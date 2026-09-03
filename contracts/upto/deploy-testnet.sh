#!/usr/bin/env bash
# One-time, manual: deploys contracts/upto to Stellar testnet, funds a throwaway payer
# with a throwaway asset (its own issuer, so no pre-existing secret is needed), and
# submits one real settle_upto call. Prints the resulting contract id and tx hash, which
# feed scripts/soroban-upto-footprint.mjs. Not run in CI — cargo test is CI's job; this is
# the acceptance artifact for the 500,000-stroop fee ceiling re-check (ARCHITECTURE 2.4).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

NETWORK=testnet
MAX=1000000    # 0.1 UPTO (7-decimal classic asset units)
ACTUAL=420000  # 0.042 UPTO

for name in upto-issuer upto-payer upto-payto; do
  stellar keys generate "$name" --fund --network "$NETWORK" --overwrite >/dev/null
done

ISSUER=$(stellar keys address upto-issuer)
PAYER=$(stellar keys address upto-payer)
PAY_TO=$(stellar keys address upto-payto)

echo "issuer:  $ISSUER"
echo "payer:   $PAYER"
echo "pay_to:  $PAY_TO"

echo "==> wrapping a throwaway classic asset (UPTO:$ISSUER) as a SAC"
TOKEN=$(stellar contract asset deploy --asset "UPTO:$ISSUER" --source-account upto-issuer --network "$NETWORK")
echo "token:   $TOKEN"

echo "==> establishing trustlines and minting to the payer"
stellar tx new change-trust --source-account upto-payer --network "$NETWORK" --line "UPTO:$ISSUER" >/dev/null
stellar tx new change-trust --source-account upto-payto --network "$NETWORK" --line "UPTO:$ISSUER" >/dev/null
stellar tx new payment --source-account upto-issuer --network "$NETWORK" \
  --destination "$PAYER" --asset "UPTO:$ISSUER" --amount "$MAX" >/dev/null

echo "==> building contracts/upto"
cargo build --manifest-path "$(dirname "$0")/../Cargo.toml" --target wasm32v1-none --release --package upto

WASM="$(dirname "$0")/../target/wasm32v1-none/release/upto.wasm"

echo "==> deploying the settlement contract"
CONTRACT_ID=$(stellar contract deploy --wasm "$WASM" --source-account upto-payer --network "$NETWORK")
echo "contract: $CONTRACT_ID"

echo "==> invoking settle_upto(max=$MAX, actual=$ACTUAL)"
TX_HASH=$(stellar contract invoke --id "$CONTRACT_ID" --source-account upto-payer --network "$NETWORK" --send yes -- \
  settle_upto --token "$TOKEN" --payer "$PAYER" --pay_to "$PAY_TO" --max "$MAX" --actual "$ACTUAL" 2>&1 \
  | tee /dev/stderr | grep -oE '[0-9a-f]{64}' | tail -1)

if [ -z "$TX_HASH" ]; then
  echo "no transaction hash found in invoke output" >&2
  exit 1
fi
echo "tx hash: $TX_HASH"

node "$(dirname "$0")/../../scripts/record-upto-deploy.mjs" "$CONTRACT_ID" "$TX_HASH" "$TOKEN" "$PAYER" "$PAY_TO"
