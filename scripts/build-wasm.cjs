// Builds the options maths (src-tauri/crates/options-math) for WebAssembly
// and copies it to src/options/options.wasm, where the interface loads it.
// Runs before `vite`, `vite build`, the unit tests and the smoke test.
// Adds the wasm32 Rust target with rustup the first time if it is missing.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const target = "wasm32-unknown-unknown";
const out = path.join(root, "src", "options", "options.wasm");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });

try {
  const installed = run("rustup", ["target", "list", "--installed"]);
  if (!installed.split(/\s+/).includes(target)) {
    console.log(`Adding the ${target} Rust target (one time)…`);
    run("rustup", ["target", "add", target], { stdio: "inherit" });
  }
} catch {
  // No rustup (a Rust installed another way): let cargo report a missing target.
}

run("cargo", ["build", "--quiet", "--manifest-path", "src-tauri/Cargo.toml", "-p", "options-wasm", "--target", target, "--release"], { stdio: "inherit" });
const built = path.join(root, "src-tauri", "target", target, "release", "options_wasm.wasm");
const bytes = fs.readFileSync(built);
if (!fs.existsSync(out) || !fs.readFileSync(out).equals(bytes)) fs.writeFileSync(out, bytes);
