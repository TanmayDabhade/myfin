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
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Account {
    pub initial: f64,
    pub trades: Vec<Trade>,
}
impl Account {
    pub fn append(&mut self, t: Trade) -> Result<(), String> {
        if !self.initial.is_finite()
            || self.initial <= 0.
            || ![t.qty, t.price, t.fee].iter().all(|v| v.is_finite())
            || t.qty <= 0.
            || t.price <= 0.
            || t.fee < 0.
            || !["buy", "sell"].contains(&t.side.as_str())
        {
            return Err("Invalid paper order".into());
        }
        if t.symbol.is_empty()
            || t.symbol.len() > 20
            || !t
                .symbol
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || ".^_-".contains(c))
        {
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
        let mut cash = self.initial;
        let mut positions: HashMap<String, f64> = HashMap::new();
        for x in &self.trades {
            let sign = if x.side == "buy" { 1. } else { -1. };
            cash -= sign * x.qty * x.price + x.fee;
            *positions.entry(x.symbol.clone()).or_default() += sign * x.qty;
        }
        if t.side == "buy" && t.qty * t.price + t.fee > cash + 1e-8 {
            return Err("Insufficient paper cash".into());
        }
        if t.side == "sell"
            && (t.qty > *positions.get(&t.symbol).unwrap_or(&0.) + 1e-8
                || cash + t.qty * t.price - t.fee < 0.)
        {
            return Err("Insufficient shares or cash".into());
        }
        self.trades.push(t);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn trade() -> Trade {
        Trade {
            id: "1".into(),
            symbol: "AAPL".into(),
            side: "buy".into(),
            qty: 2.,
            price: 100.,
            fee: 1.,
            date: "2026-01-01T12:00:00Z".into(),
            note: String::new(),
            source: "test".into(),
        }
    }
    #[test]
    fn buying_and_duplicate() {
        let mut a = Account {
            initial: 1000.,
            trades: vec![],
        };
        assert!(a.append(trade()).is_ok());
        assert!(a.append(trade()).is_err());
    }
    #[test]
    fn cannot_overspend() {
        let mut a = Account {
            initial: 100.,
            trades: vec![],
        };
        assert!(a.append(trade()).is_err());
    }
    #[test]
    fn cannot_short() {
        let mut a = Account {
            initial: 1000.,
            trades: vec![],
        };
        let mut t = trade();
        t.side = "sell".into();
        assert!(a.append(t).is_err());
    }
}
