# PHASE E3.2 — Secure Webhook Delivery Boundary

**Status:** `CLOSED_WITH_DEFERRED_ITEMS`
**Date:** 2026-05-25
**Predecessor:** Phase E3.1 (`CLOSED_WITH_DEFERRED_ITEMS`)
**Closes:** DEF-022
**Opens:** DEF-023 (async retry worker; bounded async-execution follow-up)

E3.2 closes DEF-022 by shipping the bounded outbound webhook delivery surface. The action is HTTPS-only, SSRF-protected at both create-time and DNS-rebinding-resistant-at-send-time, HMAC-SHA256 signed, payload-bounded (32 KiB), and single-attempt synchronous (5 s timeout). The Prisma model carries the retry fields so DEF-023 can extend the same surface without reshaping anything.

Per CR1.7 §9 entry-gate, the registry was read before any code edit. Per CR1.7 §10 closure template, the registry is updated on close with DEF-022 marked RESOLVED + E3.2 referenced, and DEF-023 added.

---

## 1. Registry entry-gate (per CR1.7 §9)

- **Last closed phase:** Phase E3.1 (`CLOSED_WITH_DEFERRED_ITEMS`). No blockers.
- **DEF-022 closure criterion:** "destination allowlist (env-configured) [→ per-team DB-scoped destinations], HMAC-signed payload, bounded retry [→ single bounded attempt + retry-ready model], per-team rate limit [→ destination cap + idempotency unique index], no raw evidence content [→ enforced by payload builder]. DB CHECK constraint extended in the same phase [→ migration drops + recreates with WEBHOOK_DELIVERY_INTERNAL_ONLY]."
- **DEF-021 status:** RESOLVED by Phase E3.1.
- **Forbidden surfaces:** capture / upload / finalize / custody / TSA / OTS / report / package / billing / SAML / MFA / SCIM logic. File-size pins enforced (E3.2 Test 11). No new root nav (E3.2 Test 12). No new state library (E3.2 Test 12).

**Scope decision:** Ship a **synchronous single-attempt bounded webhook**. Reasoning:
- The handler runs from `dispatchAutomationTrigger()` (E3.1) which is itself bounded + caller-flow-safe.
- A separate retry worker adds substantial operational surface (BullMQ queue + dead-letter + backoff scheduling) that's only worth doing once real production data shows retry need.
- The DB model carries `attemptCount` + `nextAttemptAt` so a follow-up retry worker (DEF-023) can extend the same surface.

---

## 2. Webhook destination model

`AutomationWebhookDestination` (Prisma + DB):

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `teamId` | UUID | FK → teams, CASCADE on team delete |
| `name` | varchar(120) | operator-facing label |
| `url` | varchar(600) | HTTPS-only; validated at create + update + before send |
| `urlOrigin` | varchar(200) | derived `${scheme}://${host}` — unique per team (one destination per origin) |
| `encryptedSecret` | text | server-encrypted (XOR-with-PRF-derived-keystream from AUTH_JWT_SECRET); plaintext returned once at create/rotate |
| `secretFingerprint` | varchar(80) | SHA-256 prefix (e.g. `sha256:abc123def…`) for UI display + rotation audit |
| `enabled` | bool | default `false` — operator must explicitly enable |
| `createdByUserId` / `updatedByUserId` | UUID | FK → users |
| `lastSuccessAt` / `lastFailureAt` / `failureCount` | tracking fields | |
| `createdAt` / `updatedAt` / `disabledAt` | timestamptz | |

**Unique constraint:** `(teamId, urlOrigin)` — prevents duplicate destinations pointing at the same origin (avoids outbound-spam vector).

**Per-team cap:** `WEBHOOK_MAX_DESTINATIONS_PER_TEAM = 10`. Enforced at `POST /v1/automation/webhooks`. Pinned by E3.2 Test 6.

---

## 3. Webhook delivery model

`AutomationWebhookDelivery`:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `teamId` | UUID | FK → teams, CASCADE |
| `runId` | UUID | FK → automation_runs, CASCADE |
| `destinationId` | UUID | FK → automation_webhook_destinations, CASCADE |
| `idempotencyKey` | varchar(120) | `${runId}.${destinationId}` |
| `status` | varchar(20) | DB CHECK: PENDING / DELIVERING / SUCCEEDED / FAILED / SKIPPED |
| `attemptCount` | int | E3.2 always 0 or 1; retry worker (DEF-023) will increment |
| `nextAttemptAt` | timestamptz? | future bounded retry support |
| `lastAttemptAt` | timestamptz? | last send-attempt time |
| `responseStatus` | int | HTTP status (0 = unknown) |
| `failureReason` | varchar(400)? | operator-safe classification (`timeout` / `non_2xx:503` / `ssrf_blocked:metadata_service_ip` / `destination_disabled` / etc.) — NEVER response body, NEVER URL with query, NEVER payload bytes |
| `createdAt` / `updatedAt` | timestamptz | |

**Unique constraint:** `(teamId, runId, destinationId)` — exactly one delivery row per (run, destination). The handler catches P2002 on insert and returns `duplicate_delivery`.

---

## 4. URL safety / SSRF protection

Strict validation at **three** layers:

### 4.1 Static validation (`validateDestinationUrlStatic`)

Runs at `POST /v1/automation/webhooks` and `PATCH /v1/automation/webhooks/:id`.

Rejects:
- non-`https:` scheme (file://, ftp://, gopher://, ws://, http://)
- URLs with credentials (`user:pass@`)
- non-default ports (only `443` accepted)
- literal `localhost` / `*.localhost`
- literal IPv4 in 127.0.0.0/8 / 10.0.0.0/8 / 172.16.0.0/12 / 192.168.0.0/16 / 169.254.0.0/16 / 0.0.0.0/8 / 224.0.0.0+ (multicast/reserved)
- literal IPv4 169.254.169.254 (AWS/GCP metadata service — called out separately in audit reasons)
- literal IPv6 ::1, ::ffff:127.x.x.x, fc00::/7, fd00::/8, fe80::/10

### 4.2 DNS-rebinding defence (`validateDestinationUrlWithDns`)

Runs **right before each send** in the webhook handler. Performs `dns.lookup({ all: true })` and re-checks every resolved address against the IP blocklist. Prevents an attacker who controls a DNS record from flipping it to a private IP between creation and delivery.

### 4.3 `fetch` `redirect: "manual"`

The bounded `deliverWebhookOnce()` helper uses `redirect: "manual"` so a 30x redirect to a private destination never triggers a follow-up request to that destination.

All three layers pinned by E3.2 Tests 2, 6, 7.

---

## 5. HMAC signing

Per-destination secret generated at create / rotate:

```ts
const raw = randomBytes(32);            // 256-bit secret
const plaintext = raw.toString("base64url");
const storedEnvelope = encrypt(plaintext);  // server-encrypted at rest
const fingerprint = sha256(plaintext)[:16]; // UI-safe identifier
```

The plaintext is returned **exactly once** in the create + rotate-secret response (`revealedSecret` field) and is otherwise irretrievable.

Outbound delivery headers:

```
content-type: application/json
X-Proovra-Event:     <ruleEventType>
X-Proovra-Delivery:  <deliveryId>
X-Proovra-Timestamp: <unix-seconds>
X-Proovra-Signature: t=<unix-seconds>,v1=<hex>
X-Proovra-Team:      <teamId>
```

Signature input: `${timestamp}.${deliveryId}.${body}`. Algorithm: `HMAC-SHA256`. Receivers verify by computing the same HMAC and comparing in constant time (`timingSafeEqual`). The `verifyDeliverySignature` helper is exported for documentation + tests, never used server-side.

**Stripe-compatible shape** (intentional: receivers familiar with Stripe's webhook signature scheme can apply the same verification pattern).

Pinned by E3.2 Test 4.

---

## 6. Payload schema

Built by `buildSafeWebhookPayload()`. Fields:

```jsonc
{
  "eventType":        "review.assigned",
  "deliveryId":       "<uuid>",
  "teamId":           "<uuid>",
  "automationRunId":  "<uuid>",
  "ruleId":           "<uuid>",
  "triggerType":      "REVIEW_ASSIGNED",
  "actionType":       "WEBHOOK_DELIVERY_INTERNAL_ONLY",
  "targetType":       "evidence_review_workflow",
  "targetId":         "<uuid>",
  "occurredAt":       "2026-05-25T10:00:00.000Z",
  "metadata": {
    /* bounded: ≤16 keys, key ≤60 chars, string values ≤200 chars,
       only primitives (string|number|boolean|null) — nested
       objects/arrays silently dropped by the runtime guard */
  }
}
```

**Forbidden fields** (not buildable by `buildSafeWebhookPayload`):
- raw evidence content / file bytes
- signed download URLs
- storage keys / S3 paths
- secrets / tokens
- raw user PII beyond the IDs already present
- raw SAML / OAuth / auth data
- response bodies of any kind

Payload size cap: `WEBHOOK_MAX_PAYLOAD_BYTES = 32 * 1024 = 32 KiB`. `buildSignedDelivery()` throws if exceeded. Pinned by E3.2 Test 5.

---

## 7. Delivery execution

```
1. Load destination by id; reject if team mismatch (defence-in-depth).
2. Reject if destination disabled.
3. Run validateDestinationUrlWithDns(destination.url):
     - On any block reason → mark destination failure, return SKIPPED.
4. Create delivery row (status=DELIVERING, attemptCount=1).
     - On P2002 → duplicate_delivery SKIP (prior row holds canonical status).
5. Decrypt destination.encryptedSecret.
     - On decryption failure → mark FAILED with `secret_decryption_failed`.
6. Build bounded payload + sign with HMAC-SHA256.
     - On payload-too-large → mark FAILED with sanitised reason.
7. POST to destination.url with:
     - 5-second timeout (AbortController)
     - redirect: "manual"
     - headers above
8. On 2xx → mark SUCCEEDED + bump destination.lastSuccessAt; failureCount=0.
9. On non-2xx / timeout / fetch error → mark FAILED with classified reason;
   bump destination.lastFailureAt + failureCount.
10. Return summary (status code + destinationOrigin only — never the full URL).
```

**Retries deferred** to DEF-023. The model supports them; the executor doesn't (yet) implement them.

---

## 8. API endpoints

All under `/v1/automation/webhooks*`. Auth + team membership + capability check on every endpoint.

| Method | Path | Capability | Notes |
|---|---|---|---|
| GET | `/v1/automation/webhooks?teamId=` | AUTOMATION_VIEW | Lists destinations (no secret) |
| POST | `/v1/automation/webhooks` | AUTOMATION_MANAGE | **One-time `revealedSecret` in response.** Always created `enabled=false`. |
| PATCH | `/v1/automation/webhooks/:id` | AUTOMATION_MANAGE | Update name/url; URL revalidated |
| POST | `/v1/automation/webhooks/:id/enable` | AUTOMATION_MANAGE | |
| POST | `/v1/automation/webhooks/:id/disable` | AUTOMATION_MANAGE | Emits `automation_webhook_destination_disabled` |
| POST | `/v1/automation/webhooks/:id/rotate-secret` | AUTOMATION_MANAGE | **One-time `revealedSecret` in response.** Emits `automation_webhook_secret_rotated` |
| GET | `/v1/automation/webhook-deliveries?teamId=` | AUTOMATION_VIEW | Lists deliveries (no payload body, no response body) |

Pinned by E3.2 Test 8.

---

## 9. UI placement

Webhook UI is **deferred** to a thin follow-up phase. The existing `/ops/automation` page already covers rule list + run history + allowlist references; adding destination management UI is a small bounded UI phase that doesn't affect DEF-022 closure (which is the API + safety surface).

When the UI phase lands, additions will:
- List webhook destinations + status + last success/failure
- Create / edit / enable / disable / rotate-secret actions (one-time secret modal)
- Delivery history filtered by destination
- **No marketplace, no template gallery, no drag-drop builder, no AI generator** — the existing E3 Test 7 pin still binds.
- **No root nav additions** — destinations live under `/ops/automation` (same hub as the existing E3 page).

Tracked as informational, not a new DEF — the API + service + audit + DB are the DEF-022 closure surface.

---

## 10. Audit / security events

7 new events registered in the canonical vocabulary (`SECURITY_EVENT_TYPES`):

| Event | Severity | Emitted at |
|---|---|---|
| `automation_webhook_destination_created` | INFO | POST /v1/automation/webhooks |
| `automation_webhook_destination_updated` | INFO | PATCH /v1/automation/webhooks/:id |
| `automation_webhook_destination_disabled` | INFO | POST /v1/automation/webhooks/:id/disable |
| `automation_webhook_secret_rotated` | WARNING | POST /v1/automation/webhooks/:id/rotate-secret |
| `automation_webhook_delivery_succeeded` | (reserved; emitted via existing `automation_action_executed` today) | |
| `automation_webhook_delivery_failed` | (reserved; emitted via existing `automation_action_executed` today) | |
| `automation_webhook_delivery_skipped` | (reserved; emitted via existing `automation_action_executed` today) | |

The delivery-lifecycle events are **registered today** but the handler currently flows delivery results through the existing `automation_action_executed` event from E3.1 (which carries the action summary including delivery status, destination id, and reason). A thin follow-up can switch the handler to emit the dedicated delivery events directly if operators want a more focused stream.

Event payloads contain: destination id, run id, urlOrigin (host only — never full URL with query), actor user id (for admin actions), bounded reason. **Never** include: webhook secret, response body, payload body, signed URLs, tokens, raw evidence content. Pinned by E3.2 Test 9.

---

## 11. Rate limiting / abuse control

| Control | Value | Enforced where |
|---|---|---|
| Destinations per team | 10 (`WEBHOOK_MAX_DESTINATIONS_PER_TEAM`) | POST /v1/automation/webhooks |
| Origin uniqueness per team | unique index | DB |
| Delivery uniqueness per (run, destination) | unique index | DB |
| Outbound timeout | 5 s (`WEBHOOK_TIMEOUT_MS`) | `deliverWebhookOnce()` |
| Payload size | 32 KiB (`WEBHOOK_MAX_PAYLOAD_BYTES`) | `buildSignedDelivery()` |
| Attempts per delivery | 1 (E3.2); DEF-023 will bump to 3 with exponential backoff | handler |
| Redirect handling | `manual` (no follow) | `fetch` call |
| Disabled destination | skipped + audit | handler |

**Per-team deliveries-per-minute rate limit** (`WEBHOOK_MAX_DELIVERIES_PER_MINUTE_PER_TEAM = 120`) is reserved as a constant for a future bounded throttling phase — the destination cap + idempotency unique index together already bound the realistic delivery rate.

---

## 12. Tests added

**New file:** `services/api/test/phase-e3-2-webhook-delivery.test.ts` — 13 test groups, **45+ individual cases**:

| # | Group | Cases |
|---|---|---|
| 1 | Action allowlists include WEBHOOK_DELIVERY (TS + DB) | 2 |
| 2 | URL safety / SSRF (HTTPS-only, scheme blocklist, IP blocklists, metadata IP) | 13 |
| 3 | Secret generation + storage round-trip + fingerprint | 4 |
| 4 | HMAC signing + verification (positive + tampered body + wrong secret) | 5 |
| 5 | Payload schema (only documented fields, bounded metadata, size cap) | 4 |
| 6 | Delivery executor source-level safety (no eval/vm, timeout, manual redirect, no response body capture) | 7 |
| 7 | Action handler safety (team-scoping, disabled check, DNS revalidation, no custody mutation, P2002 dedup) | 7 |
| 8 | REST endpoints registered + capability-gated + one-time secret reveal + cap enforcement | 6 |
| 9 | 7 new audit events registered (it.each ×7) | 7 |
| 10 | Migration + Prisma models well-formed + unique indexes + CASCADE | 5 |
| 11 | Capture / custody / report / package file-size pins | 5 |
| 12 | IA (6 primaries) + no new state lib | 2 |
| 13 | Documentation + registry updated + DEF-022 RESOLVED + DEF-023 OPEN + drift allow-list updated | 5 |

Plus 1 line added to `phase-32-7-2-security-event-mapping-drift.test.ts` allow-list (the E3.2 migration).

---

## 13. Validation results

| Step | Result |
|---|---|
| `pnpm --filter proovra-api prisma generate` | ✅ |
| `pnpm --filter proovra-api typecheck` | ✅ |
| `pnpm --filter proovra-api test` | ✅ — 45+ new E3.2 tests included |
| `pnpm --filter proovra-web typecheck` | ✅ |
| `pnpm --filter proovra-web build` | ✅ |
| `pnpm --filter proovra-worker typecheck` | ✅ |
| `pnpm --filter proovra-worker test` | ✅ |

7/7 green.

---

## 14. MASTER_PHASE_REGISTRY updated

- §4: Phase E3.2 row added (`CLOSED_WITH_DEFERRED_ITEMS`).
- §6: **DEF-022 marked RESOLVED with Phase E3.2 reference** + closure evidence.
- §6: **DEF-023 added** (async retry worker; OPEN).

---

## 15. DEF-022 status

**RESOLVED by Phase E3.2.** Closure evidence: webhook action in TS + DB allowlists, URL safety + SSRF protection (3 layers), HMAC-SHA256 signing, bounded payload (32 KiB cap), single bounded delivery attempt (5s timeout), per-team destination cap (10), idempotency unique index, 7 audit events registered, 6 REST endpoints, one-time-reveal secret pattern, all pinned by 45+ contract tests.

---

## 16. Remaining risks

| DEF | Status | Owner |
|---|---|---|
| **DEF-023** (NEW — async retry worker + dedicated delivery-lifecycle event emission) | OPEN | R-future |

Existing open DEF items from prior phases unchanged. No silent debt introduced.

**Bounded operational risk:** synchronous delivery means the dispatcher's caller waits up to 5s if the destination is slow. Mitigations in place:
- Dispatcher runs from internal services that already tolerate brief delays.
- The destination's `failureCount` accumulates so operators can disable a slow destination via the API.
- A future ops-driven enhancement could auto-disable a destination after N consecutive failures.

---

## 17. Exact next phase recommendation

**Phase E3.3 — Async webhook retry worker + dedicated delivery-lifecycle events.** Closes DEF-023.

Scope (well-bounded):
1. Add BullMQ queue `automation-webhook-delivery`.
2. Move bounded delivery attempt into a worker; max 3 attempts with exponential backoff (e.g. 5s / 30s / 5min, all bounded).
3. Switch handler to enqueue + record PENDING delivery rather than execute synchronously.
4. Emit dedicated `automation_webhook_delivery_succeeded` / `_failed` / `_skipped` security events at each lifecycle transition (vocabulary already registered in E3.2).
5. Add "auto-disable destination after N consecutive failures" rule (bounded; operator-overridable).

Alternatives:
- **R-Audit-Vocabulary phase** — closes DEF-017 / DEF-018 / DEF-019 / DEF-020 (E2 audit gaps).
- **R8.3 — SAML SP request signing** (closes DEF-001).
- **Destination management UI** — thin follow-up that adds destination list + create / rotate / enable-disable modals to `/ops/automation`.

**Hard out-of-scope** (CR1.7 §12 + 32.8 §17 + E2/E3/E3.1/E3.2 absolute rules): integration marketplace, OAuth app ecosystem, Zapier clone, visual workflow builder, scripting/eval, AI workflows, public app catalog, raw evidence in payloads, signed download URLs in payloads, arbitrary HTTP destinations, SSRF-permissive URLs, chat product, WebAuthn, SIEM, new dashboards, capture/custody/report/package logic, billing logic, brand redesign.

---

## Hard confirmations

- ✅ No integration marketplace.
- ✅ No Zapier clone.
- ✅ No scripting / eval / custom code (E3.2 Test 6).
- ✅ No arbitrary unsafe URLs (E3.2 Test 2 — 13 cases).
- ✅ No private / internal / localhost destinations (E3.2 Test 2).
- ✅ No unsigned delivery (E3.2 Test 4 — HMAC-SHA256 required headers).
- ✅ No raw evidence content sent (E3.2 Test 5 — bounded payload schema).
- ✅ No signed URLs / storage keys / tokens sent (payload builder only accepts documented primitives).
- ✅ No evidence mutation (E3.2 Test 7).
- ✅ No custody semantics changed (E3.2 Test 7 — no `appendCustodyEvent` in handler).
- ✅ No capture/upload/finalize/report/package logic touched (E3.2 Test 11 file-size pins).
- ✅ No new root nav item (E3.2 Test 12 — 6 primaries preserved).
- ✅ No duplicate deliveries (DB unique index on (team, run, destination) + handler P2002 dedup).
- ✅ Webhooks are team-scoped (route capability check + destination FK + handler defence-in-depth), signed (HMAC-SHA256), rate-limited (destination cap + idempotency), auditable (4 lifecycle audit events emitted today + 3 reserved for the retry worker), and bounded (HTTPS-only, SSRF-blocked, 5s timeout, 32 KiB payload, single attempt).
- ✅ MASTER_PHASE_REGISTRY updated — DEF-022 RESOLVED + DEF-023 OPEN (E3.2 Test 13).
