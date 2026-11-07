#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ledger;
mod providers;
mod sec;
mod ais;
mod quotes;
mod f13;
mod universe;
use providers::Credentials;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
struct Backend {
    db: Mutex<Connection>,
    gate: tokio::sync::Mutex<()>,
    /// SEC has its own rate limit, so its requests don't wait behind other providers.
    sec_gate: tokio::sync::Mutex<()>,
    env_keys: Credentials,
    saved_keys: Mutex<Credentials>,
    key_path: std::path::PathBuf,
    ais: std::sync::Arc<Mutex<AisRuntime>>,
    quotes: std::sync::Arc<Mutex<QuoteRuntime>>,
    http: reqwest::Client,
    /// Long downloads (bulk SEC files, the listing directory).
    bulk: reqwest::Client,
    /// reference.sqlite: 13F holdings and the listing directory. Bulk loads
    /// write through their own connection; WAL keeps reads going meanwhile.
    refdb: std::sync::Arc<Mutex<Connection>>,
    ref_path: std::path::PathBuf,
    jobs: std::sync::Arc<Mutex<Jobs>>,
}
#[derive(Default, Clone, serde::Serialize)]
struct Job {
    running: bool,
    stage: String,
    done: u64,
    total: u64,
    error: String,
    finished: i64,
}
#[derive(Default)]
struct Jobs {
    holdings: Job,
    universe: Job,
}
fn open_reference(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    // auto_vacuum only takes effect on a new file, before any table exists.
    db.execute_batch("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
    db.busy_timeout(std::time::Duration::from_secs(120))?;
    f13::init(&db)?;
    universe::init(&db)?;
    Ok(db)
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
#[tauri::command]
async fn export_file(
    app: tauri::AppHandle,
    filename: String,
    contents: String,
) -> Result<bool, String> {
    if filename.contains('/') || filename.contains('\\') || contents.len() > 25_000_000 {
        return Err("Invalid export".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .dialog()
            .file()
            .set_file_name(filename)
            .blocking_save_file();
        if let Some(path) = path {
            let path = path.into_path().map_err(|e| e.to_string())?;
            std::fs::write(path, contents).map_err(|e| e.to_string())?;
            Ok(true)
        } else {
            Ok(false)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn load_state(b: tauri::State<Backend>) -> Result<Value, String> {
    let db = b.db.lock().map_err(|_| "Database unavailable")?;
    let raw: String = db
        .query_row("SELECT body FROM workspace WHERE id=1", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or("null".into());
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}
#[tauri::command]
fn save_state(b: tauri::State<Backend>, state: Value) -> Result<(), String> {
    if state.to_string().len() > 20_000_000 {
        return Err("Workspace exceeds 20 MB".into());
    }
    let db = b.db.lock().map_err(|_| "Database unavailable")?;
    db.execute("INSERT INTO workspace(id,body) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET body=excluded.body",[state.to_string()]).map_err(|e|e.to_string())?;
    Ok(())
}
#[tauri::command]
fn paper_trade(
    b: tauri::State<Backend>,
    mode: String,
    order: ledger::Trade,
) -> Result<Value, String> {
    if !["sample", "market"].contains(&mode.as_str()) {
        return Err("Invalid account".into());
    }
    let mut db = b.db.lock().map_err(|_| "Database unavailable")?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let raw: String = tx
        .query_row("SELECT body FROM workspace WHERE id=1", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut state: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let mut account: ledger::Account =
        serde_json::from_value(state["accounts"][&mode].clone()).map_err(|e| e.to_string())?;
    let map = if mode == "sample" {
        "assets"
    } else {
        "marketAssets"
    };
    if state[map].get(&order.symbol).is_none() {
        return Err("Import prices for this symbol before trading".into());
    }
    account.append(order)?;
    state["accounts"][&mode] = serde_json::to_value(account).map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE workspace SET body=?1 WHERE id=1",
        [state.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(state)
}
#[tauri::command]
fn key_status(b: tauri::State<Backend>) -> Result<Value, String> {
    let saved = b.saved_keys.lock().map_err(|_| "Key store unavailable")?;
    Ok(providers::status(&b.env_keys, &saved))
}
/// Saves keys to a private file in the app-data folder. Empty values are ignored,
/// so the form can update one provider without retyping the others.
#[tauri::command]
fn set_keys(b: tauri::State<Backend>, keys: std::collections::HashMap<String, String>) -> Result<Value, String> {
    let mut saved = b.saved_keys.lock().map_err(|_| "Key store unavailable")?;
    let mut next = saved.clone();
    for (provider, key) in keys {
        if !providers::PROVIDERS.contains(&provider.as_str()) {
            return Err("Unknown provider".into());
        }
        if !key.trim().is_empty() {
            next.set(&provider, key)?;
        }
    }
    next.save(&b.key_path)?;
    *saved = next;
    Ok(providers::status(&b.env_keys, &saved))
}
#[tauri::command]
fn clear_key(b: tauri::State<Backend>, provider: String) -> Result<Value, String> {
    let mut saved = b.saved_keys.lock().map_err(|_| "Key store unavailable")?;
    let mut next = saved.clone();
    next.set(&provider, String::new())?;
    next.save(&b.key_path)?;
    *saved = next;
    Ok(providers::status(&b.env_keys, &saved))
}
#[tauri::command]
async fn fetch_data(
    b: tauri::State<'_, Backend>,
    provider: String,
    kind: String,
    symbol: String,
) -> Result<Value, String> {
    providers::validate(&provider, &kind, &symbol)?;
    let _guard = b.gate.lock().await;
    let rules = providers::budget(&provider);
    let cache_key = format!("{provider}:{kind}:{symbol}");
    let cached: Option<(String, i64)> = {
        let db = b.db.lock().map_err(|_| "Database unavailable")?;
        db.query_row("SELECT body,stamp FROM cache WHERE id=?1", [&cache_key], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?
    };
    if let Some((body, stamp)) = &cached {
        if now() - stamp < rules.ttl {
            return Ok(json!({"data":serde_json::from_str::<Value>(body).map_err(|e|e.to_string())?,"fetchedAt":stamp,"cached":true,"provider":provider}));
        }
    }
    let key = {
        let saved = b.saved_keys.lock().map_err(|_| "Key store unavailable")?;
        providers::resolve(&b.env_keys, &saved, &provider).0.to_string()
    };
    if key.is_empty() {
        return Err(format!("No {} key yet. Add it in Settings → Data sources.", match provider.as_str() { "alpha" => "Alpha Vantage", "twelve" => "Twelve Data", _ => "FRED" }));
    }
    let (count, last): (i64, i64) = {
        let db = b.db.lock().map_err(|_| "Database unavailable")?;
        let count = db
            .query_row("SELECT COUNT(*) FROM requests WHERE provider=?1 AND stamp>?2", params![provider, now() - 86400], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let last = db
            .query_row("SELECT COALESCE(MAX(stamp),0) FROM requests WHERE provider=?1", [&provider], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        (count, last)
    };
    if count >= rules.daily {
        let msg = format!("Daily free-plan limit reached ({} requests). Showing saved data; new downloads resume within 24 hours.", rules.daily);
        return match cached {
            Some((body, stamp)) => Ok(json!({"data":serde_json::from_str::<Value>(&body).map_err(|e|e.to_string())?,"fetchedAt":stamp,"cached":true,"stale":true,"warning":msg,"provider":provider})),
            None => Err(msg),
        };
    }
    // Space requests to respect per-minute limits instead of failing them.
    let wait = rules.gap - (now() - last);
    if wait > 0 {
        tokio::time::sleep(std::time::Duration::from_secs(wait as u64)).await;
    }
    let ts = now();
    b.db.lock()
        .map_err(|_| "Database unavailable")?
        .execute("INSERT INTO requests(provider,stamp) VALUES(?1,?2)", params![provider, ts])
        .map_err(|e| e.to_string())?;
    let (url, query) = providers::request(&provider, &kind, &symbol, &key);
    let result: Result<Value, String> = async {
        let resp = b.http.get(url).query(&query).send().await.map_err(|_| "Could not reach the provider. Check your internet connection.".to_string())?;
        let http = resp.status().as_u16();
        let body = resp.text().await.map_err(|_| "Could not read provider response".to_string())?;
        providers::interpret(&provider, &kind, http, &body, &key)
    }
    .await;
    match result {
        Ok(data) => {
            b.db.lock().map_err(|_|"Database unavailable")?.execute("INSERT INTO cache(id,body,stamp) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body,stamp=excluded.stamp",params![cache_key,data.to_string(),ts]).map_err(|e|e.to_string())?;
            Ok(json!({"data":data,"fetchedAt":ts,"cached":false,"provider":provider}))
        }
        Err(error) => match cached {
            Some((body, stamp)) => Ok(json!({"data":serde_json::from_str::<Value>(&body).map_err(|e|e.to_string())?,"fetchedAt":stamp,"cached":true,"stale":true,"warning":error,"provider":provider})),
            None => Err(error),
        },
    }
}
/// SEC EDGAR data. Keyless; documents and the company directory need the
/// user's contact email, which is sent only to sec.gov.
#[tauri::command]
async fn fetch_sec(
    b: tauri::State<'_, Backend>,
    kind: String,
    cik: String,
    accession: String,
    doc: String,
) -> Result<Value, String> {
    let (url, needs_contact, ttl) = sec::resource(&kind, &cik, &accession, &doc)?;
    let cache_key = format!("sec:{url}");
    let cached: Option<(String, i64)> = {
        let db = b.db.lock().map_err(|_| "Database unavailable")?;
        db.query_row("SELECT body,stamp FROM cache WHERE id=?1", [&cache_key], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?
    };
    if let Some((body, stamp)) = &cached {
        if now() - stamp < ttl {
            return Ok(json!({"data":serde_json::from_str::<Value>(body).map_err(|e|e.to_string())?,"fetchedAt":stamp,"cached":true,"provider":"sec"}));
        }
    }
    let contact = {
        let saved = b.saved_keys.lock().map_err(|_| "Key store unavailable")?;
        providers::resolve(&b.env_keys, &saved, "sec").0.to_string()
    };
    if needs_contact && contact.is_empty() {
        return Err("SEC asks automated tools for a contact email before serving filing documents. Add yours in Settings → Data sources.".into());
    }
    let _guard = b.sec_gate.lock().await;
    // SEC allows 10 requests per second; stay well under it.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let result: Result<Value, String> = async {
        let resp = b
            .http
            .get(&url)
            .header(reqwest::header::USER_AGENT, sec::user_agent(&contact))
            .send()
            .await
            .map_err(|_| "Could not reach SEC EDGAR. Check your internet connection.".to_string())?;
        let http = resp.status().as_u16();
        let body = resp.text().await.map_err(|_| "Could not read SEC response".to_string())?;
        sec::interpret(&kind, http, &body)
    }
    .await;
    let ts = now();
    match result {
        Ok(data) => {
            b.db.lock().map_err(|_|"Database unavailable")?.execute("INSERT INTO cache(id,body,stamp) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body,stamp=excluded.stamp",params![cache_key,data.to_string(),ts]).map_err(|e|e.to_string())?;
            Ok(json!({"data":data,"fetchedAt":ts,"cached":false,"provider":"sec"}))
        }
        Err(error) => match cached {
            Some((body, stamp)) => Ok(json!({"data":serde_json::from_str::<Value>(&body).map_err(|e|e.to_string())?,"fetchedAt":stamp,"cached":true,"stale":true,"warning":error,"provider":"sec"})),
            None => Err(error),
        },
    }
}

// ---- Reference data: 13F holdings and the listing directory ---------------
type JobsRef = std::sync::Arc<Mutex<Jobs>>;
fn set_job(jobs: &JobsRef, which: &str, f: impl FnOnce(&mut Job)) {
    if let Ok(mut j) = jobs.lock() {
        f(if which == "holdings" { &mut j.holdings } else { &mut j.universe });
    }
}
fn sec_contact(b: &Backend) -> Result<String, String> {
    let saved = b.saved_keys.lock().map_err(|_| "Key store unavailable")?;
    Ok(providers::resolve(&b.env_keys, &saved, "sec").0.to_string())
}
/// GET into memory, reporting bytes as they arrive.
async fn fetch_bytes(client: &reqwest::Client, url: &str, ua: &str, jobs: &JobsRef, which: &str) -> Result<Vec<u8>, String> {
    let mut resp = client
        .get(url)
        .header(reqwest::header::USER_AGENT, ua)
        .send()
        .await
        .map_err(|_| "Could not reach the server. Check your internet connection.".to_string())?;
    match resp.status().as_u16() {
        200 => {}
        403 => return Err("SEC refused the download. Check the contact email in Settings → Data sources.".into()),
        code => return Err(format!("Download failed (HTTP {code})")),
    }
    let total = resp.content_length().unwrap_or(0);
    set_job(jobs, which, |j| {
        j.done = 0;
        j.total = total;
    });
    let mut out = Vec::with_capacity(total.min(200_000_000) as usize);
    while let Some(chunk) = resp.chunk().await.map_err(|_| "The download was interrupted.".to_string())? {
        out.extend_from_slice(&chunk);
        if out.len() > 400_000_000 {
            return Err("Download is larger than expected; stopped.".into());
        }
        let n = out.len() as u64;
        set_job(jobs, which, |j| j.done = n);
    }
    Ok(out)
}
fn first_zip_entry(bytes: Vec<u8>) -> Result<String, String> {
    use std::io::Read;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "Not a zip file".to_string())?;
    let mut f = z.by_index(0).map_err(|_| "Empty zip file".to_string())?;
    let mut b = Vec::new();
    f.read_to_end(&mut b).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&b).into_owned())
}
#[tauri::command]
fn holdings_status(b: tauri::State<Backend>) -> Result<Value, String> {
    let mut s = f13::status(&*b.refdb.lock().map_err(|_| "Database unavailable")?).map_err(|e| e.to_string())?;
    s["job"] = serde_json::to_value(b.jobs.lock().map_err(|_| "Jobs unavailable")?.holdings.clone()).unwrap_or_default();
    Ok(s)
}
/// Downloads the newest `quarters` SEC 13F data sets that aren't loaded yet,
/// loads them, drops older quarters and refreshes the ticker-to-CUSIP map.
#[tauri::command]
fn holdings_update(b: tauri::State<Backend>, quarters: u32) -> Result<(), String> {
    if !(1..=12).contains(&quarters) {
        return Err("Choose between 1 and 12 quarters".into());
    }
    let contact = sec_contact(&b)?;
    if contact.is_empty() {
        return Err("SEC asks for a contact email before bulk downloads. Add yours in Settings → Data sources.".into());
    }
    {
        let mut j = b.jobs.lock().map_err(|_| "Jobs unavailable")?;
        if j.holdings.running {
            return Ok(());
        }
        j.holdings = Job { running: true, stage: "Checking SEC for 13F data sets…".into(), ..Default::default() };
    }
    let (jobs, client, path, read) = (b.jobs.clone(), b.bulk.clone(), b.ref_path.clone(), b.refdb.clone());
    tauri::async_runtime::spawn(async move {
        let result = run_holdings(&jobs, &client, &path, &read, &sec::user_agent(&contact), quarters as usize).await;
        set_job(&jobs, "holdings", |j| {
            j.running = false;
            j.finished = now();
            match result {
                Ok(stage) => {
                    j.stage = stage;
                    j.error.clear();
                }
                Err(e) => j.error = e,
            }
        });
    });
    Ok(())
}
async fn run_holdings(jobs: &JobsRef, client: &reqwest::Client, path: &std::path::Path, read: &std::sync::Arc<Mutex<Connection>>, ua: &str, quarters: usize) -> Result<String, String> {
    let page = fetch_bytes(client, f13::LIST_URL, ua, jobs, "holdings").await?;
    let sets = f13::set_links(&String::from_utf8_lossy(&page));
    if sets.is_empty() {
        return Err("Couldn't find any 13F data sets on SEC's page.".into());
    }
    let want: Vec<(String, String)> = sets.into_iter().take(quarters).collect();
    let loaded: Vec<String> = {
        let db = read.lock().map_err(|_| "Database unavailable")?;
        let mut q = db.prepare("SELECT name FROM f13_sets").map_err(|e| e.to_string())?;
        let v = q.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
        v
    };
    let todo: Vec<&(String, String)> = want.iter().rev().filter(|(n, _)| !loaded.contains(n)).collect();
    let dir = path.parent().unwrap_or(std::path::Path::new(".")).join("f13");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (i, (name, link)) in todo.iter().enumerate() {
        let label = format!("{} of {}: SEC 13F filings {}", i + 1, todo.len(), name.trim_end_matches("_form13f").replace('-', " to "));
        set_job(jobs, "holdings", |j| j.stage = format!("Downloading {label}"));
        let bytes = fetch_bytes(client, &format!("https://www.sec.gov{link}"), ua, jobs, "holdings").await?;
        let file = dir.join(format!("{name}.zip"));
        std::fs::write(&file, &bytes).map_err(|_| "Couldn't save the download (disk full?)".to_string())?;
        drop(bytes);
        set_job(jobs, "holdings", |j| j.stage = format!("Reading {label}"));
        let (p, f, n, jb) = (path.to_path_buf(), file.clone(), name.clone(), jobs.clone());
        let out = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
            let mut db = open_reference(&p).map_err(|e| e.to_string())?;
            db.execute_batch("PRAGMA cache_size=-262144;").map_err(|e| e.to_string())?;
            let zip = std::fs::File::open(&f).map_err(|e| e.to_string())?;
            f13::ingest(&mut db, zip, &n, &mut |done, total| {
                set_job(&jb, "holdings", |j| {
                    j.done = done;
                    j.total = total;
                })
            })
        })
        .await
        .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&file);
        out?;
    }
    set_job(jobs, "holdings", |j| j.stage = "Updating the ticker-to-CUSIP map…".into());
    let page = fetch_bytes(client, f13::FTD_URL, ua, jobs, "holdings").await?;
    let have: Vec<String> = {
        let db = read.lock().map_err(|_| "Database unavailable")?;
        let mut q = db.prepare("SELECT name FROM ftd_files").map_err(|e| e.to_string())?;
        let v = q.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
        v
    };
    for (name, link) in f13::ftd_links(&String::from_utf8_lossy(&page)).into_iter().take(f13::FTD_FILES) {
        if have.contains(&name) {
            continue;
        }
        let text = first_zip_entry(fetch_bytes(client, &format!("https://www.sec.gov{link}"), ua, jobs, "holdings").await?)?;
        let map = f13::parse_ftd(&text);
        let mut db = read.lock().map_err(|_| "Database unavailable")?;
        f13::store_ftd(&mut db, &name, &map).map_err(|e| e.to_string())?;
    }
    set_job(jobs, "holdings", |j| j.stage = "Removing older quarters…".into());
    let p = path.to_path_buf();
    let names: Vec<String> = want.iter().map(|w| w.0.clone()).collect();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let db = open_reference(&p).map_err(|e| e.to_string())?;
        f13::prune(&db, quarters).map_err(|e| e.to_string())?;
        let mut q = db.prepare("SELECT name FROM f13_sets").map_err(|e| e.to_string())?;
        let all: Vec<String> = q.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
        for n in all.iter().filter(|n| !names.contains(n)) {
            db.execute("DELETE FROM f13_sets WHERE name=?1", [n]).map_err(|e| e.to_string())?;
        }
        db.execute_batch("PRAGMA incremental_vacuum;").map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(if todo.is_empty() { "Up to date".into() } else { format!("Loaded {} quarter(s)", todo.len()) })
}
fn parse_period(p: &Option<String>) -> Option<u32> {
    let p = p.as_deref()?.replace('-', "");
    (p.len() == 8).then(|| p.parse().ok()).flatten()
}
/// All 13F holders of a ticker's securities. `extra` adds CUSIPs the caller
/// knows (from 13G cover pages); `only` replaces the automatic choice.
#[tauri::command]
fn holders(b: tauri::State<Backend>, ticker: String, name: String, extra: Vec<String>, only: Option<Vec<String>>, period: Option<String>) -> Result<Value, String> {
    if ticker.len() > 30 || name.len() > 200 || extra.len() > 20 || only.as_ref().is_some_and(|o| o.len() > 20) {
        return Err("Invalid holder request".into());
    }
    let db = b.refdb.lock().map_err(|_| "Database unavailable")?;
    let period = parse_period(&period);
    let found = f13::resolve(&db, &ticker, &name, &extra, period).map_err(|e| e.to_string())?;
    let ids: Vec<String> = match only {
        Some(o) => o,
        None => found["securities"].as_array().into_iter().flatten().filter_map(|s| s["cusip"].as_str().map(String::from)).collect(),
    };
    let mut out = f13::holders(&db, &ids, period).map_err(|e| e.to_string())?;
    out["securities"] = found["securities"].clone();
    out["related"] = found["related"].clone();
    out["included"] = json!(ids);
    Ok(out)
}
#[tauri::command]
fn holder_portfolio(b: tauri::State<Backend>, cik: u32, period: Option<String>) -> Result<Value, String> {
    let db = b.refdb.lock().map_err(|_| "Database unavailable")?;
    f13::portfolio(&db, cik, parse_period(&period)).map_err(|e| e.to_string())
}
#[tauri::command]
fn holders_find(b: tauri::State<Backend>, q: String) -> Result<Value, String> {
    if q.trim().len() < 2 || q.len() > 80 {
        return Ok(json!([]));
    }
    let db = b.refdb.lock().map_err(|_| "Database unavailable")?;
    f13::find_filers(&db, &q, 12).map_err(|e| e.to_string())
}
#[tauri::command]
fn universe_status(b: tauri::State<Backend>) -> Result<Value, String> {
    let mut s = universe::status(&*b.refdb.lock().map_err(|_| "Database unavailable")?).map_err(|e| e.to_string())?;
    s["job"] = serde_json::to_value(b.jobs.lock().map_err(|_| "Jobs unavailable")?.universe.clone()).unwrap_or_default();
    Ok(s)
}
/// Rebuilds the listing directory from Twelve Data's public stock and ETF
/// lists, plus SEC's company file when a contact email is set.
#[tauri::command]
fn universe_refresh(b: tauri::State<Backend>) -> Result<(), String> {
    let contact = sec_contact(&b)?;
    {
        let mut j = b.jobs.lock().map_err(|_| "Jobs unavailable")?;
        if j.universe.running {
            return Ok(());
        }
        j.universe = Job { running: true, stage: "Downloading the world stock list…".into(), ..Default::default() };
    }
    let (jobs, client, path) = (b.jobs.clone(), b.bulk.clone(), b.ref_path.clone());
    tauri::async_runtime::spawn(async move {
        let result: Result<String, String> = async {
            let ua = "MarketLens/0.2 (desktop research app)";
            let stocks = fetch_bytes(&client, universe::STOCKS_URL, ua, &jobs, "universe").await?;
            set_job(&jobs, "universe", |j| j.stage = "Downloading the world ETF list…".into());
            let etfs = fetch_bytes(&client, universe::ETFS_URL, ua, &jobs, "universe").await?;
            let sec_body = if contact.is_empty() {
                None
            } else {
                set_job(&jobs, "universe", |j| j.stage = "Downloading SEC's company list…".into());
                fetch_bytes(&client, universe::SEC_URL, &sec::user_agent(&contact), &jobs, "universe").await.ok()
            };
            set_job(&jobs, "universe", |j| j.stage = "Building the directory…".into());
            tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
                let mut list = universe::parse_twelve(&String::from_utf8_lossy(&stocks), false)?;
                let n_stocks = list.len() as i64;
                drop(stocks);
                let etf = universe::parse_twelve(&String::from_utf8_lossy(&etfs), true).unwrap_or_default();
                let n_etfs = etf.len() as i64;
                list.extend(etf);
                let sec = sec_body.map(|s| universe::parse_sec(&String::from_utf8_lossy(&s)).unwrap_or_default()).unwrap_or_default();
                let merged = universe::merge(list, &sec);
                let mut db = open_reference(&path).map_err(|e| e.to_string())?;
                let n = universe::replace(&mut db, &merged, (n_stocks, n_etfs, sec.len() as i64)).map_err(|e| e.to_string())?;
                Ok(format!("{n} listings"))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        .await;
        set_job(&jobs, "universe", |j| {
            j.running = false;
            j.finished = now();
            match result {
                Ok(stage) => {
                    j.stage = stage;
                    j.error.clear();
                }
                Err(e) => j.error = e,
            }
        });
    });
    Ok(())
}
#[tauri::command]
fn universe_search(b: tauri::State<Backend>, q: String, limit: Option<usize>) -> Result<Value, String> {
    let db = b.refdb.lock().map_err(|_| "Database unavailable")?;
    universe::search(&db, &q, limit.unwrap_or(12)).map_err(|e| e.to_string())
}
#[tauri::command]
fn universe_browse(b: tauri::State<Backend>, country: String, mic: String, kind: String, q: String, offset: usize, limit: usize) -> Result<Value, String> {
    if [&country, &mic, &kind, &q].iter().any(|x| x.len() > 80) {
        return Err("Invalid filter".into());
    }
    let db = b.refdb.lock().map_err(|_| "Database unavailable")?;
    universe::browse(&db, &universe::Filter { country, mic, kind, q, offset, limit }).map_err(|e| e.to_string())
}
#[tauri::command]
fn universe_facets(b: tauri::State<Backend>) -> Result<Value, String> {
    let db = b.refdb.lock().map_err(|_| "Database unavailable")?;
    universe::facets(&db).map_err(|e| e.to_string())
}
#[tauri::command]
fn universe_get(b: tauri::State<Backend>, key: String) -> Result<Value, String> {
    if key.len() > 40 {
        return Ok(Value::Null);
    }
    let db = b.refdb.lock().map_err(|_| "Database unavailable")?;
    Ok(universe::get(&db, &key).map_err(|e| e.to_string())?.unwrap_or(Value::Null))
}
#[derive(Default)]
struct AisRuntime {
    store: ais::Store,
    area: String,
    status: String,
    error: String,
    last_message: i64,
    session: u64,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}
/// Starts (or moves) the live vessel stream to a box around one location.
#[tauri::command]
fn ais_start(b: tauri::State<Backend>, area: String, lat: f64, lon: f64) -> Result<(), String> {
    if area.len() > 40 || !area.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Invalid area".into());
    }
    let bbox = ais::BBox::around(lat, lon, 1.0)?;
    let key = {
        let saved = b.saved_keys.lock().map_err(|_| "Key store unavailable")?;
        providers::resolve(&b.env_keys, &saved, "ais").0.to_string()
    };
    if key.is_empty() {
        return Err("Add an AISStream key in Settings → Data sources for live vessels.".into());
    }
    let mut rt = b.ais.lock().map_err(|_| "Vessel stream unavailable")?;
    if rt.area == area && rt.task.is_some() {
        return Ok(());
    }
    if let Some(t) = rt.task.take() {
        t.abort();
    }
    rt.session += 1;
    let session = rt.session;
    rt.store = ais::Store::default();
    rt.area = area;
    rt.status = "connecting".into();
    rt.error.clear();
    rt.last_message = 0;
    let shared = b.ais.clone();
    rt.task = Some(tauri::async_runtime::spawn(run_ais(shared, session, key, bbox)));
    Ok(())
}
#[tauri::command]
fn ais_stop(b: tauri::State<Backend>) -> Result<(), String> {
    let mut rt = b.ais.lock().map_err(|_| "Vessel stream unavailable")?;
    if let Some(t) = rt.task.take() {
        t.abort();
    }
    rt.session += 1;
    rt.status = "stopped".into();
    Ok(())
}
#[tauri::command]
fn ais_snapshot(b: tauri::State<Backend>) -> Result<Value, String> {
    let mut rt = b.ais.lock().map_err(|_| "Vessel stream unavailable")?;
    rt.store.prune(now());
    let mut vessels: Vec<&ais::Vessel> = rt.store.vessels.values().collect();
    vessels.sort_by(|a, b| b.seen.cmp(&a.seen));
    Ok(json!({"area":rt.area,"status":rt.status,"error":rt.error,"lastMessage":rt.last_message,"vessels":vessels}))
}
async fn run_ais(shared: std::sync::Arc<Mutex<AisRuntime>>, session: u64, key: String, bbox: ais::BBox) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    // Every update checks the session so a replaced stream can't write.
    let update = |f: &mut dyn FnMut(&mut AisRuntime)| {
        if let Ok(mut rt) = shared.lock() {
            if rt.session == session {
                f(&mut rt);
            }
        }
    };
    let mut attempt = 0u32;
    loop {
        let mut fatal = false;
        match tokio_tungstenite::connect_async(ais::STREAM_URL).await {
            Ok((mut ws, _)) => {
                if ws.send(Message::text(ais::subscription(&key, &bbox))).await.is_ok() {
                    update(&mut |rt| rt.status = "subscribed".into());
                    while let Some(frame) = ws.next().await {
                        let bytes = match &frame {
                            Ok(Message::Text(t)) => t.as_bytes().to_vec(),
                            Ok(Message::Binary(b)) => b.to_vec(),
                            Ok(Message::Close(_)) | Err(_) => break,
                            _ => continue,
                        };
                        let Ok(msg) = serde_json::from_slice::<Value>(&bytes) else { continue };
                        if let Some(err) = msg.get("error").and_then(Value::as_str) {
                            let clean: String = err.replace(&key, "***").chars().take(200).collect();
                            fatal = clean.to_ascii_lowercase().contains("api key");
                            update(&mut |rt| {
                                rt.error = format!("AISStream: {clean}");
                                rt.status = "error".into();
                            });
                            break;
                        }
                        attempt = 0;
                        let t = now();
                        update(&mut |rt| {
                            if rt.store.apply(&msg, &bbox, t) {
                                rt.last_message = t;
                            }
                            rt.status = "live".into();
                            rt.error.clear();
                        });
                    }
                }
            }
            Err(_) => update(&mut |rt| rt.error = "Could not reach AISStream. Retrying…".into()),
        }
        if fatal {
            return; // A rejected key won't start working by retrying.
        }
        update(&mut |rt| rt.status = "reconnecting".into());
        let jitter = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_millis() as u64;
        tokio::time::sleep(ais::backoff(attempt, jitter)).await;
        attempt += 1;
    }
}
#[derive(Default)]
struct QuoteRuntime {
    book: quotes::Book,
    symbols: Vec<String>,
    status: String,
    error: String,
    last_message: i64,
    session: u64,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}
/// Sets the symbols to stream. One connection is kept open and its
/// subscriptions follow the list, since Finnhub allows one connection per key.
#[tauri::command]
fn quotes_start(b: tauri::State<Backend>, symbols: Vec<String>) -> Result<(), String> {
    let symbols = quotes::symbols(&symbols)?;
    let key = {
        let saved = b.saved_keys.lock().map_err(|_| "Key store unavailable")?;
        providers::resolve(&b.env_keys, &saved, "finnhub").0.to_string()
    };
    if key.is_empty() {
        return Err("Add a Finnhub key in Settings → Data sources for real-time prices.".into());
    }
    let mut rt = b.quotes.lock().map_err(|_| "Price stream unavailable")?;
    rt.book.quotes.retain(|s, _| symbols.contains(s));
    rt.symbols = symbols;
    // A running stream picks up the new list within a second.
    if rt.task.is_some() && rt.status != "error" {
        return Ok(());
    }
    if let Some(t) = rt.task.take() {
        t.abort();
    }
    rt.session += 1;
    let session = rt.session;
    rt.status = "connecting".into();
    rt.error.clear();
    let shared = b.quotes.clone();
    rt.task = Some(tauri::async_runtime::spawn(run_quotes(shared, session, key)));
    Ok(())
}
#[tauri::command]
fn quotes_stop(b: tauri::State<Backend>) -> Result<(), String> {
    let mut rt = b.quotes.lock().map_err(|_| "Price stream unavailable")?;
    if let Some(t) = rt.task.take() {
        t.abort();
    }
    rt.session += 1;
    rt.symbols.clear();
    rt.status = "stopped".into();
    rt.error.clear();
    Ok(())
}
#[tauri::command]
fn quotes_snapshot(b: tauri::State<Backend>) -> Result<Value, String> {
    let rt = b.quotes.lock().map_err(|_| "Price stream unavailable")?;
    Ok(json!({"status":rt.status,"error":rt.error,"lastMessage":rt.last_message,"symbols":rt.symbols,"quotes":rt.book.quotes}))
}
async fn run_quotes(shared: std::sync::Arc<Mutex<QuoteRuntime>>, session: u64, key: String) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{Error as WsError, Message};
    let update = |f: &mut dyn FnMut(&mut QuoteRuntime)| {
        if let Ok(mut rt) = shared.lock() {
            if rt.session == session {
                f(&mut rt);
            }
        }
    };
    // The current symbol list, or None once this stream has been replaced.
    let wanted = || shared.lock().ok().filter(|rt| rt.session == session).map(|rt| rt.symbols.clone());
    let mut attempt = 0u32;
    loop {
        match tokio_tungstenite::connect_async(quotes::url(&key)).await {
            Ok((mut ws, _)) => {
                update(&mut |rt| {
                    rt.status = "subscribed".into();
                    rt.error.clear();
                });
                let mut subscribed: Vec<String> = Vec::new();
                loop {
                    let Some(list) = wanted() else { return };
                    let mut sent = true;
                    for s in list.iter().filter(|s| !subscribed.contains(s)) {
                        sent &= ws.send(Message::text(quotes::subscribe(s))).await.is_ok();
                    }
                    for s in subscribed.iter().filter(|s| !list.contains(s)) {
                        sent &= ws.send(Message::text(quotes::unsubscribe(s))).await.is_ok();
                    }
                    if !sent {
                        break;
                    }
                    subscribed = list;
                    let frame = match tokio::time::timeout(std::time::Duration::from_secs(1), ws.next()).await {
                        Err(_) => continue, // nothing yet; re-check subscriptions
                        Ok(Some(Ok(f))) => f,
                        Ok(_) => break,
                    };
                    let bytes = match &frame {
                        Message::Text(t) => t.as_bytes().to_vec(),
                        Message::Binary(b) => b.to_vec(),
                        Message::Close(_) => break,
                        _ => continue,
                    };
                    let Ok(msg) = serde_json::from_slice::<Value>(&bytes) else { continue };
                    attempt = 0;
                    let t = now();
                    update(&mut |rt| match rt.book.apply(&msg, &subscribed) {
                        Ok(n) => {
                            if n > 0 {
                                rt.last_message = t;
                            }
                            rt.status = "live".into();
                            rt.error.clear();
                        }
                        Err(e) => rt.error = format!("Finnhub: {}", e.replace(&key, "***")),
                    });
                }
            }
            Err(WsError::Http(r)) => {
                let (text, retry) = quotes::handshake_error(r.status().as_u16());
                update(&mut |rt| {
                    rt.error = text.clone();
                    if !retry {
                        rt.status = "error".into();
                    }
                });
                if !retry {
                    return; // A rejected key won't start working by retrying.
                }
            }
            Err(e) => {
                let detail: String = e.to_string().replace(&key, "***").chars().take(120).collect();
                update(&mut |rt| rt.error = format!("Could not reach Finnhub ({detail}). Retrying…"));
            }
        }
        update(&mut |rt| rt.status = "reconnecting".into());
        let jitter = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_millis() as u64;
        tokio::time::sleep(ais::backoff(attempt, jitter)).await;
        attempt += 1;
    }
}
fn main() {
    tauri::Builder::default().plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init()).setup(|app|{let path=app.path().app_data_dir()?;std::fs::create_dir_all(&path)?;let db=Connection::open(path.join("market-lens.sqlite"))?;db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS cache(id TEXT PRIMARY KEY,body TEXT NOT NULL,stamp INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS requests(provider TEXT NOT NULL,stamp INTEGER NOT NULL);DELETE FROM cache WHERE id LIKE 'portwatch:%';")?;app.manage(Backend{db:Mutex::new(db),gate:tokio::sync::Mutex::new(()),sec_gate:tokio::sync::Mutex::new(()),env_keys:Credentials::from_env(),saved_keys:Mutex::new(Credentials::load(&path.join("credentials.json"))),key_path:path.join("credentials.json"),ais:Default::default(),quotes:Default::default(),http:reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).build()?,bulk:reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(20)).read_timeout(std::time::Duration::from_secs(60)).timeout(std::time::Duration::from_secs(1800)).redirect(reqwest::redirect::Policy::none()).build()?,refdb:std::sync::Arc::new(Mutex::new(open_reference(&path.join("reference.sqlite"))?)),ref_path:path.join("reference.sqlite"),jobs:Default::default()});Ok(())}).invoke_handler(tauri::generate_handler![load_state,save_state,key_status,set_keys,clear_key,fetch_data,fetch_sec,paper_trade,export_file,ais_start,ais_stop,ais_snapshot,quotes_start,quotes_stop,quotes_snapshot,holdings_status,holdings_update,holders,holder_portfolio,holders_find,universe_status,universe_refresh,universe_search,universe_browse,universe_facets,universe_get]).run(tauri::generate_context!()).expect("Could not launch Market Lens");
}
