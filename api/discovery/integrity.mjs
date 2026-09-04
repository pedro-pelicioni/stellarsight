/**
 * GET /discovery/integrity — Vercel binding.
 *
 * The web console fetches this on every load to render the catalog-integrity ledger.
 * The verdicts come from the shared hostile-corpus replay in
 * packages/index/src/integrity-replay.mjs — the same module that bakes the frontend's
 * offline fallback, so the two can never drift.
 */

import { integrityHandler } from '../../packages/index/src/serverless.mjs';

export default function handler(req, res) {
  return integrityHandler(req, res);
}
