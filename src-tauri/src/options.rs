//! Option chains: contract symbols, Alpaca's free indicative feed, chain
//! analytics (parity forward, implied volatility, Greeks, quality flags),
//! daily summaries and the `options.sqlite` store. Pure parts only; the
//! network loops live in `recorder.rs`. All maths is `options_math`.
use options_math::black::{self, Kind};
use options_math::forward::parity_forward;
use options_math::iv;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};

// ---- Time ------------------------------------------------------------------

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
pub fn parse_date(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if s.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y = s[0..4].parse().ok()?;
    let m = s[5..7].parse().ok()?;
    let d = s[8..10].parse().ok()?;
    ((1..=12).contains(&m) && (1..=31).contains(&d)).then(|| days_from_civil(y, m, d))
}
pub fn date_string(days: i64) -> String {
    crate::providers::ymd(days * 86_400)
}
fn weekday(days: i64) -> i64 {
    (days + 4).rem_euclid(7) // 0 = Sunday
}
/// The n-th (1-based) weekday `wd` of a month, as days since epoch.
fn nth_weekday(y: i64, m: i64, wd: i64, n: i64) -> i64 {
    let first = days_from_civil(y, m, 1);
    first + (wd - weekday(first)).rem_euclid(7) + 7 * (n - 1)
}
/// New York's UTC offset in seconds at Unix time `t` (US rules since 2007).
pub fn ny_offset(t: i64) -> i64 {
    let (y, _, _, _) = crate::providers::civil_date(t);
    // DST: second Sunday of March 2:00 local (7:00 UTC) to first Sunday of November 2:00 local (6:00 UTC).
    let start = nth_weekday(y, 3, 0, 2) * 86_400 + 7 * 3600;
    let end = nth_weekday(y, 11, 0, 1) * 86_400 + 6 * 3600;
    if t >= start && t < end { -4 * 3600 } else { -5 * 3600 }
}
/// (New York date as days since epoch, seconds since New York midnight).
pub fn ny_clock(t: i64) -> (i64, i64) {
    let local = t + ny_offset(t);
    (local.div_euclid(86_400), local.rem_euclid(86_400))
}
/// NYSE full-day holidays by rule (New Year, MLK, Presidents, Good Friday,
/// Memorial, Juneteenth, Independence, Labor, Thanksgiving, Christmas).
pub fn nyse_holiday(days: i64) -> bool {
    let (y, _, _, _) = crate::providers::civil_date(days * 86_400);
    let observed = |mm: i64, dd: i64| {
        let x = days_from_civil(y, mm, dd);
        match weekday(x) {
            6 => x - 1,
            0 => x + 1,
            _ => x,
        }
    };
    // Easter (anonymous Gregorian algorithm) → Good Friday.
    let a = y % 19;
    let b = y / 100;
    let c = y % 100;
    let dd = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - dd - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let mm = (a + 11 * h + 22 * l) / 451;
    let em = (h + l - 7 * mm + 114) / 31;
    let ed = (h + l - 7 * mm + 114) % 31 + 1;
    let good_friday = days_from_civil(y, em, ed) - 2;
    let last_monday_may = nth_weekday(y, 6, 1, 1) - 7;
    let list = [
        observed(1, 1),
        nth_weekday(y, 1, 1, 3),
        nth_weekday(y, 2, 1, 3),
        good_friday,
        last_monday_may,
        if y >= 2022 { observed(6, 19) } else { -1 },
        observed(7, 4),
        nth_weekday(y, 9, 1, 1),
        nth_weekday(y, 11, 4, 4),
        observed(12, 25),
    ];
    list.contains(&days)
}
pub fn trading_day(days: i64) -> bool {
    !matches!(weekday(days), 0 | 6) && !nyse_holiday(days)
}

// ---- Contracts -----------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct Contract {
    /// OCC symbol without padding, e.g. AAPL261218C00250000.
    pub symbol: String,
    pub root: String,
    pub kind: Kind,
    pub strike: f64,
    /// YYYY-MM-DD
    pub expiry: String,
}

/// Parses an OCC option symbol (optionally prefixed "O:", root padded or not).
pub fn parse_occ(sym: &str) -> Option<Contract> {
    let s: String = sym.trim_start_matches("O:").chars().filter(|c| *c != ' ').collect();
    if s.len() < 16 || s.len() > 21 || !s.is_ascii() {
        return None;
    }
    let tail = &s[s.len() - 15..];
    let root = &s[..s.len() - 15];
    if root.is_empty() || !root.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') {
        return None;
    }
    let (date, cp, strike) = (&tail[0..6], &tail[6..7], &tail[7..15]);
    if !date.chars().all(|c| c.is_ascii_digit()) || !strike.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let kind = match cp {
        "C" => Kind::Call,
        "P" => Kind::Put,
        _ => return None,
    };
    let expiry = format!("20{}-{}-{}", &date[0..2], &date[2..4], &date[4..6]);
    parse_date(&expiry)?;
    Some(Contract { symbol: s.clone(), root: root.to_string(), kind, strike: strike.parse::<f64>().ok()? / 1000.0, expiry })
}

/// OCC symbol for a contract.
#[allow(dead_code)] // used by tests and the backfill planner tests
pub fn occ_symbol(root: &str, expiry: &str, kind: Kind, strike: f64) -> String {
    let d = expiry.replace('-', "");
    format!("{}{}{}{:08}", root, &d[2..8], if kind == Kind::Call { "C" } else { "P" }, (strike * 1000.0).round() as i64)
}

// ---- Quotes and Alpaca ----------------------------------------------------

#[derive(Clone, Debug, Default, Serialize)]
pub struct Quote {
    pub symbol: String,
    pub kind: String,
    pub strike: f64,
    pub expiry: String,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub last: Option<f64>,
    pub volume: Option<f64>,
    pub open_interest: Option<f64>,
    pub oi_date: Option<String>,
    pub quote_time: Option<String>,
    pub multiplier: f64,
    pub style: String,
    pub vendor_iv: Option<f64>,
    pub vendor_delta: Option<f64>,
    // Ours:
    pub iv: Option<f64>,
    pub delta: Option<f64>,
    pub gamma: Option<f64>,
    pub theta: Option<f64>,
    pub vega: Option<f64>,
    pub rho: Option<f64>,
    pub flags: Vec<String>,
}

impl Quote {
    pub fn mid(&self) -> Option<f64> {
        match (self.bid, self.ask) {
            (Some(b), Some(a)) if b > 0.0 && a >= b => Some(0.5 * (a + b)),
            _ => None,
        }
    }
}

pub const ALPACA_DATA: &str = "https://data.alpaca.markets";
pub const ALPACA_PAPER: &str = "https://paper-api.alpaca.markets";
pub const ALPACA_LIVE: &str = "https://api.alpaca.markets";

/// Snapshot page URL for an underlying (free indicative feed).
pub fn alpaca_snapshot_url(underlying: &str, page: Option<&str>) -> (String, Vec<(String, String)>) {
    let mut q = vec![("feed".to_string(), "indicative".to_string()), ("limit".to_string(), "1000".to_string())];
    if let Some(p) = page {
        q.push(("page_token".into(), p.into()));
    }
    (format!("{ALPACA_DATA}/v1beta1/options/snapshots/{underlying}"), q)
}
/// Contract reference page URL (read-only trading API: OI, multiplier, style).
pub fn alpaca_contracts_url(host: &str, underlying: &str, page: Option<&str>) -> (String, Vec<(String, String)>) {
    let mut q = vec![("underlying_symbols".to_string(), underlying.to_string()), ("status".to_string(), "active".to_string()), ("limit".to_string(), "10000".to_string())];
    if let Some(p) = page {
        q.push(("page_token".into(), p.into()));
    }
    (format!("{host}/v2/options/contracts"), q)
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
    .filter(|x: &f64| x.is_finite())
}

/// Adds one snapshot page to `out`. Returns the next page token.
pub fn parse_alpaca_snapshots(body: &Value, out: &mut Vec<Quote>) -> Option<String> {
    if let Some(map) = body["snapshots"].as_object() {
        for (sym, s) in map {
            let Some(c) = parse_occ(sym) else { continue };
            let q = &s["latestQuote"];
            out.push(Quote {
                symbol: c.symbol,
                kind: if c.kind == Kind::Call { "call".into() } else { "put".into() },
                strike: c.strike,
                expiry: c.expiry,
                bid: num(&q["bp"]),
                ask: num(&q["ap"]),
                last: num(&s["latestTrade"]["p"]),
                volume: num(&s["dailyBar"]["v"]),
                quote_time: q["t"].as_str().map(str::to_string),
                multiplier: 100.0,
                style: "american".into(),
                vendor_iv: num(&s["impliedVolatility"]),
                vendor_delta: num(&s["greeks"]["delta"]),
                flags: vec!["indicative".into()],
                ..Default::default()
            });
        }
    }
    body["next_page_token"].as_str().filter(|t| !t.is_empty()).map(str::to_string)
}

/// Merges contract reference fields (OI, multiplier, style) into quotes. Returns the next page token.
pub fn merge_alpaca_contracts(body: &Value, quotes: &mut [Quote]) -> Option<String> {
    let mut by: std::collections::HashMap<String, &Value> = std::collections::HashMap::new();
    for c in body["option_contracts"].as_array().into_iter().flatten() {
        if let Some(s) = c["symbol"].as_str() {
            by.insert(s.to_string(), c);
        }
    }
    for q in quotes.iter_mut() {
        if let Some(c) = by.get(&q.symbol) {
            q.open_interest = num(&c["open_interest"]);
            q.oi_date = c["open_interest_date"].as_str().map(str::to_string);
            if let Some(m) = num(&c["multiplier"]) {
                q.multiplier = m;
            }
            if let Some(st) = c["style"].as_str() {
                q.style = st.to_string();
            }
            let size = num(&c["size"]).unwrap_or(100.0);
            if (q.multiplier - 100.0).abs() > 1e-9 || (size - 100.0).abs() > 1e-9 {
                q.flags.push("adjusted-contract".into());
            }
        }
    }
    body["next_page_token"].as_str().filter(|t| !t.is_empty()).map(str::to_string)
}

// ---- Chain analytics -----------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
pub struct ExpiryInfo {
    pub expiry: String,
    pub days: i64,
    pub t: f64,
    pub forward: Option<f64>,
    pub forward_source: String,
    pub forward_range: Option<f64>,
    pub df: f64,
    pub atm_iv: Option<f64>,
    pub skew: Option<f64>,
    pub contracts: usize,
    pub with_iv: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct Chain {
    pub underlying: String,
    pub spot: f64,
    pub rate: f64,
    pub rate_source: String,
    pub as_of: i64,
    pub expiries: Vec<ExpiryInfo>,
    pub quotes: Vec<Quote>,
    pub summary: Summary,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Summary {
    pub atm30: Option<f64>,
    pub atm60: Option<f64>,
    pub atm90: Option<f64>,
    pub skew30: Option<f64>,
}

/// Year fraction from `now` (Unix s) to 16:00 New York on `expiry`.
pub fn year_fraction(now: i64, expiry: &str) -> Option<f64> {
    let d = parse_date(expiry)?;
    let close = d * 86_400 + 16 * 3600;
    let t = close - ny_offset(close);
    let secs = (t - now) as f64;
    (secs > 0.0).then(|| secs / (365.0 * 86_400.0))
}

/// Linear interpolation of y at x over points sorted by x (no extrapolation).
fn interp(points: &[(f64, f64)], x: f64) -> Option<f64> {
    let i = points.partition_point(|p| p.0 < x);
    if i < points.len() && (points[i].0 - x).abs() < 1e-12 {
        return Some(points[i].1);
    }
    if i == 0 || i >= points.len() {
        return None;
    }
    let (a, b) = (points[i - 1], points[i]);
    Some(a.1 + (b.1 - a.1) * (x - a.0) / (b.0 - a.0))
}

/// ATM and 90/110 skew from (strike, iv) of OTM options at one expiry.
fn smile_stats(smile: &[(f64, f64)], forward: f64) -> (Option<f64>, Option<f64>) {
    let atm = interp(smile, forward);
    let lo = interp(smile, 0.9 * forward);
    let hi = interp(smile, 1.1 * forward);
    (atm, lo.zip(hi).map(|(l, h)| l - h))
}

/// Constant-maturity value by linear interpolation of total variance σ²T.
pub fn constant_maturity(points: &[(f64, f64)], target_t: f64) -> Option<f64> {
    let mut p: Vec<(f64, f64)> = points.iter().filter(|(t, v)| *t > 0.0 && v.is_finite()).map(|(t, v)| (*t, v * v * t)).collect();
    p.sort_by(|a, b| a.0.total_cmp(&b.0));
    if let Some(w) = interp(&p, target_t) {
        return (w > 0.0).then(|| (w / target_t).sqrt());
    }
    // Within a week of the nearest expiry: use it rather than nothing.
    p.iter().find(|(t, _)| (t - target_t).abs() * 365.0 <= 7.0).map(|(t, w)| (w / t).sqrt())
}

/// Implied volatility, Greeks and flags for a chain. IV comes from the
/// out-of-the-money option at each strike (puts below the forward, calls
/// above), inverted with Black's formula on the put–call-parity forward; the
/// in-the-money option at the same strike gets the same IV. That keeps the
/// early-exercise premium of American options, which sits mostly in ITM
/// options, out of the solve.
pub fn analyze(underlying: &str, mut quotes: Vec<Quote>, spot: f64, now: i64, rate: f64, rate_source: &str) -> Chain {
    let mut expiries: Vec<String> = quotes.iter().map(|q| q.expiry.clone()).collect();
    expiries.sort();
    expiries.dedup();
    let mut infos = Vec::new();
    for e in &expiries {
        let Some(t) = year_fraction(now, e) else { continue };
        let df = (-rate * t).exp();
        let idx: Vec<usize> = (0..quotes.len()).filter(|&i| &quotes[i].expiry == e).collect();
        // Parity forward from the strikes nearest spot with two-sided quotes on both sides.
        let mut pairs: Vec<(f64, f64, f64)> = Vec::new();
        let strikes: std::collections::BTreeMap<i64, (Option<f64>, Option<f64>)> = idx.iter().fold(Default::default(), |mut m, &i| {
            let q = &quotes[i];
            let k = (q.strike * 1000.0).round() as i64;
            let ent = m.entry(k).or_insert((None, None));
            if q.kind == "call" { ent.0 = q.mid() } else { ent.1 = q.mid() }
            m
        });
        let mut near: Vec<(f64, f64, f64)> = strikes.iter().filter_map(|(k, (c, p))| Some((*k as f64 / 1000.0, (*c)?, (*p)?))).collect();
        near.sort_by(|a, b| (a.0 - spot).abs().total_cmp(&(b.0 - spot).abs()));
        pairs.extend(near.into_iter().take(5));
        let pf = parity_forward(&pairs, df);
        let (forward, fsource, frange) = match pf {
            Some(p) if p.forward > 0.5 * spot && p.forward < 1.5 * spot => (p.forward, "put–call parity", Some(p.range)),
            _ => (spot / df, "spot carried at the rate (no usable pairs)", None),
        };
        // OTM IV per strike.
        let mut iv_by_strike: std::collections::BTreeMap<i64, f64> = Default::default();
        for &i in &idx {
            let q = &quotes[i];
            let kind = if q.kind == "call" { Kind::Call } else { Kind::Put };
            let otm = (kind == Kind::Call && q.strike >= forward) || (kind == Kind::Put && q.strike < forward);
            if !otm || q.flags.iter().any(|f| f == "adjusted-contract") {
                continue;
            }
            if let Some(m) = q.mid() {
                if let Ok(v) = iv::european(kind, m, forward, q.strike, t, df) {
                    iv_by_strike.insert((q.strike * 1000.0).round() as i64, v);
                }
            }
        }
        let carry = (forward / spot).ln() / t; // r − q implied
        let q_yield = rate - carry;
        let mut with_iv = 0;
        for &i in &idx {
            let q = &mut quotes[i];
            let kind = if q.kind == "call" { Kind::Call } else { Kind::Put };
            let k = (q.strike * 1000.0).round() as i64;
            match (q.bid, q.ask) {
                (Some(b), Some(a)) if b > 0.0 && a >= b => {
                    if (a - b) / (0.5 * (a + b)) > 0.25 {
                        q.flags.push("wide-spread".into());
                    }
                }
                (Some(b), _) if b <= 0.0 => q.flags.push("no-bid".into()),
                _ => q.flags.push("no-quote".into()),
            }
            if let Some(m) = q.mid() {
                let intrinsic = (kind.sign() * (forward - q.strike)).max(0.0) * df;
                if m < intrinsic - 1e-9 {
                    q.flags.push("below-intrinsic".into());
                }
            }
            if let Some(&v) = iv_by_strike.get(&k) {
                let g = black::bsm(kind, spot, q.strike, t, rate, q_yield, v);
                q.iv = Some(v);
                q.delta = Some(g.delta);
                q.gamma = Some(g.gamma);
                q.theta = Some(g.theta);
                q.vega = Some(g.vega);
                q.rho = Some(g.rho);
                with_iv += 1;
            }
        }
        let smile: Vec<(f64, f64)> = iv_by_strike.iter().map(|(k, v)| (*k as f64 / 1000.0, *v)).collect();
        let (atm, skew) = smile_stats(&smile, forward);
        let days = parse_date(e).unwrap_or(0) - ny_clock(now).0;
        infos.push(ExpiryInfo { expiry: e.clone(), days, t, forward: Some(forward), forward_source: fsource.into(), forward_range: frange, df, atm_iv: atm, skew, contracts: idx.len(), with_iv });
    }
    let term: Vec<(f64, f64)> = infos.iter().filter_map(|x| Some((x.t, x.atm_iv?))).collect();
    let skews: Vec<(f64, f64)> = infos.iter().filter_map(|x| Some((x.t, x.skew?))).collect();
    let summary = Summary {
        atm30: constant_maturity(&term, 30.0 / 365.0),
        atm60: constant_maturity(&term, 60.0 / 365.0),
        atm90: constant_maturity(&term, 90.0 / 365.0),
        skew30: skews.iter().min_by(|a, b| (a.0 - 30.0 / 365.0).abs().total_cmp(&(b.0 - 30.0 / 365.0).abs())).filter(|(t, _)| (t * 365.0 - 30.0).abs() <= 20.0).map(|x| x.1),
    };
    Chain { underlying: underlying.into(), spot, rate, rate_source: rate_source.into(), as_of: now, expiries: infos, quotes, summary }
}

// ---- Store -------------------------------------------------------------------------

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, underlying TEXT NOT NULL, source TEXT NOT NULL,
  taken_at INTEGER NOT NULL, spot REAL, rate REAL, by TEXT, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS snapshots_u ON snapshots(underlying, taken_at);
CREATE TABLE IF NOT EXISTS daily_summary(underlying TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL,
  atm30 REAL, atm60 REAL, atm90 REAL, skew30 REAL, spot REAL, detail TEXT,
  PRIMARY KEY(underlying, date, source)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS prints(contract TEXT NOT NULL, date TEXT NOT NULL, minute INTEGER NOT NULL, price REAL NOT NULL,
  volume REAL, trades REAL, spot REAL, source TEXT NOT NULL, PRIMARY KEY(contract, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS contracts(symbol TEXT PRIMARY KEY, underlying TEXT NOT NULL, kind TEXT NOT NULL, strike REAL NOT NULL,
  expiry TEXT NOT NULL, style TEXT, multiplier REAL, source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS contracts_u ON contracts(underlying, expiry);
CREATE TABLE IF NOT EXISTS corp_actions(underlying TEXT NOT NULL, kind TEXT NOT NULL, date TEXT NOT NULL, amount REAL,
  ratio REAL, source TEXT NOT NULL, PRIMARY KEY(underlying, kind, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS spot_minutes(underlying TEXT NOT NULL, minute INTEGER NOT NULL, price REAL NOT NULL,
  source TEXT NOT NULL, PRIMARY KEY(underlying, minute)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS daily_bars(underlying TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY(underlying, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS backfill_queue(id TEXT PRIMARY KEY, underlying TEXT NOT NULL, tier INTEGER NOT NULL,
  kind TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT, updated INTEGER NOT NULL, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS backfill_next ON backfill_queue(status, tier, seq);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_runs(started INTEGER PRIMARY KEY, finished INTEGER, by TEXT, result TEXT);
";

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
    db.busy_timeout(std::time::Duration::from_secs(60))?;
    db.execute_batch(SCHEMA)?;
    Ok(db)
}

pub fn meta_get(db: &Connection, key: &str) -> Option<String> {
    db.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0)).ok()
}
pub fn meta_set(db: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    db.execute("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value]).map(|_| ())
}

/// Stores a captured chain (write-once per id) and its daily summary row.
pub fn save_chain(db: &Connection, chain: &Chain, source: &str, by: &str) -> Result<String, String> {
    let date = date_string(ny_clock(chain.as_of).0);
    let id = format!("{}:{}:{}:{}", source, chain.underlying, date, chain.as_of);
    let body = serde_json::to_string(chain).map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR IGNORE INTO snapshots(id,underlying,source,taken_at,spot,rate,by,body) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![id, chain.underlying, source, chain.as_of, chain.spot, chain.rate, by, body],
    )
    .map_err(|e| e.to_string())?;
    let detail = json!({ "term": chain.expiries.iter().map(|x| json!({"expiry": x.expiry, "days": x.days, "atm": x.atm_iv, "skew": x.skew, "forward": x.forward})).collect::<Vec<_>>(), "contracts": chain.quotes.len() });
    upsert_summary(db, &chain.underlying, &date, source, &chain.summary, chain.spot, &detail)?;
    Ok(id)
}

pub fn upsert_summary(db: &Connection, underlying: &str, date: &str, source: &str, s: &Summary, spot: f64, detail: &Value) -> Result<(), String> {
    db.execute(
        "INSERT INTO daily_summary(underlying,date,source,atm30,atm60,atm90,skew30,spot,detail) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(underlying,date,source) DO UPDATE SET atm30=excluded.atm30,atm60=excluded.atm60,atm90=excluded.atm90,skew30=excluded.skew30,spot=excluded.spot,detail=excluded.detail",
        params![underlying, date, source, s.atm30, s.atm60, s.atm90, s.skew30, spot, detail.to_string()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Daily summary history for a symbol, oldest first: [{date, source, atm30, …}].
pub fn history(db: &Connection, underlying: &str) -> Result<Value, String> {
    let mut st = db
        .prepare("SELECT date,source,atm30,atm60,atm90,skew30,spot,detail FROM daily_summary WHERE underlying=?1 ORDER BY date, source")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([underlying], |r| {
            Ok(json!({
                "date": r.get::<_, String>(0)?, "source": r.get::<_, String>(1)?,
                "atm30": r.get::<_, Option<f64>>(2)?, "atm60": r.get::<_, Option<f64>>(3)?, "atm90": r.get::<_, Option<f64>>(4)?,
                "skew30": r.get::<_, Option<f64>>(5)?, "spot": r.get::<_, Option<f64>>(6)?,
                "detail": serde_json::from_str::<Value>(&r.get::<_, Option<String>>(7)?.unwrap_or_default()).unwrap_or(Value::Null),
            }))
        })
        .map_err(|e| e.to_string())?;
    Ok(Value::Array(rows.filter_map(Result::ok).collect()))
}

/// Deletes everything that came from one provider, including values derived from it.
pub fn purge(db: &Connection, source: &str) -> Result<usize, String> {
    let mut n = 0;
    for table in ["snapshots", "daily_summary", "prints", "contracts", "corp_actions", "spot_minutes", "daily_bars"] {
        n += db.execute(&format!("DELETE FROM {table} WHERE source=?1"), [source]).map_err(|e| e.to_string())?;
    }
    if source == "massive" {
        n += db.execute("DELETE FROM backfill_queue", []).map_err(|e| e.to_string())?;
        db.execute("DELETE FROM meta WHERE key LIKE 'massive:%'", []).map_err(|e| e.to_string())?;
    }
    db.execute_batch("VACUUM").ok();
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_writes_occ_symbols() {
        let c = parse_occ("O:AAPL261218C00250000").unwrap();
        assert_eq!((c.root.as_str(), c.kind, c.strike, c.expiry.as_str()), ("AAPL", Kind::Call, 250.0, "2026-12-18"));
        let p = parse_occ("SPY   270115P00512500").unwrap();
        assert_eq!((p.root.as_str(), p.strike), ("SPY", 512.5));
        assert_eq!(occ_symbol("SPY", "2027-01-15", Kind::Put, 512.5), "SPY270115P00512500");
        assert!(parse_occ("AAPL261218X00250000").is_none());
        assert!(parse_occ("AAPL").is_none());
        assert!(parse_occ("AAPL261340C00250000").is_none());
    }

    #[test]
    fn new_york_time_and_trading_days() {
        // 2026-07-01 20:00 UTC = 16:00 EDT; 2026-12-01 21:00 UTC = 16:00 EST.
        let jul = days_from_civil(2026, 7, 1) * 86_400 + 20 * 3600;
        assert_eq!(ny_clock(jul).1, 16 * 3600);
        let dec = days_from_civil(2026, 12, 1) * 86_400 + 21 * 3600;
        assert_eq!(ny_clock(dec).1, 16 * 3600);
        assert!(!trading_day(days_from_civil(2026, 11, 26)), "Thanksgiving");
        assert!(!trading_day(days_from_civil(2026, 4, 3)), "Good Friday 2026");
        assert!(!trading_day(days_from_civil(2026, 7, 3)), "Independence Day observed");
        assert!(!trading_day(days_from_civil(2026, 11, 21)), "Saturday");
        assert!(trading_day(days_from_civil(2026, 11, 17)));
        assert_eq!(date_string(days_from_civil(2026, 11, 17)), "2026-11-17");
    }

    fn quote(sym: &str, bid: f64, ask: f64) -> Quote {
        let c = parse_occ(sym).unwrap();
        Quote { symbol: c.symbol, kind: if c.kind == Kind::Call { "call".into() } else { "put".into() }, strike: c.strike, expiry: c.expiry, bid: Some(bid), ask: Some(ask), multiplier: 100.0, ..Default::default() }
    }

    #[test]
    fn analyzes_a_chain_priced_by_black_scholes() {
        // Chain priced at 25% vol with a 1% yield; the analysis must recover both.
        let now = days_from_civil(2026, 11, 17) * 86_400 + 21 * 3600; // 16:00 New York
        let (s, r, q, v) = (100.0, 0.04, 0.01, 0.25);
        let mut quotes = vec![];
        for exp in ["2026-12-18", "2027-01-15", "2027-03-19"] {
            let t = year_fraction(now, exp).unwrap();
            for k in (70..=130).step_by(5) {
                for kind in [Kind::Call, Kind::Put] {
                    let p = black::bsm(kind, s, k as f64, t, r, q, v).price;
                    let sym = occ_symbol("XYZ", exp, kind, k as f64);
                    quotes.push(quote(&sym, (p - 0.01).max(0.0), p + 0.01));
                }
            }
        }
        let chain = analyze("XYZ", quotes, s, now, r, "test");
        assert_eq!(chain.expiries.len(), 3);
        for e in &chain.expiries {
            assert!((e.forward.unwrap() - s * ((r - q) * e.t).exp()).abs() < 0.02, "forward {e:?}");
            assert!((e.atm_iv.unwrap() - v).abs() < 0.003, "atm {e:?}");
            assert!(e.skew.unwrap().abs() < 0.01, "flat smile");
        }
        assert!((chain.summary.atm30.unwrap() - v).abs() < 0.003);
        assert!(chain.quotes.iter().filter(|q| q.iv.is_some()).count() > 60);
        let atm_call = chain.quotes.iter().find(|q| q.kind == "call" && q.strike == 100.0 && q.expiry == "2027-01-15").unwrap();
        assert!((atm_call.delta.unwrap() - 0.55).abs() < 0.05);
    }

    #[test]
    fn constant_maturity_interpolates_total_variance() {
        let pts = [(20.0 / 365.0, 0.30), (50.0 / 365.0, 0.20)];
        let v = constant_maturity(&pts, 30.0 / 365.0).unwrap();
        let w: f64 = (0.09 * 20.0 + (0.04 * 50.0 - 0.09 * 20.0) * (10.0 / 30.0)) / 30.0;
        assert!((v - w.sqrt()).abs() < 1e-12);
        assert!(constant_maturity(&pts, 200.0 / 365.0).is_none());
    }

    #[test]
    fn alpaca_payloads() {
        let snap = serde_json::json!({"snapshots": {"AAPL261218C00250000": {"latestQuote": {"bp": 7.0, "ap": 7.2, "t": "2026-11-17T20:59:00Z"}, "latestTrade": {"p": 7.1}, "impliedVolatility": 0.27, "greeks": {"delta": 0.5}}, "bad": {}}, "next_page_token": "abc"});
        let mut qs = vec![];
        assert_eq!(parse_alpaca_snapshots(&snap, &mut qs).as_deref(), Some("abc"));
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].mid(), Some(7.1));
        let contracts = serde_json::json!({"option_contracts": [{"symbol": "AAPL261218C00250000", "open_interest": "1200", "open_interest_date": "2026-11-16", "multiplier": "100", "size": "100", "style": "american"}], "next_page_token": null});
        assert!(merge_alpaca_contracts(&contracts, &mut qs).is_none());
        assert_eq!(qs[0].open_interest, Some(1200.0));
        assert!(!qs[0].flags.contains(&"adjusted-contract".to_string()));
    }

    #[test]
    fn store_round_trip_and_purge() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA).unwrap();
        let s = Summary { atm30: Some(0.2), ..Default::default() };
        upsert_summary(&db, "AAPL", "2026-11-17", "alpaca", &s, 250.0, &json!({})).unwrap();
        upsert_summary(&db, "AAPL", "2025-11-17", "massive", &s, 200.0, &json!({})).unwrap();
        assert_eq!(history(&db, "AAPL").unwrap().as_array().unwrap().len(), 2);
        purge(&db, "massive").unwrap();
        let h = history(&db, "AAPL").unwrap();
        assert_eq!(h.as_array().unwrap().len(), 1);
        assert_eq!(h[0]["source"], "alpaca");
    }
}
