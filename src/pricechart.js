// Price and order-flow charts drawn with TradingView's open-source
// Lightweight Charts. Times are New York wall-clock seconds (candles.js),
// so the axis shows exchange time as is.
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, BaselineSeries, createSeriesMarkers, CrosshairMode, LineStyle } from "lightweight-charts";
import { movingAverage } from "./candles.js";

export const UP = "#4cc38a",
  DOWN = "#f0716a";
const fade = (c, a) => c + Math.round(a * 255).toString(16).padStart(2, "0");

const base = (intraday) => ({
  autoSize: true,
  layout: {
    background: { color: "transparent" },
    textColor: "#8d8d8d",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 10,
    attributionLogo: true,
  },
  grid: { vertLines: { color: "#202020" }, horzLines: { color: "#242424" } },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: "#6b6b6b", labelBackgroundColor: "#2f2f2f" },
    horzLine: { color: "#6b6b6b", labelBackgroundColor: "#2f2f2f" },
  },
  rightPriceScale: { borderColor: "#2b2b2b", scaleMargins: { top: 0.08, bottom: 0.24 } },
  timeScale: { borderColor: "#2b2b2b", timeVisible: intraday, secondsVisible: false, rightOffset: 8, barSpacing: 7, minBarSpacing: 0.5 },
  localization: { priceFormatter: (p) => p.toFixed(2) },
});
const quiet = { lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };

const clockFmt = (t, intraday) => {
  const d = new Date(t * 1000).toISOString();
  return intraday ? `${d.slice(0, 10)} ${d.slice(11, 16)}` : d.slice(0, 10);
};
const compactVol = (v) => (v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(Math.round(v)));

// A candle (or line) chart with volume, MA20/MA50, an optional comparison
// line and trade markers. `readout` receives a one-line OHLCV description of
// the bar under the cursor, or of the newest bar.
export function priceChart(host, { intraday = false, candles = true, symbol = "", readout = () => {} } = {}) {
  const chart = createChart(host, base(intraday));
  const main = candles
    ? chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN })
    : chart.addSeries(LineSeries, { color: "#f5f5f5", lineWidth: 2 });
  const vol = chart.addSeries(HistogramSeries, { ...quiet, priceScaleId: "vol", priceFormat: { type: "volume" } });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  const ma20 = chart.addSeries(LineSeries, { ...quiet, color: "#a3a3a3", lineWidth: 1 });
  const ma50 = chart.addSeries(LineSeries, { ...quiet, color: "#5c5c5c", lineWidth: 1 });
  const peer = chart.addSeries(LineSeries, { ...quiet, color: "#ffffff", lineWidth: 1, lineStyle: LineStyle.Dashed });
  const marks = createSeriesMarkers(main, []);
  let bars = [],
    shown = 0,
    first = null;

  const point = (b) => (candles ? { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close } : { time: b.time, value: b.close });
  const volPoint = (b) => ({ time: b.time, value: b.volume || 0, color: fade(b.close >= b.open ? UP : DOWN, 0.35) });
  const describe = (i) => {
    const b = bars[i];
    if (!b) return readout("");
    const prev = bars[i - 1]?.close,
      ch = prev ? ((b.close - prev) / prev) * 100 : null;
    readout(
      `${symbol} · ${clockFmt(b.time, intraday)}   O ${b.open.toFixed(2)}   H ${b.high.toFixed(2)}   L ${b.low.toFixed(2)}   C ${b.close.toFixed(2)}${ch == null ? "" : `   ${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`}   VOL ${compactVol(b.volume || 0)}`,
      ch,
    );
  };
  const index = new Map();
  chart.subscribeCrosshairMove((p) => {
    const i = p?.time == null ? undefined : index.get(p.time);
    describe(i ?? bars.length - 1);
  });
  const averages = () => {
    ma20.setData(movingAverage(bars, 20));
    ma50.setData(movingAverage(bars, 50));
  };

  return {
    chart,
    // Replaces everything. `peer` is [{ time, value }] already scaled.
    setData(next, { peerLine = [], markers = [] } = {}) {
      bars = next;
      shown = bars.length;
      first = bars[0]?.time ?? null;
      index.clear();
      bars.forEach((b, i) => index.set(b.time, i));
      main.setData(bars.map(point));
      vol.setData(bars.map(volPoint));
      averages();
      peer.setData(peerLine);
      marks.setMarkers(markers);
      describe(bars.length - 1);
    },
    // New or changed bars at the end: redraw only those.
    update(next) {
      if (!next.length || next[0].time !== first || next.length < shown || next.length - shown > 50) return this.setData(next);
      bars = next;
      for (let i = Math.max(0, shown - 1); i < bars.length; i++) {
        index.set(bars[i].time, i);
        main.update(point(bars[i]));
        vol.update(volPoint(bars[i]));
      }
      shown = bars.length;
      averages();
      describe(bars.length - 1);
    },
    // Show the newest `n` bars.
    showLast(n = 150) {
      const len = bars.length;
      if (len) chart.timeScale().setVisibleLogicalRange({ from: Math.max(-2, len - n), to: len + 6 });
    },
    fit: () => chart.timeScale().fitContent(),
    getRange: () => chart.timeScale().getVisibleLogicalRange(),
    setRange: (r) => chart.timeScale().setVisibleLogicalRange(r),
    onRange: (fn) => chart.timeScale().subscribeVisibleLogicalRangeChange(fn),
    size: () => bars.length,
    png: () => chart.takeScreenshot().toDataURL("image/png"),
    destroy: () => chart.remove(),
  };
}

// Running buy-minus-sell volume: green above zero, red below.
export function deltaChart(host) {
  const chart = createChart(host, {
    ...base(true),
    rightPriceScale: { borderColor: "#2b2b2b", scaleMargins: { top: 0.1, bottom: 0.1 } },
    timeScale: { borderColor: "#2b2b2b", timeVisible: true, secondsVisible: true, rightOffset: 4 },
    localization: { priceFormatter: (v) => (v < 0 ? "−" : v > 0 ? "+" : "") + compactVol(Math.abs(v)) },
  });
  const line = chart.addSeries(BaselineSeries, {
    baseValue: { type: "price", price: 0 },
    topLineColor: UP,
    topFillColor1: fade(UP, 0.28),
    topFillColor2: fade(UP, 0.04),
    bottomLineColor: DOWN,
    bottomFillColor1: fade(DOWN, 0.04),
    bottomFillColor2: fade(DOWN, 0.28),
    lineWidth: 2,
    priceLineVisible: false,
  });
  let fitted = false;
  return {
    setData(points) {
      line.setData(points);
      if (!fitted && points.length) {
        chart.timeScale().fitContent();
        fitted = true;
      }
    },
    destroy: () => chart.remove(),
  };
}
