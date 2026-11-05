#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ledger;
mod maritime;
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
    keys: Mutex<(String, String)>,
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
fn set_keys(b: tauri::State<Backend>, alpha: String, fred: String) -> Result<(), String> {
    *b.keys.lock().map_err(|_| "Key store unavailable")? = (alpha, fred);
    Ok(())
}
#[tauri::command]
async fn fetch_data(
    b: tauri::State<'_, Backend>,
    provider: String,
    kind: String,
    symbol: String,
) -> Result<Value, String> {
    let _guard = b.gate.lock().await;
    if symbol.len() > 100
        || !symbol
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_^".contains(c))
    {
        return Err("Invalid identifier".into());
    }
    let valid = [
        "TIME_SERIES_DAILY",
        "OVERVIEW",
        "INCOME_STATEMENT",
        "BALANCE_SHEET",
        "CASH_FLOW",
        "NEWS_SENTIMENT",
        "EARNINGS",
        "EARNINGS_CALENDAR",
    ];
    if provider != "fred" && (provider != "alpha" || !valid.contains(&kind.as_str())) {
        return Err("Unsupported dataset".into());
    }
    let cache_key = format!("{provider}:{kind}:{symbol}");
    let ts = now();
    let cached: Option<(String, i64)> = {
        let db = b.db.lock().map_err(|_| "Database unavailable")?;
        db.query_row(
            "SELECT body,stamp FROM cache WHERE id=?1",
            [&cache_key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
    };
    if let Some((body, stamp)) = &cached {
        if ts - stamp < 21600 {
            return Ok(
                json!({"data":serde_json::from_str::<Value>(body).map_err(|e|e.to_string())?,"fetchedAt":stamp,"cached":true,"provider":provider}),
            );
        }
    }
    let key = {
        let keys = b.keys.lock().map_err(|_| "Key store unavailable")?;
        if provider == "fred" {
            keys.1.clone()
        } else {
            keys.0.clone()
        }
    };
    if key.is_empty() {
        return Err("Add your free API key in Settings. Cached downloads remain available in the workspace.".into());
    }
    {
        let db = b.db.lock().map_err(|_| "Database unavailable")?;
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM requests WHERE provider=?1 AND stamp>?2",
                params![provider, ts - 86400],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let last: i64 = db
            .query_row(
                "SELECT COALESCE(MAX(stamp),0) FROM requests WHERE provider=?1",
                [&provider],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if provider == "alpha" && (count >= 25 || ts - last < 13) {
            return Err("Local Alpha Vantage budget: 25 requests per rolling day, at least 13 seconds apart. Use cached data or try later.".into());
        }
        db.execute(
            "INSERT INTO requests(provider,stamp) VALUES(?1,?2)",
            params![provider, ts],
        )
        .map_err(|e| e.to_string())?;
    }
    let request = if provider == "fred" {
        b.http
            .get("https://api.stlouisfed.org/fred/series/observations")
            .query(&[
                ("series_id", symbol.as_str()),
                ("api_key", key.as_str()),
                ("file_type", "json"),
                ("sort_order", "desc"),
                ("limit", "500"),
            ])
    } else {
        let mut q = vec![("function", kind.as_str()), ("apikey", key.as_str())];
        q.push((
            if kind == "NEWS_SENTIMENT" {
                "tickers"
            } else {
                "symbol"
            },
            symbol.as_str(),
        ));
        b.http.get("https://www.alphavantage.co/query").query(&q)
    };
    let result:Result<Value,String>=async{let resp=request.send().await.map_err(|_|"Provider connection failed".to_string())?;if !resp.status().is_success(){return Err(format!("Provider returned HTTP {}",resp.status().as_u16()))}let body=resp.text().await.map_err(|_|"Could not read provider response")?;let data=if kind=="EARNINGS_CALENDAR" && provider=="alpha"{json!({"csv":body})}else{serde_json::from_str::<Value>(&body).map_err(|_|"Provider returned an invalid response")?};for k in ["Error Message","Information","Note","error_message"]{if data.get(k).is_some(){return Err("Provider denied this request, reported a quota limit, or requires a different plan. Check your provider account.".into())}}Ok(data)}.await;
    match result {
        Ok(data) => {
            b.db.lock().map_err(|_|"Database unavailable")?.execute("INSERT INTO cache(id,body,stamp) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body,stamp=excluded.stamp",params![cache_key,data.to_string(),ts]).map_err(|e|e.to_string())?;
            Ok(json!({"data":data,"fetchedAt":ts,"cached":false,"provider":provider}))
        }
        Err(error) => {
            if let Some((body, stamp)) = cached {
                Ok(
                    json!({"data":serde_json::from_str::<Value>(&body).map_err(|e|e.to_string())?,"fetchedAt":stamp,"cached":true,"stale":true,"warning":error,"provider":provider}),
                )
            } else {
                Err(error)
            }
        }
    }
}
fn main() {
    tauri::Builder::default().plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init()).setup(|app|{let path=app.path().app_data_dir()?;std::fs::create_dir_all(&path)?;let db=Connection::open(path.join("market-lens.sqlite"))?;db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS cache(id TEXT PRIMARY KEY,body TEXT NOT NULL,stamp INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS requests(provider TEXT NOT NULL,stamp INTEGER NOT NULL);")?;app.manage(Backend{db:Mutex::new(db),gate:tokio::sync::Mutex::new(()),keys:Mutex::new((std::env::var("ALPHA_VANTAGE_API_KEY").unwrap_or_default(),std::env::var("FRED_API_KEY").unwrap_or_default())),http:reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).build()?});Ok(())}).invoke_handler(tauri::generate_handler![load_state,save_state,set_keys,fetch_data,paper_trade,export_file,fetch_maritime]).run(tauri::generate_context!()).expect("Could not launch Market Lens");
}
