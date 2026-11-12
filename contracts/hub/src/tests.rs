use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const HUB: &str = "signalfire.testnet";
const FOUNDER: &str = "founder.testnet";
const SCOUT: &str = "scout-lens.signalfire.testnet";
const NOVA: &str = "creator-nova.signalfire.testnet";
const QUILL: &str = "creator-quill.signalfire.testnet";
const EMBER: &str = "creator-ember.signalfire.testnet";
const DAO: &str = "glow-dao.signalfire.testnet";
const TOKEN: &str = "glow.signalfire.testnet";
const NEAR: u128 = YOCTO;

thread_local! {
    static NOW_MS: std::cell::Cell<u64> = const { std::cell::Cell::new(1_700_000_000_000) };
}

fn now() -> u64 {
    NOW_MS.with(|n| n.get())
}
fn advance(ms: u64) {
    NOW_MS.with(|n| n.set(n.get() + ms))
}

fn ctx_with(who: &str, deposit: u128, results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(HUB.parse().unwrap())
            .predecessor_account_id(who.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(1000))
            .block_timestamp(now() * 1_000_000)
            .block_height(200_000_000)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results,
    );
}
fn ctx(who: &str, deposit: u128) {
    ctx_with(who, deposit, vec![]);
}
fn ok() -> PromiseResult {
    PromiseResult::Successful(vec![])
}
fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn hub() -> Hub {
    ctx(HUB, 0);
    Hub::new(acc(HUB), acc("signalfire-ref.testnet"), acc("ft.globals.primitives.testnet"), acc("dao.globals.primitives.testnet"))
}

/// A live startup "glow" with two council holders.
fn launched() -> Hub {
    let mut h = hub();
    ctx(FOUNDER, NEAR);
    let _ = h.launch_startup("glow".into(), "Glow".into(), "Night light for founders".into(), vec![acc("holder-ada.testnet"), acc("holder-bo.testnet")], None);
    ctx_with(HUB, 0, vec![ok(), ok()]);
    assert!(h.on_launched("glow".into()));
    ctx(HUB, 0);
    let _ = h.create_tusd();
    h
}

/// Buy `gross` as `who`; pretend the token transfer landed.
fn buy(h: &mut Hub, who: &str, gross: u128, code: Option<&str>) {
    ctx(who, gross);
    let _ = h.buy("glow".into(), U128(0), code.map(str::to_string));
}

fn creator(h: &mut Hub, who: &str, name: &str) -> bool {
    ctx(HUB, 0);
    h.add_scout(acc(SCOUT));
    ctx(HUB, NEAR);
    h.fund_wallet(Some(acc(who)));
    ctx(who, 0);
    h.apply_creator(name.into(), format!("{name} makes short videos"));
    ctx(SCOUT, 0);
    h.vet_creator(acc(who), "ab".repeat(32))
}

fn salt(who: &str) -> String {
    sha_hex(&format!("salt:{who}"))
}

fn commit(h: &mut Hub, c: u32, who: &str, price: u128) {
    ctx(who, 0);
    h.commit_bid(c, bid_hash(c, who, price, &pitch_hash("pitch"), &salt(who)));
}
fn reveal(h: &mut Hub, c: u32, who: &str, price: u128) {
    ctx(who, 0);
    h.reveal_bid(c, U128(price), pitch_hash("pitch"), salt(who));
}

/// A campaign with three admitted creators, settled and funded: returns its id.
fn funded(h: &mut Hub, target: u32) -> u32 {
    for _ in 0..6 {
        buy(h, "whale.testnet", 20 * NEAR, None);
    }
    assert!(creator(h, NOVA, "Nova"));
    assert!(creator(h, QUILL, "Quill"));
    assert!(creator(h, EMBER, "Ember"));
    ctx(FOUNDER, 0);
    let id = h.create_campaign("glow".into(), "Night owls".into(), "Bring builders who ship at night".into(), target, U128(NEAR), 60, 60, 3600);
    commit(h, id, NOVA, NEAR * 9 / 10);
    commit(h, id, QUILL, NEAR * 6 / 10);
    commit(h, id, EMBER, NEAR * 5 / 10);
    advance(61_000);
    reveal(h, id, NOVA, NEAR * 9 / 10);
    reveal(h, id, QUILL, NEAR * 6 / 10);
    // Ember never reveals
    advance(60_000);
    ctx("anyone.testnet", 0);
    let _ = h.settle_auction(id);
    ctx_with(HUB, 0, vec![PromiseResult::Successful(b"4".to_vec())]);
    assert_eq!(h.on_proposed(id, Ok(4)), Some(4));
    ctx(DAO, 0);
    h.fund_campaign(id);
    id
}

#[test]
fn shared_vector() {
    // the same numbers as packages/core/test/core.test.ts
    let q = quote_buy(0, NEAR, true);
    assert_eq!(q.tokens, 7_197_528_892);
    assert_eq!(q.fee, 19_975_000_000_000_000_000_000);
    assert_eq!(q.cost, 978_774_999_955_873_738_320_000);
    assert_eq!(q.refund, 44_126_261_680_000);
    let q2 = quote_buy(7_000_000_000, NEAR / 2, false);
    assert_eq!(q2.tokens, 2_672_315_572);
    assert_eq!(q2.refund, 178_231_564_080_000);
    let s = quote_sell(7_000_000_000, 1_000_000_000);
    assert_eq!(s.proceeds, 165_000_000_000_000_000_000_000);
    assert_eq!(s.out, 161_700_000_000_000_000_000_000);
    assert_eq!(cost(123_456_789, 9_876_543_210), 1_462_962_963_101_234_567_895_000);
    assert_eq!(price_at(7_000_000_000), 170_000_000_000_000_000_000);
    hub();
    let ph = pitch_hash("Ten creators, one thread.");
    assert_eq!(ph, "2b2129bca5cf246ea4fc06c942e18d80b183dd7d2cdf74303f1dc28f1558ff4a");
    assert_eq!(
        bid_hash(7, "creator-nova.signalfire.testnet", 350_000_000_000_000_000_000_000, &ph, &"ab".repeat(32)),
        "a76c7b9c9cfbc087c74e8f96f26e5d27699d5b75f543a096d4209286d814d854"
    );
    assert_eq!(score(350_000_000_000_000_000_000_000, 1500), 304_347_826_086_956_521_739_130);
    assert_eq!(score(350_000_000_000_000_000_000_000, -2000), 437_500_000_000_000_000_000_000);
    assert_eq!((threshold(10, 1), threshold(10, 2), threshold(10, 3)), (4, 7, 10));
    assert_eq!(milestone_amount(NEAR, 1), 333_333_333_333_333_333_333_333);
    assert_eq!(milestone_amount(NEAR, 3), 333_333_333_333_333_333_333_334);
    assert_eq!(tusd_for(333_333_333_333_333_333_333_333), 999_999);
    assert!(is_lookalike("n0va.signalfire.testnet", "nova.signalfire.testnet"));
    assert!(is_lookalike("novas.x", "nova.x"));
    assert!(!is_lookalike("ember.x", "nova.x"));
    assert!(!is_lookalike("ivy.x", "ivo.x"));
}

#[test]
fn launch_builds_token_and_dao() {
    let h = launched();
    let s = h.get_startup("glow".into()).unwrap();
    assert_eq!(s.status, "live");
    assert_eq!(s.token, acc(TOKEN));
    assert_eq!(s.dao, acc(DAO));
    assert_eq!(s.founder, acc(FOUNDER));
    // the DAO policy: the hub can only propose funding; holders vote; nobody may transfer
    let p = dao_policy(&acc(HUB), &[acc("holder-ada.testnet")]);
    let text = p.to_string();
    assert!(!text.contains("transfer"));
    assert!(text.contains("\"call:AddProposal\""));
    assert!(!text.contains("call:VoteApprove\",\"add"));
}

#[test]
#[should_panic(expected = "attach 1 NEAR to launch")]
fn launch_needs_a_deposit() {
    let mut h = hub();
    ctx(FOUNDER, NEAR / 2);
    let _ = h.launch_startup("glow".into(), "Glow".into(), "".into(), vec![acc(FOUNDER)], None);
}

#[test]
#[should_panic(expected = "symbol taken")]
fn symbols_are_unique() {
    let mut h = launched();
    ctx(FOUNDER, NEAR);
    let _ = h.launch_startup("glow".into(), "Glow 2".into(), "".into(), vec![acc(FOUNDER)], None);
}

#[test]
fn a_failed_launch_is_marked_failed() {
    let mut h = hub();
    ctx(FOUNDER, NEAR);
    let _ = h.launch_startup("glow".into(), "Glow".into(), "".into(), vec![acc(FOUNDER)], None);
    ctx_with(HUB, 0, vec![ok(), PromiseResult::Failed]);
    assert!(!h.on_launched("glow".into()));
    assert_eq!(h.get_startup("glow".into()).unwrap().status, "failed");
}

#[test]
fn buys_feed_the_treasury_and_keep_the_reserve_on_the_curve() {
    let mut h = launched();
    buy(&mut h, "alice.testnet", NEAR, None);
    let s = h.get_startup("glow".into()).unwrap().clone();
    assert_eq!(s.circulating.0, 7_197_528_892);
    assert_eq!(s.available.0, 19_975_000_000_000_000_000_000);
    assert_eq!(s.fees_in.0, s.available.0);
    assert_eq!(s.reserve.0, cost(0, s.circulating.0));
    assert_eq!(s.buyers, 1);
    // a second buy by the same account pays no storage
    buy(&mut h, "alice.testnet", NEAR / 2, None);
    let s2 = h.get_startup("glow".into()).unwrap();
    assert_eq!(s2.buyers, 1);
    assert_eq!(s2.reserve.0, cost(0, s2.circulating.0));
    assert_eq!(s2.available.0, 19_975_000_000_000_000_000_000 + 10_000_000_000_000_000_000_000);
    let trades = h.get_trades("glow".into(), None);
    assert_eq!(trades.len(), 2);
    assert_eq!(trades[0].n, 1);
    assert!(h.is_buyer("glow".into(), acc("alice.testnet")));
}

#[test]
#[should_panic(expected = "slippage")]
fn buy_slippage() {
    let mut h = launched();
    ctx("alice.testnet", NEAR);
    let _ = h.buy("glow".into(), U128(7_197_528_893), None);
}

#[test]
fn a_failed_token_transfer_unwinds_the_buy() {
    let mut h = launched();
    buy(&mut h, "alice.testnet", NEAR, None);
    let q = quote_buy(0, NEAR, true);
    ctx_with(HUB, 0, vec![ok(), PromiseResult::Failed]);
    assert!(!h.on_bought("glow".into(), acc("alice.testnet"), U128(q.tokens), U128(q.fee), U128(q.refund), false));
    let s = h.get_startup("glow".into()).unwrap();
    assert_eq!(s.circulating.0, 0);
    assert_eq!(s.reserve.0, 0);
    assert_eq!(s.available.0, 0);
}

#[test]
fn sells_through_ft_transfer_call() {
    let mut h = launched();
    buy(&mut h, "alice.testnet", NEAR, None);
    let before = h.get_startup("glow".into()).unwrap().clone();
    ctx(TOKEN, 0);
    let _ = h.ft_on_transfer(acc("alice.testnet"), U128(1_000_000_000), "{\"min_near_out\":\"0\"}".into());
    let s = h.get_startup("glow".into()).unwrap();
    let q = quote_sell(before.circulating.0, 1_000_000_000);
    assert_eq!(s.circulating.0, before.circulating.0 - 1_000_000_000);
    assert_eq!(s.available.0, before.available.0 + q.fee);
    assert_eq!(s.reserve.0, cost(0, s.circulating.0));
    assert_eq!(h.get_trades("glow".into(), Some(1))[0].side, "sell");
}

#[test]
#[should_panic(expected = "not a Signalfire token")]
fn sells_only_from_our_tokens() {
    let mut h = launched();
    ctx("evil.testnet", 0);
    let _ = h.ft_on_transfer(acc("alice.testnet"), U128(1), "{}".into());
}

#[test]
#[should_panic(expected = "slippage")]
fn sell_slippage() {
    let mut h = launched();
    buy(&mut h, "alice.testnet", NEAR, None);
    ctx(TOKEN, 0);
    let _ = h.ft_on_transfer(acc("alice.testnet"), U128(1_000_000_000), format!("{{\"min_near_out\":\"{}\"}}", NEAR));
}

#[test]
fn wallet_caps_hold() {
    let mut h = launched();
    ctx(HUB, NEAR);
    h.fund_wallet(Some(acc("fan-01.signalfire.testnet")));
    // a wallet opened by funding belongs to the account itself
    ctx("fan-01.signalfire.testnet", 0);
    h.set_wallet_caps(acc("fan-01.signalfire.testnet"), U128(NEAR / 10), U128(NEAR / 4));
    ctx("fan-01.signalfire.testnet", 0);
    let _ = h.buy_with_wallet("glow".into(), U128(NEAR / 10), U128(0), None);
    ctx("fan-01.signalfire.testnet", 0);
    let _ = h.buy_with_wallet("glow".into(), U128(NEAR / 10), U128(0), None);
    let w = h.get_wallet(acc("fan-01.signalfire.testnet")).unwrap();
    assert_eq!(w.balance.0, NEAR - NEAR / 5);
    assert_eq!(w.day_spent.0, NEAR / 5);
    // the next 0.1 would pass the 24-hour cap of 0.25
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("fan-01.signalfire.testnet", 0);
        let _ = h.buy_with_wallet("glow".into(), U128(NEAR / 10), U128(0), None);
    }));
    assert!(r.is_err());
    // a day later the window resets
    advance(24 * HOUR_MS);
    ctx("fan-01.signalfire.testnet", 0);
    let _ = h.buy_with_wallet("glow".into(), U128(NEAR / 10), U128(0), None);
}

#[test]
#[should_panic(expected = "per-transaction cap")]
fn agent_pay_respects_the_tx_cap() {
    let mut h = hub();
    ctx(HUB, NEAR);
    h.fund_wallet(Some(acc("creator-nova.signalfire.testnet")));
    ctx("creator-nova.signalfire.testnet", 0);
    h.agent_pay(acc(SCOUT), U128(2 * NEAR), "brief".into());
}

#[test]
#[should_panic(expected = "wallet owner only")]
fn only_the_owner_sets_caps() {
    let mut h = hub();
    ctx(HUB, NEAR);
    h.fund_wallet(Some(acc(NOVA)));
    ctx("mallory.testnet", 0);
    h.set_wallet_caps(acc(NOVA), U128(100 * NEAR), U128(100 * NEAR));
}

#[test]
fn agents_pay_each_other() {
    let mut h = hub();
    ctx(HUB, NEAR);
    h.fund_wallet(Some(acc(NOVA)));
    ctx(NOVA, 0);
    h.agent_pay(acc(SCOUT), U128(NEAR / 100), "audience brief".into());
    assert_eq!(h.get_wallet(acc(SCOUT)).unwrap().balance.0, NEAR / 100);
    assert_eq!(h.get_wallet(acc(NOVA)).unwrap().balance.0, NEAR - NEAR / 100);
}

#[test]
fn vetting_admits_by_rule_and_rejects_lookalikes() {
    let mut h = launched();
    assert!(creator(&mut h, NOVA, "Nova"));
    // the scout was paid from escrow
    assert_eq!(h.get_wallet(acc(SCOUT)).unwrap().balance.0, VET_FEE);
    assert_eq!(h.get_wallet(acc(NOVA)).unwrap().locked.0, 0);
    // a lookalike is refused and logged
    assert!(!creator(&mut h, "creator-n0va.signalfire.testnet", "N0va"));
    let audit = h.get_audit(None, None);
    let last = audit.last().unwrap();
    assert_eq!(last.outcome, "rejected");
    assert_eq!(last.flags, vec!["lookalike".to_string()]);
    assert!(h.get_creator(acc("creator-n0va.signalfire.testnet")).is_none());
    // the creator NFT exists and is soulbound
    let t = h.nft_token(format!("creator:{NOVA}")).unwrap();
    assert_eq!(t.owner_id, acc(NOVA));
    assert!(t.metadata.unwrap().extra.unwrap().contains("\"soulbound\":true"));
}

#[test]
#[should_panic(expected = "registered scouts only")]
fn only_scouts_vet() {
    let mut h = hub();
    ctx(HUB, NEAR);
    h.fund_wallet(Some(acc(NOVA)));
    ctx(NOVA, 0);
    h.apply_creator("Nova".into(), "".into());
    ctx(NOVA, 0);
    h.vet_creator(acc(NOVA), "ab".repeat(32));
}

#[test]
#[should_panic(expected = "soulbound")]
fn creator_nfts_are_soulbound() {
    let mut h = launched();
    creator(&mut h, NOVA, "Nova");
    ctx(NOVA, 1);
    h.nft_transfer(acc("someone.testnet"), format!("creator:{NOVA}"), None, None);
}

#[test]
fn the_auction_settles_by_the_shared_rule() {
    let mut h = launched();
    let id = funded(&mut h, 3);
    let c = h.get_campaign(id).unwrap().clone();
    // Ember bid lowest but never revealed: Quill wins at 0.6, Ember's bond went to the treasury
    assert_eq!(c.winner, Some(acc(QUILL)));
    assert_eq!(c.price.0, NEAR * 6 / 10);
    assert_eq!(c.phase, "funded");
    assert_eq!(c.proposal_id, Some(4));
    let s = h.get_startup("glow".into()).unwrap();
    assert_eq!(s.forfeits_in.0, BID_BOND);
    assert_eq!(s.committed.0, NEAR * 6 / 10);
    assert_eq!(h.get_wallet(acc(EMBER)).unwrap().locked.0, 0);
    // the revealed bonds came back
    assert_eq!(h.get_wallet(acc(NOVA)).unwrap().locked.0, 0);
    assert!(h.get_audit(None, None).iter().any(|e| e.action == "bond_forfeit" && e.account == Some(acc(EMBER))));
    assert_eq!(h.get_creator(acc(QUILL)).unwrap()["creator"]["won"], 1);
}

#[test]
fn the_fund_proposal_calls_back_into_the_hub() {
    let h = launched();
    ctx(HUB, 0);
    let p = h.fund_proposal(3, "T", &acc(QUILL), 5);
    let fc = &p["proposal"]["kind"]["FunctionCall"];
    assert_eq!(fc["receiver_id"], HUB);
    assert_eq!(fc["actions"][0]["method_name"], "fund_campaign");
    assert_eq!(fc["actions"][0]["deposit"], "0");
}

#[test]
#[should_panic(expected = "opening does not match")]
fn a_wrong_opening_is_refused() {
    let mut h = launched();
    buy(&mut h, "whale.testnet", 20 * NEAR, None);
    creator(&mut h, NOVA, "Nova");
    ctx(FOUNDER, 0);
    let id = h.create_campaign("glow".into(), "T".into(), "".into(), 3, U128(NEAR / 4), 60, 60, 3600);
    commit(&mut h, id, NOVA, NEAR / 5);
    advance(61_000);
    reveal(&mut h, id, NOVA, NEAR / 6);
}

#[test]
#[should_panic(expected = "bidding is closed")]
fn no_commits_after_the_window() {
    let mut h = launched();
    buy(&mut h, "whale.testnet", 20 * NEAR, None);
    creator(&mut h, NOVA, "Nova");
    ctx(FOUNDER, 0);
    let id = h.create_campaign("glow".into(), "T".into(), "".into(), 3, U128(NEAR / 4), 60, 60, 3600);
    advance(61_000);
    commit(&mut h, id, NOVA, NEAR / 5);
}

#[test]
#[should_panic(expected = "budget over the treasury's free balance")]
fn campaigns_fit_the_treasury() {
    let mut h = launched();
    buy(&mut h, "alice.testnet", NEAR, None);
    ctx(FOUNDER, 0);
    h.create_campaign("glow".into(), "T".into(), "".into(), 3, U128(NEAR), 60, 60, 3600);
}

#[test]
#[should_panic(expected = "only the startup's DAO can fund a campaign")]
fn only_the_dao_funds() {
    let mut h = launched();
    let id = funded(&mut h, 3);
    ctx(FOUNDER, 0);
    h.fund_campaign(id);
}

#[test]
fn no_credible_bid_means_no_proposal() {
    let mut h = launched();
    buy(&mut h, "whale.testnet", 20 * NEAR, None);
    creator(&mut h, NOVA, "Nova");
    ctx(FOUNDER, 0);
    let id = h.create_campaign("glow".into(), "T".into(), "".into(), 3, U128(NEAR / 4), 60, 60, 3600);
    commit(&mut h, id, NOVA, NEAR / 100); // under the 20% floor
    advance(61_000);
    reveal(&mut h, id, NOVA, NEAR / 100);
    advance(60_000);
    ctx("anyone.testnet", 0);
    assert!(matches!(h.settle_auction(id), PromiseOrValue::Value(None)));
    assert_eq!(h.get_campaign(id).unwrap().phase, "no_bids");
}

#[test]
fn attribution_milestones_payouts_and_the_receipt() {
    let mut h = launched();
    let id = funded(&mut h, 3);
    let code = format!("c{id}");
    // the winner's own buy and a buy under 0.05 NEAR don't count; a repeat buyer doesn't count
    buy(&mut h, QUILL, NEAR / 10, Some(&code));
    buy(&mut h, "tiny.testnet", NEAR / 100, Some(&code));
    buy(&mut h, "whale.testnet", NEAR / 10, Some(&code));
    assert_eq!(h.get_campaign(id).unwrap().results, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("anyone.testnet", 0);
        let _ = h.claim_milestone(id);
    }));
    assert!(r.is_err(), "no milestone without results");
    buy(&mut h, "fan1.testnet", NEAR / 10, Some(&code));
    assert_eq!(h.get_campaign(id).unwrap().results, 1);
    assert_eq!(h.get_trades("glow".into(), Some(1))[0].attributed, Some(id));
    // milestone 1 pays a third in tUSD
    ctx("anyone.testnet", 0);
    let _ = h.claim_milestone(id);
    ctx_with(HUB, 0, vec![ok()]);
    let n = h.audit_len() as u64 - 1;
    assert_eq!(h.on_paid(id, 1, U128(milestone_amount(NEAR * 6 / 10, 1)), U128(tusd_for(milestone_amount(NEAR * 6 / 10, 1))), n), "paid");
    let e = h.get_audit(Some(n), Some(1))[0].clone();
    assert_eq!(e.outcome, "paid");
    assert_eq!(e.flags, vec!["new_payee".to_string()]);
    buy(&mut h, "fan2.testnet", NEAR / 10, Some(&code));
    buy(&mut h, "fan3.testnet", NEAR / 10, Some(&code));
    // a second claim within a minute is flagged as a burst but paid
    advance(10_000);
    ctx("anyone.testnet", 0);
    let _ = h.claim_milestone(id);
    let e2 = (*h.get_audit(None, None).last().unwrap()).clone();
    assert_eq!(e2.outcome, "paid");
    assert_eq!(e2.flags, vec!["burst".to_string()]);
    ctx_with(HUB, 0, vec![ok()]);
    h.on_paid(id, 2, U128(0), U128(0), e2.n);
    advance(120_000);
    ctx("anyone.testnet", 0);
    let _ = h.claim_milestone(id);
    let k3 = milestone_amount(NEAR * 6 / 10, 3);
    ctx_with(HUB, 0, vec![ok()]);
    h.on_paid(id, 3, U128(k3), U128(tusd_for(k3)), h.audit_len() as u64 - 1);
    let c = h.get_campaign(id).unwrap().clone();
    assert_eq!(c.phase, "done");
    assert_eq!(c.paid.0, NEAR * 6 / 10);
    assert_eq!(c.paid_tusd.0, 1_800_000); // 0.6 NEAR = 1.80 tUSD
    let s = h.get_startup("glow".into()).unwrap();
    assert_eq!(s.committed.0, 0);
    assert_eq!(s.paid.0, NEAR * 6 / 10);
    // the receipt NFT and the creator's live record
    let r = h.nft_token(format!("receipt:{id}")).unwrap();
    assert_eq!(r.owner_id, acc(QUILL));
    assert!(r.metadata.unwrap().extra.unwrap().contains("\"results\":3"));
    let cr = h.nft_token(format!("creator:{QUILL}")).unwrap().metadata.unwrap();
    assert!(cr.description.unwrap().starts_with("1 campaigns won, 1 completed"));
    assert!(cr.extra.unwrap().contains("\"rep_bps\":500"));
    assert_eq!(h.nft_tokens_for_owner(acc(QUILL), None, None).len(), 2);
    // nothing more to claim
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("anyone.testnet", 0);
        let _ = h.claim_milestone(id);
    }));
    assert!(r.is_err());
}

#[test]
fn the_policy_holds_payouts_over_the_caps() {
    let mut h = launched();
    let id = funded(&mut h, 1);
    buy(&mut h, "fan1.testnet", NEAR / 10, Some(&format!("c{id}")));
    // the founder lowers the per-payout cap under a milestone
    ctx(FOUNDER, 0);
    h.set_constraints("glow".into(), Constraints { max_payout: U128(NEAR / 10), payouts_per_hour: 1, ..Constraints::default() });
    ctx("anyone.testnet", 0);
    assert!(matches!(h.claim_milestone(id), PromiseOrValue::Value(ref s) if s == "held:over_cap"));
    assert_eq!(h.get_campaign(id).unwrap().milestones_paid, 0);
    // raised again: paid; the next one, within the hour, is held by the rate limit
    ctx(FOUNDER, 0);
    h.set_constraints("glow".into(), Constraints { payouts_per_hour: 1, ..Constraints::default() });
    ctx("anyone.testnet", 0);
    assert!(matches!(h.claim_milestone(id), PromiseOrValue::Promise(_)));
    advance(120_000);
    ctx("anyone.testnet", 0);
    assert!(matches!(h.claim_milestone(id), PromiseOrValue::Value(ref s) if s == "held:rate_limit"));
    let held: Vec<_> = h.get_audit(None, None).into_iter().filter(|e| e.outcome.starts_with("held")).map(|e| (*e).clone()).collect();
    assert_eq!(held.len(), 2);
    assert!(held[1].flags.contains(&"rate_limit".to_string()));
    // an hour later it goes through
    advance(HOUR_MS);
    ctx("anyone.testnet", 0);
    assert!(matches!(h.claim_milestone(id), PromiseOrValue::Promise(_)));
}

#[test]
fn a_failed_tusd_transfer_is_undone() {
    let mut h = launched();
    let id = funded(&mut h, 1);
    buy(&mut h, "fan1.testnet", NEAR / 10, Some(&format!("c{id}")));
    ctx("anyone.testnet", 0);
    let _ = h.claim_milestone(id);
    let a = milestone_amount(NEAR * 6 / 10, 1);
    ctx_with(HUB, 0, vec![PromiseResult::Failed]);
    assert_eq!(h.on_paid(id, 1, U128(a), U128(tusd_for(a)), h.audit_len() as u64 - 1), "failed:transfer");
    let c = h.get_campaign(id).unwrap();
    assert_eq!(c.milestones_paid, 0);
    assert_eq!(c.paid.0, 0);
    assert_eq!(h.get_startup("glow".into()).unwrap().committed.0, NEAR * 6 / 10);
    assert_eq!(h.get_audit(None, None).last().unwrap().outcome, "failed:transfer");
}

#[test]
fn revoked_creators_are_held() {
    let mut h = launched();
    let id = funded(&mut h, 1);
    buy(&mut h, "fan1.testnet", NEAR / 10, Some(&format!("c{id}")));
    ctx(SCOUT, 0);
    h.revoke_creator(acc(QUILL));
    ctx("anyone.testnet", 0);
    assert!(matches!(h.claim_milestone(id), PromiseOrValue::Value(ref s) if s == "held:payee_revoked"));
}

#[test]
fn expiry_returns_the_unpaid_part_and_counts_a_miss() {
    let mut h = launched();
    let id = funded(&mut h, 30);
    let before = h.get_startup("glow".into()).unwrap().available.0;
    advance(3_600_001);
    ctx("anyone.testnet", 0);
    h.expire_campaign(id);
    let s = h.get_startup("glow".into()).unwrap();
    assert_eq!(s.available.0, before + NEAR * 6 / 10);
    assert_eq!(s.committed.0, 0);
    assert_eq!(h.get_campaign(id).unwrap().phase, "expired");
    assert_eq!(h.get_creator(acc(QUILL)).unwrap()["rep_bps"], -1000);
}

#[test]
#[should_panic(expected = "founder only")]
fn only_the_founder_sets_constraints() {
    let mut h = launched();
    ctx("someone.testnet", 0);
    h.set_constraints("glow".into(), Constraints::default());
}

#[test]
#[should_panic(expected = "payouts_per_hour")]
fn constraints_have_hard_limits() {
    let mut h = launched();
    ctx(FOUNDER, 0);
    h.set_constraints("glow".into(), Constraints { payouts_per_hour: 0, ..Constraints::default() });
}

#[test]
fn agents_get_function_call_keys_and_a_capped_wallet() {
    let mut h = launched();
    ctx(HUB, NEAR);
    let key: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap();
    let _ = h.create_agent("holder-ada".into(), key.clone(), Some(acc(DAO)), Some(key), U128(NEAR / 4), U128(NEAR / 10), U128(NEAR / 2));
    let w = h.get_wallet(acc("holder-ada.signalfire.testnet")).unwrap();
    assert_eq!(w.balance.0, NEAR - NEAR / 4);
    assert_eq!(w.owner, acc(HUB));
    assert_eq!(w.cap_tx.0, NEAR / 10);
}

#[test]
fn the_holder_proposal_kinds() {
    assert_eq!(member_kind(true, &acc("a.testnet")).to_string(), r#"{"AddMemberToRole":{"member_id":"a.testnet","role":"holders"}}"#);
    assert_eq!(member_kind(false, &acc("a.testnet")).to_string(), r#"{"RemoveMemberFromRole":{"member_id":"a.testnet","role":"holders"}}"#);
}

#[test]
fn solvency_adds_up() {
    let mut h = launched();
    buy(&mut h, "alice.testnet", NEAR, None);
    ctx(HUB, NEAR);
    h.fund_wallet(Some(acc(NOVA)));
    let v = h.solvency();
    let s = h.get_startup("glow".into()).unwrap();
    let owed: u128 = v["owed"].as_str().unwrap().parse().unwrap();
    assert_eq!(owed, s.reserve.0 + s.available.0 + NEAR);
}

#[test]
fn tusd_formats_with_two_decimals() {
    assert_eq!(tusd_str(452_034), "0.45");
    assert_eq!(tusd_str(1_800_000), "1.80");
    assert_eq!(tusd_str(0), "0.00");
}

// The same edges packages/core (founder.ts, constraintErrors) checks in the founder's form.
#[test]
fn constraint_edges_match_core() {
    let d = Constraints::default();
    let accepts = |c: Constraints| std::panic::catch_unwind(|| Hub::check_constraints(&c)).is_ok();
    assert!(accepts(d.clone()));
    assert!(accepts(Constraints { campaign_cap: U128(1000 * NEAR), ..d.clone() }));
    assert!(!accepts(Constraints { campaign_cap: U128(1000 * NEAR + 1), ..d.clone() }));
    assert!(!accepts(Constraints { campaign_cap: U128(0), ..d.clone() }));
    assert!(!accepts(Constraints { max_payout: U128(0), ..d.clone() }));
    assert!(accepts(Constraints { payouts_per_hour: 60, ..d.clone() }));
    assert!(!accepts(Constraints { payouts_per_hour: 61, ..d.clone() }));
    assert!(accepts(Constraints { min_bid_bps: 0, ..d.clone() }));
    assert!(accepts(Constraints { min_bid_bps: 9000, ..d.clone() }));
    assert!(!accepts(Constraints { min_bid_bps: 9001, ..d.clone() }));
    assert!(!accepts(Constraints { min_holder_tokens: U128(UNIT - 1), ..d.clone() }));
    assert!(accepts(Constraints { min_holder_tokens: U128(SUPPLY / 100), ..d.clone() }));
    assert!(!accepts(Constraints { min_holder_tokens: U128(SUPPLY / 100 + 1), ..d }));
}

// ---------- the keyless treasury agent (Chain Signatures) ----------

/// From near-api-js 7.4 (createTransaction + encodeTransaction) for the same inputs: the contract builds the
/// same bytes a wallet would sign.
const VEC_PK: &str = "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const VEC_ACCOUNT: &str = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const VEC_BLOCK: &str = "cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN";
const VEC_ARGS: &str = r#"{"receiver_id":"signalfire.testnet","amount":"217360","msg":"agent-payout:0"}"#;
const VEC_TX: &str = "400000006561346136633633653239633532306162656635353037623133326563356639393534373736616562656265376239323432316565613639313434366432326300ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c2a0000000000000017000000747573642e7369676e616c666972652e746573746e6574090909090909090909090909090909090909090909090909090909090909090901000000021000000066745f7472616e736665725f63616c6c4d0000007b2272656365697665725f6964223a227369676e616c666972652e746573746e6574222c22616d6f756e74223a22323137333630222c226d7367223a226167656e742d7061796f75743a30227d0080f420e6b5000001000000000000000000000000000000";
const VEC_HASH: &str = "efebba41eefc7cc014ea06c21b6eceb3ba584e66aad2ffb94f305afedb758a5d";

#[test]
fn keyless_tx_bytes_match_near_api_js() {
    let pk = ed25519_bytes(VEC_PK).unwrap();
    assert_eq!(implicit_account(&pk).as_str(), VEC_ACCOUNT);
    let bh = block_hash_bytes(VEC_BLOCK).unwrap();
    let tx = function_call_tx(VEC_ACCOUNT, &pk, 42, "tusd.signalfire.testnet", &bh, "ft_transfer_call", VEC_ARGS.as_bytes(), 200_000_000_000_000, 1);
    assert_eq!(hex::encode(&tx), VEC_TX);
    ctx(HUB, 0);
    assert_eq!(hex::encode(env::sha256_array(&tx)), VEC_HASH);
    assert_eq!(parse_payout_msg(&payout_msg(7)), Some(7));
    assert_eq!(parse_payout_msg("agent-payout:x"), None);
}

/// "The MPC network": the Ed25519 key it would derive, held by the test only.
fn mpc_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[7u8; 32])
}
fn mpc_pk() -> String {
    format!("ed25519:{}", bs58::encode(mpc_key().verifying_key().to_bytes()).into_string())
}
const AGENT_TUSD: u128 = 1_000 * 1_000_000;

/// A funded campaign with one result per milestone threshold reached, and the agent set up.
fn with_agent() -> (Hub, u32, AccountId) {
    let mut h = launched();
    let id = funded(&mut h, 3);
    ctx(HUB, NEAR / 2);
    let _ = h.agent_setup(U128(AGENT_TUSD));
    ctx_with(HUB, 0, vec![PromiseResult::Successful(format!("\"{}\"", mpc_pk()).into_bytes())]);
    let _ = h.on_agent_key(U128(AGENT_TUSD), U128(NEAR / 2), Ok(mpc_pk()));
    ctx_with(HUB, 0, vec![ok(), ok()]);
    assert!(h.on_agent_funded());
    let d = h.get_agent().unwrap();
    assert_eq!(d.account.as_str(), hex::encode(mpc_key().verifying_key().to_bytes()));
    assert_eq!(d.path, AGENT_PATH);
    assert_eq!(d.signer.as_str(), "v1.signer-prod.testnet");
    assert_eq!(d.tusd_free.0, AGENT_TUSD);
    let agent = d.account.clone();
    (h, id, agent)
}

/// Ask for a signature and answer as the MPC network would (with `key`).
fn sign_action(h: &mut Hub, id: u32, nonce: u64, key: &ed25519_dalek::SigningKey) -> bool {
    use ed25519_dalek::Signer;
    ctx("crank.testnet", 1);
    let _ = h.agent_sign(id, nonce, VEC_BLOCK.into());
    let desk = h.get_agent().unwrap();
    let a = h.get_agent_action(id).unwrap();
    let pk = ed25519_bytes(&desk.public_key).unwrap();
    let tx = payout_tx(&desk, &pk, nonce, &block_hash_bytes(VEC_BLOCK).unwrap(), &acc("tusd.signalfire.testnet"), &acc(HUB), &a);
    let hash = env::sha256_array(&tx);
    let sig = key.sign(&hash).to_bytes().to_vec();
    ctx_with(HUB, 0, vec![ok()]);
    h.on_agent_signed(id, Base64VecU8::from(tx), Ok(MpcEd25519Signature { scheme: "Ed25519".into(), signature: sig }))
}

fn deliver(h: &mut Hub, from: &str, amount: u128, msg: &str) -> PromiseOrValue<U128> {
    ctx("tusd.signalfire.testnet", 0);
    h.ft_on_transfer(acc(from), U128(amount), msg.into())
}

#[test]
fn keyless_agent_pays_an_approved_milestone_exactly_once() {
    let (mut h, id, agent) = with_agent();
    buy(&mut h, "fan1.testnet", NEAR / 10, Some(&format!("c{id}")));
    ctx("anyone.testnet", 0);
    let r = h.claim_milestone(id);
    assert!(matches!(r, PromiseOrValue::Value(ref s) if s == "paid:keyless_agent:0"), "the agent pays, not the hub");
    let e = (*h.get_audit(None, None).last().unwrap()).clone();
    assert_eq!(e.outcome, "paid");
    assert!(e.flags.contains(&"keyless_agent".to_string()));
    let a = h.get_agent_action(0).unwrap();
    let tusd = tusd_for(milestone_amount(NEAR * 6 / 10, 1));
    assert_eq!((a.status.as_str(), a.receiver.as_str(), a.tusd.0), ("approved", QUILL, tusd));
    assert_eq!(h.get_agent().unwrap().tusd_free.0, AGENT_TUSD - tusd);

    // a signature from any other key is refused; the action stays open
    assert!(!sign_action(&mut h, 0, 5, &ed25519_dalek::SigningKey::from_bytes(&[8u8; 32])));
    assert_eq!(h.get_agent_action(0).unwrap().status, "approved");
    // nonces only go up
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("crank.testnet", 1);
        let _ = h.agent_sign(0, 5, VEC_BLOCK.into());
    }));
    assert!(r.is_err());
    // a nonce NEAR would refuse at this height is refused here too
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("crank.testnet", 1);
        let _ = h.agent_sign(0, u64::MAX, VEC_BLOCK.into());
    }));
    assert!(r.is_err());
    // the MPC network's signature checks against the agent's key: the signed transaction is kept
    assert!(sign_action(&mut h, 0, 6, &mpc_key()));
    let a = h.get_agent_action(0).unwrap();
    assert_eq!(a.status, "signed");
    assert_eq!(a.nonce, Some(6));
    let stx = a.signed_tx.unwrap().0;
    assert_eq!(stx[stx.len() - 65], 0, "ED25519 signature tag");
    assert_eq!(a.tx_hash.unwrap(), hex::encode(env::sha256_array(&stx[..stx.len() - 65])));
    // not signable again until RESIGN_AFTER_MS
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("crank.testnet", 1);
        let _ = h.agent_sign(0, 7, VEC_BLOCK.into());
    }));
    assert!(r.is_err());

    // deliveries: from someone else, a wrong amount, or a wrong action go back
    assert!(matches!(deliver(&mut h, "mallory.testnet", tusd, "agent-payout:0"), PromiseOrValue::Value(U128(x)) if x == tusd));
    assert!(matches!(deliver(&mut h, agent.as_str(), tusd + 1, "agent-payout:0"), PromiseOrValue::Value(U128(x)) if x == tusd + 1));
    assert!(matches!(deliver(&mut h, agent.as_str(), tusd, "agent-payout:9"), PromiseOrValue::Value(U128(x)) if x == tusd));
    // the right one is forwarded to the creator
    assert!(matches!(deliver(&mut h, agent.as_str(), tusd, "agent-payout:0"), PromiseOrValue::Promise(_)));
    assert_eq!(h.get_agent_action(0).unwrap().status, "delivering");
    ctx_with(HUB, 0, vec![ok()]);
    assert_eq!(h.on_agent_forwarded(0).0, 0);
    assert_eq!(h.get_agent_action(0).unwrap().status, "paid");
    // a second delivery of the same action (another signature, another nonce) is refunded
    assert!(matches!(deliver(&mut h, agent.as_str(), tusd, "agent-payout:0"), PromiseOrValue::Value(U128(x)) if x == tusd));
    let c = h.get_campaign(id).unwrap();
    assert_eq!((c.milestones_paid, c.paid_tusd.0), (1, tusd));
    // the list view leaves the signed transaction out
    assert!(h.get_agent_actions(None, None)[0].signed_tx.is_none());
}

#[test]
fn keyless_agent_failed_forward_undoes_the_payout_and_frees_the_tusd() {
    let (mut h, id, agent) = with_agent();
    buy(&mut h, "fan1.testnet", NEAR / 10, Some(&format!("c{id}")));
    ctx("anyone.testnet", 0);
    let _ = h.claim_milestone(id);
    let tusd = h.get_agent_action(0).unwrap().tusd.0;
    assert!(matches!(deliver(&mut h, agent.as_str(), tusd, "agent-payout:0"), PromiseOrValue::Promise(_)));
    ctx_with(HUB, 0, vec![PromiseResult::Failed]);
    assert_eq!(h.on_agent_forwarded(0).0, tusd, "the tUSD goes back to the agent");
    assert_eq!(h.get_agent_action(0).unwrap().status, "failed:transfer");
    assert_eq!(h.get_agent().unwrap().tusd_free.0, AGENT_TUSD);
    let c = h.get_campaign(id).unwrap();
    assert_eq!((c.milestones_paid, c.paid.0, c.phase.as_str()), (0, 0, "funded"));
    assert_eq!((*h.get_audit(None, None).last().unwrap()).outcome, "failed:transfer");
}

#[test]
fn keyless_agent_timeout_lets_the_hub_pay_and_refunds_a_late_delivery() {
    let (mut h, id, agent) = with_agent();
    buy(&mut h, "fan1.testnet", NEAR / 10, Some(&format!("c{id}")));
    ctx("anyone.testnet", 0);
    let _ = h.claim_milestone(id);
    let tusd = h.get_agent_action(0).unwrap().tusd.0;
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("anyone.testnet", 0);
        let _ = h.agent_fallback(0);
    }));
    assert!(r.is_err(), "the agent still has time");
    advance(AGENT_TIMEOUT_MS);
    ctx("anyone.testnet", 0);
    let _ = h.agent_fallback(0);
    assert_eq!(h.get_agent_action(0).unwrap().status, "fallback");
    assert_eq!(h.get_agent().unwrap().tusd_free.0, AGENT_TUSD);
    ctx_with(HUB, 0, vec![ok()]);
    let n = h.get_agent_action(0).unwrap().audit_n;
    assert_eq!(h.on_paid(id, 1, U128(milestone_amount(NEAR * 6 / 10, 1)), U128(tusd), n), "paid");
    assert!(matches!(deliver(&mut h, agent.as_str(), tusd, "agent-payout:0"), PromiseOrValue::Value(U128(x)) if x == tusd));
}

#[test]
fn keyless_agent_setup_is_owner_only_once_and_needs_the_mpc_key() {
    let mut h = launched();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("mallory.testnet", NEAR);
        let _ = h.agent_setup(U128(1));
    }));
    assert!(r.is_err());
    ctx(HUB, NEAR / 2);
    let _ = h.agent_setup(U128(AGENT_TUSD));
    // the MPC call failed: nothing is set up, the NEAR goes back
    ctx_with(HUB, 0, vec![PromiseResult::Failed]);
    assert!(matches!(h.on_agent_key(U128(AGENT_TUSD), U128(NEAR / 2), Err(PromiseError::Failed)), PromiseOrValue::Value(false)));
    assert!(h.get_agent().is_none());
    // without an agent the hub pays as before
    let id = funded(&mut h, 3);
    buy(&mut h, "fan1.testnet", NEAR / 10, Some(&format!("c{id}")));
    ctx("anyone.testnet", 0);
    assert!(matches!(h.claim_milestone(id), PromiseOrValue::Promise(_)));
}

// ---------- sealed bids scored by OutLayer ----------

const BID_KEY: &str = "44f468700cdec813df76b469d073d615c06ed9a2bb1a759c7cf4437a877de57c";
const WASM_HASH: &str = "36e28ec9e6bcd127b8cdd5d7b7a34b1e4047a8661fae895cba6b5947749ddff3";

/// A live startup with three admitted creators, the scorer set up with its key, and an open brief.
fn sealed_brief() -> (Hub, u32) {
    let mut h = launched();
    for _ in 0..6 {
        buy(&mut h, "whale.testnet", 20 * NEAR, None);
    }
    assert!(creator(&mut h, NOVA, "Nova"));
    assert!(creator(&mut h, QUILL, "Quill"));
    assert!(creator(&mut h, EMBER, "Ember"));
    ctx(HUB, 0);
    h.scorer_set("https://example.org/scorer.wasm".into(), WASM_HASH.into());
    ctx("anyone.testnet", MIN_RUN_DEPOSIT);
    let _ = h.scorer_publish_key();
    ctx_with(HUB, 0, vec![ok()]);
    let out = json!({ "op": "public_key", "public_key": BID_KEY });
    assert_eq!(h.on_scorer_key(json!({"op":"public_key"}).to_string(), Ok(Some(out))), Some(BID_KEY.to_string()));
    ctx(FOUNDER, 0);
    let id = h.create_campaign("glow".into(), "Night owls".into(), "Bring builders who ship at night".into(), 3, U128(NEAR), 60, 60, 3600);
    (h, id)
}

fn seal(h: &mut Hub, c: u32, who: &str, price: u128) {
    ctx(who, 0);
    h.commit_sealed_bid(c, bid_hash(c, who, price, &pitch_hash("pitch"), &salt(who)), "ab".repeat(80));
}

/// What the scorer would answer for the brief's stored input: `winner` (index, price) and which bids opened.
fn scorer_answer(h: &Hub, c: u32, winner: Option<(usize, u128)>, valid: Vec<bool>) -> Value {
    let book = h.get_sealed(c).unwrap();
    let mut v = json!({ "op": "score", "hub": HUB, "campaign": c, "public_key": BID_KEY, "input_hash": book.input_hash, "valid": valid, "winner": null });
    if let Some((i, price)) = winner {
        let who = h.get_campaign(c).unwrap().bids[i].creator.clone();
        v["winner"] = json!(who);
        v["index"] = json!(i);
        v["price"] = json!(price.to_string());
        v["pitch_hash"] = json!(pitch_hash("pitch"));
        v["salt"] = json!(salt(who.as_str()));
    }
    v
}

#[test]
fn sealed_bids_are_scored_by_the_tee_and_only_the_winner_is_opened() {
    let (mut h, c) = sealed_brief();
    seal(&mut h, c, NOVA, NEAR * 9 / 10);
    seal(&mut h, c, QUILL, NEAR * 6 / 10);
    seal(&mut h, c, EMBER, NEAR * 5 / 10);
    // a sealed brief takes no commit-reveal bid
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| commit(&mut h, c, "creator-x.testnet", NEAR)));
    assert!(r.is_err());
    // not before bidding closes
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("anyone.testnet", MIN_RUN_DEPOSIT);
        let _ = h.score_sealed(c);
    }));
    assert!(r.is_err());
    advance(61_000);
    // nobody reveals a sealed bid
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| reveal(&mut h, c, QUILL, NEAR * 6 / 10)));
    assert!(r.is_err());
    ctx("anyone.testnet", MIN_RUN_DEPOSIT);
    let _ = h.score_sealed(c);
    let book = h.get_sealed(c).unwrap();
    assert_eq!(book.status, "scoring");
    let input: Value = serde_json::from_str(book.input.as_ref().unwrap()).unwrap();
    assert_eq!(input["bids"].as_array().unwrap().len(), 3);
    assert_eq!(book.input_hash.as_deref().unwrap(), hex::encode(env::sha256_array(book.input.as_ref().unwrap().as_bytes())));
    // Ember's ciphertext didn't open: its bond is forfeited; Quill wins; Nova's price stays secret
    let answer = scorer_answer(&h, c, Some((1, NEAR * 6 / 10)), vec![true, true, false]);
    ctx_with(HUB, 0, vec![ok()]);
    assert!(matches!(h.on_scored(c, Ok(Some(answer))), PromiseOrValue::Promise(_)));
    let cm = h.get_campaign(c).unwrap();
    assert_eq!((cm.phase.as_str(), cm.winner.as_ref().map(|w| w.as_str())), ("proposing", Some(QUILL)));
    assert_eq!(cm.price.0, NEAR * 6 / 10);
    assert!(cm.bids[1].revealed && cm.bids[1].credible);
    assert!(!cm.bids[0].revealed && cm.bids[0].price.is_none(), "a losing bid is never opened");
    assert_eq!(h.get_wallet(acc(NOVA)).unwrap().locked.0, 0);
    let s = h.get_startup("glow".into()).unwrap();
    assert_eq!(s.forfeits_in.0, BID_BOND);
    let book = h.get_sealed(c).unwrap();
    assert_eq!((book.status.as_str(), book.valid.clone()), ("scored", vec![true, true, false]));
    assert!(book.output_hash.is_some());
}

#[test]
fn a_wrong_or_foreign_answer_is_refused_and_scoring_can_be_asked_again() {
    let (mut h, c) = sealed_brief();
    seal(&mut h, c, NOVA, NEAR * 9 / 10);
    seal(&mut h, c, QUILL, NEAR * 6 / 10);
    advance(61_000);
    ctx("anyone.testnet", MIN_RUN_DEPOSIT);
    let _ = h.score_sealed(c);
    // an answer for another input
    let mut a = scorer_answer(&h, c, Some((1, NEAR * 6 / 10)), vec![true, true]);
    a["input_hash"] = json!("00".repeat(32));
    ctx_with(HUB, 0, vec![ok()]);
    assert!(matches!(h.on_scored(c, Ok(Some(a))), PromiseOrValue::Value(None)));
    assert_eq!(h.get_sealed(c).unwrap().status, "failed");
    // too soon to ask again
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("anyone.testnet", MIN_RUN_DEPOSIT);
        let _ = h.score_sealed(c);
    }));
    assert!(r.is_err());
    advance(RESCORE_AFTER_MS);
    ctx("anyone.testnet", MIN_RUN_DEPOSIT);
    let _ = h.score_sealed(c);
    // a winner whose opening doesn't match its commitment
    let a = scorer_answer(&h, c, Some((1, NEAR * 5 / 10)), vec![true, true]);
    ctx_with(HUB, 0, vec![ok()]);
    assert!(matches!(h.on_scored(c, Ok(Some(a))), PromiseOrValue::Value(None)));
    assert_eq!(h.get_campaign(c).unwrap().phase, "bidding");
    // OutLayer failed (null output)
    advance(RESCORE_AFTER_MS);
    ctx("anyone.testnet", MIN_RUN_DEPOSIT);
    let _ = h.score_sealed(c);
    ctx_with(HUB, 0, vec![ok()]);
    assert!(matches!(h.on_scored(c, Ok(None)), PromiseOrValue::Value(None)));
    // and if it never works, every bond comes back and nobody is opened
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("anyone.testnet", 0);
        h.abandon_sealed(c);
    }));
    assert!(r.is_err(), "OutLayer still has time");
    advance(60_000 + SEALED_GIVE_UP_MS + 1);
    ctx("anyone.testnet", 0);
    h.abandon_sealed(c);
    assert_eq!(h.get_campaign(c).unwrap().phase, "no_bids");
    assert_eq!(h.get_wallet(acc(NOVA)).unwrap().locked.0, 0);
    assert_eq!(h.get_sealed(c).unwrap().status, "abandoned");
}

#[test]
fn sealed_bids_need_the_scorers_key_and_a_well_formed_ciphertext() {
    let mut h = launched();
    assert!(creator(&mut h, NOVA, "Nova"));
    ctx(FOUNDER, 0);
    for _ in 0..6 {
        buy(&mut h, "whale.testnet", 20 * NEAR, None);
    }
    ctx(FOUNDER, 0);
    let c = h.create_campaign("glow".into(), "Night owls".into(), "Bring builders who ship at night".into(), 3, U128(NEAR), 60, 60, 3600);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| seal(&mut h, c, NOVA, NEAR / 2)));
    assert!(r.is_err(), "no scorer yet");
    ctx(HUB, 0);
    h.scorer_set("https://example.org/scorer.wasm".into(), WASM_HASH.into());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| seal(&mut h, c, NOVA, NEAR / 2)));
    assert!(r.is_err(), "the key is not published");
    // a key run that answered something else is not a key
    ctx("anyone.testnet", MIN_RUN_DEPOSIT);
    let _ = h.scorer_publish_key();
    ctx_with(HUB, 0, vec![ok()]);
    assert_eq!(h.on_scorer_key("{}".into(), Ok(Some(json!({ "op": "score", "public_key": BID_KEY })))), None);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("mallory.testnet", 0);
        h.scorer_set("https://evil.example/x.wasm".into(), WASM_HASH.into());
    }));
    assert!(r.is_err(), "owner only");
}
