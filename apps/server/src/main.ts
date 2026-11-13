import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fmtTusd, openingMatches, pitchHash, priceAt } from '@signalfire/core';
import { BRIEF_EVERY_MS, BRIEF_SAME_STARTUP_MS, outlayerRequestId, outlayerRuns, startAgents } from './agents.ts';
import { BA_PATH, accountFromHeaders, authHandler, authOrigin, recentRelays } from './ba.ts';
import { createActivity, sinceFilter } from './activity.ts';
import { ftBalance, getProposal, holdersOf } from './hub.ts';
import { llmsTxt } from './llms.ts';
import { rpc, view, viewNow } from './chain.ts';
import { config, explorerTx, hasKey } from './config.ts';
import { evidenceRoute } from './evidence/routes.ts';
import { discussRoute, loadThread, rolesFrom } from './discuss.ts';
import { NRAS_URL } from '@signalfire/attest';
import { attestation, modelE2eeKey, nearAiEnabled, type Signed } from './nearai.ts';
import { BRIEFS, CREATORS, HOLDERS, SCOUT } from './personas.ts';
import { agentInfo } from './keyless.ts';
import { buildProof, vettingProof } from './proof.ts';
import { computeThesis, type Thesis } from './thesis.ts';
import { cashOutInfo, settleCashOut, type CashOutRequest } from './cashout.ts';
import { latest as snapshot, peek, type Snapshot } from './snapshot.ts';
import { addWire, bidsFor, getState, getWire, loadBid, loadVetting, pendingApplicants, saveBid, savePrivateApp, setPendingApplicants, setState, tourStore } from './store.ts';
import { LIMITS as TOUR_LIMITS, rateLimiter, tourRoute } from './tour.ts';

// ---------- tiny HTTP helpers ----------

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
export async function body<T>(req: IncomingMessage, max = 20_000): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error('request too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(config.webDist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(normalize(config.webDist))) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(config.webDist, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('web app not built: pnpm build'); return; }
  const immutable = file.includes(`${join(config.webDist, 'assets')}`);
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  createReadStream(file).pipe(res);
}

// ---------- the public state ----------

// Display only (the chain keeps its own text): the first two campaigns were end-to-end test runs titled with their
// date, and the first payouts' audit notes carry tUSD in raw units ("65208 tUSD (6 dp)").
const showTitle = (c: { id: number; title: string }): string => (/^E2E \d{4}-\d{2}-\d{2}/.test(c.title) ? `Launch test (end-to-end run ${c.id + 1})` : c.title);
const showNote = (note: string): string => note.replace(/(\d+) tUSD \(6 dp\)/g, (_, raw: string) => `${fmtTusd(raw)} tUSD`);
const showAudit = <T extends { note: string }>(e: T): T => ({ ...e, note: showNote(e.note) });

/** Pitches are published only once the chain shows the bid as revealed (they're sealed until then). */
function pitchesOf(s: Snapshot, id: number): Record<string, { pitch: string; signed: boolean; model: string }> {
  const c = s.campaigns.find((x) => x.id === id);
  if (!c) return {};
  const revealed = new Set(c.bids.filter((b) => b.revealed).map((b) => b.creator));
  return Object.fromEntries(bidsFor(id).filter((b) => revealed.has(b.creator)).map((b) => [b.creator, { pitch: b.pitch, signed: !!b.proof.signature, model: b.human ? 'creator' : b.proof.model }]));
}

/**
 * When the founder agent may post its next brief: after the gap since the last one and once some startup's own gap
 * has passed. An estimate for the onboarding's waiting states: it also waits for running campaigns to finish, a
 * treasury with enough free NEAR and fans who can still buy.
 */
function briefSchedule(s: Snapshot): { auto: boolean; everyMin: number; nextAt: number | null; startup: string | null } {
  const everyMin = Math.round(BRIEF_EVERY_MS / 60_000);
  const auto = config.agents && config.autoBriefs && hasKey(config.operator);
  const mine = s.startups.filter((st) => st.founder === config.operator && st.status === 'live' && BRIEFS[st.id]?.length);
  if (!auto || mine.length === 0) return { auto: false, everyMin, nextAt: null, startup: null };
  const lastBy = getState<Record<string, number>>('last-brief-by', {});
  const soonest = Math.min(...mine.map((st) => (lastBy[st.id] ?? 0) + BRIEF_SAME_STARTUP_MS));
  // the founder agent serves the startup that waited longest first
  const next = [...mine].sort((x, y) => (lastBy[x.id] ?? 0) - (lastBy[y.id] ?? 0))[0];
  return { auto, everyMin, nextAt: Math.max(getState<number>('last-brief', 0) + BRIEF_EVERY_MS, soonest), startup: next.id };
}

function publicState(s: Snapshot) {
  const totals = { feesIn: 0n, available: 0n, committed: 0n, paid: 0n, volume: 0n, results: 0, funded: 0, done: 0 };
  for (const st of s.startups) {
    totals.feesIn += BigInt(st.fees_in) + BigInt(st.forfeits_in);
    totals.available += BigInt(st.available);
    totals.committed += BigInt(st.committed);
    totals.paid += BigInt(st.paid);
    totals.volume += BigInt(st.volume);
  }
  for (const c of s.campaigns) {
    if (['funded', 'done', 'expired'].includes(c.phase)) totals.funded++;
    if (c.phase === 'done') { totals.done++; totals.results += c.results; }
  }
  const doneSpend = s.campaigns.filter((c) => c.phase === 'done').reduce((a, c) => a + BigInt(c.price), 0n);
  return {
    at: s.at,
    network: config.network,
    hub: config.hub,
    operator: config.operator,
    demo: config.demo,
    tusd: s.config.tusd,
    terms: s.config.terms,
    nearAi: nearAiEnabled(),
    nearAiModel: config.nearAi.model,
    relayer: hasKey(config.relayer) ? config.relayer : null,
    briefs: briefSchedule(s),
    startups: s.startups.map((st) => ({ ...st, price: priceAt(BigInt(st.circulating)).toString(), holders: s.holders[st.id] ?? [] })),
    campaigns: s.campaigns.map((c) => {
      const p = s.proposals[c.id];
      return { ...c, title: showTitle(c), pitches: pitchesOf(s, c.id), proposal: p ? { status: p.status, votes: p.votes, kind: p.kind } : null };
    }),
    creators: s.creators.map((c) => ({ ...c, vetted: !!loadVetting(c.creator.account) })),
    agents: {
      creators: CREATORS.map((c) => ({ name: c.name, account: c.account, title: c.title, wallet: s.wallets[c.account] ?? null })),
      scout: { ...SCOUT, wallet: s.wallets[SCOUT.account] ?? null },
      holders: HOLDERS.map((h) => ({ name: h.name, account: h.account, wallet: s.wallets[h.account] ?? null })),
      fans: Object.entries(s.wallets).filter(([a]) => a.startsWith('fan-')).length,
    },
    solvency: s.solvency,
    totals: {
      feesIn: totals.feesIn.toString(), available: totals.available.toString(), committed: totals.committed.toString(), paid: totals.paid.toString(),
      volume: totals.volume.toString(), results: totals.results, funded: totals.funded, done: totals.done, desk: s.config.desk_reserve, tusdPaid: s.config.tusd_paid,
      costPerResult: totals.results > 0 ? (doneSpend / BigInt(totals.results)).toString() : null,
    },
  };
}

const reply = (x: Signed) => ({
  model: x.model, request: x.request, response: x.response, signedText: x.signedText ?? null, signature: x.signature ?? null, signingAddress: x.signingAddress ?? null,
  signingAlgo: x.signingAlgo ?? 'ecdsa', e2ee: x.e2ee ?? null, at: x.at,
});
// The thesis evidence reads ~50 transactions from an archival RPC and a few hundred views: computed at boot and every
// 10 minutes in the background, so the dashboard never waits on it.
let thesisGood: Thesis | null = null;
let thesisRun: Promise<Thesis> | null = null;
function refreshThesis(): Promise<Thesis> {
  thesisRun ??= computeThesis(getWire()).then((t) => { thesisGood = t; return t; }).finally(() => { thesisRun = null; });
  return thesisRun;
}
setTimeout(() => void refreshThesis().catch((e: Error) => console.warn(`thesis: ${e.message}`)), 20_000).unref();
setInterval(() => void refreshThesis().catch((e: Error) => console.warn(`thesis: ${e.message}`)), 600_000).unref();

const tourAllow = rateLimiter();

// A startup's live activity (trades, holders, votes, campaign events): cheap reads, one build per startup shared by
// every viewer for 1.5 s (activity.ts). Reads skip the snapshot's queue (viewNow) so a slow rebuild can't stall the tape.
const activity = createActivity({
  hub: config.hub,
  startup: (id) => viewNow(config.hub, 'get_startup', { id }),
  trades: (id) => viewNow(config.hub, 'get_trades', { startup: id, limit: 240 }),
  campaigns: (id) => viewNow(config.hub, 'get_campaigns', { startup: id, from: 0, limit: 100 }),
  council: (dao) => holdersOf(dao),
  balance: (token, account) => ftBalance(token, account),
  proposal: (dao, id) => getProposal(dao, id),
  snapshotProposal: (c) => peek()?.proposals[c],
  audit: () => peek()?.audit ?? [],
  wire: () => getWire(),
  relays: () => recentRelays(),
  discussion: (id) => loadThread({ dataDir: config.dataDir, roles: async () => null, me: async () => null, writes: false, origin: null }, id),
  creators: CREATORS,
  holderAgents: HOLDERS,
});

const sealedCache = new Map<number, { status: string } | null>();
let scorerCache: { at: number; v: unknown } | null = null;

// ---------- routes ----------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const post = req.method === 'POST';
  try {
    if (p === BA_PATH || p.startsWith(`${BA_PATH}/`)) { await authHandler(req, res); return; }
    if (p === '/api/health') return json(res, 200, { ok: true, version: process.env.APP_VERSION ?? 'dev' });
    if (p === '/api/state') return json(res, 200, publicState(await snapshot()));
    if ((p.startsWith('/api/evidence') || p.startsWith('/api/reply/brief/')) && (await evidenceRoute(req, res, p, () => accountFromHeaders(req.headers)))) return;
    if (p.startsWith('/api/campaign/') && p.includes('/discussion') && (await discussRoute(req, res, p, {
      dataDir: config.dataDir, roles: async (id) => rolesFrom(await snapshot(), id), me: () => accountFromHeaders(req.headers),
      writes: config.discussWrites, origin: authOrigin,
    }))) return;
    if (p === '/api/wire') return json(res, 200, getWire().slice(0, 80).map((w) => ({ ...w, what: w.what.replace(/"(E2E [^"]+)"/, (_, t: string) => `"${showTitle({ id: w.campaign ?? 0, title: t })}"`), url: w.tx ? explorerTx(w.tx) : null })));
    if (p === '/api/thesis') {
      // recomputed at most every 10 minutes (it reads ~50 transactions from an archival RPC)
      // the last good computation at once (refreshed in the background); the first request waits for the first one
      if (thesisGood) return json(res, 200, thesisGood);
      return json(res, 200, await refreshThesis());
    }
    if (p === '/api/audit') {
      const s = await snapshot();
      return json(res, 200, [...s.audit].reverse().map(showAudit));
    }
    if (p === '/llms.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' });
      const host = String(req.headers.host ?? 'signalfire.lopeselio.online');
      const proto = String(req.headers['x-forwarded-proto'] ?? (/^(localhost|127\.)/.test(host) ? 'http' : 'https')).split(',')[0];
      res.end(llmsTxt(config.hub, `${proto}://${host}`));
      return;
    }
    let m: RegExpExecArray | null = /^\/api\/s\/([a-z0-9]{2,8})\/(activity|holders)$/.exec(p);
    if (m) {
      // the startup page polls this every 2 s; agents read it too. Shared for 1.5 s across callers (activity.ts).
      // an id the last snapshot doesn't know is answered without a chain read (no read amplification, no cache growth)
      const known = peek()?.startups;
      if (known && !known.some((x) => x.id === m![1])) return json(res, 404, { error: 'no such startup' });
      const a = await activity.get(m[1]);
      if (!a) return json(res, 404, { error: 'no such startup' });
      if (m[2] === 'holders') return json(res, 200, { startup: a.startup, at: a.at, stale: a.stale, ...a.holders, votes: a.votes });
      const since = Number(url.searchParams.get('since'));
      return json(res, 200, sinceFilter(a, Number.isFinite(since) && since > 0 ? since : null));
    }
    m = /^\/api\/startup\/([a-z0-9]{2,8})\/trades$/.exec(p);
    if (m) return json(res, 200, (await snapshot()).trades[m[1]] ?? []);
    if (p === '/api/attestation') return json(res, 200, await attestation());
    if (p === '/api/agent') return json(res, 200, await agentInfo());
    if (p === '/api/nras' && post) {
      // NVIDIA's attestation service refuses browser origins, so a browser verifying a model asks us to carry its
      // GPU evidence there. We forward it unchanged and return NVIDIA's signed JWTs; the browser checks their
      // signatures against NVIDIA's keys and its own nonce, so a relayed answer can't be forged.
      const payload = await body<unknown>(req, 400_000);
      const r = await fetch(NRAS_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
      return json(res, r.ok ? 200 : 502, r.ok ? await r.json() : { error: `NRAS HTTP ${r.status}` });
    }
    m = /^\/api\/reply\/vetting\/([a-z0-9._-]{2,64})$/.exec(p);
    if (m) {
      // a vetting report's exact NEAR AI request, reply and TEE signature, so a browser can check the signature
      const v = loadVetting(m[1]);
      return v && v.proof.model !== 'none' ? json(res, 200, reply(v.proof)) : json(res, 404, { error: 'no signed report' });
    }
    m = /^\/api\/reply\/private\/([a-z0-9._-]{2,64})$/.exec(p);
    if (m) {
      // a private application's end-to-end encrypted call: the request is ciphertext (only the TEE could read the
      // details), the reply opens with the published one-off client key and is a score and fixed phrases only
      const v = loadVetting(m[1]);
      return v?.privateProof ? json(res, 200, reply(v.privateProof)) : json(res, 404, { error: 'no private application' });
    }
    m = /^\/api\/reply\/pitch\/(\d{1,6})\/([a-z0-9._-]{2,64})$/.exec(p);
    if (m) {
      // a pitch's NEAR AI proof: sealed until the chain shows the bid revealed, like the pitch itself
      const id = Number(m[1]);
      const c = (await snapshot()).campaigns.find((x) => x.id === id);
      const b = loadBid(id, m[2]);
      if (!c?.bids.some((x) => x.creator === m![2] && x.revealed) || !b || b.human || b.proof.model === 'none') return json(res, 404, { error: 'no revealed, signed pitch' });
      return json(res, 200, reply(b.proof));
    }
    if (p === '/api/quote') {
      const startup = url.searchParams.get('startup') ?? '';
      const near = url.searchParams.get('near');
      const tokens = url.searchParams.get('tokens');
      const account = url.searchParams.get('account');
      if (near) return json(res, 200, await view('quote_buy', { startup, near, account: account || null }));
      if (tokens) return json(res, 200, await view('quote_sell', { startup, tokens }));
      return json(res, 400, { error: 'near or tokens' });
    }
    m = /^\/api\/campaign\/(\d{1,6})\/sealed-run$/.exec(p);
    if (m && post) {
      // anyone who cranked score_sealed themselves tells us the transaction; we read it from the chain, check it is
      // the hub's score_sealed for this campaign, and keep OutLayer's request id from its logs (for the attestation)
      const id = Number(m[1]);
      const { tx, signer } = await body<{ tx?: string; signer?: string }>(req, 500);
      if (typeof tx !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(tx) || typeof signer !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(signer)) return json(res, 400, { error: 'tx, signer' });
      const t = await rpc<{ transaction: { receiver_id: string; actions: { FunctionCall?: { method_name: string; args: string } }[] }; receipts_outcome: { outcome: { logs: string[] } }[] }>('tx', { tx_hash: tx, sender_account_id: signer, wait_until: 'FINAL' });
      const fc = t.transaction.actions[0]?.FunctionCall;
      const args = fc ? JSON.parse(Buffer.from(fc.args, 'base64').toString('utf8')) as { campaign_id?: number } : {};
      if (t.transaction.receiver_id !== config.hub || fc?.method_name !== 'score_sealed' || args.campaign_id !== id) return json(res, 400, { error: 'not a score_sealed call for this campaign' });
      const requestId = outlayerRequestId(t.receipts_outcome.flatMap((r) => r.outcome.logs));
      if (requestId === null) return json(res, 400, { error: 'no OutLayer request in that transaction' });
      const runs = outlayerRuns();
      if (!(runs[id] ?? []).some((r) => r.tx === tx)) setState('outlayer-runs', { ...runs, [id]: [...(runs[id] ?? []), { requestId, tx, at: Date.now() }] });
      return json(res, 200, { ok: true, requestId });
    }
    m = /^\/api\/campaign\/(\d{1,6})\/sealed$/.exec(p);
    if (m) {
      // a brief scored by OutLayer: the hub's record of it, the scorer, and the runs' request ids (for their attestations)
      const id = Number(m[1]);
      const phase = (await snapshot()).campaigns.find((x) => x.id === id)?.phase;
      // a settled brief's record no longer changes: read it from the chain once
      const hit = sealedCache.get(id);
      const book = hit !== undefined ? hit : await view<{ status: string } | null>('get_sealed', { campaign_id: id });
      if (phase && phase !== 'bidding' && (book === null || book.status === 'scored' || book.status === 'abandoned')) sealedCache.set(id, book);
      if (!scorerCache || Date.now() - scorerCache.at > 60_000) scorerCache = { at: Date.now(), v: await view('get_scorer', {}).catch(() => null) };
      return json(res, 200, { book, scorer: scorerCache.v, runs: outlayerRuns()[id] ?? [], keyRequest: config.scorerKeyRequest, outlayerApi: 'https://testnet-api.outlayer.ai' });
    }
    m = /^\/api\/campaign\/(\d{1,6})(\/proof)?$/.exec(p);
    if (m) {
      const id = Number(m[1]);
      if (m[2]) {
        const b = await buildProof(id);
        return b ? json(res, 200, b) : json(res, 404, { error: 'no such campaign' });
      }
      const s = await snapshot();
      const c = s.campaigns.find((x) => x.id === id);
      if (!c) return json(res, 404, { error: 'no such campaign' });
      return json(res, 200, {
        ...c,
        pitches: pitchesOf(s, id),
        proposal: s.proposals[id] ?? null,
        audit: s.audit.filter((e) => e.campaign === id).map(showAudit),
        txs: getWire().filter((w) => w.campaign === id && w.tx).map((w) => ({ ...w, url: explorerTx(w.tx!) })),
      });
    }
    m = /^\/api\/creator\/([a-z0-9._-]{2,64})\/proof$/.exec(p);
    if (m) {
      const v = loadVetting(m[1]);
      if (!v) return json(res, 404, { error: 'no vetting report' });
      return json(res, 200, { hub: config.hub, ...vettingProof(v) });
    }
    m = /^\/api\/creator\/([a-z0-9._-]{2,64})$/.exec(p);
    if (m) {
      const account = m[1];
      const s = await snapshot();
      const c = s.creators.find((x) => x.creator.account === account) ?? null;
      const v = loadVetting(account);
      const nfts = await view('nft_tokens_for_owner', { account_id: account, from_index: null, limit: 50 }).catch(() => []);
      return json(res, 200, {
        creator: c, nfts,
        vetting: v ? {
          report: v.report, reportHash: v.reportHash, model: v.proof.model, signed: !!v.proof.signature, signingAddress: v.proof.signingAddress ?? null, at: v.at,
          privateCommitment: v.privateCommitment ?? null, privateVerdict: v.privateVerdict ?? null, privateDropped: !!v.privateDropped,
        } : null,
        campaigns: s.campaigns.filter((x) => x.bids.some((b) => b.creator === account)).map((x) => ({ id: x.id, title: showTitle(x), phase: x.phase, won: x.winner === account, price: x.price, results: x.results })),
      });
    }
    if (p === '/api/opening' && post) {
      // a person revealed a bid sealed in their browser: publish the opening (price, pitch, salt) so anyone can
      // check it. Accepted only once the chain shows the bid revealed, and only if it hashes to that commitment.
      const o = await body<{ campaign?: number; creator?: string; price?: string; pitch?: string; salt?: string }>(req, 4000);
      if (typeof o.campaign !== 'number' || typeof o.creator !== 'string' || typeof o.price !== 'string' || typeof o.pitch !== 'string' || typeof o.salt !== 'string') return json(res, 400, { error: 'campaign, creator, price, pitch, salt' });
      if (o.pitch.length === 0 || o.pitch.length > 400) return json(res, 400, { error: 'pitch: 1 to 400 characters' });
      const c = await view<{ bids: { creator: string; hash: string; revealed: boolean }[] } | null>('get_campaign', { id: o.campaign });
      const b = c?.bids.find((x) => x.creator === o.creator);
      if (!b) return json(res, 404, { error: 'no such bid onchain' });
      if (!b.revealed) return json(res, 409, { error: 'reveal onchain first; the opening stays private until then' });
      const ph = pitchHash(o.pitch);
      const opening = { campaign: o.campaign, creator: o.creator, price: o.price, pitch: o.pitch, pitchHash: ph, salt: o.salt, hash: b.hash };
      if (!openingMatches(opening, b.hash)) return json(res, 400, { error: 'this opening does not match the sealed commitment' });
      const had = loadBid(o.campaign, o.creator);
      if (!had) {
        saveBid({ ...opening, human: true, proof: { who: o.creator, text: o.pitch, model: 'none', request: '', response: '', at: Date.now() } });
        addWire({ who: o.creator.replace(`.${config.hub}`, ''), what: `published their opened offer on #${o.campaign} so anyone can check it`, kind: 'reveal', campaign: o.campaign });
      }
      return json(res, 200, { ok: true, stored: !had });
    }
    const me = await accountFromHeaders(req.headers);
    if (p === '/api/intents/info') {
      const pk = url.searchParams.get('publicKey');
      return json(res, 200, await cashOutInfo(me, pk && /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(pk) ? pk : null));
    }
    if (p === '/api/intents/cashout' && post) {
      // a signed-in creator's signed cash-out intent: the desk co-signs and the Verifier settles (cashout.ts)
      if (!me) return json(res, 401, { error: 'sign in first' });
      const b = await body<CashOutRequest>(req, 8000);
      if (![b.amount, b.message, b.nonce, b.recipient, b.publicKey, b.signature].every((x) => typeof x === 'string') || !/^\d{1,20}$/.test(b.amount)) return json(res, 400, { error: 'amount, message, nonce, recipient, publicKey, signature' });
      try { return json(res, 200, await settleCashOut(me, b)); } catch (e) { return json(res, 409, { error: (e as Error).message }); }
    }
    if (p === '/api/me/tour') {
      // the onboarding tour's memory for the signed-in account, so progress follows it across browsers (tour.ts)
      let raw: string | null = '';
      if (req.method !== 'GET') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) { size += (c as Buffer).length; if (size > TOUR_LIMITS.bytes) { raw = null; break; } chunks.push(c as Buffer); }
        if (raw !== null) raw = Buffer.concat(chunks).toString('utf8');
      }
      const r = tourRoute(req.method ?? 'GET', me, raw, Date.now(), tourStore, tourAllow);
      return json(res, r.code, r.body);
    }
    if (p === '/api/me') {
      if (!me) return json(res, 401, { error: 'not signed in' });
      const s = await snapshot();
      // the person is waiting: these reads skip the background queue (viewNow) and run together
      const bal = (token: string): Promise<string> => viewNow<string>(token, 'ft_balance_of', { account_id: me }).catch(() => '0');
      const [tokens, wallet, application, tusd] = await Promise.all([
        Promise.all(s.startups.map(async (st) => ({ startup: st.id, balance: await bal(st.token), holder: (s.holders[st.id] ?? []).includes(me), founder: st.founder === me }))),
        viewNow(config.hub, 'get_wallet', { account: me }).catch(() => null),
        viewNow(config.hub, 'get_application', { account: me }).catch(() => null),
        s.config.tusd ? bal(s.config.tusd) : Promise.resolve('0'),
      ]);
      return json(res, 200, { accountId: me, tokens, wallet, creator: s.creators.find((x) => x.creator.account === me) ?? null, application, tusd });
    }
    if (p === '/api/e2ee-key') {
      // the model key this server would seal to; browsers verify the model's attestation themselves and must match it
      if (!nearAiEnabled()) return json(res, 503, { error: 'NEAR AI is off on this server' });
      return json(res, 200, { model: config.nearAi.model, key: await modelE2eeKey() });
    }
    if (p === '/api/private-application' && post) {
      // A signed-in applicant's private details, sealed in their browser to the model's attested Ed25519 key. We
      // can't open it; it waits on disk only until the scout's call, then it's deleted.
      if (!me) return json(res, 401, { error: 'sign in first' });
      const o = await body<{ sealed?: string; modelPub?: string; commitment?: string }>(req, 12_000);
      if (typeof o.sealed !== 'string' || !/^[0-9a-f]{146,8000}$/.test(o.sealed)) return json(res, 400, { error: 'sealed: hex ciphertext' });
      if (typeof o.commitment !== 'string' || !/^[0-9a-f]{64}$/.test(o.commitment)) return json(res, 400, { error: 'commitment: 64 hex' });
      if (typeof o.modelPub !== 'string' || o.modelPub !== await modelE2eeKey()) return json(res, 409, { error: 'sealed to a key that is not the model\'s current attested key; reload and try again' });
      if ((await snapshot()).creators.some((c) => c.creator.account === me)) return json(res, 409, { error: 'already admitted' });
      savePrivateApp({ account: me, sealed: o.sealed, modelPub: o.modelPub, commitment: o.commitment, at: Date.now() });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/applied' && post) {
      // a signed-in person applied as a creator from their wallet: put them in the scout's queue
      if (!me) return json(res, 401, { error: 'sign in first' });
      const app = await view('get_application', { account: me }).catch(() => null);
      if (!app) return json(res, 400, { error: 'no application onchain yet' });
      setPendingApplicants([...pendingApplicants(), me]);
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    serveStatic(req, res);
  } catch (e) {
    const code = (e as { code?: number }).code;
    json(res, typeof code === 'number' ? code : 400, { error: (e as Error).message });
  }
}

const server = createServer((req, res) => { void route(req, res); });
server.listen(config.port, () => {
  console.log(`Signalfire on :${config.port} (hub ${config.hub}, demo ${config.demo}, NEAR AI ${nearAiEnabled() ? 'on' : 'off'})`);
});
startAgents();
