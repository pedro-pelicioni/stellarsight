/**
 * test/seller-check.test.mjs — `stellarsight-seller check` (packages/express/src/cli.mjs,
 * via check.mjs) must never drift from what `POST /discovery/resources` actually decides.
 *
 * `pay.check()` replays a paywall's announce records through a FRESH `@stellarsight/index`
 * catalog rather than a live index (see check.mjs for why that is safe and sufficient).
 * Every case here proves that replay agrees with a real `POST /discovery/resources`
 * server built the same way apps/facilitator/src/server.mjs builds its own
 * (`catalog.upsert(body)`), for one clean route and three deliberately broken ones:
 * a private host, a routeTemplate whose double-encoded traversal survives
 * @x402/extensions' own (shallower) declaration-time check, and a tag over the length cap.
 *
 * NOTHING HERE TOUCHES TESTNET OR A REAL FACILITATOR — `pay.check()` does no I/O at all,
 * and the "index" here is a bare `node:http` stub wrapping the same catalog call the real
 * facilitator makes.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test, { after } from 'node:test';

import { stellarsightPaywall } from '@stellarsight/express';
import { createCatalog } from '@stellarsight/index';

const PAY_TO = 'GSELLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ASSET = 'CASSETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
/** A closed port on loopback — nothing here ever needs to actually answer. */
const DEAD_FACILITATOR = 'http://127.0.0.1:9';

const teardown = [];
after(async () => {
  for (const close of teardown.reverse()) await close();
});

/**
 * A minimal stand-in for apps/facilitator's `POST /discovery/resources`: the exact same
 * call (`catalog.upsert(body)`) against a real HTTP server on an ephemeral port, so the
 * comparison below exercises a real request/response round-trip, not just a shared
 * function reference.
 */
async function startIndexServer() {
  const catalog = createCatalog();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let record = null;
      try {
        record = raw ? JSON.parse(raw) : null;
      } catch {
        record = null;
      }
      const out = catalog.upsert(record);
      res.writeHead(out.ok ? 200 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  server.listen(0, '127.0.0.1');
  teardown.push(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    post: async (record) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record),
      });
      return res.json();
    },
  };
}

function makePaywall(baseUrl, overrides = {}) {
  const pay = stellarsightPaywall({
    facilitator: DEAD_FACILITATOR,
    payTo: PAY_TO,
    asset: ASSET,
    baseUrl,
    announce: false,
    logger: false,
    ...overrides,
  });
  teardown.push(() => pay.stop());
  return pay;
}

/** The single announce record a one-route paywall would send. */
function soleRecord(pay) {
  const [{ record }] = pay.announceRecords();
  return record;
}

test('check: a well-formed route reports ok, agreeing with a real POST /discovery/resources', async () => {
  const index = await startIndexServer();
  const pay = makePaywall('https://api.acme.test');
  pay('/v1/fx', { price: '0.02', serviceName: 'acme-fx', tags: ['fx'] });

  const report = pay.check();
  assert.equal(report.ok, true);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].ok, true);
  assert.deepEqual(report.results[0].dropped, []);

  const server = await index.post(soleRecord(pay));
  assert.equal(server.ok, report.results[0].ok);
  assert.deepEqual(server.dropped, report.results[0].dropped);
});

test('check: a private-host resource.url is rejected, with the exact reason the index gives', async () => {
  // The escape hatch local dev sets (STELLARSIGHT_ALLOW_PRIVATE_RESOURCES=1) must not be
  // leaking from the ambient shell into this test, or the case under test never fires.
  const prior = process.env.STELLARSIGHT_ALLOW_PRIVATE_RESOURCES;
  delete process.env.STELLARSIGHT_ALLOW_PRIVATE_RESOURCES;
  try {
    const index = await startIndexServer();
    const pay = makePaywall('http://192.168.1.50:3000'); // private range — never publicly routable
    pay('/v1/internal', { price: '0.01', serviceName: 'internal-tool' });

    const report = pay.check();
    assert.equal(report.ok, false);
    assert.equal(report.results[0].ok, false);
    assert.match(report.results[0].reason, /resource\.url is missing or invalid/);

    const server = await index.post(soleRecord(pay));
    assert.equal(server.ok, false);
    assert.equal(server.reason, report.results[0].reason, 'the local reason must equal the index\'s own reason');
  } finally {
    if (prior === undefined) delete process.env.STELLARSIGHT_ALLOW_PRIVATE_RESOURCES;
    else process.env.STELLARSIGHT_ALLOW_PRIVATE_RESOURCES = prior;
  }
});

test('check: a routeTemplate whose traversal only appears after full decoding is soft-dropped, matching the index', async () => {
  // @x402/extensions' own isValidRouteTemplate (which pay() enforces at declaration time)
  // decodes percent-encoding ONE pass; packages/index/src/integrity.mjs decodes to a
  // FIXED POINT. A double-encoded ".." therefore clears declaration ("%252e%252e" is not
  // "..") but is still exactly what the index's own validator exists to catch — the
  // reason this feature has to run the index's real validator, not merely re-check what
  // pay() already accepted.
  const index = await startIndexServer();
  const pay = makePaywall('https://api.acme.test');
  pay('/v1/parse/:id', {
    price: '0.01',
    serviceName: 'parser',
    routeTemplate: '/v1/parse/:id/%252e%252e/admin/keys',
  });

  const report = pay.check();
  assert.equal(report.ok, true, 'a soft-drop keeps the record — the route still counts as ok');
  assert.deepEqual(report.results[0].dropped, ['routeTemplate']);

  const server = await index.post(soleRecord(pay));
  assert.equal(server.ok, true);
  assert.deepEqual(server.dropped, report.results[0].dropped);
});

test('check: a tag over the length cap is soft-dropped, matching the index', async () => {
  const index = await startIndexServer();
  const pay = makePaywall('https://api.acme.test');
  pay('/v1/thing', {
    price: '0.01',
    serviceName: 'thing',
    tags: ['ok-tag', 'x'.repeat(33)], // MAX_TAG_LEN is 32 (packages/index/src/integrity.mjs)
  });

  const report = pay.check();
  assert.equal(report.ok, true);
  assert.deepEqual(report.results[0].dropped, ['resource.tags[1]']);

  const server = await index.post(soleRecord(pay));
  assert.equal(server.ok, true);
  assert.deepEqual(server.dropped, report.results[0].dropped);
});

test('check: with no baseUrl configured, nothing is checkable and it says why', () => {
  const pay = makePaywall(undefined);
  pay('/v1/fx', { price: '0.02' });

  const report = pay.check();
  assert.equal(report.ok, false);
  assert.equal(report.baseUrlMissing, true);
  assert.match(report.reason, /baseUrl/);
  assert.deepEqual(report.results, []);
});

test('check: a route with no declared path fails, naming the fix', () => {
  const pay = makePaywall('https://api.acme.test');
  pay({ price: '0.02' }); // no path — nothing to build a resource.url from

  const report = pay.check();
  assert.equal(report.ok, false);
  assert.equal(report.results[0].path, null);
  assert.match(report.results[0].reason, /path/);
});

test('check: pay.announceRecords() skips no route pay.announce() would also skip', async () => {
  // announce.mjs and check.mjs must agree on which routes are announceable at all — a
  // route check() silently ignored but announce() would still try (or vice versa) is
  // exactly the drift this feature exists to prevent.
  const index = await startIndexServer();
  const pay = makePaywall('https://api.acme.test', { index: index.url });
  pay('/v1/known', { price: '0.01' });
  pay({ price: '0.02' }); // no path

  const announced = await pay.announce();
  const checked = pay.check();

  assert.deepEqual(
    announced.announced.length + announced.skipped.length + announced.failed.length,
    checked.results.length,
  );
  assert.equal(announced.skipped.length, 1);
  assert.equal(checked.results.filter((r) => r.path === null).length, 1);
});
