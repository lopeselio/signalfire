//! Signalfire's sealed-bid scorer, run by OutLayer inside an Intel TDX enclave.
//!
//! Creators encrypt their bid (price, pitch hash, salt) to an X25519 key that only this program can derive: its
//! secret is an HMAC that OutLayer's keystore computes inside the TEE under a key bound to this exact build (the
//! wasm's sha256) and to the account that asked for the run (`caller: "predecessor"`: the Signalfire hub contract).
//! No person, no server and no other contract can derive it, and this program never outputs it.
//!
//!   {"op":"public_key"}                     → {"public_key": hex}         the key creators encrypt to
//!   {"op":"score", "hub", "campaign", "budget", "min_bid_bps", "bids":[{creator, hash, rep, ciphertext}]}
//!                                           → {"winner", "price", "pitch_hash", "salt", "score", "valid", …}
//!
//! Scoring is the hub's rule (contracts/hub/src/rules.rs, packages/core): a bid is credible if
//! budget·min_bid_bps/10⁴ ≤ price ≤ budget; the winner has the lowest price·10⁴/(10⁴+rep), ties to the earlier
//! commit. A bid counts only if it opens, names this hub, campaign and creator, and hashes to the commitment the
//! creator posted onchain. Only the winner's opening leaves the enclave: losing bids are never revealed.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

#[cfg(target_arch = "wasm32")]
mod encryption_keys_host {
    wit_bindgen::generate!({ world: "encryption-keys-host", path: "wit" });
}
#[cfg(target_arch = "wasm32")]
use encryption_keys_host::outlayer::encryption_keys::api as encryption_keys;

const KEY_PATH: &str = "bids";
const KEY_LABEL: &[u8] = b"signalfire/sealed-bid/x25519/v1";
const HKDF_INFO: &[u8] = b"signalfire-bid-v1";

#[derive(Deserialize)]
struct Input {
    op: String,
    hub: Option<String>,
    campaign: Option<u32>,
    budget: Option<String>,
    min_bid_bps: Option<u32>,
    #[serde(default)]
    bids: Vec<SealedBid>,
}

#[derive(Deserialize)]
struct SealedBid {
    creator: String,
    /// the commitment posted onchain: sha256("signalfire|bid|<campaign>|<creator>|<price>|<pitch_hash>|<salt>")
    hash: String,
    rep: i64,
    /// hex: ephemeral X25519 public key (32) ‖ nonce (24) ‖ XChaCha20-Poly1305 ciphertext + tag
    ciphertext: String,
}

#[derive(Deserialize)]
struct Opening {
    price: String,
    pitch_hash: String,
    salt: String,
}

#[cfg(target_arch = "wasm32")]
fn secret() -> Result<StaticSecret, String> {
    let seed = encryption_keys::mac(KEY_PATH, None, KEY_LABEL)?;
    let bytes: [u8; 32] = seed.try_into().map_err(|_| "the keystore's mac is not 32 bytes".to_string())?;
    Ok(StaticSecret::from(bytes))
}

/// Off the TEE (tests only) there is no keystore: a fixed seed stands in for the HMAC.
#[cfg(not(target_arch = "wasm32"))]
fn secret() -> Result<StaticSecret, String> {
    let _ = (KEY_PATH, KEY_LABEL);
    Ok(StaticSecret::from([7u8; 32]))
}

fn sha_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// What the ciphertext is bound to: a bid copied onto another creator, campaign or hub fails to open.
pub fn aad(hub: &str, campaign: u32, creator: &str) -> String {
    format!("signalfire|sealed-bid|{hub}|{campaign}|{creator}")
}

pub fn open(secret: &StaticSecret, wire: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
    if wire.len() < 32 + 24 + 16 {
        return None;
    }
    let eph = PublicKey::from(<[u8; 32]>::try_from(&wire[..32]).ok()?);
    let shared = secret.diffie_hellman(&eph);
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(None, shared.as_bytes()).expand(HKDF_INFO, &mut key).ok()?;
    XChaCha20Poly1305::new(&key.into()).decrypt(XNonce::from_slice(&wire[32..56]), Payload { msg: &wire[56..], aad }).ok()
}

pub fn score(price: u128, rep: i64) -> u128 {
    price * 10_000 / (10_000 + rep) as u128
}

pub fn credible(price: u128, budget: u128, min_bid_bps: u32) -> bool {
    price > 0 && price <= budget && price >= budget * min_bid_bps as u128 / 10_000
}

fn run(raw: &str) -> Result<Value, String> {
    let input: Input = serde_json::from_str(raw).map_err(|e| format!("input: {e}"))?;
    let sk = secret()?;
    let pk = hex::encode(PublicKey::from(&sk).as_bytes());
    match input.op.as_str() {
        "public_key" => Ok(json!({ "op": "public_key", "public_key": pk })),
        "score" => {
            let hub = input.hub.ok_or("hub")?;
            let campaign = input.campaign.ok_or("campaign")?;
            let budget: u128 = input.budget.ok_or("budget")?.parse().map_err(|_| "budget")?;
            let min_bps = input.min_bid_bps.ok_or("min_bid_bps")?;
            let mut valid = Vec::with_capacity(input.bids.len());
            let mut best: Option<(usize, u128, Opening)> = None;
            let mut credible_n = 0u32;
            for (i, b) in input.bids.iter().enumerate() {
                let opening = hex::decode(&b.ciphertext)
                    .ok()
                    .and_then(|w| open(&sk, &w, aad(&hub, campaign, &b.creator).as_bytes()))
                    .and_then(|pt| serde_json::from_slice::<Opening>(&pt).ok())
                    .filter(|o| o.pitch_hash.len() == 64 && o.salt.len() <= 128)
                    .and_then(|o| o.price.parse::<u128>().ok().map(|p| (p, o)))
                    .filter(|(p, o)| sha_hex(&format!("signalfire|bid|{campaign}|{}|{p}|{}|{}", b.creator, o.pitch_hash, o.salt)) == b.hash);
                valid.push(opening.is_some());
                let Some((price, o)) = opening else { continue };
                if !credible(price, budget, min_bps) {
                    continue;
                }
                credible_n += 1;
                let s = score(price, b.rep);
                // strict "<": an equal score keeps the earlier commit
                if best.as_ref().map_or(true, |(_, bs, _)| s < *bs) {
                    best = Some((i, s, o));
                }
            }
            let input_hash = sha_hex(raw);
            Ok(match best {
                Some((i, s, o)) => json!({
                    "op": "score", "hub": hub, "campaign": campaign, "public_key": pk, "input_hash": input_hash,
                    "winner": input.bids[i].creator, "index": i, "price": o.price, "pitch_hash": o.pitch_hash, "salt": o.salt,
                    "score": s.to_string(), "valid": valid, "credible": credible_n
                }),
                None => json!({ "op": "score", "hub": hub, "campaign": campaign, "public_key": pk, "input_hash": input_hash, "winner": null, "valid": valid, "credible": 0 }),
            })
        }
        other => Err(format!("unknown op {other}")),
    }
}

fn main() {
    use std::io::{Read, Write};
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let out = run(&raw).unwrap_or_else(|e| json!({ "error": e }));
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(out.to_string().as_bytes());
    let _ = stdout.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    // Sealed by packages/attest (sealBid) with ephemeral secret [9; 32] and nonce [5; 24] to the public key of the
    // test secret [7; 32]: the TypeScript and Rust sides agree byte for byte.
    const TS_SEALED: &str = include_str!("../test/sealed-vector.hex");

    #[test]
    fn opens_what_the_browser_sealed_and_scores_by_the_hubs_rule() {
        let raw = format!(
            r#"{{"op":"score","hub":"signalfire.testnet","campaign":7,"budget":"1000000000000000000000000","min_bid_bps":2000,"bids":[{{"creator":"nova.testnet","hash":"{}","rep":0,"ciphertext":"{}"}},{{"creator":"quill.testnet","hash":"00","rep":0,"ciphertext":"00"}}]}}"#,
            sha_hex(&format!("signalfire|bid|7|nova.testnet|600000000000000000000000|{}|s1", "ab".repeat(32))),
            TS_SEALED.trim()
        );
        let out = run(&raw).unwrap();
        assert_eq!(out["winner"], "nova.testnet");
        assert_eq!(out["price"], "600000000000000000000000");
        assert_eq!(out["valid"], serde_json::json!([true, false]));
        assert_eq!(out["input_hash"], sha_hex(&raw));
        // the same ciphertext under another creator does not open
        let other = raw.replacen("nova.testnet", "ember.testnet", 1);
        assert_eq!(run(&other).unwrap()["valid"], serde_json::json!([false, false]));
    }

    #[test]
    fn the_rule_matches_the_hub() {
        assert!(credible(200, 1000, 2000) && !credible(199, 1000, 2000) && !credible(1001, 1000, 2000));
        assert_eq!(score(1000, 3000), 769);
        assert_eq!(score(1000, -2000), 1250);
    }
}
