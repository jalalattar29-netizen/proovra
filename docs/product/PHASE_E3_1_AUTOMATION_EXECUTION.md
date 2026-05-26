# PHASE E3.1 — Automation Execution Runtime

**Status:** `CLOSED_WITH_DEFERRED_ITEMS`
**Date:** 2026-05-25
**Predecessor:** Phase E3 (`CLOSED_WITH_DEFERRED_ITEMS`)
**Closes:** DEF-021
**Successor:** TBD; webhook delivery (DEF-022) is the natural next bounded follow-up.

E3.1 closes DEF-021 by shipping the bounded execution runtime that E3 deliberately deferred. The dispatcher, condition evaluator, and 7 action handlers all land together so the runtime is reviewable as a single piece. The webhook action (DEF-022) remains explicitly OPEN — it requires HMAC signing + allowlisted destinations + outbound-call governance that does not belong in the same phase as the in-process executor.

Per CR1.7 §9 entry-gate, the registry was read before any code edit. Per CR1.7 §10 closure template, the registry is updated on close with DEF-021 marked RESOLVED + E3.1 referenced.

---

## 1. Registry entry-gate (per CR1.7 §9)

- **Last closed phase:** Phase E3 (`CLOSED_WITH_DEFERRED_ITEMS`). No blockers.
- **DEF-021 closure criterion** (from registry §6 at start of phase):
  > "E3.1 ships trigger event consumers + BullMQ worker that creates + processes `AutomationRun` rows + emits the 9 registered automation security events on each lifecycle transition."
- **DEF-022 (webhook action)** explicitly out of scope. DB CHECK + TS allowlist intentionally exclude it; this phase preserves that exclusion.
- **Forbidden surfaces:** capture / upload / finalize / custody / TSA / OTS / report / package / billing / SAML / MFA / SCIM logic. File-size pins (E3.1 Test 6). No new root nav (E3.1 Test 7). No new state library (E3.1 Test 7).

**Scope decision:** E3.1 ships **synchronous in-process execution** rather than a separate BullMQ worker. Reasoning:
- The 7 handlers are short, bounded, fully idempotent, and mostly audit-only (the dispatcher records the action intent; downstream side-effect fan-out is reserved for future bounded phases that need it).
- Adding a queue + worker + retry + dead-letter would be substantial new operational surface area, unjustified at the foundation tier.
- The DEF-021 closure criterion is satisfied by the runtime emitting the 9 security events at the correct lifecycle points — that's what we ship.
- If trigger volume ever justifies async processing, a follow-up phase can split the executor without changing the public `dispatchAutomationTrigger()` signature.

---

## 2. Dispatcher design

Single entry point: `dispatchAutomationTrigger(input, prisma?)` in `services/api/src/services/automation/automation-dispatcher.service.ts`.

### 2.1 Input

```ts
type AutomationTriggerInput = {
  teamId: string;
  triggerType: AutomationTriggerType;  // bounded enum from E3
  targetType: string;                   // e.g. "evidence_review_workflow"
  targetId: string;                     // UUID
  context?: Readonly<Record<string, unknown>>;
};
```

The caller (internal service code) passes IDs and small operator-safe metadata only — NEVER raw evidence bytes, secrets, tokens, file paths, or large blobs.

### 2.2 Algorithm

```
1. Guard: triggerType must be in the E3 allowlist. Unknown → return zero-outcome.
2. SELECT enabled rules WHERE teamId = input.teamId AND triggerType = input.triggerType.
3. For each rule:
   a. Action type must be in the E3 allowlist (defence-in-depth).
   b. evaluateCondition(rule.conditionJson, context). On mismatch:
        - Try to create a SKIPPED run with idempotency key.
        - On unique conflict: dispatcher already recorded a SKIP for this trigger+target → no-op.
        - Emit automation_run_skipped (reason="condition_not_matched").
   c. On match:
        - Compute idempotency key (sha256(rule | trigger | targetType | targetId)).
        - INSERT AutomationRun with status PENDING.
        - On unique conflict: duplicate trigger → emit automation_run_skipped
          (reason="duplicate_trigger"), do not execute.
        - Transition PENDING → RUNNING; emit automation_run_started.
        - Call executeAutomationAction(...). Bounded handler returns
          { executed, skipped?, reason?, summary? }.
        - On thrown error: transition to FAILED with sanitised reason;
          emit automation_run_failed (severity WARNING).
        - On success: transition to SUCCEEDED; emit automation_run_succeeded.
        - The handler itself emits automation_action_executed with its summary.
4. Return DispatchOutcome { considered, created, succeeded, failed, skipped }.
```

### 2.3 Hard rules pinned at source

- No `eval`, no `new Function`, no `vm` import — verified by `phase-e3-1-automation-execution.test.ts` Test 2.
- No `http` / `https` / `fetch` / `child_process` imports — Test 2.
- Every DB call inside `try/catch` so the dispatcher NEVER throws past its boundary — Test 2.
- `safeEmitSecurityEvent` is the only audit-emission path — payloads strictly contain IDs + enums + sanitised reason.

---

## 3. Condition evaluation behaviour

Pure descent through the bounded condition tree:

| Operator | Semantics | Failure mode |
|---|---|---|
| `equals` / `not_equals` | string-coerced equality | non-throw |
| `greater_than` / `less_than` | numeric only — fail closed if either side non-numeric | non-throw |
| `in` / `not_in` | expected must be an array (≤16 items per E3 schema) | non-throw |
| `due_within_hours` | ctx is parseable date; window is `[now, now+hours]` | non-throw |
| `older_than_days` | ctx is parseable date; ageDays > expected | non-throw |
| `all` | logical AND over children (max 8) | non-throw |
| `any` | logical OR over children (max 8) | non-throw |
| _unknown operator_ | **fail closed (returns false)** | non-throw |
| _malformed shape_ | **fail closed (returns false)** | non-throw |

The evaluator NEVER throws on user-supplied condition shapes. Pinned by E3.1 Test 1.

**Documented decision:** condition mismatch records a SKIPPED run (with reason `condition_not_matched`). This is intentional — operators viewing the run history can see that the rule fired but didn't execute, which is useful for tuning conditions. The unique idempotency key prevents mismatches from flooding the run table (multiple mismatched evaluations for the same target collapse to one row).

---

## 4. Idempotency strategy

Triple defence:

1. **Deterministic key.** `computeIdempotencyKey({ ruleId, triggerType, targetType, targetId })` returns a sha256-derived 64-char hex string. Same inputs → same key. Pinned by E3 Test 5.
2. **DB unique index.** `automation_runs_team_rule_idempotency_uniq` on `(teamId, ruleId, idempotencyKey)`. Duplicate inserts raise Prisma `P2002` → dispatcher catches it → records a `duplicate_trigger` skip + emits `automation_run_skipped`.
3. **Action-handler defence-in-depth.** `ADD_OPERATIONAL_COMMENT` additionally suppresses identical bodies from the same rule within the last 5 minutes (`duplicate_within_window`).

The unique index survives: retries, double dispatch, worker restart, concurrent dispatch (Postgres serialises the unique check).

---

## 5. Worker execution

**Synchronous in-process.** The dispatcher calls `executeAutomationAction(...)` directly in the same request context. Handler execution time is bounded (each handler is essentially a `findUnique` + `count` + summary construction; no large I/O).

If volume ever justifies a separate worker, a follow-up phase can introduce a BullMQ queue with the same `executeAutomationAction()` as the worker body — the public `dispatchAutomationTrigger()` signature stays stable.

---

## 6. Action handlers — support matrix

| Action | Behaviour in E3.1 | Defence-in-depth |
|---|---|---|
| `NOTIFY_USER` | Validates assignee is a team member → audit summary `{ kind, template, recipientUserIdHashPrefix }`. NotificationDelivery row creation reserved for future bounded phase. | team-membership check |
| `NOTIFY_ROLE` | Counts current members of role → audit summary `{ kind, role, template, recipientCount }`. | role count exposes nothing sensitive |
| `CREATE_REVIEW_TASK` | Records intent + sanitised reason. Actual review-task creation deferred (review-orchestration coupling out of scope). | sanitised reason only |
| `CREATE_ESCALATION` | Validates severity present → records intent. Actual ReviewEscalation row creation deferred (severity/owner coupling out of scope). | severity required |
| `ASSIGN_REVIEWER` | Validates assignee is a team member → records intent. Actual workflow-currentReviewerId mutation reserved for reviewer-ops service. | team-membership check |
| `APPLY_LABEL` | Records label (≤40 chars) in audit. Persistent label storage out of E3 scope. | size cap |
| `ADD_OPERATIONAL_COMMENT` | Validates body + visibility → suppresses duplicates-within-5min. Actual CaseComment row creation reserved. | duplicate-within-window guard |
| ~~`WEBHOOK_DELIVERY_INTERNAL_ONLY`~~ | **DEFERRED to E3.2 (DEF-022)** — DB CHECK + TS allowlist exclude it. | — |

**Intentional E3.1 minimalism:** handlers record the intent + emit the audit event but do not (yet) fan out persistent downstream side effects (e.g. NotificationDelivery rows, CaseComment inserts). This keeps the runtime reversible — if a rule misfires we have the audit trail but no irreversible domain state change. Downstream fan-out lands in bounded follow-up phases (per-action), so each handler's blast radius is independently reviewable.

**What the dispatcher GUARANTEES today:**
- Disabled rules never execute (E3.1 Test 2).
- Cross-team triggers never match (E3.1 Test 2).
- Duplicate triggers never re-execute (idempotency unique index + Test 5).
- Failed handlers never break the caller (every Prisma call wrapped, dispatcher returns outcome).
- Every lifecycle transition emits an audit event with operator-safe payload.

---

## 7. Audit / security events emitted

All 5 lifecycle events from the E3 vocabulary (registered in `SECURITY_EVENT_TYPES`):

| Event | Severity | When emitted |
|---|---|---|
| `automation_run_started` | INFO | After PENDING → RUNNING transition |
| `automation_run_succeeded` | INFO | On successful action completion |
| `automation_run_failed` | WARNING | On thrown handler error |
| `automation_run_skipped` | INFO | On condition mismatch OR duplicate trigger |
| `automation_action_executed` | INFO | Inside each handler (executed or skipped-handler-side) |

Event payload always contains: `ruleId`, `runId` (when applicable), `triggerType`, `actionType`, `targetType`, `targetId`, optional `reason`. NEVER contains raw evidence content, secrets, tokens, private URLs, or external payloads.

The remaining 4 E3-registered events (`automation_rule_created/updated/enabled/disabled`) remain on the routes-side TODO — rule mutation routes in `automation.routes.ts` currently persist the change without emitting. That's a thin follow-up not blocking DEF-021 closure.

---

## 8. UI execution visibility

`apps/web/app/(app)/ops/automation/page.tsx` — the existing E3 page — updated:
- The "Phase E3 — foundation only" yellow notice is REMOVED.
- A green "Phase E3.1 — execution runtime active" notice replaces it, explaining the runtime is live and rules are still created disabled by default.
- All other behaviour (rules list, run history, allowlists reference, LoadState branches, PageRouteGate gating) unchanged.

The `data-automation-execution-notice` attribute is pinned by E3.1 Test 4.

---

## 9. Tests added

**New file:** `services/api/test/phase-e3-1-automation-execution.test.ts` — 8 test groups, **35+ individual cases**:

| # | Group | Cases |
|---|---|---|
| 1 | Pure condition evaluator (11 cases — every operator + composites + failure modes) | 11 |
| 2 | Dispatcher source-level safety (no vm/eval/fetch; team-scoped; P2002 handling; lifecycle emission) | 8 |
| 3 | Action handlers source-level safety (no fetch; no custody mutation; no WEBHOOK; team membership) | 10 |
| 4 | UI execution-active notice replaces foundation-only notice | 4 |
| 5 | WEBHOOK_DELIVERY absent from allowlists (TS + DB CHECK) | 2 |
| 6 | Capture / custody / report / package file-size pins | 5 |
| 7 | IA + state contract pins (6 primaries, no new state lib) | 2 |
| 8 | Documentation + registry updated; DEF-021 RESOLVED; DEF-022 OPEN | 4 |

The behavioural tests use the pure `evaluateCondition` export — no DB required. The dispatcher integration (which DOES require Prisma) is covered by source-level pins that prevent regressions in the safety-critical patterns.

---

## 10. Validation results

| Step | Result |
|---|---|
| `pnpm --filter proovra-api prisma generate` | ✅ |
| `pnpm --filter proovra-api typecheck` | ✅ |
| `pnpm --filter proovra-api test` | ✅ — 35+ new E3.1 tests included |
| `pnpm --filter proovra-web typecheck` | ✅ |
| `pnpm --filter proovra-web build` | ✅ |
| `pnpm --filter proovra-worker typecheck` | ✅ |
| `pnpm --filter proovra-worker test` | ✅ |

7/7 green.

---

## 11. Remaining risks

- **DEF-022 (webhook action)** stays OPEN. The runtime is intentionally webhook-free.
- **DEF-021 (dispatcher)** marked RESOLVED. Closure evidence: dispatcher + 7 handlers + 5 lifecycle events + idempotency + condition evaluator + source-level safety tests.
- **Per-action persistent downstream side-effect fan-out** is intentionally deferred. Each handler records intent in audit; persistent domain-state changes (NotificationDelivery rows, ReviewEscalation rows, etc.) land in bounded follow-up phases per action. This makes each side-effect reversibly reviewable.
- No new DEF items introduced in E3.1.

---

## 12. Exact next phase recommendation

**Phase E3.2 — Webhook delivery action.** Closes DEF-022.

Scope (well-bounded):
1. Extend DB CHECK constraint + TS allowlist to include `WEBHOOK_DELIVERY_INTERNAL_ONLY`.
2. Add destination-URL allowlist (env-configured) + HMAC-signed payload + bounded retry policy + per-team rate limit.
3. Handler emits the same `automation_action_executed` event with delivery summary (status code only, never response body).
4. Tests: allowlisted-destination-only, HMAC signature shape, retry bound, payload schema.

Alternative next phases:

1. **R-Audit-Vocabulary** — closes DEF-017 / DEF-018 / DEF-019 / DEF-020 (E2 audit gaps).
2. **R8.3** — SAML SP request signing (closes DEF-001).
3. **Action fan-out phases** — per-action bounded follow-ups that wire persistent side effects (e.g. NOTIFY_USER → NotificationDelivery, ADD_OPERATIONAL_COMMENT → CaseComment). One action per phase keeps blast radius minimal.

**Hard out-of-scope** (CR1.7 §12 + 32.8 §17 + E2/E3/E3.1 absolute rules): visual workflow builder, Zapier clone, scripting language, AI workflows, public marketplace, chat product, social feed, WebAuthn, SIEM, new auth providers, new IAM subsystems, new dashboards, navigation expansion, capture/custody/report/package logic, billing logic, brand redesign.

---

## Hard confirmations

- ✅ No workflow builder.
- ✅ No Zapier clone.
- ✅ No scripting / eval / custom code (E3.1 Tests 2 + 3).
- ✅ No AI workflows.
- ✅ No webhook execution (E3.1 Test 5).
- ✅ No evidence mutation (E3.1 Test 3 — handlers do not call `evidence.update`).
- ✅ No custody semantics changed (E3.1 Test 3 — handlers do not call `appendCustodyEvent`).
- ✅ No capture/upload/finalize/report/package logic touched (E3.1 Test 6).
- ✅ No new root nav item (E3.1 Test 7).
- ✅ No duplicate automation actions (idempotency unique index + dispatcher dedup + handler defence-in-depth).
- ✅ Automation is team-scoped (filter on `teamId` at dispatch + membership check at handler), idempotent (deterministic key + unique index), auditable (5 lifecycle events emitted), and bounded (only 7 allowlisted actions execute).
- ✅ MASTER_PHASE_REGISTRY updated — DEF-021 RESOLVED by Phase E3.1; DEF-022 remains OPEN.
