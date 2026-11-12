// Bar-by-bar replay of a finished backtest. The result is already computed;
// this only reveals it over time so entries, exits and the equity curve can
// be watched forming. Nothing here changes the numbers.
const SPEEDS = [
  ["1×", 6],
  ["5×", 30],
  ["20×", 120],
  ["60×", 360],
];
const states = new Map();
const C = { line: "#ededed", dim: "#8d8d8d", grid: "#262626", up: "#4cc38a", down: "#f0716a", hold: "rgba(76,195,138,0.09)" };

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (v) => "$" + Math.round(v).toLocaleString("en-US");
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");

// data: { bars (window only, {date, close}), result (backtest output), title }
export function mountReplay(el, key, data) {
  let st = states.get(key);
  if (!st || st.data !== data) {
    st = { data, i: 0, playing: true, speed: 1, acc: 0, last: 0, raf: 0, prep: prepare(data) };
    states.set(key, st);
  }
  if (!st.prep) {
    el.innerHTML = `<p class="muted">No bars to replay in this window.</p>`;
    return;
  }
  el.innerHTML = `<div class="ql-sim">
    <div class="ql-sim-bar">
      <button data-sim="play" class="primary">${st.playing ? "Pause" : "Play"}</button>
      <button data-sim="restart">Restart</button>
      <div class="ql-seg" role="group" aria-label="Replay speed">${SPEEDS.map(([l], j) => `<button data-sim="speed" data-v="${j}" class="${j === st.speed ? "active" : ""}">${l}</button>`).join("")}</div>
      <input type="range" data-sim="seek" min="0" max="${st.prep.n - 1}" value="${st.i}" aria-label="Replay position">
      <span class="ql-sim-date" data-sim="date"></span>
    </div>
    <div class="ql-sim-body">
      <div class="ql-sim-charts">
        <div class="ql-sim-cap">Price · <span class="up">▲ buy</span> <span class="down">▼ sell</span> · shaded while holding</div>
        <canvas data-sim="price" height="230"></canvas>
        <div class="ql-sim-cap">Equity <b>strategy</b> vs <span class="muted">buy &amp; hold</span></div>
        <canvas data-sim="equity" height="150"></canvas>
      </div>
      <div class="ql-sim-side">
        <dl class="ql-sim-stats" data-sim="stats"></dl>
        <div class="ql-sim-cap">Trades as they close</div>
        <ol class="ql-sim-log" data-sim="log"></ol>
      </div>
    </div>
  </div>`;
  const q = (s) => el.querySelector(`[data-sim="${s}"]`);
  q("play").onclick = () => {
    if (st.i >= st.prep.n - 1) st.i = 0;
    st.playing = !st.playing;
    q("play").textContent = st.playing ? "Pause" : "Play";
    if (st.playing) loop();
  };
  q("restart").onclick = () => {
    st.i = 0;
    st.acc = 0;
    st.playing = true;
    q("play").textContent = "Pause";
    draw(el, st);
    loop();
  };
  el.querySelectorAll('[data-sim="speed"]').forEach(
    (b) =>
      (b.onclick = () => {
        st.speed = +b.dataset.v;
        el.querySelectorAll('[data-sim="speed"]').forEach((x) => x.classList.toggle("active", x === b));
      }),
  );
  q("seek").oninput = (ev) => {
    st.i = +ev.target.value;
    draw(el, st);
  };
  const loop = () => {
    cancelAnimationFrame(st.raf);
    st.last = performance.now();
    const tick = (now) => {
      if (!el.isConnected || !st.playing) return;
      st.acc += ((now - st.last) / 1000) * SPEEDS[st.speed][1];
      st.last = now;
      const step = Math.floor(st.acc);
      if (step) {
        st.acc -= step;
        st.i = Math.min(st.prep.n - 1, st.i + step);
        draw(el, st);
      }
      if (st.i >= st.prep.n - 1) {
        st.playing = false;
        q("play").textContent = "Replay";
        return;
      }
      st.raf = requestAnimationFrame(tick);
    };
    st.raf = requestAnimationFrame(tick);
  };
  draw(el, st);
  if (st.playing) loop();
}

function prepare({ bars, result }) {
  const dates = result?.dates || [];
  if (dates.length < 2) return null;
  const close = new Map(bars.map((b) => [b.date, b.close]));
  const px = dates.map((d) => close.get(d) ?? null);
  const at = new Map(dates.map((d, i) => [d, i]));
  const first = px.find((v) => v != null);
  const eq = result.equity.map((v) => v / result.initialCash - 1);
  const bh = px.map((v) => (v == null ? null : v / first - 1));
  const fills = result.fills.filter((f) => at.has(f.filledAt)).map((f) => ({ ...f, i: at.get(f.filledAt) }));
  const trades = result.trades.map((t) => ({ ...t, a: at.get(t.entryAt) ?? 0, b: at.get(t.exitAt) ?? dates.length - 1 }));
  const open = result.openPosition ? { a: at.get(result.openPosition.entryAt) ?? 0, ...result.openPosition } : null;
  const range = (xs) => {
    const v = xs.filter((x) => x != null && Number.isFinite(x));
    let lo = Math.min(...v),
      hi = Math.max(...v);
    const pad = (hi - lo) * 0.08 || 1e-6;
    return [lo - pad, hi + pad];
  };
  return { n: dates.length, dates, px, eq, bh, fills, trades, open, pr: range(px), er: range([...eq, ...bh, 0]), cash: result.initialCash };
}

function canvas(cv) {
  const dpr = globalThis.devicePixelRatio || 1;
  const W = Math.max(200, cv.clientWidth || cv.parentElement.clientWidth);
  const H = +cv.getAttribute("height");
  if (cv.width !== Math.round(W * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.style.height = H + "px";
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  return { g, W, H };
}

function draw(el, st) {
  const P = st.prep,
    i = st.i;
  const L = 6,
    R = 62,
    T = 10,
    B = 8;
  const xOf = (W) => (k) => L + (k / (P.n - 1)) * (W - L - R);
  const yOf = (H, [lo, hi]) => (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const axis = (g, W, y, [lo, hi], fmt) => {
    g.font = "11px ui-sans-serif, system-ui";
    g.textBaseline = "middle";
    for (let t = 0; t <= 3; t++) {
      const v = lo + ((hi - lo) * t) / 3;
      g.strokeStyle = C.grid;
      g.beginPath();
      g.moveTo(L, y(v));
      g.lineTo(W - R, y(v));
      g.stroke();
      g.fillStyle = C.dim;
      g.fillText(fmt(v), W - R + 8, y(v));
    }
  };
  const path = (g, x, y, vals, color, width = 1.5, dash = []) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.setLineDash(dash);
    g.beginPath();
    let on = false;
    for (let k = 0; k <= i; k++) {
      const v = vals[k];
      if (v == null) continue;
      on ? g.lineTo(x(k), y(v)) : g.moveTo(x(k), y(v));
      on = true;
    }
    g.stroke();
    g.setLineDash([]);
  };

  // Price, holding periods and fills revealed up to bar i.
  {
    const { g, W, H } = canvas(el.querySelector('[data-sim="price"]'));
    const x = xOf(W),
      y = yOf(H, P.pr);
    axis(g, W, y, P.pr, (v) => "$" + v.toFixed(v < 20 ? 2 : 0));
    g.fillStyle = C.hold;
    const spans = P.trades.filter((t) => t.a <= i).map((t) => [t.a, Math.min(t.b, i)]);
    if (P.open && P.open.a <= i) spans.push([P.open.a, i]);
    for (const [a, b] of spans) g.fillRect(x(a), T, Math.max(1, x(b) - x(a)), H - T - B);
    path(g, x, y, P.px, C.line);
    for (const f of P.fills) {
      if (f.i > i) break;
      const cx = x(f.i),
        cy = y(f.price),
        buy = f.side === "buy",
        s = 5;
      g.fillStyle = buy ? C.up : C.down;
      g.beginPath();
      if (buy) (g.moveTo(cx, cy + 4), g.lineTo(cx - s, cy + 4 + s * 1.6), g.lineTo(cx + s, cy + 4 + s * 1.6));
      else (g.moveTo(cx, cy - 4), g.lineTo(cx - s, cy - 4 - s * 1.6), g.lineTo(cx + s, cy - 4 - s * 1.6));
      g.fill();
    }
    if (P.px[i] != null) {
      g.strokeStyle = "#555";
      g.beginPath();
      g.moveTo(x(i), T);
      g.lineTo(x(i), H - B);
      g.stroke();
      g.fillStyle = C.line;
      g.beginPath();
      g.arc(x(i), y(P.px[i]), 3, 0, 7);
      g.fill();
    }
  }
  // Equity against holding the stock the whole time.
  {
    const { g, W, H } = canvas(el.querySelector('[data-sim="equity"]'));
    const x = xOf(W),
      y = yOf(H, P.er);
    axis(g, W, y, P.er, (v) => (v * 100).toFixed(0) + "%");
    g.strokeStyle = "#444";
    g.beginPath();
    g.moveTo(L, y(0));
    g.lineTo(W - R, y(0));
    g.stroke();
    path(g, x, y, P.bh, C.dim, 1.2, [4, 3]);
    path(g, x, y, P.eq, P.eq[i] >= 0 ? C.up : C.down, 2);
  }

  const closed = P.trades.filter((t) => t.b <= i && t.exitAt);
  const wins = closed.filter((t) => t.pnl > 0).length;
  const holding = P.trades.find((t) => t.a <= i && t.b > i) || (P.open && P.open.a <= i ? P.open : null);
  const eqv = P.cash * (1 + P.eq[i]);
  const stats = [
    ["Date", esc(P.dates[i])],
    ["Equity", money(eqv)],
    ["Strategy", `<span class="${P.eq[i] >= 0 ? "up" : "down"}">${pct(P.eq[i])}</span>`],
    ["Buy & hold", pct(P.bh[i])],
    ["Position", holding ? `Long ${holding.qty} @ ${money(holding.entryPrice)}` : "Flat (cash)"],
    ["Closed trades", closed.length],
    ["Win rate", closed.length ? Math.round((wins / closed.length) * 100) + "%" : "—"],
  ];
  el.querySelector('[data-sim="stats"]').innerHTML = stats.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  el.querySelector('[data-sim="log"]').innerHTML = closed.length
    ? closed
        .slice(-8)
        .reverse()
        .map((t) => `<li><span>${esc(t.entryAt)} → ${esc(t.exitAt.slice(5))}</span><span>${t.bars}d</span><b class="${t.pnl >= 0 ? "up" : "down"}">${pct(t.return)}</b></li>`)
        .join("")
    : `<li class="muted">No closed trades yet.</li>`;
  el.querySelector('[data-sim="date"]').textContent = `Bar ${i + 1} of ${P.n}`;
  const seek = el.querySelector('[data-sim="seek"]');
  if (+seek.value !== i) seek.value = i;
}
