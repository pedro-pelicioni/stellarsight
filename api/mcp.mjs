/**
 * STELLARSIGHT — Hosted MCP endpoint over Streamable HTTP (Vercel Serverless Function).
 *
 * Exposes the Stellar Bazaar discovery index to AI agent runtimes over the Model
 * Context Protocol (Streamable HTTP transport) on the hosted origin (https://stellarsight.xyz/mcp).
 *
 * Architecture & Security invariants (§5.1, THREAT-MODEL T5):
 *   - Stateless mode: no session state or affinity required across serverless invocations.
 *   - CORS *: discovery is public and callable from any origin.
 *   - Per-IP rate limiting: shared limiter from apps/facilitator/src/rate-limit.mjs, under
 *     its own 'mcp' scope so discovery traffic does not spend the facilitator's budget.
 *   - Tools: stellarsight_search, stellarsight_browse, stellarsight_describe.
 *   - stellarsight_pay is refused server-side: buyer signing keys stay client-side (§5.1).
 *   - Seller metadata is marked with [UNTRUSTED_SELLER_CONTENT: ...] (T5 defense).
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../apps/agent/src/mcp-server.mjs';
import { createRateLimit } from '../apps/facilitator/src/rate-limit.mjs';

export const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  // Stateless mode has no SSE stream to open, so GET is not offered: the SDK would
  // only answer it with a JSON-RPC error. POST carries every request.
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Max-Age': '86400',
});

const rateLimiter = createRateLimit({ scope: 'mcp' });

export default async function handler(req, res) {
  // 1. CORS headers
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v);
  }

  // 2. Preflight
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // 3. Method check
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Method Not Allowed: only POST is supported (stateless transport, no SSE stream)' },
        id: null
      })
    );
    return;
  }

  // 4. Rate limit check
  // The middleware refuses by writing the 429 and returning *without* calling `next`, so
  // awaiting a promise settled by `next` would hang until maxDuration. Await the middleware
  // itself instead and let the flag say whether the request was allowed through.
  let passed = false;
  await rateLimiter(req, res, () => { passed = true; });
  if (!passed) return;

  // 5. Instantiate MCP server and stateless transport
  const server = createServer({ hosted: true, config: { inProcess: true } });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await server.connect(transport);

    // 6. Handle request
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    // Vercel's default for a thrown handler is an HTML 500, which no MCP client can read.
    // Every rejection in this repo carries a machine code and a non-null reason.
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: `Internal error: ${err?.message ?? String(err)}` },
          id: null
        })
      );
    }
  } finally {
    // A warm serverless instance reuses the process, so the per-request pair must be
    // released or its listeners accumulate across invocations. Closing here rather than on
    // res 'close' keeps a client abort from tearing the transport out of an in-flight dispatch.
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
