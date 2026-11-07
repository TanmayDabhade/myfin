//! Provider rules shared by the desktop commands: saved credentials, request
//! budgets, request construction and provider error handling. Kept free of
//! Tauri so it can be unit tested without desktop libraries.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

pub const PROVIDERS: [&str; 8] = ["alpha", "twelve", "fred", "sec", "ais", "finnhub", "alpaca", "alpacasecret"];

const ALPHA_KINDS: [&str; 8] = [
    "TIME_SERIES_DAILY",
    "OVERVIEW",
    "INCOME_STATEMENT",
    "BALANCE_SHEET",
    "CASH_FLOW",
    "NEWS_SENTIMENT",
    "EARNINGS",
    "EARNINGS_CALENDAR",
];

/// Finnhub REST datasets on the free plan: company news, key metrics,
/// company profile and the earnings calendar.
const FINNHUB_KINDS: [&str; 4] = ["company-news", "metric", "profile2", "earnings"];

/// Free-plan limits, enforced locally so the app never burns a key.
pub struct Budget {
    pub daily: i64,
    /// Minimum seconds between two requests to the same provider.
    pub gap: i64,
    /// Seconds a cached response is reused before asking the provider again.
    pub ttl: i64,
}

pub fn budget(provider: &str) -> Budget {
    match provider {
        "alpha" => Budget { daily: 25, gap: 13, ttl: 21_600 },
        "twelve" => Budget { daily: 800, gap: 8, ttl: 3_600 },
        // Finnhub allows 60 calls a minute; news and metrics are reused for 30 minutes.
        "finnhub" => Budget { daily: 3_000, gap: 1, ttl: 1_800 },
        // Past trades change only while the market is open.
        "alpaca" => Budget { daily: 3_000, gap: 1, ttl: 300 },
        _ => Budget { daily: 2_000, gap: 1, ttl: 43_200 },
    }
}

pub fn env_name(provider: &str) -> &'static str {
    match provider {
        "alpha" => "ALPHA_VANTAGE_API_KEY",
        "twelve" => "TWELVE_DATA_API_KEY",
        "sec" => "SEC_CONTACT_EMAIL",
        "ais" => "AISSTREAM_API_KEY",
        "finnhub" => "FINNHUB_API_KEY",
        "alpaca" => "ALPACA_API_KEY_ID",
        "alpacasecret" => "ALPACA_API_SECRET_KEY",
        _ => "FRED_API_KEY",
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Credentials {
    #[serde(default)]
    pub alpha: String,
    #[serde(default)]
    pub twelve: String,
    #[serde(default)]
    pub fred: String,
    /// Contact email SEC asks automated tools to declare. Not a secret key.
    #[serde(default)]
    pub sec: String,
    #[serde(default)]
    pub ais: String,
    #[serde(default)]
    pub finnhub: String,
    /// Alpaca market data: key ID and secret, sent only as request headers.
    #[serde(default)]
    pub alpaca: String,
    #[serde(default)]
    pub alpacasecret: String,
}

impl Credentials {
    pub fn get(&self, provider: &str) -> &str {
        match provider {
            "alpha" => &self.alpha,
            "twelve" => &self.twelve,
            "fred" => &self.fred,
            "sec" => &self.sec,
            "ais" => &self.ais,
            "finnhub" => &self.finnhub,
            "alpaca" => &self.alpaca,
            "alpacasecret" => &self.alpacasecret,
            _ => "",
        }
    }
    pub fn set(&mut self, provider: &str, key: String) -> Result<(), String> {
        let key = key.trim().to_string();
        if provider == "sec" {
            if !key.is_empty() && !crate::sec::valid_contact(&key) {
                return Err("Enter a valid contact email for SEC EDGAR.".into());
            }
            self.sec = key;
            return Ok(());
        }
        if key.len() > 200 || !key.chars().all(|c| c.is_ascii_alphanumeric() || "-_".contains(c)) {
            return Err("That key has unexpected characters. Paste only the key itself.".into());
        }
        match provider {
            "alpha" => self.alpha = key,
            "twelve" => self.twelve = key,
            "fred" => self.fred = key,
            "ais" => self.ais = key,
            "finnhub" => self.finnhub = key,
            "alpaca" => self.alpaca = key,
            "alpacasecret" => self.alpacasecret = key,
            _ => return Err("Unknown provider".into()),
        }
        Ok(())
    }
    pub fn from_env() -> Self {
        let read = |p: &str| std::env::var(env_name(p)).unwrap_or_default().trim().to_string();
        Credentials {
            alpha: read("alpha"),
            twelve: read("twelve"),
            fred: read("fred"),
            sec: read("sec"),
            ais: read("ais"),
            finnhub: read("finnhub"),
            alpaca: read("alpaca"),
            alpacasecret: read("alpacasecret"),
        }
    }
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
    /// Writes the key file readable only by the current OS user.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let tmp = path.with_extension("tmp");
        let body = serde_json::to_string(self).map_err(|e| e.to_string())?;
        {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp).map_err(|_| "Could not save keys")?;
            file.write_all(body.as_bytes()).map_err(|_| "Could not save keys")?;
        }
        std::fs::rename(&tmp, path).map_err(|_| "Could not save keys".to_string())
    }
}

/// Environment variables win over saved keys so CI and power users can override.
pub fn resolve<'a>(env: &'a Credentials, saved: &'a Credentials, provider: &str) -> (&'a str, &'static str) {
    if !env.get(provider).is_empty() {
        (env.get(provider), "environment")
    } else if !saved.get(provider).is_empty() {
        (saved.get(provider), "saved")
    } else {
        ("", "none")
    }
}

pub fn status(env: &Credentials, saved: &Credentials) -> Value {
    let mut out = json!({});
    for p in PROVIDERS {
        let (key, source) = resolve(env, saved, p);
        out[p] = json!({ "configured": !key.is_empty(), "source": source });
    }
    out
}

pub fn validate(provider: &str, kind: &str, symbol: &str) -> Result<(), String> {
    if symbol.is_empty()
        || symbol.len() > 100
        || !symbol.chars().all(|c| c.is_ascii_alphanumeric() || ".-_^:&".contains(c))
    {
        return Err("Invalid identifier".into());
    }
    // Finnhub's free REST data and Alpaca's free trades cover US listings.
    if (provider == "finnhub" || provider == "alpaca") && symbol.contains(':') {
        return Err("This source covers US-listed stocks only.".into());
    }
    let ok = match provider {
        "alpha" => ALPHA_KINDS.contains(&kind),
        "twelve" => kind == "TIME_SERIES" || kind == "TIME_SERIES_1MIN",
        "fred" => kind == "observations",
        "finnhub" => FINNHUB_KINDS.contains(&kind),
        "alpaca" => kind == "trades",
        _ => false,
    };
    if ok { Ok(()) } else { Err("Unsupported dataset".into()) }
}

/// One provider request: URL, query and headers.
pub struct Request {
    pub url: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
}

/// Calendar date (UTC) for Unix seconds, from Howard Hinnant's days-to-civil.
fn civil(secs: i64) -> (i64, i64, i64, i64) {
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d, tod)
}
pub fn ymd(secs: i64) -> String {
    let (y, m, d, _) = civil(secs);
    format!("{y:04}-{m:02}-{d:02}")
}
pub fn rfc3339(secs: i64) -> String {
    let (_, _, _, t) = civil(secs);
    format!("{}T{:02}:{:02}:{:02}Z", ymd(secs), t / 3600, t / 60 % 60, t % 60)
}

/// Builds the request. `key` for Alpaca is "KEYID:SECRET"; `now` is Unix
/// seconds, used for date windows.
pub fn request(provider: &str, kind: &str, symbol: &str, key: &str, now: i64) -> Request {
    let q = |pairs: &[(&str, &str)]| pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    let plain = |url: &str, query: Vec<(String, String)>| Request { url: url.to_string(), query, headers: vec![] };
    const DAY: i64 = 86_400;
    match provider {
        "fred" => plain(
            "https://api.stlouisfed.org/fred/series/observations",
            q(&[("series_id", symbol), ("api_key", key), ("file_type", "json"), ("sort_order", "desc"), ("limit", "500")]),
        ),
        // Listings outside the US are keyed SYMBOL:MIC (VOD:XLON).
        "twelve" => {
            let (interval, size) = if kind == "TIME_SERIES_1MIN" { ("1min", "390") } else { ("1day", "1300") };
            match symbol.split_once(':') {
                Some((s, mic)) => plain(
                    "https://api.twelvedata.com/time_series",
                    q(&[("symbol", s), ("mic_code", mic), ("interval", interval), ("outputsize", size), ("apikey", key)]),
                ),
                None => plain(
                    "https://api.twelvedata.com/time_series",
                    q(&[("symbol", symbol), ("interval", interval), ("outputsize", size), ("apikey", key)]),
                ),
            }
        }
        "finnhub" => {
            let base = "https://finnhub.io/api/v1";
            match kind {
                "company-news" => plain(&format!("{base}/company-news"), q(&[("symbol", symbol), ("from", &ymd(now - 7 * DAY)), ("to", &ymd(now)), ("token", key)])),
                "metric" => plain(&format!("{base}/stock/metric"), q(&[("symbol", symbol), ("metric", "all"), ("token", key)])),
                "profile2" => plain(&format!("{base}/stock/profile2"), q(&[("symbol", symbol), ("token", key)])),
                _ => plain(&format!("{base}/calendar/earnings"), q(&[("symbol", symbol), ("from", &ymd(now - 400 * DAY)), ("to", &ymd(now + 120 * DAY)), ("token", key)])),
            }
        }
        // The newest IEX trades of the last six days. The free plan can't
        // read the latest 15 minutes, so the window ends 16 minutes ago.
        "alpaca" => {
            let (id, secret) = key.split_once(':').unwrap_or((key, ""));
            Request {
                url: format!("https://data.alpaca.markets/v2/stocks/{symbol}/trades"),
                query: q(&[("feed", "iex"), ("sort", "desc"), ("limit", "10000"), ("start", &rfc3339(now - 6 * DAY)), ("end", &rfc3339(now - 16 * 60))]),
                headers: vec![("APCA-API-KEY-ID".into(), id.into()), ("APCA-API-SECRET-KEY".into(), secret.into())],
            }
        }
        _ => {
            let field = if kind == "NEWS_SENTIMENT" { "tickers" } else { "symbol" };
            plain("https://www.alphavantage.co/query", q(&[("function", kind), (field, symbol), ("apikey", key)]))
        }
    }
}

pub fn display_name(provider: &str) -> &'static str {
    match provider {
        "alpha" => "Alpha Vantage",
        "twelve" => "Twelve Data",
        "finnhub" => "Finnhub",
        "alpaca" => "Alpaca",
        _ => "FRED",
    }
}

fn clip(message: &str, key: &str) -> String {
    let mut m = message.trim().to_string();
    for part in key.split(':') {
        if part.len() >= 6 {
            m = m.replace(part, "***");
        }
    }
    m.chars().take(300).collect()
}

/// Turns a provider body into data or a readable error. Providers often return
/// HTTP 200 with an error payload, so the body is checked either way.
pub fn interpret(provider: &str, kind: &str, http: u16, body: &str, key: &str) -> Result<Value, String> {
    let name = display_name(provider);
    if provider == "alpha" && kind == "EARNINGS_CALENDAR" && (200..300).contains(&http) && !body.trim_start().starts_with('{') {
        return Ok(json!({ "csv": body }));
    }
    let data: Result<Value, _> = serde_json::from_str(body);
    let message = data.as_ref().ok().and_then(|d| {
        if provider == "twelve" && d.get("status").and_then(Value::as_str) == Some("error") {
            return d.get("message").and_then(Value::as_str).map(str::to_string);
        }
        let keys: &[&str] = match provider {
            "finnhub" => &["error"],
            "alpaca" => &["message"],
            _ => &["Error Message", "Information", "Note", "error_message"],
        };
        keys.iter().find_map(|k| d.get(*k).and_then(Value::as_str).map(str::to_string))
    });
    if let Some(m) = message {
        return Err(format!("{name}: {}", clip(&m, key)));
    }
    if !(200..300).contains(&http) {
        return Err(format!("{name} returned HTTP {http}"));
    }
    data.map_err(|_| format!("{name} returned an unreadable response"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn env_overrides_saved_keys() {
        let env = Credentials { fred: "ENV".into(), ..Default::default() };
        let saved = Credentials { fred: "SAVED".into(), alpha: "A".into(), ..Default::default() };
        assert_eq!(resolve(&env, &saved, "fred"), ("ENV", "environment"));
        assert_eq!(resolve(&env, &saved, "alpha"), ("A", "saved"));
        assert_eq!(resolve(&env, &saved, "twelve"), ("", "none"));
        let s = status(&env, &saved);
        assert_eq!(s["twelve"]["configured"], false);
        assert!(!s.to_string().contains("SAVED"), "status must never expose keys");
    }
    #[test]
    fn saves_and_reloads_private_key_file() {
        let dir = std::env::temp_dir().join(format!("ml-keys-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("credentials.json");
        let mut c = Credentials::default();
        c.set("twelve", " abc123 ".into()).unwrap();
        c.save(&path).unwrap();
        assert_eq!(Credentials::load(&path).twelve, "abc123");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(c.set("alpha", "bad key&x=1".into()).is_err());
        assert!(c.set("sec", "not an email".into()).is_err());
        c.set("sec", "analyst@example.com".into()).unwrap();
        assert_eq!(c.get("sec"), "analyst@example.com");
        std::fs::remove_dir_all(dir).ok();
    }
    #[test]
    fn rejects_unknown_datasets_and_identifiers() {
        assert!(validate("twelve", "TIME_SERIES", "AAPL").is_ok());
        assert!(validate("twelve", "OVERVIEW", "AAPL").is_err());
        assert!(validate("twelve", "TIME_SERIES", "VOD:XLON").is_ok());
        assert!(validate("twelve", "TIME_SERIES", "M&M:XNSE").is_ok());
        let r = request("twelve", "TIME_SERIES", "VOD:XLON", "k", 0);
        assert!(r.query.contains(&("symbol".into(), "VOD".into())) && r.query.contains(&("mic_code".into(), "XLON".into())));
        assert!(validate("finnhub", "company-news", "AAPL").is_ok());
        assert!(validate("finnhub", "quote", "AAPL").is_err());
        assert!(validate("finnhub", "metric", "VOD:XLON").is_err());
        assert!(validate("alpaca", "trades", "AAPL").is_ok());
        assert!(validate("twelve", "TIME_SERIES_1MIN", "AAPL").is_ok());
        assert!(validate("alpha", "OVERVIEW", "BRK.B").is_ok());
        assert!(validate("fred", "observations", "DGS10").is_ok());
        assert!(validate("alpha", "OVERVIEW", "AAPL&apikey=x").is_err());
        assert!(validate("other", "x", "AAPL").is_err());
    }
    #[test]
    fn dates_and_new_provider_requests() {
        // 2026-11-07 18:30:05 UTC
        let now = 1_794_076_205;
        assert_eq!(ymd(now), "2026-11-07");
        assert_eq!(rfc3339(now), "2026-11-07T18:30:05Z");
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(951_782_400), "2000-02-29");
        let n = request("finnhub", "company-news", "AAPL", "FK", now);
        assert_eq!(n.url, "https://finnhub.io/api/v1/company-news");
        assert!(n.query.contains(&("from".into(), "2026-10-31".into())) && n.query.contains(&("to".into(), "2026-11-07".into())));
        let t = request("alpaca", "trades", "AAPL", "ID123:SECRET456", now);
        assert_eq!(t.url, "https://data.alpaca.markets/v2/stocks/AAPL/trades");
        assert!(t.query.contains(&("feed".into(), "iex".into())) && t.query.contains(&("end".into(), "2026-11-07T18:14:05Z".into())));
        assert!(t.headers.contains(&("APCA-API-SECRET-KEY".into(), "SECRET456".into())));
        assert!(!t.query.iter().any(|(_, v)| v.contains("SECRET")), "secret must not be in the URL");
        let m = request("twelve", "TIME_SERIES_1MIN", "AAPL", "k", now);
        assert!(m.query.contains(&("interval".into(), "1min".into())));
    }
    #[test]
    fn surfaces_provider_messages_without_the_key() {
        let e = interpret("twelve", "TIME_SERIES", 200, r#"{"code":401,"message":"apikey K12345 is incorrect","status":"error"}"#, "K12345").unwrap_err();
        assert_eq!(e, "Twelve Data: apikey *** is incorrect");
        let e = interpret("alpha", "OVERVIEW", 200, r#"{"Information":"Rate limit reached"}"#, "SECRETKEY").unwrap_err();
        assert!(e.contains("Rate limit"));
        let e = interpret("fred", "observations", 400, r#"{"error_code":400,"error_message":"Bad api_key"}"#, "SECRETKEY").unwrap_err();
        assert!(e.contains("Bad api_key"));
        assert!(interpret("fred", "observations", 500, "oops", "k").unwrap_err().contains("HTTP 500"));
        assert!(interpret("alpha", "EARNINGS_CALENDAR", 200, "symbol,name\nA,B", "k").unwrap()["csv"].is_string());
        assert!(interpret("twelve", "TIME_SERIES", 200, r#"{"values":[],"status":"ok"}"#, "k").is_ok());
        let e = interpret("finnhub", "metric", 403, r#"{"error":"You don't have access to this resource."}"#, "k").unwrap_err();
        assert_eq!(e, "Finnhub: You don't have access to this resource.");
        let e = interpret("alpaca", "trades", 403, r#"{"message":"forbidden for ID123456"}"#, "ID123456:SECRET789").unwrap_err();
        assert_eq!(e, "Alpaca: forbidden for ***");
        assert!(interpret("finnhub", "company-news", 200, r#"[{"headline":"x"}]"#, "k").unwrap().is_array());
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    async fn call(provider: &str, kind: &str, symbol: &str, key: &str) -> Result<Value, String> {
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap();
        let r = request(provider, kind, symbol, key, 0);
        let resp = client.get(&r.url).query(&r.query).send().await.map_err(|e| e.to_string())?;
        let http = resp.status().as_u16();
        interpret(provider, kind, http, &resp.text().await.unwrap(), key)
    }
    #[test]
    #[ignore = "Live provider contract check using public demo keys; requires network"]
    fn live_demo_keys() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let twelve = call("twelve", "TIME_SERIES", "AAPL", "demo").await.unwrap();
            assert!(twelve["values"].as_array().unwrap().len() > 300);
            let alpha = call("alpha", "TIME_SERIES_DAILY", "IBM", "demo").await.unwrap();
            assert!(alpha["Time Series (Daily)"].is_object());
            let bad = call("twelve", "TIME_SERIES", "AAPL", "not-a-real-key").await.unwrap_err();
            assert!(bad.starts_with("Twelve Data:"), "{bad}");
        });
    }
}
