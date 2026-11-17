//! WebAssembly exports of `options-math` for the interface.
//!
//! A plain numeric ABI, so no bindings generator is needed: scalars in and
//! out, and arrays passed as pointers into this module's memory (allocate
//! with `alloc_f64`, free with `free_f64`). The JavaScript side is
//! `src/options/math.js`. Every function here only converts arguments; the
//! mathematics lives in `options-math`, the same code the desktop app runs.
//!
//! Option kind: 1 = call, −1 = put. Estimator: 0 close-to-close,
//! 1 Parkinson, 2 Garman–Klass, 3 Rogers–Satchell, 4 Yang–Zhang.

use options_math::american::{self, Dividend};
use options_math::black::{self, Kind};
use options_math::iv;
use options_math::normal;
use options_math::realized::{self, Bars, Estimator};

/// Interface version; bumped when an export changes meaning.
#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn alloc_f64(n: usize) -> *mut f64 {
    let mut v = vec![0.0f64; n.max(1)];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p` and `n` must come from one `alloc_f64` call.
#[no_mangle]
pub unsafe extern "C" fn free_f64(p: *mut f64, n: usize) {
    if !p.is_null() {
        drop(Vec::from_raw_parts(p, n.max(1), n.max(1)));
    }
}

unsafe fn slice<'a>(p: *const f64, n: usize) -> &'a [f64] {
    if p.is_null() || n == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(p, n)
    }
}

unsafe fn write(out: *mut f64, values: &[f64]) {
    if !out.is_null() {
        std::ptr::copy_nonoverlapping(values.as_ptr(), out, values.len());
    }
}

#[no_mangle]
pub extern "C" fn norm_cdf(x: f64) -> f64 {
    normal::cdf(x)
}

/// Writes 10 values to `out`: price, delta, gamma, vega, theta, rho, vanna, charm, vomma, speed.
/// # Safety
/// `out` must point to 10 writable f64s.
#[no_mangle]
pub unsafe extern "C" fn bsm_greeks(kind: i32, s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, out: *mut f64) -> i32 {
    let Some(kind) = Kind::from_i32(kind) else { return 0 };
    write(out, &black::bsm(kind, s, k, t, r, q, sigma).to_array());
    1
}

/// # Safety
/// `out` must point to 10 writable f64s.
#[no_mangle]
pub unsafe extern "C" fn black76_greeks(kind: i32, f: f64, k: f64, t: f64, r: f64, sigma: f64, out: *mut f64) -> i32 {
    let Some(kind) = Kind::from_i32(kind) else { return 0 };
    write(out, &black::black76(kind, f, k, t, r, sigma).to_array());
    1
}

/// Implied volatility of a European option on forward `f` with discount
/// factor `df`. Failure returns a negative code: −1 bad input, −2 below
/// intrinsic, −3 no time value, −4 above maximum, −5 no convergence.
#[no_mangle]
pub extern "C" fn implied_vol(kind: i32, price: f64, f: f64, k: f64, t: f64, df: f64) -> f64 {
    let Some(kind) = Kind::from_i32(kind) else { return -1.0 };
    match iv::european(kind, price, f, k, t, df) {
        Ok(v) => v,
        Err(e) => -e.code(),
    }
}

unsafe fn dividends(times: *const f64, amounts: *const f64, n: usize) -> Vec<Dividend> {
    slice(times, n).iter().zip(slice(amounts, n)).map(|(&t, &amount)| Dividend { t, amount }).collect()
}

/// American (early = 1) or European (early = 0) price on the Leisen–Reimer tree.
/// # Safety
/// `div_t` and `div_amount` must each point to `n_div` f64s (or be null with n_div = 0).
#[no_mangle]
pub unsafe extern "C" fn tree_price(kind: i32, s: f64, k: f64, t: f64, r: f64, q: f64, sigma: f64, steps: u32, early: i32, div_t: *const f64, div_amount: *const f64, n_div: usize) -> f64 {
    let Some(kind) = Kind::from_i32(kind) else { return f64::NAN };
    american::price(kind, s, k, t, r, q, sigma, &dividends(div_t, div_amount, n_div), steps as usize, early != 0)
}

/// Implied volatility of an American option (same error codes as `implied_vol`).
/// # Safety
/// As `tree_price`.
#[no_mangle]
pub unsafe extern "C" fn american_iv(kind: i32, price: f64, s: f64, k: f64, t: f64, r: f64, q: f64, steps: u32, div_t: *const f64, div_amount: *const f64, n_div: usize) -> f64 {
    let Some(kind) = Kind::from_i32(kind) else { return -1.0 };
    match iv::american(kind, price, s, k, t, r, q, &dividends(div_t, div_amount, n_div), steps as usize) {
        Ok(v) => v,
        Err(e) => -e.code(),
    }
}

/// Flags bars whose open is more than `threshold` from the prior close
/// (1.0 = flagged) into `out` (n values). Returns the number flagged.
/// # Safety
/// `open`, `close` and `out` must each point to `n` f64s.
#[no_mangle]
pub unsafe extern "C" fn split_suspects(open: *const f64, close: *const f64, n: usize, threshold: f64, out: *mut f64) -> u32 {
    let flags = realized::split_suspects(slice(open, n), slice(close, n), threshold);
    let as_f: Vec<f64> = flags.iter().map(|&b| if b { 1.0 } else { 0.0 }).collect();
    write(out, &as_f);
    flags.iter().filter(|b| **b).count() as u32
}

/// Rolling annualized volatility into `out` (n values, NaN until enough data).
/// `excluded` holds 1.0 for bars to leave out (or is null).
/// # Safety
/// Every pointer must reference `n` f64s; `excluded` may be null.
#[no_mangle]
pub unsafe extern "C" fn realized_rolling(estimator: i32, open: *const f64, high: *const f64, low: *const f64, close: *const f64, excluded: *const f64, n: usize, window: u32, out: *mut f64) -> i32 {
    let Some(est) = Estimator::from_i32(estimator) else { return 0 };
    let bars = Bars { open: slice(open, n), high: slice(high, n), low: slice(low, n), close: slice(close, n) };
    let ex: Vec<bool> = if excluded.is_null() { vec![false; n] } else { slice(excluded, n).iter().map(|v| *v != 0.0).collect() };
    write(out, &realized::rolling(est, bars, &ex, window as usize));
    1
}

/// Volatility cone: for each of `n_windows` window lengths, 8 values into
/// `out`: window, min, p25, median, p75, max, current, count.
/// # Safety
/// Bar pointers reference `n` f64s, `windows` references `n_windows`, `out` 8·n_windows.
#[no_mangle]
pub unsafe extern "C" fn realized_cone(estimator: i32, open: *const f64, high: *const f64, low: *const f64, close: *const f64, excluded: *const f64, n: usize, windows: *const f64, n_windows: usize, out: *mut f64) -> i32 {
    let Some(est) = Estimator::from_i32(estimator) else { return 0 };
    let bars = Bars { open: slice(open, n), high: slice(high, n), low: slice(low, n), close: slice(close, n) };
    let ex: Vec<bool> = if excluded.is_null() { vec![false; n] } else { slice(excluded, n).iter().map(|v| *v != 0.0).collect() };
    let w: Vec<usize> = slice(windows, n_windows).iter().map(|v| *v as usize).collect();
    let flat: Vec<f64> = realized::cone(est, bars, &ex, &w).into_iter().flat_map(|r| r.to_array()).collect();
    write(out, &flat);
    1
}
