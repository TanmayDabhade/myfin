# Company relationship evidence

The Relationships screen shows suppliers → selected company → customers/distributors. Click or keyboard-activate any entity to traverse its immediate neighborhood; the back arrow and the breadcrumb return to companies visited earlier. A subsidiary listed without its own ticker (for example Qualcomm Technologies, parent "Qualcomm Incorporated (QCOM)") opens its listed parent, and the parent view includes the subsidiary's evidence, labelled "via" the subsidiary. The company selector and the sidebar search also reach entities without visible edges. In live mode with an SEC contact email, opening a company that has not been scanned reads its two latest annual reports automatically. Evidence is independent of synthetic prices in the sample workspace.

The initial dataset contains seven entities and six historical relationships. Apple and Qualcomm press releases support two component-supply agreements; TD SYNNEX's FY2024 Form 10-K, Item 1 (OEM Suppliers), supports four distribution relationships. Each record links directly to its primary source. Only facts are paraphrased, with no copied reports. These are dated disclosures, not assertions of active relationships or comprehensive coverage.

The SEC filing was published January 24, 2025, for the fiscal year ended November 30, 2024. Disclosure date is used for as-of filtering in the graph model; fiscal-period end must not make a later filing appear publicly available earlier. Qualcomm Technologies and Dell remain separate from their listed parent companies. Parent ticker context does not turn the parent into a contracting entity.

## Import and review

Export the graph for the v1 JSON schema. Import adds entities and evidence atomically, rejecting ID collisions, absent endpoints, self-links, invalid dates, non-HTTPS URLs and concentration fractions without a period and denominator. Maximum size is 5 MB, 2,000 entities and 5,000 edges. Existing entity IDs may be reused only if their identity fields agree. Duplicate evidence IDs are rejected rather than silently overwritten.

Imported records always become unreviewed, even when the file claims otherwise. They are shown by default as dashed candidate links; switch the filter to "Reviewed only" to hide them. Explicitly confirm source review after reading the source. Review means the evidence was checked, not that a relationship remains active. Restoring an external workspace backup also resets relationship review states. Changes persist through the existing SQLite-backed Tauri workspace, or browser local storage in preview, and are included in backups. No new network or credential permissions are added.

Unknown concentration stays unknown; disclosure fractions require their original denominator and period, and are never summed across inconsistent sources. No weights are inferred from press-release wording, supplier counts, stock prices or company size.

## Remaining scope

Issue #8 tracks filing discovery, extraction candidates, richer entity resolution, dated relationship expiry and scalable coverage. This PR establishes the inspectable graph and review path; it does not provide a Bloomberg-sized relationship database. Runtime browser verification covers navigation, recentering, import, review and persistence; native packaging remains in #9.
