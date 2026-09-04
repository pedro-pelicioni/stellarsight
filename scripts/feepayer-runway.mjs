#!/usr/bin/env node
/**
 * scripts/feepayer-runway.mjs — is the sponsor account about to stop paying for everyone.
 *
 * THREAT-MODEL.md T6: the facilitator sponsors every buyer's network fee from
 * `FEEPAYER_PUBLIC`. Drain that account and every settlement stops at once, and until
 * this script existed nothing would say so before the first failed `/settle`. This reads
 * the fee-payer's balance and transaction history straight off Horizon and answers the
 * four numbers MONITORING.md's "Fee sponsorship" table already names:
 *
 *   - current XLM balance
 *   - fee burn over the last hour, against the trailing 24h median (row 2: > 3x = spike),
 *     once it clears an absolute floor — see BURN_FLOOR_STROOPS for why the floor exists
 *   - days of runway at the trailing 7-day burn rate (row 1: < 7 days = page)
 *   - the nightly conformance settlement's own fee, against half the 500k-stroop ceiling
 *     (row 3) — read from docs/status/soroban-footprint.json rather than re-fetched,
 *     since evidence:footprint already measured that exact transaction
 *
 * The last-hour-vs-24h-median spike check and the 7-day runway rate are deliberately two
 * separate computations, not the same number reused twice: MONITORING.md names two
 * different windows because they answer different questions — one hour is a drain-attempt
 * detector, seven days is a slow-depletion estimate. Averaging one into the other would
 * make the spike detector insensitive or the runway estimate jumpy on a single busy hour.
 *
 * Every `include_failed=true` transaction on the account counts toward burn, not just the
 * successful ones — Horizon already charged the fee regardless of outcome, and a drain
 * attempt would very plausibly show up as a run of failed transactions.
 *
 * Usage:
 *   node scripts/feepayer-runway.mjs
 *   node scripts/feepayer-runway.mjs --feepayer G... --horizon https://horizon-testnet.stellar.org
 *   node scripts/feepayer-runway.mjs --emit                 # write docs/status/feepayer.json
 *   node scripts/feepayer-runway.mjs --runway-days 999999999 --burn-multiplier 0 --burn-floor-stroops 0  # force a breach
 *
 * Exits non-zero if runway is under --runway-days, the last hour's burn exceeds both
 * --burn-floor-stroops and --burn-multiplier times the trailing 24h median, or the last
 * conformance settlement's fee exceeds --fee-ceiling-half stroops.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { readEvidence, writeEvidence } from './lib/evidence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(ROOT, '.env'), quiet: true });

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const STROOPS_PER_XLM = 10_000_000;
const HORIZON_PAGE_LIMIT = 200; // Horizon's actual per-page max; confirmed live — 201 is refused
const RUNWAY_WINDOW_DAYS = 7;
const BURN_SPIKE_WINDOW_HOURS = 24;
/**
 * The smallest trailing-hour burn worth calling a spike at all, in stroops: 0.5 XLM, about a
 * hundred sponsored settlements at the ~50,000-stroop fee the nightly conformance run pays.
 *
 * Why a floor: on a quiet account 23 of the 24 hourly buckets are empty, so the trailing-24h
 * median is 0 and "more than 3x the median" degrades to "any fee in the trailing hour is a
 * breach". One playground payment landing in the hour before a scheduled check would then
 * open a public drain alert. Below the floor the runway rule is the one that matters; above
 * it the multiplier still has to be cleared, so a busy account is judged against its own
 * history rather than against this constant.
 */
const BURN_FLOOR_STROOPS = 5_000_000;
const REQUEST_TIMEOUT_MS = 8000;

const trim = (u) => String(u || '').replace(/\/+$/, '');

export async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Native-asset XLM balance for an account, as Horizon reports it (a decimal string). */
export async function fetchNativeBalance(horizonUrl, feePayer, fetchImpl) {
  const account = await getJson(`${trim(horizonUrl)}/accounts/${feePayer}`, fetchImpl);
  const native = (account?.balances ?? []).find((b) => b.asset_type === 'native');
  if (!native) throw new Error(`account ${feePayer} has no native balance in its Horizon record`);
  return native.balance;
}

/**
 * Every transaction (successful or not) on `feePayer`'s account with `created_at` no
 * older than `sinceMs`, newest first, following Horizon's `_links.next.href` pagination.
 */
export async function fetchTransactionsSince({ horizonUrl, feePayer, sinceMs, fetchImpl, pageLimit = HORIZON_PAGE_LIMIT }) {
  const base = trim(horizonUrl);
  let url = `${base}/accounts/${feePayer}/transactions?order=desc&limit=${pageLimit}&include_failed=true`;
  const records = [];
  // A hard cap on pages, not just on the time window: a misbehaving Horizon that never
  // returns an old-enough record or a missing `_links.next.href` should not hang this
  // script forever.
  for (let page = 0; url && page < 1000; page += 1) {
    const body = await getJson(url, fetchImpl);
    const batch = body?._embedded?.records ?? [];
    if (batch.length === 0) break;
    let hitCutoff = false;
    for (const tx of batch) {
      const createdMs = Date.parse(tx.created_at);
      if (Number.isFinite(sinceMs) && Number.isFinite(createdMs) && createdMs < sinceMs) {
        hitCutoff = true;
        break;
      }
      records.push(tx);
    }
    if (hitCutoff) break;
    url = body?._links?.next?.href ?? null;
  }
  return records;
}

export function feeChargedStroops(tx) {
  const n = Number(tx?.fee_charged);
  return Number.isFinite(n) ? n : 0;
}

export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Sums fee_charged into `hours` rolling one-hour buckets counted back from `nowMs`.
 * bucket[0] is the trailing 60 minutes — never a partial calendar hour — so "the last
 * hour's burn" means the same thing at 03:05 as it does at 03:55.
 */
export function bucketHourlyBurn(txs, nowMs, hours = BURN_SPIKE_WINDOW_HOURS) {
  const buckets = new Array(hours).fill(0);
  const hourMs = 60 * 60 * 1000;
  for (const tx of txs) {
    const createdMs = Date.parse(tx.created_at);
    if (!Number.isFinite(createdMs)) continue;
    const ageMs = nowMs - createdMs;
    if (ageMs < 0) continue;
    const idx = Math.floor(ageMs / hourMs);
    if (idx < hours) buckets[idx] += feeChargedStroops(tx);
  }
  return buckets;
}

/**
 * Row 2: last hour's burn against the trailing 24h median — a spike only when it clears BOTH
 * the multiplier and the absolute floor (see BURN_FLOOR_STROOPS).
 */
export function computeBurnRate(
  txs,
  nowMs,
  { burnMultiplier = 3, burnFloorStroops = BURN_FLOOR_STROOPS } = {},
) {
  const buckets = bucketHourlyBurn(txs, nowMs, BURN_SPIKE_WINDOW_HOURS);
  const lastHourBurnStroops = buckets[0];
  const median24hStroops = median(buckets);
  const breach =
    lastHourBurnStroops > burnFloorStroops && lastHourBurnStroops > burnMultiplier * median24hStroops;
  return {
    lastHourBurnStroops,
    median24hStroops,
    multiplier: burnMultiplier,
    floorStroops: burnFloorStroops,
    breach,
  };
}

/**
 * Row 1: days of runway at the trailing RUNWAY_WINDOW_DAYS average burn rate. The average
 * divides by the FULL fixed window (168h), not by "hours actually covered by data" — a
 * single transaction three days ago should read as a low, diluted average, not be
 * extrapolated into a spike from one data point.
 */
export function computeRunway(txs, nowMs, balanceStroops, { runwayDays = RUNWAY_WINDOW_DAYS } = {}) {
  const windowMs = RUNWAY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const cutoffMs = nowMs - windowMs;
  let totalBurnStroops = 0;
  for (const tx of txs) {
    const createdMs = Date.parse(tx.created_at);
    if (!Number.isFinite(createdMs) || createdMs < cutoffMs) continue;
    totalBurnStroops += feeChargedStroops(tx);
  }
  const avgBurnPerHourStroops = totalBurnStroops / (RUNWAY_WINDOW_DAYS * 24);
  const days = avgBurnPerHourStroops > 0 ? balanceStroops / avgBurnPerHourStroops / 24 : null;
  const breach = days !== null && days < runwayDays;
  return { avgBurnPerHourStroops, totalBurnStroops, days, thresholdDays: runwayDays, breach };
}

/** Row 3: the nightly conformance settlement's fee against half the 500k-stroop ceiling. */
export function computePerTxFee(footprintEvidence, feeCeilingHalf) {
  const stroops = footprintEvidence?.fees?.feeBumpFeeStroops ?? footprintEvidence?.fees?.innerFeeStroops;
  if (!Number.isFinite(stroops)) return null;
  return {
    stroops,
    ceilingHalfStroops: feeCeilingHalf,
    breach: stroops > feeCeilingHalf,
    source: 'docs/status/soroban-footprint.json',
    txHash: footprintEvidence.txHash ?? null,
  };
}

export function evaluate({ balanceXlm, txs, nowMs, footprintEvidence, thresholds }) {
  const balanceStroops = Math.round(Number(balanceXlm) * STROOPS_PER_XLM);
  const burnRate = computeBurnRate(txs, nowMs, {
    burnMultiplier: thresholds.burnMultiplier,
    burnFloorStroops: thresholds.burnFloorStroops,
  });
  const runway = computeRunway(txs, nowMs, balanceStroops, { runwayDays: thresholds.runwayDays });
  const perTxFee = computePerTxFee(footprintEvidence, thresholds.feeCeilingHalf);
  const breach = Boolean(runway.breach || burnRate.breach || perTxFee?.breach);
  return { balanceXlm: String(balanceXlm), balanceStroops, burnRate, runway, perTxFee, breach };
}

async function main() {
  const feePayer = flag('feepayer', process.env.FEEPAYER_PUBLIC);
  if (!feePayer) {
    console.error(
      'no fee-payer account configured: pass --feepayer G... or set FEEPAYER_PUBLIC, so ' +
        'there is no account to read a runway for',
    );
    process.exit(2);
  }
  const horizonUrl = flag('horizon', process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org');
  const thresholds = {
    runwayDays: Number(flag('runway-days', String(RUNWAY_WINDOW_DAYS))),
    burnMultiplier: Number(flag('burn-multiplier', '3')),
    burnFloorStroops: Number(flag('burn-floor-stroops', String(BURN_FLOOR_STROOPS))),
    feeCeilingHalf: Number(flag('fee-ceiling-half', '250000')),
  };

  const nowMs = Date.now();
  const sinceMs = nowMs - RUNWAY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  let balanceXlm;
  let txs;
  try {
    [balanceXlm, txs] = await Promise.all([
      fetchNativeBalance(horizonUrl, feePayer, fetch),
      fetchTransactionsSince({ horizonUrl, feePayer, sinceMs, fetchImpl: fetch }),
    ]);
  } catch (e) {
    console.error(`Horizon did not answer for ${feePayer}: ${e.message}`);
    process.exit(2);
  }

  const footprintEvidence = readEvidence('soroban-footprint');
  const result = evaluate({ balanceXlm, txs, nowMs, footprintEvidence, thresholds });

  const payload = {
    feePayer,
    horizon: horizonUrl,
    windowDays: RUNWAY_WINDOW_DAYS,
    transactionsConsidered: txs.length,
    ...result,
  };

  if (has('emit')) {
    const { path } = writeEvidence('feepayer', payload);
    console.log(`[feepayer] wrote ${path.replace(`${process.cwd()}/`, '')}`);
  }

  const xlm = (stroops) => (stroops / STROOPS_PER_XLM).toFixed(7);
  console.log(`\nFee-payer runway — ${feePayer}\n`);
  console.log(`  balance              ${result.balanceXlm} XLM`);
  console.log(
    `  last-hour burn       ${xlm(result.burnRate.lastHourBurnStroops)} XLM` +
      ` vs trailing-24h median ${xlm(result.burnRate.median24hStroops)} XLM` +
      ` (>${thresholds.burnMultiplier}x and above the ${xlm(thresholds.burnFloorStroops)} XLM floor: ${result.burnRate.breach ? 'BREACH' : 'ok'})`,
  );
  console.log(
    `  runway               ${result.runway.days === null ? 'unbounded (no burn observed)' : `${result.runway.days.toFixed(2)} days`}` +
      ` (< ${thresholds.runwayDays}d ${result.runway.breach ? 'BREACH' : 'ok'})`,
  );
  if (result.perTxFee) {
    console.log(
      `  last conformance fee ${result.perTxFee.stroops} stroops` +
        ` (> ${thresholds.feeCeilingHalf} ${result.perTxFee.breach ? 'BREACH' : 'ok'}) — ${result.perTxFee.txHash ?? 'unknown tx'}`,
    );
  } else {
    console.log('  last conformance fee  no docs/status/soroban-footprint.json to read yet');
  }
  console.log(`\n  ${result.breach ? 'BREACH — see above' : 'within thresholds'}\n`);

  if (result.breach) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
