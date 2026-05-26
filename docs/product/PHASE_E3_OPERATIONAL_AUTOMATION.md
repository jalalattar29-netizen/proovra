# PHASE E3 — Operational Automation Foundation

**Status:** `CLOSED_WITH_DEFERRED_ITEMS`
**Date:** 2026-05-25
**Predecessor:** Phase E2 (`CLOSED_WITH_DEFERRED_ITEMS`)
**Successor:** TBD by registry §8.

Phase E3 ships the **bounded automation foundation** — Prisma models, service-layer validation, REST API, capability gates, security-event vocabulary, frontend visibility page — without rushing trigger execution. The trigger DISPATCHER + worker execution are explicitly deferred to **E3.1** (registered as DEF-021). The `WEBHOOK_DELIVERY_INTERNAL_ONLY` action is deferred to **E3.2** (registered as DEF-022).

Per CR1.7 §9 entry-gate, the registry was read before code edit. Per CR1.7 §10 closure template, the registry is updated on close. Per the CR1.7 silent-debt rule, the 2 new audit gaps are registered as **DEF-021 + DEF-022**.

---

## 1. Registry entry-gate (per CR1.7 §9)

- **Last closed phase:** Phase E2 (`CLOSED_WITH_DEFERRED_ITEMS`). No blockers.
- **DEF items assigned to E3:** none directly. E2's new DEF-016 → DEF-020 are observability gaps, not automation foundations.
- **Forbidden surfaces:** capture / upload / finalize / custody / TSA / OTS / report / package / billing / SAML / MFA / SCIM logic. File-size pins (carried since CR1.6 / 32.7 / 32.8 / E2) enforced via E3 Test 14. No new root nav (32.8 IA pinned, re-pinned by E3 Test 9). No new state library. No PlatformContextEnvelope semantic change.
- **Scope-creep refusal list:** visual workflow builder, drag-drop UI, Zapier clone, scripting language, eval, user-defined code, AI-generated workflows, unlimited triggers/actions, public marketplace, analytics dashboards, AI features, chat features.

---

## 2. Automation inventory (audit-derived)

Phase E3 starts from a clean slate — no `AutomationRule` / `AutomationRun` Prisma model existed; no `AUTOMATION_*` capability key; no `/v1/automation/*` route. The audit found extensive existing infrastructure to integrate with:

| System | Existing | Trigger candidate | Action candidate | Risk | Notes |
|---|---|---|---|---|---|
| Reviewer queues | ✅ Phase 25 | REVIEW_ASSIGNED / REVIEW_OVERDUE | ASSIGN_REVIEWER | LOW | Reviewer reassignment already emits `reviewer_reassigned` |
| Assignments | ✅ Phase 32.8E | (no new triggers) | CREATE_REVIEW_TASK | LOW | Bounded by existing `CASE_ASSIGN` capability |
| Escalations | ✅ Phase 25 | ESCALATION_CREATED | CREATE_ESCALATION | LOW | State machine OPEN → ACK → RESOLVED already exists |
| Notifications | ✅ Phase 8 | (consumes triggers) | NOTIFY_USER / NOTIFY_ROLE | LOW | Multi-channel engine already operator-safe |
| Legal holds | ✅ Phase 14 | LEGAL_HOLD_CREATED | (forbidden — never auto-release) | HIGH-RISK if auto-action | Read-only trigger source only |
| Retention lifecycle | ✅ Phase 27 | RETENTION_CANDIDATE_FOUND | (forbidden — never auto-destroy) | HIGH-RISK if auto-action | Read-only trigger source only |
| Report/package readiness | ✅ Phase 31 | EVIDENCE_REPORTED / PACKAGE_READY | (notifications only) | LOW | Side-effect-free status |
| Evidence/case status | ✅ Phase 1.5+ | EVIDENCE_CREATED / EVIDENCE_FINALIZED | APPLY_LABEL / ADD_OPERATIONAL_COMMENT | LOW | No evidence mutation |
| Governance events | ✅ Phase 14 + 27 | (read-only trigger source) | (forbidden — manual review only) | HIGH-RISK if auto-action | |
| Audit events | ✅ extensive | (read-only) | (writes only via service) | LOW | |
| Worker queues / BullMQ | ✅ used by worker service | (E3.1 dispatcher will reuse) | (E3.1 worker will reuse) | LOW | Bounded retry policy already in place |

**Key automation design rules drawn from inventory:**
- Auto-actions that mutate evidence, custody, legal holds, retention, or external access are **FORBIDDEN**. The action allowlist enforces this.
- Auto-actions that send notifications, assign reviewers, create escalations, label, or comment are **SAFE** — they go through existing capability-gated services.
- Trigger sources reuse existing event sources; no new event taxonomy.

---

## 3. Bounded automation model

### 3.1 Schema (Prisma + DB)

`AutomationRule`:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `teamId` | UUID | FK → teams, ON DELETE CASCADE |
| `name` | varchar(120) | required |
| `description` | varchar(500) | nullable |
| `enabled` | boolean | default `false` (rules always created disabled) |
| `triggerType` | varchar(60) | DB CHECK constraint enforces the 11-item allowlist |
| `conditionJson` | jsonb | service-validated against bounded operator schema |
| `actionType` | varchar(60) | DB CHECK constraint enforces the 7-item allowlist |
| `actionConfigJson` | jsonb | service-validated per action-type strict schema |
| `version` | int | increments on every PATCH / enable / disable |
| `createdByUserId` | UUID | FK → users |
| `updatedByUserId` | UUID | FK → users |
| `createdAt` / `updatedAt` / `disabledAt` | timestamptz | |

`AutomationRun`:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `teamId` | UUID | FK → teams, ON DELETE CASCADE |
| `ruleId` | UUID | FK → automation_rules, ON DELETE CASCADE |
| `triggerType` | varchar(60) | the firing trigger |
| `targetType` / `targetId` | varchar(60) / UUID | what the trigger fired on |
| `idempotencyKey` | varchar(120) | sha256(rule \| trigger \| targetType \| targetId)[0:64] |
| `status` | varchar(20) | DB CHECK: PENDING / RUNNING / SUCCEEDED / FAILED / SKIPPED |
| `reason` | varchar(400) | operator-safe; truncated by `sanitiseReason()` |
| `startedAt` / `completedAt` / `createdAt` | timestamptz | |

**Unique constraint:** `(teamId, ruleId, idempotencyKey)` — duplicate trigger events for the same target collapse to the same run row.

### 3.2 Hard rules (DB + service + tests)

- **Team-scoped:** every row carries `teamId`. CASCADE on team delete.
- **Allowlist-only trigger types:** DB CHECK + TS const union. 11 triggers (Part 4).
- **Allowlist-only action types:** DB CHECK + TS const union. 7 actions (Part 5; webhook deferred to E3.2).
- **Bounded run status:** DB CHECK enum.
- **Idempotency:** unique index prevents duplicate runs.
- **No evidence/custody mutation:** the action allowlist excludes any destructive operation. The runtime dispatcher (E3.1) will enforce the same allowlist at execution time.
- **No scripting / eval:** service does not import `vm`, does not use `eval()`, does not call `new Function(…)`. Pinned by E3 Test 4.

---

## 4. Allowlisted triggers (11)

Pinned at the TS layer in `automation.service.ts` (`AUTOMATION_TRIGGER_TYPES`) AND at the DB layer in `automation_rules_trigger_type_allowlist` CHECK constraint:

| Trigger | Source system | Target type |
|---|---|---|
| `EVIDENCE_CREATED` | Capture / evidence routes | `evidence` |
| `EVIDENCE_FINALIZED` | Evidence finalize service | `evidence` |
| `EVIDENCE_REPORTED` | Reports worker | `evidence` |
| `PACKAGE_READY` | Verification-package worker | `evidence` |
| `REVIEW_ASSIGNED` | Reviewer-ops service | `evidence_review_workflow` |
| `REVIEW_OVERDUE` | SLA reconciler | `evidence_review_workflow` |
| `SLA_DUE_SOON` | SLA reconciler | `evidence_review_workflow` |
| `ESCALATION_CREATED` | Reviewer-ops service | `review_escalation` |
| `LEGAL_HOLD_CREATED` | Governance service | `evidence_legal_hold` |
| `RETENTION_CANDIDATE_FOUND` | Retention reconciler | `evidence` |
| `EXTERNAL_ACCESS_EXPIRING` | External-review reconciler | `external_review_grant` |

Adding a 12th trigger requires a coordinated migration (DB CHECK update) + service const update + test update. The safety belt is intentional.

---

## 5. Allowlisted actions (7 + 1 deferred)

Pinned at TS + DB layers:

| Action | Config schema | Risk class |
|---|---|---|
| `NOTIFY_USER` | `{ userId: uuid, template: string }` | LOW — uses Phase 8 notification engine |
| `NOTIFY_ROLE` | `{ role: OWNER\|ADMIN\|REVIEWER\|MEMBER, template: string }` | LOW |
| `CREATE_REVIEW_TASK` | `{ assigneeUserId?, slaHours?, reason? }` | LOW — bounded by `REVIEW_ASSIGN` |
| `CREATE_ESCALATION` | `{ severity, ownerUserId?, reason? }` | LOW — bounded by `REVIEW_ESCALATE` |
| `ASSIGN_REVIEWER` | `{ assigneeUserId, role?, reason? }` | LOW — bounded by `REVIEW_REASSIGN` |
| `APPLY_LABEL` | `{ label: string }` | LOW |
| `ADD_OPERATIONAL_COMMENT` | `{ body, visibility }` | LOW — uses CaseComment/EvidenceReviewerComment |
| ~~`WEBHOOK_DELIVERY_INTERNAL_ONLY`~~ | — | **DEFERRED to E3.2 (DEF-022)** — requires allowlisted destinations + signed payloads |

Forbidden actions (never on the allowlist): evidence deletion, evidence mutation, custody modification, legal hold release, retention destruction, external access grant, arbitrary HTTP.

### 5.1 Strict per-action JSON validation

Each action config is parsed by a strict Zod schema (unknown fields rejected, lengths bounded, UUIDs validated). The service returns operator-safe validation errors with field + reason. No dynamic eval. No expression language.

---

## 6. Idempotency strategy

```
idempotencyKey = sha256(ruleId | triggerType | targetType | targetId)[0:64]
```

- Deterministic — same trigger event for the same target produces the same key.
- DB enforces uniqueness on `(teamId, ruleId, idempotencyKey)` — a duplicate insert raises `P2002` which the runtime dispatcher (E3.1) will translate into a SKIPPED run.
- Key length fits the varchar(120) column with room for a future `:retry-N` suffix.

---

## 7. Queue / worker execution

**DEFERRED to E3.1 (DEF-021).** E3 ships the schema + service + API + UI foundation. Trigger dispatchers (which observe domain events and create `AutomationRun` rows) and the worker (which executes the bounded actions via existing services) land in E3.1.

Reason for the split:
- E3's foundation must be reviewable + reversible. Schema + capability + API changes are bounded and easy to audit.
- Execution wiring touches multiple worker services and requires careful failure-mode testing.
- Shipping execution + foundation in one phase would make rollback harder.

E3.1 will reuse existing BullMQ infrastructure (the worker service already uses it for notification delivery and other async work).

---

## 8. Audit / security events

9 new event types registered in the canonical `SECURITY_EVENT_TYPES` vocabulary (`packages/shared/src/security.ts`):

```
automation_rule_created
automation_rule_updated
automation_rule_enabled
automation_rule_disabled
automation_run_started
automation_run_succeeded
automation_run_failed
automation_run_skipped
automation_action_executed
```

E3 emits **none of these** today — emission is part of E3.1 when the runtime dispatcher lands. The vocabulary is registered now so the dispatcher can consume it without a second vocabulary change.

Event payloads will NEVER include: raw evidence content, secrets, tokens, private URLs, or raw external payloads. The `sanitiseReason()` helper truncates operator-facing strings to 380 chars + strips control characters.

---

## 9. API endpoints

All routes live at `/v1/automation/*` (`services/api/src/routes/automation.routes.ts`). Every endpoint requires authentication + team membership; VIEW endpoints require `AUTOMATION_VIEW`, MANAGE endpoints require `AUTOMATION_MANAGE`.

| Method | Path | Capability |
|---|---|---|
| GET | `/v1/automation/rules?teamId=` | AUTOMATION_VIEW |
| POST | `/v1/automation/rules` | AUTOMATION_MANAGE |
| PATCH | `/v1/automation/rules/:id` | AUTOMATION_MANAGE |
| POST | `/v1/automation/rules/:id/enable` | AUTOMATION_MANAGE |
| POST | `/v1/automation/rules/:id/disable` | AUTOMATION_MANAGE |
| GET | `/v1/automation/runs?teamId=` | AUTOMATION_VIEW |
| GET | `/v1/automation/runs/:id` | AUTOMATION_VIEW |

**Rules are always created disabled** — explicit `enable` action required. This is a deliberate safety default for production automation.

---

## 10. UI placement

Lives at `/ops/automation` — **inside the Operations Center hub, NOT a root nav item**. The 32.8 canonical primary route list remains bounded at 6 (pinned by E3 Test 9, re-pinning 32.8 Test 1).

The page (apps/web/app/(app)/ops/automation/page.tsx) provides:
- Rules list (name, trigger, action, enabled, last updated)
- Run history (status, target, reason)
- Bounded allowlists reference (read-only display of trigger + action types)
- LoadState branches: loading / ready / auth_error / unavailable
- PageRouteGate enforcing `AUTOMATION_VIEW`
- An explicit dispatcher-pending notice so operators know rules don't execute yet

**UI explicitly excludes** (pinned by E3 Test 10): drag-and-drop builder, workflow canvas, scripting editor, AI generator, marketplace, template gallery, realtime/WebSocket.

Rule create + edit form UI is intentionally minimal in E3 (API-driven; full form lands in E3.1). This keeps the foundation visible without overstating runtime capability.

---

## 11. Condition model

Bounded JSON tree, parsed by Zod, depth ≤ 4. Operator allowlist:

```
equals | not_equals | greater_than | less_than |
in | not_in | due_within_hours | older_than_days
```

Composition: `{ all: [...] }` (logical AND) and `{ any: [...] }` (logical OR), max 8 children each. Leaves are `{ field, op, value }` with bounded primitive values (no objects, no arrays of objects).

**Explicitly forbidden** (pinned by E3 Test 4): `eval`, `exec`, `script`, `regex`, `regex_match`, `function`, `javascript` operators. The service source does NOT import `vm` and does NOT call `eval()` or `new Function(…)`.

---

## 12. Webhook decision

**`WEBHOOK_DELIVERY_INTERNAL_ONLY` is intentionally deferred to E3.2.**

Reasoning:
- Safe webhook delivery requires: allowlisted destination URLs, signed payloads, bounded retry policy, no raw evidence content, no secrets in payload, abuse-prevention rate limiting.
- E3's allowlist intentionally excludes the action type so no rule can be created with it. Adding it to the DB CHECK constraint requires a coordinated migration.
- Tracked as DEF-022 in the registry.

---

## 13. Tests

**New file:** `services/api/test/phase-e3-automation-foundation.test.ts` — 15 test groups, **66+ individual cases**:

| # | Group | Cases |
|---|---|---|
| 1 | Bounded trigger + action + status allowlists (TS layer) | 3 |
| 2 | DB CHECK constraints mirror the TS allowlists | 5 |
| 3 | Prisma models + relations defined correctly | 5 |
| 4 | Service-layer JSON validation (no scripting / no eval) | 9 |
| 5 | Idempotency key deterministic + bounded | 4 |
| 6 | REST endpoints registered + capability-gated | 9 |
| 7 | Capability keys present in API + web type unions | 3 |
| 8 | 9 automation security events registered (it.each ×9 + count) | 10 |
| 9 | Route registry entry exists but NOT root nav | 3 |
| 10 | Frontend page exists + UI guardrails (no builder/scripts/AI/marketplace) | 4 |
| 11 | Duplicate-trigger prevention contract | 2 |
| 12 | Reason sanitiser bounds + strips control chars | 2 |
| 13 | No new client-state / realtime library | 1 |
| 14 | Capture / custody / report / package file-size pins | 5 |
| 15 | Documentation + registry updated | 3 |

---

## 14. Validation results

| Step | Result |
|---|---|
| `pnpm --filter proovra-api prisma generate` | ✅ |
| `pnpm --filter proovra-api typecheck` | ✅ |
| `pnpm --filter proovra-api test` | ✅ — 66+ new E3 tests included |
| `pnpm --filter proovra-web typecheck` | ✅ |
| `pnpm --filter proovra-web build` | ✅ 92 pages + 1 new (`/ops/automation`) |
| `pnpm --filter proovra-worker typecheck` | ✅ |
| `pnpm --filter proovra-worker test` | ✅ |

---

## 15. Deferred items (new — added to registry §6)

| ID | Item | Severity | Blocking? | Deferred to | Reason | Closure criteria |
|---|---|---|---|---|---|---|
| **DEF-021** | Automation trigger dispatcher + worker execution | LOW | NON_BLOCKING | E3.1 | E3 ships the schema + service + API + UI foundation; runtime execution wiring is a separate, reviewable phase. Rules can be created but do not fire until E3.1 wires them. | E3.1 ships trigger event consumers + BullMQ worker that creates + processes `AutomationRun` rows + emits the 9 registered security events on each lifecycle transition. |
| **DEF-022** | `WEBHOOK_DELIVERY_INTERNAL_ONLY` action type | LOW | NON_BLOCKING | E3.2 | Safe webhook delivery requires allowlisted destinations + signed payloads + bounded retry + abuse-prevention. The action type is intentionally absent from the E3 DB CHECK constraint and TS allowlist. | E3.2 ships the webhook action with: destination allowlist (env-configured), HMAC-signed payload, bounded retry, per-team rate limit, no raw evidence content. The DB CHECK constraint is extended in the same phase. |

---

## 16. Remaining risks

- **DEF-021** — automation rules can be created but do not execute until E3.1.
- **DEF-022** — webhook destination action not yet shipped.
- Pre-existing open DEF items from prior phases unchanged.

All E3-introduced items are LOW severity, NON_BLOCKING — the foundation is safe to ship without execution because:
- Rules are always created disabled.
- No trigger source observes events (no automatic runs).
- The UI clearly indicates execution is pending E3.1.

---

## 17. Exact next phase recommendation

**Phase E3.1 — Trigger dispatcher + worker execution.** Closes DEF-021.

Scope (well-bounded):
1. Add trigger-event consumers that observe existing domain events (e.g. `reviewer_reassigned` → REVIEW_ASSIGNED trigger).
2. For each matching enabled rule, compute idempotency key + insert PENDING `AutomationRun` row.
3. Worker dequeues PENDING runs, validates action config against allowlist + permissions, executes via existing services, transitions to SUCCEEDED / FAILED / SKIPPED.
4. Each lifecycle transition emits the corresponding security event (already in vocabulary).

If a different code phase is requested:

1. **R-Audit-Vocabulary phase** — closes DEF-017 / DEF-018 / DEF-019 / DEF-020 (E2 audit gaps).
2. **R8.3 — SAML SP request signing** (closes DEF-001).
3. **R10 — `useTeamId()` migration sweep** (closes DEF-008).

**Hard out-of-scope** (CR1.7 §12 + 32.8 §17 + E2/E3 absolute rules): visual workflow builder, Zapier clone, scripting language, AI-generated workflows, public marketplace, chat product, social feed, WebAuthn, SIEM, new auth providers, new IAM subsystems, new dashboards, navigation expansion, capture/custody/report/package logic, billing logic, brand redesign.

---

## Hard confirmations

- ✅ No visual workflow builder (E3 Test 10 pin).
- ✅ No Zapier clone — bounded allowlists only (E3 Tests 1 + 2).
- ✅ No scripting engine — no `vm` import, no `eval`, no `new Function` (E3 Test 4).
- ✅ No AI workflow generation (E3 Test 10 pin).
- ✅ No arbitrary triggers/actions — DB CHECK + TS const enforced (E3 Tests 1 + 2).
- ✅ No evidence mutation — action allowlist excludes all destructive ops.
- ✅ No custody semantics changed — file-size pins (E3 Test 14).
- ✅ No capture/upload/finalize/report/package logic touched (E3 Test 14).
- ✅ No new root nav item — `platform.automation` under Operations Center (E3 Test 9).
- ✅ No cross-team leakage — every route requires team membership + capability check (E3 Test 6).
- ✅ No duplicate notifications/actions — idempotency unique index + sha256 key (E3 Tests 5 + 11).
- ✅ Automation is team-scoped, idempotent, and auditable.
- ✅ 2 new DEF items registered (DEF-021 + DEF-022) — no silent debt (CR1.7 §12 protocol).
- ✅ MASTER_PHASE_REGISTRY updated (E3 Test 15).
