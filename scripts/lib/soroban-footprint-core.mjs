/**
 * scripts/lib/soroban-footprint-core.mjs — shared resource-footprint measurement for one
 * settled Soroban `invokeHostFunction` transaction.
 *
 * Extracted out of scripts/soroban-footprint.mjs so the same read-back logic (RPC calls,
 * XDR decoding, network-limits lookup) can measure any settled contract invocation — the
 * SAC `transfer` settle path and the `upto` settlement contract alike — without duplicating
 * the decoding. Both sides are fetched, never typed:
 *   - usage comes from the settled transaction's own `SorobanTransactionData`, read back
 *     out of the envelope the network accepted;
 *   - the limits come from the live ConfigSetting ledger entries, so when the network
 *     raises or lowers them the comparison follows without an edit here.
 *
 * What this deliberately does NOT claim: memory. `txMemoryLimit` is a host-side ceiling and
 * peak memory is not recorded in the envelope or the result meta, so callers report the
 * limit and state that usage is unobserved rather than inventing a number for it.
 */
import { xdr } from '@stellar/stellar-sdk';

export async function rpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
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
export async function networkLimits(rpcUrl) {
  const ids = ['configSettingContractComputeV0', 'configSettingContractLedgerCostV0'];
  const keys = ids.map((id) =>
    xdr.LedgerKey.configSetting(
      new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId[id]() }),
    ).toXDR('base64'),
  );
  const { entries } = await rpc(rpcUrl, 'getLedgerEntries', { keys });
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
export async function measure(rpcUrl, hash) {
  const tx = await rpc(rpcUrl, 'getTransaction', { hash });
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

export const RESOURCE_LIMIT_PAIRS = [
  ['instructions', 'txMaxInstructions'],
  ['diskReadBytes', 'txMaxDiskReadBytes'],
  ['writeBytes', 'txMaxWriteBytes'],
  ['diskReadEntries', 'txMaxDiskReadEntries'],
  ['writeLedgerEntries', 'txMaxWriteLedgerEntries'],
];

/** Builds the utilization/withinLimits payload shared by every footprint report. */
export function buildFootprintPayload({ rpcUrl, measured, limits, maxUtilization, notes }) {
  const utilization = {};
  for (const [usedKey, limitKey] of RESOURCE_LIMIT_PAIRS) {
    const used = measured.used[usedKey];
    const limit = limits[limitKey];
    utilization[usedKey] =
      Number.isFinite(used) && Number.isFinite(limit) && limit > 0
        ? Number(((used / limit) * 100).toFixed(4))
        : null;
  }
  const worst = Math.max(...Object.values(utilization).filter((v) => v !== null));
  const withinLimits = worst <= maxUtilization;

  return {
    ...measured,
    rpc: rpcUrl,
    limits,
    utilizationPercent: utilization,
    worstUtilizationPercent: Number(worst.toFixed(4)),
    headroomFactor: Number((100 / worst).toFixed(1)),
    maxUtilizationPercentAllowed: maxUtilization,
    withinLimits,
    ...notes,
  };
}

export function printFootprintReport(hash, measured, limits, utilization, payload, maxUtilization) {
  const pct = (v) => (v === null ? '   n/a' : `${v.toFixed(4).padStart(8)}%`);
  console.log(`\nSoroban per-transaction footprint — ${hash.slice(0, 12)}… (ledger ${measured.ledger})`);
  console.log(
    `  shape: ${measured.shape.operations} op (${measured.shape.operationTypes.join(', ')}), ` +
      `${measured.shape.authEntries} auth entry, ${measured.shape.authSubInvocations} sub-invocations` +
      `${measured.shape.feeBumped ? ', fee-bumped' : ''}`,
  );
  console.log('  resource            used            limit    utilization');
  for (const [usedKey, limitKey] of RESOURCE_LIMIT_PAIRS) {
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
    `\n  worst utilization ${payload.worstUtilizationPercent.toFixed(4)}% — ${payload.headroomFactor}x headroom against the tightest limit`,
  );
  if (!payload.withinLimits) {
    console.error(
      `\nFAIL: ${payload.worstUtilizationPercent.toFixed(4)}% exceeds the --max-utilization gate of ${maxUtilization}%.`,
    );
  } else {
    console.log(`  gate: within ${maxUtilization}% of every per-transaction limit ✓\n`);
  }
}
