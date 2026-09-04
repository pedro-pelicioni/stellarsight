#!/usr/bin/env node
/**
 * scripts/run-tests.mjs — the single entry point behind `npm test`.
 *
 * Why a runner instead of a bare `node --test <dir>`:
 *
 *   1. ZERO TESTS IS A FAILURE. A test command that runs nothing and exits 0 is
 *      worse than no test command at all — it reports green while proving
 *      nothing. If discovery finds no suites, this exits non-zero and says so.
 *
 *   2. A MISSING DIRECTORY IS NOT A FAILURE. Suites live in several places and
 *      arrive at different times (test/, packages/<pkg>/test/, app source dirs).
 *      Discovery walks whatever exists; a directory that does not exist yet
 *      simply contributes no files instead of blowing up the whole run.
 *
 *   3. TRUTHFUL COUNTS. The run emits a machine-readable TAP report to a temp
 *      file alongside the human-readable spec output, and the pass/fail/skip
 *      totals printed at the end are read back from it. If `node --test` were to
 *      exit 0 having executed nothing, the count check still fails the run.
 *
 *   4. HONEST EXIT CODE. Whatever `node --test` exits with is what `npm test`
 *      exits with (unless one of the checks above turns a 0 into a 1).
 *
 * Suites that reach a live service (e.g. the facilitator on :4021) are expected
 * to skip cleanly when it is down. Skipped is fine. Silently running nothing is
 * not — that is exactly what check 1 and 3 exist to catch.
 *
 * Usage:
 *   node scripts/run-tests.mjs                 # discover and run everything
 *   node scripts/run-tests.mjs <file|dir>...   # run only these paths
 *   node scripts/run-tests.mjs -- --test-name-pattern=foo   # extra node --test flags
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directories that never contain first-party suites. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.vite',
  '.turbo',
  '.cache',
  'out',
]);

/**
 * Extensions `node --test` can execute directly. TypeScript suites are
 * deliberately excluded: they need a loader this command does not install, so
 * picking them up here would turn "a suite exists" into "the run explodes".
 */
const TEST_FILE = /\.(test|spec)\.(mjs|cjs|js)$/;

/** Recursively collect runnable test files under `dir`. Missing dir -> []. */
function discoverIn(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // ENOENT/ENOTDIR: the directory does not exist yet (a suite still being
    // written, an unbuilt package). That is not this runner's failure.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }

  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...discoverIn(full));
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Resolve CLI targets (files or directories) into a sorted, deduped file list. */
function discover(targets) {
  const roots = targets.length > 0 ? targets : [ROOT];
  const found = new Set();

  for (const target of roots) {
    const abs = path.resolve(ROOT, target);
    let stats;
    try {
      stats = statSync(abs);
    } catch (err) {
      if (err.code === 'ENOENT') continue; // not yet written — skip, do not throw
      throw err;
    }
    if (stats.isDirectory()) {
      for (const file of discoverIn(abs)) found.add(file);
    } else if (TEST_FILE.test(abs)) {
      found.add(abs);
    }
  }

  return [...found].sort();
}

/**
 * Pull the run-wide totals out of the TAP report `node --test` wrote.
 *
 * TAP is used for the machine-readable copy rather than JUnit because its
 * summary block (`# tests N`, `# pass N`, ...) is a stable, documented part of
 * the format, whereas the JUnit reporter hides the same numbers in XML comments.
 * If the summary block is ever missing, fall back to counting result lines so a
 * real run is never mistaken for an empty one.
 */
function readCounts(reportPath) {
  let tap;
  try {
    tap = readFileSync(reportPath, 'utf8');
  } catch {
    return null; // reporter produced nothing — treated as "counts unknown"
  }
  if (tap.trim() === '') return null;

  // Only top-level `# key value` lines carry the run totals; nested subtest
  // diagnostics are indented, so anchoring to column 0 keeps them out.
  const total = (key) => {
    const m = tap.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };

  const tests = total('tests');
  if (tests !== null) {
    const failures = (total('fail') ?? 0) + (total('cancelled') ?? 0);
    const skipped = (total('skipped') ?? 0) + (total('todo') ?? 0);
    return { tests, failures, skipped, passed: total('pass') ?? tests - failures - skipped };
  }

  // Fallback: count TAP result lines directly.
  const ok = (tap.match(/^ok \d+/gm) ?? []).length;
  const notOk = (tap.match(/^not ok \d+/gm) ?? []).length;
  const skipped = (tap.match(/^ok \d+ .*# (SKIP|TODO)/gim) ?? []).length;
  if (ok + notOk === 0) return null;
  return { tests: ok + notOk, failures: notOk, skipped, passed: ok - skipped };
}

function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const passthrough = sep === -1 ? [] : argv.slice(sep + 1);
  const targets = sep === -1 ? argv : argv.slice(0, sep);

  const files = discover(targets);

  console.log(`\nSTELLARSIGHT test runner — discovered ${files.length} test file(s):`);
  for (const file of files) console.log(`  • ${path.relative(ROOT, file)}`);
  console.log('');

  // Check 1: a green run that executed nothing is a lie. Fail loudly.
  if (files.length === 0) {
    console.error('FAIL: no test files discovered. Refusing to report success on an empty run.');
    console.error(`       Searched under ${ROOT} for *.test.{mjs,cjs,js} / *.spec.{mjs,cjs,js}.`);
    process.exit(1);
  }

  const reportDir = mkdtempSync(path.join(tmpdir(), 'stellarsight-test-'));
  const reportPath = path.join(reportDir, 'results.tap');

  const args = [
    '--test',
    // Human-readable output for whoever is watching...
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    // ...and a machine-readable copy so the counts below are measured, not claimed.
    '--test-reporter=tap',
    `--test-reporter-destination=${reportPath}`,
    ...passthrough,
    ...files,
  ];

  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });

  child.on('error', (err) => {
    console.error(`FAIL: could not start node --test: ${err.message}`);
    rmSync(reportDir, { recursive: true, force: true });
    process.exit(1);
  });

  child.on('close', (code, signal) => {
    const counts = readCounts(reportPath);
    rmSync(reportDir, { recursive: true, force: true });

    // Check 4: the real exit code from node --test carries through.
    let exitCode = signal ? 1 : (code ?? 1);

    if (counts) {
      console.log(
        `\nSTELLARSIGHT totals across ${files.length} file(s): ` +
          `${counts.tests} test(s) — ${counts.passed} passed, ` +
          `${counts.failures} failed, ${counts.skipped} skipped.`,
      );
      // Check 3: zero executed tests can never be a pass, whatever node exited with.
      if (counts.tests === 0 && exitCode === 0) {
        console.error('FAIL: test files were discovered but zero tests executed. Reporting failure.');
        exitCode = 1;
      }
    } else if (exitCode === 0) {
      // No report to verify against — refuse to certify a pass we cannot measure.
      console.error('FAIL: no TAP report was produced, so the run could not be verified.');
      exitCode = 1;
    }

    console.log(exitCode === 0 ? 'STELLARSIGHT test run: PASS\n' : 'STELLARSIGHT test run: FAIL\n');
    process.exit(exitCode);
  });
}

main();
