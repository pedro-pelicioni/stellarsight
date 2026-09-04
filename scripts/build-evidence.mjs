#!/usr/bin/env node
/**
 * STELLARSIGHT — assembles docs/EVIDENCE.md, the "verify it yourself" page.
 *
 * Everything on that page comes from docs/status/*.json, which is written only by the
 * scripts that produced the runs. Nothing here is typed by a human, and the page says so:
 * a reviewer reading a number can open the artifact that produced it, and re-run the
 * command that wrote the artifact.
 *
 * It also states, in the same table, what this build does NOT claim — no mainnet, no
 * completed audit, a catalog that is still mostly seed records. A page of evidence that
 * omits its own limits is marketing.
 *
 * Usage:
 *   node scripts/build-evidence.mjs
 *   npm run evidence:build
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATUS_DIR, readEvidence, updateProvenance } from './lib/evidence.mjs';
import { deriveCounts } from './lib/counts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'EVIDENCE.md');
const SITE = 'https://stellarsight.xyz';

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * The four testnet accounts, read back out of docs/TESTNET-TXS.md rather than derived
 * from .env: that file is the published source, so if the two ever disagree this page
 * shows what a reader would actually find.
 */
function accountsFromTxDoc() {
  let md = '';
  try {
    md = readFileSync(join(ROOT, 'docs', 'TESTNET-TXS.md'), 'utf8');
  } catch {
    /* no transaction doc yet — the accounts section is simply omitted */
  }
  const rows = [];
  for (const line of md.split('\n')) {
    const m = /^\|\s*(ISSUER|SELLER|PAYER|FEEPAYER)\s*\|\s*`(G[A-Z2-7]{55})`/.exec(line.trim());
    if (m) rows.push({ role: m[1], key: m[2] });
  }
  return rows;
}

/**
 * Label the transactions that predate the provenance map.
 *
 * docs/TESTNET-TXS.md has recorded every settlement since the first day, and each row's
 * Step column was written by the script that produced it — `demo:`, `conformance:`,
 * `load:`, or a setup/cleanup operation. Those prefixes are the same facts the provenance
 * map stores, so deriving from them backfills history without inventing anything. Rows
 * whose prefix does not map to a known label are left out rather than guessed at, and
 * updateProvenance never overwrites a label already recorded.
 */
function backfillProvenanceFromTxDoc() {
  let md = '';
  try {
    md = readFileSync(join(ROOT, 'docs', 'TESTNET-TXS.md'), 'utf8');
  } catch {
    return { added: 0 };
  }
  const entries = {};
  for (const line of md.split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|\s*`([0-9a-f]{64})`/.exec(line.trim());
    if (!m) continue;
    const [, step, hash] = m;
    const label = step.startsWith('load:')
      ? 'scripted-load'
      : step.startsWith('conformance')
        ? 'conformance'
        : step.startsWith('demo')
          ? 'demo'
          : /^(Issuer|changeTrust|Payment ISSUER|Deploy SAC|cleanup)/i.test(step)
            ? 'setup'
            : null;
    if (label) entries[hash] = { label };
  }
  return updateProvenance(entries);
}

/**
 * Rewrite the count line at the top of TESTNET-TXS.md from the rows below it.
 *
 * That sentence has gone stale three times now, each time in the direction of
 * understating the number — which is still a number that does not match the table under
 * it. Counting is the machine's job; the prose around it stays hand-written.
 */
function retallyTxDoc() {
  const path = join(ROOT, 'docs', 'TESTNET-TXS.md');
  let md;
  try {
    md = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const counts = { setup: 0, cleanup: 0, payments: 0 };
  for (const line of md.split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|\s*`[0-9a-f]{64}`/.exec(line.trim());
    if (!m) continue;
    const step = m[1];
    if (/^cleanup/i.test(step)) counts.cleanup++;
    else if (/^(load:|demo|conformance)/i.test(step)) counts.payments++;
    else counts.setup++;
  }
  const total = counts.setup + counts.cleanup + counts.payments;
  const next = md.replace(
    /^\d+ rows: \d+ setup \+ \d+ cleanup \+ \*\*\d+ settled x402 payments\*\*\./m,
    `${total} rows: ${counts.setup} setup + ${counts.cleanup} cleanup + **${counts.payments} settled x402 payments**.`,
  );
  if (next !== md) writeFileSync(path, next, 'utf8');
  return { ...counts, total, changed: next !== md };
}

const tally = retallyTxDoc();
if (tally?.changed) {
  console.log(`[build-evidence] retallied TESTNET-TXS.md: ${tally.total} rows, ${tally.payments} payments`);
}

/**
 * Rewrite the README's payment counts from the same tally.
 *
 * The README used to claim these numbers "cannot drift again" while this script only ever
 * wrote docs/ — so within two days of the claim the README was three payments behind its
 * own table. A sentence that asserts its own freshness has to be MADE fresh by something;
 * this is that something.
 *
 * The prose lives between markers and is regenerated wholesale rather than regexed, so a
 * reworded sentence cannot silently stop being updated.
 */
function retallyReadme(counts, provenanceCounts) {
  const path = join(ROOT, 'README.md');
  let md;
  try {
    md = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  const before = md;

  // 1. the badge
  md = md.replace(
    /(badge\/settled_x402_payments-)\d+(-blue)/,
    `$1${counts.payments}$2`,
  );

  // 2. the tally block, regenerated between its markers
  const label = (k) => provenanceCounts[k] ?? 0;
  const block = [
    '<!-- evidence:tally — rewritten by `npm run evidence:build`; do not hand-edit the numbers -->',
    `${counts.total} in total, and the split matters: **${counts.payments} are x402 payments** and ${counts.setup + counts.cleanup} are setup and cleanup`,
    `(${counts.setup} setup, ${counts.cleanup} cleanup) — trustlines, the SAC deploy, minting the test asset, and returning a`,
    'legacy balance. Only the payment rows are evidence that the payment path works.',
    '',
    `The ${counts.payments} also split by what produced them, because a settlement count without that is not`,
    `evidence of anything: ${label('scripted-load')} from \`npm run evidence:batch\` (a serial script paying our own`,
    `seller, prefixed \`load:\`), ${label('demo')} from the demo loop, ${label('conformance') + label('nightly-ci')} from stock-client conformance runs.`,
    '<!-- /evidence:tally -->',
  ].join('\n');

  md = md.replace(
    /<!-- evidence:tally[\s\S]*?<!-- \/evidence:tally -->/,
    block,
  );

  if (md !== before) writeFileSync(path, md, 'utf8');
  return { changed: md !== before };
}

const backfilled = backfillProvenanceFromTxDoc();
if (backfilled.added) console.log(`[build-evidence] backfilled ${backfilled.added} hash(es) into provenance from TESTNET-TXS.md`);
if (backfilled.conflicts?.length) {
  for (const c of backfilled.conflicts) {
    console.warn(`[build-evidence] provenance conflict for ${c.hash.slice(0, 8)}…: kept "${c.kept}", refused "${c.refused}"`);
  }
}

const statusFiles = existsSync(STATUS_DIR) ? readdirSync(STATUS_DIR).filter((f) => f.endsWith('.json')) : [];
const batches = statusFiles
  .filter((f) => f.startsWith('batch-'))
  .map((f) => readJson(join(STATUS_DIR, f)))
  .filter(Boolean);
const conformance = readEvidence('conformance');
const rejections = readEvidence('rejections');
const provenance = readEvidence('provenance');
const nightly = readEvidence('nightly');
const upstreamE2e = readEvidence('upstream-e2e');
const footprint = readEvidence('soroban-footprint');
const licenses = readEvidence('licenses');
const interop = readEvidence('interop-discovery');
const latency = readEvidence('discovery-latency');
const feepayer = readEvidence('feepayer');

const labelCounts = {};
for (const meta of Object.values(provenance?.hashes ?? {})) {
  labelCounts[meta.label] = (labelCounts[meta.label] ?? 0) + 1;
}
const totalLabeled = Object.values(labelCounts).reduce((a, b) => a + b, 0);

// The README's counts come from the same two sources as this page, so they cannot disagree
// with it. Done here rather than beside retallyTxDoc() because the per-label split is only
// known once provenance has been read and backfilled.
if (tally) {
  const readme = retallyReadme(tally, labelCounts);
  if (readme?.changed) console.log('[build-evidence] rewrote the README tally and badge');
}

// The landing page's proof strip. `SETTLED_PAYMENTS` there has always been derived from
// testnet-txs.json and has always been right; the three counts beside it were hand-typed and
// were wrong — the site was still publishing 205 tests, 66 adversarial cases and 46 API checks
// after the docs had moved to 239, 70 and 49. Writing them here puts them on the same footing
// as every other number this project publishes: generated, and stale only if nobody runs the
// generator.
{
  const counts = deriveCounts();
  const path = join(ROOT, 'apps', 'web', 'src', 'data', 'counts.json');
  const body = `${JSON.stringify(
    {
      note: 'Derived by scripts/lib/counts.mjs via npm run evidence:build. Do not hand-edit.',
      ...counts,
    },
    null,
    2,
  )}\n`;
  const prior = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (prior !== body) {
    writeFileSync(path, body, 'utf8');
    console.log(
      `[build-evidence] wrote apps/web/src/data/counts.json — ${counts.tests} tests, ` +
        `${counts.adversarial} adversarial, ${counts.apiChecks} API checks`,
    );
  }
}

const accounts = accountsFromTxDoc();
const feePayer = accounts.find((a) => a.role === 'FEEPAYER')?.key;

const lines = [];
const w = (s = '') => lines.push(s);

w('# Verify it yourself');
w();
w('Every number on this page is read out of a machine-written artifact under');
w('[`docs/status/`](./status), and every artifact names the command that produced it.');
w('Nothing here is typed by hand — if a claim and the code disagree, the artifact is the');
w('one telling the truth.');
w();
w(`_Generated by \`npm run evidence:build\` from ${statusFiles.length} artifact(s)._`);
w();

/* ── what we do not claim ─────────────────────────────────────────────────── */

w('## What this build does not claim');
w();
w('| Not claimed | Why |');
w('|---|---|');
w('| Mainnet settlement | The facilitator runs on `stellar:testnet` only. `stellar:pubnet` with USDC is Tranche 3 work, gated on the Audit Bank review. The agent refuses to sign on pubnet. |');
w('| A completed security audit | No third-party audit has been performed. A threat model and a monitoring plan exist ([THREAT-MODEL.md](./THREAT-MODEL.md), [MONITORING.md](./MONITORING.md)); an audit is not the same artifact. |');
w('| Organic demand | Every settled payment below was generated by this repo — conformance runs, demos and scripted batches — and is labeled as such in [`docs/status/provenance.json`](./status/provenance.json). No third-party seller has listed yet. |');
w('| A production-sized catalog | The public catalog is mostly seed records on `.example` hosts, flagged `seeded: true` and separable with `?seeded=false`. |');
w('| Concurrency headroom | One fee-payer, one sequence number: 4/4 serial, 1/10 at concurrency 10. Published in full in [LOAD-BASELINE.md](./LOAD-BASELINE.md); the channel pool that fixes it is Tranche 1. |');
w();

/* ── the accounts ─────────────────────────────────────────────────────────── */

if (accounts.length) {
  w('## The four testnet accounts');
  w();
  w('Public keys only. These are what make fee sponsorship checkable rather than asserted:');
  w('open any settled payment on stellar.expert and the transaction\'s **source and fee');
  w('account is the FEEPAYER**, never the payer — the payer appears only inside the Soroban');
  w('authorization entry. That is the whole claim, and it takes two clicks to falsify.');
  w();
  w('| Role | Public key |');
  w('|---|---|');
  for (const a of accounts) {
    w(`| ${a.role} | [\`${a.key}\`](https://stellar.expert/explorer/testnet/account/${a.key}) |`);
  }
  w();
  w(`The FEEPAYER is also published live at [\`${SITE}/health\`](${SITE}/health) as \`feePayer\`.`);
  w();
}

/* ── settlement provenance ────────────────────────────────────────────────── */

w('## Settlements, by why they exist');
w();
if (totalLabeled) {
  w('A settlement count means nothing without knowing what produced it. Every payment this');
  w('repo generates is labeled at the moment it settles:');
  w();
  w('| Label | Count | What produced it |');
  w('|---|---|---|');
  const WHAT = {
    setup: '`scripts/setup-testnet.mjs` — account creation, trustlines, SAC deploy',
    demo: '`npm run demo` — the narrated discover → pay → unlock loop',
    conformance: '`npm run verify:conformance` — an unmodified `@x402/fetch` client',
    'scripted-load': '`node scripts/evidence-batch.mjs` — this repo paying its own seller, serially',
    'nightly-ci': 'the nightly workflow, against the hosted stack, with a buyer created in-run',
  };
  for (const [label, count] of Object.entries(labelCounts).sort((a, b) => b[1] - a[1])) {
    w(`| \`${label}\` | ${count} | ${WHAT[label] ?? 'see docs/status/provenance.json'} |`);
  }
  w(`| **total labeled** | **${totalLabeled}** | |`);
  w();
  w('An unlabeled hash renders as *unlabeled*, never as *organic*. The full map is');
  w('[`docs/status/provenance.json`](./status/provenance.json); every hash with an explorer');
  w('link is in [TESTNET-TXS.md](./TESTNET-TXS.md).');
} else {
  w('_No provenance recorded yet. Run `npm run verify:conformance -- --emit` to start the map._');
}
w();

/* ── scheme x asset ───────────────────────────────────────────────────────── */

w('## Coverage: scheme × asset × network');
w();
w('| Scheme | Asset | Network | Status |');
w('|---|---|---|---|');
const asset = conformance?.asset ? `SXT (SAC \`${conformance.asset}\`)` : 'SXT';
w(`| \`exact\` | ${asset} | \`stellar:testnet\` | settled, hashes published |`);
w(`| \`exact\` | USDC (Circle) | \`stellar:testnet\` | ${upstreamE2e?.summary ? `settled — ${upstreamE2e.summary.passed} payments through the upstream e2e suite, hashes below` : 'supported by the same code path (any SEP-41); not yet exercised here'} |`);
w('| `exact` | USDC | `stellar:pubnet` | Tranche 3 |');
w('| `upto` | — | — | Tranche 2. Ships a dedicated Soroban settlement contract (`settle_upto` via `require_auth_for_args`): no admin, no persistent storage, never holds a balance. See [upto-position.md](./upto-position.md). |');
w();

/* ── acceptance criteria ──────────────────────────────────────────────────── */

if (conformance?.criteria?.length) {
  w('## Acceptance criteria, as observed');
  w();
  w(`Written by \`npm run verify:conformance -- --emit\` on ${conformance.generatedAt?.slice(0, 19).replace('T', ' ')} UTC`);
  w(`(commit \`${conformance.commit ?? 'unknown'}\`), driving an **unmodified \`@x402/fetch\` client** —`);
  w('no STELLARSIGHT code on the payment path.');
  w();
  w('| Criterion | Expected | Observed |');
  w('|---|---|---|');
  for (const c of conformance.criteria) {
    w(`| ${c.pass ? '✓' : '✗'} ${c.name} | ${c.expected} | \`${c.observed}\` |`);
  }
  w();
  if (conformance.txHash) {
    w(`Settled: [\`${conformance.txHash}\`](${conformance.explorerUrl}) · ${conformance.amountDisplay ?? ''} · ${conformance.elapsedMs}ms end to end.`);
    w();
  }
  w('Artifact: [`docs/status/conformance.json`](./status/conformance.json)');
  w();
}

/* ── the upstream e2e suite ───────────────────────────────────────────────── */

if (upstreamE2e?.summary) {
  const s = upstreamE2e.summary;
  w('## The x402 repository\'s own e2e suite');
  w();
  w('The RFP names this as a hard acceptance criterion: *"a passing run of the x402 repo\'s');
  w('e2e suite for both networks"*. This is the `stellar:testnet` half — `stellar:pubnet` is');
  w('Tranche 3 work, so the other half is scheduled rather than skipped.');
  w();
  w(`\`${s.passed}/${s.total}\` scenarios passed against **${upstreamE2e.target}**, on suite commit`);
  w(`[\`${String(upstreamE2e.suite?.commit ?? '').slice(0, 12)}\`](https://github.com/x402-foundation/x402/commit/${upstreamE2e.suite?.commit}).`);
  w();
  w('Every payment settled in **Circle testnet USDC** — not by choice but by construction:');
  w('the suite\'s Stellar route resolves its asset through `@x402/stellar`\'s');
  w('`defaultMoneyConversion` and offers no override, so a Stellar run *is* a USDC run. That');
  w('also answers, on chain, the "any SEP-41 token, USDC by default" line in RFP 3.1 that this');
  w('project had until now only claimed.');
  w();
  w('| Client | Server | Result | Settled |');
  w('|---|---|---|---|');
  for (const sc of upstreamE2e.scenarios ?? []) {
    const tx = sc.txHash ? `[\`${sc.txHash.slice(0, 10)}…\`](${sc.explorerUrl})` : '—';
    w(`| \`${sc.client}\` | \`${sc.server}\` | ${sc.passed ? '✓' : '✗'} | ${tx} |`);
  }
  w();
  if (upstreamE2e.limits?.length) {
    w('**What this run does not cover**, stated here rather than left for a reader to find:');
    w();
    for (const l of upstreamE2e.limits) w(`- ${l}`);
    w();
  }
  if (upstreamE2e.workarounds?.length) {
    w('**Upstream defects worked around:**');
    w();
    for (const x of upstreamE2e.workarounds) w(`- ${x}`);
    w();
  }
  w('Artifact: [`docs/status/upstream-e2e.json`](./status/upstream-e2e.json) · relay source: [`e2e-proxy/`](../e2e-proxy)');
  w();
}

/* ── rejection audit ──────────────────────────────────────────────────────── */

if (rejections?.cases?.length) {
  w('## Rejection audit');
  w();
  w('The negative-path counterpart: every documented error path, driven for real, with the');
  w('code and reason the caller actually received. A rejection that arrives without a');
  w('non-empty reason fails this run even when its status code is right.');
  w();
  w(`\`node scripts/verify-rejections.mjs\` · ${rejections.passed}/${rejections.applicable} applicable path(s) behaved as documented`);
  w();
  w('| Path | Expected | Observed | Reason returned |');
  w('|---|---|---|---|');
  for (const c of rejections.cases) {
    if (c.skipped) {
      w(`| \`${c.id}\` | ${c.expected} | _n/a on this surface_ | ${c.why} |`);
      continue;
    }
    const reason = c.reason ? `\`${String(c.reason).slice(0, 90).replace(/\|/g, '\\|')}\`` : '—';
    w(`| ${c.pass ? '✓' : '✗'} \`${c.id}\` | ${c.expected} | ${c.observed} | ${reason} |`);
  }
  w();
  w('Artifact: [`docs/status/rejections.json`](./status/rejections.json)');
  w();
}

/* ── scripted batches ─────────────────────────────────────────────────────── */

if (batches.length) {
  w('## Scripted batches');
  w();
  w('Breadth of settlement, run serially and labeled as scripted. Not a load test —');
  w('[LOAD-BASELINE.md](./LOAD-BASELINE.md) already publishes what this stack does under');
  w('concurrency, and it is the least flattering number in the repo.');
  w();
  w('| Run | Settled | Routes | p50 | p95 |');
  w('|---|---|---|---|---|');
  for (const b of batches.sort((a, b2) => String(a.generatedAt).localeCompare(String(b2.generatedAt)))) {
    const routes = Object.entries(b.perRoute ?? {})
      .map(([r, s]) => `${r} ${s.settled}/${s.attempted}`)
      // `<br />`, not `<br>`: docs/EVIDENCE.md is projected into MDX for the documentation
      // site, and MDX requires void elements to be self-closed. A bare `<br>` is parsed as an
      // unclosed JSX element and takes the whole page down — it 404'd
      // docs.stellarsight.xyz/evidence/verify-it-yourself while every sibling page served.
      // GitHub renders the self-closed form identically, so nothing is lost here.
      .join('<br />');
    w(
      `| ${String(b.generatedAt).slice(0, 16).replace('T', ' ')} | ${b.succeeded}/${b.total} | ${routes} | ${Math.round(b.latenciesMs?.p50 ?? 0)}ms | ${Math.round(b.latenciesMs?.p95 ?? 0)}ms |`,
    );
  }
  w();
}

/* ── nightly ──────────────────────────────────────────────────────────────── */

if (nightly?.runs?.length) {
  w('## Nightly settled payment');
  w();
  w('One real payment a night against the **hosted** stack, with the buyer created inside');
  w('the run (Friendbot → trustline → faucet), so the evidence grows without anyone');
  w('remembering to generate it, and every hash is reproducible from a clean clone.');
  w();
  w('| Date | Settled | Elapsed | Run |');
  w('|---|---|---|---|');
  for (const r of nightly.runs.slice(-14).reverse()) {
    w(`| ${r.date} | ${r.txHash ? `[\`${String(r.txHash).slice(0, 12)}…\`](https://stellar.expert/explorer/testnet/tx/${r.txHash})` : '—'} | ${r.elapsedMs ?? '—'}ms | ${r.runUrl ? `[log](${r.runUrl})` : '—'} |`);
  }
  w();
}

/* ── soroban footprint ────────────────────────────────────────────────────── */

if (footprint?.used && footprint?.limits) {
  w('## What a settlement costs the Soroban host');
  w();
  w('Read back off the ledger from the transaction named below, and compared against the');
  w("network's live `ConfigSetting` entries — both sides fetched, neither typed. Regenerate");
  w('with `npm run evidence:footprint -- --emit`; the nightly re-measures the payment it has');
  w('just settled.');
  w();
  w('| Resource | Used | Per-transaction limit | Utilization |');
  w('|---|---|---|---|');
  const rows = [
    ['Instructions', 'instructions', 'txMaxInstructions'],
    ['Disk read bytes', 'diskReadBytes', 'txMaxDiskReadBytes'],
    ['Write bytes', 'writeBytes', 'txMaxWriteBytes'],
    ['Read ledger entries', 'diskReadEntries', 'txMaxDiskReadEntries'],
    ['Write ledger entries', 'writeLedgerEntries', 'txMaxWriteLedgerEntries'],
  ];
  const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : '—');
  for (const [label, usedKey, limitKey] of rows) {
    const pct = footprint.utilizationPercent?.[usedKey];
    w(`| ${label} | ${n(footprint.used[usedKey])} | ${n(footprint.limits[limitKey])} | ${pct === undefined || pct === null ? '—' : `${pct}%`} |`);
  }
  w(`| Memory | not observable | ${n(footprint.limits.txMemoryLimitBytes)} | — |`);
  w();
  w(
    `Worst utilization **${footprint.worstUtilizationPercent}%** — about ${footprint.headroomFactor}× headroom ` +
      `against the tightest per-transaction limit. Measured on ` +
      `[\`${String(footprint.txHash).slice(0, 12)}…\`](https://stellar.expert/explorer/testnet/tx/${footprint.txHash})` +
      `${footprint.ledger ? ` in ledger ${footprint.ledger.toLocaleString('en-US')}` : ''}.`,
  );
  w();
  w(`Memory is the one row without a measurement: ${footprint.memoryNote}`);
  w();
}

/* ── fee-payer runway ─────────────────────────────────────────────────────── */

if (feepayer?.balanceXlm) {
  w('## Fee-payer runway');
  w();
  w('THREAT-MODEL.md T6: this deployment sponsors every buyer\'s network fee from one');
  w('account, so a drained fee-payer stops every settlement at once. Read straight off');
  w('Horizon — balance, and burn from every transaction on the account over the trailing');
  w('window, successful or not, since a fee is charged either way. Regenerate with');
  w('`npm run monitor:feepayer -- --emit`; a scheduled workflow pages on a breach.');
  w();
  w('| Signal | Value | Threshold | Status |');
  w('|---|---|---|---|');
  const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : '—');
  w(`| Balance | ${feepayer.balanceXlm} XLM | — | — |`);
  w(
    `| Runway | ${feepayer.runway?.days === null ? 'unbounded' : `${feepayer.runway?.days?.toFixed(2)} days`} | ` +
      `< ${n(feepayer.runway?.thresholdDays)} days | ${feepayer.runway?.breach ? '🔴 breach' : '✅ ok'} |`,
  );
  w(
    `| Last-hour burn vs 24h median | ${n(feepayer.burnRate?.lastHourBurnStroops)} vs ${n(feepayer.burnRate?.median24hStroops)} stroops | ` +
      `> ${n(feepayer.burnRate?.multiplier)}× median${
        Number.isFinite(feepayer.burnRate?.floorStroops) ? ` and > ${n(feepayer.burnRate.floorStroops)} stroops floor` : ''
      } | ${feepayer.burnRate?.breach ? '🔴 breach' : '✅ ok'} |`,
  );
  if (feepayer.perTxFee) {
    w(
      `| Last conformance fee | ${n(feepayer.perTxFee.stroops)} stroops | > ${n(feepayer.perTxFee.ceilingHalfStroops)} stroops | ` +
        `${feepayer.perTxFee.breach ? '🔴 breach' : '✅ ok'} |`,
    );
  }
  w();
  w(`Artifact: [\`docs/status/feepayer.json\`](./status/feepayer.json)`);
  w();
}

/* ── discovery latency ────────────────────────────────────────────────────── */

if (latency?.probes?.length) {
  w('## How fast discovery answers');
  w();
  w('Wall-clock from the measuring machine over the public internet to a parsed JSON body —');
  w('network round-trip and CDN included, because that is what a caller experiences. A');
  w('server-side timer would look better and mean less. Regenerate with');
  w('`npm run latency:discovery -- --emit`.');
  w();
  w('| Probe | Uncached p50 / p95 / p99 | Cached p50 / p95 / p99 |');
  w('|---|---|---|');
  for (const p of latency.probes) {
    const f = (s2) => `${s2.p50} / ${s2.p95} / ${s2.p99} ms`;
    w(`| \`${p.label}\` | ${f(p.uncached)} | ${f(p.cached)} |`);
  }
  w();
  w(
    `Worst uncached p95 is **${latency.worstUncachedP95Ms} ms** across ${latency.samplesPerProbe} samples per probe, ` +
      `${latency.failures} failed request(s). **Uncached and cached are never averaged together.** ` +
      'Uncached forces a CDN miss with a unique parameter per request so the function actually ' +
      'runs — that is the honest number. Cached repeats one URL, which is what a caller polling ' +
      'a hot query sees; it is reported because it is true and labelled because quoting it alone ' +
      'would be the flattering half of the measurement.',
  );
  w();
}

/* ── interoperability ─────────────────────────────────────────────────────── */

if (interop?.targets?.length) {
  const reachable = interop.targets.filter((t) => t.reachable);
  w('## Interoperability: one client, two facilitators');
  w();
  w('The same unmodified `withBazaar()` client from `@x402/extensions`, pointed at this');
  w("deployment and at another facilitator, with every `accepts` entry validated by");
  w("`@x402/core`'s own `PaymentRequirementsSchema`. Regenerate with");
  w('`npm run verify:interop`.');
  w();
  w('| Facilitator | Role | Items | Array field | `accepts` validating |');
  w('|---|---|---|---|---|');
  for (const t of reachable) {
    w(`| [${t.name}](${t.url}) | ${t.role} | ${t.returnedCount} | \`${t.arrayField}\` | ${t.acceptsValid}/${t.acceptsChecked} |`);
  }
  w();
  const fmt = (list) => (list?.length ? list.map((f) => `\`${f}\``).join(', ') : '—');
  const ref = interop.targets[0];
  const del = interop.targets[1];
  w('| Fields | On both | Only ' + ref.name + ' | Only ' + del.name + ' |');
  w('|---|---|---|---|');
  w(`| Listing | ${fmt(interop.itemFieldDiff?.shared)} | ${fmt(interop.itemFieldDiff?.onlyReference)} | ${fmt(interop.itemFieldDiff?.onlyDeliverable)} |`);
  w(`| \`accepts[]\` | ${fmt(interop.acceptsFieldDiff?.shared)} | ${fmt(interop.acceptsFieldDiff?.onlyReference)} | ${fmt(interop.acceptsFieldDiff?.onlyDeliverable)} |`);
  w();
  w(
    `**One client parses both: ${interop.verdict?.oneClientParsesBoth ? 'yes' : 'no'}. ` +
      `Every \`accepts\` entry validates on both sides: ${interop.verdict?.everyAcceptsEntryValidatesOnBothSides ? 'yes' : 'no'}.** ` +
      'The two catalogs are not expected to agree — one indexes EVM resources and the other ' +
      'Stellar ones — so what is measured is whether a single consumer can read both and ' +
      'construct a payment from either.',
  );
  w();
  if (interop.notServingDiscovery?.length) {
    w('Facilitators checked that do **not** serve the Bazaar discovery endpoint today:');
    w();
    for (const n of interop.notServingDiscovery) w(`- **${n.name}** (${n.url}) — ${n.observed}`);
    w();
  }
}

/* ── dependency licences ──────────────────────────────────────────────────── */

if (licenses?.summary) {
  const s2 = licenses.summary;
  w('## Dependency licences');
  w();
  w(`\`npm run audit:licenses\` enumerates the production dependency tree — ${s2.total} packages,`);
  w('workspaces included, dev dependencies excluded because they are not redistributed — and');
  w('reads each declared licence out of the installed `package.json`. CI runs it with');
  w('`--strict`, so an unknown licence fails the build alongside a copyleft one.');
  w();
  w('| Licence | Packages |');
  w('|---|---|');
  for (const [license, count] of Object.entries(licenses.byLicense ?? {})) {
    w(`| \`${license}\` | ${count} |`);
  }
  w();
  w(
    `**${s2.strongCopyleft} strong copyleft, ${s2.weakCopyleft} weak copyleft, ${s2.unknown} unknown** ` +
      `across ${s2.total} packages. That is the check behind the architectural claim that this ` +
      'facilitator is self-hosted on `@x402/stellar` rather than built on the AGPL-3.0 ' +
      'OpenZeppelin Relayer — the licence argument is now a property of the installed tree, ' +
      'not a statement of intent.',
  );
  w();
}

/* ── run it yourself ──────────────────────────────────────────────────────── */

w('## Run it yourself');
w();
w('Against the hosted deployment, with nothing installed:');
w();
w('```bash');
w(`# the 402 challenge, in the header the spec puts it in`);
w(`curl -i ${SITE}/v1/fx/usd-brl`);
w();
w(`# what this facilitator supports, including the Stellar extra`);
w(`curl -s ${SITE}/supported`);
w();
w(`# the Bazaar: natural-language search over the live catalog`);
w(`curl -s "${SITE}/discovery/search?query=invoice%20ocr&limit=3"`);
w();
w(`# filters are applied, not accepted-and-ignored (compare the totals)`);
w(`curl -s "${SITE}/discovery/resources?limit=100" | grep -o '"total":[0-9]*'`);
w(`curl -s "${SITE}/discovery/resources?network=bogus:none&limit=100" | grep -o '"total":[0-9]*'`);
w();
w(`# the catalog-integrity ledger, labeled as a replay rather than observed traffic`);
w(`curl -s "${SITE}/discovery/integrity?limit=5"`);
w();
w(`# a refusal, with its machine code and a non-empty reason`);
w(`curl -s -X POST ${SITE}/playground/fund -H 'content-type: application/json' -d '{"account":"GBAD"}'`);
w('```');
w();
w('From a clean clone, ending in a real settled payment:');
w();
w('```bash');
w('git clone https://github.com/pedro-pelicioni/stellarsight && cd stellarsight');
w('npm install && npm run setup      # creates and funds the testnet accounts');
w('npm run dev:all                   # facilitator :4021, index :4022, seller :4023');
w('npm run verify:conformance        # unmodified @x402/fetch client → settled hash');
w('node scripts/verify-rejections.mjs  # every error path, expected vs observed');
w('```');
w();

if (feePayer) {
  w(`Then open any hash it prints on stellar.expert: the fee account is [\`${feePayer.slice(0, 8)}…\`](https://stellar.expert/explorer/testnet/account/${feePayer}), the FEEPAYER — not the payer.`);
  w();
}

writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');
console.log(`[build-evidence] wrote docs/EVIDENCE.md from ${statusFiles.length} artifact(s)`);
if (!statusFiles.length) {
  console.log('[build-evidence] note: docs/status/ is empty — run verify:conformance --emit and verify-rejections --emit first');
}
