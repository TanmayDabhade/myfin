// Keeping one workspace in step across windows. Each window remembers the
// workspace as it last saved or read it (flattened to JSON per path) and saves
// only what differs, as operations the desktop app applies in order:
// ["set", path, value], ["del", path], ["obj", [key]]. Paths are one key deep,
// or two for objects (prices per symbol, notes, macro series), so windows
// changing different entries of the same map don't overwrite each other.
// The desktop side lives in src-tauri/src/workspace.rs.
const SEP = "\u0000",
  OBJ = "\u0001{}";
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keyOf = (p) => p.join(SEP);
const pathOf = (k) => {
  const i = k.indexOf(SEP);
  return i < 0 ? [k] : [k.slice(0, i), k.slice(i + 1)];
};
// JSON drops undefined values; so do these, to match what gets saved.
const text = (v) => (v === undefined ? undefined : JSON.stringify(v));

export function flatten(state) {
  const out = new Map();
  for (const [k, v] of Object.entries(state || {})) {
    if (v === undefined) continue;
    if (!plain(v)) {
      out.set(k, text(v));
      continue;
    }
    out.set(k, OBJ);
    for (const [e, x] of Object.entries(v))
      if (x !== undefined) out.set(k + SEP + e, text(x));
  }
  return out;
}

// What to send so the saved copy (`before`, flattened) matches `state`, whose
// flattened form is `after`.
export function diff(before, after, state) {
  const ops = [];
  for (const [k, t] of after) {
    if (before.get(k) === t) continue;
    const p = pathOf(k);
    if (t === OBJ) ops.push(["obj", p]);
    else ops.push(["set", p, p.length === 1 ? state[p[0]] : state[p[0]][p[1]]]);
  }
  for (const k of before.keys())
    if (!after.has(k)) ops.push(["del", pathOf(k)]);
  return ops;
}

// The paths another window changed, from a "workspace-changed" event.
export const changedPaths = (payload) =>
  Array.isArray(payload?.paths)
    ? payload.paths.filter(
        (p) => Array.isArray(p) && (p.length === 1 || p.length === 2),
      )
    : [];

// Applies values read back from the desktop app (`{p, v}`, `{p, obj}` or
// `{p, gone}` per path) to `state`, and records them in `baseline` so they
// aren't sent back as this window's own changes.
export function applyRead(state, baseline, entries) {
  for (const { p, v, obj, gone } of entries || []) {
    const [k, e] = p;
    if (e === undefined) {
      if (gone) {
        delete state[k];
        for (const b of [...baseline.keys()])
          if (b === k || b.startsWith(k + SEP)) baseline.delete(b);
      } else if (obj) {
        if (!plain(state[k])) state[k] = {};
        baseline.set(k, OBJ);
      } else {
        state[k] = v;
        for (const b of [...baseline.keys()])
          if (b.startsWith(k + SEP)) baseline.delete(b);
        baseline.set(k, text(v));
      }
      continue;
    }
    if (gone) {
      if (plain(state[k])) delete state[k][e];
      baseline.delete(keyOf(p));
      continue;
    }
    if (!plain(state[k])) state[k] = {};
    state[k][e] = v;
    baseline.set(k, OBJ);
    baseline.set(keyOf(p), text(v));
  }
}

// The same operations applied to a plain object, for the browser stand-ins.
export function applyOps(body, ops) {
  body = plain(body) ? body : {};
  for (const [kind, [k, e], v] of ops) {
    if (kind === "obj") {
      if (!plain(body[k])) body[k] = {};
    } else if (kind === "set") {
      if (e === undefined) body[k] = v;
      else (plain(body[k]) ? body[k] : (body[k] = {}))[e] = v;
    } else if (kind === "del") {
      if (e === undefined) delete body[k];
      else if (plain(body[k])) delete body[k][e];
    }
  }
  return body;
}
