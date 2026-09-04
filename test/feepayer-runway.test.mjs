/**
 * The two rate computations in scripts/feepayer-runway.mjs answer different questions and
 * must stay different: a spike detector (last hour vs. the trailing 24h median) and a
 * slow-depletion estimate (balance vs. the trailing 7-day average). These tests exercise
 * the pure math directly — bucketing, median, runway, breach — plus the Horizon pagination
 * loop against a canned multi-page fixture, offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bucketHourlyBurn,
  median,
  computeBurnRate,
  computeRunway,
  computePerTxFee,
  evaluate,
  fetchTransactionsSince,
  feeChargedStroops,
} from '../scripts/feepayer-runway.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-02T12:00:00Z');

const tx = (agoMs, fee) => ({ created_at: new Date(NOW - agoMs).toISOString(), fee_charged: String(fee) });

test('feeChargedStroops reads the Horizon string field as a number', () => {
  assert.equal(feeChargedStroops({ fee_charged: '37960' }), 37960);
  assert.equal(feeChargedStroops({ fee_charged: undefined }), 0, 'a missing field costs nothing rather than NaN');
});

test('median handles even and odd counts, and an empty series is zero', () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('bucketHourlyBurn puts each fee in the rolling hour it actually happened, not a calendar hour', () => {
  const buckets = bucketHourlyBurn(
    [tx(30 * 60 * 1000, 100), tx(90 * 60 * 1000, 200), tx(25 * HOUR, 9999)],
    NOW,
    24,
  );
  assert.equal(buckets[0], 100, 'a fee 30 minutes ago lands in the trailing-hour bucket');
  assert.equal(buckets[1], 200, 'a fee 90 minutes ago lands one bucket back');
  assert.equal(buckets.reduce((a, b) => a + b, 0), 300, 'anything past the 24-bucket window is dropped, not overflowed');
});

test('computeBurnRate: on a quiet account one ordinary payment in the trailing hour is not a spike', () => {
  // Only 2 of the other 23 hourly buckets have any burn at all, so the 24h median is 0 — the
  // shape the deployed fee-payer has every day. Before the floor this read as a breach.
  const quietTxs = [tx(20 * HOUR, 50_000), tx(21 * HOUR, 50_000)];
  const one = computeBurnRate([tx(10 * 60 * 1000, 50_374), ...quietTxs], NOW, { burnMultiplier: 3 });
  assert.equal(one.lastHourBurnStroops, 50_374);
  assert.equal(one.median24hStroops, 0, 'the median bucket is empty because most hours saw nothing');
  assert.equal(one.floorStroops, 5_000_000, 'the default floor is 0.5 XLM per hour');
  assert.equal(one.breach, false, 'a settlement-sized fee sits two orders of magnitude under the floor');
});

test('computeBurnRate: a burst above the floor on a quiet account is a spike', () => {
  const burst = computeBurnRate([tx(10 * 60 * 1000, 6_000_000), tx(20 * HOUR, 50_000)], NOW, { burnMultiplier: 3 });
  assert.equal(burst.median24hStroops, 0);
  assert.equal(burst.breach, true, 'above the floor with a zero median, the multiplier is trivially cleared');
});

test('computeBurnRate: on a busy account the multiplier, not the floor, decides', () => {
  const steady = computeBurnRate(Array.from({ length: 24 }, (_, i) => tx(i * HOUR + 1, 100)), NOW, { burnMultiplier: 3 });
  assert.equal(steady.breach, false, 'a flat burn rate never exceeds its own median by 3x');

  // 23 hours at 3,000,000 stroops -> median 3,000,000. The trailing hour is judged against 9,000,000.
  const history = Array.from({ length: 23 }, (_, i) => tx((i + 1) * HOUR + 1, 3_000_000));
  const spike = computeBurnRate([tx(10 * 60 * 1000, 10_000_000), ...history], NOW, { burnMultiplier: 3 });
  assert.equal(spike.median24hStroops, 3_000_000);
  assert.equal(spike.breach, true, '10,000,000 clears both the floor and 3x the median');

  const under = computeBurnRate([tx(10 * 60 * 1000, 6_000_000), ...history], NOW, { burnMultiplier: 3 });
  assert.equal(under.breach, false, 'above the floor but under 3x the median is ordinary traffic for this account');
});

test('computeBurnRate: a zero floor restores the strict any-burn rule', () => {
  const strict = computeBurnRate([tx(10 * 60 * 1000, 1)], NOW, { burnMultiplier: 3, burnFloorStroops: 0 });
  assert.equal(strict.breach, true);
});

test('computeRunway divides by the full 7-day window, not by however much history exists', () => {
  // One transaction, three days ago: should read as a low, diluted average — not an
  // extrapolated spike from a single data point.
  const runway = computeRunway([tx(3 * DAY, 700_000)], NOW, 1_000_000_000, { runwayDays: 7 });
  const expectedPerHour = 700_000 / (7 * 24);
  assert.ok(Math.abs(runway.avgBurnPerHourStroops - expectedPerHour) < 1e-9);
  assert.equal(runway.breach, false, 'a well-funded, lightly-used account is not near drained');
});

test('computeRunway reports unbounded runway (not Infinity/NaN) when no burn is observed', () => {
  const runway = computeRunway([], NOW, 1_000_000_000, { runwayDays: 7 });
  assert.equal(runway.days, null);
  assert.equal(runway.breach, false);
});

test('computeRunway breaches once the trailing average would drain the balance inside the threshold', () => {
  // 7 days of burn at 1,000,000 stroops/day against a 3,000,000-stroop balance: 3 days of
  // runway, under the default 7-day threshold.
  const txs = Array.from({ length: 7 }, (_, d) => tx(d * DAY, 1_000_000));
  const runway = computeRunway(txs, NOW, 3_000_000, { runwayDays: 7 });
  assert.ok(runway.days < 7);
  assert.equal(runway.breach, true);
});

test('computePerTxFee reads feeBumpFeeStroops over innerFeeStroops when both are present', () => {
  const both = computePerTxFee({ fees: { innerFeeStroops: 50274, feeBumpFeeStroops: 50374 }, txHash: 'abc' }, 250_000);
  assert.equal(both.stroops, 50374);
  assert.equal(both.breach, false);

  const overCeiling = computePerTxFee({ fees: { innerFeeStroops: 300_000 }, txHash: 'def' }, 250_000);
  assert.equal(overCeiling.stroops, 300_000);
  assert.equal(overCeiling.breach, true);
});

test('computePerTxFee is null, not thrown, when there is no footprint evidence yet', () => {
  assert.equal(computePerTxFee(null, 250_000), null);
  assert.equal(computePerTxFee({}, 250_000), null);
});

test('evaluate combines all three signals into one breach flag', () => {
  const result = evaluate({
    balanceXlm: '100.0000000',
    txs: [],
    nowMs: NOW,
    footprintEvidence: { fees: { innerFeeStroops: 300_000 }, txHash: 'x'.repeat(64) },
    thresholds: { runwayDays: 7, burnMultiplier: 3, feeCeilingHalf: 250_000 },
  });
  assert.equal(result.balanceStroops, 1_000_000_000);
  assert.equal(result.breach, true, 'the per-tx-fee breach alone should trip the overall flag');
});

/** A canned Horizon: two pages, following `_links.next.href`. */
function horizonPages(pages) {
  let served = 0;
  return async function fetchImpl(url) {
    const page = served === 0 ? pages[0] : pages.find((p) => p.url === url);
    served += 1;
    if (!page) return { ok: true, status: 200, json: async () => ({ _embedded: { records: [] } }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        _embedded: { records: page.records },
        _links: page.next ? { next: { href: page.next } } : {},
      }),
    };
  };
}

test('fetchTransactionsSince follows _links.next.href across pages', async () => {
  const page1 = { records: [tx(HOUR, 10), tx(2 * HOUR, 20)], next: 'https://horizon/page2' };
  const page2 = { url: 'https://horizon/page2', records: [tx(3 * HOUR, 30)] };
  const records = await fetchTransactionsSince({
    horizonUrl: 'https://horizon',
    feePayer: 'GFEEPAYER',
    sinceMs: NOW - 7 * DAY,
    fetchImpl: horizonPages([page1, page2]),
  });
  assert.equal(records.length, 3, 'both pages were consumed');
});

test('fetchTransactionsSince stops once a record falls outside the trailing window', async () => {
  const page1 = {
    records: [tx(HOUR, 10), tx(10 * DAY, 999_999)], // the second record is 10 days old
    next: 'https://horizon/page2',
  };
  // If pagination did not stop at the cutoff, this second page's fee would also be counted.
  const page2 = { url: 'https://horizon/page2', records: [tx(11 * DAY, 999_999)] };
  const records = await fetchTransactionsSince({
    horizonUrl: 'https://horizon',
    feePayer: 'GFEEPAYER',
    sinceMs: NOW - 7 * DAY,
    fetchImpl: horizonPages([page1, page2]),
  });
  assert.equal(records.length, 1, 'the loop stopped at the first out-of-window record instead of paging further');
});

test('fetchTransactionsSince returns an empty list, not an error, on an empty account', async () => {
  const records = await fetchTransactionsSince({
    horizonUrl: 'https://horizon',
    feePayer: 'GFEEPAYER',
    sinceMs: NOW - 7 * DAY,
    fetchImpl: horizonPages([{ records: [] }]),
  });
  assert.equal(records.length, 0);
});
