import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { siwn } from 'better-near-auth';
import { config, hasKey, privateKey } from './config.ts';
import { getStartups } from './hub.ts';

// Sign in with a NEAR wallet: Better Auth with the better-near-auth plugin (SIWN, NEP-413).
// NEAR Connect shows the wallet picker; the wallet signs "Sign in to <our host>"; the plugin checks
// the signature, that the key is a full-access key of the account (onchain) and that the nonce is
// fresh, then sets an HttpOnly session cookie.
//
// The same plugin relays NEP-366 meta-transactions: a signed-in user's wallet signs a delegate action
// for the hub (buy, join the holders, apply), a startup's token (sell) or its DAO (vote), and our relayer
// account pays the gas.
//
// Sessions live in memory (one replica); a redeploy signs people out, nothing else is lost.

export const BA_PATH = '/api/ba';

const baseURL = process.env.BETTER_AUTH_URL ?? `http://localhost:${config.port}`;
export const authOrigin = new URL(baseURL).origin;
export const authHost = new URL(baseURL).host;

// the relayer only relays to the hub and to the startups' tokens and DAOs (read from the chain at boot);
// any NEAR a call attaches (a buy) comes from the user's own account, never from the relayer
const startups = await getStartups().catch(() => [] as { token: string; dao: string }[]);
const whitelistedContracts = [config.hub, ...startups.flatMap((s) => [s.token, s.dao])];
const relayer = config.relayer && hasKey(config.relayer)
  ? { testnet: { accountId: config.relayer, privateKey: privateKey(config.relayer), whitelistedContracts, maxDepositPerTransaction: '5000000000000000000000000', maxGasPerTransaction: '300000000000000' } }
  : undefined;

export const auth = betterAuth({
  appName: 'Signalfire',
  baseURL,
  basePath: BA_PATH,
  secret: config.sessionSecret,
  database: memoryAdapter({ user: [], session: [], account: [], verification: [], nearAccount: [], relayedTransaction: [], relayerKey: [] }),
  // the page's own origin, plus any extra origins configured
  trustedOrigins: [authOrigin, ...config.extraOrigins],
  session: { expiresIn: 24 * 3600, cookieCache: { enabled: true, maxAge: 5 * 60 } },
  advanced: { defaultCookieAttributes: { sameSite: 'lax', secure: baseURL.startsWith('https'), httpOnly: true } },
  hooks: {
    // the plugin checks signature, key and nonce, but not which site a signature was made for:
    // a sign-in must be signed for our host, with our exact message, from our page
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/near/verify' && ctx.path !== '/near/link-account') return;
      const b = (ctx.body ?? {}) as { recipient?: unknown; message?: unknown };
      if (b.recipient !== authHost || b.message !== `Sign in to ${authHost}`) {
        throw new APIError('UNAUTHORIZED', { message: 'This sign-in was signed for a different site.' });
      }
      const from = ctx.request?.headers.get('origin');
      if (from !== authOrigin) throw new APIError('FORBIDDEN', { message: 'Sign in from Signalfire’s own page.' });
    }),
  },
  plugins: [siwn({ recipients: { testnet: authHost, mainnet: authHost }, requireFullAccessKey: true, ...(relayer ? { relayer } : {}) })],
});

export const authHandler = toNodeHandler(auth);

/** The NEAR account behind a request's session cookie, or null. Cached a minute per cookie. */
const cache = new Map<string, { account: string | null; until: number }>();
export async function accountFromHeaders(headers: Record<string, string | string[] | undefined>): Promise<string | null> {
  const cookie = String(headers.cookie ?? '');
  if (!cookie.includes('session_token')) return null;
  const hit = cache.get(cookie);
  if (hit && hit.until > Date.now()) return hit.account;
  const s = await auth.api.getSession({ headers: fromNodeHeaders(headers) }).catch(() => null);
  let account: string | null = null;
  if (s?.user?.id) {
    const ctx = await auth.$context;
    const near = await ctx.adapter.findOne<{ accountId: string }>({
      model: 'nearAccount',
      where: [{ field: 'userId', operator: 'eq', value: s.user.id }, { field: 'isPrimary', operator: 'eq', value: true }],
    });
    account = near?.accountId ?? null;
  }
  if (cache.size > 5000) cache.clear();
  cache.set(cookie, { account, until: Date.now() + 60_000 });
  return account;
}
