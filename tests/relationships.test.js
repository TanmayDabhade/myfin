import test from "node:test";
import assert from "node:assert/strict";
import {
  seedGraph,
  validateGraph,
  neighborhood,
  mergeGraph,
  relationshipsView,
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
