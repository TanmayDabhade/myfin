// Runs Quant Lab research off the interface thread. Messages in:
// start {jobId, config, data}, cancel, run {reqId, config, data, items}.
// Events out carry the job id, a sequence number that only goes up, and a time.
import { runExperiment, runDetail } from "./research.js";

let cancelled = false;
self.onmessage = async ({ data: msg }) => {
  if (msg.type === "cancel") cancelled = true;
  else if (msg.type === "start") {
    cancelled = false;
    let seq = 0;
    const emit = (type, payload) => self.postMessage({ jobId: msg.jobId, seq: ++seq, at: new Date().toISOString(), type, payload });
    try {
      const out = await runExperiment(msg.config, msg.data, { emit, cancelled: () => cancelled });
      emit(out.cancelled ? "cancelled" : "completed", out);
    } catch (e) {
      emit("failed", { message: String(e?.message || e) });
    }
  } else if (msg.type === "run") {
    try {
      const runs = msg.items.map((it) => runDetail(msg.config, msg.data, it.strategy, it.split, it.window));
      self.postMessage({ reqId: msg.reqId, runs });
    } catch (e) {
      self.postMessage({ reqId: msg.reqId, error: String(e?.message || e) });
    }
  }
};
