import { RevealGroup } from '../lib/reveal'
import { CopyButton } from './CopyButton'
import { StarGlyph } from './Marks'

const QUICKSTART =
  'https://github.com/pedro-pelicioni/stellarsight/blob/main/docs/QUICKSTART-SELLER.md'

/** Every shell command on this page is declared exactly once, here, and used
 *  twice below — in the rendered row and in the step's copy payload — so the
 *  thing a developer reads and the thing they paste cannot drift apart. */
const CMD_BOOTSTRAP = 'npm install && npm run setup'
const CMD_DEV = 'npm run dev:all'
const CMD_CHECK = 'STELLARSIGHT_ALLOW_PRIVATE_RESOURCES=1 npx stellarsight-seller check'
const CMD_SEARCH = "curl -s 'localhost:4022/discovery/search?query=weather'"
const CMD_CONFORMANCE = 'npm run verify:conformance'

type Step = {
  n: string
  time: string
  title: string
  body: React.ReactNode
  code: React.ReactNode
  /** Literal handed to the clipboard. Omitted on the step that has no command. */
  copy?: string
}

const STEPS: Step[] = [
  {
    n: '01',
    time: '49 s',
    title: 'Clone and bootstrap',
    body: (
      <>
        <code>setup</code> generates every keypair, funds them from Friendbot, issues the{' '}
        <code>SXT</code> asset and deploys its SAC. No faucet captcha, no API key, no wallet
        extension — it runs start to finish with no web forms.
      </>
    ),
    code: (
      <>
        <div className="row">
          <span className="t-p">$ </span>
          <span className="path">{CMD_BOOTSTRAP}</span>
        </div>
        <div className="row">
          <span className="t-p">$ </span>
          <span className="path">{CMD_DEV}</span>
          <span className="note">:4021 · :4022 · :4023</span>
        </div>
      </>
    ),
    copy: `${CMD_BOOTSTRAP}\n${CMD_DEV}`,
  },
  {
    n: '02',
    time: 'your call',
    title: 'Declare your endpoint',
    body: (
      <>
        One entry in the <code>ROUTES</code> array carries the price, the handler and the
        discovery metadata together, so they cannot drift apart.{' '}
        <code>declareDiscoveryExtension</code> is the stock <code>@x402/extensions</code> export,
        not a wrapper of ours.
      </>
    ),
    code: (
      <>
        <div className="row">
          <span className="t-key">path</span>
          <span className="t-dim">: </span>
          <span className="t-str">"/v1/weather/:city"</span>
          <span className="t-dim">,</span>
        </div>
        <div className="row">
          <span className="t-key">priceSxt</span>
          <span className="t-dim">: </span>
          <span className="t-num">0.02</span>
          <span className="t-dim">,</span>
        </div>
        <div className="row">
          <span className="t-key">tags</span>
          <span className="t-dim">: [</span>
          <span className="t-str">"weather"</span>
          <span className="t-dim">, </span>
          <span className="t-str">"forecast"</span>
          <span className="t-dim">],</span>
        </div>
      </>
    ),
  },
  {
    n: '03',
    time: '0.4 s',
    title: 'Check it before it is announced',
    body: (
      <>
        <code>stellarsight-seller check</code> replays your routes through the index's own
        integrity validator — the same <code>upsert()</code> the hosted catalog runs — with no
        facilitator or index up. A bad host, a malformed <code>routeTemplate</code> or an
        over-length tag shows up here, not as a silent soft-drop after the first announce.
      </>
    ),
    code: (
      <>
        <div className="row">
          <span className="t-p">$ </span>
          <span className="path">{CMD_CHECK}</span>
        </div>
        <div className="row">
          <span className="t-good">ok</span>
          <span className="t-dim"> </span>
          <span className="path">GET /v1/fx/usd-brl</span>
        </div>
        <div className="row">
          <span className="t-good">3/3</span>
          <span className="t-dim"> </span>
          <span className="path">route(s) ok</span>
          <span className="note">exit 0</span>
        </div>
      </>
    ),
    copy: CMD_CHECK,
  },
  {
    n: '04',
    time: 'one curl',
    title: 'You are already listed',
    body: (
      <>
        The seller announces itself to the index on boot and re-announces every 30 s — so you are
        discoverable <em>before</em> your first payment. A catalog that lists a resource only
        after it has been paid cannot be used to find it in order to pay it.
      </>
    ),
    code: (
      <>
        <div className="row">
          <span className="t-p">$ </span>
          <span className="path">{CMD_SEARCH}</span>
        </div>
        <div className="row">
          <span className="t-good">0.8412</span>
          <span className="t-dim"> </span>
          <span className="path">acme-weather</span>
          <span className="note">top hit</span>
        </div>
      </>
    ),
    copy: CMD_SEARCH,
  },
  {
    n: '05',
    time: '10 s',
    title: 'Take a real payment',
    body: (
      <>
        An <em>unmodified</em> <code>@x402/fetch</code> client — no STELLARSIGHT code on the path — is
        driven through 402 → sign → settle → 200 against your seller. The bazaar extension
        reports the settlement back, and the facilitator's index counts it; persisting those
        counts to the hosted catalog is on the funded roadmap.
      </>
    ),
    code: (
      <>
        <div className="row">
          <span className="t-p">$ </span>
          <span className="path">{CMD_CONFORMANCE}</span>
        </div>
        <div className="row">
          <span className="t-good">PASS</span>
          <span className="path">settled · fees sponsored</span>
          <span className="note">buyer holds 0 XLM</span>
        </div>
      </>
    ),
    copy: CMD_CONFORMANCE,
  },
]

export function SellerPath() {
  return (
    <section className="section" id="ship">
      <div className="shell">
        <RevealGroup className="section__head">
          <span className="section__kicker rise" style={{ ['--i' as string]: 0 }}>
            <StarGlyph /> For sellers
          </span>
          <h2 className="section__title rise" style={{ ['--i' as string]: 1 }}>
            Docs to a paid, discoverable endpoint. <em>Fifty-nine seconds.</em>
          </h2>
          <p className="lede section__sub rise" style={{ ['--i' as string]: 2 }}>
            The RFP sets the bar at <em>well under an hour</em>. Every command below was timed
            with <code>/usr/bin/time</code> on a clean clone against live testnet, and they add
            up to 59 seconds — most of it waiting on five testnet transactions to close. The one
            step without a number is you writing a route object.
          </p>
        </RevealGroup>

        <RevealGroup className="ship">
          {STEPS.map((s, i) => (
            <article className="ship__step rise" key={s.n} style={{ ['--i' as string]: i }}>
              <div className="ship__rail" aria-hidden="true">
                <span className="ship__n">{s.n}</span>
              </div>
              <div className="ship__body">
                <div className="ship__head">
                  <h3>{s.title}</h3>
                  <span className="ship__time">{s.time}</span>
                </div>
                <p>{s.body}</p>
              </div>
              <div
                className={`ship__code${s.copy ? ' copy-host copy-host--pad' : ''}`}
                style={s.copy ? { ['--copy-gutter' as string]: '2.4rem' } : undefined}
              >
                {s.code}
                {s.copy && (
                  <CopyButton
                    text={s.copy}
                    label=""
                    what={`step ${s.n} command${s.copy.includes('\n') ? 's' : ''}`}
                  />
                )}
              </div>
            </article>
          ))}
        </RevealGroup>

        <RevealGroup>
          <div className="ship__foot rise" style={{ ['--i' as string]: 0 }}>
            <p>
              No API keys. No captcha. No faucet. No mainnet, no real money. Every step ends in
              something <code>curl</code> can check, and every command is one click to copy.
            </p>
            <a className="btn btn--solid btn--sm" href={QUICKSTART} target="_blank" rel="noreferrer noopener">
              Read the quickstart ↗
            </a>
          </div>
        </RevealGroup>
      </div>
    </section>
  )
}

export default SellerPath
