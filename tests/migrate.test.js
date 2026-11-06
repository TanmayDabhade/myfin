import test from "node:test";
import assert from "node:assert/strict";
import { migrate, validateWorkspace, SCHEMA } from "../src/engine.js";
import { sample } from "../src/sample.js";

const bars = [
  { date: "2026-01-02", open: 100, high: 102, low: 99, close: 101, volume: 10 },
  { date: "2026-01-05", open: 101, high: 104, low: 100, close: 103, volume: 20 },
];

test("a 0.1 workspace with imported data upgrades and skips first-run setup", () => {
  const old = sample();
  delete old.sources;
  old.mode = "market";
  old.marketAssets = { ABC: { symbol: "ABC", name: "ABC", bars, origin: "import", source: "User CSV import" } };
  const s = migrate(structuredClone(old));
  assert.equal(s.schema, SCHEMA);
  assert.deepEqual(s.sources, { prices: "twelve" });
  assert.equal(s.setupDone, true);
  assert.equal(s.marketAssets.ABC.origin, "import", "existing data is preserved");
  assert.equal(migrate(structuredClone(s)).schema, SCHEMA, "idempotent");
});

test("a fresh sample workspace keeps the first-run screen", () => {
  assert.equal(migrate(sample()).setupDone, undefined);
});

test("workspaces from a newer version are refused rather than damaged", () => {
  assert.throws(() => migrate({ ...sample(), schema: SCHEMA + 1 }), /newer Market Lens/);
});

test("backups containing Twelve Data prices restore", () => {
  const s = migrate(sample());
  s.marketAssets = { AAPL: { symbol: "AAPL", name: "AAPL", bars, origin: "twelve", source: "Twelve Data · daily" } };
  assert.doesNotThrow(() => validateWorkspace(JSON.parse(JSON.stringify(s))));
});
