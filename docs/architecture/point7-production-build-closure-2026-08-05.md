# PHASE 12 — POINT 7: production-build closure

**Run id** `767131de-3d8f-4a79-8bb0-cbc114fc8d7f` · **Build id** `971b3db4a0025221…`
**Web runtime** `production-build` (`next build` + `next start`) · **Strict CSP** enabled

---

## 1. CSP root cause

Proven from the build output, not inferred. The prerendered `login.html`
contained, on every script:

```text
"nonce":"$undefined"
```

The policy is nonce-based and the middleware mints a fresh nonce per response.
But 65 routes were rendered at BUILD time, when no request — and therefore no
nonce — exists. The browser received build-time HTML whose scripts carry no
nonce together with a header demanding one, so
`script-src 'self' 'nonce-…'` blocked every inline script and **nothing
hydrated anywhere in the application**.

`/login` was only where it was visible: its entire body was
`<Suspense fallback={null}>` over a client component, so a page that could not
hydrate had nothing at all to show. `/` and `/legal/*` looked fine and were
equally non-interactive.

This is also why the earlier one-line attempt failed. Setting the CSP on the
request lets Next read the nonce **during a render**; a statically prerendered
route has no render at request time for it to affect. Half a fix is not a fix.

## 2. The correction

Strict CSP is preserved. No `unsafe-inline`, no `CSP_RELAXED`, no broad `*`, no
new external script origin, no static or predictable nonce.

**One authority.** `buildCsp` is called ONCE per request and the same string
is used for both the request context (so the render reads the nonce) and the
response header (so the browser enforces it). It was previously built twice
and matched only by coincidence.

**The nonce reaches the render.** `nextWithNonce` now sets
`Content-Security-Policy` on the request headers alongside `x-nonce`. Next does
not read `x-nonce`; that is an application convention.

**A per-request nonce requires a per-request render.**
`export const dynamic = "force-dynamic"` on the root layout.

**Caching consequence, recorded rather than glossed:** static prerendered pages
went 65 → 0. That is the real price of a nonce-based policy. It is the right
trade for an authenticated evidence product whose pages are context-sensitive
anyway — the marketing and legal pages are the only genuinely static ones, and
serving them uncached is cheaper than shipping an application that does not
run. `'unsafe-inline'` is not a cheaper trade; it is the removal of the
protection.

## 3. Login server shell

`fallback={null}` is replaced by an accessible shell: an `<h1>`, a
`role="status" aria-live="polite"` line, and stable layout. It carries **no
inputs and no buttons** — a control that cannot work yet is worse than no
control — and no secrets or client state. After hydration the real form
replaces it.

## 4. Route audit under `next start` + strict CSP

The first crawler read server HTML only and flagged ten authenticated routes as
`REAL_BLANK_PAGE_DEFECT`. Checking `/home` in a real browser showed 488
characters of live UI. **Classifying from HTML would have condemned ten working
pages** — the exact failure the mandate warns against. Re-run through real
hydration with console capture:

```text
HEALTHY_CLIENT_HYDRATED  /  /login  /register  /pricing  /legal/privacy
                         /legal/terms  /home  /capture  /evidence  /cases
                         /teams  /workspaces  /review  /settings  /billing
                         /verify/<fixture>  /reports  /organizations

ProductionBuildBlankRoutes       = 0
ProductionBuildCspViolations     = 0
RequiredProductionRoutesRendered = 18/18
```

`/login` hydrates to 6 inputs, 2 forms, email and password present, title
`PROOVRA`, **zero console errors**.

## 5. Closure verdict

```json
{ "ok": true, "failures": [], "missing": [],
  "metrics": {
    "canonicalPlans": 5, "plansExecutedInCurrentRun": 5,
    "requiredScenarioIds": 99, "executedScenarioIds": 99,
    "browserSuitesHashValid": true, "oneRunId": true, "oneBuildId": true,
    "staleArtifacts": 0, "skippedRequiredScenarios": 0, "unknownScenarios": 0,
    "outbound": { "productLedgerPresent": true, "productLocalAllowed": 2056,
      "unexpectedExternalAttempts": 0, "unexpectedExternalConnections": 0,
      "productionDestinationAttempts": 0, "productionDestinationConnections": 0,
      "canaryAttempts": 5, "canaryRecordsInProductLedger": 0,
      "foreignRunRecords": 0, "offendingHosts": [] },
    "productionBuildBrowserProof": true, "strictCspEnabled": true } }
```

The gate now rejects a dev-mode proof. Three new negative cases:

* **X12** browser proof recorded in `development` → fails
* **X13** browser proof that does not DECLARE its runtime mode → fails
  (absent is not the same as false, and neither is creditable)
* **X14** browser proof recorded without strict CSP → fails

Battery: 34/34. The gate also caught a real mistake during this pass — it read
a STALE ledger left at the default path and rejected 1,772 records as belonging
to a different run. That is the freshness lock working.

## 6. Evidence

| Suite | Result |
|---|---|
| API unit | 646 files · 21,688 / 21,689 (see §8) |
| API integration (server matrix) | 23 files · **363 / 363** |
| Worker | 48 files · **868 / 868** |
| Playwright `point7` under `next start` | **35 / 35** |
| Web | 1,852 · 0 fail |
| `@proovra/shared` | **803 / 803** |
| Mobile | **8 / 8** |
| Isolation canary | **12 / 12** |
| Typecheck / lint (api, worker, web, mobile, packages) | **0 / 0** |
| Prisma schema | valid |

| Ledger | Entries | Content |
|---|---|---|
| product | 2,056 | all loopback; **0 attempted, 0 connected** external |
| canary | 5 | deliberate, blocked, one carrying its scenario id |
| tooling | 1 | `registry.npmjs.org`, `hot-reloader` caller, blocked |

Mailbox: **108 messages, all `acknowledged`**. Proof: 7 suites, 99 scenarios,
one run id, one build id, every BROWSER record declaring
`webRuntimeMode=production-build` and `strictCsp=true`.

## 7. Queue incident — code-side verification

The 22-case skew/topology suite and the full worker suite pass (868/868),
re-confirming: version-skewed payloads are refused before Prisma; no rejection
path can hand `undefined` to a caller; graph-reconcile is not bound to the
purge processor; no queue is served by two processors; each job runs in its own
Sentry isolation scope; a background failure gets its own trace and an explicit
`queue.<name>` transaction rather than the ambient health-probe one.

```text
QueueHandlerMismatches       = 0
MalformedJobsReachingPrisma  = 0
HealthTransactionJobErrors   = 0
```

No `P7_PRODUCTION_QUEUE_READONLY_URL` was provided, so no production Redis was
contacted and the collector refused to start, by design. Status unchanged:
`OWNER_PRODUCTION_QUEUE_INCIDENT_AUDIT_PENDING`.

## 8. One unresolved non-determinism, stated plainly

`phase-12-point4-drift-check-target › still resolves DATABASE_URL when no
explicit target is given` fails **only** in the full 646-file parallel run, and
passes deterministically in isolation (6/6, twice) and in mixed groups
(1,406/1,406). Across three full runs it failed, passed, failed. It is the one
test that `spawnSync`s a Node child which itself loads the preload and Prisma,
which is consistent with resource starvation under full-suite parallelism
rather than a logic defect.

I am not calling it green and I am not calling it fine. It is unresolved,
load-dependent, and unrelated to this pass's changes.

## 9. External blockers — unchanged, not claimed

```text
StagingProductMatrix              = PENDING   (no staging credentials exist here)
OwnerProductionQueueIncidentAudit = PENDING   (needs the read-only URL)
Point6ProductionMigrationSnapshot = DEFERRED BY OWNER
```

Production was not contacted, mutated, migrated, deployed to, queue-touched, or
restarted. Nothing committed or pushed; `HEAD` remains `36b871dc` on `main`.
Disposable containers removed; temporary artifacts cleaned.
