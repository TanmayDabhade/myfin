//! SEC Form 13F data sets. Every investment manager with $100M or more in
//! US-listed equities files its holdings each quarter, and SEC publishes all
//! of them as one bulk file per three-month filing window. This module
//! reduces those files to one row per manager, security and option type,
//! and answers "who holds this security" and "what does this manager hold".
//!
//! Tickers are not part of 13F data (securities are identified by CUSIP), so
//! a ticker-to-CUSIP map is built from SEC's fails-to-deliver files, which
//! list both, with issuer-name matching as a fallback.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek};

pub const LIST_URL: &str = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets";
pub const FTD_URL: &str = "https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data";
/// A quarter counts as reported once this many managers have filed for it.
/// Fewer means only late filers for a quarter whose data set isn't loaded.
pub const COMPLETE: i64 = if cfg!(test) { 1 } else { 1000 };
/// Fails-to-deliver files kept for the CUSIP map (two per month).
pub const FTD_FILES: usize = 12;

pub fn init(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS f13_sets(name TEXT PRIMARY KEY, loaded INTEGER NOT NULL, filings INTEGER, rows INTEGER);
         CREATE TABLE IF NOT EXISTS f13_filers(period INTEGER NOT NULL, cik INTEGER NOT NULL, accession TEXT NOT NULL, filed INTEGER NOT NULL,
            name TEXT, city TEXT, state TEXT, reported_total INTEGER, total INTEGER, positions INTEGER, PRIMARY KEY(period,cik)) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS f13_pos(cusip TEXT NOT NULL, period INTEGER NOT NULL, cik INTEGER NOT NULL, putcall INTEGER NOT NULL,
            value INTEGER, shares INTEGER, sh_type INTEGER, discretion INTEGER, sole INTEGER, shared INTEGER, none INTEGER, rank INTEGER,
            PRIMARY KEY(cusip,period,cik,putcall)) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS f13_pos_filer ON f13_pos(cik,period);
         CREATE TABLE IF NOT EXISTS f13_names(cusip TEXT PRIMARY KEY, issuer TEXT, class TEXT, norm TEXT, period INTEGER);
         CREATE INDEX IF NOT EXISTS f13_names_norm ON f13_names(norm);
         CREATE TABLE IF NOT EXISTS cusip_map(ticker TEXT NOT NULL, cusip TEXT NOT NULL, name TEXT, seen INTEGER, PRIMARY KEY(ticker,cusip)) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS cusip_map_cusip ON cusip_map(cusip);
         CREATE TABLE IF NOT EXISTS f13_added(accession TEXT PRIMARY KEY);
         CREATE TABLE IF NOT EXISTS ftd_files(name TEXT PRIMARY KEY);",
    )
}

const DISCRETION: [&str; 4] = ["", "Sole", "Shared", "Other"];
const MONTHS: [&str; 12] = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/// "30-JUN-2026" (or "30jun2026") as 20260630.
pub fn date(s: &str) -> Option<u32> {
    let s = s.trim();
    let (d, m, y) = if s.contains('-') {
        let mut p = s.split('-');
        (p.next()?, p.next()?, p.next()?)
    } else {
        if s.len() != 9 {
            return None;
        }
        (&s[..2], &s[2..5], &s[5..])
    };
    let m = MONTHS.iter().position(|x| x.eq_ignore_ascii_case(m))? as u32 + 1;
    let d: u32 = d.parse().ok()?;
    let y: u32 = y.parse().ok()?;
    if !(1..=31).contains(&d) || !(1980..=2200).contains(&y) {
        return None;
    }
    Some(y * 10_000 + m * 100 + d)
}

/// "2026-06-30" for 20260630.
pub fn iso(d: u32) -> String {
    format!("{:04}-{:02}-{:02}", d / 10_000, d / 100 % 100, d % 100)
}

/// Upper-case CUSIP, restoring leading zeros that spreadsheets strip.
pub fn cusip(raw: &str) -> Option<String> {
    let c = raw.trim().to_ascii_uppercase();
    if c.len() > 9 || c.len() < 7 || !c.chars().all(|x| x.is_ascii_alphanumeric()) {
        return None;
    }
    Some(format!("{c:0>9}"))
}

/// Tickers compared without punctuation: SEC writes BRKB, BRK-B or BRK.B.
pub fn ticker_key(t: &str) -> String {
    t.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_uppercase()
}

const NAME_NOISE: [&str; 34] = [
    "INCORPORATED", "INC", "CORPORATION", "CORP", "COMPANY", "CO", "LIMITED", "LTD", "PLC", "LLC", "LP", "HOLDING",
    "HOLDINGS", "GROUP", "SA", "NV", "AG", "SE", "THE", "DE", "DEL", "NEW", "COM", "SHS", "CL", "CLASS", "A", "ADR",
    "ADS", "SPONSORED", "ORD", "COMMON", "STOCK", "ETF",
];

/// Issuer name reduced for matching: "Apple Inc." and "APPLE INC COM" agree.
pub fn issuer_key(name: &str) -> String {
    let up = name.to_ascii_uppercase().replace('&', " AND ");
    let clean: String = up.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' }).collect();
    clean.split_whitespace().filter(|w| !NAME_NOISE.contains(w)).collect::<Vec<_>>().join(" ")
}

/// Column positions by header name, so a reordered file still parses.
fn columns(header: &str, names: &[&str]) -> Result<Vec<usize>, String> {
    let head: Vec<&str> = header.trim_end_matches(['\r', '\n']).split('\t').collect();
    names
        .iter()
        .map(|n| head.iter().position(|h| h.eq_ignore_ascii_case(n)).ok_or(format!("13F data set is missing the {n} column")))
        .collect()
}

fn table(text: &str, names: &[&str]) -> Result<Vec<Vec<String>>, String> {
    let mut lines = text.lines();
    let idx = columns(lines.next().unwrap_or(""), names)?;
    Ok(lines
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            idx.iter().map(|i| f.get(*i).unwrap_or(&"").trim().to_string()).collect()
        })
        .collect())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Filing {
    pub accession: String,
    pub cik: u32,
    pub period: u32,
    pub filed: u32,
    /// A "new holdings" amendment adds rows to the filing it amends.
    pub addition: bool,
    pub name: String,
    pub city: String,
    pub state: String,
    pub reported_total: i64,
}

/// The filings that count in one data set: per manager and quarter, the
/// latest original or restatement, plus any "new holdings" amendments filed
/// after it. Notices (13F-NT) carry no holdings and are skipped.
pub fn select(submission: &str, cover: &str, summary: &str) -> Result<HashMap<String, Filing>, String> {
    let subs = table(submission, &["ACCESSION_NUMBER", "FILING_DATE", "SUBMISSIONTYPE", "CIK", "PERIODOFREPORT"])?;
    let covers: HashMap<String, Vec<String>> = table(
        cover,
        &["ACCESSION_NUMBER", "ISAMENDMENT", "AMENDMENTTYPE", "FILINGMANAGER_NAME", "FILINGMANAGER_CITY", "FILINGMANAGER_STATEORCOUNTRY", "REPORTTYPE"],
    )?
    .into_iter()
    .map(|r| (r[0].clone(), r))
    .collect();
    let totals: HashMap<String, i64> = table(summary, &["ACCESSION_NUMBER", "TABLEVALUETOTAL"])?
        .into_iter()
        .map(|r| (r[0].clone(), r[1].parse().unwrap_or(0)))
        .collect();
    let mut bases: HashMap<(u32, u32), Filing> = HashMap::new();
    let mut additions: Vec<Filing> = Vec::new();
    for s in subs {
        let kind = s[2].to_ascii_uppercase();
        if kind != "13F-HR" && kind != "13F-HR/A" {
            continue;
        }
        let (Some(filed), Some(period), Ok(cik)) = (date(&s[1]), date(&s[4]), s[3].parse::<u32>()) else { continue };
        let c = covers.get(&s[0]);
        let field = |i: usize| c.map(|r| r[i].clone()).unwrap_or_default();
        if field(6).to_ascii_uppercase().contains("NOTICE") {
            continue;
        }
        let addition = kind == "13F-HR/A" && field(2).to_ascii_uppercase().contains("NEW HOLDINGS");
        let f = Filing {
            accession: s[0].clone(),
            cik,
            period,
            filed,
            addition,
            name: field(3),
            city: field(4),
            state: field(5),
            reported_total: *totals.get(&s[0]).unwrap_or(&0),
        };
        if addition {
            additions.push(f);
        } else {
            let newer = bases.get(&(cik, period)).map_or(true, |b| (f.filed, &f.accession) > (b.filed, &b.accession));
            if newer {
                bases.insert((cik, period), f);
            }
        }
    }
    let mut out: HashMap<String, Filing> = HashMap::new();
    for a in additions {
        // An addition filed before the latest restatement is already part of it.
        let superseded = bases.get(&(a.cik, a.period)).is_some_and(|b| (b.filed, &b.accession) >= (a.filed, &a.accession));
        if !superseded {
            out.insert(a.accession.clone(), a);
        }
    }
    for b in bases.into_values() {
        out.insert(b.accession.clone(), b);
    }
    Ok(out)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pos {
    pub value: i64,
    pub shares: i64,
    /// 0 shares, 1 principal amount (bonds).
    pub sh_type: u8,
    /// 1 sole, 2 shared-defined, 3 other.
    pub discretion: u8,
    pub sole: i64,
    pub shared: i64,
    pub none: i64,
    pub rank: Option<u32>,
    biggest: i64,
}

/// Key of one aggregated row: CUSIP and 0 (shares), 1 (put) or 2 (call).
pub type Key = (String, u8);

/// Infotable column order used by `add_line`.
pub const INFO_COLUMNS: [&str; 12] = [
    "ACCESSION_NUMBER", "NAMEOFISSUER", "TITLEOFCLASS", "CUSIP", "VALUE", "SSHPRNAMT", "SSHPRNAMTTYPE", "PUTCALL",
    "INVESTMENTDISCRETION", "VOTING_AUTH_SOLE", "VOTING_AUTH_SHARED", "VOTING_AUTH_NONE",
];

/// Adds one infotable line to a filing's rows. Managers often report the
/// same security on several lines (per sub-adviser or discretion type).
pub fn add_line(rows: &mut HashMap<Key, Pos>, f: &[&str]) -> Option<Key> {
    let num = |i: usize| f.get(i).and_then(|x| x.trim().parse::<f64>().ok()).unwrap_or(0.0) as i64;
    let cusip = cusip(f.get(3)?)?;
    let putcall = match f.get(7).map(|x| x.trim().to_ascii_uppercase()) {
        Some(p) if p == "PUT" => 1,
        Some(p) if p == "CALL" => 2,
        _ => 0,
    };
    let value = num(4);
    let p = rows.entry((cusip.clone(), putcall)).or_default();
    p.value += value;
    p.shares += num(5);
    p.sole += num(9);
    p.shared += num(10);
    p.none += num(11);
    if f.get(6).is_some_and(|x| x.trim().eq_ignore_ascii_case("PRN")) {
        p.sh_type = 1;
    }
    if value >= p.biggest || p.discretion == 0 {
        p.biggest = value;
        p.discretion = match f.get(8).map(|x| x.trim().to_ascii_uppercase()).as_deref() {
            Some("SOLE") => 1,
            Some("DFND") => 2,
            Some("OTR") => 3,
            _ => p.discretion,
        };
    }
    Some((cusip, putcall))
}

/// Ranks share positions (not options) by value, 1 = largest holding.
pub fn rank(rows: &mut HashMap<Key, Pos>) {
    let mut order: Vec<(&Key, i64)> = rows.iter().filter(|(k, _)| k.1 == 0).map(|(k, p)| (k, p.value)).collect();
    order.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let ranks: Vec<(Key, u32)> = order.iter().enumerate().map(|(i, (k, _))| ((*k).clone(), i as u32 + 1)).collect();
    for (k, r) in ranks {
        if let Some(p) = rows.get_mut(&k) {
            p.rank = Some(r);
        }
    }
}

fn merge(into: &mut HashMap<Key, Pos>, from: HashMap<Key, Pos>) {
    for (k, p) in from {
        let t = into.entry(k).or_default();
        t.value += p.value;
        t.shares += p.shares;
        t.sole += p.sole;
        t.shared += p.shared;
        t.none += p.none;
        t.sh_type = t.sh_type.max(p.sh_type);
        if t.discretion == 0 {
            t.discretion = p.discretion;
        }
    }
}

fn entry_text<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Result<String, String> {
    let mut f = zip.by_name(name).map_err(|_| format!("13F data set has no {name}"))?;
    let mut b = Vec::new();
    f.read_to_end(&mut b).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&b).into_owned())
}

/// Streams INFOTABLE.tsv, calling `run` once per filing with its rows.
/// Rows of one filing are contiguous in SEC's files.
fn each_filing<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    wanted: &dyn Fn(&str) -> bool,
    progress: &mut dyn FnMut(u64, u64),
    names: &mut Option<&mut HashMap<String, HashMap<(String, String), u32>>>,
    run: &mut dyn FnMut(&str, HashMap<Key, Pos>) -> Result<(), String>,
) -> Result<u64, String> {
    let entry = zip.by_name("INFOTABLE.tsv").map_err(|_| "13F data set has no INFOTABLE.tsv".to_string())?;
    let total = entry.size().max(1);
    let mut r = BufReader::with_capacity(1 << 20, entry);
    let mut line = Vec::new();
    r.read_until(b'\n', &mut line).map_err(|e| e.to_string())?;
    let idx = columns(&String::from_utf8_lossy(&line), &INFO_COLUMNS)?;
    let (mut read, mut lines, mut current, mut rows) = (line.len() as u64, 0u64, String::new(), HashMap::new());
    loop {
        line.clear();
        let n = r.read_until(b'\n', &mut line).map_err(|e| e.to_string())?;
        read += n as u64;
        let text = String::from_utf8_lossy(&line);
        let f: Vec<&str> = text.trim_end_matches(['\r', '\n']).split('\t').collect();
        let acc = if n == 0 { "" } else { f.get(idx[0]).copied().unwrap_or("") };
        if acc != current {
            if !current.is_empty() && wanted(&current) {
                run(&current, std::mem::take(&mut rows))?;
            }
            rows.clear();
            current = acc.to_string();
            if lines % 64 == 0 {
                progress(read, total);
            }
        }
        if n == 0 {
            break;
        }
        lines += 1;
        if !wanted(acc) {
            continue;
        }
        let picked: Vec<&str> = idx.iter().map(|i| f.get(*i).copied().unwrap_or("")).collect();
        if let (Some(key), Some(names)) = (add_line(&mut rows, &picked), names.as_deref_mut()) {
            if key.1 == 0 {
                let by = names.entry(key.0).or_default();
                *by.entry((picked[1].trim().to_string(), picked[2].trim().to_string())).or_default() += 1;
            }
        }
    }
    progress(total, total);
    Ok(lines)
}

/// Loads one SEC 13F data set (the zip as published) into the database.
/// Filings the database already has a same-or-newer version of are skipped,
/// so sets can be loaded in any order.
pub fn ingest<R: Read + Seek>(db: &mut Connection, archive: R, set: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<Value, String> {
    let e = |x: rusqlite::Error| x.to_string();
    let mut zip = zip::ZipArchive::new(archive).map_err(|_| "The 13F download is not a valid zip file".to_string())?;
    let filings = select(&entry_text(&mut zip, "SUBMISSION.tsv")?, &entry_text(&mut zip, "COVERPAGE.tsv")?, &entry_text(&mut zip, "SUMMARYPAGE.tsv")?)?;
    let tx = db.transaction().map_err(e)?;
    let mut keep: HashMap<String, Filing> = HashMap::new();
    let mut replace: Vec<(u32, u32)> = Vec::new();
    {
        let mut q = tx.prepare("SELECT filed, accession FROM f13_filers WHERE period=?1 AND cik=?2").map_err(e)?;
        let mut applied = tx.prepare("SELECT 1 FROM f13_added WHERE accession=?1").map_err(e)?;
        for f in filings.into_values() {
            if f.addition && applied.exists([&f.accession]).map_err(e)? {
                continue;
            }
            let stored: Option<(u32, String)> = q.query_row(params![f.period, f.cik], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(e)?;
            match &stored {
                Some((filed, acc)) if (*filed, acc.as_str()) >= (f.filed, f.accession.as_str()) => continue,
                Some(_) if !f.addition => replace.push((f.period, f.cik)),
                _ => {}
            }
            keep.insert(f.accession.clone(), f);
        }
    }
    if !replace.is_empty() {
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS f13_old(period INTEGER, cik INTEGER, PRIMARY KEY(period,cik)); DELETE FROM f13_old;").map_err(e)?;
        for (p, c) in &replace {
            tx.execute("INSERT OR IGNORE INTO f13_old VALUES(?1,?2)", params![p, c]).map_err(e)?;
        }
        tx.execute_batch(
            "DELETE FROM f13_pos WHERE EXISTS (SELECT 1 FROM f13_old o WHERE o.period=f13_pos.period AND o.cik=f13_pos.cik);
             DELETE FROM f13_filers WHERE EXISTS (SELECT 1 FROM f13_old o WHERE o.period=f13_filers.period AND o.cik=f13_filers.cik);",
        )
        .map_err(e)?;
    }
    // Pass 1: rows of "new holdings" amendments, merged into their filing below.
    let mut extra: HashMap<(u32, u32), HashMap<Key, Pos>> = HashMap::new();
    let has_additions = keep.values().any(|f| f.addition);
    if has_additions {
        let is_add = |a: &str| keep.get(a).is_some_and(|f| f.addition);
        each_filing(&mut zip, &is_add, &mut |_: u64, _: u64| {}, &mut None, &mut |acc, rows| {
            let f = &keep[acc];
            merge(extra.entry((f.period, f.cik)).or_default(), rows);
            Ok(())
        })?;
    }
    // Pass 2: each filing's rows, ranked and written.
    let mut names: HashMap<String, HashMap<(String, String), u32>> = HashMap::new();
    let (mut written, mut filings_written) = (0u64, 0u64);
    let latest_period = keep.values().filter(|f| !f.addition).map(|f| f.period).max().unwrap_or(0);
    {
        let mut pos = tx
            .prepare(
                "INSERT INTO f13_pos(cusip,period,cik,putcall,value,shares,sh_type,discretion,sole,shared,none,rank) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                 ON CONFLICT(cusip,period,cik,putcall) DO UPDATE SET value=value+excluded.value, shares=shares+excluded.shares,
                 sole=sole+excluded.sole, shared=shared+excluded.shared, none=none+excluded.none",
            )
            .map_err(e)?;
        let mut filer = tx
            .prepare("INSERT OR REPLACE INTO f13_filers(period,cik,accession,filed,name,city,state,reported_total,total,positions) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)")
            .map_err(e)?;
        let is_base = |a: &str| keep.get(a).is_some_and(|f| !f.addition);
        let mut write = |f: &Filing, rows: &HashMap<Key, Pos>| -> Result<(), String> {
            for ((c, pc), p) in rows {
                pos.execute(params![c, f.period, f.cik, pc, p.value, p.shares, p.sh_type, p.discretion, p.sole, p.shared, p.none, p.rank]).map_err(e)?;
            }
            let total: i64 = rows.values().map(|p| p.value).sum();
            filer
                .execute(params![f.period, f.cik, f.accession, f.filed, f.name, f.city, f.state, f.reported_total, total, rows.len() as i64])
                .map_err(e)?;
            Ok(())
        };
        each_filing(&mut zip, &is_base, progress, &mut Some(&mut names), &mut |acc, mut rows| {
            let f = &keep[acc];
            if let Some(more) = extra.remove(&(f.period, f.cik)) {
                merge(&mut rows, more);
            }
            rank(&mut rows);
            written += rows.len() as u64;
            filings_written += 1;
            write(f, &rows)
        })?;
        // Amendments to a filing loaded from another data set.
        for ((period, cik), rows) in extra.drain() {
            for ((c, pc), p) in &rows {
                pos.execute(params![c, period, cik, pc, p.value, p.shares, p.sh_type, p.discretion, p.sole, p.shared, p.none, Option::<u32>::None]).map_err(e)?;
            }
            let added: i64 = rows.values().map(|p| p.value).sum();
            tx.execute("UPDATE f13_filers SET total=total+?3, positions=positions+?4 WHERE period=?1 AND cik=?2", params![period, cik, added, rows.len() as i64])
                .map_err(e)?;
            written += rows.len() as u64;
        }
    }
    {
        let mut up = tx
            .prepare(
                "INSERT INTO f13_names(cusip,issuer,class,norm,period) VALUES(?1,?2,?3,?4,?5)
                 ON CONFLICT(cusip) DO UPDATE SET issuer=excluded.issuer, class=excluded.class, norm=excluded.norm, period=excluded.period WHERE excluded.period>=f13_names.period",
            )
            .map_err(e)?;
        for (c, by) in names {
            if let Some(((issuer, class), _)) = by.into_iter().max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0))) {
                up.execute(params![c, issuer, class, issuer_key(&issuer), latest_period]).map_err(e)?;
            }
        }
    }
    for f in keep.values().filter(|f| f.addition) {
        tx.execute("INSERT OR IGNORE INTO f13_added(accession) VALUES(?1)", [&f.accession]).map_err(e)?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO f13_sets(name,loaded,filings,rows) VALUES(?1,strftime('%s','now'),?2,?3)",
        params![set, filings_written as i64, written as i64],
    )
    .map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(json!({ "set": set, "filings": filings_written, "rows": written }))
}

/// Quarters with a full set of filings, newest first, with manager counts.
pub fn periods(db: &Connection) -> rusqlite::Result<Vec<(u32, i64)>> {
    let mut q = db.prepare("SELECT period, COUNT(*) n FROM f13_filers GROUP BY period HAVING n >= ?1 ORDER BY period DESC")?;
    let rows = q.query_map([COMPLETE], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Keeps the newest `quarters` complete quarters and drops older data.
pub fn prune(db: &Connection, quarters: usize) -> rusqlite::Result<usize> {
    let p = periods(db)?;
    let Some(&(cutoff, _)) = p.get(quarters.max(1) - 1) else { return Ok(0) };
    let n = db.execute("DELETE FROM f13_pos WHERE period < ?1", [cutoff])?;
    db.execute("DELETE FROM f13_filers WHERE period < ?1", [cutoff])?;
    Ok(n)
}

/// Links to published 13F data sets, newest filing window first.
pub fn set_links(html: &str) -> Vec<(String, String)> {
    let mut out: Vec<(u32, String, String)> = Vec::new();
    for part in html.split("href=\"").skip(1) {
        let Some(path) = part.split('"').next() else { continue };
        if !path.starts_with("/files/") || !path.ends_with("_form13f.zip") || !path.chars().all(|c| c.is_ascii_alphanumeric() || "/-_.".contains(c)) {
            continue;
        }
        let name = path.rsplit('/').next().unwrap_or("").trim_end_matches(".zip").to_string();
        let Some(end) = name.split('_').next().and_then(|w| w.split('-').nth(1)).and_then(date) else { continue };
        if !out.iter().any(|x| x.1 == name) {
            out.push((end, name, path.to_string()));
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, n, p)| (n, p)).collect()
}

/// Links to fails-to-deliver files, newest first.
pub fn ftd_links(html: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for part in html.split("href=\"").skip(1) {
        let Some(path) = part.split('"').next() else { continue };
        let name = path.rsplit('/').next().unwrap_or("").trim_end_matches(".zip");
        let ok = path.starts_with("/files/")
            && path.ends_with(".zip")
            && name.len() == 15
            && name.starts_with("cnsfails")
            && name[8..14].chars().all(|c| c.is_ascii_digit())
            && name.ends_with(['a', 'b'])
            && path.chars().all(|c| c.is_ascii_alphanumeric() || "/-_.".contains(c));
        if ok && !out.iter().any(|x| x.0 == name) {
            out.push((name.to_string(), path.to_string()));
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}

/// (ticker, CUSIP) -> (description, latest settlement date) from one
/// fails-to-deliver file: SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY|DESCRIPTION|PRICE.
pub fn parse_ftd(text: &str) -> HashMap<(String, String), (String, u32)> {
    let mut out: HashMap<(String, String), (String, u32)> = HashMap::new();
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split('|').collect();
        if f.len() < 5 {
            continue;
        }
        let (Ok(d), Some(c)) = (f[0].trim().parse::<u32>(), cusip(f[1])) else { continue };
        let t = ticker_key(f[2]);
        if t.is_empty() || t.len() > 12 {
            continue;
        }
        let e = out.entry((t, c)).or_insert((String::new(), 0));
        if d >= e.1 {
            *e = (f[4].trim().to_string(), d);
        }
    }
    out
}

pub fn store_ftd(db: &mut Connection, name: &str, map: &HashMap<(String, String), (String, u32)>) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    {
        let mut q = tx.prepare(
            "INSERT INTO cusip_map(ticker,cusip,name,seen) VALUES(?1,?2,?3,?4)
             ON CONFLICT(ticker,cusip) DO UPDATE SET name=excluded.name, seen=excluded.seen WHERE excluded.seen>=cusip_map.seen",
        )?;
        for ((t, c), (n, d)) in map {
            q.execute(params![t, c, n, d])?;
        }
    }
    tx.execute("INSERT OR IGNORE INTO ftd_files(name) VALUES(?1)", [name])?;
    tx.commit()
}

fn latest_two(db: &Connection, period: Option<u32>) -> rusqlite::Result<(Option<u32>, Option<u32>, Vec<(u32, i64)>)> {
    let all = periods(db)?;
    let cur = match period {
        Some(p) if all.iter().any(|x| x.0 == p) => Some(p),
        _ => all.first().map(|x| x.0),
    };
    let prev = cur.and_then(|c| all.iter().find(|x| x.0 < c).map(|x| x.0));
    Ok((cur, prev, all))
}

fn security(db: &Connection, c: &str, period: Option<u32>, source: &str) -> rusqlite::Result<Value> {
    let (issuer, class): (Option<String>, Option<String>) =
        db.query_row("SELECT issuer, class FROM f13_names WHERE cusip=?1", [c], |r| Ok((r.get(0)?, r.get(1)?))).optional()?.unwrap_or((None, None));
    let (holders, value): (i64, Option<i64>) = db.query_row(
        "SELECT COUNT(*), SUM(value) FROM f13_pos WHERE cusip=?1 AND period=?2 AND putcall=0",
        params![c, period.unwrap_or(0)],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(json!({ "cusip": c, "issuer": issuer, "class": class, "holders": holders, "value": value, "source": source }))
}

/// CUSIPs that stand for a ticker: from the fails-to-deliver map, any the
/// caller already knows (13G cover pages list one), else by issuer name.
/// Also lists the issuer's other securities (share classes, notes).
pub fn resolve(db: &Connection, ticker: &str, name: &str, extra: &[String], period: Option<u32>) -> rusqlite::Result<Value> {
    let period = latest_two(db, period)?.0;
    let mut found: Vec<(String, &str)> = Vec::new();
    {
        let mut q = db.prepare("SELECT cusip FROM cusip_map WHERE ticker=?1 ORDER BY seen DESC")?;
        for c in q.query_map([ticker_key(ticker)], |r| r.get::<_, String>(0))? {
            found.push((c?, "SEC fails-to-deliver list"));
        }
    }
    for c in extra.iter().filter_map(|c| cusip(c)) {
        if !found.iter().any(|f| f.0 == c) {
            found.push((c, "Schedule 13D/G cover page"));
        }
    }
    // Same issuer name too: catches a CUSIP the company had before a
    // reorganization. Skips other share classes (mapped to other tickers)
    // and debt, preferred and warrants.
    let key = issuer_key(name);
    if key.len() >= 3 {
        let tk = ticker_key(ticker);
        let mut q = db.prepare(
            "SELECT cusip FROM f13_names n WHERE norm=?1
               AND NOT EXISTS (SELECT 1 FROM cusip_map m WHERE m.cusip=n.cusip AND m.ticker<>?2)
               AND class NOT LIKE '%NOTE%' AND class NOT LIKE '%PFD%' AND class NOT LIKE '%PREF%' AND class NOT LIKE '%WT%'
               AND class NOT LIKE '%WARR%' AND class NOT LIKE '%RIGHT%' AND class NOT LIKE '%DEB%' AND class NOT LIKE '%BOND%'
               AND class NOT LIKE '%CALL%' AND class NOT LIKE '%PUT%' AND class NOT LIKE '%OPTION%'",
        )?;
        let named: Vec<String> = q.query_map(params![&key, &tk], |r| r.get(0))?.collect::<Result<_, _>>()?;
        // With a mapped CUSIP in hand, only a different issuer entity (a
        // reorganization, new first six characters) with real holders is
        // added; the same issuer's other classes stay under "related".
        let mapped: Vec<String> = found.iter().map(|f| f.0[..6].to_string()).collect();
        for c in named {
            if found.iter().any(|f| f.0 == c) {
                continue;
            }
            if !mapped.is_empty() {
                let n: i64 = db.query_row(
                    "SELECT COUNT(*) FROM f13_pos WHERE cusip=?1 AND period=?2 AND putcall=0",
                    params![c, period.unwrap_or(0)],
                    |r| r.get(0),
                )?;
                if mapped.contains(&c[..6].to_string()) || n < 25 {
                    continue;
                }
            }
            found.push((c, "Issuer name match"));
        }
    }
    let mut securities = Vec::new();
    for (c, source) in &found {
        let s = security(db, c, period, source)?;
        if s["holders"].as_i64().unwrap_or(0) > 0 || source.starts_with("SEC") {
            securities.push(s);
        }
    }
    // Same first six characters = same issuer.
    let mut related = Vec::new();
    let prefixes: Vec<String> = found.iter().map(|f| f.0[..6].to_string()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    for p in prefixes {
        let mut q = db.prepare("SELECT cusip FROM f13_names WHERE cusip >= ?1 AND cusip < ?2")?;
        let ids: Vec<String> = q.query_map(params![p, format!("{p}~")], |r| r.get(0))?.collect::<Result<_, _>>()?;
        for c in ids {
            if !found.iter().any(|f| f.0 == c) {
                let s = security(db, &c, period, "Same issuer")?;
                if s["holders"].as_i64().unwrap_or(0) > 0 {
                    related.push(s);
                }
            }
        }
    }
    Ok(json!({ "securities": securities, "related": related }))
}

fn sql_list(n: usize, from: usize) -> String {
    (0..n).map(|i| format!("?{}", i + from)).collect::<Vec<_>>().join(",")
}

/// Every manager's position in the given CUSIPs for one quarter and the
/// quarter before it, with each manager's portfolio size, plus ownership
/// history across all stored quarters.
pub fn holders(db: &Connection, cusips: &[String], period: Option<u32>) -> rusqlite::Result<Value> {
    let (cur, prev, all) = latest_two(db, period)?;
    let ids: Vec<String> = cusips.iter().filter_map(|c| cusip(c)).take(20).collect();
    let quarters: Vec<Value> = all.iter().map(|(p, n)| json!({ "period": iso(*p), "filers": n })).collect();
    if ids.is_empty() || cur.is_none() {
        return Ok(json!({ "period": cur.map(iso), "prior": prev.map(iso), "quarters": quarters, "rows": [], "history": [], "tenure": {} }));
    }
    let list = sql_list(ids.len(), 3);
    let mut args: Vec<rusqlite::types::Value> = vec![cur.unwrap_or(0).into(), prev.unwrap_or(0).into()];
    args.extend(ids.iter().map(|c| rusqlite::types::Value::from(c.clone())));
    let sql = format!(
        "SELECT p.period, p.cik, p.putcall, SUM(p.value), SUM(p.shares), MAX(p.sh_type), MAX(p.discretion), SUM(p.sole), SUM(p.shared), SUM(p.none), MIN(p.rank),
                f.name, f.city, f.state, f.total, f.positions, f.accession, f.filed
         FROM f13_pos p JOIN f13_filers f ON f.period=p.period AND f.cik=p.cik
         WHERE p.period IN (?1,?2) AND p.cusip IN ({list})
         GROUP BY p.period, p.cik, p.putcall"
    );
    let mut q = db.prepare(&sql)?;
    let rows: Vec<Value> = q
        .query_map(rusqlite::params_from_iter(args.iter()), |r| {
            Ok(json!({
                "period": iso(r.get::<_, u32>(0)?), "cik": r.get::<_, u32>(1)?, "putcall": r.get::<_, u8>(2)?,
                "value": r.get::<_, i64>(3)?, "shares": r.get::<_, i64>(4)?, "prn": r.get::<_, u8>(5)? == 1,
                "discretion": DISCRETION[r.get::<_, u8>(6)?.min(3) as usize],
                "sole": r.get::<_, i64>(7)?, "shared": r.get::<_, i64>(8)?, "none": r.get::<_, i64>(9)?, "rank": r.get::<_, Option<u32>>(10)?,
                "name": r.get::<_, Option<String>>(11)?, "city": r.get::<_, Option<String>>(12)?, "state": r.get::<_, Option<String>>(13)?,
                "portfolio": r.get::<_, Option<i64>>(14)?, "positions": r.get::<_, Option<i64>>(15)?,
                "accession": r.get::<_, String>(16)?, "filed": iso(r.get::<_, u32>(17)?),
            }))
        })?
        .collect::<Result<_, _>>()?;
    let list1 = sql_list(ids.len(), 1);
    let id_args = || rusqlite::params_from_iter(ids.iter());
    let mut h = db.prepare(&format!(
        "SELECT period, putcall, COUNT(DISTINCT cik), SUM(shares), SUM(value) FROM f13_pos WHERE cusip IN ({list1}) GROUP BY period, putcall ORDER BY period"
    ))?;
    let mut history: Vec<Value> = Vec::new();
    for r in h.query_map(id_args(), |r| Ok((r.get::<_, u32>(0)?, r.get::<_, u8>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?)))? {
        let (p, pc, n, sh, v) = r?;
        if !all.iter().any(|x| x.0 == p) {
            continue; // late filers for a quarter that isn't loaded
        }
        let label = iso(p);
        if !history.last().is_some_and(|x| x["period"] == label) {
            history.push(json!({ "period": label, "holders": 0, "shares": 0, "value": 0, "putHolders": 0, "putShares": 0, "callHolders": 0, "callShares": 0 }));
        }
        let x = history.last_mut().unwrap();
        let (hk, sk) = match pc {
            1 => ("putHolders", "putShares"),
            2 => ("callHolders", "callShares"),
            _ => ("holders", "shares"),
        };
        x[hk] = n.into();
        x[sk] = sh.into();
        if pc == 0 {
            x["value"] = v.into();
        }
    }
    let mut t = db.prepare(&format!(
        "SELECT cik, COUNT(DISTINCT period), MIN(period) FROM f13_pos WHERE cusip IN ({list1}) AND putcall=0 GROUP BY cik"
    ))?;
    let mut tenure = serde_json::Map::new();
    for r in t.query_map(id_args(), |r| Ok((r.get::<_, u32>(0)?, r.get::<_, i64>(1)?, r.get::<_, u32>(2)?)))? {
        let (cik, n, first) = r?;
        tenure.insert(cik.to_string(), json!({ "quarters": n, "since": iso(first) }));
    }
    // A prior holder missing this quarter either sold out (it filed without
    // the position) or hasn't filed yet; only the first is an exit.
    let mut held_now = std::collections::HashSet::new();
    let mut held_before = std::collections::BTreeSet::new();
    for r in &rows {
        let cik = r["cik"].as_u64().unwrap_or(0);
        if r["period"] == json!(cur.map(iso)) {
            held_now.insert(cik);
        } else {
            held_before.insert(cik);
        }
    }
    let mut reported = Vec::new();
    {
        let mut q = db.prepare("SELECT 1 FROM f13_filers WHERE period=?1 AND cik=?2")?;
        for cik in held_before.iter().filter(|c| !held_now.contains(c)) {
            if q.exists(params![cur.unwrap_or(0), cik])? {
                reported.push(*cik);
            }
        }
    }
    Ok(json!({ "period": cur.map(iso), "prior": prev.map(iso), "quarters": quarters, "rows": rows, "history": history, "tenure": tenure, "reported": reported }))
}

/// One manager's full portfolio for a quarter and the quarter before.
pub fn portfolio(db: &Connection, cik: u32, period: Option<u32>) -> rusqlite::Result<Value> {
    let (cur, prev, all) = latest_two(db, period)?;
    let quarters: Vec<Value> = all.iter().map(|(p, n)| json!({ "period": iso(*p), "filers": n })).collect();
    let mut f = db.prepare("SELECT period, name, city, state, total, positions, accession, filed, reported_total FROM f13_filers WHERE cik=?1 ORDER BY period DESC")?;
    let filings: Vec<Value> = f
        .query_map([cik], |r| {
            Ok(json!({
                "period": iso(r.get::<_, u32>(0)?), "name": r.get::<_, Option<String>>(1)?, "city": r.get::<_, Option<String>>(2)?,
                "state": r.get::<_, Option<String>>(3)?, "total": r.get::<_, Option<i64>>(4)?, "positions": r.get::<_, Option<i64>>(5)?,
                "accession": r.get::<_, String>(6)?, "filed": iso(r.get::<_, u32>(7)?), "reportedTotal": r.get::<_, Option<i64>>(8)?,
            }))
        })?
        .collect::<Result<_, _>>()?;
    let mut q = db.prepare(
        "SELECT p.period, p.cusip, p.putcall, p.value, p.shares, p.sh_type, p.rank, n.issuer, n.class,
                (SELECT ticker FROM cusip_map m WHERE m.cusip=p.cusip ORDER BY seen DESC LIMIT 1)
         FROM f13_pos p LEFT JOIN f13_names n ON n.cusip=p.cusip WHERE p.cik=?1 AND p.period IN (?2,?3)",
    )?;
    let rows: Vec<Value> = q
        .query_map(params![cik, cur.unwrap_or(0), prev.unwrap_or(0)], |r| {
            Ok(json!({
                "period": iso(r.get::<_, u32>(0)?), "cusip": r.get::<_, String>(1)?, "putcall": r.get::<_, u8>(2)?, "value": r.get::<_, i64>(3)?,
                "shares": r.get::<_, i64>(4)?, "prn": r.get::<_, u8>(5)? == 1, "rank": r.get::<_, Option<u32>>(6)?,
                "issuer": r.get::<_, Option<String>>(7)?, "class": r.get::<_, Option<String>>(8)?, "ticker": r.get::<_, Option<String>>(9)?,
            }))
        })?
        .collect::<Result<_, _>>()?;
    Ok(json!({ "cik": cik, "period": cur.map(iso), "prior": prev.map(iso), "quarters": quarters, "filings": filings, "rows": rows }))
}

/// Managers whose name contains the text, for jumping to a fund directly.
pub fn find_filers(db: &Connection, text: &str, limit: usize) -> rusqlite::Result<Value> {
    let (cur, _, _) = latest_two(db, None)?;
    let like = format!("%{}%", text.replace(['%', '_', '\\'], " ").trim());
    let mut q = db.prepare("SELECT cik, name, city, state, total, positions FROM f13_filers WHERE period=?1 AND name LIKE ?2 ORDER BY total DESC LIMIT ?3")?;
    let rows: Vec<Value> = q
        .query_map(params![cur.unwrap_or(0), like, limit as i64], |r| {
            Ok(json!({ "cik": r.get::<_, u32>(0)?, "name": r.get::<_, Option<String>>(1)?, "city": r.get::<_, Option<String>>(2)?,
                       "state": r.get::<_, Option<String>>(3)?, "total": r.get::<_, Option<i64>>(4)?, "positions": r.get::<_, Option<i64>>(5)? }))
        })?
        .collect::<Result<_, _>>()?;
    Ok(Value::Array(rows))
}

pub fn status(db: &Connection) -> rusqlite::Result<Value> {
    let quarters: Vec<Value> = periods(db)?.iter().map(|(p, n)| json!({ "period": iso(*p), "filers": n })).collect();
    let mut s = db.prepare("SELECT name, loaded, filings, rows FROM f13_sets ORDER BY name")?;
    let sets: Vec<Value> = s
        .query_map([], |r| Ok(json!({ "name": r.get::<_, String>(0)?, "loaded": r.get::<_, i64>(1)?, "filings": r.get::<_, Option<i64>>(2)?, "rows": r.get::<_, Option<i64>>(3)? })))?
        .collect::<Result<_, _>>()?;
    let mapped: i64 = db.query_row("SELECT COUNT(DISTINCT cusip) FROM cusip_map", [], |r| r.get(0))?;
    Ok(json!({ "quarters": quarters, "sets": sets, "mapped": mapped }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const SUB: &str = "ACCESSION_NUMBER\tFILING_DATE\tSUBMISSIONTYPE\tCIK\tPERIODOFREPORT\n\
        A-1\t10-AUG-2026\t13F-HR\t0000000001\t30-JUN-2026\n\
        A-2\t12-AUG-2026\t13F-HR/A\t0000000001\t30-JUN-2026\n\
        B-1\t01-AUG-2026\t13F-HR\t0000000002\t30-JUN-2026\n\
        B-2\t20-AUG-2026\t13F-HR/A\t0000000002\t30-JUN-2026\n\
        C-1\t01-AUG-2026\t13F-NT\t0000000003\t30-JUN-2026\n";
    const COVER: &str = "ACCESSION_NUMBER\tISAMENDMENT\tAMENDMENTTYPE\tFILINGMANAGER_NAME\tFILINGMANAGER_CITY\tFILINGMANAGER_STATEORCOUNTRY\tREPORTTYPE\n\
        A-1\t\t\tAlpha Capital\tBoston\tMA\t13F HOLDINGS REPORT\n\
        A-2\tY\tRESTATEMENT\tAlpha Capital\tBoston\tMA\t13F HOLDINGS REPORT\n\
        B-1\t\t\tBeta Advisors\tNew York\tNY\t13F HOLDINGS REPORT\n\
        B-2\tY\tNEW HOLDINGS\tBeta Advisors\tNew York\tNY\t13F HOLDINGS REPORT\n\
        C-1\t\t\tGamma\tAustin\tTX\t13F NOTICE\n";
    const SUMMARY: &str = "ACCESSION_NUMBER\tTABLEVALUETOTAL\nA-1\t100\nA-2\t300\nB-1\t1000\nB-2\t50\n";
    const INFO: &str = "ACCESSION_NUMBER\tINFOTABLE_SK\tNAMEOFISSUER\tTITLEOFCLASS\tCUSIP\tFIGI\tVALUE\tSSHPRNAMT\tSSHPRNAMTTYPE\tPUTCALL\tINVESTMENTDISCRETION\tOTHERMANAGER\tVOTING_AUTH_SOLE\tVOTING_AUTH_SHARED\tVOTING_AUTH_NONE\n\
        A-1\t1\tAPPLE INC\tCOM\t037833100\t\t100\t1\tSH\t\tSOLE\t\t1\t0\t0\n\
        A-2\t2\tAPPLE INC\tCOM\t037833100\t\t200\t2\tSH\t\tSOLE\t\t2\t0\t0\n\
        A-2\t3\tApple Inc\tCOM\t37833100\t\t100\t1\tSH\t\tDFND\t1\t0\t1\t0\n\
        A-2\t4\tAPPLE INC\tCOM\t037833100\t\t50\t10\tSH\tPut\tSOLE\t\t0\t0\t10\n\
        B-1\t5\tMICROSOFT CORP\tCOM\t594918104\t\t600\t3\tSH\t\tSOLE\t\t3\t0\t0\n\
        B-1\t6\tAPPLE INC\tCOM\t037833100\t\t400\t2\tSH\t\tDFND\t\t0\t2\t0\n\
        B-2\t7\tNVIDIA CORP\tCOM\t67066G104\t\t50\t1\tSH\t\tSOLE\t\t1\t0\t0\n";

    fn archive(info: &str) -> std::io::Cursor<Vec<u8>> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            for (n, body) in [("SUBMISSION.tsv", SUB), ("COVERPAGE.tsv", COVER), ("SUMMARYPAGE.tsv", SUMMARY), ("INFOTABLE.tsv", info)] {
                z.start_file(n, o).unwrap();
                z.write_all(body.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        buf.set_position(0);
        buf
    }

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    #[test]
    fn dates_cusips_and_names() {
        assert_eq!(date("30-JUN-2026"), Some(20260630));
        assert_eq!(date("01jun2026"), Some(20260601));
        assert_eq!(date("31-XYZ-2026"), None);
        assert_eq!(iso(20260630), "2026-06-30");
        assert_eq!(cusip("37833100").as_deref(), Some("037833100"));
        assert_eq!(cusip("67066g104").as_deref(), Some("67066G104"));
        assert_eq!(cusip("12-34"), None);
        assert_eq!(ticker_key("brk.b"), "BRKB");
        assert_eq!(issuer_key("Apple Inc."), issuer_key("APPLE INC COM"));
        assert_eq!(issuer_key("AT&T Inc"), "AT AND T");
    }

    #[test]
    fn picks_latest_restatement_and_keeps_new_holdings_amendments() {
        let f = select(SUB, COVER, SUMMARY).unwrap();
        let mut keys: Vec<&str> = f.keys().map(|s| s.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["A-2", "B-1", "B-2"]);
        assert!(f["B-2"].addition && !f["A-2"].addition);
        assert_eq!(f["A-2"].reported_total, 300);
        assert_eq!(f["B-1"].name, "Beta Advisors");
    }

    #[test]
    fn ingests_aggregates_ranks_and_answers_queries() {
        let mut c = db();
        let r = ingest(&mut c, archive(INFO), "test", &mut |_, _| {}).unwrap();
        assert_eq!(r["filings"], 2);
        // Alpha's two Apple share lines are one row; the put is separate.
        let h = holders(&c, &["037833100".into()], None).unwrap();
        let rows = h["rows"].as_array().unwrap();
        let alpha: Vec<&Value> = rows.iter().filter(|x| x["cik"] == 1).collect();
        assert_eq!(alpha.len(), 2);
        let shares = alpha.iter().find(|x| x["putcall"] == 0).unwrap();
        assert_eq!(shares["value"], 300);
        assert_eq!(shares["shares"], 3);
        assert_eq!(shares["portfolio"], 350);
        assert_eq!(shares["rank"], 1);
        assert_eq!(shares["discretion"], "Sole");
        assert_eq!(shares["name"], "Alpha Capital");
        // Beta's new-holdings amendment is merged into its filing.
        let beta = rows.iter().find(|x| x["cik"] == 2).unwrap();
        assert_eq!(beta["portfolio"], 1050);
        assert_eq!(beta["rank"], 2); // Microsoft is bigger
        let p = portfolio(&c, 2, None).unwrap();
        assert_eq!(p["rows"].as_array().unwrap().len(), 3);
        assert_eq!(p["filings"][0]["positions"], 3);
        assert_eq!(h["history"][0]["holders"], 2);
        assert_eq!(h["history"][0]["putHolders"], 1);
        assert_eq!(h["tenure"]["1"]["quarters"], 1);
    }

    #[test]
    fn reloading_an_older_copy_does_not_replace_newer_data() {
        let mut c = db();
        ingest(&mut c, archive(INFO), "a", &mut |_, _| {}).unwrap();
        let again = ingest(&mut c, archive(INFO), "b", &mut |_, _| {}).unwrap();
        assert_eq!(again["filings"], 0);
        let v: i64 = c.query_row("SELECT SUM(value) FROM f13_pos WHERE cik=1 AND putcall=0", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 300);
        // The new-holdings amendment is not added a second time.
        let n: i64 = c.query_row("SELECT SUM(value) FROM f13_pos WHERE cik=2", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1050);
    }

    #[test]
    fn resolves_tickers_through_the_ftd_map_and_issuer_names() {
        let mut c = db();
        ingest(&mut c, archive(INFO), "a", &mut |_, _| {}).unwrap();
        let ftd = parse_ftd("SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE\n20261001|037833100|AAPL|5|APPLE INC|300\n20260901|037833100|AAPL|5|APPLE INC|290\n");
        assert_eq!(ftd[&("AAPL".into(), "037833100".into())].1, 20261001);
        store_ftd(&mut c, "cnsfails202610a", &ftd).unwrap();
        let r = resolve(&c, "AAPL", "Apple Inc.", &[], None).unwrap();
        assert_eq!(r["securities"][0]["cusip"], "037833100");
        let by_name = resolve(&c, "MSFT", "Microsoft Corporation", &[], None).unwrap();
        assert_eq!(by_name["securities"][0]["cusip"], "594918104");
        assert_eq!(by_name["securities"][0]["source"], "Issuer name match");
    }

    #[test]
    fn finds_data_set_and_ftd_links() {
        let html = r#"<a href="/files/structureddata/data/form-13f-data-sets/01mar2026-31may2026_form13f.zip">x</a>
            <a href="/files/datastandardsinnovation/data/form-13f-data-sets/01jun2026-31aug2026_form13f.zip">y</a>
            <a href="https://evil.example/01jun2026-31aug2026_form13f.zip">z</a>
            <a href="/files/data/other/fails-deliver-data/cnsfails202610a.zip">f</a><a href="/files/data/fails-deliver-data/cnsfails202609b.zip">g</a>"#;
        let s = set_links(html);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].0, "01jun2026-31aug2026_form13f");
        let f = ftd_links(html);
        assert_eq!(f.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["cnsfails202610a", "cnsfails202609b"]);
    }
}

#[cfg(test)]
mod real_data {
    use super::*;
    /// F13_ZIP=path/to/01jun2026-31aug2026_form13f.zip F13_DB=/tmp/x.sqlite
    #[test]
    #[ignore = "Loads a real SEC 13F data set from F13_ZIP; slow"]
    fn ingest_real_set() {
        let (Ok(zip), Ok(path)) = (std::env::var("F13_ZIP"), std::env::var("F13_DB")) else { return };
        let _ = std::fs::remove_file(&path);
        let mut db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA cache_size=-262144;").unwrap();
        init(&db).unwrap();
        let t = std::time::Instant::now();
        let r = ingest(&mut db, std::fs::File::open(&zip).unwrap(), "real", &mut |_, _| {}).unwrap();
        eprintln!("ingest {:?}: {r}", t.elapsed());
        let t = std::time::Instant::now();
        let h = holders(&db, &["037833100".into()], None).unwrap();
        eprintln!("holders {:?}: {} rows", t.elapsed(), h["rows"].as_array().unwrap().len());
        let t = std::time::Instant::now();
        let p = portfolio(&db, 102909, None).unwrap();
        eprintln!("portfolio {:?}: {} rows", t.elapsed(), p["rows"].as_array().unwrap().len());
    }
}

#[cfg(test)]
mod real_map {
    use super::*;
    /// F13_DB=loaded.sqlite FTD_DIR=dir-with-cnsfails-txt-files
    #[test]
    #[ignore = "Resolves tickers against a real loaded database and real FTD files"]
    fn resolve_real_tickers() {
        let (Ok(db), Ok(dir)) = (std::env::var("F13_DB"), std::env::var("FTD_DIR")) else { return };
        let mut c = Connection::open(db).unwrap();
        init(&c).unwrap();
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "txt") {
                let text = String::from_utf8_lossy(&std::fs::read(&p).unwrap()).into_owned();
                store_ftd(&mut c, p.file_stem().unwrap().to_str().unwrap(), &parse_ftd(&text)).unwrap();
            }
        }
        for (t, n) in [("AAPL", "Apple Inc."), ("XOM", "Exxon Mobil Corp"), ("BRK.B", "Berkshire Hathaway Inc"), ("GOOGL", "Alphabet Inc."), ("TSM", "Taiwan Semiconductor"), ("ZZZQ", "Nonexistent Holdings")] {
            let r = resolve(&c, t, n, &[], None).unwrap();
            let h = holders(&c, &r["securities"].as_array().unwrap().iter().map(|s| s["cusip"].as_str().unwrap().to_string()).collect::<Vec<_>>(), None).unwrap();
            let secs: Vec<String> = r["securities"].as_array().unwrap().iter().map(|s| format!("{} {} {} ({} holders)", s["cusip"], s["issuer"], s["class"], s["holders"])).collect();
            eprintln!("{t}: {secs:?} related={} rows={}", r["related"].as_array().unwrap().len(), h["rows"].as_array().unwrap().len());
        }
    }
}
