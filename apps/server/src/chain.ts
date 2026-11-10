import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPairSigner, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { config, privateKey } from './config.ts';

// Contract calls. A signer is an account, or "account#dao" for a holder agent's DAO key. Each key's calls
// run one after another so its nonces never collide.

// several public testnet RPCs (docs.near.org/api/rpc/providers); on an error the next one is tried
const RPCS = [config.rpcUrl, 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs'].filter((u, i, a) => a.indexOf(u) === i);
const provider = new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url })));
// a plain provider for lookups that may miss (the failover one logs every miss as an error)
const quiet = new JsonRpcProvider({ url: RPCS[0] });
const accounts = new Map<string, Account>();
const queues = new Map<string, Promise<unknown>>();

function account(signer: string): Account {
  let a = accounts.get(signer);
  if (!a) {
    a = new Account(signer.split('#')[0], provider, KeyPairSigner.fromSecretKey(privateKey(signer) as KeyPairString));
    accounts.set(signer, a);
  }
  return a;
}

export interface CallResult<T> { value: T; tx: string; logs: string[] }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const transient = (e: unknown): boolean => /fetch failed|ECONNRESET|ETIMEDOUT|timeout|503|502|429|InvalidNonce|Expired/i.test(String((e as Error)?.message ?? e));

interface Outcome {
  transaction: { hash: string };
  status: { SuccessValue?: string; Failure?: unknown };
  receipts_outcome?: { outcome: { logs: string[]; status: { Failure?: unknown } } }[];
}

/** A readable reason from a failed outcome (the contract's panic message when there is one). */
export function failureText(o: unknown): string {
  const s = JSON.stringify(o ?? '');
  const m = /Smart contract panicked: ([^"\\]+)|"ExecutionError":"([^"]+)"/.exec(s);
  return (m?.[1] ?? m?.[2] ?? s).slice(0, 240);
}

/** Calls `method` on `receiver` as `signer`. Returns the decoded value, the tx hash and every receipt's logs. */
export function callOn<T = unknown>(signer: string, receiver: string, method: string, args: object, gasTera = 100, depositYocto = 0n): Promise<CallResult<T>> {
  const once = async (): Promise<CallResult<T>> => {
    const outcome = await account(signer).signAndSendTransaction({
      receiverId: receiver,
      actions: [actions.functionCall(method, args as Record<string, unknown>, teraToGas(gasTera), depositYocto)],
      waitUntil: 'EXECUTED_OPTIMISTIC',
      throwOnFailure: false,
    });
    const o = outcome as unknown as Outcome;
    const logs = (o.receipts_outcome ?? []).flatMap((r) => r.outcome.logs);
    if (o.status && 'Failure' in o.status && o.status.Failure) {
      throw Object.assign(new Error(`${method}: ${failureText(o.status.Failure)}`), { tx: o.transaction.hash, refused: true });
    }
    // a failure deeper in the receipt tree (a callback that panicked) also counts
    const deep = (o.receipts_outcome ?? []).find((r) => r.outcome.status && 'Failure' in r.outcome.status && r.outcome.status.Failure);
    if (deep) throw Object.assign(new Error(`${method}: ${failureText(deep.outcome.status.Failure)}`), { tx: o.transaction.hash, refused: true });
    const raw = o.status?.SuccessValue ? Buffer.from(o.status.SuccessValue, 'base64').toString('utf8') : '';
    let value: unknown;
    try { value = raw ? JSON.parse(raw) : undefined; } catch { value = raw; }
    return { value: value as T, tx: o.transaction.hash, logs };
  };
  const guarded = async (): Promise<CallResult<T>> => {
    for (let attempt = 0; ; attempt++) {
      try { return await once(); } catch (e) {
        if ((e as { refused?: boolean }).refused || attempt >= 3 || !transient(e)) throw e;
        if (/InvalidNonce/i.test(String((e as Error)?.message ?? e))) accounts.delete(signer);
        await sleep(800 * (attempt + 1));
      }
    }
  };
  const run = (queues.get(signer) ?? Promise.resolve()).catch(() => undefined).then(guarded);
  queues.set(signer, run);
  return run;
}

/** A call on the hub. */
export const call = <T = unknown>(signer: string, method: string, args: object, gasTera = 100, depositYocto = 0n): Promise<CallResult<T>> =>
  callOn<T>(signer, config.hub, method, args, gasTera, depositYocto);

/** Sends NEAR from `signer` to `to`. */
export function send(signer: string, to: string, yocto: bigint): Promise<string> {
  const run = (queues.get(signer) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const o = (await account(signer).signAndSendTransaction({ receiverId: to, actions: [actions.transfer(yocto)], waitUntil: 'EXECUTED_OPTIMISTIC' })) as unknown as Outcome;
    return o.transaction.hash;
  });
  queues.set(signer, run);
  return run;
}

// Views go straight to the RPCs with our own failover, at most 6 in flight (public RPCs reset bursts).
let inflight = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (inflight >= 6) await new Promise<void>((r) => waiting.push(r));
  inflight++;
  try { return await fn(); } finally { inflight--; waiting.shift()?.(); }
}

export function viewOn<T>(contractId: string, method: string, args: object = {}): Promise<T> {
  return slot(async () => {
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const url = RPCS[attempt % RPCS.length];
      try {
        const res = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
        });
        const j = (await res.json()) as { result?: { result: number[]; error?: string }; error?: { cause?: { name?: string }; data?: string; message?: string } };
        if (j.result?.result) {
          const raw = Buffer.from(j.result.result).toString('utf8');
          return (raw ? JSON.parse(raw) : null) as T;
        }
        const msg = j.result?.error ?? j.error?.data ?? j.error?.message ?? `HTTP ${res.status}`;
        // the contract refused (a panic in a view, an unknown account): no point retrying
        if (/wasm execution failed|panicked|does not exist|UNKNOWN_ACCOUNT|CodeDoesNotExist|MethodNotFound/i.test(String(msg) + JSON.stringify(j.error ?? ''))) throw Object.assign(new Error(`${method}: ${msg}`), { refused: true });
        last = new Error(`${method}: ${msg}`);
      } catch (e) {
        if ((e as { refused?: boolean }).refused) throw e;
        last = e;
      }
      await sleep(300 * (attempt + 1));
    }
    throw last;
  });
}
export const view = <T>(method: string, args: object = {}): Promise<T> => viewOn<T>(config.hub, method, args);

/** An account's balance in yoctoNEAR (null if it doesn't exist). */
export async function balanceOf(accountId: string): Promise<bigint | null> {
  try {
    const a = (await quiet.viewAccount({ accountId, finalityQuery: { finality: 'optimistic' } } as never)) as unknown as { amount: string };
    return BigInt(a.amount);
  } catch { return null; }
}

/** A key's permission (with its remaining allowance for a function-call key), or null. */
export async function accessKeys(accountId: string): Promise<{ public_key: string; access_key: { permission: unknown } }[]> {
  try {
    const r = (await quiet.viewAccessKeyList({ accountId, finalityQuery: { finality: 'optimistic' } } as never)) as unknown as { keys: { public_key: string; access_key: { permission: unknown } }[] };
    return r.keys;
  } catch { return []; }
}

export { provider };
