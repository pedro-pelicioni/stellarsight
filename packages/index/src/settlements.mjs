/**
 * packages/index/src/settlements.mjs — this facilitator's settlement feed.
 *
 * Every settlement this deployment performs is a fee-bumped transaction whose FEE account
 * is the facilitator's fee-payer (that is the whole non-custodial claim: the facilitator
 * pays the network, the buyer pays the seller, and the facilitator never sources the
 * money). Horizon indexes the fee account as a participant, so listing that account's
 * transactions IS the complete list of what this facilitator has settled.
 *
 * Scope, stated because it is easy to overclaim: this reads OUR activity, not the
 * ledger's. It is not a cross-operator index and the UI says so. What it can do that a
 * cross-operator index cannot is tell you WHY each payment exists: the scripts that
 * generated a payment recorded it (docs/status/provenance.json), and for traffic the
 * live stack settled after that file was last written, the facilitator records what it
 * could attribute at settle time — marked `inferred`, never merged with the recorded
 * ones (see labelRows).
 *
 * Pure functions with an injectable `fetch`, so the whole thing is testable offline.
 */

const DEFAULT_HORIZON = 'https://horizon-testnet.stellar.org';
const PER_TX_TIMEOUT_MS = 4000;
const OPS_CONCURRENCY = 5;

/** Labels the provenance map may carry. Anything else renders as `unlabeled`. */
export const KNOWN_LABELS = Object.freeze(['setup', 'demo', 'conformance', 'scripted-load', 'nightly-ci']);

const trim = (u) => String(u || '').replace(/\/+$/, '');

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(PER_TX_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Run `worker` over `items` with a small concurrency cap. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * fetchSettlementFeed({ horizonUrl, feePayer, limit, fetchImpl })
 *   -> { ok: true, rows, fetchedAt } | { ok: false, reason }
 *
 * Each row carries the ONE transfer the transaction performed. A transaction whose
 * operations do not resolve to exactly one asset transfer is dropped rather than
 * guessed at — the same rule apps/web/scripts/sync-txs.mjs applies, for the same reason:
 * a feed that invents an amount is worse than a feed with a gap.
 */
export async function fetchSettlementFeed({
  horizonUrl = DEFAULT_HORIZON,
  feePayer,
  limit = 25,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!feePayer) return { ok: false, reason: 'no fee-payer account configured, so there is no feed to read' };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no fetch implementation available' };

  const base = trim(horizonUrl);
  let page;
  try {
    page = await getJson(
      `${base}/accounts/${feePayer}/transactions?order=desc&limit=${Math.min(Math.max(limit, 1), 100)}&include_failed=true`,
      fetchImpl,
    );
  } catch (e) {
    return { ok: false, reason: `Horizon did not answer for ${feePayer}: ${e.message}` };
  }

  const txs = (page?._embedded?.records ?? []).filter((t) => t?.successful !== false);

  const rows = await mapLimit(txs, OPS_CONCURRENCY, async (tx) => {
    let transfer = null;
    try {
      const ops = await getJson(`${base}/transactions/${tx.hash}/operations`, fetchImpl);
      const changes = [];
      for (const op of ops?._embedded?.records ?? []) {
        for (const c of op?.asset_balance_changes ?? []) {
          if (c?.type === 'transfer') changes.push(c);
        }
      }
      // Exactly one transfer, or we cannot say what was paid.
      if (changes.length === 1) transfer = changes[0];
    } catch {
      /* an unreadable operations page costs this row its amount, not the feed */
    }

    return {
      txHash: tx.hash,
      settledAt: tx.created_at ?? null,
      ledger: tx.ledger ?? null,
      feeAccount: tx.fee_account ?? null,
      sourceAccount: tx.source_account ?? null,
      from: transfer?.from ?? null,
      to: transfer?.to ?? null,
      amount: transfer?.amount ?? null,
      assetCode: transfer?.asset_code ?? null,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${tx.hash}`,
    };
  });

  return { ok: true, rows: rows.filter(Boolean), fetchedAt: new Date().toISOString() };
}

/**
 * labelRows(rows, { provenance, inferred, records })
 *
 * Three joins, all conservative, and the first two are deliberately not merged:
 *
 *   provenance — the hash -> label map the scripts wrote. The script that generated a
 *                payment knows why it exists and asserts it, so these are `recorded`.
 *
 *   inferred   — what the live stack could attribute at settle time, from the durable
 *                store. Today that is one inference: the payer's money came out of our own
 *                public faucet, so the payment is demo traffic rather than demand. It is
 *                weaker evidence than an assertion and the row says so (`source:
 *                'inferred'`) rather than passing it off as a record. A recorded label
 *                always wins over an inferred one.
 *
 *                Neither ever upgrades an unknown hash: a hash in neither map is
 *                `unlabeled`, NEVER `organic`. We cannot prove a payment came from
 *                outside, and claiming it did would be exactly the overstatement this
 *                whole feed exists to avoid.
 *
 *   listing    — match a catalog record when the payee and the amount agree. That is a
 *                heuristic, so the row says so (`matchedBy: 'price'`) and the UI prints
 *                it, rather than presenting an inference as a record.
 */
export function labelRows(rows, { provenance = {}, inferred = {}, records = [] } = {}) {
  return rows.map((row) => {
    const recorded = provenance[row.txHash];
    const guessed = inferred[row.txHash];
    const known =
      recorded && KNOWN_LABELS.includes(recorded.label)
        ? { entry: recorded, source: 'recorded' }
        : guessed && KNOWN_LABELS.includes(guessed.label)
          ? { entry: guessed, source: 'inferred' }
          : null;
    const label = known ? known.entry.label : 'unlabeled';

    let listing = null;
    if (row.to && row.amount) {
      const match = records.find((r) => {
        if (r?.payTo !== row.to) return false;
        const price = Number(r?.maxAmountRequired ?? 0) / 1e7;
        return Math.abs(price - Number(row.amount)) < 1e-7;
      });
      if (match) {
        listing = {
          id: match.id,
          serviceName: match.resource?.serviceName ?? match.serviceName ?? null,
          matchedBy: 'price',
        };
      }
    }

    return {
      ...row,
      scheme: 'exact',
      provenance: {
        label,
        source: known ? known.source : 'absent',
        ...(known?.source === 'inferred' && known.entry.basis ? { basis: known.entry.basis } : {}),
      },
      listing,
    };
  });
}

export default { fetchSettlementFeed, labelRows, KNOWN_LABELS };
