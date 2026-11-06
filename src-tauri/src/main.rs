#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ledger;
mod maritime;
mod providers;
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
    env_keys: Credentials,
    saved_keys: Mutex<Credentials>,
    key_path: std::path::PathBuf,
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
fn main() {
    tauri::Builder::default().plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init()).setup(|app|{let path=app.path().app_data_dir()?;std::fs::create_dir_all(&path)?;let db=Connection::open(path.join("market-lens.sqlite"))?;db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS cache(id TEXT PRIMARY KEY,body TEXT NOT NULL,stamp INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS requests(provider TEXT NOT NULL,stamp INTEGER NOT NULL);")?;app.manage(Backend{db:Mutex::new(db),gate:tokio::sync::Mutex::new(()),env_keys:Credentials::from_env(),saved_keys:Mutex::new(Credentials::load(&path.join("credentials.json"))),key_path:path.join("credentials.json"),http:reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).build()?});Ok(())}).invoke_handler(tauri::generate_handler![load_state,save_state,key_status,set_keys,clear_key,fetch_data,paper_trade,export_file,fetch_maritime]).run(tauri::generate_context!()).expect("Could not launch Market Lens");
}
