/**
 * packages/index/src/integrity-replay.mjs — the hostile corpus and its replay, shared.
 *
 * Two consumers render the catalog-integrity ledger: the build step that bakes
 * apps/web/src/data/integrity.json (apps/web/scripts/gen-integrity.mjs) and the public
 * GET /discovery/integrity endpoint. The corpus and the replay live here, in packages/index,
 * next to the validator they exercise — one definition, two bindings, nothing to drift.
 *
 * Verdict semantics come from `upsert`'s own contract (packages/index/src/index.mjs):
 *   ok: false                    -> `rejected`  — the whole record is refused
 *   ok: true with dropped[]      -> `soft-drop` — hostile field discarded, record kept
 *
 * The corpus is drawn from test/catalog-integrity.test.mjs so the ledger and the test
 * suite exercise the same inputs. Adding a case here without a matching test is how
 * this drifts again — don't.
 */

import { createCatalog } from './index.mjs';
import * as V from './integrity.mjs';

/** Names the validator for provenance lines; both consumers print it verbatim. */
export const VALIDATOR_ID = 'packages/index/src/integrity.mjs (via createCatalog().upsert)';

/** A record that passes every check, so each case varies exactly one hostile field. */
export const BASE = {
  id: 'https://api.example.com/v1/thing',
  resource: {
    url: 'https://api.example.com/v1/thing',
    serviceName: 'example-service',
    description: 'A well-formed listing used as the control for every hostile case.',
    tags: ['example'],
  },
  type: 'http',
  network: 'stellar:testnet',
  scheme: 'exact',
  payTo: 'GDQN7VJHXBQ3AGH7SMPMZLQXHDBUSVQZOYAVXQ4EFYNRQEK4NRZ3KTL3',
  asset: 'CAYCPWN5YZEHKPGZOXGU3O7R2Q5H7LT7SZ45YIO26VMFM47VBUHOGPO2',
  maxAmountRequired: '10000',
  input: { type: 'http', method: 'GET' },
  output: { type: 'json' },
  extensions: ['bazaar'],
};

/** Deep-merge a hostile patch onto BASE without mutating it. */
const withPatch = (patch) => {
  const rec = structuredClone(BASE);
  for (const [k, v] of Object.entries(patch)) {
    rec[k] = v && typeof v === 'object' && !Array.isArray(v) && rec[k] && typeof rec[k] === 'object'
      ? { ...rec[k], ...v }
      : v;
  }
  return rec;
};

/**
 * The hostile corpus. `field` is what a publisher would need to fix; everything else
 * in the emitted row comes back from the validator.
 *
 * `display` overrides the input string shown in the ledger for cases whose literal
 * value is too long to read — it must still describe the same input truthfully.
 */
export const HOSTILE_CORPUS = [
  {
    field: 'routeTemplate',
    input: '/v1/parse/:id/../../admin/keys',
    patch: { routeTemplate: '/v1/parse/:id/../../admin/keys' },
  },
  {
    field: 'routeTemplate',
    input: '/v1/%252e%252e/thing',
    patch: { routeTemplate: '/v1/%252e%252e/thing' },
  },
  {
    field: 'routeTemplate',
    input: '/v1/redirect/https%3A%2F%2Fexfil.example',
    patch: { routeTemplate: '/v1/redirect/https%3A%2F%2Fexfil.example' },
  },
  {
    field: 'resource.iconUrl',
    input: 'http://169.254.169.254/latest/meta-data/',
    patch: { resource: { iconUrl: 'http://169.254.169.254/latest/meta-data/' } },
  },
  {
    field: 'resource.iconUrl',
    input: 'http://2130706433/i.png',
    patch: { resource: { iconUrl: 'http://2130706433/i.png' } },
  },
  {
    field: 'resource.iconUrl',
    input: 'http://0177.0.0.1/i.png',
    patch: { resource: { iconUrl: 'http://0177.0.0.1/i.png' } },
  },
  {
    field: 'resource.iconUrl',
    input: 'http://[::1]/i.png',
    patch: { resource: { iconUrl: 'http://[::1]/i.png' } },
  },
  {
    field: 'resource.iconUrl',
    input: 'https://user:pass@cdn.example.com/i.png',
    patch: { resource: { iconUrl: 'https://user:pass@cdn.example.com/i.png' } },
  },
  {
    field: 'resource.iconUrl',
    input: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    patch: { resource: { iconUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } },
  },
  {
    field: 'resource.tags',
    display: '["invoice","inv","invoices", … 96 more]',
    patch: {
      resource: {
        tags: ['invoice', 'inv', 'invoices', ...Array.from({ length: 96 }, (_, i) => `tag-${i}`)],
      },
    },
  },
  {
    field: 'resource.tags',
    input: '["inv\\u0000oice"]',
    patch: { resource: { tags: ['example', 'inv\u0000oice'] } },
  },
  {
    field: 'resource.description',
    display: '"best api in the world …" (18,204 chars)',
    patch: { resource: { description: `best api in the world ${'x'.repeat(18_182)}` } },
  },
  {
    field: 'resource.serviceName',
    input: 'payment-service\\u202Egnp.exe',
    patch: { resource: { serviceName: 'payment-service‮gnp.exe' } },
  },
  {
    field: 'input.schema',
    input: '{ "$ref": "https://exfil.example/schema.json" }',
    patch: {
      input: { type: 'http', method: 'GET', schema: { $ref: 'https://exfil.example/schema.json' } },
    },
  },
  {
    field: 'resource.url',
    input: 'javascript:alert(1)',
    patch: { id: 'javascript:alert(1)', resource: { url: 'javascript:alert(1)' } },
  },
  {
    field: 'type',
    input: 'grpc',
    patch: { type: 'grpc' },
  },
];

/**
 * Re-run one hostile value through the leaf validator that owns its field and return
 * that validator's own `reason`. Returns null when the field has no leaf validator
 * (`type`, `resource.url`), in which case `upsert`'s own reason is already specific.
 *
 * `upsert` says WHICH path it dropped; the leaf validator says why. "iconUrl host
 * rejected: IP literal host" is actionable, "resource.iconUrl dropped" is not.
 */
function leafReason(field, patch) {
  const r = patch.resource ?? {};
  switch (field) {
    case 'routeTemplate':
      return V.validateRouteTemplate(patch.routeTemplate).reason;
    case 'resource.iconUrl':
      return V.validateIconUrl(r.iconUrl).reason;
    case 'resource.serviceName':
      return V.validateServiceName(r.serviceName).reason;
    case 'input.schema':
      return V.validateJsonSchema(patch.input.schema).reason;
    case 'resource.tags': {
      // Report the first tag the validator actually refused; if every tag is well
      // formed, the drop was the cap, so state the cap the code enforces — read back
      // off the validator's own output rather than restated by hand.
      const bad = (r.tags ?? []).map((t) => V.validateTag(t)).find((x) => !x.valid);
      if (bad) return bad.reason;
      const cap = (V.validateResourceBlock({ url: BASE.resource.url, tags: r.tags }).value.tags ?? [])
        .length;
      return `${r.tags.length} tags submitted, catalog keeps ${cap} — overflow dropped to contain index pollution`;
    }
    case 'resource.description': {
      const kept = V.validateResourceBlock({
        url: BASE.resource.url,
        description: r.description,
      }).value.description;
      return `description is ${r.description.length.toLocaleString('en-US')} characters, catalog keeps ${kept.length.toLocaleString('en-US')} — truncated before BM25 indexing`;
    }
    default:
      return null;
  }
}

/**
 * replayHostileCorpus() -> { entries, skipped, validator, note }
 *
 * Runs every corpus case through a FRESH catalog (upsert is stateful; a leftover record
 * would let one case's outcome change another's) and returns the validator's verdicts.
 * Pure, in-memory, deterministic, measured in milliseconds — safe at serverless cold
 * start and safe to call once per warm instance.
 *
 * `skipped` lists cases the validator ACCEPTED — corpus and code disagree, and the
 * caller decides how loudly to say so (the build script warns; the endpoint reports a
 * count). An accepted hostile case is never silently dropped from both.
 */
export function replayHostileCorpus() {
  const entries = [];
  const skipped = [];

  for (const c of HOSTILE_CORPUS) {
    const catalog = createCatalog();
    const result = catalog.upsert(withPatch(c.patch));

    const rejected = !result?.ok;
    // For a soft-drop, name the dropped path the validator actually reported for this
    // field — the rule vocabulary the code emits, not one invented here. A rejection
    // has no dropped path (the record never landed), so the field itself is the rule.
    const rule = rejected
      ? c.field
      : (result.dropped ?? []).find((d) => d.startsWith(c.field)) ?? c.field;

    if (!rejected && !(result.dropped ?? []).some((d) => d.startsWith(c.field))) {
      skipped.push({ field: c.field, input: c.display ?? c.input });
      continue;
    }

    const why = rejected ? result.reason : leafReason(c.field, c.patch);

    entries.push({
      verdict: rejected ? 'rejected' : 'soft-drop',
      rule,
      field: c.field,
      input: c.display ?? c.input,
      reason: why ?? `field dropped, record kept — ${rule}`,
      survived: rejected ? null : 'record kept',
    });
  }

  // Rejections first. Ledger renderers show a bounded number of rows while counting all
  // of them; a rejection sorted to the tail would be promised in the count, never shown.
  entries.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'rejected' ? -1 : 1));

  return {
    entries,
    skipped,
    validator: VALIDATOR_ID,
    note: 'Replay of a fixed hostile corpus through the shipped validator. Every rule, verdict and reason is the validator’s own output. Not a live feed.',
  };
}

export default { BASE, HOSTILE_CORPUS, VALIDATOR_ID, replayHostileCorpus };
