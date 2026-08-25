#!/usr/bin/env node
/**
 * scripts/latency-baseline.mjs — how fast discovery actually answers.
 *
 * §3.6 asks for fast discovery lookups and interactive-grade latency. The repo already
 * publishes settlement latency, and its least flattering number at that
 * (docs/LOAD-BASELINE.md). Discovery had no number at all — only a monitoring threshold
 * that is not live yet, which is a plan rather than a measurement.
 *
 * What this measures, stated plainly because it bounds what the number means: wall-clock
 * time from this machine, over the public internet, to first byte of a parsed JSON body.
 * That includes network round-trip and CDN behaviour, so it is what a caller experiences
 * rather than what the server would report about itself. Server-side timing would look
 * better and mean less.
 *
 * Cached and uncached are measured separately and never averaged together:
 *   - uncached — a unique cache-busting parameter per request, so the CDN cannot serve it
 *     and the function actually runs. This is the honest number.
 *   - cached — the same URL repeatedly, which is what a real caller polling a hot query
 *     sees. Reported because it is true, and labelled because quoting it alone would be
 *     the kind of flattering half-measurement this repo tries not to publish.
 *
 * Usage:
 *   node scripts/latency-baseline.mjs
 *   node scripts/latency-baseline.mjs --site https://stellarsight.xyz --samples 30 --emit
 */
import { writeEvidence } from './lib/evidence.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const SITE = (flag('site', 'https://stellarsight.xyz')).replace(/\/$/, '');
const SAMPLES = Math.max(5, Number(flag('samples', '25')));
const WARMUP = 3;

const PROBES = [
  { key: 'search', label: 'GET /discovery/search', path: '/discovery/search?query=invoice%20ocr&limit=10' },
  { key: 'search-filtered', label: 'GET /discovery/search + filters', path: '/discovery/search?query=fx%20rate&network=stellar:testnet&limit=10' },
  { key: 'resources', label: 'GET /discovery/resources', path: '/discovery/resources?limit=25' },
  { key: 'resources-filtered', label: 'GET /discovery/resources + filters', path: '/discovery/resources?scheme=exact&network=stellar:testnet&limit=25' },
];

const quantile = (sorted, q) => {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
};

async function timeOnce(url) {
  const started = performance.now();
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  const ms = performance.now() - started;
  return { ms, ok: res.ok && body !== null, status: res.status, cache: res.headers.get('x-vercel-cache') ?? null };
}

async function measure(path, { bustCache }) {
  const samples = [];
  const cacheStates = new Set();
  let failures = 0;
  for (let i = 0; i < SAMPLES + WARMUP; i += 1) {
    const sep = path.includes('?') ? '&' : '?';
    // A monotonic counter, not a random value: the script must stay deterministic enough
    // that two runs differ by network conditions rather than by what was requested.
    const url = `${SITE}${path}${bustCache ? `${sep}_cb=${i}-${SAMPLES}` : ''}`;
    try {
      const r = await timeOnce(url);
      if (!r.ok) failures += 1;
      if (r.cache) cacheStates.add(r.cache);
      if (i >= WARMUP && r.ok) samples.push(r.ms); // warm-up excluded from the statistics
    } catch {
      failures += 1;
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    failures,
    cacheStates: [...cacheStates],
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    min: sorted.length ? Math.round(sorted[0]) : null,
    max: sorted.length ? Math.round(sorted[sorted.length - 1]) : null,
  };
}

const probes = [];
for (const probe of PROBES) {
  const uncached = await measure(probe.path, { bustCache: true });
  const cached = await measure(probe.path, { bustCache: false });
  probes.push({ ...probe, uncached, cached });
}

const worstUncachedP95 = Math.max(...probes.map((p) => p.uncached.p95 ?? 0));
const totalFailures = probes.reduce((n, p) => n + p.uncached.failures + p.cached.failures, 0);

const payload = {
  site: SITE,
  method:
    'Wall-clock from the measuring machine over the public internet to a parsed JSON body. Includes network round-trip and CDN behaviour; not a server-side timer.',
  samplesPerProbe: SAMPLES,
  warmupDiscarded: WARMUP,
  cacheNote:
    'uncached forces a CDN miss with a unique parameter per request, so the function runs. cached repeats one URL, which is what a caller polling a hot query sees. They are never averaged together.',
  probes,
  worstUncachedP95Ms: worstUncachedP95,
  failures: totalFailures,
};

if (has('emit')) {
  const { path } = writeEvidence('discovery-latency', payload);
  console.log(`[latency] wrote ${path.replace(`${process.cwd()}/`, '')}`);
}

console.log(`\nDiscovery latency — ${SITE}, ${SAMPLES} samples per probe (${WARMUP} warm-up discarded)\n`);
console.log('  probe                                uncached p50/p95/p99      cached p50/p95/p99');
for (const p of probes) {
  const fmt = (s) => `${String(s.p50).padStart(5)}/${String(s.p95).padStart(5)}/${String(s.p99).padStart(5)}ms`;
  console.log(`  ${p.label.padEnd(36)} ${fmt(p.uncached)}   ${fmt(p.cached)}`);
}
console.log(`\n  worst uncached p95: ${worstUncachedP95}ms · failed requests: ${totalFailures}\n`);
if (totalFailures > 0) process.exit(1);
