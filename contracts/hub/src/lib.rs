//! Signalfire hub: attention tokens whose trading fees can only fund marketing.
//!
//! - **Launchpad.** `launch_startup` creates `<sym>.<hub>` (the NEP-141 global contract
//!   `ft.globals.primitives.testnet`, whole fixed supply minted to this hub) and `<sym>-dao.<hub>` (a Sputnik DAO v2
//!   from `dao.globals.primitives.testnet`) in one call. Founders get no tokens.
//! - **Market.** A linear bonding curve (`curve.rs`) sells and buys back the token for NEAR. 2% of every trade goes to
//!   the startup's **marketing treasury**, a ledger in this contract.
//! - **Spend policy.** Treasury money leaves only through `claim_milestone`: to the winning, admitted creator of a
//!   campaign the startup's DAO funded, within the campaign price, the founder's per-payout cap and hourly rate,
//!   milestone by milestone as attributed results arrive. Every attempt is written to the audit log with flags.
//! - **Campaign auctions.** Sealed bids (commit-reveal) with bonds from agent wallets; the winner is decided here by
//!   a deterministic rule; funding is a FunctionCall proposal on the startup's DAO that holders vote on.
//! - **Agents.** Agent accounts are created here with function-call keys only; they spend from capped wallets.
//! - **NFTs (NEP-171).** A soulbound creator NFT whose metadata is computed from state, and campaign receipts.
//!
//! The strings and integer rules are byte for byte packages/core (shared vector in tests.rs).

use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap, LookupSet, Vector};
use near_sdk::{
    env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey,
};
use std::collections::HashMap;

pub mod curve;
pub mod keyless;
pub mod rules;
pub mod sealed;
#[cfg(test)]
mod tests;

use curve::*;
use keyless::*;
use rules::*;
use sealed::*;

const YOCTO: u128 = 1_000_000_000_000_000_000_000_000;
pub const LAUNCH_DEPOSIT: u128 = YOCTO; // 1 NEAR: token + DAO accounts and their storage
const TOKEN_ACCOUNT_BALANCE: u128 = YOCTO / 10;
pub const TRADE_RING: u64 = 240;
const MAX_ATTRIBUTED: usize = 500;
const AGENT_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(250);
pub const AGENT_METHODS: &str =
    "commit_bid,reveal_bid,agent_pay,buy_with_wallet,join_holders,claim_milestone,settle_auction,apply_creator,vet_creator,expire_campaign";
const TUSD_SUPPLY: u128 = 10_000_000 * 1_000_000;

const GAS_INIT: Gas = Gas::from_tgas(30);
const GAS_CB_LAUNCH: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_STORAGE: Gas = Gas::from_tgas(8);
const GAS_CB_SMALL: Gas = Gas::from_tgas(15);
const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(20);
const GAS_BALANCE: Gas = Gas::from_tgas(5);
const GAS_CB_HOLDER: Gas = Gas::from_tgas(90);
const GAS_CB_MEMBER: Gas = Gas::from_tgas(50);
const GAS_ACT: Gas = Gas::from_tgas(30);
const GAS_FUND_CALL: u64 = 30_000_000_000_000;
const GAS_MPC_VIEW: Gas = Gas::from_tgas(10);
const GAS_MPC_SIGN: Gas = Gas::from_tgas(60);
const GAS_CB_AGENT_KEY: Gas = Gas::from_tgas(60);
const GAS_CB_AGENT_SIGNED: Gas = Gas::from_tgas(15);
const GAS_CB_FORWARDED: Gas = Gas::from_tgas(40);
const GAS_OUTLAYER: Gas = Gas::from_tgas(50);
const GAS_CB_SCORED: Gas = Gas::from_tgas(80);

pub const TERMS: &str = "An attention token is NOT equity, NOT a share of revenue, profits or the treasury, and NOT a promise of anything. \
Its trading fees can only fund marketing campaigns chosen by holders. Testnet only: no real money.";

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Startups,
    StartupIds,
    Trades,
    Buyers,
    Campaigns,
    Creators,
    CreatorIds,
    Wallets,
    Audit,
    Applications,
    NftOwner,
    NftMeta,
    NftEnum,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Constraints {
    /// largest campaign budget (yoctoNEAR)
    pub campaign_cap: U128,
    /// largest single payout (yoctoNEAR); above it a payout is held
    pub max_payout: U128,
    pub payouts_per_hour: u32,
    /// the credible-bid floor as a share of the budget (basis points)
    pub min_bid_bps: u32,
    /// raw token units needed to join the holders' council
    pub min_holder_tokens: U128,
}

impl Default for Constraints {
    fn default() -> Self {
        Self {
            campaign_cap: U128(2 * YOCTO),
            max_payout: U128(YOCTO),
            payouts_per_hour: 6,
            min_bid_bps: 2000,
            min_holder_tokens: U128(100 * UNIT),
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Startup {
    pub id: String,
    pub name: String,
    pub pitch: String,
    pub founder: AccountId,
    pub token: AccountId,
    pub dao: AccountId,
    /// "launching" | "live" | "failed"
    pub status: String,
    pub circulating: U128,
    pub reserve: U128,
    /// the marketing treasury: free, reserved for funded campaigns, paid out, and every fee that came in
    pub available: U128,
    pub committed: U128,
    pub paid: U128,
    pub fees_in: U128,
    pub forfeits_in: U128,
    pub trades: u64,
    pub volume: U128,
    pub buyers: u32,
    pub constraints: Constraints,
    pub recent_payouts: Vec<u64>,
    pub last_payout_ms: Option<u64>,
    pub campaigns: Vec<u32>,
    pub created_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Trade {
    pub n: u64,
    pub ts_ms: u64,
    pub account: AccountId,
    /// "buy" | "sell"
    pub side: String,
    /// NEAR paid in (buy, fee included) or out (sell, after the fee)
    pub near: U128,
    pub tokens: U128,
    pub fee: U128,
    pub circulating_after: U128,
    pub ref_code: Option<String>,
    /// the campaign this buy counted for
    pub attributed: Option<u32>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Bid {
    pub creator: AccountId,
    pub hash: String,
    pub committed_ms: u64,
    pub revealed: bool,
    pub price: Option<U128>,
    pub pitch_hash: Option<String>,
    pub credible: bool,
    /// reputation at reveal (basis points)
    pub rep: i64,
    pub bond_settled: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Campaign {
    pub id: u32,
    pub startup: String,
    pub title: String,
    pub brief: String,
    /// attributed first-time buyers wanted
    pub target: u32,
    pub budget: U128,
    pub created_ms: u64,
    pub commit_ends_ms: u64,
    pub reveal_ends_ms: u64,
    pub duration_ms: u64,
    /// "bidding" | "proposing" | "voting" | "funded" | "done" | "expired" | "no_bids" | "propose_failed"
    pub phase: String,
    pub bids: Vec<Bid>,
    pub winner: Option<AccountId>,
    pub price: U128,
    pub proposal_id: Option<u64>,
    pub funded_ms: Option<u64>,
    pub deadline_ms: Option<u64>,
    pub results: u32,
    pub attributed: Vec<AccountId>,
    pub milestones_paid: u8,
    pub paid: U128,
    pub paid_tusd: U128,
    pub receipt: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Creator {
    pub account: AccountId,
    pub name: String,
    pub profile: String,
    /// sha256 of the scout's NEAR AI vetting report (the report and its TEE signature are published offchain)
    pub report_hash: String,
    pub scout: AccountId,
    pub admitted_ms: u64,
    pub revoked: bool,
    pub won: u32,
    pub completed: u32,
    pub missed: u32,
    pub results: u32,
    pub payouts: u32,
    pub paid: U128,
    pub paid_tusd: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Application {
    pub name: String,
    pub profile: String,
    pub fee: U128,
    pub applied_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Wallet {
    /// who may set caps and withdraw (the agent's operator, or the person themselves)
    pub owner: AccountId,
    pub balance: U128,
    /// bid bonds and application fees in escrow
    pub locked: U128,
    pub cap_tx: U128,
    pub cap_day: U128,
    pub day_start_ms: u64,
    pub day_spent: U128,
    pub spent_total: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct AuditEntry {
    pub n: u64,
    pub ts_ms: u64,
    pub startup: Option<String>,
    pub campaign: Option<u32>,
    /// "payout" | "fund" | "vet" | "revoke" | "bond_forfeit" | "expire" | "constraints"
    pub action: String,
    pub account: Option<AccountId>,
    pub amount: U128,
    pub outcome: String,
    pub flags: Vec<String>,
    pub note: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Hub {
    owner: AccountId,
    operator: AccountId,
    ft_global: AccountId,
    dao_global: AccountId,
    tusd: Option<AccountId>,
    scouts: Vec<AccountId>,
    startups: LookupMap<String, Startup>,
    startup_ids: Vector<String>,
    trades: LookupMap<String, Trade>,
    buyers: LookupSet<String>,
    campaigns: Vector<Campaign>,
    creators: LookupMap<AccountId, Creator>,
    creator_ids: Vector<AccountId>,
    applications: LookupMap<AccountId, Application>,
    wallets: IterableMap<AccountId, Wallet>,
    audit: Vector<AuditEntry>,
    /// NEAR kept as backing for tUSD paid out (the payout desk)
    desk_reserve: u128,
    tusd_paid: u128,
    nft: NonFungibleToken,
}

fn event(name: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "signalfire", "version": "1.0.0", "event": name, "data": [data] })));
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn valid_symbol(s: &str) -> bool {
    (2..=8).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) && s != "tusd"
}

fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

/// tUSD raw units (6 decimals) as "1.23".
pub fn tusd_str(raw: u128) -> String {
    format!("{}.{:02}", raw / 1_000_000, (raw % 1_000_000) / 10_000)
}

fn all_ok() -> bool {
    (0..env::promise_results_count()).all(|i| env::promise_result_checked(i, 1024).is_ok())
}

fn new_wallet(owner: &AccountId) -> Wallet {
    Wallet {
        owner: owner.clone(),
        balance: U128(0),
        locked: U128(0),
        cap_tx: U128(YOCTO),
        cap_day: U128(5 * YOCTO),
        day_start_ms: now_ms(),
        day_spent: U128(0),
        spent_total: U128(0),
    }
}

/// The JSON of a Sputnik proposal kind that adds or removes a holder.
pub fn member_kind(add: bool, member: &AccountId) -> Value {
    let k = if add { "AddMemberToRole" } else { "RemoveMemberFromRole" };
    json!({ k: { "member_id": member, "role": "holders" } })
}

/// The DAO policy a startup launches with.
pub fn dao_policy(hub: &AccountId, council: &[AccountId]) -> Value {
    json!({
        "roles": [
            { "name": "signalfire", "kind": { "Group": [hub] }, "permissions": [
                "call:AddProposal", "add_member_to_role:AddProposal", "add_member_to_role:VoteApprove",
                "remove_member_from_role:AddProposal", "remove_member_from_role:VoteApprove"], "vote_policy": {} },
            { "name": "holders", "kind": { "Group": council }, "permissions": ["call:VoteApprove", "call:VoteReject", "call:VoteRemove"], "vote_policy": {} }
        ],
        "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
        "proposal_bond": "0",
        "proposal_period": "604800000000000",
        "bounty_bond": "0",
        "bounty_forgiveness_period": "86400000000000"
    })
}

#[near]
impl Hub {
    #[init]
    pub fn new(owner: AccountId, operator: AccountId, ft_global: AccountId, dao_global: AccountId) -> Self {
        Self {
            owner,
            operator,
            ft_global,
            dao_global,
            tusd: None,
            scouts: vec![],
            startups: LookupMap::new(Key::Startups),
            startup_ids: Vector::new(Key::StartupIds),
            trades: LookupMap::new(Key::Trades),
            buyers: LookupSet::new(Key::Buyers),
            campaigns: Vector::new(Key::Campaigns),
            creators: LookupMap::new(Key::Creators),
            creator_ids: Vector::new(Key::CreatorIds),
            applications: LookupMap::new(Key::Applications),
            wallets: IterableMap::new(Key::Wallets),
            audit: Vector::new(Key::Audit),
            desk_reserve: 0,
            tusd_paid: 0,
            nft: NonFungibleToken::new(Key::NftOwner, env::current_account_id(), Some(Key::NftMeta), Some(Key::NftEnum), None::<Key>),
        }
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    #[allow(clippy::too_many_arguments)]
    fn log(&mut self, startup: Option<&str>, campaign: Option<u32>, action: &str, account: Option<&AccountId>, amount: u128, outcome: &str, flags: Vec<String>, note: String) -> u64 {
        let n = self.audit.len() as u64;
        let e = AuditEntry {
            n,
            ts_ms: now_ms(),
            startup: startup.map(str::to_string),
            campaign,
            action: action.to_string(),
            account: account.cloned(),
            amount: U128(amount),
            outcome: outcome.to_string(),
            flags,
            note,
        };
        event("audit", json!(e));
        self.audit.push(e);
        n
    }

    fn startup(&self, id: &str) -> &Startup {
        self.startups.get(id).unwrap_or_else(|| env::panic_str("no such startup"))
    }
    fn startup_mut(&mut self, id: &str) -> &mut Startup {
        self.startups.get_mut(id).unwrap_or_else(|| env::panic_str("no such startup"))
    }
    fn campaign_mut(&mut self, id: u32) -> &mut Campaign {
        self.campaigns.get_mut(id).unwrap_or_else(|| env::panic_str("no such campaign"))
    }

    // ---------- owner setup ----------

    pub fn add_scout(&mut self, scout: AccountId) {
        self.only_owner();
        if !self.scouts.contains(&scout) {
            self.scouts.push(scout);
        }
    }

    pub fn set_operator(&mut self, operator: AccountId) {
        self.only_owner();
        self.operator = operator;
    }

    /// Creates `tusd.<hub>`: the test stablecoin (global FT), whole supply to this hub's payout desk.
    #[payable]
    pub fn create_tusd(&mut self) -> Promise {
        self.only_owner();
        require!(self.tusd.is_none(), "tUSD exists");
        let id: AccountId = format!("tusd.{}", env::current_account_id()).parse().unwrap();
        self.tusd = Some(id.clone());
        let args = json!({
            "owner_id": env::current_account_id(),
            "total_supply": U128(TUSD_SUPPLY),
            "metadata": { "spec": "ft-1.0.0", "name": "Test USD (testnet only, no value) - Signalfire", "symbol": "tUSD", "decimals": 6,
                "icon": null, "reference": null, "reference_hash": null }
        });
        Promise::new(id)
            .create_account()
            .transfer(env::attached_deposit())
            .use_global_contract_by_account_id(self.ft_global.clone())
            .function_call("new", serde_json::to_vec(&args).unwrap(), yocto(0), GAS_INIT)
    }

    /// Creates an agent account `<name>.<hub>` whose only keys are function-call keys: one for this hub's agent
    /// methods, and optionally one for `act_proposal` on a DAO. The rest of the deposit opens its capped wallet.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_agent(&mut self, name: String, hub_key: PublicKey, dao: Option<AccountId>, dao_key: Option<PublicKey>, account_balance: U128, cap_tx: U128, cap_day: U128) -> Promise {
        self.only_owner();
        require!(!name.is_empty() && name.len() <= 24 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'), "bad agent name");
        require!(name.contains('-'), "agent names have a role prefix (creator-, holder-, fan-, scout-)");
        let id: AccountId = format!("{name}.{}", env::current_account_id()).parse().unwrap();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= account_balance.0, "deposit below the account balance");
        let mut p = Promise::new(id.clone())
            .create_account()
            .transfer(yocto(account_balance.0))
            .add_access_key_allowance(hub_key, Allowance::limited(AGENT_KEY_ALLOWANCE).unwrap(), env::current_account_id(), AGENT_METHODS);
        if let (Some(dao), Some(k)) = (dao, dao_key) {
            p = p.add_access_key_allowance(k, Allowance::limited(AGENT_KEY_ALLOWANCE).unwrap(), dao, "act_proposal");
        }
        let mut w = new_wallet(&env::predecessor_account_id());
        w.balance = U128(deposit - account_balance.0);
        w.cap_tx = cap_tx;
        w.cap_day = cap_day;
        self.wallets.insert(id.clone(), w);
        event("agent_created", json!({ "account": id, "wallet": U128(deposit - account_balance.0), "cap_tx": cap_tx, "cap_day": cap_day }));
        p
    }

    // ---------- launch ----------

    /// Launches a startup: its attention token and its DAO, in one call. Anyone may launch; the caller is the founder.
    #[payable]
    pub fn launch_startup(&mut self, symbol: String, name: String, pitch: String, council: Vec<AccountId>, constraints: Option<Constraints>) -> Promise {
        require!(valid_symbol(&symbol), "symbol: 2-8 lowercase letters or digits");
        require!(!self.startups.contains_key(&symbol), "symbol taken");
        require!(!name.is_empty() && name.len() <= 40 && pitch.len() <= 280, "name or pitch too long");
        require!(!council.is_empty() && council.len() <= 9, "council: 1 to 9 holders");
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= LAUNCH_DEPOSIT, "attach 1 NEAR to launch");
        let c = constraints.unwrap_or_default();
        Self::check_constraints(&c);
        let me = env::current_account_id();
        let token: AccountId = format!("{symbol}.{me}").parse().unwrap();
        let dao: AccountId = format!("{symbol}-dao.{me}").parse().unwrap();
        let founder = env::predecessor_account_id();
        self.startups.insert(
            symbol.clone(),
            Startup {
                id: symbol.clone(),
                name: name.clone(),
                pitch,
                founder: founder.clone(),
                token: token.clone(),
                dao: dao.clone(),
                status: "launching".into(),
                circulating: U128(0),
                reserve: U128(0),
                available: U128(0),
                committed: U128(0),
                paid: U128(0),
                fees_in: U128(0),
                forfeits_in: U128(0),
                trades: 0,
                volume: U128(0),
                buyers: 0,
                constraints: c,
                recent_payouts: vec![],
                last_payout_ms: None,
                campaigns: vec![],
                created_ms: now_ms(),
            },
        );
        self.startup_ids.push(symbol.clone());
        let ft_args = json!({
            "owner_id": me,
            "total_supply": U128(SUPPLY),
            "metadata": { "spec": "ft-1.0.0", "name": format!("{name} attention token (not equity)"), "symbol": symbol.to_uppercase(), "decimals": 6,
                "icon": null, "reference": null, "reference_hash": null }
        });
        let purpose = format!("Holders of {} vote on which marketing campaigns its treasury funds. {TERMS}", symbol.to_uppercase());
        let dao_args = json!({ "config": { "name": format!("{symbol}-dao"), "purpose": purpose, "metadata": Base64VecU8(vec![]) }, "policy": dao_policy(&me, &council) });
        event("startup_launched", json!({ "id": symbol, "founder": founder, "token": token, "dao": dao, "council": council }));
        let t = Promise::new(token)
            .create_account()
            .transfer(yocto(TOKEN_ACCOUNT_BALANCE))
            .use_global_contract_by_account_id(self.ft_global.clone())
            .function_call("new", serde_json::to_vec(&ft_args).unwrap(), yocto(0), GAS_INIT);
        let d = Promise::new(dao)
            .create_account()
            .transfer(yocto(deposit - TOKEN_ACCOUNT_BALANCE))
            .use_global_contract_by_account_id(self.dao_global.clone())
            .function_call("new", serde_json::to_vec(&dao_args).unwrap(), yocto(0), GAS_INIT);
        t.and(d).then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_LAUNCH).on_launched(symbol))
    }

    #[private]
    pub fn on_launched(&mut self, symbol: String) -> bool {
        let ok = all_ok();
        let s = self.startup_mut(&symbol);
        s.status = if ok { "live".into() } else { "failed".into() };
        event("startup_status", json!({ "id": symbol, "status": s.status }));
        ok
    }

    fn check_constraints(c: &Constraints) {
        require!(c.campaign_cap.0 > 0 && c.campaign_cap.0 <= 1000 * YOCTO, "campaign_cap out of range");
        require!(c.max_payout.0 > 0, "max_payout must be positive");
        require!((1..=60).contains(&c.payouts_per_hour), "payouts_per_hour: 1 to 60");
        require!(c.min_bid_bps <= 9000, "min_bid_bps: at most 9000");
        require!(c.min_holder_tokens.0 >= UNIT && c.min_holder_tokens.0 <= SUPPLY / 100, "min_holder_tokens: 1 token to 1% of supply");
    }

    /// The founder's only lever: the constraints the rules run within. They can't move money.
    pub fn set_constraints(&mut self, startup: String, constraints: Constraints) {
        Self::check_constraints(&constraints);
        let me = env::predecessor_account_id();
        let s = self.startup_mut(&startup);
        require!(s.founder == me, "founder only");
        s.constraints = constraints.clone();
        self.log(Some(&startup), None, "constraints", Some(&me), 0, "set", vec![], serde_json::to_string(&constraints).unwrap());
    }

    // ---------- the market ----------

    /// Buys tokens with the attached NEAR. `ref_code` ("c<campaign id>") credits a campaign.
    #[payable]
    pub fn buy(&mut self, startup: String, min_tokens_out: U128, ref_code: Option<String>) -> Promise {
        let buyer = env::predecessor_account_id();
        let gross = env::attached_deposit().as_yoctonear();
        self.internal_buy(startup, buyer, gross, min_tokens_out.0, ref_code, false)
    }

    /// An agent buys from its wallet (function-call keys can't attach NEAR).
    pub fn buy_with_wallet(&mut self, startup: String, amount: U128, min_tokens_out: U128, ref_code: Option<String>) -> Promise {
        let buyer = env::predecessor_account_id();
        self.wallet_spend(&buyer, amount.0);
        self.internal_buy(startup, buyer, amount.0, min_tokens_out.0, ref_code, true)
    }

    fn internal_buy(&mut self, startup: String, buyer: AccountId, gross: u128, min_out: u128, ref_code: Option<String>, from_wallet: bool) -> Promise {
        require!(gross <= MAX_BUY, "at most 1000 NEAR per buy");
        let key = format!("{startup}|{buyer}");
        let first = !self.buyers.contains(&key);
        let s = self.startup(&startup);
        require!(s.status == "live", "startup is not live");
        let x0 = s.circulating.0;
        let q = curve::quote_buy(x0, gross, first);
        require!(q.tokens > 0, "too little to buy one raw unit");
        require!(q.tokens >= min_out, "slippage: fewer tokens than min_tokens_out");
        let token = s.token.clone();
        // attribution: a first-time buyer through a funded campaign's code
        let mut attributed = None;
        if let Some(id) = ref_code.as_deref().and_then(|c| c.strip_prefix('c')).and_then(|n| n.parse::<u32>().ok()) {
            if let Some(c) = self.campaigns.get_mut(id) {
                let live = c.phase == "funded" && c.deadline_ms.is_some_and(|d| now_ms() <= d);
                if c.startup == startup && live && first && gross >= MIN_ATTRIB && c.winner.as_ref() != Some(&buyer) {
                    c.results += 1;
                    if c.attributed.len() < MAX_ATTRIBUTED {
                        c.attributed.push(buyer.clone());
                    }
                    attributed = Some(id);
                }
            }
        }
        if first {
            self.buyers.insert(key);
        }
        let s = self.startup_mut(&startup);
        s.circulating = U128(x0 + q.tokens);
        s.reserve = U128(s.reserve.0 + q.cost);
        s.available = U128(s.available.0 + q.fee);
        s.fees_in = U128(s.fees_in.0 + q.fee);
        s.volume = U128(s.volume.0 + gross);
        if first {
            s.buyers += 1;
        }
        let circ = s.circulating;
        self.record_trade(&startup, &buyer, "buy", gross, q.tokens, q.fee, circ, ref_code.clone(), attributed);
        event("buy", json!({ "startup": startup, "buyer": buyer, "near": U128(gross), "tokens": U128(q.tokens), "fee": U128(q.fee), "ref": ref_code, "attributed": attributed }));
        let mut p = Promise::new(token);
        if first {
            p = p.function_call("storage_deposit", serde_json::to_vec(&json!({ "account_id": buyer, "registration_only": true })).unwrap(), yocto(FT_STORAGE), GAS_STORAGE);
        }
        p = p.function_call(
            "ft_transfer",
            serde_json::to_vec(&json!({ "receiver_id": buyer, "amount": U128(q.tokens), "memo": "signalfire buy" })).unwrap(),
            yocto(1),
            GAS_FT_TRANSFER,
        );
        p.then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_SMALL).on_bought(startup, buyer, U128(q.tokens), U128(q.fee), U128(q.refund), from_wallet))
    }

    #[allow(clippy::too_many_arguments)]
    fn record_trade(&mut self, startup: &str, account: &AccountId, side: &str, near: u128, tokens: u128, fee: u128, circ: U128, ref_code: Option<String>, attributed: Option<u32>) {
        let s = self.startup_mut(startup);
        let n = s.trades;
        s.trades += 1;
        let t = Trade {
            n,
            ts_ms: now_ms(),
            account: account.clone(),
            side: side.into(),
            near: U128(near),
            tokens: U128(tokens),
            fee: U128(fee),
            circulating_after: circ,
            ref_code,
            attributed,
        };
        self.trades.insert(format!("{startup}|{}", n % TRADE_RING), t);
    }

    /// Refunds the dust; if the token transfer failed, puts the tokens back on the curve and refunds the buyer.
    #[private]
    pub fn on_bought(&mut self, startup: String, buyer: AccountId, tokens: U128, fee: U128, refund: U128, from_wallet: bool) -> bool {
        let ok = all_ok();
        let back = if ok {
            refund.0
        } else {
            // undo: the tokens go back on the curve, the reserve follows the integral, the fee is returned
            let s = self.startup_mut(&startup);
            let before = s.reserve.0;
            let x = s.circulating.0 - tokens.0;
            s.circulating = U128(x);
            s.reserve = U128(cost(0, x));
            let fee = fee.0.min(s.available.0);
            s.available = U128(s.available.0 - fee);
            s.fees_in = U128(s.fees_in.0 - fee);
            event("buy_reverted", json!({ "startup": startup, "buyer": buyer, "tokens": tokens }));
            (before - s.reserve.0) + fee + refund.0
        };
        if back > 0 {
            if from_wallet {
                if let Some(w) = self.wallets.get_mut(&buyer) {
                    w.balance = U128(w.balance.0 + back);
                }
            } else {
                Promise::new(buyer).transfer(yocto(back)).detach();
            }
        }
        ok
    }

    /// NEP-141 receiver: selling tokens back to the curve. `msg` = `{"min_near_out": "<yocto>"}`.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        if self.tusd.as_ref() == Some(&token) {
            return self.agent_delivery(sender_id, amount, msg);
        }
        let suffix = format!(".{}", env::current_account_id());
        let sym = token.as_str().strip_suffix(&suffix).unwrap_or_else(|| env::panic_str("not a Signalfire token")).to_string();
        let s = self.startup(&sym);
        require!(s.token == token && s.status == "live", "not a live Signalfire token");
        let m: Value = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg: {\"min_near_out\": \"<yocto>\"}"));
        let min_out: u128 = m.get("min_near_out").and_then(|v| v.as_str()).and_then(|v| v.parse().ok()).unwrap_or(0);
        let q = curve::quote_sell(s.circulating.0, amount.0);
        require!(q.out >= min_out, "slippage: less NEAR than min_near_out");
        let s = self.startup_mut(&sym);
        s.circulating = U128(s.circulating.0 - amount.0);
        s.reserve = U128(s.reserve.0 - q.proceeds);
        s.available = U128(s.available.0 + q.fee);
        s.fees_in = U128(s.fees_in.0 + q.fee);
        s.volume = U128(s.volume.0 + q.proceeds);
        let circ = s.circulating;
        self.record_trade(&sym, &sender_id, "sell", q.out, amount.0, q.fee, circ, None, None);
        event("sell", json!({ "startup": sym, "seller": sender_id, "near": U128(q.out), "tokens": amount, "fee": U128(q.fee) }));
        Promise::new(sender_id).transfer(yocto(q.out)).detach();
        PromiseOrValue::Value(U128(0))
    }

    // ---------- agent wallets ----------

    /// Adds NEAR to a wallet (anyone may fund anyone). A new wallet belongs to `account` with default caps.
    #[payable]
    pub fn fund_wallet(&mut self, account: Option<AccountId>) {
        let who = account.unwrap_or_else(env::predecessor_account_id);
        let d = env::attached_deposit().as_yoctonear();
        require!(d > 0, "attach NEAR");
        self.wallet_credit(&who, d);
        event("wallet_funded", json!({ "account": who, "amount": U128(d) }));
    }

    pub fn set_wallet_caps(&mut self, account: AccountId, cap_tx: U128, cap_day: U128) {
        let me = env::predecessor_account_id();
        let w = self.wallets.get_mut(&account).unwrap_or_else(|| env::panic_str("no wallet"));
        require!(w.owner == me, "wallet owner only");
        w.cap_tx = cap_tx;
        w.cap_day = cap_day;
    }

    /// The wallet's owner takes NEAR out (to the owner's own account).
    pub fn withdraw(&mut self, account: AccountId, amount: U128) -> Promise {
        let me = env::predecessor_account_id();
        let w = self.wallets.get_mut(&account).unwrap_or_else(|| env::panic_str("no wallet"));
        require!(w.owner == me, "wallet owner only");
        require!(w.balance.0 >= amount.0, "not enough in the wallet");
        w.balance = U128(w.balance.0 - amount.0);
        Promise::new(me).transfer(yocto(amount.0))
    }

    /// Spending from a wallet: the per-transaction and 24-hour caps.
    fn wallet_spend(&mut self, who: &AccountId, amount: u128) {
        let now = now_ms();
        let w = self.wallets.get_mut(who).unwrap_or_else(|| env::panic_str("no wallet"));
        require!(amount <= w.cap_tx.0, "wallet: over the per-transaction cap");
        if now.saturating_sub(w.day_start_ms) >= 24 * HOUR_MS {
            w.day_start_ms = now;
            w.day_spent = U128(0);
        }
        require!(w.day_spent.0 + amount <= w.cap_day.0, "wallet: over the 24-hour cap");
        require!(w.balance.0 >= amount, "wallet: not enough NEAR");
        w.balance = U128(w.balance.0 - amount);
        w.day_spent = U128(w.day_spent.0 + amount);
        w.spent_total = U128(w.spent_total.0 + amount);
    }

    fn wallet_credit(&mut self, who: &AccountId, amount: u128) {
        let w = self.wallets.entry(who.clone()).or_insert_with(|| new_wallet(who));
        w.balance = U128(w.balance.0 + amount);
    }

    /// One agent pays another for a service (an audience brief, a review), within its caps.
    pub fn agent_pay(&mut self, to: AccountId, amount: U128, memo: String) {
        let me = env::predecessor_account_id();
        require!(me != to, "pay someone else");
        require!(memo.len() <= 80, "memo too long");
        self.wallet_spend(&me, amount.0);
        self.wallet_credit(&to, amount.0);
        event("agent_pay", json!({ "from": me, "to": to, "amount": amount, "memo": memo }));
    }

    // ---------- creators ----------

    /// A creator applies; the vetting fee for the scout goes into escrow from the creator's wallet.
    pub fn apply_creator(&mut self, name: String, profile: String) {
        let me = env::predecessor_account_id();
        require!(!self.creators.contains_key(&me), "already admitted");
        require!(!self.applications.contains_key(&me), "already applied");
        require!(!name.is_empty() && name.len() <= 40 && profile.len() <= 400, "name or profile too long");
        self.wallet_spend(&me, VET_FEE);
        let w = self.wallets.get_mut(&me).unwrap();
        w.locked = U128(w.locked.0 + VET_FEE);
        self.applications.insert(me.clone(), Application { name: name.clone(), profile, fee: U128(VET_FEE), applied_ms: now_ms() });
        event("creator_applied", json!({ "account": me, "name": name }));
    }

    /// The scout files its vetting report. Admission is decided by rule here, not by the report: the scout is
    /// registered, the creator applied (fee in escrow) and isn't a lookalike of an admitted creator.
    pub fn vet_creator(&mut self, account: AccountId, report_hash: String) -> bool {
        let scout = env::predecessor_account_id();
        require!(self.scouts.contains(&scout), "registered scouts only");
        require!(is_hex32(&report_hash), "report_hash: 32-byte hex");
        let app = self.applications.remove(&account).unwrap_or_else(|| env::panic_str("no application"));
        // the scout is paid for the work either way
        if let Some(w) = self.wallets.get_mut(&account) {
            w.locked = U128(w.locked.0.saturating_sub(app.fee.0));
        }
        self.wallet_credit(&scout, app.fee.0);
        let look: Vec<AccountId> = self.creator_ids.iter().filter(|c| is_lookalike(account.as_str(), c.as_str())).cloned().collect();
        if !look.is_empty() {
            let note = format!("lookalike of {}", look.iter().map(|a| a.as_str()).collect::<Vec<_>>().join(", "));
            self.log(None, None, "vet", Some(&account), app.fee.0, "rejected", vec!["lookalike".into()], note);
            return false;
        }
        let c = Creator {
            account: account.clone(),
            name: app.name.clone(),
            profile: app.profile,
            report_hash: report_hash.clone(),
            scout,
            admitted_ms: now_ms(),
            revoked: false,
            won: 0,
            completed: 0,
            missed: 0,
            results: 0,
            payouts: 0,
            paid: U128(0),
            paid_tusd: U128(0),
        };
        self.creators.insert(account.clone(), c);
        self.creator_ids.push(account.clone());
        let token_id = format!("creator:{account}");
        self.nft.internal_mint_with_refund(token_id, account.clone(), Some(TokenMetadata { title: Some(format!("Signalfire creator: {}", app.name)), ..Default::default() }), None);
        self.log(None, None, "vet", Some(&account), app.fee.0, "admitted", vec![], format!("report {report_hash}"));
        // register the creator with tUSD so payouts can land
        if let Some(t) = self.tusd.clone() {
            Promise::new(t)
                .function_call("storage_deposit", serde_json::to_vec(&json!({ "account_id": account, "registration_only": true })).unwrap(), yocto(FT_STORAGE), GAS_STORAGE)
                .detach();
        }
        true
    }

    pub fn revoke_creator(&mut self, account: AccountId) {
        let me = env::predecessor_account_id();
        require!(me == self.owner || self.scouts.contains(&me), "owner or scout only");
        let c = self.creators.get_mut(&account).unwrap_or_else(|| env::panic_str("not a creator"));
        c.revoked = true;
        self.log(None, None, "revoke", Some(&account), 0, "revoked", vec![], String::new());
    }

    // ---------- campaigns ----------

    /// The founder posts a brief. The budget must fit the cap and what the treasury has free right now.
    #[allow(clippy::too_many_arguments)]
    pub fn create_campaign(&mut self, startup: String, title: String, brief: String, target: u32, budget: U128, commit_secs: u32, reveal_secs: u32, duration_secs: u32) -> u32 {
        let me = env::predecessor_account_id();
        let s = self.startup(&startup);
        require!(s.founder == me, "founder only");
        require!(s.status == "live", "startup is not live");
        require!(!title.is_empty() && title.len() <= 80 && brief.len() <= 600, "title or brief too long");
        require!((1..=10_000).contains(&target), "target: 1 to 10000 buyers");
        require!(budget.0 > 0 && budget.0 <= s.constraints.campaign_cap.0, "budget over the campaign cap");
        require!(budget.0 <= s.available.0, "budget over the treasury's free balance");
        require!((30..=7 * 86400).contains(&commit_secs) && (30..=7 * 86400).contains(&reveal_secs), "windows: 30 s to 7 days");
        require!((60..=90 * 86400).contains(&duration_secs), "duration: 1 minute to 90 days");
        let now = now_ms();
        let id = self.campaigns.len();
        let c = Campaign {
            id,
            startup: startup.clone(),
            title,
            brief,
            target,
            budget,
            created_ms: now,
            commit_ends_ms: now + commit_secs as u64 * 1000,
            reveal_ends_ms: now + (commit_secs + reveal_secs) as u64 * 1000,
            duration_ms: duration_secs as u64 * 1000,
            phase: "bidding".into(),
            bids: vec![],
            winner: None,
            price: U128(0),
            proposal_id: None,
            funded_ms: None,
            deadline_ms: None,
            results: 0,
            attributed: vec![],
            milestones_paid: 0,
            paid: U128(0),
            paid_tusd: U128(0),
            receipt: None,
        };
        event("campaign_created", json!({ "id": id, "startup": startup, "title": c.title, "budget": budget, "target": target }));
        self.campaigns.push(c);
        self.startup_mut(&startup).campaigns.push(id);
        id
    }

    /// A sealed bid: sha256("signalfire|bid|<campaign>|<creator>|<price>|<pitch_hash>|<salt>"), with a bond.
    /// With `ciphertext` it is the same as `commit_sealed_bid` (scored by OutLayer, never revealed): agent accounts'
    /// function-call keys predate that method and can't be changed, but they can call this one.
    pub fn commit_bid(&mut self, campaign_id: u32, hash: String, ciphertext: Option<String>) {
        if let Some(ct) = ciphertext {
            return self.commit_sealed_bid(campaign_id, hash, ct);
        }
        let me = env::predecessor_account_id();
        let cr = self.creators.get(&me).unwrap_or_else(|| env::panic_str("admitted creators only"));
        require!(!cr.revoked, "creator revoked");
        require!(is_hex32(&hash), "hash: 32-byte hex");
        let c = self.campaigns.get(campaign_id).unwrap_or_else(|| env::panic_str("no such campaign"));
        require!(c.phase == "bidding" && now_ms() < c.commit_ends_ms, "bidding is closed");
        require!(c.bids.iter().all(|b| b.creator != me), "one bid per creator");
        require!(c.bids.len() < 20, "bid book full");
        require!(load_book(campaign_id).is_none(), "this brief takes sealed bids only (commit_sealed_bid)");
        self.wallet_spend(&me, BID_BOND);
        let w = self.wallets.get_mut(&me).unwrap();
        w.locked = U128(w.locked.0 + BID_BOND);
        let c = self.campaign_mut(campaign_id);
        c.bids.push(Bid { creator: me.clone(), hash: hash.clone(), committed_ms: now_ms(), revealed: false, price: None, pitch_hash: None, credible: false, rep: 0, bond_settled: false });
        event("bid_committed", json!({ "campaign": campaign_id, "creator": me, "hash": hash }));
    }

    /// Opens a sealed bid. The bond returns to the wallet.
    pub fn reveal_bid(&mut self, campaign_id: u32, price: U128, pitch_hash: String, salt: String) {
        let me = env::predecessor_account_id();
        require!(is_hex32(&pitch_hash) && salt.len() <= 128, "bad opening");
        let (completed, missed) = self.creators.get(&me).map(|c| (c.completed, c.missed)).unwrap_or((0, 0));
        let c = self.campaigns.get(campaign_id).unwrap_or_else(|| env::panic_str("no such campaign"));
        let now = now_ms();
        require!(c.phase == "bidding" && now >= c.commit_ends_ms && now < c.reveal_ends_ms, "not the reveal window");
        require!(load_book(campaign_id).is_none(), "sealed bids are never revealed: OutLayer scores them");
        let budget = c.budget.0;
        let min_bps = self.startup(&c.startup).constraints.min_bid_bps;
        let expected = bid_hash(campaign_id, me.as_str(), price.0, &pitch_hash, &salt);
        let c = self.campaign_mut(campaign_id);
        let b = c.bids.iter_mut().find(|b| b.creator == me).unwrap_or_else(|| env::panic_str("no bid from you"));
        require!(!b.revealed, "already revealed");
        require!(b.hash == expected, "opening does not match the commitment");
        b.revealed = true;
        b.price = Some(price);
        b.pitch_hash = Some(pitch_hash);
        b.credible = credible(price.0, budget, min_bps);
        b.rep = rep_bps(completed, missed);
        b.bond_settled = true;
        let cred = b.credible;
        let w = self.wallets.get_mut(&me).unwrap();
        w.locked = U128(w.locked.0 - BID_BOND);
        w.balance = U128(w.balance.0 + BID_BOND);
        event("bid_revealed", json!({ "campaign": campaign_id, "creator": me, "price": price, "credible": cred }));
    }

    /// After the reveal window, anyone settles: unrevealed bonds go to the treasury; the winner is the lowest
    /// reputation-weighted credible price; the hub files the funding proposal on the startup's DAO.
    pub fn settle_auction(&mut self, campaign_id: u32) -> PromiseOrValue<Option<u64>> {
        let c = self.campaigns.get(campaign_id).unwrap_or_else(|| env::panic_str("no such campaign")).clone();
        require!(c.phase == "bidding" || c.phase == "propose_failed", "already settled");
        require!(c.phase == "propose_failed" || load_book(campaign_id).is_none(), "this brief's sealed bids are scored by OutLayer: score_sealed");
        require!(now_ms() >= c.reveal_ends_ms, "the reveal window is still open");
        let startup = c.startup.clone();
        // unrevealed bonds go to the treasury
        let late: Vec<AccountId> = c.bids.iter().filter(|b| !b.bond_settled).map(|b| b.creator.clone()).collect();
        for a in &late {
            if let Some(w) = self.wallets.get_mut(a) {
                w.locked = U128(w.locked.0.saturating_sub(BID_BOND));
            }
            self.log(Some(&startup), Some(campaign_id), "bond_forfeit", Some(a), BID_BOND, "to_treasury", vec![], "bid never revealed".into());
        }
        if !late.is_empty() {
            let forfeited = BID_BOND * late.len() as u128;
            let s = self.startup_mut(&startup);
            s.available = U128(s.available.0 + forfeited);
            s.forfeits_in = U128(s.forfeits_in.0 + forfeited);
        }
        // the winner: bids are stored in commit order, so a strict "<" keeps the earlier of two equal scores
        let mut best: Option<usize> = None;
        for (i, b) in c.bids.iter().enumerate() {
            if !(b.revealed && b.credible) {
                continue;
            }
            let better = match best {
                None => true,
                Some(j) => score(b.price.unwrap().0, b.rep) < score(c.bids[j].price.unwrap().0, c.bids[j].rep),
            };
            if better {
                best = Some(i);
            }
        }
        self.award(campaign_id, best)
    }

    /// The auction's outcome: every bond is settled; the winner (by index in the bid book) gets the funding
    /// proposal filed in the startup's DAO, or the brief ends with no credible bid.
    fn award(&mut self, campaign_id: u32, best: Option<usize>) -> PromiseOrValue<Option<u64>> {
        let startup = self.campaigns.get(campaign_id).unwrap().startup.clone();
        let cm = self.campaign_mut(campaign_id);
        for b in cm.bids.iter_mut() {
            b.bond_settled = true;
        }
        let Some(i) = best else {
            cm.phase = "no_bids".into();
            event("auction_settled", json!({ "campaign": campaign_id, "winner": null }));
            return PromiseOrValue::Value(None);
        };
        let winner = cm.bids[i].creator.clone();
        let price = cm.bids[i].price.unwrap();
        cm.winner = Some(winner.clone());
        cm.price = price;
        cm.phase = "proposing".into();
        let title = cm.title.clone();
        let dao = self.startup(&startup).dao.clone();
        event("auction_settled", json!({ "campaign": campaign_id, "winner": winner, "price": price }));
        PromiseOrValue::Promise(
            Promise::new(dao)
                .function_call("add_proposal", serde_json::to_vec(&self.fund_proposal(campaign_id, &title, &winner, price.0)).unwrap(), yocto(0), GAS_ADD_PROPOSAL)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_SMALL).on_proposed(campaign_id)),
        )
    }

    fn fund_proposal(&self, campaign_id: u32, title: &str, winner: &AccountId, price: u128) -> Value {
        let fund_args = serde_json::to_vec(&json!({ "campaign_id": campaign_id })).unwrap();
        let description = format!(
            "Fund Signalfire campaign #{campaign_id} \"{title}\": {winner} won the sealed-bid auction at {price} yoctoNEAR, paid in tUSD over 3 milestones as attributed buyers arrive."
        );
        json!({ "proposal": { "description": description, "kind": { "FunctionCall": {
            "receiver_id": env::current_account_id(),
            "actions": [{ "method_name": "fund_campaign", "args": Base64VecU8(fund_args), "deposit": "0", "gas": GAS_FUND_CALL.to_string() }] } } } })
    }

    #[private]
    pub fn on_proposed(&mut self, campaign_id: u32, #[callback_result] id: Result<u64, PromiseError>) -> Option<u64> {
        let c = self.campaign_mut(campaign_id);
        match id {
            Ok(id) => {
                c.proposal_id = Some(id);
                c.phase = "voting".into();
                event("campaign_proposed", json!({ "campaign": campaign_id, "proposal_id": id }));
                Some(id)
            }
            Err(_) => {
                c.phase = "propose_failed".into();
                None
            }
        }
    }

    /// Called by the startup's DAO when holders approve the funding proposal: the price is reserved.
    pub fn fund_campaign(&mut self, campaign_id: u32) {
        let c = self.campaigns.get(campaign_id).unwrap_or_else(|| env::panic_str("no such campaign")).clone();
        let s = self.startup(&c.startup);
        require!(env::predecessor_account_id() == s.dao, "only the startup's DAO can fund a campaign");
        require!(c.phase == "voting", "not awaiting a vote");
        require!(s.available.0 >= c.price.0, "the treasury can't cover the price");
        let startup = c.startup.clone();
        let s = self.startup_mut(&startup);
        s.available = U128(s.available.0 - c.price.0);
        s.committed = U128(s.committed.0 + c.price.0);
        let now = now_ms();
        let cm = self.campaign_mut(campaign_id);
        cm.phase = "funded".into();
        cm.funded_ms = Some(now);
        cm.deadline_ms = Some(now + cm.duration_ms);
        let winner = cm.winner.clone().unwrap();
        if let Some(cr) = self.creators.get_mut(&winner) {
            cr.won += 1;
        }
        self.log(Some(&startup), Some(campaign_id), "fund", Some(&winner), c.price.0, "committed", vec![], format!("DAO proposal {}", c.proposal_id.unwrap_or(0)));
    }

    /// Anyone cranks the next milestone. The spend policy decides; held attempts are logged and nothing moves.
    pub fn claim_milestone(&mut self, campaign_id: u32) -> PromiseOrValue<String> {
        let c = self.campaigns.get(campaign_id).unwrap_or_else(|| env::panic_str("no such campaign")).clone();
        require!(c.phase == "funded", "campaign is not funded");
        let k = c.milestones_paid + 1;
        require!(unlocked(c.target, c.results) >= k, "milestone not reached yet");
        let winner = c.winner.clone().unwrap();
        let cr = self.creators.get(&winner).unwrap_or_else(|| env::panic_str("payee is not a creator")).clone();
        let now = now_ms();
        let amount = milestone_amount(c.price.0, k);
        if cr.revoked {
            self.log(Some(&c.startup), Some(campaign_id), "payout", Some(&winner), amount, "held:payee_revoked", vec![], format!("milestone {k}"));
            return PromiseOrValue::Value("held:payee_revoked".into());
        }
        let s = self.startup(&c.startup);
        let (outcome, flags) = evaluate_payout(&PayoutCheck {
            amount,
            price: c.price.0,
            paid_so_far: c.paid.0,
            max_payout: s.constraints.max_payout.0,
            payouts_per_hour: s.constraints.payouts_per_hour,
            recent: &s.recent_payouts,
            last_payout_ms: s.last_payout_ms,
            now_ms: now,
            prior_payouts_to_payee: cr.payouts,
        });
        let tusd = tusd_for(amount);
        let n = self.log(Some(&c.startup), Some(campaign_id), "payout", Some(&winner), amount, &outcome, flags, format!("milestone {k}: {} tUSD", tusd_str(tusd)));
        if outcome != "paid" {
            return PromiseOrValue::Value(outcome);
        }
        let token = self.tusd.clone().unwrap_or_else(|| env::panic_str("tUSD not set up"));
        // book it now; on_paid undoes it if the transfer fails
        let st = self.startup_mut(&c.startup);
        st.committed = U128(st.committed.0 - amount);
        st.paid = U128(st.paid.0 + amount);
        st.recent_payouts.retain(|t| now.saturating_sub(*t) < HOUR_MS);
        st.recent_payouts.push(now);
        st.last_payout_ms = Some(now);
        let cm = self.campaign_mut(campaign_id);
        cm.milestones_paid = k;
        cm.paid = U128(cm.paid.0 + amount);
        cm.paid_tusd = U128(cm.paid_tusd.0 + tusd);
        if k == MILESTONES {
            cm.phase = "done".into();
        }
        self.desk_reserve += amount;
        self.tusd_paid += tusd;
        let cr = self.creators.get_mut(&winner).unwrap();
        cr.payouts += 1;
        cr.paid = U128(cr.paid.0 + amount);
        cr.paid_tusd = U128(cr.paid_tusd.0 + tusd);
        // The keyless agent pays when it is set up and holds enough: the payout becomes an approved action that only
        // this contract can have signed (agent_sign), and that this contract checks again on delivery.
        if let Some(mut desk) = load_desk().filter(|d| d.enabled && d.tusd_free.0 >= tusd) {
            desk.tusd_free = U128(desk.tusd_free.0 - tusd);
            let id = desk.actions;
            desk.actions += 1;
            save_desk(&desk);
            save_action(&AgentAction {
                id, kind: "payout".into(), campaign: campaign_id, milestone: k, receiver: winner.clone(), tusd: U128(tusd), amount: U128(amount), audit_n: n,
                status: "approved".into(), created_ms: now, signed_ms: None, done_ms: None, signs: 0, nonce: None, tx_hash: None, signed_tx: None,
            });
            if let Some(e) = self.audit.get_mut(n as u32) {
                e.flags.push("keyless_agent".into());
                e.note = format!("{} · keyless agent action {id}", e.note);
            }
            event("agent_action", json!({ "id": id, "campaign": campaign_id, "milestone": k, "receiver": winner, "tusd": U128(tusd) }));
            return PromiseOrValue::Value(format!("paid:keyless_agent:{id}"));
        }
        PromiseOrValue::Promise(
            Promise::new(token)
                .function_call(
                    "ft_transfer",
                    serde_json::to_vec(&json!({ "receiver_id": winner, "amount": U128(tusd), "memo": format!("Signalfire campaign #{campaign_id} milestone {k}") })).unwrap(),
                    yocto(1),
                    GAS_FT_TRANSFER,
                )
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_HOLDER).on_paid(campaign_id, k, U128(amount), U128(tusd), n)),
        )
    }

    #[private]
    pub fn on_paid(&mut self, campaign_id: u32, k: u8, amount: U128, tusd: U128, audit_n: u64) -> String {
        let ok = all_ok();
        let c = self.campaigns.get(campaign_id).unwrap().clone();
        let winner = c.winner.clone().unwrap();
        if !ok {
            self.undo_payout(campaign_id, k, amount.0, tusd.0, audit_n);
            return "failed:transfer".into();
        }
        event("milestone_paid", json!({ "campaign": campaign_id, "milestone": k, "creator": winner, "amount": amount, "tusd": tusd }));
        if k == MILESTONES {
            self.complete(campaign_id);
        }
        "paid".into()
    }

    /// The last milestone landed: the creator's record grows and the receipt NFT is minted to them.
    fn complete(&mut self, campaign_id: u32) {
        let c = self.campaigns.get(campaign_id).unwrap().clone();
        let winner = c.winner.clone().unwrap();
        let s = self.startup(&c.startup).clone();
        let cr = self.creators.get_mut(&winner).unwrap();
        cr.completed += 1;
        cr.results += c.results;
        let token_id = format!("receipt:{campaign_id}");
        let cpr = if c.results > 0 { c.price.0 / c.results as u128 } else { 0 };
        let extra = json!({
            "startup": s.id, "startup_name": s.name, "token": s.token, "dao": s.dao, "campaign": campaign_id, "title": c.title,
            "creator": winner, "spend_yocto": c.price, "spend_tusd": c.paid_tusd, "results": c.results, "target": c.target,
            "cost_per_result_yocto": U128(cpr), "proposal_id": c.proposal_id, "funded_ms": c.funded_ms, "completed_ms": now_ms()
        });
        self.nft.internal_mint_with_refund(
            token_id.clone(),
            winner.clone(),
            Some(TokenMetadata {
                title: Some(format!("{} campaign #{campaign_id}: {}", s.id.to_uppercase(), c.title)),
                description: Some(format!("Receipt: {} new buyers for {} tUSD of marketing paid from the {} treasury.", c.results, tusd_str(c.paid_tusd.0), s.id.to_uppercase())),
                extra: Some(extra.to_string()),
                ..Default::default()
            }),
            None,
        );
        self.campaign_mut(campaign_id).receipt = Some(token_id.clone());
        event("receipt_minted", json!({ "campaign": campaign_id, "token_id": token_id, "owner": winner }));
    }

    /// A payout whose tUSD didn't reach the creator: the books go back to before the claim.
    fn undo_payout(&mut self, campaign_id: u32, k: u8, amount: u128, tusd: u128, audit_n: u64) {
        let c = self.campaigns.get(campaign_id).unwrap().clone();
        let winner = c.winner.clone().unwrap();
        let st = self.startup_mut(&c.startup);
        st.committed = U128(st.committed.0 + amount);
        st.paid = U128(st.paid.0 - amount);
        st.recent_payouts.pop();
        let cm = self.campaign_mut(campaign_id);
        cm.milestones_paid = k - 1;
        cm.paid = U128(cm.paid.0 - amount);
        cm.paid_tusd = U128(cm.paid_tusd.0 - tusd);
        cm.phase = "funded".into();
        self.desk_reserve -= amount;
        self.tusd_paid -= tusd;
        let cr = self.creators.get_mut(&winner).unwrap();
        cr.payouts -= 1;
        cr.paid = U128(cr.paid.0 - amount);
        cr.paid_tusd = U128(cr.paid_tusd.0 - tusd);
        if let Some(e) = self.audit.get_mut(audit_n as u32) {
            e.outcome = "failed:transfer".into();
        }
    }

    /// After the deadline, an unfinished campaign returns its unpaid part to the treasury and counts as a miss.
    pub fn expire_campaign(&mut self, campaign_id: u32) {
        let c = self.campaigns.get(campaign_id).unwrap_or_else(|| env::panic_str("no such campaign")).clone();
        require!(c.phase == "funded", "campaign is not running");
        require!(c.deadline_ms.is_some_and(|d| now_ms() > d), "deadline not passed");
        let unpaid = c.price.0 - c.paid.0;
        let st = self.startup_mut(&c.startup);
        st.committed = U128(st.committed.0 - unpaid);
        st.available = U128(st.available.0 + unpaid);
        self.campaign_mut(campaign_id).phase = "expired".into();
        let winner = c.winner.clone().unwrap();
        if let Some(cr) = self.creators.get_mut(&winner) {
            cr.missed += 1;
            cr.results += c.results;
        }
        self.log(Some(&c.startup), Some(campaign_id), "expire", Some(&winner), unpaid, "returned", vec![], format!("{} of {} results", c.results, c.target));
    }

    // ---------- holders' council in the DAO ----------

    /// Anyone holding at least the startup's minimum joins its DAO's `holders` role.
    pub fn join_holders(&mut self, startup: String) -> Promise {
        self.check_holder(startup, env::predecessor_account_id(), true)
    }

    /// Anyone may prune a holder whose balance fell below the minimum.
    pub fn prune_holder(&mut self, startup: String, account: AccountId) -> Promise {
        self.check_holder(startup, account, false)
    }

    fn check_holder(&self, startup: String, account: AccountId, join: bool) -> Promise {
        let s = self.startup(&startup);
        require!(s.status == "live", "startup is not live");
        Promise::new(s.token.clone())
            .function_call("ft_balance_of", serde_json::to_vec(&json!({ "account_id": account })).unwrap(), yocto(0), GAS_BALANCE)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_HOLDER).on_holder_balance(startup, account, join))
    }

    #[private]
    pub fn on_holder_balance(&mut self, startup: String, account: AccountId, join: bool, #[callback_result] bal: Result<U128, PromiseError>) -> Promise {
        let bal = bal.unwrap_or_else(|_| env::panic_str("could not read the balance")).0;
        let s = self.startup(&startup);
        let min = s.constraints.min_holder_tokens.0;
        if join {
            require!(bal >= min, "below the holder minimum");
        } else {
            require!(bal < min, "still above the holder minimum");
        }
        let what = if join { "joins" } else { "is pruned from" };
        let args = json!({ "proposal": { "description": format!("{account} {what} the {} holders ({bal} raw units held, minimum {min})", startup.to_uppercase()), "kind": member_kind(join, &account) } });
        Promise::new(s.dao.clone())
            .function_call("add_proposal", serde_json::to_vec(&args).unwrap(), yocto(0), GAS_ADD_PROPOSAL)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_MEMBER).on_member_proposed(startup, account, join))
    }

    #[private]
    pub fn on_member_proposed(&mut self, startup: String, account: AccountId, join: bool, #[callback_result] id: Result<u64, PromiseError>) -> Promise {
        let id = id.unwrap_or_else(|_| env::panic_str("the DAO refused the proposal"));
        let dao = self.startup(&startup).dao.clone();
        event("holder_change", json!({ "startup": startup, "account": account, "join": join, "proposal_id": id }));
        Promise::new(dao).function_call(
            "act_proposal",
            serde_json::to_vec(&json!({ "id": id, "action": "VoteApprove", "proposal": member_kind(join, &account) })).unwrap(),
            yocto(0),
            GAS_ACT,
        )
    }

    // ---------- the keyless treasury agent (Chain Signatures) ----------

    /// Sets up the keyless agent (owner, once): asks the MPC signer for the Ed25519 key it derives for this contract
    /// and AGENT_PATH, then opens that key's implicit account with the attached NEAR (its gas), registers it with
    /// tUSD and moves `tusd` of the payout desk to it. Nobody supplies the key: it comes from the MPC contract.
    #[payable]
    pub fn agent_setup(&mut self, tusd: U128) -> Promise {
        self.only_owner();
        require!(load_desk().is_none(), "the agent exists");
        require!(self.tusd.is_some(), "tUSD not set up");
        let near = env::attached_deposit().as_yoctonear();
        require!(near >= YOCTO / 10, "attach at least 0.1 NEAR for the agent's gas and tUSD storage");
        Promise::new(mpc_signer())
            .function_call(
                "derived_public_key",
                serde_json::to_vec(&json!({ "path": AGENT_PATH, "predecessor": env::current_account_id(), "domain_id": ED25519_DOMAIN })).unwrap(),
                yocto(0),
                GAS_MPC_VIEW,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_AGENT_KEY).on_agent_key(tusd, U128(near)))
    }

    #[private]
    pub fn on_agent_key(&mut self, tusd: U128, near: U128, #[callback_result] key: Result<String, PromiseError>) -> PromiseOrValue<bool> {
        let refund = || Promise::new(self.owner.clone()).transfer(yocto(near.0)).detach();
        let Some(pk) = key.ok().as_deref().and_then(ed25519_bytes) else {
            refund();
            return PromiseOrValue::Value(false);
        };
        let account = implicit_account(&pk);
        let desk = AgentDesk {
            account: account.clone(), public_key: format!("ed25519:{}", bs58::encode(pk).into_string()), signer: mpc_signer(), path: AGENT_PATH.into(),
            domain_id: ED25519_DOMAIN, enabled: true, tusd_free: tusd, last_nonce: 0, actions: 0, created_ms: now_ms(),
        };
        save_desk(&desk);
        self.log(None, None, "agent_setup", Some(&account), near.0, "set", vec!["keyless_agent".into()], format!("key {} from {} path {AGENT_PATH}; {} tUSD of the desk moved to it", desk.public_key, desk.signer, tusd_str(tusd.0)));
        event("agent_setup", json!(desk));
        let token = self.tusd.clone().unwrap();
        let storage = 1_250_000_000_000_000_000_000u128;
        Promise::new(account.clone()).transfer(yocto(near.0 - storage)).detach();
        PromiseOrValue::Promise(
            Promise::new(token.clone())
                .function_call("storage_deposit", serde_json::to_vec(&json!({ "account_id": account, "registration_only": true })).unwrap(), yocto(storage), GAS_STORAGE)
                .then(Promise::new(token).function_call(
                    "ft_transfer",
                    serde_json::to_vec(&json!({ "receiver_id": account, "amount": tusd, "memo": "Signalfire payout desk: tUSD for the keyless agent" })).unwrap(),
                    yocto(1),
                    GAS_FT_TRANSFER,
                ))
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_SMALL).on_agent_funded()),
        )
    }

    #[private]
    pub fn on_agent_funded(&mut self) -> bool {
        let ok = all_ok();
        if !ok {
            // the tUSD didn't move: the agent stays off until the owner sorts it out
            if let Some(mut d) = load_desk() {
                d.enabled = false;
                d.tusd_free = U128(0);
                save_desk(&d);
            }
        }
        ok
    }

    /// The owner turns the agent's payouts on or off (off: the hub pays from its own desk, as before).
    pub fn agent_set_enabled(&mut self, enabled: bool) {
        self.only_owner();
        let mut d = load_desk().unwrap_or_else(|| env::panic_str("no agent"));
        d.enabled = enabled;
        save_desk(&d);
        self.log(None, None, "agent_enabled", Some(&d.account), 0, if enabled { "on" } else { "off" }, vec!["keyless_agent".into()], String::new());
    }

    /// Anyone cranks: build the agent's transaction for approved action `id` (content fixed here: tUSD
    /// `ft_transfer_call` of exactly the approved amount to this hub) with a recent `block_hash` and a fresh `nonce`
    /// for the agent's key, and ask the MPC network to sign it. Attach the MPC fee (1 yoctoNEAR on testnet).
    #[payable]
    pub fn agent_sign(&mut self, id: u32, nonce: u64, block_hash: String) -> Promise {
        let fee = env::attached_deposit();
        require!(fee.as_yoctonear() >= 1, "attach the MPC signer's fee (at least 1 yoctoNEAR)");
        let mut desk = load_desk().unwrap_or_else(|| env::panic_str("no agent"));
        let mut a = load_action(id).unwrap_or_else(|| env::panic_str("no such action"));
        let now = now_ms();
        let ready = a.status == "approved" || (a.status == "signed" && a.signed_ms.is_some_and(|t| now.saturating_sub(t) >= RESIGN_AFTER_MS))
            || (a.status == "signing" && a.signed_ms.is_some_and(|t| now.saturating_sub(t) >= RESIGN_AFTER_MS));
        require!(ready, "this action is not waiting for a signature");
        require!(nonce > desk.last_nonce, "nonce must be above the last one signed");
        // NEAR refuses a nonce above block_height * 10^6; so do we, or a crank could push last_nonce out of reach
        require!(nonce <= env::block_height().saturating_mul(1_000_000), "nonce above what NEAR accepts at this height");
        let bh = block_hash_bytes(&block_hash).unwrap_or_else(|| env::panic_str("block_hash: base58 of 32 bytes"));
        let pk = ed25519_bytes(&desk.public_key).unwrap();
        let tx = payout_tx(&desk, &pk, nonce, &bh, self.tusd.as_ref().unwrap(), &env::current_account_id(), &a);
        let hash = env::sha256_array(&tx);
        desk.last_nonce = nonce;
        save_desk(&desk);
        a.status = "signing".into();
        a.signed_ms = Some(now);
        a.signs += 1;
        a.nonce = Some(nonce);
        save_action(&a);
        let request = MpcSignRequestEd { path: desk.path.clone(), payload_v2: MpcPayloadEd { eddsa: hex::encode(hash) }, domain_id: ED25519_DOMAIN };
        Promise::new(desk.signer.clone())
            .function_call("sign", serde_json::to_vec(&json!({ "request": request })).unwrap(), fee, GAS_MPC_SIGN)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_AGENT_SIGNED).on_agent_signed(id, Base64VecU8::from(tx)))
    }

    /// The MPC network answered. Keep the signed transaction if the signature checks against the agent's key.
    #[private]
    pub fn on_agent_signed(&mut self, id: u32, tx: Base64VecU8, #[callback_result] sig: Result<MpcEd25519Signature, PromiseError>) -> bool {
        let Some(mut a) = load_action(id) else { return false };
        let desk = load_desk().unwrap();
        let pk = ed25519_bytes(&desk.public_key).unwrap();
        let hash = env::sha256_array(&tx.0);
        let good = sig.ok().filter(|s| s.scheme == "Ed25519").and_then(|s| <[u8; 64]>::try_from(s.signature).ok()).filter(|s| env::ed25519_verify(s, &hash, &pk));
        if a.status != "signing" {
            return false; // delivered or paid by the hub meanwhile
        }
        match good {
            Some(s) => {
                a.status = "signed".into();
                a.tx_hash = Some(hex::encode(hash));
                a.signed_tx = Some(Base64VecU8::from(signed_tx(&tx.0, &s)));
                save_action(&a);
                event("agent_signed", json!({ "id": id, "tx_hash": a.tx_hash, "nonce": a.nonce }));
                true
            }
            None => {
                a.status = if a.signs > 1 { "signed".into() } else { "approved".into() };
                save_action(&a);
                false
            }
        }
    }

    /// tUSD from the agent: a delivery for an approved action is forwarded to the creator; anything else (another
    /// signature of the same action, a wrong amount, an action already paid) goes back to the agent.
    fn agent_delivery(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let desk = load_desk();
        let action = parse_payout_msg(&msg).and_then(load_action);
        let fits = |a: &AgentAction| ["approved", "signing", "signed"].contains(&a.status.as_str()) && a.tusd == amount;
        match (desk, action) {
            (Some(d), Some(mut a)) if d.account == sender_id && fits(&a) => {
                a.status = "delivering".into();
                save_action(&a);
                let token = self.tusd.clone().unwrap();
                PromiseOrValue::Promise(
                    Promise::new(token)
                        .function_call(
                            "ft_transfer",
                            serde_json::to_vec(&json!({ "receiver_id": a.receiver, "amount": a.tusd, "memo": format!("Signalfire campaign #{} milestone {} (keyless agent)", a.campaign, a.milestone) })).unwrap(),
                            yocto(1),
                            GAS_FT_TRANSFER,
                        )
                        .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_FORWARDED).on_agent_forwarded(a.id)),
                )
            }
            _ => {
                event("agent_refund", json!({ "from": sender_id, "amount": amount, "msg": msg }));
                PromiseOrValue::Value(amount)
            }
        }
    }

    /// The forward to the creator landed (the payout is done) or didn't (the books go back; the tUSD returns to the agent).
    #[private]
    pub fn on_agent_forwarded(&mut self, id: u32) -> U128 {
        let ok = all_ok();
        let mut a = load_action(id).unwrap();
        if ok {
            a.status = "paid".into();
            a.done_ms = Some(now_ms());
            save_action(&a);
            event("milestone_paid", json!({ "campaign": a.campaign, "milestone": a.milestone, "creator": a.receiver, "amount": a.amount, "tusd": a.tusd, "keyless_agent_action": id }));
            if a.milestone == MILESTONES {
                self.complete(a.campaign);
            }
            return U128(0);
        }
        a.status = "failed:transfer".into();
        a.done_ms = Some(now_ms());
        save_action(&a);
        let mut d = load_desk().unwrap();
        d.tusd_free = U128(d.tusd_free.0 + a.tusd.0);
        save_desk(&d);
        self.undo_payout(a.campaign, a.milestone, a.amount.0, a.tusd.0, a.audit_n);
        a.tusd
    }

    /// Anyone, once an approved payout has waited AGENT_TIMEOUT_MS: the hub pays it from its own desk instead.
    /// The agent's tUSD for it is freed, and a late delivery by the agent is refunded (the action is no longer open).
    pub fn agent_fallback(&mut self, id: u32) -> Promise {
        let mut a = load_action(id).unwrap_or_else(|| env::panic_str("no such action"));
        require!(["approved", "signing", "signed"].contains(&a.status.as_str()), "this action is not open");
        require!(now_ms().saturating_sub(a.created_ms) >= AGENT_TIMEOUT_MS, "the agent still has time");
        a.status = "fallback".into();
        a.done_ms = Some(now_ms());
        save_action(&a);
        let mut d = load_desk().unwrap();
        d.tusd_free = U128(d.tusd_free.0 + a.tusd.0);
        save_desk(&d);
        Promise::new(self.tusd.clone().unwrap())
            .function_call(
                "ft_transfer",
                serde_json::to_vec(&json!({ "receiver_id": a.receiver, "amount": a.tusd, "memo": format!("Signalfire campaign #{} milestone {}", a.campaign, a.milestone) })).unwrap(),
                yocto(1),
                GAS_FT_TRANSFER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_HOLDER).on_paid(a.campaign, a.milestone, a.amount, a.tusd, a.audit_n))
    }

    pub fn get_agent(&self) -> Option<AgentDesk> {
        load_desk()
    }

    /// The agent's actions, newest first (the signed transaction left out; get_agent_action has it).
    pub fn get_agent_actions(&self, from: Option<u32>, limit: Option<u32>) -> Vec<AgentAction> {
        let Some(d) = load_desk() else { return vec![] };
        let end = from.map(|f| f.min(d.actions)).unwrap_or(d.actions);
        let n = limit.unwrap_or(50).min(100);
        (end.saturating_sub(n)..end).rev().filter_map(load_action).map(|a| AgentAction { signed_tx: None, ..a }).collect()
    }

    pub fn get_agent_action(&self, id: u32) -> Option<AgentAction> {
        load_action(id)
    }

    // ---------- sealed bids scored privately by OutLayer ----------

    /// The scoring program (owner): its wasm URL and sha256. A new program needs a new bid key (scorer_publish_key).
    pub fn scorer_set(&mut self, wasm_url: String, wasm_hash: String) {
        self.only_owner();
        require!(wasm_url.starts_with("https://") && wasm_url.len() <= 300, "wasm_url: https, at most 300 characters");
        require!(wasm_hash.len() == 64 && is_hex(&wasm_hash), "wasm_hash: sha256 hex");
        save_scorer(&Scorer {
            outlayer: outlayer(), wasm_url, wasm_hash: wasm_hash.clone(), build_target: "wasm32-wasip2".into(), bid_key: None, key_ms: None,
            key_input: None, key_output: None, set_ms: now_ms(),
        });
        self.log(None, None, "scorer_set", None, 0, "set", vec!["outlayer".into()], format!("wasm sha256 {wasm_hash}"));
    }

    fn outlayer_run(&self, sc: &Scorer, input: &str, gas: Gas) -> Promise {
        let args = json!({
            "source": { "WasmUrl": { "url": sc.wasm_url, "hash": sc.wasm_hash, "build_target": sc.build_target } },
            "resource_limits": { "max_instructions": 2_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 60 },
            "input_data": input,
            "response_format": "Json",
            "payer_account_id": env::predecessor_account_id(),
        });
        Promise::new(sc.outlayer.clone()).function_call_weight("request_execution", serde_json::to_vec(&args).unwrap(), env::attached_deposit(), gas, near_sdk::GasWeight(1))
    }

    /// Anyone (attach at least 0.01 NEAR; OutLayer refunds what it doesn't use): have the scorer publish the key bids
    /// are encrypted to. The key comes out of the TEE; nobody supplies it.
    #[payable]
    pub fn scorer_publish_key(&mut self) -> Promise {
        let sc = load_scorer().unwrap_or_else(|| env::panic_str("no scorer set"));
        require!(sc.bid_key.is_none(), "the key is published");
        require!(env::attached_deposit().as_yoctonear() >= MIN_RUN_DEPOSIT, "attach at least 0.01 NEAR for OutLayer");
        let input = json!({ "op": "public_key" }).to_string();
        self.outlayer_run(&sc, &input, GAS_OUTLAYER)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_SMALL).on_scorer_key(input))
    }

    #[private]
    pub fn on_scorer_key(&mut self, input: String, #[callback_result] out: Result<Option<Value>, PromiseError>) -> Option<String> {
        let mut sc = load_scorer()?;
        let v = out.ok().flatten()?;
        let key = v.get("public_key").and_then(|k| k.as_str()).filter(|k| k.len() == 64 && is_hex(k))?.to_string();
        if v.get("op").and_then(|o| o.as_str()) != Some("public_key") {
            return None;
        }
        sc.bid_key = Some(key.clone());
        sc.key_ms = Some(now_ms());
        sc.key_input = Some(input);
        sc.key_output = Some(v.to_string());
        save_scorer(&sc);
        self.log(None, None, "scorer_key", None, 0, "set", vec!["outlayer".into()], format!("bid key {key} from the TEE run of wasm {}", sc.wasm_hash));
        event("scorer_key", json!({ "bid_key": key, "wasm_hash": sc.wasm_hash }));
        Some(key)
    }

    /// An admitted creator's sealed bid: the usual commitment `hash` and bond, plus the opening encrypted to the
    /// scorer's key. It is never revealed: OutLayer scores the brief when bidding closes.
    pub fn commit_sealed_bid(&mut self, campaign_id: u32, hash: String, ciphertext: String) {
        let me = env::predecessor_account_id();
        let cr = self.creators.get(&me).unwrap_or_else(|| env::panic_str("admitted creators only"));
        require!(!cr.revoked, "creator revoked");
        require!(is_hex32(&hash), "hash: 32-byte hex");
        require!(is_hex(&ciphertext) && ciphertext.len() >= 2 * (32 + 24 + 16) && ciphertext.len() <= MAX_CIPHERTEXT_HEX, "ciphertext: hex, sealed to the scorer's key");
        let sc = load_scorer().unwrap_or_else(|| env::panic_str("no scorer set"));
        let key = sc.bid_key.clone().unwrap_or_else(|| env::panic_str("the scorer's key is not published yet"));
        let c = self.campaigns.get(campaign_id).unwrap_or_else(|| env::panic_str("no such campaign"));
        require!(c.phase == "bidding" && now_ms() < c.commit_ends_ms, "bidding is closed");
        require!(c.bids.iter().all(|b| b.creator != me), "one bid per creator");
        require!(c.bids.len() < 20, "bid book full");
        let mut book = match load_book(campaign_id) {
            Some(b) => b,
            None => {
                require!(c.bids.is_empty(), "this brief takes commit-reveal bids");
                SealedBook {
                    campaign: campaign_id, entries: vec![], status: "open".into(), attempts: 0, requested_ms: None, scored_ms: None,
                    wasm_hash: sc.wasm_hash.clone(), bid_key: key.clone(), input: None, input_hash: None, output: None, output_hash: None, valid: vec![],
                }
            }
        };
        require!(book.bid_key == key, "the scorer's key changed: seal to the key this brief started with");
        self.wallet_spend(&me, BID_BOND);
        let w = self.wallets.get_mut(&me).unwrap();
        w.locked = U128(w.locked.0 + BID_BOND);
        book.entries.push(SealedEntry { creator: me.clone(), ciphertext });
        save_book(&book);
        let c = self.campaign_mut(campaign_id);
        c.bids.push(Bid { creator: me.clone(), hash: hash.clone(), committed_ms: now_ms(), revealed: false, price: None, pitch_hash: None, credible: false, rep: 0, bond_settled: false });
        event("bid_committed", json!({ "campaign": campaign_id, "creator": me, "hash": hash, "sealed_for": "outlayer" }));
    }

    /// Anyone, once bidding closes (attach at least 0.01 NEAR for OutLayer; the unused part comes back): run the
    /// scorer on every ciphertext in an OutLayer TEE. Only its result for the winner comes back.
    #[payable]
    pub fn score_sealed(&mut self, campaign_id: u32) -> Promise {
        require!(env::attached_deposit().as_yoctonear() >= MIN_RUN_DEPOSIT, "attach at least 0.01 NEAR for OutLayer");
        let c = self.campaigns.get(campaign_id).unwrap_or_else(|| env::panic_str("no such campaign")).clone();
        let mut book = load_book(campaign_id).unwrap_or_else(|| env::panic_str("this brief has no sealed bids"));
        require!(c.phase == "bidding" && now_ms() >= c.commit_ends_ms, "bidding is still open");
        let now = now_ms();
        let retry = (book.status == "failed" || book.status == "scoring") && book.requested_ms.is_some_and(|t| now.saturating_sub(t) >= RESCORE_AFTER_MS);
        require!(book.status == "open" || retry, "already being scored");
        let sc = load_scorer().unwrap();
        require!(sc.wasm_hash == book.wasm_hash && sc.bid_key.as_deref() == Some(book.bid_key.as_str()), "the scorer changed since these bids were sealed");
        let min_bps = self.startup(&c.startup).constraints.min_bid_bps;
        let bids: Vec<Value> = c.bids.iter().zip(book.entries.iter()).map(|(b, e)| {
            let (completed, missed) = self.creators.get(&b.creator).map(|x| (x.completed, x.missed)).unwrap_or((0, 0));
            json!({ "creator": b.creator, "hash": b.hash, "rep": rep_bps(completed, missed), "ciphertext": e.ciphertext })
        }).collect();
        let input = json!({ "op": "score", "hub": env::current_account_id(), "campaign": campaign_id, "budget": c.budget, "min_bid_bps": min_bps, "bids": bids }).to_string();
        book.input_hash = Some(hex::encode(env::sha256_array(input.as_bytes())));
        book.input = Some(input.clone());
        book.status = "scoring".into();
        book.attempts += 1;
        book.requested_ms = Some(now);
        save_book(&book);
        self.outlayer_run(&sc, &input, GAS_OUTLAYER)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CB_SCORED).on_scored(campaign_id))
    }

    /// OutLayer answered. Accept it only if it is the scorer's answer for exactly this input, and the winner's opening
    /// matches the commitment onchain; then settle bonds and file the funding proposal, as a revealed auction would.
    #[private]
    pub fn on_scored(&mut self, campaign_id: u32, #[callback_result] out: Result<Option<Value>, PromiseError>) -> PromiseOrValue<Option<u64>> {
        let Some(mut book) = load_book(campaign_id) else { return PromiseOrValue::Value(None) };
        let c = self.campaigns.get(campaign_id).unwrap().clone();
        let fail = |mut book: SealedBook, why: &str| {
            book.status = "failed".into();
            save_book(&book);
            event("sealed_score_failed", json!({ "campaign": campaign_id, "why": why }));
            PromiseOrValue::Value(None)
        };
        if book.status != "scoring" || c.phase != "bidding" {
            return PromiseOrValue::Value(None);
        }
        let Some(v) = out.ok().flatten() else { return fail(book, "no output") };
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        if s("op").as_deref() != Some("score") || s("hub").as_deref() != Some(env::current_account_id().as_str()) || v.get("campaign").and_then(|x| x.as_u64()) != Some(campaign_id as u64)
            || s("public_key").as_deref() != Some(book.bid_key.as_str()) || s("input_hash") != book.input_hash {
            return fail(book, "not the scorer's answer for this input");
        }
        let valid: Vec<bool> = v.get("valid").and_then(|x| x.as_array()).map(|a| a.iter().map(|b| b.as_bool() == Some(true)).collect()).unwrap_or_default();
        if valid.len() != c.bids.len() {
            return fail(book, "wrong number of verdicts");
        }
        let budget = c.budget.0;
        let min_bps = self.startup(&c.startup).constraints.min_bid_bps;
        // the winner's opening, checked against its commitment and the credibility rule here
        let mut best: Option<usize> = None;
        if !v.get("winner").is_some_and(|w| w.is_null()) {
            let i = v.get("index").and_then(|x| x.as_u64()).unwrap_or(u64::MAX) as usize;
            let (Some(winner), Some(price), Some(pitch_hash), Some(salt)) = (s("winner"), s("price").and_then(|p| p.parse::<u128>().ok()), s("pitch_hash"), s("salt")) else {
                return fail(book, "incomplete winner");
            };
            let ok = i < c.bids.len() && c.bids[i].creator.as_str() == winner && valid[i] && is_hex32(&pitch_hash) && salt.len() <= 128
                && bid_hash(campaign_id, &winner, price, &pitch_hash, &salt) == c.bids[i].hash && credible(price, budget, min_bps);
            if !ok {
                return fail(book, "the winner's opening does not match its commitment");
            }
            let (completed, missed) = self.creators.get(&c.bids[i].creator).map(|x| (x.completed, x.missed)).unwrap_or((0, 0));
            let b = &mut self.campaign_mut(campaign_id).bids[i];
            b.revealed = true;
            b.price = Some(U128(price));
            b.pitch_hash = Some(pitch_hash);
            b.credible = true;
            b.rep = rep_bps(completed, missed);
            best = Some(i);
        }
        // bonds: a ciphertext that opened and matched its commitment gets its bond back; anything else is forfeited
        let startup = c.startup.clone();
        let mut forfeited = 0u128;
        for (i, b) in c.bids.iter().enumerate() {
            if let Some(w) = self.wallets.get_mut(&b.creator) {
                w.locked = U128(w.locked.0.saturating_sub(BID_BOND));
                if valid[i] {
                    w.balance = U128(w.balance.0 + BID_BOND);
                }
            }
            if !valid[i] {
                forfeited += BID_BOND;
                self.log(Some(&startup), Some(campaign_id), "bond_forfeit", Some(&b.creator), BID_BOND, "to_treasury", vec!["outlayer".into()], "sealed bid did not open to its commitment".into());
            }
        }
        if forfeited > 0 {
            let st = self.startup_mut(&startup);
            st.available = U128(st.available.0 + forfeited);
            st.forfeits_in = U128(st.forfeits_in.0 + forfeited);
        }
        let output = v.to_string();
        book.output_hash = Some(hex::encode(env::sha256_array(output.as_bytes())));
        book.output = Some(output);
        book.valid = valid;
        book.status = "scored".into();
        book.scored_ms = Some(now_ms());
        save_book(&book);
        event("sealed_scored", json!({ "campaign": campaign_id, "winner": best.map(|i| c.bids[i].creator.clone()), "valid": book.valid }));
        self.award(campaign_id, best)
    }

    /// Anyone, if a sealed brief could not be scored by SEALED_GIVE_UP_MS after its reveal window: every bond comes back
    /// and the brief ends without a winner. Nobody's bid is opened.
    pub fn abandon_sealed(&mut self, campaign_id: u32) {
        let c = self.campaigns.get(campaign_id).unwrap_or_else(|| env::panic_str("no such campaign")).clone();
        let mut book = load_book(campaign_id).unwrap_or_else(|| env::panic_str("this brief has no sealed bids"));
        require!(c.phase == "bidding" && book.status != "scored", "nothing to abandon");
        require!(now_ms() > c.reveal_ends_ms + SEALED_GIVE_UP_MS, "OutLayer still has time");
        for b in c.bids.iter() {
            if let Some(w) = self.wallets.get_mut(&b.creator) {
                w.locked = U128(w.locked.0.saturating_sub(BID_BOND));
                w.balance = U128(w.balance.0 + BID_BOND);
            }
        }
        book.status = "abandoned".into();
        save_book(&book);
        self.log(Some(&c.startup), Some(campaign_id), "sealed_abandoned", None, 0, "returned", vec!["outlayer".into()], "the TEE scoring did not answer: bonds returned, no winner".into());
        let _ = self.award(campaign_id, None);
    }

    pub fn get_scorer(&self) -> Option<Scorer> {
        load_scorer()
    }

    pub fn get_sealed(&self, campaign_id: u32) -> Option<SealedBook> {
        load_book(campaign_id)
    }

    // ---------- views ----------

    pub fn terms(&self) -> &'static str {
        TERMS
    }

    pub fn get_config(&self) -> Value {
        json!({
            "owner": self.owner, "operator": self.operator, "ft_global": self.ft_global, "dao_global": self.dao_global, "tusd": self.tusd,
            "scouts": self.scouts, "startups": self.startup_ids.len(), "campaigns": self.campaigns.len(), "creators": self.creator_ids.len(),
            "audit": self.audit.len(), "desk_reserve": U128(self.desk_reserve), "tusd_paid": U128(self.tusd_paid),
            "curve": { "a": U128(A), "b": U128(B), "supply": U128(SUPPLY), "decimals": 6, "fee_bps": FEE_BPS as u32 },
            "rules": { "bid_bond": U128(BID_BOND), "vet_fee": U128(VET_FEE), "min_attrib": U128(MIN_ATTRIB), "milestones": MILESTONES, "tusd_per_near": TUSD_PER_NEAR as u32,
                "launch_deposit": U128(LAUNCH_DEPOSIT), "agent_methods": AGENT_METHODS },
            "terms": TERMS
        })
    }

    pub fn get_startups(&self) -> Vec<&Startup> {
        self.startup_ids.iter().filter_map(|id| self.startups.get(id)).collect()
    }

    pub fn get_startup(&self, id: String) -> Option<&Startup> {
        self.startups.get(&id)
    }

    /// The most recent trades, newest first (at most 240 are kept).
    pub fn get_trades(&self, startup: String, limit: Option<u64>) -> Vec<&Trade> {
        let Some(s) = self.startups.get(&startup) else { return vec![] };
        let n = s.trades;
        let take = limit.unwrap_or(TRADE_RING).min(TRADE_RING).min(n);
        (0..take).filter_map(|i| self.trades.get(&format!("{startup}|{}", (n - 1 - i) % TRADE_RING))).collect()
    }

    pub fn is_buyer(&self, startup: String, account: AccountId) -> bool {
        self.buyers.contains(&format!("{startup}|{account}"))
    }

    pub fn quote_buy(&self, startup: String, near: U128, account: Option<AccountId>) -> Value {
        let s = self.startup(&startup);
        let first = account.is_none_or(|a| !self.buyers.contains(&format!("{startup}|{a}")));
        let q = curve::quote_buy(s.circulating.0, near.0, first);
        json!({ "tokens": U128(q.tokens), "fee": U128(q.fee), "storage": U128(q.storage), "cost": U128(q.cost), "refund": U128(q.refund),
            "price_after": U128(price_at(s.circulating.0 + q.tokens)) })
    }

    pub fn quote_sell(&self, startup: String, tokens: U128) -> Value {
        let s = self.startup(&startup);
        let q = curve::quote_sell(s.circulating.0, tokens.0);
        json!({ "proceeds": U128(q.proceeds), "fee": U128(q.fee), "out": U128(q.out), "price_after": U128(price_at(s.circulating.0 - tokens.0)) })
    }

    pub fn price(&self, startup: String) -> U128 {
        U128(price_at(self.startup(&startup).circulating.0))
    }

    pub fn get_campaign(&self, id: u32) -> Option<&Campaign> {
        self.campaigns.get(id)
    }

    pub fn get_campaigns(&self, startup: Option<String>, from: Option<u32>, limit: Option<u32>) -> Vec<&Campaign> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        self.campaigns.iter().skip(from as usize).filter(|c| startup.as_ref().is_none_or(|s| &c.startup == s)).take(limit as usize).collect()
    }

    pub fn get_creator(&self, account: AccountId) -> Option<Value> {
        self.creators.get(&account).map(|c| json!({ "creator": c, "rep_bps": rep_bps(c.completed, c.missed) }))
    }

    pub fn get_creators(&self) -> Vec<Value> {
        self.creator_ids.iter().filter_map(|a| self.get_creator(a.clone())).collect()
    }

    pub fn get_application(&self, account: AccountId) -> Option<&Application> {
        self.applications.get(&account)
    }

    pub fn get_wallet(&self, account: AccountId) -> Option<&Wallet> {
        self.wallets.get(&account)
    }

    pub fn get_audit(&self, from: Option<u64>, limit: Option<u64>) -> Vec<&AuditEntry> {
        let from = from.unwrap_or(0) as u32;
        let limit = limit.unwrap_or(100).min(200) as u32;
        (from..(from + limit).min(self.audit.len())).filter_map(|i| self.audit.get(i)).collect()
    }

    pub fn audit_len(&self) -> u32 {
        self.audit.len()
    }

    /// Everything the hub owes in NEAR (curve reserves, treasuries, wallets, the tUSD desk) next to its balance.
    pub fn solvency(&self) -> Value {
        let mut reserves = 0u128;
        let mut treasuries = 0u128;
        for id in self.startup_ids.iter() {
            if let Some(s) = self.startups.get(id) {
                reserves += s.reserve.0;
                treasuries += s.available.0 + s.committed.0;
            }
        }
        let wallets: u128 = self.wallets.values().map(|w| w.balance.0 + w.locked.0).sum();
        json!({ "reserves": U128(reserves), "treasuries": U128(treasuries), "wallets": U128(wallets), "desk_reserve": U128(self.desk_reserve),
            "owed": U128(reserves + treasuries + wallets + self.desk_reserve), "balance": U128(env::account_balance().as_yoctonear()),
            "locked_for_storage": U128(env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128) })
    }

    fn creator_metadata(&self, account: &AccountId, base: Option<TokenMetadata>) -> Option<TokenMetadata> {
        let c = self.creators.get(account)?;
        let rep = rep_bps(c.completed, c.missed);
        let mut m = base.unwrap_or_default();
        m.title = Some(format!("Signalfire creator: {}", c.name));
        m.description = Some(format!(
            "{} campaigns won, {} completed, {} missed, {} buyers brought, {} tUSD earned. Reputation {rep} bps.{}",
            c.won,
            c.completed,
            c.missed,
            c.results,
            tusd_str(c.paid_tusd.0),
            if c.revoked { " Revoked." } else { "" }
        ));
        m.extra = Some(
            json!({ "won": c.won, "completed": c.completed, "missed": c.missed, "results": c.results, "paid_yocto": c.paid, "paid_tusd": c.paid_tusd,
                "rep_bps": rep, "revoked": c.revoked, "report_hash": c.report_hash, "scout": c.scout, "soulbound": true })
            .to_string(),
        );
        Some(m)
    }

    fn live(&self, t: Token) -> Token {
        match t.token_id.strip_prefix("creator:").and_then(|a| a.parse::<AccountId>().ok()) {
            Some(a) => {
                let metadata = self.creator_metadata(&a, t.metadata.clone());
                Token { metadata, ..t }
            }
            None => t,
        }
    }
}

// ---------- NEP-171 / 177 / 181 ----------

#[near]
impl NonFungibleTokenCore for Hub {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        require!(!token_id.starts_with("creator:"), "creator NFTs are soulbound");
        self.nft.nft_transfer(receiver_id, token_id, approval_id, memo)
    }

    #[payable]
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        require!(!token_id.starts_with("creator:"), "creator NFTs are soulbound");
        self.nft.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.nft.nft_token(token_id).map(|t| self.live(t))
    }
}

#[near]
impl NonFungibleTokenResolver for Hub {
    #[private]
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: TokenId, approved_account_ids: Option<HashMap<AccountId, u64>>) -> bool {
        self.nft.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Hub {
    fn nft_total_supply(&self) -> U128 {
        self.nft.nft_total_supply()
    }
    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.nft.nft_tokens(from_index, limit).into_iter().map(|t| self.live(t)).collect()
    }
    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.nft.nft_supply_for_owner(account_id)
    }
    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.nft.nft_tokens_for_owner(account_id, from_index, limit).into_iter().map(|t| self.live(t)).collect()
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Hub {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Signalfire creators and campaign receipts".into(),
            symbol: "SIGNAL".into(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
}
