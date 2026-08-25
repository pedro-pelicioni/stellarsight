/**
 * test/catalog-integrity.test.mjs — STELLARSIGHT catalog trust-boundary tests.
 *
 * Run with:  node --test test/
 *
 * Every case below cites the bazaar spec rule it enforces. The catalog ingests data
 * that a paying client echoed back to the facilitator, so all of it is
 * attacker-controlled. Two behaviours are under test:
 *
 *   REJECTION  — hostile values never reach the index.
 *   SURVIVAL   — rejecting a hostile value never destroys the honest metadata around
 *                it. Without this, "poison one tag to delist a competitor" is a
 *                one-line attack.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCatalog,
  validateResourceBlock,
  validateRouteTemplate,
  validateJsonSchema,
  scoreHybrid,
} from '../packages/index/src/index.mjs';
import { validateResourceUrl } from '../packages/index/src/integrity.mjs';
import { seedCatalog } from '../packages/index/src/seed.mjs';

const GOOD_URL = 'https://api.example.com/v1/thing';
const draft = (extra = {}) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  ...extra,
});

/* ══════════════════════════════════════════════════════════════════════════
   routeTemplate
   [spec: non-empty; starts with "/"; matches ^/[a-zA-Z0-9_/:.\-~%]+$;
          must not contain ".."; must not contain "://";
          "All implementations decode percent-encoding (e.g. %2e%2e -> ..) before
          applying the traversal and scheme checks."]
   ══════════════════════════════════════════════════════════════════════════ */

test('routeTemplate: accepts a well-formed parameterised route', () => {
  // [spec: canonical template uses :param syntax, e.g. /users/:userId]
  assert.equal(validateRouteTemplate('/v1/postal-code/:cep').valid, true);
  assert.equal(validateRouteTemplate('/users/:userId/orders/:orderId').valid, true);
});

test('routeTemplate: rejects an empty string', () => {
  // [spec: routeTemplate must be a non-empty string]
  assert.equal(validateRouteTemplate('').valid, false);
  assert.equal(validateRouteTemplate(undefined).valid, false);
  assert.equal(validateRouteTemplate(null).valid, false);
});

test('routeTemplate: rejects a template that does not start with "/"', () => {
  // [spec: routeTemplate must start with "/"]
  assert.equal(validateRouteTemplate('users/:userId').valid, false);
  assert.equal(validateRouteTemplate('https://evil.example/x').valid, false);
});

test('routeTemplate: rejects literal ".." traversal', () => {
  // [spec: routeTemplate must not contain ".."]
  assert.equal(validateRouteTemplate('/a/../b').valid, false);
  assert.equal(validateRouteTemplate('/..').valid, false);
});

test('routeTemplate: rejects percent-encoded traversal /a/%2e%2e/b', () => {
  // [spec: decode percent-encoding (%2e%2e -> ..) BEFORE the traversal check]
  // The charset regex deliberately permits "%", so a raw-string ".." check alone
  // would pass this straight through.
  const r = validateRouteTemplate('/a/%2e%2e/b');
  assert.equal(r.valid, false);
  assert.match(r.reason, /traversal/);
});

test('routeTemplate: rejects double-encoded traversal /a/%252e%252e/b', () => {
  // [spec: decode percent-encoding before the traversal check]
  // One decode pass yields "%2e%2e", which is still not "..". Decoding must run to a
  // fixed point or this bypasses the check.
  const r = validateRouteTemplate('/a/%252e%252e/b');
  assert.equal(r.valid, false);
  assert.match(r.reason, /traversal/);
});

test('routeTemplate: rejects triple-encoded traversal', () => {
  // [spec: decode percent-encoding before the traversal check]
  assert.equal(validateRouteTemplate('/a/%25252e%25252e/b').valid, false);
});

test('routeTemplate: rejects uppercase percent-encoded traversal /a/%2E%2E/b', () => {
  // [spec: decode percent-encoding before the traversal check] — hex digits are
  // case-insensitive; a lowercase-only matcher would miss this.
  assert.equal(validateRouteTemplate('/a/%2E%2E/b').valid, false);
});

test('routeTemplate: rejects a literal "://"', () => {
  // [spec: routeTemplate must not contain "://"]
  assert.equal(validateRouteTemplate('/redirect/http://evil.example').valid, false);
});

test('routeTemplate: rejects percent-encoded "%3a%2f%2f" scheme separator', () => {
  // [spec: decode percent-encoding before the SCHEME check, not just the traversal one]
  const r = validateRouteTemplate('/redirect/http%3a%2f%2fevil.example');
  assert.equal(r.valid, false);
  assert.match(r.reason, /:\/\//);
});

test('routeTemplate: rejects characters outside the permitted charset', () => {
  // [spec: must match ^/[a-zA-Z0-9_/:.\-~%]+$]
  for (const bad of ['/a/<script>', '/a b', '/a?q=1', '/a#frag', '/a|b', '/a\\b', '/a{id}']) {
    assert.equal(validateRouteTemplate(bad).valid, false, `expected reject: ${bad}`);
  }
});

test('routeTemplate: fails closed on malformed percent-encoding', () => {
  // [spec: implementations decode percent-encoding] — "%zz" and a lone "%" cannot be
  // decoded, so the template cannot be canonicalised and cannot be safely checked.
  assert.equal(validateRouteTemplate('/a/%zz/b').valid, false);
  assert.equal(validateRouteTemplate('/a/%/b').valid, false);
  assert.equal(validateRouteTemplate('/a/%2/b').valid, false);
});

test('routeTemplate: rejects a protocol-relative template after decoding', () => {
  // [spec: must not contain "://"] — "//evil.example" is scheme-relative and resolves
  // off-origin in every browser and most HTTP clients.
  assert.equal(validateRouteTemplate('/%2f/evil.example/x').valid, false);
});

/* ══════════════════════════════════════════════════════════════════════════
   serviceName
   [spec: "Non-empty string of printable ASCII (U+0020–U+007E), length <= 32
           characters; contains no Unicode control characters (category Cc)."]
   ══════════════════════════════════════════════════════════════════════════ */

test('serviceName: a valid name survives untouched', () => {
  const { value, dropped } = validateResourceBlock({ url: GOOD_URL, serviceName: 'USD/BRL FX Rate' });
  assert.equal(value.serviceName, 'USD/BRL FX Rate');
  assert.deepEqual(dropped, []);
});

test('serviceName: longer than 32 characters is dropped', () => {
  // [spec: serviceName length <= 32]
  const { value, dropped } = validateResourceBlock({ url: GOOD_URL, serviceName: 'A'.repeat(33) });
  assert.equal(value.serviceName, undefined);
  assert.ok(dropped.includes('resource.serviceName'));
});

test('serviceName: exactly 32 characters is accepted (boundary)', () => {
  // [spec: length <= 32 is inclusive]
  const { value } = validateResourceBlock({ url: GOOD_URL, serviceName: 'A'.repeat(32) });
  assert.equal(value.serviceName?.length, 32);
});

test('serviceName: control characters are dropped', () => {
  // [spec: contains no Unicode control characters (category Cc)]
  for (const bad of ['Rate\u0007Feed', 'Rate\u0000Feed', 'Rate\nFeed', 'Rate\rFeed', 'Rate\u001BFeed', 'Rate\u007FFeed']) {
    const { value, dropped } = validateResourceBlock({ url: GOOD_URL, serviceName: bad });
    assert.equal(value.serviceName, undefined, `expected drop: ${JSON.stringify(bad)}`);
    assert.ok(dropped.includes('resource.serviceName'));
  }
});

test('serviceName: non-ASCII is dropped, including RTL-override spoofing', () => {
  // [spec: printable ASCII U+0020–U+007E only] — U+202E reverses rendering order and
  // is a classic display-spoofing primitive in any list UI.
  for (const bad of ['Café Ratings', 'Rate‮eht', 'Рате']) {
    const { value } = validateResourceBlock({ url: GOOD_URL, serviceName: bad });
    assert.equal(value.serviceName, undefined);
  }
});

test('serviceName: empty or whitespace-only is dropped', () => {
  // [spec: non-empty string]
  assert.equal(validateResourceBlock({ url: GOOD_URL, serviceName: '' }).value.serviceName, undefined);
  assert.equal(validateResourceBlock({ url: GOOD_URL, serviceName: '   ' }).value.serviceName, undefined);
});

/* ══════════════════════════════════════════════════════════════════════════
   tags
   [spec: "Array of strings; at most 5 entries; each entry non-empty, printable
           ASCII (U+0020–U+007E), length <= 32 characters, no Unicode control
           characters; entries deduplicated case-insensitively (first occurrence
           wins)."]
   ══════════════════════════════════════════════════════════════════════════ */

test('tags: more than 5 entries keeps the first 5 and drops the excess', () => {
  // [spec: at most 5 entries]
  const { value, dropped } = validateResourceBlock({
    url: GOOD_URL,
    tags: ['fx', 'rates', 'brl', 'oracle', 'stellar', 'spam6', 'spam7'],
  });
  assert.equal(value.tags.length, 5);
  assert.deepEqual(value.tags, ['fx', 'rates', 'brl', 'oracle', 'stellar']);
  assert.ok(dropped.some((d) => d.startsWith('resource.tags[5]')));
  assert.ok(dropped.some((d) => d.startsWith('resource.tags[6]')));
});

test('tags: case-insensitive dedupe keeps the first occurrence', () => {
  // [spec: entries deduplicated case-insensitively (first occurrence wins)]
  const { value, dropped } = validateResourceBlock({ url: GOOD_URL, tags: ['FX', 'fx', 'Fx', 'rates'] });
  assert.deepEqual(value.tags, ['FX', 'rates']);
  assert.ok(dropped.some((d) => d.includes('duplicate')));
});

test('tags: dedupe does not let a duplicate consume one of the 5 slots', () => {
  // [spec: at most 5 entries, deduplicated] — dedupe must precede the cap, otherwise
  // an attacker pads with duplicates to push honest tags out.
  const { value } = validateResourceBlock({
    url: GOOD_URL,
    tags: ['fx', 'FX', 'Fx', 'fX', 'rates', 'oracle', 'stellar', 'brl'],
  });
  assert.deepEqual(value.tags, ['fx', 'rates', 'oracle', 'stellar', 'brl']);
});

test('tags: an over-long entry is dropped and the others SURVIVE', () => {
  // [spec: each entry <= 32 characters] + SURVIVAL INVARIANT
  const { value, dropped } = validateResourceBlock({
    url: GOOD_URL,
    tags: ['fx', 'B'.repeat(33), 'rates'],
  });
  assert.deepEqual(value.tags, ['fx', 'rates']);
  assert.ok(dropped.includes('resource.tags[1]'));
});

test('tags: a control-character entry is dropped and the others SURVIVE', () => {
  // [spec: no Unicode control characters] + SURVIVAL INVARIANT
  const { value } = validateResourceBlock({ url: GOOD_URL, tags: ['fx', 'ra\u0009tes', 'oracle'] });
  assert.deepEqual(value.tags, ['fx', 'oracle']);
});

test('tags: non-string and non-array inputs are rejected without throwing', () => {
  // [spec: tags is an array of strings]
  assert.equal(validateResourceBlock({ url: GOOD_URL, tags: 'fx,rates' }).value.tags, undefined);
  assert.deepEqual(validateResourceBlock({ url: GOOD_URL, tags: ['fx', 42, null, {}] }).value.tags, ['fx']);
});

/* ══════════════════════════════════════════════════════════════════════════
   iconUrl — SSRF surface
   [spec: absolute http/https; no data:/file:/other schemes; no userinfo;
          not an IP literal, loopback, all-digit hostname or hex literal;
          <= 2048 characters; no control characters.
          "Implementations MUST percent-decode the iconUrl host before applying
           the IP / localhost checks."]
   ══════════════════════════════════════════════════════════════════════════ */

test('iconUrl: a valid absolute https URL survives', () => {
  const { value, dropped } = validateResourceBlock({ url: GOOD_URL, iconUrl: 'https://cdn.example.com/icon.svg' });
  assert.equal(value.iconUrl, 'https://cdn.example.com/icon.svg');
  assert.deepEqual(dropped, []);
});

test('iconUrl: loopback literal 127.0.0.1 is dropped', () => {
  // [spec: host must not be an IP literal or loopback]
  const { value, dropped } = validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://127.0.0.1/icon.png' });
  assert.equal(value.iconUrl, undefined);
  assert.ok(dropped.includes('resource.iconUrl'));
});

test('iconUrl: 32-bit decimal host 2130706433 is dropped', () => {
  // [spec: host must not be an all-digit hostname] — 2130706433 === 127.0.0.1
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://2130706433/i.png' }).value.iconUrl, undefined);
});

test('iconUrl: hex host 0x7f.1 and 0x7f000001 are dropped', () => {
  // [spec: host must not be a hex literal] — both resolve to 127.0.0.1
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://0x7f.1/i.png' }).value.iconUrl, undefined);
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://0x7f000001/i.png' }).value.iconUrl, undefined);
});

test('iconUrl: octal host 0177.0.0.1 is dropped', () => {
  // [spec: host must not be an IP literal] — leading-zero labels parse as octal
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://0177.0.0.1/i.png' }).value.iconUrl, undefined);
});

test('iconUrl: IPv6 loopback [::1] is dropped', () => {
  // [spec: host must not be an IP literal, including IPv6 [::1]]
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://[::1]/i.png' }).value.iconUrl, undefined);
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://[0:0:0:0:0:0:0:1]/i.png' }).value.iconUrl, undefined);
});

test('iconUrl: unspecified address 0.0.0.0 is dropped', () => {
  // [spec: host must not be an IP literal] — 0.0.0.0 routes to localhost on Linux
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://0.0.0.0:8080/i.png' }).value.iconUrl, undefined);
});

test('iconUrl: link-local metadata address 169.254.169.254 is dropped', () => {
  // [spec: host must not be an IP literal] — the cloud metadata endpoint is the
  // highest-value SSRF target in any hosted facilitator.
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://169.254.169.254/latest/meta-data/' }).value.iconUrl, undefined);
});

test('iconUrl: the hostname "localhost" and its subdomains are dropped', () => {
  // [spec: host must not be loopback]
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://localhost:4022/i.png' }).value.iconUrl, undefined);
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'https://evil.localhost/i.png' }).value.iconUrl, undefined);
});

test('iconUrl: percent-encoded host is decoded before the loopback check', () => {
  // [spec: "Implementations MUST percent-decode the iconUrl host before applying the
  //  IP / localhost checks."] — %31%32%37 is "127".
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://%31%32%37.0.0.1/i.png' }).value.iconUrl, undefined);
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://%6c%6f%63%61%6c%68%6f%73%74/i.png' }).value.iconUrl, undefined);
});

test('iconUrl: data: URIs are dropped', () => {
  // [spec: no data:, file:// or other schemes] — a data: icon is arbitrary
  // attacker-controlled bytes rendered inside the console UI.
  assert.equal(
    validateResourceBlock({ url: GOOD_URL, iconUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }).value.iconUrl,
    undefined,
  );
});

test('iconUrl: file:, javascript: and ftp: schemes are dropped', () => {
  // [spec: absolute http/https only]
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/i.png', 'gopher://example.com/']) {
    assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: bad }).value.iconUrl, undefined, `expected drop: ${bad}`);
  }
});

test('iconUrl: embedded userinfo is dropped', () => {
  // [spec: no userinfo] — "https://cdn.example.com@evil.example/" reads as the CDN in
  // a UI but resolves to evil.example.
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'https://cdn.example.com@evil.example/i.png' }).value.iconUrl, undefined);
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'https://user:pass@cdn.example.com/i.png' }).value.iconUrl, undefined);
});

test('iconUrl: longer than 2048 characters is dropped', () => {
  // [spec: iconUrl <= 2048 characters]
  const long = `https://cdn.example.com/${'a'.repeat(2100)}.svg`;
  assert.ok(long.length > 2048);
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: long }).value.iconUrl, undefined);
});

test('iconUrl: embedded control characters are dropped before URL parsing', () => {
  // [spec: no control characters] — the WHATWG URL parser SILENTLY STRIPS tab/CR/LF,
  // so parsing first would normalise "http://127.0.0\n.1/" into something a naive
  // check accepts while a downstream fetcher sees the raw bytes.
  for (const bad of ['https://cdn.example.com/i\u0000.svg', 'https://cdn.exa\nmple.com/i.svg', 'https://cdn.exa\tmple.com/i.svg']) {
    assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: bad }).value.iconUrl, undefined);
  }
});

test('iconUrl: a bare hostname with no dot is dropped', () => {
  // [spec: host must not be loopback / a bare internal name] — "intranet" resolves via
  // the facilitator's own search domain.
  assert.equal(validateResourceBlock({ url: GOOD_URL, iconUrl: 'http://intranet/i.png' }).value.iconUrl, undefined);
});

/* ══════════════════════════════════════════════════════════════════════════
   JSON Schema
   [spec: "$ref and $id values must be same-document JSON Pointer fragments
           (starting with #); external references are not allowed" /
          "Facilitators must not resolve external references when validating
           untrusted schemas"]
   ══════════════════════════════════════════════════════════════════════════ */

test('schema: an external $ref is rejected', () => {
  // [spec: external references are not allowed]
  const r = validateJsonSchema(draft({ properties: { a: { $ref: 'https://evil.example/schema.json' } } }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /external reference/);
});

test('schema: an external $id is rejected', () => {
  // [spec: $id must be a same-document fragment]
  assert.equal(validateJsonSchema(draft({ $id: 'https://evil.example/root.json' })).valid, false);
});

test('schema: a relative or file $ref is rejected', () => {
  // [spec: $ref must start with "#"] — relative refs still resolve off-document.
  assert.equal(validateJsonSchema(draft({ properties: { a: { $ref: './other.json' } } })).valid, false);
  assert.equal(validateJsonSchema(draft({ properties: { a: { $ref: 'file:///etc/passwd' } } })).valid, false);
  assert.equal(validateJsonSchema(draft({ properties: { a: { $ref: '//evil.example/s.json' } } })).valid, false);
});

test('schema: a same-document JSON Pointer fragment is accepted', () => {
  // [spec: same-document JSON Pointer fragments (starting with #) are allowed]
  const ok = draft({
    $defs: { Pair: { type: 'string' } },
    properties: { pair: { $ref: '#/$defs/Pair' } },
  });
  assert.equal(validateJsonSchema(ok).valid, true);
});

test('schema: the $schema meta-schema URI is NOT treated as an external reference', () => {
  // [spec: schemas must use JSON Schema Draft 2020-12] — $schema is expected to be an
  // absolute URI; only $ref/$id are constrained to fragments.
  assert.equal(validateJsonSchema(draft({ properties: { a: { type: 'string' } } })).valid, true);
});

test('schema: an external $ref nested deep inside the document is rejected', () => {
  // [spec: external references are not allowed] — the check must walk the whole
  // document, not just the top level.
  const nested = draft({
    properties: {
      outer: { type: 'array', items: { anyOf: [{ type: 'null' }, { $ref: 'https://evil.example/deep.json' }] } },
    },
  });
  assert.equal(validateJsonSchema(nested).valid, false);
});

test('schema: a cyclic schema object terminates instead of hanging', () => {
  // Robustness: a self-referencing object must not spin the validator forever.
  const cyclic = draft({ properties: {} });
  cyclic.properties.self = cyclic;
  assert.equal(validateJsonSchema(cyclic).valid, true);
});

/* ══════════════════════════════════════════════════════════════════════════
   SURVIVAL INVARIANT — the core soft-drop guarantee
   ══════════════════════════════════════════════════════════════════════════ */

test('SURVIVAL: one bad tag does not drop the whole record', () => {
  // Soft-drop semantics: an invalid FIELD is discarded, the surrounding metadata
  // survives. Otherwise a single poisoned tag is a delisting attack.
  const { value, dropped } = validateResourceBlock({
    url: GOOD_URL,
    serviceName: 'FX Rate Service',
    description: 'A perfectly legitimate exchange rate endpoint with a full description.',
    tags: ['fx', 'C'.repeat(40), 'rates'],
    iconUrl: 'https://cdn.example.com/fx.svg',
  });
  assert.equal(value.serviceName, 'FX Rate Service');
  assert.ok(value.description.startsWith('A perfectly legitimate'));
  assert.deepEqual(value.tags, ['fx', 'rates']);
  assert.equal(value.iconUrl, 'https://cdn.example.com/fx.svg');
  assert.deepEqual(dropped, ['resource.tags[1]']);
});

test('SURVIVAL: a hostile iconUrl does not drop serviceName, description or tags', () => {
  // SURVIVAL INVARIANT across field boundaries.
  const { value, dropped } = validateResourceBlock({
    url: GOOD_URL,
    serviceName: 'Weather Forecast',
    description: 'Seven-day forecast for any municipality, refreshed hourly from station data.',
    tags: ['weather', 'forecast'],
    iconUrl: 'http://169.254.169.254/latest/meta-data/',
  });
  assert.equal(value.serviceName, 'Weather Forecast');
  assert.deepEqual(value.tags, ['weather', 'forecast']);
  assert.ok(value.description.length > 20);
  assert.deepEqual(dropped, ['resource.iconUrl']);
});

test('SURVIVAL: an invalid routeTemplate is discarded but the record is still indexed', () => {
  // [spec: routeTemplate is optional; an invalid one falls back to the concrete URL]
  const catalog = createCatalog();
  const r = catalog.upsert({
    resource: { url: GOOD_URL, serviceName: 'Thing API' },
    type: 'http',
    routeTemplate: '/v1/%252e%252e/thing',
    input: { type: 'http', method: 'GET' },
    output: { type: 'json' },
  });
  assert.equal(r.ok, true);
  assert.ok(r.dropped.includes('routeTemplate'));
  assert.equal(catalog.size(), 1);
  assert.equal(catalog.get(GOOD_URL).routeTemplate, undefined);
  assert.equal(catalog.get(GOOD_URL).resource.serviceName, 'Thing API');
});

test('SURVIVAL: an external $ref drops only the schema, not the record', () => {
  // [spec: external references are not allowed] — refusing to STORE the schema is
  // enough; the endpoint itself stays discoverable.
  const catalog = createCatalog();
  const r = catalog.upsert({
    resource: { url: GOOD_URL, serviceName: 'Thing API' },
    type: 'http',
    input: { type: 'http', method: 'GET', schema: draft({ properties: { a: { $ref: 'https://evil.example/s.json' } } }) },
    output: { type: 'json' },
  });
  assert.equal(r.ok, true);
  assert.ok(r.dropped.includes('input.schema'));
  assert.equal(catalog.get(GOOD_URL).input.schema, undefined);
  assert.equal(catalog.size(), 1);
});

/* ══════════════════════════════════════════════════════════════════════════
   Identity — hard rejections and the MCP tuple key
   ══════════════════════════════════════════════════════════════════════════ */

test('identity: a record with a missing or non-absolute url is rejected outright', () => {
  // resource.url is IDENTITY, not metadata — there is nothing to key on without it.
  const catalog = createCatalog();
  for (const bad of [undefined, '', 'not-a-url', '/relative/path', 'javascript:alert(1)']) {
    const r = catalog.upsert({ resource: { url: bad }, type: 'http', input: { type: 'http', method: 'GET' } });
    assert.equal(r.ok, false, `expected reject: ${bad}`);
    assert.match(r.reason, /resource\.url/);
  }
  assert.equal(catalog.size(), 0);
});

test('identity: MCP tools sharing one URL are DISTINCT records', () => {
  // [spec: "For MCP tools, the unique resource identifier is the tuple
  //  (resource.url, input.toolName). Since MCP multiplexes multiple tools over a
  //  single server endpoint, resource.url alone may not be unique."]
  const catalog = createCatalog();
  const url = 'https://mcp.example.com/mcp';
  for (const toolName of ['submit_transaction', 'simulate_contract', 'fetch_ledger_entry']) {
    const r = catalog.upsert({
      resource: { url, serviceName: 'Tools MCP' },
      type: 'mcp',
      input: { type: 'mcp', toolName, inputSchema: draft({ properties: {} }) },
      output: { type: 'json' },
    });
    assert.equal(r.ok, true);
  }
  assert.equal(catalog.size(), 3, 'keying on resource.url alone would collapse these to 1');
  assert.ok(catalog.get(`${url}#submit_transaction`));
  assert.ok(catalog.get(`${url}#simulate_contract`));
  assert.ok(catalog.get(`${url}#fetch_ledger_entry`));
});

test('identity: re-upserting the same (url, toolName) tuple updates in place', () => {
  // The tuple is a stable primary key — re-observing a tool must not duplicate it.
  const catalog = createCatalog();
  const rec = {
    resource: { url: 'https://mcp.example.com/mcp', serviceName: 'Tools MCP' },
    type: 'mcp',
    input: { type: 'mcp', toolName: 'submit_transaction' },
    output: { type: 'json' },
    settlements: 5,
  };
  catalog.upsert(rec);
  catalog.upsert({ ...rec, settlements: 9 });
  assert.equal(catalog.size(), 1);
  // Monotonic merge: settlement history is never lost on re-observation.
  assert.equal(catalog.get('https://mcp.example.com/mcp#submit_transaction').settlements, 9);
});

test('identity: an MCP record without input.toolName is rejected', () => {
  // [spec: toolName is REQUIRED for MCP input] — without it there is no tuple key.
  const catalog = createCatalog();
  const r = catalog.upsert({
    resource: { url: 'https://mcp.example.com/mcp' },
    type: 'mcp',
    input: { type: 'mcp' },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /toolName/);
});

test('identity: an unknown resource type is rejected', () => {
  // [spec: input.type is "http" or "mcp"]
  const catalog = createCatalog();
  assert.equal(catalog.upsert({ resource: { url: GOOD_URL }, type: 'grpc' }).ok, false);
  assert.equal(catalog.upsert({ resource: { url: GOOD_URL } }).ok, false);
});

/* ══════════════════════════════════════════════════════════════════════════
   Discovery surface — filters, ranking and cursor pagination
   ══════════════════════════════════════════════════════════════════════════ */

test('discovery: list() applies the spec filters and offset pagination', () => {
  // [spec: GET /discovery/resources?type&payTo&scheme&network&extensions&limit&offset]
  const catalog = createCatalog();
  seedCatalog(catalog);

  const all = catalog.list({ limit: 100 });
  assert.equal(all.total, catalog.size());

  const mcp = catalog.list({ type: 'mcp', limit: 100 });
  assert.ok(mcp.total >= 4);
  assert.ok(mcp.items.every((r) => r.type === 'mcp'));

  const net = catalog.list({ network: 'stellar:testnet', limit: 100 });
  assert.equal(net.total, catalog.size());
  assert.equal(catalog.list({ network: 'eip155:8453', limit: 100 }).total, 0);

  const ext = catalog.list({ extensions: 'bazaar', limit: 100 });
  assert.equal(ext.total, catalog.size());
  assert.equal(catalog.list({ extensions: 'nonexistent', limit: 100 }).total, 0);

  const page1 = catalog.list({ limit: 5, offset: 0 });
  const page2 = catalog.list({ limit: 5, offset: 5 });
  assert.equal(page1.items.length, 5);
  assert.equal(page1.limit, 5);
  assert.equal(page2.offset, 5);
  const ids = new Set([...page1.items, ...page2.items].map((r) => r.id));
  assert.equal(ids.size, 10, 'offset pages must not overlap');
});

test('discovery: search() returns the spec response shape', () => {
  // [spec: GET /discovery/search response carries partialResults and
  //  pagination { limit, cursor }, cursor null when unavailable]
  const catalog = createCatalog();
  seedCatalog(catalog);

  const r = catalog.search({ query: 'exchange rate', limit: 3 });
  assert.equal(typeof r.partialResults, 'boolean');
  assert.ok(r.pagination && typeof r.pagination === 'object');
  assert.equal(r.pagination.limit, 3);
  assert.ok(r.pagination.cursor === null || typeof r.pagination.cursor === 'string');
  assert.ok(Array.isArray(r.items));
});

test('discovery: cursor pagination walks the result set without overlap', () => {
  // [spec: pagination.cursor is an advisory continuation cursor]
  const catalog = createCatalog();
  seedCatalog(catalog);

  const seen = [];
  let cursor;
  let guard = 0;
  do {
    const page = catalog.search({ query: 'stellar payments data', limit: 2, cursor });
    seen.push(...page.items.map((i) => i.id));
    cursor = page.pagination.cursor;
    // partialResults must be true exactly while a next page exists.
    assert.equal(page.partialResults, cursor !== null);
    guard++;
  } while (cursor && guard < 50);

  assert.equal(new Set(seen).size, seen.length, 'cursor pages must not repeat results');
  assert.ok(seen.length > 2);
});

test('discovery: a cursor minted for a different query is ignored, not misapplied', () => {
  // The cursor is opaque and fingerprinted; replaying it against another query must
  // restart cleanly rather than return a slice of someone else's result set.
  const catalog = createCatalog();
  seedCatalog(catalog);

  const a = catalog.search({ query: 'exchange rate', limit: 2 });
  assert.ok(a.pagination.cursor);
  const b = catalog.search({ query: 'weather forecast', limit: 2, cursor: a.pagination.cursor });
  const fresh = catalog.search({ query: 'weather forecast', limit: 2 });
  assert.deepEqual(b.items.map((i) => i.id), fresh.items.map((i) => i.id));

  // A malformed or forged cursor must not throw.
  assert.doesNotThrow(() => catalog.search({ query: 'x', cursor: 'not-base64-!!' }));
});

test('ranking: scoreHybrid returns _score and a full _explain breakdown', () => {
  // The UI renders _explain so a user can see WHY a result ranked where it did.
  const catalog = createCatalog();
  seedCatalog(catalog);

  const ranked = scoreHybrid('exchange rate dollar', catalog.all());
  assert.ok(ranked.length > 0);
  const top = ranked[0];
  assert.equal(typeof top._score, 'number');
  assert.ok(top._explain.terms.length > 0);
  assert.ok(top._explain.matchedFields.length > 0);
  for (const part of ['relevance', 'completeness', 'popularity', 'recency']) {
    assert.equal(typeof top._explain.parts[part], 'number', `missing _explain.parts.${part}`);
  }
  // The four parts must sum to the reported score (linear blend, no hidden terms).
  const sum = Object.values(top._explain.parts).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - top._score) < 1e-3, `parts ${sum} != score ${top._score}`);
  // Scores must be monotonically non-increasing.
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1]._score >= ranked[i]._score);
});

test('ranking: accent folding makes diacritics irrelevant to matching', () => {
  // Accent folding is text normalization, not a language feature: the same word
  // spelled with or without diacritics must reach the same index term.
  const catalog = createCatalog();
  catalog.upsert({
    resource: {
      url: 'https://api.example.com/v1/cafe',
      serviceName: 'Cafe Price Index',
      description: 'Wholesale cafe commodity prices refreshed daily from exchange settlement data.',
      tags: ['commodities', 'prices'],
    },
    type: 'http',
    input: { type: 'http', method: 'GET' },
    output: { type: 'json' },
  });
  const withAccent = catalog.search({ query: 'café' });
  const without = catalog.search({ query: 'cafe' });
  assert.equal(withAccent.items.length, 1);
  assert.equal(without.items.length, 1);
  assert.equal(withAccent.items[0].id, without.items[0].id);
});

test('ranking: relevance dominates the quality prior', () => {
  // The quality prior tops out at 0.25 against a relevance term worth up to 1.0, so a
  // popular-but-irrelevant record can never displace a relevant one.
  const catalog = createCatalog();
  const common = { type: 'http', input: { type: 'http', method: 'GET' }, output: { type: 'json' } };
  catalog.upsert({
    ...common,
    resource: {
      url: 'https://api.example.com/popular',
      serviceName: 'Sausage Delivery Tracker',
      description: 'Tracks meat delivery vans across the country in real time with live positions.',
      tags: ['logistics', 'tracking'],
      iconUrl: 'https://cdn.example.com/x.svg',
    },
    settlements: 900000,
    lastSeenAt: Date.now(),
  });
  catalog.upsert({
    ...common,
    resource: { url: 'https://api.example.com/obscure', serviceName: 'Barometric Pressure Feed' },
    settlements: 0,
    lastSeenAt: Date.now() - 200 * 86_400_000,
  });
  const r = catalog.search({ query: 'barometric pressure' });
  assert.equal(r.items[0].resource.url, 'https://api.example.com/obscure');
});

test('ranking: metadata completeness breaks ties between equally relevant records', () => {
  // The completeness signal is the only quality evidence available on a cold catalog.
  const catalog = createCatalog();
  const now = Date.now();
  catalog.upsert({
    type: 'http',
    resource: {
      url: 'https://api.example.com/documented',
      serviceName: 'Widget Pricing API',
      description: 'Returns current widget pricing for any catalogued widget, updated every minute.',
      tags: ['widget', 'pricing'],
      iconUrl: 'https://cdn.example.com/w.svg',
    },
    input: {
      type: 'http',
      method: 'GET',
      schema: draft({ properties: { sku: { type: 'string', description: 'Widget stock keeping unit to price.' } } }),
    },
    output: { type: 'json', format: 'price', example: { price: '1.00' } },
    settlements: 10,
    lastSeenAt: now,
  });
  catalog.upsert({
    type: 'http',
    resource: { url: 'https://api.example.com/bare', serviceName: 'Widget Pricing API' },
    input: { type: 'http', method: 'GET', queryParams: { sku: 'x' } },
    settlements: 10,
    lastSeenAt: now,
  });
  const r = catalog.search({ query: 'widget pricing' });
  assert.equal(r.items[0].resource.url, 'https://api.example.com/documented');
  assert.ok(r.items[0]._explain.quality.completeness > r.items[1]._explain.quality.completeness);
});

test('seed: the demo catalog loads cleanly and exercises the completeness spread', () => {
  const catalog = createCatalog();
  const summary = seedCatalog(catalog);
  assert.deepEqual(summary.rejected, [], 'no seed record should be rejected');
  assert.ok(summary.inserted >= 24, `expected >= 24 seeded resources, got ${summary.inserted}`);

  // Three MCP tools share one URL — proof the tuple key is doing real work.
  const shared = catalog.all().filter((r) => r.resource.url === 'https://mcp.stellartools.example/mcp');
  assert.equal(shared.length, 3);
  assert.equal(new Set(shared.map((r) => r.input.toolName)).size, 3);

  // Completeness must actually vary, otherwise the signal is dead weight.
  const scores = scoreHybrid('', catalog.all()).map((d) => d._explain.quality.completeness);
  assert.ok(Math.max(...scores) >= 0.9, 'expected at least one fully documented resource');
  assert.ok(Math.min(...scores) <= 0.3, 'expected at least one near-bare resource');
});

/* ── a public catalog must not advertise what only its operator can reach ──── */

test('resource.url on a loopback or private host is refused', () => {
  const unreachable = [
    'http://localhost:4022/exact/stellar',
    'http://sub.localhost/x',
    'http://127.0.0.1/x',
    'http://127.9.9.9/x',
    'http://10.0.0.5/x',
    'http://172.16.4.4/x',
    'http://192.168.1.4/x',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/x',
    'http://[::1]/x',
    'http://api.internal/x',
    'http://box.local/x',
  ];
  for (const url of unreachable) {
    const r = validateResourceUrl(url);
    assert.equal(r.valid, false, `${url} should be refused`);
    assert.match(r.reason, /not publicly reachable/);
  }
});

test('a public host — including a bare public IP — is still accepted', () => {
  // Deliberately looser than the iconUrl deny-list: that one is an SSRF control and
  // rejects IP literals outright. A resource can legitimately live on a public IP.
  for (const url of [
    'https://stellarsight.xyz/v1/fx/usd-brl',
    'https://93.184.216.34/api',
    'http://172.32.0.1/x', // just outside the 172.16/12 private block
    'https://[2606:4700::1111]/x',
  ]) {
    assert.equal(validateResourceUrl(url).valid, true, `${url} should be accepted`);
  }
});

test('local development can opt back in, and the opt-in is explicit', () => {
  const prior = process.env.STELLARSIGHT_ALLOW_PRIVATE_RESOURCES;
  try {
    process.env.STELLARSIGHT_ALLOW_PRIVATE_RESOURCES = '1';
    assert.equal(validateResourceUrl('http://localhost:4023/v1/thing').valid, true);
    // Any value other than exactly "1" is not an opt-in.
    process.env.STELLARSIGHT_ALLOW_PRIVATE_RESOURCES = 'true';
    assert.equal(validateResourceUrl('http://localhost:4023/v1/thing').valid, false);
  } finally {
    if (prior === undefined) delete process.env.STELLARSIGHT_ALLOW_PRIVATE_RESOURCES;
    else process.env.STELLARSIGHT_ALLOW_PRIVATE_RESOURCES = prior;
  }
});

test('an unreachable resource is dropped on restore, not just on catalog', () => {
  // catalog.upsert() is the single door for the settle path AND the store-restore path,
  // so a record that was stored before this rule existed stops being served once it is
  // re-read. That is what removes the localhost rows from the live catalog.
  const catalog = createCatalog();
  const stored = {
    id: 'http://localhost:4022/exact/stellar',
    resource: { url: 'http://localhost:4022/exact/stellar', serviceName: 'e2e relay' },
    type: 'http',
    scheme: 'exact',
    network: 'stellar:testnet',
    payTo: 'GSELLER',
    asset: 'CASSET',
    maxAmountRequired: '100000',
    settlements: 2,
  };
  assert.equal(catalog.upsert(stored).ok, false, 'a stored loopback record must not restore');
  assert.equal(catalog.list({ limit: 10 }).items.length, 0);
});
