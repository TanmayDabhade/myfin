import { sample } from "./sample.js";
const invoke = window.__TAURI__?.core.invoke;
export const native = !!invoke;
export async function load() {
  return (
    (native
      ? await invoke("load_state")
      : JSON.parse(localStorage.getItem("market-lens-v1") || "null")) ||
    sample()
  );
}
export async function save(state) {
  if (native) await invoke("save_state", { state });
  else localStorage.setItem("market-lens-v1", JSON.stringify(state));
}
// Which providers have a key. Never returns the keys themselves.
export async function keyStatus() {
  return native ? invoke("key_status") : null;
}
export async function saveKeys(keys) {
  if (!native) throw Error("Live data connects in the desktop app.");
  return invoke("set_keys", { keys });
}
export async function clearKey(provider) {
  return invoke("clear_key", { provider });
}
export async function fetchData(provider, kind, symbol) {
  if (!native) throw Error("Live data connects in the desktop app.");
  return invoke("fetch_data", { provider, kind, symbol });
}
export async function fetchMaritime(id) {
  if (!native) throw Error("Live data connects in the desktop app.");
  return invoke("fetch_maritime", { id });
}
export async function fetchSEC(kind, cik = "", accession = "", doc = "") {
  if (!native) throw Error("Live data connects in the desktop app.");
  return invoke("fetch_sec", { kind, cik, accession, doc });
}
export const aisStart = (area, lat, lon) => invoke("ais_start", { area, lat, lon });
export const aisStop = () => (native ? invoke("ais_stop") : Promise.resolve());
export const aisSnapshot = () => invoke("ais_snapshot");
export async function nativeTrade(mode, order) {
  return invoke("paper_trade", { mode, order });
}
export const quotesStart = (symbols) => invoke("quotes_start", { symbols });
export const quotesStop = () => (native ? invoke("quotes_stop") : Promise.resolve());
export const quotesSnapshot = () => invoke("quotes_snapshot");
