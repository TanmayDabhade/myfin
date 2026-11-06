//! Provider rules shared by the desktop commands: saved credentials, request
//! budgets, request construction and provider error handling. Kept free of
//! Tauri so it can be unit tested without desktop libraries.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

pub const PROVIDERS: [&str; 6] = ["alpha", "twelve", "fred", "sec", "ais", "finnhub"];

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
            _ => return Err("Unknown provider".into()),
        }
        Ok(())
    }
    pub fn from_env() -> Self {
        let read = |p: &str| std::env::var(env_name(p)).unwrap_or_default().trim().to_string();
        Credentials { alpha: read("alpha"), twelve: read("twelve"), fred: read("fred"), sec: read("sec"), ais: read("ais"), finnhub: read("finnhub") }
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
        || !symbol.chars().all(|c| c.is_ascii_alphanumeric() || ".-_^".contains(c))
    {
        return Err("Invalid identifier".into());
    }
    let ok = match provider {
        "alpha" => ALPHA_KINDS.contains(&kind),
        "twelve" => kind == "TIME_SERIES",
        "fred" => kind == "observations",
        _ => false,
    };
    if ok { Ok(()) } else { Err("Unsupported dataset".into()) }
}

pub fn request(provider: &str, kind: &str, symbol: &str, key: &str) -> (&'static str, Vec<(String, String)>) {
    let q = |pairs: &[(&str, &str)]| pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    match provider {
        "fred" => (
            "https://api.stlouisfed.org/fred/series/observations",
            q(&[("series_id", symbol), ("api_key", key), ("file_type", "json"), ("sort_order", "desc"), ("limit", "500")]),
        ),
        "twelve" => (
            "https://api.twelvedata.com/time_series",
            q(&[("symbol", symbol), ("interval", "1day"), ("outputsize", "1300"), ("apikey", key)]),
        ),
        _ => {
            let field = if kind == "NEWS_SENTIMENT" { "tickers" } else { "symbol" };
            ("https://www.alphavantage.co/query", q(&[("function", kind), (field, symbol), ("apikey", key)]))
        }
    }
}

fn clip(message: &str, key: &str) -> String {
    let mut m = message.trim().to_string();
    if key.len() >= 6 {
        m = m.replace(key, "***");
    }
    m.chars().take(300).collect()
}

/// Turns a provider body into data or a readable error. Providers often return
/// HTTP 200 with an error payload, so the body is checked either way.
pub fn interpret(provider: &str, kind: &str, http: u16, body: &str, key: &str) -> Result<Value, String> {
    let name = match provider { "alpha" => "Alpha Vantage", "twelve" => "Twelve Data", _ => "FRED" };
    if provider == "alpha" && kind == "EARNINGS_CALENDAR" && (200..300).contains(&http) && !body.trim_start().starts_with('{') {
        return Ok(json!({ "csv": body }));
    }
    let data: Result<Value, _> = serde_json::from_str(body);
    let message = data.as_ref().ok().and_then(|d| {
        if provider == "twelve" && d.get("status").and_then(Value::as_str) == Some("error") {
            return d.get("message").and_then(Value::as_str).map(str::to_string);
        }
        ["Error Message", "Information", "Note", "error_message"]
            .iter()
            .find_map(|k| d.get(*k).and_then(Value::as_str).map(str::to_string))
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
        assert!(validate("alpha", "OVERVIEW", "BRK.B").is_ok());
        assert!(validate("fred", "observations", "DGS10").is_ok());
        assert!(validate("alpha", "OVERVIEW", "AAPL&apikey=x").is_err());
        assert!(validate("other", "x", "AAPL").is_err());
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
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    async fn call(provider: &str, kind: &str, symbol: &str, key: &str) -> Result<Value, String> {
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap();
        let (url, query) = request(provider, kind, symbol, key);
        let resp = client.get(url).query(&query).send().await.map_err(|e| e.to_string())?;
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
