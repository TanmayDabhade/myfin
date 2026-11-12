import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import publish from "../.github/scripts/publish-pr-release.cjs";

const sha = "a".repeat(40);
const missing = () => {
  throw Object.assign(Error("Not found"), { status: 404 });
};
function fixture() {
  const state = {
    run: {
      id: 42,
      run_number: 8,
      workflow_id: 3,
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      head_sha: sha,
      repository: { full_name: "owner/myfin" },
      head_repository: { full_name: "owner/myfin" },
      pull_requests: [{ number: 7 }],
    },
    pr: {
      number: 7,
      state: "open",
      draft: false,
      base: { repo: { full_name: "owner/myfin" } },
      head: { sha, repo: { full_name: "owner/myfin" } },
    },
    artifacts: ["linux-x64", "windows-x64", "macos-universal"].map((p, i) => ({
      id: i + 1,
      name: `Aperture-${p}`,
      size_in_bytes: 50,
      expired: false,
    })),
    releases: [],
    uploads: [],
    tap: [],
    files: {},
    published: 0,
    draftAssets: [],
  };
  const actions = {
    getWorkflowRun: async () => ({ data: state.run }),
    getWorkflow: async () => ({ data: { id: 3 } }),
    listWorkflowRunArtifacts: async () => state.artifacts,
    downloadArtifact: async ({ artifact_id }) => ({
      data: Buffer.from(`archive-${artifact_id}`),
    }),
  };
  const repos = {
    listPullRequestsAssociatedWithCommit: async () => [{ number: 7 }],
    getReleaseByTag: async () =>
      state.release ? { data: state.release } : missing(),
    createRelease: async (args) => {
      state.releases.push(args);
      state.release = {
        id: 9,
        html_url: "https://github.com/owner/myfin/releases/tag/test",
        ...args,
      };
      return { data: state.release };
    },
    listReleaseAssets: async () => state.draftAssets,
    listReleases: async () => (state.release ? [state.release] : []),
    deleteReleaseAsset: async (args) => (state.deleted = args),
    uploadReleaseAsset: async (args) => {
      if (state.uploadError) throw Error("Upload interrupted");
      state.uploads.push(args);
      return { data: { id: 10 } };
    },
    updateRelease: async (args) => {
      state.published++;
      Object.assign(state.release, args);
      return { data: state.release };
    },
    getContent: async ({ path }) =>
      state.files[path] ? { data: state.files[path] } : missing(),
    createOrUpdateFileContents: async (args) => {
      if (state.tapError) throw Error("Branch protected");
      state.tap.push(args);
    },
  };
  const github = {
    rest: {
      actions,
      repos,
      pulls: { get: async () => ({ data: state.pr }) },
      git: {
        getRef: async () => (state.ref ? { data: state.ref } : missing()),
      },
    },
    paginate: (method, args) => method(args),
  };
  const core = {
    info: () => {},
    summary: {
      addLink() {
        return this;
      },
      async write() {},
    },
  };
  return {
    state,
    github,
    core,
    context: {
      repo: { owner: "owner", repo: "myfin" },
      payload: { repository: { default_branch: "main" } },
    },
    runId: 42,
  };
}

test("publishes complete prerelease with actual archive checksums and updates cask", async () => {
  const f = fixture();
  await publish(f);
  assert.equal(f.state.uploads.length, 3);
  assert.equal(f.state.published, 1);
  assert.equal(f.state.release.prerelease, true);
  assert.equal(f.state.release.make_latest, "false");
  assert.equal(f.state.release.target_commitish, sha);
  assert.equal(f.state.release.tag_name, `pr-7-${sha}`);
  const content = Buffer.from(f.state.tap[0].content, "base64").toString();
  const expected = createHash("sha256").update("archive-3").digest("hex");
  assert.ok(content.includes(`sha256 "${expected}"`));
  assert.ok(content.includes('version "0.0.8"'));
  assert.ok(
    content.includes('container nested: "Aperture-macos-universal.dmg"'),
  );
  assert.equal(f.state.tap[0].path, "Casks/aperture-preview.rb");
  assert.equal(f.state.tap[0].branch, "main");
  assert.equal(f.state.tap[1].path, "bucket/aperture-preview.json");
  assert.equal(f.state.tap[1].branch, "main");
  const manifest = JSON.parse(
    Buffer.from(f.state.tap[1].content, "base64").toString(),
  );
  const windows = createHash("sha256").update("archive-2").digest("hex");
  assert.equal(manifest.version, "0.0.8");
  assert.equal(manifest.architecture["64bit"].hash, windows);
  assert.equal(
    manifest.architecture["64bit"].url,
    `https://github.com/owner/myfin/releases/download/pr-7-${sha}/Aperture-windows-x64.zip`,
  );
  assert.deepEqual(manifest.installer, {
    file: "Aperture-windows-x64.exe",
    args: ["/S"],
  });
  assert.ok(f.state.release.body.includes(`<!-- windows-sha256: ${windows} -->`));
});
test("failed, unrelated or non-PR workflow runs cannot publish", async () => {
  for (const patch of [
    { conclusion: "failure" },
    { event: "push" },
    { workflow_id: 99 },
    { status: "in_progress" },
    { repository: { full_name: "other/repo" } },
  ]) {
    const f = fixture();
    Object.assign(f.state.run, patch);
    await assert.rejects(publish(f), /Only successful/);
    assert.equal(f.state.releases.length, 0);
  }
});
test("obsolete heads and closed unmerged PRs are skipped", async () => {
  for (const change of [
    (f) => (f.state.pr.head.sha = "b".repeat(40)),
    (f) => (f.state.pr.state = "closed"),
  ]) {
    const f = fixture();
    change(f);
    await publish(f);
    assert.equal(f.state.releases.length, 0);
  }
});
test("fork association fallback publishes download without advancing Homebrew", async () => {
  const f = fixture();
  f.state.run.pull_requests = [];
  f.state.run.head_repository.full_name = "fork/myfin";
  f.state.pr.head.repo.full_name = "fork/myfin";
  await publish(f);
  assert.equal(f.state.published, 1);
  assert.equal(f.state.tap.length, 0);
});
test("draft PR gets a prerelease but never advances Homebrew", async () => {
  const f = fixture();
  f.state.pr.draft = true;
  await publish(f);
  assert.equal(f.state.published, 1);
  assert.equal(f.state.tap.length, 0);
});
test("partial, duplicate, expired or oversized artifacts cannot create releases", async () => {
  for (const change of [
    (f) => f.state.artifacts.pop(),
    (f) => f.state.artifacts.push(f.state.artifacts[0]),
    (f) => (f.state.artifacts[0].expired = true),
    (f) => (f.state.artifacts[0].size_in_bytes = 600 * 1024 * 1024),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(publish(f), /artifact/);
    assert.equal(f.state.releases.length, 0);
  }
});
test("a missing Linux or Windows build does not block the Mac release and tap", async () => {
  for (const [name, channels] of [
    ["Aperture-linux-x64", ["Casks/aperture-preview.rb", "bucket/aperture-preview.json"]],
    ["Aperture-windows-x64", ["Casks/aperture-preview.rb"]],
  ]) {
    const f = fixture();
    f.state.artifacts = f.state.artifacts.filter((a) => a.name !== name);
    await publish(f);
    assert.equal(f.state.published, 1);
    assert.equal(f.state.uploads.length, 2);
    assert.deepEqual(f.state.tap.map((t) => t.path), channels);
  }
});
test("the Mac build is required", async () => {
  const f = fixture();
  f.state.artifacts = f.state.artifacts.filter((a) => a.name !== "Aperture-macos-universal");
  await assert.rejects(publish(f), /macos-universal artifact/);
  assert.equal(f.state.releases.length, 0);
});
test("failed uploads stay draft and cannot update the tap", async () => {
  const f = fixture();
  f.state.uploadError = true;
  await assert.rejects(publish(f), /interrupted/);
  assert.equal(f.state.release.draft, true);
  assert.equal(f.state.published, 0);
  assert.equal(f.state.tap.length, 0);
});
test("mismatched artifact digest is rejected before upload", async () => {
  const f = fixture();
  f.state.artifacts[0].digest = "sha256:" + "0".repeat(64);
  await assert.rejects(publish(f), /checksum mismatch/);
  assert.equal(f.state.uploads.length, 0);
});
test("published release rerun is idempotent and can repair tap publication", async () => {
  const f = fixture();
  f.state.tapError = true;
  await assert.rejects(publish(f), /Branch protected/);
  assert.equal(f.state.published, 1);
  f.state.tapError = false;
  await publish(f);
  assert.equal(f.state.uploads.length, 3);
  assert.equal(f.state.published, 1);
  assert.equal(f.state.tap.length, 2);
  const manifest = JSON.parse(
    Buffer.from(f.state.tap[1].content, "base64").toString(),
  );
  assert.equal(
    manifest.architecture["64bit"].hash,
    createHash("sha256").update("archive-2").digest("hex"),
  );
});
test("a release published before Scoop existed still repairs Homebrew", async () => {
  const f = fixture();
  f.state.release = {
    id: 9,
    tag_name: `pr-7-${sha}`,
    draft: false,
    prerelease: true,
    html_url: "https://github.com/owner/myfin/releases/tag/test",
    body: `<!-- macos-sha256: ${"d".repeat(64)} -->`,
  };
  await publish(f);
  assert.equal(f.state.uploads.length, 0);
  assert.deepEqual(f.state.tap.map((t) => t.path), ["Casks/aperture-preview.rb"]);
});
test("a blocked Homebrew write still updates Scoop and then fails", async () => {
  const f = fixture();
  f.github.rest.repos.createOrUpdateFileContents = async (args) => {
    if (args.path.startsWith("Casks/")) throw Error("Branch protected");
    f.state.tap.push(args);
  };
  await assert.rejects(publish(f), /Branch protected/);
  assert.deepEqual(f.state.tap.map((t) => t.path), ["bucket/aperture-preview.json"]);
});
test("an older build cannot downgrade an existing tap or bucket", async () => {
  const f = fixture();
  f.state.files["Casks/aperture-preview.rb"] = {
    sha: "existing",
    content: Buffer.from("# build-run-number: 9\n").toString("base64"),
  };
  f.state.files["bucket/aperture-preview.json"] = {
    sha: "existing",
    content: Buffer.from(
      publish.scoopManifest({
        repository: "owner/myfin",
        tag: `pr-7-${sha}`,
        checksum: "c".repeat(64),
        sequence: 9,
      }),
    ).toString("base64"),
  };
  await publish(f);
  assert.equal(f.state.published, 1);
  assert.equal(f.state.tap.length, 0);
});
test("an unmanaged bucket manifest is never overwritten", async () => {
  const f = fixture();
  f.state.files["bucket/aperture-preview.json"] = {
    sha: "existing",
    content: Buffer.from('{"version": "1.0"}').toString("base64"),
  };
  await assert.rejects(publish(f), /unmanaged bucket/);
  assert.deepEqual(f.state.tap.map((t) => t.path), ["Casks/aperture-preview.rb"]);
});
test("tag collisions fail rather than point a release at the wrong source", async () => {
  const f = fixture();
  f.state.ref = { object: { sha: "b".repeat(40) } };
  await assert.rejects(publish(f), /does not match/);
  assert.equal(f.state.releases.length, 0);
});
test("cask interpolation rejects executable or invalid metadata", () => {
  const safe = {
    repository: "owner/myfin",
    tag: `pr-7-${sha}`,
    checksum: "c".repeat(64),
    sequence: 8,
  };
  for (const patch of [
    { repository: 'owner/evil"' },
    { tag: '#{system("bad")}' },
    { checksum: "no_check" },
    { sequence: -1 },
  ])
  {
    assert.throws(() => publish.cask({ ...safe, ...patch }), /Invalid/);
    assert.throws(() => publish.scoopManifest({ ...safe, ...patch }), /Invalid/);
  }
});

test("concurrent tap updates re-read the cask and never downgrade", async () => {
  const f = fixture();
  let calls = 0;
  f.github.rest.repos.createOrUpdateFileContents = async ({ path }) => {
    calls++;
    f.state.files[path] = {
      sha: "newer",
      content: Buffer.from(
        path.endsWith(".rb")
          ? "# build-run-number: 10\n"
          : '{"##": ["build-run-number: 10"]}',
      ).toString("base64"),
    };
    throw Object.assign(Error("Conflict"), { status: 409 });
  };
  await publish(f);
  assert.equal(calls, 2);
  assert.equal(f.state.published, 1);
});
test("interrupted draft is reused instead of creating a duplicate release", async () => {
  const f = fixture();
  f.state.uploadError = true;
  await assert.rejects(publish(f));
  f.state.uploadError = false;
  f.github.rest.repos.getReleaseByTag = async () => missing();
  await publish(f);
  assert.equal(f.state.releases.length, 1);
  assert.equal(f.state.published, 1);
});
