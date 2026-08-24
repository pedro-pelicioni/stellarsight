#!/usr/bin/env node
/**
 * Creates a throwaway buyer, from nothing, in one run.
 *
 * The nightly evidence job needs a funded account holding the seller's asset. The obvious
 * way to get one is a GitHub secret holding a funded key — which means the evidence
 * depends on a credential a reviewer cannot see, and a rotated secret silently ends the
 * series. So instead the job builds its buyer the same way a first-time visitor does:
 *
 *   1. generate a keypair (kept only in this process)
 *   2. Friendbot funds it with testnet XLM
 *   3. it signs its own changeTrust for the asset
 *   4. the PUBLIC faucet grants it the demo token
 *
 * Step 4 is the point: the nightly run dogfoods the same endpoint the browser playground
 * calls, so a faucet that breaks in production fails a job instead of failing a visitor.
 * Zero repository secrets are involved, and the whole thing is reproducible by anyone.
 *
 * Prints `PAYER_SECRET=S…` on stdout and appends it to $GITHUB_ENV when present.
 *
 * Usage:
 *   node scripts/ci-buyer.mjs --faucet https://stellarsight.xyz/playground/fund
 */

import { appendFileSync } from 'node:fs';
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from '@stellar/stellar-sdk';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const SITE = String(arg('site', 'https://stellarsight.xyz')).replace(/\/+$/, '');
const FAUCET = arg('faucet', `${SITE}/playground/fund`);
const HORIZON = arg('horizon', 'https://horizon-testnet.stellar.org');
const FRIENDBOT = arg('friendbot', 'https://friendbot.stellar.org');

const die = (msg) => {
  console.error(`ci-buyer: ${msg}`);
  process.exit(1);
};

/* 1. the key ─────────────────────────────────────────────────────────────── */

const kp = Keypair.random();
console.log(`buyer   ${kp.publicKey()}`);

/* 2. Friendbot ───────────────────────────────────────────────────────────── */

for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const r = await fetch(`${FRIENDBOT}/?addr=${kp.publicKey()}`, { signal: AbortSignal.timeout(30_000) });
    if (r.ok) break;
    const body = await r.text();
    // Friendbot answers 400 for an account it has already funded, which is success here.
    if (/op_already_exists|already funded/i.test(body)) break;
    if (attempt === 3) die(`Friendbot refused (${r.status}): ${body.slice(0, 200)}`);
  } catch (e) {
    if (attempt === 3) die(`Friendbot unreachable: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 2000 * attempt));
}
console.log('funded  via friendbot');

/* 3. the asset the seller charges in, and the trustline for it ───────────── */

// Read the asset off the live facilitator rather than hardcoding it: if the deployment
// changes assets, the nightly buyer follows without an edit here.
let assetCode;
let assetIssuer;
try {
  const health = await (await fetch(`${SITE}/health`, { signal: AbortSignal.timeout(15_000) })).json();
  assetCode = health.assetCode;
  // /health publishes the SAC contract id; the classic issuer comes from the faucet's
  // refusal below, which names the exact trustline it wants. Ask it first with no
  // trustline in place and read the issuer out of the reasoned 400.
  if (!assetCode) die('the facilitator /health did not report an assetCode');
} catch (e) {
  die(`could not read ${SITE}/health: ${e.message}`);
}

const probe = await (
  await fetch(FAUCET, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: kp.publicKey() }),
    signal: AbortSignal.timeout(20_000),
  })
).json();

if (probe.code === 'FAUCET_NO_TRUSTLINE') {
  assetIssuer = probe.assetIssuer;
} else if (probe.ok) {
  // Already funded us without needing a trustline — nothing left to do.
  console.log(`granted ${probe.amount} ${probe.assetCode} (no trustline needed)`);
} else {
  die(`faucet refused before the trustline step — ${probe.code}: ${probe.reason}`);
}

if (assetIssuer) {
  console.log(`asset   ${assetCode}:${assetIssuer}`);
  try {
    const horizon = new Horizon.Server(HORIZON);
    const account = await horizon.loadAccount(kp.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * 10),
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: new Asset(assetCode, assetIssuer) }))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    await horizon.submitTransaction(tx);
    console.log('trust   changeTrust submitted');
  } catch (e) {
    const codes = e?.response?.data?.extras?.result_codes;
    die(`changeTrust failed: ${codes ? JSON.stringify(codes) : e.message}`);
  }

  /* 4. the public faucet ──────────────────────────────────────────────────── */

  const grant = await (
    await fetch(FAUCET, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: kp.publicKey() }),
      signal: AbortSignal.timeout(30_000),
    })
  ).json();

  if (!grant.ok) {
    // The faucet's own reason IS the diagnosis — a rate limit, a missing secret, a
    // Horizon outage. Surface it verbatim rather than restating it as "funding failed".
    die(`faucet refused — ${grant.code}: ${grant.reason}`);
  }
  console.log(`granted ${grant.amount} ${grant.assetCode} (limiter: ${grant.limiter})${grant.txHash ? ` tx ${grant.txHash.slice(0, 12)}…` : ''}`);
}

/* export ─────────────────────────────────────────────────────────────────── */

if (process.env.GITHUB_ENV) {
  // Register the value as a secret BEFORE writing it anywhere. Actions echoes the `env:`
  // block of every downstream step, so without this the seed appears in a public log four
  // times over. The key is a single-run testnet throwaway holding 2 SXT, so nothing is at
  // risk — but a visible `S…` seed reads badly in a submission whose subject is the
  // security of a payment path, and the reader cannot tell which kind of key it is.
  console.log(`::add-mask::${kp.secret()}`);
  appendFileSync(process.env.GITHUB_ENV, `PAYER_SECRET=${kp.secret()}\n`);
  console.log('exported PAYER_SECRET to $GITHUB_ENV (masked)');
} else {
  // Local use only: the caller needs the value to re-run the payment by hand.
  console.log(`PAYER_SECRET=${kp.secret()}`);
}
