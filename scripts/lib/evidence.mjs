/**
 * scripts/lib/evidence.mjs — the machine-generated evidence pack, one writer.
 *
 * Every claim this project publishes should be diffable against reality, so the scripts
 * that PRODUCE evidence (conformance, rejection audit, scripted batches, nightly runs)
 * all write through here into docs/status/*.json with one envelope: what kind of
 * artifact, when it was generated, by which commit, against which stack. Nothing in
 * docs/status/ is typed in, with one exception that says so: upstream-e2e.json records a
 * manual run of the x402 repository's own e2e suite and carries `recordedBy: "manual"`.
 *
 * docs/status/provenance.json is the hash -> label map that keeps the volume story
 * honest: every settled payment this repo generates records WHY it exists
 * (`conformance`, `demo`, `scripted-load`, `nightly-ci`, `setup`), so the explorer feed
 * and the docs can label synthetic traffic as synthetic instead of letting it read as
 * organic. An unlabeled hash renders as "unlabeled", never as "organic".
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATUS_DIR = join(ROOT, 'docs', 'status');
export const PROVENANCE_PATH = join(STATUS_DIR, 'provenance.json');
export const TX_DOC_PATH = join(ROOT, 'docs', 'TESTNET-TXS.md');

/** Labels the provenance map accepts. Anything else is a bug, not a new category. */
export const PROVENANCE_LABELS = Object.freeze([
  'setup',
  'demo',
  'conformance',
  'scripted-load',
  'nightly-ci',
]);

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })
      .toString()
      .trim() || null;
  } catch {
    return null; // not a git checkout — provenance is optional, the payload is not
  }
}

/**
 * writeEvidence(name, payload) -> { path, body }
 *
 * Writes docs/status/<name>.json with the shared envelope. `kind` defaults to `name`;
 * pass one explicitly when several files share a kind (e.g. batch-YYYYMMDD).
 */
export function writeEvidence(name, payload, { kind = name } = {}) {
  const body = {
    kind,
    generatedAt: new Date().toISOString(),
    commit: gitCommit(),
    node: process.version,
    network: 'stellar:testnet',
    ...payload,
  };
  mkdirSync(STATUS_DIR, { recursive: true });
  const path = join(STATUS_DIR, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return { path, body };
}

export function readEvidence(name) {
  try {
    return JSON.parse(readFileSync(join(STATUS_DIR, `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * updateProvenance({ '<txHash>': { label, run? } }) — merge, never overwrite an
 * existing hash with a different label: the first recorded reason a payment exists is
 * the true one, and silently relabeling history is exactly the kind of edit this file
 * exists to make visible.
 */
export function updateProvenance(entries) {
  let current = {};
  try {
    current = JSON.parse(readFileSync(PROVENANCE_PATH, 'utf8')).hashes ?? {};
  } catch {
    /* first write */
  }
  let added = 0;
  const conflicts = [];
  for (const [hash, meta] of Object.entries(entries ?? {})) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) continue;
    if (!PROVENANCE_LABELS.includes(meta?.label)) {
      throw new Error(
        `provenance label ${JSON.stringify(meta?.label)} for ${hash.slice(0, 8)}… is not one of: ${PROVENANCE_LABELS.join(', ')}`,
      );
    }
    if (current[hash]) {
      if (current[hash].label !== meta.label) conflicts.push({ hash, kept: current[hash].label, refused: meta.label });
      continue;
    }
    current[hash] = { label: meta.label, ...(meta.run ? { run: meta.run } : {}), recordedAt: new Date().toISOString() };
    added++;
  }
  mkdirSync(STATUS_DIR, { recursive: true });
  writeFileSync(
    PROVENANCE_PATH,
    `${JSON.stringify(
      {
        note: 'hash -> why this payment exists. Written only by scripts/; an unlisted hash renders as "unlabeled", never as "organic".',
        labels: PROVENANCE_LABELS,
        updatedAt: new Date().toISOString(),
        hashes: current,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { added, conflicts, total: Object.keys(current).length };
}

/**
 * appendTxRows([{ step, hash, date? }]) — append rows to docs/TESTNET-TXS.md in its
 * current 4-column shape (| Step | Hash | Explorer | Date |). `date` defaults to
 * today (UTC): the ledger's created_at is authoritative, but at append time the two
 * agree to the day, and the doc's own note says dates come from Horizon.
 */
export function appendTxRows(rows) {
  if (!rows?.length) return { appended: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const lines = rows
    .map(
      (r) =>
        `| ${r.step} | \`${r.hash}\` | https://stellar.expert/explorer/testnet/tx/${r.hash} | ${r.date ?? today} |`,
    )
    .join('\n');
  if (existsSync(TX_DOC_PATH)) {
    const prev = readFileSync(TX_DOC_PATH, 'utf8').trimEnd();
    writeFileSync(TX_DOC_PATH, `${prev}\n${lines}\n`, 'utf8');
  } else {
    const header = `# STELLARSIGHT — testnet transactions\n\n| Step | Hash | Explorer | Date |\n|---|---|---|---|\n`;
    writeFileSync(TX_DOC_PATH, `${header}${lines}\n`, 'utf8');
  }
  return { appended: rows.length };
}

export default {
  STATUS_DIR,
  PROVENANCE_PATH,
  TX_DOC_PATH,
  PROVENANCE_LABELS,
  writeEvidence,
  readEvidence,
  updateProvenance,
  appendTxRows,
};
