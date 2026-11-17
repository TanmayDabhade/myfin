//! A risk-free curve from Treasury bill yields (FRED DTB4WK, DTB3, DTB6,
//! DTB1YR are secondary-market rates on a discount basis).
//!
//! A bill quoted at discount rate d with `days` to maturity costs
//! 1 − d·days/360 per 1 of face value. The continuously compounded zero
//! rate is −ln(price) / (days/365). Rates between pillars are linearly
//! interpolated in time, and held flat outside them.

/// Discount-basis bill rate (decimal, e.g. 0.0425) → continuous zero rate.
pub fn bill_discount_to_continuous(discount_rate: f64, days: f64) -> Option<f64> {
    if !(discount_rate.is_finite() && days.is_finite() && days > 0.0) {
        return None;
    }
    let price = 1.0 - discount_rate * days / 360.0;
    if price <= 0.0 {
        return None;
    }
    Some(-price.ln() / (days / 365.0))
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Curve {
    /// (years, continuous zero rate), sorted by time.
    pub points: Vec<(f64, f64)>,
}

impl Curve {
    pub fn new(mut points: Vec<(f64, f64)>) -> Curve {
        points.retain(|(t, r)| t.is_finite() && r.is_finite() && *t > 0.0);
        points.sort_by(|a, b| a.0.total_cmp(&b.0));
        points.dedup_by(|a, b| a.0 == b.0);
        Curve { points }
    }

    /// Zero rate to time `t`; NaN for an empty curve.
    pub fn rate(&self, t: f64) -> f64 {
        let p = &self.points;
        match p.len() {
            0 => f64::NAN,
            _ if t <= p[0].0 => p[0].1,
            _ if t >= p[p.len() - 1].0 => p[p.len() - 1].1,
            _ => {
                let i = p.partition_point(|(x, _)| *x <= t);
                let (t0, r0) = p[i - 1];
                let (t1, r1) = p[i];
                r0 + (r1 - r0) * (t - t0) / (t1 - t0)
            }
        }
    }

    pub fn discount(&self, t: f64) -> f64 {
        (-self.rate(t) * t).exp()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_a_bill_quote() {
        // 3-month bill at 4.00% discount, 91 days: price 0.989889 → 4.104% continuous.
        let r = bill_discount_to_continuous(0.04, 91.0).unwrap();
        let price = 1.0 - 0.04 * 91.0 / 360.0;
        assert!(((-r * 91.0 / 365.0).exp() - price).abs() < 1e-15);
        assert!(r > 0.04 && r < 0.042, "{r}");
        assert!(bill_discount_to_continuous(5.0, 91.0).is_none());
        assert!(bill_discount_to_continuous(0.04, 0.0).is_none());
    }

    #[test]
    fn interpolates_and_extrapolates_flat() {
        let c = Curve::new(vec![(0.5, 0.05), (0.25, 0.04), (1.0, 0.045), (f64::NAN, 1.0)]);
        assert_eq!(c.points.len(), 3);
        assert_eq!(c.rate(0.1), 0.04);
        assert!((c.rate(0.375) - 0.045).abs() < 1e-15);
        assert_eq!(c.rate(3.0), 0.045);
        assert!((c.discount(1.0) - (-0.045f64).exp()).abs() < 1e-15);
        assert!(Curve::default().rate(1.0).is_nan());
    }
}
