import { config, explorerTx } from './config.ts';
import { getAudit, getCampaign, getProposal, getStartup } from './hub.ts';
import type { Signed } from './nearai.ts';
import { bidsFor, getWire, loadVetting } from './store.ts';

// A campaign's proof bundle: what the chain only holds hashes of (bid openings, pitches, vetting reports)
// plus their NEAR AI proofs. `pnpm verify` checks it against the chain, which it reads itself.

export interface ProofBid { creator: string; price: string; salt: string; pitch: string; pitchHash: string; proof: Signed | null; author?: 'creator' | 'agent' }
export interface ProofVetting { account: string; report: string; reportHash: string; proof: Signed | null }
export interface ProofBundle {
  campaign: number;
  hub: string;
  startup: string;
  dao: string;
  /** openings are published only for bids the chain shows as revealed */
  bids: ProofBid[];
  vetting: ProofVetting[];
  txs: { what: string; who: string; tx: string; url: string }[];
}

export async function buildProof(id: number): Promise<ProofBundle | null> {
  const c = await getCampaign(id);
  if (!c) return null;
  const s = await getStartup(c.startup);
  if (!s) return null;
  const revealed = new Set(c.bids.filter((b) => b.revealed).map((b) => b.creator));
  const bids = bidsFor(id)
    .filter((b) => revealed.has(b.creator))
    .map((b) => ({ creator: b.creator, price: b.price, salt: b.salt, pitch: b.pitch, pitchHash: b.pitchHash, proof: b.proof.signature ? b.proof : b.proof.model === 'none' ? null : b.proof, author: b.human ? 'creator' as const : 'agent' as const }));
  const vetting = c.bids
    .map((b) => loadVetting(b.creator))
    .filter((v): v is NonNullable<typeof v> => !!v)
    .map((v) => ({ account: v.account, report: v.report, reportHash: v.reportHash, proof: v.proof.model === 'none' ? null : v.proof }));
  const txs = getWire()
    .filter((w) => w.campaign === id && w.tx)
    .reverse()
    .map((w) => ({ what: w.what, who: w.who, tx: w.tx!, url: explorerTx(w.tx!) }));
  return { campaign: id, hub: config.hub, startup: s.id, dao: s.dao, bids, vetting, txs };
}

export { getAudit, getProposal };
