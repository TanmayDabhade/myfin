//! Implied volatility: the σ at which the model price equals a market price.
//!
//! European options are inverted on the forward with Black's formula, so the
//! same solver serves BSM (F = S·e^{(r−q)T}) and Black-76. In-the-money
//! options are converted to the out-of-the-money option at the same strike
//! by put–call parity first, which keeps the time value from being lost in
//! subtraction. The solver is Newton's method on vega inside a bracket that
//! always contains the answer; a step that leaves the bracket is replaced by
//! bisection, so it cannot diverge.

use crate::american::{self, Dividend};
use crate::black::{black_undiscounted, Kind};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IvError {
    /// Non-finite or non-positive inputs.
    BadInput,
    /// Price below the (discounted) intrinsic value: no volatility gives it.
    BelowIntrinsic,
    /// Price at intrinsic value: implied volatility would be zero.
    NoTimeValue,
    /// Price at or above the no-arbitrage maximum (the forward for a call, the strike for a put).
    AboveMaximum,
    /// No solution with σ in the search range.
    NoConvergence,
}

impl IvError {
    /// Stable numeric code for the WebAssembly boundary (returned as −code).
    pub fn code(self) -> f64 {
        match self {
            IvError::BadInput => 1.0,
            IvError::BelowIntrinsic => 2.0,
            IvError::NoTimeValue => 3.0,
            IvError::AboveMaximum => 4.0,
            IvError::NoConvergence => 5.0,
        }
    }
}

pub const SIGMA_MIN: f64 = 1e-6;
pub const SIGMA_MAX: f64 = 10.0;

/// Implied volatility of a European option from its price.
/// `f` forward, `df` discount factor to expiry (e^{−rT}).
pub fn european(kind: Kind, price: f64, f: f64, k: f64, t: f64, df: f64) -> Result<f64, IvError> {
    if ![price, f, k, t, df].iter().all(|v| v.is_finite()) || f <= 0.0 || k <= 0.0 || t <= 0.0 || df <= 0.0 || price < 0.0 {
        return Err(IvError::BadInput);
    }
    let mut u = price / df; // undiscounted
    let mut kind = kind;
    // Out-of-the-money side at the same strike: same implied volatility.
    if kind == Kind::Call && f > k {
        u -= f - k;
        kind = Kind::Put;
    } else if kind == Kind::Put && k > f {
        u -= k - f;
        kind = Kind::Call;
    }
    let scale = f.max(k);
    if u < -1e-12 * scale {
        return Err(IvError::BelowIntrinsic);
    }
    if u <= 1e-14 * scale {
        return Err(IvError::NoTimeValue);
    }
    let upper = match kind {
        Kind::Call => f,
        Kind::Put => k,
    };
    if u >= upper {
        return Err(IvError::AboveMaximum);
    }
    let value = |s: f64| black_undiscounted(kind, f, k, t, s);
    let (top, _) = value(SIGMA_MAX);
    if top < u {
        return Err(IvError::NoConvergence);
    }
    let (mut lo, mut hi) = (SIGMA_MIN, SIGMA_MAX);
    // Brenner–Subrahmanyam start, kept inside a sensible range.
    let mut s = ((2.0 * std::f64::consts::PI / t).sqrt() * u / f).clamp(0.01, 3.0);
    for _ in 0..200 {
        let (p, vega) = value(s);
        let diff = p - u;
        // Relative to the time value, so far out-of-the-money options solve as precisely as at-the-money ones.
        if diff.abs() <= (1e-12 * u).max(1e-15 * scale) {
            return Ok(s);
        }
        if diff > 0.0 {
            hi = s;
        } else {
            lo = s;
        }
        let newton = if vega > 1e-300 { s - diff / vega } else { f64::NAN };
        s = if newton.is_finite() && newton > lo && newton < hi { newton } else { 0.5 * (lo + hi) };
        if hi - lo < 1e-15 {
            return Ok(s);
        }
    }
    Err(IvError::NoConvergence)
}

/// Implied volatility of a BSM option on spot with continuous yield `q`.
pub fn bsm(kind: Kind, price: f64, s: f64, k: f64, t: f64, r: f64, q: f64) -> Result<f64, IvError> {
    european(kind, price, s * ((r - q) * t).exp(), k, t, (-r * t).exp())
}

/// Implied volatility of an American option priced on the Leisen–Reimer
/// tree. Bracketed bisection with a secant step (the tree price is monotone
/// in σ but its derivative is not available in closed form).
pub fn american(kind: Kind, price: f64, s: f64, k: f64, t: f64, r: f64, q: f64, dividends: &[Dividend], steps: usize) -> Result<f64, IvError> {
    if ![price, s, k, t, r, q].iter().all(|v| v.is_finite()) || s <= 0.0 || k <= 0.0 || t <= 0.0 || price < 0.0 {
        return Err(IvError::BadInput);
    }
    let intrinsic = (kind.sign() * (s - k)).max(0.0);
    let scale = s.max(k);
    if price < intrinsic - 1e-12 * scale {
        return Err(IvError::BelowIntrinsic);
    }
    let value = |sig: f64| american::price(kind, s, k, t, r, q, sig, dividends, steps, true);
    let (mut lo, mut hi) = (SIGMA_MIN, SIGMA_MAX);
    let (mut plo, phi_) = (value(lo), value(hi));
    if price <= plo + 1e-12 * scale {
        return Err(IvError::NoTimeValue);
    }
    if price > phi_ {
        return Err(IvError::AboveMaximum);
    }
    let mut phi_v = phi_;
    for _ in 0..200 {
        // Secant inside the bracket, falling back to bisection.
        let mut mid = lo + (price - plo) * (hi - lo) / (phi_v - plo);
        if !(mid > lo && mid < hi) || (hi - lo) > 0.5 {
            mid = 0.5 * (lo + hi);
        }
        let p = value(mid);
        if (p - price).abs() <= 1e-10 * scale || hi - lo < 1e-12 {
            return Ok(mid);
        }
        if p > price {
            hi = mid;
            phi_v = p;
        } else {
            lo = mid;
            plo = p;
        }
    }
    Err(IvError::NoConvergence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::black;

    #[test]
    fn round_trips_across_strikes_expiries_and_vols() {
        let (s, r, q) = (100.0, 0.04, 0.012);
        for &k in &[40.0, 70.0, 90.0, 100.0, 110.0, 150.0, 250.0] {
            for &t in &[2.0 / 365.0, 0.1, 0.5, 2.0] {
                for &v in &[0.05, 0.2, 0.6, 1.5] {
                    for kind in [Kind::Call, Kind::Put] {
                        let p = black::bsm(kind, s, k, t, r, q, v).price;
                        match bsm(kind, p, s, k, t, r, q) {
                            Ok(iv) => {
                                // Where the time value is a sliver of the price, the price itself can't pin σ
                                // down to 1e-7; then the solved σ must at least reproduce the price.
                                let back = black::bsm(kind, s, k, t, r, q, iv).price;
                                assert!((iv - v).abs() < 1e-7 || (back - p).abs() < 1e-12 * s, "{kind:?} K={k} T={t} σ={v} → {iv}");
                            }
                            // Deep options whose time value underflows can't be inverted, and must say so.
                            Err(IvError::NoTimeValue) => {
                                let f = s * ((r - q) * t).exp();
                                let tv = p / (-r * t).exp() - (kind.sign() * (f - k)).max(0.0);
                                assert!(tv < 1e-10, "{kind:?} K={k} T={t} σ={v}: time value {tv} should have solved");
                            }
                            Err(e) => panic!("{kind:?} K={k} T={t} σ={v}: {e:?}"),
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn refuses_impossible_prices() {
        let (f, k, t, df) = (100.0, 90.0, 0.5, 0.98);
        // Call worth less than discounted intrinsic (10 × 0.98).
        assert_eq!(european(Kind::Call, 9.0, f, k, t, df), Err(IvError::BelowIntrinsic));
        assert_eq!(european(Kind::Call, 9.8, f, k, t, df), Err(IvError::NoTimeValue));
        assert_eq!(european(Kind::Call, 99.0, f, k, t, df), Err(IvError::AboveMaximum));
        assert_eq!(european(Kind::Put, 1.0, f, -5.0, t, df), Err(IvError::BadInput));
        assert_eq!(european(Kind::Put, f64::NAN, f, k, t, df), Err(IvError::BadInput));
    }

    #[test]
    fn american_iv_round_trip() {
        let (s, k, t, r, q) = (50.0, 52.0, 0.4, 0.05, 0.0);
        for &v in &[0.15, 0.3, 0.7] {
            let p = american::price(Kind::Put, s, k, t, r, q, v, &[], 301, true);
            let iv = american(Kind::Put, p, s, k, t, r, q, &[], 301).unwrap();
            assert!((iv - v).abs() < 1e-6, "σ={v} → {iv}");
        }
        assert_eq!(american(Kind::Put, 1.0, 50.0, 60.0, 0.4, 0.05, 0.0, &[], 101), Err(IvError::BelowIntrinsic));
    }
}
