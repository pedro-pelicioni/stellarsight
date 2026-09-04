/**
 * apps/facilitator/src/settled-nonces.mjs — naming a replay, rather than shrugging at one.
 *
 * ─── THE PROBLEM ────────────────────────────────────────────────────────────────────
 *
 * Re-submitting an authorization entry that already settled IS refused — by the chain,
 * every time, whatever this file does. But the caller could not tell that apart from any
 * other failure, because `@x402/stellar` collapses every simulation failure into one
 * opaque code. From its facilitator (dist/esm/exact/facilitator/index.mjs):
 *
 *     const errorMsg = simResponse.error ? `: ${simResponse.error}` : "";
 *     console.error("Simulation error:", errorMsg);
 *     return invalidVerifyResponse("invalid_exact_stellar_payload_simulation_failed", ...)
 *
 * The real diagnostic is read, printed to the operator's stdout, and then dropped. So a
 * replayed entry, an underfunded account, an expired signature and a genuine bug all
 * reach the caller as `invalid_exact_stellar_payload_simulation_failed`. An agent cannot
 * branch on that, and "every rejection carries a reason an agent can act on" is a claim
 * this project makes everywhere.
 *
 * ─── WHAT THIS DOES, AND WHAT IT IS NOT ─────────────────────────────────────────────
 *
 * It remembers the (address, nonce) pairs this facilitator has settled, and checks
 * incoming payloads against that memory so a replay can be REPORTED as a replay.
 *
 * That pair is not a heuristic: it is the exact identity Soroban itself replay-protects
 * on — the nonce ledger key is (address, nonce) — so agreeing with the chain is the
 * whole design.
 *
 * This is **not** the security boundary, and nothing here should be read as one:
 *
 *   · The chain refuses the replay whether or not this memory exists.
 *   · A restart, a scale-out to an instance that never saw the original, or an expired
 *     TTL all mean we simply do not recognise it — and then the caller gets the generic
 *     code, exactly as before. Never worse, sometimes better.
 *   · A hostile client gains nothing by evading this check: evading it means reaching
 *     the chain, which is where the refusal actually happens.
 *
 * So: a naming layer over an enforcement layer we do not own. Failing open is correct.
 */

import { createHash } from "node:crypto";

import { Networks, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";

import { createKv } from "../../../packages/index/src/store.mjs";

/**
 * How long a settled nonce stays recognisable. The signed entry dies at its own
 * `signatureExpirationLedger` (~60s) and Soroban's nonce entry outlives that, so a day is
 * generous for naming purposes and bounds what we store.
 */
const TTL_SECONDS = 86_400;

/** Per-instance fallback when no durable store is configured. */
const memory = new Map();

const keyFor = (address, nonce) => `stellarsight:settled:${address}:${nonce}`;

/**
 * authIdentity(paymentPayload) -> { address, nonce, expiry, fingerprint } | null
 *
 * Reads the payer address and nonce straight out of the signed envelope. Returns null
 * for anything it cannot parse with certainty — an unreadable payload is not a replay,
 * and guessing here would produce exactly the false confidence this module exists to
 * remove.
 */
export function authIdentity(paymentPayload, networkPassphrase = Networks.TESTNET) {
  const envelope = paymentPayload?.payload?.transaction;
  if (typeof envelope !== "string" || !envelope) return null;

  try {
    const tx = TransactionBuilder.fromXDR(envelope, networkPassphrase);
    for (const op of tx.operations ?? []) {
      for (const entry of op.auth ?? []) {
        const creds = entry.credentials();
        if (creds.switch().name !== "sorobanCredentialsAddress") continue;
        const addressCreds = creds.address();
        const scAddress = addressCreds.address();
        const kind = scAddress.switch().name;
        const address =
          kind === "scAddressTypeAccount"
            ? StrKey.encodeEd25519PublicKey(scAddress.accountId().ed25519())
            : StrKey.encodeContract(scAddress.contractId());
        const nonce = addressCreds.nonce().toString();
        return {
          address,
          nonce,
          expiry: addressCreds.signatureExpirationLedger(),
          // A short stable id for logs and events, so the full pair need not be printed.
          fingerprint: createHash("sha256").update(`${address}:${nonce}`).digest("hex").slice(0, 16),
        };
      }
    }
  } catch {
    /* an unparseable envelope is the scheme's problem to reject, not ours to name */
  }
  return null;
}

/**
 * seen(identity) -> { seen: boolean, at?: number, degraded?: string }
 *
 * Never throws and never fails closed: an unreachable store answers `seen: false` with a
 * `degraded` note, because a naming layer that starts rejecting real payments when Redis
 * blinks would be strictly worse than no naming layer at all.
 */
export async function seen(identity, { kv = createKv() } = {}) {
  if (!identity) return { seen: false };
  const key = keyFor(identity.address, identity.nonce);

  if (!kv) {
    const at = memory.get(key);
    if (at && Date.now() - at < TTL_SECONDS * 1000) return { seen: true, at, transport: "per-instance" };
    return { seen: false, transport: "per-instance" };
  }

  const r = await kv.command(["GET", key]);
  if (!r.ok) return { seen: false, degraded: r.reason, transport: kv.transport };
  const raw = r.result?.result ?? r.result;
  if (raw === null || raw === undefined || raw === "") return { seen: false, transport: kv.transport };
  // We wrote a timestamp; anything else means the entry is not ours or the store is
  // confused. Treat it as unknown rather than as a hit: a false positive here would
  // refuse a legitimate first-time payment, which is the one way this naming layer could
  // do real harm. Fail open, always.
  const at = Number(raw);
  if (!Number.isFinite(at) || at <= 0) {
    return { seen: false, degraded: `unrecognised store value for ${key}`, transport: kv.transport };
  }
  return { seen: true, at, transport: kv.transport };
}

/**
 * remember(identity) — called only after a settlement actually succeeds.
 *
 * Recording at /verify time would be a bug with teeth: verify runs immediately before
 * settle for the SAME payment, so the legitimate settle that follows would be reported
 * as a replay of itself.
 */
export async function remember(identity, { kv = createKv() } = {}) {
  if (!identity) return { ok: false, reason: "no auth identity to remember" };
  const key = keyFor(identity.address, identity.nonce);
  const now = Date.now();

  if (!kv) {
    memory.set(key, now);
    // Bound the fallback map so a long-lived process cannot grow one entry per payment
    // forever. The oldest entries are the least likely to be replayed.
    if (memory.size > 10_000) {
      for (const k of [...memory.keys()].slice(0, 2_000)) memory.delete(k);
    }
    return { ok: true, transport: "per-instance" };
  }

  const r = await kv.command(["SET", key, String(now), "EX", String(TTL_SECONDS)]);
  return r.ok ? { ok: true, transport: kv.transport } : { ok: false, reason: r.reason, transport: kv.transport };
}

/** Test hook: drop the per-instance memory. */
export function resetMemory() {
  memory.clear();
}

/**
 * The sentence a caller gets when we recognise a replay.
 *
 * It deliberately contains the word "replay" and names the nonce, because both payment
 * clients in this repo classify by reading the reason text
 * (`classifySettleFailure` in apps/agent/src/pay.mjs and its browser port). Wording this
 * sentence IS the wiring — change it and the code the caller branches on changes with it,
 * which is why test/replay-naming.test.mjs pins the round trip rather than the string.
 */
export function replayReason(identity) {
  return (
    `This authorization entry has already been settled by this facilitator — replay refused. ` +
    `A Soroban auth entry is single-use: nonce ${identity.nonce} for ${identity.address} was consumed ` +
    `when it settled, and the chain would reject this submission regardless. Sign a fresh payment.`
  );
}
