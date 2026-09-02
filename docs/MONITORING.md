# On-chain monitoring plan — v0.1

The companion to [THREAT-MODEL.md](THREAT-MODEL.md): for each thing that can go wrong,
the signal that shows it, the threshold that fires, and what the operator does next.

**Status.** This is the plan, written now so the Tranche 2 deliverable is an
implementation rather than a discovery exercise. What exists today is marked ✅; what does
not is marked ⬜ and is funded work, not a claim. Tranche 2 makes every row below live
against testnet with alerts demonstrated firing on simulated anomalies; Tranche 3 runs the
same plan against mainnet with a public status page.

## What is watched

### Settlement path

| Signal | Source | Threshold | Response | Today |
|---|---|---|---|---|
| Settlement success rate | `/settle` outcomes | < 95% over 15 min | Page. Check RPC health first — this is usually upstream | ⬜ |
| Settlement latency p95 | facilitator timings | > 20s (≈4 ledgers) | Investigate RPC; compare against [LOAD-BASELINE.md](LOAD-BASELINE.md) | ⬜ |
| Sequence-number failures | `tx_bad_seq` / submission failures | **any**, once the channel pool ships | Pool exhaustion or drift — quarantine and reconcile the channel | ⬜ (T1) |
| Verify→settle rejection mix | rejection reason codes | any single reason > 30% of rejections | A specific integration broke; the reason code names which | ⬜ |

Baseline for these thresholds is measured, not guessed: today's single-fee-payer
configuration settles a lone payment in ~7s and collapses to a 10% success rate at 10-way
concurrency. Post-pool numbers replace these.

### Fee sponsorship — the drain surface

| Signal | Source | Threshold | Response | Today |
|---|---|---|---|---|
| `FEEPAYER` XLM balance | Horizon account | < 7 days of burn at trailing rate | Top up; runbook documents the procedure | ⬜ |
| Fee burn rate | balance delta per hour | > 3× the trailing 24h median | Possible drain attempt — inspect payer dispersion, consider rate limits | ⬜ |
| Per-transaction fee | settlement result | > 250,000 stroops (half the 500k ceiling) | Network conditions moved; re-derive the ceiling with evidence, as it was derived originally | ⬜ |
| Rejections at the fee ceiling | `/verify` outcomes | any sustained run | The ceiling is now too tight and is silently refusing valid payments — the exact failure the 500k calibration fixed once already | ⬜ |

### Catalog integrity

| Signal | Source | Threshold | Response | Today |
|---|---|---|---|---|
| Soft-drop rate | `EXTENSION-RESPONSES` | > 20% of writes dropping a field | Either a seller is malformed or someone is probing the validator | ✅ reported per write, ⬜ aggregated |
| Rejected writes | `POST /discovery/resources` 400s | > 10/min from one source | Flooding attempt; rate-limit | ⬜ |
| Unauthorized write attempts | 401s on the write path | > 5/min | Token probing | ⬜ |
| Durable-store reachability | `store.ping()` | 2 consecutive failures | Catalog is serving read-only from seed; announce and say so | ✅ reported on `/discovery/health`, ⬜ alerted |
| Catalog size drop | record count | falls > 10% between checks | Store trouble or an accidental purge | ⬜ |

### Discovery quality

| Signal | Source | Threshold | Response | Today |
|---|---|---|---|---|
| nDCG@10 on the golden set | `npm run eval:search` | falls > 0.02 below baseline | **Build fails.** Fix the ranking or update the baseline deliberately, in the diff | ✅ live in CI |
| Zero-result rate | `/discovery/search` | > 25% of live queries | Vocabulary mismatch — the case the Tranche 2 semantic layer addresses | ⬜ |
| Search latency p95 | endpoint timing | > 500ms | Index degradation | ⬜ |

### Conformance

| Signal | Source | Threshold | Response | Today |
|---|---|---|---|---|
| Stock-client conformance | `verify:conformance` against the live stack, settling a real payment per run | any failure | The spec moved or we drifted. This is the RFP's named failure mode | ✅ **running nightly**. `.github/workflows/nightly-evidence.yml` creates a throwaway buyer in-run (Friendbot → changeTrust → the public faucet, so no repository secret is involved), settles against `stellarsight.xyz` with an unmodified `@x402/fetch` client, and commits the hash. CI separately runs the 54 API-conformance checks, the suite and the search-quality gate on Node 22/24 |
| `withBazaar()` API checks | `verify:api`, 54 checks | any failure | Wire-format regression | ✅ in CI |
| Upstream `@x402/*` version | dependency watch | new minor | Re-run conformance before bumping — 2.21 → 2.22 landed mid-development | ⬜ |

### RPC dependency

| Signal | Source | Threshold | Response | Today |
|---|---|---|---|---|
| RPC error rate | Soroban RPC calls | > 5% over 5 min | Fail over to the second provider (Tranche 3 provisions one) | ⬜ |
| Ledger staleness | latest ledger vs wall clock | > 3 ledgers behind | Known public-testnet failure mode; back off rather than hammer | ⬜ |

## Alert routing

One severity split, because a solo maintainer with five severities has one severity.

- **Page** (immediate): fee-payer runway < 7 days, settlement success < 95%, store
  unreachable, conformance failure.
- **Ticket** (next working session): everything else.

Every alert links to the runbook section for its signal. The runbook is a Tranche 3
deliverable and covers, at minimum: fee-payer top-up, key rotation, channel-pool
reconciliation, store failover, and rollback.

## What gets published

The Tranche 3 public status page shows settlement success rate, settlement latency p50/p95,
catalog size, discovery latency and rolling 30-day uptime against the 99% target — with
the SLO's exclusions stated (planned maintenance, upstream Stellar/RPC outages), because an
availability number without its exclusions is marketing.

## Deliberately not monitored

- **Per-payer behavioural profiling.** The catalog is public infrastructure; building a
  behavioural dossier on the agents that use it is not in scope.
- **Content moderation of listings.** Integrity validation is mechanical (traversal, SSRF,
  length, encoding). Judging what a service *is* would make the facilitator an arbiter of
  what may be sold, which is the opposite of permissionless.
