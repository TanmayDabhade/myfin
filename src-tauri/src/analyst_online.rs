//! Aperture Analyst through an online account or a model server the user
//! runs: OpenRouter sign-in in the browser, saved account keys, the model
//! list, and questions sent to OpenRouter, OpenAI, Anthropic, Google Gemini
//! or an OpenAI-compatible server (Ollama, LM Studio). Keys stay in the
//! desktop process; the window only learns whether an account is connected.
use crate::analyst::{self, Config, Provider, Reply, Style};
use crate::analyst_host::{self as host, Host};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::atomic::Ordering,
    time::{Duration, Instant},
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
    let key = key_for(data, p.id);
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
        let key = key_for(data, p.id);
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

/// Signs in to OpenRouter: opens its sign-in page in the browser, waits for
/// it to send the browser back to a one-time address on this computer, and
/// trades the code for a key that belongs to the user's account.
pub async fn sign_in(app: &tauri::AppHandle, hostc: &Host, data: &Path) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let attempt = hostc.sign_in.fetch_add(1, Ordering::SeqCst) + 1;
    let verifier = host::session_key();
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = host::session_key()[..32].to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("Couldn't start the sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    app.opener().open_url(openrouter_auth_url(port, &challenge, &state), None::<&str>).map_err(|e| format!("Couldn't open the browser: {e}"))?;
    let started = Instant::now();
    let code = loop {
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
        let Some(result) = callback_code(&request, &state) else {
            let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        };
        let page = if result.is_ok() { DONE_PAGE } else { FAILED_PAGE };
        let _ = sock.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len()).as_bytes()).await;
        break result?;
    };
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
    fn readable_errors() {
        assert!(http_error("OpenAI", 401, r#"{"error":{"message":"bad key"}}"#).contains("Connect the account again"));
        assert!(http_error("OpenRouter", 402, "").contains("out of credit"));
        assert!(http_error("X", 500, r#"{"message":"boom"}"#).ends_with("boom"));
    }
}
