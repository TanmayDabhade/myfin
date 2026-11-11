//! Aperture Analyst on the desktop: the user's choice of where it runs, the
//! llama.cpp server and the Gemma 4 model (checksum-verified) for running on
//! this computer, the server on 127.0.0.1 behind a per-session key, replies
//! streamed to the window from whichever model was chosen, and the analyst's
//! two internet tools: a news search and a reader for public web pages.
use crate::analyst::{self, Config, Download, Reply};
use crate::analyst_online as online;
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
    model: PathBuf,
}

#[derive(Default)]
pub struct Host {
    pub progress: Mutex<Progress>,
    pub server: tokio::sync::Mutex<Option<Server>>,
    pub last_used: Mutex<Option<Instant>>,
    /// Bumped by analyst_cancel; a reply in flight stops when it changes.
    pub cancel: AtomicU64,
    /// Bumped by each sign-in attempt; an older one stops waiting.
    pub sign_in: AtomicU64,
}

// ---- Settings ----------------------------------------------------------------
// Outside the download folder, so removing the downloads keeps them.
fn config_path(data: &Path) -> PathBuf {
    data.join("analyst.json")
}
fn keys_path(data: &Path) -> PathBuf {
    data.join("analyst-keys.json")
}
pub fn load_config(data: &Path) -> Config {
    std::fs::read_to_string(config_path(data)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
pub fn save_config(data: &Path, c: &Config) -> Result<(), String> {
    write_private(&config_path(data), &serde_json::to_string_pretty(c).map_err(|e| e.to_string())?)
}
pub fn load_keys(data: &Path) -> analyst::Keys {
    std::fs::read_to_string(keys_path(data)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
pub fn save_keys(data: &Path, k: &analyst::Keys) -> Result<(), String> {
    write_private(&keys_path(data), &serde_json::to_string(k).map_err(|e| e.to_string())?)
}
/// Writes a file readable only by the current OS user.
fn write_private(path: &Path, body: &str) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(&tmp).map_err(|_| "Could not save the analyst settings".to_string())?;
    f.write_all(body.as_bytes()).map_err(|_| "Could not save the analyst settings".to_string())?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|_| "Could not save the analyst settings".to_string())
}

/// Checks that a file is a GGUF model (it starts with the bytes "GGUF").
pub fn gguf_ok(path: &Path) -> Result<u64, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|_| "That file can't be opened.".to_string())?;
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).map_err(|_| "That file is empty.".to_string())?;
    if &magic != b"GGUF" {
        return Err("That isn't a GGUF model file. Choose a .gguf file, e.g. one downloaded from Hugging Face.".into());
    }
    Ok(f.metadata().map(|m| m.len()).unwrap_or(0))
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
    let cfg = load_config(data);
    let keys = load_keys(data);
    let model = analyst::model();
    let has_gemma = std::fs::metadata(model_path(data)).map(|m| m.len() == model.size).unwrap_or(false);
    let has_runtime = server_exe(data).is_some();
    let rt = runtime();
    let gguf = (!cfg.gguf.is_empty()).then(|| {
        let p = Path::new(&cfg.gguf);
        json!({ "path": cfg.gguf, "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), "bytes": std::fs::metadata(p).map(|m| m.len()).unwrap_or(0), "found": p.is_file() })
    });
    let runtime_need = if has_runtime { 0 } else { rt.as_ref().map_or(0, |r| r.size) };
    let (ready, need) = match cfg.choice() {
        "gemma" => (rt.is_some() && has_gemma && has_runtime, runtime_need + if has_gemma { 0 } else { model.size }),
        "gguf" => (rt.is_some() && has_runtime && Path::new(&cfg.gguf).is_file(), runtime_need),
        "server" => (analyst::server_url(&cfg.server_url).is_ok(), 0),
        _ => (analyst::provider(&cfg.provider).is_some_and(|p| keys.get(p.id).is_some_and(|k| !k.is_empty())) && !cfg.model.is_empty(), 0),
    };
    let providers: Vec<Value> = analyst::PROVIDERS
        .iter()
        .map(|p| json!({ "id": p.id, "name": p.name, "signIn": p.sign_in, "keyUrl": p.key_url, "suggested": p.suggested, "connected": keys.get(p.id).is_some_and(|k| !k.is_empty()) }))
        .collect();
    let online_name = analyst::provider(&cfg.provider).map(|p| p.name).unwrap_or("");
    json!({
        "supported": rt.is_some(),
        "choice": cfg.choice(),
        "local": cfg.local(),
        "ready": ready,
        "installed": ready,
        "model": { "name": "Gemma 4 E4B", "file": analyst::MODEL_FILE, "bytes": model.size, "license": "Apache 2.0", "installed": has_gemma },
        "runtime": { "name": format!("llama.cpp {}", analyst::LLAMA_BUILD), "license": "MIT", "installed": has_runtime },
        "gguf": gguf,
        "server": { "url": cfg.server_url, "model": cfg.server_model, "hasKey": keys.get("server").is_some_and(|k| !k.is_empty()) },
        "online": { "provider": cfg.provider, "name": online_name, "model": cfg.model, "providers": providers },
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
        if load_config(&data).choice() == "gemma" && std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) != model.size {
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

pub fn session_key() -> String {
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
async fn ensure(host: &Host, client: &reqwest::Client, data: &Path, model: PathBuf) -> Result<(u16, String), String> {
    let mut guard = host.server.lock().await;
    if let Some(s) = guard.as_mut() {
        if s.model == model && s.child.try_wait().ok().flatten().is_none() {
            return Ok((s.port, s.key.clone()));
        }
        // A different model was chosen (or the server stopped): start again.
        let _ = s.child.kill().await;
        *guard = None;
    }
    let exe = server_exe(data).ok_or("The AI engine isn't downloaded yet. Download it in the analyst's setup first.")?;
    if !model.is_file() {
        return Err(if model == model_path(data) { "The Gemma 4 model isn't downloaded yet.".to_string() } else { format!("The model file {} can't be found. Choose it again.", model.display()) });
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
            return Err(format!("The AI engine stopped while loading the model ({code}). The computer may not have enough free memory for it, or the file isn't a model llama.cpp can run."));
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
    *guard = Some(Server { child, port, key: key.clone(), model });
    Ok((port, key))
}

/// One model turn on whichever model the user chose. Text is streamed to
/// the window as `analyst-delta` events ({ id, text }); the finished message
/// (text and tool calls) is returned. `allow_tools` false asks for an answer.
pub async fn chat(app: &tauri::AppHandle, host: &Host, local: &reqwest::Client, data: &Path, id: String, messages: Value, tools: Value, allow_tools: bool) -> Result<Reply, String> {
    let cfg = load_config(data);
    let model = match cfg.choice() {
        "gemma" => model_path(data),
        "gguf" => PathBuf::from(&cfg.gguf),
        _ => {
            stop(host).await;
            return online::chat(app, host, data, &cfg, &id, &messages, &tools, allow_tools).await;
        }
    };
    let _ = app.emit("analyst-delta", json!({ "id": id, "stage": "loading" }));
    let (port, key) = ensure(host, local, data, model).await?;
    let body = analyst::openai_body("local", "", &messages, &tools, allow_tools);
    let req = local.post(format!("http://127.0.0.1:{port}/v1/chat/completions")).bearer_auth(&key).timeout(Duration::from_secs(600)).json(&body);
    stream(app, host, &id, req, "The AI engine", false).await
}

/// Sends a streamed request and assembles the reply (OpenAI or Anthropic
/// format), stopping early when the user presses Stop.
pub async fn stream(app: &tauri::AppHandle, host: &Host, id: &str, req: reqwest::RequestBuilder, who: &str, anthropic: bool) -> Result<Reply, String> {
    if let Ok(mut t) = host.last_used.lock() {
        *t = Some(Instant::now());
    }
    let generation = host.cancel.load(Ordering::SeqCst);
    let mut resp = req.send().await.map_err(|e| if e.is_connect() || e.is_timeout() { format!("{who} couldn't be reached. Check that it is running and your connection works.") } else { format!("{who} didn't answer: {e}") })?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(online::http_error(who, status, &text));
    }
    let _ = app.emit("analyst-delta", json!({ "id": id, "stage": "writing" }));
    let mut reply = Reply::default();
    let mut claude = analyst::AnthropicStream::default();
    let mut buf = String::new();
    let mut cancelled = false;
    while let Some(chunk) = resp.chunk().await.map_err(|_| format!("The connection to {who} dropped. Ask again."))? {
        if host.cancel.load(Ordering::SeqCst) != generation {
            cancelled = true;
            break;
        }
        buf.push_str(&String::from_utf8_lossy(&chunk));
        let (events, done) = analyst::sse_events(&mut buf);
        for e in &events {
            if let Some(err) = e.get("error").filter(|_| !anthropic) {
                return Err(format!("{who}: {}", err["message"].as_str().unwrap_or("the model returned an error")));
            }
            let text = if anthropic { claude.apply(e) } else { reply.apply(e) };
            if let Some(text) = text {
                let _ = app.emit("analyst-delta", json!({ "id": id, "text": text }));
            }
        }
        if done {
            break;
        }
    }
    if anthropic {
        if !claude.error.is_empty() {
            return Err(format!("{who}: {}", claude.error));
        }
        reply = claude.finish();
    }
    if cancelled {
        reply.finish = "cancelled".into();
    }
    if reply.finish == "refusal" && reply.content.trim().is_empty() {
        return Err(format!("{who}'s model declined to answer this question. Try rephrasing it."));
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
