// Recomputes the thesis numbers from public RPC (no keys, no trust in our server beyond the list of tx hashes):
//   pnpm thesis [baseUrl]      default https://signalfire.lopeselio.online   (--json for raw output)
import { computeThesis, type WireTx } from './thesis.ts';

const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith('--')) ?? 'https://signalfire.lopeselio.online';
const wire = (await (await fetch(`${base}/api/wire`)).json()) as WireTx[];
const t = await computeThesis(wire, { perAction: 8 });
if (args.includes('--json')) { console.log(JSON.stringify(t, null, 2)); process.exit(0); }

console.log(`Signalfire thesis, recomputed ${new Date(t.at).toISOString()} on ${t.network} (hub ${t.hub})\n`);
console.log(`CLAIM  ${t.claim}\n`);
console.log('1. What an agent action costs (gas burnt, read from each transaction\'s receipts on an archival RPC)');
for (const c of t.costs) console.log(`   ${c.action.padEnd(46)} ${c.method.padEnd(16)} median ${c.medianNear} NEAR  max ${c.maxNear}  (n=${c.n})`);
if (t.loopCostNear) console.log(`   one whole campaign (19 transactions): about ${t.loopCostNear} NEAR of gas`);
console.log('\n2. Where the trading fees went (hub state)');
console.log(`   in ${t.fees.inNear} NEAR → creators ${t.fees.toCreatorsNear} (${t.fees.shareToCreatorsPct}%), reserved ${t.fees.reservedNear}, free ${t.fees.freeNear}, founders ${t.fees.toFoundersNear}`);
console.log('\n3. Cost per new buyer, by startup (finished campaigns)');
for (const s of t.startups) console.log(`   ${s.name.padEnd(10)} fees in ${s.feesInNear}  paid ${s.paidNear}  campaigns ${s.campaignsDone}  new buyers ${s.newBuyers}  per buyer ${s.costPerBuyerNear ?? '—'} NEAR`);
console.log('\n4. What bounded the agents (audit log, access keys, wallets)');
const b = t.bounds;
console.log(`   payout attempts ${b.payoutAttempts}: paid ${b.paid}, held by the policy ${b.held}; admissions refused ${b.admissionsRefused}; flags ${JSON.stringify(b.flags)}`);
console.log(`   ${b.agentsFcOnly}/${b.agents} agent accounts hold function-call keys only (${b.fullAccessKeys} full-access keys among them)${b.agentsUnread ? `; ${b.agentsUnread} couldn't be read from the RPC this time` : ''}`);
console.log(`   agent wallets: ${b.walletsSpentNear} NEAR spent in total under ${b.walletsCapDayNear} NEAR/day of caps; the busiest fan spent ${b.fanSpentMaxNear} NEAR over its life, never more than ${b.fanCapDayNear} NEAR in a day (its cap)`);
console.log('\n5. How long it takes (hub timestamps, DAO proposal submission time)');
const l = t.latency;
console.log(`   ${l.campaigns} funded campaigns: DAO proposal → funded median ${l.voteMedianS ?? '—'} s; brief → funded ${l.briefToFundedMedianS ?? '—'} s; brief → last payout ${l.briefToPaidMedianS ?? '—'} s`);
console.log('\n6. Runway (fans that can still be first-time buyers, at the founder agent\'s pace)');
const r = t.runway;
console.log(`   ${r.firstBuysLeft} first buys left → ${r.campaignsLeft} campaigns of ${r.perCampaign} new buyers, one brief every ${r.hoursBetweenBriefs} h → until about ${r.lastsUntil}; ${r.treasuriesFreeNear} NEAR free in treasuries`);
console.log('\nLIMITS');
for (const x of t.limits) console.log(`   - ${x}`);
process.exit(0);
