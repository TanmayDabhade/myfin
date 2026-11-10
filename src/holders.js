// Ownership from SEC filings: institutional managers (13F), 5%+ owners
// (Schedules 13D/G) and insiders (Forms 3/4/5). Pure functions; the app
// fetches the filings and renders the results.

// ---- Command line ---------------------------------------------------------
// Terminal-style mnemonics typed in the search box: "AAPL HDS", "HDS AAPL",
// "HDS" (current stock). Stock functions open that view of the stock page.
// Words like US and EQUITY are ignored.
export const COMMANDS = {
  DES: "Stock",
  GP: "Stock",
  FA: "Stock",
  CN: "Stock",
  HDS: "Stock",
  OWN: "Stock",
  SPLC: "Stock",
  RELS: "Stock",
  DCF: "Stock",
  TAS: "Stock",
  QR: "Stock",
  ASK: "Stock",
  CF: "Stock",
  EQS: "Universe",
  SECF: "Universe",
  PORT: "Portfolio",
  ECO: "Economy",
  CMDTY: "Commodities",
};
const VIEW_ALIAS = { RELS: "SPLC", QR: "TAS" };
const FILLER = new Set(["US", "EQUITY", "<GO>", "GO", "<EQUITY>"]);
export function parseCommand(text) {
  const all = String(text || "").trim().toUpperCase().split(/\s+/).filter(Boolean);
  const words = all.filter((w) => !FILLER.has(w));
  // "CF US EQUITY" names the security; a lone word after it is a ticker.
  if (words.length === 1 && all.some((w) => w === "EQUITY" || w === "<EQUITY>")) return null;
  // The function is the last command word, so "CF HDS" is CF's holders.
  const cmd = words.findLast((w) => COMMANDS[w]);
  if (!cmd) return null;
  const rest = words.filter((w, i) => i !== words.lastIndexOf(cmd));
  const page = COMMANDS[cmd];
  return { command: cmd, page, view: page === "Stock" ? VIEW_ALIAS[cmd] || cmd : null, ticker: rest[0] || null };
}

// ---- Shares outstanding (XBRL dei cover-page facts) -----------------------
// One point per report date. Companies with several share classes report
// one fact per class on the same date; those are summed.
export function sharesSeries(concept) {
  const facts = concept?.units?.shares || [];
  const byEnd = new Map();
  for (const f of facts) {
    if (!f?.end || !Number.isFinite(f.val)) continue;
    const prev = byEnd.get(f.end);
    if (!prev || f.filed > prev.filed) byEnd.set(f.end, { date: f.end, filed: f.filed, accn: f.accn, shares: f.val, classes: 1 });
    else if (f.filed === prev.filed && f.accn === prev.accn) {
      prev.shares += f.val;
      prev.classes++;
    }
  }
  return [...byEnd.values()].sort((a, b) => a.date.localeCompare(b.date));
}
// Shares outstanding as of a date: the latest report on or before it, or
// failing that the earliest one after it.
export function sharesAt(series, date) {
  if (!series?.length) return null;
  const before = series.filter((x) => x.date <= date).at(-1);
  return before || series[0];
}

// ---- 13F: holders of one security -----------------------------------------
const ratio = (a, b) => (Number.isFinite(a) && b > 0 ? a / b : null);

// Joins this quarter's and last quarter's positions per manager.
// `sharesOut` is the share count used for "% of shares outstanding".
export function compareHolders(data, sharesOut = null) {
  const cur = data?.period,
    prior = data?.prior;
  const reported = new Set((data?.reported || []).map(Number));
  const byCik = new Map();
  const options = [];
  for (const r of data?.rows || []) {
    if (r.putcall) {
      if (r.period === cur) options.push({ ...r, type: r.putcall === 1 ? "Put" : "Call" });
      continue;
    }
    const h = byCik.get(r.cik) || {};
    h[r.period === cur ? "now" : "before"] = r;
    byCik.set(r.cik, h);
  }
  // Put/call changes from last quarter.
  const prevOpt = new Map((data?.rows || []).filter((r) => r.putcall && r.period === prior).map((r) => [`${r.cik}:${r.putcall}`, r]));
  for (const o of options) {
    const p = prevOpt.get(`${o.cik}:${o.putcall}`);
    o.prevShares = p ? p.shares : 0;
    o.change = o.shares - o.prevShares;
    o.status = p ? (o.change > 0 ? "added" : o.change < 0 ? "reduced" : "unchanged") : "new";
  }
  const holders = [];
  for (const [cik, { now, before }] of byCik) {
    const info = now || before;
    const shares = now?.shares ?? 0,
      prevShares = before?.shares ?? 0;
    let status;
    if (now && !before) status = prior ? "new" : "held";
    else if (!now) status = reported.has(cik) ? "exited" : "not-filed";
    else status = shares > prevShares ? "added" : shares < prevShares ? "reduced" : "unchanged";
    const tenure = data?.tenure?.[String(cik)];
    holders.push({
      cik,
      name: info.name || `CIK ${cik}`,
      city: info.city || "",
      state: info.state || "",
      shares,
      value: now?.value ?? 0,
      prevShares,
      prevValue: before?.value ?? 0,
      change: status === "not-filed" ? null : shares - prevShares,
      changePct: before && status !== "not-filed" ? ratio(shares - prevShares, prevShares) : null,
      status,
      weight: now ? ratio(now.value, now.portfolio) : null,
      prevWeight: before ? ratio(before.value, before.portfolio) : null,
      rank: now?.rank ?? null,
      positions: now?.positions ?? before?.positions ?? null,
      portfolio: now?.portfolio ?? null,
      pctOut: now ? ratio(now.shares, sharesOut) : null,
      price: now ? ratio(now.value, now.shares) : null,
      discretion: now?.discretion || "",
      sole: now?.sole ?? null,
      sharedVote: now?.shared ?? null,
      noVote: now?.none ?? null,
      prn: !!(now || before).prn,
      filed: (now || before).filed,
      accession: (now || before).accession,
      quarters: tenure?.quarters ?? null,
      since: tenure?.since ?? null,
    });
  }
  holders.sort((a, b) => b.value - a.value || b.prevValue - a.prevValue);
  options.sort((a, b) => b.value - a.value);
  return { period: cur, prior, holders, options, summary: holderSummary(holders, options, sharesOut) };
}

const sum = (xs, f) => xs.reduce((t, x) => t + (f(x) || 0), 0);
function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function holderSummary(holders, options = [], sharesOut = null) {
  const now = holders.filter((h) => h.shares > 0);
  const before = holders.filter((h) => h.prevShares > 0);
  const shares = sum(now, (h) => h.shares),
    prevShares = sum(before.filter((h) => h.status !== "not-filed"), (h) => h.prevShares);
  const count = (s) => holders.filter((h) => h.status === s).length;
  const top10 = sum(now.slice(0, 10), (h) => h.shares);
  const puts = options.filter((o) => o.putcall === 1),
    calls = options.filter((o) => o.putcall === 2);
  const weights = now.map((h) => h.weight);
  return {
    holders: now.length,
    prevHolders: before.length,
    shares,
    prevShares,
    value: sum(now, (h) => h.value),
    pctOut: ratio(shares, sharesOut),
    sharesOut,
    newPositions: count("new"),
    exited: count("exited"),
    added: count("added"),
    reduced: count("reduced"),
    unchanged: count("unchanged"),
    notFiled: count("not-filed"),
    bought: sum(holders.filter((h) => h.change > 0), (h) => h.change),
    sold: -sum(holders.filter((h) => h.change < 0), (h) => h.change),
    netChange: sum(holders.filter((h) => h.change != null), (h) => h.change),
    top10Share: ratio(top10, shares),
    medianWeight: median(weights),
    highConviction: now.filter((h) => h.weight >= 0.01).length,
    topHolding: now.filter((h) => h.rank === 1).length,
    price: ratio(sum(now, (h) => h.value), shares),
    putHolders: puts.length,
    callHolders: calls.length,
    putShares: sum(puts, (o) => o.shares),
    callShares: sum(calls, (o) => o.shares),
    putCall: ratio(sum(puts, (o) => o.shares), sum(calls, (o) => o.shares)),
  };
}

// Ownership trend, with % of shares outstanding per quarter.
export function ownershipHistory(history, series) {
  return (history || []).map((h) => {
    const out = sharesAt(series, h.period);
    return { ...h, sharesOut: out?.shares ?? null, pctOut: ratio(h.shares, out?.shares) };
  });
}

export const STATUS_LABEL = {
  new: "New",
  added: "Added",
  reduced: "Reduced",
  unchanged: "Unchanged",
  exited: "Sold out",
  "not-filed": "No filing yet",
  held: "Held",
};

// ---- 13F: one manager's portfolio ----------------------------------------
export function comparePortfolio(data) {
  const cur = data?.period,
    prior = data?.prior;
  const key = (r) => `${r.cusip}:${r.putcall}`;
  const before = new Map((data?.rows || []).filter((r) => r.period === prior).map((r) => [key(r), r]));
  const now = (data?.rows || []).filter((r) => r.period === cur);
  const nowKeys = new Set(now.map(key));
  const filing = (p) => data?.filings?.find((f) => f.period === p);
  const total = filing(cur)?.total || sum(now, (r) => r.value);
  const filedNow = !!filing(cur);
  const rows = now.map((r) => {
    const b = before.get(key(r));
    const price = ratio(r.value, r.shares);
    const change = r.shares - (b?.shares || 0);
    return {
      ...r,
      prevShares: b?.shares || 0,
      prevValue: b?.value || 0,
      change,
      changePct: b ? ratio(change, b.shares) : null,
      flow: price != null ? change * price : null,
      weight: ratio(r.value, total),
      status: !prior ? "held" : !b ? "new" : change > 0 ? "added" : change < 0 ? "reduced" : "unchanged",
    };
  });
  if (filedNow)
    for (const [k, b] of before)
      if (!nowKeys.has(k))
        rows.push({ ...b, period: cur, value: 0, shares: 0, prevShares: b.shares, prevValue: b.value, change: -b.shares, changePct: -1, flow: -b.value, weight: 0, status: "exited", rank: null });
  rows.sort((a, b) => b.value - a.value || b.prevValue - a.prevValue);
  const count = (s) => rows.filter((r) => r.status === s).length;
  const prevTotal = filing(prior)?.total || null;
  const equity = rows.filter((r) => !r.putcall && r.value > 0);
  return {
    period: cur,
    prior,
    filing: filing(cur) || filing(prior) || null,
    rows,
    summary: {
      total,
      prevTotal,
      positions: rows.filter((r) => r.value > 0).length,
      prevPositions: filing(prior)?.positions ?? null,
      newPositions: count("new"),
      exited: count("exited"),
      added: count("added"),
      reduced: count("reduced"),
      bought: sum(rows.filter((r) => r.flow > 0), (r) => r.flow),
      sold: -sum(rows.filter((r) => r.flow < 0), (r) => r.flow),
      top10Weight: ratio(sum(equity.slice(0, 10), (r) => r.value), total),
      options: rows.filter((r) => r.putcall && r.value > 0).length,
    },
  };
}

// ---- XML helpers ---------------------------------------------------------
const unescape = (s) =>
  String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&");
const reCache = new Map();
function blocks(xml, name) {
  let re = reCache.get(name);
  if (!re) reCache.set(name, (re = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "g")));
  return [...String(xml || "").matchAll(re)].map((m) => m[1]);
}
const first = (xml, name) => blocks(xml, name)[0] ?? "";
const text = (xml, name) => unescape(first(xml, name).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
// Form 3/4/5 fields wrap values: <transactionShares><value>10</value></transactionShares>.
const valueOf = (xml, name) => {
  const b = first(xml, name);
  return unescape((/<value>([\s\S]*?)<\/value>/.exec(b)?.[1] ?? (b.includes("<") ? "" : b)).trim());
};
const num = (x) => {
  const n = Number(String(x ?? "").replace(/,/g, "").trim());
  return String(x ?? "").trim() !== "" && Number.isFinite(n) ? n : null;
};
const usDate = (d) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(d).trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : String(d || "").trim() || null;
};

// ---- Schedules 13D and 13G (structured since December 2024) ---------------
export const PERSON_TYPES = {
  IA: "Investment adviser",
  BD: "Broker-dealer",
  BK: "Bank",
  IC: "Insurance company",
  IV: "Investment company",
  EP: "Employee benefit plan",
  HC: "Parent holding company",
  SA: "Savings association",
  CP: "Church plan",
  CO: "Corporation",
  PN: "Partnership",
  IN: "Individual",
  FI: "Non-US institution",
  OO: "Other",
};
export function parseSchedule13(xml) {
  const form = text(xml, "submissionType");
  const d = /13D/i.test(form);
  const persons = (d ? blocks(xml, "reportingPersonInfo") : blocks(xml, "coverPageHeaderReportingPersonDetails")).map((p) => ({
    name: text(p, "reportingPersonName"),
    cik: text(p, "reportingPersonCIK") || null,
    shares: num(d ? text(p, "aggregateAmountOwned") : text(p, "reportingPersonBeneficiallyOwnedAggregateNumberOfShares")),
    percent: num(d ? text(p, "percentOfClass") : text(p, "classPercent")),
    soleVote: num(text(p, "soleVotingPower")),
    sharedVote: num(text(p, "sharedVotingPower")),
    soleDispose: num(text(p, "soleDispositivePower")),
    sharedDispose: num(text(p, "sharedDispositivePower")),
    type: text(p, "typeOfReportingPerson").split(/[\s,]+/)[0] || "",
    citizenship: text(p, "citizenshipOrOrganization"),
    fundSource: d ? text(p, "fundType") : "",
  }));
  return {
    form,
    activist: d,
    amendment: /\/A$/.test(form),
    amendmentNo: num(text(xml, "amendmentNo")),
    filerCik: text(first(xml, "filerCredentials"), "cik") || null,
    issuerName: text(xml, "issuerName"),
    issuerCik: text(xml, "issuerCik") || text(xml, "issuerCIK") || null,
    cusips: blocks(xml, "issuerCusipNumber").map((c) => unescape(c).trim().toUpperCase()).filter((c) => /^[0-9A-Z]{9}$/.test(c)),
    classTitle: text(xml, "securitiesClassTitle"),
    eventDate: usDate(text(xml, d ? "dateOfEvent" : "eventDateRequiresFilingThisStatement")),
    rule: text(xml, "designateRulePursuantThisScheduleFiled"),
    purpose: d ? text(first(xml, "item4"), "transactionPurpose") || text(xml, "item4").slice(0, 1500) : "",
    persons,
  };
}

// Latest Schedule 13D/G per filer, with its change from the filer's
// previous one. `filings` are parsed schedules with filed/accession/url.
export function bigHolders(filings) {
  const byFiler = new Map();
  for (const f of [...filings].sort((a, b) => b.filed.localeCompare(a.filed) || b.accession.localeCompare(a.accession))) {
    const k = f.filerCik || f.persons[0]?.name || f.accession;
    (byFiler.get(k) || byFiler.set(k, []).get(k)).push(f);
  }
  const lead = (f) => [...f.persons].sort((a, b) => (b.shares || 0) - (a.shares || 0))[0] || {};
  const rows = [];
  for (const list of byFiler.values()) {
    const [latest, previous] = list;
    const p = lead(latest),
      q = previous ? lead(previous) : null;
    rows.push({
      name: p.name || "Unnamed filer",
      type: p.type,
      typeLabel: PERSON_TYPES[p.type] || p.type || "",
      shares: p.shares,
      percent: p.percent,
      soleVote: p.soleVote,
      sharedVote: p.sharedVote,
      soleDispose: p.soleDispose,
      sharedDispose: p.sharedDispose,
      members: latest.persons.length,
      form: latest.form,
      activist: latest.activist,
      eventDate: latest.eventDate,
      filed: latest.filed,
      url: latest.url,
      purpose: latest.purpose,
      prevShares: q?.shares ?? null,
      prevPercent: q?.percent ?? null,
      change: q && p.shares != null && q.shares != null ? p.shares - q.shares : null,
      filings: list.length,
      below5: p.percent != null && p.percent < 5,
    });
  }
  return rows.sort((a, b) => a.below5 - b.below5 || (b.percent || 0) - (a.percent || 0));
}

// ---- Forms 3, 4 and 5 (insiders) -----------------------------------------
export const TX_CODES = {
  P: "Open-market buy",
  S: "Open-market sale",
  A: "Grant or award",
  M: "Option exercise",
  X: "Option exercise (in the money)",
  C: "Conversion",
  F: "Tax withholding",
  G: "Gift",
  D: "Sold back to issuer",
  J: "Other",
  I: "Discretionary",
  W: "Will or inheritance",
  Z: "Voting trust",
  K: "Equity swap",
  E: "Expiration of short derivative",
  H: "Expiration of long derivative",
  L: "Small acquisition",
  O: "Out-of-the-money exercise",
  U: "Tender of shares",
  V: "Voluntarily reported",
};
export function parseOwnership(xml) {
  const owners = blocks(xml, "reportingOwner").map((o) => {
    const rel = first(o, "reportingOwnerRelationship");
    const yes = (n) => /^(1|true)$/i.test(text(rel, n));
    return {
      cik: text(o, "rptOwnerCik"),
      name: text(o, "rptOwnerName"),
      director: yes("isDirector"),
      officer: yes("isOfficer"),
      tenPct: yes("isTenPercentOwner"),
      other: yes("isOther"),
      title: text(rel, "officerTitle") || text(rel, "otherText"),
    };
  });
  const row = (b, derivative, holding) => ({
    security: valueOf(b, "securityTitle"),
    date: valueOf(b, "transactionDate") || null,
    code: holding ? "" : text(first(b, "transactionCoding"), "transactionCode"),
    shares: num(valueOf(b, "transactionShares")),
    price: num(valueOf(b, "transactionPricePerShare")),
    ad: valueOf(b, "transactionAcquiredDisposedCode"),
    after: num(valueOf(b, "sharesOwnedFollowingTransaction")),
    direct: valueOf(b, "directOrIndirectOwnership") !== "I",
    nature: valueOf(b, "natureOfOwnership"),
    derivative,
    holding,
    exercise: derivative ? num(valueOf(b, "conversionOrExercisePrice")) : null,
    underlying: derivative ? num(valueOf(b, "underlyingSecurityShares")) : null,
  });
  return {
    type: text(xml, "documentType"),
    period: text(xml, "periodOfReport"),
    issuer: { cik: text(xml, "issuerCik"), name: text(xml, "issuerName"), symbol: text(xml, "issuerTradingSymbol") },
    owners,
    plan: /^(1|true)$/i.test(text(xml, "aff10b5One")),
    rows: [
      ...blocks(xml, "nonDerivativeTransaction").map((b) => row(b, false, false)),
      ...blocks(xml, "nonDerivativeHolding").map((b) => row(b, false, true)),
      ...blocks(xml, "derivativeTransaction").map((b) => row(b, true, false)),
      ...blocks(xml, "derivativeHolding").map((b) => row(b, true, true)),
    ],
  };
}
export function relationship(o) {
  const parts = [];
  if (o.officer) parts.push(o.title || "Officer");
  if (o.director) parts.push("Director");
  if (o.tenPct) parts.push("10% owner");
  if (o.other && !o.officer) parts.push(o.title || "Other");
  return parts.join(", ") || "—";
}

// Insider roster and transaction log from parsed forms (each with filed,
// accession, url). Holdings come from each insider's latest form: direct
// shares plus indirect holdings by trust, spouse and so on.
export function insiderSummary(forms, since = null) {
  const sorted = [...forms].sort((a, b) => b.filed.localeCompare(a.filed) || b.accession.localeCompare(a.accession));
  const people = new Map();
  const log = [];
  for (const f of sorted) {
    const owner = f.owners[0];
    if (!owner) continue;
    const key = owner.cik || owner.name;
    for (const r of f.rows)
      if (!r.holding && (!since || (r.date || f.filed) >= since))
        log.push({ ...r, owner: owner.name, ownerKey: key, role: relationship(owner), form: f.type, filed: f.filed, url: f.url, plan: f.plan, value: r.shares != null && r.price != null ? r.shares * r.price : null });
    if (people.has(key)) continue;
    const last = new Map();
    for (const r of f.rows.filter((r) => !r.derivative && r.after != null)) last.set(`${r.direct ? "D" : "I"}:${r.nature}:${r.security}`, r);
    const held = [...last.values()];
    people.set(key, {
      name: owner.name,
      cik: owner.cik,
      role: relationship(owner),
      director: owner.director,
      officer: owner.officer,
      tenPct: owner.tenPct,
      direct: held.some((r) => r.direct) ? sum(held.filter((r) => r.direct), (r) => r.after) : null,
      indirect: held.some((r) => !r.direct) ? sum(held.filter((r) => !r.direct), (r) => r.after) : null,
      derivatives: f.rows.filter((r) => r.derivative && r.after != null).length,
      lastFiled: f.filed,
      lastForm: f.type,
      url: f.url,
    });
  }
  for (const p of people.values()) {
    const mine = log.filter((x) => x.ownerKey === (p.cik || p.name) && !x.derivative);
    p.bought = sum(mine.filter((x) => x.code === "P"), (x) => x.shares);
    p.sold = sum(mine.filter((x) => x.code === "S"), (x) => x.shares);
    p.boughtValue = sum(mine.filter((x) => x.code === "P"), (x) => x.value);
    p.soldValue = sum(mine.filter((x) => x.code === "S"), (x) => x.value);
    p.trades = mine.length;
  }
  log.sort((a, b) => (b.date || b.filed).localeCompare(a.date || a.filed));
  const open = log.filter((x) => !x.derivative && (x.code === "P" || x.code === "S"));
  const buys = open.filter((x) => x.code === "P"),
    sells = open.filter((x) => x.code === "S");
  return {
    people: [...people.values()].sort((a, b) => (b.direct || 0) + (b.indirect || 0) - ((a.direct || 0) + (a.indirect || 0))),
    log,
    summary: {
      insiders: people.size,
      buys: buys.length,
      sells: sells.length,
      buyers: new Set(buys.map((x) => x.ownerKey)).size,
      sellers: new Set(sells.map((x) => x.ownerKey)).size,
      boughtShares: sum(buys, (x) => x.shares),
      soldShares: sum(sells, (x) => x.shares),
      boughtValue: sum(buys, (x) => x.value),
      soldValue: sum(sells, (x) => x.value),
      planSales: sells.filter((x) => x.plan).length,
    },
  };
}

// ---- Which ownership filings a company's EDGAR list contains --------------
const INSIDER = new Set(["3", "4", "5", "3/A", "4/A", "5/A"]);
export function ownershipFilings(submissions) {
  const r = submissions?.filings?.recent;
  if (!r?.form) return { schedules: [], legacy: [], insiders: [] };
  const cik = Number(submissions.cik);
  const out = { schedules: [], legacy: [], insiders: [] };
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i],
      accession = r.accessionNumber[i],
      filed = r.filingDate[i],
      primary = r.primaryDocument[i] || "";
    // EDGAR lists the styled copy (xslF345X06/form4.xml); the raw file sits beside it.
    const doc = primary.split("/").pop();
    const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, "")}/`;
    const entry = { form, accession, filed, doc, url: base + primary };
    if (/^SCHEDULE 13[DG]/.test(form) && doc.endsWith(".xml")) out.schedules.push(entry);
    else if (/^SC 13[DG]/.test(form)) out.legacy.push(entry);
    else if (INSIDER.has(form) && doc.endsWith(".xml")) out.insiders.push(entry);
  }
  return out;
}

// ---- Listings ------------------------------------------------------------
// Alpha Vantage's documented suffixes for listings outside the US.
export const ALPHA_SUFFIX = { XLON: "LON", XTSE: "TRT", XTSX: "TRV", XETR: "DEX", XFRA: "FRK", XBOM: "BSE", XSHG: "SHH", XSHE: "SHZ" };
export function alphaSymbol(key) {
  const [s, mic] = String(key).split(":");
  if (!mic) return s;
  return ALPHA_SUFFIX[mic] ? `${s}.${ALPHA_SUFFIX[mic]}` : null;
}
export const isUSKey = (key) => !String(key).includes(":");
