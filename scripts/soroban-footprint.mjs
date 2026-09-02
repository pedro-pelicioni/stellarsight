#!/usr/bin/env node
/**
 * scripts/soroban-footprint.mjs — what one settled x402 payment actually costs the
 * Soroban host, measured on chain and compared against the network's own per-transaction
 * limits.
 *
 * Why this exists: the settle path is a single `invokeHostFunction` calling `transfer` on
 * a SAC, and the obvious question about it — does it fit inside Soroban's per-transaction
 * read, write, instruction and memory limits — was answerable only by argument. Fee was
 * documented (the 500,000-stroop ceiling in ARCHITECTURE 2.4), but fee is a price, not a
 * resource: a transaction can be cheap and still be one refactor away from the instruction
 * ceiling. So measure the resources themselves.
 *
 * Both sides are fetched, never typed:
 *   - usage comes from the settled transaction's own `SorobanTransactionData`, read back
 *     out of the envelope the network accepted;
 *   - the limits come from the live ConfigSetting ledger entries, so when the network
 *     raises or lowers them the comparison follows without an edit here.
 *
 * What it deliberately does NOT claim: memory. `txMemoryLimit` is a host-side ceiling and
 * peak memory is not recorded in the envelope or the result meta, so the artifact reports
 * the limit and states that usage is unobserved rather than inventing a number for it.
 *
 * Usage:
 *   node scripts/soroban-footprint.mjs                 # measure the last conformance settle
 *   node scripts/soroban-footprint.mjs --hash <tx>     # measure a specific settlement
 *   node scripts/soroban-footprint.mjs --emit          # write docs/status/soroban-footprint.json
 *
 * Exits non-zero if any measured resource exceeds --max-utilization (default 25%) of its
 * per-transaction limit. Today the largest is well under 1%, so the gate is not a
 * threshold anyone is near — it is a tripwire for a change that alters the settle path's
 * shape, which is the only way this number moves.
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

const hash = flag('hash', readEvidence('conformance')?.txHash ?? null);
if (!hash) {
  console.error('no --hash given and docs/status/conformance.json has no txHash to fall back on');
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
  },
});

if (has('emit')) {
  const { path } = writeEvidence('soroban-footprint', payload);
  console.log(`[footprint] wrote ${path.replace(`${process.cwd()}/`, '')}`);
}

printFootprintReport(hash, measured, limits, payload.utilizationPercent, payload, MAX_UTILIZATION);

if (!payload.withinLimits) {
  process.exit(1);
}
