//! The forward implied by put–call parity: C − P = DF·(F − K), so
//! F = K + (C − P)/DF. Taken as the median over the strikes the caller
//! passes (normally the few nearest the money with tight quotes). The
//! forward absorbs dividends and borrow costs without an explicit input,
//! and the spread of the per-strike estimates measures quote quality.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ParityForward {
    pub forward: f64,
    /// Highest minus lowest per-strike estimate.
    pub range: f64,
    pub strikes: usize,
}

/// `pairs`: (strike, call mid, put mid) at one expiry. `df`: discount factor to that expiry.
pub fn parity_forward(pairs: &[(f64, f64, f64)], df: f64) -> Option<ParityForward> {
    if !(df.is_finite() && df > 0.0) {
        return None;
    }
    let mut est: Vec<f64> = pairs
        .iter()
        .filter(|(k, c, p)| k.is_finite() && c.is_finite() && p.is_finite() && *k > 0.0 && *c >= 0.0 && *p >= 0.0)
        .map(|(k, c, p)| k + (c - p) / df)
        .filter(|f| *f > 0.0)
        .collect();
    if est.is_empty() {
        return None;
    }
    est.sort_by(|a, b| a.total_cmp(b));
    let n = est.len();
    let forward = if n % 2 == 1 { est[n / 2] } else { 0.5 * (est[n / 2 - 1] + est[n / 2]) };
    Some(ParityForward { forward, range: est[n - 1] - est[0], strikes: n })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::black::{bsm, Kind};

    #[test]
    fn recovers_the_forward_with_a_dividend_yield() {
        let (s, t, r, q, v): (f64, f64, f64, f64, f64) = (100.0, 0.5, 0.045, 0.02, 0.3);
        let df = (-r * t).exp();
        let pairs: Vec<_> = [95.0, 100.0, 105.0].iter().map(|&k| (k, bsm(Kind::Call, s, k, t, r, q, v).price, bsm(Kind::Put, s, k, t, r, q, v).price)).collect();
        let f = parity_forward(&pairs, df).unwrap();
        assert!((f.forward - s * ((r - q) * t).exp()).abs() < 1e-10);
        assert!(f.range < 1e-10 && f.strikes == 3);
    }

    #[test]
    fn median_resists_one_bad_quote() {
        let f = parity_forward(&[(100.0, 5.0, 4.0), (101.0, 4.5, 4.5), (102.0, 9.0, 1.0), (103.0, 3.0, 5.0)], 1.0).unwrap();
        assert_eq!(f.forward, 101.0);
        assert_eq!(f.range, 9.0);
        assert!(parity_forward(&[], 1.0).is_none());
        assert!(parity_forward(&[(100.0, 1.0, 1.0)], 0.0).is_none());
    }
}
