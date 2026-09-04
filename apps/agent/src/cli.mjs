#!/usr/bin/env node
/**
 * STELLARSIGHT — terminal demo of the agent loop.
 *
 *   stellarsight "usd to brl exchange rate"          (npx stellarsight, or npm run demo -w apps/agent)
 *   stellarsight "..." --dry-run                      discovery only, never spends
 *   stellarsight "..." --max-price 20000
 *
 * Narrates the four movements of an instrument fix:
 *   QUERY -> SIGHTS TAKEN -> BEARING FIXED -> PAYMENT SETTLED
 *
 * Degrades cleanly: if the index or the seller is down, it says exactly what is
 * down and what to start, and still exits with a readable frame.
 */

import pc from 'picocolors';

import { loadConfig, payAndFetch } from './pay.mjs';
import { search } from './bazaar.mjs';

/* ------------------------------------------------------------------ *
 * Palette + primitives
 * ------------------------------------------------------------------ */
const W = Math.min(Math.max(process.stdout.columns || 84, 72), 96);
const dim = (s) => pc.dim(s);
const key = (s) => pc.cyan(s);
const good = (s) => pc.green(s);
const warn = (s) => pc.yellow(s);
const bad = (s) => pc.red(s);
const hi = (s) => pc.bold(pc.white(s));

const BOX = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', rail: '│', tee: '├', dot: '·' };

const strip = (s) => String(s).replace(/\[[0-9;]*m/g, '');
const width = (s) => strip(s).length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

function out(line = '') {
  process.stdout.write(line + '\n');
}

function rule(char = BOX.h, n = W) {
  return dim(char.repeat(n));
}

/** Top banner. */
function banner(cfg, mode) {
  const title = ' STELLARSIGHT ';
  const sub = ' Find what to pay for on Stellar ';
  out();
  out(dim(BOX.tl + BOX.h.repeat(W - 2) + BOX.tr));
  out(dim(BOX.v) + pad(`  ${pc.bold(pc.cyan(title.trim()))}${dim(' — ')}${dim(sub.trim())}`, W - 2) + dim(BOX.v));
  out(
    dim(BOX.v) +
      pad(
        `  ${dim('x402')} ${dim(BOX.dot)} ${dim(cfg.network)} ${dim(BOX.dot)} ${dim('index')} ${dim(cfg.indexUrl)} ${dim(BOX.dot)} ${mode}`,
        W - 2
      ) +
      dim(BOX.v)
  );
  out(dim(BOX.bl + BOX.h.repeat(W - 2) + BOX.br));
}

/** A movement heading on the left rail. */
function movement(n, label, note = '') {
  out();
  out(`${pc.cyan(BOX.tee)}${dim(BOX.h.repeat(2))} ${pc.bold(pc.white(`${n}  ${label}`))} ${note ? dim(note) : ''}`);
}

function rail(text = '') {
  out(`${pc.cyan(BOX.rail)}   ${text}`);
}

function railKV(k, v, kw = 14) {
  rail(`${dim(pad(k, kw))} ${v}`);
}

/** Horizontal score meter. */
function meter(score, max, cells = 22) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, score / max)) : 0;
  const filled = Math.round(ratio * cells);
  return pc.cyan('█'.repeat(filled)) + dim('░'.repeat(cells - filled));
}

const money = (atomic, code) => `${hi(String(atomic ?? '?'))} ${dim(code)}`;
const ms = (n) => `${String(n ?? 0).padStart(5)}${dim('ms')}`;

/* ------------------------------------------------------------------ *
 * Args
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const args = { query: null, dryRun: false, maxPrice: null, limit: 5 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--max-price') args.maxPrice = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]) || 5;
    else if (a === '--help' || a === '-h') args.help = true;
    else rest.push(a);
  }
  args.query = rest.join(' ').trim() || null;
  return args;
}

function usage() {
  out();
  out(hi('  stellarsight') + dim(' — agent-side demo of the Stellar Bazaar payment loop'));
  out();
  out(`  ${key('stellarsight')} ${dim('"usd to brl exchange rate"')}`);
  out();
  out(`  ${dim('--dry-run, -n')}     discover and rank only; never signs, never spends`);
  out(`  ${dim('--max-price N')}     refuse to pay above N atomic units`);
  out(`  ${dim('--limit N')}         number of candidates to sight (default 5)`);
  out();
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
const DEFAULT_QUERY = 'usd to brl exchange rate';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const cfg = loadConfig();
  const query = args.query || DEFAULT_QUERY;

  const mode = args.dryRun ? warn('DRY RUN — no funds move') : good('LIVE — testnet funds will move');
  banner(cfg, mode);

  /* -- 1. QUERY --------------------------------------------------- */
  movement('01', 'QUERY');
  rail();
  rail(`${dim('"')}${hi(query)}${dim('"')}`);
  rail();
  rail(dim('The agent has no API key, no docs, no vendor account. Only a wallet.'));
  railKV('payer', cfg.payerPublic ? pc.magenta(cfg.payerPublic) : warn('PAYER_SECRET not set — discovery only'));

  /* -- 2. SIGHTS TAKEN -------------------------------------------- */
  movement('02', 'SIGHTS TAKEN', dim(`GET ${cfg.indexUrl}/discovery/search`));
  const found = await search({ query, limit: args.limit, maxPrice: args.maxPrice ?? undefined });

  if (!found.ok) {
    rail();
    rail(`${bad('rejected')} ${dim(found.code)}`);
    rail(dim(wrap(found.reason, W - 8)));
    rail();
    footerDown();
    process.exitCode = 2;
    return;
  }

  const maxScore = Math.max(...found.items.map((i) => Number(i.score ?? i._score ?? 0)), 0.0001);
  rail();
  found.items.forEach((item, idx) => {
    const score = Number(item.score ?? item._score ?? 0);
    const rank = dim(String(idx + 1).padStart(2, '0'));
    const name = idx === 0 ? pc.bold(pc.cyan(item.serviceName || item.id || '(unnamed)')) : hi(item.serviceName || item.id || '(unnamed)');
    rail(`${rank} ${meter(score, maxScore)} ${dim(score.toFixed(3).padStart(6))}  ${name}`);
    rail(`   ${dim(' '.repeat(22))} ${dim(truncate(item.url || item.id || '', W - 34))}`);
    rail(
      `   ${dim(' '.repeat(22))} ${money(item.maxAmountRequired, cfg.assetCode)} ${dim(BOX.dot)} ${dim(item.type || '?')} ${dim(BOX.dot)} ${dim(`${item.settlements ?? 0} settled`)}`
    );
    const ex = explainLine(item._explain);
    if (ex) rail(`   ${dim(' '.repeat(22))} ${dim(ex)}`);
    rail();
  });
  if (found.partialResults) rail(warn('partial results — the index answered before finishing the sweep'));

  /* -- 3. BEARING FIXED ------------------------------------------- */
  const chosen = found.items[0];
  movement('03', 'BEARING FIXED');
  rail();
  railKV('resource', pc.bold(pc.cyan(chosen.serviceName || chosen.id)));
  railKV('url', hi(chosen.url || chosen.id));
  railKV('price', money(chosen.maxAmountRequired, cfg.assetCode));
  railKV('pay to', pc.magenta(chosen.payTo || '?'));
  railKV('asset', dim(chosen.asset || '?'));
  railKV('network', dim(chosen.network || cfg.network));
  if (chosen.description) railKV('about', dim(truncate(chosen.description, W - 22)));

  if (args.dryRun) {
    rail();
    rail(warn('dry run — stopping before the 402 challenge. Nothing was signed.'));
    out();
    out(rule());
    return;
  }

  /* -- 4. PAYMENT SETTLED ----------------------------------------- */
  movement('04', 'PAYMENT SETTLED', dim('x402: challenge · sign · retry · settle'));
  rail();

  const res = await payAndFetch(chosen.url || chosen.id, {
    maxPrice: args.maxPrice ?? undefined,
    onEvent: (e) => {
      if (e.stage === 'request') {
        rail(`${dim('->')} ${key('GET')} ${dim(truncate(e.url, W - 12))} ${dim('(unpaid)')}`);
      } else if (e.stage === 'challenge') {
        rail(`${dim('<-')} ${warn('402 Payment Required')} ${dim(`${e.challengeMs}ms`)}`);
        rail(`   ${dim('PAYMENT-REQUIRED')} ${dim(`x402 v${e.x402Version}`)} ${dim(BOX.dot)} ${dim(`${e.accepts.length} option(s)`)}`);
        rail(`   ${dim('quote')}  ${money(e.price, cfg.assetCode)} ${dim('->')} ${pc.magenta(short(e.payTo))} ${dim(BOX.dot)} ${dim(short(e.asset))}`);
      } else if (e.stage === 'sign') {
        rail(`${dim('..')} ${warn('replaying a previously signed header')}`);
      } else if (e.stage === 'signed') {
        rail(`${dim('..')} ${key('signing')} Soroban auth entry with ${pc.magenta(short(e.payer))} ${dim(`${e.signMs}ms`)}`);
        rail(`   ${dim(`PAYMENT-SIGNATURE ${e.headerBytes} bytes`)}`);
      } else if (e.stage === 'settled') {
        rail(`${dim('->')} ${key('retry')} with payment header`);
        rail(`${dim('<-')} ${good('settled on stellar:testnet')} ${dim(`${e.settleMs}ms`)}`);
      } else if (e.stage === 'free') {
        rail(`${dim('<-')} ${warn(`HTTP ${e.status} — this resource is not priced; nothing was paid`)}`);
      }
    }
  });

  rail();
  if (!res.ok) {
    rail(`${bad('REJECTED')}  ${pc.bold(pc.red(res.code))}`);
    rail(dim(wrap(res.reason, W - 8)));
    rail();
    timingsBlock(res.timings);
    out();
    out(rule());
    process.exitCode = 3;
    return;
  }

  if (res.txHash) {
    railKV('tx', good(res.txHash));
    if (res.explorerUrl) railKV('explorer', pc.underline(pc.cyan(res.explorerUrl)));
    railKV('paid', `${money(res.amount, cfg.assetCode)} ${dim('->')} ${pc.magenta(short(res.payTo))}`);
    railKV('payer', pc.magenta(res.payer || cfg.payerPublic || '?'));
  } else {
    railKV('tx', warn('no settlement hash returned by the seller'));
  }
  if (res.extensions?.bazaar) {
    railKV('bazaar', dim(`${res.extensions.bazaar.status}${res.extensions.bazaar.rejectedReason ? ` — ${res.extensions.bazaar.rejectedReason}` : ''}`));
  }

  rail();
  timingsBlock(res.timings);

  /* -- payload ----------------------------------------------------- */
  out();
  out(`${pc.cyan(BOX.tee)}${dim(BOX.h.repeat(2))} ${pc.bold(pc.white('   UNLOCKED PAYLOAD'))} ${dim(`HTTP ${res.status}`)}`);
  out(`${pc.cyan(BOX.rail)}`);
  const pretty = typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2);
  for (const line of String(pretty ?? '(empty body)').split('\n').slice(0, 40)) {
    out(`${pc.cyan(BOX.rail)}   ${good(line)}`);
  }
  out(`${pc.cyan(BOX.rail)}`);
  out(`${pc.cyan(BOX.bl)}${dim(BOX.h.repeat(W - 1))}`);
  out();
  out(`  ${dim('Discovered, priced, paid and delivered without a human in the loop.')}`);
  out();
}

/* ------------------------------------------------------------------ *
 * Small renderers
 * ------------------------------------------------------------------ */
function timingsBlock(t = {}) {
  const total = Math.max(1, t.totalMs || 1);
  const bar = (n) => {
    const cells = Math.max(0, Math.round(((n || 0) / total) * 30));
    return pc.cyan('▏'.repeat(0)) + pc.cyan('▄'.repeat(cells)) + dim('▁'.repeat(30 - cells));
  };
  rail(dim('timings'));
  rail(`  ${dim(pad('challenge', 10))} ${ms(t.challengeMs)}  ${bar(t.challengeMs)}`);
  rail(`  ${dim(pad('sign', 10))} ${ms(t.signMs)}  ${bar(t.signMs)}`);
  rail(`  ${dim(pad('settle', 10))} ${ms(t.settleMs)}  ${bar(t.settleMs)}`);
  rail(`  ${dim(pad('total', 10))} ${hi(String(t.totalMs ?? 0).padStart(5))}${dim('ms')}`);
}

function footerDown() {
  const cfg = loadConfig();
  out();
  out(dim('  Nothing was signed and nothing was spent.'));
  out(dim(`  Bring the stack up:  ${pc.reset(pc.cyan('npm run dev:all'))}${dim('   (facilitator :4021 · index :4022 · seller :4023)')}`));
  out(dim(`  Or point elsewhere:  ${pc.reset(pc.cyan('INDEX_URL=https://... stellarsight "..."'))}`));
  out();
  out(rule());
}

function explainLine(explain) {
  if (!explain || typeof explain !== 'object') return null;
  const parts = [];
  if (explain.bm25 !== undefined) parts.push(`bm25 ${Number(explain.bm25).toFixed(2)}`);
  if (explain.fieldBoost !== undefined) parts.push(`boost ${Number(explain.fieldBoost).toFixed(2)}`);
  if (explain.matchedFields) {
    const f = Array.isArray(explain.matchedFields) ? explain.matchedFields : Object.keys(explain.matchedFields);
    if (f.length) parts.push(`fields ${f.join('+')}`);
  }
  if (explain.terms) {
    const raw = Array.isArray(explain.terms) ? explain.terms : Object.keys(explain.terms);
    const t = raw.map((x) => (typeof x === 'string' ? x : (x?.term ?? ''))).filter(Boolean);
    if (t.length) parts.push(`terms ${t.slice(0, 6).join('+')}`);
  }
  if (explain.quality?.completeness !== undefined) {
    parts.push(`completeness ${Number(explain.quality.completeness).toFixed(2)}`);
  }
  if (!parts.length) {
    const compact = JSON.stringify(explain);
    return compact.length > 2 ? `explain ${truncate(compact, 60)}` : null;
  }
  return parts.join(`  ${BOX.dot}  `);
}

const short = (s) => (typeof s === 'string' && s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s || '?');
const truncate = (s, n) => (String(s).length > n ? `${String(s).slice(0, Math.max(0, n - 1))}…` : String(s));

function wrap(text, n) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > n) {
      lines.push(line.trim());
      line = w;
    } else line += ` ${w}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join(`\n${pc.cyan(BOX.rail)}   `);
}

main().catch((err) => {
  out();
  out(`  ${bad('unexpected failure')} ${dim(err instanceof Error ? err.message : String(err))}`);
  out();
  process.exit(1);
});
