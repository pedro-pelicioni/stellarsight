# STELLARSIGHT — Integration Contract (read this first)

Monorepo, plain npm workspaces, Node 22 or newer (CI and the deployment run 24), ESM (`"type": "module"`). No TypeScript build step
anywhere except `apps/web` (Vite). Everything must run with `node <file>.mjs` or `npm run dev`.

## Ports (fixed, do not change)

| Service | Port | Owner |
|---|---|---|
| facilitator (`/verify`, `/settle`, `/supported`) | 4021 | apps/facilitator |
| bazaar index (`/discovery/*`) | 4022 | packages/index served by apps/facilitator |
| seller paid API | 4023 | apps/seller |
| web (Vite dev) | 5173 | apps/web |

## Shared env — `/.env` at repo root (written by scripts/setup-testnet.mjs)

```
STELLAR_NETWORK=stellar:testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
HORIZON_URL=https://horizon-testnet.stellar.org
NETWORK_PASSPHRASE=Test SDF Network ; September 2015

ISSUER_SECRET=S...        # issues the SXT SEP-41 test asset
ISSUER_PUBLIC=G...
ASSET_CODE=SXT
ASSET_SAC=C...            # SAC contract id — this is `asset` in PaymentRequirements

SELLER_SECRET=S...        # payTo account (has SXT trustline)
SELLER_PUBLIC=G...

PAYER_SECRET=S...         # the agent's wallet (has SXT trustline + balance)
PAYER_PUBLIC=G...

FEEPAYER_SECRET=S...      # facilitator sponsors network fees (RFP 3.1 areFeesSponsored)
FEEPAYER_PUBLIC=G...

FACILITATOR_URL=http://localhost:4021
INDEX_URL=http://localhost:4022
SELLER_URL=http://localhost:4023
```

## packages/index — public API (ESM named exports from `packages/index/src/index.mjs`)

```js
export function createCatalog()                    // -> Catalog
// Catalog:
//   upsert(record) -> { ok: boolean, dropped: string[], reason?: string }
//   list({ type, payTo, scheme, network, extensions, limit=20, offset=0 }) -> { items, total, limit, offset }
//   search({ query, limit=20, cursor, ...filters }) -> { items, partialResults, pagination:{limit,cursor} }
//   NOTE: both return INTERNAL records. The wire projection happens in discovery.mjs.
//   size() -> number
export function validateResourceBlock(block)       // soft-drop -> { value, dropped: string[] }
export function validateRouteTemplate(t)           // -> { valid: boolean, reason?: string }
export function scoreHybrid(query, docs)           // BM25 + field-boost -> ranked docs
```

### The INTERNAL record shape

This is what `upsert()` takes, what the store holds and what `list()`/`search()` return.
It is **not** what goes on the wire — see the next section.

```js
{
  id: string,                 // `${resource.url}` or `${resource.url}#${input.toolName}` for MCP
  resource: { url, serviceName?, tags?, iconUrl?, description? },
  type: "http" | "mcp",
  network: "stellar:testnet",
  scheme: "exact",
  payTo: "G...",
  asset: "C...",
  maxAmountRequired: "10000",
  extra?: object,             // sanitized accepts.extra of the offering mirrored above
  requirements: [             // EVERY distinct offering this resource advertises.
    { scheme, network, payTo, asset, maxAmountRequired, extra? }
    // Identity = scheme|network|asset|payTo|canonical(extra): re-seeing an offering
    // updates its price in place; a different offering (second upto profile, exact
    // alongside upto) is appended. Top-level fields mirror the most recently seen
    // offering. Content-keyed on purpose until the spec names the discriminator
    // (extra.uptoProfile is still in open upstream PRs) — see issue #1.
  ],
  input: { type, method?, queryParams?, body?, toolName?, inputSchema? },
  output: { type, format?, example? },
  routeTemplate?: string,
  extensions: ["bazaar"],
  lastSeenAt: number,         // ms epoch
  settlements: number         // count of observed settled payments
}
```

### The WIRE shape — `DiscoveryResource`

`packages/index/src/discovery.mjs` (`toDiscoveryResource`) projects the internal record
onto the type the shipped SDK declares (`@x402/extensions/dist/esm/index-*.d.mts`). **All
three** transport adapters go through it:

| Adapter | Serves | Goes through `discovery.mjs`? |
|---|---|---|
| `packages/index/src/serverless.mjs` (via `api/discovery/*.mjs`) | `stellarsight.xyz` | yes |
| `packages/index/src/http.mjs` (`mountDiscoveryRoutes`) | any Express host | yes |
| `apps/facilitator/src/server.mjs` (mounts `mountDiscoveryRoutes`) | the local index on `:4022` | yes |

This register previously carried a **KNOWN DRIFT** here: the facilitator hand-rolled its
own `/discovery/resources` and `/discovery/search` and returned `catalog.list()` /
`catalog.search()` verbatim, so `:4022` served the INTERNAL record shape while the
deployment served the wire shape. It is closed. The facilitator now calls
`mountDiscoveryRoutes(indexApp, catalog)`, and `apps/agent/src/bazaar.mjs` reads either
shape through one `fieldsOf()` accessor rather than reaching for `rec.resource.url`.

`GET /health` on `:4022` reports `wireShape: "spec"` when the shared routes are mounted,
and `"internal-stub"` in the one degraded case that remains — `packages/index` failing to
import at all, where the facilitator falls back to its in-memory stub and says so rather
than pretending to be spec-shaped.

```js
{
  // ---- spec DiscoveryResource ----
  resource: "https://api.example/v1/thing",   // a URL STRING, not the block above
  type: "http" | "mcp",
  x402Version: 2,
  accepts: [                                  // x402 v2 PaymentRequirements — one entry
    { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra }
    // per distinct offering the record advertises. accepts[0] is always the offering
    // the native mirrors below track; further offerings follow in first-seen order.
  ],
  lastUpdated: "2026-08-07T12:00:00.000Z",    // ISO 8601, from lastSeenAt
  serviceName?, description?, tags?, iconUrl?, mimeType?,   // TOP LEVEL, not nested
  extensions: { bazaar: { info: { input, output }, routeTemplate?, schema? } },  // object MAP

  // ---- additive, STELLARSIGHT-native: not spec, ignored by a spec consumer ----
  id, network, scheme, payTo, asset, maxAmountRequired,     // mirrors of accepts[0]
  input, output, routeTemplate,
  lastSeenAt, firstSeenAt, settlements, seeded,
  _score, _explain
}
```

Three things a stock consumer needs that the internal record does not give it, and the
reasons they are easy to get wrong:

1. **`resource` is a URL string.** The presentation fields move to the top level.
2. **`accepts` is required** — without it a client cannot construct a payment from a
   search result. **x402 v2 `PaymentRequirements` names the price `amount`, NOT
   `maxAmountRequired`**; the v1 name fails `PaymentRequirementsSchema` in the installed
   `@x402/core`.
3. **`lastUpdated` is ISO 8601**, where the record keeps epoch ms in `lastSeenAt`.

## HTTP surfaces — do not rename fields

- `GET  /supported` -> `{ kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true, asset } }] }`
- `POST /verify`  -> `{ isValid, invalidReason|null, payer }`
- `POST /settle`  -> `{ success, errorReason|null, transaction, network, payer }` + header `EXTENSION-RESPONSES`
- `GET  /discovery/resources?type&payTo&scheme&network&extensions&limit&offset`
  -> `{ x402Version, items: DiscoveryResource[], pagination: { limit, offset, total } }`
  (plus flat `total`/`limit`/`offset`)
- `GET  /discovery/search?query&limit&cursor&...filters`
  -> `{ x402Version, resources: DiscoveryResource[], partialResults, pagination: { limit, cursor } }`
- `EXTENSION-RESPONSES` header = base64(JSON) of `{ bazaar: { status: "success"|"processing"|"rejected", rejectedReason? } }`
- `POST /mcp` -> MCP over Streamable HTTP, stateless (one JSON-RPC request per `POST`; `GET` answers `405`). `stellarsight_search` / `_browse` / `_describe` are live; `stellarsight_pay` is registered and refused on the hosted origin.

**`/verify` and `/settle` are rate limited; nothing else is.** Over the configured
per-caller budget they answer `429` with `Retry-After` and
`{ ok: false, code: "STELLARSIGHT_RATE_LIMITED", reason, scope, limit, windowSeconds,
retryAfterSeconds }` — a transport refusal, deliberately **not** the `isValid`/`success`
shape, because a rate limit is not a verdict about the payment. `/supported`, `/health`
and `/events` are never limited: `/supported` is an RFP acceptance criterion and must
answer a stock client unconditionally. Defaults are 120 requests per 60s per caller;
`FACILITATOR_RATE_LIMIT=0` disables it. `GET /health` reports the policy in force under
`rateLimit`, and the facilitator's fee under `fee`.

**The two discovery envelopes differ deliberately, and so does their pagination.**
`DiscoveryResourcesResponse` names the array **`items`** and paginates by
offset/total; `SearchDiscoveryResourcesResponse` names it **`resources`** and paginates
by cursor. `withBazaar()` returns the parsed body untransformed, so a search response
carrying only `items` makes `search.resources` `undefined` and throws on iteration.
Search currently ALSO emits `items` as a deprecated duplicate alias of the same array,
for one release. New consumers must read `resources`.

None of this is asserted by reading the field names this repo emits — that is a belief,
not an observation, and it is how the `items`/`resources` divergence shipped in the first
place. `npm run verify:api` imports the real `withBazaar` from `@x402/extensions`, drives
it against the actual handlers over a socket, and validates every `accepts` entry with
`@x402/core`'s own `PaymentRequirementsSchema`. Change a field name here and that harness
is what tells you.

## apps/web contract

Reads from `INDEX_URL`. **MUST render fully with a baked-in fallback fixture** at
`apps/web/src/data/fixture.json` when the API is unreachable — the demo cannot depend on
localhost being up. Show a small "LIVE / DEMO" pill reflecting which source is active.

Routes: `/` (landing), `/console` (live search + payment loop viewer).

## Assets

Generated assets land in `apps/web/public/assets/`. Web must degrade gracefully (CSS-only
fallback) if an asset file is missing.
