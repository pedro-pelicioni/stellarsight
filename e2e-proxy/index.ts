/**
 * A forwarding facilitator for the official x402 end-to-end harness.
 *
 * ─── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────
 *
 * The SCF RFP names as a hard acceptance criterion "a passing run of the x402 repo's e2e
 * suite". That suite (x402-foundation/x402, `e2e/`) cannot be pointed at a deployed
 * facilitator by any flag or environment variable: `GenericFacilitatorProxy` spawns a
 * child process and hardcodes `http://localhost:${port}` for every call it makes.
 *
 * The upstream-sanctioned seam is `e2e/facilitators/external-proxies/<name>/`, documented
 * in that directory's own README as the way to test "external production facilitators".
 * The harness special-cases the directory in `e2e/src/discovery.ts` (`isExternal: true`)
 * and lists it as a workspace root in `e2e/pnpm-workspace.yaml` — but the directory is
 * gitignored, so no proxy implementation ships upstream. Every external run is first-party
 * glue like this one.
 *
 * That is worth saying out loud rather than letting a reviewer discover it: a passing run
 * against STELLARSIGHT includes this file. So it lives in OUR repository, under version
 * control, and is published next to the results. What it must not do is influence an
 * outcome — hence: no retries, no response rewriting, no status remapping, no fallbacks.
 * It relays bytes and gets out of the way. If the hosted facilitator rejects a payment,
 * the harness sees that rejection exactly as the hosted facilitator wrote it.
 *
 * ─── WHAT THE HARNESS REQUIRES OF IT ────────────────────────────────────────────────
 *
 *   · listen on process.env.PORT
 *   · print the exact string "Facilitator listening" once ready — GenericFacilitatorProxy
 *     gates readiness on that literal, and without it startup falls back to a 30s timeout
 *   · serve POST /verify, POST /settle, GET /supported, GET /health, POST /close
 *   · serve GET /discovery/resources and GET /discovery/search for the bazaar extension
 *
 * Run: the harness launches this via `pnpm exec tsx index.ts` (resolveRunCommand).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const UPSTREAM = (process.env.STELLARSIGHT_URL ?? 'https://stellarsight.xyz').replace(/\/+$/, '')
const PORT = Number(process.env.PORT ?? 4020)

/** Paths relayed verbatim. Anything else is a 404 — the harness should not silently pass. */
const FORWARDED = new Set([
  '/verify',
  '/settle',
  '/supported',
  '/discovery/resources',
  '/discovery/search',
])

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

const send = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname

  // Health is answered locally and deliberately: it reports that the RELAY is up. Proxying
  // it would make a slow upstream look like a dead proxy and cost the run its 10×2s
  // startup budget before a single payment was attempted.
  if (path === '/health') return send(res, 200, { status: 'ok', relayFor: UPSTREAM })

  if (path === '/close') {
    send(res, 200, { status: 'closing' })
    // Reply first, then exit, so the harness never sees a dropped connection.
    setTimeout(() => process.exit(0), 50)
    return
  }

  if (!FORWARDED.has(path)) {
    return send(res, 404, {
      error: 'not_forwarded',
      message: `this relay forwards ${[...FORWARDED].join(', ')} to ${UPSTREAM}; ${path} is not one of them`,
    })
  }

  const target = `${UPSTREAM}${path}${url.search}`
  const method = req.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)

  try {
    const upstream = await fetch(target, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body,
      // Long enough for a Soroban settle behind a serverless cold start, short enough that
      // a hung request fails the scenario rather than the whole run.
      signal: AbortSignal.timeout(55_000),
    })

    const text = await upstream.text()
    // Relay the status verbatim. A 402 from the facilitator is a legitimate protocol
    // answer and must not be laundered into a 200 or a 500 on the way through.
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    })
    res.end(text)
  } catch (e) {
    // A relay failure is OUR failure and is labelled as such, so a reviewer reading the
    // log can tell it apart from a facilitator rejection.
    send(res, 502, {
      error: 'relay_failed',
      message: `could not reach ${target}: ${e instanceof Error ? e.message : String(e)}`,
    })
  }
})

server.listen(PORT, () => {
  console.log(`Relaying to ${UPSTREAM}`)
  // The literal the harness waits for. Keep it last and keep it exact.
  console.log('Facilitator listening')
})
