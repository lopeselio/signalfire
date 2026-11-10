# Signalfire — agent notes

- Hackathon rules: https://nearhackathon.com/HACKATHON.md (deadline 2026-11-14 23:59 UTC; repo must stay public).
- Design source of truth: DESIGN.md. Keep README "do X, see Y" steps current — AI judges run them.
- Independent of the NEAR Arcade (the user's other submission): its own repo, contract, rules and server.
- packages/core is deterministic and isomorphic (browser + Node): no Math.random, no Date, no DOM, no node: imports.
  Its curve math, bid hashes, auction scoring, milestones and lookalike rule must match contracts/hub byte for byte
  (shared test vectors in both test suites).
- The LLM never decides money, admission or a winner; contracts/hub (and packages/core, which mirrors it) does.
  NEAR AI writes vetting reports and pitches; every reply is kept with its TEE signature.
- Treasury money leaves only through `claim_milestone` (spend policy + audit log). Never add a method that moves a
  startup's treasury anywhere else.
- Agents have function-call keys only; they spend from hub wallets with caps.
- The attention token is not equity and not a claim on revenue: keep that wording in the UI and metadata.
- Testnet only. Keys live in .env / ~/.near-credentials, never in the repo.
- Verify NEAR endpoints/SDK versions against docs.near.org/llms.txt and docs.near.ai/llms.txt, not memory.
- Local ports 8861–8869 (server 8861, Vite 8862).
- Commits: no Co-Authored-By or other AI attribution lines; small granular commits. Every change after the first
  push goes on a branch, through a PR, and is rebase-merged.
