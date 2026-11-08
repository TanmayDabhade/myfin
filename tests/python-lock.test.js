import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (f) => fs.readFileSync(new URL(`../src-tauri/python/${f}`, import.meta.url), "utf8");
const pins = (text) => [...text.matchAll(/^([A-Za-z0-9_.-]+)==([^\s\;]+)/gm)].map((m) => `${m[1].toLowerCase().replace(/[-_.]+/g, "-")}==${m[2]}`);

test("the bundled Python's lock matches constraints and hashes every package", () => {
  const want = new Set([...pins(read("requirements.txt")), ...pins(read("constraints.txt"))]);
  const lock = read("requirements.lock");
  assert.deepEqual(new Set(pins(lock)), want, "run node scripts/lock-python.cjs");
  for (const block of lock.split(/\n(?=[A-Za-z])/).filter((b) => /==/.test(b))) assert.match(block, /--hash=sha256:[0-9a-f]{64}/, block.split("\n")[0]);
  assert.ok(![...want].some((p) => /\.dev\d|rc\d/.test(p)), "no development or release-candidate builds");
});
