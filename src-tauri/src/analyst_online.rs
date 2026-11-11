//! Aperture Analyst through an online account or a model server the user
//! runs: OpenRouter and Hugging Face sign-in in the browser, saved account
//! keys, the model list, and questions sent to OpenRouter, Hugging Face,
//! OpenAI, Anthropic, Google Gemini or an OpenAI-compatible server (Ollama,
//! LM Studio). Keys stay in the desktop process; the window only learns
//! whether an account is connected.
use crate::analyst::{self, Config, Provider, Reply, Style};
use crate::analyst_host::{self as host, Host};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::atomic::Ordering,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const ANTHROPIC_VERSION: &str = "2026-10-21";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

/// A readable message for a failed request, using the service's own error
/// text when it sends one.
pub fn http_error(who: &str, status: u16, body: &str) -> String {
    let detail: String = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or_else(|| v["error"].as_str()).or_else(|| v["message"].as_str()).map(String::from))
        .unwrap_or_else(|| body.trim().to_string())
        .chars()
        .take(300)
        .collect();
    match status {
        401 | 403 => format!("{who} didn't accept the saved sign-in. Connect the account again in the analyst's setup. ({detail})"),
        402 => format!("Your {who} account is out of credit. Add credit on {who}'s site, then ask again."),
        404 => format!("{who} doesn't offer the chosen model. Pick another model in the analyst's setup. ({detail})"),
        429 => format!("{who} is rate-limiting this account right now. Wait a minute and ask again. ({detail})"),
        _ => format!("{who} returned HTTP {status}. {detail}"),
    }
}

/// Adds the account's sign-in to a request for `p`.
fn authorize(req: reqwest::RequestBuilder, p: &Provider, key: &str) -> reqwest::RequestBuilder {
    match p.style {
        Style::Anthropic => req.header("x-api-key", key).header("anthropic-version", ANTHROPIC_VERSION),
        Style::OpenAi => {
            let req = req.bearer_auth(key);
            // OpenRouter shows the app's name on the user's activity page.
            if p.id == "openrouter" { req.header("X-Title", "Aperture") } else { req }
        }
    }
}

fn key_for(data: &Path, id: &str) -> String {
    host::load_keys(data).get(id).cloned().unwrap_or_default()
}

/// The key to send for account `id`. Hugging Face sign-ins last hours, not
/// forever, so a token about to expire is renewed first.
async fn access_key(data: &Path, id: &str) -> Result<String, String> {
    if id == "huggingface" {
        return hf_fresh_token(data).await;
    }
    Ok(key_for(data, id))
}

pub async fn chat(app: &tauri::AppHandle, host: &Host, data: &Path, cfg: &Config, id: &str, messages: &Value, tools: &Value, allow_tools: bool) -> Result<Reply, String> {
    let http = client()?;
    if cfg.choice() == "server" {
        let base = analyst::server_url(&cfg.server_url)?;
        let key = key_for(data, "server");
        let _ = app.emit("analyst-delta", json!({ "id": id, "stage": "waiting" }));
        let send = |body: &Value| {
            let mut req = http.post(format!("{}/chat/completions", base.as_str().trim_end_matches('/'))).json(body);
            if !key.is_empty() {
                req = req.bearer_auth(&key);
            }
            req
        };
        let body = analyst::openai_body("server", &cfg.server_model, messages, tools, allow_tools);
        // Some local models can't take tools: ask again without them.
        let probe = send(&body).send().await;
        if let Ok(r) = probe {
            if r.status().as_u16() == 400 && body.get("tools").is_some() {
                let text = r.text().await.unwrap_or_default();
                if text.to_ascii_lowercase().contains("tool") {
                    let mut plain = body.clone();
                    if let Some(o) = plain.as_object_mut() {
                        o.remove("tools");
                        o.remove("tool_choice");
                        o.remove("parallel_tool_calls");
                    }
                    return host::stream(app, host, id, send(&plain), "The model server", false).await;
                }
                return Err(http_error("The model server", 400, &text));
            }
        }
        return host::stream(app, host, id, send(&body), "The model server", false).await;
    }
    let p = analyst::provider(&cfg.provider).ok_or("Choose an online account in the analyst's setup.")?;
    let key = access_key(data, p.id).await?;
    if key.is_empty() {
        return Err(format!("{} isn't connected. Connect it in the analyst's setup.", p.name));
    }
    if cfg.model.is_empty() {
        return Err(format!("Choose a {} model in the analyst's setup.", p.name));
    }
    let _ = app.emit("analyst-delta", json!({ "id": id, "stage": "waiting" }));
    match p.style {
        Style::Anthropic => {
            let body = analyst::anthropic_body(&cfg.model, messages, tools, allow_tools);
            let mut req = authorize(http.post(format!("{}/messages", p.base)), p, &key).json(&body);
            if body.get("fallbacks").is_some() {
                req = req.header("anthropic-beta", FALLBACK_BETA);
            }
            host::stream(app, host, id, req, p.name, true).await
        }
        Style::OpenAi => {
            let body = analyst::openai_body(p.id, &cfg.model, messages, tools, allow_tools);
            let req = authorize(http.post(format!("{}/chat/completions", p.base)), p, &key).json(&body);
            host::stream(app, host, id, req, p.name, false).await
        }
    }
}

/// The models an account (or the model server) offers.
pub async fn models(data: &Path, target: &str) -> Result<Vec<String>, String> {
    let http = client()?;
    let (who, req) = if target == "server" {
        let cfg = host::load_config(data);
        let base = analyst::server_url(&cfg.server_url)?;
        let key = key_for(data, "server");
        let mut req = http.get(format!("{}/models", base.as_str().trim_end_matches('/'))).timeout(Duration::from_secs(15));
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
        ("The model server".to_string(), req)
    } else {
        let p = analyst::provider(target).ok_or("Unknown account")?;
        let key = access_key(data, p.id).await?;
        if key.is_empty() {
            return Err(format!("{} isn't connected.", p.name));
        }
        (p.name.to_string(), authorize(http.get(format!("{}/models?limit=1000", p.base)).timeout(Duration::from_secs(20)), p, &key))
    };
    let resp = req.send().await.map_err(|_| format!("{who} couldn't be reached."))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(http_error(&who, status, &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| format!("{who} sent a model list Aperture couldn't read."))?;
    Ok(analyst::model_ids(&v))
}

/// Saves a pasted key after checking it with the account's model list.
pub async fn set_key(data: &Path, id: &str, key: &str) -> Result<(), String> {
    let key = key.trim();
    if id != "server" && analyst::provider(id).is_none() {
        return Err("Unknown account".into());
    }
    if key.is_empty() || key.len() > 400 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That doesn't look like a key. Copy it again from the account's key page.".into());
    }
    let mut keys = host::load_keys(data);
    let old = keys.insert(id.to_string(), key.to_string());
    host::save_keys(data, &keys)?;
    if id != "server" {
        if let Err(e) = models(data, id).await {
            match old {
                Some(k) => keys.insert(id.to_string(), k),
                None => keys.remove(id),
            };
            host::save_keys(data, &keys)?;
            return Err(e);
        }
    }
    Ok(())
}

pub fn sign_out(data: &Path, id: &str) -> Result<(), String> {
    let mut keys = host::load_keys(data);
    keys.remove(id);
    // Hugging Face's renewal token goes too; Aperture's app registration
    // (HF_CLIENT) isn't a secret and is kept for the next login.
    keys.remove(&format!("{id}{HF_REFRESH}"));
    keys.remove(&format!("{id}{HF_EXPIRES}"));
    host::save_keys(data, &keys)
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The OpenRouter sign-in page for a PKCE challenge and callback port.
pub fn openrouter_auth_url(port: u16, challenge: &str, state: &str) -> String {
    let mut u = reqwest::Url::parse("https://openrouter.ai/auth").expect("static url");
    u.query_pairs_mut()
        .append_pair("callback_url", &format!("http://localhost:{port}/callback"))
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("key_label", "Aperture Analyst")
        .append_pair("state", state);
    u.to_string()
}

/// Reads the `code` from the browser's return to the callback, if this
/// request is it.
pub fn callback_code(request: &str, state: &str) -> Option<Result<String, String>> {
    let path = request.lines().next()?.split_whitespace().nth(1)?;
    let u = reqwest::Url::parse(&format!("http://localhost{path}")).ok()?;
    if u.path() != "/callback" {
        return None;
    }
    let get = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    Some(match (get("code"), get("state")) {
        (Some(code), Some(s)) if s == state && !code.is_empty() => Ok(code),
        (Some(_), _) => Err("The sign-in didn't match this request. Try again.".into()),
        _ => Err("Sign-in was cancelled.".into()),
    })
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Aperture</title><body style=\"font:16px -apple-system,system-ui,sans-serif;margin:15vh auto;max-width:28rem;text-align:center\"><h2>You're signed in</h2><p>You can close this tab and go back to Aperture.</p></body>";
const FAILED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Aperture</title><body style=\"font:16px -apple-system,system-ui,sans-serif;margin:15vh auto;max-width:28rem;text-align:center\"><h2>Sign-in didn't finish</h2><p>Go back to Aperture and try again.</p></body>";

/// Opens `url(port)` in the browser and waits for the account's sign-in
/// page to send the browser back to a one-time address on this computer.
/// Returns the `code` it brings.
async fn browser_code(app: &tauri::AppHandle, hostc: &Host, state: &str, listener: tokio::net::TcpListener, url: String) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let attempt = hostc.sign_in.fetch_add(1, Ordering::SeqCst) + 1;
    app.opener().open_url(url, None::<&str>).map_err(|e| format!("Couldn't open the browser: {e}"))?;
    let started = Instant::now();
    loop {
        if hostc.sign_in.load(Ordering::SeqCst) != attempt {
            return Err("Sign-in was restarted.".into());
        }
        if started.elapsed() > Duration::from_secs(600) {
            return Err("Sign-in timed out. Try again.".into());
        }
        let Ok(Ok((mut sock, _))) = tokio::time::timeout(Duration::from_secs(1), listener.accept()).await else { continue };
        let mut buf = vec![0u8; 8192];
        let n = tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await.ok().and_then(|r| r.ok()).unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]).to_string();
        let Some(result) = callback_code(&request, state) else {
            let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        };
        let page = if result.is_ok() { DONE_PAGE } else { FAILED_PAGE };
        let _ = sock.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len()).as_bytes()).await;
        return result;
    }
}

/// Signs in to account `id` (OpenRouter or Hugging Face) in the browser and
/// saves what it hands back. Aperture never sees the password.
pub async fn sign_in(app: &tauri::AppHandle, hostc: &Host, data: &Path, id: &str) -> Result<(), String> {
    let verifier = host::session_key();
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = host::session_key()[..32].to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("Couldn't start the sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    match id {
        "openrouter" => {
            let code = browser_code(app, hostc, &state, listener, openrouter_auth_url(port, &challenge, &state)).await?;
            openrouter_finish(data, &code, &verifier).await
        }
        "huggingface" => {
            let client_id = hf_client(data).await?;
            let redirect = hf_redirect(port);
            let code = browser_code(app, hostc, &state, listener, hf_auth_url(&client_id, &redirect, &challenge, &state)).await?;
            let form = [("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", redirect.as_str()), ("client_id", client_id.as_str()), ("code_verifier", verifier.as_str())];
            hf_token(data, &client_id, &form).await
        }
        _ => Err("This account signs in with a key, not a browser login.".into()),
    }
}

/// Trades OpenRouter's code for a key that belongs to the user's account.
async fn openrouter_finish(data: &Path, code: &str, verifier: &str) -> Result<(), String> {
    let resp = client()?
        .post("https://openrouter.ai/api/v1/auth/keys")
        .timeout(Duration::from_secs(30))
        .json(&json!({ "code": code, "code_verifier": verifier, "code_challenge_method": "S256" }))
        .send()
        .await
        .map_err(|_| "OpenRouter couldn't be reached to finish signing in.".to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(http_error("OpenRouter", status, &text));
    }
    let key = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["key"].as_str().map(String::from)).filter(|k| !k.is_empty()).ok_or("OpenRouter didn't send a key back. Try again.")?;
    let mut keys = host::load_keys(data);
    keys.insert("openrouter".into(), key);
    host::save_keys(data, &keys)
}

// ---- Hugging Face ----
// "Sign in with Hugging Face" (OAuth with PKCE) for a public app: no client
// secret. Aperture registers itself with Hugging Face on the first login
// (dynamic client registration) and keeps the client id. The token can call
// Inference Providers for the user (scope `inference-api`) and nothing else
// beyond their public profile; it's renewed with the refresh token.
const HF: &str = "https://huggingface.co";
const HF_SCOPE: &str = "openid inference-api";
/// Saved-key suffixes next to the access token under "huggingface".
const HF_CLIENT: &str = ":client";
const HF_REFRESH: &str = ":refresh";
const HF_EXPIRES: &str = ":expires";
/// Registered without a port: Hugging Face accepts any port on a loopback
/// address, so the sign-in can listen wherever the OS puts it.
const HF_REDIRECT: &str = "http://127.0.0.1/callback";

fn hf_redirect(port: u16) -> String {
    format!("http://127.0.0.1:{port}/callback")
}

pub fn hf_auth_url(client_id: &str, redirect: &str, challenge: &str, state: &str) -> String {
    let mut u = reqwest::Url::parse(&format!("{HF}/oauth/authorize")).expect("static url");
    u.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", HF_SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    u.to_string()
}

/// Aperture's client id with Hugging Face, registering the app on first use.
async fn hf_client(data: &Path) -> Result<String, String> {
    let saved = key_for(data, &format!("huggingface{HF_CLIENT}"));
    if !saved.is_empty() {
        return Ok(saved);
    }
    let resp = client()?
        .post(format!("{HF}/oauth/register"))
        .timeout(Duration::from_secs(30))
        .json(&json!({
            "client_name": "Aperture Analyst",
            "redirect_uris": [HF_REDIRECT],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "scope": HF_SCOPE,
        }))
        .send()
        .await
        .map_err(|_| "Hugging Face couldn't be reached to start signing in.".to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(http_error("Hugging Face", status, &text));
    }
    let id = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["client_id"].as_str().map(String::from)).filter(|k| !k.is_empty()).ok_or("Hugging Face didn't accept Aperture's sign-in request. Try again.")?;
    let mut keys = host::load_keys(data);
    keys.insert(format!("huggingface{HF_CLIENT}"), id.clone());
    host::save_keys(data, &keys)?;
    Ok(id)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The saved entries from a token response: the access token, the refresh
/// token when one is sent, and when the access token expires.
pub fn hf_entries(v: &Value, now: u64) -> Option<Vec<(String, String)>> {
    let token = v["access_token"].as_str().filter(|t| !t.is_empty())?;
    let mut out = vec![("huggingface".to_string(), token.to_string())];
    if let Some(r) = v["refresh_token"].as_str().filter(|r| !r.is_empty()) {
        out.push((format!("huggingface{HF_REFRESH}"), r.to_string()));
    }
    if let Some(s) = v["expires_in"].as_u64() {
        out.push((format!("huggingface{HF_EXPIRES}"), (now + s).to_string()));
    }
    Some(out)
}

/// Posts to Hugging Face's token endpoint and saves the tokens it returns.
async fn hf_token(data: &Path, client_id: &str, form: &[(&str, &str)]) -> Result<(), String> {
    let resp = client()?
        .post(format!("{HF}/oauth/token"))
        .timeout(Duration::from_secs(30))
        .form(form)
        .send()
        .await
        .map_err(|_| "Hugging Face couldn't be reached to finish signing in.".to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let mut keys = host::load_keys(data);
        // A registration Hugging Face no longer knows: register again next time.
        if v["error"] == "invalid_client" && keys.get(&format!("huggingface{HF_CLIENT}")).is_some_and(|c| c == client_id) {
            keys.remove(&format!("huggingface{HF_CLIENT}"));
            host::save_keys(data, &keys)?;
        }
        if v["error"].is_string() {
            let what = v["error_description"].as_str().or_else(|| v["error"].as_str()).unwrap_or("");
            return Err(format!("Hugging Face didn't finish the sign-in ({what}). Log in again."));
        }
        return Err(http_error("Hugging Face", status, &text));
    }
    let entries = hf_entries(&v, now_secs()).ok_or("Hugging Face didn't send a sign-in back. Try again.")?;
    let mut keys = host::load_keys(data);
    // A new login replaces the old one's refresh token and expiry.
    if entries.iter().all(|(k, _)| !k.ends_with(HF_REFRESH)) {
        keys.remove(&format!("huggingface{HF_REFRESH}"));
    }
    if entries.iter().all(|(k, _)| !k.ends_with(HF_EXPIRES)) {
        keys.remove(&format!("huggingface{HF_EXPIRES}"));
    }
    keys.extend(entries);
    host::save_keys(data, &keys)
}

/// One renewal at a time, so two requests don't both spend the refresh token.
static HF_RENEW: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

/// The Hugging Face token, renewed when it expires within two minutes.
async fn hf_fresh_token(data: &Path) -> Result<String, String> {
    let fresh = |keys: &analyst::Keys| {
        let token = keys.get("huggingface").cloned().unwrap_or_default();
        let expires = keys.get(&format!("huggingface{HF_EXPIRES}")).and_then(|e| e.parse::<u64>().ok());
        (token.is_empty() || expires.is_none_or(|e| e > now_secs() + 120)).then_some(token)
    };
    if let Some(t) = fresh(&host::load_keys(data)) {
        return Ok(t);
    }
    let _one = HF_RENEW.get_or_init(Default::default).lock().await;
    let keys = host::load_keys(data);
    if let Some(t) = fresh(&keys) {
        return Ok(t);
    }
    let refresh = keys.get(&format!("huggingface{HF_REFRESH}")).cloned().unwrap_or_default();
    let client_id = keys.get(&format!("huggingface{HF_CLIENT}")).cloned().unwrap_or_default();
    let expired = || {
        let _ = sign_out(data, "huggingface");
        "Your Hugging Face login expired. Log in again in the analyst's setup.".to_string()
    };
    if refresh.is_empty() || client_id.is_empty() {
        return Err(expired());
    }
    let form = [("grant_type", "refresh_token"), ("refresh_token", refresh.as_str()), ("client_id", client_id.as_str())];
    match hf_token(data, &client_id, &form).await {
        Ok(()) => Ok(key_for(data, "huggingface")),
        // Hugging Face turned the renewal down: the login is gone.
        Err(e) if e.starts_with("Hugging Face didn't finish") => Err(expired()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openrouter_sign_in_addresses() {
        let u = reqwest::Url::parse(&openrouter_auth_url(51423, "abc_-", "st8")).unwrap();
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["callback_url"], "http://localhost:51423/callback");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["state"], "st8");
        assert_eq!(callback_code("GET /callback?code=xyz&state=st8 HTTP/1.1\r\nHost: x\r\n", "st8"), Some(Ok("xyz".into())));
        assert!(matches!(callback_code("GET /callback?code=xyz&state=evil HTTP/1.1\r\n", "st8"), Some(Err(_))));
        assert!(matches!(callback_code("GET /callback?error=denied HTTP/1.1\r\n", "st8"), Some(Err(_))));
        assert_eq!(callback_code("GET /favicon.ico HTTP/1.1\r\n", "st8"), None);
        // S256: base64url(sha256(verifier)) without padding
        assert_eq!(b64url(&Sha256::digest(b"dBjftJeZ4CVP-mB92K27uhbUhU1p1r_wW1gFWFOEjXk")), "MmCevXfzcYlpqCg9Gt-8Vr3VpnG8md7nIeXR8aiPe3A");
    }

    #[test]
    fn huggingface_sign_in() {
        let u = reqwest::Url::parse(&hf_auth_url("cid", &hf_redirect(50111), "ch", "st8")).unwrap();
        assert_eq!(u.as_str().split('?').next(), Some("https://huggingface.co/oauth/authorize"));
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:50111/callback");
        assert_eq!(q["scope"], "openid inference-api");
        assert_eq!((q["client_id"].as_str(), q["code_challenge_method"].as_str(), q["response_type"].as_str()), ("cid", "S256", "code"));
        // Only the port differs from the registered address.
        let reg = reqwest::Url::parse(HF_REDIRECT).unwrap();
        let got = reqwest::Url::parse(&q["redirect_uri"]).unwrap();
        assert_eq!((reg.scheme(), reg.host_str(), reg.path()), (got.scheme(), got.host_str(), got.path()));
        let e = hf_entries(&json!({ "access_token": "hf_oauth_a", "refresh_token": "r", "expires_in": 28800 }), 1000).unwrap();
        assert_eq!(e, vec![("huggingface".into(), "hf_oauth_a".into()), ("huggingface:refresh".into(), "r".into()), ("huggingface:expires".into(), "29800".into())]);
        assert!(hf_entries(&json!({ "error": "invalid_grant" }), 0).is_none());
    }

    #[test]
    fn readable_errors() {
        assert!(http_error("OpenAI", 401, r#"{"error":{"message":"bad key"}}"#).contains("Connect the account again"));
        assert!(http_error("OpenRouter", 402, "").contains("out of credit"));
        assert!(http_error("X", 500, r#"{"message":"boom"}"#).ends_with("boom"));
    }
}
