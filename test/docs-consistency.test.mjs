/**
 * test/docs-consistency.test.mjs — counts stated in prose must match what they count.
 *
 * This repo has already been bitten by exactly this: `scripts/build-evidence.mjs` carries a
 * comment recording that the README claimed its payment numbers "cannot drift again" while
 * the script that generated them only ever wrote `docs/`, and within two days the README
 * was three payments behind. Payment counts are generated now. Counts that are still typed
 * by hand are not, and they drift the same way — silently, in the direction of overstating.
 *
 * So: derive the count from the artifact, and assert every place that repeats it agrees.
 * A new threat, or a rejection case added to the audit, fails here until the prose catches
 * up. That is the whole point — the failure is cheap and the drift is not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty',
];
const inWords = (n) => WORDS[n] ?? String(n);

test('the threat count in prose matches the rows in THREAT-MODEL.md', () => {
  const threatModel = read('docs/THREAT-MODEL.md');

  // Rows are `| T<n> | ...`; the header row and the separator do not match.
  const ids = [...threatModel.matchAll(/^\|\s*T(\d+)\s*\|/gm)].map((m) => Number(m[1]));
  assert.ok(ids.length > 0, 'no threat rows found — has the table shape changed?');

  // Numbering must be dense and start at 1, or "N threats" is not what the table shows.
  assert.deepEqual(
    ids,
    Array.from({ length: ids.length }, (_, i) => i + 1),
    `threat ids are not 1..${ids.length} in order: ${ids.join(', ')}`,
  );

  const n = ids.length;
  const word = inWords(n);

  // Every surface that repeats the count. Two are hand-authored (README, the docs-site
  // landing page), one is prose inside a synced file, one is the description the sync
  // script stamps into the page's frontmatter.
  const claims = [
    ['README.md', `assets, trust boundaries, and ${word}`],
    ['docs/ARCHITECTURE.md', `[THREAT-MODEL.md](THREAT-MODEL.md) — ${word} threats`],
    ['scripts/sync-docs-site.mjs', `"${word[0].toUpperCase()}${word.slice(1)} threats, each mapped`],
    ['docs-site/index.mdx', `[Threat model](/security/threat-model) — ${n} threats`],
  ];

  for (const [file, expected] of claims) {
    assert.ok(
      read(file).includes(expected),
      `${file} does not state ${n} threats — expected to find: ${expected}`,
    );
  }
});

test('every stated conformance-check count matches the checks that exist', () => {
  // The count published everywhere is what `npm run verify:api` prints, and that is one
  // `check(...)` call site per check. Counting the call sites derives it without booting
  // the handlers, which is what makes this cheap enough to run in the unit suite.
  const harness = read('scripts/verify-serverless.mjs');
  const n = [...harness.matchAll(/^\s*(?:await\s+)?check\(/gm)].length;
  assert.ok(
    n > 0,
    'no check() call sites found in scripts/verify-serverless.mjs — the harness shape changed, ' +
      'and this test can no longer derive the count it guards',
  );

  // Every surface that repeats the number, in prose or in a workflow comment. Anything of
  // the form "<number> [word] check(s)" in these files is claiming this count.
  const files = [
    'README.md',
    'docs-site/index.mdx',
    'docs-site/quickstart.mdx',
    'docs/ARCHITECTURE.md',
    'docs/MONITORING.md',
    'docs/THREAT-MODEL.md',
    '.github/workflows/nightly-evidence.yml',
  ];

  const wrong = [];
  let found = 0;
  for (const file of files) {
    for (const m of read(file).matchAll(/(\d+)(?:\s+[A-Za-z-]+)?\s+checks?\b/g)) {
      found += 1;
      if (Number(m[1]) !== n) wrong.push(`${file}: "${m[0].replace(/\n/g, ' ')}"`);
    }
  }

  assert.ok(found > 0, 'no conformance-check counts found in the docs — did the wording change?');
  assert.deepEqual(
    wrong,
    [],
    `verify:api runs ${n} checks, but these say otherwise:\n  ${wrong.join('\n  ')}`,
  );
});

test('every stated test count matches the tests that exist', () => {
  // Mirrors scripts/run-tests.mjs discovery: same skip list, same filename pattern. The
  // count is of `test(...)` declarations, which for this suite equals what the runner
  // reports — asserted below against the two sub-counts the docs also publish, so a
  // table-driven suite that stopped matching would show up here rather than silently.
  const SKIP = new Set([
    'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.vite', '.turbo', '.cache', 'out',
  ]);
  const TEST_FILE = /\.(test|spec)\.(mjs|cjs|js)$/;

  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) out.push(...walk(full));
      } else if (TEST_FILE.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  };

  const declarations = (file) =>
    [...readFileSync(file, 'utf8').matchAll(/^\s*(?:await\s+)?(?:test|it)\s*\(/gm)].length;

  const files = walk(ROOT);
  const total = files.reduce((n, f) => n + declarations(f), 0);
  assert.ok(total > 0, 'no test declarations discovered — has the runner’s layout changed?');

  const claims = [
    ['README.md', /(\d+)\s+tests\b/g],
    ['docs-site/index.mdx', /(\d+)\s+tests\b/g],
    ['docs-site/quickstart.mdx', /(\d+)\s+tests\b/g],
    ['docs/ARCHITECTURE.md', /(\d+)\s+tests\b/g],
  ];

  const wrong = [];
  for (const [file, re] of claims) {
    for (const m of read(file).matchAll(re)) {
      if (Number(m[1]) !== total) wrong.push(`${file}: "${m[0]}"`);
    }
  }
  assert.deepEqual(wrong, [], `the suite declares ${total} tests, but these say otherwise:\n  ${wrong.join('\n  ')}`);

  // The two sub-counts the README breaks out. They are the reason a reader trusts the
  // total: "66 of them adversarial" is a claim about which file, not just how many.
  const bySuffix = (suffix) =>
    declarations(files.find((f) => f.endsWith(suffix)) ?? '');

  const adversarial = bySuffix('catalog-integrity.test.mjs');
  const middleware = bySuffix('express-middleware.test.mjs');

  // Claimed in more than one place, and the first version of this guard only checked the
  // README — so two mentions went stale in ARCHITECTURE and THREAT-MODEL without failing
  // anything. Scan every file that states it.
  const adversarialWrong = [];
  for (const file of ['README.md', 'docs-site/quickstart.mdx', 'docs/ARCHITECTURE.md', 'docs/THREAT-MODEL.md']) {
    for (const m of read(file).matchAll(/(\d+)\s+(?:of them\s+|of the repository's tests[^.]*?)?adversarial/g)) {
      if (Number(m[1]) !== adversarial) adversarialWrong.push(`${file}: "${m[0]}"`);
    }
    for (const m of read(file).matchAll(/(\d+)\s+adversarial\s+(?:cases|tests)/g)) {
      if (Number(m[1]) !== adversarial) adversarialWrong.push(`${file}: "${m[0]}"`);
    }
  }
  assert.deepEqual(
    adversarialWrong,
    [],
    `catalog-integrity.test.mjs declares ${adversarial} tests, but these say otherwise:\n  ${adversarialWrong.join('\n  ')}`,
  );
  assert.ok(
    read('README.md').includes(`${middleware} of the ${total} tests are its`),
    `README.md does not state ${middleware} of the ${total} tests as packages/express`,
  );
});
