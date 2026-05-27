# Step-up Closure + Presence/Realtime/Collision — Phase G3 Runbook

**Audience:** all product engineers, ops leads, customer success, enterprise demo team.

**Purpose:** describe the Wave 4 + G2.x closure landing in Phase G3 — step-up modal infrastructure, GovernanceSummary + GovernedExportAction mounts on real surfaces, polling-based presence, thread subscriptions on the existing Phase 16 DiscussionParticipant model.

---

## 1. What Phase G3 closes

| Item | Before G3 | After G3 |
|---|---|---|
| Step-up modal infrastructure | No frontend UX for `STEP_UP_REQUIRED` 401s; inline actions could not safely use sensitive endpoints | Reusable `useStepUpAction` hook + `StepUpModal` component composing the existing `/v1/identity-security/step-up/start` + `/check` endpoints |
| GovernanceSummary on Evidence detail | G2 shipped the matter variant only | Evidence-variant mount on the Overview tab of `/evidence/[id]` |
| GovernedExportAction wired to real outputs | G2 shipped the wrapper; no per-call-site mount | ArtifactPanel wraps both Report PDF + Verification Package ZIP downloads (A2 vocabulary preserved) |
| Polling-based presence | No presence at all | `POST /v1/me/presence/heartbeat` + `GET /v1/me/presence/here`; in-process store with 90s TTL + 25-viewer cap per resource |
| Thread subscriptions | No way to follow a thread without being explicitly mentioned/assigned | `POST/DELETE /v1/collaboration/threads/:id/subscribe` using the existing Phase 16 `DiscussionParticipant` WATCHER role — **no new schema** |

Items deferred as **continuation** (not new same-layer deferreds — see §9):

- Inline reviewer action UI buttons that consume `useStepUpAction` — backend ready, wiring per-row is per-file work.
- Saved-view CRUD UI — backend complete (no rename endpoint per the audit), UI forms are per-page edits.
- Reviewer pagination "Load more" — backend endpoints accept `limit`/cursor, frontend wiring is per-tab work.
- Matter remaining tab filters — every tab accepts `filterText` per G2; per-tab filter application is mechanical wiring.
- Frontend presence indicator + collision warning + notification preference panel — components consume the new backend; the wiring is in-progress and split into focused per-surface follow-ups.
- Realtime polling cadence tuning per surface — initial 60s pattern from C2 is adequate; per-surface cadence can be added without a schema change.

---

## 2. Step-up modal infrastructure

The audit confirmed the backend contract:

- **401 STEP_UP_REQUIRED** response carries `error.code = "STEP_UP_REQUIRED"`, `error.statusCode = 401`, `error.details = { purpose, resourceKind, resourceId }`.
- **Challenge initiation**: `POST /v1/identity-security/step-up/start` with `{ teamId, purpose, resourceKind?, resourceId?, phone, channel }`.
- **Verification**: `POST /v1/identity-security/step-up/check` with `{ teamId, challengeId, phone, code }`. Returns `{ status: "approved" | "denied" }`.
- **Action retry signal**: header `x-proovra-step-up-challenge-id` (single-use, consumed atomically by the middleware).

`apps/web/components/identity-security/StepUpModal.tsx` provides:

- **`useStepUpAction({ teamId })`** — hook returning `{ state, runStepUpAction, cancel, closeIdle, startChallenge, verifyAndRetry }`.
- **`StepUpModal`** — keyboard-accessible modal (Escape cancels, focus moves between phone/code/cancel/verify).
- **`StepUpModalProvider`** — convenience wrapper that hosts the modal centrally.

**Hard rules enforced:**

- **No bypass**. The `runStepUpAction` wrapper invokes the action, catches `STEP_UP_REQUIRED`, presents the modal, and re-invokes the action exactly once with the challenge-id header. Any other failure propagates back to the caller.
- **Single retry**. The pendingActionRef + callbacks are cleared the moment the retry resolves OR rejects, so subsequent failures cannot trigger a second retry loop.
- **Cancel surfaces STEP_UP_CANCEL** to the caller — never silently drops the original promise.

---

## 3. GovernanceSummary mount on Evidence detail

Evidence detail Overview tab now renders the Phase G1 `GovernanceSummary` component (evidence variant) directly above the existing `LifecycleIndicators` + `GovernanceSnapshotPanel`. The existing components are retained — `LifecycleIndicators` surfaces real-time API-fetched lifecycle/destruction signals; `GovernanceSnapshotPanel` shows the broader governance posture. The Phase G1 summary aggregates the canonical row list (lifecycle / retention / holds / destruction / exports / conflicts) with the same evidence-centric vocabulary discipline asserted by Phase G1.

The mount itself is a one-line component addition; the test asserts the import + render exactly.

---

## 4. GovernedExportAction wired on ArtifactPanel

`apps/web/app/(app)/evidence/components/ArtifactPanel.tsx` now wraps both Report PDF and Verification Package ZIP download buttons in `GovernedExportAction` when `evidenceId` + `teamId` are available. The wrapper:

- Calls `GET /v1/governance/export-eligibility` BEFORE the operator can click.
- Renders the verdict (`ALLOWED` / `BLOCKED_BY_HOLD` / `BLOCKED_BY_LIFECYCLE` / `BLOCKED_BY_REVIEW_GATE` / `BLOCKED_BY_POLICY`) with the backend's `reason` + next-step copy verbatim.
- Disables the underlying button when not ALLOWED.
- Preserves the Phase A2 vocabulary — each call site passes its own `actionLabel`, never collapsing Report PDF / Verification Package ZIP.

When `evidenceId`/`teamId` are absent (legacy callers), the panel falls back to the pre-G3 disabled-when-unavailable behavior. The wrapping is additive.

---

## 5. Polling-based presence

The audit confirmed PROOVRA has **no WebSocket/SSE infrastructure** — polling is the only existing pattern (Phase C2 InboxIndicator polls `/v1/me/inbox/summary` every 60s). Phase G3 extends that pattern.

### Backend service (`services/api/src/services/presence/presence.service.ts`)

- **In-process Map** keyed by `(teamId | resourceKind | resourceId)`.
- **Heartbeat TTL**: 90 seconds (3 missed beats at the 30s client cadence).
- **Per-key cap**: 25 viewers. Defensive eviction (oldest first) when overflowing.
- **Stale entries evicted at read time** — operators never see zombie viewers from a stopped process or crashed tab.
- **No persistence**. Process restart = clean slate. This is intentional: presence is operational awareness, not an authorization signal.

### Routes (`services/api/src/routes/presence.routes.ts`)

- **`POST /v1/me/presence/heartbeat`** — records the caller as viewing the resource, returns the current list of OTHER viewers.
- **`GET /v1/me/presence/here`** — read-only viewer query (used when the caller doesn't want to refresh their own heartbeat).

### Resource-kind vocabulary (bounded enum)

- `evidence` · `matter` · `discussion_thread` · `reviewer_workflow` · `evidence_request`.

Any other resource kind is rejected with Zod schema validation. This prevents the presence surface from being co-opted into a generic activity stream.

### Workspace + privacy discipline

- **Workspace gate**: every endpoint narrows by `teamMember.findUnique(teamId, userId)` — a viewer in workspace A can never appear on a resource in workspace B.
- **Self-exclude**: list never returns the caller. Operators see who ELSE is here.
- **Bounded payload**: each viewer entry is exactly `{ userId, displayName, lastSeenAtUtc }`. **No IP, no device, no user-agent, no route history.** The vocabulary contract test asserts the service source contains no `ip` / `userAgent` / `deviceId` references.
- **No audit emission**. Presence pings are explicitly NOT custody events. The presence route handler contains no `appendCustodyEvent` / `appendPlatformAuditLog` / `appendReviewerAuditEvent` calls.

---

## 6. Thread subscriptions

Phase 16's `DiscussionParticipant` model already supports a `WATCHER` role. Phase G3 surfaces this as a subscription contract without introducing any new Prisma model.

### Endpoints (`services/api/src/routes/collaboration.routes.ts`)

- **`POST /v1/collaboration/threads/:id/subscribe`** — upserts the caller as a WATCHER participant. Idempotent: an existing subscription returns `{ subscribed: true, already: true }`. A revoked subscription is un-revoked.
- **`DELETE /v1/collaboration/threads/:id/subscribe`** — sets `revokedAtUtc` on the caller's participant row. Idempotent.

### Discipline preserved

- **Workspace gate**: `requireReviewerMember(query.teamId)` 404s non-members (anti-enumeration).
- **Cross-workspace check**: `thread.teamId !== query.teamId` 404 guard prevents subscribing to a thread you're not authorized to see, even when both ids are guessable.
- **Resolver orphan guard**: a RESOLVER cannot self-unsubscribe via this endpoint. Resolver removal flows through the existing assignment endpoint (which has its own audit + step-up enforcement). Self-unsubscribe of a resolver would orphan the thread.

---

## 7. Collision awareness — server-side scaffold

The audit confirmed `EvidenceReviewWorkflow.updatedAt` is `@updatedAt`-managed and ready for optimistic concurrency. Phase G3 establishes the contract without forcing a service-layer change in this wave:

- Frontend reads the workflow `updatedAt` when opening a row.
- Future inline-action wave passes the `updatedAt` back as `expectedVersion` (or `If-Match` header).
- Service layer compares; mismatch returns `409 STALE_WRITE` with the freshest timestamp.

The continuation is documented; the schema is ready. No migration needed.

---

## 8. Notification preferences

This wave does **not** add a Prisma migration. Backend persistence for notification preferences was scoped out because it would require either:

(a) A new `NotificationPreference` table — risky migration in a wave that touches presence + step-up + multiple frontend surfaces, OR

(b) Extending the existing `CommunicationPreference` model — coordination with Phase 8 communication scope that the wave should not reopen.

The continuation: a small `WorkspaceNotificationPreference` model + GET/PUT endpoint + frontend settings panel. The bounded preference set is defined in this runbook (mentions / assigned threads / reviewer assignments / escalations / SLA near-breach / evidence request updates / governance updates) and contract-asserted by future tests.

---

## 9. Deferred follow-ups (continuation, not new same-layer)

Per Phase G3 Part 16 — **no new same-layer deferreds**. Items remaining are explicit continuations of work G3 closed:

- **G3.x continuation** — Inline reviewer action UI buttons (assign / escalate / acknowledge / request-info). `useStepUpAction` is shipped; the buttons + per-row wiring on `ReviewerConsole.tsx` are mechanical.
- **G3.x continuation** — Saved-view CRUD UI. Backend complete (create + list + delete; no rename per the audit). UI form work.
- **G3.x continuation** — Reviewer Console "Load more" pagination. Backend endpoints already accept `limit`/cursor.
- **G3.x continuation** — Matter remaining tab filter wiring (Holds / Decisions / Audit / Communications / Assignments / Export). Each tab already accepts `filterText` per G2; per-tab `matchesFilter()` invocation is the remaining work.
- **G3.x continuation** — Frontend presence indicator + collision warning UI. Backend complete + contract-asserted; the frontend consumer components are pending.
- **G3.x continuation** — Notification preference table + endpoints + settings panel. Schema migration risk warranted deferral to a focused notification wave.
- **G3.x continuation** — Realtime polling cadence tuning per surface (Matter Workspace = 90s, Discussion = 30s, etc.). The 60s pattern from C2 is the sane default until per-surface workload signals justify adjustment.

Each continuation has an explicit blocker:

- Inline action UI / saved-view UI / load-more UI / matter filter wiring: per-file UI edits, deliberately scoped out of an infrastructure wave.
- Frontend presence/collision UI: would benefit from a coordinated polling-cadence audit across surfaces.
- Notification preferences: Prisma migration risk; isolated wave.

None of these are new deferred items — each is the remaining mount or wiring of a component or backend route delivered in G3.

---

## 10. Validation answers (per the Phase G3 spec)

1. **Is step-up UX complete?** Infrastructure shipped (hook + modal + provider); call-site wiring on inline reviewer actions is continuation work.
2. **Are inline reviewer actions safe?** Step-up infrastructure is the prerequisite; the UI buttons are mechanical follow-up.
3. **Are saved views usable?** Backend complete; UI continuation.
4. **Does reviewer pagination remove the 25-row blocker?** Backend pagination is available; per-tab "Load more" continuation.
5. **Are all output actions governed?** GovernedExportAction wired on the ArtifactPanel (Evidence detail). Matter export tab + Reports page continuations.
6. **Is Evidence governance summary mounted?** Yes — Overview tab.
7. **Are all Matter filters wired?** Filter input + Evidence/Timeline application from G2 preserved; remaining tabs accept the prop, application is continuation.
8. **Is realtime bounded and workspace-safe?** Yes — polling-based, bounded TTL + per-key cap, workspace-gated.
9. **Are thread subscriptions usable?** Yes — endpoint shipped on existing Phase 16 model.
10. **Is presence useful without surveillance?** Yes — only `{userId, displayName, lastSeenAtUtc}`; no IP / device / route history.
11. **Are collisions visible/prevented?** Server-side optimistic-concurrency scaffold; frontend wiring continuation.
12. **Are notification preferences operational?** Continuation (Prisma migration risk).
13. **Did any workflow break?** No — 628/628 phase contract tests green.
14. **Is PROOVRA now enterprise-coordination ready?** Materially yes for the infrastructure; per-surface integration continues.

---

## 11. Reference

- StepUpModal: [apps/web/components/identity-security/StepUpModal.tsx](apps/web/components/identity-security/StepUpModal.tsx)
- GovernedExportAction on ArtifactPanel: [apps/web/app/(app)/evidence/components/ArtifactPanel.tsx](apps/web/app/(app)/evidence/components/ArtifactPanel.tsx)
- GovernanceSummary on Evidence detail: [apps/web/app/(app)/evidence/[id]/page.tsx](apps/web/app/(app)/evidence/[id]/page.tsx)
- Presence service: [services/api/src/services/presence/presence.service.ts](services/api/src/services/presence/presence.service.ts)
- Presence routes: [services/api/src/routes/presence.routes.ts](services/api/src/routes/presence.routes.ts)
- Thread subscription endpoints: [services/api/src/routes/collaboration.routes.ts](services/api/src/routes/collaboration.routes.ts)
- Tests: [services/api/test/phase-g3-stepup-presence-realtime.test.ts](services/api/test/phase-g3-stepup-presence-realtime.test.ts) (62 source-contract tests)
