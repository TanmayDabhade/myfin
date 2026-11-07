//! Market map: every S&P 500 company with its sector, price, returns over
//! several horizons and market cap. Pure parts live here; the download job
//! is in the desktop binary.
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

/// Public S&P 500 constituents list (symbol, name, GICS sector and
/// sub-industry, SEC CIK), maintained as an open dataset.
pub const CONSTITUENTS_URL: &str = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Member {
    pub symbol: String,
    pub name: String,
    pub sector: String,
    pub industry: String,
    pub cik: u64,
}

/// Splits one CSV line, honouring double-quoted fields.
fn fields(line: &str) -> Vec<String> {
    let (mut out, mut cur, mut quoted) = (Vec::new(), String::new(), false);
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

pub fn parse_constituents(csv: &str) -> Result<Vec<Member>, String> {
    let mut lines = csv.lines();
    let head = fields(lines.next().ok_or("Empty constituents list")?);
    let col = |name: &str| head.iter().position(|h| h.trim() == name).ok_or(format!("Constituents list has no {name} column"));
    let (s, n, sec, ind, cik) = (col("Symbol")?, col("Security")?, col("GICS Sector")?, col("GICS Sub-Industry")?, col("CIK")?);
    let mut out = Vec::new();
    for line in lines.filter(|l| !l.trim().is_empty()) {
        let f = fields(line);
        let get = |i: usize| f.get(i).map(|x| x.trim().to_string()).unwrap_or_default();
        let symbol = get(s).to_ascii_uppercase();
        if symbol.is_empty() || symbol.len() > 10 || !symbol.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
            continue;
        }
        out.push(Member { symbol, name: get(n), sector: get(sec), industry: get(ind), cik: get(cik).parse().unwrap_or(0) });
    }
    if out.len() < 400 {
        return Err(format!("The constituents list looks incomplete ({} rows).", out.len()));
    }
    Ok(out)
}

/// SEC XBRL frames for cover-page shares outstanding: the current calendar
/// quarter and the two before it. Each frame holds one value per company.
pub fn frame_urls(now: i64) -> Vec<String> {
    let (y, m, _, _) = crate::providers::civil_date(now);
    let mut q = (y, (m - 1) / 3 + 1);
    let mut out = Vec::new();
    for _ in 0..3 {
        out.push(format!("https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/CY{}Q{}I.json", q.0, q.1));
        q = if q.1 == 1 { (q.0 - 1, 4) } else { (q.0, q.1 - 1) };
    }
    out
}
/// Adds a frame's values to `shares`, keeping the latest date per CIK.
pub fn merge_frame(shares: &mut HashMap<u64, (String, f64)>, frame: &Value) {
    for d in frame["data"].as_array().into_iter().flatten() {
        let (Some(cik), Some(end), Some(val)) = (d["cik"].as_u64(), d["end"].as_str(), d["val"].as_f64()) else { continue };
        if val <= 0.0 {
            continue;
        }
        if shares.get(&cik).is_none_or(|(e, _)| end > e.as_str()) {
            shares.insert(cik, (end.to_string(), val));
        }
    }
}
/// Latest cover-page shares from a company-concept response, summing share
/// classes reported for the same date in the same filing.
pub fn concept_shares(concept: &Value) -> Option<(String, f64)> {
    let facts = concept["units"]["shares"].as_array()?;
    let latest = facts.iter().filter_map(|f| f["end"].as_str()).max()?.to_string();
    let on: Vec<&Value> = facts.iter().filter(|f| f["end"].as_str() == Some(latest.as_str())).collect();
    let newest = on.iter().filter_map(|f| f["filed"].as_str()).max()?;
    let accn = on.iter().find(|f| f["filed"].as_str() == Some(newest))?["accn"].as_str()?.to_string();
    let total: f64 = on.iter().filter(|f| f["accn"].as_str() == Some(accn.as_str())).filter_map(|f| f["val"].as_f64()).sum();
    (total > 0.0).then_some((latest, total))
}

/// Returns over the screener's horizons from daily closes, oldest first.
/// Sessions are counted, as on the screener: 1, 5, 21, 63 and 252.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Returns {
    pub d1: Option<f64>,
    pub w1: Option<f64>,
    pub m1: Option<f64>,
    pub m3: Option<f64>,
    pub y1: Option<f64>,
    pub ytd: Option<f64>,
}
pub fn returns(closes: &[(String, f64)]) -> Returns {
    let Some((date, last)) = closes.last() else { return Returns::default() };
    let back = |n: usize| (closes.len() > n).then(|| closes[closes.len() - 1 - n].1).filter(|b| *b > 0.0).map(|b| last / b - 1.0);
    let year = &date[..4.min(date.len())];
    let ytd = closes.iter().rev().find(|(d, _)| &d[..4.min(d.len())] < year).map(|(_, c)| *c).filter(|b| *b > 0.0).map(|b| last / b - 1.0);
    Returns { d1: back(1), w1: back(5), m1: back(21), m3: back(63), y1: back(252), ytd }
}

#[derive(Serialize, Clone, Debug)]
pub struct Tile {
    pub symbol: String,
    pub name: String,
    pub sector: String,
    pub industry: String,
    pub price: Option<f64>,
    pub date: String,
    pub returns: Returns,
    /// Price × cover-page shares outstanding. Several share classes of one
    /// company (GOOGL and GOOG) split it evenly.
    pub cap: Option<f64>,
    pub shares_date: String,
}

/// Joins members, prices and shares into tiles.
pub fn tiles(members: &[Member], prices: &HashMap<String, (String, f64, Returns)>, shares: &HashMap<u64, (String, f64)>) -> Vec<Tile> {
    let mut classes: HashMap<u64, usize> = HashMap::new();
    for m in members.iter().filter(|m| m.cik > 0) {
        *classes.entry(m.cik).or_default() += 1;
    }
    members
        .iter()
        .map(|m| {
            let p = prices.get(&m.symbol);
            let sh = shares.get(&m.cik).filter(|_| m.cik > 0);
            let n = classes.get(&m.cik).copied().unwrap_or(1).max(1) as f64;
            Tile {
                symbol: m.symbol.clone(),
                name: m.name.clone(),
                sector: m.sector.clone(),
                industry: m.industry.clone(),
                price: p.map(|x| x.1),
                date: p.map(|x| x.0.clone()).unwrap_or_default(),
                returns: p.map(|x| x.2.clone()).unwrap_or_default(),
                cap: match (p, sh) {
                    (Some(p), Some((_, s))) => Some(p.1 * s / n),
                    _ => None,
                },
                shares_date: sh.map(|x| x.0.clone()).unwrap_or_default(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn csv() -> String {
        let mut s = String::from("Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location,Date added,CIK,Founded\n");
        s += "MMM,3M,Industrials,Industrial Conglomerates,\"Saint Paul, Minnesota\",1957-03-04,66740,1902\n";
        s += "BRK.B,\"Berkshire \"\"B\"\"\",Financials,Multi-Sector Holdings,\"Omaha, Nebraska\",2010-02-16,1067983,1839\n";
        for i in 0..420 {
            s += &format!("T{i},Test {i},Energy,Oil,\"X, Y\",2000-01-01,{},1900\n", 1000 + i);
        }
        s
    }
    #[test]
    fn parses_quoted_constituents() {
        let m = parse_constituents(&csv()).unwrap();
        assert_eq!(m[0], Member { symbol: "MMM".into(), name: "3M".into(), sector: "Industrials".into(), industry: "Industrial Conglomerates".into(), cik: 66740 });
        assert_eq!(m[1].symbol, "BRK.B");
        assert_eq!(m[1].name, "Berkshire \"B\"");
        assert!(parse_constituents("Symbol,Security\nA,B").is_err());
    }
    #[test]
    fn frames_cover_three_quarters_and_keep_the_latest() {
        // 2026-11-07
        let urls = frame_urls(1_794_076_205);
        assert!(urls[0].ends_with("CY2026Q4I.json") && urls[1].ends_with("CY2026Q3I.json") && urls[2].ends_with("CY2026Q2I.json"));
        assert!(frame_urls(1_767_312_000)[1].ends_with("CY2025Q4I.json")); // 2026-01-02
        let mut sh = HashMap::new();
        merge_frame(&mut sh, &json!({"data":[{"cik":1,"end":"2026-07-20","val":100.0},{"cik":2,"end":"2026-07-01","val":0.0}]}));
        merge_frame(&mut sh, &json!({"data":[{"cik":1,"end":"2026-10-20","val":90.0},{"cik":1,"end":"2026-01-01","val":5.0}]}));
        assert_eq!(sh[&1], ("2026-10-20".to_string(), 90.0));
        assert!(!sh.contains_key(&2));
    }
    #[test]
    fn concept_shares_sums_classes_of_the_latest_filing() {
        let c = json!({"units":{"shares":[
            {"end":"2026-07-20","val":5.0,"filed":"2026-08-01","accn":"a"},
            {"end":"2026-10-20","val":300.0,"filed":"2026-10-30","accn":"b"},
            {"end":"2026-10-20","val":200.0,"filed":"2026-10-30","accn":"b"},
            {"end":"2026-10-20","val":999.0,"filed":"2026-10-01","accn":"old"}
        ]}});
        assert_eq!(concept_shares(&c), Some(("2026-10-20".into(), 500.0)));
        assert_eq!(concept_shares(&json!({})), None);
    }
    #[test]
    fn returns_count_sessions_and_ytd() {
        let closes: Vec<(String, f64)> = (0..300).map(|i| (if i < 290 { format!("2025-{:04}", i) } else { format!("2026-{:04}", i) }, 100.0 + i as f64)).collect();
        let r = returns(&closes);
        assert_eq!(r.d1, Some(399.0 / 398.0 - 1.0));
        assert_eq!(r.y1, Some(399.0 / 147.0 - 1.0));
        assert_eq!(r.ytd, Some(399.0 / 389.0 - 1.0));
        assert_eq!(returns(&closes[..3]).w1, None);
        assert_eq!(returns(&[]), Returns::default());
    }
    #[test]
    fn tiles_split_cap_across_share_classes() {
        let members = vec![
            Member { symbol: "GOOGL".into(), name: "A".into(), sector: "S".into(), industry: "I".into(), cik: 7 },
            Member { symbol: "GOOG".into(), name: "C".into(), sector: "S".into(), industry: "I".into(), cik: 7 },
            Member { symbol: "X".into(), name: "X".into(), sector: "S".into(), industry: "I".into(), cik: 8 },
        ];
        let mut prices = HashMap::new();
        prices.insert("GOOGL".to_string(), ("2026-11-06".to_string(), 10.0, Returns::default()));
        prices.insert("X".to_string(), ("2026-11-06".to_string(), 2.0, Returns::default()));
        let mut shares = HashMap::new();
        shares.insert(7u64, ("2026-10-20".to_string(), 100.0));
        let t = tiles(&members, &prices, &shares);
        assert_eq!(t[0].cap, Some(500.0));
        assert_eq!(t[1].cap, None); // no price for GOOG
        assert_eq!(t[2].cap, None); // no shares for X
        assert_eq!(t[2].price, Some(2.0));
    }
}
