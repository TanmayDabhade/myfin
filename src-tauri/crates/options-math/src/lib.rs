//! Aperture's options mathematics: one implementation used by the desktop
//! app, the background recorder and (through WebAssembly) the interface.
//!
//! Conventions, everywhere:
//! - Time `t` is in years. Rates and yields are continuously compounded decimals.
//! - Volatility is an annualized decimal (0.25 = 25%).
//! - Theta and charm are per year of calendar time (divide by 365 for per day).
//! - Vega, vomma and vanna are per 1.00 change in volatility (divide by 100 for per vol point).
//! - Rho is per 1.00 change in the rate.
//! - Realized volatility uses log returns and 252 trading days a year.

pub mod american;
pub mod black;
pub mod forward;
pub mod iv;
pub mod normal;
pub mod rates;
pub mod realized;

pub use black::{Greeks, Kind};
pub mod svi;
