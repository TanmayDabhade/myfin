//! Native paper-order validation. Mirrors `execute()` and `requirements()`
//! in src/engine.js (the browser preview's ledger): signed positions,
//! multiplier-aware cash, long-only shares, covered or spread short calls,
//! cash-secured or spread short puts, no flipping a position in one order.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Trade {
    pub id: String,
    pub symbol: String,
    pub side: String,
    pub qty: f64,
    pub price: f64,
    pub fee: f64,
    pub date: String,
    pub note: String,
    pub source: String,
    /// "option" for an option contract (symbol is its OCC code); absent for shares.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instrument: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiplier: Option<f64>,
    /// Implied volatility when the order was placed, for model marks later.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iv: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Account {
    pub initial: f64,
    pub trades: Vec<Trade>,
}

#[derive(Clone, Debug, Default)]
struct Pos {
    qty: f64,
    cost: f64,
    option: Option<crate::options::Contract>,
    mult: f64,
}

impl Trade {
    fn is_option(&self) -> bool {
        self.instrument.as_deref() == Some("option")
    }
    fn mult(&self) -> f64 {
        if self.is_option() { self.multiplier.unwrap_or(100.0) } else { 1.0 }
    }
}

/// Cash and signed positions after the trades, by average cost.
fn book(initial: f64, trades: &[Trade]) -> (f64, HashMap<String, Pos>) {
    let mut cash = initial;
    let mut pos: HashMap<String, Pos> = HashMap::new();
    for t in trades {
        let m = t.mult();
        let p = pos.entry(t.symbol.clone()).or_insert_with(|| Pos { mult: m, option: if t.is_option() { crate::options::parse_occ(&t.symbol) } else { None }, ..Default::default() });
        let dq = if t.side == "buy" { t.qty } else { -t.qty };
        let flow = -dq * t.price * m - t.fee;
        cash += flow;
        if p.qty == 0.0 || dq.signum() == p.qty.signum() {
            p.cost -= flow;
            p.qty += dq;
        } else {
            let closing = dq.abs().min(p.qty.abs());
            let basis = p.cost * closing / p.qty.abs();
            p.cost -= basis;
            p.qty += dq.signum() * closing;
            if p.qty.abs() < 1e-9 {
                p.qty = 0.0;
                p.cost = 0.0;
            }
        }
    }
    (cash, pos)
}

/// (cash that must stay in the account, uncovered short calls).
fn requirements(pos: &HashMap<String, Pos>) -> (f64, Vec<String>) {
    use options_math::black::Kind;
    struct Leg {
        kind: Kind,
        strike: f64,
        expiry: String,
        n: f64,
        short: bool,
        m: f64,
        sym: String,
    }
    let mut by: HashMap<String, (f64, Vec<Leg>)> = HashMap::new();
    for (sym, p) in pos {
        if p.qty == 0.0 {
            continue;
        }
        match &p.option {
            Some(c) => by.entry(c.root.clone()).or_default().1.push(Leg { kind: c.kind, strike: c.strike, expiry: c.expiry.clone(), n: p.qty.abs(), short: p.qty < 0.0, m: p.mult, sym: sym.clone() }),
            None => by.entry(sym.clone()).or_default().0 += p.qty,
        }
    }
    let mut required = 0.0;
    let mut uncovered = vec![];
    for (_, (shares, legs)) in by.iter_mut() {
        let mut shares = *shares;
        let longs = |kind: Kind| legs.iter().filter(|l| !l.short && l.kind == kind).map(|l| (l.strike, l.expiry.clone(), l.n)).collect::<Vec<_>>();
        let mut lc = longs(Kind::Call);
        let mut lp = longs(Kind::Put);
        lc.sort_by(|a, b| a.0.total_cmp(&b.0));
        lp.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut sc: Vec<&Leg> = legs.iter().filter(|l| l.short && l.kind == Kind::Call).collect();
        sc.sort_by(|a, b| a.strike.total_cmp(&b.strike));
        for l in sc {
            let mut n = l.n;
            let from_shares = n.min((shares / l.m).floor());
            shares -= from_shares * l.m;
            n -= from_shares;
            for long in lc.iter_mut().filter(|x| x.1 >= l.expiry) {
                if n <= 0.0 {
                    break;
                }
                let k = n.min(long.2);
                long.2 -= k;
                n -= k;
                required += k * l.m * (long.0 - l.strike).max(0.0);
            }
            if n > 1e-9 {
                uncovered.push(format!("{n} {}", l.sym));
            }
        }
        let mut sp: Vec<&Leg> = legs.iter().filter(|l| l.short && l.kind == Kind::Put).collect();
        sp.sort_by(|a, b| b.strike.total_cmp(&a.strike));
        for l in sp {
            let mut n = l.n;
            for long in lp.iter_mut().filter(|x| x.1 >= l.expiry) {
                if n <= 0.0 {
                    break;
                }
                let k = n.min(long.2);
                long.2 -= k;
                n -= k;
                required += k * l.m * (l.strike - long.0).max(0.0);
            }
            required += n * l.m * l.strike;
        }
    }
    (required, uncovered)
}

impl Account {
    pub fn append(&mut self, t: Trade) -> Result<(), String> {
        let option = t.is_option();
        if !self.initial.is_finite()
            || self.initial <= 0.
            || ![t.qty, t.price, t.fee].iter().all(|v| v.is_finite())
            || t.qty <= 0.
            || t.price < 0.
            || (t.price == 0. && t.source != "expiry")
            || t.fee < 0.
            || !["buy", "sell"].contains(&t.side.as_str())
            || (option && (t.qty.fract() != 0.0 || t.mult() <= 0.0 || !t.mult().is_finite()))
        {
            return Err("Invalid paper order".into());
        }
        let symbol_ok = if option {
            crate::options::parse_occ(&t.symbol).is_some_and(|c| c.symbol == t.symbol)
        } else {
            !t.symbol.is_empty() && t.symbol.len() <= 20 && t.symbol.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || ".^_-".contains(c))
        };
        if !symbol_ok {
            return Err("Invalid symbol".into());
        }
        if self.trades.iter().any(|x| x.id == t.id) {
            return Err("Duplicate order ID".into());
        }
        if let Some(last) = self.trades.last() {
            if last.date > t.date {
                return Err("Orders must be chronological".into());
            }
        }
        let (_, before) = book(self.initial, &self.trades);
        let held = before.get(&t.symbol).map(|p| p.qty).unwrap_or(0.0);
        let dq = if t.side == "buy" { t.qty } else { -t.qty };
        if !option && t.side == "sell" && t.qty > held + 1e-8 {
            return Err("Insufficient shares or cash".into());
        }
        if option && held != 0.0 && held.signum() != dq.signum() && t.qty > held.abs() + 1e-9 {
            return Err("That would turn a position into the opposite one. Close it first.".into());
        }
        let mut next = self.trades.clone();
        let side = t.side.clone();
        next.push(t);
        let (cash, after) = book(self.initial, &next);
        let (required, uncovered) = requirements(&after);
        if !uncovered.is_empty() {
            return Err(format!("Short calls must be covered by shares or a long call: {} would be uncovered", uncovered.join(", ")));
        }
        let opening = side == "buy" || (option && held <= 0.0);
        if (opening && cash < required - 1e-8) || (!opening && cash < -1e-8) {
            return Err("Insufficient paper cash".into());
        }
        self.trades = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn trade() -> Trade {
        Trade { id: "1".into(), symbol: "AAPL".into(), side: "buy".into(), qty: 2., price: 100., fee: 1., date: "2026-01-01T12:00:00Z".into(), note: String::new(), source: "test".into(), instrument: None, multiplier: None, iv: None }
    }
    fn opt(id: &str, sym: &str, side: &str, qty: f64, price: f64) -> Trade {
        Trade { id: id.into(), symbol: sym.into(), side: side.into(), qty, price, fee: 0.65, instrument: Some("option".into()), multiplier: Some(100.0), ..trade() }
    }
    #[test]
    fn buying_and_duplicate() {
        let mut a = Account { initial: 1000., trades: vec![] };
        assert!(a.append(trade()).is_ok());
        assert!(a.append(trade()).is_err());
    }
    #[test]
    fn cannot_overspend() {
        let mut a = Account { initial: 100., trades: vec![] };
        assert!(a.append(trade()).is_err());
    }
    #[test]
    fn cannot_short() {
        let mut a = Account { initial: 1000., trades: vec![] };
        let mut t = trade();
        t.side = "sell".into();
        assert!(a.append(t).is_err());
    }
    #[test]
    fn option_rules_match_the_browser_ledger() {
        let c250 = "AAPL261218C00250000";
        let c260 = "AAPL261218C00260000";
        let p240 = "AAPL261218P00240000";
        // Naked call refused; covered call accepted.
        let mut a = Account { initial: 50_000., trades: vec![] };
        assert!(a.append(opt("1", c260, "sell", 1., 2.)).is_err());
        a.append(Trade { id: "2".into(), qty: 100., price: 248., fee: 0., ..trade() }).unwrap();
        a.append(opt("3", c260, "sell", 1., 2.)).unwrap();
        // The covering shares can't be sold.
        assert!(a.append(Trade { id: "4".into(), side: "sell".into(), qty: 50., price: 250., fee: 0., ..trade() }).is_err());
        // Cash-secured put needs strike × 100.
        let mut b = Account { initial: 10_000., trades: vec![] };
        assert!(b.append(opt("5", p240, "sell", 1., 3.)).is_err());
        let mut c = Account { initial: 30_000., trades: vec![] };
        c.append(opt("6", p240, "sell", 1., 3.)).unwrap();
        // Spread: long 250 call, short 260 call.
        let mut d = Account { initial: 1_000., trades: vec![] };
        d.append(opt("7", c250, "buy", 1., 6.)).unwrap();
        d.append(opt("8", c260, "sell", 1., 2.)).unwrap();
        // No flipping; whole contracts only; a padded symbol isn't accepted.
        assert!(d.append(opt("9", c250, "sell", 2., 6.)).is_err());
        assert!(d.append(opt("10", c250, "buy", 0.5, 6.)).is_err());
        assert!(d.append(opt("11", "AAPL  261218C00250000", "buy", 1., 1.)).is_err());
        // Expiry settlement may be at zero.
        let mut e = Account { initial: 1_000., trades: vec![] };
        e.append(opt("12", c250, "buy", 1., 6.)).unwrap();
        e.append(Trade { source: "expiry".into(), fee: 0., ..opt("13", c250, "sell", 1., 0.) }).unwrap();
        assert!(e.append(opt("14", c250, "buy", 1., 0.)).is_err());
    }
}
