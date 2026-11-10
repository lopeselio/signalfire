//! Bid hashes, auction scoring, milestones, attribution, the payout policy and lookalike names.
//! Identical to packages/core (shared vector in tests.rs).

use near_sdk::env;

pub const MILESTONES: u8 = 3;
pub const MIN_ATTRIB: u128 = 50_000_000_000_000_000_000_000;
pub const BID_BOND: u128 = 20_000_000_000_000_000_000_000;
pub const VET_FEE: u128 = 10_000_000_000_000_000_000_000;
pub const TUSD_PER_NEAR: u128 = 3;
pub const BURST_MS: u64 = 60_000;
pub const HOUR_MS: u64 = 3_600_000;

pub fn sha_hex(s: &str) -> String {
    hex::encode(env::sha256(s.as_bytes()))
}

pub fn is_hex32(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn pitch_hash(pitch: &str) -> String {
    sha_hex(&format!("signalfire|pitch|{pitch}"))
}

pub fn bid_hash(campaign: u32, creator: &str, price: u128, pitch_hash: &str, salt: &str) -> String {
    sha_hex(&format!("signalfire|bid|{campaign}|{creator}|{price}|{pitch_hash}|{salt}"))
}

pub fn rep_bps(completed: u32, missed: u32) -> i64 {
    (500 * completed as i64 - 1000 * missed as i64).clamp(-2000, 3000)
}

pub fn score(price: u128, rep: i64) -> u128 {
    price * 10_000 / (10_000 + rep) as u128
}

pub fn credible(price: u128, budget: u128, min_bid_bps: u32) -> bool {
    price > 0 && price <= budget && price >= budget * min_bid_bps as u128 / 10_000
}

pub fn threshold(target: u32, k: u8) -> u32 {
    (target * k as u32).div_ceil(MILESTONES as u32)
}

pub fn milestone_amount(price: u128, k: u8) -> u128 {
    let third = price / MILESTONES as u128;
    if k < MILESTONES {
        third
    } else {
        price - third * (MILESTONES as u128 - 1)
    }
}

pub fn unlocked(target: u32, results: u32) -> u8 {
    let mut k = 0;
    while k < MILESTONES && results >= threshold(target, k + 1) {
        k += 1;
    }
    k
}

pub fn tusd_for(yocto: u128) -> u128 {
    yocto * TUSD_PER_NEAR / 1_000_000_000_000_000_000
}

pub struct PayoutCheck<'a> {
    pub amount: u128,
    pub price: u128,
    pub paid_so_far: u128,
    pub max_payout: u128,
    pub payouts_per_hour: u32,
    pub recent: &'a [u64],
    pub last_payout_ms: Option<u64>,
    pub now_ms: u64,
    pub prior_payouts_to_payee: u32,
}

/// The outcome ("paid", "held:over_cap", "held:rate_limit") and the audit flags.
pub fn evaluate_payout(c: &PayoutCheck) -> (String, Vec<String>) {
    let mut flags = vec![];
    let over_cap = c.amount > c.max_payout || c.paid_so_far + c.amount > c.price;
    let in_hour = c.recent.iter().filter(|t| c.now_ms.saturating_sub(**t) < HOUR_MS).count() as u32;
    let rate_limited = in_hour >= c.payouts_per_hour;
    if over_cap {
        flags.push("over_cap".to_string());
    }
    if rate_limited {
        flags.push("rate_limit".to_string());
    }
    if c.last_payout_ms.is_some_and(|l| c.now_ms.saturating_sub(l) < BURST_MS) {
        flags.push("burst".to_string());
    }
    if c.prior_payouts_to_payee == 0 {
        flags.push("new_payee".to_string());
    }
    let outcome = if over_cap {
        "held:over_cap"
    } else if rate_limited {
        "held:rate_limit"
    } else {
        "paid"
    };
    (outcome.to_string(), flags)
}

pub fn normalize(account: &str) -> String {
    account
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .chars()
        .map(|c| match c {
            '0' => 'o',
            '1' => 'l',
            '3' => 'e',
            '5' => 's',
            c => c,
        })
        .collect()
}

pub fn levenshtein(a: &str, b: &str) -> usize {
    let a = a.as_bytes();
    let b = b.as_bytes();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut diag = prev[0];
        prev[0] = i;
        for j in 1..=b.len() {
            let tmp = prev[j];
            prev[j] = (prev[j] + 1).min(prev[j - 1] + 1).min(diag + usize::from(a[i - 1] != b[j - 1]));
            diag = tmp;
        }
    }
    prev[b.len()]
}

pub fn is_lookalike(candidate: &str, existing: &str) -> bool {
    if candidate == existing {
        return false;
    }
    let a = normalize(candidate);
    let b = normalize(existing);
    if a == b {
        return true;
    }
    a.len().min(b.len()) >= 4 && levenshtein(&a, &b) <= 1
}
