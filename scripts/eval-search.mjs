#!/usr/bin/env node
/**
 * scripts/eval-search.mjs — measured search quality, with a regression gate.
 *
 * The RFP names search quality as the hardest part of the discovery scope, and
 * docs/SEARCH-QUALITY.md has always described the evaluation plan. A plan is not a
 * number. This runs it: a human-graded golden set against the real ranker, producing
 * nDCG@10, Recall@20 and MRR@10 that can be quoted, reproduced from a clean clone, and
 * regressed against on every push.
 *
 * WHAT IS AND IS NOT CLAIMED
 *
 *   - The corpus is the seeded demo catalog (packages/index/src/seed.mjs), 27 records.
 *     Every result below is a KNOWN-ITEM measurement over that corpus and is labelled as
 *     such. It is not a claim about a live catalog with thousands of listings, and a
 *     bigger corpus will move these numbers.
 *   - The judgments in eval/golden.jsonl were written by hand by the maintainer, who also
 *     wrote the ranker. That is a real bias and it is stated rather than hidden; the
 *     Tranche 1 deliverable expands the set to 150-200 queries with a rolling sample from
 *     the live catalog, which is where the bias gets diluted by data nobody authored.
 *   - Queries graded `no-match` carry no relevant document on purpose. They are excluded
 *     from the ranking averages (nDCG is undefined without a relevant document) and
 *     reported separately as `noMatchSilence` — how often the ranker correctly says
 *     nothing rather than dressing up its best bad guess.
 *
 * METRIC DEFINITIONS (stated so the numbers are checkable, not just printed)
 *
 *   gain(rel)   = 2^rel - 1            exponential gain, rel in {0,1,2,3}
 *   DCG@k       = sum_i gain(rel_i) / log2(i + 1),  i = 1..k
 *   nDCG@k      = DCG@k / IDCG@k       IDCG from the ideal ordering of the judged set
 *   Recall@k    = |retrieved in top k with rel >= 2| / |judged with rel >= 2|
 *   RR@k        = 1 / rank of the first result with rel >= 2, else 0;  MRR = mean(RR)
 *
 * Grade 1 means "marginally related" and deliberately counts for nDCG but NOT for the
 * binary metrics: a marginal hit is worth something in a ranked list and worth nothing as
 * an answer.
 *
 * USAGE
 *   node scripts/eval-search.mjs              # measure, compare to baseline, gate
 *   node scripts/eval-search.mjs --update     # accept current numbers as the baseline
 *   node scripts/eval-search.mjs --report     # also write docs/SEARCH-EVAL.md
 *   node scripts/eval-search.mjs --quiet      # totals only
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalog } from '../packages/index/src/index.mjs';
import { seedCatalog } from '../packages/index/src/seed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_PATH = join(ROOT, 'eval', 'golden.jsonl');
const BASELINE_PATH = join(ROOT, 'eval', 'baseline.json');
const REPORT_PATH = join(ROOT, 'docs', 'SEARCH-EVAL.md');

/** Cut-offs. k=10 for the ranked metrics, k=20 for recall — the spec's page sizes. */
const NDCG_K = 10;
const RECALL_K = 20;
const MRR_K = 10;
/** A result counts as "an answer" for the binary metrics at this grade or above. */
const RELEVANT_AT = 2;
/**
 * How far a metric may fall below the baseline before the run fails. Absolute, not
 * relative: 0.02 on nDCG@10 is a real regression at this corpus size and 0.001 is noise
 * from a tie-break.
 */
const TOLERANCE = 0.02;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

/* ─────────────────────────────── metrics ─────────────────────────────── */

const gain = (rel) => (rel > 0 ? 2 ** rel - 1 : 0);
const discount = (rank) => Math.log2(rank + 1); // rank is 1-based

export function ndcgAt(rankedIds, relevance, k) {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, rankedIds.length); i++) {
    dcg += gain(relevance[rankedIds[i]] ?? 0) / discount(i + 1);
  }
  const ideal = Object.values(relevance).sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(k, ideal.length); i++) idcg += gain(ideal[i]) / discount(i + 1);
  return idcg === 0 ? null : dcg / idcg;
}

export function recallAt(rankedIds, relevance, k, threshold = RELEVANT_AT) {
  const wanted = Object.entries(relevance).filter(([, g]) => g >= threshold).map(([id]) => id);
  if (wanted.length === 0) return null;
  const top = new Set(rankedIds.slice(0, k));
  return wanted.filter((id) => top.has(id)).length / wanted.length;
}

export function reciprocalRankAt(rankedIds, relevance, k, threshold = RELEVANT_AT) {
  const limit = Math.min(k, rankedIds.length);
  for (let i = 0; i < limit; i++) {
    if ((relevance[rankedIds[i]] ?? 0) >= threshold) return 1 / (i + 1);
  }
  return 0;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r4 = (n) => Math.round(n * 10_000) / 10_000;

/* ─────────────────────────────── the run ─────────────────────────────── */

export function loadGolden(path = GOLDEN_PATH) {
  const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`eval/golden.jsonl line ${i + 1} is not valid JSON: ${err.message}`);
    }
  });
}

/**
 * Run every query through the real `catalog.search`, i.e. the same code path
 * /discovery/search serves. No shortcut around the ranker, no fixture of results.
 */
export function runEval({ golden = loadGolden(), catalog } = {}) {
  const cat = catalog ?? (() => {
    const c = createCatalog();
    seedCatalog(c);
    return c;
  })();

  const perQuery = [];
  for (const q of golden) {
    const relevance = q.relevant ?? {};
    const judged = Object.keys(relevance).length > 0;

    const result = cat.search({ query: q.query, limit: RECALL_K });
    const rankedIds = (result.items ?? []).map((r) => r.id);

    // A judged id that is not in the corpus is a broken golden set, not a bad ranker.
    for (const id of Object.keys(relevance)) {
      if (!cat.get?.(id)) throw new Error(`golden query ${q.id} judges "${id}", which is not in the catalog`);
    }

    perQuery.push({
      id: q.id,
      query: q.query,
      intent: q.intent ?? 'task',
      judged,
      returned: rankedIds.length,
      topId: rankedIds[0] ?? null,
      topGrade: rankedIds[0] ? (relevance[rankedIds[0]] ?? 0) : null,
      ndcg: judged ? ndcgAt(rankedIds, relevance, NDCG_K) : null,
      recall: judged ? recallAt(rankedIds, relevance, RECALL_K) : null,
      rr: judged ? reciprocalRankAt(rankedIds, relevance, MRR_K) : null,
    });
  }

  const judged = perQuery.filter((q) => q.judged);
  const noMatch = perQuery.filter((q) => !q.judged);

  return {
    corpus: { records: cat.size(), source: 'packages/index/src/seed.mjs', kind: 'known-item' },
    queries: { total: perQuery.length, judged: judged.length, noMatch: noMatch.length },
    metrics: {
      ndcgAt10: r4(mean(judged.map((q) => q.ndcg).filter((n) => n !== null))),
      recallAt20: r4(mean(judged.map((q) => q.recall).filter((n) => n !== null))),
      mrrAt10: r4(mean(judged.map((q) => q.rr).filter((n) => n !== null))),
      // How often a query with no right answer returns nothing at all.
      noMatchSilence: noMatch.length ? r4(noMatch.filter((q) => q.returned === 0).length / noMatch.length) : null,
      // How often the top hit is a genuine answer (grade >= RELEVANT_AT).
      precisionAt1: r4(judged.filter((q) => (q.topGrade ?? 0) >= RELEVANT_AT).length / judged.length),
    },
    perQuery,
  };
}

/* ─────────────────────────────── reporting ─────────────────────────────── */

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeReport(run) {
  const m = run.metrics;
  const worst = run.perQuery
    .filter((q) => q.judged && q.ndcg !== null)
    .sort((a, b) => a.ndcg - b.ndcg)
    .slice(0, 5);

  const md = `# Search evaluation — measured, not planned

Generated by \`npm run eval:search\`. Reproduce from a clean clone with
\`npm install && npm run eval:search\`.

| Metric | Value |
|---|---|
| nDCG@10 | **${m.ndcgAt10}** |
| Recall@20 | **${m.recallAt20}** |
| MRR@10 | **${m.mrrAt10}** |
| Precision@1 | ${m.precisionAt1} |
| No-match silence | ${m.noMatchSilence ?? 'n/a'} |

Corpus: ${run.corpus.records} records from \`${run.corpus.source}\`, **${run.corpus.kind}**.
Queries: ${run.queries.total} (${run.queries.judged} judged, ${run.queries.noMatch} no-match probes).

## What these numbers are not

The corpus is the seeded demo catalog and the judgments were written by the same person
who wrote the ranker. Both facts inflate confidence and neither is hidden: this is a
known-item measurement, the honest floor for "does the ranker work at all", and the
Tranche 1 deliverable replaces it with 150–200 queries plus a rolling sample drawn from
the live catalog, which nobody here authored.

\`no-match silence\` is the fraction of deliberately unanswerable queries
(\`quantum teleportation as a service\`) for which the ranker returns **nothing** rather
than its best bad guess. A low number here is a real weakness, published on purpose:
BM25 will happily match a stray token, and the cold-start section of
[SEARCH-QUALITY.md](SEARCH-QUALITY.md) names the mitigations that are not built yet.

## Weakest queries

| Query | Intent | nDCG@10 | Top hit |
|---|---|---|---|
${worst.map((q) => `| \`${q.query}\` | ${q.intent} | ${r4(q.ndcg)} | ${q.topId ? `\`${q.topId}\`` : '—'} |`).join('\n')}

## Method

- \`gain(rel) = 2^rel - 1\`, grades 0–3, judged in \`eval/golden.jsonl\`.
- nDCG@10 against the ideal ordering of the judged set; queries with no judged document
  are excluded (nDCG is undefined for them) and counted under no-match instead.
- Recall@20 and MRR@10 count a document as an answer at grade **>= 2**. Grade 1
  ("marginally related") therefore contributes to nDCG and not to the binary metrics.
- Every query runs through \`catalog.search\`, the same call \`/discovery/search\` serves.

## Regression gate

\`npm run eval:search\` compares against \`eval/baseline.json\` and exits non-zero if any
metric falls more than ${TOLERANCE} below it. CI runs it on every push, so a ranking change
that quietly costs relevance fails the build instead of shipping.
`;
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, md, 'utf8');
  return REPORT_PATH;
}

/* ─────────────────────────────────── CLI ─────────────────────────────────── */

function main() {
  const run = runEval();
  const m = run.metrics;
  const quiet = has('--quiet');

  if (!quiet) {
    console.log('\nSTELLARSIGHT search evaluation');
    console.log(`  corpus   ${run.corpus.records} records (${run.corpus.kind}, ${run.corpus.source})`);
    console.log(`  queries  ${run.queries.total} — ${run.queries.judged} judged, ${run.queries.noMatch} no-match probes\n`);
    console.log(`  nDCG@10        ${m.ndcgAt10}`);
    console.log(`  Recall@20      ${m.recallAt20}`);
    console.log(`  MRR@10         ${m.mrrAt10}`);
    console.log(`  Precision@1    ${m.precisionAt1}`);
    console.log(`  no-match sil.  ${m.noMatchSilence ?? 'n/a'}\n`);

    const worst = run.perQuery.filter((q) => q.judged && q.ndcg !== null).sort((a, b) => a.ndcg - b.ndcg).slice(0, 5);
    console.log('  weakest queries:');
    for (const q of worst) console.log(`    ${r4(q.ndcg).toFixed(4)}  "${q.query}"  ->  ${q.topId ?? '(nothing)'}`);
    console.log('');
  }

  if (has('--report')) {
    const p = writeReport(run);
    console.log(`  report written to ${p}`);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    corpus: run.corpus,
    queries: run.queries,
    metrics: m,
    method: {
      gain: '2^rel - 1',
      ndcgK: NDCG_K,
      recallK: RECALL_K,
      mrrK: MRR_K,
      relevantAtGrade: RELEVANT_AT,
      tolerance: TOLERANCE,
    },
  };

  if (has('--update')) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`  baseline updated -> ${BASELINE_PATH}\n`);
    return 0;
  }

  const baseline = readBaseline();
  if (!baseline) {
    console.log('  no baseline yet — run `npm run eval:search -- --update` to record one.\n');
    return 0;
  }

  const gated = ['ndcgAt10', 'recallAt20', 'mrrAt10', 'precisionAt1'];
  const regressions = [];
  for (const key of gated) {
    const before = baseline.metrics?.[key];
    const after = m[key];
    if (typeof before !== 'number' || typeof after !== 'number') continue;
    if (after < before - TOLERANCE) regressions.push({ key, before, after, delta: r4(after - before) });
  }

  if (regressions.length) {
    console.error('  REGRESSION — search quality fell below the recorded baseline:\n');
    for (const r of regressions) {
      console.error(`    ${r.key}: ${r.before} -> ${r.after}  (${r.delta > 0 ? '+' : ''}${r.delta}, tolerance ${TOLERANCE})`);
    }
    console.error('\n  Fix the ranking, or accept the new numbers deliberately with `--update`.\n');
    return 1;
  }

  if (!quiet) {
    console.log(`  no regression against baseline of ${baseline.generatedAt} (tolerance ${TOLERANCE}).\n`);
  }
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exit(main());
