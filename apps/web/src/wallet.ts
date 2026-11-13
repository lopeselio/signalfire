import { createAuthClient } from 'better-auth/client';
import { siwnClient } from 'better-near-auth/client';

// Sign in with a NEAR wallet through Better Auth's better-near-auth plugin (SIWN, NEP-413).
// NEAR Connect shows the wallet picker; the wallet signs "Sign in to <this host>"; the server checks it
// and sets an HttpOnly session cookie.
//
// Calls are NEP-366 meta-transactions when the wallet can sign a delegate action: Signalfire's relayer
// pays the gas, and any NEAR the call attaches (a buy) still comes from your own account. If the wallet
// can't sign delegate actions, the same call goes out as an ordinary wallet transaction.

let client: ReturnType<typeof makeClient> | null = null;
function makeClient() {
  const host = location.host;
  return createAuthClient({
    baseURL: location.origin,
    basePath: '/api/ba',
    plugins: [siwnClient({ recipients: { testnet: host, mainnet: host }, networkId: 'testnet' })],
  });
}
const authClient = () => (client ??= makeClient());

/** Open the wallet picker, sign the sign-in message, start a session. Returns the account. */
export async function signIn(): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    void authClient().signIn.near({
      onSuccess: () => resolve(),
      onError: (e: Error) => reject(new Error(e?.message || 'the wallet didn’t sign')),
    }).catch(reject);
  });
  // The session's user record doesn't carry the NEAR account (better-near-auth keeps it in its own table), and
  // some wallets return the account only inside the signed message, so the client may not know it yet. The server
  // does: it reads the account behind the session cookie. Ask it, with a couple of retries.
  const fromClient = authClient().near.getAccountId();
  if (fromClient) return fromClient;
  for (let k = 0; k < 3; k++) {
    const me = await fetch('/api/me', { credentials: 'same-origin' }).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { accountId?: string } | null;
    if (me?.accountId) return me.accountId;
    await sleep(700);
  }
  throw new Error('Your wallet signed, but the session didn’t start. Sign in again; if it repeats, try another wallet.');
}

export async function signOut(): Promise<void> {
  try { await authClient().signOut(); } catch { /* cookie may already be gone */ }
  try { await authClient().near.disconnect(); } catch { /* not connected */ }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ensureWallet(): Promise<void> {
  const near = authClient().near;
  if (near.isWalletConnected()) return;
  if (await near.ensureConnected().catch(() => false)) return;
  throw new Error('Reconnect your wallet: sign out and sign in again.');
}

/**
 * A contract call from the signed-in account, to any receiver (the hub, a startup's token, its DAO).
 * Gasless through the relayer when the wallet can sign a delegate action; otherwise a normal transaction.
 */
export async function call(contract: string, method: string, args: object, depositYocto: bigint = 0n): Promise<{ tx: string; gasless: boolean }> {
  await ensureWallet();
  const near = authClient().near;
  const gas = (method === 'act_proposal' ? '150 Tgas' : '100 Tgas') as `${number} Tgas`;
  const attachedDeposit = `${depositYocto} yocto` as const;
  try {
    const payload = await near.buildSignedDelegateAction(contract, (b, receiverId) =>
      b.functionCall(receiverId, method, args, { gas, attachedDeposit }));
    const r = await near.relayTransaction({ payload });
    if (r.error || !r.data) throw new Error(r.error?.message ?? 'the relayer refused the transaction');
    const tx = r.data.txHash;
    for (let k = 0; k < 20; k++) {
      const st = await near.getRelayStatus(tx);
      if (st.data?.status === 'completed') return { tx, gasless: true };
      if (st.data?.status === 'failed') throw new Error(failure(st.data.outcome) ?? `the transaction failed (${tx.slice(0, 10)}…)`);
      await sleep(1500);
    }
    return { tx, gasless: true };
  } catch (e) {
    // a refusal from the contract is final; only fall back when the wallet or relayer can't do it
    const msg = (e as Error).message ?? '';
    if (/panicked|failed \(/i.test(msg)) throw e;
    const out = (await near.getNearClient().call(contract, method, args, { gas, attachedDeposit })) as { transaction?: { hash: string }; status?: { Failure?: unknown } };
    if (out?.status && 'Failure' in out.status && out.status.Failure) throw new Error(failure(out) ?? 'the transaction failed');
    return { tx: out?.transaction?.hash ?? '', gasless: false };
  }
}

function failure(outcome: unknown): string | undefined {
  const m = /panicked at[^"]*?: ?([^"\\]+)|Smart contract panicked: ([^"\\]+)/.exec(JSON.stringify(outcome ?? ''));
  return m?.[1] ?? m?.[2];
}

/** Signs a NEP-413 message in the wallet (a NEAR Intents cash-out). The wallet shows the message before signing. */
export async function signMessage(message: string, recipient: string, nonce: Uint8Array): Promise<{ accountId: string; publicKey: string; signature: string }> {
  await ensureWallet();
  const r = await authClient().near.getNearClient().signMessage({ message, recipient, nonce });
  if (!r?.signature || !r.publicKey) throw new Error('the wallet didn’t sign the message');
  return { accountId: r.accountId, publicKey: r.publicKey, signature: r.signature };
}
