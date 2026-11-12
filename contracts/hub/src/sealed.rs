//! Sealed bids scored privately by OutLayer (TEE compute for NEAR). A creator encrypts its opening (price, pitch
//! hash, salt) to an X25519 key that only Signalfire's scoring program can derive inside an OutLayer TEE (an
//! encryption key bound to that exact wasm build and to this hub as the caller), and posts the ciphertext with the
//! usual commitment and bond. Nobody reveals. When bidding closes, anyone asks OutLayer to run the scorer on every
//! ciphertext; the hub accepts back only the winner's opening (checked here against its commitment) and which
//! ciphertexts opened. Losing bids are never revealed, to us or anyone.
//!
//! State lives under raw storage keys (`x:ol`, `x:sb:<campaign>`), so the Hub struct's layout is unchanged.

use near_sdk::borsh::{self, BorshDeserialize};
use near_sdk::{env, near, AccountId};

pub const OUTLAYER_TESTNET: &str = "outlayer.testnet";
pub const OUTLAYER_MAINNET: &str = "outlayer.near";
/// OutLayer's minimum and what we attach per run (unused NEAR is refunded to the caller).
pub const MIN_RUN_DEPOSIT: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
/// A failed or stuck scoring may be asked again after this.
pub const RESCORE_AFTER_MS: u64 = 2 * 60 * 1000;
/// After the reveal window plus this, a sealed brief that could not be scored ends with every bond returned.
pub const SEALED_GIVE_UP_MS: u64 = 30 * 60 * 1000;
pub const MAX_CIPHERTEXT_HEX: usize = 2048;

pub fn outlayer() -> AccountId {
    let testnet = env::current_account_id().as_str().ends_with(".testnet");
    (if testnet { OUTLAYER_TESTNET } else { OUTLAYER_MAINNET }).parse().unwrap()
}

/// The scoring program: its wasm (by URL and sha256) and the bid key it published.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Scorer {
    pub outlayer: AccountId,
    pub wasm_url: String,
    pub wasm_hash: String,
    pub build_target: String,
    /// X25519 public key (hex) creators encrypt to; published by the scorer itself through OutLayer
    pub bid_key: Option<String>,
    pub key_ms: Option<u64>,
    /// the key run's exact input and output, so its OutLayer attestation can be checked (sha256 of each)
    pub key_input: Option<String>,
    pub key_output: Option<String>,
    pub set_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SealedEntry {
    pub creator: AccountId,
    /// hex: ephemeral X25519 key (32) ‖ nonce (24) ‖ XChaCha20-Poly1305 ciphertext + tag
    pub ciphertext: String,
}

/// A brief that takes sealed bids: the ciphertexts, and the scoring run's exact input and output.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SealedBook {
    pub campaign: u32,
    pub entries: Vec<SealedEntry>,
    /// open → scoring → scored; failed (may be asked again); abandoned (could not be scored: bonds returned)
    pub status: String,
    pub attempts: u32,
    pub requested_ms: Option<u64>,
    pub scored_ms: Option<u64>,
    /// the scorer the bids were sealed to (its wasm hash and bid key at the time)
    pub wasm_hash: String,
    pub bid_key: String,
    /// the exact `input_data` sent to OutLayer, its sha256, and the program's output as returned
    pub input: Option<String>,
    pub input_hash: Option<String>,
    pub output: Option<String>,
    pub output_hash: Option<String>,
    /// which ciphertexts opened and matched their commitment (bonds back), by commit order
    pub valid: Vec<bool>,
}

const SCORER_KEY: &[u8] = b"x:ol";
fn book_key(id: u32) -> Vec<u8> {
    format!("x:sb:{id}").into_bytes()
}

pub fn load_scorer() -> Option<Scorer> {
    env::storage_read(SCORER_KEY).and_then(|b| Scorer::try_from_slice(&b).ok())
}
pub fn save_scorer(s: &Scorer) {
    env::storage_write(SCORER_KEY, &borsh::to_vec(s).unwrap());
}
pub fn load_book(id: u32) -> Option<SealedBook> {
    env::storage_read(&book_key(id)).and_then(|b| SealedBook::try_from_slice(&b).ok())
}
pub fn save_book(b: &SealedBook) {
    env::storage_write(&book_key(b.campaign), &borsh::to_vec(b).unwrap());
}

pub fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.len() % 2 == 0 && s.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// What the ciphertext is bound to (AEAD associated data), as the scorer and the sealing code build it.
pub fn bid_aad(hub: &str, campaign: u32, creator: &str) -> String {
    format!("signalfire|sealed-bid|{hub}|{campaign}|{creator}")
}
