import test from "node:test";
import assert from "node:assert/strict";
import { normalizeActivity, summary } from "../src/maritime.js";
const payload = (a) => ({ features: [{ attributes: a }] });
test("PortWatch normalizes both API schemas without turning null into zero", () => {
  const r = normalizeActivity(
    payload({
      portid: "port1",
      date: "2026-01-01",
      portcalls_tanker: 0,
      portcalls_cargo: null,
    }),
    "port1",
  )[0];
  assert.equal(r.tanker, 0);
  assert.equal(r.cargo, null);
  assert.equal(
    normalizeActivity(
      payload({ portid: "chokepoint1", date: 1767225600000, n_tanker: 8 }),
      "chokepoint1",
    )[0].tanker,
    8,
  );
});
test("reject service errors and mismatched locations", () => {
  assert.throws(() => normalizeActivity({ error: {} }, "port1"));
  assert.throws(() =>
    normalizeActivity(
      payload({ portid: "port2", date: "2026-01-01" }),
      "port1",
    ),
  );
});
test("weekly summaries require known values and nonzero prior baseline", () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({
    date: "x",
    tanker: i < 7 ? 10 : 20,
  }));
  assert.equal(summary(rows, "tanker").change, 1);
  rows[0].tanker = null;
  assert.equal(summary(rows, "tanker").change, null);
  assert.equal(summary([], "tanker").latest, null);
});
