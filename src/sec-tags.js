// XBRL revenue concepts tried in order; companies report under different tags.
// Must match REVENUE_TAGS in src-tauri/src/sec.rs.
export const REVENUE_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
];
// XBRL concepts for valuation inputs. Must match VALUE_TAGS in sec.rs.
export const VALUE_TAGS = [
  "NetCashProvidedByUsedInOperatingActivities",
  "PaymentsToAcquirePropertyPlantAndEquipment",
  "CashAndCashEquivalentsAtCarryingValue",
  "LongTermDebt",
  "LongTermDebtNoncurrent",
  "LongTermDebtCurrent",
  "ShortTermBorrowings",
  "WeightedAverageNumberOfDilutedSharesOutstanding",
  "NetIncomeLoss",
];
