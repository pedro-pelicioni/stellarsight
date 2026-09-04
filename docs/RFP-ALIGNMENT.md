# RFP alignment — requirement, status, evidence

A reviewer's index. For each requirement of the *"x402 Facilitator with Bazaar (discovery)
support"* RFP: what state it is in, and the artifact that shows it — a command to run, a
generated file, or a section that argues the position.

**What this document does not claim.** It is not an exhaustive enumeration of every clause
in the RFP. It covers the requirements this repository can point at evidence for, quoting
the RFP where the exact wording matters. A requirement that is absent here is absent because
it is not mapped yet, not because it is met. Anything with no artifact behind it says so.

Status vocabulary, used strictly:

| Status | Means |
|---|---|
| **Delivered** | Working today on `stellar:testnet`, with an artifact anyone can regenerate |
| **T1 / T2 / T3** | Funded work, in the named tranche ([ARCHITECTURE §10](ARCHITECTURE.md#10-architecture-mapped-to-the-funded-tranches)) |
| **Position** | A decision taken and written down, with the reasoning, rather than a build |
| **Prototype** | On testnet today; the funded tranche is what makes it standard, interoperable and reviewed |
| **Not built** | Absent, and said so |

Every count below is one `npm run evidence:build` derives — from `docs/status/*.json`, the
test files and the conformance harness. Nothing in that directory is typed in, with one
exception that says so: `upstream-e2e.json` records a manual run of the x402 repository's
own suite and carries `recordedBy: "manual"`. This file is maintained against those
artifacts.

---

## §3.6 — The six acceptance criteria

The hardest table in the RFP, because each row is pass/fail rather than a judgement.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | An unmodified canonical client completes a payment end to end, on both networks | **Delivered** on testnet · pubnet is **T3** | `npm run verify:conformance` → [`conformance.json`](status/conformance.json) |
| 2 | `/supported` advertises the Stellar extra including `areFeesSponsored` | **Delivered** | `curl -s https://stellarsight.xyz/supported`; asserted in `npm run verify:api` |
| 3 | The `payload: { transaction }` shape is accepted verbatim | **Delivered** | Named criterion `payload-transaction-verbatim`, read off the header the stock client sent; the reading is pinned by `test/payment-shape.test.mjs` against a real recorded payload |
| 4 | A passing run of the x402 repository's own e2e suite, on both networks | **Delivered** on testnet, 6/6 · pubnet is **T3** | [`upstream-e2e.json`](status/upstream-e2e.json), pinned to suite commit `6557149` |
| 5 | A settled transaction hash published per network per scheme | **Delivered** for `exact`/testnet · `upto` **Prototype** — one settled `settle_upto` call on testnet, not yet through the facilitator · pubnet is **T3** | [TESTNET-TXS.md](TESTNET-TXS.md) · [`upto-settlement-deploy.json`](status/upto-settlement-deploy.json) |
| 6 | Every rejection carries a non-null reason | **Delivered**, 11/11 | `node scripts/verify-rejections.mjs` → [`rejections.json`](status/rejections.json) |

---

## §3.1 — The facilitator

| Requirement | Status | Evidence |
|---|---|---|
| `verify` / `settle` / `supported`, self-facilitated | **Delivered** | `apps/facilitator`, self-hosted on Apache-2.0 `@x402/stellar` |
| Fee sponsorship — the paying agent needs no XLM | **Delivered** | [ARCHITECTURE §2.4](ARCHITECTURE.md#24-fee-sponsorship-and-the-500000-stroop-ceiling); visible on any settled transaction's fee account |
| Support for classic keypairs and custom `__check_auth` accounts | Classic keypairs **Delivered** · `__check_auth` is **T2** | [ARCHITECTURE §2.2](ARCHITECTURE.md#22-the-buyer-signs-an-authorization-entry-not-a-transaction), §10 |
| *"Caller authentication, metering, and rate limiting are the respondent's design choice. **Document the mechanism and make it configurable.**"* | Rate limiting **Delivered** and configurable · per-caller metering **Not built**, belongs with per-seller identity in **T1** | [DEPLOY.md — Caller authentication, metering and rate limiting](DEPLOY.md#caller-authentication-metering-and-rate-limiting); `GET /health` reports the policy |
| *"any fee must be **configurable rather than hard wired** so a self hoster can change or remove it. **Document the business model.**"* | Fee is `0`, read from `FACILITATOR_FEE_BPS` and reported on `/health`; **collection** is **T3**, inside the audit scope | [DEPLOY.md — The business model](DEPLOY.md#the-business-model) |

---

## §3.2 — The Bazaar discovery layer

The RFP calls this *"the core new capability"* and *"the hardest part of the scope"*.

| Requirement | Status | Evidence |
|---|---|---|
| Automatic cataloging, with no separate seller registration | **Delivered** | [ARCHITECTURE §3.1](ARCHITECTURE.md#31-cataloging-is-a-side-effect-of-getting-paid) — a listing is a side effect of a **settled** payment; `/verify` never writes to the catalog |
| Readable by the stock `@x402/extensions` client | **Delivered** | `npm run check:bazaar` against any deployment; 54 checks in `npm run verify:api` |
| Catalog integrity — *"the facilitator is a trust boundary"* | **Delivered** | 70 adversarial tests: traversal under triple encoding, `iconUrl` SSRF, tag flooding, external `$ref`, and resource URLs on hosts nobody outside can reach |
| Natural-language search, with a stated evaluation method | **Delivered** | `npm run eval:search` → nDCG@10 0.864 over a 50-query graded set, with a CI regression gate |
| Listings representable consistently with other facilitators', *"so Stellar is not a walled garden"* | **Delivered** | `npm run verify:interop` → [one client, two facilitators](EVIDENCE.md#interoperability-one-client-two-facilitators); [ARCHITECTURE §3.6](ARCHITECTURE.md#36-interoperability-measured-against-another-facilitator) |
| Golden set at 150–200 queries; wire shape locked by golden tests | **T1** | ARCHITECTURE §10 |

---

## §3.3 — The agent-facing interface

| Requirement | Status | Evidence |
|---|---|---|
| MCP interface an agent can discover and pay through | **Delivered** | `apps/agent` — four MCP tools with input **and** output schemas, 17-code error enum |
| Hosted HTTP MCP endpoint | **Delivered** | `api/mcp.mjs` — Streamable HTTP endpoint at `https://stellarsight.xyz/mcp` with stateless transport, per-IP rate limiting, and T5 prompt injection markers |
| Multi-language (TS, Go, Python) adapter tests against that endpoint | **T2** | ARCHITECTURE §10 |

---

## §3.4 — Schemes, and coordinating upstream

| Requirement | Status | Evidence |
|---|---|---|
| *"`batch-settlement` … `auth-capture` is also deferred … **Do not foreclose either.**"* | **Position**, argued positively and checkably | [ARCHITECTURE §6.4](ARCHITECTURE.md#64-batch-settlement-and-auth-capture-are-deferred-not-foreclosed) — including the two consumer surfaces that *would* need editing, named |
| Coordinate the contribution *"through the x402 **Technical Steering Committee**"* | **Position** today, **T2** as a deliverable | [upto-position.md](upto-position.md); ARCHITECTURE §10 |
| `upto` implemented as standardized, with an interop report | **Prototype** — the contract in `contracts/upto` is deployed and footprint-measured; the scheme in the facilitator, the spec upstream and the interop report are **T2** | [ARCHITECTURE §6.3](ARCHITECTURE.md#63-what-tranche-2-delivers) · [`upto-settlement-footprint.json`](status/upto-settlement-footprint.json) |

---

## §3.5 — Stellar specifics

| Requirement | Status | Evidence |
|---|---|---|
| *"Soroban resource limits. Verify, settle, and any registry operations must stay within per transaction read, write, instruction, and memory limits."* | **Delivered**, measured | `npm run evidence:footprint` → [what a settlement costs the host](EVIDENCE.md#what-a-settlement-costs-the-soroban-host); [ARCHITECTURE §2.7](ARCHITECTURE.md#27-soroban-resource-limits-measured). Worst utilization 1.5%; memory reported as **unobserved** rather than guessed; no on-chain registry exists, so that clause has no operation to bound |
| SEP-41 / SAC assets | **Delivered** | [ARCHITECTURE §2.3](ARCHITECTURE.md#23-sep-41--sac) |
| Trustlines: onboarding and examples must account for the prerequisite (§3.5 points at **AHA Labs' Trustline Onboarder RFP**) | **Delivered** for the paths this deployment controls; the ecosystem-level answer is deliberately not ours to build | [ARCHITECTURE §2.3](ARCHITECTURE.md#23-sep-41--sac) — `npm run setup` issues, deploys and trusts in one idempotent command; the public faucet does the same for a browser visitor |

---

## §3.6 — Security, conformance, licensing

| Requirement | Status | Evidence |
|---|---|---|
| *"Strict payload verification, a settlement path resistant to replay **and front running**"* | **Delivered** | Replay: [THREAT-MODEL T7](THREAT-MODEL.md) — enforced on-chain by the Soroban nonce. Front running: **T13**, with what it does *not* cover stated |
| *"No AGPL or other strong copyleft in the dependency path … **Confirm dependency licenses and flag anything uncertain.**"* | **Delivered**, confirmed rather than asserted | `npm run audit:licenses` → [dependency licences](EVIDENCE.md#dependency-licences): 191 production packages, all permissive, zero unknown. CI fails the build on strong copyleft **or** an unknown licence |
| *"Drift, not inability, is the failure mode this screens for"* | **Delivered** | The drift we found **in ourselves**: our seller advertised `x402Version: 2` and answered 402 in the v1 wire format. [The whole story](../README.md#where-we-had-drifted), and a nightly stock-client run so it cannot recur |
| Permissive licence end to end | **Delivered** | Apache-2.0, checked by the audit above |
| Performance: fast discovery lookups, interactive-grade latency | **Delivered**, measured | `npm run latency:discovery` → [how fast discovery answers](EVIDENCE.md#how-fast-discovery-answers). Worst uncached p95 **305 ms**; cached and uncached reported separately and never averaged |
| 99%+ uptime target, degraded-mode story | Degraded modes **Delivered** and tested; the measured 30-day uptime is **T3** | [MONITORING.md](MONITORING.md); read-only catalog degradation is exercised in `verify:api` |
| External security review | **T3** | SCF Audit Bank; the fee is excluded from the budget per the rules |

---

## §4 — Evaluation criteria

| Criterion | Where the answer is |
|---|---|
| §4.2 Interoperability story | `npm run verify:interop`, and [ARCHITECTURE §3.6](ARCHITECTURE.md#36-interoperability-measured-against-another-facilitator). Graded twice — it is also a §3.2 requirement |
| §4.3 Conformance discipline — *"prior conformance runs, spec contributions, or interop bug reports are strong signals"* | Nightly settled payment since 2026-08-22; the official x402 e2e suite passing 6/6; a spec PR open upstream; and the v1/v2 drift found in our own seller |
| §4.6 Alignment with wallet teams on auth-entry signing | **T2**, scheduled rather than asserted — ARCHITECTURE §10 |
| Search quality as a real answer, not a plan | `npm run eval:search`, with the method and the caveats in [SEARCH-EVAL.md](SEARCH-EVAL.md) |
| Honest reporting of weaknesses | [LOAD-BASELINE.md](LOAD-BASELINE.md) publishes the worst number in the repo: 4/4 serial, 1/10 concurrent |

---

## §5 — Expected deliverables

| Deliverable | Status | Evidence |
|---|---|---|
| §5.4 Author `scheme_upto_stellar.md` | **T2, committed on either branch.** Preference is to implement whatever the open proposals converge on rather than add a fourth draft — but **if neither has landed by the end of Tranche 2 we author and submit it ourselves** through the x402 spec process, at no change in cost. The named artifact exists whichever way the upstream discussion goes | [upto-position.md](upto-position.md) · ARCHITECTURE §10 |
| §5.7 Role-based developer guide with a seller path, a buyer/agent path and an **operator path** | **Delivered**, all three | [seller](QUICKSTART-SELLER.md) · [agent](../apps/agent/README.md) · [operator](DEPLOY.md) |
| §5.7 Contributions to the Stellar Developer Docs | **T2** | ARCHITECTURE §10 |
| §5.8 Two end-to-end example integrations | **Delivered** | `apps/seller` — a paid API with three real routes that announces itself into the catalog; `apps/agent` — an MCP agent that discovers and pays with no prior integration. Both run in CI |
| UX: *"docs to a paid, discoverable endpoint appearing in the Bazaar in well under an hour"* | **Delivered** — **59 seconds**, measured | [QUICKSTART-SELLER.md](QUICKSTART-SELLER.md), every command timed with `/usr/bin/time` |
| On-chain registry | **Out of scope, deliberately** | The RFP calls it an optional stretch and explains the rent/TTL and doubled-settlement cost; [ARCHITECTURE §3](ARCHITECTURE.md#3-the-bazaar-the-facilitator-side-catalog) |

---

## Appendix — the conformance baseline the RFP suggests

The appendix suggests building a baseline by *"pointing the same stock client at both it and
the deliverable"*. That is what `npm run verify:interop` is: one unmodified `withBazaar()`
client against a reference facilitator and against this deployment, with every `accepts`
entry on both sides validated by `@x402/core`'s own schema. Result and method:
[EVIDENCE.md](EVIDENCE.md#interoperability-one-client-two-facilitators).

One finding worth carrying into any baseline work: of the public facilitators reachable
today, **only CDP serves the Bazaar discovery endpoint at all**. `x402.org/facilitator`
answers `/supported` and 404s on `/discovery/resources`; `facilitator.x402.rs` returns its
marketing page for the same path. A discovery-layer baseline currently has one other
implementation to be a baseline against.
