//! European option prices and Greeks: Black–Scholes–Merton on a spot with a
//! continuous dividend yield, and Black-76 on a forward or futures price.
//!
//! Both are the generalized Black–Scholes formula with cost of carry `b`
//! (Haug, *The Complete Guide to Option Pricing Formulas*, ch. 1–2):
//! BSM uses b = r − q, Black-76 uses b = 0 with the forward in place of spot.

use crate::normal::{cdf, pdf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Call,
    Put,
}

impl Kind {
    pub fn from_i32(v: i32) -> Option<Kind> {
        match v {
            1 => Some(Kind::Call),
            -1 => Some(Kind::Put),
            _ => None,
        }
    }
    pub fn sign(self) -> f64 {
        match self {
            Kind::Call => 1.0,
            Kind::Put => -1.0,
        }
    }
}

/// Price and sensitivities. See the crate docs for units.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Greeks {
    pub price: f64,
    /// ∂V/∂S (∂V/∂F for Black-76).
    pub delta: f64,
    pub gamma: f64,
    /// ∂V/∂σ.
    pub vega: f64,
    /// ∂V/∂t, calendar time passing (negative for a long option, usually).
    pub theta: f64,
    /// ∂V/∂r.
    pub rho: f64,
    /// ∂²V/∂S∂σ.
    pub vanna: f64,
    /// ∂Δ/∂t, calendar time passing.
    pub charm: f64,
    /// ∂²V/∂σ².
    pub vomma: f64,
    /// ∂Γ/∂S.
    pub speed: f64,
}

impl Greeks {
    pub fn to_array(self) -> [f64; 10] {
        [self.price, self.delta, self.gamma, self.vega, self.theta, self.rho, self.vanna, self.charm, self.vomma, self.speed]
    }
    fn nan() -> Greeks {
        let n = f64::NAN;
        Greeks { price: n, delta: n, gamma: n, vega: n, theta: n, rho: n, vanna: n, charm: n, vomma: n, speed: n }
    }
}

fn valid(s: f64, k: f64, t: f64, r: f64, b: f64, sigma: f64) -> bool {
    [s, k, t, r, b, sigma].iter().all(|v| v.is_finite()) && s > 0.0 && k > 0.0 && t >= 0.0 && sigma >= 0.0
}

/// At expiry, or with zero volatility: the option is worth its discounted
/// forward intrinsic value and has no curvature.
fn degenerate(kind: Kind, s: f64, k: f64, t: f64, r: f64, b: f64) -> Greeks {
    let phi = kind.sign();
    let carry = ((b - r) * t).exp();
    let df = (-r * t).exp();
    let fwd_intrinsic = phi * (s * carry - k * df);
    let itm = fwd_intrinsic > 0.0;
    Greeks {
        price: fwd_intrinsic.max(0.0),
        delta: if itm { phi * carry } else { 0.0 },
        ..Greeks::default()
    }
}

/// Generalized Black–Scholes with cost of carry `b`. `rho_mode` chooses how
/// the rate enters: true when the forward moves with r (BSM, b = r − q),
/// false when the forward is fixed (Black-76).
fn generalized(kind: Kind, s: f64, k: f64, t: f64, r: f64, b: f64, sigma: f64, forward_moves_with_r: bool) -> Greeks {
    if !valid(s, k, t, r, b, sigma) {
        return Greeks::nan();
    }
    if t == 0.0 || sigma == 0.0 {
        return degenerate(kind, s, k, t, r, b);
    }
    let phi = kind.sign();
    let sqrt_t = t.sqrt();
    let vol_t = sigma * sqrt_t;
    let d1 = ((s / k).ln() + (b + 0.5 * sigma * sigma) * t) / vol_t;
    let d2 = d1 - vol_t;
    let carry = ((b - r) * t).exp(); // e^{(b−r)T}
    let df = (-r * t).exp();
    let nd1 = cdf(phi * d1);
    let nd2 = cdf(phi * d2);
    let n1 = pdf(d1);

    let price = phi * (s * carry * nd1 - k * df * nd2);
    let delta = phi * carry * nd1;
    let gamma = carry * n1 / (s * vol_t);
    let vega = s * carry * n1 * sqrt_t;
    let theta = -s * carry * n1 * sigma / (2.0 * sqrt_t) - phi * (b - r) * s * carry * nd1 - phi * r * k * df * nd2;
    let rho = if forward_moves_with_r { phi * k * t * df * nd2 } else { -t * price };
    let vanna = -carry * n1 * d2 / sigma;
    let charm = -carry * (n1 * (b / vol_t - d2 / (2.0 * t)) + phi * (b - r) * nd1);
    let vomma = vega * d1 * d2 / sigma;
    let speed = -gamma / s * (1.0 + d1 / vol_t);
    Greeks { price, delta, gamma, vega, theta, rho, vanna, charm, vomma, speed }
}

/// Black–Scholes–Merton on spot `s` with continuous dividend yield `q`.
pub fn bsm(kind: Kind, s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64) -> Greeks {
    generalized(kind, s, k, t, r, r - q, sigma, true)
}

/// Black-76 on forward or futures price `f`, discounted at `r`.
pub fn black76(kind: Kind, f: f64, k: f64, t: f64, r: f64, sigma: f64) -> Greeks {
    generalized(kind, f, k, t, r, 0.0, sigma, false)
}

/// Undiscounted Black price on a forward (price / discount factor). Used by
/// the implied-volatility solver, where only σ varies.
pub fn black_undiscounted(kind: Kind, f: f64, k: f64, t: f64, sigma: f64) -> (f64, f64) {
    if t <= 0.0 || sigma <= 0.0 {
        return ((kind.sign() * (f - k)).max(0.0), 0.0);
    }
    let phi = kind.sign();
    let vol_t = sigma * t.sqrt();
    let d1 = ((f / k).ln() + 0.5 * vol_t * vol_t) / vol_t;
    let d2 = d1 - vol_t;
    let price = phi * (f * cdf(phi * d1) - k * cdf(phi * d2));
    let vega = f * pdf(d1) * t.sqrt();
    (price, vega)
}

#[cfg(test)]
mod tests {
    use super::*;
    const C: Kind = Kind::Call;
    const P: Kind = Kind::Put;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * (1.0 + b.abs())
    }

    #[test]
    fn hull_example() {
        // Hull, Options, Futures, and Other Derivatives: S=42, K=40, r=10%, σ=20%, T=0.5.
        let c = bsm(C, 42.0, 40.0, 0.5, 0.1, 0.0, 0.2).price;
        let p = bsm(P, 42.0, 40.0, 0.5, 0.1, 0.0, 0.2).price;
        assert!((c - 4.76).abs() < 0.005, "call {c}");
        assert!((p - 0.81).abs() < 0.005, "put {p}");
    }

    #[test]
    fn haug_black76_example() {
        // Haug: futures option F=19, K=19, T=0.75, r=10%, σ=28% → call = put = 1.7011.
        let c = black76(C, 19.0, 19.0, 0.75, 0.1, 0.28).price;
        let p = black76(P, 19.0, 19.0, 0.75, 0.1, 0.28).price;
        assert!((c - 1.7011).abs() < 5e-5, "call {c}");
        assert!((p - c).abs() < 1e-12);
    }

    #[test]
    fn put_call_parity_and_delta_identity() {
        for &(s, k, t, r, q, v) in &[(100.0, 90.0, 0.25, 0.04, 0.01, 0.3), (50.0, 70.0, 2.0, 0.05, 0.03, 0.45), (10.0, 10.0, 0.01, 0.0, 0.0, 0.8)] {
            let c = bsm(C, s, k, t, r, q, v);
            let p = bsm(P, s, k, t, r, q, v);
            let parity = s * (-q * t).exp() - k * (-r * t).exp();
            assert!(close(c.price - p.price, parity, 1e-12), "parity");
            assert!(close(c.delta - p.delta, (-q * t).exp(), 1e-12), "delta identity");
            assert!(close(c.gamma, p.gamma, 1e-12) && close(c.vega, p.vega, 1e-12));
        }
    }

    /// Every closed-form Greek against a central finite difference of the price.
    #[test]
    fn greeks_match_finite_differences() {
        let (s, k, t, r, q, v) = (105.0, 100.0, 0.6, 0.045, 0.015, 0.27);
        for kind in [C, P] {
            let g = bsm(kind, s, k, t, r, q, v);
            let pr = |s: f64, t: f64, r: f64, v: f64| bsm(kind, s, k, t, r, q, v);
            let h = 1e-4;
            let fd_delta = (pr(s + h, t, r, v).price - pr(s - h, t, r, v).price) / (2.0 * h);
            let fd_gamma = (pr(s + h, t, r, v).price - 2.0 * g.price + pr(s - h, t, r, v).price) / (h * h);
            let fd_vega = (pr(s, t, r, v + h).price - pr(s, t, r, v - h).price) / (2.0 * h);
            let fd_theta = -(pr(s, t + h, r, v).price - pr(s, t - h, r, v).price) / (2.0 * h);
            let fd_rho = (pr(s, t, r + h, v).price - pr(s, t, r - h, v).price) / (2.0 * h);
            let fd_vanna = (pr(s + h, t, r, v).vega - pr(s - h, t, r, v).vega) / (2.0 * h);
            let fd_charm = -(pr(s, t + h, r, v).delta - pr(s, t - h, r, v).delta) / (2.0 * h);
            let fd_vomma = (pr(s, t, r, v + h).vega - pr(s, t, r, v - h).vega) / (2.0 * h);
            let fd_speed = (pr(s + h, t, r, v).gamma - pr(s - h, t, r, v).gamma) / (2.0 * h);
            assert!(close(g.delta, fd_delta, 1e-7), "delta {kind:?}");
            assert!(close(g.gamma, fd_gamma, 1e-4), "gamma {kind:?}");
            assert!(close(g.vega, fd_vega, 1e-7), "vega {kind:?}");
            assert!(close(g.theta, fd_theta, 1e-6), "theta {kind:?} {} vs {}", g.theta, fd_theta);
            assert!(close(g.rho, fd_rho, 1e-6), "rho {kind:?}");
            assert!(close(g.vanna, fd_vanna, 1e-6), "vanna {kind:?}");
            assert!(close(g.charm, fd_charm, 1e-6), "charm {kind:?} {} vs {}", g.charm, fd_charm);
            assert!(close(g.vomma, fd_vomma, 1e-6), "vomma {kind:?}");
            assert!(close(g.speed, fd_speed, 1e-5), "speed {kind:?}");
        }
    }

    /// The Black–Scholes PDE: Θ + ½σ²S²Γ + (r − q)SΔ − rV = 0.
    #[test]
    fn satisfies_the_pde() {
        let (s, k, t, r, q, v) = (80.0, 95.0, 1.3, 0.05, 0.02, 0.35);
        for kind in [C, P] {
            let g = bsm(kind, s, k, t, r, q, v);
            let residual = g.theta + 0.5 * v * v * s * s * g.gamma + (r - q) * s * g.delta - r * g.price;
            assert!(residual.abs() < 1e-10, "{kind:?} residual {residual}");
        }
    }

    #[test]
    fn black76_rho_and_forward_delta() {
        let (f, k, t, r, v) = (101.0, 100.0, 0.5, 0.04, 0.2);
        let g = black76(C, f, k, t, r, v);
        let h = 1e-5;
        let fd_rho = (black76(C, f, k, t, r + h, v).price - black76(C, f, k, t, r - h, v).price) / (2.0 * h);
        assert!(close(g.rho, fd_rho, 1e-7));
        let (u, _) = black_undiscounted(C, f, k, t, v);
        assert!(close(u * (-r * t).exp(), g.price, 1e-14));
    }

    #[test]
    fn expiry_zero_vol_and_bad_inputs() {
        let g = bsm(C, 110.0, 100.0, 0.0, 0.05, 0.0, 0.3);
        assert_eq!(g.price, 10.0);
        assert_eq!(g.delta, 1.0);
        assert_eq!(bsm(P, 110.0, 100.0, 0.0, 0.05, 0.0, 0.3).price, 0.0);
        let z = bsm(C, 100.0, 100.0, 1.0, 0.05, 0.0, 0.0);
        assert!(close(z.price, 100.0 - 100.0 * (-0.05f64).exp(), 1e-14));
        assert!(bsm(C, -1.0, 100.0, 1.0, 0.05, 0.0, 0.2).price.is_nan());
        assert!(bsm(C, 100.0, 100.0, f64::NAN, 0.05, 0.0, 0.2).price.is_nan());
    }
}
