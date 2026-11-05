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
export async function keys(alpha, fred) {
  if (!native)
    throw Error(
      "API connections are available in the native desktop app. Browser preview is offline.",
    );
  await invoke("set_keys", { alpha, fred });
}
export async function fetchData(provider, kind, symbol) {
  if (!native)
    throw Error(
      "Run the Tauri desktop app to connect providers. You can import CSV data here.",
    );
  return invoke("fetch_data", { provider, kind, symbol });
}

export async function nativeTrade(mode, order) {
  return invoke("paper_trade", { mode, order });
}
