#!/usr/bin/env node
/**
 * STELLARSIGHT — stock-client conformance check.
 *
 * The RFP's hard acceptance criterion is that an UNMODIFIED canonical client can pay an
 * independent resource server. This script is that test, and it is deliberately written
 * so that nothing in `apps/agent` is on the code path: the only client code here comes
 * from the published packages.
 *
 *   @x402/fetch            -> wrapFetchWithPayment, x402Client, decodePaymentResponseHeader
 *   @x402/stellar          -> createEd25519Signer
 *   @x402/stellar/exact/client -> ExactStellarScheme
 *   @x402/core/http        -> decodePaymentRequiredHeader   (spec assertion only)
 *
 * `wrapFetchWithPayment` drives the whole loop itself: unpaid request -> read the
 * `PAYMENT-REQUIRED` header -> sign -> resend with `PAYMENT-SIGNATURE` -> read
 * `PAYMENT-RESPONSE`. If the seller drifts off the x402 v2 HTTP transport in any of those
 * four places, this fails. There is no leniency anywhere in this file to hide it.
 *
 * This is a REAL run against stellar:testnet. It moves real (valueless) testnet tokens and
 * prints the settled transaction hash.
 *
 * Usage:
 *   npm run verify:conformance
 *   npm run verify:conformance -- --url http://localhost:4023/v1/cep/01310100
 *   npm run verify:conformance -- --seller https://stellarsight.xyz --emit --append-txdoc "conformance: nightly hosted"
 *
 * `--emit` writes docs/status/conformance.json — every criterion with the value actually
 * observed, plus the settled hash — so the published claim and the run that produced it
 * are the same artifact. `--append-txdoc "<label>"` appends the settled row to
 * docs/TESTNET-TXS.md instead of only printing it for a human to paste. Neither flag
 * changes what is checked; without them this script behaves exactly as before.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { writeEvidence, updateProvenance, appendTxRows } from "./lib/evidence.mjs";
import { decodePaymentHeader, payloadShape } from "./lib/payment-shape.mjs";

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });

// ---------------------------------------------------------------------------
// Tiny transcript printer — every line is evidence, so keep it plain.
// ---------------------------------------------------------------------------

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", cyan: "\x1b[36m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", red: "", green: "", cyan: "", bold: "", off: "" };

let step = 0;
const say = (msg) => console.log(`  ${msg}`);
const head = (msg) => console.log(`\n${C.bold}${++step}. ${msg}${C.off}`);
const ok = (msg) => say(`${C.green}PASS${C.off}  ${msg}`);
const info = (msg) => say(`${C.dim}      ${msg}${C.off}`);

/**
 * The acceptance criteria, as observed rather than as claimed.
 *
 * Each entry records what the RFP asks for (`expected`) beside what this run actually
 * saw (`observed`). A criterion whose observed value is written by hand is not evidence,
 * so every one of these is filled from the response objects themselves.
 */
const criteria = [];
const record = (id, name, expected, observed, pass = true) => {
  criteria.push({ id, name, expected, observed: String(observed), pass });
};

function die(msg, detail, id) {
  if (id) record(id, msg, "pass", detail ? `${msg} — ${String(detail).split("\n")[0]}` : msg, false);
  console.error(`  ${C.red}FAIL${C.off}  ${msg}`);
  if (detail) console.error(`${C.dim}        ${String(detail).split("\n").join("\n        ")}${C.off}`);
  // A failed run is still evidence — arguably the more valuable kind — so emit it before
  // exiting rather than leaving the last passing artifact on disk to imply a green run.
  if (EMIT) {
    try {
      writeEvidence("conformance", {
        ok: false,
        target: TARGET,
        network: NETWORK,
        criteria,
        failure: msg,
      });
      console.error(`${C.dim}        wrote docs/status/conformance.json (ok: false)${C.off}`);
    } catch (e) {
      console.error(`${C.dim}        could not write evidence: ${e.message}${C.off}`);
    }
  }
  console.error(`\n${C.red}CONFORMANCE CHECK FAILED${C.off} — a stock @x402/fetch client cannot pay this resource.\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Arguments and configuration
// ---------------------------------------------------------------------------

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const {
  STELLAR_NETWORK: NETWORK = "stellar:testnet",
  STELLAR_RPC_URL: RPC_URL = "https://soroban-testnet.stellar.org",
  PAYER_SECRET,
} = process.env;

const SELLER_URL = String(arg("seller", process.env.SELLER_URL || "http://localhost:4023")).replace(/\/+$/, "");
const TARGET = arg("url", `${SELLER_URL}/v1/fx/usd-brl`);
const METHOD = arg("method", "GET").toUpperCase();
const EMIT = process.argv.includes("--emit");
/** `--append-txdoc "<label>"` — the label prefixes the row, e.g. "conformance: nightly hosted". */
const APPEND_LABEL = arg("append-txdoc", null);

console.log(`\n${C.bold}STELLARSIGHT — x402 v2 conformance against an unmodified @x402/fetch client${C.off}`);
console.log(`${C.dim}  resource ${TARGET}`);
console.log(`  network  ${NETWORK}`);
console.log(`  client   @x402/fetch wrapFetchWithPayment (no STELLARSIGHT code on the path)${C.off}`);

if (!PAYER_SECRET) die("PAYER_SECRET is not set in .env — run `npm run setup` first.");
if (NETWORK !== "stellar:testnet") die(`Refusing to run on ${NETWORK}; this check is testnet-only.`);

// ---------------------------------------------------------------------------
// 1. The 402 challenge must live where the spec puts it.
//
// specs/transports-v2/http.md: "The `PAYMENT-REQUIRED` header is the canonical HTTP
// transport location for the `PaymentRequired` object." @x402/core's client accepts a
// JSON body only when `body.x402Version === 1`, so a v2 server that answers with a body
// alone is unreachable. We assert the header explicitly, before handing control to the
// SDK, so that this specific drift produces a specific message.
// ---------------------------------------------------------------------------

head("Unpaid probe — the 402 must carry a PAYMENT-REQUIRED header");

let probe;
try {
  probe = await fetch(TARGET, { method: METHOD, headers: { accept: "application/json" } });
} catch (e) {
  die(`Could not reach the resource at ${TARGET}`, `${e.message}\nIs the seller running? \`npm run dev:all\``);
}

if (probe.status !== 402) die(`Expected HTTP 402 from an unpaid request, got ${probe.status}.`, null, "unpaid-402");
ok("HTTP 402 Payment Required");
record("unpaid-402", "an unpaid request is answered 402", "HTTP 402", `HTTP ${probe.status}`);

const challengeHeader = probe.headers.get("PAYMENT-REQUIRED");
if (!challengeHeader) {
  die(
    "The 402 carries no PAYMENT-REQUIRED header.",
    "x402 v2 puts the PaymentRequired object in that header. @x402/core only falls back to\n" +
      "the JSON body when body.x402Version === 1, so a stock client cannot read this challenge.",
  );
}

let challenge;
try {
  challenge = decodePaymentRequiredHeader(challengeHeader);
} catch (e) {
  die("PAYMENT-REQUIRED did not decode with @x402/core's decodePaymentRequiredHeader.", e.message);
}
ok(`PAYMENT-REQUIRED decoded — x402Version ${challenge.x402Version}, ${challenge.accepts?.length ?? 0} requirement(s)`);
record(
  "payment-required-header",
  "the challenge rides in the PAYMENT-REQUIRED header and decodes with @x402/core",
  "decodes via decodePaymentRequiredHeader",
  `decoded, ${challenge.accepts?.length ?? 0} requirement(s)`,
);

const req0 = challenge.accepts?.[0] ?? {};
info(`${req0.scheme}@${req0.network}  amount=${req0.amount}  asset=${req0.asset}`);
info(`resource ${challenge.resource?.url ?? "(none)"}`);

if (challenge.x402Version !== 2) die(`Challenge advertises x402Version ${challenge.x402Version}; this check targets v2.`, null, "v2-version");
if (!Array.isArray(challenge.accepts) || challenge.accepts.length === 0) die("Challenge lists no `accepts` entries.", null, "v2-version");
if (req0.maxAmountRequired !== undefined && req0.amount === undefined) {
  die("PaymentRequirements uses the v1 field `maxAmountRequired`; v2 names it `amount`.", null, "v2-version");
}
record("v2-version", "the challenge is x402 v2 shaped", "x402Version 2, accepts[].amount", `x402Version ${challenge.x402Version}, amount=${req0.amount}`);
record("scheme-network", "the offer names the scheme and CAIP-2 network", "exact @ stellar:testnet", `${req0.scheme} @ ${req0.network}`);

// ---------------------------------------------------------------------------
// 2. Build the canonical client and let it drive the whole loop.
// ---------------------------------------------------------------------------

head("Stock client — wrapFetchWithPayment drives 402 -> sign -> settle -> 200");

let signer;
try {
  signer = createEd25519Signer(PAYER_SECRET, NETWORK);
} catch (e) {
  die("createEd25519Signer rejected PAYER_SECRET.", e.message);
}
info(`payer ${signer.address}`);

const client = new x402Client().register(NETWORK, new ExactStellarScheme(signer, { url: RPC_URL }));

// Capture what the STOCK client puts on the wire, so the payload-shape criterion is an
// observation rather than a belief about what the library does. This wrapper does not
// alter the request — it reads a header on the way past.
let sentPaymentHeader = null;
const observingFetch = (url, init = {}) => {
  try {
    const headers = new Headers(init.headers ?? {});
    const sent = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
    if (sent) sentPaymentHeader = sent;
  } catch {
    /* an exotic init shape must never break the payment itself */
  }
  return fetch(url, init);
};
const fetchWithPayment = wrapFetchWithPayment(observingFetch, client);

const started = Date.now();
let response;
try {
  response = await fetchWithPayment(TARGET, { method: METHOD, headers: { accept: "application/json" } });
} catch (e) {
  die("wrapFetchWithPayment threw before completing the loop.", e.message);
}
const elapsedMs = Date.now() - started;

if (response.status !== 200) {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 600);
  } catch {
    /* body already consumed or absent */
  }
  const hint =
    response.status === 402
      ? "\nA second 402 after payment means the seller never saw the PAYMENT-SIGNATURE header\n" +
        "(v2 clients do not send X-PAYMENT) or the facilitator rejected the payload."
      : "";
  die(`Paid request returned HTTP ${response.status}, expected 200.${hint}`, detail, "stock-client-200");
}
ok(`HTTP 200 in ${elapsedMs}ms`);
record(
  "stock-client-200",
  "an unmodified @x402/fetch client completes 402 -> sign -> settle -> 200",
  "HTTP 200",
  `HTTP 200 in ${elapsedMs}ms`,
);

// ---------------------------------------------------------------------------
// 3. The settlement receipt must live where the spec puts it.
// ---------------------------------------------------------------------------

head("Settlement receipt — PAYMENT-RESPONSE header");

const receiptHeader = response.headers.get("PAYMENT-RESPONSE");
if (!receiptHeader) {
  die(
    "The 200 carries no PAYMENT-RESPONSE header.",
    "x402 v2 returns the SettlementResponse there. X-PAYMENT-RESPONSE is the v1 name.",
  );
}

let settle;
try {
  settle = decodePaymentResponseHeader(receiptHeader);
} catch (e) {
  die("PAYMENT-RESPONSE did not decode with @x402/fetch's decodePaymentResponseHeader.", e.message);
}

if (settle.success !== true) die(`Settlement reported success=false: ${settle.errorReason ?? "no errorReason given"}`, null, "settle-success");
ok("PAYMENT-RESPONSE decoded, success=true");
record(
  "payment-response-header",
  "the receipt rides in the PAYMENT-RESPONSE header and decodes with @x402/fetch",
  "decodes via decodePaymentResponseHeader",
  "decoded",
);
record("settle-success", "settlement reports success", "success=true", `success=${settle.success}`);

// RFP acceptance criterion: the Stellar payload is `{ transaction }` and the facilitator
// takes it verbatim. It was implied by a green stock-client run and named nowhere, which
// means a reviewer grepping for it found nothing. Named here, and observed from the header
// the unmodified client actually sent.
{
  const shape = payloadShape(decodePaymentHeader(sentPaymentHeader));
  record(
    "payload-transaction-verbatim",
    "the stock client sends `payload: { transaction }` and the facilitator settles it verbatim",
    "payload keys exactly [transaction], settled",
    shape.observed
      ? `payload keys [${shape.keys.join(", ")}], settled=${settle.success === true}`
      : "payment header not observed",
    shape.verbatim && settle.success === true,
  );
  if (shape.verbatim) ok("payload is `{ transaction }`, accepted verbatim");
}

const txHash = String(settle.transaction ?? "").trim();
if (!/^[0-9a-f]{64}$/i.test(txHash)) die(`Settlement carried no usable transaction hash (got ${JSON.stringify(settle.transaction)}).`, null, "tx-hash");
record("tx-hash", "the receipt carries a settled transaction hash", "64-hex transaction hash", txHash);

const explorer = `https://stellar.expert/explorer/testnet/tx/${txHash}`;

head("Resource body");
const payload = await response.json();
info(JSON.stringify(payload?.data ?? payload).slice(0, 240));

console.log(`\n${C.green}${C.bold}CONFORMANCE CHECK PASSED${C.off}`);
console.log(`  An unmodified @x402/fetch client completed 402 -> sign -> settle -> 200.`);
console.log(`\n  ${C.bold}tx${C.off}       ${txHash}`);
console.log(`  ${C.bold}payer${C.off}    ${settle.payer ?? signer.address}`);
console.log(`  ${C.bold}network${C.off}  ${settle.network ?? NETWORK}`);
console.log(`  ${C.bold}explorer${C.off} ${C.cyan}${explorer}${C.off}`);
const route = new URL(TARGET).pathname;

/**
 * Name the asset the CHALLENGE named, never the one this repo happens to default to.
 *
 * These four lines used to hardcode "SXT". That was true of every run anyone had made,
 * and silently false the moment one is made against a different SEP-41 token — the
 * evidence writer would have stamped `0.001 SXT` onto a settlement denominated in Circle
 * USDC, in the two artifacts a reviewer checks first. An evidence generator that labels
 * from a default rather than from the observation is worse than one that says nothing.
 *
 * Order: the seller's own `extra.assetCode`, then the two Circle USDC SACs the
 * @x402/stellar SDK pins, then the contract id itself. Never a guess.
 */
const USDC_SACS = {
  CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA: "USDC", // testnet
  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75: "USDC", // pubnet
};
const assetCode =
  req0.extra?.assetCode ??
  USDC_SACS[req0.asset] ??
  (req0.asset ? `${String(req0.asset).slice(0, 8)}…` : "?");

/**
 * 7 decimals is correct for a classic Stellar asset wrapped in a SAC — which is what both
 * SXT and Circle USDC are, and what @x402/stellar assumes with DEFAULT_TOKEN_DECIMALS.
 * A native Soroban token declaring different decimals would render wrongly here; the raw
 * atomic `amount` is emitted alongside so the artifact stays checkable either way.
 */
const amountDisplay = req0.amount ? Number(req0.amount) / 1e7 : null;

if (EMIT) {
  const { path } = writeEvidence("conformance", {
    ok: true,
    target: TARGET,
    route,
    method: METHOD,
    client: "@x402/fetch wrapFetchWithPayment (unmodified)",
    payer: settle.payer ?? signer.address,
    amount: req0.amount ?? null,
    amountDisplay: amountDisplay === null ? null : `${amountDisplay} ${assetCode}`,
    assetCode,
    asset: req0.asset ?? null,
    scheme: req0.scheme ?? null,
    txHash,
    explorerUrl: explorer,
    elapsedMs,
    criteria,
  });
  updateProvenance({ [txHash]: { label: "conformance", run: process.env.GITHUB_RUN_ID ?? null } });
  console.log(`  ${C.dim}evidence  ${path.replace(`${ROOT}/`, "")}${C.off}`);
}

if (APPEND_LABEL) {
  const { appended } = appendTxRows([{ step: `${APPEND_LABEL} -> ${route}`, hash: txHash }]);
  console.log(`  ${C.dim}appended  ${appended} row to docs/TESTNET-TXS.md${C.off}`);
} else {
  console.log(`\n  ${C.dim}Append to docs/TESTNET-TXS.md (or re-run with --append-txdoc "<label>"):${C.off}`);
  console.log(`  | \`${txHash.slice(0, 8)}…\` | ${amountDisplay ?? "?"} ${assetCode} | ${route} | [link](${explorer}) |`);
}

// GitHub Actions job summary: the settled hash is the point of a nightly run, so put it
// where a reviewer clicking through the run sees it without opening the log.
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `### Conformance settled on ${NETWORK}`,
      "",
      `An unmodified \`@x402/fetch\` client completed 402 → sign → settle → 200 against \`${TARGET}\`.`,
      "",
      `| | |`,
      `|---|---|`,
      `| tx | [\`${txHash}\`](${explorer}) |`,
      `| payer | \`${settle.payer ?? signer.address}\` |`,
      `| amount | ${amountDisplay ?? "?"} ${assetCode} |`,
      `| elapsed | ${elapsedMs} ms |`,
      "",
    ].join("\n"),
  );
}

console.log("");
