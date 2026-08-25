/**
 * The facilitator must validate a seller's `info` against the `schema` the seller supplied.
 *
 * RFP 3.2 is specific: on receiving a PaymentPayload carrying the discovery extension, the
 * facilitator "validates `info` against the supplied `schema` and catalogs the resource
 * with no separate registration step".
 *
 * We were doing the second half only. `validateAndExtract` takes ONE argument — the
 * discovery extension — and the call passed it two, `(paymentRequirements, paymentPayload)`.
 * That returns `{valid:false}` for every input, the guard below it rejected the result, and
 * the code fell through to a raw unvalidated read of the same block. The stock validator
 * never ran on any payment.
 *
 * These tests pin both halves: that the upstream helper does the job when called correctly,
 * and that the shape our facilitator now passes it is the shape it accepts. They exercise
 * the published `@x402/extensions` helper rather than a copy of its behaviour, so an
 * upstream change to the contract fails here rather than silently downgrading us to no
 * validation again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateAndExtract } from '@x402/extensions/bazaar';

/** A schema that actually constrains the field the hostile cases corrupt. */
const schema = {
  type: 'object',
  required: ['serviceName'],
  properties: {
    serviceName: { type: 'string' },
    maxItems: { type: 'integer' },
  },
};

const extension = (info) => ({ info, schema, input: { type: 'http', method: 'GET' } });

test('the helper accepts info that satisfies the seller’s own schema', () => {
  const out = validateAndExtract(extension({ serviceName: 'stellarsight-fx', maxItems: 3 }));
  assert.equal(out.valid, true);
  assert.equal(out.info.serviceName, 'stellarsight-fx');
});

test('a field typed against the schema is rejected, with a reason naming the field', () => {
  const out = validateAndExtract(extension({ serviceName: 12345 }));
  assert.equal(out.valid, false, 'a number where the schema says string must not validate');
  assert.ok(Array.isArray(out.errors) && out.errors.length > 0, 'errors must be reported');
  assert.match(out.errors.join(' '), /serviceName/, 'the reason must name the offending field');
});

test('a missing required field is rejected', () => {
  const out = validateAndExtract(extension({}));
  assert.equal(out.valid, false);
  assert.match(out.errors.join(' '), /required/i);
});

test('the two-argument call this repo used to make never validates anything', () => {
  // The regression itself, pinned. If a future edit reintroduces the two-argument shape,
  // this test documents exactly what that costs: `valid:false` on every input, which the
  // facilitator's guard reads as "no discovery info" and silently falls through to the
  // unvalidated path.
  const paymentRequirements = { scheme: 'exact', network: 'stellar:testnet', extensions: { bazaar: extension({ serviceName: 'ok' }) } };
  const paymentPayload = { x402Version: 2, extensions: { bazaar: extension({ serviceName: 'ok' }) } };
  const out = validateAndExtract(paymentRequirements, paymentPayload);
  assert.equal(out.valid, false, 'the wrong call shape reports invalid even for valid input');
  assert.match(out.errors.join(' '), /schema/i);
});

test('the facilitator passes the extension block itself, not the envelope', async () => {
  // Reading the source rather than booting the stack: the property under test is which
  // value reaches the helper, and that is a call-shape question.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../apps/facilitator/src/server.mjs', import.meta.url), 'utf8');
  assert.match(src, /validateAndExtract\(block\)/, 'the helper must receive the extension block');
  assert.doesNotMatch(
    src,
    /validateAndExtract\?\.\(paymentRequirements, paymentPayload\)/,
    'the two-argument call must not come back',
  );
});
