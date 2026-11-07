//! Directory of listed securities worldwide: Twelve Data's public reference
//! lists (every stock and ETF it knows, on about 70 exchanges; no key
//! needed) merged with SEC's company file, which adds CIKs for US filers.
//! Kept in reference.sqlite for search and browsing.
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const STOCKS_URL: &str = "https://api.twelvedata.com/stocks";
pub const ETFS_URL: &str = "https://api.twelvedata.com/etfs";
pub const SEC_URL: &str = "https://www.sec.gov/files/company_tickers_exchange.json";

pub fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS listings(key TEXT PRIMARY KEY, symbol TEXT NOT NULL, name TEXT NOT NULL, exchange TEXT, mic TEXT, country TEXT,
            currency TEXT, kind TEXT, figi TEXT, cik TEXT, tier INTEGER NOT NULL, source TEXT);
         CREATE INDEX IF NOT EXISTS listings_symbol ON listings(symbol);
         CREATE INDEX IF NOT EXISTS listings_country ON listings(country, tier, name);
         CREATE TABLE IF NOT EXISTS universe_meta(id INTEGER PRIMARY KEY, fetched INTEGER, stocks INTEGER, etfs INTEGER, sec INTEGER);",
    )
}

/// US venues, where the app keys a listing by its bare ticker (AAPL).
pub const US_MICS: [&str; 12] = ["XNYS", "XNAS", "XNGS", "XNMS", "XNCM", "XASE", "ARCX", "BATS", "IEXG", "PINX", "OTCB", "OTCQ"];
const US_MAJOR: [&str; 8] = ["XNYS", "XNAS", "XNGS", "XNMS", "XNCM", "XASE", "ARCX", "BATS"];
/// Venues that mostly re-list securities whose home market is elsewhere.
const SECONDARY: [&str; 15] = [
    "XSTU", "XFRA", "XDUS", "XMUN", "XHAN", "XBER", "XHAM", "BCXE", "PINX", "OTCB", "OTCQ", "PSGM", "EXPM", "IEXG", "NEOE",
];

/// Search order: 0 US major exchanges, 1 home exchanges, 2 secondary venues.
pub fn tier(mic: &str) -> i64 {
    if US_MAJOR.contains(&mic) {
        0
    } else if SECONDARY.contains(&mic) {
        2
    } else {
        1
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Listing {
    pub symbol: String,
    pub name: String,
    pub exchange: String,
    pub mic: String,
    pub country: String,
    pub currency: String,
    pub kind: String,
    pub figi: String,
    pub cik: String,
    pub source: &'static str,
}

impl Listing {
    pub fn us(&self) -> bool {
        self.country == "United States" || (self.country.is_empty() && US_MICS.contains(&self.mic.as_str()))
    }
    /// The app's identifier: AAPL for US listings, VOD:XLON elsewhere.
    pub fn key(&self) -> String {
        if self.us() {
            self.symbol.clone()
        } else {
            format!("{}:{}", self.symbol, self.mic)
        }
    }
}

#[derive(Deserialize)]
struct Raw {
    #[serde(default)]
    symbol: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    currency: String,
    #[serde(default)]
    exchange: String,
    #[serde(default)]
    mic_code: String,
    #[serde(default)]
    country: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    figi_code: String,
}

#[derive(Deserialize)]
struct Resp {
    #[serde(default)]
    data: Vec<Raw>,
    #[serde(default)]
    message: Option<String>,
}

fn clean(s: &str, max: usize) -> String {
    s.trim().chars().filter(|c| !c.is_control()).take(max).collect()
}

/// Parses Twelve Data's /stocks or /etfs response.
pub fn parse_twelve(body: &str, etf: bool) -> Result<Vec<Listing>, String> {
    let r: Resp = serde_json::from_str(body).map_err(|_| "Twelve Data returned an unreadable listing file".to_string())?;
    if r.data.is_empty() {
        return Err(r.message.unwrap_or_else(|| "Twelve Data returned no listings".into()));
    }
    Ok(r.data
        .into_iter()
        .filter(|x| !x.symbol.trim().is_empty() && !x.name.trim().is_empty() && x.symbol.len() <= 24)
        .map(|x| Listing {
            symbol: clean(&x.symbol, 24).to_ascii_uppercase(),
            name: clean(&x.name, 160),
            exchange: clean(&x.exchange, 40),
            mic: clean(&x.mic_code, 8).to_ascii_uppercase(),
            country: clean(&x.country, 60),
            currency: clean(&x.currency, 8),
            kind: if etf { "ETF".into() } else { clean(&x.kind, 40) },
            figi: clean(&x.figi_code, 16),
            cik: String::new(),
            source: "Twelve Data",
        })
        .collect())
}

/// SEC's company_tickers_exchange.json: (cik, name, ticker, exchange).
pub fn parse_sec(body: &str) -> Result<Vec<(String, String, String, String)>, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "SEC returned an unreadable company file".to_string())?;
    let fields: Vec<&str> = v["fields"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let at = |n: &str| fields.iter().position(|f| *f == n);
    let (Some(c), Some(n), Some(t), Some(e)) = (at("cik"), at("name"), at("ticker"), at("exchange")) else {
        return Err("SEC company file has an unexpected layout".into());
    };
    Ok(v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let cik = row.get(c)?.as_u64()?;
            let ticker = row.get(t)?.as_str()?.trim().to_ascii_uppercase();
            if ticker.is_empty() {
                return None;
            }
            Some((format!("{cik:0>10}"), clean(row.get(n)?.as_str().unwrap_or(""), 160), ticker, row.get(e).and_then(Value::as_str).unwrap_or("").to_string()))
        })
        .collect())
}

/// SEC writes BRK-B, Twelve Data BRK.B.
fn us_ticker(t: &str) -> String {
    t.replace('-', ".")
}

/// Merges the sources into one list: IEX duplicates of securities listed
/// on a main US exchange are dropped, SEC adds CIKs and any US filer
/// Twelve Data lacks.
pub fn merge(mut listings: Vec<Listing>, sec: &[(String, String, String, String)]) -> Vec<Listing> {
    let main_us: HashSet<String> = listings.iter().filter(|l| l.us() && l.mic != "IEXG").map(|l| l.symbol.clone()).collect();
    listings.retain(|l| l.mic != "IEXG" || !main_us.contains(&l.symbol));
    let mut by_ticker: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, l) in listings.iter().enumerate() {
        if l.us() {
            by_ticker.entry(l.symbol.clone()).or_default().push(i);
        }
    }
    for (cik, name, ticker, exchange) in sec {
        let t = us_ticker(ticker);
        match by_ticker.get(&t) {
            Some(ix) => {
                for i in ix {
                    listings[*i].cik = cik.clone();
                }
            }
            None => {
                let mic = match exchange.as_str() {
                    "Nasdaq" => "XNAS",
                    "NYSE" => "XNYS",
                    "CBOE" => "BATS",
                    "OTC" => "OTCB",
                    _ => "",
                };
                listings.push(Listing {
                    symbol: t.clone(),
                    name: name.clone(),
                    exchange: if exchange.is_empty() { "Not listed".into() } else { exchange.clone() },
                    mic: mic.into(),
                    country: "United States".into(),
                    currency: "USD".into(),
                    kind: String::new(),
                    figi: String::new(),
                    cik: cik.clone(),
                    source: "SEC",
                });
                by_ticker.insert(t, vec![listings.len() - 1]);
            }
        }
    }
    listings
}

pub fn replace(db: &mut Connection, listings: &[Listing], counts: (i64, i64, i64)) -> rusqlite::Result<usize> {
    let tx = db.transaction()?;
    tx.execute("DELETE FROM listings", [])?;
    let mut n = 0;
    {
        let mut q = tx.prepare(
            "INSERT OR IGNORE INTO listings(key,symbol,name,exchange,mic,country,currency,kind,figi,cik,tier,source) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        )?;
        for l in listings {
            n += q.execute(params![l.key(), l.symbol, l.name, l.exchange, l.mic, l.country, l.currency, l.kind, l.figi, l.cik, tier(&l.mic), l.source])?;
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO universe_meta(id,fetched,stocks,etfs,sec) VALUES(1,strftime('%s','now'),?1,?2,?3)",
        params![counts.0, counts.1, counts.2],
    )?;
    tx.commit()?;
    Ok(n)
}

const COLS: &str = "key,symbol,name,exchange,mic,country,currency,kind,cik,source";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "key": r.get::<_, String>(0)?, "symbol": r.get::<_, String>(1)?, "name": r.get::<_, String>(2)?,
        "exchange": r.get::<_, Option<String>>(3)?, "mic": r.get::<_, Option<String>>(4)?, "country": r.get::<_, Option<String>>(5)?,
        "currency": r.get::<_, Option<String>>(6)?, "kind": r.get::<_, Option<String>>(7)?, "cik": r.get::<_, Option<String>>(8)?,
        "source": r.get::<_, Option<String>>(9)?,
    }))
}

fn like_escape(q: &str) -> String {
    q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Ticker or name search across every listing: exact ticker, then ticker
/// prefix, then name prefix, then name anywhere; main venues first.
pub fn search(db: &Connection, q: &str, limit: usize) -> rusqlite::Result<Value> {
    let q = q.trim();
    if q.is_empty() || q.len() > 80 {
        return Ok(json!([]));
    }
    let up = q.to_uppercase();
    let e = like_escape(&up);
    let sql = format!(
        "SELECT {COLS} FROM listings WHERE symbol LIKE ?1 ESCAPE '\\' OR key = ?3 OR name LIKE ?2 ESCAPE '\\'
         ORDER BY CASE WHEN symbol=?3 OR key=?3 THEN 0
                       WHEN length(?3) <= 4 AND symbol LIKE ?1 ESCAPE '\\' THEN 1
                       WHEN name LIKE ?4 ESCAPE '\\' THEN 1
                       WHEN symbol LIKE ?1 ESCAPE '\\' THEN 2 ELSE 3 END,
                  tier, CASE WHEN kind LIKE '%Common%' OR kind='' THEN 0 WHEN kind LIKE '%Depositary%' THEN 1 ELSE 2 END, length(symbol), name
         LIMIT ?5"
    );
    let mut s = db.prepare(&sql)?;
    let rows: Vec<Value> = s.query_map(params![format!("{e}%"), format!("%{e}%"), up, format!("{e}%"), limit.min(200) as i64], row)?.collect::<Result<_, _>>()?;
    Ok(Value::Array(rows))
}

pub struct Filter {
    pub country: String,
    pub mic: String,
    pub kind: String,
    pub q: String,
    pub offset: usize,
    pub limit: usize,
}

/// One page of listings matching the filters, with the total count.
pub fn browse(db: &Connection, f: &Filter) -> rusqlite::Result<Value> {
    let mut wh: Vec<String> = Vec::new();
    let mut args: Vec<String> = Vec::new();
    for (col, v) in [("country", &f.country), ("mic", &f.mic)] {
        if !v.is_empty() {
            args.push(v.clone());
            wh.push(format!("{col} = ?{}", args.len()));
        }
    }
    match f.kind.as_str() {
        "" => {}
        "Stock" => wh.push("kind NOT IN ('ETF','Warrant','Right','Unit','Preferred Stock','Structured Product','Exchange-Traded Note')".into()),
        k => {
            args.push(k.to_string());
            wh.push(format!("kind = ?{}", args.len()));
        }
    }
    if !f.q.trim().is_empty() {
        let e = like_escape(&f.q.trim().to_uppercase());
        args.push(format!("{e}%"));
        args.push(format!("%{e}%"));
        wh.push(format!("(symbol LIKE ?{} ESCAPE '\\' OR name LIKE ?{} ESCAPE '\\')", args.len() - 1, args.len()));
    }
    let cond = if wh.is_empty() { "1".into() } else { wh.join(" AND ") };
    let total: i64 = db.query_row(&format!("SELECT COUNT(*) FROM listings WHERE {cond}"), rusqlite::params_from_iter(args.iter()), |r| r.get(0))?;
    let mut s = db.prepare(&format!("SELECT {COLS} FROM listings WHERE {cond} ORDER BY tier, name LIMIT {} OFFSET {}", f.limit.clamp(1, 500), f.offset))?;
    let rows: Vec<Value> = s.query_map(rusqlite::params_from_iter(args.iter()), row)?.collect::<Result<_, _>>()?;
    Ok(json!({ "total": total, "rows": rows }))
}

/// Counts by country, exchange and security type, for the browse filters.
pub fn facets(db: &Connection) -> rusqlite::Result<Value> {
    let pairs = |sql: &str| -> rusqlite::Result<Vec<Value>> {
        let mut s = db.prepare(sql)?;
        let v = s.query_map([], |r| Ok(json!([r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, i64>(3)?])))?;
        v.collect()
    };
    let countries = pairs("SELECT country, '', '', COUNT(*) n FROM listings GROUP BY country ORDER BY n DESC")?;
    let exchanges = pairs("SELECT mic, MAX(exchange), MAX(country), COUNT(*) n FROM listings GROUP BY mic ORDER BY n DESC")?;
    let kinds = pairs("SELECT kind, '', '', COUNT(*) n FROM listings GROUP BY kind ORDER BY n DESC")?;
    Ok(json!({ "countries": countries, "exchanges": exchanges, "kinds": kinds }))
}

pub fn status(db: &Connection) -> rusqlite::Result<Value> {
    let total: i64 = db.query_row("SELECT COUNT(*) FROM listings", [], |r| r.get(0))?;
    let (countries, exchanges): (i64, i64) =
        db.query_row("SELECT COUNT(DISTINCT country), COUNT(DISTINCT mic) FROM listings", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let meta: Option<(i64, i64, i64, i64)> = db
        .query_row("SELECT fetched, stocks, etfs, sec FROM universe_meta WHERE id=1", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .ok();
    Ok(json!({
        "listings": total, "countries": countries, "exchanges": exchanges,
        "fetched": meta.map(|m| m.0), "stocks": meta.map(|m| m.1), "etfs": meta.map(|m| m.2), "sec": meta.map(|m| m.3),
    }))
}

/// One listing by app key.
pub fn get(db: &Connection, key: &str) -> rusqlite::Result<Option<Value>> {
    use rusqlite::OptionalExtension;
    db.query_row(&format!("SELECT {COLS} FROM listings WHERE key=?1"), [key], row).optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    const STOCKS: &str = r#"{"data":[
        {"symbol":"AAPL","name":"Apple Inc.","currency":"USD","exchange":"NASDAQ","mic_code":"XNGS","country":"United States","type":"Common Stock","figi_code":"BBG000B9XRY4"},
        {"symbol":"AAPL","name":"Apple Inc.","currency":"USD","exchange":"IEX","mic_code":"IEXG","country":"","type":"Common Stock"},
        {"symbol":"APC","name":"Apple Inc.","currency":"EUR","exchange":"FSX","mic_code":"XFRA","country":"Germany","type":"Common Stock"},
        {"symbol":"VOD","name":"Vodafone Group Plc","currency":"GBp","exchange":"LSE","mic_code":"XLON","country":"United Kingdom","type":"Common Stock"},
        {"symbol":"BRK.B","name":"Berkshire Hathaway Inc.","currency":"USD","exchange":"NYSE","mic_code":"XNYS","country":"United States","type":"Common Stock"},
        {"symbol":"7203","name":"Toyota Motor Corp","currency":"JPY","exchange":"JPX","mic_code":"XJPX","country":"Japan","type":"Common Stock"}]}"#;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        let sec = parse_sec(r#"{"fields":["cik","name","ticker","exchange"],"data":[[1067983,"BERKSHIRE HATHAWAY INC","BRK-B","NYSE"],[320193,"Apple Inc.","AAPL","Nasdaq"],[999,"Tiny Co","TINY","OTC"]]}"#).unwrap();
        let mut list = parse_twelve(STOCKS, false).unwrap();
        list.extend(parse_twelve(r#"{"data":[{"symbol":"SPY","name":"SPDR S&P 500 ETF Trust","currency":"USD","exchange":"NYSE","mic_code":"ARCX","country":"United States"}]}"#, true).unwrap());
        let merged = merge(list, &sec);
        let mut c = c;
        replace(&mut c, &merged, (6, 1, 3)).unwrap();
        c
    }

    #[test]
    fn keys_tiers_and_merge() {
        let c = db();
        let s = status(&c).unwrap();
        assert_eq!(s["listings"], 7); // IEX copy of AAPL dropped, TINY added from SEC
        let vod = get(&c, "VOD:XLON").unwrap().unwrap();
        assert_eq!(vod["country"], "United Kingdom");
        let brk = get(&c, "BRK.B").unwrap().unwrap();
        assert_eq!(brk["cik"], "0001067983");
        assert_eq!(get(&c, "TINY").unwrap().unwrap()["source"], "SEC");
        assert_eq!(get(&c, "SPY").unwrap().unwrap()["kind"], "ETF");
        assert_eq!(tier("XFRA"), 2);
    }

    #[test]
    fn search_ranks_exact_ticker_and_home_listing_first() {
        let c = db();
        let r = search(&c, "apple", 10).unwrap();
        assert_eq!(r[0]["key"], "AAPL"); // US main listing before Frankfurt
        assert_eq!(r[1]["key"], "APC:XFRA");
        assert_eq!(search(&c, "7203", 5).unwrap()[0]["key"], "7203:XJPX");
        assert_eq!(search(&c, "vod:xlon", 5).unwrap()[0]["key"], "VOD:XLON");
        assert_eq!(search(&c, "%", 5).unwrap().as_array().unwrap().len(), 0);
    }

    #[test]
    fn browse_filters_and_counts() {
        let c = db();
        let all = browse(&c, &Filter { country: String::new(), mic: String::new(), kind: String::new(), q: String::new(), offset: 0, limit: 2 }).unwrap();
        assert_eq!(all["total"], 7);
        assert_eq!(all["rows"].as_array().unwrap().len(), 2);
        let jp = browse(&c, &Filter { country: "Japan".into(), mic: String::new(), kind: String::new(), q: String::new(), offset: 0, limit: 50 }).unwrap();
        assert_eq!(jp["total"], 1);
        let q = browse(&c, &Filter { country: String::new(), mic: String::new(), kind: "Stock".into(), q: "berk".into(), offset: 0, limit: 50 }).unwrap();
        assert_eq!(q["total"], 1);
        let f = facets(&c).unwrap();
        assert!(f["countries"].as_array().unwrap().len() >= 4);
    }
}

#[cfg(test)]
mod real_data {
    use super::*;
    /// UNI_STOCKS=stocks.json UNI_ETFS=etfs.json (Twelve Data downloads)
    #[test]
    #[ignore = "Parses real Twelve Data listing files from UNI_STOCKS/UNI_ETFS"]
    fn real_listing_files() {
        let (Ok(s), Ok(e)) = (std::env::var("UNI_STOCKS"), std::env::var("UNI_ETFS")) else { return };
        let t = std::time::Instant::now();
        let mut list = parse_twelve(&std::fs::read_to_string(s).unwrap(), false).unwrap();
        list.extend(parse_twelve(&std::fs::read_to_string(e).unwrap(), true).unwrap());
        let merged = merge(list, &[]);
        let mut db = Connection::open_in_memory().unwrap();
        init(&db).unwrap();
        let n = replace(&mut db, &merged, (0, 0, 0)).unwrap();
        eprintln!("{n} listings in {:?}", t.elapsed());
        for q in ["AAPL", "toyota", "SAP", "vodafone", "reliance", "BRK.B"] {
            let t = std::time::Instant::now();
            let r = search(&db, q, 3).unwrap();
            let keys: Vec<String> = r.as_array().unwrap().iter().map(|x| format!("{} ({})", x["key"].as_str().unwrap(), x["name"].as_str().unwrap())).collect();
            eprintln!("{q:>9} {:?}: {keys:?}", t.elapsed());
        }
        eprintln!("{}", status(&db).unwrap());
    }
}
