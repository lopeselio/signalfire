import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { priceAt } from '@signalfire/core';
import { startAgents } from './agents.ts';
import { BA_PATH, accountFromHeaders, authHandler } from './ba.ts';
import { view } from './chain.ts';
import { config, explorerTx, hasKey } from './config.ts';
import { ftBalance } from './hub.ts';
import { attestation, nearAiEnabled } from './nearai.ts';
import { CREATORS, HOLDERS, SCOUT } from './personas.ts';
import { buildProof } from './proof.ts';
import { latest as snapshot, type Snapshot } from './snapshot.ts';
import { bidsFor, getWire, loadVetting, pendingApplicants, setPendingApplicants } from './store.ts';

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

/** Pitches are published only once the chain shows the bid as revealed (they're sealed until then). */
function pitchesOf(s: Snapshot, id: number): Record<string, { pitch: string; signed: boolean; model: string }> {
  const c = s.campaigns.find((x) => x.id === id);
  if (!c) return {};
  const revealed = new Set(c.bids.filter((b) => b.revealed).map((b) => b.creator));
  return Object.fromEntries(bidsFor(id).filter((b) => revealed.has(b.creator)).map((b) => [b.creator, { pitch: b.pitch, signed: !!b.proof.signature, model: b.proof.model }]));
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
    startups: s.startups.map((st) => ({ ...st, price: priceAt(BigInt(st.circulating)).toString(), holders: s.holders[st.id] ?? [] })),
    campaigns: s.campaigns.map((c) => {
      const p = s.proposals[c.id];
      return { ...c, pitches: pitchesOf(s, c.id), proposal: p ? { status: p.status, votes: p.votes, kind: p.kind } : null };
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

// ---------- routes ----------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const post = req.method === 'POST';
  try {
    if (p === BA_PATH || p.startsWith(`${BA_PATH}/`)) { await authHandler(req, res); return; }
    if (p === '/api/health') return json(res, 200, { ok: true, version: process.env.APP_VERSION ?? 'dev' });
    if (p === '/api/state') return json(res, 200, publicState(await snapshot()));
    if (p === '/api/wire') return json(res, 200, getWire().slice(0, 80).map((w) => ({ ...w, url: w.tx ? explorerTx(w.tx) : null })));
    if (p === '/api/audit') {
      const s = await snapshot();
      return json(res, 200, [...s.audit].reverse());
    }
    let m = /^\/api\/startup\/([a-z0-9]{2,8})\/trades$/.exec(p);
    if (m) return json(res, 200, (await snapshot()).trades[m[1]] ?? []);
    if (p === '/api/attestation') return json(res, 200, await attestation());
    if (p === '/api/quote') {
      const startup = url.searchParams.get('startup') ?? '';
      const near = url.searchParams.get('near');
      const tokens = url.searchParams.get('tokens');
      const account = url.searchParams.get('account');
      if (near) return json(res, 200, await view('quote_buy', { startup, near, account: account || null }));
      if (tokens) return json(res, 200, await view('quote_sell', { startup, tokens }));
      return json(res, 400, { error: 'near or tokens' });
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
        audit: s.audit.filter((e) => e.campaign === id),
        txs: getWire().filter((w) => w.campaign === id && w.tx).map((w) => ({ ...w, url: explorerTx(w.tx!) })),
      });
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
        vetting: v ? { report: v.report, reportHash: v.reportHash, model: v.proof.model, signed: !!v.proof.signature, signingAddress: v.proof.signingAddress ?? null, at: v.at } : null,
        campaigns: s.campaigns.filter((x) => x.bids.some((b) => b.creator === account)).map((x) => ({ id: x.id, title: x.title, phase: x.phase, won: x.winner === account, price: x.price, results: x.results })),
      });
    }
    const me = await accountFromHeaders(req.headers);
    if (p === '/api/me') {
      if (!me) return json(res, 401, { error: 'not signed in' });
      const s = await snapshot();
      const tokens = await Promise.all(s.startups.map(async (st) => ({ startup: st.id, balance: await ftBalance(st.token, me), holder: (s.holders[st.id] ?? []).includes(me), founder: st.founder === me })));
      return json(res, 200, {
        accountId: me,
        tokens,
        wallet: await view('get_wallet', { account: me }).catch(() => null),
        creator: s.creators.find((x) => x.creator.account === me) ?? null,
        application: await view('get_application', { account: me }).catch(() => null),
        tusd: s.config.tusd ? await ftBalance(s.config.tusd, me) : '0',
      });
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
