//! Standard normal density and distribution function.
//!
//! The distribution function uses two coefficient-free expansions of erfc,
//! so its accuracy follows from the mathematics rather than from transcribed
//! constants: a positive-term series for small arguments and a continued
//! fraction (modified Lentz) for the tail. Relative accuracy is about 1e-14
//! across the range Aperture uses (checked against scipy in the oracle test).

pub const SQRT_2PI: f64 = 2.506_628_274_631_000_5;
const SQRT_PI: f64 = 1.772_453_850_905_516;
const FRAC_1_SQRT_2: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// Standard normal density.
pub fn pdf(x: f64) -> f64 {
    (-0.5 * x * x).exp() / SQRT_2PI
}

/// erf(z) for 0 ≤ z < 2: 2/√π · e^{−z²} · Σ 2ⁿ z^{2n+1} / (2n+1)!!, all terms positive.
fn erf_series(z: f64) -> f64 {
    let z2 = z * z;
    let mut term = z;
    let mut sum = z;
    let mut n = 0.0;
    loop {
        term *= 2.0 * z2 / (2.0 * n + 3.0);
        sum += term;
        n += 1.0;
        if term < 1e-17 * sum || n > 200.0 {
            break;
        }
    }
    2.0 / SQRT_PI * (-z2).exp() * sum
}

/// erfc(z) for z ≥ 2: e^{−z²}/√π · 1/(z + (1/2)/(z + 1/(z + (3/2)/(z + …)))).
fn erfc_fraction(z: f64) -> f64 {
    const TINY: f64 = 1e-300;
    let mut f = z;
    let mut c = z;
    let mut d = 0.0;
    for n in 1..2000 {
        let a = n as f64 * 0.5;
        d = z + a * d;
        if d.abs() < TINY {
            d = TINY;
        }
        c = z + a / c;
        if c.abs() < TINY {
            c = TINY;
        }
        d = 1.0 / d;
        let delta = c * d;
        f *= delta;
        if (delta - 1.0).abs() < 1e-16 {
            break;
        }
    }
    (-z * z).exp() / (f * SQRT_PI)
}

/// Complementary error function for z ≥ 0.
fn erfc_pos(z: f64) -> f64 {
    if z < 2.0 {
        1.0 - erf_series(z)
    } else if z > 27.0 {
        0.0
    } else {
        erfc_fraction(z)
    }
}

/// Standard normal distribution function N(x).
pub fn cdf(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    let z = x.abs() * FRAC_1_SQRT_2;
    let tail = 0.5 * erfc_pos(z);
    if x >= 0.0 {
        1.0 - tail
    } else {
        tail
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_values() {
        // Reference values of Φ(x) to 15+ significant figures.
        let cases = [
            (0.0, 0.5),
            (1.0, 0.841_344_746_068_542_9),
            (-1.0, 0.158_655_253_931_457_05),
            (1.96, 0.975_002_104_851_779_6),
            (-3.0, 0.001_349_898_031_630_094_6),
            (-5.0, 2.866_515_718_791_939e-7),
            (-8.0, 6.220_960_574_271_784e-16),
            (2.5, 0.993_790_334_674_223_6),
        ];
        for (x, want) in cases {
            let got = cdf(x);
            assert!(((got - want) / want).abs() < 1e-13, "Φ({x}) = {got}, want {want}");
        }
        assert_eq!(cdf(40.0), 1.0);
        assert_eq!(cdf(-40.0), 0.0);
        assert!(cdf(f64::NAN).is_nan());
    }
    #[test]
    fn symmetric_and_monotone() {
        let mut prev = 0.0;
        for i in -800..=800 {
            let x = i as f64 / 100.0;
            let p = cdf(x);
            assert!((p + cdf(-x) - 1.0).abs() < 1e-15, "symmetry at {x}");
            assert!(p >= prev, "monotone at {x}");
            prev = p;
        }
    }
}
