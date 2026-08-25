/**
 * packages/index/src/provenance-store.mjs — provenance for settlements the LIVE stack makes.
 *
 * The problem this closes: `docs/status/provenance.json` is written by the scripts that
 * generate traffic and read by the feed from the bundle that was deployed. So a settlement
 * made through the hosted stack after the last commit had no way to be labelled at all —
 * it rendered as `unlabeled` until somebody ran a script and committed the result. On the
 * public feed that was the majority of recent rows, which made the honest default carry far
 * more weight than it should have to.
 *
 * The fix is not to loosen the default. It is to give the live stack a place to record what
 * it can actually attribute, and to keep that recording visibly weaker than the scripts'.
 *
 * **Recorded versus inferred, and why the distinction is kept.** A script that generates a
 * payment knows why it exists and asserts it: that is a claim its author can be held to. The
 * live stack does not know why a stranger is paying; the most it can honestly say is that
 * the payer's money came out of our own public faucet, which makes the payment demo traffic
 * rather than demand. That is an inference, and it is reported as one. A recorded label
 * always wins over an inferred one, and neither ever upgrades an unknown hash to organic.
 */

export const PROVENANCE_KEY = (txHash) => `stellarsight:provenance:${txHash}`;

/** The faucet's own claim key. Reused rather than duplicated — one definition of "we funded this". */
export const FAUCET_ACCOUNT_KEY = (account) => `stellarsight:faucet:acct:${account}`;

/** kv.command results arrive as either `X` or `{ result: X }` depending on transport. */
const unwrap = (r) => (r && typeof r === 'object' && 'result' in r ? r.result : r);

const isHash = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h);

/**
 * fundedByFaucet(kv, account) -> boolean
 *
 * True when this account was funded by our public faucet inside the faucet's own retention
 * window. Never throws: a store that cannot answer means "we do not know", which lands the
 * settlement on `unlabeled` — the safe side.
 */
export async function fundedByFaucet(kv, account) {
  if (!kv || typeof account !== 'string' || !account) return false;
  try {
    const r = await kv.command(['EXISTS', FAUCET_ACCOUNT_KEY(account)]);
    if (!r?.ok) return false;
    return Number(unwrap(r.result)) === 1;
  } catch {
    return false;
  }
}

/**
 * recordInferredProvenance(kv, txHash, label, meta) -> { ok, written?, reason? }
 *
 * SET NX, so the first reason recorded for a hash is the one that stands — the same rule
 * `updateProvenance()` holds to for the committed map. Silently relabelling history is
 * exactly what both of these exist to prevent.
 */
export async function recordInferredProvenance(kv, txHash, label, meta = {}) {
  if (!kv) return { ok: false, reason: 'no durable store configured' };
  if (!isHash(txHash)) return { ok: false, reason: 'not a transaction hash' };
  try {
    const value = JSON.stringify({ label, inferredAt: new Date().toISOString(), ...meta });
    const r = await kv.command(['SET', PROVENANCE_KEY(txHash), value, 'NX']);
    if (!r?.ok) return { ok: false, reason: r?.reason ?? 'store refused the write' };
    const res = unwrap(r.result);
    return { ok: true, written: res === 'OK' };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

/**
 * readInferredProvenance(kv, hashes) -> { '<hash>': { label, inferredAt, ... } }
 *
 * One MGET for the page being rendered. An unreachable store returns `{}`, which renders
 * every row as `unlabeled` — degraded, never flattering.
 */
export async function readInferredProvenance(kv, hashes) {
  const wanted = [...new Set((hashes ?? []).filter(isHash))];
  if (!kv || wanted.length === 0) return {};
  try {
    const r = await kv.command(['MGET', ...wanted.map(PROVENANCE_KEY)]);
    if (!r?.ok) return {};
    const values = unwrap(r.result);
    if (!Array.isArray(values)) return {};
    const out = {};
    wanted.forEach((hash, i) => {
      const raw = unwrap(values[i]);
      if (typeof raw !== 'string' || !raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.label === 'string') out[hash] = parsed;
      } catch {
        /* an unreadable value is not a label */
      }
    });
    return out;
  } catch {
    return {};
  }
}

export default {
  PROVENANCE_KEY,
  FAUCET_ACCOUNT_KEY,
  fundedByFaucet,
  recordInferredProvenance,
  readInferredProvenance,
};
