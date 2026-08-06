# PHASE 12 — POINT 7: external-destination closure

**Date:** 2026-08-05 · **Run id:** `1e2fb0e3-ddde-4337-a2d5-22559cde4795`
**Build id:** `971b3db4a0025221…`

The previous report said *"No production destination was attempted by any
process in this pass."* That sentence described CONNECTIONS and was written as
though it described ATTEMPTS. Thirty-one attempts were made and refused. This
pass traces every one of them to its caller, fixes the cause, and makes the
distinction load-bearing in the gate.

Four states, kept apart from here on:

```text
ATTEMPTED  the product reached for a real external destination
CONNECTED  it got there
COMPLETED  the request finished
ACKNOWLEDGED  the provider committed to the operation
```

A blocked attempt at a real provider is safe containment. It is **not** a
provider-behaviour proof, and every journey that depended on one was passing
for the wrong reason.

---

## 1. All 31 previous attempts — source and disposition

Attribution comes from the extended ledger's `boundedCallSite`, not inference.

| Destination | n | Attributed caller | Disposition |
|---|---|---|---|
| `api.resend.com` | 18 | `deliverEmail` — the one canonical transport, with a fake key bound so the send path stayed live | The transport now SELECTS a provider (`EMAIL_TRANSPORT`). Local runs get a real recording provider. Production unchanged when unset. |
| `fonts.googleapis.com` | 12 | `next/font/google` at BUILD time, plus a duplicate remote `@import` in `globals.css` | `@import` DELETED (it was a second authority for a family already self-hosted). `FONT_STRATEGY=system` swaps the font module at resolve time for a hermetic build. |
| `registry.npmjs.org` | 1 | `hot-reloader-webpack.js:getVersionInfo` — `next dev`'s version banner poll | Framework tooling. Classified by CALLER into a separate tooling ledger; structurally absent from `next start`. |

Two further destinations, invisible before this pass, surfaced once the
duplicate-guard noise was removed:

| Destination | n | Attributed caller | Disposition |
|---|---|---|---|
| `checkpoint.prisma.io` | 23 | `child.js:check` — the Prisma CLI's engine-version poller | `CHECKPOINT_DISABLE=1`. No product behaviour consults it. |
| `…ingest.de.sentry.io` | 1 | `observability-isolation.integration.test.ts` inside `assertThrows` | A DELIBERATE attempt proving the guard refuses one. Routed to the CANARY ledger under scenario `p7.obs.guard.denies_non_loopback`. |

They were invisible because the old record carried only host and count, and
because two guards were writing to one file in two shapes — 1,408 malformed
entries with no `runId`, no `phase`, no `category`, including `host: "null"`.

## 2. The Resend correction

`deliverEmail` is still the ONE transport. It now chooses a provider:

```text
production  → resend   (the default; omission changes nothing)
staging     → whatever staging configures, deliberately
test/browser→ recording, set by the --import bootstrap BEFORE any import
```

`deliverEmailViaRecorder` is a real implementation of the contract, not a stub:
it acknowledges, stores the message, collapses a duplicate on the idempotency
key the way a provider honouring that key does, and can be scripted to refuse
as `retryable`, `permanent` or `ambiguous`. It never receives an API key.

Three suites that assert on the provider WIRE — they read the
`Idempotency-Key` header and script 5xx/timeouts through a `fetch` stub — now
NAME the provider they test (`EMAIL_TRANSPORT=resend`). Their stubs refuse any
non-Resend URL, so nothing leaves the process.

### The database bypass this was hiding

`p7.invite.correct_recipient_accepts` read `SELECT token FROM team_invites`. It
proved a row existed, and it passed identically in a run where every send was
refused at the socket. It now waits for an ACKNOWLEDGED message and opens the
link from it. A static gate (comment-stripped, so explaining the removal does
not trip it) prevents reintroduction.

Four new scenarios, all executed:

* `p7.invite.resend_reuses_the_durable_idempotency_key`
* `p7.invite.revoked_link_still_fails_server_side`
* `p7.invite.mailbox_has_no_cross_tenant_leakage`
* `p7.invite.no_real_provider_attempt_during_the_journey`

**Mailbox for the final run: 54 messages, all `acknowledged`.** The boundary
was exercised, not merely blocked.

## 3. The closure gate can now fail on this

`evaluateOutboundLedgers` reads the ledgers from disk itself. Eleven negative
cases (X1–X11) prove it refuses: a blocked Resend / Google Fonts / npm attempt;
a CONNECTED destination (counted as a connection, not an attempt); a production
destination counted as production; a missing ledger; a canary record in the
product ledger; records from another run. X9 and X10 prove the converse — the
canary's deliberate attempt and ordinary loopback do not fail a clean run.

Also fixed: `readIsolationLedger` matched `outcome === "DENIED"` while the
guard writes `"BLOCKED"`, so every refusal was filed as an allowed host. Safe
by accident; wrong in principle.

## 4. Evidence

```json
{ "ok": true, "failures": [], "missing": [],
  "metrics": {
    "canonicalPlans": 5, "plansExecutedInCurrentRun": 5,
    "requiredScenarioIds": 99, "executedScenarioIds": 99,
    "browserSuitesHashValid": true, "oneRunId": true, "oneBuildId": true,
    "staleArtifacts": 0, "skippedRequiredScenarios": 0, "unknownScenarios": 0,
    "outbound": { "productLedgerPresent": true, "productLocalAllowed": 1772,
      "unexpectedExternalAttempts": 0, "unexpectedExternalConnections": 0,
      "productionDestinationAttempts": 0, "productionDestinationConnections": 0,
      "canaryAttempts": 4, "canaryRecordsInProductLedger": 0,
      "foreignRunRecords": 0, "offendingHosts": [] } } }
```

| Suite | Result |
|---|---|
| API unit | 646 files · **21,686 / 21,686** |
| API integration (server matrix) | 23 files · **363 / 363** |
| Worker | 48 files · **868 / 868** |
| Playwright `point7` (browser matrix) | **35 / 35** |
| Web | 1,852 · **0 fail** |
| `@proovra/shared` | **803 / 803** |
| Mobile | **8 / 8** |
| Isolation canary | **12 / 12** |
| Typecheck / lint | **0 errors, 0 warnings**, all projects |
| Builds | api, worker, shared, shared-runtime, web — all green |

**Ledger totals for the product run**

| Ledger | Entries | Content |
|---|---|---|
| product | 1,772 | all loopback; 0 attempted, 0 connected external |
| canary | 4 | deliberate, blocked; one carries its scenario id |
| tooling | 1 | `registry.npmjs.org`, `hot-reloader` caller, blocked |

**Proof artifacts, one run each:** Point-7 — 7 suites (4 server + 3 browser),
99 scenarios, one run id, one build id. Point-5 — 12 suites, 282 cases, one
run id.

## 5. NEW DEFECT FOUND, NOT FIXED

**On a production build, no client-rendered page hydrates under the app's own
strict CSP.**

`/login` serves a `<body>` containing only scripts and no DOM; `/` and
`/legal/privacy` render normally. The page is `<Suspense fallback={null}>` over
a `"use client"` component, so it has nothing to show until hydration, and
hydration never runs. The response carries `script-src 'self' 'nonce-…'`;
Next's inline RSC bootstrap scripts carry no nonce. `CSP_RELAXED=true` cannot
even be used to test it, because `buildCsp` forces `effectiveRelaxed = false`
when `isProd`.

A one-line attempt (also setting the CSP on the REQUEST headers, so Next could
read the nonce from it) did **not** work, and was reverted —
`apps/web/middleware.ts` is byte-identical to its pre-pass state.

This predates this pass, is outside its bounded objective, and needs its own
work. It is why the browser matrix runs against `next dev`; the npm-registry
attempt that mode reintroduces is classified by caller into the tooling ledger
rather than allowlisted by host.

## 6. External blockers — unchanged and not claimed

```text
StagingProductMatrix              = PENDING   (no staging credentials exist here)
OwnerProductionQueueIncidentAudit = PENDING   (needs P7_PRODUCTION_QUEUE_READONLY_URL)
Point6ProductionMigrationSnapshot = DEFERRED BY OWNER
```

Production was not contacted, mutated, migrated, deployed to, or restarted
during this pass. Nothing was committed or pushed. The dirty worktree is
preserved.
