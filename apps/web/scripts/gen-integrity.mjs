/**
 * Generates src/data/integrity.json by replaying the shared hostile corpus through the
 * REAL catalog validator — `replayHostileCorpus()` from
 * packages/index/src/integrity-replay.mjs — and recording exactly what it returned.
 *
 * The ledger is derived, not authored: every `rule`, `verdict` and `reason` is a literal
 * string produced by the shipped code path, so it cannot drift from the validator.
 *
 * The corpus and the replay themselves live in packages/index/src/integrity-replay.mjs,
 * shared with the public GET /discovery/integrity endpoint — one definition, two
 * bindings, nothing to drift. This script only owns what is build-specific: the commit
 * stamp, the carry-forward of `generatedAt`, and the write-only-when-changed rule.
 *
 * Never fails the build: on any error it leaves the existing file alone and exits 0.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../src/data/integrity.json')
const ROOT = resolve(here, '../../..')

try {
  const { replayHostileCorpus, VALIDATOR_ID } = await import(
    resolve(ROOT, 'packages/index/src/integrity-replay.mjs')
  )

  // Stamp the commit that last touched the VALIDATOR (and now the shared corpus), not
  // HEAD. HEAD would change on every unrelated commit, so this file would be rewritten
  // by the next `npm run dev` and dirty the tree forever. The validator's own commit is
  // also the provenance that actually matters: it identifies the code that produced
  // these verdicts.
  // On Vercel the checkout is shallow, so `git log -- <paths>` can only answer from the
  // truncated window and quietly returns the boundary commit — the deployed panel spent a
  // day attributing the replay to a commit that never touched the validator. The platform
  // already knows the build's SHA; trust it there, and use git's answer locally.
  let commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null
  try {
    commit ??= execFileSync(
      'git',
      [
        'log',
        '-1',
        '--format=%h',
        '--',
        'packages/index/src/integrity.mjs',
        'packages/index/src/index.mjs',
        'packages/index/src/integrity-replay.mjs',
      ],
      { cwd: ROOT },
    )
      .toString()
      .trim() || null
  } catch {
    /* not a git checkout — provenance is optional, the verdicts are not */
  }

  const { entries, skipped } = replayHostileCorpus()

  for (const s of skipped) {
    console.warn(
      `[gen-integrity] SKIP ${s.field} <- ${s.input}: the validator accepted it. ` +
        `The corpus and the code disagree — fix one of them.`,
    )
  }

  if (entries.length === 0) {
    console.warn('[gen-integrity] produced no rows — keeping the existing file')
    process.exit(0)
  }

  const body = {
    generator: 'apps/web/scripts/gen-integrity.mjs',
    validator: VALIDATOR_ID,
    commit,
    note: 'Replay of a fixed hostile corpus through the shipped validator. Every rule, verdict and reason below is the validator&apos;s own output. Not a live feed.',
    entries,
  }

  // `generatedAt` means "when these verdicts last changed", not "when this script last
  // ran". Stamping the wall clock on every run would rewrite the file on every
  // `npm run dev` and leave the tree permanently dirty, so carry the old timestamp
  // forward whenever the substance is identical — and skip the write entirely.
  let previous = null
  try {
    previous = JSON.parse(readFileSync(out, 'utf8'))
  } catch {
    /* first run, or the file is unreadable — write a fresh one */
  }
  const unchanged =
    previous && JSON.stringify({ ...previous, generatedAt: undefined }) === JSON.stringify({ ...body, generatedAt: undefined })

  const n = entries.filter((r) => r.verdict === 'rejected').length
  if (unchanged) {
    console.log(
      `[gen-integrity] ${entries.length} verdicts unchanged (${n} rejected, ${entries.length - n} soft-drop)${commit ? ` @ ${commit}` : ''} — file left alone`,
    )
  } else {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...body }, null, 2)}\n`)
    console.log(
      `[gen-integrity] wrote ${entries.length} verdicts from the real validator (${n} rejected, ${entries.length - n} soft-drop)${commit ? ` @ ${commit}` : ''}`,
    )
  }
} catch (e) {
  console.log(`[gen-integrity] could not regenerate (${e.message}) — keeping current data`)
  process.exit(0)
}
