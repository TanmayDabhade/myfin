//! The crate against independent scipy/numpy reference values
//! (scripts/options-oracle.py → tests/oracle.txt).
use options_math::black::{bsm, Kind};
use options_math::iv;
use options_math::normal::cdf;
use options_math::realized::{rolling, Bars, Estimator};

fn rows() -> Vec<(String, Vec<f64>)> {
    include_str!("oracle.txt")
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .map(|l| {
            let mut it = l.split_whitespace();
            let tag = it.next().unwrap().to_string();
            (tag, it.map(|x| x.parse::<f64>().unwrap()).collect())
        })
        .collect()
}

fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / b.abs().max(1e-300)
}

#[test]
fn normal_distribution_matches_scipy() {
    let mut n = 0;
    for (_, v) in rows().into_iter().filter(|(t, _)| t == "cdf") {
        let (x, want) = (v[0], v[1]);
        assert!(rel(cdf(x), want) < 1e-13 || (cdf(x) - want).abs() < 1e-17, "Φ({x}) = {} vs scipy {want}", cdf(x));
        n += 1;
    }
    assert!(n > 150);
}

#[test]
fn prices_and_greeks_match_scipy() {
    let mut n = 0;
    for (_, v) in rows().into_iter().filter(|(t, _)| t == "bsm") {
        let kind = Kind::from_i32(v[0] as i32).unwrap();
        let g = bsm(kind, v[1], v[2], v[3], v[4], v[5], v[6]);
        let want = &v[7..13];
        let got = [g.price, g.delta, g.gamma, g.vega, g.theta, g.rho];
        for (i, name) in ["price", "delta", "gamma", "vega", "theta", "rho"].iter().enumerate() {
            let scale = want[i].abs().max(1e-8);
            assert!((got[i] - want[i]).abs() <= 1e-10 * scale.max(1.0) || rel(got[i], want[i]) < 1e-10, "{name}: {} vs {} for {:?}", got[i], want[i], &v[..7]);
        }
        n += 1;
    }
    assert_eq!(n, 400);
}

#[test]
fn implied_volatility_matches_scipy_brent() {
    let mut n = 0;
    for (_, v) in rows().into_iter().filter(|(t, _)| t == "iv") {
        let kind = Kind::from_i32(v[0] as i32).unwrap();
        let got = iv::bsm(kind, v[1], v[2], v[3], v[4], v[5], v[6]).unwrap();
        assert!((got - v[7]).abs() < 1e-9, "IV {got} vs scipy {} for {:?}", v[7], &v[..7]);
        n += 1;
    }
    assert_eq!(n, 200);
}

#[test]
fn realized_volatility_matches_numpy() {
    let all = rows();
    let bars: Vec<&Vec<f64>> = all.iter().filter(|(t, _)| t == "bar").map(|(_, v)| v).collect();
    let col = |i: usize| bars.iter().map(|b| b[i]).collect::<Vec<f64>>();
    let (o, h, l, c) = (col(0), col(1), col(2), col(3));
    let b = Bars { open: &o, high: &h, low: &l, close: &c };
    let none = vec![false; c.len()];
    let mut n = 0;
    for (_, v) in all.iter().filter(|(t, _)| t == "rv") {
        let est = Estimator::from_i32(v[0] as i32).unwrap();
        let w = v[1] as usize;
        let got = *rolling(est, b, &none, w).last().unwrap();
        assert!(rel(got, v[2]) < 1e-12, "{est:?} w={w}: {got} vs numpy {}", v[2]);
        n += 1;
    }
    assert_eq!(n, 20);
}
