#!/usr/bin/env node
/**
 * scripts/license-audit.mjs — confirm, rather than assert, that nothing in the production
 * dependency path is strong copyleft.
 *
 * This project's loudest architectural claim is that the facilitator is self-hosted on
 * `@x402/stellar` specifically so it does not depend on the AGPL-3.0 OpenZeppelin Relayer.
 * That argument appears in three documents. Until now it appeared nowhere as evidence: no
 * SBOM, no checker output, nothing a reviewer could run. An argument about licensing that
 * cannot be re-run is a claim about intent, not about the tree.
 *
 * So: enumerate the production tree with `npm ls --omit=dev --all`, resolve each package's
 * declared license out of the installed `package.json`, classify it, and fail if anything
 * strong-copyleft is in the path. Dev dependencies are deliberately out of scope — they are
 * not redistributed — and that scope is recorded in the artifact rather than left implicit.
 *
 * SPDX expressions are handled by their weakest term: `(MIT OR GPL-3.0)` is satisfiable as
 * MIT, so it is permissive. `(MIT AND GPL-3.0)` is not, so it is not.
 *
 * Usage:
 *   node scripts/license-audit.mjs            # report, fail on strong copyleft
 *   node scripts/license-audit.mjs --emit     # also write docs/status/licenses.json
 *   node scripts/license-audit.mjs --strict   # additionally fail on unknown or weak copyleft
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeEvidence } from './lib/evidence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);

/** Redistribution-safe. Everything here permits use in an Apache-2.0 work without terms. */
const PERMISSIVE = new Set([
  '0BSD', 'MIT', 'MIT-0', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD',
  'Unlicense', 'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'BlueOak-1.0.0', 'Python-2.0',
  'Zlib', 'WTFPL', 'Apache*',
]);

/** The category the RFP excludes by name. Any of these in the path is a build failure. */
const STRONG_COPYLEFT = [/^AGPL/i, /^SSPL/i, /^GPL-/i, /^GPL$/i, /^OSL/i, /^EUPL/i, /^CPAL/i];

/** File-level copyleft: not excluded by the RFP, but reported rather than waved through. */
const WEAK_COPYLEFT = [/^LGPL/i, /^MPL-/i, /^EPL-/i, /^CDDL/i, /^Artistic-/i];

const classifyTerm = (term) => {
  const t = term.replace(/[()]/g, '').trim();
  if (!t) return 'unknown';
  if (PERMISSIVE.has(t)) return 'permissive';
  if (STRONG_COPYLEFT.some((re) => re.test(t))) return 'strong-copyleft';
  if (WEAK_COPYLEFT.some((re) => re.test(t))) return 'weak-copyleft';
  return 'unknown';
};

/** An OR expression takes its most permissive branch; an AND takes its most restrictive. */
function classify(expression) {
  if (!expression || typeof expression !== 'string') return 'unknown';
  const rank = { permissive: 0, 'weak-copyleft': 1, unknown: 2, 'strong-copyleft': 3 };
  const unrank = Object.keys(rank);
  if (/\bOR\b/i.test(expression)) {
    const best = Math.min(...expression.split(/\bOR\b/i).map((t) => rank[classify(t)]));
    return unrank[best];
  }
  if (/\bAND\b/i.test(expression)) {
    const worst = Math.max(...expression.split(/\bAND\b/i).map((t) => rank[classify(t)]));
    return unrank[worst];
  }
  return classifyTerm(expression);
}

/** name@version -> license, built by scanning every installed package.json once. */
function installedLicenses() {
  const map = new Map();
  const visit = (nodeModules) => {
    if (!existsSync(nodeModules)) return;
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const dirs = entry.name.startsWith('@')
        ? readdirSync(join(nodeModules, entry.name), { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => join(nodeModules, entry.name, e.name))
        : [join(nodeModules, entry.name)];
      for (const dir of dirs) {
        const pkgPath = join(dir, 'package.json');
        if (existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
            const license =
              pkg.license ??
              (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(' OR ') : null);
            if (pkg.name && pkg.version) map.set(`${pkg.name}@${pkg.version}`, license ?? null);
          } catch {
            /* an unreadable package.json becomes an unknown below, which is the point */
          }
        }
        visit(join(dir, 'node_modules'));
      }
    }
  };
  visit(join(ROOT, 'node_modules'));
  return map;
}

/** Every distinct package in the production tree, workspaces included. */
function productionTree() {
  // `npm ls` exits non-zero on any tree complaint (an unmet peer, an extraneous package)
  // while still printing a complete tree. Treating that exit code as fatal would make an
  // unrelated warning look like a licensing failure, so read stdout either way and let the
  // parse be the thing that can fail.
  let raw;
  try {
    raw = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    raw = err.stdout;
    if (!raw) throw err;
  }
  const tree = JSON.parse(raw);
  const found = new Map(); // name -> Set(version)
  const walk = (node) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      const version = child.version ?? null;
      if (version) {
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(version);
      }
      walk(child);
    }
  };
  walk(tree);
  return found;
}

const licenses = installedLicenses();
const production = productionTree();

const packages = [];
for (const [name, versions] of [...production].sort(([a], [b]) => a.localeCompare(b))) {
  for (const version of [...versions].sort()) {
    // A workspace package is this repository, not a third-party dependency.
    const workspace = name.startsWith('@stellarsight/');
    const declared = workspace
      ? 'Apache-2.0'
      : (licenses.get(`${name}@${version}`) ?? null);
    packages.push({
      name,
      version,
      license: declared,
      classification: classify(declared),
      ...(workspace ? { workspace: true } : {}),
    });
  }
}

const by = (c) => packages.filter((p) => p.classification === c);
const summary = {
  total: packages.length,
  permissive: by('permissive').length,
  weakCopyleft: by('weak-copyleft').length,
  strongCopyleft: by('strong-copyleft').length,
  unknown: by('unknown').length,
};

const byLicense = {};
for (const p of packages) byLicense[p.license ?? '(none declared)'] = (byLicense[p.license ?? '(none declared)'] ?? 0) + 1;

const payload = {
  scope: 'production dependency tree (`npm ls --omit=dev --all`), all workspaces',
  scopeNote:
    'Dev dependencies are excluded because they are not redistributed. Nothing in this repository ships a dev dependency to a user.',
  summary,
  byLicense: Object.fromEntries(Object.entries(byLicense).sort((a, b) => b[1] - a[1])),
  strongCopyleft: by('strong-copyleft'),
  weakCopyleft: by('weak-copyleft'),
  unknown: by('unknown'),
  packages,
};

if (has('emit')) {
  const { path } = writeEvidence('licenses', payload);
  console.log(`[licenses] wrote ${path.replace(`${ROOT}/`, '')}`);
}

console.log(`\nProduction dependency licenses — ${summary.total} packages`);
for (const [license, count] of Object.entries(payload.byLicense)) {
  console.log(`  ${String(count).padStart(4)}  ${license}`);
}
console.log(
  `\n  permissive ${summary.permissive} · weak copyleft ${summary.weakCopyleft} · ` +
    `strong copyleft ${summary.strongCopyleft} · unknown ${summary.unknown}`,
);

for (const p of by('strong-copyleft')) console.error(`  STRONG COPYLEFT  ${p.name}@${p.version} — ${p.license}`);
for (const p of by('weak-copyleft')) console.log(`  weak copyleft    ${p.name}@${p.version} — ${p.license}`);
for (const p of by('unknown')) console.log(`  unknown          ${p.name}@${p.version} — ${p.license ?? '(none declared)'}`);

if (summary.strongCopyleft > 0) {
  console.error(`\nFAIL: ${summary.strongCopyleft} strong-copyleft package(s) in the production path.\n`);
  process.exit(1);
}
if (has('strict') && (summary.unknown > 0 || summary.weakCopyleft > 0)) {
  console.error(`\nFAIL (--strict): ${summary.unknown} unknown and ${summary.weakCopyleft} weak-copyleft package(s).\n`);
  process.exit(1);
}
console.log(`\n  no strong copyleft in the production path ✓\n`);
