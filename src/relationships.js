import seed from "./data/relationships.json" with { type: "json" };
import { prettyName } from "./filings.js";
export const seedGraph = () => structuredClone(seed);
const e = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const id = (x) => typeof x === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(x);
const date = (x) =>
  typeof x === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(x) &&
  Number.isFinite(Date.parse(x)) &&
  new Date(x).toISOString().slice(0, 10) === x;
export function validateGraph(g, { imported = false } = {}) {
  if (
    g?.version !== 1 ||
    !Array.isArray(g.nodes) ||
    !Array.isArray(g.edges) ||
    g.nodes.length > 2000 ||
    g.edges.length > 5000
  )
    throw Error(
      "Expected v1 graph, at most 2,000 entities and 5,000 relationships",
    );
  const nodes = new Set(),
    edges = new Set();
  for (const n of g.nodes) {
    if (
      !id(n.id) ||
      nodes.has(n.id) ||
      typeof n.name !== "string" ||
      !n.name.trim() ||
      n.name.length > 200
    )
      throw Error("Invalid or duplicate entity");
    nodes.add(n.id);
  }
  for (const a of g.edges) {
    if (
      !id(a.id) ||
      edges.has(a.id) ||
      !nodes.has(a.supplier) ||
      !nodes.has(a.customer) ||
      a.supplier === a.customer
    )
      throw Error("Invalid relationship endpoints or duplicate ID");
    edges.add(a.id);
    let u;
    try {
      u = new URL(a.sourceURL);
    } catch {
      throw Error("Every relationship requires a source URL");
    }
    if (u.protocol !== "https:" || u.username || u.password)
      throw Error("Source must be a credential-free HTTPS URL");
    if (
      !date(a.observedOn) ||
      typeof a.evidence !== "string" ||
      !a.evidence.trim() ||
      a.evidence.length > 2000 ||
      typeof a.relationship !== "string" ||
      !a.relationship.trim()
    )
      throw Error(
        "Every edge needs a date, relationship type and evidence summary",
      );
    if (
      a.revenueShare !== null &&
      a.revenueShare !== undefined &&
      (!Number.isFinite(a.revenueShare) ||
        a.revenueShare < 0 ||
        a.revenueShare > 1 ||
        !a.revenuePeriod ||
        !a.revenueBasis)
    )
      throw Error(
        "Concentration requires a fraction, period and denominator description",
      );
    if (a.retrievedOn != null && !date(a.retrievedOn))
      throw Error("Invalid retrieval date");
    if (a.reviewedOn != null && !date(a.reviewedOn))
      throw Error("Invalid review date");
    if (imported) {
      a.review = "unreviewed";
      delete a.reviewedOn;
    } else if (!["reviewed", "unreviewed"].includes(a.review))
      throw Error("Invalid review state");
  }
  return g;
}
// A subsidiary listed without its own ticker, e.g. parent "Qualcomm
// Incorporated (QCOM)", belongs to that listed parent.
export function parentTicker(node) {
  return node?.ticker ? "" : node?.parent?.match(/\(([A-Z][A-Z0-9.]{0,9})\)\s*$/)?.[1] || "";
}
// Entity IDs shown together as one company: the entity plus any subsidiaries
// whose parent ticker is the entity's ticker.
export function companyGroup(graph, center) {
  const n = graph.nodes.find((x) => x.id === center);
  if (!n) return new Set([center]);
  return new Set([
    n.id,
    ...(n.ticker ? graph.nodes.filter((x) => parentTicker(x) === n.ticker).map((x) => x.id) : []),
  ]);
}
// The listed company for a ticker, created if the graph doesn't have it yet.
// Returns the node; mutates graph.nodes when adding one.
export function ensureCompany(graph, ticker, name) {
  let n = graph.nodes.find((x) => x.ticker === ticker);
  if (n) return n;
  const sub = graph.nodes.find((x) => parentTicker(x) === ticker);
  n = {
    id: "t-" + ticker.toLowerCase().replace(/[^a-z0-9]/g, "-"),
    name: name || sub?.parent.replace(/\s*\([^)]*\)\s*$/, "") || ticker,
    ticker,
  };
  graph.nodes.push(n);
  return n;
}
// Where clicking an entity should land: a subsidiary without a ticker opens
// its listed parent, so the whole company's relationships show together.
export function resolveCenter(graph, id) {
  const n = graph.nodes.find((x) => x.id === id);
  const t = parentTicker(n);
  return t ? ensureCompany(graph, t).id : id;
}
export function neighborhood(
  graph,
  center,
  { includeUnreviewed = false, asOf = "9999-12-31" } = {},
) {
  const group = companyGroup(graph, center);
  const valid = graph.edges.filter(
    (a) =>
      (includeUnreviewed || a.review === "reviewed") && a.observedOn <= asOf,
  );
  return {
    suppliers: valid.filter((a) => group.has(a.customer) && !group.has(a.supplier)),
    customers: valid.filter((a) => group.has(a.supplier) && !group.has(a.customer)),
  };
}
export function mergeGraph(existing, incoming) {
  const next = validateGraph(structuredClone(incoming), { imported: true });
  const merged = structuredClone(existing);
  for (const n of next.nodes) {
    const old = merged.nodes.find((x) => x.id === n.id);
    if (
      old &&
      ["name", "ticker", "parent"].some((k) => (old[k] ?? "") !== (n[k] ?? ""))
    )
      throw Error("Entity ID collision: " + n.id);
    if (!old) merged.nodes.push(n);
  }
  for (const a of next.edges) {
    if (merged.edges.some((x) => x.id === a.id))
      throw Error("Relationship ID already exists: " + a.id);
    merged.edges.push(a);
  }
  return validateGraph(merged);
}
const short = (x, n) => (x.length > n ? x.slice(0, n - 1) + "…" : x);
// One graph node per counterparty, however many evidence records link them.
function counterparties(edges, side, group, nodeMap) {
  const by = new Map();
  for (const a of edges) {
    const other = side === "supplier" ? a.supplier : a.customer;
    const own = side === "supplier" ? a.customer : a.supplier;
    const entry = by.get(other) || { entity: nodeMap[other], edges: [], via: new Set() };
    entry.edges.push(a);
    if (group.size > 1) entry.via.add(own);
    by.set(other, entry);
  }
  return [...by.values()]
    .filter((x) => x.entity)
    .map((x) => ({ ...x, reviewed: x.edges.some((a) => a.review === "reviewed") }))
    .sort((a, b) => b.reviewed - a.reviewed || b.edges.length - a.edges.length || a.entity.name.localeCompare(b.entity.name));
}
const MAX_PER_SIDE = 14;
export function relationshipsView(
  graph,
  center = "apple",
  showCandidates = false,
  { trail = [], progress = "", width = 960 } = {},
) {
  const n = graph.nodes.find((x) => x.id === center) || graph.nodes[0];
  if (!n) return '<div class="empty">No entities. Import a graph.</div>';
  const around = neighborhood(graph, n.id, { includeUnreviewed: showCandidates });
  const name = prettyName(n.name);
  const group = companyGroup(graph, n.id);
  // Display copies with readable names; IDs and sources are unchanged.
  const nodeMap = Object.fromEntries(graph.nodes.map((x) => [x.id, { ...x, name: prettyName(x.name) }]));
  const all = [...around.suppliers, ...around.customers];
  const sup = counterparties(around.suppliers, "supplier", group, nodeMap);
  const cus = counterparties(around.customers, "customer", group, nodeMap);
  const shownSup = sup.slice(0, MAX_PER_SIDE),
    shownCus = cus.slice(0, MAX_PER_SIDE);
  // Laid out in real pixels for the panel's width: columns spread out and cards
  // widen a little on big screens, but text sizes never change.
  const VW = Math.max(760, Math.round(width) || 960);
  const ROW = 66,
    TOP = 56,
    W = Math.round(Math.min(320, Math.max(220, VW * 0.2)));
  const chars = (pad) => Math.floor((W - pad) / 7.4);
  const rows = Math.max(shownSup.length, shownCus.length, 1) + (Math.max(sup.length, cus.length) > MAX_PER_SIDE ? 1 : 0);
  const height = Math.max(260, rows * ROW + TOP + 20);
  const cy = TOP + (height - TOP - 20) / 2;
  const colX = { sup: 20, mid: Math.round((VW - W) / 2), cus: VW - W - 20 };
  const yFor = (i, count) => {
    const block = count * ROW;
    return TOP + (height - TOP - 20 - block) / 2 + i * ROW + ROW / 2;
  };
  const sublabel = (entity) => entity.ticker || parentTicker(entity) || "Private / unlisted";
  const card = (c, x, y, side) => {
    const entity = c.entity;
    const candidate = !c.reviewed;
    const via = [...c.via].filter((v) => v !== n.id).map((v) => nodeMap[v]?.name).filter(Boolean);
    const meta = `${sublabel(entity)}${via.length ? " · via " + via[0].replace(/,? (Inc|Corp|Corporation|Ltd)\.?$/, "") : ""}${c.edges.length > 1 ? ` · ${c.edges.length} sources` : ""}${candidate ? " · candidate" : ""}`;
    const tip = `${entity.name}${via.length ? " · via " + via.join(", ") : ""}\n${c.edges.map((a) => `${a.relationship} · ${a.observedOn}`).join("\n")}`;
    return `<g class="g-node ${side}${candidate ? " candidate" : ""}" role="button" tabindex="0" data-entity="${e(entity.id)}" aria-label="Explore ${e(entity.name)}"><rect x="${x}" y="${y - 24}" width="${W}" height="48" rx="10"/><text class="g-name" x="${x + 14}" y="${y - 3}">${e(short(entity.name, chars(28)))}</text><text class="g-meta" x="${x + 14}" y="${y + 14}">${e(short(meta, chars(-40)))}</text><title>${e(tip)}</title></g>`;
  };
  const edgePath = (c, y, side) => {
    const cls = `g-edge${c.reviewed ? "" : " candidate"}`;
    const [x1, y1, x2, y2] = side === "sup" ? [colX.sup + W, y, colX.mid, cy] : [colX.mid + W, cy, colX.cus, y];
    const mx = (x1 + x2) / 2;
    return `<path class="${cls}" data-edge-for="${e(c.entity.id)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}" marker-end="url(#edge-arrow)"/>`;
  };
  const side = (list, full, key) => {
    const paths = [],
      cards = [];
    list.forEach((c, i) => {
      const y = yFor(i, list.length + (full.length > list.length ? 1 : 0));
      paths.push(edgePath(c, y, key));
      cards.push(card(c, colX[key], y, key));
    });
    if (full.length > list.length) {
      const y = yFor(list.length, list.length + 1);
      cards.push(`<text class="g-more" x="${colX[key] + 14}" y="${y + 4}">+${full.length - list.length} more · see evidence below</text>`);
    }
    return { paths: paths.join(""), cards: cards.join("") };
  };
  const left = side(shownSup, sup, "sup"),
    right = side(shownCus, cus, "cus");
  const subs = [...group].filter((id) => id !== n.id).map((id) => nodeMap[id]?.name).filter(Boolean);
  const centerCard = `<g class="g-node center" role="button" tabindex="0" data-entity="${e(n.id)}" aria-label="${e(name)} (selected)"><rect x="${colX.mid}" y="${cy - 34}" width="${W}" height="68" rx="12"/><text class="g-name" x="${colX.mid + 16}" y="${cy - 9}">${e(short(name, chars(32)))}</text><text class="g-meta" x="${colX.mid + 16}" y="${cy + 10}">${e(sublabel(n))}</text><text class="g-meta" x="${colX.mid + 16}" y="${cy + 25}">${sup.length} supplier${sup.length === 1 ? "" : "s"} · ${cus.length} customer${cus.length === 1 ? "" : "s"}</text><title>${e(name)}${subs.length ? " · includes " + e(subs.join(", ")) : ""}</title></g>`;
  // Only the last few companies, so the trail stays on one line.
  const SHOW = 4;
  const first = Math.max(0, trail.length - SHOW);
  const crumb = (id, i) => {
    const x = nodeMap[id];
    if (!x) return "";
    return i === trail.length - 1
      ? `<span class="crumb current" aria-current="page">${e(short(x.name, 34))}</span>`
      : `<button class="crumb" data-action="graph-crumb" data-value="${i}" title="${e(x.name)}">${e(short(x.name, 22))}</button>`;
  };
  const crumbs =
    (first > 0 ? `<button class="crumb" data-action="graph-crumb" data-value="${first - 1}" title="Earlier companies">…</button><span class="crumb-sep">›</span>` : "") +
    trail.slice(first).map((id, i) => crumb(id, first + i)).filter(Boolean).join('<span class="crumb-sep">›</span>');
  const card2 = (a) => `<article class="evidence-card${a.review === "reviewed" ? "" : " candidate"}"><div class="panel-head"><h3><button class="link-button" data-entity="${e(a.supplier)}">${e(nodeMap[a.supplier].name)}</button> → <button class="link-button" data-entity="${e(a.customer)}">${e(nodeMap[a.customer].name)}</button></h3><span class="tag">${a.review === "reviewed" ? "HISTORICAL DISCLOSURE" : "UNREVIEWED CLAIM"}</span></div><p><b>${e(a.relationship)}</b> · ${e(a.product || "Product not specified")}</p><p>${e(a.evidence)}</p><div class="metrics"><span>Disclosure date</span><b>${e(a.observedOn)}</b><span>Reporting period</span><b>${e(a.reportingPeriod || "Not specified")}</b><span>Source retrieved</span><b>${e(a.retrievedOn || "Not recorded")}</b><span>Evidence reviewed</span><b>${e(a.reviewedOn || "Pending")}</b><span>Revenue concentration</span><b>${a.revenueShare == null ? "Not disclosed" : (a.revenueShare * 100).toFixed(1) + "% · " + e(a.revenuePeriod) + " · " + e(a.revenueBasis)}</b><span>Current relationship status</span><b>Not independently verified</b></div><a href="${e(a.sourceURL)}" target="_blank" rel="noreferrer">${e(a.sourceTitle || "Open evidence source")} ↗</a>${a.review !== "reviewed" ? `<button data-action="graph-review" data-value="${e(a.id)}">Mark source reviewed</button>` : ""}</article>`;
  const evidence = (title, list) =>
    list.length ? `<h3 class="evidence-group">${title} <small>${list.length}</small></h3>${list.map(card2).join("")}` : "";
  return `<section class="panel graph-panel"><div class="graph-toolbar"><button class="icon-btn" data-action="graph-back" ${trail.length < 2 ? "disabled" : ""} aria-label="Back to previous company">←</button><div class="combo"><input id="graph-search" type="search" autocomplete="off" spellcheck="false" placeholder="Search any company or ticker…" aria-label="Search any company or ticker" aria-controls="graph-results" aria-expanded="false" role="combobox"><div id="graph-results" class="combo-list" role="listbox" hidden></div></div><label class="inline-field">Show<select id="graph-candidates"><option value="all" ${showCandidates ? "selected" : ""}>All links (incl. candidates)</option><option value="reviewed" ${!showCandidates ? "selected" : ""}>Reviewed only</option></select></label><button data-action="graph-export">Export</button></div><div class="trail-row"><div class="trail" aria-label="Companies visited">${crumbs || `<span class="crumb current">${e(name)}</span>`}</div>${progress ? `<span class="pill live">${e(progress)}</span>` : ""}</div><div class="relationship-graph"><svg viewBox="0 0 ${VW} ${height}" width="${VW}" height="${height}" role="group" aria-label="Suppliers to ${e(name)} to customers"><defs><marker id="edge-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" class="g-arrow"/></marker></defs><text class="g-col" x="${colX.sup}" y="26">SUPPLIERS · ${sup.length}</text><text class="g-col" x="${colX.mid}" y="26">SELECTED COMPANY</text><text class="g-col" x="${colX.cus}" y="26">CUSTOMERS / DISTRIBUTORS · ${cus.length}</text>${left.paths}${right.paths}${left.cards}${right.cards}${centerCard}${!sup.length ? `<text class="g-more" x="${colX.sup + 14}" y="${cy + 4}">No suppliers on record</text>` : ""}${!cus.length ? `<text class="g-more" x="${colX.cus + 14}" y="${cy + 4}">No customers on record</text>` : ""}</svg></div><div class="graph-legend"><span><i class="lg solid"></i>Reviewed disclosure</span><span><i class="lg dashed"></i>Unreviewed candidate</span><span>Click any company to explore its relationships · ← to go back</span></div>${!all.length ? '<div class="empty">No relationships on record for this company yet. This does not mean the company has no suppliers or customers.</div>' : ""}<div class="stats"><div class="stat"><span>Supplier evidence records</span><strong>${around.suppliers.length}</strong></div><div class="stat"><span>Customer evidence records</span><strong>${around.customers.length}</strong></div><div class="stat"><span>Unreviewed records in dataset</span><strong>${graph.edges.filter((x) => x.review !== "reviewed").length}</strong></div><div class="stat"><span>Concentration evidence</span><strong>${all.filter((a) => a.revenueShare != null).length} disclosed</strong><small>No inferred weights</small></div></div></section><section class="panel"><div class="panel-head"><h2>Evidence & relationship details</h2></div>${evidence("Suppliers", around.suppliers) + evidence("Customers & distributors", around.customers) || "<p>No evidence to display for this company.</p>"}<p class="muted">A reviewed source establishes what was disclosed on its date; it does not establish that the relationship is still active. Edges run from the legal entity named as supplier to the customer or distributor; subsidiaries without their own ticker are shown under their listed parent. Procurement values, revenue shares and relationship strength are unknown unless explicitly sourced.</p></section>`;
}
