//! American (and European) options on a Leisen–Reimer binomial tree.
//!
//! Leisen and Reimer (1996) choose the up-probability with the Peizer–Pratt
//! inversion so the tree converges to Black–Scholes smoothly and quickly
//! (error ~1/n², no odd/even oscillation). An odd number of steps is used.
//!
//! Discrete cash dividends use the escrowed-dividend model: the tree is built
//! on S* = S − PV(dividends before expiry), and at each node the stock price
//! is S* plus the present value of the dividends still to be paid. This is
//! the usual practitioner approximation; it can misprice slightly when a
//! large dividend falls close to expiry.

use crate::black::Kind;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Dividend {
    /// Ex-dividend time in years from now.
    pub t: f64,
    /// Cash amount per share.
    pub amount: f64,
}

/// Peizer–Pratt method 2 inversion used by Leisen–Reimer.
fn peizer_pratt(z: f64, n: f64) -> f64 {
    let a = z / (n + 1.0 / 3.0 + 0.1 / (n + 1.0));
    let inner = (0.25 - 0.25 * (-(a * a) * (n + 1.0 / 6.0)).exp()).max(0.0);
    0.5 + z.signum() * inner.sqrt()
}

/// Present value at time `now` of the dividends paid after `now` and up to `t_end`.
fn pv_dividends(dividends: &[Dividend], now: f64, t_end: f64, r: f64) -> f64 {
    dividends
        .iter()
        .filter(|d| d.t > now && d.t <= t_end && d.amount.is_finite() && d.amount > 0.0)
        .map(|d| d.amount * (-r * (d.t - now)).exp())
        .sum()
}

/// Option price on the tree. `early` = true for American exercise.
#[allow(clippy::too_many_arguments)]
pub fn price(kind: Kind, s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, dividends: &[Dividend], steps: usize, early: bool) -> f64 {
    if ![s, k, t, r, q, sigma].iter().all(|v| v.is_finite()) || s <= 0.0 || k <= 0.0 || t < 0.0 || sigma < 0.0 {
        return f64::NAN;
    }
    let phi = kind.sign();
    if t == 0.0 {
        return (phi * (s - k)).max(0.0);
    }
    let n = (steps.max(3) | 1) as f64; // odd
    let steps = n as usize;
    let s_star = s - pv_dividends(dividends, 0.0, t, r);
    if s_star <= 0.0 {
        return f64::NAN;
    }
    let sigma = sigma.max(1e-8);
    let dt = t / n;
    let vol_t = sigma * t.sqrt();
    let d1 = ((s_star / k).ln() + (r - q + 0.5 * sigma * sigma) * t) / vol_t;
    let d2 = d1 - vol_t;
    let p = peizer_pratt(d2, n);
    let p_bar = peizer_pratt(d1, n);
    let growth = ((r - q) * dt).exp();
    let u = growth * p_bar / p;
    let d = (growth - p * u) / (1.0 - p);
    let disc = (-r * dt).exp();
    let (pu, pd) = (disc * p, disc * (1.0 - p));
    let ratio = u / d;

    // Terminal values, lowest node first. No dividends remain at expiry.
    let mut values = vec![0.0f64; steps + 1];
    let mut node = s_star * d.powi(steps as i32);
    for v in values.iter_mut() {
        *v = (phi * (node - k)).max(0.0);
        node *= ratio;
    }
    for i in (0..steps).rev() {
        let now = i as f64 * dt;
        let pv = if early { pv_dividends(dividends, now, t, r) } else { 0.0 };
        let mut node = s_star * d.powi(i as i32);
        for j in 0..=i {
            let cont = pu * values[j + 1] + pd * values[j];
            values[j] = if early {
                let exercise = phi * (node + pv - k);
                if exercise > cont { exercise } else { cont }
            } else {
                cont
            };
            node *= ratio;
        }
    }
    values[0]
}

/// Greeks by central finite differences on the tree (same steps for every
/// evaluation, which LR's smooth convergence makes stable). Theta is per
/// year of calendar time; vega and rho per 1.00.
#[allow(clippy::too_many_arguments)]
pub fn greeks(kind: Kind, s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, dividends: &[Dividend], steps: usize) -> crate::Greeks {
    let pr = |s: f64, t: f64, r: f64, v: f64, divs: &[Dividend]| price(kind, s, k, t, r, q, v, divs, steps, true);
    let v0 = pr(s, t, r, sigma, dividends);
    let hs = 1e-3 * s;
    let up = pr(s + hs, t, r, sigma, dividends);
    let dn = pr(s - hs, t, r, sigma, dividends);
    let hv = 1e-3;
    let ht = (1.0f64 / 365.0).min(t / 4.0);
    // Moving the valuation date forward moves every dividend closer.
    let later: Vec<Dividend> = dividends.iter().map(|d| Dividend { t: d.t - ht, amount: d.amount }).collect();
    let hr = 1e-4;
    crate::Greeks {
        price: v0,
        delta: (up - dn) / (2.0 * hs),
        gamma: (up - 2.0 * v0 + dn) / (hs * hs),
        vega: (pr(s, t, r, sigma + hv, dividends) - pr(s, t, r, sigma - hv, dividends)) / (2.0 * hv),
        theta: if t > ht { (pr(s, t - ht, r, sigma, &later) - v0) / ht } else { f64::NAN },
        rho: (pr(s, t, r + hr, sigma, dividends) - pr(s, t, r - hr, sigma, dividends)) / (2.0 * hr),
        ..crate::Greeks::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::black;

    #[test]
    fn european_tree_converges_to_black_scholes() {
        for kind in [Kind::Call, Kind::Put] {
            for &(s, k, t, r, q, v) in &[(100.0, 95.0, 0.5, 0.05, 0.02, 0.25), (40.0, 50.0, 1.5, 0.03, 0.0, 0.4)] {
                let tree = price(kind, s, k, t, r, q, v, &[], 201, false);
                let bs = black::bsm(kind, s, k, t, r, q, v).price;
                assert!((tree - bs).abs() < 2e-4, "{kind:?} tree {tree} vs bs {bs}");
            }
        }
    }

    #[test]
    fn hull_american_put() {
        // Hull's American put: S=50, K=50, r=10%, σ=40%, T=5 months. Converged ≈ 4.28.
        let p = price(Kind::Put, 50.0, 50.0, 5.0 / 12.0, 0.1, 0.0, 0.4, &[], 501, true);
        assert!((p - 4.28).abs() < 0.01, "{p}");
        let eu = black::bsm(Kind::Put, 50.0, 50.0, 5.0 / 12.0, 0.1, 0.0, 0.4).price;
        assert!(p > eu + 0.1, "early exercise premium: {p} vs {eu}");
    }

    #[test]
    fn american_call_without_dividends_is_european() {
        let am = price(Kind::Call, 100.0, 100.0, 1.0, 0.05, 0.0, 0.3, &[], 301, true);
        let eu = price(Kind::Call, 100.0, 100.0, 1.0, 0.05, 0.0, 0.3, &[], 301, false);
        assert!((am - eu).abs() < 1e-10);
    }

    #[test]
    fn a_dividend_lowers_calls_and_can_make_early_exercise_pay() {
        let div = [Dividend { t: 0.25, amount: 5.0 }];
        let none = price(Kind::Call, 100.0, 80.0, 0.5, 0.05, 0.0, 0.2, &[], 301, true);
        let with = price(Kind::Call, 100.0, 80.0, 0.5, 0.05, 0.0, 0.2, &div, 301, true);
        let eu = price(Kind::Call, 100.0, 80.0, 0.5, 0.05, 0.0, 0.2, &div, 301, false);
        assert!(with < none, "dividend lowers the call");
        assert!(with > eu + 1e-3, "deep ITM call before a large dividend is worth exercising: {with} vs {eu}");
        // Dividends after expiry are ignored.
        let late = [Dividend { t: 2.0, amount: 5.0 }];
        assert_eq!(price(Kind::Call, 100.0, 80.0, 0.5, 0.05, 0.0, 0.2, &late, 301, true), none);
    }

    #[test]
    fn finite_difference_greeks_are_sane() {
        let g = greeks(Kind::Put, 50.0, 50.0, 0.5, 0.05, 0.0, 0.3, &[], 301);
        let bs = black::bsm(Kind::Put, 50.0, 50.0, 0.5, 0.05, 0.0, 0.3);
        assert!(g.delta < 0.0 && g.delta > -1.0 && g.delta < bs.delta, "American put delta more negative: {} vs {}", g.delta, bs.delta);
        assert!(g.gamma > 0.0 && (g.vega - bs.vega).abs() / bs.vega < 0.1);
        assert!(g.theta < 0.0 && g.rho < 0.0);
    }

    #[test]
    fn rejects_bad_inputs() {
        assert!(price(Kind::Call, -1.0, 100.0, 1.0, 0.05, 0.0, 0.3, &[], 101, true).is_nan());
        assert!(price(Kind::Call, 10.0, 100.0, 1.0, 0.05, 0.0, 0.3, &[Dividend { t: 0.5, amount: 20.0 }], 101, true).is_nan());
        assert_eq!(price(Kind::Put, 90.0, 100.0, 0.0, 0.05, 0.0, 0.3, &[], 101, true), 10.0);
    }
}
