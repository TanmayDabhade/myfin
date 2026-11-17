//! Network side of option data, shared by the desktop app and the headless
//! background agent (`aperture --agent`): pacing through the shared request
//! log, Alpaca chain capture, the Massive backfill queue, and one agent run.
//!
//! Rules (docs/research/DERIVATIVES_FEASIBILITY.md §10): documented APIs and
//! the user's own keys only; Alpaca is read-only (market data, contract
//! reference); Massive gets one request at a time, at least 13 s apart, from
//! one key; every stored row carries its source so it can be deleted.
use crate::massive;
use crate::options::{self, date_string, ny_clock, trading_day, Chain, Quote};
use crate::providers::{self, Credentials};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[derive(Clone)]
pub struct Ctx {
    pub http: reqwest::Client,
    pub data_dir: PathBuf,
    pub keys: Credentials,
    /// "app" or "agent", recorded with every capture.
    pub by: String,
}

impl Ctx {
    pub fn main_db(&self) -> PathBuf {
        self.data_dir.join(crate::legacy::DB)
    }
    pub fn options_db(&self) -> PathBuf {
        self.data_dir.join("options.sqlite")
    }
    pub fn open_options(&self) -> Result<Connection, String> {
        options::open(&self.options_db()).map_err(|e| e.to_string())
    }
    fn open_main(&self) -> Result<Connection, String> {
        let db = Connection::open(self.main_db()).map_err(|e| e.to_string())?;
        db.busy_timeout(std::time::Duration::from_secs(30)).map_err(|e| e.to_string())?;
        Ok(db)
    }
}

/// Saved keys with environment overrides, as the app resolves them.
pub fn resolved_keys(data_dir: &Path) -> Credentials {
    let env = Credentials::from_env();
    let saved = Credentials::load(&data_dir.join("credentials.json"));
    let mut out = Credentials::default();
    for p in providers::PROVIDERS {
        let _ = out.set(p, providers::resolve(&env, &saved, p).0.to_string());
    }
    out
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).redirect(reqwest::redirect::Policy::none()).build().unwrap_or_default()
}

/// Waits until the provider's free-plan spacing allows a request and records
/// it in the request log shared with the app's other downloads.
pub async fn pace(ctx: &Ctx, provider: &str) -> Result<(), String> {
    let rules = providers::budget(provider);
    loop {
        let wait = {
            let db = ctx.open_main()?;
            let count: i64 = db.query_row("SELECT COUNT(*) FROM requests WHERE provider=?1 AND stamp>?2", params![provider, now() - 86_400], |r| r.get(0)).map_err(|e| e.to_string())?;
            if count >= rules.daily {
                return Err(format!("{}: daily free-plan limit reached ({} requests).", providers::display_name(provider), rules.daily));
            }
            let last: i64 = db.query_row("SELECT COALESCE(MAX(stamp),0) FROM requests WHERE provider=?1", [provider], |r| r.get(0)).map_err(|e| e.to_string())?;
            let wait = rules.gap - (now() - last);
            if wait <= 0 {
                db.execute("INSERT INTO requests(provider,stamp) VALUES(?1,?2)", params![provider, now()]).map_err(|e| e.to_string())?;
            }
            wait
        };
        if wait <= 0 {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(wait as u64)).await;
    }
}

async fn get(ctx: &Ctx, url: &str, query: &[(String, String)], headers: &[(&str, String)]) -> Result<(u16, Value), String> {
    let mut req = ctx.http.get(url).query(query);
    for (k, v) in headers {
        req = req.header(*k, v.as_str());
    }
    let resp = req.send().await.map_err(|_| "Could not reach the provider. Check your internet connection.".to_string())?;
    let code = resp.status().as_u16();
    let text = resp.text().await.map_err(|_| "Could not read the provider's response".to_string())?;
    Ok((code, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

fn alpaca_headers(k: &Credentials) -> Result<Vec<(&'static str, String)>, String> {
    if k.alpaca.is_empty() || k.alpacasecret.is_empty() {
        return Err("Option chains need your Alpaca key ID and secret (Settings → Data sources).".into());
    }
    Ok(vec![("APCA-API-KEY-ID", k.alpaca.clone()), ("APCA-API-SECRET-KEY", k.alpacasecret.clone())])
}

// ---- Risk-free rate ---------------------------------------------------------

/// FRED 3-month bill rates from the app's cache (fetched here when missing),
/// as continuous rates by day; fed funds or 4% as the fallback.
pub async fn rates(ctx: &Ctx) -> (massive::Rates, String) {
    let read = |ctx: &Ctx| -> Option<(Value, i64)> {
        let db = ctx.open_main().ok()?;
        for id in ["fred:observations_long:DTB3", "fred:observations:DTB3"] {
            let row: Option<(String, i64)> = db.query_row("SELECT body,stamp FROM cache WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok()?;
            if let Some((b, s)) = row {
                return serde_json::from_str(&b).ok().map(|v| (v, s));
            }
        }
        None
    };
    let mut data = read(ctx);
    if data.as_ref().is_none_or(|(_, s)| now() - s > 43_200) && !ctx.keys.fred.is_empty() && pace(ctx, "fred").await.is_ok() {
        let r = providers::request("fred", "observations_long", "DTB3", &ctx.keys.fred, now());
        if let Ok(resp) = ctx.http.get(&r.url).query(&r.query).send().await {
            let code = resp.status().as_u16();
            if let Ok(text) = resp.text().await {
                if let Ok(v) = providers::interpret("fred", "observations_long", code, &text, &ctx.keys.fred) {
                    if let Ok(db) = ctx.open_main() {
                        let _ = db.execute("INSERT INTO cache(id,body,stamp) VALUES('fred:observations_long:DTB3',?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body,stamp=excluded.stamp", params![v.to_string(), now()]);
                    }
                    data = Some((v, now()));
                }
            }
        }
    }
    let mut by_day: Vec<(i64, f64)> = data
        .map(|(v, _)| {
            v["observations"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| {
                    let d = options::parse_date(o["date"].as_str()?)?;
                    let pct: f64 = o["value"].as_str()?.parse().ok()?;
                    Some((d, options_math::rates::bill_discount_to_continuous(pct / 100.0, 91.0)?))
                })
                .collect()
        })
        .unwrap_or_default();
    by_day.sort_by_key(|x| x.0);
    let source = if by_day.is_empty() { "assumed 4% (no FRED 3-month bill data)".to_string() } else { "FRED 3-month Treasury bill (DTB3)".to_string() };
    (massive::Rates { by_day, fallback: 0.04 }, source)
}

// ---- Alpaca option chains -------------------------------------------------------

async fn alpaca_spot(ctx: &Ctx, underlying: &str, h: &[(&str, String)]) -> Result<f64, String> {
    pace(ctx, "alpaca").await?;
    let (code, v) = get(ctx, &format!("{}/v2/stocks/{underlying}/trades/latest", options::ALPACA_DATA), &[("feed".into(), "iex".into())], h).await?;
    if code != 200 {
        return Err(format!("Alpaca returned HTTP {code} for {underlying}'s latest trade"));
    }
    v["trade"]["p"].as_f64().filter(|p| *p > 0.0).ok_or_else(|| "Alpaca returned no price".to_string())
}

/// The full chain from Alpaca's free indicative feed, with contract reference
/// data, analyzed with our own forward, IV and Greeks.
pub async fn alpaca_chain(ctx: &Ctx, underlying: &str, spot_hint: Option<f64>) -> Result<Chain, String> {
    if underlying.contains(':') || underlying.is_empty() || underlying.len() > 10 {
        return Err("Option chains cover US-listed stocks and ETFs.".into());
    }
    let h = alpaca_headers(&ctx.keys)?;
    let spot = match spot_hint.filter(|s| *s > 0.0) {
        Some(s) => s,
        None => alpaca_spot(ctx, underlying, &h).await?,
    };
    let mut quotes: Vec<Quote> = vec![];
    let mut page: Option<String> = None;
    for _ in 0..40 {
        pace(ctx, "alpaca").await?;
        let (url, q) = options::alpaca_snapshot_url(underlying, page.as_deref());
        let (code, v) = get(ctx, &url, &q, &h).await?;
        match code {
            200 => {}
            401 | 403 => return Err("Alpaca refused the request. Check the key ID and secret in Settings → Data sources.".into()),
            404 => return Err(format!("Alpaca has no options for {underlying}.")),
            c => return Err(format!("Alpaca returned HTTP {c}")),
        }
        page = options::parse_alpaca_snapshots(&v, &mut quotes);
        if page.is_none() {
            break;
        }
    }
    if quotes.is_empty() {
        return Err(format!("Alpaca returned no option contracts for {underlying}."));
    }
    // Contract reference (open interest, multiplier, style) from the read-only
    // trading API; paper keys use the paper host, live keys the live host.
    let opts_db = ctx.open_options()?;
    let mut hosts = vec![options::ALPACA_PAPER, options::ALPACA_LIVE];
    if options::meta_get(&opts_db, "alpaca:contracts-host").as_deref() == Some(options::ALPACA_LIVE) {
        hosts.reverse();
    }
    'hosts: for host in hosts {
        let mut page: Option<String> = None;
        for _ in 0..20 {
            pace(ctx, "alpaca").await?;
            let (url, q) = options::alpaca_contracts_url(host, underlying, page.as_deref());
            let (code, v) = get(ctx, &url, &q, &h).await?;
            if code == 401 || code == 403 {
                continue 'hosts;
            }
            if code != 200 {
                break 'hosts;
            }
            let _ = options::meta_set(&opts_db, "alpaca:contracts-host", host);
            page = options::merge_alpaca_contracts(&v, &mut quotes);
            if page.is_none() {
                break 'hosts;
            }
        }
    }
    let (rates, source) = rates(ctx).await;
    let t = now();
    Ok(options::analyze(underlying, quotes, spot, t, rates.at(ny_clock(t).0), &source))
}

/// End-of-day capture window: a trading day, 16:15 to 23:59 New York.
pub fn capture_window(t: i64) -> bool {
    let (day, clock) = ny_clock(t);
    trading_day(day) && clock >= 16 * 3600 + 15 * 60
}
pub fn captured_today(db: &Connection, underlying: &str, t: i64) -> bool {
    let date = date_string(ny_clock(t).0);
    db.query_row("SELECT 1 FROM daily_summary WHERE underlying=?1 AND date=?2 AND source='alpaca'", params![underlying, date], |_| Ok(())).is_ok()
}

/// Symbols to record: SPY and QQQ, then the watchlist (US listings), at most 30.
pub fn recorder_list(ctx: &Ctx) -> Vec<String> {
    let mut out: Vec<String> = vec!["SPY".into(), "QQQ".into()];
    if let Ok(db) = ctx.open_main() {
        let body: Option<String> = db.query_row("SELECT body FROM workspace WHERE id=1", [], |r| r.get(0)).optional().ok().flatten();
        if let Some(v) = body.and_then(|b| serde_json::from_str::<Value>(&b).ok()) {
            for s in v["watchlist"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                if !s.contains(':') && s.len() <= 10 && !out.iter().any(|x| x == s) {
                    out.push(s.to_string());
                }
            }
        }
    }
    out.truncate(30);
    out
}

/// Captures every recorder symbol not yet captured today. Returns a summary line.
pub async fn capture_due(ctx: &Ctx) -> String {
    let t = now();
    if !capture_window(t) || ctx.keys.alpaca.is_empty() || ctx.keys.alpacasecret.is_empty() {
        return String::new();
    }
    let (mut ok, mut failed) = (0, vec![]);
    for u in recorder_list(ctx) {
        let done = ctx.open_options().map(|db| captured_today(&db, &u, t)).unwrap_or(true);
        if done {
            continue;
        }
        match alpaca_chain(ctx, &u, None).await {
            Ok(chain) => {
                if ctx.open_options().and_then(|db| options::save_chain(&db, &chain, "alpaca", &ctx.by)).is_ok() {
                    ok += 1;
                }
            }
            Err(e) => failed.push(format!("{u}: {e}")),
        }
        if !capture_window(now()) {
            break;
        }
    }
    format!("captured {ok} chain(s){}", if failed.is_empty() { String::new() } else { format!("; failed {}", failed.join("; ")) })
}

// ---- Massive backfill ---------------------------------------------------------------

/// Queues the reference steps for symbols not yet planned. Returns how many were added.
pub fn plan_backfill(db: &Connection, symbols: &[String], today: i64) -> Result<usize, String> {
    let mut added = 0;
    for s in symbols {
        let key = format!("massive:planned:{s}");
        if options::meta_get(db, &key).is_some() {
            continue;
        }
        for item in massive::plan_reference(s, today) {
            added += enqueue(db, s, &item)?;
        }
        options::meta_set(db, &key, &date_string(today)).map_err(|e| e.to_string())?;
    }
    Ok(added)
}

fn enqueue(db: &Connection, underlying: &str, (id, tier, kind, url): &massive::Item) -> Result<usize, String> {
    let seq: i64 = db.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM backfill_queue", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR IGNORE INTO backfill_queue(id,underlying,tier,kind,request,status,attempts,updated,seq) VALUES(?1,?2,?3,?4,?5,'pending',0,?6,?7)",
        params![id, underlying, tier, kind, url, now(), seq],
    )
    .map_err(|e| e.to_string())
}

/// One runner at a time across the app and the agent: a lease renewed as it works.
fn claim(db: &Connection, by: &str) -> bool {
    let t = now();
    let cur = options::meta_get(db, "massive:runner");
    let free = match cur.as_deref().and_then(|s| s.split_once('|')) {
        Some((who, beat)) => who == by || t - beat.parse::<i64>().unwrap_or(0) > 180,
        None => true,
    };
    free && options::meta_set(db, "massive:runner", &format!("{by}|{t}")).is_ok()
}

pub fn backfill_status(db: &Connection) -> Result<Value, String> {
    let mut st = db.prepare("SELECT underlying, tier, status, COUNT(*) FROM backfill_queue GROUP BY underlying, tier, status").map_err(|e| e.to_string())?;
    let rows: Vec<(String, i64, String, i64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
    let mut symbols: serde_json::Map<String, Value> = Default::default();
    let mut tiers = [[0i64; 3]; 4]; // [tier][done, pending, failed]
    for (u, tier, status, n) in &rows {
        let col = match status.as_str() {
            "done" => 0,
            "pending" => 1,
            _ => 2,
        };
        if let Some(t) = tiers.get_mut(*tier as usize) {
            t[col] += n;
        }
        let e = symbols.entry(u.clone()).or_insert(json!({"done": 0, "pending": 0, "failed": 0}));
        e[["done", "pending", "failed"][col]] = json!(e[["done", "pending", "failed"][col]].as_i64().unwrap_or(0) + n);
    }
    let pending: i64 = tiers.iter().map(|t| t[1]).sum();
    let runner = options::meta_get(db, "massive:runner");
    let running = runner.as_deref().and_then(|s| s.split_once('|')).map(|(_, b)| now() - b.parse::<i64>().unwrap_or(0) < 90).unwrap_or(false);
    let days: i64 = db.query_row("SELECT COUNT(*) FROM daily_summary WHERE source='massive'", [], |r| r.get(0)).unwrap_or(0);
    Ok(json!({
        "symbols": symbols,
        "tiers": tiers.iter().map(|t| json!({"done": t[0], "pending": t[1], "failed": t[2]})).collect::<Vec<_>>(),
        "pending": pending,
        "etaMinutes": (pending as f64 * 13.0 / 60.0).ceil(),
        "running": running,
        "runner": runner.and_then(|s| s.split_once('|').map(|x| x.0.to_string())),
        "paused": options::meta_get(db, "massive:paused").as_deref() == Some("1"),
        "error": options::meta_get(db, "massive:error"),
        "summaryDays": days,
    }))
}

/// Works through the queue until it is empty, `deadline` passes, `stop` is
/// set or the user pauses. Recomputes IV history as contracts arrive.
pub async fn run_backfill(ctx: &Ctx, deadline: std::time::Instant, stop: Arc<AtomicBool>) -> Result<String, String> {
    if ctx.keys.massive.is_empty() {
        return Err("No Massive key. Add it in Settings → Data sources.".into());
    }
    {
        let db = ctx.open_options()?;
        if !claim(&db, &ctx.by) {
            return Ok("another Aperture process is already backfilling".into());
        }
    }
    let auth = vec![("Authorization", format!("Bearer {}", ctx.keys.massive))];
    let (rates, _) = rates(ctx).await;
    let mut done = 0;
    let mut touched: std::collections::BTreeMap<String, i64> = Default::default();
    let result: Result<(), String> = async {
        loop {
            if stop.load(Ordering::Relaxed) || std::time::Instant::now() >= deadline {
                break;
            }
            let next: Option<(String, String, String, String, i64)> = {
                let db = ctx.open_options()?;
                if options::meta_get(&db, "massive:paused").as_deref() == Some("1") || !claim(&db, &ctx.by) {
                    break;
                }
                db.query_row("SELECT id, underlying, kind, request, attempts FROM backfill_queue WHERE status='pending' ORDER BY tier, seq LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
                    .optional()
                    .map_err(|e| e.to_string())?
            };
            let Some((id, underlying, kind, url, attempts)) = next else { break };
            let mark = |status: &str, err: Option<&str>| -> Result<(), String> {
                let db = ctx.open_options()?;
                db.execute("UPDATE backfill_queue SET status=?2, attempts=attempts+1, error=?3, updated=?4 WHERE id=?1", params![id, status, err, now()]).map(|_| ()).map_err(|e| e.to_string())
            };
            if !massive::allowed(&url) {
                mark("failed", Some("refused: not Massive's API host"))?;
                continue;
            }
            pace(ctx, "massive").await?;
            let (code, body) = match get(ctx, &url, &[], &auth).await {
                Ok(x) => x,
                Err(e) => {
                    mark(if attempts >= 2 { "failed" } else { "pending" }, Some(&e))?;
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    continue;
                }
            };
            match code {
                200 => {
                    let follow = {
                        let db = ctx.open_options()?;
                        let follow = massive::apply(&db, &underlying, &kind, &body, ny_clock(now()).0)?;
                        for f in &follow {
                            enqueue(&db, &underlying, f)?;
                        }
                        db.execute("UPDATE backfill_queue SET status='done', updated=?2, error=NULL WHERE id=?1", params![id, now()]).map_err(|e| e.to_string())?;
                        let _ = db.execute("DELETE FROM meta WHERE key='massive:error'", []);
                        follow
                    };
                    let _ = follow;
                    done += 1;
                    if kind == "aggs" {
                        let n = touched.entry(underlying.clone()).or_insert(0);
                        *n += 1;
                        if *n % 20 == 0 {
                            let db = ctx.open_options()?;
                            massive::compute(&db, &underlying, &rates)?;
                        }
                    }
                }
                401 => {
                    let db = ctx.open_options()?;
                    let _ = options::meta_set(&db, "massive:error", "Massive refused the key (HTTP 401). Check it in Settings → Data sources.");
                    return Err("Massive refused the key.".into());
                }
                403 => mark("denied", Some("Not included in the free plan (HTTP 403)"))?,
                404 => mark("done", Some("No data (HTTP 404)"))?,
                429 => {
                    mark("pending", Some("Rate limited (HTTP 429); waiting"))?;
                    tokio::time::sleep(std::time::Duration::from_secs(65)).await;
                }
                c => mark(if attempts >= 2 { "failed" } else { "pending" }, Some(&format!("HTTP {c}")))?,
            }
        }
        Ok(())
    }
    .await;
    let db = ctx.open_options()?;
    for u in touched.keys() {
        let _ = massive::compute(&db, u, &rates);
    }
    let _ = db.execute("DELETE FROM meta WHERE key='massive:runner' AND value LIKE ?1", [format!("{}|%", ctx.by)]);
    result?;
    Ok(format!("backfill: {done} request(s)"))
}

/// One background run: capture due chains, then backfill for up to
/// `budget` of time. Used by `aperture --agent` and the app's own loop.
pub async fn run_once(ctx: &Ctx, budget: std::time::Duration, stop: Arc<AtomicBool>) -> String {
    let started = now();
    let mut parts = vec![];
    if let Ok(db) = ctx.open_options() {
        let _ = db.execute("INSERT OR REPLACE INTO agent_runs(started,by) VALUES(?1,?2)", params![started, ctx.by]);
    }
    let cap = capture_due(ctx).await;
    if !cap.is_empty() {
        parts.push(cap);
    }
    if !ctx.keys.massive.is_empty() {
        let symbols = recorder_list(ctx);
        if let Ok(db) = ctx.open_options() {
            let _ = plan_backfill(&db, &symbols, ny_clock(now()).0);
        }
        match run_backfill(ctx, std::time::Instant::now() + budget, stop).await {
            Ok(s) => parts.push(s),
            Err(e) => parts.push(format!("backfill stopped: {e}")),
        }
    }
    let result = if parts.is_empty() { "nothing due".to_string() } else { parts.join(" · ") };
    if let Ok(db) = ctx.open_options() {
        let _ = db.execute("UPDATE agent_runs SET finished=?2, result=?3 WHERE started=?1", params![started, now(), result]);
        let _ = db.execute("DELETE FROM agent_runs WHERE started < ?1", [now() - 30 * 86_400]);
    }
    result
}

/// Entry point for `aperture --agent --data <dir>`.
pub fn agent_main(data_dir: PathBuf) -> i32 {
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(_) => return 1,
    };
    let ctx = Ctx { http: http_client(), keys: resolved_keys(&data_dir), data_dir, by: "agent".into() };
    let out = rt.block_on(run_once(&ctx, std::time::Duration::from_secs(25 * 60), Arc::new(AtomicBool::new(false))));
    println!("{} {out}", providers::rfc3339(now()));
    0
}

pub fn last_runs(db: &Connection, n: usize) -> Value {
    let mut st = match db.prepare("SELECT started, finished, by, result FROM agent_runs ORDER BY started DESC LIMIT ?1") {
        Ok(s) => s,
        Err(_) => return json!([]),
    };
    let rows = st.query_map([n as i64], |r| Ok(json!({"started": r.get::<_, i64>(0)?, "finished": r.get::<_, Option<i64>>(1)?, "by": r.get::<_, Option<String>>(2)?, "result": r.get::<_, Option<String>>(3)?})));
    Value::Array(rows.map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_window_is_after_the_close_on_trading_days() {
        let d = options::days_from_civil(2026, 11, 17);
        assert!(!capture_window(d * 86_400 + 21 * 3600)); // 16:00 ET
        assert!(capture_window(d * 86_400 + 21 * 3600 + 20 * 60)); // 16:20 ET
        let sat = options::days_from_civil(2026, 11, 21);
        assert!(!capture_window(sat * 86_400 + 22 * 3600));
    }
    #[test]
    fn plans_once_and_leases_one_runner() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(options::SCHEMA).unwrap();
        let today = options::days_from_civil(2026, 11, 17);
        let n = plan_backfill(&db, &["AAPL".to_string()], today).unwrap();
        assert!(n > 40);
        assert_eq!(plan_backfill(&db, &["AAPL".to_string()], today).unwrap(), 0);
        assert!(claim(&db, "agent"));
        assert!(!claim(&db, "app"), "the agent holds a fresh lease");
        assert!(claim(&db, "agent"));
        let s = backfill_status(&db).unwrap();
        assert_eq!(s["pending"].as_i64().unwrap() as usize, n);
    }
}
