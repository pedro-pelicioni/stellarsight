/**
 * scripts/lib/counts.mjs — the counts this project publishes about itself, derived once.
 *
 * A hand-typed count is true when written and nobody re-checks it. So every published count
 * is derived here, in one place, and both the artifact writer and the consistency test read
 * from this module: a counting rule that lived in two files would drift the same way.
 *
 * Static derivation is deliberate: running the suite to count the suite is circular, and
 * `verify:api` needs a network. Counting declarations is cheap enough that the test can do it
 * on every run, which is what makes it a guard rather than a snapshot.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Mirrors scripts/run-tests.mjs discovery: same skip list, same filename pattern. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.vite', '.turbo', '.cache', 'out',
]);
const TEST_FILE = /\.(test|spec)\.(mjs|cjs|js)$/;

const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');

function testFiles(dir = ROOT) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...testFiles(full));
    } else if (TEST_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const declarations = (source) =>
  [...source.matchAll(/^\s*(?:await\s+)?(?:test|it)\s*\(/gm)].length;

const checkCallSites = (lines) =>
  lines.filter((line) => /^\s*(?:await\s+)?check\(/.test(line)).length;

/**
 * deriveCounts() -> { tests, adversarial, apiChecks, stockClientChecks }
 *
 * `stockClientChecks` is the tail of `apiChecks`: the checks declared after the section header
 * that announces the unmodified `@x402/extensions` client. Keying on that header rather than on
 * a hand-kept list means adding a check to that section counts it automatically.
 */
export function deriveCounts() {
  const files = testFiles();
  const tests = files.reduce((n, f) => n + declarations(readFileSync(f, 'utf8')), 0);

  const adversarialFile = files.find((f) => f.endsWith('catalog-integrity.test.mjs'));
  const adversarial = adversarialFile ? declarations(readFileSync(adversarialFile, 'utf8')) : 0;

  const harness = read('scripts/verify-serverless.mjs').split('\n');
  const apiChecks = checkCallSites(harness);
  const stockHeader = harness.findIndex((l) => /stock @x402\/extensions withBazaar\(\) client/.test(l));
  const stockClientChecks = stockHeader >= 0 ? checkCallSites(harness.slice(stockHeader)) : 0;

  return { tests, adversarial, apiChecks, stockClientChecks };
}
