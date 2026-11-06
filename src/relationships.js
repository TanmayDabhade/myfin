import seed from "./data/relationships.json" with { type: "json" };
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
export function neighborhood(
  graph,
  center,
  { includeUnreviewed = false, asOf = "9999-12-31" } = {},
) {
  const valid = graph.edges.filter(
    (a) =>
      (includeUnreviewed || a.review === "reviewed") && a.observedOn <= asOf,
  );
  return {
    suppliers: valid.filter((a) => a.customer === center),
    customers: valid.filter((a) => a.supplier === center),
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
export function relationshipsView(
  graph,
  center = "apple",
  showCandidates = false,
) {
  const n = graph.nodes.find((x) => x.id === center) || graph.nodes[0];
  if (!n) return '<div class="empty">No entities. Import a graph.</div>';
  const around = neighborhood(graph, n.id, {
    includeUnreviewed: showCandidates,
  });
  const nodeMap = Object.fromEntries(graph.nodes.map((x) => [x.id, x]));
  const all = [...around.suppliers, ...around.customers];
  const height = Math.max(
    320,
    Math.max(around.suppliers.length, around.customers.length) * 90 + 80,
  );
  const centerY = height / 2;
  const lines = [];
  const node = (entity, x, y, edge) =>
    `<g role="button" tabindex="0" data-entity="${e(entity.id)}" aria-label="Explore ${e(entity.name)}"><rect x="${x}" y="${y - 27}" width="210" height="54" rx="8" fill="${entity.id === n.id ? "#4b4b4b" : "#2c2c2c"}" stroke="#747474"/><text x="${x + 12}" y="${y - 6}" fill="#f3f3f3" font-size="12">${e(entity.name.length > 27 ? entity.name.slice(0, 25) + "…" : entity.name)}</text><text x="${x + 12}" y="${y + 14}" fill="#b9b9b9" font-size="10">${e(entity.ticker || entity.parent || "Entity")} ${edge?.review === "unreviewed" ? "· CANDIDATE" : ""}</text><title>${e(entity.name)}${edge ? " · " + e(edge.relationship) + " · " + e(edge.observedOn) : ""}</title></g>`;
  const branch = (edges, left) =>
    edges
      .map((a, i) => {
        const y = 70 + i * 90;
        lines.push(
          `<path d="M${left ? 230 : 560},${left ? y : centerY} C${left ? 290 : 620},${left ? y : centerY} ${left ? 290 : 620},${left ? centerY : y} ${left ? 350 : 680},${left ? centerY : y}" fill="none" stroke="${a.review === "reviewed" ? "#b1b1b1" : "#b8b8b8"}" stroke-width="1.5" ${a.review === "unreviewed" ? 'stroke-dasharray="5 4"' : ""} marker-end="url(#edge-arrow)"/>`,
        );
        return node(
          nodeMap[left ? a.supplier : a.customer],
          left ? 20 : 680,
          y,
          a,
        );
      })
      .join("");
  const suppliers = branch(around.suppliers, true),
    customers = branch(around.customers, false);
  return `<section class="panel"><div class="panel-head"><h2>Company relationship explorer</h2><span class="tag">DATED PRIMARY-SOURCE DISCLOSURES</span><button data-action="graph-export">Export evidence graph</button></div><div class="filters"><label>Company<select id="graph-center">${graph.nodes.map((x) => `<option value="${e(x.id)}" ${x.id === n.id ? "selected" : ""}>${e(x.name)} ${e(x.ticker || "")}</option>`).join("")}</select></label><label>Evidence filter<select id="graph-candidates"><option value="reviewed" ${!showCandidates ? "selected" : ""}>Reviewed historical disclosures</option><option value="all" ${showCandidates ? "selected" : ""}>Include unreviewed claims</option></select></label></div><p>Click a company to recenter and explore another tier. A reviewed source establishes what was disclosed on its date; it does not establish that the relationship is still active. This is a small curated evidence set, not comprehensive coverage.</p><div class="relationship-graph"><svg viewBox="0 0 920 ${height}" role="group" aria-label="Suppliers to ${e(n.name)} to customers"><defs><marker id="edge-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#b1b1b1"/></marker></defs><text x="20" y="22" fill="#acacac">SUPPLIERS →</text><text x="350" y="22" fill="#acacac">SELECTED COMPANY</text><text x="680" y="22" fill="#acacac">→ CUSTOMERS / DISTRIBUTORS</text>${lines.join("")}${suppliers}${customers}${node(n, 350, centerY)}</svg></div>${!all.length ? '<div class="empty">No reviewed relationships in this dataset. This does not mean the company has no suppliers or customers.</div>' : ""}<div class="stats"><div class="stat"><span>Supplier evidence records</span><strong>${around.suppliers.length}</strong></div><div class="stat"><span>Customer evidence records</span><strong>${around.customers.length}</strong></div><div class="stat"><span>Unreviewed records in dataset</span><strong>${graph.edges.filter((x) => x.review !== "reviewed").length}</strong></div><div class="stat"><span>Concentration evidence</span><strong>${all.filter((a) => a.revenueShare != null).length} disclosed</strong><small>No inferred weights</small></div></div></section><section class="panel"><div class="panel-head"><h2>Evidence & relationship details</h2></div>${all.map((a) => `<article class="evidence-card"><div class="panel-head"><h3>${e(nodeMap[a.supplier].name)} → ${e(nodeMap[a.customer].name)}</h3><span class="tag">${a.review === "reviewed" ? "HISTORICAL DISCLOSURE" : "UNREVIEWED CLAIM"}</span></div><p><b>${e(a.relationship)}</b> · ${e(a.product || "Product not specified")}</p><p>${e(a.evidence)}</p><div class="metrics"><span>Disclosure date</span><b>${e(a.observedOn)}</b><span>Reporting period</span><b>${e(a.reportingPeriod || "Not specified")}</b><span>Source retrieved</span><b>${e(a.retrievedOn || "Not recorded")}</b><span>Evidence reviewed</span><b>${e(a.reviewedOn || "Pending")}</b><span>Revenue concentration</span><b>${a.revenueShare == null ? "Not disclosed" : (a.revenueShare * 100).toFixed(1) + "% · " + e(a.revenuePeriod) + " · " + e(a.revenueBasis)}</b><span>Current relationship status</span><b>Not independently verified</b></div><a href="${e(a.sourceURL)}" target="_blank" rel="noreferrer">${e(a.sourceTitle || "Open evidence source")} ↗</a>${a.review !== "reviewed" ? `<button data-action="graph-review" data-value="${e(a.id)}">Mark source reviewed</button>` : ""}</article>`).join("") || "<p>No evidence to display for this entity.</p>"}</section><section class="panel"><h2>Coverage and interpretation</h2><p>Edges run from the legal entity identified as supplier to the customer or distributor. Listed parent tickers are context, not a claim that the parent directly signed the agreement. No unnamed customers are assigned identities. Procurement values, revenue shares and relationship strength are unknown unless explicitly sourced.</p><small>Seed sources: Apple/Broadcom announcement (2023), Qualcomm Technologies/Apple announcement (2023), TD SYNNEX FY2024 annual report.</small></section>`;
}
