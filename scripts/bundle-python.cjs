// Builds the Python runtime that ships inside the app for GS Quant risk
// analytics: a standalone CPython (astral-sh/python-build-standalone,
// checksum-pinned below) with gs-quant and its dependencies installed from
// the hash-locked wheels in src-tauri/python/requirements.lock (regenerate it
// with scripts/lock-python.cjs after changing constraints.txt).
//
//   node scripts/bundle-python.cjs                       # this machine's platform
//   node scripts/bundle-python.cjs aarch64-apple-darwin x86_64-apple-darwin
//
// Output: src-tauri/resources/python/<target>/, which Tauri bundles as the
// app resource python/<target>/. Other targets' wheels are cross-installed
// with pip --platform, so a universal Mac build can be made on one runner.
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "src-tauri", "resources", "python");
const CACHE = path.join(ROOT, "src-tauri", "target", "python-download");
const SPEC = path.join(ROOT, "src-tauri", "python");
const RELEASE = "20261013";
const VERSION = "3.13.16";
const PY = "3.13";
// SHA-256 from the release's published asset digests.
const BUILDS = {
  "aarch64-apple-darwin": { sha256: "16a5332fb0dcb77f163fc8f8cbccd95be1644cc53e68e5d2a79f50afd6680a0e", platform: "macosx_11_0_arm64" },
  "x86_64-apple-darwin": { sha256: "f507ae04eb7747cd97cb484e8c5d83936cbfc52d9b08a1f35c00b47c707b1ae1", platform: "macosx_11_0_x86_64" },
  "x86_64-pc-windows-msvc": { sha256: "7aba3985d4cee1c7cacb963ca6aa08a5d3e695d7f9609d9fabc56f22ddcf5a06", platform: "win_amd64" },
  "x86_64-unknown-linux-gnu": { sha256: "d0080766b6b74aeb81e1949ef0d9a20e6c17f7b160fb295a69b936ccb17660be", platform: "manylinux_2_28_x86_64" },
};
// Parts of the standard library and packages the analytics never use.
const PRUNE_DIRS = new Set(["tests", "test", "idlelib", "tkinter", "turtledemo", "ensurepip", "__pycache__"]);
const PRUNE_TOP = ["include", "share", "lib/pkgconfig", "lib/tcl9", "lib/tk9", "lib/tcl8", "lib/tk8", "lib/itcl4", "lib/thread3", "tcl", "Scripts"];

function hostTarget() {
  const key = `${process.platform}-${process.arch}`;
  const t = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "win32-x64": "x86_64-pc-windows-msvc", "linux-x64": "x86_64-unknown-linux-gnu" }[key];
  if (!t) throw Error(`No bundled Python for ${key}`);
  return t;
}
const isWin = (t) => t.includes("windows");
const pythonExe = (dir, t) => (isWin(t) ? path.join(dir, "python.exe") : path.join(dir, "bin", "python3"));
const sitePackages = (dir, t) => (isWin(t) ? path.join(dir, "Lib", "site-packages") : path.join(dir, "lib", `python${PY}`, "site-packages"));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

async function download(t) {
  const name = `cpython-${VERSION}+${RELEASE}-${t}-install_only_stripped.tar.gz`;
  const file = path.join(CACHE, name);
  const ok = () => fs.existsSync(file) && crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === BUILDS[t].sha256;
  if (!ok()) {
    fs.mkdirSync(CACHE, { recursive: true });
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${encodeURIComponent(name)}`;
    console.log(`Downloading ${name}`);
    const res = await fetch(url);
    if (!res.ok) throw Error(`Download failed (${res.status}): ${url}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    if (!ok()) throw Error(`Checksum mismatch for ${name}`);
  }
  return file;
}

// Resource copying is simplest with real files, so symlinks become copies.
function dereference(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      const real = fs.realpathSync(p);
      fs.rmSync(p);
      fs.cpSync(real, p, { recursive: true });
    } else if (e.isDirectory()) dereference(p);
  }
}

function prune(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (PRUNE_DIRS.has(e.name)) fs.rmSync(p, { recursive: true, force: true });
    else prune(p);
  }
}

function size(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? size(p) : fs.statSync(p).size;
  }
  return n;
}

async function unpack(t) {
  const archive = await download(t);
  const dest = path.join(OUT, t);
  const tmp = path.join(OUT, `.${t}-unpack`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  // On Windows use the system bsdtar: Git's GNU tar reads "C:" as a remote host.
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  run(tar, ["-xzf", archive, "-C", tmp]);
  fs.renameSync(path.join(tmp, "python"), dest);
  fs.rmSync(tmp, { recursive: true, force: true });
  dereference(dest);
  return dest;
}

// Checks the bundle by running the app's own analysis script with it.
function verify(dir, t) {
  const closes = [];
  let p = 100;
  for (let i = 0; i < 300; i++) {
    p *= 1 + Math.sin(i * 1.7) / 100;
    closes.push([new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10), +p.toFixed(4)]);
  }
  const input = JSON.stringify({ symbol: "TEST", closes, benchmark: { symbol: "SPY", closes }, riskFree: 0.04 });
  const started = Date.now();
  const out = execFileSync(pythonExe(dir, t), ["-I", "-B", path.join(ROOT, "src-tauri", "src", "quant.py")], { input, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }).toString();
  const r = JSON.parse(out);
  if (r.error || !(r.metrics?.vol1y > 0) || Math.abs(r.metrics.beta3m - 1) > 1e-6) throw Error(`Bundled Python failed the analytics check: ${out.slice(0, 300)}`);
  console.log(`Verified ${t}: gs-quant ${r.gsQuant}, analytics in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

(async () => {
  const host = hostTarget();
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : [host];
  for (const t of targets) if (!BUILDS[t]) throw Error(`Unknown target ${t}. Known: ${Object.keys(BUILDS).join(", ")}`);
  fs.mkdirSync(OUT, { recursive: true });
  // pip and compileall run under this machine's Python; bytecode does not
  // depend on the CPU, only on the Python version, which is the same for all.
  const toolDir = await unpack(host);
  const tool = pythonExe(toolDir, host);
  for (const t of targets) {
    const dir = t === host ? toolDir : await unpack(t);
    console.log(`Installing gs-quant for ${t}`);
    run(tool, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-cache-dir", "--no-compile", "--only-binary=:all:", "--target", sitePackages(dir, t), "--platform", BUILDS[t].platform, "--python-version", PY, "--implementation", "cp", "--abi", `cp${PY.replace(".", "")}`, "--require-hashes", "--no-deps", "--index-url", "https://pypi.org/simple", "-r", path.join(SPEC, "requirements.lock")], { env: { ...process.env, PIP_CONFIG_FILE: os.devnull } });
    prune(dir);
    for (const rel of PRUNE_TOP) fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
    // Precompiled with hash checks off: the installed app is read-only and
    // file times change when it is copied, so Python must trust these files
    // as they are. Otherwise every run would recompile gs-quant (about a minute).
    // aenum ships a Python 2 file it never imports, so it is skipped.
    run(tool, ["-W", "ignore", "-m", "compileall", "-q", "-j", "0", "-x", "aenum[/\\\\]_py2\\.py$", "--invalidation-mode", "unchecked-hash", isWin(t) ? path.join(dir, "Lib") : path.join(dir, "lib")]);
    fs.writeFileSync(path.join(dir, "BUNDLE.json"), JSON.stringify({ python: VERSION, release: RELEASE, target: t, gsQuant: "2.2.5" }, null, 2));
    console.log(`${t}: ${(size(dir) / 1e6).toFixed(0)} MB`);
  }
  // A host tree that was only needed as the tool is not shipped.
  if (!targets.includes(host)) fs.rmSync(toolDir, { recursive: true, force: true });
  for (const t of targets) if (t === host) verify(path.join(OUT, t), t);
  // pip is only needed while building.
  for (const t of targets) {
    const dir = path.join(OUT, t);
    for (const e of fs.readdirSync(sitePackages(dir, t))) if (/^pip($|-)/.test(e)) fs.rmSync(path.join(sitePackages(dir, t), e), { recursive: true, force: true });
    const bin = path.join(dir, "bin");
    if (fs.existsSync(bin)) for (const e of fs.readdirSync(bin)) if (/^pip/.test(e)) fs.rmSync(path.join(bin, e));
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
