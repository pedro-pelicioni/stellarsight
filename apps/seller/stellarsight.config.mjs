/**
 * apps/seller/stellarsight.config.mjs — the `stellarsight-seller check` config for this
 * demo seller.
 *
 * src/server.mjs implements the x402 challenge INLINE against the facilitator rather
 * than through @stellarsight/express (see that file's own header for why: it keeps the
 * exact wire shapes under direct control). That means there is no live `pay` instance
 * for the CLI to point at, so this file re-declares the same three routes — mirroring
 * server.mjs's `ROUTES`, the way `announceRecordFor()` in packages/express/src/route.mjs
 * already documents that it mirrors this app's `preRegister()` — through the real
 * @stellarsight/express API, purely so `npx stellarsight-seller check` has a paywall
 * config to validate. It is never imported by the running seller; keep it in sync with
 * `ROUTES` by hand if that array changes.
 *
 * Run from apps/seller:
 *
 *   npx stellarsight-seller check
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { stellarsightPaywall } from "@stellarsight/express";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });

const {
  ASSET_SAC,
  ASSET_CODE = "SXT",
  SELLER_PUBLIC,
  FACILITATOR_URL = "http://localhost:4021",
  INDEX_URL = "http://localhost:4022",
  SELLER_URL = "http://localhost:4023",
} = process.env;

const pay = stellarsightPaywall({
  facilitator: FACILITATOR_URL,
  payTo: SELLER_PUBLIC,
  asset: ASSET_SAC,
  assetCode: ASSET_CODE,
  baseUrl: SELLER_URL,
  index: INDEX_URL,
  network: "stellar:testnet",
  // This module is checked, never served — no boot announcement to arm.
  announce: false,
});

pay("/v1/fx/usd-brl", {
  price: "0.01",
  serviceName: "stellarsight-fx",
  description: "USD/BRL exchange rate with bid, ask and mid price.",
  // The bazaar keeps at most 5 tags (packages/index/src/integrity.mjs); server.mjs's
  // ROUTES declares 6 for this route ("finance" is the sixth), which the index silently
  // drops. Capped at 5 here so `check` demonstrates a clean listing rather than the drop.
  tags: ["fx", "forex", "usd", "brl", "quote"],
  input: {},
  inputSchema: { properties: {}, required: [] },
  output: {
    example: {
      pair: "USD/BRL",
      bid: 5.4312,
      ask: 5.4389,
      mid: 5.435,
      asOf: "2026-08-06T12:00:00.000Z",
      source: "stellarsight-mock",
    },
  },
});

pay("/v1/cep/:cep", {
  routeTemplate: "/v1/cep/:cep",
  price: "0.005",
  serviceName: "stellarsight-postal",
  description: "Brazilian postal code lookup returning street, neighborhood, city and state.",
  tags: ["postal-code", "address", "brazil", "geocoding", "lookup"],
  input: { cep: "01310100" },
  inputSchema: {
    properties: {
      cep: {
        type: "string",
        description: "Brazilian postal code, 8 digits, hyphen optional. Example: 01310100.",
      },
    },
    required: ["cep"],
  },
  pathParams: { cep: "01310100" },
  pathParamsSchema: {
    properties: {
      cep: { type: "string", description: "Brazilian postal code, 8 digits, hyphen optional." },
    },
    required: ["cep"],
  },
  output: {
    example: {
      postalCode: "01310-100",
      street: "Avenida Paulista",
      neighborhood: "Bela Vista",
      city: "Sao Paulo",
      state: "SP",
      country: "BR",
    },
  },
});

pay("/v1/ocr/nota-fiscal", {
  method: "POST",
  price: "0.05",
  serviceName: "stellarsight-ocr",
  description:
    "Invoice OCR — Brazilian electronic invoice (NF-e), returning structured line items and totals.",
  // Same 5-tag cap as the fx route above — "extraction" is server.mjs's sixth tag.
  tags: ["ocr", "invoice", "nfe", "brazil", "document"],
  bodyType: "json",
  input: { imageUrl: "https://example.com/invoice.png", language: "pt-BR" },
  inputSchema: {
    properties: {
      imageUrl: {
        type: "string",
        description: "Publicly reachable URL of the invoice image or PDF to run OCR against.",
      },
      imageBase64: {
        type: "string",
        description: "Base64-encoded invoice image. Supply this instead of imageUrl for private documents.",
      },
      language: { type: "string", description: "BCP-47 language tag for the document. Defaults to pt-BR." },
    },
    required: ["imageUrl"],
  },
  output: {
    example: {
      documentType: "NFe",
      accessKey: "35240612345678000199550010000012341000012345",
      issuer: { name: "Example Trading Ltd", taxId: "12.345.678/0001-99" },
      total: 1234.56,
      currency: "BRL",
      lineItems: [{ description: "Item A", quantity: 2, unitPrice: 100, total: 200 }],
      confidence: 0.97,
    },
  },
});

export default pay;
