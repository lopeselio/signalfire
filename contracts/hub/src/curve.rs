//! The bonding curve, identical to packages/core/src/curve.ts (shared vector in tests.rs).
//!
//! Price per raw unit at circulating supply x: p(x) = A + B·x yoctoNEAR.
//! cost(x0, x1) = A·(x1−x0) + B·(x1²−x0²)/2, exact because B is even.

pub const UNIT: u128 = 1_000_000;
pub const SUPPLY: u128 = 1_000_000 * UNIT;
pub const A: u128 = 100_000_000_000_000;
pub const B: u128 = 10_000;
pub const FEE_BPS: u128 = 200;
pub const FT_STORAGE: u128 = 1_250_000_000_000_000_000_000;
pub const MAX_BUY: u128 = 1_000 * 1_000_000_000_000_000_000_000_000;

pub fn cost(x0: u128, x1: u128) -> u128 {
    assert!(x1 >= x0, "cost: bad range");
    A * (x1 - x0) + B * (x1 * x1 - x0 * x0) / 2
}

pub fn price_at(x: u128) -> u128 {
    (A + B * x) * UNIT
}

pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = x / 2 + 1;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

#[derive(Debug, PartialEq)]
pub struct BuyQuote {
    pub storage: u128,
    pub fee: u128,
    pub net: u128,
    pub tokens: u128,
    pub cost: u128,
    pub refund: u128,
}

pub fn quote_buy(x0: u128, gross: u128, needs_storage: bool) -> BuyQuote {
    let storage = if needs_storage { FT_STORAGE } else { 0 };
    assert!(gross > storage, "not enough attached for the storage registration");
    let rest = gross - storage;
    let fee = rest * FEE_BPS / 10_000;
    let net = rest - fee;
    let base = A + B * x0;
    let mut x1 = (isqrt(base * base + 2 * B * net) - A) / B;
    if x1 > SUPPLY {
        x1 = SUPPLY;
    }
    let c = cost(x0, x1);
    BuyQuote { storage, fee, net, tokens: x1 - x0, cost: c, refund: net - c }
}

#[derive(Debug, PartialEq)]
pub struct SellQuote {
    pub proceeds: u128,
    pub fee: u128,
    pub out: u128,
}

pub fn quote_sell(x0: u128, tokens: u128) -> SellQuote {
    assert!(tokens > 0 && tokens <= x0, "sell: bad amount");
    let proceeds = cost(x0 - tokens, x0);
    let fee = proceeds * FEE_BPS / 10_000;
    SellQuote { proceeds, fee, out: proceeds - fee }
}
