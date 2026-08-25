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
import { xdr } from '@stellar/stellar-sdk';
import { readEvidence, writeEvidence } from './lib/evidence.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const RPC = flag('rpc', process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org');
const MAX_UTILIZATION = Number(flag('max-utilization', '25'));

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

/** Per-transaction limits, straight out of the live ConfigSetting entries. */
async function networkLimits() {
  const ids = ['configSettingContractComputeV0', 'configSettingContractLedgerCostV0'];
  const keys = ids.map((id) =>
    xdr.LedgerKey.configSetting(
      new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId[id]() }),
    ).toXDR('base64'),
  );
  const { entries } = await rpc('getLedgerEntries', { keys });
  const out = {};
  for (const entry of entries ?? []) {
    const setting = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64').configSetting();
    const which = setting.switch().name;
    if (which === 'configSettingContractComputeV0') {
      const c = setting.contractCompute();
      out.txMaxInstructions = Number(c.txMaxInstructions().toString());
      out.txMemoryLimitBytes = Number(c.txMemoryLimit());
    }
    if (which === 'configSettingContractLedgerCostV0') {
      const c = setting.contractLedgerCost();
      out.txMaxDiskReadBytes = Number(c.txMaxDiskReadBytes().toString());
      out.txMaxWriteBytes = Number(c.txMaxWriteBytes().toString());
      out.txMaxDiskReadEntries = Number(c.txMaxDiskReadEntries());
      out.txMaxWriteLedgerEntries = Number(c.txMaxWriteLedgerEntries());
    }
  }
  return out;
}

/** Resources and shape of one settled transaction. */
async function measure(hash) {
  const tx = await rpc('getTransaction', { hash });
  if (tx.status !== 'SUCCESS') {
    throw new Error(
      `transaction ${hash.slice(0, 8)}… is ${tx.status}` +
        (tx.status === 'NOT_FOUND'
          ? ' — public RPC retains only a short window, so measure a recent settlement'
          : ''),
    );
  }
  const envelope = xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, 'base64');
  const isFeeBump = envelope.switch().name === 'envelopeTypeTxFeeBump';
  const inner = isFeeBump ? envelope.feeBump().tx().innerTx().v1().tx() : envelope.v1().tx();

  const soroban = inner.ext().sorobanData();
  const r = soroban.resources();
  // Protocol 23 renamed readBytes -> diskReadBytes; accept either so an SDK bump is not a
  // silent zero.
  const readBytes = Number((r.diskReadBytes ? r.diskReadBytes() : r.readBytes()).toString());
  const footprint = r.footprint();

  const ops = inner.operations();
  const hostFn = ops[0]?.body()?.invokeHostFunctionOp?.();
  const auth = hostFn ? hostFn.auth() : [];
  const subInvocations = auth.reduce((n, a) => n + a.rootInvocation().subInvocations().length, 0);

  return {
    txHash: hash,
    ledger: tx.ledger ?? null,
    shape: {
      feeBumped: isFeeBump,
      operations: ops.length,
      operationTypes: ops.map((o) => o.body().switch().name),
      hostFunctionType: hostFn ? hostFn.hostFunction().switch().name : null,
      authEntries: auth.length,
      authSubInvocations: subInvocations,
    },
    used: {
      instructions: Number(r.instructions().toString()),
      diskReadBytes: readBytes,
      writeBytes: Number(r.writeBytes().toString()),
      diskReadEntries: footprint.readOnly().length,
      writeLedgerEntries: footprint.readWrite().length,
      memoryBytes: null, // not recorded on chain — see the header note
    },
    fees: {
      resourceFeeStroops: Number(soroban.resourceFee().toString()),
      innerFeeStroops: Number(inner.fee()),
      feeBumpFeeStroops: isFeeBump ? Number(envelope.feeBump().tx().fee().toString()) : null,
    },
  };
}

const PAIRS = [
  ['instructions', 'txMaxInstructions'],
  ['diskReadBytes', 'txMaxDiskReadBytes'],
  ['writeBytes', 'txMaxWriteBytes'],
  ['diskReadEntries', 'txMaxDiskReadEntries'],
  ['writeLedgerEntries', 'txMaxWriteLedgerEntries'],
];

const hash = flag('hash', readEvidence('conformance')?.txHash ?? null);
if (!hash) {
  console.error('no --hash given and docs/status/conformance.json has no txHash to fall back on');
  process.exit(2);
}

const [limits, measured] = await Promise.all([networkLimits(), measure(hash)]);

const utilization = {};
for (const [usedKey, limitKey] of PAIRS) {
  const used = measured.used[usedKey];
  const limit = limits[limitKey];
  utilization[usedKey] =
    Number.isFinite(used) && Number.isFinite(limit) && limit > 0
      ? Number(((used / limit) * 100).toFixed(4))
      : null;
}
const worst = Math.max(...Object.values(utilization).filter((v) => v !== null));
const withinLimits = worst <= MAX_UTILIZATION;

const payload = {
  ...measured,
  rpc: RPC,
  limits,
  utilizationPercent: utilization,
  worstUtilizationPercent: Number(worst.toFixed(4)),
  headroomFactor: Number((100 / worst).toFixed(1)),
  maxUtilizationPercentAllowed: MAX_UTILIZATION,
  withinLimits,
  memoryNote:
    'Peak host memory is not recorded in the transaction envelope or result meta, so usage is unobserved. The per-transaction limit is reported for completeness.',
  registryNote:
    'There is no on-chain registry in this design — the catalog is facilitator-side — so the RFP clause about registry operations staying within limits has no on-chain operation to bound.',
};

if (has('emit')) {
  const { path } = writeEvidence('soroban-footprint', payload);
  console.log(`[footprint] wrote ${path.replace(`${process.cwd()}/`, '')}`);
}

const pct = (v) => (v === null ? '   n/a' : `${v.toFixed(4).padStart(8)}%`);
console.log(`\nSoroban per-transaction footprint — ${hash.slice(0, 12)}… (ledger ${measured.ledger})`);
console.log(
  `  shape: ${measured.shape.operations} op (${measured.shape.operationTypes.join(', ')}), ` +
    `${measured.shape.authEntries} auth entry, ${measured.shape.authSubInvocations} sub-invocations` +
    `${measured.shape.feeBumped ? ', fee-bumped' : ''}`,
);
console.log('  resource            used            limit    utilization');
for (const [usedKey, limitKey] of PAIRS) {
  console.log(
    `  ${usedKey.padEnd(18)} ${String(measured.used[usedKey]).padStart(10)} ${String(
      limits[limitKey],
    ).padStart(16)}   ${pct(utilization[usedKey])}`,
  );
}
console.log(
  `  memory                unobserved ${String(limits.txMemoryLimitBytes).padStart(16)}        (see note)`,
);
console.log(
  `\n  worst utilization ${worst.toFixed(4)}% — ${payload.headroomFactor}x headroom against the tightest limit`,
);

if (!withinLimits) {
  console.error(
    `\nFAIL: ${worst.toFixed(4)}% exceeds the --max-utilization gate of ${MAX_UTILIZATION}%.`,
  );
  process.exit(1);
}
console.log(`  gate: within ${MAX_UTILIZATION}% of every per-transaction limit ✓\n`);
