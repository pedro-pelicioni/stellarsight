import { useLayoutEffect, useRef, useState } from 'react'
import { ASSET_CODE } from '../lib/api'
import { ago, formatAmount, pct, shortKey, sightNumber } from '../lib/format'
import { PART_MAX, SCORE_MAX, tokenize } from '../lib/rank'
import type { Explain, ExplainKey, StellarsightRecord } from '../lib/types'

const PART_LABEL: Record<ExplainKey, string> = {
  bm25: 'BM25 text',
  metadata: 'Metadata',
  settlements: 'Settlements',
  recency: 'Recency',
}
const PART_COLOR: Record<ExplainKey, string> = {
  bm25: 'var(--accent)',
  metadata: 'var(--g-400)',
  settlements: 'var(--good)',
  recency: 'var(--amber)',
}

/* ------------------------------------------------------------------ explain */

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * The index and the local ranker disagree about the shape of `_explain` — the
 * index sends `parts` as an object. api.ts reconciles them, but this is the
 * last line of defence before render, so assume nothing.
 */
const explainParts = (ex: Explain | undefined): Explain['parts'] =>
  Array.isArray(ex?.parts) ? ex.parts : []

function ExplainPanel({ ex, id }: { ex: Explain; id: string }) {
  // Belt and braces: api.ts normalizes every dialect into arrays, but a crash
  // here is unrecoverable in front of an audience — never trust the shape.
  const parts = explainParts(ex)
  const terms = Array.isArray(ex.terms) ? ex.terms : []
  const total = Number.isFinite(ex.total) ? ex.total : parts.reduce((a, p) => a + num(p.value), 0)

  return (
    <div className="explain" id={id}>
      <p className="explain__lead">Why this result ranked here</p>
      <div className="explain__rows">
        {parts.map((p) => (
          <div className="explain__row" key={p.key}>
            <span className="explain__key">{PART_LABEL[p.key] ?? p.key}</span>
            <span className="explain__meter">
              <i
                style={{
                  // Against this part's OWN ceiling, not a shared constant. The 0.55 here
                  // was the old bm25 weight, so recency (max 0.05) painted itself full at
                  // a tenth of its value and bm25 (max 1.00) saturated at 0.55.
                  width: `${Math.min(100, (num(p.value) / (PART_MAX[p.key] ?? SCORE_MAX)) * 100)}%`,
                  background: PART_COLOR[p.key] ?? 'var(--fg-3)',
                }}
              />
            </span>
            <span className="explain__detail" title={p.detail}>
              {p.detail}
            </span>
            <span className="explain__val">{num(p.value).toFixed(3)}</span>
          </div>
        ))}
      </div>
      <div className="explain__total">
        <span>SCORE</span>
        <b>{total.toFixed(3)}</b>
        {/* Denominator is the sum of the weights (1.25), not 1.00. Dividing this scale by
            1.00 overstated every result by ~25%. */}
        <span>· {pct(total / SCORE_MAX)} of a perfect score</span>
      </div>
      {terms.length > 0 ? (
        <div className="explain__terms">
          {terms.map((t) => (
            <span className="term" key={`${t.term}-${t.field}`}>
              <b>{t.term}</b> · {t.field} · tf {t.tf} · idf {t.idf}
              {t.df === undefined ? '' : ` · df ${t.df}`} · +{t.weight}
            </span>
          ))}
        </div>
      ) : (
        <p className="explain__none">
          No query terms matched — this sight is held up by catalog health alone.
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------- sight */

function Sight({
  rec,
  index,
  hits,
  onPay,
  source = 'live',
}: {
  rec: StellarsightRecord
  index: number
  hits: Set<string>
  onPay?: (r: StellarsightRecord) => void
  source?: 'live' | 'demo'
}) {
  const [open, setOpen] = useState(false)
  const ex = rec._explain
  const panelId = `explain-${index}`
  const total = num(ex?.total)

  return (
    <article className={`sight${index === 0 ? ' sight--top' : ''}`}>
      <div className="sight__rail">
        <span className="sight__seq">Rank</span>
        <span className="sight__no">{sightNumber(index)}</span>
        {ex && <span className="sight__score">{total.toFixed(2)}</span>}
      </div>

      <div className="sight__body">
        <h3 className="sight__name">{rec.resource.serviceName}</h3>
        <p className="sight__url">{rec.resource.url}</p>
        <p className="sight__desc">{rec.resource.description}</p>
        <div className="sight__meta">
          <span className={`pill pill--${rec.type}`}>{rec.type === 'mcp' ? 'MCP tool' : 'HTTP'}</span>
          <span className="pill pill--net">{rec.network}</span>
          {(rec.resource.tags ?? []).slice(0, 6).map((t) => (
            <span className={`tag${hits.has(t.toLowerCase()) ? ' tag--hit' : ''}`} key={t}>
              {t}
            </span>
          ))}
        </div>
      </div>

      <div className="sight__right">
        <span className="price">
          {formatAmount(rec.amount ?? rec.maxAmountRequired)}
          <small>{ASSET_CODE}</small>
        </span>
        <span
          className={`source-pill source-pill--${source === 'demo' || rec.seeded ? 'seed' : 'live'}`}
          style={{ padding: '0.22rem 0.42rem', letterSpacing: '0.1em', whiteSpace: 'nowrap' }}
          title={
            source === 'demo'
              ? 'Baked fixture row — nothing here is reachable or payable from this page'
              : rec.seeded
                ? 'Illustrative catalog entry — advertised, not settle-backed'
                : 'Live registration — announced by a reachable seller, payable now'
          }
        >
          {/*
            The index never emits `seeded: false` — a live announcement CLEARS the flag —
            so absence is correct provenance on the live path and cannot be tightened.
            In the baked fixture the distinction is about where the rows came from, not
            about any field on the record.
          */}
          <span className="dot" />
          {source === 'demo' ? 'Fixture' : rec.seeded ? 'Catalog' : 'Live · Payable'}
        </span>
        <span className="sight__seen">seen {ago(rec.lastSeenAt)}</span>
        <span className="sight__seen">pay to {shortKey(rec.payTo, 4, 4)}</span>
        <div className="sight__acts">
          {ex && (
            <button
              className="disclose"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((v) => !v)}
            >
              <i>›</i> _explain
            </button>
          )}
          {onPay && (
            <button className="btn btn--sm btn--solid" onClick={() => onPay(rec)}>
              Pay
            </button>
          )}
        </div>
      </div>

      {ex && (
        <div className="scorebar" title={`score ${total.toFixed(3)}`}>
          {explainParts(ex).map((p) => (
            <span
              key={p.key}
              className={`scorebar__seg seg--${p.key}`}
              style={{ width: `${num(p.value) * 100}%` }}
            />
          ))}
          <span className="scorebar__ticks">
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>
      )}

      {open && ex && <ExplainPanel ex={ex} id={panelId} />}
    </article>
  )
}

/* -------------------------------------------------------------------- board */

export function SightBoard({
  items,
  query = '',
  onPay,
  caption = 'Ranked results',
  source = 'live',
}: {
  items: StellarsightRecord[]
  query?: string
  onPay?: (r: StellarsightRecord) => void
  caption?: string
  /** Where these rows came from. Nothing in the baked fixture is payable by a visitor. */
  source?: 'live' | 'demo'
}) {
  const refs = useRef(new Map<string, HTMLElement>())
  const last = useRef(new Map<string, number>())
  const hits = new Set(tokenize(query))

  /* FLIP — the board physically re-orders when the ranking changes */
  useLayoutEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    refs.current.forEach((el, id) => {
      const top = el.getBoundingClientRect().top
      const before = last.current.get(id)
      if (before !== undefined && !reduced) {
        const dy = before - top
        if (Math.abs(dy) > 2) {
          el.animate(
            [
              { transform: `translateY(${dy}px)`, opacity: 0.72 },
              { transform: 'translateY(0)', opacity: 1 },
            ],
            { duration: 620, easing: 'cubic-bezier(.2,.7,.2,1)' },
          )
        }
      }
      last.current.set(id, top)
    })
  }, [items])

  return (
    <section className="board" aria-label={caption}>
      <header className="board__head">
        <span className="label">{caption}</span>
        <span className="board__stat">
          {items.length} result{items.length === 1 ? '' : 's'} · ranked by hybrid score
        </span>
      </header>
      {items.map((rec, i) => (
        <div
          key={rec.id}
          ref={(el) => {
            if (el) refs.current.set(rec.id, el)
            else refs.current.delete(rec.id)
          }}
        >
          <Sight rec={rec} index={i} hits={hits} onPay={onPay}  source={source} />
        </div>
      ))}
    </section>
  )
}
