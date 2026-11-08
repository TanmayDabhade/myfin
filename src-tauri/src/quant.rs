//! Risk analytics from Goldman Sachs' open-source gs-quant library.
//!
//! gs-quant is Python. Release builds ship a standalone Python with gs-quant
//! installed (scripts/bundle-python.cjs, app resource `python/<target>/`).
//! A Python the user picks, or APERTURE_PYTHON, takes precedence; without a
//! bundle (a dev build) the usual install locations are searched. The
//! compiled-in `quant.py` gets the stock's daily closes on stdin. Only the offline
//! `gs_quant.timeseries` functions are used: nothing is sent to Goldman Sachs.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const SCRIPT: &str = include_str!("quant.py");
// Finds gs-quant without importing it (a cold import can take a minute).
const PROBE: &str = "import sys, json, importlib.util as u, importlib.metadata as m\n\
def v():\n    for n in ('gs-quant', 'gs_quant'):\n        try: return m.version(n)\n        except Exception: pass\n    return '?'\n\
print(json.dumps({'python': sys.version.split()[0], 'gsQuant': v() if u.find_spec('gs_quant') else None}))";
pub const INSTALL: &str = "python3 -m pip install gs-quant";
const MAX_POINTS: usize = 10_000;
const MIN_POINTS: usize = 30;

#[derive(Clone, Debug, PartialEq)]
pub struct Env {
    pub python: PathBuf,
    pub version: String,
    pub gs_quant: Option<String>,
    /// Picked by the user rather than found.
    pub chosen: bool,
    /// The Python that ships inside the app.
    pub bundled: bool,
}

impl Env {
    pub fn status(env: Option<&Env>) -> Value {
        match env {
            Some(e) => json!({
                "python": e.python.display().to_string(),
                "version": e.version,
                "gsQuant": e.gs_quant,
                "chosen": e.chosen,
                "bundled": e.bundled,
                "install": format!("{} -m pip install gs-quant", e.python.display()),
            }),
            None => json!({ "python": null, "gsQuant": null, "chosen": false, "bundled": false, "install": INSTALL }),
        }
    }
}

/// The bundle's folder name for the platform this binary was built for. A
/// universal Mac app carries both Mac folders and uses the one that matches.
pub const TARGET: &str = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    "aarch64-apple-darwin"
} else if cfg!(target_os = "macos") {
    "x86_64-apple-darwin"
} else if cfg!(windows) {
    "x86_64-pc-windows-msvc"
} else {
    "x86_64-unknown-linux-gnu"
};

/// The Python inside the app's resources, if this build has one.
pub fn bundled(resource_dir: &Path) -> Option<PathBuf> {
    let dir = resource_dir.join("python").join(TARGET);
    let exe = if cfg!(windows) { dir.join("python.exe") } else { dir.join("bin").join("python3") };
    exe.is_file().then_some(exe)
}

/// Places a Python 3 is commonly installed. GUI apps on macOS do not get the
/// shell's PATH, so the usual install locations are listed explicitly too.
pub fn candidates(path_var: Option<&str>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let names: &[&str] = if cfg!(windows) { &["python.exe", "python3.exe"] } else { &["python3", "python"] };
    if let Some(p) = path_var {
        for dir in std::env::split_paths(p) {
            // The Microsoft Store alias opens the Store instead of running Python.
            if dir.to_string_lossy().contains("WindowsApps") {
                continue;
            }
            for n in names {
                out.push(dir.join(n));
            }
        }
    }
    if cfg!(windows) {
        if let Some(h) = home {
            if let Ok(rd) = std::fs::read_dir(h.join("AppData/Local/Programs/Python")) {
                let mut dirs: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
                dirs.sort();
                out.extend(dirs.into_iter().rev().map(|d| d.join("python.exe")));
            }
        }
    } else {
        for p in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"] {
            out.push(p.into());
        }
        if let Some(h) = home {
            for p in [".pyenv/shims/python3", "miniforge3/bin/python3", "miniconda3/bin/python3", "anaconda3/bin/python3", ".local/bin/python3"] {
                out.push(h.join(p));
            }
        }
        out.push("/usr/bin/python3".into());
    }
    let mut seen = std::collections::HashSet::new();
    out.into_iter().filter(|p| p.is_file() && seen.insert(p.clone())).collect()
}

fn command(python: &Path) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(python);
    // -I: ignore PYTHON* variables, user site tweaks and the working directory.
    // -B: never write bytecode (the bundled Python is precompiled and read-only).
    c.arg("-I").arg("-B").env("PYTHONIOENCODING", "utf-8").kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    c
}

/// Runs `python -I -c code` with `input` on stdin; returns stdout.
pub async fn run(python: &Path, code: &str, input: &[u8], limit: Duration) -> Result<String, String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let mut child = command(python)
        .arg("-c")
        .arg(code)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", python.display()))?;
    let mut stdin = child.stdin.take().ok_or("No stdin")?;
    let input = input.to_vec();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(&input).await;
    });
    let out = tokio::time::timeout(limit, child.wait_with_output())
        .await
        .map_err(|_| format!("Python did not finish within {} seconds.", limit.as_secs()))?
        .map_err(|e| e.to_string())?;
    let _ = writer.await;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no error output");
        return Err(format!("Python exited with {}: {}", out.status, line.chars().take(300).collect::<String>()));
    }
    String::from_utf8(out.stdout).map_err(|_| "Python returned non-UTF-8 output.".into())
}

/// Asks one Python for its version and whether gs-quant is installed.
pub async fn probe(python: &Path, chosen: bool) -> Result<Env, String> {
    probe_as(python, chosen, false).await
}
pub async fn probe_as(python: &Path, chosen: bool, bundled: bool) -> Result<Env, String> {
    let out = run(python, PROBE, b"", Duration::from_secs(15)).await?;
    let v: Value = serde_json::from_str(out.trim()).map_err(|_| "Not a Python 3 interpreter.".to_string())?;
    let version = v["python"].as_str().unwrap_or("").to_string();
    if !version.starts_with('3') {
        return Err("Python 3 is required.".into());
    }
    Ok(Env { python: python.to_path_buf(), version, gs_quant: v["gsQuant"].as_str().map(String::from), chosen, bundled })
}

/// First Python with gs-quant installed; otherwise the first working Python.
/// `bundled` marks the app's own Python in the result.
pub async fn detect(list: &[PathBuf], bundled: Option<&Path>) -> Option<Env> {
    let mut fallback = None;
    for p in list {
        if let Ok(env) = probe_as(p, false, bundled == Some(p.as_path())).await {
            if env.gs_quant.is_some() {
                return Some(env);
            }
            fallback.get_or_insert(env);
        }
    }
    fallback
}

fn closes(v: &Value) -> Result<Vec<(String, f64)>, String> {
    let rows = v.as_array().ok_or("Prices must be a list.")?;
    if rows.len() > MAX_POINTS {
        return Err("Too many prices.".into());
    }
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let (d, c) = (r[0].as_str().unwrap_or(""), r[1].as_f64().unwrap_or(f64::NAN));
        let date_ok = d.len() == 10 && d.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
        if !date_ok || !c.is_finite() || c <= 0.0 {
            return Err(format!("Invalid price row: {}", r.to_string().chars().take(60).collect::<String>()));
        }
        out.push((d.to_string(), c));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.dedup_by(|a, b| a.0 == b.0);
    Ok(out)
}

/// Checks what the page sent and builds the script's stdin.
pub fn request(input: &Value) -> Result<String, String> {
    let symbol = input["symbol"].as_str().unwrap_or("");
    if symbol.is_empty() || symbol.len() > 30 {
        return Err("Invalid symbol.".into());
    }
    let main = closes(&input["closes"])?;
    if main.len() < MIN_POINTS {
        return Err(format!("Risk analytics need at least {MIN_POINTS} daily prices."));
    }
    let bench = match &input["benchmark"] {
        Value::Object(b) => {
            let rows = closes(b.get("closes").unwrap_or(&Value::Null))?;
            let s = b.get("symbol").and_then(Value::as_str).unwrap_or("").chars().take(30).collect::<String>();
            json!({ "symbol": s, "closes": rows.iter().map(|(d, c)| json!([d, c])).collect::<Vec<_>>() })
        }
        _ => Value::Null,
    };
    let rate = input["riskFree"].as_f64().filter(|r| r.is_finite() && (-0.05..0.5).contains(r)).unwrap_or(0.0);
    Ok(json!({
        "symbol": symbol,
        "closes": main.iter().map(|(d, c)| json!([d, c])).collect::<Vec<_>>(),
        "benchmark": bench,
        "riskFree": rate,
    })
    .to_string())
}

/// Reads the script's output; its `error` field becomes an Err.
pub fn response(out: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(out.trim()).map_err(|_| "gs-quant returned something unreadable.".to_string())?;
    if let Some(e) = v["error"].as_str() {
        return Err(e.chars().take(300).collect());
    }
    if !v["metrics"].is_object() {
        return Err("gs-quant returned no metrics.".into());
    }
    Ok(v)
}

/// A Python the user picked earlier, saved in quant.json.
pub fn load_choice(path: &Path) -> Option<PathBuf> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    Some(PathBuf::from(v["python"].as_str()?)).filter(|p| p.is_file())
}
pub fn save_choice(path: &Path, python: Option<&Path>) -> std::io::Result<()> {
    match python {
        Some(p) => std::fs::write(path, json!({ "python": p.display().to_string() }).to_string()),
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(n: usize) -> Value {
        Value::Array(
            (0..n)
                .map(|i| json!([format!("2025-{:02}-{:02}", 1 + i / 28 % 12, 1 + i % 28), 100.0 + i as f64]))
                .collect(),
        )
    }

    #[test]
    fn builds_a_clean_request() {
        let mut closes = rows(40);
        closes.as_array_mut().unwrap().push(json!(["2025-01-01", 1.0])); // duplicate date
        let r: Value = serde_json::from_str(
            &request(&json!({ "symbol": "AAPL", "closes": closes, "benchmark": { "symbol": "SPY", "closes": rows(40) }, "riskFree": 0.04 })).unwrap(),
        )
        .unwrap();
        assert_eq!(r["closes"].as_array().unwrap().len(), 40);
        assert_eq!(r["benchmark"]["symbol"], "SPY");
        assert_eq!(r["riskFree"], 0.04);
        let first = r["closes"][0][0].as_str().unwrap();
        assert!(r["closes"].as_array().unwrap().iter().all(|x| x[0].as_str().unwrap() >= first), "sorted");
    }

    #[test]
    fn rejects_bad_input() {
        assert!(request(&json!({ "symbol": "AAPL", "closes": rows(10) })).unwrap_err().contains("at least"));
        assert!(request(&json!({ "symbol": "", "closes": rows(40) })).is_err());
        let mut bad = rows(40);
        bad[3] = json!(["2025-01-04", -1]);
        assert!(request(&json!({ "symbol": "A", "closes": bad })).is_err());
        let mut bad = rows(40);
        bad[3] = json!(["2025-1-4; rm", 10]);
        assert!(request(&json!({ "symbol": "A", "closes": bad })).is_err());
        // An absurd rate falls back to zero instead of failing.
        let r: Value = serde_json::from_str(&request(&json!({ "symbol": "A", "closes": rows(40), "riskFree": 7 })).unwrap()).unwrap();
        assert_eq!(r["riskFree"], 0.0);
    }

    #[test]
    fn reads_script_output() {
        assert!(response(r#"{"metrics":{"vol1m":12.5}}"#).is_ok());
        assert_eq!(response(r#"{"error":"Could not load gs-quant"}"#).unwrap_err(), "Could not load gs-quant");
        assert!(response("Traceback ...").is_err());
        assert!(response("{}").is_err());
    }

    #[test]
    fn finds_the_bundled_python_for_this_platform() {
        let dir = std::env::temp_dir().join(format!("aperture-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(bundled(&dir), None);
        let exe = if cfg!(windows) { dir.join("python").join(TARGET).join("python.exe") } else { dir.join("python").join(TARGET).join("bin/python3") };
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "").unwrap();
        assert_eq!(bundled(&dir), Some(exe));
    }

    #[test]
    fn saves_and_forgets_the_chosen_python() {
        let dir = std::env::temp_dir().join(format!("aperture-quant-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (file, exe) = (dir.join("quant.json"), dir.join("python3"));
        std::fs::write(&exe, "").unwrap();
        save_choice(&file, Some(&exe)).unwrap();
        assert_eq!(load_choice(&file), Some(exe.clone()));
        std::fs::remove_file(&exe).unwrap();
        assert_eq!(load_choice(&file), None, "a deleted interpreter is ignored");
        save_choice(&file, None).unwrap();
        save_choice(&file, None).unwrap();
        assert!(!file.exists());
    }

    /// Runs the real script. APERTURE_TEST_PYTHON=/path/to/python-with-gs-quant
    /// cargo test --no-default-features --lib quant -- --ignored
    #[test]
    #[ignore]
    fn runs_gs_quant() {
        let python = PathBuf::from(std::env::var("APERTURE_TEST_PYTHON").expect("APERTURE_TEST_PYTHON"));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let env = rt.block_on(probe(&python, true)).unwrap();
        assert!(env.gs_quant.is_some(), "gs-quant is not installed for {}", python.display());
        let mut p = 100.0;
        let closes: Vec<Value> = (0..400)
            .map(|i| {
                p *= 1.0 + ((i * 7919 % 13) as f64 - 6.0) / 400.0;
                let d = chrono_like(i);
                json!([d, p])
            })
            .collect();
        let input = request(&json!({ "symbol": "TEST", "closes": closes, "benchmark": { "symbol": "SPY", "closes": closes }, "riskFree": 0.04 })).unwrap();
        let out = rt.block_on(run(&python, SCRIPT, input.as_bytes(), Duration::from_secs(240))).unwrap();
        let v = response(&out).unwrap();
        assert!(v["metrics"]["vol1y"].as_f64().unwrap() > 0.0);
        assert!((v["metrics"]["beta3m"].as_f64().unwrap() - 1.0).abs() < 1e-6, "beta to itself is 1");
        assert_eq!(v["series"]["vol"].as_array().unwrap().len(), 252);
        let year = &v["sim"]["horizons"]["252"];
        assert!(year["p5"].as_f64().unwrap() < year["p50"].as_f64().unwrap() && year["p50"].as_f64().unwrap() < year["p95"].as_f64().unwrap());
        assert_eq!(v["sim"]["bands"]["p50"].as_array().unwrap().len(), 252);
        assert!(v["market"]["rows"].as_array().unwrap().len() == 6);
        assert!(v["daily"]["counts"].as_array().unwrap().len() == 50);
    }

    // Consecutive calendar dates from 2024-01-01, without a date library.
    fn chrono_like(i: usize) -> String {
        let days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let (mut m, mut d) = (0, i);
        while d >= days[m] {
            d -= days[m];
            m += 1;
        }
        format!("{}-{:02}-{:02}", 2024 + m / 12, m % 12 + 1, d + 1)
    }
}
