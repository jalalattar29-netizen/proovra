# PROOVRA — FINAL ADVERSARIAL E2E CLOSURE AUDIT

**Mode:** AUDIT ONLY. No fixes, no commits, no push, no migrations, no Production action.
**Baseline:** HEAD `840fe5bb` = origin/main `840fe5bb`, divergence `0 0`, tracked tree clean,
nothing untracked. 270 migrations, 1 held.

**Purpose:** attempt to DISPROVE closure. Every claim below was re-derived from current
source; no conclusion of a previous audit was accepted as given.

---

## A. EXECUTIVE VERDICT

## 2. ARCHITECTURE SOUND — TARGETED CLOSURE REQUIRED

Not verdict 1, and the reason is stated rather than implied. §25 forbids "fully closed"
when any required runtime proof is unavailable. Two are:

- **AI Copilot** — source-proven only. Never driven in a browser.
- **Partial Report/Package failure** — source-proven only. Runtime injection could not be
  performed without patching product behaviour, which this audit forbids.

Independently, **two P2 findings** survive: the canonical work registry declares recovery
authorities that do not implement the recovery they name, and the gate that exists to
catch exactly that cannot see it.

**No P0. No P1.** The forensic invariants hold: no TSA retry path exists anywhere; existing
artifacts survive downgrade; concurrent allocation cannot collide; every canonical state
has a renderer on every surface; no frontend surface makes a commercial decision.

---

## B. CANONICAL ARCHITECTURE MAP

| Question | Single authority | Consumers |
|---|---|---|
| What plan governs this workspace? | `resolveWorkspaceEffectivePlan` (`plan-catalog.ts:582`) | `workspace-billing.service.ts:303` |
| What outputs does this record earn? | `resolveEvidenceOutputEntitlements` (`plan-catalog.ts:790`) | output-eligibility service |
| What state is this output in? | `deriveEvidenceOutputState` (`evidence-output-lifecycle.ts:344`) | 3 server projections |
| What may a surface offer? | `outputActionFor` | same 3 projections; **zero web callers** |
| Is this intent a forced regeneration? | `resolveForceRegenerate` | API route only |
| Who may a worker claim? | `resolveAndClaimReportRequest` | worker only |
| Has this blocker ended? | `blockerStillActive` | durable writer only |
| Who writes OTS columns? | `buildOtsEvidenceUpdateData` | init + upgrade (two phases, one writer) |
| Who allocates a version? | inline reservation under `pg_advisory_xact_lock` (`processor.ts:3153`) | one site |

**Verified adversarially:** `grep` for `forceRegenerate` across `apps/web` returns **zero
matches**. The frontend cannot assert regeneration authority at all — not "does not
currently", *cannot*.

---

## C. OUTPUT STATE MACHINE

Precedence (`deriveEvidenceOutputState`): availability → generation-in-flight → eligibility
→ generation-terminal → finalized.

| State | Enter | Writer | Exit | Recovery authority | Action | Download | Runtime proof |
|---|---|---|---|---|---|---|---|
| `NOT_INCLUDED` | plan/funding excludes | projection (derived) | upgrade entitlement | n/a | NONE | n/a | **RUNTIME** |
| `ELIGIBLE_NOT_GENERATED` | finalized + entitled, no artifact | derived | Generate | n/a | n/a | GENERATE | **RUNTIME** |
| `QUEUED` | durable request committed | `createReportGenerationRequest` | worker claim | `reconcileStrandedReportRequests` | NONE | n/a | **RUNTIME** (§6.3) |
| `GENERATING` | worker claimed | `resolveAndClaimReportRequest` | success/failure/lease expiry | lease sweep | NONE | n/a | **RUNTIME** (§6.4) |
| `READY` | artifact row exists | report/package create | regeneration → v+1 | n/a | REGENERATE (if eligible) | **YES** | **RUNTIME** |
| `RETRYABLE_FAILURE` | attempt failed, budget left | `markRequestRetryable` | retry / ceiling | reconciler stage 3+4 | RETRY | existing only | **RUNTIME** |
| `TERMINAL_FAILURE` | non-recoverable / budget burned | `markRequestTerminal` | supersession if commercially obsolete | none by design | NONE | existing only | **RUNTIME** |
| `BLOCKED` | governance refusal | worker terminal write | blocker ends → `:s<n>` | `blockerStillActive` | NONE→GENERATE | existing only | **RUNTIME** (§5.6) |

**No state can be entered that cannot be left**, with one intentional exception:
`TERMINAL_FAILURE` for a non-recoverable, non-obsolete reason. That is the design — a request
that names a dead fact is not reopened — and the record itself remains generatable at a new
baseline version once the underlying cause is fixed.

**OTS:** `NULL → (sweep) → PENDING|FAILED|DISABLED|ANCHORED`. NULL is recoverable
(`neverAttemptedOtsWhere`, 30 min–30 d). Transient infrastructure failure writes **no column**.
**TSA:** written once inside the finalize claim; no transition exists afterward, by design.

---

## D. ACTION / BUTTON MATRIX

Three executable generation call sites exist repo-wide, all hitting one route:

| Surface | File | Label source | Outcome reader |
|---|---|---|---|
| Evidence Detail | `_hooks/useEvidenceArtifactActions.ts:311` | `GENERATION_ACTION_LABEL` | `readGenerationOutcome` |
| AI Copilot | `EvidenceCopilotPanel.tsx:113` | canonical | `readGenerationOutcome` |
| Reports | `ReportsIndex.tsx:1016` | `GENERATION_ACTION_LABEL_COMPACT` | `readGenerationOutcome` |

Downloads: header + Artifacts + Reports + per-version history, all through
`assertArtifactDownloadAllowed`. Historical versions are consumed at
`useEvidenceArtifactActions.ts:349/370` and rendered by `ArtifactHistorySection` —
**not an orphan route**.

**Dead-button sweep result: none found.** `ArtifactLifecyclePanel` is a `switch` with no
`default`, total over all 8 states; `OUTPUT_STATE_COPY` covers all 8; `ReportsIndex`
references all 8.

---

## E. USER-JOURNEY MATRIX

| # | Journey | Result | Proof |
|---|---|---|---|
| J1 | FREE, no artifacts | `NOT_INCLUDED / NONE`, `pending:false`, no download control | **RUNTIME** |
| J2 | FREE → PRO historical | `ELIGIBLE_NOT_GENERATED / GENERATE`; key `REPORT:<id>:v0` (**no `:force`**); 0 credits | **RUNTIME** |
| J3 | PRO normal generation | READY v1 both outputs | **RUNTIME** |
| J4 | READY → Regenerate | `v1:force` → v2; v1 still 200; latest = v2 | **RUNTIME** |
| J5 | Downgrade after READY | `READY / action=NONE`; v1 **and** v2 both 200 | **RUNTIME** |
| J6 | Retryable failure | `RETRYABLE_FAILURE / RETRY` on all surfaces | **RUNTIME** |
| J7 | Legal hold | `RECOVERABLE_BLOCKED` → release → `SUPERSEDED`, `:s1`, history intact | **RUNTIME** |
| J8 | Terminal failure | `TERMINAL` + truthful copy; retry refused | **RUNTIME** |
| J9 | Report exists, package missing | `outputPairComplete` false → fresh matched pair at v+1 | SOURCE |
| J10 | Package without report | **Unreachable** — package is built after the report in the same job; no independent producer | SOURCE (invariant) |
| J11 | OTS pending, outputs eligible | OTS is read, never a gate — report job owns no OTS write | SOURCE |
| J12 | TSA failed | outputs/downloads unaffected; **no customer retry exists** | SOURCE (§H) |
| J13 | TSA later fixed | offline re-parse of stored bytes; never re-contacts an authority | SOURCE (§H) |
| J14 | Lost OTS enqueue | `trigger:"interval"` sweep found it; controls untouched | **RUNTIME** |
| J15 | Transient OTS throw | attempt 1→2, `otsStatus` stayed null | **RUNTIME** |
| J16 | Lost report enqueue | `requestsReenqueued:2` on one scheduled tick | **RUNTIME** |
| J17 | Expired lease | `requestLeasesReleased:1`; live claim not stolen | **RUNTIME** |
| J18/J19 | Concurrent generate/regenerate | one live row per chain; v1/v2 never v1/v1 | **RUNTIME** |
| J20 | Cross-tenant historical | 404 **byte-identical** to nonexistent id | **RUNTIME** |
| J21/J22 | Workspace lifecycle / non-ACTIVE membership | `ORGANIZATION_NOT_ACTIVE` recoverable; ACTIVE-only membership | SOURCE |
| J23 | Linked-case hold | `checkExportEligibility` consults linked cases | SOURCE |
| J24 | Latest + historical | latest = v2, history offers v1+v2 | **RUNTIME** |

---

## F. COMMERCIAL TRUTH

`getPlanCapabilities` gives **`reportsIncluded === verificationPackageIncluded` for every
plan** (both false on FREE, both true otherwise), and `EVIDENCE_CREDIT` funding forces both
true regardless of plan. The two outputs therefore cannot diverge on the *eligibility* axis;
they diverge only on generation/availability, which is correct.

**Frontend derivation exceptions — every one classified:**

| Site | Classification |
|---|---|
| `QueueSelectionPreview.tsx:137,189` | **DISPLAY ONLY** — plan consulted *after* `!availability.available` |
| `evidence-library-helpers.ts:42-57` | **PROJECTION** — copies server capability into a view model |
| `page.tsx:425` | **DISPLAY ONLY** — passed to a status *description* helper |
| `EvidenceIntegrityTab.tsx:236` | **DISPLAY ONLY** — fallback label after `.available` |
| `_lib.tsx:603,606` | **DISPLAY ONLY** — polling heuristic, OR'd with availability |
| `SiuPanel.tsx:123` | **DISPLAY ONLY** — an integer count, unrelated to entitlement |

**Zero DUPLICATE AUTHORITY. Zero BUG. The critical invariant holds:** existing-artifact
download never consults current commercial eligibility — proven at runtime by J5.

---

## G. REPORT/PACKAGE ATOMICITY

Report render, upload, retention, read-back and row creation all occur **inside** the
`$transaction` holding `pg_advisory_xact_lock(hashtext(evidenceId))` (`processor.ts:3109`–
`3772`). The package is built and persisted **after** that transaction.

**Can the report be stored while the package fails? YES**, and the handling is correct:
`packageTechnicalFailure` + `verificationPackageEntitled` → `recordPackageGenerationIncident`
→ **throws a retryable error**. `SUCCEEDED` is written only on clean return, so a request
cannot falsely succeed with a required package absent. The committed report is untouched and
stays downloadable. `outputPairComplete` then prevents the next run treating the record as
done, and produces a fresh matched pair at v+1 rather than back-filling a published version.

**Orphan objects:** a transaction aborting after upload leaves an object at a version-scoped
key that no row references. It is never reachable — downloads read `Report.storageKey` from
the row — and the generation that ultimately commits that version supersedes it (S3 is
versioned; `putObjectBuffer` uses no `IfNoneMatch`, so the retry cannot be permanently
refused).

**RUNTIME: UNPROVEN.** Injecting a package-only failure requires either patching product
code or manipulating storage ACLs mid-run. Neither is audit-safe. Stated as a gap, not a pass.

---

## H. TSA NO-RETRY PROOF

| Path | Classification |
|---|---|
| `createEvidenceTimestamp` at finalize | **INITIAL FINALIZATION ONLY** |
| `processor.ts` TSA references (3) | **READ/VERIFY** — a label string, a status comparison, a digest comparison. No client, no network, no write |
| `repair-tsa-failed-with-token.ts` | **READ/VERIFY** — re-parses stored bytes, then calls `requestReportGeneration`. Never contacts an authority |
| `remediation-registry.ts` `tsa_failure` | `NO_SAFE_REMEDIATION_AUTHORITY` + written `unsafeReason` |
| `evidence-health-cohorts.service.ts:183` | `tsaRetryable = disposition === "DIRECT_REMEDIATION"` → **always false** |

Repo-wide search for `retry.?tsa|tsa.?retry|restamp` in executable source returns **no retry
path**; the only matches are unrelated lifecycle wording. **No queue, job, route, button,
Operations action, or Copilot action can retry or restamp TSA.** Report and package
regeneration do not request a new timestamp.

---

## I. OTS DURABILITY

Two failure vocabularies, both observed in one worker process:

- **RETURN path** — everything inside `createOpenTimestamp`'s try, including the missing
  binary (named branch). Observed: two records persisted `otsStatus:"FAILED"`.
- **THROW path** — `mkWorkDir()` (`fs.mkdtemp`) and the content guard, both *before* the try.
  Observed: `OTS_INITIALIZATION_TRANSIENT:…ENOENT…mkdtemp`, BullMQ `attempt` 1→2,
  `outcome:"failed"`, and the record left `otsStatus=null, proof=null, failureReason=null`.

Scan predicate excludes in-flight (30 min floor) and already-stamped records — both
verified by control records that were correctly left alone. Anchored records are not
re-stamped. Evidence `status` stayed `SIGNED` throughout.

---

## J. RECONCILIATION MAP — **P2 FINDINGS HERE**

`startLifecycleRecoveryScheduler()` is called at `index.ts:2606` in the boot chain and
stopped at `:2348`; re-entrancy guarded by a running flag. One tick runs three scans.

**Registry truth sweep (block-accurate, all entries):**

| Work name | Declared reconciler | Reality |
|---|---|---|
| `GENERATE_REPORT` | `lifecycle-recovery.ts` | **TRUE** (runtime-proven) |
| `UPGRADE_OTS` | `lifecycle-recovery.ts` | **TRUE** (runtime-proven) |
| `PURGE_DELETED_EVIDENCE` | `lifecycle-recovery.ts` | **FALSE — 0 occurrences of "purge"** |
| `EMBED_SEMANTIC_CHUNKS` | `intelligence-run-reconciler.ts` | **FALSE — 0 occurrences of embed/semantic/chunk** |

---

## K. STORAGE / VERSIONING

Allocation is inside the advisory lock, before any object is written; the uploaded PDF is
**re-rendered inside the transaction** with the reserved version, so stored bytes cannot
print a version its row disagrees with. Behaviourally proven: two simultaneous allocations
returned **v1 and v2** with two distinct keys and both rows surviving; the unique index on
`(evidenceId, version)` was independently shown to reject a duplicate.

---

## L. OPERATIONS / NOTIFICATIONS — **P3 FINDING HERE**

`resolveRemediations` **fails closed**: an unregistered condition returns
`READ_ONLY_GUIDANCE` with `actions: []`. No dead button is ever rendered.

But `IntegrityClass` is only `"tsa_failure" | "ots_failure"`, and `integrityClassOf` reads
the fingerprint head. The two conditions the reliability closure introduced —
`ots_pending_aged`, `ots_initialization_stalled` — therefore resolve to **no action, no
guidance, and no `unsafeReason`**. An operator sees an incident with nothing to do and no
explanation. `tsa_failure` shows the correct pattern.

---

## M. ERROR CONTRACT

Canonical `{ error: { code, message, requestId, timestamp } }` observed live on 401 and 404.
Cross-tenant, malformed and nonexistent ids all answer **404 byte-identically** — verified at
runtime for the historical-version route, which is the newest and least-tested surface.

---

## N. AI COPILOT — **RUNTIME UNPROVEN**

Source shows it imports `readGenerationOutcome` (line 15), calls the same canonical route
(line 113), and derives its offer from the server action rather than `_count.reports` (the
removal is recorded in a comment at line 83). It cannot retry TSA (no such path exists
anywhere) and cannot bypass governance (the route re-derives authority server-side).

**Not driven in a browser.** Per §14, reported as UNPROVEN, not PASS.

---

## O. MOBILE / UI COMPLETENESS

Runtime, real assembled app, authenticated: **0 px horizontal overflow** at 320/360/375/390/
430/768 on both `/reports` and `/evidence/[id]`. All 8 states have copy in
`OUTPUT_STATE_COPY`; the Artifacts panel is exhaustive with no blank state.

---

## P. CREDIT / IDEMPOTENCY

`EvidenceCreditLedgerEntry` has a UNIQUE `evidence_id` and is settled inside the completion
transaction. **Runtime-proven:** across a first generation, a regeneration, a blocked
attempt and a supersession on one record, `creditLedgerEntries` remained **0** throughout —
generation after upgrade consumes nothing, and neither retry nor regenerate can double-charge.

---

## Q. SCHEMA / MIGRATION TRUTH

270 migrations, 1 held. The fixture database was built from the migration chain alone and the
API's own runtime schema validator reported `runtime.schema_validation.healthy, checked:109`
against it — physical truth, not `migrate status`. Real DB constraints were exercised
incidentally (`evidence_team_implies_org_chk` rejected a malformed seed), confirming the
physical schema carries them.

---

## R. LEGACY / DEAD PATH INVENTORY

| Item | Class |
|---|---|
| `PLAN_CAPABILITIES.PAYG` | **RETIRED** — explicitly never assigned, documented |
| `repair-tsa-failed-with-token.ts` | **KEEP** — offline, operator-run, contacts nothing |
| `smoke-evidence-forward-path.ts` | **TEST-ONLY** |
| `seed-home-personas.ts` | **TEST-ONLY** |
| WhatsApp intake enum members | **KEEP** — deliberately retained for historical rows |
| `_count.reports` as entitlement | **REMOVED** — 0 executable occurrences; one comment records the removal |

---

## S. TEST-QUALITY CLASSIFICATION

| Invariant | Strongest coverage |
|---|---|
| Version allocation concurrency | **BEHAVIOURAL** (live PG, v1/v2 asserted) |
| Blocked supersession | **BEHAVIOURAL** + **RUNTIME** |
| Download after downgrade | **RUNTIME** |
| OTS transient retry | **BEHAVIOURAL** + **RUNTIME** |
| Report lost enqueue | **BEHAVIOURAL** + **RUNTIME** |
| Expired lease | **BEHAVIOURAL** + **RUNTIME** |
| Cross-tenant historical download | **RUNTIME** |
| Credit idempotency | **RUNTIME** (observed 0 across 4 operations) + DB constraint |
| Commercial authority | **RUNTIME** (FREE→PRO→FREE observed) |
| **TSA no-retry** | **SOURCE-TEXT + absence proof only** |
| **Report/package partial failure** | **SOURCE + CONTRACT only** |

TSA no-retry is protected by proving a *negative* (no queue/job/route/button exists). That is
the strongest available form for an absence, but it remains source-derived.

---

## T. CONTRADICTIONS FOUND

**None material.** Specifically checked and cleared:
- "not included" vs "generate" — entitlement is symmetric across outputs; unreachable.
- "previous versions remain downloadable" vs no route — the route exists, is consumed by
  `ArtifactHistorySection`, and was runtime-proven for v1 and v2.
- "queued" vs `enqueued:false` — `QUEUE_UNAVAILABLE` is its own outcome with its own copy.
- "READY" vs artifact absent — the package endpoint answers 404 for that reconciliation
  mismatch rather than "ready" or "pending".

One nuance, not a contradiction: the Reports page collapses the two outputs into one action
(`report.action !== NONE ? report.action : package.action`). Because `READY` wins the state
precedence, the divergences that would make this misleading are unreachable.

---

## U. ORPHANS FOUND

- **Registry entries naming a reconciler that does not implement the recovery** — 2 (§J).
- No orphan states, buttons, routes, unscheduled reconcilers, or unrenderable actions.
- `runJobWithTelemetryContext` initially looked orphaned; it is used by
  `observability/queue-otel-context.ts`.

---

## V. RUNTIME PROOFS

Fixture proven isolated **before** startup by the repository's own `buildLocalFixtureEnv`:
100 allowlisted variables, 23 URL-shaped values all loopback, zero forbidden-host hits,
`DOTENV_CONFIG_PATH` pointing at a nonexistent file so the `.env` holding live Production
credentials could not load. Ports 55901/56901/59901/8291/3411.

Proven at runtime: §5.1, §5.2, §5.3, §5.4, §5.5, §5.6, §5.7, §5.9, §6.1, §6.2, §6.3, §6.4, §8,
cross-tenant denial, credit non-consumption.
Not proven at runtime: **AI Copilot browser action**, **partial Report/Package failure**.

---

## W. GATE RESULTS (exit codes, measured at `840fe5bb`)

| Gate | Exit |
|---|---|
| `pnpm --filter proovra-worker test` | **0** — 50 files, 891 tests |
| `pnpm audit:architecture --engine-check` | **0** — `AuditEngineIntegrity = PASS` |
| `pnpm audit:architecture --closure-check` | **0** — `PASS`, backlog `EMPTY` |
| `npx playwright test --project=chromium e2e/phase-a0-integrity-hard-gate.spec.ts` | **0** — 7 passed |
| `phase13-public-write-bounds` isolated | **0** — 25/25 |
| `report-generation-supersession-recovery` | **0** — 13/13 |
| tsc × 3 (api/worker/web) | **0** |
| `pnpm -r lint` | **0** — 0 errors, 1 pre-existing warning |
| API + worker production builds | **0** |

---

## X. FINDINGS BY SEVERITY

### P0 — none
### P1 — none

### P2-1 — The work registry declares recovery authorities that do not implement the recovery

- **Files:** `packages/shared/src/queue-integrity/registry.ts` (`PURGE_DELETED_EVIDENCE`,
  `EMBED_SEMANTIC_CHUNKS`); `services/worker/src/lifecycle-recovery.ts`;
  `services/worker/src/intelligence-run-reconciler.ts`
- **Root cause:** the `reconciler` field is prose that nothing validates semantically.
- **Impact — purge:** *documentation only*. Real recovery exists in
  `governance/trash-grace-reconciler.ts`, which re-scans `lifecycleState:"TRASHED"` rows whose
  `deleteScheduledForUtc` has passed, so a lost purge enqueue self-heals on the next tick.
- **Impact — embed:** *possible durability gap*. `mi-embed-queue.ts` enqueues with
  `commandId: anchorChunkId` and writes **no `IntelligenceRun` row**, while the declared
  reconciler scans `IntelligenceRun` by status. A lost embed enqueue appears to have no
  automated recovery. Outside this audit's evidence-output scope; flagged because §7 requires it.
- **Coverage:** none. The topology gate cannot detect it (P2-2).
- **Fix:** point each entry at the module that actually recovers it, or set `reconciler: null`
  and record the gap honestly. For embed, establish whether recovery exists at all.
- **Migration:** no. **Production action:** no.

### P2-2 — The topology gate validates file existence, not recovery

- **File:** `services/api/test/phase-12-point5-topology-gate.test.ts:394`
- **Root cause:** the assertion is `existsSync(resolve(REPO, e.reconciler))`. Any entry naming
  any existing file passes.
- **Impact:** this is precisely why `UPGRADE_OTS → lifecycle-recovery.ts` was false for
  months, and why the two entries above are false today. The gate cannot fail on the defect
  it exists to prevent.
- **Fix:** additionally require the declared module to reference the work name or its queue,
  or to export a symbol the registry names.
- **Migration:** no. **Production action:** no.

### P3-1 — Two Operations conditions render with no action and no guidance

- **Files:** `services/api/src/services/operations/remediation-registry.ts` (`IntegrityClass`,
  `integrityClassOf`, `resolveRemediations`)
- **Root cause:** `IntegrityClass` covers only `tsa_failure` and `ots_failure`;
  `ots_pending_aged` and `ots_initialization_stalled` fall through to a null entry.
- **Impact:** an operator sees an incident with no action **and no explanation**. Fails closed
  (no dead button), so this is a UX gap, not a correctness defect.
- **Fix:** give both a `READ_ONLY_GUIDANCE` entry with written guidance, exactly as
  `tsa_failure` does with `unsafeReason`.
- **Migration:** no. **Production action:** no.

### P3-2 — Reports collapses two outputs into one action label

- **File:** `apps/web/components/reports-experience/ReportsIndex.tsx:1072`
- **Impact:** when report is `READY` and package is `RETRYABLE_FAILURE`, the button reads
  "Regenerate" although the package needed "Retry". The resulting request is correct.
- **Fix:** optional; label from the output being acted on, or state that one action drives both.

---

## Y. CLOSURE QUESTIONS

1. **Finalized evidence permanently missing OTS undetected?** **No.** Scheduled sweep +
   `ots_initialization_stalled`. Runtime-proven.
2. **Report request permanently stranded?** **No.** Four-stage reconciler on a 5-min tick.
   Runtime-proven.
3. **Transient OTS failure mistaken for success?** **No.** It throws; attempt 1→2 observed.
4. **Report falsely SUCCEEDED with package absent?** **No.** Retryable throw precedes the
   terminal write. Source-proven; **runtime unproven**.
5. **Regeneration restamp TSA?** **No.** No TSA client is reachable from the report job.
6. **Any customer-facing TSA retry?** **No.** No queue, job, route or button exists.
7. **Downgraded customer download everything already created?** **Yes** — v1 and v2, both
   artifact types, runtime-proven.
8. **FREE historical evidence generatable after upgrade?** **Yes**, runtime-proven.
9. **Which button?** Evidence Detail → Artifacts → **"Generate report & verification package"**
   (`GENERATION_ACTION_LABEL.GENERATE`); Reports shows the compact prefix of the same label.
10. **UI while queued/generating?** `OUTPUT_STATE_COPY.QUEUED` / `.GENERATING` in the Artifacts
    panel, which stays visible with no duplicate control.
11. **Concurrent generations sharing a version?** **No.** v1/v2 behaviourally proven.
12. **Retry/Regenerate double-charge?** **No.** 0 ledger entries across 4 operations.
13. **Copilot bypass the action authority?** **No** in source; **UNPROVEN** at runtime.
14. **Operations issue whose remediation cannot fix its population?** **No** — but two
    conditions offer no remediation *and no guidance* (P3-1).
15. **Every recoverable state has automated recovery or a safe human action?** **Yes.**
16. **Every terminal state has truthful no-action UX?** **Yes.**
17. **Every visible button maps to a reachable outcome?** **Yes.**
18. **Every backend action has a truthful UI consumer?** **Yes** — including the historical
    download routes.
19. **Commercial decisions in the frontend?** **None.** Every read is display-only or a
    post-availability fallback.
20. **Backend-written states no surface can explain?** **Two** — `ots_pending_aged` and
    `ots_initialization_stalled` surface with empty guidance (P3-1).

---

## Z. REPOSITORY SAFETY

No product code changed. No migrations. No commit. No push. No Production mutation, deploy,
backfill, credit consumption, or report regeneration. Temporary fixture files were removed
before this report; the disposable fixture's processes are stopped and its ports closed.
