//! Aperture Analyst: Google's Gemma 4 E4B running on the user's computer
//! through llama.cpp's server. This module holds the pure parts (what to
//! download, how to start the server, news search, readable page text, URL
//! safety and the streamed reply); downloads and the server process live in
//! the desktop binary.
use serde::Serialize;
use serde_json::Value;
use std::net::IpAddr;

/// llama.cpp build the app runs. Pinned with checksums: the files come from
/// GitHub and are verified before anything is unpacked.
pub const LLAMA_BUILD: &str = "b11927";

#[derive(Debug, Clone, PartialEq)]
pub struct Download {
    pub url: String,
    pub sha256: &'static str,
    pub size: u64,
}

/// The llama.cpp server for this computer, by `std::env::consts` OS and arch.
/// CPU builds on Windows and Linux work on every machine; macOS on Apple
/// Silicon uses the GPU (Metal).
pub fn runtime_for(os: &str, arch: &str) -> Option<Download> {
    let (asset, sha256, size): (&str, &str, u64) = match (os, arch) {
        ("macos", "aarch64") => ("macos-arm64.tar.gz", "6015918064ddf52a4c60bd8c0c01fe030e07ff317d744f1e93cd3e54b10ba08e", 16_000_000),
        ("macos", "x86_64") => ("macos-x64.tar.gz", "4969321f8d27980686c1ce947f00fd07355693197f1f1732e3673f1b4791f7e4", 12_000_000),
        ("windows", "x86_64") => ("win-cpu-x64.zip", "f70b7fe800e683f58fed3199fcf9c961932307f30916498a7758dce5f1d76ce9", 24_000_000),
        ("windows", "aarch64") => ("win-cpu-arm64.zip", "a28993a67dcb7daa5d677ff9cc142722e0218e839e073a4ff569f4e87263f433", 12_000_000),
        ("linux", "x86_64") => ("ubuntu-x64.tar.gz", "13a2802a7b7b6c39deda5c3c7f59a8377be9fff289a578ccf801baba278765bf", 22_000_000),
        ("linux", "aarch64") => ("ubuntu-arm64.tar.gz", "fb56c30b1af259eef64a30e1aee7ef57329fd84bf8efd326abbb653adbd42a98", 18_000_000),
        _ => return None,
    };
    Some(Download {
        url: format!("https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_BUILD}/llama-{LLAMA_BUILD}-bin-{asset}"),
        sha256,
        size,
    })
}

/// Gemma 4 E4B instruction-tuned, 4-bit (Q4_K_M), Apache 2.0, pinned to one
/// revision of Unsloth's GGUF repository on Hugging Face.
pub const MODEL_FILE: &str = "gemma-4-E4B-it-Q4_K_M.gguf";
pub fn model() -> Download {
    Download {
        url: format!("https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/bfc15c382204943c3a8fff0c750b94ae2364d7a3/{MODEL_FILE}"),
        sha256: "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87",
        size: 4_977_171_584,
    }
}

/// Context the server keeps per conversation. Enough for the stock briefing,
/// a few tool results and the answer, while staying fast on a CPU.
pub const CONTEXT_TOKENS: u32 = 16_384;

/// Arguments for llama-server: local only, behind a per-session key, no web
/// page of its own, thinking off (faster, and tool calls land in the reply).
pub fn server_args(model: &str, port: u16, key: &str, gpu: bool) -> Vec<String> {
    let mut a: Vec<String> = [
        "-m", model, "--host", "127.0.0.1", "--port", &port.to_string(), "--api-key", key,
        "-c", &CONTEXT_TOKENS.to_string(), "--jinja", "--reasoning", "off", "--no-webui", "-np", "1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.extend(["-ngl".into(), if gpu { "all".into() } else { "0".into() }]);
    a
}

// ---- News search ------------------------------------------------------------

/// Bing News RSS search. Results link to the publisher's own article, which
/// `read_page` can then open (Google News links are opaque redirects).
pub fn news_url(query: &str) -> String {
    let q: String = query.chars().filter(|c| !c.is_control()).take(200).collect();
    let mut u = reqwest::Url::parse("https://www.bing.com/news/search").expect("static url");
    u.query_pairs_mut().append_pair("q", q.trim()).append_pair("format", "rss").append_pair("setlang", "en-us");
    u.to_string()
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct NewsItem {
    pub title: String,
    pub url: String,
    pub source: String,
    pub published: String,
    pub snippet: String,
}

fn between<'a>(s: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let i = s.find(open)? + open.len();
    let j = s[i..].find(close)? + i;
    Some(&s[i..j])
}
/// The value of a tag that may carry attributes, CDATA or a namespace.
fn tag(item: &str, name: &str) -> String {
    let open = format!("<{name}");
    let Some(start) = item.find(&open) else { return String::new() };
    let rest = &item[start + open.len()..];
    // Skip `<titlefoo>`-style longer names.
    if !rest.starts_with('>') && !rest.starts_with(' ') {
        return String::new();
    }
    let Some(gt) = rest.find('>') else { return String::new() };
    let body = &rest[gt + 1..];
    let end = body.find(&format!("</{name}>")).unwrap_or(0);
    let raw = &body[..end];
    let raw = raw.strip_prefix("<![CDATA[").and_then(|r| r.strip_suffix("]]>")).unwrap_or(raw);
    decode_entities(raw).trim().to_string()
}

pub fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        // Look for the ';' within a few characters, on character boundaries
        // (byte slicing could split a multi-byte character).
        let Some(semi) = rest.char_indices().take(12).find(|(_, c)| *c == ';').map(|(i, _)| i) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let ent = &rest[1..semi];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            "mdash" => Some('—'),
            "ndash" => Some('–'),
            "rsquo" | "lsquo" => Some('\''),
            "rdquo" | "ldquo" => Some('"'),
            "hellip" => Some('…'),
            e if e.starts_with("#x") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Bing wraps each link in a click tracker; the article is its `url` param.
fn publisher_url(link: &str) -> String {
    reqwest::Url::parse(link)
        .ok()
        .filter(|u| u.host_str().is_some_and(|h| h.ends_with("bing.com")))
        .and_then(|u| u.query_pairs().find(|(k, _)| k == "url").map(|(_, v)| v.into_owned()))
        .unwrap_or_else(|| link.to_string())
}

/// RSS 2.0 items, at most `max`.
pub fn parse_rss(xml: &str, max: usize) -> Vec<NewsItem> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(item) = between(rest, "<item>", "</item>") {
        rest = &rest[rest.find("</item>").map_or(rest.len(), |i| i + 7)..];
        let url = publisher_url(&tag(item, "link"));
        let title = tag(item, "title");
        if title.is_empty() || !url.starts_with("http") {
            continue;
        }
        let mut source = tag(item, "News:Source");
        if source.is_empty() {
            source = tag(item, "source");
        }
        if source.is_empty() {
            source = reqwest::Url::parse(&url).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string())).unwrap_or_default();
        }
        out.push(NewsItem { title, url, source, published: tag(item, "pubDate"), snippet: clip(&strip_tags(&tag(item, "description")), 300) });
        if out.len() >= max {
            break;
        }
    }
    out
}

// ---- Readable page text -----------------------------------------------------

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max).collect();
    t.push('…');
    t
}

/// Removes every `<name …>…</name>` block (case-insensitive).
fn drop_blocks(html: &str, name: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let (open, close) = (format!("<{name}"), format!("</{name}>"));
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while let Some(s) = lower[i..].find(&open).map(|x| x + i) {
        out.push_str(&html[i..s]);
        match lower[s..].find(&close) {
            Some(e) => i = s + e + close.len(),
            None => return out,
        }
    }
    out.push_str(&html[i..]);
    out
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    decode_entities(&out).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A page's title and visible text, without scripts, styles, navigation,
/// headers or footers, at most `max` characters.
pub fn readable_text(html: &str, max: usize) -> (String, String) {
    let title = between(html, "<title", "</title>").map(|t| strip_tags(&format!("<x{t}"))).unwrap_or_default();
    let body = between(html, "<body", "</body>").map(|b| b.split_once('>').map_or(b, |(_, rest)| rest)).unwrap_or(html);
    let mut text = body.to_string();
    for name in ["script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form", "iframe"] {
        text = drop_blocks(&text, name);
    }
    // A paragraph that ends without punctuation still ends a sentence.
    let marked = strip_tags(&text.replace("</p>", " \u{b6}</p>").replace("</P>", " \u{b6}</P>"));
    let mut out = String::with_capacity(marked.len());
    for word in marked.split(' ') {
        if word == "\u{b6}" {
            if !out.ends_with(['.', '!', '?', ':', ';']) && !out.is_empty() {
                out.push('.');
            }
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    (clip(&title, 200), clip(&out, max))
}

// ---- URL safety -------------------------------------------------------------

/// Addresses the analyst may never reach: this computer, the local network,
/// link-local and other special ranges.
pub fn private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || v.is_multicast()
                || v.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // carrier-grade NAT
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments
                || (o[0] == 198 && (o[1] & 0xfe) == 18) // benchmarking
                || o[0] >= 240
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            let embedded = |hi: u16, lo: u16| private_ip(&IpAddr::V4(std::net::Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8)));
            v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link-local
                || (s[0] & 0xffc0) == 0xfec0 // site-local (deprecated)
                || v.to_ipv4_mapped().is_some_and(|m| private_ip(&IpAddr::V4(m)))
                // IPv4-compatible ::a.b.c.d (deprecated)
                || (s[..6].iter().all(|&x| x == 0) && embedded(s[6], s[7]))
                // NAT64 64:ff9b::/96 and 64:ff9b:1::/48 carry an IPv4 address
                || (s[0] == 0x64 && s[1] == 0xff9b && embedded(s[6], s[7]))
                // 6to4 2002:a.b.c.d::/48
                || (s[0] == 0x2002 && embedded(s[1], s[2]))
                // Teredo 2001:0::/32 hides the client address; never needed here
                || (s[0] == 0x2001 && s[1] == 0)
        }
    }
}

/// A public http(s) URL the analyst may read; rejects credentials, odd ports,
/// local hostnames and private IP literals. DNS answers are checked again
/// when the page is fetched.
pub fn public_url(raw: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(raw.trim()).map_err(|_| "Not a valid web address".to_string())?;
    if !matches!(u.scheme(), "http" | "https") || !u.username().is_empty() || u.password().is_some() {
        return Err("Only public http(s) pages can be read".into());
    }
    if u.port().is_some_and(|p| p != 80 && p != 443) {
        return Err("Only standard web ports can be read".into());
    }
    let host = u.host_str().ok_or("No host")?.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") || !host.contains('.') {
        return Err("Local addresses can't be read".into());
    }
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        if private_ip(&ip) {
            return Err("Local addresses can't be read".into());
        }
    }
    Ok(u)
}

// ---- Streamed reply ---------------------------------------------------------

/// The assistant message assembled from llama-server's streamed chunks
/// (OpenAI chat-completions format).
#[derive(Default, Debug, Serialize, PartialEq)]
pub struct Reply {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish: String,
}
#[derive(Default, Debug, Serialize, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

impl Reply {
    /// Applies one `data:` payload. Returns the new text, if any, to show
    /// while the reply is still being written.
    pub fn apply(&mut self, chunk: &Value) -> Option<String> {
        let choice = chunk["choices"].get(0)?;
        if let Some(f) = choice["finish_reason"].as_str() {
            self.finish = f.to_string();
        }
        let delta = &choice["delta"];
        for tc in delta["tool_calls"].as_array().into_iter().flatten() {
            let i = tc["index"].as_u64().unwrap_or(self.tool_calls.len().saturating_sub(1) as u64) as usize;
            while self.tool_calls.len() <= i.min(15) {
                self.tool_calls.push(ToolCall::default());
            }
            let call = &mut self.tool_calls[i.min(15)];
            if let Some(id) = tc["id"].as_str() {
                call.id = id.to_string();
            }
            if let Some(n) = tc["function"]["name"].as_str() {
                call.name.push_str(n);
            }
            if let Some(a) = tc["function"]["arguments"].as_str() {
                call.arguments.push_str(a);
            }
        }
        let text = delta["content"].as_str().filter(|t| !t.is_empty())?;
        self.content.push_str(text);
        Some(text.to_string())
    }
}

/// Splits complete server-sent-event lines off `buf`, returning their JSON
/// payloads and whether the stream said `[DONE]`.
pub fn sse_events(buf: &mut String) -> (Vec<Value>, bool) {
    let mut out = Vec::new();
    let mut done = false;
    while let Some(nl) = buf.find('\n') {
        let line: String = buf.drain(..=nl).collect();
        let Some(data) = line.trim().strip_prefix("data:") else { continue };
        let data = data.trim();
        if data == "[DONE]" {
            done = true;
        } else if let Ok(v) = serde_json::from_str(data) {
            out.push(v);
        }
    }
    (out, done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pins_a_runtime_per_platform_and_the_model() {
        let mac = runtime_for("macos", "aarch64").unwrap();
        assert_eq!(mac.url, "https://github.com/ggml-org/llama.cpp/releases/download/b11927/llama-b11927-bin-macos-arm64.tar.gz");
        assert_eq!(mac.sha256.len(), 64);
        assert!(runtime_for("windows", "x86_64").unwrap().url.ends_with("win-cpu-x64.zip"));
        assert!(runtime_for("freebsd", "x86_64").is_none());
        let m = model();
        assert!(m.url.contains("/resolve/bfc15c38") && m.url.ends_with(MODEL_FILE));
        assert_eq!(m.size, 4_977_171_584);
        let a = server_args("/m.gguf", 4242, "k", true);
        let s = a.join(" ");
        assert!(s.contains("--host 127.0.0.1") && s.contains("--port 4242") && s.contains("--api-key k") && s.contains("--jinja") && s.contains("--reasoning off") && s.contains("-ngl all"));
        assert!(server_args("/m.gguf", 1, "k", false).join(" ").ends_with("-ngl 0"));
    }

    #[test]
    fn reads_bing_news_rss() {
        let xml = r#"<rss><channel><title>x</title><item><title>Apple &amp; the CFO</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;url=https%3a%2f%2fwww.example.com%2fapple-cfo&amp;c=1</link><description>The &lt;b&gt;CFO&lt;/b&gt; left.</description><pubDate>Tue, 10 Nov 2026 13:00:00 GMT</pubDate><News:Source>Example News</News:Source></item><item><title></title><link>http://x.com</link></item><item><title>Second</title><link>https://news.example.org/b</link></item></channel></rss>"#;
        let items = parse_rss(xml, 10);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Apple & the CFO");
        assert_eq!(items[0].url, "https://www.example.com/apple-cfo");
        assert_eq!(items[0].source, "Example News");
        assert_eq!(items[0].snippet, "The CFO left.");
        assert_eq!(items[1].source, "news.example.org");
        assert!(news_url("AAPL stock\n").contains("q=AAPL+stock&format=rss"));
    }

    #[test]
    fn extracts_readable_text() {
        let html = "<html><head><title>Big &amp; News</title><style>p{}</style></head><body><nav>Menu</nav><script>evil()</script><p>First para.</p><p>Second &#8212; para</p><footer>(c)</footer></body></html>";
        let (title, text) = readable_text(html, 1000);
        assert_eq!(title, "Big & News");
        assert_eq!(text, "First para. Second — para.");
        assert!(readable_text(&format!("<body>{}</body>", "word ".repeat(500)), 50).1.ends_with('…'));
        // Multi-byte characters right after '&' must not split mid-character.
        assert_eq!(decode_entities("&ééééééééééé; &amp; ü&"), "&ééééééééééé; & ü&");
        assert_eq!(decode_entities("R&D — 東京&"), "R&D — 東京&");
    }

    #[test]
    fn only_public_web_addresses() {
        assert!(public_url("https://www.reuters.com/markets/x").is_ok());
        for bad in ["file:///etc/passwd", "http://localhost:8080/", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/admin", "http://[::1]/", "http://169.254.169.254/latest", "http://router/", "https://user:pw@example.com/", "https://example.com:8443/", "http://printer.local/"] {
            assert!(public_url(bad).is_err(), "{bad}");
        }
        assert!(private_ip(&"100.64.0.1".parse().unwrap()) && !private_ip(&"8.8.8.8".parse().unwrap()));
        assert!(private_ip(&"::ffff:192.168.0.1".parse().unwrap()) && private_ip(&"fd00::1".parse().unwrap()));
        for ip in ["64:ff9b::7f00:1", "64:ff9b::a00:5", "2002:c0a8:101::1", "::127.0.0.1", "2001:0:4136:e378::1", "198.18.0.1", "192.0.0.8", "fec0::1"] {
            assert!(private_ip(&ip.parse().unwrap()), "{ip}");
        }
        for ip in ["2606:4700::1111", "2002:808:808::1", "64:ff9b::808:808", "1.1.1.1"] {
            assert!(!private_ip(&ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn assembles_streamed_text_and_tool_calls() {
        let mut buf = String::from("data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"search_news\",\"arguments\":\"{\\\"query\\\":\"}}]}}]}\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"AAPL\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\ndata: [DONE]\npartial");
        let (events, done) = sse_events(&mut buf);
        assert!(done);
        assert_eq!(buf, "partial");
        let mut r = Reply::default();
        let shown: Vec<String> = events.iter().filter_map(|e| r.apply(e)).collect();
        assert_eq!(shown, vec!["Hel", "lo"]);
        assert_eq!(r.content, "Hello");
        assert_eq!(r.finish, "tool_calls");
        assert_eq!(r.tool_calls, vec![ToolCall { id: "c1".into(), name: "search_news".into(), arguments: r#"{"query":"AAPL"}"#.into() }]);
        assert_eq!(r.apply(&json!({"choices":[]})), None);
    }
}
