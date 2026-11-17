//! History backfill from Massive's free tier (Options Basic + Stocks Basic:
//! end-of-day, 2 years, 5 calls a minute, individual use). Pure parts:
//! request URLs, response parsing, which contracts to fetch, the closing
//! window, and turning trade prints into implied volatility history.
//!
//! Requests go only to https://api.massive.com with the key in an
//! Authorization header, one at a time, spaced by the shared request log.
use crate::options::{self, constant_maturity, date_string, days_from_civil, ny_clock, parse_date, parse_occ, trading_day, Summary};
use options_math::black::Kind;
use options_math::iv;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub const HOST: &str = "https://api.massive.com";
/// History the free tier serves, with a few days of margin.
pub const WINDOW_DAYS: i64 = 725;
/// Closing window: prints from 15:30 to 16:00 New York.
pub const CLOSE_FROM: i64 = 15 * 3600 + 30 * 60;
pub const CLOSE_TO: i64 = 16 * 3600;

/// Only Massive's API host may be called (next_url values are checked too).
pub fn allowed(url: &str) -> bool {
    url.starts_with("https://api.massive.com/") && !url.contains("@") && !url.contains("apiKey=")
}

/// Monthly expiries (third Friday, or Thursday when Friday is a holiday) in [from, to].
pub fn monthly_expiries(from: i64, to: i64) -> Vec<String> {
    let mut out = vec![];
    let (mut y, mut m, _, _) = crate::providers::civil_date(from * 86_400);
    loop {
        let first = days_from_civil(y, m, 1);
        let fri = first + (5 - (first + 4).rem_euclid(7)).rem_euclid(7) + 14;
        let d = if trading_day(fri) { fri } else { fri - 1 };
        if d > to {
            break;
        }
        if d >= from {
            out.push(date_string(d));
        }
        m += 1;
        if m > 12 {
            m = 1;
            y += 1;
        }
    }
    out
}

/// Queue item: (id, tier, kind, url).
pub type Item = (String, i64, String, String);

/// Tier 0 for one underlying: adjusted daily bars, splits, dividends, the
/// stock's minute bars (in ~45-day pieces) and the monthly contract lists.
pub fn plan_reference(underlying: &str, today: i64) -> Vec<Item> {
    let u = underlying;
    let from = today - WINDOW_DAYS;
    let mut v = vec![
        (format!("bars:{u}"), 0, "bars".into(), format!("{HOST}/v2/aggs/ticker/{u}/range/1/day/{}/{}?adjusted=true&sort=asc&limit=50000", date_string(from), date_string(today))),
        (format!("splits:{u}"), 0, "splits".into(), format!("{HOST}/stocks/v1/splits?ticker={u}&limit=1000")),
        (format!("divs:{u}"), 0, "dividends".into(), format!("{HOST}/stocks/v1/dividends?ticker={u}&limit=1000")),
    ];
    let mut d = from;
    while d <= today {
        let end = (d + 44).min(today);
        v.push((format!("spot:{u}:{}", date_string(d)), 0, "spot".into(), format!("{HOST}/v2/aggs/ticker/{u}/range/1/minute/{}/{}?adjusted=true&sort=asc&limit=50000", date_string(d), date_string(end))));
        d = end + 1;
    }
    for e in monthly_expiries(from + 20, today + 120) {
        let expired = parse_date(&e).unwrap_or(0) < today;
        v.push((format!("list:{u}:{e}"), 0, "list".into(), format!("{HOST}/v3/reference/options/contracts?underlying_ticker={u}&expiration_date={e}&expired={expired}&limit=1000")));
    }
    v
}

/// Minute bars of one option contract over the part of its life inside the window.
pub fn contract_item(symbol: &str, expiry: &str, tier: i64, today: i64) -> Option<Item> {
    let exp = parse_date(expiry)?;
    let from = (exp - 120).max(today - WINDOW_DAYS);
    let to = exp.min(today);
    (from < to).then(|| (format!("aggs:{symbol}"), tier, "aggs".to_string(), format!("{HOST}/v2/aggs/ticker/O:{symbol}/range/1/minute/{}/{}?adjusted=true&sort=asc&limit=50000", date_string(from), date_string(to))))
}

/// Which contracts of one monthly expiry to fetch. Tier 1: the ~6 strikes
/// nearest the stock's median price 20–100 days before expiry, calls and
/// puts (both, for the parity check and so every strike has its OTM side).
/// Tier 2: puts near 85–90% and calls near 110–115% of that price (skew).
pub fn choose_contracts(symbols: &[String], closes: &[(i64, f64)], expiry: &str) -> (Vec<String>, Vec<String>) {
    let Some(exp) = parse_date(expiry) else { return (vec![], vec![]) };
    let mut window: Vec<f64> = closes.iter().filter(|(d, _)| *d >= exp - 100 && *d <= exp - 20).map(|x| x.1).collect();
    if window.is_empty() {
        window = closes.iter().filter(|(d, _)| *d <= exp && *d >= exp - 120).map(|x| x.1).collect();
    }
    if window.is_empty() {
        return (vec![], vec![]);
    }
    window.sort_by(|a, b| a.total_cmp(b));
    let median = window[window.len() / 2];
    let parsed: Vec<_> = symbols.iter().filter_map(|s| parse_occ(s)).filter(|c| c.expiry == expiry).collect();
    let mut strikes: Vec<f64> = parsed.iter().map(|c| c.strike).collect();
    strikes.sort_by(|a, b| a.total_cmp(b));
    strikes.dedup();
    let mut near = strikes.clone();
    near.sort_by(|a, b| (a - median).abs().total_cmp(&(b - median).abs()));
    near.truncate(6);
    let pick = |k: f64, kind: Kind| parsed.iter().find(|c| c.strike == k && c.kind == kind).map(|c| c.symbol.clone());
    let mut t1 = vec![];
    for &k in &near {
        t1.extend(pick(k, Kind::Call));
        t1.extend(pick(k, Kind::Put));
    }
    let nearest = |target: f64| strikes.iter().copied().min_by(|a, b| (a - target).abs().total_cmp(&(b - target).abs()));
    let mut t2 = vec![];
    for (f, kind) in [(0.85, Kind::Put), (0.9, Kind::Put), (1.1, Kind::Call), (1.15, Kind::Call)] {
        if let Some(k) = nearest(median * f) {
            if let Some(s) = pick(k, kind) {
                if !t1.contains(&s) && !t2.contains(&s) {
                    t2.push(s);
                }
            }
        }
    }
    (t1, t2)
}

fn f(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

/// Minute bars → the last bar in the closing window of each New York day:
/// (day, minute start Unix s, close, volume, trades).
pub fn closing_prints(body: &Value) -> Vec<(i64, i64, f64, f64, f64)> {
    let mut best: std::collections::BTreeMap<i64, (i64, f64, f64, f64)> = Default::default();
    for b in body["results"].as_array().into_iter().flatten() {
        let (Some(t), Some(c)) = (b["t"].as_i64(), f(&b["c"])) else { continue };
        let ts = t / 1000;
        let (day, clock) = ny_clock(ts);
        if !(CLOSE_FROM..CLOSE_TO).contains(&clock) || c <= 0.0 {
            continue;
        }
        let e = best.entry(day).or_insert((ts, c, 0.0, 0.0));
        if ts >= e.0 {
            *e = (ts, c, f(&b["v"]).unwrap_or(0.0), f(&b["n"]).unwrap_or(0.0));
        }
    }
    best.into_iter().map(|(d, (ts, c, v, n))| (d, ts, c, v, n)).collect()
}

/// Stock minute bars → (minute Unix s, close) inside the closing window.
pub fn closing_minutes(body: &Value) -> Vec<(i64, f64)> {
    body["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| {
            let ts = b["t"].as_i64()? / 1000;
            let c = f(&b["c"])?;
            let (_, clock) = ny_clock(ts);
            ((CLOSE_FROM..CLOSE_TO).contains(&clock) && c > 0.0).then_some((ts, c))
        })
        .collect()
}

/// Applies a successful response to the store. Returns follow-up items.
pub fn apply(db: &Connection, underlying: &str, kind: &str, body: &Value, today: i64) -> Result<Vec<Item>, String> {
    let mut follow = vec![];
    let e = |e: rusqlite::Error| e.to_string();
    match kind {
        "bars" => {
            for b in body["results"].as_array().into_iter().flatten() {
                let (Some(t), Some(c)) = (b["t"].as_i64(), f(&b["c"])) else { continue };
                // Daily bars are stamped at New York midnight.
                let day = ny_clock(t / 1000 + 6 * 3600).0;
                db.execute("INSERT OR REPLACE INTO daily_bars(underlying,date,close,source) VALUES(?1,?2,?3,'massive')", params![underlying, date_string(day), c]).map_err(e)?;
            }
        }
        "splits" => {
            for s in body["results"].as_array().into_iter().flatten() {
                let (Some(d), Some(from), Some(to)) = (s["execution_date"].as_str(), f(&s["split_from"]), f(&s["split_to"])) else { continue };
                db.execute("INSERT OR REPLACE INTO corp_actions(underlying,kind,date,amount,ratio,source) VALUES(?1,'split',?2,NULL,?3,'massive')", params![underlying, d, to / from]).map_err(e)?;
            }
        }
        "dividends" => {
            for s in body["results"].as_array().into_iter().flatten() {
                let (Some(d), Some(a)) = (s["ex_dividend_date"].as_str(), f(&s["cash_amount"])) else { continue };
                db.execute("INSERT OR REPLACE INTO corp_actions(underlying,kind,date,amount,ratio,source) VALUES(?1,'dividend',?2,?3,NULL,'massive')", params![underlying, d, a]).map_err(e)?;
            }
        }
        "spot" => {
            for (ts, c) in closing_minutes(body) {
                db.execute("INSERT OR REPLACE INTO spot_minutes(underlying,minute,price,source) VALUES(?1,?2,?3,'massive')", params![underlying, ts, c]).map_err(e)?;
            }
        }
        "list" => {
            let mut symbols = vec![];
            let mut expiry = String::new();
            for c in body["results"].as_array().into_iter().flatten() {
                let Some(t) = c["ticker"].as_str() else { continue };
                let Some(p) = parse_occ(t) else { continue };
                let style = c["exercise_style"].as_str().unwrap_or("american");
                let mult = f(&c["shares_per_contract"]).unwrap_or(100.0);
                let adjusted = c["additional_underlyings"].as_array().map(|a| !a.is_empty()).unwrap_or(false) || (mult - 100.0).abs() > 1e-9;
                if adjusted {
                    continue;
                }
                db.execute(
                    "INSERT OR REPLACE INTO contracts(symbol,underlying,kind,strike,expiry,style,multiplier,source) VALUES(?1,?2,?3,?4,?5,?6,?7,'massive')",
                    params![p.symbol, underlying, if p.kind == Kind::Call { "call" } else { "put" }, p.strike, p.expiry, style, mult],
                )
                .map_err(e)?;
                expiry = p.expiry.clone();
                symbols.push(p.symbol);
            }
            if let Some(next) = body["next_url"].as_str().filter(|u| allowed(u)) {
                follow.push((format!("list:{underlying}:{expiry}:{}", symbols.len()), 0, "list".into(), next.to_string()));
            }
            if !expiry.is_empty() {
                let closes = closes(db, underlying)?;
                let all: Vec<String> = {
                    let mut st = db.prepare("SELECT symbol FROM contracts WHERE underlying=?1 AND expiry=?2").map_err(e)?;
                    let rows = st.query_map(params![underlying, expiry], |r| r.get::<_, String>(0)).map_err(e)?;
                    rows.filter_map(Result::ok).collect()
                };
                let (t1, t2) = choose_contracts(&all, &closes, &expiry);
                for s in t1 {
                    follow.extend(contract_item(&s, &expiry, 1, today));
                }
                for s in t2 {
                    follow.extend(contract_item(&s, &expiry, 2, today));
                }
            }
        }
        "aggs" => {
            let sym = body["ticker"].as_str().unwrap_or("").trim_start_matches("O:").to_string();
            for (day, ts, c, v, n) in closing_prints(body) {
                db.execute(
                    "INSERT OR REPLACE INTO prints(contract,date,minute,price,volume,trades,spot,source) VALUES(?1,?2,?3,?4,?5,?6,NULL,'massive')",
                    params![sym, date_string(day), ts, c, v, n],
                )
                .map_err(e)?;
            }
        }
        _ => return Err(format!("Unknown backfill step {kind}")),
    }
    Ok(follow)
}

fn closes(db: &Connection, underlying: &str) -> Result<Vec<(i64, f64)>, String> {
    let mut st = db.prepare("SELECT date, close FROM daily_bars WHERE underlying=?1 ORDER BY date").map_err(|e| e.to_string())?;
    let rows = st.query_map([underlying], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).filter_map(|(d, c)| Some((parse_date(&d)?, c))).collect())
}

/// Risk-free rate by date (continuous), from FRED 3-month bill quotes when present.
pub struct Rates {
    pub by_day: Vec<(i64, f64)>,
    pub fallback: f64,
}
impl Rates {
    pub fn at(&self, day: i64) -> f64 {
        let i = self.by_day.partition_point(|(d, _)| *d <= day);
        if i == 0 { self.by_day.first().map(|x| x.1).unwrap_or(self.fallback) } else { self.by_day[i - 1].1 }
    }
}

/// Implied-volatility history from the stored closing prints of one
/// underlying: per day, ATM IV at 30/60/90 days (variance-interpolated
/// across monthly expiries) and 90–110% skew, written as daily_summary rows
/// with source "massive". Returns the number of days written.
pub fn compute(db: &Connection, underlying: &str, rates: &Rates) -> Result<usize, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let divs: Vec<(i64, f64)> = {
        let mut st = db.prepare("SELECT date, amount FROM corp_actions WHERE underlying=?1 AND kind='dividend' AND amount>0").map_err(e)?;
        let rows = st.query_map([underlying], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))).map_err(e)?;
        rows.filter_map(Result::ok).filter_map(|(d, a)| Some((parse_date(&d)?, a))).collect()
    };
    let day_close: std::collections::HashMap<i64, f64> = closes(db, underlying)?.into_iter().collect();
    let spot: Vec<(i64, f64)> = {
        let mut st = db.prepare("SELECT minute, price FROM spot_minutes WHERE underlying=?1 ORDER BY minute").map_err(e)?;
        let rows = st.query_map([underlying], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?))).map_err(e)?;
        rows.filter_map(Result::ok).collect()
    };
    // Spot in the same minute, or the latest within the previous 5 minutes.
    let spot_at = |ts: i64| -> Option<f64> {
        let i = spot.partition_point(|(m, _)| *m <= ts);
        (i > 0 && ts - spot[i - 1].0 <= 300).then(|| spot[i - 1].1)
    };
    let mut st = db
        .prepare("SELECT p.date, p.minute, p.price, c.kind, c.strike, c.expiry FROM prints p JOIN contracts c ON c.symbol=p.contract WHERE c.underlying=?1 AND p.source='massive' ORDER BY p.date")
        .map_err(e)?;
    let rows: Vec<(String, i64, f64, String, f64, String)> = st
        .query_map([underlying], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .map_err(e)?
        .filter_map(Result::ok)
        .collect();
    // date → expiry → [(strike, iv)] for OTM prints.
    let mut grid: std::collections::BTreeMap<String, std::collections::BTreeMap<String, (f64, f64, Vec<(f64, f64)>)>> = Default::default();
    for (date, ts, price, kind, strike, expiry) in rows {
        let Some(s) = spot_at(ts) else { continue };
        let Some(t) = options::year_fraction(ts, &expiry) else { continue };
        if t < 3.0 / 365.0 {
            continue; // final days: prices are mostly intrinsic and noisy
        }
        let day = ny_clock(ts).0;
        let r = rates.at(day);
        let exp_day = parse_date(&expiry).unwrap_or(day);
        let pv_div: f64 = divs.iter().filter(|(d, _)| *d > day && *d <= exp_day).map(|(d, a)| a * (-r * (*d - day) as f64 / 365.0).exp()).sum();
        let df = (-r * t).exp();
        let forward = (s - pv_div) / df;
        let k = if kind == "call" { Kind::Call } else { Kind::Put };
        let otm = (k == Kind::Call && strike >= forward) || (k == Kind::Put && strike < forward);
        if !otm {
            continue;
        }
        if let Ok(v) = iv::european(k, price, forward, strike, t, df) {
            let ent = grid.entry(date).or_default().entry(expiry).or_insert((forward, t, vec![]));
            ent.2.push((strike, v));
        }
    }
    let mut written = 0;
    for (date, exps) in grid {
        let mut term = vec![];
        let mut skews = vec![];
        let mut detail = vec![];
        for (expiry, (forward, t, mut smile)) in exps {
            smile.sort_by(|a, b| a.0.total_cmp(&b.0));
            smile.dedup_by(|a, b| a.0 == b.0);
            let below = smile.iter().rev().find(|(k, _)| *k <= forward);
            let above = smile.iter().find(|(k, _)| *k >= forward);
            let atm = match (below, above) {
                (Some(a), Some(b)) if b.0 > a.0 => Some(a.1 + (b.1 - a.1) * (forward - a.0) / (b.0 - a.0)),
                (Some(a), Some(_)) => Some(a.1),
                (Some(a), None) | (None, Some(a)) if (a.0 / forward - 1.0).abs() <= 0.02 => Some(a.1),
                _ => None,
            };
            let near = |target: f64| smile.iter().filter(|(k, _)| (k / target - 1.0).abs() <= 0.04).min_by(|a, b| (a.0 - target).abs().total_cmp(&(b.0 - target).abs())).map(|x| x.1);
            let skew = near(0.9 * forward).zip(near(1.1 * forward)).map(|(l, h)| l - h);
            if let Some(a) = atm {
                term.push((t, a));
            }
            if let Some(s) = skew {
                skews.push((t, s));
            }
            detail.push(json!({ "expiry": expiry, "days": (t * 365.0).round(), "atm": atm, "skew": skew, "forward": forward, "points": smile.len() }));
        }
        if term.is_empty() {
            continue;
        }
        let summary = Summary {
            atm30: constant_maturity(&term, 30.0 / 365.0),
            atm60: constant_maturity(&term, 60.0 / 365.0),
            atm90: constant_maturity(&term, 90.0 / 365.0),
            skew30: skews.iter().min_by(|a, b| (a.0 - 30.0 / 365.0).abs().total_cmp(&(b.0 - 30.0 / 365.0).abs())).filter(|(t, _)| (t * 365.0 - 30.0).abs() <= 25.0).map(|x| x.1),
        };
        if summary.atm30.is_none() && summary.atm60.is_none() {
            continue;
        }
        let spot_close = parse_date(&date).and_then(|d| day_close.get(&d).copied()).unwrap_or(f64::NAN);
        options::upsert_summary(db, underlying, &date, "massive", &summary, spot_close, &json!({ "term": detail, "method": "trade prints 15:30–16:00 ET, same-minute spot, OTM only" }))?;
        written += 1;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn third_fridays_and_holidays() {
        let e = monthly_expiries(days_from_civil(2026, 1, 1), days_from_civil(2026, 6, 30));
        assert_eq!(e, vec!["2026-01-16", "2026-02-20", "2026-03-20", "2026-04-17", "2026-05-15", "2026-06-18"]);
        // June 19 2026 (Juneteenth) is a Friday holiday: expiry moves to Thursday.
    }

    #[test]
    fn only_massives_host_is_allowed() {
        assert!(allowed("https://api.massive.com/v3/reference/options/contracts?cursor=abc"));
        assert!(!allowed("https://evil.example/v3"));
        assert!(!allowed("http://api.massive.com/v3"));
        assert!(!allowed("https://api.massive.com/v3?apiKey=x"));
        let plan = plan_reference("AAPL", days_from_civil(2026, 11, 17));
        assert!(plan.iter().all(|(_, _, _, u)| allowed(u)));
        assert!(plan.iter().filter(|x| x.2 == "list").count() >= 24);
        assert!(plan.iter().filter(|x| x.2 == "spot").count() >= 15);
    }

    #[test]
    fn picks_near_money_and_skew_contracts() {
        let exp = "2026-06-18";
        let mut syms = vec![];
        for k in (150..=250).step_by(5) {
            syms.push(options::occ_symbol("AAPL", exp, Kind::Call, k as f64));
            syms.push(options::occ_symbol("AAPL", exp, Kind::Put, k as f64));
        }
        let ed = parse_date(exp).unwrap();
        let closes: Vec<(i64, f64)> = (0..150).map(|i| (ed - 150 + i, 200.0)).collect();
        let (t1, t2) = choose_contracts(&syms, &closes, exp);
        assert_eq!(t1.len(), 12);
        assert!(t1.contains(&options::occ_symbol("AAPL", exp, Kind::Call, 200.0)));
        assert!(t2.contains(&options::occ_symbol("AAPL", exp, Kind::Put, 180.0)));
        assert!(t2.contains(&options::occ_symbol("AAPL", exp, Kind::Call, 220.0)));
    }

    #[test]
    fn keeps_the_last_print_of_the_closing_window() {
        // 2026-11-17 is EST (UTC−5): 15:45 ET = 20:45 UTC.
        let base = days_from_civil(2026, 11, 17) * 86_400;
        let ms = |h: i64, m: i64| (base + h * 3600 + m * 60) * 1000;
        let body = json!({"results": [
            {"t": ms(20, 10), "c": 1.0, "v": 5, "n": 2},
            {"t": ms(20, 45), "c": 2.0, "v": 7, "n": 3},
            {"t": ms(20, 50), "c": 2.5, "v": 1, "n": 1},
            {"t": ms(21, 5), "c": 9.0, "v": 1, "n": 1}
        ]});
        let p = closing_prints(&body);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].2, 2.5);
        assert_eq!(closing_minutes(&body).len(), 2);
    }

    /// End to end on synthetic data: contracts priced at a known vol produce that vol.
    #[test]
    fn computes_iv_history_from_prints() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(options::SCHEMA).unwrap();
        let (s, v, r) = (100.0, 0.3, 0.04);
        let rates = Rates { by_day: vec![], fallback: r };
        let day = days_from_civil(2026, 3, 2);
        let ts = day * 86_400 + 20 * 3600 + 55 * 60; // 15:55 EST
        db.execute("INSERT INTO spot_minutes VALUES('XYZ',?1,?2,'massive')", params![ts, s]).unwrap();
        db.execute("INSERT INTO daily_bars VALUES('XYZ','2026-03-02',100.0,'massive')", []).unwrap();
        for exp in ["2026-03-20", "2026-04-17", "2026-05-15"] {
            let t = options::year_fraction(ts, exp).unwrap();
            for k in [90.0, 95.0, 100.0, 105.0, 110.0] {
                for kind in [Kind::Call, Kind::Put] {
                    let sym = options::occ_symbol("XYZ", exp, kind, k);
                    let price = options_math::black::bsm(kind, s, k, t, r, 0.0, v).price;
                    db.execute("INSERT INTO contracts VALUES(?1,'XYZ',?2,?3,?4,'american',100,'massive')", params![sym, if kind == Kind::Call { "call" } else { "put" }, k, exp]).unwrap();
                    db.execute("INSERT INTO prints VALUES(?1,'2026-03-02',?2,?3,1,1,NULL,'massive')", params![sym, ts, price]).unwrap();
                }
            }
        }
        assert_eq!(compute(&db, "XYZ", &rates).unwrap(), 1);
        let h = options::history(&db, "XYZ").unwrap();
        let atm30 = h[0]["atm30"].as_f64().unwrap();
        assert!((atm30 - v).abs() < 1e-6, "{atm30}");
        assert!(h[0]["skew30"].as_f64().unwrap().abs() < 1e-6);
    }
}
