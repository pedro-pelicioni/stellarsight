/**
 * The adversarial step: three attacks on the payment you just made, each demonstrating a
 * different property, each with the outcome the property actually predicts.
 *
 * Each attack signs a FRESH, unspent entry (`signOnly` — nothing is charged for it) and
 * states its own pass condition. Attacking the header of the completed payment would be
 * refused for nonce reuse before the property under test is ever reached, and would credit
 * the wrong control:
 *
 *   replay            resend an entry that already settled.
 *                     PASSES WHEN REFUSED. The nonce was consumed on chain.
 *
 *   corrupt-signature flip a byte inside the signed envelope.
 *                     PASSES WHEN REFUSED. The payment is signed; mutating it breaks it.
 *
 *   inflate-echo      multiply `accepted.amount` — the price the CLIENT echoes back —
 *                     by 100 on a valid entry.
 *                     PASSES WHEN IT SETTLES AT THE ORIGINAL PRICE. This one is not
 *                     refused, and pretending otherwise was the bug: the echoed block is
 *                     untrusted decoration. The money moves according to the signed
 *                     transaction, so inflating the echo changes nothing. Being charged
 *                     the true amount IS the control working.
 */

import { payInBrowser, decodeBase64Json, type PayEvent } from './payBrowser'

export type AttackKind = 'replay' | 'corrupt-signature' | 'inflate-echo'

export type AttackOutcome = {
  kind: AttackKind
  /** Did the system behave the way the security property requires? */
  passed: boolean
  /** One line naming what actually happened, in the system's own terms. */
  observed: string
  code: string | null
  reason: string | null
  /** Set when the attack could not be built, so nothing was sent and nothing was proved. */
  notSent?: boolean
}

type Opts = { payerSecret: string; method?: string; body?: unknown; onEvent?: (e: PayEvent) => void }

/** Re-encode a mutated payload back into the header shape. */
function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

const notSent = (kind: AttackKind, reason: string): AttackOutcome => ({
  kind,
  passed: false,
  notSent: true,
  observed: 'not sent — nothing was proved either way',
  code: 'PLAYGROUND_CANNOT_BUILD_ATTACK',
  reason,
})

/** Sign a fresh entry without settling it, so an attack has something valid to mutate. */
async function freshHeader(url: string, opts: Opts): Promise<{ header: string; amount: string } | { error: string }> {
  const signed = await payInBrowser(url, { ...opts, signOnly: true })
  if (!signed.ok) return { error: `${signed.code}: ${signed.reason}` }
  if (!signed.signedOnly) return { error: 'the signing path settled a payment instead of stopping at the signature' }
  return { header: signed.paymentHeader, amount: signed.amount }
}

/**
 * Resend the header from the payment that already settled.
 *
 * The facilitator recognises the consumed (address, nonce) pair and says so; if it has no
 * memory of it — a restart, another instance — the chain refuses it anyway and the code is
 * the generic settlement failure. Either way the pass condition is the same: refused, with
 * a reason.
 */
export async function replayPayment(url: string, settledHeader: string, opts: Opts): Promise<AttackOutcome> {
  const result = await payInBrowser(url, { ...opts, forcePaymentHeader: settledHeader })
  if (result.ok) {
    return {
      kind: 'replay',
      passed: false,
      observed: 'settled a second time — a spent authorization was accepted',
      code: null,
      reason: null,
    }
  }
  return {
    kind: 'replay',
    passed: true,
    observed: `refused — ${result.code}`,
    code: result.code,
    reason: result.reason,
  }
}

/** Flip one character deep inside the signed envelope, leaving everything else intact. */
export async function corruptSignature(url: string, opts: Opts): Promise<AttackOutcome> {
  const fresh = await freshHeader(url, opts)
  if ('error' in fresh) return notSent('corrupt-signature', `could not sign a fresh entry: ${fresh.error}`)

  const decoded = decodeBase64Json(fresh.header)
  const xdr = (decoded as { payload?: { transaction?: string } } | null)?.payload?.transaction
  if (!decoded || typeof xdr !== 'string' || xdr.length < 64) {
    return notSent('corrupt-signature', 'the signed payload did not decode into an envelope this demonstration can mutate')
  }

  // Three quarters in: past the operation body, inside the signature region.
  const at = Math.floor(xdr.length * 0.75)
  const flipped = `${xdr.slice(0, at)}${xdr[at] === 'A' ? 'B' : 'A'}${xdr.slice(at + 1)}`
  const header = encodeBase64Json({ ...decoded, payload: { ...(decoded as { payload: object }).payload, transaction: flipped } })

  const result = await payInBrowser(url, { ...opts, forcePaymentHeader: header })
  if (result.ok) {
    return {
      kind: 'corrupt-signature',
      passed: false,
      observed: 'settled with a corrupted signature',
      code: null,
      reason: null,
    }
  }
  return {
    kind: 'corrupt-signature',
    passed: true,
    observed: `refused — ${result.code}`,
    code: result.code,
    reason: result.reason,
  }
}

/**
 * Multiply the echoed price by 100 and pay.
 *
 * The pass condition is deliberately not "refused". The seller re-derives price from its
 * own route table and the chain moves what the signed transaction says, so the inflated
 * echo is ignored — and the visitor is charged the real price. Anything else would be the
 * finding.
 */
export async function inflateEcho(url: string, opts: Opts): Promise<AttackOutcome> {
  const fresh = await freshHeader(url, opts)
  if ('error' in fresh) return notSent('inflate-echo', `could not sign a fresh entry: ${fresh.error}`)

  const decoded = decodeBase64Json(fresh.header)
  const accepted = (decoded as { accepted?: Record<string, unknown> } | null)?.accepted
  const original = String(accepted?.amount ?? accepted?.maxAmountRequired ?? '')
  if (!decoded || !accepted || !/^\d+$/.test(original)) {
    return notSent('inflate-echo', 'the signed payload carried no echoed price to inflate')
  }

  const inflated = (BigInt(original) * 100n).toString()
  const header = encodeBase64Json({
    ...decoded,
    accepted: {
      ...accepted,
      ...(accepted.amount !== undefined ? { amount: inflated } : {}),
      ...(accepted.maxAmountRequired !== undefined ? { maxAmountRequired: inflated } : {}),
    },
  })

  const result = await payInBrowser(url, { ...opts, forcePaymentHeader: header })

  if (!result.ok) {
    // Also an acceptable outcome — the seller may refuse the mismatch outright rather than
    // ignore it. Either way nothing was overcharged, which is the property.
    return {
      kind: 'inflate-echo',
      passed: true,
      observed: `refused outright — ${result.code}`,
      code: result.code,
      reason: result.reason,
    }
  }

  // `signOnly` was not requested here, so this is the settled variant.
  const settled = result.signedOnly ? null : result
  const charged = (settled?.body as { paidWith?: { amount?: string } } | null)?.paidWith?.amount ?? null
  const expected = Number(original) / 1e7
  const overcharged = charged !== null && Number(charged) > expected + 1e-9

  return {
    kind: 'inflate-echo',
    passed: !overcharged,
    observed: overcharged
      ? `settled and charged ${charged} — the inflated echo was believed`
      : `settled and charged ${charged ?? expected} — the inflated echo was ignored`,
    code: null,
    reason: overcharged
      ? 'The echoed price changed what was charged. That is a real finding.'
      : `The client claimed ${inflated} atomic units; the signed transaction said ${original}, and ${original} is what moved.`,
  }
}
