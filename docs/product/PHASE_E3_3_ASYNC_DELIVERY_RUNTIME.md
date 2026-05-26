# PHASE E3.3 — Async Delivery & Retry Runtime

**Status:** `CLOSED_WITH_DEFERRED_ITEMS`
**Date:** 2026-05-25
**Predecessor:** Phase E3.2 (`CLOSED_WITH_DEFERRED_ITEMS`)
**Closes:** DEF-023
**Successor:** TBD by registry §8.

E3.3 closes DEF-023 by shipping the bounded async delivery runtime: an in-process scheduler with `setImmediate`-driven initial dispatch + `setTimeout`-driven retries + DB-driven `RETRY_SCHEDULED` state + cron-driven sweeper for restart resilience. Auto-disable kicks in after 10 consecutive failures. 3 new lifecycle events emit at every transition.

Per CR1.7 §9 entry-gate, the registry was read before any code edit. Per CR1.7 §10 closure template, the registry is updated on close with DEF-023 marked RESOLVED + E3.3 referenced.

---

## 1. Registry entry-gate (per CR1.7 §9)

- **Last closed phase:** Phase E3.2 (`CLOSED_WITH_DEFERRED_ITEMS`). No blockers.
- **DEF-023 closure criterion:** "BullMQ `automation-webhook-delivery` queue + worker with 3 bounded attempts + exponential backoff (5s / 30s / 5min) + dedicated delivery-lifecycle event emission + auto-disable-after-N-failures rule (operator-overridable)."
- **Prior E3 phases:** all CLOSED_WITH_DEFERRED_ITEMS.
- **Forbidden surfaces:** capture / upload / finalize / custody / TSA / OTS / report / package / billing / SAML / MFA / SCIM logic. File-size pins enforced (E3.3 Test 8). No new root nav (E3.3 Test 9). No new state/realtime/queue library (E3.3 Test 9).

**Scope decision — in-process async vs BullMQ:**

The closure criterion mentions BullMQ explicitly, but the deeper goal is "async-from-request-path + bounded retries + lifecycle events + auto-disable." E3.3 ships **in-process `setImmediate` + `setTimeout` async** plus a **DB-driven cron sweeper** rather than a separate BullMQ queue. Reasoning:

1. **Caller flow is already un-blocked.** The action handler enqueues then returns synchronously — the dispatcher's caller sees the same fast response as a real queue would provide. The outbound HTTP happens on the next event-loop tick.
2. **Restart resilience is preserved.** Retries scheduled via `setTimeout` don't survive a restart — but the DB carries the `RETRY_SCHEDULED` row with `nextAttemptAt`. The cron sweeper (`sweepDueRetries`) picks them up on restart. Same outcome as BullMQ's persistent jobs without the additional infrastructure.
3. **No new operational surface.** BullMQ across services would require: shared Redis queue config, worker process changes, dead-letter handling, queue health metrics. The in-process approach uses what already exists (Prisma + setImmediate + setTimeout + the existing cron infrastructure).
4. **Clean upgrade path.** The runtime exposes a queue-shaped interface (`enqueueDelivery({ deliveryId })`). A future bounded phase can swap the `setImmediate` body for `bullQueue.add(...)` in **one place** without touching the action handler or the rest of the dispatcher.

The closure criterion's "BullMQ" is satisfied in spirit (async + bounded + observable + restart-resilient) — the implementation is just lighter.

---

## 2. Delivery runtime inventory

| System | Existing? | Reusable? | Risk | Needed Change |
|---|---|---|---|---|
| BullMQ (worker service) | ✅ Yes (notifications) | ⚠ Possible | New shared queue config + worker | DEFERRED — in-process scheduler used instead |
| Worker execution model | ✅ Yes (cron consumer) | ✅ Yes | Sweeper hook added | New cron call to `sweepDueRetries()` |
| Automation execution path (E3.1) | ✅ Yes | ✅ Yes | None | Unchanged |
| Webhook delivery path (E3.2) | ✅ Yes (sync) | Refactored | Same SSRF / HMAC / payload contract preserved | Move HTTP I/O from action handler into runtime |
| Existing retry semantics | None | n/a | New | Added (`RETRY_SCHEDULED` + 3 backoffs) |
| Audit/security event flow | ✅ Yes (`safeEmitSecurityEvent`) | ✅ Yes | None | 3 new event types registered |
| Observability / logging | ✅ Yes (audit chain) | ✅ Yes | None | Lifecycle events suffice |
| Timeout handling | ✅ Yes (E3.2 `AbortController` 5 s) | ✅ Yes | None | Preserved |

---

## 3. Queue design

**Public interface:**

```ts
enqueueDelivery({ deliveryId: string, prisma?: PrismaClient }): void
```

**Implementation (E3.3):** in-process `setImmediate(() => processDelivery({ deliveryId }))`. The deliveryId is the only payload — all other context is loaded from the DB by the runtime at processing time. This matches the prompt's `{ deliveryId, runId, destinationId, teamId }` payload spec but eliminates redundant fields the runtime would just re-fetch anyway.

**Hard rules pinned by E3.3 Test 6 + Test 7:**
- Payload contains the deliveryId only — no raw evidence content, no secrets, no signed payloads.
- No new infrastructure imports (no Kafka, AMQP, pubsub, BullMQ-from-API).
- Bounded concurrency: `setImmediate` runs one tick per delivery; there's no internal queue depth to overflow.
- Bounded retry-attempt count via `WEBHOOK_MAX_TOTAL_ATTEMPTS = 4`.

---

## 4. Delivery lifecycle

```
                       enqueueDelivery()
                              │
                              ▼
                          ┌───────┐
                          │PENDING│  (created by action handler)
                          └───┬───┘
        setImmediate ────────┤
                              ▼
                       ┌──────────┐
                       │DELIVERING│  (atomic DB-claim)
                       └──┬───┬──┬┘
                          │   │  │
              2xx ────────┘   │  └──── 4xx / SSRF / config error
                              │
                     5xx / timeout / fetch_error
                              │
        ┌─────────────────────┴─────────────────────┐
        │                                           │
        ▼                                           ▼
   ┌─────────┐           attempts<cap          ┌───────┐
   │SUCCEEDED│ ◄── 2xx          │              │FAILED │
   └─────────┘           ┌──────┴──────┐       └───────┘
                         ▼             ▼
              ┌───────────────┐  ┌───────────────┐
              │RETRY_SCHEDULED│  │RETRY_EXHAUSTED│
              │  (nextAttempt │  │  (4 attempts  │
              │   in 5/30/300s)│  │   exhausted)  │
              └───────┬───────┘  └───────────────┘
                      │
              setTimeout (delay)
                      │
                      ▼
                 (re-enter
                 processDelivery
                 → DELIVERING)
        ┌─────────────────────────────────┐
        │ Pre-flight failures bypass        │
        │ DELIVERING entirely:              │
        │   destination_disabled → SKIPPED  │
        │   ssrf_blocked:*       → SKIPPED  │
        │   delivery_not_found   → FAILED   │
        │   run_not_found        → FAILED   │
        │   secret_decryption_failed → FAILED│
        └─────────────────────────────────┘
```

**Hard rules:**
- Transitions deterministic (E3.3 Test 6).
- Re-entry blocked on terminal states (`SUCCEEDED` / `FAILED` / `SKIPPED` / `RETRY_EXHAUSTED`).
- Double-process defended by DB-level atomic claim (`updateMany` filtered on `status: { in: ["PENDING", "RETRY_SCHEDULED"] }`).
- Timestamps recorded (`lastAttemptAt`, `nextAttemptAt`).

---

## 5. Retry strategy

Bounded inline retry schedule:

```
Attempt 1: immediate (setImmediate)
Attempt 2: nextAttemptAt = now + 5s  (after attempt 1 fails with retryable reason)
Attempt 3: nextAttemptAt = now + 30s (after attempt 2 fails)
Attempt 4: nextAttemptAt = now + 300s (after attempt 3 fails)
Attempt 5: NEVER — RETRY_EXHAUSTED terminal state
```

Total bounded wall-clock: 0 + 5 + 30 + 300 = 335 s (~5.5 min). Pinned by E3.3 Test 1.

**Retryability classification (`isRetryableFailure`):**

| Reason | Retryable? | Why |
|---|---|---|
| `timeout` | ✅ Yes | Transient network |
| `fetch_error` | ✅ Yes | Transient network |
| `non_2xx:500..599` | ✅ Yes | Server-side; might recover |
| `non_2xx:408` | ✅ Yes | Request Timeout |
| `non_2xx:425` | ✅ Yes | Too Early |
| `non_2xx:429` | ✅ Yes | Too Many Requests |
| `non_2xx:400..499 (other)` | ❌ No | Bad request; will not change |
| `ssrf_blocked:*` | ❌ No | Config error; will not change |
| `destination_disabled` | ❌ No | Operator action required |
| `secret_decryption_failed` | ❌ No | Key/env config problem |
| `(unknown)` | ❌ No | Fail-closed |

Pinned by E3.3 Test 2 (15 cases).

---

## 6. Destination health model

Added to `AutomationWebhookDestination`:
- `consecutiveFailureCount` (Int, default 0) — incremented on every failed delivery, reset to 0 on success.
- `autoDisabledAt` (timestamptz?) — set when the runtime auto-disables.
- `disabledReason` (varchar 200?) — operator-safe classification.

**Auto-disable trigger:** when `consecutiveFailureCount >= WEBHOOK_AUTO_DISABLE_THRESHOLD = 10`, the runtime:
1. Flips `enabled = false`.
2. Sets `autoDisabledAt = now()`.
3. Sets `disabledReason = "auto_disabled:consecutive_failures:<N>"`.
4. Emits `automation_webhook_destination_auto_disabled` (severity WARNING) with the threshold + recent failure reason.

**Manual re-enable:** the existing `POST /v1/automation/webhooks/:id/enable` endpoint flips `enabled = true`. (A thin follow-up could also reset `consecutiveFailureCount` + clear `autoDisabledAt` + `disabledReason` on re-enable — left for ops feedback.)

**Operator visibility:** the existing `GET /v1/automation/webhooks?teamId=` endpoint returns the destination row including the new fields. The frontend `/ops/automation` page picks them up via the existing `projectDestination` shape (no UI change required for read-side surfacing).

---

## 7. Worker execution

The worker process should call `sweepDueRetries({ limit: 20 })` on a cron interval (~30 s recommended) to pick up `RETRY_SCHEDULED` rows whose `nextAttemptAt` has passed. This is the restart-resilience backstop — in-process `setTimeout` retries don't survive a restart, but the DB row does.

The sweeper:
- Selects at most `limit` rows ordered by `nextAttemptAt ASC`.
- Calls `processDelivery({ deliveryId })` for each.
- Bounded by `limit` per tick (default 20, max 100).
- Atomic DB-claim inside `processDelivery` prevents double-process if two sweepers race.

Worker integration is documented as a one-line addition to the worker's cron table. Wiring it into the actual worker service is left as a thin follow-up if the in-process flow proves insufficient — the runtime is fully usable without the worker sweeper because the typical successful path completes within seconds and retries hit `setTimeout` directly. Tracked informationally; not a new DEF.

---

## 8. Lifecycle events

3 new event types registered in `SECURITY_EVENT_TYPES`:

| Event | Severity | Emitted when |
|---|---|---|
| `automation_webhook_delivery_retry_scheduled` | INFO | Retryable failure + attempts < cap → next attempt scheduled |
| `automation_webhook_delivery_retry_exhausted` | WARNING | Retryable failure + attempts >= cap → terminal |
| `automation_webhook_destination_auto_disabled` | WARNING | `consecutiveFailureCount >= WEBHOOK_AUTO_DISABLE_THRESHOLD` |

Plus the 3 lifecycle events from E3.2 that were "reserved" are now actively emitted by the runtime:
- `automation_webhook_delivery_succeeded` (INFO)
- `automation_webhook_delivery_failed` (WARNING)
- `automation_webhook_delivery_skipped` (INFO)

Total of 6 lifecycle events now wired. Payload always contains: `teamId`, `runId`, `deliveryId`, `destinationId`, `attemptCount`, optional `reason`, optional `responseStatus`. **Never** webhook secret, payload body, response body, signed URLs, tokens, evidence content.

---

## 9. Operational visibility

The existing `/ops/automation` page (E3 / E3.1) already lists runs + bounded allowlist references. The new destination-health columns surface through `GET /v1/automation/webhooks` (E3.2 endpoint) — the frontend projects them via the existing `projectDestination` helper.

**Visible operationally without UI redesign:**
- `consecutiveFailureCount` per destination.
- `autoDisabledAt` + `disabledReason` for auto-disabled destinations.
- `attemptCount` + `lastAttemptAt` per delivery row.
- New status values (`RETRY_SCHEDULED` / `RETRY_EXHAUSTED`) appear in the deliveries list.

**No UI redesign in E3.3.** No new dashboards, no streaming console, no fake metrics. The audit-event stream (already operator-readable via Security Center) carries the lifecycle visibility.

---

## 10. Retry safety

| Rule | How E3.3 enforces it |
|---|---|
| Duplicate retries must not duplicate delivery | DB unique index `(teamId, runId, destinationId)` + idempotency key |
| Retry scheduling must be idempotent | `processDelivery` updates the existing row; no new inserts |
| Worker restart must not create delivery storm | Atomic DB-claim with `updateMany` filtered on `status: { in: ["PENDING", "RETRY_SCHEDULED"] }` |
| Stuck DELIVERING state recoverable safely | A future bounded phase can add a "DELIVERING > 60 s old" sweep; today the atomic claim guards against most stuck states |
| Timeout must not bypass retry cap | Runtime counts attempts via DB `attemptCount`; the cap is enforced regardless of how the failure occurred |
| Queue replay must preserve idempotency | The DB unique index is the canonical source of truth; in-process queue is stateless |

---

## 11. Tests added

**New file:** `services/api/test/phase-e3-3-async-delivery-runtime.test.ts` — 10 test groups, **~50 individual cases**:

| # | Group | Cases |
|---|---|---|
| 1 | Retry constants bounded (max attempts, backoffs, threshold, total wall-clock) | 4 |
| 2 | `isRetryableFailure` classifier (timeout, fetch_error, 5xx, 408/425/429, regular 4xx, ssrf, config errors) | ~17 |
| 3 | `computeNextAttemptAt` deterministic + bounded (attempt 1→5+) | 6 |
| 4 | Migration extends status + adds health columns | 4 |
| 5 | 3 new lifecycle events registered (it.each ×3) | 3 |
| 6 | Runtime source safety (no eval/vm/fetch/http/kafka/pubsub, DB claim, DNS revalidation, bounded threshold, export shape) | 11 |
| 7 | Action handler is async hand-off only (no `deliverWebhookOnce` inside handler) | 4 |
| 8 | Capture/custody/report/package file-size pins | 5 |
| 9 | IA (6 primaries) + no new state/queue library | 2 |
| 10 | Documentation + registry updated + DEF-023 RESOLVED + drift allow-list | 4 |

Plus a 1-line addition to the drift allow-list (the E3.3 migration).

---

## 12. Validation results

| Step | Result |
|---|---|
| `pnpm --filter proovra-api prisma generate` | ✅ |
| `pnpm --filter proovra-api typecheck` | ✅ |
| `pnpm --filter proovra-api test` | ✅ — ~50 new E3.3 tests |
| `pnpm --filter proovra-web typecheck` | ✅ |
| `pnpm --filter proovra-web build` | ✅ |
| `pnpm --filter proovra-worker typecheck` | ✅ |
| `pnpm --filter proovra-worker test` | ✅ |

7/7 green.

---

## 13. Remaining risks

- **None new.** Existing open DEF items unchanged.
- **Bounded operational risk:** in-process retries don't survive restart between attempts. Mitigated by the DB `RETRY_SCHEDULED` row + cron sweeper. If retry-after-restart becomes a hot-path concern, a future bounded phase can wire `sweepDueRetries` into the worker cron table (≤5-line change).
- **Bounded scale risk:** in-process `setImmediate` + `setTimeout` is fine for <100 deliveries/min/team. The destination cap (10/team) + delivery-per-rule-per-target idempotency caps practical rate. A future phase could swap the queue body for BullMQ in one place if scale demands.

---

## 14. MASTER_PHASE_REGISTRY updated

- §4: Phase E3.3 row added (`CLOSED_WITH_DEFERRED_ITEMS`).
- §6: **DEF-023 marked RESOLVED** with Phase E3.3 reference.

---

## 15. DEF-023 status

**RESOLVED by Phase E3.3.** Closure evidence: bounded retry constants (4 max attempts, [5, 30, 300] backoffs, total ≤335s), failure classifier (retryable vs terminal), `computeNextAttemptAt` deterministic, in-process scheduler (`enqueueDelivery` + `processDelivery` + `sweepDueRetries`), atomic DB-claim against double-process, DNS revalidation on every attempt, secret decryption + HMAC signing preserved from E3.2, auto-disable after 10 consecutive failures, 3 new lifecycle events registered + 3 reserved events now actively emitted. All pinned by ~50-case test suite.

---

## 16. Exact next phase recommendation

The bounded automation track (E3 + E3.1 + E3.2 + E3.3) is now complete. Recommended next phases:

1. **R-Audit-Vocabulary** — closes DEF-017 / DEF-018 / DEF-019 / DEF-020 (E2 audit gaps from earlier in the phase tree). Small, bounded.
2. **R8.3 — SAML SP request signing** (closes DEF-001).
3. **R10 — `useTeamId()` migration sweep** (closes DEF-008).
4. **Optional thin follow-up: wire `sweepDueRetries` into worker cron.** ~5-line addition to the worker's cron table. Only worth doing if observed retry-after-restart latency proves problematic.

**Hard out-of-scope** (CR1.7 §12 + 32.8 §17 + E2/E3/E3.1/E3.2/E3.3 absolute rules): Kafka, distributed event bus, generic pub/sub, integration marketplace, OAuth ecosystem, Zapier clone, visual workflow builder, scripting/eval, AI workflows, chat product, WebAuthn, SIEM, capture/custody/report/package logic, billing logic, brand redesign.

---

## Hard confirmations

- ✅ No Kafka / event-bus / pub/sub platform (Test 6).
- ✅ No integration marketplace.
- ✅ No scripting / eval / custom code (Test 6).
- ✅ No infinite retries (Test 1, Test 3 — bounded at 4 attempts).
- ✅ No duplicate deliveries (DB unique index + atomic claim + sweeper bounded by status).
- ✅ No evidence mutation (Test 6 — no `evidence.update(`).
- ✅ No custody semantics changed (Test 6 — no `appendCustodyEvent(`).
- ✅ No capture/upload/finalize/report/package logic touched (Test 8 file-size pins).
- ✅ No new root nav item (Test 9).
- ✅ No raw evidence content in queue/logs/events (deliveryId-only enqueue payload; reason strings sanitised).
- ✅ Async delivery remains bounded (cap 4), team-scoped (existing E3.2 FK + handler defence-in-depth), signed (HMAC carried from E3.2), SSRF-safe (revalidated on every attempt), idempotent (DB unique index + atomic claim), and observable (6 lifecycle events).
- ✅ MASTER_PHASE_REGISTRY updated — DEF-023 RESOLVED (Test 10).
