/**
 * @stellarsight/express — the paywall.
 *
 * One `stellarsightPaywall(...)` call owns the whole x402 loop for a server:
 *
 *   1. no payment            -> 402 + `PAYMENT-REQUIRED` (base64 of the PaymentRequired object)
 *   2. `PAYMENT-SIGNATURE`   -> decode with @x402/core's own codec
 *   3. re-derive the price   -> compare the client's echo, reject any mismatch
 *   4. POST /verify          -> facilitator says yes or gives a reason
 *   5. POST /settle          -> facilitator moves the money or gives a reason
 *   6. `PAYMENT-RESPONSE` + `EXTENSION-RESPONSES` forwarded, `req.stellarsight` populated, next()
 *
 * WIRE FORMAT. Every base64 payload is produced and consumed by `@x402/core/http`'s own
 * encoders/decoders, never by hand. The v2 HTTP transport puts the challenge in the
 * `PAYMENT-REQUIRED` *header* and calls the body "a server implementation concern"; we
 * mirror the same object into the JSON body purely so `curl` and pre-header v1 clients see
 * something useful. `X-PAYMENT` (request) and `X-PAYMENT-RESPONSE` (response) are the v1
 * spellings, accepted and emitted for backwards compatibility. Nothing here depends on them.
 *
 * TRUST. `paymentPayload.accepted` is attacker-controlled. It is compared against the
 * server's own requirements and then discarded — `/verify` and `/settle` are always called
 * with the requirements re-derived from the route declaration.
 *
 * REASONS. Every 402 this file emits carries a non-null, human-readable `error`. See
 * reason.mjs: there is exactly one funnel and it substitutes a sentence when a component
 * rejects without explaining itself.
 */

import {
  PAYMENT_REQUIRED_CACHE_CONTROL,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";

import { parseAtomicUnits } from "./amount.mjs";
import { createAnnouncer } from "./announce.mjs";
import { checkListings } from "./check.mjs";
import { normalizeConfig } from "./config.mjs";
import { postJson } from "./http.mjs";
import { NO_REASON_GIVEN, reasonOf, snippet } from "./reason.mjs";
import {
  announceRecordFor,
  compileRoute,
  discoveryFor,
  learnPath,
  paymentRequiredFor,
  publicViewOf,
  requirementsFor,
  resourceInfoFor,
} from "./route.mjs";

/**
 * Create a paywall bound to one facilitator, one asset and one payee.
 *
 * @param {object} options - see the package README
 * @returns {Function & {routes: Function, wellKnown: Function, wellKnownHandler: Function, announce: Function, stop: Function, config: object}}
 */
export function stellarsightPaywall(options) {
  const config = normalizeConfig(options);
  const routes = [];
  const announcer = createAnnouncer(config, routes);

  /**
   * `pay(routeConfig)` or `pay(path, routeConfig)` -> an Express middleware.
   * Passing the path lets the route be announced to the bazaar at boot instead of
   * waiting for its first request.
   */
  function pay(a, b) {
    const declaration =
      typeof a === "string" ? { ...(b ?? {}), path: a } : a === undefined ? {} : a;
    const route = compileRoute(declaration, config);
    routes.push(route);
    announcer.schedule();
    return makeMiddleware(route, config, announcer);
  }

  pay.routes = () => routes.map((r) => publicViewOf(r, config));

  /**
   * The exact records `pay.announce()` would POST to the bazaar index, one per declared
   * route, without sending any of them. A route with no known path yet (see `learnPath`)
   * has nothing announceable, so its `record` is `null` — the same case `announce()`
   * itself skips.
   */
  pay.announceRecords = () =>
    routes.map((r) => ({
      method: r.method,
      path: r.path,
      record: r.path ? announceRecordFor(r, config, config.baseUrl) : null,
    }));

  pay.wellKnown = (origin) => {
    const base = origin ?? config.baseUrl ?? "";
    return {
      x402Version: config.x402Version,
      resources: routes
        .filter((r) => r.path)
        .map((r) => ({
          resource: resourceInfoFor(r, base),
          accepts: [requirementsFor(r, config)],
          extensions: discoveryFor(r),
          routeTemplate: r.routeTemplate,
        })),
    };
  };

  pay.wellKnownHandler = () => (req, res) => res.json(pay.wellKnown(originFor(req, config)));

  pay.announce = (opts) => announcer.run({ quiet: false, ...opts });

  /**
   * Locally replay every announce record through the bazaar index's OWN integrity
   * validator (`@stellarsight/index`) — no facilitator or index needs to be running.
   * This is what the `stellarsight-seller check` CLI calls; see check.mjs.
   */
  pay.check = () => checkListings(pay);

  pay.stop = () => announcer.stop();

  pay.config = Object.freeze({
    facilitator: config.facilitator,
    index: config.index,
    baseUrl: config.baseUrl,
    payTo: config.payTo,
    asset: config.asset,
    assetCode: config.assetCode,
    network: config.network,
    scheme: config.scheme,
    decimals: config.decimals,
    x402Version: config.x402Version,
  });

  return pay;
}

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

function makeMiddleware(route, config, announcer) {
  const handle = makeHandler(route, config, announcer);

  /**
   * The exported middleware is a thin shell whose only job is that NOTHING escapes.
   *
   * An async middleware that rejects is not a 500 on every Express: on Express 4 —
   * a declared peer — the rejection is unhandled, which under Node's default
   * `--unhandled-rejections=throw` kills the seller's process outright, and the paying
   * agent gets no response and no reason at all. That is the one rejection path this
   * package must never have, so every throw is funnelled back into a reasoned 402.
   */
  return function stellarsightPaywallMiddleware(req, res, next) {
    let promise;
    try {
      promise = handle(req, res, next);
    } catch (e) {
      return failSafe(e, req, res, next, route, config);
    }
    return Promise.resolve(promise).catch((e) => failSafe(e, req, res, next, route, config));
  };
}

/**
 * Last line of defence. Turns an unexpected throw into a reasoned 402 — never a silent
 * hang, never an HTML stack trace, never a served resource.
 */
function failSafe(error, req, res, next, route, config) {
  const reason = reasonOf(error, "the paywall failed unexpectedly");
  config.logger.error(`[stellarsight] ${route.method} ${route.path ?? "?"} failed unexpectedly: ${reason}`);

  if (res.headersSent || res.writableEnded) return next(error);

  // A receipt may already be staged from a settlement that then failed to complete.
  // Serving a 402 that still carries it would be a lie about what happened.
  for (const name of ["PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE", "EXTENSION-RESPONSES"]) {
    try {
      res.removeHeader?.(name);
    } catch {
      /* header bag already flushed — the guard above is the real check */
    }
  }

  const sentence =
    `This request could not be completed: ${snippet(reason, 300)}. ` +
    "The resource was not served. If your payment settled, keep the transaction id and contact the operator " +
    "before paying again.";

  try {
    return send402(res, route, config, originFor(req, config), sentence, req);
  } catch (secondary) {
    // Even the challenge could not be built. Still answer, still with a reason.
    config.logger.error(`[stellarsight] could not encode the 402 challenge: ${reasonOf(secondary)}`);
    try {
      return res
        .status(402)
        .json({ x402Version: config.x402Version, error: sentence, accepts: [] });
    } catch {
      return next(error);
    }
  }
}

function makeHandler(route, config, announcer) {
  return async function handlePayment(req, res, next) {
    if (learnPath(route, req)) announcer.schedule();

    const origin = originFor(req, config);
    const expected = requirementsFor(route, config);
    const reject = (reason) => send402(res, route, config, origin, reason, req);

    const header = extractPaymentHeader(req);
    if (!header) {
      return reject(
        `Payment of ${expected.extra.humanAmount} is required for this resource. ` +
          "Send the signed x402 payload in the PAYMENT-SIGNATURE header (the v1 X-PAYMENT spelling is also accepted).",
      );
    }

    let paymentPayload;
    try {
      paymentPayload = decodePaymentSignatureHeader(header.value);
    } catch (e) {
      return reject(
        `The ${header.name} header is not valid base64-encoded JSON: ${reasonOf(e, "it could not be decoded")}.`,
      );
    }

    if (!paymentPayload || typeof paymentPayload !== "object" || Array.isArray(paymentPayload)) {
      return reject(
        `The ${header.name} header decoded to ${describeType(paymentPayload)}, not an x402 payment payload object.`,
      );
    }
    if (paymentPayload.payload == null) {
      return reject(
        `The ${header.name} header carries no \`payload\` field, so there is no signed authorization to verify.`,
      );
    }

    // ---- Never trust the client's echoed requirements about money. -------------
    const echoed = paymentPayload.accepted;
    if (echoed && typeof echoed === "object" && !Array.isArray(echoed)) {
      const mismatch = describeMismatch(echoed, expected, header.name);
      if (mismatch) return reject(mismatch);
    }
    // If `accepted` is absent entirely there is nothing to compare; the facilitator is
    // still asked to verify against `expected` below, so the price is enforced regardless.

    // ---- /verify ---------------------------------------------------------------
    const facilitatorBody = {
      x402Version: config.x402Version,
      paymentPayload,
      paymentRequirements: expected, // OUR requirements, never the echo
    };

    const verify = await postJson(
      config.fetch,
      `${config.facilitator}/verify`,
      facilitatorBody,
      config.facilitatorTimeoutMs,
    );

    if (verify.json === null) {
      return reject(`The facilitator could not be asked to verify this payment: ${verify.error}.`);
    }
    if (verify.json.isValid !== true) {
      return reject(
        reasonOf(
          verify.json.invalidReason,
          verify.ok
            ? `The facilitator at ${config.facilitator} rejected this payment without giving a reason.`
            : `The facilitator at ${config.facilitator} returned HTTP ${verify.status} for /verify: ${snippet(verify.json)}`,
        ),
      );
    }

    // ---- /settle ---------------------------------------------------------------
    const settle = await postJson(
      config.fetch,
      `${config.facilitator}/settle`,
      facilitatorBody,
      config.facilitatorTimeoutMs,
    );

    if (settle.json === null) {
      return reject(
        `The payment verified but could not be settled: ${settle.error}. Nothing was charged.`,
      );
    }
    if (settle.json.success !== true) {
      return reject(
        reasonOf(
          settle.json.errorReason,
          settle.ok
            ? `The facilitator at ${config.facilitator} failed to settle this payment without giving a reason.`
            : `The facilitator at ${config.facilitator} returned HTTP ${settle.status} for /settle: ${snippet(settle.json)}`,
        ),
      );
    }

    // ---- Receipt ---------------------------------------------------------------
    let receipt;
    try {
      receipt = encodePaymentResponseHeader(settle.json);
    } catch (e) {
      return reject(
        `The payment settled as ${settle.json.transaction ?? "an unknown transaction"} but its receipt could not be encoded: ${reasonOf(e)}. ` +
          "Refusing to serve the resource without a verifiable receipt.",
      );
    }
    res.set("PAYMENT-RESPONSE", receipt);
    res.set("X-PAYMENT-RESPONSE", receipt); // v1 spelling

    const extensionResponses = settle.headers?.get?.("EXTENSION-RESPONSES");
    if (extensionResponses) res.set("EXTENSION-RESPONSES", extensionResponses);

    req.x402 = settle.json; // compatible with apps/seller's existing handlers
    req.stellarsight = {
      settlement: settle.json,
      transaction: settle.json.transaction ?? null,
      payer: settle.json.payer ?? null,
      network: settle.json.network ?? config.network,
      requirements: expected,
      route: publicViewOf(route, config),
      facilitator: config.facilitator,
      extensionResponses: extensionResponses ?? null,
    };

    if (config.onSettled) {
      try {
        config.onSettled(req.stellarsight, req);
      } catch (e) {
        // A bookkeeping callback must never fail a payment the chain already accepted.
        config.logger.warn(`[stellarsight] onSettled threw and was ignored: ${reasonOf(e)}`);
      }
    }

    return next();
  };
}

// ---------------------------------------------------------------------------
// 402
// ---------------------------------------------------------------------------

function send402(res, route, config, origin, reason, req) {
  const error = reasonOf(reason, NO_REASON_GIVEN);
  const paymentRequired = paymentRequiredFor(route, config, origin, error);

  if (config.onRejected) {
    try {
      config.onRejected({ reason: error, route: publicViewOf(route, config) }, req);
    } catch (e) {
      config.logger.warn(`[stellarsight] onRejected threw and was ignored: ${reasonOf(e)}`);
    }
  }

  return res
    .status(402)
    .set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired))
    .set("Cache-Control", PAYMENT_REQUIRED_CACHE_CONTROL)
    .json(paymentRequired);
}

/**
 * Read the signed payload from wherever the client put it.
 * v2 clients send `PAYMENT-SIGNATURE`; `X-PAYMENT` is the v1 spelling, still accepted.
 */
function extractPaymentHeader(req) {
  const v2 = req.headers?.["payment-signature"];
  const v1 = req.headers?.["x-payment"];
  const raw = v2 ?? v1;
  if (raw == null) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.trim() === "") return null;
  return { name: v2 != null ? "PAYMENT-SIGNATURE" : "X-PAYMENT", value: value.trim() };
}

/**
 * Compare what the client says it agreed to against what this resource actually costs.
 * Returns a sentence naming every field that disagrees, or null when the echo is fine.
 */
function describeMismatch(echoed, expected, headerName) {
  const problems = [];

  if (echoed.payTo !== expected.payTo) {
    problems.push(`payTo is ${quote(echoed.payTo)} but this resource is paid to ${quote(expected.payTo)}`);
  }
  if (echoed.asset !== expected.asset) {
    problems.push(`asset is ${quote(echoed.asset)} but this resource is priced in ${quote(expected.asset)}`);
  }
  if (echoed.network != null && echoed.network !== expected.network) {
    problems.push(`network is ${quote(echoed.network)} but this resource settles on ${quote(expected.network)}`);
  }
  if (echoed.scheme != null && echoed.scheme !== expected.scheme) {
    problems.push(`scheme is ${quote(echoed.scheme)} but this resource uses ${quote(expected.scheme)}`);
  }

  // v2 names the price `amount`; `maxAmountRequired` is the v1 spelling.
  const rawAmount = echoed.amount ?? echoed.maxAmountRequired;
  const amount = parseAtomicUnits(rawAmount);
  if (amount === null) {
    problems.push(
      `amount is ${quote(rawAmount)}, which is not an integer number of atomic units`,
    );
  } else if (amount < BigInt(expected.amount)) {
    problems.push(
      `amount is ${amount} atomic units but this resource costs ${expected.amount} (${expected.extra.humanAmount})`,
    );
  }

  if (problems.length === 0) return null;
  return (
    `The payment requirements echoed in ${headerName} do not match this resource: ` +
    `${problems.join("; ")}. Re-read the PAYMENT-REQUIRED challenge and pay the offer it advertises.`
  );
}

// ---------------------------------------------------------------------------

/**
 * The origin used in the 402 challenge. `baseUrl` wins; otherwise it is derived from the
 * request, which is fine for a self-describing challenge (the caller already knows the host
 * it dialled) but is deliberately NEVER used for bazaar announcements — see announce.mjs.
 */
function originFor(req, config) {
  if (config.baseUrl) return config.baseUrl;
  const host = typeof req?.get === "function" ? req.get("host") : req?.headers?.host;
  if (!host) return "";
  const proto = req?.protocol ?? "http";
  return `${proto}://${host}`;
}

function quote(value) {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  return typeof value === "string" ? JSON.stringify(snippet(value, 80)) : snippet(value, 80);
}

function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
