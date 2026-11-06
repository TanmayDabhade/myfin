// SEC filing discovery: recent filings, revenue history and candidate
// supplier/customer mentions. Candidates are never marked reviewed here;
// a person must read the source and confirm each one.

const ANNUAL = ["10-K", "10-K/A", "20-F", "40-F"];
const LISTED = [...ANNUAL, "10-Q", "8-K", "6-K", "DEF 14A", "S-1"];

export const padCIK = (c) => String(c).replace(/\D/g, "").padStart(10, "0");

export function filingURL(cik, accession, doc) {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${doc}`;
}

export function recentFilings(submissions, limit = 12) {
  const r = submissions?.filings?.recent;
  if (!r?.form) return [];
  const cik = submissions.cik;
  const out = [];
  for (let i = 0; i < r.form.length && out.length < limit; i++) {
    if (!LISTED.includes(r.form[i]) || !r.primaryDocument[i]) continue;
    out.push({
      form: r.form[i],
      filed: r.filingDate[i],
      period: r.reportDate[i] || "",
      accession: r.accessionNumber[i],
      doc: r.primaryDocument[i],
      description: r.primaryDocDescription?.[i] || "",
      url: filingURL(cik, r.accessionNumber[i], r.primaryDocument[i]),
    });
  }
  return out;
}

export function annualReports(submissions, count = 2) {
  return recentFilings(submissions, 200)
    .filter((f) => ANNUAL.includes(f.form) && !f.form.endsWith("/A"))
    .slice(0, count);
}

// Annual revenue by fiscal period end, from an XBRL company-concept response.
export function revenueHistory(concept, years = 6) {
  const rows = (concept?.units?.USD || []).filter(
    (x) =>
      ANNUAL.includes(x.form) &&
      x.start &&
      x.end &&
      (Date.parse(x.end) - Date.parse(x.start)) / 864e5 > 300 &&
      Number.isFinite(x.val),
  );
  const byEnd = new Map();
  for (const x of rows) {
    const old = byEnd.get(x.end);
    if (!old || x.filed > old.filed) byEnd.set(x.end, x);
  }
  const sorted = [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
  return sorted
    .map((x, i) => ({
      end: x.end,
      revenue: x.val,
      growth: i > 0 && sorted[i - 1].val > 0 ? x.val / sorted[i - 1].val - 1 : null,
      filed: x.filed,
      accession: x.accn,
    }))
    .slice(-years);
}

const SUFFIX =
  /\b(INCORPORATED|INC|CORPORATION|CORP|COMPANY|CO|LIMITED|LTD|PLC|LLC|LP|HOLDINGS?|GROUP|SA|NV|AG|SE|THE|DE|NEW|CL A|CLASS A)\b/g;
export function normalizeName(name) {
  return ` ${String(name)
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}
const LEGAL = /\b(Inc|Incorporated|Corporation|Corp|Company|Limited|Ltd|plc|PLC|LLC|N\.V|S\.A|AG|SE|Co)\b/;

// Company directory for entity resolution: SEC's ticker file plus graph
// entities and their aliases. Each entry resolves to one canonical entity.
export function buildDirectory(companyTickers, graph) {
  const entries = new Map();
  const add = (key, entry) => {
    if (key.trim().length < 3 || entries.has(key)) return;
    entries.set(key, entry);
  };
  for (const n of graph?.nodes || [])
    for (const alias of [n.name, ...(n.aliases || [])])
      add(normalizeName(alias), { nodeId: n.id, name: n.name, ticker: n.ticker, cik: n.cik });
  for (const c of Object.values(companyTickers || {})) {
    if (!c?.title || !c.cik_str) continue;
    const cik = padCIK(c.cik_str);
    const node = graph?.nodes?.find((n) => n.cik === cik || (n.ticker && n.ticker === c.ticker));
    add(normalizeName(c.title), {
      nodeId: node?.id,
      name: node?.name || c.title,
      ticker: c.ticker,
      cik,
    });
  }
  return [...entries].map(([key, entry]) => ({
    key,
    single: key.trim().split(" ").length === 1,
    ...entry,
  }));
}

const SUPPLIER_CUE =
  /\b(suppliers?|supplied by|sourced? from|purchases? from|purchased from|manufactured by|contract manufactur\w*|foundr(y|ies)|vendors?|single.source|sole.source)\b/i;
const CUSTOMER_CUE =
  /\b(customers?|sales to|sold to|net sales to|distributors?|resellers?|largest customer|significant customer)\b/i;
const SHARE =
  /(\d{1,2}(?:\.\d+)?)\s?%\s+of\s+(?:the\s+company['’]s\s+|our\s+|its\s+)?((?:total\s+|net\s+|consolidated\s+)?(?:revenues?|net sales|sales))/i;

export function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+(?=[A-Z(“"])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 1500);
}

// Find named counterparties in sentences that also contain a supply-chain cue.
export function extractCandidates(text, directory, filer) {
  const found = [];
  const seen = new Set();
  // Index names by first word so each sentence checks only plausible names.
  const index = new Map();
  for (const d of directory) {
    const first = d.key.trim().split(" ")[0];
    if (!index.has(first)) index.set(first, []);
    index.get(first).push(d);
  }
  for (const s of sentences(text)) {
    const supplier = SUPPLIER_CUE.test(s),
      customer = CUSTOMER_CUE.test(s);
    if (supplier === customer) continue; // no cue, or direction unclear
    const norm = normalizeName(s);
    const pool = [...new Set(norm.trim().split(" "))].flatMap((w) => index.get(w) || []);
    for (const d of pool) {
      if (d.cik && d.cik === filer.cik) continue;
      if (filer.nodeId && d.nodeId === filer.nodeId) continue;
      if (d.nodeId && filer.skip?.includes(d.nodeId)) continue;
      if (!norm.includes(d.key)) continue;
      // One-word names ("Target", "Block") need a legal suffix right after
      // them in the original sentence to count as a company mention.
      if (d.single) {
        const word = d.key.trim();
        const re = new RegExp(`\\b${word}\\b[,]?\\s+${LEGAL.source}`, "i");
        if (!re.test(s)) continue;
      }
      const role = supplier ? "supplier" : "customer";
      const dedupe = `${d.cik || d.nodeId}:${role}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const share = role === "customer" ? s.match(SHARE) : null;
      found.push({
        counterparty: d,
        role,
        sentence: s.length > 600 ? s.slice(0, 597) + "…" : s,
        revenueShare: share ? Number(share[1]) / 100 : null,
        revenueBasis: share ? share[2] : null,
      });
    }
  }
  return found;
}

const slug = (x) =>
  String(x).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// Turn candidates into unreviewed graph edges, adding entities as needed.
export function candidatesToGraph(graph, filer, filing, candidates, today) {
  const next = structuredClone(graph);
  const nodeFor = (d) => {
    let n =
      (d.nodeId && next.nodes.find((x) => x.id === d.nodeId)) ||
      next.nodes.find((x) => (d.cik && x.cik === d.cik) || (d.ticker && x.ticker === d.ticker));
    if (!n) {
      n = { id: d.cik ? `cik-${d.cik}` : slug(d.name), name: d.name, ticker: d.ticker, cik: d.cik };
      next.nodes.push(n);
    } else if (d.cik && !n.cik) n.cik = d.cik;
    return n;
  };
  const self = nodeFor(filer);
  let added = 0;
  for (const c of candidates) {
    const other = nodeFor(c.counterparty);
    const supplier = c.role === "supplier" ? other.id : self.id;
    const customer = c.role === "supplier" ? self.id : other.id;
    const id = `sec-${filing.accession}-${supplier}-${customer}`.slice(0, 100);
    if (next.edges.some((e) => e.id === id)) continue;
    next.edges.push({
      id,
      supplier,
      customer,
      relationship: c.role === "supplier" ? "Named as supplier in filing (candidate)" : "Named as customer in filing (candidate)",
      product: null,
      observedOn: filing.filed,
      reportingPeriod: filing.period || null,
      review: "unreviewed",
      sourceURL: filing.url,
      sourceTitle: `${filer.name} ${filing.form} filed ${filing.filed}`,
      evidence: c.sentence,
      revenueShare: c.revenueShare,
      revenuePeriod: c.revenueShare != null ? `Fiscal period ending ${filing.period || filing.filed}` : null,
      revenueBasis: c.revenueBasis,
      retrievedOn: today,
      origin: "sec-scan",
    });
    added++;
  }
  return { graph: next, added, self };
}

// Compare counterparties between this and the prior annual report.
export function compareMentions(current, prior) {
  const key = (c) => `${c.counterparty.cik || c.counterparty.nodeId}:${c.role}`;
  const before = new Set(prior.map(key)),
    now = new Set(current.map(key));
  return {
    added: current.filter((c) => !before.has(key(c))),
    dropped: prior.filter((c) => !now.has(key(c))),
    kept: current.filter((c) => before.has(key(c))),
  };
}
