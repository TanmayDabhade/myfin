//! Aperture Analyst on the desktop: downloads the llama.cpp server and the
//! Gemma 4 model (checksum-verified), runs the server on 127.0.0.1 behind a
//! per-session key, streams replies to the window, and gives the analyst its
//! two internet tools: a news search and a reader for public web pages.
use crate::analyst::{self, Download, Reply};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Emitter;
use tokio::io::AsyncWriteExt;

/// Stop the server after this long without a question, to give back memory.
const IDLE: Duration = Duration::from_secs(15 * 60);

#[derive(Default, Clone, serde::Serialize)]
pub struct Progress {
    pub running: bool,
    pub stage: String,
    pub done: u64,
    pub total: u64,
    pub error: String,
}

pub struct Server {
    child: tokio::process::Child,
    port: u16,
    key: String,
}

#[derive(Default)]
pub struct Host {
    pub progress: Mutex<Progress>,
    pub server: tokio::sync::Mutex<Option<Server>>,
    pub last_used: Mutex<Option<Instant>>,
    /// Bumped by analyst_cancel; a reply in flight stops when it changes.
    pub cancel: AtomicU64,
}

pub fn dir(data: &Path) -> PathBuf {
    data.join("analyst")
}
fn model_path(data: &Path) -> PathBuf {
    dir(data).join(analyst::MODEL_FILE)
}
fn runtime_dir(data: &Path) -> PathBuf {
    dir(data).join(format!("llama-{}", analyst::LLAMA_BUILD))
}
fn exe_name() -> &'static str {
    if cfg!(windows) { "llama-server.exe" } else { "llama-server" }
}
/// The unpacked server binary, wherever the archive put it.
fn server_exe(data: &Path) -> Option<PathBuf> {
    fn find(d: &Path, depth: u8) -> Option<PathBuf> {
        let direct = d.join(exe_name());
        if direct.is_file() {
            return Some(direct);
        }
        if depth == 0 {
            return None;
        }
        std::fs::read_dir(d).ok()?.flatten().filter(|e| e.path().is_dir()).find_map(|e| find(&e.path(), depth - 1))
    }
    find(&runtime_dir(data), 2)
}
fn runtime() -> Option<Download> {
    analyst::runtime_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn status(host: &Host, data: &Path, running: bool) -> Value {
    let model = analyst::model();
    let has_model = std::fs::metadata(model_path(data)).map(|m| m.len() == model.size).unwrap_or(false);
    let has_runtime = server_exe(data).is_some();
    let rt = runtime();
    let need = (if has_model { 0 } else { model.size }) + (if has_runtime { 0 } else { rt.as_ref().map_or(0, |r| r.size) });
    json!({
        "supported": rt.is_some(),
        "installed": has_model && has_runtime,
        "model": { "name": "Gemma 4 E4B", "file": analyst::MODEL_FILE, "bytes": model.size, "license": "Apache 2.0" },
        "runtime": { "name": format!("llama.cpp {}", analyst::LLAMA_BUILD), "license": "MIT" },
        "downloadBytes": need,
        "gpu": gpu(),
        "running": running,
        "job": serde_json::to_value(host.progress.lock().map(|p| p.clone()).unwrap_or_default()).unwrap_or_default(),
    })
}
fn gpu() -> bool {
    cfg!(target_os = "macos") && std::env::consts::ARCH == "aarch64"
}

fn set(host: &Host, f: impl FnOnce(&mut Progress)) {
    if let Ok(mut p) = host.progress.lock() {
        f(&mut p);
    }
}

/// Downloads `d` to `dest`, resuming a partial file, and checks its SHA-256.
async fn fetch(host: &Host, client: &reqwest::Client, d: &Download, dest: &Path, stage: &str) -> Result<(), String> {
    let part = dest.with_extension("part");
    let mut hasher = Sha256::new();
    let mut have = 0u64;
    // Resume: hash what is already there, a piece at a time.
    if let Ok(mut f) = tokio::fs::File::open(&part).await {
        if f.metadata().await.map(|m| m.len() < d.size).unwrap_or(false) {
            use tokio::io::AsyncReadExt;
            let mut piece = vec![0u8; 8 << 20];
            loop {
                let n = f.read(&mut piece).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hasher.update(&piece[..n]);
                have += n as u64;
            }
        }
    }
    let mut req = client.get(&d.url);
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let mut resp = req.send().await.map_err(|_| "Could not reach the download server. Check your internet connection.".to_string())?;
    let status = resp.status().as_u16();
    if have > 0 && status == 200 {
        // The server ignored the range: start over.
        hasher = Sha256::new();
        have = 0;
    } else if status != 200 && status != 206 {
        return Err(format!("Download failed (HTTP {status})."));
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(have > 0)
        .truncate(have == 0)
        .open(&part)
        .await
        .map_err(|e| e.to_string())?;
    set(host, |p| {
        p.stage = stage.into();
        p.total = d.size;
        p.done = have;
    });
    while let Some(chunk) = resp.chunk().await.map_err(|_| "The download was interrupted. Start it again to resume.".to_string())? {
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        have += chunk.len() as u64;
        if have > d.size + 1024 {
            return Err("The download is larger than expected.".into());
        }
        set(host, |p| p.done = have);
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    let digest = format!("{:x}", hasher.finalize());
    if digest != d.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("The downloaded file didn't match its published checksum, so it was deleted. Try again.".into());
    }
    tokio::fs::rename(&part, dest).await.map_err(|e| e.to_string())
}

/// The client for the engine and model downloads.
pub fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::custom(|a| if analyst::follow_download(a.url(), a.previous().len()) { a.follow() } else { a.error("Unexpected download redirect") }))
        .build()
        .map_err(|e| e.to_string())
}

/// Downloads and unpacks whatever is missing.
pub async fn install(host: Arc<Host>, data: PathBuf) {
    let result: Result<(), String> = async {
        let client = download_client()?;
        let rt = runtime().ok_or("Aperture Analyst isn't available for this computer yet.")?;
        tokio::fs::create_dir_all(dir(&data)).await.map_err(|e| e.to_string())?;
        if server_exe(&data).is_none() {
            let name = rt.url.rsplit('/').next().unwrap_or("runtime");
            let archive = dir(&data).join(name);
            fetch(&host, &client, &rt, &archive, "Downloading the AI engine (llama.cpp)…").await?;
            set(&host, |p| p.stage = "Unpacking the AI engine…".into());
            let out = runtime_dir(&data);
            let _ = tokio::fs::remove_dir_all(&out).await;
            tokio::fs::create_dir_all(&out).await.map_err(|e| e.to_string())?;
            // The system tar handles .tar.gz (with symlinks) and, on Windows, .zip.
            let ok = tokio::process::Command::new("tar")
                .arg("-xf")
                .arg(&archive)
                .arg("-C")
                .arg(&out)
                .status()
                .await
                .map_err(|e| format!("Could not unpack the AI engine: {e}"))?
                .success();
            let _ = tokio::fs::remove_file(&archive).await;
            if !ok || server_exe(&data).is_none() {
                return Err("Could not unpack the AI engine.".into());
            }
        }
        let model = analyst::model();
        let path = model_path(&data);
        if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) != model.size {
            fetch(&host, &client, &model, &path, "Downloading Gemma 4 E4B (about 5 GB)…").await?;
        }
        Ok(())
    }
    .await;
    set(&host, |p| {
        p.running = false;
        match result {
            Ok(()) => {
                p.stage = "Ready".into();
                p.error.clear();
            }
            Err(e) => p.error = e,
        }
    });
}

pub async fn remove(host: &Host, data: &Path) -> Result<(), String> {
    stop(host).await;
    match tokio::fs::remove_dir_all(dir(data)).await {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

pub async fn stop(host: &Host) {
    if let Some(mut s) = host.server.lock().await.take() {
        let _ = s.child.kill().await;
    }
}

fn session_key() -> String {
    let mut h = Sha256::new();
    h.update(format!("{:?}{}{:p}", std::time::SystemTime::now(), std::process::id(), &h).as_bytes());
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let mut b = [0u8; 32];
        if std::io::Read::read_exact(&mut f, &mut b).is_ok() {
            h.update(b);
        }
    }
    format!("{:x}", h.finalize())
}

/// Starts the server if needed and waits until the model has loaded.
async fn ensure(host: &Host, client: &reqwest::Client, data: &Path) -> Result<(u16, String), String> {
    let mut guard = host.server.lock().await;
    if let Some(s) = guard.as_mut() {
        if s.child.try_wait().ok().flatten().is_none() {
            return Ok((s.port, s.key.clone()));
        }
        *guard = None;
    }
    let exe = server_exe(data).ok_or("Aperture Analyst isn't installed. Download it first.")?;
    let model = model_path(data);
    if !model.is_file() {
        return Err("The Gemma 4 model isn't downloaded yet.".into());
    }
    let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
    let key = session_key();
    let mut cmd = tokio::process::Command::new(&exe);
    cmd.args(analyst::server_args(&model.to_string_lossy(), port, &key, gpu()))
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the AI engine: {e}"))?;
    let health = format!("http://127.0.0.1:{port}/health");
    let started = Instant::now();
    loop {
        if let Some(code) = child.try_wait().ok().flatten() {
            return Err(format!("The AI engine stopped while loading the model ({code}). The computer may not have enough free memory (about 6 GB)."));
        }
        if let Ok(r) = client.get(&health).timeout(Duration::from_secs(2)).send().await {
            if r.status().is_success() {
                break;
            }
        }
        if started.elapsed() > Duration::from_secs(240) {
            let _ = child.kill().await;
            return Err("The model took too long to load.".into());
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    *guard = Some(Server { child, port, key: key.clone() });
    Ok((port, key))
}

/// One model turn. Text is streamed to the window as `analyst-delta`
/// events ({ id, text }); the finished message (text and tool calls) is
/// returned.
pub async fn chat(app: &tauri::AppHandle, host: &Host, client: &reqwest::Client, data: &Path, id: String, messages: Value, tools: Value) -> Result<Reply, String> {
    let _ = app.emit("analyst-delta", json!({ "id": id, "stage": "loading" }));
    let (port, key) = ensure(host, client, data).await?;
    if let Ok(mut t) = host.last_used.lock() {
        *t = Some(Instant::now());
    }
    let generation = host.cancel.load(Ordering::SeqCst);
    let mut body = json!({
        "messages": messages,
        "stream": true,
        "temperature": 0.2,
        "top_p": 0.9,
        "max_tokens": 1200,
    });
    if tools.as_array().is_some_and(|t| !t.is_empty()) {
        body["tools"] = tools;
        body["parallel_tool_calls"] = json!(false);
    }
    let mut resp = client
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .bearer_auth(&key)
        .timeout(Duration::from_secs(600))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("The AI engine didn't answer: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text: String = resp.text().await.unwrap_or_default().chars().take(300).collect();
        return Err(format!("The AI engine returned HTTP {status}. {text}"));
    }
    let _ = app.emit("analyst-delta", json!({ "id": id, "stage": "writing" }));
    let mut reply = Reply::default();
    let mut buf = String::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if host.cancel.load(Ordering::SeqCst) != generation {
            reply.finish = "cancelled".into();
            break;
        }
        buf.push_str(&String::from_utf8_lossy(&chunk));
        let (events, done) = analyst::sse_events(&mut buf);
        for e in &events {
            if let Some(text) = reply.apply(e) {
                let _ = app.emit("analyst-delta", json!({ "id": id, "text": text }));
            }
        }
        if done {
            break;
        }
    }
    if let Ok(mut t) = host.last_used.lock() {
        *t = Some(Instant::now());
    }
    Ok(reply)
}

/// Stops the server once it has been idle for a while.
pub async fn idle_watch(host: Arc<Host>) {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let idle = host.last_used.lock().ok().and_then(|t| *t).is_some_and(|t| t.elapsed() > IDLE);
        if idle && host.server.lock().await.is_some() {
            stop(&host).await;
            if let Ok(mut t) = host.last_used.lock() {
                *t = None;
            }
        }
    }
}

const AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

pub async fn news(client: &reqwest::Client, query: &str) -> Result<Vec<analyst::NewsItem>, String> {
    if query.trim().is_empty() {
        return Err("Empty search".into());
    }
    let resp = client
        .get(analyst::news_url(query))
        .header("User-Agent", AGENT)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "News search is unreachable right now.".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("News search returned HTTP {}", resp.status().as_u16()));
    }
    let xml = resp.text().await.map_err(|e| e.to_string())?;
    Ok(analyst::parse_rss(&xml, 8))
}

/// Reads a public web page as plain text. Each hop of a redirect is checked,
/// and the connection is pinned to an address that was checked, so a page
/// can't steer the analyst onto this computer or the local network.
pub async fn read(url: &str) -> Result<Value, String> {
    let mut current = analyst::public_url(url)?;
    for _ in 0..4 {
        let host = current.host_str().ok_or("No host")?.to_string();
        let port = current.port_or_known_default().unwrap_or(443);
        let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port)).await.map_err(|_| "That site's address couldn't be found.".to_string())?.collect();
        let addr = *addrs.first().ok_or("That site's address couldn't be found.")?;
        if addrs.iter().any(|a| analyst::private_ip(&a.ip())) {
            return Err("Local addresses can't be read".into());
        }
        // No proxy: a proxy would look the name up again itself and skip
        // the address check above.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, addr)
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        let mut resp = client
            .get(current.clone())
            .header("User-Agent", AGENT)
            .header("Accept", "text/html,text/plain;q=0.9")
            .send()
            .await
            .map_err(|_| "That page couldn't be reached.".to_string())?;
        if resp.status().is_redirection() {
            let next = resp.headers().get("location").and_then(|l| l.to_str().ok()).ok_or("Bad redirect")?;
            current = analyst::public_url(current.join(next).map_err(|_| "Bad redirect")?.as_str())?;
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("The page returned HTTP {} (it may need a subscription).", resp.status().as_u16()));
        }
        let kind = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        if !(kind.is_empty() || kind.contains("text/html") || kind.contains("text/plain") || kind.contains("xhtml")) {
            return Err("Only web pages can be read, not files.".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            body.extend_from_slice(&chunk);
            if body.len() > 3_000_000 {
                break;
            }
        }
        let html = String::from_utf8_lossy(&body);
        let (title, text) = analyst::readable_text(&html, 12_000);
        if text.len() < 200 {
            return Err("The page had no readable article text (it may need JavaScript or a subscription).".into());
        }
        return Ok(json!({ "url": current.as_str(), "title": title, "text": text }));
    }
    Err("Too many redirects".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real download path against GitHub: redirect, exact size and
    /// checksum. Downloads only; nothing is run.
    #[test]
    #[ignore = "Downloads the llama.cpp engine (12–25 MB); requires network"]
    fn live_runtime_download() {
        let rt = runtime().expect("supported platform");
        let dir = std::env::temp_dir().join(format!("aperture-analyst-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("runtime.archive");
        let host = Host::default();
        let r = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let out = r.block_on(async { fetch(&host, &download_client().unwrap(), &rt, &dest, "test").await });
        let len = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        let _ = std::fs::remove_dir_all(&dir);
        out.unwrap();
        assert_eq!(len, rt.size);
    }
}
