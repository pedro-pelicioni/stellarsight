/**
 * packages/index/src/integrity.mjs — STELLARSIGHT: the catalog is a TRUST BOUNDARY.
 *
 * Per the bazaar spec, the client echoes the `bazaar` extension (including the whole
 * `resource` block) from `PaymentRequired` into its `PaymentPayload`. The facilitator
 * then catalogs it. Therefore EVERY field here is attacker-controlled and reaches
 * other agents' screens and, worse, other agents' HTTP clients.
 *
 * Two rules drive this module:
 *
 *   1. FAIL CLOSED on anything ambiguous (malformed percent-encoding, unparseable URL).
 *   2. SOFT DROP, never hard reject: an invalid FIELD is discarded and the surrounding
 *      metadata SURVIVES. A single bad tag must not erase an otherwise good listing —
 *      that would hand an attacker a cheap denial-of-listing primitive against
 *      honest publishers who happen to share a URL prefix.
 *
 * Spec references are cited inline as [spec: ...].
 */

/** Printable ASCII, U+0020–U+007E. Excludes all C0/C1 controls by construction. */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
const HAS_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

const MAX_SERVICE_NAME = 32;
const MAX_TAGS = 5;
const MAX_TAG_LEN = 32;
const MAX_ICON_URL = 2048;
const MAX_DESCRIPTION = 512;
const MAX_ROUTE_TEMPLATE = 1024;
const DECODE_PASSES = 5;

/**
 * Percent-decode until the string stops changing (or we hit `cap` passes).
 *
 * [spec: "All implementations decode percent-encoding (e.g. %2e%2e -> ..) before
 *  applying the traversal and scheme checks."]
 *
 * A SINGLE decode pass is not enough: `%252e%252e` decodes to `%2e%2e`, which decodes
 * to `..`. We therefore loop to a fixed point. The pass cap bounds the work an attacker
 * can force with a deeply nested encoding; hitting the cap without stabilising is
 * treated as hostile (fail closed).
 *
 * Malformed sequences (`%zz`, a lone `%`) make decodeURIComponent throw. We do NOT
 * "best effort" past that — an input we cannot canonicalise is an input we cannot
 * safely check.
 */
export function decodeToFixedPoint(input, cap = DECODE_PASSES) {
  let cur = String(input);
  for (let i = 0; i <= cap; i++) {
    let next;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return { ok: false, reason: 'malformed-percent-encoding' };
    }
    if (next === cur) return { ok: true, value: cur, passes: i };
    cur = next;
  }
  return { ok: false, reason: 'percent-encoding-decode-limit-exceeded' };
}

/* ───────────────────────────── routeTemplate ───────────────────────────── */

/**
 * validateRouteTemplate(t) -> { valid: boolean, reason?: string }
 *
 * [spec: routeTemplate MUST be a non-empty string, MUST start with "/", MUST match
 *  ^/[a-zA-Z0-9_/:.\-~%]+$, MUST NOT contain "..", MUST NOT contain "://"]
 *
 * The charset regex intentionally permits `%`, so the literal `..` and `://` checks
 * would be trivially bypassed by `%2e%2e` and `%3a%2f%2f`. Both checks therefore run
 * against the fixed-point decoding, not the raw string.
 *
 * Callers discard an invalid template and fall back to the concrete URL.
 */
export function validateRouteTemplate(t) {
  if (typeof t !== 'string') return { valid: false, reason: 'routeTemplate must be a string' };
  if (t.length === 0) return { valid: false, reason: 'routeTemplate must be non-empty' };
  if (t.length > MAX_ROUTE_TEMPLATE) return { valid: false, reason: 'routeTemplate too long' };
  if (!t.startsWith('/')) return { valid: false, reason: 'routeTemplate must start with "/"' };
  if (!/^\/[a-zA-Z0-9_/:.\-~%]+$/.test(t)) {
    return { valid: false, reason: 'routeTemplate contains characters outside ^/[a-zA-Z0-9_/:.\\-~%]+$' };
  }

  const decoded = decodeToFixedPoint(t);
  if (!decoded.ok) return { valid: false, reason: decoded.reason };
  const d = decoded.value;

  if (HAS_CONTROL.test(d)) return { valid: false, reason: 'routeTemplate contains control characters after decoding' };
  if (d.includes('..')) return { valid: false, reason: 'routeTemplate contains path traversal ".." after decoding' };
  if (d.includes('://')) return { valid: false, reason: 'routeTemplate contains "://" after decoding' };
  if (!d.startsWith('/')) return { valid: false, reason: 'routeTemplate must start with "/" after decoding' };
  if (d.startsWith('//')) return { valid: false, reason: 'routeTemplate is protocol-relative after decoding' };

  return { valid: true };
}

/* ──────────────────────────── JSON Schema safety ──────────────────────────── */

/**
 * validateJsonSchema(schema) -> { valid: boolean, reason?: string }
 *
 * [spec: "$ref and $id values must be same-document JSON Pointer fragments (starting
 *  with #); external references are not allowed" / "Facilitators must not resolve
 *  external references when validating untrusted schemas"]
 *
 * An external $ref in a cataloged schema is an SSRF primitive aimed at every consumer
 * that later resolves it, so we refuse to STORE it, not merely to resolve it.
 * `$schema` is exempt: it names the meta-schema (draft 2020-12) and is expected to be
 * an absolute URI.
 */
export function validateJsonSchema(schema, { maxDepth = 32 } = {}) {
  const seen = new Set();
  const REF_KEYS = new Set(['$ref', '$id', '$dynamicRef']);

  function walk(node, depth, path) {
    if (depth > maxDepth) return { valid: false, reason: `schema nested deeper than ${maxDepth} at ${path}` };
    if (node === null || typeof node !== 'object') return { valid: true };
    if (seen.has(node)) return { valid: true }; // cycle guard
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const r = walk(node[i], depth + 1, `${path}[${i}]`);
        if (!r.valid) return r;
      }
      return { valid: true };
    }

    for (const [key, value] of Object.entries(node)) {
      if (REF_KEYS.has(key)) {
        if (typeof value !== 'string') return { valid: false, reason: `${path}.${key} must be a string` };
        if (!value.startsWith('#')) {
          return { valid: false, reason: `external reference not allowed: ${path}.${key} = ${truncate(value, 80)}` };
        }
      }
      const r = walk(value, depth + 1, `${path}.${key}`);
      if (!r.valid) return r;
    }
    return { valid: true };
  }

  if (schema === null || typeof schema !== 'object') return { valid: false, reason: 'schema must be an object' };
  return walk(schema, 0, '$');
}

/* ────────────────────────────── icon URL / SSRF ────────────────────────────── */

/**
 * A hostname is an IP literal in disguise if EVERY dot-separated label is numeric —
 * decimal, octal (leading 0) or hex (0x…). This one rule covers the whole family of
 * classic SSRF evasions in a single pass:
 *
 *   127.0.0.1        dotted quad
 *   2130706433       32-bit decimal            [spec: "not ... all-digit hostname"]
 *   0x7f.0.0.1       hex label                 [spec: "not ... hex literal"]
 *   0x7f.1           short-form hex
 *   0177.0.0.1       octal
 *   0.0.0.0          unspecified address
 */
function isNumericHost(host) {
  if (host.length === 0) return false;
  const labels = host.split('.');
  if (labels.some((l) => l.length === 0)) return false;
  return labels.every((l) => /^(0[xX][0-9a-fA-F]+|\d+)$/.test(l));
}

function isBlockedHost(host) {
  const h = host.toLowerCase();
  if (h.length === 0) return 'empty host';
  // [spec: iconUrl host must not be an IPv6 literal, e.g. [::1]]
  if (h.startsWith('[') || h.includes(':')) return 'IPv6 / bracketed host literal';
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback hostname';
  if (isNumericHost(h)) return 'IP literal host (decimal/octal/hex)';
  // Defence in depth beyond the spec's literal list: internal-only TLDs.
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localdomain')) return 'internal-only TLD';
  return null;
}

/**
 * isPubliclyRoutableHost(host) -> null | string (the reason it is not)
 *
 * A catalog is a discovery index, so a resource nobody outside can reach is not a
 * discovery result — it is noise that inflates the catalog's apparent size and wastes the
 * click of anyone who tries it. This is not the `iconUrl` deny-list: that one is an SSRF
 * control and is deliberately paranoid (it rejects bare IP literals outright). A resource
 * legitimately can live on a public IP, so this check rejects only what is genuinely
 * unreachable from outside: loopback, private and link-local ranges, and internal-only
 * names.
 *
 * The escape hatch is `STELLARSIGHT_ALLOW_PRIVATE_RESOURCES=1`, which local development
 * sets so `npm run dev:all` still catalogs the seller it just paid on `localhost`.
 */
export function isPubliclyRoutableHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h.length === 0) return 'empty host';
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback hostname';
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localdomain')) return 'internal-only TLD';

  // IPv6: loopback, link-local (fe80::/10), unique-local (fc00::/7), unspecified.
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return 'IPv6 loopback';
    if (/^fe[89ab][0-9a-f]:/.test(h)) return 'IPv6 link-local';
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return 'IPv6 unique-local';
    return null;
  }

  // IPv4 dotted quad only — a hostname that merely looks numeric is left to DNS.
  const quad = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (quad) {
    const [a, b] = quad.slice(1).map(Number);
    if (a === 127) return 'IPv4 loopback';
    if (a === 10) return 'IPv4 private range';
    if (a === 172 && b >= 16 && b <= 31) return 'IPv4 private range';
    if (a === 192 && b === 168) return 'IPv4 private range';
    if (a === 169 && b === 254) return 'IPv4 link-local';
    if (a === 0) return 'IPv4 unspecified';
  }
  return null;
}

/**
 * validateIconUrl(u) -> { valid: boolean, reason?: string, value?: string }
 *
 * [spec: absolute http/https, no data:/file:/other schemes, no userinfo, IDN-normalized
 *  host, not IP literal / loopback / all-digit / hex literal, <= 2048 chars, no control
 *  characters. "Implementations MUST percent-decode the iconUrl host before applying
 *  the IP / localhost checks."]
 *
 * Control characters are rejected BEFORE parsing on purpose: the WHATWG URL parser
 * silently strips tab/CR/LF, so `http://127.0.0\n.1/` would otherwise be normalised
 * into something that passes a naive check while a downstream fetcher sees the raw
 * string. We reject the raw form instead.
 */
export function validateIconUrl(u) {
  if (typeof u !== 'string') return { valid: false, reason: 'iconUrl must be a string' };
  if (u.length === 0) return { valid: false, reason: 'iconUrl must be non-empty' };
  if (u.length > MAX_ICON_URL) return { valid: false, reason: `iconUrl exceeds ${MAX_ICON_URL} characters` };
  if (HAS_CONTROL.test(u)) return { valid: false, reason: 'iconUrl contains control characters' };
  if (/\s/.test(u)) return { valid: false, reason: 'iconUrl contains whitespace' };

  let url;
  try {
    url = new URL(u);
  } catch {
    return { valid: false, reason: 'iconUrl is not an absolute URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { valid: false, reason: `iconUrl scheme "${url.protocol}" is not http/https` };
  }
  if (url.username !== '' || url.password !== '') {
    return { valid: false, reason: 'iconUrl must not contain userinfo' };
  }

  // Percent-decode the host to a fixed point BEFORE the IP / localhost checks.
  const decoded = decodeToFixedPoint(url.hostname);
  if (!decoded.ok) return { valid: false, reason: `iconUrl host: ${decoded.reason}` };
  const host = decoded.value.replace(/^\[|\]$/g, (m) => m); // keep brackets visible to isBlockedHost

  const blocked = isBlockedHost(host);
  if (blocked) return { valid: false, reason: `iconUrl host rejected: ${blocked}` };
  if (!host.includes('.')) return { valid: false, reason: 'iconUrl host is not a fully-qualified domain name' };

  return { valid: true, value: url.href };
}

/* ─────────────────────────── serviceName / tags ─────────────────────────── */

/** [spec: serviceName — non-empty printable ASCII (U+0020–U+007E), <= 32 chars, no Cc] */
export function validateServiceName(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'serviceName must be a string' };
  const v = s.trim();
  if (v.length === 0) return { valid: false, reason: 'serviceName must be non-empty' };
  if (v.length > MAX_SERVICE_NAME) return { valid: false, reason: `serviceName exceeds ${MAX_SERVICE_NAME} characters` };
  if (HAS_CONTROL.test(v)) return { valid: false, reason: 'serviceName contains control characters' };
  if (!PRINTABLE_ASCII.test(v)) return { valid: false, reason: 'serviceName contains non-printable-ASCII characters' };
  return { valid: true, value: v };
}

/** [spec: each tag — non-empty printable ASCII, <= 32 chars, no Cc] */
export function validateTag(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'tag must be a string' };
  const v = s.trim();
  if (v.length === 0) return { valid: false, reason: 'tag must be non-empty' };
  if (v.length > MAX_TAG_LEN) return { valid: false, reason: `tag exceeds ${MAX_TAG_LEN} characters` };
  if (HAS_CONTROL.test(v)) return { valid: false, reason: 'tag contains control characters' };
  if (!PRINTABLE_ASCII.test(v)) return { valid: false, reason: 'tag contains non-printable-ASCII characters' };
  return { valid: true, value: v };
}

/** The resource URL itself. Unlike the metadata this is IDENTITY — it cannot soft-drop. */
export function validateResourceUrl(u) {
  if (typeof u !== 'string' || u.length === 0) return { valid: false, reason: 'resource.url must be a non-empty string' };
  if (u.length > MAX_ICON_URL) return { valid: false, reason: 'resource.url too long' };
  if (HAS_CONTROL.test(u)) return { valid: false, reason: 'resource.url contains control characters' };
  let url;
  try {
    url = new URL(u);
  } catch {
    return { valid: false, reason: 'resource.url is not an absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { valid: false, reason: `resource.url scheme "${url.protocol}" is not http/https` };
  }
  if (url.username !== '' || url.password !== '') return { valid: false, reason: 'resource.url must not contain userinfo' };

  // A publicly served catalog must not advertise resources only its own operator can
  // reach. This ran without the check for a while and it showed: three
  // `http://localhost:402x/exact/stellar` rows — real settlements from the upstream e2e
  // suite, run through a relay — sat in the public catalog as half of everything that was
  // not seed data. The settlements are real; the listings were unusable to anyone else.
  //
  // Because `catalog.upsert()` is the single door for both the settle path and the
  // restore-from-store path, adding it here both stops new ones and drops the existing
  // ones the next time the catalog loads.
  if (process.env.STELLARSIGHT_ALLOW_PRIVATE_RESOURCES !== '1') {
    const unreachable = isPubliclyRoutableHost(url.hostname);
    if (unreachable) {
      return { valid: false, reason: `resource.url host is not publicly reachable (${unreachable})` };
    }
  }
  return { valid: true, value: url.href };
}

/* ──────────────────────── the soft-drop entry point ──────────────────────── */

/**
 * validateResourceBlock(block) -> { value, dropped: string[] }
 *
 * SOFT DROP semantics. `value` is a fresh object holding only the fields that passed;
 * `dropped` names every field that was discarded, using dotted/indexed paths
 * (`resource.iconUrl`, `resource.tags[3]`) so a publisher can act on the feedback.
 *
 * SURVIVAL INVARIANT: a hostile value in any one field never removes another field.
 * `resource.url` is the exception — it is the record's identity, so callers treat a
 * dropped url as a hard rejection of the whole record.
 */
export function validateResourceBlock(block) {
  const dropped = [];
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    return { value: {}, dropped: ['resource'] };
  }

  const value = {};

  // url — identity
  const url = validateResourceUrl(block.url);
  if (url.valid) value.url = url.value;
  else dropped.push('resource.url');

  // serviceName
  if (block.serviceName !== undefined) {
    const r = validateServiceName(block.serviceName);
    if (r.valid) value.serviceName = r.value;
    else dropped.push('resource.serviceName');
  }

  // description — no ASCII restriction in the spec (non-ASCII prose is expected), but it is
  // still untrusted display text: strip controls, cap length.
  if (block.description !== undefined) {
    if (typeof block.description !== 'string') {
      dropped.push('resource.description');
    } else {
      const cleaned = block.description.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
      if (cleaned.length === 0) dropped.push('resource.description');
      else if (cleaned.length > MAX_DESCRIPTION) {
        value.description = cleaned.slice(0, MAX_DESCRIPTION);
        dropped.push('resource.description:truncated');
      } else {
        value.description = cleaned;
      }
    }
  }

  // tags — per-entry drop, case-insensitive dedupe (first occurrence wins), cap 5
  if (block.tags !== undefined) {
    if (!Array.isArray(block.tags)) {
      dropped.push('resource.tags');
    } else {
      const kept = [];
      const seen = new Set();
      for (let i = 0; i < block.tags.length; i++) {
        const r = validateTag(block.tags[i]);
        if (!r.valid) {
          dropped.push(`resource.tags[${i}]`);
          continue;
        }
        const key = r.value.toLowerCase();
        if (seen.has(key)) {
          dropped.push(`resource.tags[${i}]:duplicate`);
          continue;
        }
        if (kept.length >= MAX_TAGS) {
          dropped.push(`resource.tags[${i}]:over-limit`);
          continue;
        }
        seen.add(key);
        kept.push(r.value);
      }
      if (kept.length > 0) value.tags = kept;
    }
  }

  // iconUrl
  if (block.iconUrl !== undefined) {
    const r = validateIconUrl(block.iconUrl);
    if (r.valid) value.iconUrl = r.value;
    else dropped.push('resource.iconUrl');
  }

  return { value, dropped };
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export default {
  validateResourceBlock,
  validateRouteTemplate,
  validateJsonSchema,
  validateIconUrl,
  validateServiceName,
  validateTag,
  validateResourceUrl,
  decodeToFixedPoint,
};
