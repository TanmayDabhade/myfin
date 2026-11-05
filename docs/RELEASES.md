# PR installers and Homebrew updates

Every opened, updated, reopened or ready-for-review PR builds Linux x64 (DEB and AppImage), Windows x64 (NSIS installer) and a universal Mac DMG (Intel and Apple Silicon). All three builds and tests must pass before publication. Draft PRs also get prereleases. These are previews, not stable production versions.

The publisher creates `pr-<number>-<full-commit-sha>` with three downloadable ZIP archives. Each archive contains only the installers for that platform. Release notes link the PR and exact built commit and include SHA-256 checksums. A new commit gets a new versioned release; rerunning the same commit never overwrites a published release. Failed uploads remain drafts and can be retried. Existing releases are retained.

## Install on macOS

After this workflow is merged and the first eligible PR has published successfully:

```sh
brew tap tanmaydabhade/myfin https://github.com/TanmayDabhade/myfin.git
brew install --cask tanmaydabhade/myfin/market-lens-preview
```

The same repository is the tap; the explicit URL is necessary because it is not named `homebrew-myfin`.

To update the installed application:

```sh
brew update
brew upgrade --cask tanmaydabhade/myfin/market-lens-preview
```

To install if missing, or upgrade if already installed:

```sh
brew tap tanmaydabhade/myfin https://github.com/TanmayDabhade/myfin.git
brew update
if brew list --cask tanmaydabhade/myfin/market-lens-preview >/dev/null 2>&1; then
  brew upgrade --cask tanmaydabhade/myfin/market-lens-preview
else
  brew install --cask tanmaydabhade/myfin/market-lens-preview
fi
```

`brew update` refreshes the cask definition; `brew upgrade` downloads the checksum-verified archive and replaces `/Applications/Market Lens.app`. Workspace data is not deleted. Quit the app before upgrading. An existing manually installed copy may need to be removed from Applications before the first Homebrew install; retain its application-data folder. These builds are not Developer ID signed/notarized, so Gatekeeper may block launch. This setup does not disable quarantine or OS security controls.

## Preview channel

After publishing a non-draft PR from this repository, the trusted publisher writes only `Casks/market-lens-preview.rb` on the default branch, with the immutable release URL and actual archive checksum. This generated distribution metadata commit does not merge the feature PR. The cask version is `0.0.<build-run-number>` so newer successful builds are recognized even though the app itself still reports 0.1.0. Older runs cannot downgrade the tap. Fork PRs and draft PRs get releases but never automatically replace the Homebrew channel. If multiple PRs are open, the channel tracks the newest eligible successful build, not a combined build of all PRs.

## Activation and permissions

1. Merge the workflow PR. `workflow_run` publishers must exist on the default branch before GitHub can trigger them.
2. Update/reopen an existing feature PR or open a new one to trigger `PR desktop builds` with the new workflow present in its branch. Existing branches may need the default-branch changes incorporated first.
3. The normal `GITHUB_TOKEN` needs Actions read, Pull requests read and Contents write. No credentials are passed to PR build scripts. Publisher code is checked out only from the default branch; downloaded archives are never extracted or executed by the publisher.
4. GitHub may require Workflows write permission when a release targets a commit that changes `.github/workflows/` relative to the default branch. `GITHUB_TOKEN` cannot have that permission. For those PRs, configure a repository-scoped `PR_RELEASE_TOKEN` secret (a fine-grained token or GitHub App installation token with Contents/Workflows write and Actions/Pull requests read), or publish after the workflow changes have landed. Do not put a token in source files or PR builds.
5. The generated cask commit must be permitted by default-branch protection. If a rule blocks it, the release remains available but Homebrew publication fails visibly. Configure a narrowly scoped authorized publisher; this workflow does not bypass protections.

Use **Actions → Publish PR prerelease → Run workflow**, supplying a successful `PR desktop builds` run ID, to retry publication or a tap update. Failed builds, expired/missing artifacts, unrelated workflow IDs and outdated PR heads are rejected. Source tags always point to the actual built PR commit.

References: [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run), [release API permissions](https://docs.github.com/en/rest/releases/releases#create-a-release), [Homebrew taps](https://docs.brew.sh/Taps), [cask definitions](https://docs.brew.sh/Cask-Cookbook).
