//! The keyless treasury agent: a NEAR implicit account whose only key is an Ed25519 key that NEAR's MPC network
//! (Chain Signatures) derives for this hub contract and a fixed path. No person or server holds that key: a
//! transaction from the agent exists only when this contract asks the MPC network to sign it, and the contract asks
//! only for an action the spend policy already approved (a milestone payout), with the transaction's content fixed
//! here. The agent holds part of the tUSD payout desk; a payout is the agent's `ft_transfer_call` of exactly the
//! approved amount to this hub, which checks it against the approved action and forwards it to the creator. A second
//! delivery of the same action (another signature, another nonce) is refunded, so a payout lands at most once.
//!
//! State lives under raw storage keys (`x:agent…`), so the Hub struct's layout, and its stored state, are unchanged.

use near_sdk::borsh::{self, BorshDeserialize};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{env, near, AccountId};

/// The derivation path of the agent's key (with this contract as the predecessor).
pub const AGENT_PATH: &str = "signalfire-treasury-agent";
/// MPC signer contracts (docs.near.org, Chain Signatures): testnet and mainnet.
pub const MPC_SIGNER_TESTNET: &str = "v1.signer-prod.testnet";
pub const MPC_SIGNER_MAINNET: &str = "v1.signer";
/// Ed25519 in the MPC network's domains (0 is secp256k1).
pub const ED25519_DOMAIN: u32 = 1;
/// Gas the agent's own transaction attaches to `ft_transfer_call` (the hub's check and the forward run inside it).
pub const AGENT_TX_GAS: u64 = 200_000_000_000_000;
/// After this, a payout the agent hasn't delivered may be paid by the hub directly (and the agent's late delivery
/// is refunded).
pub const AGENT_TIMEOUT_MS: u64 = 30 * 60 * 1000;
/// A signed but undelivered action may be re-signed (new block hash and nonce) after this.
pub const RESIGN_AFTER_MS: u64 = 3 * 60 * 1000;

pub fn mpc_signer() -> AccountId {
    let testnet = env::current_account_id().as_str().ends_with(".testnet");
    (if testnet { MPC_SIGNER_TESTNET } else { MPC_SIGNER_MAINNET }).parse().unwrap()
}

/// The agent: its implicit account (hex of its public key), the key, and where the key comes from.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentDesk {
    pub account: AccountId,
    /// "ed25519:<base58>", as the MPC signer's `derived_public_key` returns it
    pub public_key: String,
    pub signer: AccountId,
    pub path: String,
    pub domain_id: u32,
    pub enabled: bool,
    /// tUSD the agent holds for payouts not yet reserved (raw, 6 decimals)
    pub tusd_free: U128,
    /// the highest transaction nonce this contract has had signed for the agent
    pub last_nonce: u64,
    pub actions: u32,
    pub created_ms: u64,
}

/// One approved action for the agent to carry out.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentAction {
    pub id: u32,
    pub kind: String,
    pub campaign: u32,
    pub milestone: u8,
    pub receiver: AccountId,
    pub tusd: U128,
    /// the NEAR the treasury paid for it (yoctoNEAR)
    pub amount: U128,
    pub audit_n: u64,
    /// approved → signing → signed → delivering → paid; or fallback (the hub paid directly) / failed:transfer
    pub status: String,
    pub created_ms: u64,
    pub signed_ms: Option<u64>,
    pub done_ms: Option<u64>,
    pub signs: u32,
    pub nonce: Option<u64>,
    /// sha256 of the borsh transaction, hex: the NEAR transaction hash (base58 of these bytes)
    pub tx_hash: Option<String>,
    /// the signed transaction (borsh), ready for anyone to broadcast
    pub signed_tx: Option<Base64VecU8>,
}

/// What the MPC signer returns for an Ed25519 request.
#[near(serializers = [json])]
pub struct MpcEd25519Signature {
    pub scheme: String,
    pub signature: Vec<u8>,
}

#[near(serializers = [json])]
pub struct MpcPayloadEd {
    #[serde(rename = "Eddsa")]
    pub eddsa: String,
}

#[near(serializers = [json])]
pub struct MpcSignRequestEd {
    pub path: String,
    pub payload_v2: MpcPayloadEd,
    pub domain_id: u32,
}

// ---------- storage ----------

const DESK_KEY: &[u8] = b"x:agent";
fn action_key(id: u32) -> Vec<u8> {
    format!("x:agent:a:{id}").into_bytes()
}

pub fn load_desk() -> Option<AgentDesk> {
    env::storage_read(DESK_KEY).and_then(|b| AgentDesk::try_from_slice(&b).ok())
}
pub fn save_desk(d: &AgentDesk) {
    env::storage_write(DESK_KEY, &borsh::to_vec(d).unwrap());
}
pub fn load_action(id: u32) -> Option<AgentAction> {
    env::storage_read(&action_key(id)).and_then(|b| AgentAction::try_from_slice(&b).ok())
}
pub fn save_action(a: &AgentAction) {
    env::storage_write(&action_key(a.id), &borsh::to_vec(a).unwrap());
}

// ---------- keys and transactions ----------

/// "ed25519:<base58>" → the 32 key bytes.
pub fn ed25519_bytes(key: &str) -> Option<[u8; 32]> {
    let b = bs58::decode(key.strip_prefix("ed25519:")?).into_vec().ok()?;
    b.try_into().ok()
}

/// A NEAR implicit account is the hex of its Ed25519 public key.
pub fn implicit_account(pk: &[u8; 32]) -> AccountId {
    hex::encode(pk).parse().unwrap()
}

pub fn block_hash_bytes(b58: &str) -> Option<[u8; 32]> {
    bs58::decode(b58).into_vec().ok()?.try_into().ok()
}

fn put_str(v: &mut Vec<u8>, s: &str) {
    v.extend((s.len() as u32).to_le_bytes());
    v.extend(s.as_bytes());
}

/// The borsh bytes of a NEAR transaction with one FunctionCall action (the layout wallets and near-api-js sign):
/// signer_id, public_key (0 = ED25519 ‖ 32 bytes), nonce, receiver_id, block_hash, actions [FunctionCall = 2:
/// method_name, args, gas, deposit].
#[allow(clippy::too_many_arguments)]
pub fn function_call_tx(signer: &str, pk: &[u8; 32], nonce: u64, receiver: &str, block_hash: &[u8; 32], method: &str, args: &[u8], gas: u64, deposit: u128) -> Vec<u8> {
    let mut v = Vec::with_capacity(256 + args.len());
    put_str(&mut v, signer);
    v.push(0);
    v.extend(pk);
    v.extend(nonce.to_le_bytes());
    put_str(&mut v, receiver);
    v.extend(block_hash);
    v.extend(1u32.to_le_bytes());
    v.push(2);
    put_str(&mut v, method);
    v.extend((args.len() as u32).to_le_bytes());
    v.extend(args);
    v.extend(gas.to_le_bytes());
    v.extend(deposit.to_le_bytes());
    v
}

/// A signed transaction: the transaction, then the signature (0 = ED25519 ‖ 64 bytes).
pub fn signed_tx(tx: &[u8], sig: &[u8; 64]) -> Vec<u8> {
    let mut v = tx.to_vec();
    v.push(0);
    v.extend(sig);
    v
}

/// The `msg` of a payout delivery, and its parse.
pub fn payout_msg(id: u32) -> String {
    format!("agent-payout:{id}")
}
pub fn parse_payout_msg(msg: &str) -> Option<u32> {
    msg.strip_prefix("agent-payout:")?.parse().ok()
}

/// The agent's payout transaction: `tusd.ft_transfer_call(hub, tusd, msg)` with 1 yoctoNEAR.
pub fn payout_tx(desk: &AgentDesk, pk: &[u8; 32], nonce: u64, block_hash: &[u8; 32], tusd_token: &AccountId, hub: &AccountId, a: &AgentAction) -> Vec<u8> {
    let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({ "receiver_id": hub, "amount": a.tusd, "msg": payout_msg(a.id) })).unwrap();
    function_call_tx(desk.account.as_str(), pk, nonce, tusd_token.as_str(), block_hash, "ft_transfer_call", &args, AGENT_TX_GAS, 1)
}
