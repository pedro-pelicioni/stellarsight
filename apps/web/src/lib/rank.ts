import type { Explain, StellarsightRecord } from './types'

/**
 * Client-side mirror of packages/index `scoreHybrid`: BM25 over boosted fields
 * plus three catalog-health signals. Runs locally so the console still explains
 * itself when the index is unreachable — and so the _explain panel always has
 * something honest to show.
 */

const STOP = new Set([
  'a','o','os','as','de','da','do','das','dos','que','com','para','por','um','uma','e','em','no','na',
  'nos','nas','ao','aos','the','of','for','to','and','with','in','on','an','my','me','i','is','are','it',
])

const FIELD_BOOST: Record<string, number> = {
  serviceName: 3.0,
  tags: 2.2,
  description: 1.0,
  url: 0.6,
}

/**
 * The index's own blend weights, not a second opinion. packages/index/src/rank.mjs uses
 * relevance 1.00 / completeness 0.12 / popularity 0.08 / recency 0.05, and the landing page
 * publishes exactly those as "the formula". This file's header claims to mirror
 * `scoreHybrid`; with a different set it did not, so a query-less board scored here
 * contradicted the formula printed on the site and summed to a different ceiling.
 */
export const WEIGHTS = { bm25: 1.0, metadata: 0.12, settlements: 0.08, recency: 0.05 }

/** What a total can reach when every part maxes out. The _explain meter's denominator. */
export const SCORE_MAX = WEIGHTS.bm25 + WEIGHTS.metadata + WEIGHTS.settlements + WEIGHTS.recency

/** Per-part ceilings, so a meter can show each bar against what that part alone can score. */
export const PART_MAX: Record<string, number> = {
  bm25: WEIGHTS.bm25,
  metadata: WEIGHTS.metadata,
  settlements: WEIGHTS.settlements,
  recency: WEIGHTS.recency,
}

/** Matches the index: 14-day half-life. See RECENCY_HALF_LIFE_DAYS in rank.mjs. */
const RECENCY_HALF_LIFE_DAYS = 14

const K1 = 1.4
const B = 0.72

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

export function tokenize(s: string): string[] {
  return normalize(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
}

type Fields = Record<string, string[]>

function fieldsOf(r: StellarsightRecord): Fields {
  return {
    serviceName: tokenize(r.resource?.serviceName ?? ''),
    tags: tokenize((r.resource?.tags ?? []).join(' ')),
    description: tokenize(r.resource?.description ?? ''),
    url: tokenize(r.resource?.url ?? ''),
  }
}

/** 0..1 — how completely the seller filled out the advertisement */
function metadataScore(r: StellarsightRecord): { score: number; missing: string[] } {
  const checks: [string, boolean][] = [
    ['serviceName', Boolean(r.resource?.serviceName)],
    ['description ≥ 80', (r.resource?.description ?? '').length >= 80],
    ['tags ≥ 3', (r.resource?.tags ?? []).length >= 3],
    ['iconUrl', Boolean(r.resource?.iconUrl)],
    ['input schema', Boolean(r.input && Object.keys(r.input).length > 1)],
    ['output example', Boolean((r.output as { example?: string })?.example)],
    ['routeTemplate', Boolean(r.routeTemplate) || r.type === 'mcp'],
  ]
  const hit = checks.filter(([, ok]) => ok).length
  return { score: hit / checks.length, missing: checks.filter(([, ok]) => !ok).map(([k]) => k) }
}

const settlementScore = (n: number) => Math.log10(1 + Math.max(0, n)) / Math.log10(1 + 5000)

/**
 * `Math.exp(-hours / 72)` was here, labelled "72 h half-life" in the _explain panel. It is
 * an e-folding with a 72-hour time constant, whose actual half-life is 72·ln2 ≈ 50 h — and
 * the index it claims to mirror decays on a 14-day half-life. Two different curves, and the
 * label described neither. This is the index's function.
 */
const recencyScore = (ts: number) => {
  const days = Math.max(0, (Date.now() - ts) / 86_400_000)
  return Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS)
}

export function rank(query: string, docs: StellarsightRecord[]): StellarsightRecord[] {
  const q = tokenize(query)
  const corpus = docs.map(fieldsOf)
  const N = docs.length || 1

  // avg length + document frequency per field
  const avgdl: Record<string, number> = {}
  const df: Record<string, Record<string, number>> = {}
  for (const field of Object.keys(FIELD_BOOST)) {
    avgdl[field] = corpus.reduce((a, f) => a + f[field].length, 0) / N || 1
    df[field] = {}
    for (const f of corpus) {
      for (const t of new Set(f[field])) df[field][t] = (df[field][t] ?? 0) + 1
    }
  }

  const scored = docs.map((doc, i) => {
    const f = corpus[i]
    let raw = 0
    const terms: Explain['terms'] = []

    for (const term of q) {
      let best: Explain['terms'][number] | null = null
      for (const field of Object.keys(FIELD_BOOST)) {
        const toks = f[field]
        if (!toks.length) continue
        let tf = toks.filter((t) => t === term).length
        let fuzzy = false
        if (!tf && term.length >= 4) {
          tf = toks.filter((t) => t.startsWith(term) || term.startsWith(t)).length * 0.75
          fuzzy = tf > 0
        }
        if (!tf) continue
        const n = Math.max(1, df[field][term] ?? (fuzzy ? 1 : 1))
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
        const denom = tf + K1 * (1 - B + (B * toks.length) / avgdl[field])
        const contrib = (idf * (tf * (K1 + 1))) / denom * FIELD_BOOST[field]
        if (!best || contrib > best.weight) {
          best = { term, field, tf: Math.round(tf * 100) / 100, idf: Math.round(idf * 100) / 100, weight: contrib }
        }
        raw += contrib
      }
      if (best) terms.push({ ...best, weight: Math.round(best.weight * 1000) / 1000 })
    }

    const bm25n = q.length ? raw / (raw + 6) : 0
    const meta = metadataScore(doc)
    const settle = settlementScore(doc.settlements ?? 0)
    const rec = recencyScore(doc.lastSeenAt ?? Date.now())

    const parts: Explain['parts'] = [
      {
        key: 'bm25',
        value: bm25n * WEIGHTS.bm25,
        detail: q.length
          ? `raw BM25 ${raw.toFixed(2)} · k1=${K1} b=${B} · field boost ×${FIELD_BOOST.serviceName}/${FIELD_BOOST.tags}/${FIELD_BOOST.description}`
          : 'no query — text contributes nothing',
      },
      {
        key: 'metadata',
        value: meta.score * WEIGHTS.metadata,
        detail: meta.missing.length ? `missing: ${meta.missing.join(', ')}` : 'advertisement complete (7/7)',
      },
      {
        key: 'settlements',
        value: settle * WEIGHTS.settlements,
        detail: `${(doc.settlements ?? 0).toLocaleString('en-US')} settlements observed (log-scaled)`,
      },
      { key: 'recency', value: rec * WEIGHTS.recency, detail: '14-day half-life since lastSeenAt' },
    ]

    const total = parts.reduce((a, p) => a + p.value, 0)
    const _explain: Explain = { total, parts, terms: terms.sort((a, b) => b.weight - a.weight).slice(0, 6) }
    return { ...doc, _explain }
  })

  return scored.sort((a, b) => (b._explain!.total ?? 0) - (a._explain!.total ?? 0))
}
