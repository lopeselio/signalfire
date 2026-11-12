#!/bin/bash
# Builds the scorer for OutLayer (WASI Preview 2) and copies it, with its sha256, to outlayer/wasm/.
# The hub runs exactly that file (by URL and sha256); the TEE derives the bid key from this exact build.
set -euo pipefail
cd "$(dirname "$0")"
rustup target add wasm32-wasip2 >/dev/null 2>&1 || true
cargo test --locked
cargo build --locked --target wasm32-wasip2 --release
out=target/wasm32-wasip2/release/signalfire-scorer.wasm
grep -qa '"path": "bids"' "$out" || { echo "the outlayer.manifest section (encryption key \"bids\") is missing" >&2; exit 1; }
mkdir -p ../wasm
cp "$out" ../wasm/signalfire-scorer.wasm
shasum -a 256 ../wasm/signalfire-scorer.wasm | cut -d' ' -f1 | tee ../wasm/signalfire-scorer.wasm.sha256
