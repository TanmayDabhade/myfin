//! SEC EDGAR access. data.sec.gov JSON (filing lists, XBRL facts) is fetched
//! with the app's identity; full filing documents and the company directory
//! on www.sec.gov are fetched only when the user has supplied the contact
//! email that SEC's fair-access policy asks automated tools to declare.
use serde_json::Value;

pub const REVENUE_TAGS: [&str; 3] = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
];
/// XBRL concepts used to pre-fill the valuation model: cash flow, capital
/// spending, cash, debt and diluted shares. Must match VALUE_TAGS in
/// src/sec-tags.js.
pub const VALUE_TAGS: [&str; 9] = [
    "NetCashProvidedByUsedInOperatingActivities",
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "CashAndCashEquivalentsAtCarryingValue",
    "LongTermDebt",
    "LongTermDebtNoncurrent",
    "LongTermDebtCurrent",
    "ShortTermBorrowings",
    "WeightedAverageNumberOfDilutedSharesOutstanding",
    "NetIncomeLoss",
];

pub fn cik(raw: &str) -> Result<String, String> {
    let digits = raw.trim().trim_start_matches("CIK");
    if digits.is_empty() || digits.len() > 10 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid SEC CIK".into());
    }
    Ok(format!("{:0>10}", digits))
}

pub fn valid_contact(email: &str) -> bool {
    let e = email.trim();
    let mut parts = e.split('@');
    let (Some(user), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    e.len() <= 120
        && !user.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && e.chars().all(|c| c.is_ascii_alphanumeric() || "@.-_+".contains(c))
}

pub fn user_agent(contact: &str) -> String {
    if contact.is_empty() {
        "Aperture/0.3 (desktop research app)".into()
    } else {
        format!("Aperture/0.3 (desktop research app) {contact}")
    }
}

/// Which EDGAR resource to fetch. Returns (url, needs_contact, cache_seconds).
pub fn resource(kind: &str, cik_raw: &str, accession: &str, doc: &str) -> Result<(String, bool, i64), String> {
    match kind {
        "tickers" => Ok(("https://www.sec.gov/files/company_tickers.json".into(), true, 7 * 86_400)),
        // Checked every 30 minutes so new filings show up the same hour.
        "submissions" => Ok((format!("https://data.sec.gov/submissions/CIK{}.json", cik(cik_raw)?), false, 1_800)),
        "revenue" => {
            if !REVENUE_TAGS.contains(&doc) {
                return Err("Unsupported XBRL concept".into());
            }
            Ok((format!("https://data.sec.gov/api/xbrl/companyconcept/CIK{}/us-gaap/{doc}.json", cik(cik_raw)?), false, 86_400))
        }
        "concept" => {
            if !VALUE_TAGS.contains(&doc) {
                return Err("Unsupported XBRL concept".into());
            }
            Ok((format!("https://data.sec.gov/api/xbrl/companyconcept/CIK{}/us-gaap/{doc}.json", cik(cik_raw)?), false, 86_400))
        }
        // Shares outstanding from the cover page of each 10-K and 10-Q.
        "shares" => Ok((
            format!("https://data.sec.gov/api/xbrl/companyconcept/CIK{}/dei/EntityCommonStockSharesOutstanding.json", cik(cik_raw)?),
            false,
            86_400,
        )),
        "document" | "xml" => {
            let acc: Vec<&str> = accession.split('-').collect();
            let ok_acc = acc.len() == 3
                && [10, 2, 6].iter().zip(&acc).all(|(n, p)| p.len() == *n && p.chars().all(|c| c.is_ascii_digit()));
            let ok_doc = !doc.is_empty()
                && doc.len() <= 120
                && doc.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
                && !doc.starts_with('.')
                && if kind == "xml" { doc.ends_with(".xml") } else { doc.ends_with(".htm") || doc.ends_with(".html") || doc.ends_with(".txt") };
            if !ok_acc || !ok_doc {
                return Err("Invalid filing reference".into());
            }
            let id = cik(cik_raw)?.trim_start_matches('0').to_string();
            // Filed documents never change, so they are kept for 30 days.
            Ok((format!("https://www.sec.gov/Archives/edgar/data/{id}/{}/{doc}", accession.replace('-', "")), true, 30 * 86_400))
        }
        // Full-text search of annual reports. `doc` carries the phrase and
        // `accession` the earliest filing date.
        "search" => {
            let phrase = doc.trim();
            let ok_phrase = (2..=80).contains(&phrase.len())
                && phrase.chars().all(|c| c.is_ascii_alphanumeric() || " .,&'-".contains(c));
            let d = accession;
            let ok_date = d.len() == 10
                && d.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
            if !ok_phrase || !ok_date {
                return Err("Invalid filing search".into());
            }
            let q: String = format!("\"{phrase}\"")
                .bytes()
                .map(|b| if b.is_ascii_alphanumeric() || b == b'-' || b == b'.' { (b as char).to_string() } else { format!("%{b:02X}") })
                .collect();
            Ok((format!("https://efts.sec.gov/LATEST/search-index?q={q}&forms=10-K,20-F,40-F&dateRange=custom&startdt={d}"), true, 86_400))
        }
        _ => Err("Unsupported SEC dataset".into()),
    }
}

/// Keeps one entry per main annual-report document from a search response.
pub fn search_hits(raw: &Value) -> Value {
    let mut out = Vec::new();
    for h in raw["hits"]["hits"].as_array().into_iter().flatten() {
        let src = &h["_source"];
        let kind = src["file_type"].as_str().unwrap_or("");
        if !["10-K", "20-F", "40-F"].contains(&kind) {
            continue;
        }
        let id = h["_id"].as_str().unwrap_or("");
        let Some((adsh, doc)) = id.split_once(':') else { continue };
        let Some(cik) = src["ciks"][0].as_str() else { continue };
        let name = src["display_names"][0].as_str().unwrap_or("").split("  (").next().unwrap_or("").trim();
        out.push(serde_json::json!({
            "cik": cik, "name": name, "accession": adsh, "doc": doc, "form": kind,
            "filed": src["file_date"], "period": src["period_ending"],
        }));
    }
    serde_json::json!({ "total": raw["hits"]["total"]["value"], "hits": out })
}

fn entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" | "rsquo" | "lsquo" => '\'',
        "nbsp" | "ensp" | "emsp" | "thinsp" => ' ',
        "ldquo" | "rdquo" => '"',
        "mdash" | "ndash" => '-',
        _ => {
            let n = name.strip_prefix('#')?;
            let code = if let Some(h) = n.strip_prefix(['x', 'X']) { u32::from_str_radix(h, 16).ok()? } else { n.parse().ok()? };
            match char::from_u32(code)? {
                '\u{a0}' | '\u{2002}'..='\u{200b}' => ' ',
                '\u{2018}' | '\u{2019}' => '\'',
                '\u{201c}' | '\u{201d}' => '"',
                '\u{2013}' | '\u{2014}' => '-',
                c => c,
            }
        }
    })
}

/// Reduces filing HTML (including inline XBRL) to readable text.
pub fn html_to_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len() / 3);
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let rest = &lower[i..];
            // Skip invisible blocks entirely.
            let skip = ["<script", "<style", "<ix:header", "<head"].iter().find(|t| rest.starts_with(**t));
            if let Some(tag) = skip {
                let close = format!("</{}", &tag[1..]);
                i = match rest.find(&close) {
                    Some(p) => i + p + close.len(),
                    None => bytes.len(),
                };
                continue;
            }
            let end = rest.find('>').map(|p| i + p + 1).unwrap_or(bytes.len());
            let block = ["<p", "<div", "<br", "<tr", "<li", "<h1", "<h2", "<h3", "<h4", "</p", "</div", "</tr", "<table"]
                .iter()
                .any(|t| rest.starts_with(t));
            out.push(if block { '\n' } else { ' ' });
            i = end;
        } else if bytes[i] == b'&' {
            let rest = &html[i + 1..];
            match rest.find(';').filter(|p| *p <= 10).and_then(|p| entity(&rest[..p]).map(|c| (c, p))) {
                Some((c, p)) => {
                    out.push(c);
                    i += p + 2;
                }
                None => {
                    out.push('&');
                    i += 1;
                }
            }
        } else {
            let ch = html[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    // Collapse whitespace but keep paragraph breaks.
    let mut text = String::with_capacity(out.len());
    for line in out.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        if !words.is_empty() {
            text.push_str(&words.join(" "));
            text.push('\n');
        }
    }
    text
}

pub fn interpret(kind: &str, http: u16, body: &str) -> Result<Value, String> {
    if http == 403 {
        return Err("SEC refused the request. Check the contact email in Settings → Data sources.".into());
    }
    if http == 404 {
        return Err("SEC has no data for this company or concept.".into());
    }
    if !(200..300).contains(&http) {
        return Err(format!("SEC returned HTTP {http}"));
    }
    if kind == "xml" {
        // Ownership filings (Forms 3/4/5, Schedules 13D/G) are small XML files.
        if body.len() > 3_000_000 || !body.trim_start().starts_with('<') {
            return Err("SEC returned an unexpected ownership document".into());
        }
        return Ok(serde_json::json!({ "xml": body }));
    }
    if kind == "document" {
        let text = html_to_text(body);
        return Ok(serde_json::json!({ "text": text.chars().take(3_000_000).collect::<String>() }));
    }
    let v: Value = serde_json::from_str(body).map_err(|_| "SEC returned an unreadable response".to_string())?;
    Ok(if kind == "search" { search_hits(&v) } else { v })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builds_full_text_search_and_keeps_main_documents() {
        let (url, contact, _) = resource("search", "", "2025-05-01", "Apple Inc.").unwrap();
        assert!(contact);
        assert!(url.starts_with("https://efts.sec.gov/LATEST/search-index?q=%22Apple%20Inc.%22&forms=10-K,20-F,40-F"));
        assert!(url.ends_with("startdt=2025-05-01"));
        assert!(resource("search", "", "2025-5-1", "Apple").is_err());
        assert!(resource("search", "", "2025-05-01", "a\"&forms=8-K").is_err());
        let raw = serde_json::json!({"hits":{"total":{"value":2},"hits":[
            {"_id":"0000772406-26-000010:crus-20260328.htm","_source":{"ciks":["0000772406"],"display_names":["CIRRUS LOGIC, INC.  (CRUS)  (CIK 0000772406)"],"file_type":"10-K","file_date":"2026-05-20","period_ending":"2026-03-28"}},
            {"_id":"0000772406-26-000010:ex21.htm","_source":{"ciks":["0000772406"],"display_names":["CIRRUS"],"file_type":"EX-21"}}]}});
        let h = search_hits(&raw);
        assert_eq!(h["hits"].as_array().unwrap().len(), 1);
        assert_eq!(h["hits"][0]["name"], "CIRRUS LOGIC, INC.");
        assert_eq!(h["hits"][0]["doc"], "crus-20260328.htm");
    }
    #[test]
    fn pads_and_rejects_ciks() {
        assert_eq!(cik("320193").unwrap(), "0000320193");
        assert_eq!(cik("CIK0000320193").unwrap(), "0000320193");
        for bad in ["", "12345678901", "32a", "../1"] {
            assert!(cik(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn contact_email_validation() {
        assert!(valid_contact("analyst@example.com"));
        assert!(!valid_contact("no-at-sign"));
        assert!(!valid_contact("a@b"));
        assert!(!valid_contact("a@b.com\r\nX-Injected: 1"));
        assert!(!valid_contact("a@@b.com"));
    }
    #[test]
    fn builds_only_whitelisted_urls() {
        let (u, contact, _) = resource("submissions", "320193", "", "").unwrap();
        assert_eq!(u, "https://data.sec.gov/submissions/CIK0000320193.json");
        assert!(!contact);
        let (u, contact, _) = resource("document", "320193", "0000320193-26-000026", "aapl-20260926.htm").unwrap();
        assert_eq!(u, "https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm");
        assert!(contact);
        assert!(resource("document", "320193", "0000320193-26-000026", "../x.htm").is_err());
        assert!(resource("document", "320193", "1-2-3", "a.htm").is_err());
        assert!(resource("document", "320193", "0000320193-26-000026", "a.exe").is_err());
        assert!(resource("revenue", "320193", "", "Assets").is_err());
        let (u, contact, _) = resource("xml", "320193", "0001140361-26-042149", "form4.xml").unwrap();
        assert_eq!(u, "https://www.sec.gov/Archives/edgar/data/320193/000114036126042149/form4.xml");
        assert!(contact);
        assert!(resource("xml", "320193", "0001140361-26-042149", "form4.htm").is_err());
        assert!(resource("xml", "320193", "0001140361-26-042149", "xslF345X06/form4.xml").is_err());
        let (u, contact, _) = resource("shares", "320193", "", "").unwrap();
        assert!(u.ends_with("/CIK0000320193/dei/EntityCommonStockSharesOutstanding.json") && !contact);
        assert!(resource("other", "1", "", "").is_err());
        let (u, contact, _) = resource("concept", "320193", "", "LongTermDebt").unwrap();
        assert!(u.ends_with("/CIK0000320193/us-gaap/LongTermDebt.json") && !contact);
        assert!(resource("concept", "320193", "", "Revenues").is_err());
        assert!(resource("concept", "320193", "", "../x").is_err());
    }
    #[test]
    fn strips_html_and_hidden_xbrl() {
        let html = "<html><head><title>x</title></head><body><ix:header><ix:hidden>SECRET</ix:hidden></ix:header><script>bad()</script><p>Our largest customer, Acme&#160;Corp, accounted for 12% of net sales.</p><div>Supplier&nbsp;&amp; partner &#8217;s &unknown; text</div></body></html>";
        let t = html_to_text(html);
        assert!(!t.contains("SECRET") && !t.contains("bad()") && !t.contains('<'));
        assert!(t.contains("Our largest customer, Acme Corp, accounted for 12% of net sales."));
        assert!(t.contains("Supplier & partner 's &unknown; text"));
    }
    #[test]
    fn maps_sec_errors() {
        assert!(interpret("submissions", 403, "").unwrap_err().contains("contact email"));
        assert!(interpret("revenue", 404, "").unwrap_err().contains("no data"));
        assert_eq!(interpret("document", 200, "<p>Hi</p>").unwrap()["text"], "Hi\n");
        assert_eq!(interpret("xml", 200, "<a>1</a>").unwrap()["xml"], "<a>1</a>");
        assert!(interpret("xml", 200, "{}").is_err());
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    #[test]
    #[ignore = "Live SEC contract check for keyless data.sec.gov endpoints; requires network"]
    fn live_keyless_endpoints() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap();
            for (kind, doc) in [("submissions", ""), ("revenue", REVENUE_TAGS[0])] {
                let (url, contact, _) = resource(kind, "320193", "", doc).unwrap();
                assert!(!contact);
                let resp = client.get(url).header(reqwest::header::USER_AGENT, user_agent("")).send().await.unwrap();
                let http = resp.status().as_u16();
                let data = interpret(kind, http, &resp.text().await.unwrap()).unwrap();
                if kind == "submissions" {
                    assert!(data["filings"]["recent"]["form"].as_array().unwrap().len() > 10);
                } else {
                    assert!(data["units"]["USD"].as_array().unwrap().len() > 5);
                }
            }
        });
    }
}
