/**
 * Where the playground's four surfaces live.
 *
 * Same discipline as lib/api.ts: in production everything is same-origin (vercel.json
 * routes /v1/*, /settle, /discovery/* and /playground/fund to their functions from one
 * domain), and in dev each service is on the port CONTRACT.md pins it to. An explicit
 * VITE_* override wins in both, including the empty string.
 */

const override = (v: unknown, fallback: string): string =>
  typeof v === 'string' ? v.replace(/\/$/, '') : fallback

const SAME_ORIGIN = ''

export const SELLER_URL = override(
  import.meta.env.VITE_SELLER_URL,
  import.meta.env.PROD ? SAME_ORIGIN : 'http://localhost:4023',
)

export const FAUCET_URL = override(
  import.meta.env.VITE_FAUCET_URL,
  import.meta.env.PROD ? SAME_ORIGIN : 'http://localhost:4021',
)

/** Testnet, hardcoded. The playground signs with a key it generated; it never touches pubnet. */
export const NETWORK = 'stellar:testnet'
export const RPC_URL = 'https://soroban-testnet.stellar.org'
export const HORIZON_URL = 'https://horizon-testnet.stellar.org'
export const FRIENDBOT_URL = 'https://friendbot.stellar.org'

/** The seller routes a visitor can buy, with the method and body each one takes. */
export const ROUTES = [
  {
    id: 'fx',
    label: 'USD/BRL rate',
    path: '/v1/fx/usd-brl',
    method: 'GET' as const,
    body: undefined,
    blurb: 'A foreign-exchange quote. The cheapest route, and the one the conformance script buys.',
  },
  {
    id: 'cep',
    label: 'Postal code lookup',
    path: '/v1/cep/01310100',
    method: 'GET' as const,
    body: undefined,
    blurb: 'Brazilian postal-code lookup — an address, resolved.',
  },
  {
    id: 'ocr',
    label: 'Invoice OCR',
    path: '/v1/ocr/nota-fiscal',
    method: 'POST' as const,
    body: { imageUrl: 'https://example.com/invoice.png', language: 'pt-BR' },
    blurb: 'Structured extraction from an invoice. A POST, to show the loop is not GET-only.',
  },
]

export type PlaygroundRoute = (typeof ROUTES)[number]
