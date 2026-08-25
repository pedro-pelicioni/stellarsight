/**
 * test/facilitator-rate-limit.test.mjs — the configurable limit on /verify and /settle.
 *
 * The RFP's requirement is not a particular policy, it is that the mechanism be documented
 * and configurable. So the properties worth testing are the configurability and the failure
 * behaviour, not a magic number: that 0 really disables it, that a refusal is
 * machine-readable with a non-null reason like every other rejection in this repo, that a
 * store outage degrades the limiter instead of taking the facilitator down with it, and
 * that a raw IP address never reaches a key.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimit, rateLimitStatus, clientIpHash } from '../apps/facilitator/src/rate-limit.mjs';

/** Minimal express-ish req/res pair. */
const reqFrom = (ip) => ({ headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } });

function resSpy() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

/** Drive the middleware once; resolves to { res, passed }. */
async function hit(limit, ip) {
  const res = resSpy();
  let passed = false;
  await limit(reqFrom(ip), res, () => { passed = true; });
  return { res, passed };
}

/** An in-memory stand-in for the durable KV, with the same { ok, result } envelope. */
function fakeKv({ failWith = null } = {}) {
  const values = new Map();
  return {
    calls: [],
    async command(argv) {
      this.calls.push(argv);
      if (failWith) return { ok: false, reason: failWith };
      const [op, key] = argv;
      if (op === 'INCR') {
        const next = (values.get(key) ?? 0) + 1;
        values.set(key, next);
        return { ok: true, result: next };
      }
      if (op === 'EXPIRE') return { ok: true, result: 1 };
      if (op === 'TTL') return { ok: true, result: 42 };
      return { ok: true, result: null };
    },
  };
}

test('0 disables the limiter entirely', async () => {
  const limit = createRateLimit({
    env: { FACILITATOR_RATE_LIMIT: '0', FACILITATOR_RATE_GLOBAL_LIMIT: '0' },
    deps: { kv: fakeKv() },
  });
  for (let i = 0; i < 50; i++) {
    const { passed, res } = await hit(limit, '203.0.113.9');
    assert.equal(passed, true, 'request should pass through');
    assert.equal(res.statusCode, null, 'nothing should be refused');
  }
});

test('the configured per-caller limit is what is enforced', async () => {
  const kv = fakeKv();
  const limit = createRateLimit({
    env: { FACILITATOR_RATE_LIMIT: '3', FACILITATOR_RATE_WINDOW_S: '60' },
    deps: { kv, now: () => 1_700_000_000_000 },
  });
  const ip = '203.0.113.10';

  for (let i = 1; i <= 3; i++) {
    const { passed, res } = await hit(limit, ip);
    assert.equal(passed, true, `request ${i} of 3 should pass`);
    assert.equal(res.headers['X-RateLimit-Remaining'], String(3 - i));
  }

  const { passed, res } = await hit(limit, ip);
  assert.equal(passed, false, 'the fourth request should not reach the handler');
  assert.equal(res.statusCode, 429);
});

test('a refusal is machine-readable, with a non-null reason and Retry-After', async () => {
  const limit = createRateLimit({
    env: { FACILITATOR_RATE_LIMIT: '1', FACILITATOR_RATE_WINDOW_S: '60' },
    deps: { kv: fakeKv(), now: () => 1_700_000_000_000 },
  });
  const ip = '203.0.113.11';
  await hit(limit, ip);
  const { res } = await hit(limit, ip);

  assert.equal(res.statusCode, 429);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STELLARSIGHT_RATE_LIMITED');
  assert.ok(res.body.reason && res.body.reason.length > 0, 'reason must be non-null and non-empty');
  assert.equal(res.body.scope, 'ip');
  assert.equal(res.body.limit, 1);
  assert.equal(res.body.windowSeconds, 60);
  assert.ok(Number(res.headers['Retry-After']) > 0, 'Retry-After must be a positive number of seconds');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('callers are counted separately', async () => {
  const limit = createRateLimit({
    env: { FACILITATOR_RATE_LIMIT: '1', FACILITATOR_RATE_WINDOW_S: '60' },
    deps: { kv: fakeKv(), now: () => 1_700_000_000_000 },
  });
  await hit(limit, '203.0.113.12');
  const { passed } = await hit(limit, '203.0.113.13');
  assert.equal(passed, true, 'a different caller has its own budget');
});

test('the raw IP address never reaches a key', async () => {
  const kv = fakeKv();
  const limit = createRateLimit({
    env: { FACILITATOR_RATE_LIMIT: '5' },
    deps: { kv, now: () => 1_700_000_000_000 },
  });
  const ip = '198.51.100.77';
  await hit(limit, ip);

  const keys = kv.calls.map((c) => String(c[1] ?? ''));
  assert.ok(keys.length > 0, 'the durable counter should have been used');
  for (const key of keys) {
    assert.ok(!key.includes(ip), `key leaked the raw address: ${key}`);
  }
  assert.ok(keys.some((k) => k.includes(clientIpHash(reqFrom(ip)))), 'key should carry the hash');
});

test('a global cap refuses with its own scope', async () => {
  const limit = createRateLimit({
    env: { FACILITATOR_RATE_LIMIT: '0', FACILITATOR_RATE_GLOBAL_LIMIT: '2' },
    deps: { kv: fakeKv(), now: () => 1_700_000_000_000 },
  });
  await hit(limit, '203.0.113.20');
  await hit(limit, '203.0.113.21');
  const { passed, res } = await hit(limit, '203.0.113.22');

  assert.equal(passed, false);
  assert.equal(res.body.scope, 'global');
  assert.match(res.body.reason, /run your own/, 'a global refusal should point at self-hosting');
});

test('an unreachable store degrades to per-instance counting and says so', async () => {
  const limit = createRateLimit({
    env: { FACILITATOR_RATE_LIMIT: '2', FACILITATOR_RATE_WINDOW_S: '60' },
    deps: { kv: fakeKv({ failWith: 'ECONNREFUSED' }), now: () => 1_700_000_000_000 },
  });
  const ip = '203.0.113.30';

  const first = await hit(limit, ip);
  assert.equal(first.passed, true, 'a store outage must not refuse traffic');
  assert.equal(first.res.headers['X-RateLimit-Degraded'], 'per-instance');

  await hit(limit, ip);
  const third = await hit(limit, ip);
  assert.equal(third.passed, false, 'the fallback still counts');
});

test('a counter that throws fails open rather than taking the facilitator down', async () => {
  const exploding = { command() { throw new Error('boom'); } };
  const limit = createRateLimit({
    env: { FACILITATOR_RATE_LIMIT: '1' },
    deps: { kv: exploding, now: () => 1_700_000_000_000 },
  });
  const { passed, res } = await hit(limit, '203.0.113.40');
  assert.equal(passed, true, 'the request should still be served');
  assert.equal(res.statusCode, null);
});

test('the window rolls over', async () => {
  let clock = 1_700_000_000_000;
  const limit = createRateLimit({
    env: { FACILITATOR_RATE_LIMIT: '1', FACILITATOR_RATE_WINDOW_S: '60' },
    deps: { kv: fakeKv(), now: () => clock },
  });
  const ip = '203.0.113.50';
  await hit(limit, ip);
  assert.equal((await hit(limit, ip)).passed, false, 'still inside the window');

  clock += 61_000;
  assert.equal((await hit(limit, ip)).passed, true, 'a new window is a new budget');
});

test('health reports the policy without anyone reading the env', () => {
  assert.deepEqual(rateLimitStatus({}), {
    enabled: true,
    perCallerPerWindow: 120,
    globalPerWindow: null,
    windowSeconds: 60,
  });
  assert.deepEqual(rateLimitStatus({ FACILITATOR_RATE_LIMIT: '0' }), {
    enabled: false,
    perCallerPerWindow: null,
    globalPerWindow: null,
    windowSeconds: 60,
  });
});
