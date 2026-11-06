// Real-time trades on top of daily bars. A trade updates today's bar, or
// starts one when the last stored bar is from an earlier session.
const nyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
// US equity sessions are dated in New York time.
export const nyDate = (ms) => nyFormat.format(new Date(ms));

// Applies one trade { price, time (ms) } to an asset in place.
// Returns true when the asset changed.
export function applyTrade(asset, q) {
  const last = asset?.bars?.at(-1);
  if (!last || !(q?.price > 0) || !Number.isFinite(q.time)) return false;
  if (asset.live && asset.live.time >= q.time) return false;
  const date = nyDate(q.time);
  if (date < last.date) return false;
  if (date === last.date) {
    last.close = q.price;
    last.high = Math.max(last.high, q.price);
    last.low = Math.min(last.low, q.price);
  } else
    asset.bars.push({ date, open: q.price, high: q.price, low: q.price, close: q.price, volume: 0 });
  asset.live = { price: q.price, time: q.time };
  return true;
}
