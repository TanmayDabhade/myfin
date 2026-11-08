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
    }
)
