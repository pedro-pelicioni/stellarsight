/**
 * apps/facilitator/src/faucet.mjs — the playground's SXT drip.
 *
 * The playground's promise is "your first paid call in about a minute, with no wallet and
 * no signup". Friendbot funds the throwaway account with XLM and the visitor's own browser
 * signs the trustline, but nothing on the public internet will give that account the
 * SEP-41 token the seller actually charges in. This endpoint does, in one fixed, tiny
 * grant, on testnet only.
 *
 * SXT is self-issued and worth nothing, so the risk here is not theft — it is a public
 * write endpoint that submits transactions, i.e. a way to burn the operator's XLM and
 * hammer Horizon. Hence: a per-account grant that cannot repeat inside 24h, a per-IP
 * daily cap, a global daily cap, and a hard testnet lock no environment variable can
 * unpick. When Redis is unreachable the limiter degrades to per-instance counters and the
 * RESPONSE SAYS SO (`limiter: "per-instance"`) rather than implying a guarantee the
 * deployment cannot make.
 *
 * Mounted twice, from one definition: `app.post('/playground/fund', createFaucetHandler())`
 * on the local facilitator, and api/playground/fund.mjs on the deployment.
 *
 * Every rejection carries a machine `code` AND a non-empty `reason`, per the contract the
 * rest of this repo holds itself to.
 */

import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from '@stellar/stellar-sdk';

import { createKv } from '../../../packages/index/src/store.mjs';
// One definition of "who is calling", shared with the facilitator's limiter so the two
// surfaces cannot drift into hashing different things.
import { clientIpHash } from './rate-limit.mjs';
import { CORS_HEADERS, handlePreflight, readJsonBody, sendJson } from '../../../packages/index/src/serverless.mjs';

/** Testnet, always. Not an env var: a faucet that can be pointed at pubnet is a wallet. */
const NETWORK_PASSPHRASE = Networks.TESTNET;
const DEFAULT_HORIZON = 'https://horizon-testnet.stellar.org';

const G_ADDRESS = /^G[A-Z2-7]{55}$/;
const DAY_SECONDS = 86_400;

const num = (v, dflt) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/**
 * Per-instance fallback counters. Deliberately module scope: on a warm serverless
 * instance this still stops a tight loop, and the response never claims it is more than
 * that.
 */
const memory = { accounts: new Map(), ips: new Map(), day: { key: null, count: 0 } };

function memoryLimiter(now) {
  return {
    transport: 'per-instance',
    async claimAccount(pub) {
      const until = memory.accounts.get(pub);
      if (until && until > now) return { ok: false, retryAfterSeconds: Math.ceil((until - now) / 1000) };
      memory.accounts.set(pub, now + DAY_SECONDS * 1000);
      return { ok: true };
    },
    async bumpIp(hash, cap) {
      const rec = memory.ips.get(hash);
      const fresh = !rec || rec.resetAt <= now;
      const count = fresh ? 1 : rec.count + 1;
      memory.ips.set(hash, { count, resetAt: fresh ? now + DAY_SECONDS * 1000 : rec.resetAt });
      return { ok: count <= cap, count };
    },
    async bumpGlobal(dayKey, cap) {
      if (memory.day.key !== dayKey) memory.day = { key: dayKey, count: 0 };
      memory.day.count++;
      return { ok: memory.day.count <= cap, count: memory.day.count };
    },
  };
}

function redisLimiter(kv) {
  return {
    transport: 'durable',
    async claimAccount(pub) {
      // SET NX EX: the claim and its expiry are one atomic operation, so two concurrent
      // requests for the same account cannot both win.
      const r = await kv.command(['SET', `stellarsight:faucet:acct:${pub}`, String(Date.now()), 'NX', 'EX', String(DAY_SECONDS)]);
      if (!r.ok) return { ok: true, degraded: r.reason }; // store unreachable: fail open, and say so
      const claimed = r.result === 'OK' || r.result?.result === 'OK';
      if (claimed) return { ok: true };
      const ttl = await kv.command(['TTL', `stellarsight:faucet:acct:${pub}`]);
      const seconds = Number(ttl.ok ? (ttl.result?.result ?? ttl.result) : 0);
      return { ok: false, retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : DAY_SECONDS };
    },
    async bumpIp(hash, cap) {
      const key = `stellarsight:faucet:ip:${hash}`;
      const r = await kv.command(['INCR', key]);
      if (!r.ok) return { ok: true, degraded: r.reason };
      const count = Number(r.result?.result ?? r.result ?? 0);
      if (count === 1) await kv.command(['EXPIRE', key, String(DAY_SECONDS)]);
      return { ok: count <= cap, count };
    },
    async bumpGlobal(dayKey, cap) {
      const key = `stellarsight:faucet:day:${dayKey}`;
      const r = await kv.command(['INCR', key]);
      if (!r.ok) return { ok: true, degraded: r.reason };
      const count = Number(r.result?.result ?? r.result ?? 0);
      if (count === 1) await kv.command(['EXPIRE', key, String(DAY_SECONDS * 2)]);
      return { ok: count <= cap, count };
    },
  };
}

const fail = (res, status, code, reason, extra = {}) =>
  sendJson(res, status, { ok: false, code, reason, ...extra }, { 'Cache-Control': 'no-store' });

/**
 * createFaucetHandler({ env, deps }) -> async (req, res)
 *
 * `deps` exists for tests: `{ fetchImpl, kv, now, submit }` replace Horizon, Redis, the
 * clock and the submission so the whole guard matrix can be exercised without a network.
 */
export function createFaucetHandler({ env = process.env, deps = {} } = {}) {
  return async function faucetHandler(req, res) {
    if (handlePreflight(req, res, 'POST, OPTIONS')) return res;
    if (req?.method !== 'POST') {
      return sendJson(
        res,
        405,
        { ok: false, code: 'FAUCET_METHOD_NOT_ALLOWED', reason: 'the faucet accepts POST with a JSON body of {"account":"G…"}' },
        { Allow: 'POST, OPTIONS', 'Cache-Control': 'no-store', ...CORS_HEADERS },
      );
    }

    const secret = env.PLAYGROUND_FAUCET_SECRET ?? env.ISSUER_SECRET ?? null;
    if (env.PLAYGROUND_FAUCET_DISABLED === '1') {
      return fail(res, 503, 'FAUCET_DISABLED', 'the operator has switched this faucet off (PLAYGROUND_FAUCET_DISABLED=1)');
    }
    if (!secret) {
      return fail(
        res,
        503,
        'FAUCET_DISABLED',
        'this deployment has no distributor secret configured, so it cannot hand out the demo asset. Set PLAYGROUND_FAUCET_SECRET (or ISSUER_SECRET) to enable the playground faucet.',
      );
    }

    const assetCode = env.ASSET_CODE || 'SXT';
    const horizonUrl = env.STELLAR_HORIZON_URL || DEFAULT_HORIZON;
    const amount = String(env.FAUCET_AMOUNT_SXT || '2');
    const ipCap = num(env.FAUCET_IP_DAILY_LIMIT, 10);
    const globalCap = num(env.FAUCET_GLOBAL_DAILY_LIMIT, 200);
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const now = deps.now ? deps.now() : Date.now();

    const body = await readJsonBody(req);
    if (!body.ok) return fail(res, 400, 'FAUCET_BAD_REQUEST', body.reason);

    const account = String(body.value?.account ?? '').trim();
    if (!G_ADDRESS.test(account)) {
      return fail(res, 400, 'FAUCET_BAD_ACCOUNT', 'the "account" field must be a Stellar public key (G…, 56 characters)');
    }

    let distributor;
    try {
      distributor = Keypair.fromSecret(secret);
    } catch {
      return fail(res, 503, 'FAUCET_DISABLED', 'the configured distributor secret is not a valid Stellar secret key');
    }
    if (account === distributor.publicKey()) {
      return fail(res, 400, 'FAUCET_BAD_ACCOUNT', 'that is the distributor account; ask for a grant to your own throwaway key');
    }

    /* ── the account must already exist and trust the asset ───────────────── */

    let acct;
    try {
      const r = await fetchImpl(`${horizonUrl}/accounts/${account}`, { signal: AbortSignal.timeout(8000) });
      if (r.status === 404) {
        return fail(
          res,
          400,
          'FAUCET_ACCOUNT_UNFUNDED',
          'that account does not exist on testnet yet. Fund it with Friendbot first — the playground does this for you in step 2.',
        );
      }
      if (!r.ok) return fail(res, 502, 'FAUCET_HORIZON_UNREACHABLE', `Horizon answered ${r.status} when asked about that account`);
      acct = await r.json();
    } catch (e) {
      return fail(res, 502, 'FAUCET_HORIZON_UNREACHABLE', `could not reach Horizon at ${horizonUrl}: ${e.message}`);
    }

    const issuer = distributor.publicKey();
    const trusts = (acct.balances ?? []).some((b) => b.asset_code === assetCode && b.asset_issuer === issuer);
    if (!trusts) {
      return fail(
        res,
        400,
        'FAUCET_NO_TRUSTLINE',
        `that account has no trustline to ${assetCode}:${issuer}. Sign a changeTrust operation for it first — the playground does this in step 3, with the key that never leaves your browser.`,
        { assetCode, assetIssuer: issuer },
      );
    }

    /* ── abuse guards ─────────────────────────────────────────────────────── */

    const kv = deps.kv ?? createKv(env);
    const limiter = kv ? redisLimiter(kv) : memoryLimiter(now);
    const degraded = [];

    const dayKey = new Date(now).toISOString().slice(0, 10);
    const global = await limiter.bumpGlobal(dayKey, globalCap);
    if (global.degraded) degraded.push(global.degraded);
    if (!global.ok) {
      return fail(res, 429, 'FAUCET_RATE_LIMITED', `this faucet has handed out its daily maximum of ${globalCap} grants; it resets at 00:00 UTC`, {
        scope: 'global',
      });
    }

    const ip = await limiter.bumpIp(clientIpHash(req), ipCap);
    if (ip.degraded) degraded.push(ip.degraded);
    if (!ip.ok) {
      return fail(res, 429, 'FAUCET_RATE_LIMITED', `this address has already requested ${ipCap} grants today; it resets 24h after the first one`, {
        scope: 'ip',
      });
    }

    const claim = await limiter.claimAccount(account);
    if (claim.degraded) degraded.push(claim.degraded);
    if (!claim.ok) {
      return fail(res, 429, 'FAUCET_RATE_LIMITED', `that account was already funded by this faucet; generate a fresh key or wait for the grant window to reset`, {
        scope: 'account',
        retryAfterSeconds: claim.retryAfterSeconds,
      });
    }

    /* ── pay ──────────────────────────────────────────────────────────────── */

    try {
      const horizon = new Horizon.Server(horizonUrl);
      const source = await horizon.loadAccount(distributor.publicKey());
      const tx = new TransactionBuilder(source, {
        fee: String(Number(BASE_FEE) * 10),
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.payment({
            destination: account,
            asset: new Asset(assetCode, issuer),
            amount,
          }),
        )
        .setTimeout(60)
        .build();
      tx.sign(distributor);
      const submitted = deps.submit ? await deps.submit(tx) : await horizon.submitTransaction(tx);
      const hash = submitted?.hash;

      return sendJson(
        res,
        200,
        {
          ok: true,
          account,
          amount,
          assetCode,
          assetIssuer: issuer,
          network: 'stellar:testnet',
          txHash: hash ?? null,
          explorerUrl: hash ? `https://stellar.expert/explorer/testnet/tx/${hash}` : null,
          limiter: limiter.transport,
          ...(degraded.length ? { limiterDegraded: degraded[0] } : {}),
          note: `${assetCode} is a self-issued testnet demo token with no value. Testnet only.`,
        },
        { 'Cache-Control': 'no-store' },
      );
    } catch (e) {
      const codes = e?.response?.data?.extras?.result_codes;
      return fail(
        res,
        502,
        'FAUCET_SUBMIT_FAILED',
        `the grant transaction was rejected by the network: ${codes ? JSON.stringify(codes) : e.message}`,
      );
    }
  };
}

export default { createFaucetHandler };
