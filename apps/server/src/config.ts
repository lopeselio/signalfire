import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = (k: string, d = ''): string => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '8861')),
  network: env('NEAR_NETWORK', 'testnet'),
  rpcUrl: env('NEAR_RPC_URL', 'https://test.rpc.fastnear.com'),
  /** the hub contract */
  hub: env('CONTRACT_ID', 'signalfire.testnet'),
  /** runs the demo startup (its founder), the agent loop and the cranks */
  operator: env('OPERATOR_ID', 'signalfire-ref.testnet'),
  /** pays gas for signed-in users' meta-transactions (NEP-366), relayed by better-near-auth */
  relayer: env('RELAYER_ID', 'signalfire-relay.testnet'),
  /** the startup the operator runs and the agents work for */
  demo: env('DEMO_STARTUP', 'glow'),
  /** run the agent loop (creators, scout, holders, audience, cranks) */
  agents: env('AGENTS', '1') !== '0',
  /** the founder agent posts a new brief when nothing is running */
  autoBriefs: env('AUTO_BRIEFS', '1') !== '0',
  tickMs: Number(env('TICK_MS', '8000')),
  extraOrigins: env('EXTRA_ORIGINS').split(',').map((x) => x.trim()).filter(Boolean),
  webDist: env('WEB_DIST', join(import.meta.dirname, '../../web/dist')),
  dataDir: env('DATA_DIR', join(import.meta.dirname, '../../../data')),
  sessionSecret: env('SESSION_SECRET', 'dev-only-secret-change-me'),
  nearAi: {
    apiKey: env('NEARAI_API_KEY') === 'none' ? '' : env('NEARAI_API_KEY'),
    baseUrl: env('NEARAI_BASE_URL', 'https://cloud-api.near.ai/v1'),
    model: env('NEARAI_MODEL', 'Qwen/Qwen3.6-35B-A3B-FP8'),
  },
};

// Hosted: keys come from one JSON env var {account: "ed25519:..."}; locally from ~/.near-credentials.
const hosted: Record<string, string> = (() => {
  try { return JSON.parse(env('NEAR_KEYS', '{}')) as Record<string, string>; } catch { return {}; }
})();

/** A signer's key: `account`, or `account#dao` for a holder agent's second key (the one its DAO accepts). */
export function privateKey(signer: string): string {
  if (hosted[signer]) return hosted[signer];
  const file = join(homedir(), '.near-credentials', config.network, `${signer.replace('#', '.')}.json`);
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { private_key: string }).private_key;
  } catch {
    throw new Error(`no key for ${signer} (set NEAR_KEYS or add ${file})`);
  }
}

export function hasKey(signer: string): boolean {
  try { privateKey(signer); return true; } catch { return false; }
}

export const explorerTx = (hash: string): string => `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = (a: string): string => `https://testnet.nearblocks.io/address/${a}`;
export const sub = (name: string): string => `${name}.${config.hub}`;
