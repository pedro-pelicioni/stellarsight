#!/usr/bin/env node
/**
 * scripts/interop-discovery.mjs — point one unmodified bazaar client at this deployment and
 * at another facilitator, and diff what comes back field by field.
 *
 * Why: the RFP asks that Stellar listings be representable consistently with listings from
 * other facilitators, "so Stellar is not a walled garden", and its appendix suggests a
 * conformance baseline built by pointing the same stock client at a reference facilitator
 * and at the deliverable. Both were arguments here and neither was an artifact. An
 * interoperability claim that nobody has run against another implementation is a claim
 * about intent.
 *
 * The comparison is deliberately *not* "do the two agree". They should not: one indexes
 * EVM resources, the other Stellar ones, and each is free to carry its own extras. What
 * matters, and what this measures, is narrower and harder:
 *
 *   1. the same unmodified `withBazaar()` client parses both envelopes;
 *   2. every `accepts` entry on both sides validates against `@x402/core`'s own shipped
 *      `PaymentRequirementsSchema`, so a buyer can construct a payment from either;
 *   3. the fields each side carries are enumerated, so a divergence is visible as a
 *      difference rather than discovered later as a bug.
 *
 * Anything either side adds beyond the shared set is reported, in both directions —
 * including ours. A report that only lists the other implementation's extras is marketing.
 *
 * Usage:
 *   node scripts/interop-discovery.mjs
 *   node scripts/interop-discovery.mjs --limit 25 --emit
 */
import { withBazaar } from '@x402/extensions/bazaar';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { PaymentRequirementsSchema } from '@x402/core/schemas';
import { writeEvidence } from './lib/evidence.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);
const LIMIT = Number(flag('limit', '20'));

/**
 * The reference side is CDP. That is a finding rather than a preference: of the public
 * facilitators reachable today, it is the only one serving the Bazaar discovery endpoint at
 * all. `https://x402.org/facilitator` answers `/supported` but 404s on
 * `/discovery/resources`, and `https://facilitator.x402.rs` returns its marketing site for
 * the same path. Both are recorded below so the claim is checkable and so the picture
 * updates when they implement it.
 */
const TARGETS = [
  { key: 'cdp', name: 'CDP (Coinbase)', url: 'https://api.cdp.coinbase.com/platform/v2/x402', role: 'reference' },
  { key: 'stellarsight', name: 'STELLARSIGHT', url: 'https://stellarsight.xyz', role: 'deliverable' },
];

const NOT_SERVING_DISCOVERY = [
  { name: 'x402.org facilitator', url: 'https://x402.org/facilitator', observed: '/supported answers 200; /discovery/resources answers 404' },
  { name: 'x402.rs facilitator', url: 'https://facilitator.x402.rs', observed: '/supported answers 200; /discovery/resources returns HTML' },
];

/** Every field name present on at least one item, with how often it appears. */
function fieldFrequency(objects) {
  const counts = new Map();
  for (const o of objects) {
    for (const k of Object.keys(o ?? {})) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

async function probe(target) {
  const client = withBazaar(new HTTPFacilitatorClient({ url: target.url, fetch }));
  const started = Date.now();
  let response;
  try {
    response = await client.extensions.bazaar.listResources({ limit: LIMIT });
  } catch (err) {
    return { ...target, reachable: false, error: err?.message ?? String(err) };
  }
  const elapsedMs = Date.now() - started;

  // The envelope difference the CONTRACT documents: list names the array `items`, search
  // names it `resources`. Accept either here so an implementation that took the other
  // reading still gets compared rather than reported as broken.
  const items = response.items ?? response.resources ?? [];
  const accepts = items.flatMap((i) => (Array.isArray(i?.accepts) ? i.accepts : []));

  let valid = 0;
  const failures = [];
  for (const entry of accepts) {
    const parsed = PaymentRequirementsSchema.safeParse(entry);
    if (parsed.success) valid += 1;
    else failures.push({ scheme: entry?.scheme ?? null, network: entry?.network ?? null, issue: parsed.error.issues?.[0]?.message ?? 'unknown' });
  }

  return {
    ...target,
    reachable: true,
    elapsedMs,
    envelopeKeys: Object.keys(response).sort(),
    arrayField: response.items ? 'items' : response.resources ? 'resources' : null,
    pagination: response.pagination ?? null,
    requestedLimit: LIMIT,
    returnedCount: items.length,
    honoursLimit: items.length <= LIMIT,
    itemFields: fieldFrequency(items),
    acceptsFields: fieldFrequency(accepts),
    acceptsChecked: accepts.length,
    acceptsValid: valid,
    acceptsInvalid: failures.slice(0, 5),
    resourceIsString: items.length > 0 ? items.every((i) => typeof i?.resource === 'string') : null,
  };
}

const results = await Promise.all(TARGETS.map(probe));
const [reference, ours] = results;

const keysOf = (o) => new Set(Object.keys(o ?? {}));
const compare = (a, b) => {
  const A = keysOf(a);
  const B = keysOf(b);
  return {
    shared: [...A].filter((k) => B.has(k)).sort(),
    onlyReference: [...A].filter((k) => !B.has(k)).sort(),
    onlyDeliverable: [...B].filter((k) => !A.has(k)).sort(),
  };
};

const itemDiff = compare(reference.itemFields, ours.itemFields);
const acceptsDiff = compare(reference.acceptsFields, ours.acceptsFields);

const bothParsed = results.every((r) => r.reachable && r.arrayField);
const bothValidate = results.every((r) => r.reachable && r.acceptsChecked > 0 && r.acceptsValid === r.acceptsChecked);

const payload = {
  question:
    'Can one unmodified bazaar client read this deployment and another facilitator, and does a buyer get a constructible payment from either?',
  method:
    "The same @x402/extensions `withBazaar()` client calls listResources() against both, and every accepts entry is validated with @x402/core's own PaymentRequirementsSchema.",
  limitRequested: LIMIT,
  targets: results,
  notServingDiscovery: NOT_SERVING_DISCOVERY,
  itemFieldDiff: itemDiff,
  acceptsFieldDiff: acceptsDiff,
  verdict: {
    oneClientParsesBoth: bothParsed,
    everyAcceptsEntryValidatesOnBothSides: bothValidate,
  },
};

if (has('emit')) {
  const { path } = writeEvidence('interop-discovery', payload);
  console.log(`[interop] wrote ${path.replace(`${process.cwd()}/`, '')}`);
}

/* ── report ──────────────────────────────────────────────────────────────── */

console.log(`\nOne stock withBazaar() client, two facilitators (limit ${LIMIT})\n`);
for (const r of results) {
  if (!r.reachable) {
    console.log(`  ${r.name.padEnd(16)} UNREACHABLE — ${r.error}`);
    continue;
  }
  console.log(
    `  ${r.name.padEnd(16)} ${String(r.returnedCount).padStart(3)} item(s) in ${r.elapsedMs}ms · array field \`${r.arrayField}\` · ` +
      `accepts ${r.acceptsValid}/${r.acceptsChecked} validate` +
      `${r.honoursLimit ? '' : `  [limit ${LIMIT} not honoured — returned ${r.returnedCount}]`}`,
  );
}

const label = (text) => `    ${text}`.padEnd(28);
const section = (title, diff) => {
  console.log(`\n  ${title}`);
  console.log(`${label('shared')}${diff.shared.join(', ') || '—'}`);
  console.log(`${label(`only ${reference.name}`)}${diff.onlyReference.join(', ') || '—'}`);
  console.log(`${label(`only ${ours.name}`)}${diff.onlyDeliverable.join(', ') || '—'}`);
};
section('Item fields', itemDiff);
section('accepts[] fields', acceptsDiff);

console.log(
  `\n  one client parses both: ${payload.verdict.oneClientParsesBoth ? 'yes' : 'NO'} · ` +
    `every accepts entry validates on both sides: ${payload.verdict.everyAcceptsEntryValidatesOnBothSides ? 'yes' : 'NO'}\n`,
);

if (!bothParsed || !bothValidate) process.exit(1);
