export function sample() {
  const specs = [
    ["AAPL", "Apple", "Technology", 224, 31, 0.24, 0.09],
    ["MSFT", "Microsoft", "Technology", 418, 35, 0.36, 0.15],
    ["NVDA", "NVIDIA", "Technology", 139, 48, 0.51, 0.35],
    ["AMZN", "Amazon", "Consumer", 204, 39, 0.09, 0.11],
    ["GOOGL", "Alphabet", "Communication", 178, 23, 0.28, 0.12],
    ["JPM", "JPMorgan Chase", "Financials", 241, 13, 0.31, 0.07],
    ["XOM", "Exxon Mobil", "Energy", 116, 15, 0.09, -0.02],
    ["JNJ", "Johnson & Johnson", "Healthcare", 156, 18, 0.19, 0.04],
    ["SPY", "S&P 500 ETF proxy", "Broad market", 588, null, null, null],
    ["QQQ", "Nasdaq ETF proxy", "Broad market", 504, null, null, null],
    ["GLD", "Gold ETF proxy", "Commodity", 248, null, null, null],
    ["TLT", "Treasury ETF proxy", "Fixed income", 92, null, null, null],
  ];
  const assets = {};
  let seed = 7351;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (const [symbol, name, sector, price, pe, margin, growth] of specs) {
    let close = price * 0.82;
    const bars = [];
    for (let i = 0; i < 380; i++) {
      let d = new Date(Date.UTC(2025, 0, 1 + i));
      if ([0, 6].includes(d.getUTCDay())) continue;
      let open = close;
      close *= 1 + (random() - 0.47) * 0.035;
      bars.push({
        date: d.toISOString().slice(0, 10),
        open,
        high: Math.max(open, close) * (1 + random() * 0.012),
        low: Math.min(open, close) * (1 - random() * 0.012),
        close,
        volume: Math.floor(10000000 + random() * 40000000),
      });
    }
    assets[symbol] = {
      symbol,
      name,
      sector,
      bars,
      origin: "sample",
      source: "Synthetic demonstration • not market prices",
      overview: {
        Name: name,
        Sector: sector,
        PERatio: pe,
        ProfitMargin: margin,
        QuarterlyRevenueGrowthYOY: growth,
        MarketCapitalization: price * 1000000000,
        DividendYield: 0.008,
      },
      fetchedAt: null,
    };
  }
  return {
    version: 1,
    mode: "sample",
    assets,
    marketAssets: {},
    watchlist: ["AAPL", "MSFT", "NVDA", "SPY", "GLD"],
    accounts: {
      sample: { initial: 100000, trades: [] },
      market: { initial: 100000, trades: [] },
    },
    alerts: [],
    screens: [],
    notes: {},
    macro: {},
    datasets: {},
  };
}
