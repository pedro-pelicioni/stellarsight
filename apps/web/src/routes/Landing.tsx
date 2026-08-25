import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AssetImg } from '../components/AssetImg'
import { CodeSpans, CopyButton, copyText } from '../components/CopyButton'
import type { CodeSpan } from '../components/CopyButton'
import { StellarsightMark, StarGlyph } from '../components/Marks'
import { SellerPath } from '../components/SellerPath'
import { Ticker } from '../components/Ticker'
import { DitherField } from '../components/DitherField'
import { DottedGlobe } from '../components/DottedGlobe'
import { OrbitRing } from '../components/OrbitRing'
import { bakedIntegrity, demoCatalog, loadCatalog, testnetTxs } from '../lib/api'
import { explorerTx, shortHash } from '../lib/format'
import { RevealGroup } from '../lib/reveal'
import type { Catalog } from '../lib/types'

const GITHUB = 'https://github.com/pedro-pelicioni/stellarsight'

/**
 * Three representative verdicts for the bento card — one rejection, then the two most
 * distinct soft-drops. Taken from the generated ledger so the card cannot drift from
 * the validator the way its hand-written predecessor did.
 */
const miniLedger = (() => {
  const all = bakedIntegrity().entries
  const rejected = all.filter((e) => e.verdict === 'rejected').slice(0, 1)
  const soft = all.filter((e) => e.verdict === 'soft-drop')
  const seen = new Set<string>()
  const distinct = soft.filter((e) => {
    const head = e.rule.split(/[[:]/)[0]
    if (seen.has(head)) return false
    seen.add(head)
    return true
  })
  return [...rejected, ...distinct].slice(0, 3)
})()

/**
 * The hero command, declared once. `CodeSpans` paints it and `copyText` folds the
 * same array into the literal the copy button puts on the clipboard, so the two
 * cannot drift. The `$ ` prompt is rendered but marked `copy: false` — it is
 * chrome, and pasting it into a shell is an error.
 */
const HERO_CMD: CodeSpan[] = [
  { text: '$ ', className: 't-p', copy: false },
  {
    text: "curl 'https://stellarsight.xyz/discovery/search?query=invoice%20ocr&limit=3'",
    className: 't-cmd',
  },
]

/**
 * Counts a visitor can falsify by running the command printed beside them, so they are
 * declared once and rendered from here in both the proof strip and the verify block. The
 * page previously carried a hand-typed 84 in the strip and 129 in the block, for the same
 * `npm test`, eighty lines apart.
 */
const TEST_COUNT = 205
const API_CHECKS = 46
/**
 * Counted from the receipts, not typed in. This number moves every time a batch or a
 * nightly run settles, and a hand-written one silently understated it for two weeks —
 * which is the same defect as overstating it, just in the flattering direction.
 *
 * A row counts as a payment when its label names the script that made it (`demo:`,
 * `conformance:`, `load:`); the setup and cleanup operations that created the accounts
 * are transactions but not payments.
 */
const SETTLED_PAYMENTS = testnetTxs.filter((t) => /^(demo|conformance|load)/i.test(t.label ?? '')).length
/** Of API_CHECKS, the ones driven through the unmodified @x402/extensions client. */
const STOCK_CLIENT_CHECKS = 9

/** The three verification commands, declared once: the block renders them aligned
 *  with their comments, the copy button ships the bare commands. */
const VERIFY_CMDS = [
  { cmd: 'npm test', note: `${TEST_COUNT} tests, 0 failing` },
  { cmd: 'npm run verify:api', note: `${API_CHECKS} checks, incl. the stock withBazaar() client` },
  { cmd: 'npm run demo', note: 'discover → 402 → sign → settle → 200' },
] as const
const VERIFY_COL = Math.max(...VERIFY_CMDS.map((c) => c.cmd.length)) + 1

/* ------------------------------------------------------------ terminal */

function Terminal() {
  return (
    <div className="terminal">
      <div className="terminal__bar">
        <span className="terminal__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="terminal__title">stellarsight.xyz — discovery/search</span>
        <span className="terminal__title" style={{ marginLeft: 'auto' }}>
          x402 v2
        </span>
        <CopyButton variant="bar" text={copyText(HERO_CMD)} what="search command" />
      </div>
      <div className="terminal__body">
        <pre>
          <CodeSpans spans={HERO_CMD} />
          {'\n'}
          <span className="t-dim">{'{'}</span>
          {'\n  '}
          <span className="t-key">"x402Version"</span>
          <span className="t-dim">: </span>
          <span className="t-num">2</span>
          <span className="t-dim">,</span>
          {'\n  '}
          <span className="t-key">"resources"</span>
          <span className="t-dim">: [{'{'}</span>
          {'\n    '}
          <span className="t-key">"resource"</span>
          <span className="t-dim">: </span>
          <span className="t-str">"https://api.documents.example/v1/invoice-ocr"</span>
          <span className="t-dim">,</span>
          {'\n    '}
          <span className="t-key">"serviceName"</span>
          <span className="t-dim">: </span>
          <span className="t-str">"Invoice OCR"</span>
          <span className="t-dim">,</span>
          {'\n    '}
          <span className="t-key">"_score"</span>
          <span className="t-dim">: </span>
          <span className="t-num">0.7736</span>
          <span className="t-dim">,</span>
          {'\n    '}
          <span className="t-key">"accepts"</span>
          <span className="t-dim">: [{'{'} </span>
          <span className="t-key">"scheme"</span>
          <span className="t-dim">: </span>
          <span className="t-str">"exact"</span>
          <span className="t-dim">,</span>
          {'\n      '}
          <span className="t-key">"network"</span>
          <span className="t-dim">: </span>
          <span className="t-good">"stellar:testnet"</span>
          <span className="t-dim">,</span>
          {'\n      '}
          <span className="t-key">"amount"</span>
          <span className="t-dim">: </span>
          <span className="t-str">"15000"</span>
          <span className="t-dim">,</span>
          {'\n      '}
          <span className="t-key">"payTo"</span>
          <span className="t-dim">: </span>
          <span className="t-str">"GDQN…KTL3"</span>
          <span className="t-dim"> {'}'}]</span>
          {'\n  '}
          <span className="t-dim">{'}'}, </span>
          <span className="t-dim">… 2 more ],</span>
          {'\n  '}
          <span className="t-key">"partialResults"</span>
          <span className="t-dim">: </span>
          <span className="t-num">false</span>
          <span className="t-dim">,</span>
          {'\n  '}
          <span className="t-key">"pagination"</span>
          <span className="t-dim">: {'{'} </span>
          <span className="t-key">"limit"</span>
          <span className="t-dim">: </span>
          <span className="t-num">3</span>
          <span className="t-dim">, </span>
          <span className="t-key">"cursor"</span>
          <span className="t-dim">: </span>
          <span className="t-num">null</span>
          <span className="t-dim"> {'}'}</span>
          {'\n'}
          <span className="t-dim">{'}'}</span>
          {'\n'}
          <span className="t-p">$ </span>
          <span className="terminal__cursor" aria-hidden="true" />
        </pre>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- landing */

export default function Landing() {
  const [cat, setCat] = useState<Catalog>(() => demoCatalog())
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    let alive = true
    loadCatalog().then((c) => alive && setCat(c))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const paymentTxs = testnetTxs.slice(0, 8)

  return (
    <div className="theme">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <span className="grain" aria-hidden="true" />

      <header className={`topbar${scrolled ? ' is-scrolled' : ''}`}>
        <div className="shell topbar__in">
          <Link className="topbar__mark" to="/" aria-label="STELLARSIGHT home">
            <StellarsightMark />
            <span>STELLARSIGHT</span>
          </Link>
          <nav className="topbar__nav" aria-label="Site">
            <a href="#ship">Sell an API</a>
            <Link to="/console">Console</Link>
            <Link to="/playground">Playground</Link>
            <Link to="/explorer">Explorer</Link>
            <a href={GITHUB} target="_blank" rel="noreferrer noopener">
              GitHub
            </a>
          </nav>
          <span
            className={`source-pill source-pill--${cat.source}`}
            title={
              cat.source === 'live'
                ? 'connected to the discovery index'
                : 'index unreachable — rendering the baked fixture'
            }
          >
            <span className="dot dot--pulse" />
            {cat.source}
          </span>
          <Link className="btn btn--sm btn--solid" to="/console">
            Open console
          </Link>
        </div>
      </header>

      <main id="main">
        {/* ---------------------------------------------------------- hero */}
        <section className="hero">
          <DitherField />
          <div className="shell hero__in">
            <div className="hero__grid">
              <div>
                <span className="kicker reveal" style={{ ['--d' as string]: '60ms' }}>
                  <span className="dot" />
                  stellar:testnet
                  <span className="sep">·</span>
                  x402 v2
                </span>
                <h1 className="hero__title reveal" style={{ ['--d' as string]: '140ms' }}>
                  Find <em>what to pay for</em> on Stellar.
                </h1>
                <p className="lede hero__sub reveal" style={{ ['--d' as string]: '240ms' }}>
                  STELLARSIGHT is the facilitator-side Bazaar discovery layer for x402 — a public,
                  hosted index where agents advertise paid APIs, search them in plain language,
                  and settle in one HTTP round trip.
                </p>
                <div className="hero__cta reveal" style={{ ['--d' as string]: '330ms' }}>
                  <Link className="btn btn--solid" to="/playground">
                    Pay for something now
                  </Link>
                  <Link className="btn btn--ghost" to="/console">
                    Open console
                  </Link>
                  <a className="btn btn--ghost" href="#ship">
                    List your API ↓
                  </a>
                  <a
                    className="btn btn--ghost"
                    href={GITHUB}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    GitHub ↗
                  </a>
                </div>
                <p className="hero__note reveal" style={{ ['--d' as string]: '420ms' }}>
                  Or make a real testnet payment from this browser in about a minute — no wallet,
                  no signup, no API key. Clone to a paid, discoverable endpoint in 59s of commands.
                </p>
              </div>
              <div className="reveal" style={{ ['--d' as string]: '380ms' }}>
                <Terminal />
              </div>
            </div>

            {/* ------------------------------------------------- proof strip */}
            <RevealGroup>
              <div
                className="proof rise"
                style={{ marginTop: 'clamp(2.5rem, 6vw, 4rem)', ['--i' as string]: 0 }}
              >
                <div className="proof__cell">
                  <span className="proof__n">
                    <em>{SETTLED_PAYMENTS}</em>
                  </span>
                  <span className="proof__l">
                    settled x402 payments on Stellar testnet — every one labeled by the script
                    that made it, none of it organic demand
                  </span>
                </div>
                <div className="proof__cell">
                  <span className="proof__n">{TEST_COUNT}</span>
                  <span className="proof__l">tests, 0 failing — 66 of them adversarial</span>
                </div>
                <div className="proof__cell">
                  <span className="proof__n">{API_CHECKS}</span>
                  <span className="proof__l">
                    API conformance checks — {STOCK_CLIENT_CHECKS} through the unmodified{' '}
                    <code>@x402/extensions</code> client
                  </span>
                </div>
                <div className="proof__cell">
                  <span className="proof__n">Apache-2.0</span>
                  <span className="proof__l">permissive from the first commit</span>
                </div>
              </div>
            </RevealGroup>
          </div>
        </section>

        <Ticker items={cat.items} />

        {/* --------------------------------------------------------- bento */}
        <section className="section" id="features">
          <div className="shell">
            <RevealGroup className="section__head">
              <span className="section__kicker rise" style={{ ['--i' as string]: 0 }}>
                <StarGlyph /> What ships
              </span>
              <h2 className="section__title rise" style={{ ['--i' as string]: 1 }}>
                Discovery is the missing half of x402. <em>This is it, running.</em>
              </h2>
              <p className="lede section__sub rise" style={{ ['--i' as string]: 2 }}>
                An agent that can pay but cannot discover is an agent with a wallet and no map.
                STELLARSIGHT is the map — and the whole payment loop around it, end to end on testnet.
              </p>
            </RevealGroup>

            <RevealGroup className="bento">
              <article
                className="bento__card bento__card--3 globe-host rise"
                style={{ ['--i' as string]: 0 }}
              >
                <DottedGlobe className="globe--bleed" />
                <span className="bento__kicker">
                  <StarGlyph size={9} /> Bazaar discovery
                </span>
                <h3>A public Bazaar any agent can call</h3>
                <p>
                  The spec's <code>/discovery</code> endpoints, served from the same catalog code
                  locally and at <code>stellarsight.xyz</code> — readable by the stock{' '}
                  <code>@x402/extensions</code> client, with CORS open because the point is for
                  other people's agents to call it.
                </p>
                <div className="bento__code">
                  <div className="row">
                    <span className="method">GET</span>
                    <span className="path">/discovery/resources</span>
                    <span className="note">paginated catalog, spec filters</span>
                  </div>
                  <div className="row">
                    <span className="method">GET</span>
                    <span className="path">/discovery/search</span>
                    <span className="note">natural language, ranked</span>
                  </div>
                  <div className="row">
                    <span className="method">GET</span>
                    <span className="path">/discovery/health</span>
                    <span className="note">mode · records · commit</span>
                  </div>
                </div>
              </article>

              <article className="bento__card bento__card--3 rise" style={{ ['--i' as string]: 1 }}>
                <span className="bento__kicker">
                  <StarGlyph size={9} /> Explainable ranking
                </span>
                <h3>
                  Every <code>_explain</code> sums to its <code>_score</code>
                </h3>
                <p>
                  BM25 over boosted fields, blended with catalog health. Quality breaks ties — it
                  never overrides relevance — and a test asserts the four parts sum exactly to the
                  score.
                </p>
                <div className="bento__code" aria-label="Ranking formula">
                  <span className="formula">
                    <b>1.00</b>·bm25 + <b>0.12</b>·completeness + <b>0.08</b>·popularity +{' '}
                    <b>0.05</b>·recency
                  </span>
                  <span className="minibar" aria-hidden="true">
                    <i className="seg--bm25" style={{ width: '80%' }} />
                    <i className="seg--metadata" style={{ width: '9.6%' }} />
                    <i className="seg--settlements" style={{ width: '6.4%' }} />
                    <i className="seg--recency" style={{ width: '4%' }} />
                  </span>
                  <span className="minibar__legend">
                    <span>
                      <i className="seg--bm25" style={{ display: 'inline-block' }} />
                      BM25
                    </span>
                    <span>
                      <i className="seg--metadata" style={{ display: 'inline-block' }} />
                      metadata
                    </span>
                    <span>
                      <i className="seg--settlements" style={{ display: 'inline-block' }} />
                      settlements
                    </span>
                    <span>
                      <i className="seg--recency" style={{ display: 'inline-block' }} />
                      recency
                    </span>
                  </span>
                </div>
              </article>

              <article className="bento__card rise" style={{ ['--i' as string]: 2 }}>
                <span className="bento__kicker">
                  <StarGlyph size={9} /> Catalog integrity
                </span>
                <h3>Soft-drop at the trust boundary</h3>
                <p>
                  Every discovery field is attacker-controlled. Hostile routes are refused; hostile
                  fields are dropped and the record survives.
                </p>
                {/* Driven by the generated ledger, not typed out here. The hand-written
                    version of these three rows named rules the validator does not have
                    and called a traversal "rejected" when the code soft-drops it. */}
                <div className="miniledger">
                  {miniLedger.map((e) => (
                    <div className="miniledger__row" key={`${e.verdict}-${e.rule}`}>
                      <span className={`verdict verdict--${e.verdict}`}>
                        {e.verdict === 'rejected' ? 'rejected' : 'soft-drop'}
                      </span>
                      <span className="miniledger__rule">{e.rule}</span>
                    </div>
                  ))}
                </div>
              </article>

              <article className="bento__card rise" style={{ ['--i' as string]: 3 }}>
                <span className="bento__kicker">
                  <StarGlyph size={9} /> Fee-sponsored payments
                </span>
                <h3>The buyer needs zero XLM</h3>
                <p>
                  The facilitator's fee account sponsors every network fee. On a settled
                  transaction, <code>fee_account</code> is the facilitator — not the payer.
                </p>
                <div className="bento__code">
                  <div className="row">
                    <span className="path">extra.areFeesSponsored</span>
                    <span className="note" style={{ color: 'var(--good)' }}>
                      true
                    </span>
                  </div>
                </div>
              </article>

              <article className="bento__card rise" style={{ ['--i' as string]: 4 }}>
                <span className="bento__kicker">
                  <StarGlyph size={9} /> MCP server
                </span>
                <h3>Four tools, schemas on both ends</h3>
                <p>
                  Any MCP client can discover and pay — input <em>and</em> output schemas, a
                  17-code error enum, settled payments driven over MCP.
                </p>
                <div className="bento__code">
                  <div className="row">
                    <span className="path">stellarsight_search</span>
                  </div>
                  <div className="row">
                    <span className="path">stellarsight_browse</span>
                  </div>
                  <div className="row">
                    <span className="path">stellarsight_describe</span>
                  </div>
                  <div className="row">
                    <span className="path">stellarsight_pay</span>
                  </div>
                </div>
              </article>

              <article
                className="bento__card bento__card--6 rise"
                style={{ ['--i' as string]: 5 }}
              >
                <div className="bento__wide">
                  <div>
                    <span className="bento__kicker">
                      <StarGlyph size={9} /> Self-hosted facilitator
                    </span>
                    <h3 style={{ marginTop: '0.6rem' }}>Yours to fork and run</h3>
                    <p style={{ marginTop: '0.6rem' }}>
                      verify / settle / supported on the Apache-2.0 <code>@x402/stellar</code>{' '}
                      package — no AGPL dependencies, no third-party relayer, no API keys. It
                      issues its own SEP-41 test asset, so setup runs start to finish with no web
                      forms.
                    </p>
                  </div>
                  <div className="bento__wide-side">
                    <div className="bento__code" style={{ width: '100%', marginTop: 0 }}>
                      <div className="row">
                        <span className="method" style={{ color: 'var(--accent)' }}>
                          POST
                        </span>
                        <span className="path">/verify</span>
                        <span className="note">isValid · payer</span>
                      </div>
                      <div className="row">
                        <span className="method" style={{ color: 'var(--accent)' }}>
                          POST
                        </span>
                        <span className="path">/settle</span>
                        <span className="note">tx hash · EXTENSION-RESPONSES</span>
                      </div>
                      <div className="row">
                        <span className="method">GET</span>
                        <span className="path">/supported</span>
                        <span className="note">kinds · areFeesSponsored</span>
                      </div>
                    </div>
                    <a
                      className="btn btn--ghost btn--sm"
                      href={GITHUB}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Read the source ↗
                    </a>
                  </div>
                </div>
              </article>
            </RevealGroup>
          </div>
        </section>

        {/* ------------------------------------------------------ one index */}
        <section className="section" id="index">
          <div className="shell orbit-split">
            <RevealGroup>
              <span className="section__kicker rise" style={{ ['--i' as string]: 0 }}>
                <StarGlyph /> One index
              </span>
              <h2 className="section__title rise" style={{ ['--i' as string]: 1 }}>
                Every client orbits <em>the same catalog.</em>
              </h2>
              <p className="lede section__sub rise" style={{ ['--i' as string]: 2 }}>
                The four MCP tools and the <code>/discovery/*</code> routes are two doors into one
                index — the same catalog code, the same ranking, the same records, whether it runs
                on your laptop or at <code>stellarsight.xyz</code>. Nothing is mirrored per client.
              </p>
            </RevealGroup>
            <OrbitRing />
          </div>
        </section>

        {/* --------------------------------------------------- seller path */}
        <SellerPath />

        {/* -------------------------------------------------------- verify */}
        <section className="section" id="verify">
          <div className="shell verify">
            <RevealGroup>
              <span className="section__kicker rise" style={{ ['--i' as string]: 0 }}>
                <StarGlyph /> On testnet
              </span>
              <h2 className="section__title rise" style={{ ['--i' as string]: 1 }}>
                Verify it in <em>60 seconds.</em>
              </h2>
              <p className="prose section__sub rise" style={{ ['--i' as string]: 2 }}>
                Nothing here asks for trust. Every hash on the right is a real transaction this
                code submitted to Stellar testnet — open any of them on stellar.expert and read{' '}
                <code style={{ fontFamily: "'DM Mono', monospace", fontSize: '0.85em' }}>
                  successful: true
                </code>{' '}
                off the ledger.
              </p>
              <pre
                className="verify__cmd rise copy-host copy-host--pad"
                style={{ ['--i' as string]: 3 }}
              >
                {VERIFY_CMDS.map((c) => `$ ${c.cmd.padEnd(VERIFY_COL)}# ${c.note}`).join('\n')}
                <CopyButton
                  text={VERIFY_CMDS.map((c) => c.cmd).join('\n')}
                  what="verification commands"
                  label="Copy all"
                />
              </pre>
            </RevealGroup>
            <RevealGroup>
              <div className="txs rise" style={{ ['--i' as string]: 1 }}>
                {paymentTxs.map((tx, i) => (
                  <a
                    key={tx.hash}
                    className="tx"
                    href={explorerTx(tx.hash)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <span className="tx__no">{String(i + 1).padStart(2, '0')}</span>
                    <span className="tx__label">{tx.label}</span>
                    <span className="tx__hash">{shortHash(tx.hash)} ↗</span>
                  </a>
                ))}
                {paymentTxs.length === 0 && (
                  <p className="prose" style={{ padding: '1.25rem' }}>
                    Settlement log is being written.
                  </p>
                )}
              </div>
            </RevealGroup>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="shell">
          <div className="footer__top">
            <div>
              <div className="footer__brand">
                <AssetImg src="/assets/stellarsight-mark.svg" width={34} height={34} />
                <p className="footer__mark">STELLARSIGHT</p>
              </div>
              <p className="footer__tag">Find what to pay for on Stellar.</p>
            </div>
            <nav className="footer__links" aria-label="Elsewhere">
              <Link className="link" to="/console">
                Console
              </Link>
              <a className="link" href={GITHUB} target="_blank" rel="noreferrer noopener">
                GitHub ↗
              </a>
              <a
                className="link"
                href="https://stellar.expert/explorer/testnet"
                target="_blank"
                rel="noreferrer noopener"
              >
                Explorer ↗
              </a>
            </nav>
          </div>
          <div className="footer__colophon">
            <span>Apache-2.0</span>
            <span>x402 v2 · stellar:testnet</span>
            <span>Built in São Paulo, Brazil.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
