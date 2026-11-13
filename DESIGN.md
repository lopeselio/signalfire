# Signalfire — design

## Pitch

A startup launches an **attention token**. People trade it on a bonding curve. Every trade pays a 2% fee, and
that fee can only land in the startup's **marketing treasury**: there is no method, key or role that sends it to
the founders. Vetted **creators** (people or AI creator agents) compete in **sealed-bid auctions** to run marketing
campaigns paid from that treasury. Token holders vote in the startup's **Sputnik DAO** on which winning bid to fund.
The treasury pays the creator in milestones, only as **attributable results** arrive onchain (new buyers who came
through the campaign's referral code), in a testnet stablecoin, through a **spend policy** with an audit log.

> Community attention becomes a marketing budget the founders can't pocket.

The attention token is **not equity and not a claim on revenue or on the treasury**. It says so in the token's
name, in the contract (`terms()`), and in the UI. Testnet only: no real money anywhere.

Adapted from the Solana Foundation's request for startups "Attention tokens for startup distribution", rebuilt
natively on NEAR (NEP-141, Sputnik DAO v2 via global contracts, function-call keys, NEAR AI Cloud TEE models,
NEP-171, NEP-366 meta-transactions).

## Accounts (testnet)

| Account | What it is |
|---|---|
| `signalfire.testnet` | the **hub** contract (Rust, near-sdk 5.29): launchpad, bonding-curve market, marketing treasuries, spend policy + audit log, sealed-bid campaign auctions, attribution, agent wallets, creator registry, NEP-171 NFTs |
| `<sym>.signalfire.testnet` | a startup's attention token: the NEP-141 global contract `ft.globals.primitives.testnet` (no mint method), whole supply minted to the hub's curve at launch |
| `<sym>-dao.signalfire.testnet` | the startup's Sputnik DAO v2 (global contract `dao.globals.primitives.testnet`): the holders' vote |
| `tusd.signalfire.testnet` | **tUSD**, a clearly-labelled *test* stablecoin (the same global FT; 10M supply held by the hub's payout desk) |
| `signalfire-ref.testnet` | the operator: runs the demo startup, the agent loop, and cranks (anyone may crank) |
| `signalfire-relay.testnet` | pays gas for signed-in users' NEP-366 meta-transactions (better-near-auth relayer) |
| `creator-*.signalfire.testnet` | AI creator agents (function-call keys only) |
| `scout-lens.signalfire.testnet` | the AI scout that vets creators (function-call key only) |
| `holder-*.signalfire.testnet` | AI holder agents (one FC key for the hub, one for their DAO's `act_proposal`) |
| `fan-*.signalfire.testnet` | the simulated audience that buys through referral links (FC keys only) |

The hub creates every startup, agent and fan account itself, so their keys are exactly what the contract added.

## The token and the curve (memecoins)

- Supply: **1,000,000 tokens** (6 decimals; 10¹² raw units), minted once to the hub at launch. The global FT has no
  mint method, so supply can never grow. Founders get **zero**: the whole supply sits on the curve.
- Price per raw unit at circulating supply `x` (raw units): `p(x) = A + B·x` yoctoNEAR, with `A = 10¹⁴`
  (0.0001 NEAR per token) and `B = 10⁴`. Buying from `x0` to `x1` costs
  `cost(x0, x1) = A·(x1−x0) + B·(x1²−x0²)/2` (B is even, so it's exact). The curve reserve always equals
  `cost(0, circulating)`, so every token can always be sold back.
- Buying with `n` NEAR: fee = 2% of `n` (to the treasury); the rest buys `x1 = ⌊(√((A+B·x0)² + 2B·net) − A) / B⌋`;
  the unspent dust is refunded. A first-time buyer also pays the token's storage registration (0.00125 NEAR).
- Selling: `ft_transfer_call` the tokens to the hub; proceeds = `cost(x0−dx, x0)`; 2% fee to the treasury.
- Slippage: `min_tokens_out` on buys, `min_near_out` on sells (the UI sends 1% by default).
- The last 240 trades are kept in a ring on the hub (the price chart reads them from the chain).

`packages/core/src/curve.ts` and `contracts/hub/src/curve.rs` implement the same integer math; a shared vector pins it.

## The marketing treasury and the spend policy (security)

Each startup's treasury is a ledger inside the hub: `available`, `committed` (funded campaigns not yet paid),
`paid`, `fees_in`. Money enters only as trade fees and forfeited bid bonds. **It leaves only one way**: a milestone
payout to the winning creator of a DAO-funded campaign, after the policy checks:

1. **Approved campaigns only**: the campaign was funded by its startup's DAO (`fund_campaign` only accepts the DAO
   account as caller).
2. **Payee allowlist**: the payee is the campaign's winner and is an admitted, not revoked creator.
3. **Per-campaign cap**: total paid ≤ the winning price ≤ the campaign budget ≤ the startup's `campaign_cap`.
4. **Per-payout cap**: a payout above the founder's `max_payout` is **held**.
5. **Rate limit**: more than `payouts_per_hour` payouts in the last hour for that startup → **held**.
6. **Milestones**: 3 milestones; milestone *k* unlocks at ⌈target·k/3⌉ attributed buyers.

Every attempt is written to the onchain **audit log** with its outcome (`paid`, `held:<reason>`) and flags:
`burst` (within 60 s of the startup's previous payout), `new_payee` (first payout ever to this creator),
`over_cap`, `rate_limit`. Creator admission is logged too, with `lookalike` when the account name is one edit (after
mapping 0→o, 1→l, 3→e, 5→s) from an admitted creator; lookalikes are refused.

Founders set constraints only (`set_constraints`: campaign cap, per-payout cap, payouts per hour, credible bid
floor, holder minimum), inside hard limits in the contract. They can't move money.

## The keyless treasury agent (security, privacy)

Payouts in tUSD are sent by an implicit NEAR account whose only key is the Ed25519 key NEAR's MPC network derives
for `signalfire.testnet` and the path `signalfire-treasury-agent` (Chain Signatures, domain 1). No person or server
holds it. `claim_milestone` approves a payout through the spend policy and records an agent action; `agent_sign`
(anyone cranks) has the hub build the agent's transaction (tUSD `ft_transfer_call` of exactly that amount to the hub,
`agent-payout:<id>`) and request the MPC signature; the signed transaction is kept onchain and anyone broadcasts it.
The hub's `ft_on_transfer` forwards a matching delivery to the creator and refunds any other (a second signature of
the same action, a wrong amount, a closed action). After 30 minutes, `agent_fallback` pays from the hub's desk instead.
It is a contract-controlled keyless agent, not a Shade Agent: it runs no code of its own (a Shade Agent, agent code in
a TEE, is a possible next step). State is kept under raw storage keys; the Hub struct is unchanged.

## Agent wallets and keys (security, agents)

Agents never hold a full-access key. The hub creates each agent account with **function-call keys only**, each with a
gas allowance, for the hub's agent methods (and, for holders, `act_proposal` on their DAO). An FC key can't attach a
deposit, so agents spend from an **agent wallet** inside the hub, funded by their owner, with a **per-transaction cap
and a 24-hour cap**. From a wallet an agent can: post bid bonds, pay another agent (`agent_pay`: the scout's vetting
fee, an audience brief), and buy attention tokens (`buy_with_wallet`). Earnings (tUSD payouts) land in the agent
account's own tUSD balance.

## Sealed-bid campaign auctions (swarms, privacy)

1. The founder posts a **brief** (`create_campaign`): title, goal, target (new buyers), budget ≤ cap and ≤ the
   treasury's available NEAR, commit and reveal windows.
2. **Commit**: each admitted creator posts `sha256("signalfire|bid|<campaign>|<creator>|<price>|<pitch_hash>|<salt>")`
   with a 0.02 NEAR bond from its wallet. Price and pitch stay secret.
3. **Reveal**: the creator opens price, pitch hash and salt; the bond returns. A bid is *credible* if
   `budget·min_bid_bps/10⁴ ≤ price ≤ budget`. Unrevealed bonds go to the treasury.
4. **Settle** (anyone): the winner is the lowest `score = price·10⁴ / (10⁴ + rep_bps)`, ties to the earlier commit.
   `rep_bps = clamp(500·completed − 1000·missed, −2000, 3000)`. The hub then files a **FunctionCall proposal** on the
   startup's DAO: call `fund_campaign(campaign_id)` on the hub.
5. **Holders vote** in the DAO; at a majority the DAO calls the hub and the price moves from `available` to `committed`.
6. **Results**: buys made with the campaign's referral code (`c<id>`) by first-time buyers of that token, of at
   least 0.05 NEAR, while the campaign is funded, count as results (the creator's own buys don't).
7. **Payouts** (anyone can crank `claim_milestone`): each milestone pays a third of the price in tUSD. The final one
   mints the **receipt NFT** and updates the creator's record. A funded campaign that misses its deadline returns the
   unpaid part to `available` and counts as a miss.

`packages/core` (bids.ts, auction.ts) and the contract use the same strings and integer scoring (shared vector).

### Sealed bids scored in a TEE (OutLayer)

New briefs use `commit_sealed_bid`: besides the commitment and bond, the creator posts the opening encrypted to an
X25519 key that only `outlayer/scorer` (a WASI program, pinned by sha256 in the hub) can derive inside an OutLayer TEE,
from a keystore key bound to that exact wasm and to the hub as caller. Nobody reveals. After bidding closes,
`score_sealed` sends every ciphertext to `outlayer.testnet` (`request_execution`); `on_scored` accepts only the
winner's opening (checked against its commitment and the credibility rule onchain) and which ciphertexts opened (their
bonds return). Losing prices are never published. Each run has an attestation (wasm hash, input and output hashes in
the TDX quote's task hash) that the UI and `pnpm verify` check. A brief whose first bid is a plain commitment, and
every older campaign, stays commit-reveal. If OutLayer never answers, `abandon_sealed` returns the bonds.

## The DAO (social)

Policy at launch (built by the hub):

- role `signalfire` = {hub}: `call:AddProposal`, `add_member_to_role:AddProposal|VoteApprove`,
  `remove_member_from_role:AddProposal|VoteApprove`. The hub can only propose; it can't vote on spending.
- role `holders` = the initial council (≥1 account): `call:VoteApprove|VoteReject|VoteRemove`.
- default vote policy RoleWeight, threshold ½ (a majority of holders). No `transfer` permission for anyone.

**Joining**: anyone holding at least `min_holder_tokens` calls `join_holders(startup)`; the hub reads the balance from
the token (`ft_balance_of`), files `AddMemberToRole` and approves it with its own role (the only voter for that kind).
**Pruning**: anyone may call `prune_holder(startup, account)`; below the minimum, the hub removes them the same way.
One holder, one vote (Sputnik's RoleWeight), not token-weighted: this keeps whales from buying the vote.

## Creators, vetting and NFTs (privacy, agents, nfts)

- A creator applies with a name and a short profile. The **scout agent** asks a TEE-hosted model on NEAR AI Cloud
  for a vetting report, keeps the request, response and the enclave's signature, and calls
  `vet_creator(account, report_hash)`. The creator's wallet pays the scout 0.01 NEAR for the service.
- **The model never decides money or admission.** The contract admits by rule: the scout is registered, the creator
  has a wallet, the name is not a lookalike of an admitted creator. The report is advice, published with its proof.
- Creator agents' pitches come from the same TEE model; the pitch hash is sealed inside the bid.
- **Private applications.** An applicant may add private details (audience size, past results, contact). The browser
  verifies the model's Ed25519 key by attestation, seals the details to it (NEAR AI E2EE v2) and keeps a receipt (details,
  salt, one-off key). The server forwards ciphertext and deletes it after the call. The scout writes its public note from
  public facts only; a second, end-to-end encrypted call returns only `{fit, private_details, concern}` from fixed enums
  (JSON schema), so the public record can't repeat the details. The report (hashed onchain) carries that verdict and
  `sha256("signalfire|private|<account>|<salt>|<details>")`. The receipt proves later what the model saw.
- **Private AI, verified.** Every vetting report and pitch carries a badge that runs the model's attestation in the
  viewer's browser (`packages/attest`): fresh nonce → `cloud-api.near.ai/v1/attestation/report` → Intel TDX quote
  (dcap-qvl) → signer + nonce in report data → MRCONFIGID = 01‖sha256(app_compose) → RTMR3 replay → NVIDIA NRAS JWTs
  (relayed by `/api/nras`, verified against NVIDIA's JWKS) → the reply's EIP-191 signature recovers to exactly one
  verified signer. `pnpm verify` runs the same checks. Caveat (docs.near.ai): instances of a model share a signing
  key, so this does not prove which instance served a given reply.
- **NFTs (NEP-171 on the hub)**: `creator:<account>` is minted at admission and is soulbound; its metadata is
  **computed from state** at read time (campaigns won, completed, missed, results, paid, reputation).
  `receipt:<campaign>` is minted to the creator when a campaign completes: startup, campaign, spend, results,
  cost per result.

## Stablecoin (realworld)

No testnet stablecoin can be minted on demand (docs.near.org lists none), so Signalfire deploys **tUSD** (global FT,
"Test USD — no value"). The hub's payout desk holds the supply. A payout converts the treasury's NEAR to tUSD at a
fixed test rate (1 NEAR = 3 tUSD, a constant in the contract), keeps that NEAR as the desk's backing, and transfers
the tUSD to the creator. Signed-in users' calls go gasless through the NEP-366 relayer.

## Offchain (server)

Node + tsx. It runs the demo startup, the agent loop, the trading/board API, NEAR AI calls, wallet sign-in
(Better Auth + better-near-auth with a recipient/message/origin check) and the relayer. It keeps JSON records
(salts until reveal, NEAR AI proofs, pitches) under `DATA_DIR`. Everything that moves money or decides a winner is
onchain; the server only proposes, cranks and narrates.

`pnpm verify <campaignId>` reads the hub and the DAO over public RPC and checks a campaign without trusting the
server: every bid opening against its commitment, the winner by the shared scoring rule, the DAO proposal and its
status, every attributed buyer's trade, every payout against the policy and milestones, the receipt NFT, and the
signatures on the NEAR AI reports.

## Evidence and the AI research brief (discovery)

Creators are vetted; founders are not: anyone with a wallet and 1 NEAR can launch and claim any history. So every
startup page has an **Evidence** tab, adapted from the Solana request "Discovery and trading for onchain startup
fundraising": help people look at the team behind a token before they back it, with traceable sources, and use AI
to organize the evidence without presenting speculation as fact.

- **Founder-linked sources, proven.** A founder links GitHub (user, org or `owner/repo`) and X accounts (at launch
  and from the Founder's desk). Proof of control: the founder's wallet signs a NEP-413 message naming the startup,
  the founder account and the link (recipient = the hub, nonce = sha256(message)); the founder publishes the
  resulting `signalfire-proof:…` line from that account (a file in the repository or a gist by its owner; a post by
  the X handle) and pastes the URL. The server fetches it from those hosts only, checks the place belongs to the
  linked account and the signature against one of the founder's **full-access keys** (public RPC). Unproven links
  stay "claimed" and are never fetched for numbers. Links live in the server store with their proofs, published in
  `/api/evidence/<sym>/proof`: a signature by the founder's key is self-certifying, so onchain storage would add
  availability, not trust (and a hub migration this late).
- **Evidence items**, numbered E1…En, each with a source link and a fetch time: founder-linked sources; the founder's
  NEAR account (NearBlocks API v3: creation, transactions, active days) and other startups they launched here;
  shipped work for verified GitHub links (commits in 30/90 days, last push and release, contributors, issues,
  languages, stars; cached 6 h); the onchain record from the hub (treasury, campaigns, cost per new buyer, buyers
  over time, creators). `evidenceHash` = sha256 of the canonical JSON.
- **The research brief.** The TEE model on NEAR AI Cloud gets only the evidence (`evidencePrompt`) and published
  rules, with its output constrained to a JSON schema (observed / reading / gaps / check, bounded). Code then decides
  what is shown (`guardBrief`, packages/core, deterministic): every line must cite existing ids; advice, price talk,
  predictions and fundraising words are removed; every standalone number and date must appear in the cited sources;
  a hedged "observation" moves to the AI reading. Gaps and red flags are first computed by rule (`ruleFlags`: no
  verified links or repository, a founder account under 7 days, a platform-run demo, missed campaigns, a quiet or
  archived repository). The exact request, response and the enclave's signature are stored; the Private AI badge and
  `pnpm verify-brief` check them, and the latter re-runs the guard, recomputes the hash and rule checks, rechecks
  every link proof and re-reads the sources. Rewritten every 6 h and on request (rate-limited).
- **The profile check** (`profileCheck`, rule `profile-check/1`, packages/core): four ratings, each citing the evidence
  it rests on: code activity (verified repositories: Active = 5+ commits in 30 days, or 1+ with 2+ contributors, and a
  push within 30 days of the fetch; Some = any commit in 90 days; None; Not linked), public presence (Verified /
  Claimed only / None), founder account (Established = 90+ days and 50+ transactions; New = 7+ days; Brand new), track
  record (Proven = 3+ delivered, missed at most a third of that, new buyers reached; Some = 1+ delivered; None yet).
  Points 2/1/0; Strong = 6+ with a verified link, active code and a founder account a week old; Moderate = 3+ with a
  verified link; Thin otherwise; Not enough evidence = no proven link and no delivered campaign; a demo startup is at
  most Thin. The brief's prompt receives it as facts with ids to explain; the guard drops a line naming another
  strength. The brief record stores the check, the rule version and `inputsHash` (sha256 of the canonical facts the
  rule reads); `pnpm verify-brief` recomputes them. Not onchain: it is recomputable from the published evidence.
  A claimed, proven or removed founder link rewrites the brief (same rate limits).
- **Discover** filters on verified founder, repository active in 30 days, campaigns delivered and profile strength
  (Moderate or Strong), and sorts by profile strength then the amount of checkable evidence (`summarize`), never by a
  model's opinion. The model decides nothing.

## Trust model: what the chain does not prove

- That a creator's campaign *caused* the buys: attribution is "first-time buyers who used the code". The demo
  audience is our own fan accounts.
- That the NEAR AI report is wise: only that it came from the TEE model unaltered (signature) — and it decides nothing.
- That the operator didn't bid through a creator it controls: the demo creators are our agents; admission is
  rule-based but anyone the scout vets can bid.
- The hub account still has a full-access key on testnet (to iterate). The global FT and Sputnik code are published
  by NEAR's `globals.primitives` accounts; their publisher could update them.
- tUSD is a test token whose only backing is the NEAR the desk keeps; the 1:3 rate is a constant, not an oracle.
- That a research brief is right: only that every kept line cites real evidence and its numbers appear there. A
  verified link proves control of an account, not identity.
- That a "Strong" profile check means a good startup: it counts checkable evidence by a fixed rule, and is not advice.

## Track mapping

| Track | What's real |
|---|---|
| memecoins | NEP-141 token, curve, fee-only-to-treasury, fixed supply, zero founder allocation, supply/fee panel |
| social | a Sputnik DAO per startup; funding = a FunctionCall proposal; holders join/prune by balance |
| security | spend policy, caps, allowlist, rate limit, milestones, audit log with flags, FC-key agents with wallet caps, a keyless payout agent (Chain Signatures) |
| swarms | creator agents bid in commit-reveal auctions; the contract settles by a deterministic rule |
| agents | agents earn tUSD, pay bonds, pay the scout, buy tokens; the scout sells vetting |
| privacy | sealed bids and pitches; TEE-signed reports and pitches with kept proofs; private creator applications only the TEE model reads; losing bids never revealed (OutLayer TEE scoring); the model's attestation verified in the browser and by `verify` |
| business | treasury → procurement (auctions) → payouts runs on rules; humans set constraints |
| realworld | tUSD payouts (labelled test stablecoin), gasless meta-transactions |
| nfts | soulbound dynamic creator NFT, campaign receipt NFTs |
| defi | the bonding-curve market with slippage limits; creators cash tUSD out for NEAR through NEAR Intents in the web app (`token_diff` + `native_withdraw`, settled by `execute_intents` on Signalfire's own testnet Verifier, `signalfire-intents.testnet`) |
| thesis | the public dashboard read live from the chain, with a written thesis |
