# PR installers, Homebrew and Scoop updates

Every opened, updated, reopened or ready-for-review PR builds Linux x64 (DEB and AppImage), Windows x64 (NSIS installer) and a universal Mac DMG (Intel and Apple Silicon). All three builds and tests must pass before publication. Draft PRs also get prereleases. These are previews, not stable production versions.

The publisher creates `pr-<number>-<full-commit-sha>` with three downloadable ZIP archives. Each archive contains only the installers for that platform. Release notes link the PR and exact built commit and include SHA-256 checksums. A new commit gets a new versioned release; rerunning the same commit never overwrites a published release. Failed uploads remain drafts and can be retried. Existing releases are retained.

## Install on macOS

After this workflow is merged and the first eligible PR has published successfully:

```sh
brew tap tanmaydabhade/myfin https://github.com/TanmayDabhade/myfin.git
brew trust tanmaydabhade/myfin
brew install --cask tanmaydabhade/myfin/aperture-preview
```

Current Homebrew refuses casks from third-party taps until you trust the tap, so run `brew trust tanmaydabhade/myfin` once after tapping.

The same repository is the tap; the explicit URL is necessary because it is not named `homebrew-myfin`.

To update the installed application:

```sh
brew update
brew upgrade --cask tanmaydabhade/myfin/aperture-preview
```

To install if missing, or upgrade if already installed:

```sh
brew tap tanmaydabhade/myfin https://github.com/TanmayDabhade/myfin.git
brew trust tanmaydabhade/myfin
brew update
if brew list --cask tanmaydabhade/myfin/aperture-preview >/dev/null 2>&1; then
  brew upgrade --cask tanmaydabhade/myfin/aperture-preview
else
  brew install --cask tanmaydabhade/myfin/aperture-preview
fi
```

`brew update` refreshes the cask definition; `brew upgrade` downloads the checksum-verified archive and replaces `/Applications/Aperture.app`. Workspace data is not deleted. Quit the app before upgrading. An existing manually installed copy may need to be removed from Applications before the first Homebrew install; retain its application-data folder. These builds are not Developer ID signed/notarized, so Gatekeeper may block launch. This setup does not disable quarantine or OS security controls.

## Install on Windows

Scoop is the Windows counterpart of the Homebrew tap. This repository is also the Scoop bucket: the publisher writes `bucket/aperture-preview.json` from the same build as the cask. In PowerShell (Scoop needs Git for buckets: `scoop install git`):

```powershell
scoop bucket add myfin https://github.com/TanmayDabhade/myfin
scoop install myfin/aperture-preview
```

To update the installed application:

```powershell
scoop update
scoop update aperture-preview
```

`scoop update` refreshes the bucket; `scoop update aperture-preview` downloads the checksum-verified archive and runs the NSIS installer silently (`/S`). The installer closes a running Aperture, installs over the previous build in `%LOCALAPPDATA%\Aperture`, and keeps the Start menu and desktop shortcuts. Workspace data in `%APPDATA%\com.aperture.desktop` and `%LOCALAPPDATA%\com.aperture.desktop` is never deleted. `scoop uninstall aperture-preview` runs Aperture's own uninstaller silently, which also leaves that data alone. If you installed Aperture by hand before, Scoop installs over it in the same folder.

To stay current without thinking about it, schedule `scoop update; scoop update aperture-preview` (for example a daily Task Scheduler job), the same way you would schedule `brew upgrade` on a Mac.

The builds are not code signed. Scoop downloads outside the browser, so SmartScreen does not usually prompt, but antivirus software may still inspect the new installer.

## Coming from Market Lens

The app was called Market Lens until 0.3. `cask_renames.json` maps the old `market-lens-preview` cask to `aperture-preview`, so `brew update && brew upgrade --cask aperture-preview` moves an existing install over and replaces `Market Lens.app` with `Aperture.app`. On its first launch Aperture moves the workspace, saved keys and SEC downloads from the old `com.marketlens.desktop` data folder into `com.aperture.desktop`; nothing has to be re-entered.

## Preview channel

After publishing a non-draft PR from this repository, the trusted publisher writes only `Casks/aperture-preview.rb` and `bucket/aperture-preview.json` on the default branch, each with the immutable release URL and the actual checksum of its platform's archive. These generated distribution metadata commits do not merge the feature PR. Both versions are `0.0.<build-run-number>` so newer successful builds are recognized even though the app itself reports its release version. Older runs cannot downgrade the tap or the bucket. Fork PRs and draft PRs get releases but never automatically replace either channel. If multiple PRs are open, the channels track the newest eligible successful build, not a combined build of all PRs.

The Windows build is optional, like Linux. When it fails, the release and the Homebrew cask still publish and the Scoop manifest keeps pointing at the last build that had a Windows installer. Each channel is written separately: if one write is blocked, the other is still attempted, the run fails visibly, and a rerun repairs it.

## Activation and permissions

1. Merge the workflow PR. `workflow_run` publishers must exist on the default branch before GitHub can trigger them.
2. Update/reopen an existing feature PR or open a new one to trigger `PR desktop builds` with the new workflow present in its branch. Existing branches may need the default-branch changes incorporated first.
3. The normal `GITHUB_TOKEN` needs Actions read, Pull requests read and Contents write. No credentials are passed to PR build scripts. Publisher code is checked out only from the default branch; downloaded archives are never extracted or executed by the publisher.
4. GitHub may require Workflows write permission when a release targets a commit that changes `.github/workflows/` relative to the default branch. `GITHUB_TOKEN` cannot have that permission. For those PRs, configure a repository-scoped `PR_RELEASE_TOKEN` secret (a fine-grained token or GitHub App installation token with Contents/Workflows write and Actions/Pull requests read), or publish after the workflow changes have landed. Do not put a token in source files or PR builds.
5. The generated cask commit must be permitted by default-branch protection. If a rule blocks it, the release remains available but Homebrew publication fails visibly. Configure a narrowly scoped authorized publisher; this workflow does not bypass protections.

Use **Actions → Publish PR prerelease → Run workflow**, supplying a successful `PR desktop builds` run ID, to retry publication or a tap update. Failed builds, expired/missing artifacts, unrelated workflow IDs and outdated PR heads are rejected. Source tags always point to the actual built PR commit.

References: [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run), [release API permissions](https://docs.github.com/en/rest/releases/releases#create-a-release), [Homebrew taps](https://docs.brew.sh/Taps), [cask definitions](https://docs.brew.sh/Cask-Cookbook), [Scoop buckets](https://github.com/ScoopInstaller/Scoop/wiki/Buckets), [Scoop manifests](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests).
