/**
 * test/payment-shape.test.mjs — the acceptance criterion about `payload: { transaction }`.
 *
 * The criterion is observed at conformance time from the header a stock client sent, which
 * means it only ever runs when a real payment runs. These tests pin the reading of that
 * header against a payload captured from a real settlement, so a change that quietly makes
 * the criterion always report "not observed" — the failure mode that turns a check into
 * decoration — fails here instead of passing silently every night.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePaymentHeader, innerPayload, payloadShape } from '../scripts/lib/payment-shape.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/settled-payload.json'), 'utf8'));

const asHeader = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

test('a real settled payload reads as verbatim `{ transaction }`', () => {
  const shape = payloadShape(decodePaymentHeader(asHeader(fixture.paymentPayload)));
  assert.equal(shape.observed, true);
  assert.deepEqual(shape.keys, ['transaction']);
  assert.equal(shape.transactionIsString, true);
  assert.equal(shape.verbatim, true, 'the recorded payload is the shape the criterion names');
});

test('an unreadable header is "not observed", never a pass', () => {
  for (const bad of [null, undefined, '', 'not-base64-json', Buffer.from('{oops', 'utf8').toString('base64')]) {
    const shape = payloadShape(decodePaymentHeader(bad));
    assert.equal(shape.observed, false, `${JSON.stringify(bad)} should not be observed`);
    assert.equal(shape.verbatim, false, `${JSON.stringify(bad)} must never read as verbatim`);
  }
});

test('an extra field is not verbatim', () => {
  const shape = payloadShape(
    decodePaymentHeader(asHeader({ payload: { transaction: 'AAAA', memo: 'extra' } })),
  );
  assert.equal(shape.observed, true);
  assert.deepEqual(shape.keys, ['memo', 'transaction']);
  assert.equal(shape.verbatim, false, 'a payload carrying more than `transaction` is drift, not a pass');
});

test('an empty or non-string transaction is not verbatim', () => {
  for (const value of ['', 42, null, { nested: true }]) {
    const shape = payloadShape(decodePaymentHeader(asHeader({ payload: { transaction: value } })));
    assert.equal(shape.verbatim, false, `transaction=${JSON.stringify(value)} must not read as verbatim`);
  }
});

test('a wrapped PaymentPayload is unwrapped', () => {
  const shape = payloadShape(decodePaymentHeader(asHeader({ paymentPayload: fixture.paymentPayload })));
  assert.equal(shape.verbatim, true);
});

test('a payload that is an array or a scalar is not an object to inspect', () => {
  assert.equal(innerPayload({ payload: ['transaction'] }), null);
  assert.equal(innerPayload({ payload: 'transaction' }), null);
  assert.equal(payloadShape({ payload: ['transaction'] }).observed, false);
});
