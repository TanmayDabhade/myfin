# Run Market Lens on your desktop

This download is the source project, not an installer.

1. Install Node.js 22+ and Rust stable. On a Mac, install Xcode command-line tools with `xcode-select --install`.
2. Open Terminal inside the extracted `market-lens` directory.
3. Run:

```sh
npm ci
npm run tauri dev
```

A native application window opens. For an installable application, run `npm run tauri build` on your own operating system.

On first launch, paste your free Twelve Data, Alpha Vantage and/or FRED keys. They are saved, and data loads on its own from then on. Choose **Explore demo data** to look around without keys.

Read `README.md` for provider setup, supported workflows, calculation assumptions, and current boundaries. Read `VALIDATION.md` for exactly what has and has not been tested.
