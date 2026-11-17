//! Realized (historical) volatility from daily OHLC bars.
//!
//! | Estimator | Uses | Notes |
//! |---|---|---|
//! | Close-to-close | C | Sample stdev of log returns |
//! | Parkinson (1980) | H, L | Ignores opening gaps, so it reads low for stocks |
//! | Garman–Klass (1980) | O, H, L, C | Ignores opening gaps |
//! | Rogers–Satchell (1991) | O, H, L, C | Unaffected by drift; ignores opening gaps |
//! | Yang–Zhang (2000) | O, H, L, C + prior C | Overnight + open-to-close + RS; handles gaps and drift |
//!
//! All results are annualized with 252 trading days. A bar flagged in
//! `excluded` (for example an unadjusted stock split) contributes no
//! overnight or close-to-close return; its own intraday range still counts.

pub const YEAR: f64 = 252.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Estimator {
    CloseToClose,
    Parkinson,
    GarmanKlass,
    RogersSatchell,
    YangZhang,
}

impl Estimator {
    pub fn from_i32(v: i32) -> Option<Estimator> {
        Some(match v {
            0 => Estimator::CloseToClose,
            1 => Estimator::Parkinson,
            2 => Estimator::GarmanKlass,
            3 => Estimator::RogersSatchell,
            4 => Estimator::YangZhang,
            _ => return None,
        })
    }
}

/// Daily bars as parallel slices, oldest first.
#[derive(Clone, Copy)]
pub struct Bars<'a> {
    pub open: &'a [f64],
    pub high: &'a [f64],
    pub low: &'a [f64],
    pub close: &'a [f64],
}

impl Bars<'_> {
    pub fn len(&self) -> usize {
        self.close.len().min(self.open.len()).min(self.high.len()).min(self.low.len())
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    fn ok(&self, i: usize) -> bool {
        let (o, h, l, c) = (self.open[i], self.high[i], self.low[i], self.close[i]);
        [o, h, l, c].iter().all(|v| v.is_finite() && *v > 0.0) && h >= l
    }
}

/// Bars whose open is more than `threshold` (e.g. 0.4 = 40%) away from the
/// prior close: probably a split the provider didn't adjust. Index 0 is never flagged.
pub fn split_suspects(open: &[f64], close: &[f64], threshold: f64) -> Vec<bool> {
    let n = open.len().min(close.len());
    (0..n).map(|i| i > 0 && close[i - 1] > 0.0 && open[i].is_finite() && (open[i] / close[i - 1] - 1.0).abs() > threshold).collect()
}

struct Parts {
    /// ln(C_i / C_{i−1})
    cc: Option<f64>,
    /// ln(O_i / C_{i−1})
    overnight: Option<f64>,
    /// ln(C_i / O_i)
    oc: Option<f64>,
    /// ln(H_i / L_i)
    hl: Option<f64>,
    /// Rogers–Satchell term u(u − c) + d(d − c)
    rs: Option<f64>,
}

fn parts(b: &Bars, excluded: &[bool], i: usize) -> Parts {
    let here = b.ok(i);
    let link = i > 0 && here && b.ok(i - 1) && !excluded.get(i).copied().unwrap_or(false);
    let (o, h, l, c) = (b.open[i], b.high[i], b.low[i], b.close[i]);
    let u = (h / o).ln();
    let d = (l / o).ln();
    let cl = (c / o).ln();
    Parts {
        cc: link.then(|| (c / b.close[i - 1]).ln()),
        overnight: link.then(|| (o / b.close[i - 1]).ln()),
        oc: here.then_some(cl),
        hl: here.then(|| (h / l).ln()),
        rs: here.then(|| u * (u - cl) + d * (d - cl)),
    }
}

fn sample_var(x: &[f64]) -> Option<f64> {
    if x.len() < 2 {
        return None;
    }
    let m = x.iter().sum::<f64>() / x.len() as f64;
    Some(x.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / (x.len() - 1) as f64)
}

fn mean(x: &[f64]) -> Option<f64> {
    (x.len() >= 2).then(|| x.iter().sum::<f64>() / x.len() as f64)
}

/// Daily variance over a set of bars, by estimator.
fn window_variance(est: Estimator, p: &[Parts]) -> Option<f64> {
    let ln2 = std::f64::consts::LN_2;
    let collect = |f: &dyn Fn(&Parts) -> Option<f64>| p.iter().filter_map(f).collect::<Vec<f64>>();
    let v = match est {
        Estimator::CloseToClose => sample_var(&collect(&|x| x.cc))?,
        Estimator::Parkinson => mean(&collect(&|x| x.hl.map(|h| h * h)))? / (4.0 * ln2),
        Estimator::GarmanKlass => mean(&collect(&|x| Some(0.5 * x.hl? * x.hl? - (2.0 * ln2 - 1.0) * x.oc? * x.oc?)))?,
        Estimator::RogersSatchell => mean(&collect(&|x| x.rs))?,
        Estimator::YangZhang => {
            // Bars with an overnight return, so the three parts share one sample.
            let linked: Vec<&Parts> = p.iter().filter(|x| x.overnight.is_some() && x.oc.is_some()).collect();
            let n = linked.len();
            if n < 3 {
                return None;
            }
            let on: Vec<f64> = linked.iter().map(|x| x.overnight.unwrap()).collect();
            let oc: Vec<f64> = linked.iter().map(|x| x.oc.unwrap()).collect();
            let rs = linked.iter().map(|x| x.rs.unwrap()).sum::<f64>() / n as f64;
            let nf = n as f64;
            let k = 0.34 / (1.34 + (nf + 1.0) / (nf - 1.0));
            sample_var(&on)? + k * sample_var(&oc)? + (1.0 - k) * rs
        }
    };
    (v.is_finite() && v >= 0.0).then_some(v)
}

/// Annualized volatility over each window of `window` bars ending at each
/// bar. `out[i]` covers bars i−window+1 ..= i; NaN until enough data.
pub fn rolling(est: Estimator, bars: Bars, excluded: &[bool], window: usize) -> Vec<f64> {
    let n = bars.len();
    let mut out = vec![f64::NAN; n];
    if window < 2 || n == 0 {
        return out;
    }
    let all: Vec<Parts> = (0..n).map(|i| parts(&bars, excluded, i)).collect();
    for i in (window - 1)..n {
        if let Some(v) = window_variance(est, &all[i + 1 - window..=i]) {
            out[i] = (v * YEAR).sqrt();
        }
    }
    out
}

/// Linear-interpolation percentile of sorted data (numpy's default).
pub fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let pos = (p.clamp(0.0, 1.0)) * (sorted.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo as f64)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ConeRow {
    pub window: usize,
    pub min: f64,
    pub p25: f64,
    pub median: f64,
    pub p75: f64,
    pub max: f64,
    /// The latest window's value.
    pub current: f64,
    /// Number of (overlapping) windows in the distribution.
    pub count: usize,
}

impl ConeRow {
    pub fn to_array(self) -> [f64; 8] {
        [self.window as f64, self.min, self.p25, self.median, self.p75, self.max, self.current, self.count as f64]
    }
}

/// Volatility cone: the distribution of rolling volatility for each window length.
pub fn cone(est: Estimator, bars: Bars, excluded: &[bool], windows: &[usize]) -> Vec<ConeRow> {
    windows
        .iter()
        .map(|&w| {
            let series = rolling(est, bars, excluded, w);
            let current = series.last().copied().unwrap_or(f64::NAN);
            let mut v: Vec<f64> = series.into_iter().filter(|x| x.is_finite()).collect();
            v.sort_by(|a, b| a.total_cmp(b));
            ConeRow {
                window: w,
                min: v.first().copied().unwrap_or(f64::NAN),
                p25: percentile(&v, 0.25),
                median: percentile(&v, 0.5),
                p75: percentile(&v, 0.75),
                max: v.last().copied().unwrap_or(f64::NAN),
                current,
                count: v.len(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic GBM bars with a known daily volatility, opening at the prior close.
    fn gbm(n: usize, sigma_annual: f64) -> (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>) {
        let mut seed: u64 = 42;
        let mut normal = || {
            // Box–Muller on a small LCG: fine for a statistical test.
            let mut u = || {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                ((seed >> 11) as f64 + 0.5) / (1u64 << 53) as f64
            };
            let (a, b) = (u(), u());
            (-2.0 * a.ln()).sqrt() * (2.0 * std::f64::consts::PI * b).cos()
        };
        let sd = sigma_annual / YEAR.sqrt();
        let steps = 400;
        let (mut o, mut h, mut l, mut c) = (vec![], vec![], vec![], vec![]);
        let mut px = 100.0f64;
        for _ in 0..n {
            let open = px;
            let (mut hi, mut lo) = (px, px);
            for _ in 0..steps {
                px *= (sd / (steps as f64).sqrt() * normal()).exp();
                hi = hi.max(px);
                lo = lo.min(px);
            }
            o.push(open);
            h.push(hi);
            l.push(lo);
            c.push(px);
        }
        (o, h, l, c)
    }

    #[test]
    fn estimators_recover_a_known_volatility() {
        let (o, h, l, c) = gbm(3000, 0.30);
        let bars = Bars { open: &o, high: &h, low: &l, close: &c };
        let none = vec![false; c.len()];
        for est in [Estimator::CloseToClose, Estimator::GarmanKlass, Estimator::RogersSatchell, Estimator::YangZhang, Estimator::Parkinson] {
            let v = *rolling(est, bars, &none, 3000).last().unwrap();
            // Discretely sampled highs/lows sit inside the true range, so range estimators read a little low.
            assert!((v - 0.30).abs() < 0.03, "{est:?} → {v}");
        }
    }

    #[test]
    fn close_to_close_matches_the_textbook_formula() {
        let c = [100.0, 101.0, 99.5, 102.0, 101.0];
        let bars = Bars { open: &c, high: &c, low: &c, close: &c };
        let r: Vec<f64> = c.windows(2).map(|w| (w[1] / w[0]).ln()).collect();
        let m = r.iter().sum::<f64>() / 4.0;
        let want = (r.iter().map(|x| (x - m).powi(2)).sum::<f64>() / 3.0 * 252.0).sqrt();
        let got = rolling(Estimator::CloseToClose, bars, &[false; 5], 5);
        assert!(got[..4].iter().all(|v| v.is_nan()));
        assert!((got[4] - want).abs() < 1e-15);
    }

    #[test]
    fn a_flagged_split_is_left_out() {
        let (mut o, mut h, mut l, mut c) = gbm(300, 0.2);
        // An unadjusted 2-for-1 split from bar 150 on.
        for i in 150..300 {
            o[i] /= 2.0;
            h[i] /= 2.0;
            l[i] /= 2.0;
            c[i] /= 2.0;
        }
        let ex = split_suspects(&o, &c, 0.4);
        assert_eq!(ex.iter().filter(|x| **x).count(), 1);
        assert!(ex[150]);
        let bars = Bars { open: &o, high: &h, low: &l, close: &c };
        let raw = *rolling(Estimator::YangZhang, bars, &vec![false; 300], 252).last().unwrap();
        let fixed = *rolling(Estimator::YangZhang, bars, &ex, 252).last().unwrap();
        assert!(raw > 0.5, "split inflates the raw figure: {raw}");
        assert!((fixed - 0.2).abs() < 0.05, "{fixed}");
    }

    #[test]
    fn cone_and_percentiles() {
        let (o, h, l, c) = gbm(600, 0.25);
        let bars = Bars { open: &o, high: &h, low: &l, close: &c };
        let rows = cone(Estimator::YangZhang, bars, &vec![false; 600], &[20, 60, 120]);
        assert_eq!(rows.len(), 3);
        for r in &rows {
            assert!(r.min <= r.p25 && r.p25 <= r.median && r.median <= r.p75 && r.p75 <= r.max);
            assert_eq!(r.count, 600 - r.window + 1);
        }
        // Longer windows vary less.
        assert!(rows[2].max - rows[2].min < rows[0].max - rows[0].min);
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 0.5), 2.5);
        assert!(percentile(&[], 0.5).is_nan());
    }

    #[test]
    fn ignores_bad_bars() {
        let o = [100.0, f64::NAN, 101.0, 102.0, 101.0, 100.0];
        let bars = Bars { open: &o, high: &[101.0, 1.0, 102.0, 103.0, 102.0, 101.0], low: &[99.0, 1.0, 100.0, 101.0, 100.0, 99.0], close: &[100.5, 1.0, 101.5, 102.5, 100.5, 100.2] };
        let v = rolling(Estimator::CloseToClose, bars, &[false; 6], 6);
        assert!(v[5].is_finite());
    }
}
