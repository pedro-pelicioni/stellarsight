# @stellarsight/express

x402 paywall middleware for Express. Put a price on any route, take payment in a Stellar
token, and have the route listed in the STELLARSIGHT bazaar **before** its first payment.

You do not need to fork anything. This is a self-contained package that drops into your
own repo:

```bash
npm install @stellarsight/express express @x402/core @x402/extensions
```

## 60 seconds

```js
import express from 'express'
import { stellarsightPaywall } from '@stellarsight/express'

const app = express()
app.use(express.json())

const pay = stellarsightPaywall({
  facilitator: 'http://localhost:4021',   // where /verify and /settle live
  payTo:   process.env.SELLER_PUBLIC,     // G... — who gets the money
  asset:   process.env.ASSET_SAC,         // C... — the SEP-41 / SAC token you price in
  network: 'stellar:testnet',
  baseUrl: 'http://localhost:4023',       // this server's public origin
  index:   'http://localhost:4022',       // optional — announce to the Bazaar
  assetCode: 'SXT',                       // optional — makes `0.02 SXT` readable to agents
})

app.get('/v1/weather/:city', pay('/v1/weather/:city', {
  price: '0.02',
  serviceName: 'acme-weather',
  description: 'Current conditions and a 3-day forecast for a city.',
  tags: ['weather', 'forecast'],
  // `:city` is a PATH parameter, so it goes in pathParams. `input` is published as
  // queryParams — use it for `?units=metric`, not for a segment of the URL.
  pathParams: { city: 'sao-paulo' },
  pathParamsSchema: {
    properties: { city: { type: 'string', description: 'City slug, lowercase, hyphenated.' } },
    required: ['city'],
  },
  output: { example: { city: 'sao-paulo', tempC: 21.4 } },
}), (req, res) => {
  res.json({ city: req.params.city, tempC: 21.4, paidWith: req.stellarsight.transaction })
})

// Your machine-readable catalogue, served from your own server.
app.get('/.well-known/x402', pay.wellKnownHandler())

app.listen(4023)
```

That is the whole seller story. An x402 client (`@x402/fetch`, or anything that speaks the
v2 HTTP transport) now gets a 402 with a `PAYMENT-REQUIRED` header, pays, and gets the JSON.

### The two call shapes

```js
pay('/v1/weather/:city', { price: '0.02' })   // path first  — recommended
pay({ path: '/v1/weather/:city', price: '0.02' })
pay({ price: '0.02' })                        // path learned from the first request
```

Give the path. It is the difference between "discoverable at boot" and "discoverable after
somebody happens to hit the route", and a parameterised path is also used as the bazaar
`routeTemplate` automatically.

## What the middleware does on every request

1. No payment header → **402** with the `PaymentRequired` object base64-encoded into the
   `PAYMENT-REQUIRED` response header (and mirrored into the JSON body for `curl` and v1
   clients), `Cache-Control: no-store`, and a bazaar discovery extension attached.
2. Reads `PAYMENT-SIGNATURE`, or the v1 `X-PAYMENT` spelling.
3. Decodes it with `@x402/core/http`'s own codec — never hand-rolled base64, so the wire
   format cannot drift from what a stock client produces.
4. **Re-derives price, asset, payTo and network from your route declaration** and compares
   them against what the client echoed. A mismatch is a 402 naming every field that
   disagreed. The echo is then discarded: `/verify` and `/settle` are always called with the
   server's own requirements.
5. `POST {facilitator}/verify`, then `POST {facilitator}/settle`.
6. On success, forwards `PAYMENT-RESPONSE` (plus the v1 `X-PAYMENT-RESPONSE`) and any
   `EXTENSION-RESPONSES` header, populates `req.stellarsight` and `req.x402`, and calls `next()`.

**Every rejection carries a non-null, human-readable `error`.** When the facilitator rejects
without saying why, the middleware substitutes a sentence rather than emitting `null`.

## `req.stellarsight`

```js
{
  settlement: { success, errorReason, transaction, network, payer },  // raw /settle response
  transaction: 'abc123…',
  payer: 'G…',
  network: 'stellar:testnet',
  requirements: { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra },
  route: { method, path, price, amount, asset, payTo, serviceName, tags, … },
  facilitator: 'http://localhost:4021',
  extensionResponses: '<base64>' | null,
}
```

`req.x402` is the raw settle response, kept for compatibility with handlers written against
the STELLARSIGHT reference seller.

## Discovery

Every priced route declares a bazaar discovery extension built with the stock
`declareDiscoveryExtension` from `@x402/extensions`. It is attached to the 402 challenge, to
`/.well-known/x402`, and to the record announced to the index.

When `index` **and** `baseUrl` are configured, routes are announced to
`POST {index}/discovery/resources` shortly after the first route is declared and re-announced
every 30s (the reference index is in-memory and forgets everything on restart). Both timers
are `unref()`d and will never keep your process alive.

> **Announcements require `baseUrl`.** The only origin available at request time comes from
> the client-controlled `Host` header; publishing that would let any caller list your routes
> in the public catalog under a URL they own. With no `baseUrl`, nothing is announced and
> `await pay.announce()` tells you exactly that.

Describe your inputs and outputs. The bazaar ranks on metadata completeness, and an agent
that cannot tell what a parameter means will not call your endpoint:

```js
pay('/v1/cep/:cep', {
  price: '0.005',
  serviceName: 'acme-postal',
  description: 'Brazilian postal code lookup returning street, neighborhood, city and state.',
  tags: ['postal-code', 'address', 'brazil'],
  input: { cep: '01310100' },
  inputSchema: {
    properties: { cep: { type: 'string', description: 'Brazilian postal code, 8 digits, hyphen optional.' } },
    required: ['cep'],
  },
  pathParams: { cep: '01310100' },
  output: { example: { postalCode: '01310-100', city: 'Sao Paulo', state: 'SP' } },
})
```

For `POST`/`PUT`/`PATCH` routes set `method` and (optionally) `bodyType`, which defaults to
`'json'`:

```js
app.post('/v1/ocr', pay('/v1/ocr', { method: 'POST', price: '0.05', input: { imageUrl: '…' } }), handler)
```

## Paywall options

| option | default | meaning |
|---|---|---|
| `facilitator` | **required** | absolute URL exposing `POST /verify` and `POST /settle` |
| `payTo` | **required** | `G…` account that receives payment (per-route override allowed) |
| `asset` | **required** | `C…` SEP-41 / SAC contract id you price in |
| `network` | `'stellar:testnet'` | CAIP-2 network id |
| `scheme` | `'exact'` | x402 payment scheme |
| `decimals` | `7` | token decimals used to turn `price` into atomic units |
| `assetCode` | – | display code, e.g. `'SXT'`; drives `extra.humanAmount` |
| `baseUrl` | – | this server's public origin; **required for announcements** |
| `index` | – | bazaar index URL to announce to |
| `announce` | `true` | set `false` to declare routes without any background traffic |
| `announceDelayMs` / `announceIntervalMs` | `1200` / `30000` | boot delay and re-announce period (`0` disables the interval) |
| `maxTimeoutSeconds` | `120` | advertised payment validity window |
| `feesSponsored` | `true` | sets `extra.areFeesSponsored` |
| `extra` | `{}` | merged into `PaymentRequirements.extra` |
| `mimeType` | `'application/json'` | advertised response type |
| `facilitatorTimeoutMs` / `indexTimeoutMs` | `15000` / `5000` | request timeouts |
| `onSettled(stellarsight, req)` | – | called after a successful settlement; throwing is logged, never fails the request |
| `onRejected({reason, route}, req)` | – | called on every 402 |
| `fetch` | `globalThis.fetch` | injectable, for tests |
| `logger` | `console` | pass `false` to silence |

## Route options

`price` (human units, e.g. `'0.02'`) **or** `amount` (atomic units, e.g. `'200000'`) is
required; giving both is an error. Everything else is optional: `path`, `method`, `payTo`,
`asset`, `maxTimeoutSeconds`, `serviceName`, `description`, `tags`, `iconUrl`, `mimeType`,
`routeTemplate`, `extra`, and the discovery fields `input`, `inputSchema`, `pathParams`,
`pathParamsSchema`, `bodyType`, `output`.

Bad declarations throw **when you call `pay(...)`**, not on the first paying request.

## Instance API

```js
pay.routes()             // [{ method, path, price, amount, asset, payTo, serviceName, tags, … }]
pay.wellKnown(origin?)   // the /.well-known/x402 body
pay.wellKnownHandler()   // an Express handler serving it
await pay.announce()     // announce now -> { announced[], skipped[{route,reason}], failed[{route,reason}] }
pay.announceRecords()    // [{ method, path, record }] — the records announce() would send, unsent
pay.check()              // replay those records through the bazaar index's own validator, offline
pay.stop()               // clear the announce timers
pay.config               // frozen view of the resolved configuration
```

## CLI: `stellarsight-seller check`

A rejected or silently soft-dropped listing has historically surfaced only after boot — a
`could not announce` warning in the seller's own log, or nothing at all when the index
drops a field. `stellarsight-seller check` runs the bazaar index's own integrity validator
(`@stellarsight/index`) against every route's announce record **before** you ever announce,
with no facilitator or index running and nothing sent over the network:

```bash
npx stellarsight-seller check
npx stellarsight-seller check --json     # machine-readable, for scripts
npx stellarsight-seller check --config ./path/to/stellarsight.config.mjs
```

```
ok    GET   /v1/weather/:city
FAIL  POST  /v1/ocr/invoice   resource.url host is not publicly reachable (IPv4 private range)

1/2 route(s) ok, 1 rejected
```

Exit code is `1` on any rejection, `0` otherwise — gate your own CI on it.

**Config file contract.** By default the CLI loads `stellarsight.config.mjs` (or `.js`)
from the current directory; `--config` points it elsewhere. That module must export the
object `stellarsightPaywall()` returns, with every route already declared via `pay(...)`,
as its default export or a named `pay` export:

```js
// stellarsight.config.mjs
import { stellarsightPaywall } from '@stellarsight/express'

const pay = stellarsightPaywall({
  facilitator: process.env.FACILITATOR_URL,
  payTo: process.env.SELLER_PUBLIC,
  asset: process.env.ASSET_SAC,
  baseUrl: process.env.SELLER_URL,   // required — see pay.check() below
  index: process.env.INDEX_URL,
})

export const weatherRoute = pay('/v1/weather/:city', {
  price: '0.02',
  serviceName: 'acme-weather',
})

export default pay
```

Your real server imports the same module and attaches the already-built middleware —
nothing is declared twice, so the config the CLI checks can never drift from what you
actually serve:

```js
// server.mjs
import pay, { weatherRoute } from './stellarsight.config.mjs'

app.get('/v1/weather/:city', weatherRoute, (req, res) => res.json({ tempC: 21.4 }))
app.get('/.well-known/x402', pay.wellKnownHandler())
app.listen(PORT)
```

`pay.check()` needs `baseUrl` set — without it, no route has an absolute resource URL and
nothing would ever be announced either, so the CLI reports why instead of a per-route
reason.

## CORS

Browser agents can only read the x402 headers if they are explicitly exposed:

```js
import cors from 'cors'
import { x402CorsOptions } from '@stellarsight/express'
app.use(cors(x402CorsOptions()))
```

## Prices never touch a float

`price: '0.07'` becomes `'700000'` by string arithmetic. `Math.round(0.07 * 1e7)` is
`700000.0000000001` before rounding, and every "off by one stroop" bug starts there. A price
with more decimal places than the asset has is a thrown error, not a silent rounding.

## License

Apache-2.0
