/**
 * GET /explorer/feed — this facilitator's settled payments, read from Horizon.
 *
 * Deliberately scoped to OUR activity. An index of every x402 operator on the network is
 * a different product with a different honesty problem: aggregate numbers that read as
 * yours. This one names its own fee-payer in the payload and the UI prints the caveat.
 *
 * Horizon is slow enough per transaction that a browser polling it directly would be
 * unkind to both, so this aggregates server-side, memoises per instance for a minute, and
 * lets the CDN absorb the rest.
 */

import { readFileSync } from 'node:fs';

import { fetchSettlementFeed, labelRows } from '../../packages/index/src/settlements.mjs';
import { readInferredProvenance } from '../../packages/index/src/provenance-store.mjs';
import { createKv } from '../../packages/index/src/store.mjs';
import { getState, handlePreflight, readQuery, sendJson } from '../../packages/index/src/serverless.mjs';

const MEMO_TTL_MS = 60_000;
let memo = null;

/**
 * The hash -> label map, read once per instance. Missing is normal on a fresh checkout
 * and simply means every row renders as `unlabeled`.
 */
let provenanceCache;
function provenance() {
  if (provenanceCache !== undefined) return provenanceCache;
  try {
    const url = new URL('../../docs/status/provenance.json', import.meta.url);
    provenanceCache = JSON.parse(readFileSync(url, 'utf8')).hashes ?? {};
  } catch {
    provenanceCache = {};
  }
  return provenanceCache;
}

export default async function handler(req, res) {
  const allow = 'GET, HEAD, OPTIONS';
  if (handlePreflight(req, res, allow)) return res;
  if (req?.method !== 'GET' && req?.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, reason: `allowed methods: ${allow}` }, { Allow: allow, 'Cache-Control': 'no-store' });
  }

  const feePayer = process.env.FEEPAYER_PUBLIC;
  if (!feePayer) {
    return sendJson(
      res,
      503,
      {
        ok: false,
        reason:
          'this deployment has no FEEPAYER_PUBLIC configured, so it cannot name whose settlements it would be showing. Set it to the facilitator fee-payer account (a public key, not a secret).',
      },
      { 'Cache-Control': 'no-store' },
    );
  }

  const limit = Math.min(Math.max(Number.parseInt(readQuery(req)?.limit ?? '', 10) || 25, 1), 50);
  const fresh = memo && Date.now() - memo.at < MEMO_TTL_MS && memo.limit >= limit;

  if (!fresh) {
    const feed = await fetchSettlementFeed({
      horizonUrl: process.env.STELLAR_HORIZON_URL,
      feePayer,
      limit,
    });
    if (!feed.ok) {
      // Serve the stale memo rather than nothing when Horizon blinks; say which it is.
      if (memo) {
        return sendJson(
          res,
          200,
          { ...memo.body, stale: true, staleReason: feed.reason },
          { 'Cache-Control': 'no-store' },
        );
      }
      return sendJson(
        res,
        502,
        { ok: false, reason: feed.reason, horizon: { reachable: false } },
        { 'Cache-Control': 'no-store' },
      );
    }

    let records = [];
    try {
      const state = await getState({});
      records = state.catalog.all ? state.catalog.all() : [];
    } catch {
      /* the listing join is a nice-to-have; the settlements are the point */
    }

    // Labels the live stack recorded for traffic it settled itself. Kept separate from the
    // committed map on purpose — a script's assertion outranks the facilitator's inference,
    // and labelRows reports which is which. An unreachable store yields `{}`, which means
    // more rows render as `unlabeled`: degraded in the unflattering direction, which is the
    // only direction this feed is allowed to degrade in.
    let inferred = {};
    try {
      inferred = await readInferredProvenance(createKv(process.env), feed.rows.map((r) => r.txHash));
    } catch {
      /* no live labels — the committed map still applies */
    }

    memo = {
      at: Date.now(),
      limit,
      body: {
        ok: true,
        service: 'stellarsight-explorer',
        network: 'stellar:testnet',
        feePayer,
        scope: 'settlements performed by this deployment, read from Horizon — not an index of all x402 operators',
        fetchedAt: feed.fetchedAt,
        rows: labelRows(feed.rows, { provenance: provenance(), inferred, records }),
      },
    };
  }

  return sendJson(res, 200, memo.body, {
    // The CDN, not Horizon, absorbs the polling.
    'Cache-Control': 'public, max-age=0, s-maxage=30, stale-while-revalidate=300',
  });
}
