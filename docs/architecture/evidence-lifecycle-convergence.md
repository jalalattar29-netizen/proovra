# Evidence Lifecycle Convergence — Architecture & Rollout Spec

Status: **CONVERGED. The canonical authority is the runtime authority end to end.**
Every item in the §19 ledger is shipped and proven; the one remaining follow-up is
named there with its reason. Automatic physical destruction is implemented and
OBSERVE-ONLY by default — see §17.
Owner authority: `packages/shared/src/evidence-retention-lifecycle.ts` (`@proovra/shared`).

This document is the single source of truth for how PROOVRA Evidence moves through
Active → Archived → Trashed → Destroyed, how retention and S3 Object Lock gate
destruction, and the safe order in which the remaining implementation lands.

Production storage truth (given): `S3_OBJECT_LOCK_ENABLED=true`,
`S3_OBJECT_LOCK_MODE=COMPLIANCE`, `S3_OBJECT_LOCK_RETAIN_DAYS=2920` (~8y).

---

## 0. The three layers (never conflate)

1. **Product visibility state** — what a user sees: Active / Archived / Trash.
2. **Database lifecycle state** — `Evidence.lifecycleState` (authority) + event
   timestamps (`archivedAt`, `deletedAt`/`deletedAtUtc` = trash, `destroyedAt`).
3. **Storage retention state** — S3 Object Lock mode + retain-until + versioning.

The convergence's central correction: **retention/Object Lock live in layer 3 and
gate PHYSICAL DESTRUCTION only. They do not define product state and do not block
recoverable soft-trash.**

## 1. Canonical state machine

```
                 archive                       unarchive / restore-to-active
        ACTIVE ───────────────► ARCHIVED ───────────────────────────► ACTIVE
          │                        │
          │  move to trash         │  move to trash
          ▼                        ▼
        TRASHED ◄───────────────────
          │   ▲
          │   │ restore from trash
          │   └───────────────► ACTIVE (or ARCHIVED — see §restore)
          │
          │ trashGraceUntil <= now  AND  appRetentionUntil <= now
          │ AND objectLockRetainUntil <= now  AND  no legal hold
          │ AND destruction approval satisfied (if required)
          ▼
   DESTRUCTION_ELIGIBLE
          │  one canonical executor: lease → recompute → S3 delete → VERIFY
          ▼
        DESTROYED   (immutable tombstone row + destruction certificate)
```

Governance-internal postures (`UNDER_REVIEW`, `ON_HOLD`, `RETENTION_LOCKED`,
`PENDING_DESTRUCTION`) remain on `lifecycleState` for governance surfaces only;
they are **not** product states and are not shown in the ordinary Evidence Library.

`ARCHIVE ≠ TRASH ≠ DESTRUCTION`. `DESTROYED ≠ "hidden from UI"`.

## 2. Canonical authority (Phase 1 — DONE)

`packages/shared/src/evidence-retention-lifecycle.ts`, exported from
`@proovra/shared`. Pure, clock-injected, I/O-free. Every surface derives from it:

- `resolveEvidenceProductState(input)` → ACTIVE | ARCHIVED | TRASHED | DESTROYED
  (precedence DESTROYED > TRASHED > ARCHIVED > ACTIVE; retention is **not** a state).
- `computeEffectiveRetentionUntil(input)` = `max(appRetentionUntil, objectLockRetainUntil)`.
- `computeEvidenceDestructionEligibility(input, now)` — fail-closed precedence:
  `TERMINAL_DESTROYED → NOT_TRASHED → EVIDENCE_LOCKED → LEGAL_HOLD_ACTIVE →
  TRASH_GRACE_ACTIVE → APP_RETENTION_ACTIVE → OBJECT_LOCK_RETENTION_ACTIVE →
  DESTRUCTION_APPROVAL_REQUIRED`. `destructionEligibleAt = max(trashGrace,
  appRetention, objectLockRetain)`.
- `computeEvidenceLifecycleCapabilities(input, now)` — the one projection both UI
  and routes consume (`canArchive/canUnarchive/canTrash/canRestoreFromTrash/
  canDestroy` + all dates + `objectLockCompliance` + `legalHold` +
  `destructionEligibleAt` + `destructionBlockReason`).
- `evaluateDestructionCandidate(input, now)` — the dry-run/worker per-record view.

Callers resolve two verdicts from their own stores and pass them in (the module
never reads a store): `legalHold` (union of evidence/case/workspace holds,
fail-closed) and `destructionApprovalRequired` / `destructionApproved`
(workspace governance capability — never a plan name).

Tests: `packages/shared/tests/evidence-retention-lifecycle.test.mjs` (14).

## 3. Retention precedence (§35)

```
record-specific retention / legal hold
  >  workspace retention policy
  >  platform default (S3_OBJECT_LOCK_RETAIN_DAYS = 2920d)
```

`Evidence.retentionUntilUtc` is the application retention deadline;
`storageObjectLockRetainUntilUtc` is the S3 physical retain-until. For
**destruction**, the effective boundary is the **maximum** of the two — the
platform never destroys before *either* clears. S3 COMPLIANCE retain-until is a
**hard** lower bound and is never bypassed or shortened. Existing 2034 dates are
never reduced.

## 4. Archive — final semantics (§4)

`lifecycleState=ARCHIVED` + `archivedAt` set. No S3 op, no retention change, no
timer, no destruction request, no artifact-status change, verification/custody
intact. Reversible. Single and bulk call the same `archiveEvidence` primitive.
Capability gate: `canArchive` (ACTIVE, not locked, **not under a legal hold**).

A hold blocks archive for the same reason it blocks trash: archive removes the
record from the default working set, and a preservation obligation is exactly
the period during which a reviewer must be able to find it where they expect
it. Retention does **not** block archive — that boundary stays on destruction.
The refusal is reported as `archiveBlockReason`, beside `trashBlockReason`, so
no surface has to infer one verdict from the other.

## 5. Trash — final semantics (§5/§6/§26)

`lifecycleState=TRASHED` + `trashedAt` (compat `deletedAt`/`deletedAtUtc`) +
`deletedByUserId` + `trashGraceUntil = now + 90d` (`deleteScheduledForUtc`).
**No S3 deletion, no certificate, no "destroyed" claim.** Reversible while not
DESTROYED. **Retention, Object Lock, and legal hold do NOT block trash** — only a
permanent record lock or a terminal state does. The 90-day value is explicitly a
**recovery grace window**, not an unconditional deletion time.

UI truth after trashing a retained record: `Trashed · Retained until 04 Jul 2034 ·
Eligible for destruction after retention expires` — never "cannot be moved to
trash until 2034".

## 6. Restore (§14)

Restore-from-trash clears the trash fields; state returns to ACTIVE (Phase-1
rule; a future refinement may restore to the pre-trash ARCHIVED posture if a
`preTrashArchived` flag is added). Restore-from-archive clears `archivedAt`.
**Authorization must use the same canonical record-access capability as trash**
(the audited owner-only weak path is removed), preserving legitimate
personal-owner access through canonical authorization, not a one-off check.

## 7. One canonical destruction executor (§16/§20/§21) — SPEC

`executeEvidenceDestruction({ evidenceId, approval, actorContext })`:

1. acquire durable lease (BullMQ job lock / advisory lock)
2. reload Evidence
3. recompute `computeEvidenceDestructionEligibility` — abort unless `eligible`
4. verify no legal hold (fresh union evaluation, fail-closed)
5. verify app retention expired
6. verify S3 Object Lock retain-until expired (COMPLIANCE hard boundary)
7. enumerate canonical storage keys from the Evidence manifest (evidence object +
   parts + reports + verification packages + READY redaction derivatives) —
   **only keys proven to belong to this Evidence** (§44), under its storage prefix
8. version-aware delete every object/version (§43); handle Object Lock semantics
9. **verify** deletion (re-`headObject`/list → gone)
10. only after deletion is proven: `lifecycleState=DESTROYED`, `destroyedAt`,
    immutable tombstone, **destruction certificate**, custody `EVIDENCE_DESTROYED`
11. commit idempotently; retry-safe (no duplicate certificate / double delete)

Failure semantics (§42): if any object fails to delete, state stays
destruction-in-progress/FAILED, **not** DESTROYED, and **no final certificate**.

The current three paths converge onto this ONE executor:
- Trash-grace worker (§8) enqueues it.
- Governance orchestrator (`destruction-orchestrator.worker.ts`) calls/enqueues it
  instead of flipping `DESTROYED` with no deletion.
- Manual Phase-4B (`destruction-governance.service.ts` /
  `product-and-lifecycle.routes.ts:1510`) invokes it — differing only in
  trigger/approval source, not mechanics.

## 8. Trash-grace reconciliation worker (§15) — SPEC

Scheduled (cron-locked, idempotent). Scans `lifecycleState=TRASHED AND
trashGraceUntil <= now`. For each, `evaluateDestructionCandidate`:
- retention/object-lock still active → remain TRASHED/RETAINED (no delete)
- legal hold → remain TRASHED/HELD
- approval required → create/reuse canonical destruction review
- fully eligible → enqueue `executeEvidenceDestruction`

Replaces the dormant `PurgeDeletedEvidenceJob` producer gap (§19): the purge
processor is refactored into the canonical executor or retired after zero-consumer
proof — **no second physical-deletion authority**.

## 9. Certificate semantics (§17/§51) — SPEC

A **final destruction certificate** is created **only after step 9 verifies
physical deletion**. While retained/held, state is `TRASHED` (or a governance
`DESTRUCTION_PENDING_RETENTION` posture) with **no** certificate. A pending
destruction *request/review* is a distinct record, never the final certificate.

## 10. Tombstone, not hard-delete (§18) — SPEC

Final destruction preserves a minimal immutable tombstone: Evidence ID, tenant,
created-at, destroyed-at, retention policy/version, approving actor/process,
reason, certificate hash, custody linkage. **No content bytes retained.** Retire
the contradictory row hard-delete (`PurgeDeletedEvidenceJob`'s `tx.evidence.delete`)
in favour of the governance tombstone.

## 11. Legal hold (§11) — status

Application legal hold (DB union evaluator) is the authoritative destruction gate,
fail-closed, and is honoured by the authority (`legalHold` input). **S3 Object
Lock legal hold is NOT wired to app holds today** (`storageObjectLockLegalHoldStatus`
reflects whatever the bucket reports on a HEAD, and nothing writes it). Wiring
real `PutObjectLegalHold` is a documented follow-up; until then we do **not**
claim S3 legal hold is active. DB hold is never weakened.

As of 2026-08-24 the hold gates ARCHIVE as well as trash and destruction, in the
canonical authority rather than in a governance layer that runs later. That
ordering matters: the governance gate returns `allowed` unconditionally for
evidence with no `teamId`, so a hold enforced only there was not enforced at all
for personal-scope records — held personal evidence was archived on request.
Deciding it in `computeEvidenceLifecycleCapabilities`, which runs before the
governance gate and which both the single and bulk routes consult, closes that
by construction rather than by adding a fourth check.

## 12. Single/bulk parity (§13/§49)

Both single and bulk routes call the same `moveEvidenceToTrash` / `archiveEvidence`
/ `restoreArchivedEvidence` / `restoreTrashedEvidence` primitives and the same
capability authority. The audited divergence (single trash ran the workspace
retention-policy `gateRetentionAction`, bulk did not) is resolved by the corrected
semantics: retention no longer blocks soft-trash, so that destruction-style gate is
removed from **both** trash paths (it moves to the destruction executor), yielding
parity by construction — not by adding an incorrect guard to bulk.

## 13. Evidence Library UI (§24/§25/§53) — SPEC

Scopes: **Active / Archived / Trash** (rename "Deleted Evidence" → "Trash").
DESTROYED tombstones do **not** appear in the ordinary Library (governance/history
surface only). Bulk menu exposes only actions valid for the selection
(active/archived → Archive where applicable / Move to Trash / Case ops; trash →
Restore from Trash), derived from `computeEvidenceLifecycleCapabilities`. Mixed
selections: disable incompatible actions or process only eligible rows with an
explicit summary.

## 14. Evidence Details UI (§27–§32/§54) — SPEC

Lifecycle area answers four questions compactly: current state; can I
restore/archive/trash; how long retained; can it be destroyed. Actions by state:
ACTIVE → Archive / Move to Trash; ARCHIVED → Restore to Active / Move to Trash;
TRASHED → Restore from Trash; DESTROYED → tombstone info only (authorized users).
A compact **Retention** block separate from actions: `Protected until <date>` ·
`S3 Object Lock · Compliance` · `Trash recovery 90 days` · `Physical destruction:
not before retention expires and all holds/approvals clear`. Trash is soft-delete;
verification/custody remain intact unless an explicit publication policy revokes
public exposure (never a side effect of `deletedAt`).

## 15. Migration / backfill (§22/§23/§47) — SPEC

Add `TRASHED` to `EvidenceLifecycleState` (safe additive enum migration).
Deterministic backfill (no data destruction; never infer destruction from
soft-delete):

```
if lifecycleState = DESTROYED (tombstone proven)   → DESTROYED
else if deletedAt != null                          → TRASHED
else if archivedAt != null                         → ARCHIVED
else                                               → ACTIVE
```

Preserve all existing timestamps; existing S3 retain-until never shortened. Add
migration tests + clean-db-boot proof + migration inventory before any deploy.

## 16. Storage config convergence (§34)

One env-parsing authority shared by API and worker for Object Lock
(mode/retain). No stale 365-day assumption where production is 2920. No
upload path may stage preserved Evidence without applying required Object Lock
retention. Secrets never committed.

**`S3_OBJECT_LOCK_LEGAL_HOLD` is no longer read by any storage path** (corrected
2026-08-24). It was parsed into `PutObjectLegalHold` at finalize time, which
made it a foot-gun in both directions: the value was carried as a truthy string,
so `OFF` still stamped a status onto every finalized object, and setting it to
`ON` would have placed native, per-object holds that no code in this repository
can release. Native legal hold is not implemented, so the variable now maps to
nothing — the worker's config schema REFUSES `ON` at boot and the API raises a
startup violation for it, rather than accepting a setting it cannot honour.
Object Lock RETENTION is untouched: `PutObjectRetention` still applies
COMPLIANCE/2920 exactly as before, proven behaviourally by capturing the
commands the storage layer emits.

## 17. Rollout safety (§55/§56) — MANDATORY GATING

1. Land canonical authority + tests — **done**.
2. Wire read-only projections (Details/Library capabilities) — **done**.
3. Land archive/trash/restore parity through the canonical primitives — **done**.
4. Land the executor + worker **disabled** — **done**.
   `AUTOMATIC_EVIDENCE_DESTRUCTION_ENABLED` defaults to false. The reconciler
   scans, evaluates and REPORTS on every tick; the flag gates only the enqueue of
   an actual destruction. Opening a destruction review is deliberately NOT gated
   by it — that surfaces a decision to a person and destroys nothing, and gating
   it would make the reconciler inert for exactly the records that most need
   review.
5. **NOT DONE — this is the owner's step, and it is the last one.** Run the
   read-only candidate report against production:

   ```
   DATABASE_URL=<production, read-only>      pnpm --filter @proovra/worker destruction-candidates
   ```

   It shares the reconciler's evaluation, so the list it prints is the list the
   executor would act on — it is not a second opinion about the same records.
   `dryRun` suppresses every write independently of the flag, so running it in a
   workspace where automatic destruction is already enabled cannot be the thing
   that triggers one.

   What to look for: every record retained under the production Object Lock
   configuration (COMPLIANCE, 2920 days) must report
   `OBJECT_LOCK_RETENTION_ACTIVE`. Anything reporting `ELIGIBLE` should be a
   record you can name and account for. If the report surprises you, that is the
   report doing its job.
6. Only after that proof: set `AUTOMATIC_EVIDENCE_DESTRUCTION_ENABLED=true`.

**Do not enable automatic destruction against production before step 5's proof.**
The pipeline is complete and correct as of this pass — which is precisely why the
default matters. Every previous implementation was wrong in ways that made it
safe by accident (two of the four deleted nothing at all), so the production
backlog has been accumulating under code that never correctly computed
eligibility. Turning a newly-correct irreversible pipeline loose on it without
reading the report first would mean the first thing the fix does is delete things
nobody has looked at.

## 18. Test matrix (§48–§52)

State transitions; single==bulk equivalence (the audited bug); S3 (Trash/Archive/
Restore do zero `DeleteObject`; destruction before retain-until does zero deletion;
eligible destruction deletes + verifies; failed delete → not DESTROYED, no
certificate; success → exactly one certificate + tombstone); certificate timing;
UI (Active/Archived/Trashed+retained/eligible/hold/DESTROYED, desktop/mobile/RTL).

## 19. Implementation ledger (honesty)

| Item | Status |
|---|---|
| Canonical authority + eligibility + capabilities + dry-run evaluator | **DONE, tested (22)** |
| `@proovra/shared` export + build | **DONE** |
| This spec (§46) | **DONE** |
| Frontend/detail/library projection wiring onto the authority | **DONE** — `EvidenceLifecycleProjection` on list rows and the detail response; the browser's copy of the retention predicates is deleted |
| Archive/trash/restore single+bulk convergence onto one primitive | **DONE** — `applyEvidenceLifecycleAction`; four route bodies and four bulk branches replaced by one |
| `TRASHED` enum migration + backfill + migration gates | **DONE** — 20271220000000 + 20271220000001; applied from zero against disposable PostgreSQL 16, raw-schema 873 objects / 0 divergences, drift in sync, inventory 0 gate failures, readiness command proven capable of failing |
| Canonical destruction executor (verify-before-DESTROYED) | **DONE** — `packages/shared-runtime/src/evidence-destruction/executor.ts`; 13 live cases including "a delete that reports success but leaves the object" |
| Trash-grace worker + orchestrator/Phase-4B convergence + purge retirement | **DONE** — four executors became one; the other three are triggers with zero destruction logic |
| "Deleted Evidence" → "Trash" rename | **DONE** — scope `trash`; `deleted` retained as a normalised WIRE alias for the shipped mobile client, with no filter, response field or label behind it |
| Real S3 Object Lock legal-hold wiring | **STILL A FOLLOW-UP.** See below. |

### The one thing that is still a follow-up, and why

`PutObjectLegalHold` is NOT wired. The application legal hold is enforced —
fail-closed, through the union evaluator, at trash time and again inside the
destruction executor after it has won its claim and re-read the row — and that
enforcement is proven by live cases. What is not done is engaging S3's own
object-level legal hold so the bucket itself would refuse a delete that somehow
bypassed the application.

That is a genuine defence-in-depth gap and it is recorded as one rather than
implied away. It is not on the critical path for this convergence: the executor
is now the ONLY code that can delete evidence bytes, and it refuses on an active
hold before it reaches storage. Wiring the S3 hold would add a second, independent
refusal underneath — worth having, and honestly absent today.

### What changed since this document said "specified, not shipped"

The reason given for deferring was that the destructive and migration items
mutate irreversible behaviour on a COMPLIANCE-locked platform and the required
gates could not be executed. That reason no longer holds: the repository's own
disposable infrastructure — PostgreSQL 16 + pgvector, Redis and MinIO, all on
loopback — was located and used. Migrations were applied from zero and the
schema gates run against a throwaway database; the destruction path was exercised
against a disposable object store through the same port the hosts inject, so the
code under test is the production executor with only its outermost adapter
swapped. No production database or bucket was contacted by any gate.

The remaining production risk is not in the code but in the DATA: a backlog of
trashed records whose real eligibility has never been computed, because the
implementations that were supposed to compute it were broken. That is why
automatic destruction ships disabled and why the read-only candidate report
exists — see §17.
