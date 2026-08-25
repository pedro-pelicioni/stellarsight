/**
 * test/provenance-live.test.mjs — provenance for settlements the live stack makes.
 *
 * The gap this closes was visible on the public feed: the committed map only covers
 * payments a script generated, and the feed reads it from the deployed bundle, so anything
 * the hosted stack settled after the last commit rendered as `unlabeled`. The fix must not
 * make the default weaker, so the properties worth pinning are about restraint:
 *
 *   - a recorded label always beats an inferred one;
 *   - an inferred label is marked as inferred and carries its basis;
 *   - neither ever promotes an unknown hash — `organic` is a word this code cannot emit;
 *   - every store failure lands on `unlabeled`, never on a label.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAUCET_ACCOUNT_KEY,
  PROVENANCE_KEY,
  fundedByFaucet,
  readInferredProvenance,
  recordInferredProvenance,
} from '../packages/index/src/provenance-store.mjs';
import { labelRows } from '../packages/index/src/settlements.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** A kv double with the { ok, result } envelope the real transports use. */
function fakeKv({ fail = null, values = new Map(), wrapped = false } = {}) {
  const wrap = (v) => (wrapped ? { result: v } : v);
  return {
    calls: [],
    values,
    async command(argv) {
      this.calls.push(argv);
      if (fail) return { ok: false, reason: fail };
      const [op, ...rest] = argv;
      if (op === 'EXISTS') return { ok: true, result: wrap(values.has(rest[0]) ? 1 : 0) };
      if (op === 'SET') {
        const [key, value, nx] = rest;
        if (nx === 'NX' && values.has(key)) return { ok: true, result: wrap(null) };
        values.set(key, value);
        return { ok: true, result: wrap('OK') };
      }
      if (op === 'MGET') return { ok: true, result: wrap(rest.map((k) => wrap(values.get(k) ?? null))) };
      return { ok: true, result: wrap(null) };
    },
  };
}

test('fundedByFaucet answers only from the faucet’s own claim key', async () => {
  const kv = fakeKv({ values: new Map([[FAUCET_ACCOUNT_KEY('GPAYER'), '1']]) });
  assert.equal(await fundedByFaucet(kv, 'GPAYER'), true);
  assert.equal(await fundedByFaucet(kv, 'GSTRANGER'), false);
});

test('a store that cannot answer means "we do not know", not "funded"', async () => {
  assert.equal(await fundedByFaucet(fakeKv({ fail: 'ECONNREFUSED' }), 'GPAYER'), false);
  assert.equal(await fundedByFaucet(null, 'GPAYER'), false);
  assert.equal(await fundedByFaucet(fakeKv(), ''), false);
});

test('a recorded label is written once and never relabelled', async () => {
  const kv = fakeKv();
  const first = await recordInferredProvenance(kv, HASH_A, 'demo', { basis: 'faucet' });
  assert.deepEqual(first, { ok: true, written: true });

  const second = await recordInferredProvenance(kv, HASH_A, 'scripted-load', { basis: 'other' });
  assert.equal(second.ok, true);
  assert.equal(second.written, false, 'the first reason recorded is the one that stands');

  const stored = JSON.parse(kv.values.get(PROVENANCE_KEY(HASH_A)));
  assert.equal(stored.label, 'demo');
  assert.equal(stored.basis, 'faucet');
});

test('anything that is not a transaction hash is refused', async () => {
  const kv = fakeKv();
  for (const bad of ['', 'nope', 'A'.repeat(63), null, undefined]) {
    const r = await recordInferredProvenance(kv, bad, 'demo');
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not be recorded`);
  }
  assert.equal(kv.calls.length, 0, 'a malformed hash never reaches the store');
});

test('reading labels tolerates both transport envelopes, and junk values', async () => {
  for (const wrapped of [false, true]) {
    const values = new Map([
      [PROVENANCE_KEY(HASH_A), JSON.stringify({ label: 'demo', basis: 'faucet' })],
      [PROVENANCE_KEY(HASH_B), 'not json'],
    ]);
    const out = await readInferredProvenance(fakeKv({ values, wrapped }), [HASH_A, HASH_B]);
    assert.equal(out[HASH_A]?.label, 'demo', `wrapped=${wrapped}`);
    assert.equal(out[HASH_B], undefined, 'an unreadable value is not a label');
  }
});

test('an unreachable store yields no labels rather than throwing', async () => {
  assert.deepEqual(await readInferredProvenance(fakeKv({ fail: 'ETIMEDOUT' }), [HASH_A]), {});
  assert.deepEqual(await readInferredProvenance(null, [HASH_A]), {});
  assert.deepEqual(await readInferredProvenance(fakeKv(), []), {});
});

/* ── the join, which is where the honesty lives ───────────────────────────── */

const row = (txHash) => ({ txHash, to: 'GSELLER', amount: '0.01' });

test('a recorded label outranks an inferred one', () => {
  const [labelled] = labelRows([row(HASH_A)], {
    provenance: { [HASH_A]: { label: 'conformance' } },
    inferred: { [HASH_A]: { label: 'demo', basis: 'faucet' } },
  });
  assert.equal(labelled.provenance.label, 'conformance');
  assert.equal(labelled.provenance.source, 'recorded');
  assert.equal(labelled.provenance.basis, undefined, 'a recorded label carries no inference basis');
});

test('an inferred label is marked as inferred and carries its basis', () => {
  const [labelled] = labelRows([row(HASH_A)], {
    inferred: { [HASH_A]: { label: 'demo', basis: 'payer funded by the faucet' } },
  });
  assert.equal(labelled.provenance.label, 'demo');
  assert.equal(labelled.provenance.source, 'inferred');
  assert.equal(labelled.provenance.basis, 'payer funded by the faucet');
});

test('a hash in neither map is unlabeled and absent — never organic', () => {
  const [labelled] = labelRows([row(HASH_A)], { provenance: {}, inferred: {} });
  assert.equal(labelled.provenance.label, 'unlabeled');
  assert.equal(labelled.provenance.source, 'absent');
  assert.notEqual(labelled.provenance.label, 'organic');
});

test('a label outside the closed set is refused from either map', () => {
  const [fromRecorded] = labelRows([row(HASH_A)], { provenance: { [HASH_A]: { label: 'organic' } } });
  assert.equal(fromRecorded.provenance.label, 'unlabeled');
  assert.equal(fromRecorded.provenance.source, 'absent');

  const [fromInferred] = labelRows([row(HASH_A)], { inferred: { [HASH_A]: { label: 'organic' } } });
  assert.equal(fromInferred.provenance.label, 'unlabeled');
  assert.equal(fromInferred.provenance.source, 'absent');
});

test('an invalid recorded label falls through to a valid inferred one', () => {
  const [labelled] = labelRows([row(HASH_A)], {
    provenance: { [HASH_A]: { label: 'organic' } },
    inferred: { [HASH_A]: { label: 'demo', basis: 'faucet' } },
  });
  assert.equal(labelled.provenance.label, 'demo');
  assert.equal(labelled.provenance.source, 'inferred');
});
