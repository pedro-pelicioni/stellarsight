const DECIMALS = 7

/** stroops-style integer string -> human SXT amount */
export function formatAmount(raw: string | number | undefined): string {
  const n = Number(raw ?? 0)
  if (!Number.isFinite(n)) return '—'
  const v = n / 10 ** DECIMALS
  if (v === 0) return '0'
  if (v < 0.0001) return v.toExponential(2)
  return v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
}

export function shortKey(k: string | undefined, head = 4, tail = 4): string {
  if (!k) return '—'
  if (k.length <= head + tail + 1) return k
  return `${k.slice(0, head)}…${k.slice(-tail)}`
}

export function shortHash(h: string): string {
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h
}

export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

/**
 * An absolute UTC stamp — "6 Aug 2026, 19:22 UTC" — for things that happened once, on a
 * date, and are being shown again later. Deliberately not `ago()`: a relative string
 * ("4 d ago") drifts with the reader's clock, and next to a replayed settlement the whole
 * point is to pin it to a date that is plainly not now.
 */
export function settledOn(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return undefined
  const date = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })
  return `${date}, ${time} UTC`
}

export const sightNumber = (i: number) => String(i + 1).padStart(2, '0')

export const explorerTx = (hash: string) =>
  `https://stellar.expert/explorer/testnet/tx/${hash}`

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}
