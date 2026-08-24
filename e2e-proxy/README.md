# `e2e-proxy` — running the official x402 e2e suite against this deployment

The SCF #45 RFP names as a hard acceptance criterion:

> *"a passing run of the x402 repo's e2e suite for both networks"*

That suite lives in [`x402-foundation/x402`](https://github.com/x402-foundation/x402) under
`e2e/`. **It cannot be pointed at a deployed facilitator by any flag or environment
variable.** `GenericFacilitatorProxy` spawns a child process and hardcodes
`http://localhost:${port}` for every call, and the resource server's `FACILITATOR_URL` is
overwritten by the harness with that locally-spawned URL.

The upstream-sanctioned seam is `e2e/facilitators/external-proxies/<name>/`, described in
that directory's own README as the way to test *"external production facilitators"*. The
harness special-cases the directory in `e2e/src/discovery.ts` (`isExternal: true`) and
declares it a workspace root in `e2e/pnpm-workspace.yaml` — but **the directory is
gitignored**, so no proxy implementation ships upstream. Every external run is first-party
glue.

That is why this directory exists here, in our repository, under version control: a passing
run against STELLARSIGHT includes this file, and a reviewer should be able to read it rather
than take our word for what it did.

## What it deliberately does not do

It relays bytes. No retries, no response rewriting, no status remapping, no fallbacks. A
402 from the facilitator reaches the harness as a 402, with the facilitator's own reason
intact. The only status it originates is a `502 relay_failed`, labelled so a reviewer can
tell a relay problem from a facilitator rejection.

`GET /health` is answered locally on purpose: it reports that the *relay* is up. Proxying it
would make a slow upstream look like a dead proxy and burn the harness's 10x2s startup
budget before a single payment was attempted.

## Using it

```bash
git clone https://github.com/x402-foundation/x402 && cd x402
git checkout <pinned SHA — see docs/status/upstream-e2e.json>

cd typescript && pnpm install --frozen-lockfile && pnpm build && cd ..

mkdir -p e2e/facilitators/external-proxies/stellarsight
cp /path/to/stellarsight/e2e-proxy/* e2e/facilitators/external-proxies/stellarsight/

cd e2e && pnpm install          # NOT --frozen-lockfile: you just added a workspace package
```

Then write `e2e/.env` (see `docs/status/upstream-e2e.json` for the shape) and run:

```bash
pnpm test --testnet --versions=2 --transport=http \
  --families=stellar --schemes=exact --endpoints='/exact/stellar' \
  --facilitators=stellarsight --extensions=bazaar \
  -v --log=e2e-run.log --output-json=e2e-results.json
```

## What the suite exercises, and what it does not

| | |
|---|---|
| The facilitator | **Ours**, hosted, via this relay — `/verify`, `/settle`, `/supported`, `/discovery/*` |
| The seller | Upstream's, spawned **locally**. The harness has no remote-seller mode, so our hosted seller is never on the path |
| The payer | Upstream's client, **locally**, signing with a key from `e2e/.env` |
| The asset | **Circle testnet USDC** (`CBIELTK6…`), hardcoded in `@x402/stellar`'s `defaultMoneyConversion`. There is no `SERVER_STELLAR_ASSET` override, so a Stellar run *is* a USDC run |
| The network | `stellar:testnet`. `--mainnet` would need `stellar:pubnet`, which is Tranche 3 work |
