# Myfin delivery roadmap

Work is tracked in feature issues and reviewable PRs. Never auto-merge. Check the default branch, open PRs, issue acceptance criteria and AGENTS.md at the beginning of each work session. Preserve other contributors' edits. Stacked PRs must declare their base/dependency.

| Milestone | Tracker | Feature issues | Exit criteria |
|---|---|---|---|
| M1 Visual screening | #1 | #4 | Sector heatmaps, multiple metrics/horizons, sizing, filters, saved views, accessible drilldown and coverage |
| M2 Commodity / maritime intelligence | #2 | #5, #6 | Sourced port aggregates, cargo/tanker filters and map; optional AIS ingestion; commodity context; freshness and bounded collection |
| M3 Company relationship intelligence | #3 | #7, #8 | Suppliers → company → customers, source-backed directional edges, recursive research, evidence review and dated concentration |
| M4 Native integration and release | #9 | #9 | Provider contract and native-runtime tests, CI, packaging, migration and security review |

These tracker issues are not native GitHub milestone objects: the connector cannot create those and the available browser has no signed-in GitHub session. Keep progress here and in the issue checklists until native milestones can be provisioned.

## Data contract

- Real and synthetic data remain separate. No demo observation is relabeled live.
- Every external record needs source URL/provider, observation date, retrieval date and coverage/quality state.
- Missing values are not zeros. A connection failure does not imply zero vessels or no suppliers.
- AIS vessel class is not a manifest: tankers may carry chemicals, refined products or other cargo. Do not label all tankers petroleum vessels.
- PortWatch volumes are model estimates, not verified shipment manifests; port-call counts are a distinct measure.
- A company mention is not proof of a supply relationship. Named edges require explicit evidence; unnamed material customers stay unnamed.
- Use public documented endpoints or the user's own authorized keys. Respect quotas, terms and redistribution constraints. No paywall bypass, leaked data or proxy rotation.
- WorldMonitor is a product reference only. Do not copy AGPL implementation code into this repository without an explicit licensing decision.

## Working cadence

Complete bounded, independently reviewable feature slices; test meaningful behavior; open PRs linked to feature issues. Update existing PRs for their fixes instead of opening duplicates. Keep main untouched and do not merge automatically. If a paid source, authentication or missing entitlement blocks a feature, document the exact boundary and continue independent work. Prefer one implementation PR per scheduled run to control cost.
