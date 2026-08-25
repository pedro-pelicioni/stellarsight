/**
 * apps/facilitator/src/rate-limit.mjs — a configurable per-caller limit on the two
 * endpoints that cost this deployment money.
 *
 * The RFP leaves caller authentication, metering and rate limiting to the respondent —
 * with one requirement attached: document the mechanism and make it configurable. This is
 * the mechanism. The policy it defaults to is deliberate and stated in DEPLOY.md: testnet
 * stays open and key-less, because "no signup, no API key" is a differentiator this
 * project claims in four places, and a limit exists only to stop one caller from draining
 * the sponsored fee-payer that everyone else is sharing.
 *
 * Nothing here is new machinery. The faucet has run a durable counter with a per-instance
 * fallback since it shipped; this generalises the same two implementations so the two
 * surfaces cannot drift apart, and so `clientIpHash` has one definition rather than two.
 *
 * Three properties carried over deliberately:
 *   - **Fail open.** An unreachable store degrades to per-instance counting and says so,
 *     rather than refusing traffic. A rate limiter that 500s when Redis blinks is a worse
 *     outage than the one it prevents.
 *   - **The raw IP is never stored or logged.** Only a truncated SHA-256 of the first
 *     x-forwarded-for hop becomes a key.
 *   - **Every refusal carries a machine code and a non-null reason**, the invariant the
 *     rest of this repo's rejections hold to.
 */
import { createHash } from 'node:crypto';

import { createKv } from '../../../packages/index/src/store.mjs';

/** Env parse that treats 0 as a real value — 0 means "disabled", not "use the default". */
export function intFromEnv(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** First hop of x-forwarded-for, hashed. The raw address is never stored or logged. */
export function clientIpHash(req) {
  const fwd = String(req?.headers?.['x-forwarded-for'] ?? req?.headers?.['X-Forwarded-For'] ?? '');
  const ip = fwd.split(',')[0].trim() || req?.socket?.remoteAddress || 'unknown';
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

/**
 * Per-instance fallback counters. Module scope on purpose: on a warm serverless instance
 * this still stops a tight loop, and the response never claims it is more than that.
 */
const memory = new Map();

function memoryCounter() {
  return {
    transport: 'per-instance',
    async bump(key, windowSeconds, nowMs) {
      const record = memory.get(key);
      const fresh = !record || record.resetAt <= nowMs;
      const count = fresh ? 1 : record.count + 1;
      const resetAt = fresh ? nowMs + windowSeconds * 1000 : record.resetAt;
      memory.set(key, { count, resetAt });
      // Bounded: a window's worth of distinct callers, then the oldest entries go. This
      // is a fallback, not an accounting system.
      if (memory.size > 10_000) {
        for (const [k, v] of memory) {
          if (v.resetAt <= nowMs) memory.delete(k);
          if (memory.size <= 5_000) break;
        }
      }
      return { count, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - nowMs) / 1000)) };
    },
  };
}

function durableCounter(kv) {
  return {
    transport: 'durable',
    async bump(key, windowSeconds) {
      const incr = await kv.command(['INCR', key]);
      if (!incr.ok) return { degraded: incr.reason };
      const count = Number(incr.result?.result ?? incr.result ?? 0);
      if (count === 1) await kv.command(['EXPIRE', key, String(windowSeconds)]);
      const ttl = await kv.command(['TTL', key]);
      const seconds = Number(ttl.ok ? (ttl.result?.result ?? ttl.result) : 0);
      return {
        count,
        retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : windowSeconds,
      };
    },
  };
}

/**
 * createRateLimit({ env, deps }) -> express middleware
 *
 * `deps` exists for tests: `{ kv, now }` replace the store and the clock so the whole
 * matrix runs without a network.
 *
 *   FACILITATOR_RATE_LIMIT          requests per window, per caller. 0 disables. Default 120.
 *   FACILITATOR_RATE_WINDOW_S       window length in seconds. Default 60.
 *   FACILITATOR_RATE_GLOBAL_LIMIT   requests per window across all callers. 0 disables (default).
 */
export function createRateLimit({ env = process.env, deps = {} } = {}) {
  const perCaller = intFromEnv(env.FACILITATOR_RATE_LIMIT, 120);
  const windowSeconds = intFromEnv(env.FACILITATOR_RATE_WINDOW_S, 60) || 60;
  const globalCap = intFromEnv(env.FACILITATOR_RATE_GLOBAL_LIMIT, 0);
  const now = deps.now ?? (() => Date.now());

  const disabled = perCaller === 0 && globalCap === 0;

  let counter = null;
  const resolveCounter = () => {
    if (counter) return counter;
    const kv = deps.kv ?? createKv(env);
    counter = kv ? durableCounter(kv) : memoryCounter();
    return counter;
  };

  const refuse = (res, { scope, limit, retryAfterSeconds }) => {
    const reason =
      scope === 'global'
        ? `this facilitator is handling its configured maximum of ${limit} requests per ${windowSeconds}s; retry in ${retryAfterSeconds}s or run your own (docs/DEPLOY.md)`
        : `this caller has made ${limit} requests in the last ${windowSeconds}s, which is the configured per-caller limit; retry in ${retryAfterSeconds}s`;
    res.set('Retry-After', String(retryAfterSeconds));
    res.set('Cache-Control', 'no-store');
    return res.status(429).json({
      ok: false,
      code: 'STELLARSIGHT_RATE_LIMITED',
      reason,
      scope,
      limit,
      windowSeconds,
      retryAfterSeconds,
    });
  };

  return async function rateLimit(req, res, next) {
    if (disabled) return next();

    const nowMs = now();
    const bucket = Math.floor(nowMs / 1000 / windowSeconds);
    const impl = resolveCounter();
    let degraded = null;

    const count = async (key) => {
      let result = await impl.bump(key, windowSeconds, nowMs);
      if (result?.degraded) {
        // The durable store answered with a failure. Fall back to per-instance counting
        // for this request and record why, instead of letting the limiter vanish silently.
        degraded = result.degraded;
        result = await memoryCounter().bump(key, windowSeconds, nowMs);
      }
      return result;
    };

    try {
      if (globalCap > 0) {
        const g = await count(`stellarsight:rl:all:${bucket}`);
        if (g.count > globalCap) {
          return refuse(res, { scope: 'global', limit: globalCap, retryAfterSeconds: g.retryAfterSeconds });
        }
      }

      if (perCaller > 0) {
        const c = await count(`stellarsight:rl:ip:${clientIpHash(req)}:${bucket}`);
        res.set('X-RateLimit-Limit', String(perCaller));
        res.set('X-RateLimit-Remaining', String(Math.max(0, perCaller - c.count)));
        if (degraded) res.set('X-RateLimit-Degraded', 'per-instance');
        if (c.count > perCaller) {
          return refuse(res, { scope: 'ip', limit: perCaller, retryAfterSeconds: c.retryAfterSeconds });
        }
      }
    } catch (err) {
      // Fail open, loudly. A limiter that can take the facilitator down is a worse
      // failure than the traffic it was meant to shape.
      console.warn(`[rate-limit] failing open: ${err?.message ?? err}`);
      return next();
    }

    return next();
  };
}

/** What /health reports, so an operator can see the policy without reading the env. */
export function rateLimitStatus(env = process.env) {
  const perCaller = intFromEnv(env.FACILITATOR_RATE_LIMIT, 120);
  const globalCap = intFromEnv(env.FACILITATOR_RATE_GLOBAL_LIMIT, 0);
  return {
    enabled: !(perCaller === 0 && globalCap === 0),
    perCallerPerWindow: perCaller || null,
    globalPerWindow: globalCap || null,
    windowSeconds: intFromEnv(env.FACILITATOR_RATE_WINDOW_S, 60) || 60,
  };
}

export default { createRateLimit, rateLimitStatus, clientIpHash, intFromEnv };
