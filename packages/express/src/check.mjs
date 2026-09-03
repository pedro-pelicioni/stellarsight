/**
 * packages/express/src/check.mjs — replay the bazaar index's OWN integrity validation
 * against the records this paywall would announce, without booting an index.
 *
 * `createCatalog().upsert()` (`@stellarsight/index`) is the exact function
 * `POST /discovery/resources` calls, both locally (apps/facilitator/src/server.mjs) and
 * on the deployed serverless handler (packages/index/src/serverless.mjs). Running the
 * records `pay.announceRecords()` would send through a fresh, throwaway catalog therefore
 * answers the question a seller needs before their first announce — "what would the index
 * say?" — with the SAME validator, so the two can never drift. `@stellarsight/index`'s own
 * integrity-replay.mjs leans on the same trick for the public `/discovery/integrity` ledger.
 *
 * A fresh catalog per call is deliberate: `upsert` is stateful (offerings merge across
 * calls for the same id), and a leftover record from an earlier check could change a
 * later one's verdict. `createCatalog()` does no I/O until `.save()`/`.load()` are called
 * explicitly, so this is pure, in-memory and safe to run offline.
 */

import { createCatalog } from "@stellarsight/index";

/**
 * @param {object} pay - the object returned by stellarsightPaywall(), with every route
 *   already declared via pay(...)
 * @returns {{
 *   ok: boolean,
 *   baseUrlMissing: boolean,
 *   reason?: string,
 *   results: Array<{
 *     method: string,
 *     path: string|null,
 *     id?: string,
 *     ok: boolean,
 *     dropped: string[],
 *     reason?: string,
 *   }>,
 * }}
 */
export function checkListings(pay) {
  if (!pay || typeof pay.announceRecords !== "function" || !pay.config) {
    throw new TypeError("checkListings(pay): `pay` must be the object returned by stellarsightPaywall().");
  }

  // Mirrors the announcer's own precondition (announce.mjs): with no baseUrl, a resource
  // URL derived from the client-supplied Host header would let any caller list these
  // routes under an origin they control, so nothing is ever announced. Nothing is
  // checkable either — every record would fail on an unrelated, less specific reason.
  if (!pay.config.baseUrl) {
    return {
      ok: false,
      baseUrlMissing: true,
      reason:
        "`baseUrl` is not configured, so no route has an absolute, checkable resource URL " +
        "and nothing would ever be announced. Set `baseUrl` to this server's public origin.",
      results: [],
    };
  }

  const catalog = createCatalog();

  const results = pay.announceRecords().map(({ method, path, record }) => {
    if (!record) {
      return {
        method,
        path,
        ok: false,
        dropped: [],
        reason:
          "this route has no declared path, so it cannot be checked (or announced at boot). " +
          "Pass `path` to pay(path, { ... }) or pay({ path, ... }).",
      };
    }

    const verdict = catalog.upsert(record);
    return {
      method,
      path,
      id: verdict.id ?? record.id,
      ok: Boolean(verdict.ok),
      dropped: verdict.dropped ?? [],
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    };
  });

  return { ok: results.every((r) => r.ok), baseUrlMissing: false, results };
}

export default { checkListings };
