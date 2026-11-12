// Quant Lab persistence. Records are JSON bodies keyed by (kind, id).
// Datasets, runs, frozen selections, holdout evaluations and job events are
// write-once: the desktop database refuses to replace them, so a holdout can
// be evaluated once per frozen selection and never quietly re-run.
import { canonical, sha256 } from "./dsl.js";

export const IMMUTABLE = new Set(["snapshot", "run", "selection", "holdout", "event"]);

// Browser preview and tests: same rules, kept in memory (and localStorage
// when available).
export function memoryBackend(storage = null, key = "aperture-quantlab-v1") {
  let rows = {};
  try {
    rows = JSON.parse(storage?.getItem(key) || "{}");
  } catch {}
  // Written in batches: serializing everything on each write is quadratic.
  let timer = null;
  const write = () => {
    clearTimeout(timer);
    timer = null;
    try {
      storage.setItem(key, JSON.stringify(rows));
    } catch {}
  };
  const flush = () => {
    if (storage && !timer) timer = setTimeout(write, 300);
  };
  // Leaving or reloading the page must not drop the last batch.
  if (storage) {
    globalThis.addEventListener?.("pagehide", () => timer && write());
    globalThis.document?.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && timer && write());
  }
  return {
    async put(kind, id, parent, body, immutable) {
      const k = `${kind}:${id}`,
        text = JSON.stringify(body);
      if (rows[k] && (immutable || rows[k].immutable) && rows[k].body !== text) throw Error(`This ${kind} is already recorded and can't be changed.`);
      rows[k] = { kind, id, parent, body: text, immutable: !!immutable, created: rows[k]?.created || Date.now() };
      flush();
    },
    async get(kind, id) {
      const r = rows[`${kind}:${id}`];
      return r ? JSON.parse(r.body) : null;
    },
    async list(kind, parent = null) {
      return Object.values(rows)
        .filter((r) => r.kind === kind && (parent == null || r.parent === parent))
        .sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1))
        .map((r) => JSON.parse(r.body));
    },
  };
}
export function nativeBackend(invoke) {
  return {
    put: (kind, id, parent, body, immutable) => invoke("lab_put", { kind, id, parent, body: JSON.stringify(body), immutable: !!immutable }),
    get: async (kind, id) => {
      const t = await invoke("lab_get", { kind, id });
      return t == null ? null : JSON.parse(t);
    },
    list: async (kind, parent = null) => (await invoke("lab_list", { kind, parent })).map((t) => JSON.parse(t)),
  };
}


export function createStore(backend, now = () => new Date().toISOString()) {
  const put = (kind, id, parent, body) => backend.put(kind, id, parent, body, IMMUTABLE.has(kind));
  const store = {
    backend,
    saveSnapshot: (s) => put("snapshot", s.id, s.symbol, s),
    getSnapshot: (id) => backend.get("snapshot", id),
    async saveExperiment(e) {
      e.updatedAt = now();
      await put("experiment", e.id, null, e);
      return e;
    },
    getExperiment: (id) => backend.get("experiment", id),
    listExperiments: () => backend.list("experiment"),
    async appendEvents(jobId, events) {
      for (const ev of events) await put("event", `${jobId}:${String(ev.seq).padStart(6, "0")}`, jobId, ev);
    },
    listEvents: (jobId) => backend.list("event", jobId),
    async saveRun(run, experimentId) {
      await put("run", run.id, experimentId, run);
      return run;
    },
    getRun: (id) => backend.get("run", id),
    listRuns: (experimentId) => backend.list("run", experimentId),
    listSelections: (experimentId) => backend.list("selection", experimentId),
    getHoldout: (selectionId) => backend.get("holdout", selectionId),
    // Freezes a short list. Later edits make a new selection, never change this one.
    async freezeSelection(experiment, strategyIds) {
      const chosen = strategyIds.map((id) => experiment.candidates.find((c) => c.strategyId === id)).filter(Boolean);
      if (!chosen.length || chosen.length > 4) throw Error("Freeze one to four candidates.");
      if (experiment.status !== "completed") throw Error("Freeze a selection after the experiment completes.");
      const body = {
        experimentId: experiment.id,
        strategies: chosen.map((c) => c.strategy),
        strategyIds: chosen.map((c) => c.strategyId),
        validationSummary: chosen.map((c) => ({ strategyId: c.strategyId, rank: c.rank, score: c.score, validation: c.validation })),
        selectedAt: now(),
        holdoutPreviouslyViewed: (experiment.holdout?.evaluations || 0) > 0,
        datasetId: experiment.datasetId,
      };
      body.manifestSha256 = sha256(canonical(body));
      body.id = "sel_" + body.manifestSha256.slice(0, 20);
      await put("selection", body.id, experiment.id, body);
      return body;
    },
    // Records the one holdout evaluation of a frozen selection.
    async recordHoldout(experiment, selection, runs) {
      if (await backend.get("holdout", selection.id)) throw Error("This selection's holdout was already evaluated. The result below is the only one.");
      for (const r of runs) await store.saveRun(r, experiment.id);
      const record = {
        selectionId: selection.id,
        experimentId: experiment.id,
        runIds: runs.map((r) => r.id),
        evaluatedAt: now(),
        untouched: !selection.holdoutPreviouslyViewed,
      };
      await put("holdout", selection.id, experiment.id, record);
      experiment.holdout = { evaluations: (experiment.holdout?.evaluations || 0) + 1, lastSelectionId: selection.id, lastAt: record.evaluatedAt };
      await store.saveExperiment(experiment);
      return record;
    },
  };
  return store;
}
