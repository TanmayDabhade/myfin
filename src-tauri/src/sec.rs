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
        "MarketLens/0.2 (desktop research app)".into()
    } else {
        format!("MarketLens/0.2 (desktop research app) {contact}")
    }
}

/// Which EDGAR resource to fetch. Returns (url, needs_contact, cache_seconds).
pub fn resource(kind: &str, cik_raw: &str, accession: &str, doc: &str) -> Result<(String, bool, i64), String> {
    match kind {
        "tickers" => Ok(("https://www.sec.gov/files/company_tickers.json".into(), true, 7 * 86_400)),
        "submissions" => Ok((format!("https://data.sec.gov/submissions/CIK{}.json", cik(cik_raw)?), false, 21_600)),
        "revenue" => {
            if !REVENUE_TAGS.contains(&doc) {
                return Err("Unsupported XBRL concept".into());
            }
            Ok((format!("https://data.sec.gov/api/xbrl/companyconcept/CIK{}/us-gaap/{doc}.json", cik(cik_raw)?), false, 86_400))
        }
        "document" => {
            let acc: Vec<&str> = accession.split('-').collect();
            let ok_acc = acc.len() == 3
                && [10, 2, 6].iter().zip(&acc).all(|(n, p)| p.len() == *n && p.chars().all(|c| c.is_ascii_digit()));
            let ok_doc = !doc.is_empty()
                && doc.len() <= 120
                && doc.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
                && !doc.starts_with('.')
                && (doc.ends_with(".htm") || doc.ends_with(".html") || doc.ends_with(".txt"));
            if !ok_acc || !ok_doc {
                return Err("Invalid filing reference".into());
            }
            let id = cik(cik_raw)?.trim_start_matches('0').to_string();
            // Filed documents never change, so they are kept for 30 days.
            Ok((format!("https://www.sec.gov/Archives/edgar/data/{id}/{}/{doc}", accession.replace('-', "")), true, 30 * 86_400))
        }
        _ => Err("Unsupported SEC dataset".into()),
    }
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
    if kind == "document" {
        let text = html_to_text(body);
        return Ok(serde_json::json!({ "text": text.chars().take(3_000_000).collect::<String>() }));
    }
    serde_json::from_str(body).map_err(|_| "SEC returned an unreadable response".into())
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(resource("other", "1", "", "").is_err());
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
