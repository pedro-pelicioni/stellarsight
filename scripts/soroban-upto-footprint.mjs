#!/usr/bin/env node
/**
 * scripts/soroban-upto-footprint.mjs — what one settled `settle_upto` contract call
 * actually costs the Soroban host, measured the same way as scripts/soroban-footprint.mjs
 * measures the plain SAC `transfer` settle path (ARCHITECTURE 2.7).
 *
 * Why a separate script instead of pointing the existing one at a different hash: the
 * default `--hash` source and the output artifact are both settle-path-specific
 * (conformance.json / soroban-footprint.json), and the notes describe "the settle path"
 * in terms of the transfer flow. The actual measurement logic lives once, in
 * scripts/lib/soroban-footprint-core.mjs, and both scripts just call into it.
 *
 * Re-checks the 500,000-stroop fee ceiling (ARCHITECTURE 2.4) against a real
 * `settle_upto` invocation instead of a plain `transfer` — expect one auth sub-invocation
 * here (the nested `approve`), versus zero for a plain transfer.
 *
 * Usage:
 *   node scripts/soroban-upto-footprint.mjs                # measure the last deployed settle_upto call
 *   node scripts/soroban-upto-footprint.mjs --hash <tx>     # measure a specific settlement
 *   node scripts/soroban-upto-footprint.mjs --emit          # write docs/status/upto-settlement-footprint.json
 *
 * Exits non-zero if any measured resource exceeds --max-utilization (default 25%) of its
 * per-transaction limit.
 */
import { readEvidence, writeEvidence } from './lib/evidence.mjs';
import { measure, networkLimits, buildFootprintPayload, printFootprintReport } from './lib/soroban-footprint-core.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const RPC = flag('rpc', process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org');
const MAX_UTILIZATION = Number(flag('max-utilization', '25'));

const hash = flag('hash', readEvidence('upto-settlement-deploy')?.txHash ?? null);
if (!hash) {
  console.error(
    'no --hash given and docs/status/upto-settlement-deploy.json has no txHash to fall back on — ' +
      'run contracts/upto/deploy-testnet.sh first',
  );
  process.exit(2);
}

const [limits, measured] = await Promise.all([networkLimits(RPC), measure(RPC, hash)]);

const payload = buildFootprintPayload({
  rpcUrl: RPC,
  measured,
  limits,
  maxUtilization: MAX_UTILIZATION,
  notes: {
    memoryNote:
      'Peak host memory is not recorded in the transaction envelope or result meta, so usage is unobserved. The per-transaction limit is reported for completeness.',
    registryNote:
      'There is no on-chain registry in this design — the catalog is facilitator-side — so the RFP clause about registry operations staying within limits has no on-chain operation to bound.',
    contractNote:
      'Measures a real contracts/upto settle_upto invocation (approve nested in the payer auth tree, then transfer_from), not the plain SAC transfer that scripts/soroban-footprint.mjs measures — expect one auth sub-invocation here.',
  },
});

if (has('emit')) {
  const { path } = writeEvidence('upto-settlement-footprint', payload);
  console.log(`[footprint] wrote ${path.replace(`${process.cwd()}/`, '')}`);
}

printFootprintReport(hash, measured, limits, payload.utilizationPercent, payload, MAX_UTILIZATION);

if (!payload.withinLimits) {
  process.exit(1);
}
