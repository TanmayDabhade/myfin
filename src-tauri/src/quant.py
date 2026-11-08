# Aperture risk analytics, computed with Goldman Sachs' open-source gs-quant
# library (gs_quant.timeseries). Reads one JSON request on stdin:
#   {"symbol": "AAPL", "closes": [["2026-11-06", 341.2], ...],
#    "benchmark": {"symbol": "SPY", "closes": [...]} | null, "riskFree": 0.04}
# and prints one JSON object. Runs offline: none of the functions used here
# call Goldman Sachs services, so no Marquee account is needed.
import json
import math
import sys
import warnings

warnings.filterwarnings("ignore")


def emit(obj):
    sys.stdout.write(json.dumps(obj, allow_nan=False))
    sys.stdout.flush()


try:
    import pandas as pd
    import gs_quant
    from gs_quant import timeseries as ts
    from gs_quant.timeseries.econometrics import excess_returns_pure
    from gs_quant.timeseries.helper import CurveType
except Exception as e:  # not installed, or a broken install
    emit({"error": f"Could not load gs-quant: {type(e).__name__}: {e}"[:300]})
    sys.exit(0)

YEAR, QUARTER, MONTH = 252, 66, 22


def series(rows):
    s = pd.Series({pd.Timestamp(d): float(c) for d, c in rows}).sort_index()
    return s[~s.index.duplicated(keep="last")]


def num(v):
    v = float(v)
    return round(v, 6) if math.isfinite(v) else None


def last(x):
    if isinstance(x, pd.DataFrame):
        x = x.iloc[:, 0]
    x = x.dropna()
    return num(x.iloc[-1]) if len(x) else None


def tail(x, n=YEAR):
    rows = [[d.strftime("%Y-%m-%d"), num(v)] for d, v in x.dropna().tail(n).items()]
    return [r for r in rows if r[1] is not None]


def safe(fn):
    try:
        return fn()
    except Exception:
        return None


def excess_index(px, rate):
    # Excess over cash earning `rate` (Actual/360), via gs-quant's own helper.
    days = px.index.to_series().diff().dt.days.fillna(0)
    return excess_returns_pure(px, (1 + rate * days / 360).cumprod())


req = json.load(sys.stdin)
px = series(req["closes"])
n = len(px)
rate = float(req.get("riskFree") or 0)
enough = lambda w: n > w

m = {
    "vol1m": safe(lambda: last(ts.volatility(px, ts.Window(MONTH, 0)))) if enough(MONTH) else None,
    "vol3m": safe(lambda: last(ts.volatility(px, ts.Window(QUARTER, 0)))) if enough(QUARTER) else None,
    "vol1y": safe(lambda: last(ts.volatility(px, ts.Window(YEAR, 0)))) if enough(YEAR) else None,
    "return1y": safe(lambda: last(ts.returns(px, YEAR))) if enough(YEAR) else None,
    "sharpe1y": safe(
        lambda: last(ts.sharpe_ratio(excess_index(px, rate), w=ts.Window(YEAR, 0), curve_type=CurveType.EXCESS_RETURNS))
    )
    if enough(YEAR)
    else None,
    "maxDrawdown1y": safe(lambda: last(ts.max_drawdown(px, ts.Window(YEAR, 0)))) if enough(YEAR) else None,
    "drawdown": num(px.iloc[-1] / px.tail(YEAR).max() - 1),
    "rsi14": safe(lambda: last(ts.relative_strength_index(px, 14))) if enough(14) else None,
    "zscore3m": safe(lambda: last(ts.zscores(px, ts.Window(QUARTER, 0)))) if enough(QUARTER) else None,
}
bands = safe(lambda: ts.bollinger_bands(px, ts.Window(20, 0), 2).dropna()) if enough(20) else None
if bands is not None and len(bands):
    row = [num(v) for v in bands.iloc[-1]]
    m["bollingerLow"], m["bollingerHigh"] = min(row), max(row)

out_series = {
    "vol": safe(lambda: tail(ts.volatility(px, ts.Window(MONTH, MONTH)))) or [],
    "drawdown": tail(px / px.rolling(YEAR, min_periods=1).max() - 1),
}

bench = req.get("benchmark")
if bench and bench.get("closes"):
    x, b = px.align(series(bench["closes"]), join="inner")
    k = len(x)
    if k > QUARTER:
        m["beta3m"] = safe(lambda: last(ts.beta(x, b, ts.Window(QUARTER, 0))))
        m["corr3m"] = safe(lambda: last(ts.correlation(x, b, ts.Window(QUARTER, 0))))
        out_series["beta"] = safe(lambda: tail(ts.beta(x, b, ts.Window(QUARTER, QUARTER)))) or []
    if k > YEAR:
        m["beta1y"] = safe(lambda: last(ts.beta(x, b, ts.Window(YEAR, 0))))

# ---- Simulations ----------------------------------------------------------
# Monte Carlo by block bootstrap: future daily moves are drawn from this
# stock's own last three years of daily log returns, in 5-day blocks so calm
# and volatile spells stay together, with the average trend replaced by the
# cash rate. numpy does the sampling (it ships with
# gs-quant); the seed comes from the symbol and date, so a recalculation on
# the same data gives the same picture. A simulation, not a forecast.
import zlib
import numpy as np

PATHS, BLOCK, LOOKBACK, HORIZONS = 10000, 5, 3 * YEAR, (MONTH, QUARTER, 2 * QUARTER - 6, YEAR)
seed = zlib.crc32(f"{req.get('symbol')}|{px.index[-1].date()}|{n}".encode())
rng = np.random.default_rng(seed)
logr = np.diff(np.log(px.to_numpy(dtype=float)))[-LOOKBACK:]
# No view on direction: the historical average move is removed and replaced
# by the cash rate, so only the size and pattern of past swings carry over.
drift = np.log1p(rate) / YEAR
logr_sim = logr - logr.mean() + drift


def blocks(m, h, count):
    starts = rng.integers(0, m - BLOCK + 1, size=(count, -(-h // BLOCK)))
    return (starts[:, :, None] + np.arange(BLOCK)).reshape(count, -1)[:, :h]


def r4(v):
    return [num(x) for x in v]


sim = None
if len(logr) >= 2 * QUARTER:
    start = float(px.iloc[-1])
    idx = blocks(len(logr), YEAR, PATHS)
    paths = start * np.exp(np.cumsum(logr_sim[idx], axis=1))
    peaks = np.maximum.accumulate(np.maximum(paths, start), axis=1)
    days = pd.bdate_range(px.index[-1] + pd.Timedelta(days=1), periods=YEAR)
    bands = np.percentile(paths, [5, 25, 50, 75, 95], axis=0)
    horizons = {}
    for h in HORIZONS:
        end = paths[:, h - 1]
        q = np.percentile(end, [0.5, 5, 25, 50, 75, 95, 99.5])
        tail5 = end[end <= q[1]]
        dd = (paths[:, :h] / peaks[:, :h] - 1).min(axis=1)
        counts, edges = np.histogram(end, bins=40, range=(q[0], q[6]))
        horizons[str(h)] = {
            "days": h,
            "date": days[h - 1].strftime("%Y-%m-%d"),
            "p5": num(q[1]), "p25": num(q[2]), "p50": num(q[3]), "p75": num(q[4]), "p95": num(q[5]),
            "up": num((end > start).mean()),
            "up10": num((end >= start * 1.1).mean()),
            "down10": num((end <= start * 0.9).mean()),
            "down20": num((end <= start * 0.8).mean()),
            "cvar5": num(tail5.mean() if len(tail5) else q[1]),
            "drawdownMedian": num(np.median(dd)),
            "drawdown5": num(np.percentile(dd, 5)),
            "hist": {"edges": r4(edges), "counts": counts.tolist()},
        }
    sim = {
        "method": "block bootstrap",
        "paths": PATHS,
        "block": BLOCK,
        "lookback": int(len(logr)),
        "drift": num(rate),
        "start": num(start),
        "dates": [d.strftime("%Y-%m-%d") for d in days],
        "bands": {k: r4(v) for k, v in zip(["p5", "p25", "p50", "p75", "p95"], bands)},
        "examples": [r4(paths[i]) for i in rng.choice(PATHS, 3, replace=False)],
        "horizons": horizons,
    }

# What happened to this stock in simulated months where the market moved a
# given amount: stock and benchmark moves are drawn from the same days.
market = None
if bench and bench.get("closes"):
    x, b = px.align(series(bench["closes"]), join="inner")
    pair = np.diff(np.log(np.column_stack([x.to_numpy(dtype=float), b.to_numpy(dtype=float)])), axis=0)[-LOOKBACK:]
    pair = pair - pair.mean(axis=0) + drift
    if len(pair) >= 2 * QUARTER:
        idx = blocks(len(pair), MONTH, 40000)
        moves = np.expm1(pair[idx].sum(axis=1))  # (paths, 2) one-month simple returns
        rows = []
        for lo, hi, label in [(-1, -0.1, "Down 10%+"), (-0.1, -0.05, "Down 5–10%"), (-0.05, 0, "Down 0–5%"), (0, 0.05, "Up 0–5%"), (0.05, 0.1, "Up 5–10%"), (0.1, 9, "Up 10%+")]:
            hit = moves[(moves[:, 1] > lo) & (moves[:, 1] <= hi), 0]
            rows.append({
                "label": label,
                "share": num(len(hit) / len(moves)),
                "count": int(len(hit)),
                **({"p10": num(np.percentile(hit, 10)), "p50": num(np.median(hit)), "p90": num(np.percentile(hit, 90))} if len(hit) >= 50 else {}),
            })
        market = {"benchmark": bench.get("symbol"), "days": MONTH, "rows": rows}

# Daily moves against a normal curve with the same mean and spread.
daily = None
if len(logr) >= QUARTER:
    simple = np.expm1(logr)
    mu, sd = float(simple.mean()), float(simple.std(ddof=1))
    counts, edges = np.histogram(simple, bins=50)
    centers = (edges[:-1] + edges[1:]) / 2
    width = edges[1] - edges[0]
    normal = len(simple) * width * np.exp(-((centers - mu) ** 2) / (2 * sd * sd)) / (sd * np.sqrt(2 * np.pi))
    dates = px.index[-len(simple):]
    big = int((np.abs(simple - mu) > 3 * sd).sum())
    daily = {
        "days": int(len(simple)),
        "edges": r4(edges),
        "counts": counts.tolist(),
        "normal": r4(normal),
        "sd": num(sd),
        "bigDays": big,
        "bigExpected": num(len(simple) * 0.0027),
        "best": {"date": dates[int(simple.argmax())].strftime("%Y-%m-%d"), "move": num(simple.max())},
        "worst": {"date": dates[int(simple.argmin())].strftime("%Y-%m-%d"), "move": num(simple.min())},
    }

emit(
    {
        "gsQuant": getattr(gs_quant, "__version__", "?"),
        "python": sys.version.split()[0],
        "symbol": req.get("symbol"),
        "benchmark": bench.get("symbol") if bench else None,
        "asOf": px.index[-1].strftime("%Y-%m-%d"),
        "points": n,
        "riskFree": rate,
        "metrics": m,
        "series": out_series,
        "sim": sim,
        "market": market,
        "daily": daily,
    }
)
