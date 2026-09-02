/**
 * STELLARSIGHT — thin, fail-soft HTTP client for the Bazaar index (`INDEX_URL`).
 *
 * Endpoints (CONTRACT.md, owned by packages/index served on :4022):
 *   GET /discovery/search?query&limit&cursor&...filters
 *       -> { items, partialResults, pagination:{ limit, cursor } }
 *   GET /discovery/resources?type&payTo&scheme&network&extensions&limit&offset
 *       -> { items, total, limit, offset }
 *
 * Never throws. Returns `{ ok:true, ... }` or `{ ok:false, code, reason }`.
 */

import { ERROR_CODES, fail, loadConfig } from './pay.mjs';

const errText = (e) => (e instanceof Error ? e.message : String(e ?? 'unknown error'));

/**
 * In-process mode has no HTTP status line, so nothing maps a handler failure onto an
 * error the way `getJson` does for the network path. The discovery handlers signal one
 * with `{ status: 500, body: { error, message } }`; without this check that body reaches
 * `itemsOf` as 0 items and the caller reports NO_RESULTS / NOT_FOUND — a confident wrong
 * reason ("the catalogue may still be empty") for what is actually an index failure.
 */
function inProcessFailure(res) {
  const status = Number(res?.status);
  if (!Number.isFinite(status) || status < 400) return null;
  return fail(
    'STELLARSIGHT_INDEX_ERROR',
    `In-process discovery returned status ${status}: ${res?.body?.error || res?.body?.message || 'no detail'}` +
      (res?.body?.error && res?.body?.message ? ` (${res.body.message})` : '')
  );
}

/** In-process mode never talks to a host; do not report cfg.indexUrl's localhost default. */
const INPROCESS_SOURCE = 'inprocess';

async function getJson(url, timeoutMs = 8000) {
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const to = /abort|timeout/i.test(errText(err));
    return fail(
      to ? 'STELLARSIGHT_TIMEOUT' : 'STELLARSIGHT_INDEX_UNREACHABLE',
      to
        ? `The bazaar index at ${url} did not answer within ${timeoutMs}ms.`
        : `The bazaar index is not reachable at ${url} (${errText(err)}). ` +
          'Start the stack with "npm run dev:all" from the repo root, or point INDEX_URL elsewhere.'
    );
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    return fail('STELLARSIGHT_INDEX_ERROR', `The bazaar index returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    return fail(
      'STELLARSIGHT_INDEX_ERROR',
      `The bazaar index returned HTTP ${res.status}: ${json?.error || json?.reason || text.slice(0, 200) || 'no body'}`
    );
  }
  return { ok: true, json };
}

/** Normalise whatever the index returns into an array of records. */
function itemsOf(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.items)) return json.items;
  if (Array.isArray(json?.results)) return json.results;
  if (Array.isArray(json?.resources)) return json.resources;
  return [];
}

/**
 * Read one record in EITHER shape.
 *
 * The spec's `DiscoveryResource` puts the URL in `resource` as a plain STRING and the
 * presentation fields at the top level, with the payment terms in `accepts[0]`. This
 * repo's internal catalog record nests them under `resource: { url, serviceName, … }`.
 * Both shapes reach this client — the deployment and :4022 now serve the spec shape, a
 * third-party facilitator may serve either — so read the spec shape first and fall back
 * to the nested block rather than returning `null` for a record that is perfectly valid.
 */
function fieldsOf(rec) {
  const block = rec?.resource && typeof rec.resource === 'object' ? rec.resource : {};
  const accepts = Array.isArray(rec?.accepts) && rec.accepts.length ? rec.accepts[0] : {};
  return {
    url: typeof rec?.resource === 'string' ? rec.resource : (block.url ?? null),
    serviceName: rec?.serviceName ?? block.serviceName ?? null,
    description: rec?.description ?? block.description ?? null,
    tags: rec?.tags ?? block.tags ?? [],
    iconUrl: rec?.iconUrl ?? block.iconUrl ?? null,
    network: rec?.network ?? accepts.network ?? null,
    scheme: rec?.scheme ?? accepts.scheme ?? null,
    payTo: rec?.payTo ?? accepts.payTo ?? null,
    asset: rec?.asset ?? accepts.asset ?? null,
    // v2 names the price `amount`; the v1 name is kept as an additive mirror.
    maxAmountRequired: rec?.maxAmountRequired ?? accepts.amount ?? null,
    lastSeenAt: rec?.lastSeenAt ?? (rec?.lastUpdated ? Date.parse(rec.lastUpdated) || null : null)
  };
}

/** Project a record down to the agent-facing summary shape. */
export function summarise(rec, extra = {}) {
  const f = fieldsOf(rec);
  return {
    id: rec?.id ?? f.url ?? null,
    url: f.url,
    serviceName: f.serviceName,
    description: f.description,
    tags: f.tags,
    type: rec?.type ?? null,
    network: f.network,
    scheme: f.scheme,
    payTo: f.payTo,
    asset: f.asset,
    maxAmountRequired: f.maxAmountRequired,
    settlements: rec?.settlements ?? 0,
    lastSeenAt: f.lastSeenAt,
    ...(rec?.seeded === true ? { seeded: true } : {}),
    ...extra
  };
}

async function searchInProcess(params) {
  try {
    const { getState } = await import('../../../packages/index/src/serverless.mjs');
    const { searchResources } = await import('../../../packages/index/src/discovery.mjs');
    const state = await getState();
    const res = searchResources(state.catalog, params);
    return inProcessFailure(res) ?? { ok: true, json: res.body };
  } catch (err) {
    return fail('STELLARSIGHT_INDEX_ERROR', `In-process discovery failed: ${errText(err)}`);
  }
}

async function browseInProcess(params) {
  try {
    const { getState } = await import('../../../packages/index/src/serverless.mjs');
    const { listResources } = await import('../../../packages/index/src/discovery.mjs');
    const state = await getState();
    const res = listResources(state.catalog, params);
    return inProcessFailure(res) ?? { ok: true, json: res.body };
  } catch (err) {
    return fail('STELLARSIGHT_INDEX_ERROR', `In-process discovery failed: ${errText(err)}`);
  }
}

async function describeInProcess(wanted) {
  try {
    const { getState } = await import('../../../packages/index/src/serverless.mjs');
    const { listResources, searchResources } = await import('../../../packages/index/src/discovery.mjs');
    const state = await getState();
    const matches = (r) =>
      r?.id === wanted ||
      (typeof r?.resource === 'string' ? r.resource === wanted : r?.resource?.url === wanted);
    // Both calls are checked: an index failure on either leg must not degrade into
    // NOT_FOUND, which would tell the agent its id is wrong when the index is broken.
    const listed = listResources(state.catalog, { limit: 100 });
    const listedFailed = inProcessFailure(listed);
    if (listedFailed) return listedFailed;
    let rec = itemsOf(listed.body).find(matches);
    if (!rec) {
      const searched = searchResources(state.catalog, { query: wanted, limit: 25 });
      const searchedFailed = inProcessFailure(searched);
      if (searchedFailed) return searchedFailed;
      rec = itemsOf(searched.body).find(matches);
    }
    return { ok: true, rec };
  } catch (err) {
    return fail('STELLARSIGHT_INDEX_ERROR', `In-process discovery failed: ${errText(err)}`);
  }
}

/**
 * Ranked natural-language search.
 * @returns {Promise<{ok:true,items:Array,partialResults:boolean,pagination:object,source:string}|{ok:false,code,reason}>}
 */
export async function search({ query, limit = 5, network, maxPrice, type, payTo, config } = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return fail('STELLARSIGHT_BAD_REQUEST', 'A non-empty `query` string is required for stellarsight_search.');
  }
  const cfg = loadConfig(config || {});
  let res;
  let inProcess = false;

  if (cfg.indexUrl === 'inprocess' || config?.inProcess) {
    inProcess = true;
    res = await searchInProcess({ query: query.trim(), limit: clampLimit(limit), network, type, payTo });
  } else {
    const u = new URL(`${cfg.indexUrl}/discovery/search`);
    u.searchParams.set('query', query.trim());
    u.searchParams.set('limit', String(clampLimit(limit)));
    if (network) u.searchParams.set('network', network);
    if (type) u.searchParams.set('type', type);
    if (payTo) u.searchParams.set('payTo', payTo);
    res = await getJson(u.toString());
  }

  if (!res.ok) return res;

  let items = itemsOf(res.json).map((r) =>
    summarise(r, {
      _explain: r?._explain ?? null,
      score: r?._score ?? r?.score ?? r?._explain?.score ?? null
    })
  );

  if (maxPrice !== undefined && maxPrice !== null && String(maxPrice) !== '') {
    let ceiling;
    try {
      ceiling = BigInt(String(maxPrice));
    } catch {
      return fail('STELLARSIGHT_BAD_REQUEST', `maxPrice "${maxPrice}" must be an integer amount in atomic units.`);
    }
    const before = items.length;
    items = items.filter((i) => {
      try {
        return BigInt(String(i.maxAmountRequired ?? '0')) <= ceiling;
      } catch {
        return false;
      }
    });
    if (items.length === 0 && before > 0) {
      return fail(
        'STELLARSIGHT_NO_RESULTS',
        `${before} resource(s) matched "${query}" but all of them price above the caller's budget of ${maxPrice} atomic units.`
      );
    }
  }

  if (items.length === 0) {
    return fail(
      'STELLARSIGHT_NO_RESULTS',
      `No resource in the bazaar index matched "${query}"${network ? ` on ${network}` : ''}. ` +
        `The index returned 0 matches; try broader terms, or call stellarsight_browse to see the whole catalogue.`
    );
  }

  return {
    ok: true,
    query: query.trim(),
    items,
    partialResults: Boolean(res.json?.partialResults),
    pagination: res.json?.pagination ?? { limit: clampLimit(limit), cursor: null },
    source: inProcess ? INPROCESS_SOURCE : cfg.indexUrl
  };
}

/** Unranked catalogue listing with filters. */
export async function browse({ type, payTo, network, scheme, extensions, limit = 20, offset = 0, config } = {}) {
  const cfg = loadConfig(config || {});
  let res;
  let inProcess = false;

  if (cfg.indexUrl === 'inprocess' || config?.inProcess) {
    inProcess = true;
    res = await browseInProcess({
      type,
      payTo,
      network,
      scheme,
      extensions,
      limit: clampLimit(limit, 100),
      offset: Math.max(0, Number(offset) || 0)
    });
  } else {
    const u = new URL(`${cfg.indexUrl}/discovery/resources`);
    if (type) u.searchParams.set('type', type);
    if (payTo) u.searchParams.set('payTo', payTo);
    if (network) u.searchParams.set('network', network);
    if (scheme) u.searchParams.set('scheme', scheme);
    if (extensions) u.searchParams.set('extensions', Array.isArray(extensions) ? extensions.join(',') : String(extensions));
    u.searchParams.set('limit', String(clampLimit(limit, 100)));
    u.searchParams.set('offset', String(Math.max(0, Number(offset) || 0)));
    res = await getJson(u.toString());
  }

  if (!res.ok) return res;

  const items = itemsOf(res.json).map((r) => summarise(r));
  if (items.length === 0) {
    return fail(
      'STELLARSIGHT_NO_RESULTS',
      `The bazaar index returned no resources for these filters ` +
        `(${JSON.stringify({ type, payTo, network, scheme, extensions })}). The catalogue may still be empty.`
    );
  }
  return {
    ok: true,
    items,
    total: res.json?.total ?? items.length,
    limit: res.json?.limit ?? clampLimit(limit, 100),
    offset: res.json?.offset ?? (Number(offset) || 0),
    source: inProcess ? INPROCESS_SOURCE : cfg.indexUrl
  };
}

/**
 * Full metadata for one resource id, including per-parameter descriptions so an
 * agent can construct a valid call with no external docs.
 */
export async function describe({ id, config } = {}) {
  if (!id || typeof id !== 'string' || !id.trim()) {
    return fail('STELLARSIGHT_BAD_REQUEST', 'A non-empty resource `id` is required for stellarsight_describe.');
  }
  const cfg = loadConfig(config || {});
  const wanted = id.trim();

  if (cfg.indexUrl === 'inprocess' || config?.inProcess) {
    const inProc = await describeInProcess(wanted);
    if (!inProc.ok) return inProc;
    if (!inProc.rec) {
      // No host to name here — the index is this process, not cfg.indexUrl's default.
      return fail(
        'STELLARSIGHT_NOT_FOUND',
        `No resource with id "${wanted}" is registered in the bazaar index. ` +
          `Use stellarsight_search or stellarsight_browse to obtain a valid id.`
      );
    }
    return { ok: true, ...describeRecord(inProc.rec), source: INPROCESS_SOURCE };
  }

  // The index has no by-id route in the contract, so resolve through the two
  // documented endpoints: exact-id scan over the catalogue, then search fallback.
  const listed = await getJson(`${cfg.indexUrl}/discovery/resources?limit=100`);
  if (!listed.ok) return listed;

  const matches = (r) =>
    r?.id === wanted ||
    (typeof r?.resource === 'string' ? r.resource === wanted : r?.resource?.url === wanted);

  let rec = itemsOf(listed.json).find(matches);

  if (!rec) {
    const u = new URL(`${cfg.indexUrl}/discovery/search`);
    u.searchParams.set('query', wanted);
    u.searchParams.set('limit', '25');
    const found = await getJson(u.toString());
    if (found.ok) rec = itemsOf(found.json).find(matches);
  }

  if (!rec) {
    return fail(
      'STELLARSIGHT_NOT_FOUND',
      `No resource with id "${wanted}" is registered in the bazaar index at ${cfg.indexUrl}. ` +
        `Use stellarsight_search or stellarsight_browse to obtain a valid id.`
    );
  }

  return { ok: true, ...describeRecord(rec), source: cfg.indexUrl };
}

/** Turn a raw bazaar record into a call-construction brief. Pure — also used offline. */
export function describeRecord(rec) {
  const params = normaliseParams(rec);
  const f = fieldsOf(rec);
  return {
    id: rec?.id ?? f.url ?? null,
    // Always the presentation BLOCK, whichever shape arrived: an agent building a call
    // wants the fields, not the spec's bare URL string.
    resource: { url: f.url, serviceName: f.serviceName, description: f.description, tags: f.tags, ...(f.iconUrl ? { iconUrl: f.iconUrl } : {}) },
    type: rec?.type ?? null,
    network: f.network,
    scheme: f.scheme,
    payTo: f.payTo,
    asset: f.asset,
    maxAmountRequired: f.maxAmountRequired,
    routeTemplate: rec?.routeTemplate ?? rec?.extensions?.bazaar?.routeTemplate ?? null,
    extensions: Array.isArray(rec?.extensions)
      ? rec.extensions
      : rec?.extensions && typeof rec.extensions === 'object'
        ? Object.keys(rec.extensions)
        : [],
    settlements: rec?.settlements ?? 0,
    lastSeenAt: f.lastSeenAt,
    input: rec?.input ?? rec?.extensions?.bazaar?.info?.input ?? null,
    output: rec?.output ?? rec?.extensions?.bazaar?.info?.output ?? null,
    parameters: params,
    howToCall: {
      tool: 'stellarsight_pay',
      url: f.url,
      method: rec?.input?.method ?? (rec?.type === 'mcp' ? 'MCP' : 'GET'),
      params: Object.fromEntries(params.map((p) => [p.name, p.example ?? `<${p.type || 'string'}>`])),
      methodHint:
        (rec?.input?.method ?? 'GET') === 'GET'
          ? 'Pass params as the query string (stellarsight_pay defaults to GET).'
          : `This endpoint is ${rec?.input?.method}: call stellarsight_pay with method:"${rec?.input?.method}" and pass params as the JSON body.`,
      note:
        rec?.type === 'mcp'
          ? `MCP tool "${rec?.input?.toolName ?? 'unknown'}" — call the upstream MCP server; stellarsight_pay covers the HTTP-facing 402 leg.`
          : 'stellarsight_pay performs the 402 challenge, signs the Soroban auth entry with PAYER_SECRET and retries.'
    }
  };
}

/** Flatten queryParams / body / JSON-Schema inputSchema into one parameter list. */
function normaliseParams(record) {
  // Spec shape carries the declaration under extensions.bazaar.info; the internal record
  // carries it flattened. `describe` must work against both.
  const rec = record?.input
    ? record
    : { ...record, input: record?.extensions?.bazaar?.info?.input, output: record?.extensions?.bazaar?.info?.output };
  const out = [];
  const push = (name, spec, where) => {
    if (!name) return;
    // A spec can be a JSON-Schema-ish object, or just an example value.
    const isSpec = spec && typeof spec === 'object' && !Array.isArray(spec);
    const s = isSpec ? spec : {};
    const asExample = isSpec ? undefined : spec;
    out.push({
      name,
      in: where,
      type: s.type ?? (asExample === undefined ? 'string' : Array.isArray(spec) ? 'array' : typeof asExample),
      required: Boolean(s.required),
      description: s.description ?? null,
      enum: s.enum ?? null,
      example: s.example ?? s.default ?? (asExample === undefined ? null : asExample)
    });
  };

  const qp = rec?.input?.queryParams;
  if (qp && typeof qp === 'object') for (const [k, v] of Object.entries(qp)) push(k, v, 'query');

  const body = rec?.input?.body;
  if (body && typeof body === 'object') for (const [k, v] of Object.entries(body)) push(k, v, 'body');

  const schema = rec?.input?.inputSchema;
  if (schema && typeof schema === 'object' && schema.properties) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [k, v] of Object.entries(schema.properties)) {
      push(k, v, 'mcp-argument');
      const last = out[out.length - 1];
      if (last) last.required = required.has(k);
    }
  }
  return out;
}

function clampLimit(n, max = 50) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 5;
  return Math.min(Math.floor(v), max);
}

export { ERROR_CODES };
