/**
 * scripts/lib/payment-shape.mjs — read the payment payload a stock client put on the wire.
 *
 * One of the RFP's six acceptance criteria is that the Stellar payload is
 * `{ transaction }` and that the facilitator takes it verbatim. A green end-to-end run
 * implies it, but implication is not a named check, and a reviewer looking for the
 * criterion by name found nothing. This is the named check's eyes: it decodes the
 * PAYMENT-SIGNATURE header an unmodified `@x402/fetch` client sent and reports the shape.
 *
 * Kept in its own module, rather than inline in verify-conformance.mjs, for one reason:
 * that script is a run, not a library — importing it settles a payment. Here the logic can
 * be pinned against a real recorded payload with no network at all.
 */

/** Base64(JSON) -> object, or null. A header we cannot read is "not observed", never a pass. */
export function decodePaymentHeader(header) {
  if (typeof header !== 'string' || header.length === 0) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * The inner payload, whether the caller hands over a PaymentPayload or something wrapping
 * one. Returns null when there is no object to inspect.
 */
export function innerPayload(decoded) {
  const inner = decoded?.payload ?? decoded?.paymentPayload?.payload ?? null;
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : null;
}

/**
 * payloadShape(decoded) -> { observed, keys, transactionIsString, verbatim }
 *
 * `verbatim` is deliberately strict: exactly one key, named `transaction`, holding a
 * non-empty string. An extra field would mean the client is sending something the criterion
 * does not describe, and reporting that as a pass would be the drift this repo exists to
 * catch.
 */
export function payloadShape(decoded) {
  const inner = innerPayload(decoded);
  if (!inner) return { observed: false, keys: null, transactionIsString: false, verbatim: false };
  const keys = Object.keys(inner).sort();
  const transactionIsString = typeof inner.transaction === 'string' && inner.transaction.length > 0;
  return {
    observed: true,
    keys,
    transactionIsString,
    verbatim: transactionIsString && keys.length === 1 && keys[0] === 'transaction',
  };
}

export default { decodePaymentHeader, innerPayload, payloadShape };
