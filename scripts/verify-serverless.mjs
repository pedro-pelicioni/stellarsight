#!/usr/bin/env node
/**
 * scripts/verify-serverless.mjs — exercise the deployed discovery API without deploying.
 *
 * `npx vercel dev` is the faithful path but needs an authenticated Vercel account, which
 * a checkout of this repo does not have. So this harness imports the ACTUAL function
 * files under api/ — the same modules Vercel will load — drives them with mock Node
 * `req`/`res` objects, and asserts the wire contract:
 *
 *   · every filter narrows the result set
 *   · offset and cursor pagination walk the catalog without overlap
 *   · `_explain` is present on search results and its parts sum to `_score`
 *   · CORS is permissive and the OPTIONS preflight is answered
 *   · `Cache-Control` carries an s-maxage + stale-while-revalidate for the CDN
 *   · the write path degrades cleanly with no store, and works with one
 *   · vercel.json routes /discovery/* to the functions BEFORE the SPA catch-all
 *   · the stock @x402/extensions bazaar client can read every response (section 7)
 *
 * That last one is the load-bearing check, and it does NOT inspect raw JSON. It imports
 * the real `withBazaar` from `@x402/extensions`, points it at these handlers over a real
 * socket, and asserts on what THE CLIENT hands back — then re-validates every `accepts`
 * entry with `@x402/core`'s own `PaymentRequirementsSchema`. Reading the field names the repo
 * itself emits would agree with the bug this exists to catch (search once emitted `items`
 * where `SearchDiscoveryResourcesResponse` declares `resources`, and `withBazaar(client).search()`
 * returned `undefined`), so the assertion is on what the client returns.
 *
 * It is deliberately NOT named *.test.mjs: `npm test` counts suites, and this is a
 * deployment check rather than a unit suite.
 *
 *   node scripts/verify-serverless.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

// The unmodified, shipped bazaar client and the unmodified, shipped payment schema.
// Nothing in this repo is allowed to stand in for either of them.
import { withBazaar } from '@x402/extensions/bazaar';
import { PaymentRequirementsSchema, isPaymentRequirementsV2 } from '@x402/core/schemas';

import resourcesFn from '../api/discovery/resources.mjs';
import searchFn from '../api/discovery/search.mjs';
import healthFn from '../api/discovery/health.mjs';
import integrityFn from '../api/discovery/integrity.mjs';
import mcpFn from '../api/mcp.mjs';
import {
  resourcesHandler,
  searchHandler,
  healthHandler,
  resetState,
} from '../packages/index/src/serverless.mjs';
import * as replayModule from '../packages/index/src/integrity-replay.mjs';

const ROOT = new URL('..', import.meta.url);

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => {
          passed++;
          console.log(`  ok   ${name}`);
        },
        (err) => {
          failures.push({ name, err });
          console.log(`  FAIL ${name}\n         ${err?.message ?? err}`);
        },
      );
    }
    passed++;
    console.log(`  ok   ${name}`);
    return Promise.resolve();
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n         ${err?.message ?? err}`);
    return Promise.resolve();
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/* ─────────────────────────────── mocks ─────────────────────────────── */

function mockReq(method, url, { headers = {}, body, query } = {}) {
  const req = { method, url, headers };
  if (body !== undefined) req.body = body;
  if (query !== undefined) req.query = query;
  return req;
}

function mockRes() {
  return {
    statusCode: 0,
    headers: Object.create(null),
    raw: '',
    ended: false,
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = String(v);
    },
    getHeader(k) {
      return this.headers[String(k).toLowerCase()];
    },
    end(chunk) {
      this.raw = chunk === undefined ? '' : String(chunk);
      this.ended = true;
    },
    get json() {
      return this.raw ? JSON.parse(this.raw) : null;
    },
  };
}

/** Drive one handler and return the finished mock response. */
async function call(fn, req) {
  const res = mockRes();
  await fn(req, res);
  assert(res.ended, 'handler never ended the response');
  return res;
}

/* ─────────────────────────── the checks ─────────────────────────── */

async function main() {
  console.log('\nSTELLARSIGHT serverless verification\n');

  /* ---------- 1. GET /discovery/resources through the real api/ file ---------- */
  console.log('api/discovery/resources.mjs');

  const list = await call(resourcesFn, mockReq('GET', '/discovery/resources?limit=5'));

  await check('200 with the spec envelope', () => {
    eq(list.statusCode, 200, 'status');
    const b = list.json;
    eq(b.x402Version, 2, 'x402Version');
    assert(Array.isArray(b.items), '`items` must be an array');
    assert(typeof b.total === 'number' && b.total > 0, '`total` must be a positive number');
    eq(b.limit, 5, 'limit echoed');
    eq(b.offset, 0, 'offset echoed');
    assert(b.pagination && b.pagination.limit === 5 && b.pagination.offset === 0, '`pagination` mirrors limit/offset');
    eq(b.items.length, 5, 'limit is honoured');
  });

  await check("STELLARSIGHT's additive fields survive the spec projection", () => {
    // These are NOT spec fields. They are the ones CONTRACT.md promises the console and
    // the MCP agent can still read after the record is projected onto DiscoveryResource.
    const rec = list.json.items[0];
    for (const field of ['id', 'network', 'scheme', 'payTo', 'asset', 'maxAmountRequired', 'lastSeenAt', 'settlements']) {
      assert(field in rec, `record is missing the additive field \`${field}\``);
    }
    eq(rec.maxAmountRequired, rec.accepts[0].amount, 'the v1 mirror must agree with accepts[0].amount');
  });

  await check('the catalog is seeded at cold start (no configuration required)', () => {
    assert(list.json.total >= 25, `expected the seed corpus, got total=${list.json.total}`);
  });

  await check('CORS is permissive', () => {
    eq(list.getHeader('access-control-allow-origin'), '*', 'Access-Control-Allow-Origin');
    assert(/GET/.test(list.getHeader('access-control-allow-methods') ?? ''), 'Access-Control-Allow-Methods');
    assert(/Content-Type/i.test(list.getHeader('access-control-allow-headers') ?? ''), 'Access-Control-Allow-Headers');
  });

  await check('Cache-Control is CDN-friendly', () => {
    const cc = list.getHeader('cache-control') ?? '';
    assert(/s-maxage=\d+/.test(cc), `expected an s-maxage, got "${cc}"`);
    assert(/stale-while-revalidate=\d+/.test(cc), `expected stale-while-revalidate, got "${cc}"`);
  });

  await check('OPTIONS preflight answers 204 with the allowed methods', async () => {
    const res = await call(resourcesFn, mockReq('OPTIONS', '/discovery/resources'));
    eq(res.statusCode, 204, 'preflight status');
    eq(res.getHeader('access-control-allow-origin'), '*', 'preflight ACAO');
    assert(/POST/.test(res.getHeader('access-control-allow-methods') ?? ''), 'preflight allows POST');
  });

  await check('filters narrow the set: type=mcp', async () => {
    const res = await call(resourcesFn, mockReq('GET', '/discovery/resources?type=mcp&limit=100'));
    const items = res.json.items;
    assert(items.length > 0, 'expected at least one MCP resource');
    assert(items.every((r) => r.type === 'mcp'), 'a non-mcp record leaked through the type filter');
    assert(items.length < list.json.total, 'the filter did not narrow anything');
  });

  await check('filters narrow the set: payTo, scheme, network, extensions', async () => {
    const all = await call(resourcesFn, mockReq('GET', '/discovery/resources?limit=100'));
    const payTo = all.json.items[0].payTo;

    const byPayTo = await call(resourcesFn, mockReq('GET', `/discovery/resources?payTo=${payTo}&limit=100`));
    assert(byPayTo.json.items.every((r) => r.payTo === payTo), 'payTo filter leaked');
    assert(byPayTo.json.total < all.json.total, 'payTo filter did not narrow');

    const byScheme = await call(resourcesFn, mockReq('GET', '/discovery/resources?scheme=exact&limit=100'));
    assert(byScheme.json.items.every((r) => r.scheme === 'exact'), 'scheme filter leaked');

    const byNetwork = await call(resourcesFn, mockReq('GET', '/discovery/resources?network=stellar%3Atestnet&limit=100'));
    assert(byNetwork.json.total > 0 && byNetwork.json.items.every((r) => r.network === 'stellar:testnet'), 'network filter');

    // [spec: DiscoveryResource.extensions is a Record<string, unknown>, not a string array]
    const byExt = await call(resourcesFn, mockReq('GET', '/discovery/resources?extensions=bazaar&limit=100'));
    assert(byExt.json.total > 0 && byExt.json.items.every((r) => 'bazaar' in r.extensions), 'extensions filter');

    const byMissingExt = await call(resourcesFn, mockReq('GET', '/discovery/resources?extensions=nope&limit=100'));
    eq(byMissingExt.json.total, 0, 'an unknown extension must match nothing');
  });

  await check('offset pagination does not overlap', async () => {
    const p1 = await call(resourcesFn, mockReq('GET', '/discovery/resources?limit=10&offset=0'));
    const p2 = await call(resourcesFn, mockReq('GET', '/discovery/resources?limit=10&offset=10'));
    eq(p1.json.items.length, 10, 'page 1 size');
    assert(p2.json.items.length > 0, 'page 2 is empty');
    const ids = new Set(p1.json.items.map((r) => r.id));
    assert(p2.json.items.every((r) => !ids.has(r.id)), 'offset paging returned a duplicate');
    eq(p2.json.offset, 10, 'offset echoed');
  });

  await check('Vercel-style pre-parsed req.query is honoured', async () => {
    const res = await call(resourcesFn, mockReq('GET', '/discovery/resources', { query: { type: 'mcp', limit: '3' } }));
    eq(res.statusCode, 200, 'status');
    eq(res.json.items.length, 3, 'limit from req.query');
    assert(res.json.items.every((r) => r.type === 'mcp'), 'type from req.query');
  });

  /* ---------- 2. GET /discovery/search ---------- */
  console.log('\napi/discovery/search.mjs');

  const search = await call(searchFn, mockReq('GET', '/discovery/search?query=invoice%20ocr&limit=5'));

  await check('200 with partialResults and pagination{limit,cursor}', () => {
    eq(search.statusCode, 200, 'status');
    const b = search.json;
    eq(b.x402Version, 2, 'x402Version');
    // [spec: SearchDiscoveryResourcesResponse names the array `resources`; only the LIST
    //  endpoint uses `items`. The two envelopes differ deliberately, and so does their
    //  pagination — offset/total for list, cursor for search.]
    assert(Array.isArray(b.resources) && b.resources.length > 0, '`resources` must be a non-empty array');
    eq(typeof b.partialResults, 'boolean', '`partialResults` must be a boolean');
    assert(b.pagination && typeof b.pagination === 'object', '`pagination` must be an object');
    assert('limit' in b.pagination, '`pagination.limit` is required');
    assert('cursor' in b.pagination, '`pagination.cursor` is required (null when unavailable)');
    assert(!('offset' in b.pagination), 'search paginates by cursor, not offset');
    eq(b.pagination.limit, 5, 'pagination.limit');
  });

  await check('`items` is still emitted as a deprecated alias of the same array', () => {
    // One release of grace for consumers written against the old STELLARSIGHT envelope.
    // When this alias is removed, DELETE THIS CHECK — do not weaken it.
    const b = search.json;
    assert(Array.isArray(b.items), '`items` alias missing');
    eq(b.items.length, b.resources.length, 'alias length');
    assert(
      b.items.every((r, i) => r.id === b.resources[i].id),
      'the `items` alias must be the same array in the same order',
    );
  });

  await check('the query actually ranks — invoice ocr finds the OCR service first', () => {
    const top = search.json.resources[0];
    assert(/ocr/i.test(top.resource) || /ocr/i.test(top.serviceName ?? ''), `unexpected top hit: ${top.id}`);
  });

  await check('_explain is present and its parts sum to _score', () => {
    for (const rec of search.json.resources) {
      assert(rec._explain && typeof rec._explain === 'object', `_explain missing on ${rec.id}`);
      const p = rec._explain.parts;
      assert(p && typeof p === 'object', `_explain.parts missing on ${rec.id}`);
      for (const key of ['relevance', 'completeness', 'popularity', 'recency']) {
        assert(typeof p[key] === 'number', `_explain.parts.${key} missing on ${rec.id}`);
      }
      const sum = p.relevance + p.completeness + p.popularity + p.recency;
      assert(Math.abs(sum - rec._score) < 1e-3, `parts sum ${sum} != _score ${rec._score} on ${rec.id}`);
      assert(Array.isArray(rec._explain.terms), `_explain.terms missing on ${rec.id}`);
      assert(rec._explain.terms.every((t) => 'tf' in t && 'idf' in t && 'contribution' in t), '_explain.terms need tf/idf/contribution');
    }
  });

  await check('cursor pagination walks the result set without overlap', async () => {
    const p1 = await call(searchFn, mockReq('GET', '/discovery/search?query=stellar&limit=2'));
    assert(p1.json.partialResults === true, 'expected more matches than one page');
    const cursor = p1.json.pagination.cursor;
    assert(typeof cursor === 'string' && cursor.length > 0, 'expected a continuation cursor');

    const p2 = await call(searchFn, mockReq('GET', `/discovery/search?query=stellar&limit=2&cursor=${encodeURIComponent(cursor)}`));
    const ids = new Set(p1.json.resources.map((r) => r.id));
    assert(p2.json.resources.length > 0, 'page 2 is empty');
    assert(p2.json.resources.every((r) => !ids.has(r.id)), 'cursor paging returned a duplicate');
  });

  await check('the last page reports partialResults=false and cursor=null', async () => {
    const res = await call(searchFn, mockReq('GET', '/discovery/search?query=invoice%20ocr&limit=100'));
    eq(res.json.partialResults, false, 'partialResults on the final page');
    eq(res.json.pagination.cursor, null, 'cursor on the final page');
  });

  await check('search honours the shared filters', async () => {
    const res = await call(searchFn, mockReq('GET', '/discovery/search?query=stellar&type=mcp&limit=100'));
    assert(res.json.resources.length > 0, 'expected MCP hits for "stellar"');
    assert(res.json.resources.every((r) => r.type === 'mcp'), 'type filter leaked on search');
  });

  await check('a missing query parameter is a 400, not an empty 200', async () => {
    const res = await call(searchFn, mockReq('GET', '/discovery/search'));
    eq(res.statusCode, 400, 'status');
    eq(res.json.error, 'missing_query', 'error code');
    eq(res.getHeader('access-control-allow-origin'), '*', 'CORS is set on errors too');
  });

  await check('an empty query browses the catalog by the quality prior', async () => {
    const res = await call(searchFn, mockReq('GET', '/discovery/search?query=&limit=5'));
    eq(res.statusCode, 200, 'status');
    eq(res.json.resources.length, 5, 'browse returns results');
  });

  await check('POST to /discovery/search is 405 with an Allow header', async () => {
    const res = await call(searchFn, mockReq('POST', '/discovery/search?query=x'));
    eq(res.statusCode, 405, 'status');
    assert(/GET/.test(res.getHeader('allow') ?? ''), 'Allow header');
  });

  /* ---------- 3. GET /discovery/health ---------- */
  console.log('\napi/discovery/health.mjs');

  await check('reports mode, record count and build', async () => {
    const res = await call(healthFn, mockReq('GET', '/discovery/health'));
    eq(res.statusCode, 200, 'status');
    const b = res.json;
    eq(b.ok, true, 'ok');
    eq(b.mode, 'seed', 'unconfigured deployments run in read-only seed mode');
    eq(b.writable, false, 'read-only without a store');
    assert(typeof b.records === 'number' && b.records > 0, 'records');
    eq(b.records, b.seededRecords + b.liveRecords, 'seeded + live must equal records');
    eq(b.durableStore.configured, false, 'durableStore.configured');
    assert(b.build && 'commit' in b.build && 'env' in b.build && 'node' in b.build, 'build info');
    eq(res.getHeader('cache-control'), 'no-store', 'health must not be CDN-cached');
    assert(
      b.endpoints.includes('/discovery/integrity'),
      'health must advertise the integrity endpoint',
    );
    // The full store host:port is an unnecessary public disclosure (see maskStoreHost).
    // An unconfigured deployment has no host at all; when one is set it must be masked.
    assert(
      b.durableStore.host === null || !/:\d+$/.test(b.durableStore.host),
      'durableStore.host must not expose a port publicly',
    );
  });

  /* ---------- 3b. GET /discovery/integrity through the real api/ file ---------- */
  console.log('\napi/discovery/integrity.mjs');

  await check('serves the hostile-corpus replay with honest provenance', async () => {
    const res = await call(integrityFn, mockReq('GET', '/discovery/integrity?limit=20'));
    eq(res.statusCode, 200, 'status');
    const b = res.json;
    eq(b.ok, true, 'ok');
    // `source` is the field the web console keys its replay-vs-observed banner off.
    // This endpoint replays a fixed corpus; claiming anything else would be the exact
    // static-file-as-live-feed lie the integrity panel exists not to tell.
    eq(b.source, 'replay', 'replay verdicts must say so');
    assert(Array.isArray(b.integrity) && b.integrity.length > 0, 'integrity rows');
    assert(b.integrity.length <= 20, 'limit respected');
    eq(b.skippedCases, 0, 'no corpus case may be silently accepted by the validator');
    for (const row of b.integrity) {
      assert(row.verdict === 'rejected' || row.verdict === 'soft-drop', `verdict: ${row.verdict}`);
      assert(typeof row.reason === 'string' && row.reason.length > 0, 'every row carries a non-null reason');
      assert(typeof row.at === 'number' && row.at > 0, 'every row is timestamped');
    }
    // Rejections sort first so a bounded render never hides them behind soft-drops.
    const firstSoftDrop = b.integrity.findIndex((r) => r.verdict === 'soft-drop');
    const lastRejected = b.integrity.map((r) => r.verdict).lastIndexOf('rejected');
    assert(firstSoftDrop === -1 || lastRejected < firstSoftDrop, 'rejected rows sort first');
  });

  await check('clamps limit and refuses non-GET with a reasoned 405', async () => {
    const one = await call(integrityFn, mockReq('GET', '/discovery/integrity?limit=1'));
    eq(one.json.integrity.length, 1, 'limit=1');
    const put = await call(integrityFn, mockReq('PUT', '/discovery/integrity'));
    eq(put.statusCode, 405, 'PUT is refused');
    assert(put.getHeader('allow')?.includes('GET'), '405 names the allowed methods');
    const pre = await call(integrityFn, mockReq('OPTIONS', '/discovery/integrity'));
    eq(pre.statusCode, 204, 'CORS preflight');
  });

  await check('replay verdicts match the baked frontend fallback byte for byte', () => {
    // Same corpus, same validator, two bindings — if these ever differ, the endpoint
    // and the offline fallback have drifted, which is the bug this module structure
    // exists to prevent.
    const baked = JSON.parse(
      readFileSync(fileURLToPath(new URL('apps/web/src/data/integrity.json', ROOT)), 'utf8'),
    );
    const { replayHostileCorpus } = replayModule;
    const fresh = replayHostileCorpus().entries;
    eq(
      JSON.stringify(fresh),
      JSON.stringify(baked.entries),
      'endpoint replay and baked integrity.json disagree — regenerate with node apps/web/scripts/gen-integrity.mjs',
    );
  });

  /* ---------- 4. write path ---------- */
  console.log('\nwrite path (POST /discovery/resources)');

  const SAMPLE = {
    resource: {
      url: 'https://api.example.test/v1/echo',
      serviceName: 'Echo',
      description: 'Echoes a payload back, used only to verify the write path end to end.',
      tags: ['test', 'echo'],
    },
    type: 'http',
    payTo: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    maxAmountRequired: '1000',
    input: { type: 'http', method: 'POST', body: { text: 'hi' } },
    output: { type: 'json' },
    extensions: ['bazaar'],
  };

  await check('with no store configured: 503 and an actionable reason, never a crash', async () => {
    resetState();
    const res = mockRes();
    await resourcesHandler(mockReq('POST', '/discovery/resources', { body: SAMPLE }), res, {});
    eq(res.statusCode, 503, 'status');
    eq(res.json.ok, false, 'ok');
    assert(/KV_REST_API_URL/.test(res.json.reason), `reason should name the env vars, got: ${res.json.reason}`);
  });

  await check('store configured but no write token: still refused, with the reason', async () => {
    resetState();
    const restore = stubFetch(new Map());
    try {
      const res = mockRes();
      await resourcesHandler(mockReq('POST', '/discovery/resources', { body: SAMPLE }), res, KV_ENV);
      eq(res.statusCode, 503, 'status');
      assert(/STELLARSIGHT_WRITE_TOKEN/.test(res.json.reason), `reason should name the token, got: ${res.json.reason}`);
    } finally {
      restore();
    }
  });

  await check('store + token, wrong bearer: 401', async () => {
    resetState();
    const restore = stubFetch(new Map());
    try {
      const res = mockRes();
      await resourcesHandler(
        mockReq('POST', '/discovery/resources', { body: SAMPLE, headers: { authorization: 'Bearer nope' } }),
        res,
        { ...KV_ENV, STELLARSIGHT_WRITE_TOKEN: 's3cret' },
      );
      eq(res.statusCode, 401, 'status');
    } finally {
      restore();
    }
  });

  await check('store + token + bearer: the record is validated, persisted and then served', async () => {
    resetState();
    const kv = new Map();
    const restore = stubFetch(kv);
    const env = { ...KV_ENV, STELLARSIGHT_WRITE_TOKEN: 's3cret', STELLARSIGHT_KV_TTL_MS: '0' };
    try {
      const write = mockRes();
      await resourcesHandler(
        mockReq('POST', '/discovery/resources', { body: SAMPLE, headers: { authorization: 'Bearer s3cret' } }),
        write,
        env,
      );
      eq(write.statusCode, 200, 'write status');
      eq(write.json.ok, true, 'write ok');
      eq(write.json.id, SAMPLE.resource.url, 'write id');
      eq(write.json.durable, true, 'the write claims durability');
      eq(kv.size, 1, 'the durable store holds exactly one record');

      // A different instance would see it too: rebuild from scratch and search for it.
      resetState();
      const found = mockRes();
      await searchHandler(mockReq('GET', '/discovery/search?query=echoes%20a%20payload&limit=5'), found, env);
      eq(found.statusCode, 200, 'search status');
      assert(found.json.resources.some((r) => r.id === SAMPLE.resource.url), 'the persisted record is not discoverable');

      const health = mockRes();
      await healthHandler(mockReq('GET', '/discovery/health'), health, env);
      eq(health.json.mode, 'kv', 'health reports kv mode');
      eq(health.json.writable, true, 'health reports writable');
      eq(health.json.durableStore.configured, true, 'durableStore.configured');
      eq(health.json.durableStore.reachable, true, 'durableStore.reachable');
      eq(health.json.liveRecords, 1, 'the written record is counted as live, not seeded');
    } finally {
      restore();
      resetState();
    }
  });

  await check('a hostile field is soft-dropped, the record survives', async () => {
    resetState();
    const kv = new Map();
    const restore = stubFetch(kv);
    try {
      const res = mockRes();
      await resourcesHandler(
        mockReq('POST', '/discovery/resources', {
          body: { ...SAMPLE, routeTemplate: '/v1/parse/%252e%252e/admin/keys' },
          headers: { authorization: 'Bearer s3cret' },
        }),
        res,
        { ...KV_ENV, STELLARSIGHT_WRITE_TOKEN: 's3cret' },
      );
      eq(res.statusCode, 200, 'the record must survive');
      assert(res.json.dropped.includes('routeTemplate'), `expected routeTemplate in dropped, got ${JSON.stringify(res.json.dropped)}`);
      const stored = JSON.parse([...kv.values()][0]);
      assert(!('routeTemplate' in stored), 'the traversal template was persisted');
    } finally {
      restore();
      resetState();
    }
  });

  await check('an unreachable store degrades to the seeded catalog instead of erroring', async () => {
    resetState();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    try {
      const res = mockRes();
      await searchHandler(mockReq('GET', '/discovery/search?query=invoice&limit=3'), res, KV_ENV);
      eq(res.statusCode, 200, 'reads must still succeed');
      assert(res.json.resources.length > 0, 'the seeded catalog should still answer');

      const health = mockRes();
      await healthHandler(mockReq('GET', '/discovery/health'), health, KV_ENV);
      eq(health.json.mode, 'seed', 'a broken store falls back to seed mode');
      eq(health.json.durableStore.configured, true, 'still reports that a store was configured');
      assert(health.json.durableStore.error, 'the failure reason must be reported');
    } finally {
      globalThis.fetch = realFetch;
      resetState();
    }
  });

  await check('junk env vars never crash the read path', async () => {
    for (const env of [
      {},
      { KV_REST_API_URL: '' },
      { KV_REST_API_URL: 'not a url', KV_REST_API_TOKEN: 'x' },
      { KV_REST_API_TOKEN: 'token-without-a-url' },
      { KV_REST_API_URL: 'redis://nope', KV_REST_API_TOKEN: 'x' },
    ]) {
      resetState();
      const res = mockRes();
      await resourcesHandler(mockReq('GET', '/discovery/resources?limit=1'), res, env);
      eq(res.statusCode, 200, `env ${JSON.stringify(env)} broke the read path`);
    }
    resetState();
  });

  /* ---------- 5. routing ---------- */
  console.log('\nvercel.json routing');

  const vercelJson = JSON.parse(readFileSync(fileURLToPath(new URL('vercel.json', ROOT)), 'utf8'));

  await check('the SPA catch-all is last and every /discovery route precedes it', () => {
    const rewrites = vercelJson.rewrites ?? [];
    const catchAllIndex = rewrites.findIndex((r) => r.source === '/(.*)');
    assert(catchAllIndex !== -1, 'the SPA catch-all rewrite is missing');
    eq(catchAllIndex, rewrites.length - 1, 'the SPA catch-all must be the LAST rewrite');
    for (const path of ['/discovery/resources', '/discovery/search', '/discovery/health', '/mcp']) {
      const i = rewrites.findIndex((r) => r.source === path);
      assert(i !== -1, `no rewrite for ${path}`);
      assert(i < catchAllIndex, `${path} is shadowed by the catch-all`);
      eq(rewrites[i].destination, `/api${path}`, `${path} destination`);
    }
  });

  await check('first-match routing sends /discovery/* to the functions, not index.html', () => {
    // Vercel evaluates rewrites top to bottom, first match wins, after the filesystem
    // check. Replay that here over the real config.
    const resolve = (pathname) => {
      for (const rule of vercelJson.rewrites ?? []) {
        const dest = applyRewrite(rule, pathname);
        if (dest !== null) return dest;
      }
      return null;
    };
    eq(resolve('/discovery/search'), '/api/discovery/search', '/discovery/search');
    eq(resolve('/discovery/resources'), '/api/discovery/resources', '/discovery/resources');
    eq(resolve('/discovery/health'), '/api/discovery/health', '/discovery/health');
    eq(resolve('/mcp'), '/api/mcp', '/mcp reaches the mcp function, not index.html');
    // The whole namespace belongs to the API: an unknown /discovery/* path must 404 as
    // JSON, not silently render the single-page app.
    //
    // This assertion used to expect '/api/discovery/nope' — pointing the guard at a
    // destination that does not exist, on the assumption that Vercel would 404 it.
    // Production disproved that: a rewrite whose destination has no function behind it
    // falls through to the NEXT rule, which is the SPA catch-all, so /discovery/nope
    // answered 200 text/html. The guard now targets one concrete function instead.
    eq(resolve('/discovery/nope'), '/api/discovery/unknown', 'unknown /discovery paths stay in the API');
    // The facilitator half of the RFP title. These five ride the same first-match rule:
    // each must land on the facilitator function, not fall through to the SPA.
    for (const path of ['/supported', '/verify', '/settle', '/health', '/events']) {
      eq(resolve(path), '/api/facilitator', `${path} reaches the facilitator, not index.html`);
    }
    // The seller's paid routes and its x402 well-known document.
    eq(resolve('/v1/fx/usd-brl'), '/api/seller', '/v1/* reaches the seller, not index.html');
    eq(resolve('/.well-known/x402'), '/api/seller', 'the x402 well-known doc reaches the seller');
    eq(resolve('/console'), '/index.html', 'the SPA still catches its own routes');
    eq(resolve('/'), '/index.html', 'the landing page still resolves');
  });

  await check('each fixed rewrite destination has a function file behind it', () => {
    // Every /api/ destination must resolve to a file — including the `/discovery/:path*`
    // guard, which is the whole point: a destination with no function behind it does not
    // 404, it falls through to the next rewrite.
    let checked = 0;
    for (const rule of vercelJson.rewrites ?? []) {
      if (!rule.destination.startsWith('/api/') || rule.destination.includes(':')) continue;
      readFileSync(fileURLToPath(new URL(`.${rule.destination}.mjs`, ROOT)), 'utf8');
      checked++;
    }
    // 16 = four discovery endpoints (resources, search, health, integrity) + the
    // /discovery/:path* guard + five facilitator routes + the playground faucet + the
    // explorer feed + the hosted mcp routes (/mcp, /mcp/:path*) + the seller's two (/v1/:path* and /.well-known/x402).
    eq(checked, 16, 'expected sixteen concrete function routes (discovery x5 + facilitator x5 + playground x1 + explorer x1 + mcp x2 + seller x2)');
  });

  await check('the functions glob in vercel.json matches the files that exist', () => {
    const keys = Object.keys(vercelJson.functions ?? {});
    assert(keys.length > 0, 'no functions configuration');
    assert(keys.some((k) => k === 'api/**/*.mjs'), `unexpected functions globs: ${keys.join(', ')}`);
    // api/explorer/feed.mjs reads docs/status/provenance.json with fs at cold start, so
    // that path must be traced into the bundle — a static import would be found for us,
    // a file read is not.
    const inc = String(vercelJson.functions['api/**/*.mjs'].includeFiles ?? '');
    assert(inc.includes('packages/index/src'), `includeFiles must cover packages/index/src, got "${inc}"`);
    assert(inc.includes('docs/status'), `includeFiles must cover docs/status for the explorer feed, got "${inc}"`);
    assert(inc.includes('apps/agent/src'), `includeFiles must cover apps/agent/src for hosted mcp, got "${inc}"`);
    assert(inc.includes('apps/facilitator/src'), `includeFiles must cover apps/facilitator/src for rate limiting, got "${inc}"`);
    // api/**/*.+(js|mjs|ts|tsx) is the zero-config glob Vercel uses to find functions,
    // so .mjs under api/ is picked up without further configuration.
    for (const name of ['resources', 'search', 'health', 'integrity', 'unknown']) {
      readFileSync(fileURLToPath(new URL(`api/discovery/${name}.mjs`, ROOT)), 'utf8');
    }
    readFileSync(fileURLToPath(new URL('api/mcp.mjs', ROOT)), 'utf8');
    // Function filenames must be literal. A bracketed dynamic-route name such as
    // `[...path].mjs` is read as a character class by the glob above, so includeFiles
    // never matches it, the packages/index import is never traced, and the function
    // silently never deploys.
    for (const f of readdirSync(fileURLToPath(new URL('api/discovery', ROOT)))) {
      assert(!/[[\]]/.test(f), `bracketed function filename will not deploy reliably: ${f}`);
    }
  });

  /* ---------- 6. over a real socket ---------- */
  console.log('\nover a real node:http socket (real IncomingMessage / ServerResponse)');

  resetState();
  const server = createServer((req, res) => {
    // Exactly what vercel.json's rewrites do: /discovery/* -> the function file.
    const path = new URL(req.url, 'http://localhost').pathname;
    const fn = {
      '/discovery/resources': resourcesFn,
      '/discovery/search': searchFn,
      '/discovery/health': healthFn,
      '/mcp': mcpFn,
    }[path];
    if (!fn) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    Promise.resolve(fn(req, res)).catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    await check('GET /discovery/search over HTTP returns ranked JSON', async () => {
      const res = await fetch(`${origin}/discovery/search?query=invoice%20ocr&limit=3`);
      eq(res.status, 200, 'status');
      assert(/application\/json/.test(res.headers.get('content-type') ?? ''), 'content-type');
      eq(res.headers.get('access-control-allow-origin'), '*', 'CORS over the wire');
      const body = await res.json();
      assert(body.resources.length > 0 && body.resources[0]._explain, 'ranked resources with _explain');
    });

    await check('GET /discovery/resources over HTTP honours filters', async () => {
      const res = await fetch(`${origin}/discovery/resources?type=mcp&limit=100`);
      const body = await res.json();
      assert(body.items.length > 0 && body.items.every((r) => r.type === 'mcp'), 'type filter over the wire');
    });

    await check('OPTIONS preflight over HTTP returns 204 with no body', async () => {
      const res = await fetch(`${origin}/discovery/resources`, { method: 'OPTIONS' });
      eq(res.status, 204, 'status');
      eq(res.headers.get('access-control-allow-origin'), '*', 'preflight ACAO');
    });

    await check('a streamed POST body is parsed (no framework body parser present)', async () => {
      const res = await fetch(`${origin}/discovery/resources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
        body: JSON.stringify(SAMPLE),
      });
      // No store is configured here, so this is the read-only refusal — which proves the
      // request reached the handler and was answered rather than hanging on the stream.
      eq(res.status, 503, 'status');
      const body = await res.json();
      eq(body.ok, false, 'ok');
    });

    await check('GET /discovery/health over HTTP reports the live mode', async () => {
      const res = await fetch(`${origin}/discovery/health`);
      eq(res.status, 200, 'status');
      const body = await res.json();
      eq(body.mode, 'seed', 'mode');
      assert(body.records > 0, 'records');
    });

    /* ---------- 7. the STOCK @x402/extensions bazaar client ---------- */
    console.log('\nstock @x402/extensions withBazaar() client (RFP 3.6: unmodified canonical client)');

    // Exactly the three lines from the package's own README, against our handlers.
    // `withBazaar` returns `await response.json()` untransformed, so whatever it hands
    // back IS our wire format seen through the declared types.
    const bazaar = withBazaar({
      url: origin,
      extensions: {},
      createAuthHeaders: async () => ({ headers: {} }),
    }).extensions.bazaar;

    await check('search({query}) returns a real, iterable `resources` array', async () => {
      const out = await bazaar.search({ query: 'invoice ocr', limit: 5 });
      // This is the assertion the old harness could not make. `resources` was undefined
      // and `for (const r of out.resources)` threw a TypeError.
      assert(Array.isArray(out.resources), '`resources` is not an array — a stock client cannot iterate the result');
      assert(out.resources.length > 0, '`resources` is empty for a query with known matches');
      let iterated = 0;
      for (const _r of out.resources) iterated++;
      eq(iterated, out.resources.length, 'iteration must visit every result');
      eq(out.x402Version, 2, 'x402Version');
      eq(typeof out.partialResults, 'boolean', 'partialResults');
      assert(out.pagination && 'cursor' in out.pagination, 'pagination.cursor');
    });

    await check('listResources() returns the declared `items` array', async () => {
      const out = await bazaar.listResources({ limit: 5 });
      assert(Array.isArray(out.items) && out.items.length === 5, '`items` must be the list array');
      assert(out.pagination && typeof out.pagination.offset === 'number' && typeof out.pagination.total === 'number',
        'the list endpoint paginates by offset/total');
    });

    /**
     * Assert one result against the shipped `DiscoveryResource` declaration
     * (@x402/extensions/dist/esm/index-*.d.mts).
     */
    const assertDiscoveryResource = (r, where) => {
      assert(typeof r.resource === 'string' && /^https?:\/\//.test(r.resource),
        `${where}: \`resource\` must be a URL STRING, got ${typeof r.resource}`);
      assert(typeof r.type === 'string' && r.type.length > 0, `${where}: \`type\``);
      eq(r.x402Version, 2, `${where}: \`x402Version\``);
      assert(Array.isArray(r.accepts) && r.accepts.length > 0,
        `${where}: \`accepts\` is missing — a client cannot construct a payment from this result`);
      assert(typeof r.lastUpdated === 'string' && !Number.isNaN(Date.parse(r.lastUpdated)),
        `${where}: \`lastUpdated\` must be an ISO 8601 string, got ${JSON.stringify(r.lastUpdated)}`);
      eq(r.lastUpdated, new Date(r.lastUpdated).toISOString(), `${where}: \`lastUpdated\` must round-trip as ISO 8601`);
      assert(r.extensions && typeof r.extensions === 'object' && !Array.isArray(r.extensions),
        `${where}: \`extensions\` must be an object map, not an array`);
      for (const [field, type] of [['serviceName', 'string'], ['description', 'string'], ['iconUrl', 'string']]) {
        if (r[field] !== undefined) eq(typeof r[field], type, `${where}: \`${field}\` is top-level and must be a ${type}`);
      }
      if (r.tags !== undefined) assert(Array.isArray(r.tags), `${where}: \`tags\` must be a top-level array`);
    };

    await check('every search result validates as a spec DiscoveryResource', async () => {
      const out = await bazaar.search({ query: 'stellar', limit: 20 });
      out.resources.forEach((r, i) => assertDiscoveryResource(r, `search[${i}]`));
      // The presentation metadata must actually survive the move to the top level —
      // an all-`undefined` projection would pass a shape check and still be useless.
      assert(out.resources.some((r) => typeof r.serviceName === 'string' && r.serviceName.length > 0),
        'no result carries a top-level serviceName');
      assert(out.resources.some((r) => Array.isArray(r.tags) && r.tags.length > 0),
        'no result carries top-level tags');
    });

    await check('every listed resource validates as a spec DiscoveryResource', async () => {
      const out = await bazaar.listResources({ limit: 100 });
      assert(out.items.length >= 25, `expected the seed corpus, got ${out.items.length}`);
      out.items.forEach((r, i) => assertDiscoveryResource(r, `items[${i}]`));
    });

    await check("accepts[] parses as x402 v2 PaymentRequirements under @x402/core's own schema", async () => {
      const out = await bazaar.search({ query: 'stellar', limit: 20 });
      assert(out.resources.length > 0, 'no results to validate');
      for (const r of out.resources) {
        for (const [i, pr] of r.accepts.entries()) {
          const parsed = PaymentRequirementsSchema.safeParse(pr);
          assert(parsed.success,
            `${r.resource} accepts[${i}] rejected by PaymentRequirementsSchema: ${JSON.stringify(parsed.error?.issues?.[0])}`);
          // v2 names the price `amount`. `maxAmountRequired` is the v1 name and would make
          // this entry parse as V1 — which additionally requires `resource` and
          // `description` inside the requirement, neither of which we emit.
          assert(isPaymentRequirementsV2(pr),
            `${r.resource} accepts[${i}] is not v2 — v2 uses \`amount\`, not \`maxAmountRequired\``);
          assert(!('maxAmountRequired' in pr), `${r.resource} accepts[${i}] still carries the v1 \`maxAmountRequired\``);
          assert(typeof pr.amount === 'string' && /^\d+$/.test(pr.amount), `${r.resource} accepts[${i}].amount`);
          assert(typeof pr.maxTimeoutSeconds === 'number', `${r.resource} accepts[${i}].maxTimeoutSeconds`);
        }
      }
    });

    await check('a stock consumer can go from one search hit to a payable offer', async () => {
      // The end-to-end shape claim, stated as behaviour: search -> pick -> read the price
      // and the recipient off `accepts[0]` with no STELLARSIGHT-specific knowledge at all.
      const { resources } = await bazaar.search({ query: 'invoice ocr', limit: 1 });
      const [hit] = resources;
      const offer = hit.accepts[0];
      assert(new URL(hit.resource).protocol.startsWith('http'), 'the resource URL must parse');
      assert(/^G[A-Z2-7]{55}$/.test(offer.payTo), `payTo is not a Stellar account: ${offer.payTo}`);
      assert(offer.network.includes(':'), `network must be a CAIP-2 id, got ${offer.network}`);
      assert(BigInt(offer.amount) >= 0n, 'amount must parse as an integer');
      eq(offer.scheme, 'exact', 'scheme');
    });

    await check('STELLARSIGHT extras ride along without displacing a spec field', async () => {
      const { resources } = await bazaar.search({ query: 'invoice ocr', limit: 3 });
      for (const r of resources) {
        assert(typeof r._score === 'number', `_score missing on ${r.resource}`);
        assert(r._explain && typeof r._explain === 'object', `_explain missing on ${r.resource}`);
        assert(typeof r.settlements === 'number', `settlements missing on ${r.resource}`);
        assert(typeof r.lastSeenAt === 'number', `lastSeenAt missing on ${r.resource}`);
      }
      const listed = await bazaar.listResources({ limit: 100 });
      assert(listed.items.some((r) => r.seeded === true), '`seeded` provenance was lost in the projection');
    });

    await check('cursor paging through the stock client stays coherent', async () => {
      // [spec: identity is the (resource.url, input.toolName) TUPLE — MCP multiplexes many
      //  tools over one server endpoint, so `resource` alone is not unique. Both halves are
      //  visible to a stock client: the URL in `resource`, the tool name in
      //  `extensions.bazaar.info.input.toolName` (McpDiscoveryInfo).]
      const key = (r) => `${r.resource}#${r.extensions?.bazaar?.info?.input?.toolName ?? ''}`;
      const p1 = await bazaar.search({ query: 'stellar', limit: 2 });
      assert(p1.partialResults === true && typeof p1.pagination.cursor === 'string', 'expected a continuation cursor');
      const p2 = await bazaar.search({ query: 'stellar', limit: 2, cursor: p1.pagination.cursor });
      const seen = new Set(p1.resources.map(key));
      assert(p2.resources.length > 0, 'page 2 is empty');
      assert(p2.resources.every((r) => !seen.has(key(r))), 'the client saw a duplicate across pages');
      // …and the tuple must actually be reachable, or the client has no way to tell two
      // tools on the same MCP endpoint apart.
      const mcp = [...p1.resources, ...p2.resources].filter((r) => r.type === 'mcp');
      assert(mcp.length > 0, 'expected at least one MCP record in these two pages');
      assert(mcp.every((r) => typeof r.extensions?.bazaar?.info?.input?.toolName === 'string'),
        'an MCP record reached the client with no toolName under extensions.bazaar.info');
    });

    await check('the client filters narrow the set the same way the raw query params do', async () => {
      const mcp = await bazaar.search({ query: 'stellar', type: 'mcp', limit: 100 });
      assert(mcp.resources.length > 0 && mcp.resources.every((r) => r.type === 'mcp'), 'type filter through the client');
      const byExt = await bazaar.listResources({ extensions: 'bazaar', limit: 100 });
      assert(byExt.items.length > 0 && byExt.items.every((r) => 'bazaar' in r.extensions),
        'extensions filter through the client');
    });

    /* ---------- 8. hosted Streamable HTTP MCP server (api/mcp.mjs) ---------- */
    console.log('\nhosted Streamable HTTP MCP server (api/mcp.mjs)');

    await check('OPTIONS /mcp returns 204 with CORS headers', async () => {
      const res = await fetch(`${origin}/mcp`, { method: 'OPTIONS' });
      eq(res.status, 204, 'status');
      eq(res.headers.get('access-control-allow-origin'), '*', 'CORS origin');
      const methods = res.headers.get('access-control-allow-methods') ?? '';
      assert(/POST/i.test(methods), 'allowed methods name POST');
      // Stateless transport has no SSE stream, so GET must not be advertised.
      assert(!/GET/i.test(methods), 'allowed methods must not name GET');
    });

    await check('POST /mcp with JSON-RPC initialize performs protocol handshake', async () => {
      const res = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'verify-serverless', version: '1.0.0' }
          }
        })
      });
      eq(res.status, 200, 'status');
      const text = await res.text();
      assert(text.includes('"serverInfo"'), 'initialize payload must include serverInfo');
      assert(text.includes('"stellarsight"'), 'serverInfo name must be stellarsight');
    });

    await check('POST /mcp tools/list exposes discovery plus a pay stub, never the live payer', async () => {
      const res = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
          'mcp-protocol-version': '2024-11-05'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {}
        })
      });
      eq(res.status, 200, 'status');
      const text = await res.text();
      assert(text.includes('stellarsight_search'), 'must include stellarsight_search');
      assert(text.includes('stellarsight_browse'), 'must include stellarsight_browse');
      assert(text.includes('stellarsight_describe'), 'must include stellarsight_describe');
      // The name alone would pass whether the endpoint exposed the refusal stub or a live
      // payer holding buyer keys — the regression that matters. Assert the stub's text.
      assert(text.includes('stellarsight_pay'), 'must include stellarsight_pay');
      assert(text.includes('Disabled on the hosted MCP endpoint'), 'stellarsight_pay must be the refusal stub');
    });

    await check('POST /mcp tools/call stellarsight_search returns results with T5 untrusted markers', async () => {
      const res = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
          'mcp-protocol-version': '2024-11-05'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'stellarsight_search',
            arguments: { query: 'weather' }
          }
        })
      });
      eq(res.status, 200, 'status');
      const text = await res.text();
      assert(text.includes('[UNTRUSTED_SELLER_CONTENT:'), 'seller metadata must carry untrusted marker (T5)');
      assert(text.includes('"ok":true'), 'tool call succeeds');
    });

    await check('POST /mcp tools/call stellarsight_pay is refused server-side (§5.1)', async () => {
      const res = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
          'mcp-protocol-version': '2024-11-05'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'stellarsight_pay',
            arguments: { url: 'https://api.weather.example/v1/forecast' }
          }
        })
      });
      eq(res.status, 200, 'status');
      const text = await res.text();
      assert(text.includes('STELLARSIGHT_CONFIG_MISSING'), 'must return STELLARSIGHT_CONFIG_MISSING');
      assert(text.includes('hosted MCP endpoint'), 'must explain buyer signing keys remain client-side');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  /* ---------- done ---------- */
  console.log(
    `\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${passed} check(s) passed, ${failures.length} failed\n`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

/* ─────────────────────────── helpers ─────────────────────────── */

const KV_ENV = { KV_REST_API_URL: 'https://kv.example.test', KV_REST_API_TOKEN: 'kv-token' };

/**
 * Stand in for the Vercel KV / Upstash REST endpoint with a Map, so the write path is
 * exercised for real (same fetch call, same command encoding, same response parsing)
 * without a network or an account.
 */
function stubFetch(hash) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const cmd = JSON.parse(init.body);
    const [verb, , field, value] = cmd;
    const reply = (result) =>
      new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (String(verb).toUpperCase()) {
      case 'HGETALL': {
        const flat = [];
        for (const [k, v] of hash) flat.push(k, v);
        return reply(flat);
      }
      case 'HSET':
        hash.set(field, value);
        return reply(1);
      case 'HDEL':
        return reply(hash.delete(field) ? 1 : 0);
      case 'HLEN':
        return reply(hash.size);
      default:
        return reply(null);
    }
  };
  return () => {
    globalThis.fetch = real;
  };
}

/**
 * Compile a vercel.json rewrite `source` the way Vercel matches it: a bare path is an
 * exact match, `(...)` groups pass through as regex, `:param` is one segment and
 * `:param*` is zero or more. Returns the regex plus the parameter names in capture order
 * so the destination can be filled in. Only the forms this repo uses need to work.
 */
function compileSource(source) {
  const params = [];
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < source.length && depth > 0) {
        if (source[j] === '(') depth++;
        else if (source[j] === ')') depth--;
        j++;
      }
      out += source.slice(i, j); // pass the group through untouched
      params.push(null); // an anonymous capture
      i = j;
    } else if (ch === ':') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      const name = source.slice(i + 1, j);
      if (source[j] === '*') {
        // `/a/:p*` matches `/a` as well as `/a/x/y`, so the separator is optional.
        if (out.endsWith('/')) out = out.slice(0, -1);
        out += '(?:/(.*))?';
        params.push({ name, star: true });
        i = j + 1;
      } else {
        out += '([^/]+)';
        params.push({ name, star: false });
        i = j;
      }
    } else {
      out += ch.replace(/[.*+?^${}|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return { re: new RegExp(`^${out}$`), params };
}

/** Apply one rewrite rule to a pathname; returns the destination, or null on no match. */
function applyRewrite(rule, pathname) {
  const { re, params } = compileSource(rule.source);
  const m = re.exec(pathname);
  if (!m) return null;
  let dest = rule.destination;
  params.forEach((p, idx) => {
    if (!p) return;
    const value = m[idx + 1] ?? '';
    dest = dest.replace(p.star ? `:${p.name}*` : `:${p.name}`, value);
  });
  return dest;
}

main().catch((err) => {
  console.error(`\nverification harness crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
