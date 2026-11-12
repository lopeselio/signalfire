import { call, rpc, viewOn } from './chain.ts';
import { config, explorerTx } from './config.ts';
import { txHashOf } from './b58.ts';
import { addWire, getState, setState } from './store.ts';

export { txHashOf };

// The keyless treasury agent (contracts/hub/src/keyless.rs). The hub's MPC-derived Ed25519 key controls an
// implicit account nobody holds a key to; the hub asks NEAR's MPC network (Chain Signatures) to sign that account's
// transaction for a payout the spend policy approved. This crank only moves things along, as anyone could:
//   approved  → agent_sign(id, nonce, block_hash)   (the contract fixes what the transaction does)
//   signed    → broadcast the signed transaction     (anyone may; it can only deliver that payout)
//   too late  → agent_fallback(id)                   (the hub pays from its own desk; a late delivery is refunded)

export interface AgentDesk {
  account: string; public_key: string; signer: string; path: string; domain_id: number; enabled: boolean;
  tusd_free: string; last_nonce: number; actions: number; created_ms: number;
}
export interface AgentAction {
  id: number; kind: string; campaign: number; milestone: number; receiver: string; tusd: string; amount: string; audit_n: number;
  status: string; created_ms: number; signed_ms: number | null; done_ms: number | null; signs: number; nonce: number | null;
  tx_hash: string | null; signed_tx: string | null;
}

const AGENT_TIMEOUT_MS = 30 * 60_000;
const RESIGN_AFTER_MS = 3 * 60_000;

export const getDesk = (): Promise<AgentDesk | null> => viewOn<AgentDesk | null>(config.hub, 'get_agent', {}).catch(() => null);
export const getActions = (limit = 50): Promise<AgentAction[]> => viewOn<AgentAction[]>(config.hub, 'get_agent_actions', { limit }).catch(() => []);

/** Where a transaction of the agent's landed: the delivery tx we broadcast, per action. */
export const deliveries = (): Record<string, string> => getState<Record<string, string>>('agent-deliveries', {});

async function keyNonce(account: string, publicKey: string): Promise<number> {
  const r = await rpc<{ nonce: number }>('query', { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: publicKey });
  return r.nonce;
}

/** One pass over the agent's open actions. Called from the agent loop. */
export async function crankAgent(): Promise<void> {
  const desk = await getDesk();
  if (!desk) return;
  const open = (await getActions(20)).filter((a) => ['approved', 'signing', 'signed'].includes(a.status)).reverse();
  for (const a of open) {
    const now = Date.now();
    if (now - a.created_ms > AGENT_TIMEOUT_MS + 10_000) {
      await call(config.operator, 'agent_fallback', { id: a.id }, 120)
        .then((r) => addWire({ who: 'Signalfire', what: `paid milestone ${a.milestone} of #${a.campaign} from the hub's own desk: the keyless agent hadn't delivered in 30 minutes`, tx: r.tx, kind: 'payout', campaign: a.campaign }))
        .catch((e: Error) => console.warn(`agent_fallback ${a.id}: ${e.message}`));
      continue;
    }
    const stale = a.signed_ms !== null && now - a.signed_ms > RESIGN_AFTER_MS + 5_000;
    if (a.status === 'approved' || ((a.status === 'signed' || a.status === 'signing') && stale)) {
      try {
        const nonce = Math.max(await keyNonce(desk.account, desk.public_key), desk.last_nonce) + 1;
        const block = await rpc<{ header: { hash: string } }>('block', { finality: 'final' });
        const r = await call<boolean>(config.operator, 'agent_sign', { id: a.id, nonce, block_hash: block.header.hash }, 150, 1n);
        addWire({ who: 'Signalfire', what: `asked NEAR's MPC network to sign the keyless agent's payout of milestone ${a.milestone} of #${a.campaign} (action ${a.id})${r.value === false ? ': no valid signature yet' : ''}`, tx: r.tx, kind: 'agent', campaign: a.campaign });
      } catch (e) { console.warn(`agent_sign ${a.id}: ${(e as Error).message}`); }
      continue;
    }
    if (a.status === 'signed') {
      const full = await viewOn<AgentAction | null>(config.hub, 'get_agent_action', { id: a.id }).catch(() => null);
      if (!full?.signed_tx || !full.tx_hash) continue;
      const hash = txHashOf(full.tx_hash);
      if (deliveries()[a.id] === hash) continue; // already sent; wait for the delivery or a re-sign
      try {
        const out = await rpc<{ status: { Failure?: unknown } }>('send_tx', { signed_tx_base64: full.signed_tx, wait_until: 'EXECUTED_OPTIMISTIC' });
        setState('agent-deliveries', { ...deliveries(), [a.id]: hash });
        const tusd = (Number(a.tusd) / 1e6).toFixed(2);
        addWire({ who: 'keyless agent', what: `paid ${tusd} tUSD for milestone ${a.milestone} of #${a.campaign} to ${a.receiver.replace(`.${config.hub}`, '')} (a transaction only NEAR's MPC network could sign)${out.status?.Failure ? ' — failed' : ''}`, tx: hash, kind: 'payout', campaign: a.campaign });
      } catch (e) {
        // an expired block hash or a used nonce: re-sign after RESIGN_AFTER_MS
        console.warn(`agent broadcast ${a.id}: ${(e as Error).message}`);
        setState('agent-deliveries', { ...deliveries(), [a.id]: hash });
      }
    }
  }
}

/** What the treasury page shows, with everything a visitor needs to check it. */
let infoCache: { at: number; p: Promise<unknown> } | null = null;
/** Cached for 15 seconds: every visitor's treasury page polls it, and it costs several RPC reads. */
export function agentInfo(): Promise<unknown> {
  if (!infoCache || Date.now() - infoCache.at > 15_000) {
    const p = readAgentInfo();
    infoCache = { at: Date.now(), p };
    p.catch(() => { if (infoCache?.p === p) infoCache = null; });
  }
  return infoCache.p;
}

async function readAgentInfo(): Promise<unknown> {
  const desk = await getDesk();
  if (!desk) return { desk: null };
  const [actions, keys, derived, tusd] = await Promise.all([
    getActions(30),
    rpc<{ keys: { public_key: string; access_key: { permission: unknown } }[] }>('query', { request_type: 'view_access_key_list', finality: 'final', account_id: desk.account }).then((r) => r.keys).catch(() => []),
    viewOn<string>(desk.signer, 'derived_public_key', { path: desk.path, predecessor: config.hub, domain_id: desk.domain_id }).catch(() => null),
    viewOn<string>(`tusd.${config.hub}`, 'ft_balance_of', { account_id: desk.account }).catch(() => null),
  ]);
  const sent = deliveries();
  return {
    desk,
    tusdBalance: tusd,
    derivedKey: derived,
    keys: keys.map((k) => ({ publicKey: k.public_key, fullAccess: k.access_key.permission === 'FullAccess' })),
    actions: actions.map((a) => {
      const hash = a.tx_hash ? txHashOf(a.tx_hash) : null;
      return { ...a, txHash: hash, txUrl: hash && (a.status === 'paid' || sent[a.id] === hash) ? explorerTx(hash) : null };
    }),
  };
}
