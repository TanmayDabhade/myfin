# Myfin preview bucket (Scoop)

The successful PR release publisher generates `aperture-preview.json` here with a versioned download URL and SHA-256 checksum, from the same build as the Homebrew cask in `../Casks`. It is absent until a PR build with a Windows installer has published. See [installation and updates](../docs/RELEASES.md).

Scoop reads manifests from this `bucket` folder when it exists, so it ignores the JSON files at the repository root.
