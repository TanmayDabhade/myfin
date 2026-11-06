//! Real-time US stock trades from Finnhub's websocket. This module holds the
//! pure parts (symbol rules, subscription messages, latest-trade book); the
//! websocket loop lives in the desktop binary.
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

pub const STREAM_URL: &str = "wss://ws.finnhub.io";
/// Finnhub's free plan streams at most 50 symbols per connection.
pub const MAX_SYMBOLS: usize = 50;

pub fn valid_symbol(s: &str) -> bool {
    !s.is_empty() && s.len() <= 20 && s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || ".:-_^".contains(c))
}

/// Cleans and de-duplicates the requested symbols, keeping the first 50.
pub fn symbols(requested: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for s in requested {
        let s = s.trim().to_ascii_uppercase();
        if !valid_symbol(&s) {
            return Err(format!("Invalid symbol for streaming: {}", s.chars().take(20).collect::<String>()));
        }
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out.truncate(MAX_SYMBOLS);
    Ok(out)
}

/// Finnhub takes the key in the URL; it only travels over the encrypted socket.
pub fn url(key: &str) -> String {
    format!("{STREAM_URL}/?token={key}")
}

pub fn subscribe(symbol: &str) -> String {
    json!({ "type": "subscribe", "symbol": symbol }).to_string()
}

pub fn unsubscribe(symbol: &str) -> String {
    json!({ "type": "unsubscribe", "symbol": symbol }).to_string()
}

/// What to tell the user when the handshake is refused, and whether
/// retrying could help.
pub fn handshake_error(status: u16) -> (String, bool) {
    match status {
        401 | 403 => ("Finnhub rejected the key. Check it in Settings → Data sources.".into(), false),
        429 => ("Finnhub allows one live connection per key. Close other apps using this key; retrying…".into(), true),
        s => (format!("Finnhub returned HTTP {s}. Retrying…"), true),
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Quote {
    pub price: f64,
    /// Trade time in Unix milliseconds.
    pub time: i64,
}

#[derive(Default)]
pub struct Book {
    pub quotes: HashMap<String, Quote>,
}

impl Book {
    /// Applies one Finnhub message and returns how many trades it kept.
    /// Provider error messages come back as Err.
    pub fn apply(&mut self, msg: &Value, wanted: &[String]) -> Result<usize, String> {
        match msg["type"].as_str() {
            Some("trade") => {
                let mut kept = 0;
                for t in msg["data"].as_array().into_iter().flatten() {
                    let (Some(s), Some(p), Some(time)) = (t["s"].as_str(), t["p"].as_f64(), t["t"].as_i64()) else { continue };
                    if !p.is_finite() || p <= 0.0 || !wanted.iter().any(|w| w == s) {
                        continue;
                    }
                    // Trades can arrive out of order inside a batch.
                    if self.quotes.get(s).is_some_and(|q| q.time > time) {
                        continue;
                    }
                    self.quotes.insert(s.to_string(), Quote { price: p, time });
                    kept += 1;
                }
                Ok(kept)
            }
            Some("error") => Err(msg["msg"].as_str().unwrap_or("Stream error").chars().take(200).collect()),
            _ => Ok(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wanted() -> Vec<String> {
        vec!["AAPL".into(), "QCOM".into()]
    }
    #[test]
    fn cleans_symbols_and_caps_the_list() {
        assert_eq!(symbols(&[" aapl".into(), "AAPL".into(), "BRK.B".into()]).unwrap(), vec!["AAPL", "BRK.B"]);
        assert!(symbols(&["AA PL".into()]).is_err());
        let many: Vec<String> = (0..80).map(|i| format!("S{i}")).collect();
        assert_eq!(symbols(&many).unwrap().len(), MAX_SYMBOLS);
        assert_eq!(subscribe("AAPL"), r#"{"symbol":"AAPL","type":"subscribe"}"#);
        assert_eq!(unsubscribe("AAPL"), r#"{"symbol":"AAPL","type":"unsubscribe"}"#);
        assert!(!handshake_error(401).1 && handshake_error(429).1);
        assert!(url("K").starts_with("wss://ws.finnhub.io/?token="));
    }
    #[test]
    fn keeps_latest_trade_per_wanted_symbol() {
        let mut b = Book::default();
        let msg = json!({"type":"trade","data":[
            {"s":"AAPL","p":201.5,"t":2000,"v":10},
            {"s":"AAPL","p":200.0,"t":1000,"v":5},
            {"s":"MSFT","p":400.0,"t":2000,"v":1},
            {"s":"QCOM","p":-1.0,"t":2000,"v":1}
        ]});
        assert_eq!(b.apply(&msg, &wanted()), Ok(1));
        assert_eq!(b.quotes["AAPL"], Quote { price: 201.5, time: 2000 });
        assert!(!b.quotes.contains_key("MSFT") && !b.quotes.contains_key("QCOM"));
        assert_eq!(b.apply(&json!({"type":"ping"}), &wanted()), Ok(0));
        assert!(b.apply(&json!({"type":"error","msg":"Invalid symbol"}), &wanted()).is_err());
    }
}

#[cfg(all(test, feature = "desktop"))]
mod contract_tests {
    /// Proves the handshake URL is well-formed: Finnhub must answer a bad
    /// key with HTTP 401, not a connection or request error.
    #[test]
    #[ignore = "Live Finnhub handshake check; requires network"]
    fn live_finnhub_handshake() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            match tokio_tungstenite::connect_async(super::url("invalidkey123")).await {
                Err(tokio_tungstenite::tungstenite::Error::Http(r)) => assert_eq!(r.status().as_u16(), 401),
                Err(e) => panic!("unexpected error: {e}"),
                Ok(_) => panic!("bad key accepted"),
            }
        });
    }
}
