//! Raw SVI smile (Gatheral 2004): total implied variance as a function of
//! log-moneyness k = ln(K/F),
//!
//!   w(k) = a + b·(ρ·(k − m) + √((k − m)² + σ²)),  b ≥ 0, |ρ| < 1, σ > 0.
//!
//! Fitted per expiry by Nelder–Mead on unconstrained parameters (b = eˣ,
//! ρ = tanh x, σ = eˣ) from a few starting points, weighting each point
//! equally in implied volatility. The butterfly (density) check is
//! Gatheral's g(k) = (1 − k·w'/(2w))² − (w'²/4)(1/w + 1/4) + w''/2 ≥ 0.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Svi {
    pub a: f64,
    pub b: f64,
    pub rho: f64,
    pub m: f64,
    pub sigma: f64,
}

impl Svi {
    pub fn w(&self, k: f64) -> f64 {
        let x = k - self.m;
        self.a + self.b * (self.rho * x + (x * x + self.sigma * self.sigma).sqrt())
    }
    fn dw(&self, k: f64) -> (f64, f64) {
        let x = k - self.m;
        let r = (x * x + self.sigma * self.sigma).sqrt();
        (self.b * (self.rho + x / r), self.b * self.sigma * self.sigma / (r * r * r))
    }
    /// Implied volatility at log-moneyness k for expiry t (years).
    pub fn iv(&self, k: f64, t: f64) -> f64 {
        (self.w(k).max(0.0) / t).sqrt()
    }
    /// Gatheral's density function; negative values mean butterfly arbitrage.
    pub fn g(&self, k: f64) -> f64 {
        let w = self.w(k);
        let (w1, w2) = self.dw(k);
        if w <= 0.0 {
            return f64::NEG_INFINITY;
        }
        (1.0 - k * w1 / (2.0 * w)).powi(2) - w1 * w1 / 4.0 * (1.0 / w + 0.25) + w2 / 2.0
    }
    fn from(x: &[f64; 5]) -> Svi {
        Svi { a: x[0], b: x[1].exp(), rho: x[2].tanh(), m: x[3], sigma: x[4].exp().max(1e-4) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fit {
    pub params: Svi,
    /// Root-mean-square error in implied volatility (decimal).
    pub rmse: f64,
    /// Smallest g(k) on a grid spanning the data ±0.25 in k.
    pub min_g: f64,
    pub points: usize,
}

fn nelder_mead(f: &dyn Fn(&[f64; 5]) -> f64, start: [f64; 5], step: [f64; 5], iters: usize) -> ([f64; 5], f64) {
    let mut simplex: Vec<([f64; 5], f64)> = (0..6)
        .map(|i| {
            let mut p = start;
            if i > 0 {
                p[i - 1] += step[i - 1];
            }
            (p, f(&p))
        })
        .collect();
    for _ in 0..iters {
        simplex.sort_by(|a, b| a.1.total_cmp(&b.1));
        if (simplex[5].1 - simplex[0].1).abs() < 1e-14 {
            break;
        }
        let mut c = [0.0; 5];
        for (p, _) in &simplex[..5] {
            for j in 0..5 {
                c[j] += p[j] / 5.0;
            }
        }
        let worst = simplex[5].0;
        let at = |t: f64| {
            let mut p = [0.0; 5];
            for j in 0..5 {
                p[j] = c[j] + t * (worst[j] - c[j]);
            }
            p
        };
        let r = at(-1.0);
        let fr = f(&r);
        if fr < simplex[0].1 {
            let e = at(-2.0);
            let fe = f(&e);
            simplex[5] = if fe < fr { (e, fe) } else { (r, fr) };
        } else if fr < simplex[4].1 {
            simplex[5] = (r, fr);
        } else {
            let k = if fr < simplex[5].1 { at(-0.5) } else { at(0.5) };
            let fk = f(&k);
            if fk < simplex[5].1.min(fr) {
                simplex[5] = (k, fk);
            } else {
                let best = simplex[0].0;
                for s in simplex.iter_mut().skip(1) {
                    for j in 0..5 {
                        s.0[j] = best[j] + 0.5 * (s.0[j] - best[j]);
                    }
                    s.1 = f(&s.0);
                }
            }
        }
    }
    simplex.sort_by(|a, b| a.1.total_cmp(&b.1));
    simplex[0]
}

/// Fits SVI to (log-moneyness, implied volatility) points of one expiry.
pub fn fit(points: &[(f64, f64)], t: f64) -> Option<Fit> {
    let pts: Vec<(f64, f64)> = points.iter().copied().filter(|(k, v)| k.is_finite() && v.is_finite() && *v > 0.0).collect();
    if pts.len() < 5 || !(t > 0.0) {
        return None;
    }
    let atm = pts.iter().min_by(|a, b| a.0.abs().total_cmp(&b.0.abs())).map(|p| p.1).unwrap_or(0.2);
    let objective = |x: &[f64; 5]| -> f64 {
        let s = Svi::from(x);
        let mut err = 0.0;
        for (k, v) in &pts {
            let w = s.w(*k);
            if w <= 0.0 {
                return 1e6 + w.abs();
            }
            let d = (w / t).sqrt() - v;
            err += d * d;
        }
        // Keep the minimum total variance non-negative: a + bσ√(1−ρ²) ≥ 0.
        let floor = s.a + s.b * s.sigma * (1.0 - s.rho * s.rho).sqrt();
        err / pts.len() as f64 + if floor < 0.0 { 1e3 * floor * floor } else { 0.0 }
    };
    let mut best: Option<([f64; 5], f64)> = None;
    for (m0, rho0) in [(0.0, -0.4), (0.05, -0.7), (-0.05, -0.2), (0.0, 0.2)] {
        let b0 = 0.1f64;
        let s0 = 0.1f64;
        let a0 = atm * atm * t - b0 * s0;
        let start = [a0, b0.ln(), (rho0 as f64).atanh(), m0, s0.ln()];
        let (x, fx) = nelder_mead(&objective, start, [0.02 * t.max(0.05), 0.5, 0.3, 0.05, 0.5], 4000);
        let (x, fx) = nelder_mead(&objective, x, [0.005 * t.max(0.05), 0.2, 0.1, 0.02, 0.2], 4000).min_by_f(fx, x);
        if best.is_none_or(|b| fx < b.1) {
            best = Some((x, fx));
        }
    }
    let (x, _) = best?;
    let params = Svi::from(&x);
    let rmse = (pts.iter().map(|(k, v)| (params.iv(*k, t) - v).powi(2)).sum::<f64>() / pts.len() as f64).sqrt();
    let (kmin, kmax) = pts.iter().fold((f64::MAX, f64::MIN), |(lo, hi), (k, _)| (lo.min(*k), hi.max(*k)));
    let min_g = (0..=200).map(|i| params.g(kmin - 0.25 + (kmax - kmin + 0.5) * i as f64 / 200.0)).fold(f64::INFINITY, f64::min);
    Some(Fit { params, rmse, min_g, points: pts.len() })
}

trait MinBy {
    fn min_by_f(self, fx: f64, x: [f64; 5]) -> ([f64; 5], f64);
}
impl MinBy for ([f64; 5], f64) {
    fn min_by_f(self, fx: f64, x: [f64; 5]) -> ([f64; 5], f64) {
        if self.1 <= fx { self } else { (x, fx) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_a_known_smile() {
        let truth = Svi { a: 0.01, b: 0.08, rho: -0.5, m: 0.02, sigma: 0.15 };
        let t = 0.25;
        let pts: Vec<(f64, f64)> = (-12..=8).map(|i| i as f64 * 0.03).map(|k| (k, truth.iv(k, t))).collect();
        let f = fit(&pts, t).unwrap();
        assert!(f.rmse < 2e-4, "rmse {}", f.rmse);
        for &(k, v) in &pts {
            assert!((f.params.iv(k, t) - v).abs() < 1e-3);
        }
        assert!(f.min_g > 0.0, "this smile is arbitrage-free");
    }

    #[test]
    fn flat_smile_and_too_few_points() {
        let pts: Vec<(f64, f64)> = (-5..=5).map(|i| (i as f64 * 0.05, 0.3)).collect();
        let f = fit(&pts, 0.5).unwrap();
        assert!(f.rmse < 1e-3);
        assert!(fit(&pts[..3], 0.5).is_none());
    }

    #[test]
    fn detects_butterfly_arbitrage() {
        // A very steep, sharp smile violates the density condition.
        let bad = Svi { a: -0.05, b: 2.0, rho: -0.99, m: 0.0, sigma: 0.01 };
        let worst = (-50..=50).map(|i| bad.g(i as f64 * 0.01)).fold(f64::INFINITY, f64::min);
        assert!(worst < 0.0);
    }
}
