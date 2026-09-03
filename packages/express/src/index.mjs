/**
 * @stellarsight/express — sell an Express endpoint for a Stellar token with one line.
 *
 *   import express from 'express'
 *   import { stellarsightPaywall } from '@stellarsight/express'
 *
 *   const app = express()
 *   const pay = stellarsightPaywall({
 *     facilitator: 'http://localhost:4021',
 *     payTo: process.env.SELLER_PUBLIC,
 *     asset: process.env.ASSET_SAC,
 *     baseUrl: 'https://api.acme.dev',
 *     index: 'http://localhost:4022',
 *   })
 *
 *   app.get('/v1/weather/:city', pay('/v1/weather/:city', {
 *     price: '0.02',
 *     serviceName: 'acme-weather',
 *     description: 'Current conditions and a 3-day forecast for a city.',
 *     tags: ['weather', 'forecast'],
 *     pathParams: { city: 'sao-paulo' },   // `input` is published as queryParams — see README
 *     output: { example: { city: 'sao-paulo', tempC: 21.4 } },
 *   }), (req, res) => res.json({ tempC: 21.4, tx: req.stellarsight.transaction }))
 *
 *   app.get('/.well-known/x402', pay.wellKnownHandler())
 *
 * See README.md for the full option reference.
 */

export { stellarsightPaywall } from "./paywall.mjs";
export { checkListings } from "./check.mjs";
export {
  DEFAULTS,
  X402_ALLOWED_HEADERS,
  X402_EXPOSED_HEADERS,
  x402CorsOptions,
} from "./config.mjs";
export { fromAtomicUnits, parseAtomicUnits, toAtomicUnits } from "./amount.mjs";
export { NO_REASON_GIVEN, reasonOf } from "./reason.mjs";
