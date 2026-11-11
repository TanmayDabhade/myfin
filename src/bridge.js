import { sample } from "./sample.js";
const invoke = window.__TAURI__?.core.invoke;
export const native = !!invoke;
const KEY = "aperture-v1";
export async function load() {
  return (
    (native
      ? await invoke("load_state")
      : JSON.parse(
          localStorage.getItem(KEY) ||
            // Saved before the app was renamed from Market Lens.
            localStorage.getItem("market-lens-v1") ||
            "null",
        )) ||
    sample()
  );
}
export async function save(state) {
  if (native) await invoke("save_state", { state });
  else localStorage.setItem(KEY, JSON.stringify(state));
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
// force: new data is known to exist, so skip the usual cache lifetime.
export async function fetchData(provider, kind, symbol, force = false) {
  if (!native) throw Error("Live data connects in the desktop app.");
  return invoke("fetch_data", { provider, kind, symbol, force });
}
export async function fetchSEC(kind, cik = "", accession = "", doc = "", force = false) {
  if (!native) throw Error("Live data connects in the desktop app.");
  return invoke("fetch_sec", { kind, cik, accession, doc, force });
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
export const quotesTape = (symbol, since = 0) => invoke("quotes_tape", { symbol, since });
// Reference data: SEC 13F holdings and the world listing directory.
const call = (cmd, args) => (native ? invoke(cmd, args) : Promise.reject(Error("Holder and listing data load in the desktop app.")));
export const holdingsStatus = () => call("holdings_status");
export const holdingsUpdate = (quarters) => call("holdings_update", { quarters });
export const holdersFor = (ticker, name, extra = [], only = null, period = null) => call("holders", { ticker, name, extra, only, period });
export const holderPortfolio = (cik, period = null) => call("holder_portfolio", { cik, period });
export const holdersFind = (q) => call("holders_find", { q });
export const universeStatus = () => call("universe_status");
export const universeRefresh = () => call("universe_refresh");
export const universeSearch = (q, limit = 10) => call("universe_search", { q, limit });
export const universeBrowse = (f) => call("universe_browse", f);
export const universeFacets = () => call("universe_facets");
export const universeGet = (key) => call("universe_get", { key });
// S&P 500 market map, built in the background by the desktop app.
export const marketStatus = () => call("market_status");
export const marketRefresh = () => call("market_refresh");
export const marketSnapshot = () => call("market_snapshot");
// Risk analytics from GS Quant, run by the user's Python in the desktop app.
export const quantStatus = (refresh = false) => call("quant_status", { refresh });
export const quantChoose = () => call("quant_choose");
export const quantForget = () => call("quant_forget");
export const quantAnalyze = (input) => call("quant_analyze", { input });
export const quantAnalyzeBatch = (inputs) => call("quant_analyze_batch", { inputs });
export const quantCached = (symbols) => call("quant_cached", { symbols });
// Aperture Analyst (desktop only): a model on this computer or one from the
// user's online account. Account keys never come back to the window.
export const analystStatus = () => call("analyst_status");
export const analystInstall = () => call("analyst_install");
export const analystRemove = () => call("analyst_remove");
export const analystChat = (id, messages, tools, allowTools) => call("analyst_chat", { id, messages, tools, allowTools });
// { choice?, serverUrl?, serverModel?, provider?, model? }
export const analystConfigure = (c) => call("analyst_configure", c);
export const analystPickModel = () => call("analyst_pick_model");
export const analystSetKey = (provider, key) => call("analyst_set_key", { provider, key });
export const analystSignOut = (provider) => call("analyst_sign_out", { provider });
export const analystSignIn = () => call("analyst_sign_in");
export const analystModels = (target) => call("analyst_models", { target });
export const analystCancel = () => (native ? invoke("analyst_cancel") : Promise.resolve());
export const analystNews = (query) => call("analyst_news", { query });
export const analystRead = (url) => call("analyst_read", { url });
// Streamed reply text: fn({ id, text?, stage? }).
export const onAnalystDelta = (fn) => window.__TAURI__?.event?.listen?.("analyst-delta", (e) => fn(e.payload));
