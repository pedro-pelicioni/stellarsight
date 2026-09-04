#!/usr/bin/env node
/**
 * STELLARSIGHT — self-hosted x402 facilitator (RFP 3.1 "self-facilitation").
 *
 * We run our OWN facilitator. There is no dependency on any third-party relayer —
 * in particular NOT on the OpenZeppelin Channels relayer, which is AGPL and therefore
 * disqualifying for this project. All verify/settle cryptography comes from the
 * Apache-2.0 `@x402/stellar` package; we never reimplement it.
 *
 * Real symbols used:
 *   @x402/stellar/exact/facilitator -> ExactStellarScheme  (class; .verify/.settle)
 *   @x402/stellar                   -> createEd25519Signer
 *   @x402/core/facilitator          -> x402Facilitator     (class; .register/.registerExtension/.getSupported/.verify/.settle)
 *   @x402/extensions/bazaar         -> BAZAAR, validateAndExtract
 *
 * Ports: 4021 facilitator, 4022 bazaar index (packages/index mounted here).
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import { BAZAAR, validateAndExtract } from "@x402/extensions/bazaar";
import { createCatalog } from "../../../packages/index/src/index.mjs";
import { mountDiscoveryFallback, mountDiscoveryRoutes } from "../../../packages/index/src/http.mjs";

import { createFaucetHandler } from "./faucet.mjs";
import { createRateLimit, rateLimitStatus } from "./rate-limit.mjs";
import { authIdentity, remember, replayReason, seen } from "./settled-nonces.mjs";
import {
  fundedByFaucet,
  recordInferredProvenance,
} from "../../../packages/index/src/provenance-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });

const {
  STELLAR_RPC_URL = "https://soroban-testnet.stellar.org",
  ASSET_SAC,
  ASSET_CODE = "SXT",
  FEEPAYER_SECRET,
  SELLER_PUBLIC,
} = process.env;

const NETWORK = "stellar:testnet";
const FACILITATOR_PORT = 4021;
const INDEX_PORT = 4022;

if (!FEEPAYER_SECRET) {
  console.error("[facilitator] FEEPAYER_SECRET missing — run `npm run setup` first.");
  process.exit(1);
}
if (!ASSET_SAC) {
  console.error("[facilitator] ASSET_SAC missing — run `npm run setup` first.");
  process.exit(1);
}

const catalog = createCatalog();

// ---------------------------------------------------------------------------
// Durable store — the difference between "this instance saw a settlement" and
// "the public catalog holds it".
//
// A settle that only ever reached `catalog` above lives in THIS process's heap. Run the
// facilitator as a Vercel function (api/facilitator.mjs) and that heap is per-invocation:
// a third-party seller could settle through the hosted endpoint, watch the
// EXTENSION-RESPONSES header say `success`, and still never appear in the public
// /discovery/resources — because the instance that catalogued it is gone. Auto-cataloging
// that does not survive the process is a demo, not a Bazaar.
//
// So the same durable store that packages/index/src/serverless.mjs reads is written here,
// keyed by record id, with the POST-VALIDATION record (never the raw request body) so the
// store can never be used to smuggle a field past integrity.mjs.
//
// Optional by design: with no store configured this is null, every write is a no-op that
// reports `durable: false`, and the in-memory catalog behaves exactly as before.
// ---------------------------------------------------------------------------

let durableStore = null;
let storeStatus = { configured: false, reason: "no durable store configured" };

// The same key-value transport the faucet and the rate limiter use, resolved once and
// lazily so an unconfigured deployment simply has no live provenance rather than failing
// at boot. Separate from `durableStore`, which is the catalog's snapshot store.
let provenanceKvCache;
async function provenanceKv() {
  if (provenanceKvCache === undefined) {
    try {
      const mod = await import("../../../packages/index/src/store.mjs");
      provenanceKvCache = mod.createKv(process.env) ?? null;
    } catch {
      provenanceKvCache = null;
    }
  }
  return provenanceKvCache;
}

try {
  const storeMod = await import("../../../packages/index/src/store.mjs");
  durableStore = storeMod.createStore(process.env) ?? null;
  if (durableStore) {
    storeStatus = { configured: true, transport: durableStore.transport, key: durableStore.key };
    // Load what is already durable so the local index and the deployment agree from boot.
    const loaded = await durableStore.load();
    if (loaded.ok) {
      let restored = 0;
      for (const rec of loaded.records) {
        try {
          if (catalog.upsert(rec).ok) restored++;
        } catch {
          /* one bad stored record must not break the boot */
        }
      }
      console.log(
        `[index] durable store ${durableStore.transport}:${durableStore.host} — restored ${restored} record(s)`,
      );
    } else {
      storeStatus.error = loaded.reason;
      console.warn(`[index] durable store unreachable (${loaded.reason}) — catalog is in-memory only`);
    }
  }
} catch (e) {
  storeStatus = { configured: false, reason: `store module unavailable: ${e.message}` };
  console.warn(`[index] durable store disabled (${e.message})`);
}

/**
 * Persist a record the catalog has ALREADY validated and stored.
 *
 * Never throws and never blocks the caller's success path: a settlement that moved money
 * on Stellar is not retroactively a failure because Redis blinked. The outcome is
 * returned so the settle handler can report it honestly in EXTENSION-RESPONSES rather
 * than claiming a durability it did not get.
 */
async function persistRecord(id) {
  if (!durableStore) return { durable: false, reason: storeStatus.reason ?? "no durable store configured" };
  const stored = catalog.get?.(id);
  if (!stored) return { durable: false, reason: `record ${id} is not in the catalog` };
  try {
    const r = await durableStore.put(stored);
    return r.ok ? { durable: true } : { durable: false, reason: r.reason };
  } catch (e) {
    return { durable: false, reason: reasonOf(e, "durable write threw") };
  }
}

// ---------------------------------------------------------------------------
// Catalog seeding — a bazaar index with three entries makes discovery look like a toy
// and makes the ranker invisible. Load the demo corpus from packages/index/src/seed.mjs
// BEFORE any route is mounted, so the index is never observed in a half-seeded state.
//
// Ordering guarantees the live resources win: seeding happens here at boot, while the
// seller announces its real routes afterwards over POST /discovery/resources. `upsert`
// is keyed by id, so a live announcement overwrites any seed record sharing its id and
// clears the `seeded` flag with it. Seed records are additionally pinned to
// `settlements: 0` (see asSeedRecord) so they can never inflate an observed-settlement
// total. Set SEED_CATALOG=0 to boot an empty index.
// ---------------------------------------------------------------------------

const seedEnabled = process.env.SEED_CATALOG !== "0";

if (seedEnabled) {
  try {
    const { seedCatalog } = await import("../../../packages/index/src/seed.mjs");
    const summary = seedCatalog(catalog);
    console.log(
      `[index] seeded ${summary.inserted} demo records (catalog size ${catalog.size()})`,
    );
    if (summary.rejected?.length) {
      console.warn(`[index] ${summary.rejected.length} seed record(s) rejected:`);
      for (const r of summary.rejected) console.warn(`[index]   ${r.url} — ${r.reason}`);
    }
  } catch (e) {
    console.warn(`[index] catalog seeding skipped (${e.message}) — index starts empty`);
  }
} else {
  console.log("[index] catalog seeding disabled (SEED_CATALOG=0)");
}

// ---------------------------------------------------------------------------
// x402 wiring — all cryptography delegated to @x402/stellar (Apache-2.0).
// FEEPAYER signs AND acts as feeBumpSigner, so the paying agent needs zero XLM.
// ---------------------------------------------------------------------------

const feePayerSigner = createEd25519Signer(FEEPAYER_SECRET, NETWORK);

// `maxTransactionFeeStroops` is a SAFETY CEILING, not a fee we pay. @x402/stellar
// simulates the transfer, and if the simulation-derived fee exceeds this number it
// refuses at /verify before any money moves. Its default is 50_000.
//
// That default is too tight for this scheme and was empirically breaking payments.
// A SEP-41 SAC transfer with a sponsored fee bump simulates around 57_000 stroops on
// testnet today — above the default — and the margin moves with network load, so the
// failure is intermittent: it disappears when you test and returns under load, which
// is the worst way for a reviewer to meet it. Observed: four consecutive /verify
// rejections at 57_031–57_038 stroops, and a settlement that squeaked through at
// max_fee 57_227 an hour later.
//
// 500_000 stroops is 0.05 XLM. It is 8.7x the observed simulation and still small
// enough to catch a genuinely runaway transaction, which is what the ceiling is for.
// The FEEPAYER pays this, never the buyer.
// A malformed env value must fall back to the calibrated default, not become NaN —
// every NaN comparison is false, which would silently remove the ceiling.
const maxFeeFromEnv = Number(process.env.MAX_TRANSACTION_FEE_STROOPS ?? 500_000);
const MAX_TRANSACTION_FEE_STROOPS =
  Number.isFinite(maxFeeFromEnv) && maxFeeFromEnv > 0 ? maxFeeFromEnv : 500_000;

// The facilitator fee, in basis points. It is zero, and the RFP's requirement is that any
// fee be configurable rather than hard wired — so it is read here rather than assumed,
// documented in docs/DEPLOY.md, and reported on /health.
//
// Fee collection itself is Tranche 3 work, inside the audit scope, because taking a cut of
// a settlement changes the amount a buyer authorized and that is not a change to ship
// unaudited. Until then a non-zero value is refused at boot rather than silently ignored:
// an operator who configures a fee and receives none has been lied to by their own config,
// which is the failure mode FEEPAYER_SECRET is already handled this way to avoid.
const FEE_BPS = Number.parseInt(String(process.env.FACILITATOR_FEE_BPS ?? '0'), 10) || 0;
if (FEE_BPS !== 0) {
  console.error(
    `[facilitator] FACILITATOR_FEE_BPS=${FEE_BPS} but fee collection is not implemented ` +
      `(Tranche 3, inside the audit scope). Refusing to start rather than charging nothing ` +
      `while claiming a fee — see docs/DEPLOY.md#the-business-model.`,
  );
  process.exit(1);
}

const stellarScheme = new ExactStellarScheme([feePayerSigner], {
  rpcConfig: { url: STELLAR_RPC_URL },
  areFeesSponsored: true,
  feeBumpSigner: feePayerSigner,
  maxTransactionFeeStroops: MAX_TRANSACTION_FEE_STROOPS,
});

const facilitator = new x402Facilitator().register(NETWORK, stellarScheme);
try {
  facilitator.registerExtension(BAZAAR);
} catch (e) {
  console.warn(`[facilitator] BAZAAR extension registration failed: ${e.message}`);
}

// ---------------------------------------------------------------------------
// SSE event bus — lets the web console watch the payment loop live.
// ---------------------------------------------------------------------------

const sseClients = new Set();

function emit(event) {
  const payload = { ts: Date.now(), ...event };
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
  console.log(`[event] ${payload.type}`, payload.detail ?? "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accept both spec field names and common aliases so we never 400 on a nit. */
function readPaymentBody(body = {}) {
  const paymentPayload = body.paymentPayload ?? body.payload ?? body.payment;
  const paymentRequirements =
    body.paymentRequirements ?? body.requirements ?? body.accepts?.[0];
  return { paymentPayload, paymentRequirements };
}

/** Every rejection MUST carry a non-null human-readable reason (RFP hard criterion). */
function reasonOf(value, fallback) {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    const s = value.message ?? value.reason ?? value.error;
    if (typeof s === "string" && s.trim()) return s;
  }
  return fallback;
}

/** Turn a machine code such as `unexpected_verify_error` into a readable sentence. */
function humanize(code) {
  const words = String(code).replace(/[_-]+/g, " ").trim();
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Build the human-readable rejection reason the RFP requires.
 *
 * `@x402/stellar` reports failures as short machine codes (`unexpected_verify_error`,
 * `insufficient_funds`, …) and sometimes a richer `invalidMessage`/`errorMessage`.
 * A bare code is not human-readable, so we always emit a sentence and keep the raw
 * code appended in brackets for machine consumers.
 */
function explainRejection(result, codeField, messageField, fallback) {
  const code = result?.[codeField];
  const message = result?.[messageField];

  const hasSentence = typeof message === "string" && message.trim().length > 0;
  const hasCode = typeof code === "string" && code.trim().length > 0;

  if (hasSentence && hasCode) return `${message.trim()} [${code.trim()}]`;
  if (hasSentence) return message.trim();
  if (hasCode) {
    const readable = humanize(code);
    // Already a sentence (contains a space)? Then leave it be.
    return code.includes(" ") ? code : `${readable} [${code.trim()}]`;
  }
  return fallback;
}

function encodeExtensionResponses(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/**
 * Where the seller's bazaar extension block actually sits.
 *
 * The client echoes it from PaymentRequired into PaymentPayload, so the payload copy is
 * the one that crossed the trust boundary and the one worth validating. The others are
 * checked because older sellers put it elsewhere.
 */
function readDiscoveryBlock(paymentPayload, paymentRequirements) {
  return (
    paymentPayload?.extensions?.bazaar ??
    paymentRequirements?.extensions?.bazaar ??
    paymentRequirements?.extra?.bazaar ??
    paymentRequirements?.outputSchema?.bazaar ??
    null
  );
}

/**
 * Validate the seller's `info` against the `schema` it supplied, using the stock helper.
 *
 * RFP 3.2 is specific about this: the facilitator "validates `info` against the supplied
 * `schema` and catalogs the resource with no separate registration step". We were not
 * doing the first half.
 *
 * `validateAndExtract` takes ONE argument — the discovery extension — and this code passed
 * it two, `(paymentRequirements, paymentPayload)`. That call returns
 * `{valid:false, errors:["Schema validation failed: schema must be object or boolean"]}`
 * for every input, because the first argument is not an extension. The guard below it then
 * rejected the result and the loop fell through to a raw, unvalidated read of the same
 * block. So the stock validator never ran, on any payment, and a listing whose `info`
 * contradicted its own `schema` was catalogued anyway.
 *
 * Called correctly the helper does exactly what the RFP describes — a `serviceName` typed
 * as a number against a schema declaring `string` comes back
 * `{valid:false, errors:["/serviceName: must be string"]}`.
 *
 * Returns `{ ok: true, discovery }` or `{ ok: false, reason }`; the reason reaches the
 * seller through EXTENSION-RESPONSES, so a rejected listing says why.
 */
function readDiscovery(paymentPayload, paymentRequirements) {
  const block = readDiscoveryBlock(paymentPayload, paymentRequirements);
  if (!block) return { ok: false, reason: null }; // nothing to catalog; not an error

  if (typeof validateAndExtract === "function") {
    try {
      const out = validateAndExtract(block);
      if (out?.valid === false) {
        const errors = Array.isArray(out.errors) ? out.errors.join("; ") : "schema validation failed";
        return { ok: false, reason: `discovery info does not satisfy the schema the seller supplied: ${errors}` };
      }
      // The helper returns the validated `info`; keep the rest of the block (input,
      // schema, extensions) so the catalog record keeps everything it needs.
      if (out?.valid === true) return { ok: true, discovery: { ...block, info: out.info ?? block.info } };
    } catch (e) {
      // A helper that throws is an upstream problem, not a seller problem. Fall through to
      // the raw block rather than refusing a listing over it, and say so.
      emit({ type: "catalog", ok: false, detail: `validateAndExtract threw (${reasonOf(e, "unknown")}) — cataloging unvalidated` });
    }
  }

  return { ok: true, discovery: block };
}

/**
 * Map an x402 settle into the canonical catalog record from CONTRACT.md.
 *
 * NOTE on shapes: in x402 **v2** the resource metadata lives on
 * `PaymentPayload.resource` (a ResourceInfo), NOT on PaymentRequirements, and the
 * price field is `amount` — v1 called it `maxAmountRequired` and inlined the
 * resource. We read both so either version settles cleanly.
 */
function toCatalogRecord(paymentPayload, paymentRequirements, discovery) {
  const info = discovery?.info ?? discovery ?? {};
  const input = info.input ?? {};

  // v2: payload.resource (ResourceInfo). v1: requirements.resource (a bare url string).
  const resourceInfo =
    paymentPayload?.resource ??
    (typeof paymentRequirements?.resource === "string"
      ? { url: paymentRequirements.resource, description: paymentRequirements.description }
      : (paymentRequirements?.resource ?? {}));

  // Key the record by the WHATWG-normalized href so the prior-settlements lookup on the
  // settle path hits the same id that catalog.upsert stores under (upsert keys on
  // url.href — a raw "https://api.example.com" would otherwise miss its own stored
  // record forever and pin the settlement counter at 1).
  const rawUrl = resourceInfo.url ?? "";
  let url;
  try {
    url = new URL(rawUrl).href;
  } catch {
    url = rawUrl;
  }
  const meta = paymentRequirements?.extra ?? {};
  const id = input.toolName ? `${url}#${input.toolName}` : url;

  return {
    id,
    resource: {
      url,
      serviceName: resourceInfo.serviceName ?? meta.serviceName ?? "stellarsight-seller",
      tags: resourceInfo.tags ?? discovery?.tags ?? meta.tags ?? [],
      iconUrl: resourceInfo.iconUrl ?? discovery?.iconUrl ?? meta.iconUrl,
      description: resourceInfo.description ?? paymentRequirements?.description ?? "",
    },
    type: input.type === "mcp" ? "mcp" : "http",
    network: paymentRequirements?.network ?? NETWORK,
    scheme: paymentRequirements?.scheme ?? "exact",
    payTo: paymentRequirements?.payTo ?? SELLER_PUBLIC,
    asset: paymentRequirements?.asset ?? ASSET_SAC,
    // The requirements' extra rides into the catalog so distinct offerings of the
    // same resource (e.g. two upto profiles) keep their identity — see issue #1.
    extra: paymentRequirements?.extra,
    maxAmountRequired: String(
      paymentRequirements?.amount ?? paymentRequirements?.maxAmountRequired ?? "0",
    ),
    input,
    output: info.output ?? { type: "json" },
    routeTemplate: discovery?.routeTemplate ?? info.routeTemplate,
    extensions: ["bazaar"],
    lastSeenAt: Date.now(),
    settlements: 1,
  };
}

// ---------------------------------------------------------------------------
// Facilitator app (4021)
// ---------------------------------------------------------------------------

const app = express();
app.use(cors({ origin: true, exposedHeaders: ["EXTENSION-RESPONSES", "X-PAYMENT-RESPONSE"] }));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "stellarsight-facilitator",
    network: NETWORK,
    asset: ASSET_SAC,
    assetCode: ASSET_CODE,
    feePayer: feePayerSigner.address,
    areFeesSponsored: true,
    catalogSize: catalog.size(),
    // Whether a settlement through THIS facilitator ends up in the durable public
    // catalog or only in this process's heap. A reviewer settling against the hosted
    // endpoint should be able to read the answer, not infer it.
    durableCataloging: {
      enabled: Boolean(durableStore),
      transport: durableStore?.transport ?? null,
      ...(storeStatus.error ? { error: storeStatus.error } : {}),
      ...(durableStore ? {} : { reason: storeStatus.reason }),
    },
    // The rate-limit policy in force on /verify and /settle, so an operator or a caller
    // can read it rather than discover it by getting a 429.
    rateLimit: rateLimitStatus(),
    // The fee this facilitator takes. Zero, configurable, and reported rather than
    // assumed — a self-hoster inherits no fee from this deployment.
    fee: { basisPoints: FEE_BPS, configurable: true, variable: "FACILITATOR_FEE_BPS" },
  });
});

app.get("/supported", (_req, res) => {
  let kinds;
  try {
    const supported = facilitator.getSupported();
    kinds = (supported.kinds ?? []).map((k) => ({
      ...k,
      x402Version: k.x402Version ?? 2,
      extra: { ...(k.extra ?? {}), areFeesSponsored: true, asset: ASSET_SAC },
    }));
  } catch (e) {
    console.warn(`[supported] getSupported failed (${e.message}) — using static kind`);
    kinds = [];
  }
  if (!kinds.length) {
    kinds = [
      {
        x402Version: 2,
        scheme: "exact",
        network: NETWORK,
        extra: { areFeesSponsored: true, asset: ASSET_SAC },
      },
    ];
  }
  res.json({ kinds });
});

// The two endpoints that spend this deployment's resources: /verify simulates against
// RPC, /settle submits and sponsors the fee. /supported, /health and /events are cheap
// reads and stay unlimited — /supported in particular is an RFP acceptance criterion and
// must answer a stock client unconditionally. Policy, defaults and the reasoning are in
// docs/DEPLOY.md; set FACILITATOR_RATE_LIMIT=0 to turn it off entirely.
const rateLimit = createRateLimit();

app.post("/verify", rateLimit, async (req, res) => {
  const { paymentPayload, paymentRequirements } = readPaymentBody(req.body);

  if (!paymentPayload || !paymentRequirements) {
    const invalidReason =
      "Request body must include both `paymentPayload` and `paymentRequirements`.";
    emit({ type: "verify", ok: false, detail: invalidReason });
    return res.status(400).json({ isValid: false, invalidReason, payer: null });
  }

  // Before delegating: is this an entry we already settled? The scheme would refuse it
  // anyway — the chain does — but it would refuse it as
  // `invalid_exact_stellar_payload_simulation_failed`, which tells the caller nothing it
  // can branch on. See apps/facilitator/src/settled-nonces.mjs for why this is a naming
  // layer and not a security boundary.
  const identity = authIdentity(paymentPayload);
  const known = await seen(identity);
  if (known.seen) {
    const invalidReason = replayReason(identity);
    emit({ type: "verify", ok: false, payer: identity.address, detail: invalidReason });
    return res.json({ isValid: false, invalidReason, payer: identity.address });
  }

  try {
    const result = await facilitator.verify(paymentPayload, paymentRequirements);
    const isValid = Boolean(result?.isValid);
    const invalidReason = isValid
      ? null
      : explainRejection(
          result,
          "invalidReason",
          "invalidMessage",
          "Payment verification failed for an unspecified reason.",
        );
    const payer = result?.payer ?? paymentPayload?.payload?.from ?? null;

    emit({
      type: "verify",
      ok: isValid,
      payer,
      detail: isValid ? "payment authorization valid" : invalidReason,
    });
    return res.json({ isValid, invalidReason, payer });
  } catch (e) {
    const invalidReason = reasonOf(e, "Verification threw an unexpected error.");
    emit({ type: "verify", ok: false, detail: invalidReason });
    return res.json({ isValid: false, invalidReason, payer: null });
  }
});

app.post("/settle", rateLimit, async (req, res) => {
  const { paymentPayload, paymentRequirements } = readPaymentBody(req.body);

  if (!paymentPayload || !paymentRequirements) {
    const errorReason =
      "Request body must include both `paymentPayload` and `paymentRequirements`.";
    emit({ type: "settle", ok: false, detail: errorReason });
    return res.status(400).json({
      success: false,
      errorReason,
      transaction: null,
      network: NETWORK,
      payer: null,
    });
  }

  let bazaarResponse = null;

  const identity = authIdentity(paymentPayload);
  const known = await seen(identity);
  if (known.seen) {
    const errorReason = replayReason(identity);
    emit({ type: "settle", ok: false, payer: identity.address, detail: errorReason });
    return res.json({
      success: false,
      errorReason,
      transaction: null,
      network: NETWORK,
      payer: identity.address,
    });
  }

  try {
    const result = await facilitator.settle(paymentPayload, paymentRequirements);
    const success = Boolean(result?.success);
    const errorReason = success
      ? null
      : explainRejection(
          result,
          "errorReason",
          "errorMessage",
          "Settlement failed for an unspecified reason.",
        );
    const transaction = result?.transaction ?? null;
    const payer = result?.payer ?? paymentPayload?.payload?.from ?? null;

    emit({
      type: "settle",
      ok: success,
      payer,
      transaction,
      explorer: transaction
        ? `https://stellar.expert/explorer/testnet/tx/${transaction}`
        : null,
      detail: success ? "settled on stellar testnet" : errorReason,
    });

    // Remember the nonce only once the settlement actually happened. Recording at verify
    // time — or on a failed settle — would make the very next legitimate attempt look
    // like a replay of itself.
    if (success && identity) {
      const noted = await remember(identity);
      if (!noted.ok) {
        // Losing this record costs a future replay its precise name, nothing more.
        emit({ type: "settle", ok: true, detail: `settled; nonce not recorded: ${noted.reason}` });
      }
    }

    // --- provenance for traffic THIS deployment settles ---
    //
    // docs/status/provenance.json only covers payments a script generated, and the feed
    // reads it out of the deployed bundle — so anything settled through the hosted stack
    // after the last commit had no way to be labelled and rendered as `unlabeled`. Honest,
    // but it left the default carrying most of the public feed.
    //
    // The one thing this can honestly attribute is a payer whose money came out of our own
    // public faucet: that makes the payment demo traffic rather than demand. It is an
    // inference, it is recorded as one, and a script's assertion always outranks it.
    if (success && transaction) {
      try {
        const kv = await provenanceKv();
        if (kv && (await fundedByFaucet(kv, payer))) {
          await recordInferredProvenance(kv, transaction, "demo", {
            basis: "payer was funded by this deployment's public faucet",
            payer,
          });
        }
      } catch (e) {
        // Labelling must never cost a settlement, and an unlabelled row is the safe
        // outcome anyway.
        emit({ type: "settle", ok: true, detail: `settled; provenance not recorded: ${e?.message ?? e}` });
      }
    }

    // --- bazaar discovery: auto-catalog the resource on a successful settle ---
    if (success) {
      const extracted = readDiscovery(paymentPayload, paymentRequirements);

      // A listing whose `info` contradicts its own `schema` is refused, and the seller is
      // told why through EXTENSION-RESPONSES rather than being left to wonder why the
      // resource never appeared. The payment itself already settled and is untouched by
      // this — cataloging is a side effect of settlement, not a condition of it.
      if (!extracted.ok && extracted.reason) {
        bazaarResponse = { status: "rejected", rejectedReason: extracted.reason };
        emit({ type: "catalog", ok: false, detail: extracted.reason });
      }

      const discovery = extracted.ok ? extracted.discovery : null;
      if (discovery) {
        try {
          const record = toCatalogRecord(paymentPayload, paymentRequirements, discovery);
          // Prefer the O(1) keyed lookup. The previous `list({ limit: 1000 })` scan was
          // silently capped at the catalog's MAX_LIMIT of 100 — harmless while the index
          // held three records, but now that it boots seeded a resource beyond the first
          // page would look brand new and have its settlement history reset on every
          // settle. `list` stays as the fallback for the in-memory stub, which has no get().
          const prior =
            catalog.get?.(record.id) ??
            catalog.list({ limit: 100 }).items.find((i) => i.id === record.id);
          if (prior) record.settlements = (prior.settlements ?? 0) + 1;

          const up = catalog.upsert(record);
          if (up?.ok) {
            // Durability is part of cataloging, not an afterthought: a seller who settles
            // through the hosted facilitator must still be discoverable after this
            // process is gone. `durable` is reported rather than assumed — a store that
            // rejected the write says so here instead of in a support thread later.
            const persisted = await persistRecord(up.id ?? record.id);
            bazaarResponse = persisted.durable
              ? { status: "success" }
              : durableStore
                ? { status: "success", note: `cataloged, but the durable write failed: ${persisted.reason}` }
                : { status: "success" };
            emit({
              type: "catalog",
              ok: true,
              id: record.id,
              settlements: record.settlements,
              durable: persisted.durable,
              detail: `cataloged ${record.id}${persisted.durable ? " (durable)" : ""}`,
            });
          } else {
            bazaarResponse = {
              status: "rejected",
              rejectedReason: reasonOf(up?.reason, "Catalog rejected the resource record."),
            };
            emit({ type: "catalog", ok: false, detail: bazaarResponse.rejectedReason });
          }
        } catch (e) {
          bazaarResponse = {
            status: "rejected",
            rejectedReason: reasonOf(e, "Cataloging threw an unexpected error."),
          };
          emit({ type: "catalog", ok: false, detail: bazaarResponse.rejectedReason });
        }
      }
    }

    if (bazaarResponse) {
      res.setHeader("EXTENSION-RESPONSES", encodeExtensionResponses({ bazaar: bazaarResponse }));
    }
    return res.json({ success, errorReason, transaction, network: NETWORK, payer });
  } catch (e) {
    const errorReason = reasonOf(e, "Settlement threw an unexpected error.");
    emit({ type: "settle", ok: false, detail: errorReason });
    return res.json({
      success: false,
      errorReason,
      transaction: null,
      network: NETWORK,
      payer: null,
    });
  }
});

app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
  res.write(`data: ${JSON.stringify({ type: "hello", ts: Date.now(), detail: "connected" })}\n\n`);
  sseClients.add(res);

  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* connection closing */
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

/**
 * POST /playground/fund — the browser playground's SXT drip.
 *
 * Mounted on the facilitator app so `npm run dev:all` serves it at :4021 and the same
 * handler answers on the deployment through api/playground/fund.mjs. The guards (testnet
 * lock, per-account / per-IP / global caps, trustline precondition) live in the handler,
 * not here.
 */
app.post("/playground/fund", createFaucetHandler());

/**
 * GET /explorer/feed — the settlement feed the web explorer polls.
 *
 * Mounted here for the same reason the faucet is: `npm run dev:all` and the deployment
 * must answer the same paths, or the dev stack quietly diverges from the thing reviewers
 * actually see. The handler is the deployed function itself, imported.
 *
 * FEEPAYER_PUBLIC is what the feed keys on; locally it is derived from the fee-payer
 * secret already in .env, so a developer does not have to add a second variable that
 * says the same thing.
 */
app.get("/explorer/feed", async (req, res) => {
  process.env.FEEPAYER_PUBLIC ??= feePayerSigner.address;
  const { default: explorerFeed } = await import("../../../api/explorer/feed.mjs");
  return explorerFeed(req, res);
});

// ---------------------------------------------------------------------------
// Bazaar index app (4022) — HTTP surface over packages/index.
// ---------------------------------------------------------------------------

const indexApp = express();
indexApp.use(cors({ origin: true }));
indexApp.use(express.json({ limit: "2mb" }));

indexApp.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "stellarsight-index",
    size: catalog.size(),
    // The routes come from packages/index/src/discovery.mjs — the same wire format the
    // deployment serves.
    wireShape: "spec",
    durableStore: durableStore ? { transport: durableStore.transport, key: durableStore.key } : null,
  }),
);

/**
 * GET /discovery/resources and GET /discovery/search come from packages/index/src/discovery.mjs
 * — the same binding api/discovery/* serves, so a stock withBazaar() client reads :4022 and
 * the deployment identically.
 */
{
  const { paths } = mountDiscoveryRoutes(indexApp, catalog);
  console.log(`[index] discovery routes mounted from packages/index: ${paths.join(", ")}`);
}

/** Lets the seller pre-register routes at boot so discovery works before any payment. */
indexApp.post("/discovery/resources", async (req, res) => {
  try {
    const out = catalog.upsert(req.body);
    if (!out?.ok) {
      return res.status(400).json(out ?? { ok: false, dropped: [], reason: "upsert failed" });
    }
    // Pre-registration is durable too, for the same reason settle-time cataloging is:
    // the announcement outlives the process that received it.
    const persisted = await persistRecord(out.id ?? req.body?.id);
    emit({
      type: "catalog",
      ok: true,
      id: req.body?.id,
      durable: persisted.durable,
      detail: `pre-registered${persisted.durable ? " (durable)" : ""}`,
    });
    return res.status(200).json({ ...out, durable: persisted.durable, ...(persisted.reason ? { durableReason: persisted.reason } : {}) });
  } catch (e) {
    return res.status(400).json({ ok: false, dropped: [], reason: reasonOf(e, "upsert failed") });
  }
});

/**
 * The JSON 404 for unknown /discovery/* paths, matching what api/discovery/unknown.mjs
 * serves on the deployment. Mounted here, last, because it matches every remaining path
 * under /discovery — registering it inside mountDiscoveryRoutes would have shadowed the
 * POST write path above.
 */
mountDiscoveryFallback(indexApp, {
  endpoints: ["/discovery/resources", "/discovery/search", "/discovery/integrity"],
});

// ---------------------------------------------------------------------------
// Boot
//
// Only when executed directly (`node apps/facilitator/src/server.mjs`). When this module
// is imported — api/facilitator.mjs wraps `app` as a Vercel function so /supported,
// /verify and /settle answer on the public domain — binding ports would crash the
// runtime. indexApp stays local-only either way; the deployed discovery API is
// api/discovery/*. Both mount the same mountDiscoveryRoutes from packages/index, so the two
// surfaces agree on the wire format and write through the same durable store.
// ---------------------------------------------------------------------------

const runDirect =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (runDirect) {
  app.listen(FACILITATOR_PORT, () => {
    console.log(`\n[facilitator] x402 facilitator  http://localhost:${FACILITATOR_PORT}`);
    console.log(`[facilitator]   GET  /supported  /health  /events`);
    console.log(`[facilitator]   POST /verify     /settle`);
    console.log(`[facilitator]   asset   ${ASSET_CODE} ${ASSET_SAC}`);
    console.log(`[facilitator]   feePayer ${feePayerSigner.address} (fees sponsored)`);
  });

  // Loopback only: the local index carries an unauthenticated write path (the deployed
  // write path is bearer-gated in serverless.mjs), so it must never bind a public
  // interface. Public discovery reads belong to api/discovery/* or mountDiscoveryRoutes
  // mounted on a host the operator controls.
  indexApp.listen(INDEX_PORT, "127.0.0.1", () => {
    console.log(`[index]       bazaar index    http://localhost:${INDEX_PORT}`);
    console.log(`[index]         GET /discovery/resources  /discovery/search\n`);
  });
}

export { app, indexApp };
