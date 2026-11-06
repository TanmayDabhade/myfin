#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ledger;
mod maritime;
mod providers;
mod sec;
mod ais;
mod quotes;
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
async fn fetch_maritime(b:tauri::State<'_,Backend>,id:String)->Result<Value,String>{
 maritime::query(&id)?;
 let _gate=b.gate.lock().await;let stamp=now();let key=format!("portwatch:{id}");
 let cached:Option<(String,i64)>={let db=b.db.lock().map_err(|_|"Database unavailable")?;db.query_row("SELECT body,stamp FROM cache WHERE id=?1",[&key],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?};
 if let Some((body,at))=&cached{if stamp-at<21600{return Ok(json!({"data":serde_json::from_str::<Value>(body).map_err(|e|e.to_string())?,"fetchedAt":at,"cached":true,"provider":"IMF PortWatch"}))}}
 match maritime::fetch(&b.http,&id).await{Ok(data)=>{b.db.lock().map_err(|_|"Database unavailable")?.execute("INSERT INTO cache(id,body,stamp) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body,stamp=excluded.stamp",params![key,data.to_string(),stamp]).map_err(|e|e.to_string())?;Ok(json!({"data":data,"fetchedAt":stamp,"cached":false,"provider":"IMF PortWatch"}))},Err(error)=>{if let Some((body,at))=cached{Ok(json!({"data":serde_json::from_str::<Value>(&body).map_err(|e|e.to_string())?,"fetchedAt":at,"stale":true,"warning":error,"provider":"IMF PortWatch"}))}else{Err(error)}}}
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
        .plugin(tauri_plugin_dialog::init()).setup(|app|{let path=app.path().app_data_dir()?;std::fs::create_dir_all(&path)?;let db=Connection::open(path.join("market-lens.sqlite"))?;db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS cache(id TEXT PRIMARY KEY,body TEXT NOT NULL,stamp INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS requests(provider TEXT NOT NULL,stamp INTEGER NOT NULL);")?;app.manage(Backend{db:Mutex::new(db),gate:tokio::sync::Mutex::new(()),sec_gate:tokio::sync::Mutex::new(()),env_keys:Credentials::from_env(),saved_keys:Mutex::new(Credentials::load(&path.join("credentials.json"))),key_path:path.join("credentials.json"),ais:Default::default(),quotes:Default::default(),http:reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).build()?});Ok(())}).invoke_handler(tauri::generate_handler![load_state,save_state,key_status,set_keys,clear_key,fetch_data,fetch_sec,paper_trade,export_file,fetch_maritime,ais_start,ais_stop,ais_snapshot,quotes_start,quotes_stop,quotes_snapshot]).run(tauri::generate_context!()).expect("Could not launch Market Lens");
}
