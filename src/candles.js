// Candles at any timeframe, and keeping the newest one moving with live
// trades. Times are New York wall-clock seconds written as if they were UTC,
// so the chart's time axis reads in exchange time with no timezone handling.

// Intraday bars come from Twelve Data; daily and weekly are built from the
// daily history the app already keeps.
export const INTERVALS = [
  { id: "1m", label: "1m", sec: 60, kind: "INTRADAY_1MIN", name: "1-minute" },
  { id: "5m", label: "5m", sec: 300, kind: "INTRADAY_5MIN", name: "5-minute" },
  { id: "15m", label: "15m", sec: 900, kind: "INTRADAY_15MIN", name: "15-minute" },
  { id: "1h", label: "1H", sec: 3600, kind: "INTRADAY_1H", name: "hourly" },
  { id: "4h", label: "4H", sec: 14400, kind: "INTRADAY_4H", name: "4-hour" },
  { id: "1D", label: "D", sec: 86400, name: "daily" },
  { id: "1W", label: "W", sec: 604800, name: "weekly" },
];
export const intervalOf = (id) => INTERVALS.find((x) => x.id === id) || INTERVALS[5];
export const isIntraday = (id) => intervalOf(id).sec < 86400;

// How often the chart redraws with new trades. 0 = as trades arrive.
export const FREQUENCIES = [
  { id: "live", label: "Real-time", ms: 0 },
  { id: "1s", label: "Every 1s", ms: 1000 },
  { id: "5s", label: "Every 5s", ms: 5000 },
  { id: "15s", label: "Every 15s", ms: 15000 },
  { id: "1m", label: "Every 1m", ms: 60000 },
  { id: "off", label: "Paused", ms: Infinity },
];
export const frequencyOf = (id) => FREQUENCIES.find((x) => x.id === id) || FREQUENCIES[0];

const DAY = 86400;
const OPEN = 9.5 * 3600,
  CLOSE = 16 * 3600;

// New York's offset from UTC, cached per hour (it only changes at DST).
const nyParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const offsets = new Map();
function nyOffset(ms) {
  const hour = Math.floor(ms / 3600000);
  let off = offsets.get(hour);
  if (off == null) {
    const p = Object.fromEntries(nyParts.formatToParts(new Date(hour * 3600000)).map((x) => [x.type, +x.value]));
    off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - hour * 3600000;
    if (offsets.size > 2000) offsets.clear();
    offsets.set(hour, off);
  }
  return off;
}
// Unix milliseconds -> New York wall-clock seconds.
export const nyWall = (ms) => Math.floor((ms + nyOffset(ms)) / 1000);

// "2026-11-10 09:30:00" or "2026-11-10" (New York time) -> wall-clock seconds.
export function parseWall(text) {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d))?)?/.exec(String(text || ""));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 1000;
}
const weekday = (t) => new Date(t * 1000).getUTCDay(); // 0 Sunday
// Monday to Friday, 9:30 to 16:00. Holidays are not modeled.
export function inSession(t) {
  const d = weekday(t),
    s = t % DAY;
  return d >= 1 && d <= 5 && s >= OPEN && s < CLOSE;
}

// Start of the bar a trade at wall-clock time `t` belongs to. Intraday bars
// are counted from the 9:30 open, the way Twelve Data and TradingView align
// hourly and 4-hour bars (9:30, 10:30 …).
export function bucketStart(t, id) {
  const day = t - (t % DAY);
  if (id === "1D") return day;
  if (id === "1W") return day - ((weekday(day) + 6) % 7) * DAY;
  const sec = intervalOf(id).sec,
    open = day + OPEN;
  return open + Math.floor((t - open) / sec) * sec;
}

const num = (x) => {
  const n = typeof x === "string" ? Number(x) : x;
  return Number.isFinite(n) ? n : null;
};
// Twelve Data time_series (newest first) -> bars oldest first.
export function fromTwelve(data) {
  const seen = new Set();
  return (data?.values || [])
    .map((v) => ({ time: parseWall(v.datetime), open: num(v.open), high: num(v.high), low: num(v.low), close: num(v.close), volume: num(v.volume) ?? 0 }))
    .filter((b) => b.time != null && b.open != null && b.high != null && b.low != null && b.close != null && !seen.has(b.time) && seen.add(b.time))
    .sort((a, b) => a.time - b.time);
}
// The app's daily bars ({ date, open, … }) -> chart bars.
export function dailyBars(bars) {
  return (bars || []).map((b) => ({ time: parseWall(b.date), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 })).filter((b) => b.time != null);
}
// Daily bars -> weekly bars, each dated by its Monday.
export function weeklyBars(days) {
  const out = [];
  for (const b of days) {
    const time = bucketStart(b.time, "1W"),
      w = out.at(-1);
    if (w && w.time === time) {
      w.high = Math.max(w.high, b.high);
      w.low = Math.min(w.low, b.low);
      w.close = b.close;
      w.volume += b.volume;
    } else out.push({ ...b, time });
  }
  return out;
}

// Applies trade prints ({ price, size, time ms }) to intraday bars in place.
// Trades outside the regular session are skipped, as the provider's bars
// cover regular hours only. Returns how many prints landed on a bar.
export function applyPrints(bars, prints, id) {
  let used = 0;
  for (const p of prints || []) {
    if (!(p?.price > 0) || !Number.isFinite(p.time)) continue;
    const t = nyWall(p.time);
    if (!inSession(t)) continue;
    const time = bucketStart(t, id),
      size = p.size > 0 ? p.size : 0;
    const last = bars.at(-1);
    if (!last || time > last.time) {
      bars.push({ time, open: p.price, high: p.price, low: p.price, close: p.price, volume: size });
      used++;
      continue;
    }
    // A late print for an earlier bar: it widens the range and adds volume,
    // but the close stays with the newest trade.
    let i = bars.length - 1;
    while (i > 0 && bars[i].time > time) i--;
    const b = bars[i];
    if (b.time !== time) continue;
    b.high = Math.max(b.high, p.price);
    b.low = Math.min(b.low, p.price);
    b.volume += size;
    if (i === bars.length - 1) b.close = p.price;
    used++;
  }
  return used;
}

// Simple moving average of closes as chart points (skips the warm-up).
export function movingAverage(bars, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: bars[i].time, value: sum / n });
  }
  return out;
}

// Whether stored intraday bars should be downloaded again. While the market
// is open: after `maxAge` seconds (longer when live trades keep the newest
// bar moving). Once it closes: when the last download was made during the
// session, so the final bars are picked up once.
export function barsDue(st, { now = Date.now(), open, wasOpen, streaming }) {
  if (!st?.fetchedAt) return true;
  const age = now / 1000 - st.fetchedAt;
  if (open) return age > (streaming ? 600 : 120);
  return !!wasOpen && age > 60;
}
