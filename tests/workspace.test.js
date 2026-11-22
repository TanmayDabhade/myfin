import test from "node:test";
import assert from "node:assert/strict";
import { flatten, diff, applyRead, applyOps, changedPaths } from "../src/workspace.js";

const copy = (x) => JSON.parse(JSON.stringify(x));
// What the desktop app's workspace_read returns (src-tauri/src/workspace.rs).
const read = (body, paths) =>
  paths.map((p) => {
    const [k, e] = p;
    const v = e === undefined ? body[k] : body[k] && typeof body[k] === "object" && !Array.isArray(body[k]) ? body[k][e] : undefined;
    if (v === undefined) return { p, gone: true };
    if (e === undefined && v && typeof v === "object" && !Array.isArray(v)) return { p, obj: true };
    return { p, v };
  });
// A window: its state, what it last synced, and a save that patches `server`.
function windowOn(server) {
  const w = { state: copy(server.body), baseline: flatten(server.body) };
  w.save = () => {
    const next = flatten(w.state),
      ops = diff(w.baseline, next, w.state);
    server.body = applyOps(server.body, copy(ops));
    w.baseline = next;
    return ops.map((o) => o[1]);
  };
  w.receive = (paths) => applyRead(w.state, w.baseline, read(server.body, paths));
  return w;
}

test("nothing to send when nothing changed", () => {
  const s = { mode: "market", watchlist: ["AAPL"], marketAssets: { AAPL: { bars: [1, 2] } } };
  assert.deepEqual(diff(flatten(s), flatten(copy(s)), s), []);
});

test("sends only the entries that changed, two levels deep", () => {
  const before = { mode: "sample", watchlist: ["AAPL"], marketAssets: { AAPL: { p: 1 }, MSFT: { p: 2 } } };
  const after = copy(before);
  after.mode = "market";
  after.marketAssets.AAPL.p = 3;
  delete after.marketAssets.MSFT;
  after.notes = { AAPL: "hi" };
  const ops = diff(flatten(before), flatten(after), after);
  assert.deepEqual(ops, [
    ["set", ["mode"], "market"],
    ["set", ["marketAssets", "AAPL"], { p: 3 }],
    ["obj", ["notes"]],
    ["set", ["notes", "AAPL"], "hi"],
    ["del", ["marketAssets", "MSFT"]],
  ]);
  assert.deepEqual(applyOps(copy(before), ops), after);
});

test("a key that changes between an object and a plain value round-trips", () => {
  const before = { a: { x: 1 }, b: 5 };
  const after = { a: 7, b: { y: 2 } };
  assert.deepEqual(applyOps(copy(before), diff(flatten(before), flatten(after), after)), after);
});

test("undefined values are dropped, as saving them as JSON would", () => {
  const s = { a: undefined, b: { c: undefined, d: 1 } };
  assert.deepEqual([...flatten(s).keys()], ["b", "b\u0000d"]);
});

test("two windows changing different stocks both keep their changes", () => {
  const server = { body: { watchlist: ["AAPL"], marketAssets: { AAPL: { p: 1 } } } };
  const a = windowOn(server),
    b = windowOn(server);
  a.state.marketAssets.AAPL = { p: 2 };
  b.state.marketAssets.MSFT = { p: 9 };
  const fromA = a.save(),
    fromB = b.save();
  assert.deepEqual(server.body.marketAssets, { AAPL: { p: 2 }, MSFT: { p: 9 } });
  b.receive(fromA);
  a.receive(fromB);
  assert.deepEqual(a.state, server.body);
  assert.deepEqual(b.state, server.body);
  // What a window read from another isn't sent back as its own change.
  assert.deepEqual(diff(a.baseline, flatten(a.state), a.state), []);
  assert.deepEqual(diff(b.baseline, flatten(b.state), b.state), []);
});

test("removals made in another window are applied", () => {
  const server = { body: { notes: { AAPL: "x", MSFT: "y" }, alerts: [1] } };
  const a = windowOn(server),
    b = windowOn(server);
  delete a.state.notes;
  a.state.alerts = [];
  b.receive(a.save());
  assert.deepEqual(b.state, { alerts: [] });
  assert.deepEqual(diff(b.baseline, flatten(b.state), b.state), []);
});

test("only one- and two-key paths are taken from an event", () => {
  assert.deepEqual(changedPaths({ paths: [["a"], ["a", "b"], [], ["a", "b", "c"], "x"] }), [["a"], ["a", "b"]]);
  assert.deepEqual(changedPaths(null), []);
});
