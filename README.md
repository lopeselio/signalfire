# Signalfire

**Community attention becomes a marketing budget the founders can't pocket.**

A startup launches an **attention token** on NEAR. People trade it on a bonding curve. Every trade pays a 2% fee,
and the contract sends that fee to one place only: the startup's **marketing treasury**. Vetted creators (people
or AI creator agents) compete in **sealed-bid auctions** to run marketing campaigns; token holders vote in the
startup's **Sputnik DAO** on which winning bid to fund; the treasury pays the creator in a testnet stablecoin,
milestone by milestone, only as **attributable results** arrive onchain, through a **spend policy** with an audit log.
Each finished campaign mints a **receipt NFT** to the creator.

> The attention token is **not equity**, not a claim on revenue, profits or the treasury, and not a promise of
> anything. It says so in its name, in the hub (`terms()`), in the DAO's purpose and in the UI.
> **Testnet only. No real money anywhere.**

Built for NEAR HACKATHON (Nov 2026). Design: [DESIGN.md](DESIGN.md).

- Hub contract (testnet): [`signalfire.testnet`](https://testnet.nearblocks.io/address/signalfire.testnet)
- Demo startup **Glowpath (GLOW)**: token [`glow.signalfire.testnet`](https://testnet.nearblocks.io/address/glow.signalfire.testnet), DAO [`glow-dao.signalfire.testnet`](https://testnet.nearblocks.io/address/glow-dao.signalfire.testnet)
- Test stablecoin: [`tusd.signalfire.testnet`](https://testnet.nearblocks.io/address/tusd.signalfire.testnet) ("Test USD (testnet only, no value)")
- Operator (runs the demo startup and the agents): `signalfire-ref.testnet`. Gasless relayer: `signalfire-relay.testnet`.

TRY_IT_PLACEHOLDER

## Tracks, honestly

| Track | What is real | What is not |
|---|---|---|
| `memecoins` | NEP-141 token per startup; fixed supply, 0% to founders; linear curve; the 2% fee can only reach the marketing treasury; supply & fee panel | no reactive supply beyond the curve |
| `social` | a Sputnik DAO v2 per startup; campaign funding is a `FunctionCall` proposal holders vote on; join/prune by token balance | one holder one vote, not token-weighted (by design) |
| `security` | spend policy (approved campaigns, payee allowlist, per-campaign and per-payout caps, hourly rate limit, milestones), onchain audit log with flags, FC-key-only agents with capped wallets, lookalike refusal (live on testnet) | the hub owner key still exists on testnet |
| `swarms` | three creator agents bid in commit-reveal auctions every brief; the contract settles by a deterministic rule | agents follow simple pricing rules, not learned strategies |
| `agents` | agents earn tUSD, post bonds, buy tokens, and pay the scout for vetting and audience briefs (`agent_pay`) | payments are inside the hub's wallets, not cross-chain |
| `privacy` | sealed bids and sealed pitches; NEAR AI TEE-signed reports and pitches, kept as proofs and checked by `verify` | openings sit on our server until the reveal |
| `business` | treasury → procurement (auctions) → payouts runs by rules; the founder only sets constraints | the founder agent posts briefs from a fixed list |
| `realworld` | creators are paid in a stablecoin-shaped token through a policy; gasless meta-transactions for signed-in users | tUSD is our own labelled test token (no testnet stablecoin can be minted on demand) |
| `nfts` | soulbound creator NFT with metadata computed from live state; receipt NFTs per completed campaign | no royalties or NFT-owned accounts |
| `defi` | the bonding-curve market with slippage limits on both sides | **no NEAR Intents settlement** (we chose not to ship a half integration) |
| `thesis` | a public dashboard read live from the chain, with a written thesis | testnet data from a simulated audience |

## How it works

```
apps/web          React + Vite product UI; wallet sign-in (better-near-auth); guests browse without a wallet
apps/server       API, the agent loop, NEAR AI calls, proof bundles, Better Auth + NEP-366 relayer, setup / e2e / verify CLIs
packages/core     curve math, bid hashes, auction scoring, milestones, spend policy, lookalike names (deterministic, isomorphic)
contracts/hub     Rust near-sdk 5.29: launchpad, curve market, treasuries, spend policy + audit log, auctions, agent wallets, NEP-171
```

**One startup = three accounts, created by the hub in one call (`launch_startup`, 1 NEAR):**

| Account | Code | Role |
|---|---|---|
| `<sym>.signalfire.testnet` | NEAR's global FT (`ft.globals.primitives.testnet`), no mint method | the NEP-141 attention token; all 1,000,000 tokens minted to the hub's curve, **0 to the founder** |
| `<sym>-dao.signalfire.testnet` | Sputnik DAO v2 (`dao.globals.primitives.testnet`) | the holders' vote; nobody may propose or approve a `transfer` |
| the startup's ledger inside `signalfire.testnet` | the hub | curve reserve, marketing treasury (available / committed / paid), campaigns, audit log |

- **The curve (memecoins, defi).** Price per raw unit `p(x) = 10¹⁴ + 10⁴·x` yoctoNEAR (0.0001 NEAR per token at launch). Buys and sells are exact integer integrals, so the reserve always equals the area under the line and every token can be sold back. Buys take `min_tokens_out`, sells (`ft_transfer_call` to the hub) take `min_near_out`. 2% of each side goes to the treasury.
- **The marketing treasury and the spend policy (security, business).** Money enters only as trade fees and forfeited bid bonds. It leaves only through `claim_milestone`, which anyone may crank: to the winning, admitted creator of a campaign the DAO funded; within the winning price, the founder's per-payout cap and payouts-per-hour; one milestone per third of the target. Every attempt goes into the onchain audit log with its outcome (`paid`, `held:over_cap`, `held:rate_limit`, `held:payee_revoked`) and flags (`burst`, `new_payee`, `over_cap`, `rate_limit`; `lookalike` on admissions). The founder's only lever is `set_constraints`, inside hard limits.
- **Sealed-bid campaign auctions (swarms, privacy).** Creators commit `sha256("signalfire|bid|<campaign>|<creator>|<price>|<pitch_hash>|<salt>")` with a 0.02 NEAR bond, then reveal. The contract picks the lowest `price·10⁴/(10⁴+reputation)` among credible bids (≥ the founder's floor, ≤ the budget); unrevealed bonds go to the treasury. The pitch is sealed inside the bid too.
- **The DAO vote (social).** Settling an auction makes the hub file a `FunctionCall` proposal in the startup's DAO: call `fund_campaign(id)` on the hub. Holders vote; at a majority the DAO calls the hub, which reserves the price. Anyone holding the minimum joins with `join_holders` (the hub reads `ft_balance_of`, proposes `AddMemberToRole` and approves it with its own role, the only voter for that kind); `prune_holder` removes people who sold. One holder, one vote.
- **Attribution.** A buy with the campaign's code (`c<id>`), of at least 0.05 NEAR, by a first-time buyer of that token who isn't the creator, while the campaign is funded, is a result. The hub counts it in the same transaction as the trade.
- **Agents (agents, swarms, security).** The hub creates every agent account itself, with **function-call keys only** (and, for holders, one more for `act_proposal` on their DAO). FC keys can't attach NEAR, so agents spend from **hub wallets with a per-transaction and a 24-hour cap**: bid bonds, buying tokens, paying each other (`agent_pay`). Three AI creator agents (Nova, Quill, Ember) bid on every brief; the scout (Lens) sells vetting and audience briefs; three holder agents vote by a plain rule; twelve fan accounts are the simulated audience.
- **NEAR AI (privacy).** The scout's vetting reports and the creators' pitches come from a TEE-hosted model on NEAR AI Cloud (`Qwen/Qwen3.6-35B-A3B-FP8`). Each reply is kept with its exact request/response and the enclave's ECDSA signature; the report's hash goes onchain with `vet_creator`, the pitch's hash inside the sealed bid. **The model never decides money, admission or a winner**: admission is a contract rule (registered scout, fee paid, not a lookalike name), the winner is the scoring rule, votes are the holders'.
- **tUSD (realworld).** NEAR testnet has no stablecoin anyone can mint on demand, so the hub deploys `tusd.signalfire.testnet` from the same global FT, labelled "Test USD (testnet only, no value)". A payout converts the treasury's NEAR at a fixed test rate (1 NEAR = 3 tUSD, a constant in the contract), keeps that NEAR as the desk's backing, and sends tUSD to the creator. Signed-in users' calls go gasless through the NEP-366 relayer (better-near-auth).
- **NFTs (nfts).** `creator:<account>` is minted at admission, is soulbound, and its NEP-177 metadata is **computed from state when read** (won, completed, missed, results, tUSD earned, reputation). `receipt:<campaign>` is minted to the creator when a campaign completes: startup, campaign, spend, results, cost per result, the DAO proposal.
- **Proofs.** `/api/campaign/<id>/proof` publishes what the chain holds only hashes of (bid openings once revealed, pitches, vetting reports) with their TEE signatures. `pnpm verify <id>` checks all of it against the chain it reads itself.

### What the chain does *not* prove

- **That a campaign caused its buys.** A result is "a first-time buyer used the code". The demo audience is our own fan accounts, run by the server.
- **That the model's report is wise**, only that the TEE produced it unaltered, and it decides nothing.
- **That the operator doesn't control a creator.** The demo creators are our agents. Anyone the scout admits can bid, and admission is by rule, but the scout is a registered account we run.
- **The hub account still has a full-access key** on testnet so we can iterate; a production deployment would remove it. The global FT and Sputnik code are published by NEAR's `globals.primitives` accounts, which could update them.
- **tUSD is backed only by the NEAR the desk keeps**, at a constant rate, not an oracle. It has no value.
- Bid openings and pitches live on our server until the reveal; a creator agent whose server dies before revealing loses its bond.

## Tests

```bash
pnpm test             # packages/core: 22 tests (curve, hashes, scoring, milestones, policy, lookalikes; the shared vector)
pnpm contract:test    # contracts/hub: 35 tests (the same shared vector, launch, trades and unwinds, wallets and caps,
                      # vetting and lookalikes, auctions, DAO-only funding, attribution, milestones, held payouts,
                      # failed transfers, expiry, soulbound and dynamic NFTs, solvency)
pnpm typecheck
pnpm e2e              # the whole loop on testnet (needs the operator's and agents' keys)
pnpm verify <id> [url]  # re-check a campaign against the chain, no keys needed
```

## Deploying

- **Contract:** `pnpm contract:build`, then `near contract deploy signalfire.testnet use-file contracts/hub/target/near/signalfire_hub.wasm with-init-call new json-args '{"owner":"signalfire.testnet","operator":"signalfire-ref.testnet","ft_global":"ft.globals.primitives.testnet","dao_global":"dao.globals.primitives.testnet"}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send` (later: `without-init-call`).
- **Testnet setup:** `pnpm setup` (idempotent): tUSD, the scout, the demo startup and its DAO, the agents with their FC keys (saved to `~/.near-credentials/testnet`), the creators' applications, the holders' first GLOW, and some trading volume so the treasury has fees.
- **Hosting:** `scripts/deploy-azure.sh` (Azure Container Apps, one replica; resource group `signalfire`). `scripts/azure-storage.sh` mounts an Azure Files share at `/data` once, so bid openings, pitches, reports and the wire survive redeploys. The agents' FC keys are shipped as one secret; the hub owner's key is not.

## Disclosures

- **Inspiration.** The idea is adapted from the Solana Foundation's request for startups "Attention tokens for startup distribution", rebuilt natively on NEAR (NEP-141 global FT, Sputnik DAO v2 via global contracts, function-call-key agents, NEAR AI Cloud TEE models, NEP-171, NEP-366). No code from any Solana project.
- **Other submission.** The same author also submitted the **NEAR Arcade** ([github.com/lopeselio/near-arcade](https://github.com/lopeselio/near-arcade)), a separate, independent project (a set of games). Signalfire shares no contract, rules or server with it; it reuses the author's own patterns for wallet sign-in (Better Auth + better-near-auth), NEAR AI proofs, Sputnik DAO setup and Azure deployment.
- **Libraries:** React, Vite, better-auth and better-near-auth, near-api-js, near-kit, @noble/hashes, ethers (signature recovery in `verify`), near-sdk and near-contract-standards (Rust). Onchain: NEAR's global FT and Sputnik DAO v2 contracts.

## License

MIT
