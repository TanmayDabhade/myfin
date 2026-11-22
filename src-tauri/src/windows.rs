//! Which windows are open and which one runs the background work (watchlist
//! refresh, filing and analytics sweeps). The first window leads; when the
//! leader closes, the window opened earliest after it takes over.
use serde_json::Value;
use std::collections::HashMap;

pub const MAIN: &str = "main";

#[derive(Default)]
pub struct Registry {
    /// Open windows in the order they opened.
    pub order: Vec<String>,
    pub leader: String,
    /// What a new window should show first, until it asks for it.
    intents: HashMap<String, Value>,
    next: u64,
}

impl Registry {
    pub fn opened(&mut self, label: &str) {
        if !self.order.iter().any(|l| l == label) {
            self.order.push(label.to_string());
        }
        if self.leader.is_empty() {
            self.leader = label.to_string();
        }
    }
    /// Reserves a label for a new window and remembers what it should show.
    pub fn reserve(&mut self, intent: Value) -> String {
        self.next += 1;
        let label = format!("w-{}", self.next);
        self.intents.insert(label.clone(), intent);
        label
    }
    pub fn take_intent(&mut self, label: &str) -> Option<Value> {
        self.intents.remove(label)
    }
    /// Forgets a closed window. Returns the new leader if leadership moved.
    pub fn closed(&mut self, label: &str) -> Option<String> {
        self.order.retain(|l| l != label);
        self.intents.remove(label);
        if self.leader != label {
            return None;
        }
        self.leader = self.order.first().cloned().unwrap_or_default();
        (!self.leader.is_empty()).then(|| self.leader.clone())
    }
}

/// Every window's symbols in one list for the single price connection: the
/// main window's first, then the others in the order they opened, so the
/// first windows keep their symbols when the provider's limit is reached.
pub fn union(subs: &HashMap<String, Vec<String>>) -> Vec<String> {
    let mut labels: Vec<&String> = subs.keys().collect();
    labels.sort_by_key(|l| (l.as_str() != MAIN, l.strip_prefix("w-").and_then(|n| n.parse::<u64>().ok()).unwrap_or(0), l.to_string()));
    let mut out: Vec<String> = Vec::new();
    for l in labels {
        for s in &subs[l] {
            if !out.contains(s) {
                out.push(s.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn first_window_leads_and_leadership_passes_on_close() {
        let mut r = Registry::default();
        r.opened(MAIN);
        let a = r.reserve(json!({"page": "Stock"}));
        r.opened(&a);
        let b = r.reserve(json!(null));
        r.opened(&b);
        assert_eq!(r.leader, MAIN);
        assert_eq!(r.closed(&b), None);
        assert_eq!(r.closed(MAIN), Some(a.clone()));
        assert_eq!(r.leader, a);
        assert_eq!(r.closed(&a), None);
        assert!(r.leader.is_empty());
    }

    #[test]
    fn intents_are_read_once() {
        let mut r = Registry::default();
        let a = r.reserve(json!({"symbol": "AAPL"}));
        assert_eq!(r.take_intent(&a), Some(json!({"symbol": "AAPL"})));
        assert_eq!(r.take_intent(&a), None);
    }

    #[test]
    fn union_puts_main_first_then_windows_in_opening_order() {
        let mut subs = HashMap::new();
        subs.insert("w-10".to_string(), vec!["TSLA".to_string()]);
        subs.insert("w-2".to_string(), vec!["MSFT".to_string(), "AAPL".to_string()]);
        subs.insert(MAIN.to_string(), vec!["AAPL".to_string(), "SPY".to_string()]);
        assert_eq!(union(&subs), vec!["AAPL", "SPY", "MSFT", "TSLA"]);
    }
}
