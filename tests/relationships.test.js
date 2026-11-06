import test from "node:test";
import assert from "node:assert/strict";
import {
  seedGraph,
  validateGraph,
  neighborhood,
  mergeGraph,
  relationshipsView,
  resolveCenter,
  companyGroup,
  ensureCompany,
  parentTicker,
} from "../src/relationships.js";

test("curated evidence preserves supply direction and disclosure dates", () => {
  const g = validateGraph(seedGraph());
  const a = neighborhood(g, "apple");
  assert.deepEqual(
    a.suppliers.map((x) => x.supplier),
    ["broadcom", "qualcomm-tech"],
  );
  assert.equal(a.customers[0].customer, "td-synnex");
  assert.equal(neighborhood(g, "td-synnex").suppliers.length, 4);
  assert.equal(
    neighborhood(g, "apple", { asOf: "2024-12-31" }).customers.length,
    0,
  );
  assert.equal(g.nodes.find((x) => x.id === "qualcomm-tech").ticker, "");
});
test("imports cannot self-certify review and failures are atomic", () => {
  const base = seedGraph();
  const addition = seedGraph();
  addition.edges = [addition.edges[0]];
  addition.edges[0].id = "new-evidence";
  const result = mergeGraph(base, addition);
  assert.equal(result.edges.at(-1).review, "unreviewed");
  assert.equal(result.edges.at(-1).reviewedOn, undefined);
  assert.equal(neighborhood(result, "apple").suppliers.length, 2);
  assert.equal(
    neighborhood(result, "apple", { includeUnreviewed: true }).suppliers.length,
    3,
  );
  assert.throws(() => mergeGraph(base, base), /already exists/);
  assert.equal(base.edges.length, 6);
});
test("reject invalid provenance, direction, dates and unsourced concentration", () => {
  for (const patch of [
    { sourceURL: "javascript:alert(1)" },
    { sourceURL: "https://user:pass@example.com" },
    { supplier: "unknown" },
    { supplier: "apple" },
    { observedOn: "2025-02-30" },
    { evidence: "" },
    { revenueShare: 0.2 },
    { reviewedOn: "yesterday" },
  ]) {
    const g = seedGraph();
    Object.assign(g.edges[0], patch);
    assert.throws(() => validateGraph(g));
  }
  const g = seedGraph();
  Object.assign(g.edges[0], {
    revenueShare: 0.2,
    revenuePeriod: "FY2024",
    revenueBasis: "Supplier total revenue",
  });
  assert.equal(validateGraph(g).edges[0].revenueShare, 0.2);
});
test("rendering escapes imported text and distinguishes absence of coverage", () => {
  const g = seedGraph();
  g.nodes[0].name = "<img src=x onerror=alert(1)>";
  assert.ok(!relationshipsView(g).includes("<img"));
  g.edges = [];
  assert.match(
    relationshipsView(g),
    /does not mean the company has no suppliers/,
  );
});
test("a subsidiary without a ticker opens its listed parent with its links", () => {
  const g = seedGraph();
  const id = resolveCenter(g, "qualcomm-tech");
  const parent = g.nodes.find((x) => x.id === id);
  assert.equal(parent.ticker, "QCOM");
  assert.equal(parent.name, "Qualcomm Incorporated");
  assert.equal(resolveCenter(g, "qualcomm-tech"), id, "parent is created once");
  assert.deepEqual([...companyGroup(g, id)], [id, "qualcomm-tech"]);
  const q = neighborhood(g, id);
  assert.deepEqual(q.customers.map((x) => x.customer), ["apple"]);
  // Apple's own view is unchanged by the parent node.
  assert.equal(neighborhood(g, "apple").suppliers.length, 2);
  assert.equal(resolveCenter(g, "apple"), "apple");
  const html = relationshipsView(g, id, false, { trail: ["apple", id] });
  assert.match(html, /data-action="graph-back"(?! disabled)/);
  assert.match(html, /data-action="graph-crumb" data-value="0" title="Apple Inc\.">Apple Inc\./);
});
test("ensureCompany reuses an existing ticker", () => {
  const g = seedGraph();
  assert.equal(ensureCompany(g, "AAPL").id, "apple");
  const n = ensureCompany(g, "NVDA", "NVIDIA Corporation");
  assert.deepEqual(n, { id: "t-nvda", name: "NVIDIA Corporation", ticker: "NVDA" });
  assert.equal(parentTicker({ ticker: "", parent: "Dell Technologies (DELL)" }), "DELL");
  assert.equal(parentTicker({ ticker: "X", parent: "Y (Z)" }), "");
});
test("the trail keeps the last four companies on one line", () => {
  const g = seedGraph();
  const trail = ["cisco", "td-synnex", "dell", "microsoft", "broadcom", "apple"];
  const html = relationshipsView(g, "apple", true, { trail });
  assert.equal((html.match(/class="crumb"/g) || []).length, 4, "three earlier companies plus the ellipsis");
  assert.match(html, /data-value="1" title="Earlier companies">…/);
  assert.doesNotMatch(html, /title="Cisco Systems/);
});
test("the graph is drawn 1:1 at the panel width so text never scales up", () => {
  const g = seedGraph();
  const wide = relationshipsView(g, "apple", false, { width: 2400 });
  assert.match(wide, /viewBox="0 0 2400 \d+" width="2400"/);
  // Customer column sits at the right edge, not at a fixed 720px.
  assert.ok(!/class="g-col" x="720"/.test(wide));
  // Too narrow is clamped to the minimum readable layout.
  assert.match(relationshipsView(g, "apple", false, { width: 300 }), /viewBox="0 0 760 /);
});
