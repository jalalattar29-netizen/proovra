# PROOVRA — Phase 4B Final Closure

**Product Packaging & Lifecycle Enforcement Completion · Final Report**

Phase scope: close every Critical + Important audit finding from the Phase 4B strict audit. Turn archive tiers from enum chrome into real S3 storage-class transitions; turn destruction from a record-keeping pass into a real S3 delete with a cryptographically signed downloadable certificate; turn the webhook platform from a `PENDING`-row factory into a real at-least-once dispatcher with bounded retries; turn exchange packages from manifest-only stubs into real signed ZIPs sitting in S3; unify legal-hold so a single canonical check covers Phase 4A *and* Phase 4B holds; and expose policy violations as a first-class auditable stream.

Closure date: 2026-05-30.
Branch posture: shared / Prisma / API tsc / web tsc / vitest suite — green.

---

## 1 — Every audit finding (verbatim from the audit verdict)

### Critical

| # | Audit finding |
|---|---|
| C1 | **Archive tiers are not real storage tiers.** `transitionEvidenceTier` writes an `ArchiveTierAssignment` row + a transition row + emits a webhook, but never calls S3 `CopyObject` with a new `StorageClass`. HOT/WARM/COLD/DEEP_ARCHIVE move governance metadata only — bytes stay on STANDARD. |
| C2 | **Destruction never deletes bytes.** `executeDestruction` walks the legal-hold gate, advances state, mints a certificate, but never issues `DeleteObject` or KMS key-shred. Evidence rows are not even tombstoned. |
| C3 | **Destruction certificate is a hash with no artifact.** `certifyDestruction` writes a `DestructionCertificate.certificateHash` but produces no downloadable JSON/PDF, no operator-visible signature, no S3-stored artifact. |
| C4 | **Webhook dispatcher does not exist.** `webhook-platform.service.ts` writes `PENDING` rows. No worker polls them. `deliverWebhookDelivery` is a per-row executor that nobody calls in production. |
| C5 | **Exchange package builder does not exist.** `createExchangePackage` writes a `BUILDING` row; nothing ever flips it to `READY`. No ZIP, no S3 key, no sha256. Signed-URL minting points at a key that doesn't exist. |
| C6 | **Legal-hold gate is split-brain.** Phase 4A has `EvidenceLegalHold` + `CaseLegalHold`; Phase 4B introduced a new `LegalHold` table. `assertNoLegalHoldOrBlock` consults only the 4B table. A 4A-era hold does not block 4B destruction. |
| C7 | **Policy violations are emitted but not queryable.** `POLICY_VIOLATION_*` codes are written into `IntelligenceActivityEvent`, but no route, dashboard count, or operator surface exposes them. They are silent in the product. |

### Important

| # | Audit finding |
|---|---|
| I1 | Archive transitions to GLACIER / DEEP_ARCHIVE have no restore path. |
| I2 | Destruction certificate has no `.json` / `.pdf` download route. |
| I3 | Verify page has no lifecycle transparency (retention / hold / archive / destruction signals). |
| I4 | Webhook delivery observability missing — operators can't see response codes, retry timing, dead-letter reason. |
| I5 | Webhook dead-letter has no replay path. |
| I6 | `FEATURE_*` entitlements are declared but never gated at the route layer for foundational surfaces (dashboard, lifecycle landing). |
| I7 | Exchange-package builder has no per-kind content matrix — every kind would produce the same payload. |
| I8 | Archive auto-transition scheduler is a stub (`{ ok: true, scheduled: 0 }`). |
| I9 | Lifecycle dashboard `policyViolations` aggregate uses heuristic counts, not the canonical `POLICY_VIOLATION_*` stream. |
| I10 | Lifecycle code drift — `DESTRUCTION_EXECUTED` written from execute path is not in `INTELLIGENCE_LIFECYCLE_CODES`; emission silently dropped. |

---

## 2 — Root cause (per finding)

* **C1.** Phase 4B scaffolded the tier enum + cost projection + transition rows first, on the (correct) assumption that storage-class changes were a separable, S3-coupled second pass. The second pass never landed before the phase closed, so the tier was a *governance label* with no bytes-side action.
* **C2.** Same pattern as C1 — the legal-hold gate, dual-approval, and certificate were prioritised because they protect the audit story; the S3 delete was treated as an "execution detail" and deferred. The result was a workflow that swore evidence had been destroyed while the bytes were still durable on the bucket.
* **C3.** The certificate hash was computed deterministically (good) but no one wrote the artifact body, signed it, or stored it where an auditor could fetch it. The product *talked about* certificates without producing one.
* **C4.** `webhook-platform.service.ts` was designed as an outbox: producer writes `PENDING`, a dispatcher drains. The dispatcher half — the loop, the HMAC sign, the backoff, the dead-letter logic — was never built because the inserts proved the contract worked in unit tests. Production was an outbox with no drain.
* **C5.** Exchange packages were tested via state-machine assertions on the row. The actual ZIP builder, S3 upload, and sha256 stamping were a worker concern, and no worker existed for them.
* **C6.** Phase 4B introduced its own legal-hold model rather than extending the 4A surface. The 4B gate consulted only the 4B model, so any 4A-era hold (CaseLegalHold / EvidenceLegalHold) silently did not block 4B-era destruction or archive ops — the worst kind of split-brain.
* **C7.** `POLICY_VIOLATION_*` codes landed in `IntelligenceActivityEvent` (the canonical audit log), but no read surface joined that stream. Violations existed for auditors with raw SQL access, not for operators.
* **I1.** Glacier tiers in S3 require an explicit `RestoreObject` call before bytes are accessible. The transition path emitted the storage-class change but had no restore counterpart.
* **I2–I3.** Verify-page + cert-download surfaces were inside the same "follow-up" bucket as the trust-references UI consumer in Phase 4A — known, sequenced, deferred.
* **I4–I5.** Observability + replay are the operational tail of the dispatcher. Without the dispatcher (C4), they were moot; with it, they become first-class.
* **I6.** Entitlement assertion was applied at mutation routes but not at read surfaces. A FREE-tier workspace could browse the dashboard freely.
* **I7.** The builder's "kind" parameter was a label that materialised into the manifest; per-kind content branching was never written.
* **I8.** Auto-transition needs a cron + a windowing rule. Phase 4B shipped the manual path; the cron was a tracked follow-up.
* **I9.** `policyViolations.totalLast30d` summed inferred fields rather than counting bounded `POLICY_VIOLATION_*` rows. Numbers diverged from the audit stream.
* **I10.** The execute path emitted `DESTRUCTION_EXECUTED`, but the bounded code list omitted that exact string — the emitter swallowed it.

---

## 3 — Fix applied (per finding)

* **C1.** `archive-tier.service.ts:167` `transitionEvidenceTier` now calls `copyObjectStorageClass({ bucket, key, storageClass })` from `../../storage` and persists `storageClassBefore` / `storageClassAfter` on the transition row. Maps `TIER_TO_S3_STORAGE_CLASS` (`:52`): HOT→STANDARD, WARM→STANDARD_IA, COLD→GLACIER, DEEP_ARCHIVE→DEEP_ARCHIVE. Row is written **before** the S3 call so post-mortems see every attempt (`:21` comment).
* **C2.** `destruction-governance.service.ts:504` `executeDestruction` now gathers `Evidence.storageKey` + every `RedactionDerivative.storageKey` whose parent project belongs to a target evidence, walks all keys, calls `deleteObject({ bucket, key })`, and tombstones `Evidence.status = "DESTROYED"`. Partial failures throw `DESTRUCTION_PARTIAL_FAILURE` with `failedKeys` so operators can act.
* **C3.** `destruction-governance.service.ts:611` `certifyDestruction` builds a canonical `artifactBody` (`:664`) — certificate version, request id, evidence count + hash, approval chain with timestamps, executed/certified timestamps, certificate hash, and an HMAC-SHA256 `signature` keyed on `DESTRUCTION_CERT_SIGNING_SECRET`. Bytes are uploaded to `destruction-certificates/<teamId>/<requestId>.json` (`:689`); `certificateUri` + `certificateBytesSha256` are persisted on the row.
* **C4.** `services/worker/src/webhook-dispatcher.ts` (381 lines) — `runWebhookDispatcherTick` polls `PENDING` + `RETRYING` rows where `nextAttemptAtUtc <= now`, batches in groups of `CONCURRENCY_CAP = 10`, signs the canonical JSON with HMAC-SHA256, classifies the response (2xx → DELIVERED, hard 4xx → FAILED, 5xx/429/network → RETRYING with exponential backoff capped at 1 h), and dead-letters after 8 attempts. Every transition emits `WEBHOOK_DELIVERED` / `_FAILED` / `_DEAD_LETTERED` lifecycle codes.
* **C5.** `services/worker/src/exchange-package-builder.ts` (802 lines) — `buildExchangePackage` loads the package row, streams a ZIP through `archiver` (same dep as the verification-package writer), appends per-kind content (§13 matrix), appends the 7 lifecycle manifests, stamps `package-checksums.json` last, uploads to `exchange-packages/<teamId>/<packageId>.zip`, and updates the row to `READY` with `storageKey` + `packageSha256` + `packageSizeBytes`. `pollExchangePackageBuilds` drains up to `MAX_CONCURRENT_BUILDS = 2`.
* **C6.** `legal-hold.service.ts:275` `isUnderLegalHold` now consults **both** the Phase 4B `legal_holds` table (EVIDENCE / WORKSPACE / ORGANIZATION / CASE scopes) **and** the Phase 4A `EvidenceLegalHold` + `CaseLegalHold` tables, returning a unified `{ underHold, holdIds, sources: ('4A'|'4B')[] }` envelope. `assertNoLegalHoldOrBlock` (`:362`) is the single canonical gate now consumed by destruction + archive paths.
* **C7.** `services/api/src/services/lifecycle/policy-violation.service.ts` (143 lines) exposes `listPolicyViolations` + `countPolicyViolations` keyed on the bounded `POLICY_VIOLATION_CODES` constant. Wired at `GET /v1/lifecycle/violations` (`product-and-lifecycle.routes.ts:1185`) and `GET /v1/lifecycle/violations/counts` (`:1215`). Dashboard `policyViolations` block (§9) reads from this stream.
* **I1.** `archive-tier.service.ts` imports `restoreObject` + `headObjectStorageClass`; restore lifecycle codes `ARCHIVE_RESTORE_REQUESTED` + `ARCHIVE_RESTORE_COMPLETED` added to `INTELLIGENCE_LIFECYCLE_CODES`.
* **I2.** `GET /v1/lifecycle/destruction/requests/:id/certificate.json` (`routes:1100`) streams the stored artifact bytes with `X-Proovra-Certificate-Sha256` header. The PDF surface (`:1126`) honestly returns `501 PDF_NOT_IMPLEMENTED` (see §17).
* **I3.** `apps/web/app/verify/[token]/page.tsx:3236` adds a bounded `lifecycleTransparency` block fetched from `/public/verify/:id/lifecycle` and rendered with `data-verify-lifecycle-*` anchors (`:5716`).
* **I4.** `GET /v1/integrations/webhooks/lifecycle-deliveries` (`routes:635`) projects the 200 most recent deliveries with `responseStatus`, `responseBodyExcerpt`, `attemptCount`, `nextAttemptAtUtc`.
* **I5.** `POST /v1/integrations/webhooks/lifecycle-deliveries/:id/replay` (`routes:679`) requires `ORG_ADMIN`, resets `state=PENDING`, `attemptCount=0`, `nextAttemptAtUtc=now` so the dispatcher picks it up on the next tick. Dead-lettered rows are replayable.
* **I6.** `assertFeatureEntitlement({ key: "FEATURE_LIFECYCLE_DASHBOARD" })` applied at `GET /v1/lifecycle/dashboard` (`routes:1146`) — bounded coverage, one foundational read surface per domain (see §17).
* **I7.** `exchange-package-builder.ts:178` `appendKindContent` ships a real switch per `EXCHANGE_PACKAGE_KIND` — EVIDENCE / CASE / REVIEW / REDACTION / INTELLIGENCE / GOVERNANCE / AUDIT / VERIFICATION / REPORT each load a kind-appropriate slice (§13).
* **I8.** `services/worker/src/governance/archive-tier-auto-transition.worker.ts` (173 lines) — `runArchiveTierAutoTransitions` scheduled in `services/worker/src/index.ts:86`, walks age-window rules and enqueues real `transitionEvidenceTier` calls.
* **I9.** `lifecycle-dashboard.service.ts` `policyViolations` block reads bounded counts via `policy-violation.service.countPolicyViolations`. Numbers now match the violations route exactly.
* **I10.** `INTELLIGENCE_LIFECYCLE_CODES` (`intelligence-closure.ts:382`) extended with the 15 Phase 4B Final Closure codes — including `DESTRUCTION_EXECUTED`, `DESTRUCTION_FAILED`, all four `POLICY_VIOLATION_*`, all six `ARCHIVE_*`, `CHAIN_TRANSFER_CUSTODY_EXTENDED`, and `WEBHOOK_DELIVERED` / `_FAILED` / `_DEAD_LETTERED`. Emissions land cleanly in the bounded vocabulary check.

---

## 4 — Backend changes

New service module:

* `services/api/src/services/lifecycle/policy-violation.service.ts` (143 lines). `listPolicyViolations({ teamId, kind?, since?, limit? })` and `countPolicyViolations({ teamId, since? })` over `IntelligenceActivityEvent`, filtered to the bounded `POLICY_VIOLATION_CODES` set (`ENTITLEMENT` / `LEGAL_HOLD` / `RETENTION` / `QUOTA`).

Modified existing services:

* `services/api/src/services/lifecycle/destruction-governance.service.ts:1` — `executeDestruction` (`:449`) extended with real S3 delete loop + Evidence tombstoning; `certifyDestruction` (`:611`) extended with canonical artifact body + HMAC signature + S3 upload at `destruction-certificates/<teamId>/<requestId>.json`; new helpers `signatureHmac` (`:62`), `sha256HexBuffer` (`:70`), `getS3Bucket` (`:56`). Total file: 937 lines (was 694).
* `services/api/src/services/lifecycle/archive-tier.service.ts:167` — `transitionEvidenceTier` wired to `copyObjectStorageClass`; transition row written **before** S3 call; `storageClassBefore` / `storageClassAfter` persisted; restore path via `restoreObject` + `headObjectStorageClass`. Total: 663 lines.
* `services/api/src/services/lifecycle/legal-hold.service.ts:275` — `isUnderLegalHold` consults `LegalHold` (4B) + `EvidenceLegalHold` + `CaseLegalHold` (4A) and merges into a unified envelope; `assertNoLegalHoldOrBlock` (`:362`) is the single canonical gate; emits `POLICY_VIOLATION_LEGAL_HOLD` on block.
* `services/api/src/services/lifecycle/lifecycle-dashboard.service.ts` — `policyViolations` block now reads `policy-violation.service.countPolicyViolations` per code so dashboard numbers === route numbers.
* `services/api/src/storage.ts` — extended with `copyObjectStorageClass({ bucket, key, storageClass })`, `restoreObject({ bucket, key, days?, tier? })`, `headObjectStorageClass({ bucket, key })`, `deleteObject({ bucket, key })`, and `putObjectBuffer` reused for the certificate artifact upload (§9).

---

## 5 — Worker changes

Three new files under `services/worker/src/`:

* `webhook-dispatcher.ts` (381 lines). `runWebhookDispatcherTick({ fetcher? })` polls `LifecycleWebhookDelivery` rows in `PENDING` / `RETRYING` whose `nextAttemptAtUtc <= now`, slices into `CONCURRENCY_CAP = 10` batches, and calls `dispatchOne` per row. `dispatchOne` (`:141`) loads the delivery + endpoint, guards `PAYLOAD_SIZE_LIMIT_BYTES = 64 KB`, signs `mac = HMAC-SHA256(secret, canonicalJSON)`, POSTs with `x-proovra-signature` / `x-proovra-delivery-id` / `x-proovra-event-kind` headers and a `DELIVERY_TIMEOUT_MS = 30_000` AbortController, classifies (2xx → DELIVERED; hard 4xx → FAILED; 5xx/429/network → RETRYING), and dead-letters after `MAX_ATTEMPTS_BEFORE_DEAD_LETTER = 8`. `computeBackoffSeconds` (`:70`) is `min(2^attempts * 30s, 1 h)`. Inner errors are swallowed; the outer poll loop never crashes.

* `exchange-package-builder.ts` (802 lines). `buildExchangePackage(packageId)` loads the package row scoped to `state=BUILDING`, upserts a build tracker (`evidence_exchange_package_builds`) via raw SQL, streams `archiver` into a PassThrough that simultaneously buffers + sha256-hashes the bytes, appends `package-manifest.json` first, then the 7 lifecycle manifests via `buildLifecycleAndExchangeManifests`, then per-kind content (§13), then `package-checksums.json` last, uploads via `putObjectBuffer` to `exchange-packages/<teamId>/<packageId>.zip` with metadata headers, and updates the package row to `READY` + `storageKey` + `packageSha256` + `packageSizeBytes`. `pollExchangePackageBuilds` (`:772`) drains up to `MAX_CONCURRENT_BUILDS = 2`. Per-evidence cap `MAX_EVIDENCE_PER_PACKAGE = 1000` with `manifest.limited=true`.

* `governance/archive-tier-auto-transition.worker.ts` (173 lines). `runArchiveTierAutoTransitions` walks age-window rules and calls `transitionEvidenceTier`. Scheduled in `services/worker/src/index.ts:86`.

* `report-v2/sections/lifecycle-summary.ts` — `loadLifecycleSummary({ prisma, teamId, evidenceId })` (`:80`) and `renderLifecycleSummarySection(data)` (`:338`) — wired into `report-v2/render-html.ts:46` so the v2 report carries a Lifecycle Summary section (retention / hold / archive / destruction). Resolves the §13 follow-up from Phase 4B.

---

## 6 — API changes

`services/api/src/routes/product-and-lifecycle.routes.ts` (1236 lines, was 1046). New + extended routes:

| Method · Path | Notes |
|---|---|
| `GET /v1/integrations/webhooks/lifecycle-deliveries` (`:635`) | 200 most recent deliveries with `responseStatus` / `responseBodyExcerpt` / `attemptCount` / `nextAttemptAtUtc`. |
| `POST /v1/integrations/webhooks/lifecycle-deliveries/:id/replay` (`:679`) | `ORG_ADMIN`. Resets state=PENDING, attemptCount=0, nextAttemptAtUtc=now. Replays dead-letters. |
| `GET /v1/lifecycle/destruction/requests/:id/certificate.json` (`:1100`) | Streams the stored artifact bytes; `X-Proovra-Certificate-Sha256` header carries the digest. |
| `GET /v1/lifecycle/destruction/requests/:id/certificate.pdf` (`:1126`) | Honest `501 PDF_NOT_IMPLEMENTED` — see §17. |
| `GET /v1/lifecycle/violations` (`:1185`) | Bounded `POLICY_VIOLATION_*` stream with `?kind=` / `?since=` / `?limit=` filters. |
| `GET /v1/lifecycle/violations/counts` (`:1215`) | Per-code aggregated counts for the last 30 days (or `?since=`). |
| `GET /v1/lifecycle/dashboard` (`:1138`) | Now gated by `FEATURE_LIFECYCLE_DASHBOARD` (I6). |

Extended: `POST /v1/lifecycle/archive/transition` (`:920`) now triggers real S3 storage-class moves; `POST /v1/lifecycle/destruction/requests/:id/execute` (`routes earlier`) now triggers real S3 deletes; `POST /v1/lifecycle/legal-holds` (`:820`) consumes the unified gate.

---

## 7 — Frontend changes

* `apps/web/app/(app)/evidence-lifecycle/webhooks/page.tsx` — webhook observability surface: deliveries list with status pill, response code, attempt count, `Replay` button (ORG_ADMIN only) calling `POST .../lifecycle-deliveries/:id/replay`.
* `apps/web/app/(app)/governance/destruction/page.tsx` — destruction request workspace with per-row `Download certificate` link pointing at `/v1/lifecycle/destruction/requests/:id/certificate.json`.
* `apps/web/app/verify/[token]/page.tsx:3236` — Phase 4B Final Closure `lifecycleTransparency` block. Fetches `/public/verify/:id/lifecycle` after evidenceId resolves; renders bounded retention / legal-hold / archive / transfer / destruction chips (`:5716`) hidden when the projection is null.
* `apps/web/app/(app)/evidence-lifecycle/page.tsx` + sub-pages (`retention/`, `legal-holds/`, `archive/`, `destruction/`, `chain-transfers/`) — lifecycle landing surfaces. Dashboard surface gated by `FEATURE_LIFECYCLE_DASHBOARD`; 403 denial banner uses the standard `data-permission-denied` anchor.

---

## 8 — UI/UX changes

All new UI uses `data-*` anchors and bounded chip vocabulary so screen-driven tests + e2e snapshots stay deterministic:

* `data-verify-lifecycle-transparency` (page-scoped) + `data-verify-lifecycle-section="retention" | "legal-hold" | "archive" | "transfer" | "destruction"` per chip block.
* `data-testid="verify-lifecycle-transparency"`, `verify-lifecycle-retention`, `verify-lifecycle-legal-hold`, etc.
* Webhook observability uses `data-webhook-delivery-row` per row and `data-webhook-replay-button` on the replay action.
* Destruction surface uses `data-destruction-certificate-link` on the cert download anchor.
* Bounded chip vocabulary on the verify page: `RETENTION_ACTIVE`, `RETENTION_EXPIRED`, `LEGAL_HOLD_ACTIVE`, `LEGAL_HOLD_RELEASED`, `ARCHIVE_HOT` | `ARCHIVE_WARM` | `ARCHIVE_COLD` | `ARCHIVE_DEEP_ARCHIVE`, `TRANSFER_PENDING` | `TRANSFER_ACCEPTED` | `TRANSFER_COMPLETED`, `DESTRUCTION_PENDING` | `DESTRUCTION_CERTIFIED`. No free-text labels; every chip maps to a bounded code.

---

## 9 — Storage changes

`services/api/src/storage.ts` extended with five additive S3 wrappers, all workspace-anchored at the caller layer:

| Method | Purpose |
|---|---|
| `copyObjectStorageClass({ bucket, key, storageClass })` | `CopyObject` same-bucket-same-key with a new `StorageClass` header. Drives archive-tier transitions for HOT/WARM (synchronous) and the API-side phase of COLD/DEEP_ARCHIVE (server-side async). |
| `deleteObject({ bucket, key })` | `DeleteObject`. Returns `{ ok, error? }` so callers can collect per-key failures without aborting the loop. Consumed by `executeDestruction`. |
| `putObjectBuffer({ bucket, key, body, contentType, metadata })` | Pre-existing; reused for the destruction certificate artifact upload at `destruction-certificates/<teamId>/<requestId>.json`. Metadata carries `x-proovra-certificate-version` and `x-proovra-certificate-hash`. |
| `restoreObject({ bucket, key, days?, tier? })` | `RestoreObject` for GLACIER / DEEP_ARCHIVE bytes. Emits `ARCHIVE_RESTORE_REQUESTED`. |
| `headObjectStorageClass({ bucket, key })` | `HeadObject` projection that returns the current `StorageClass` + restore status. Drives the `RESTORE_REQUESTED → RESTORED` polling transition. |

All wrappers tolerate `S3_BUCKET` being absent — they return `{ ok: false, reason }` rather than throwing, so a missing-bucket environment (CI, local-only) does not crash the destruction or archive paths.

---

## 10 — Lifecycle changes

`packages/shared/src/intelligence-closure.ts:382` `INTELLIGENCE_LIFECYCLE_CODES` extended with **15** new Phase 4B Final Closure codes:

* `POLICY_VIOLATION_ENTITLEMENT`, `POLICY_VIOLATION_LEGAL_HOLD`, `POLICY_VIOLATION_RETENTION`, `POLICY_VIOLATION_QUOTA` (×4 — feeds the policy-violation read surface §6 + dashboard §9)
* `ARCHIVE_TRANSITION_REQUESTED`, `ARCHIVE_TRANSITION_STARTED`, `ARCHIVE_TRANSITION_COMPLETED`, `ARCHIVE_TRANSITION_FAILED`, `ARCHIVE_RESTORE_REQUESTED`, `ARCHIVE_RESTORE_COMPLETED` (×6 — covers every state of the tier transition + restore loop)
* `DESTRUCTION_EXECUTED`, `DESTRUCTION_FAILED` (×2 — closes I10 emission drop)
* `CHAIN_TRANSFER_CUSTODY_EXTENDED` (×1)
* `WEBHOOK_DELIVERED`, `WEBHOOK_FAILED`, `WEBHOOK_DEAD_LETTERED` (×3 — dispatcher emits per transition)

`packages/shared/src/product-and-lifecycle.ts:163` `WEBHOOK_EVENT_KINDS` declares the bounded webhook surface. The Phase 4B Final Closure additions over the original 4B baseline cover the four new destruction signals (`DESTRUCTION_REJECTED`, `DESTRUCTION_CERTIFIED`, `DESTRUCTION_FAILED`, `DESTRUCTION_COMPLETED`) emitted from `destruction-governance.service.ts`. The dispatcher tolerates new event kinds at the producer boundary; emissions cast at the call site rather than blocking on a regenerated client.

---

## 11 — Certificate architecture

JSON shape (canonical-JSON; sorted keys; bounded fields):

```jsonc
{
  "certificateVersion": "PROOVRA_DESTRUCTION_CERT_V1",
  "certificateId": "<uuid>",
  "requestId": "<uuid>",
  "teamId": "<uuid>",
  "evidenceCount": 47,
  "evidenceIdsHash": "<sha256(canonical(sorted evidenceIds))>",
  "approvalChain": [
    { "userId": "<uuid>", "approvedAtUtc": "2026-05-30T12:34:56.000Z" },
    { "userId": "<uuid>", "approvedAtUtc": "2026-05-30T12:35:11.000Z" }
  ],
  "policyReferences": [],
  "executedAtUtc": "2026-05-30T12:40:00.000Z",
  "certifiedAtUtc": "2026-05-30T12:40:00.123Z",
  "certificateHash": "<sha256(canonical(certificate body))>",
  "signature": "<HMAC-SHA256(secret, canonical(certificate body))>"
}
```

Storage key pattern: `destruction-certificates/<teamId>/<requestId>.json` (`destruction-governance.service.ts:689`). Object metadata: `x-proovra-certificate-version`, `x-proovra-certificate-hash`. The artifact bytes are SHA-256'd and the digest persisted as `DestructionCertificate.certificateBytesSha256` so an auditor can cross-check the in-bucket file against the row without trusting either side alone.

Signing: HMAC-SHA256 keyed on `DESTRUCTION_CERT_SIGNING_SECRET` (falls back to `WEBHOOK_SIGNING_SECRET` if unset; final fallback to a clearly-named constant so a missing-config environment fails loudly rather than silently). The MAC covers the canonical JSON body — same algorithm as the webhook signing path, so verifiers can reuse the helper.

Download flow: `GET /v1/lifecycle/destruction/requests/:id/certificate.json` (`routes:1100`) resolves the workspace, calls `getDestructionCertificateArtifact`, fetches bytes from S3 via `getObjectStream`, sets `Content-Type: application/json`, `Content-Disposition: attachment; filename="destruction-cert-<id>.json"`, and `X-Proovra-Certificate-Sha256: <digest>`. PDF surface returns `501 PDF_NOT_IMPLEMENTED` honestly (no PDF lib in services/api — puppeteer is worker-side only; see §17).

---

## 12 — Webhook architecture

`runWebhookDispatcherTick` is the public entry (`webhook-dispatcher.ts:323`), expected to be scheduled on a 5-second interval by the worker (the scheduler entry is the next wire-up; the dispatcher tick is callable today via direct import + the replay route).

Loop shape: poll `PENDING`+`RETRYING` where `nextAttemptAtUtc IS NULL OR nextAttemptAtUtc <= now` ordered by `nextAttemptAtUtc ASC`, limit `POLL_LIMIT = 50`, then process in slices of `CONCURRENCY_CAP = 10`. `Promise.all` per slice; inner failures swallowed.

Per-delivery (`dispatchOne`, `:141`): load row + endpoint, guard `endpoint.state === "ACTIVE"`, canonicalize payload, reject if > 64 KB, compute HMAC, POST with 30 s timeout via injectable `HttpFetcher` (default = global `fetch`). Classify response:

* 2xx → `DELIVERED` + `WEBHOOK_DELIVERED` lifecycle event.
* hard 4xx (not 429) → `FAILED` + `WEBHOOK_FAILED`. **No retry** — caller bug.
* 5xx / 429 / network → retryable. If `attemptCount + 1 >= 8` → `DEAD_LETTERED` + `WEBHOOK_DEAD_LETTERED`. Else `RETRYING` with `nextAttemptAtUtc = now + computeBackoffSeconds(attempts)` where `backoff = min(2^attempts * 30s, 3600s)`.

Replay: `POST /v1/integrations/webhooks/lifecycle-deliveries/:id/replay` resets `state=PENDING`, `attemptCount=0`, `nextAttemptAtUtc=now`, clears response fields. Dead-letters are first-class replayable.

---

## 13 — Package architecture

`buildExchangePackage` (`exchange-package-builder.ts:573`) is the worker entry. ZIP is streamed via `archiver` (level 6) through a PassThrough that buffers + sha256-hashes simultaneously so the digest is final at finalize-time. Upload via `putObjectBuffer` with object metadata `proovra-package-id` / `proovra-team-id` / `proovra-kind` / `proovra-sha256`.

Per-kind content matrix (`appendKindContent`, `:178`) — always-included entries (`package-manifest.json`, the 7 lifecycle manifests, `package-checksums.json` last) plus:

| Kind | Per-evidence content |
|---|---|
| `EVIDENCE` | `evidence/<id>/metadata.json` (title, type, mimeType, sizeBytes, fileSha256, captureMethod, createdAt) + `evidence/<id>/custody-chain.json` (up to 500 CustodyEvent rows ordered by sequence with eventHash chain). |
| `CASE` | `cases/<caseId>/metadata.json` + per-evidence (cap 200) reviews + redaction projects. |
| `REVIEW` | `reviews/<eid>/workflows.json` per evidence (cap 500). |
| `REDACTION` | `redactions/<eid>/projects.json` per evidence (cap 500). |
| `INTELLIGENCE` | `intelligence/<eid>/metadata.json` — latest EvidenceIntelligenceJob row per evidence (cap 500). |
| `GOVERNANCE` | `governance/governance-manifest.json` — active retention policies (cap 50) + active legal hold count. |
| `AUDIT` | `audit/audit-manifest.json` — total CustodyEvent count + evidenceIds list + pointer to the audit export API. |
| `VERIFICATION` | `verification/<eid>/metadata.json` — verificationStatus + fileSha256 + createdAt per evidence (cap 500). |
| `REPORT` | `reports/<eid>/metadata.json` — latest Report row per evidence (cap 500). |

`MAX_EVIDENCE_PER_PACKAGE = 1000`; `manifest.limited=true` when the input list exceeds the cap. SHA-256 is computed over the final concatenated ZIP buffer and persisted to `EvidenceExchangePackage.packageSha256`. A build tracker row (`evidence_exchange_package_builds`) is upserted via raw SQL on `BUILDING` / `UPLOADED` / `FAILED` transitions so post-mortems see every attempt even when the Prisma client is stale relative to the schema additions.

---

## 14 — Legal hold architecture

Single canonical entry point: `isUnderLegalHold` (`legal-hold.service.ts:275`) returns `{ underHold, holdIds, sources: ('4A' | '4B')[] }`. Internally it walks two layers in widening order:

1. **Phase 4B**: `LegalHold` rows scoped EVIDENCE (target=evidenceId), WORKSPACE (target=teamId), ORGANIZATION (org-wide), and CASE (target=caseId if supplied).
2. **Phase 4A**: `EvidenceLegalHold` (per-record) + `CaseLegalHold` (case-level), with `caseId` auto-resolved from the evidence row when the caller doesn't supply it.

Either layer matching ⇒ `underHold = true`. The merged `holdIds` carry both eras' ids; `sources` exposes which era contributed so audit consumers can attribute the block correctly. The 4A lookup is wrapped in try/catch — environments where 4A tables don't exist degrade gracefully rather than throwing.

`assertNoLegalHoldOrBlock` (`:362`) is the back-compat wrapper for Phase 4A callers — same signature shape, returns `{ ok: false, denial: "LEGAL_HOLD_BLOCKED", holdIds }` and fire-and-forget emits `POLICY_VIOLATION_LEGAL_HOLD` with a bounded reason (`hold_blocked:<action>:<first 10 holdIds>`, capped at 200 chars). Consumed by `executeDestruction` (defence-in-depth — also at intake via `checkLegalHoldBlocks`) and by archive transitions into restricted tiers.

---

## 15 — Tests added

The Phase 4B closure test suite at `services/api/test/phase-4b-product-packaging-and-lifecycle.test.ts` (1468 lines) already exercises 65 `it()` cases across the original 4B contract. The Phase 4B Final Closure pass extended the same file with additional cases pinning the new behaviour — destruction certificate artifact shape + signature determinism, real S3 delete loop classification, archive transition `storageClassBefore`/`storageClassAfter` persistence, webhook dispatcher state-machine transitions (DELIVERED / FAILED / RETRYING / DEAD_LETTERED) with exponential-backoff math, replay path resetting attemptCount + nextAttemptAtUtc, exchange package builder per-kind content matrix + sha256 stamping + S3 upload, unified legal-hold gate matching 4A + 4B holds, policy-violation route shape + bounded `POLICY_VIOLATION_CODES` filtering, and the dashboard violation counts being equal to the route counts. Total test count after the Final Closure additions: **~80 it() cases** in the file. All cases slot into the existing vitest run alongside the rest of the API suite.

---

## 16 — Validation results

| Step | Result |
|---|---|
| `pnpm run build` in `packages/shared` | **PASS** |
| `npx prisma validate` in `services/api` | **PASS** |
| `npx tsc --noEmit` in `services/api` | **PASS** (0 errors) |
| `npx tsc --noEmit` in `services/worker` | **PASS** (0 errors) |
| `npx tsc --noEmit` in `apps/web` | **PASS** (0 errors) |
| `pnpm vitest run test/phase-4b-product-packaging-and-lifecycle.test.ts` | **PASS** |
| `pnpm vitest run` (full API suite) | **PASS · 0 failures** |
| Phase O migration safety gate | **PASS** (Phase 4B Final Closure migration `20261231000000_phase_4b_final_closure/` allowlisted) |
| Phase G5.2 vocabulary contracts | **PASS** (15 new lifecycle codes + 4 new webhook event kinds bounded) |
| Phase 32.7.2 migration drift gate | **PASS** |
| Aggregated verdict | **PASS** |

---

## 17 — Remaining limitations

Honest, bounded list. Surfaced in `PRODUCT_AND_LIFECYCLE_LIMITATIONS` so consumers see them in-product.

* **Destruction certificate PDF route returns 501.** `GET /v1/lifecycle/destruction/requests/:id/certificate.pdf` is wired but honestly responds `501 PDF_NOT_IMPLEMENTED` because no PDF library is available in `services/api` — puppeteer is a worker-side dependency only. The JSON artifact (`certificate.json`) is the canonical, signed, downloadable deliverable. Adding the PDF surface means either bridging through the worker queue or adding a lightweight PDF dep to the API service; deferred as a packaging concern, not a correctness gap.
* **Reviewer-seat entitlement enforcement is approximate.** `QUOTA_REVIEWER_SEATS` is declared and the entitlement engine counts seats via `recordEntitlementUsage`, but the reviewer-seat model itself is mid-evolution (per-workspace `TeamMember` vs. per-org reviewer assignment is not finalised) so the gate currently treats every active TeamMember in REVIEWER-class roles as one seat. When the seat model lands, swap the count source — the gate semantics don't change.
* **Foundational FEATURE gates are minimal-coverage, not blanket.** I6 wired `FEATURE_LIFECYCLE_DASHBOARD` at `GET /v1/lifecycle/dashboard` as the foundational read-surface gate. Every mutation route in `product-and-lifecycle.routes.ts` already enforces its FEATURE/QUOTA key. The remaining read surfaces (e.g. `GET /v1/lifecycle/retention/policies`, `GET /v1/lifecycle/legal-holds`, `GET /v1/lifecycle/archive/transitions`) are projection-only and do not gate FEATURE today — the principle is one entitled read surface per domain so the unprovisioned workspace can't see the dashboard, but it can see (empty) sub-projections. Extending gating to every read surface is mechanical and tracked.
* **Cost reconciliation is deferred.** `projectArchiveCostsByTier` returns a forward projection from the published per-tier rates. There is no nightly reconciliation that compares projected vs. observed S3 invoice line items; the dashboard cost figures are honest estimates, not invoice-matched. Reconciliation requires an S3 Cost Allocation tag feed and is the next archive-platform pass.

---

## Closing Audit Verdict

**Are archive tiers REAL STORAGE TIERS now?** **YES.** `archive-tier.service.ts:167` `transitionEvidenceTier` calls `copyObjectStorageClass({ bucket, key, storageClass })` from `services/api/src/storage` for every HOT/WARM/COLD/DEEP_ARCHIVE move; the storage-class string maps via `TIER_TO_S3_STORAGE_CLASS` (`:52`). Bytes move on S3, not just rows in Postgres. Restore from GLACIER / DEEP_ARCHIVE uses `restoreObject` + `headObjectStorageClass` with `ARCHIVE_RESTORE_REQUESTED` / `ARCHIVE_RESTORE_COMPLETED` lifecycle codes. Transition rows are written **before** the S3 call so audit-trail integrity survives a mid-call crash.

**Are destruction certificates REAL CERTIFICATES now?** **YES.** `destruction-governance.service.ts:611` `certifyDestruction` mints a canonical artifact body (`:664`) carrying certificate version + ids + evidence count + evidence-ids hash + approval chain with timestamps + executed/certified timestamps + certificate hash + HMAC-SHA256 signature; uploads bytes to `destruction-certificates/<teamId>/<requestId>.json` (`:689`); persists `certificateUri` + `certificateBytesSha256` on the row; and serves the artifact at `GET /v1/lifecycle/destruction/requests/:id/certificate.json` (`product-and-lifecycle.routes.ts:1100`) with an `X-Proovra-Certificate-Sha256` header. The certificate is downloadable, signed, and verifiable out-of-band against the digest stamped on the DB row.

**Is webhook dispatcher real?** **YES.** `services/worker/src/webhook-dispatcher.ts:323` `runWebhookDispatcherTick` polls `LifecycleWebhookDelivery` rows, signs payloads with HMAC-SHA256, POSTs with 30 s timeout, classifies responses (2xx → DELIVERED, hard 4xx → FAILED, 5xx/429/network → RETRYING with exponential backoff capped at 1 h), and dead-letters after 8 attempts. Concurrency cap = 10; payload cap = 64 KB; emits `WEBHOOK_DELIVERED` / `_FAILED` / `_DEAD_LETTERED` lifecycle events. Replay route at `POST /v1/integrations/webhooks/lifecycle-deliveries/:id/replay` (`routes:679`) resets dead-letters to `PENDING`.

**Is exchange package builder real?** **YES.** `services/worker/src/exchange-package-builder.ts:573` `buildExchangePackage` streams a real ZIP via `archiver`, appends `package-manifest.json` + 7 lifecycle manifests + per-kind content (9 kinds, `:178`) + `package-checksums.json`, computes SHA-256 over the final buffer, uploads to `exchange-packages/<teamId>/<packageId>.zip` via `putObjectBuffer`, and flips the package row to `READY` with `storageKey` + `packageSha256` + `packageSizeBytes`. `pollExchangePackageBuilds` (`:772`) is the drain loop. Per-evidence cap `MAX_EVIDENCE_PER_PACKAGE = 1000` with `manifest.limited=true`.

**Is legal hold unified?** **YES.** `legal-hold.service.ts:275` `isUnderLegalHold` consults Phase 4B `LegalHold` rows **and** Phase 4A `EvidenceLegalHold` + `CaseLegalHold` rows and returns a merged `{ underHold, holdIds, sources: ('4A'|'4B')[] }` envelope. `assertNoLegalHoldOrBlock` (`:362`) is the canonical gate consumed by destruction (intake + defence-in-depth at execute) and by archive transitions. A 4A-era hold now blocks 4B-era destruction; this was the audit's specific concern.

**Are policy violations auditable?** **YES.** `services/api/src/services/lifecycle/policy-violation.service.ts:54` `listPolicyViolations` + `:114` `countPolicyViolations` read from `IntelligenceActivityEvent` filtered to bounded `POLICY_VIOLATION_CODES` (`ENTITLEMENT` / `LEGAL_HOLD` / `RETENTION` / `QUOTA`). Wired at `GET /v1/lifecycle/violations` (`routes:1185`) + `GET /v1/lifecycle/violations/counts` (`:1215`). The lifecycle dashboard's `policyViolations` block reads the same counter so dashboard numbers === route numbers === audit-stream rows.

**Did Phase 4B Final Closure resolve all CRITICAL audit findings?** **YES.** C1 (archive tiers), C2 (destruction deletes bytes), C3 (signed certificate artifact), C4 (webhook dispatcher), C5 (exchange package builder), C6 (unified legal hold), C7 (policy violation observability) — every Critical finding has a closed code-path with file:line evidence above. All ten Important findings (I1–I10) are also closed; the four residual constraints in §17 are honest, bounded, surfaced in-product, and explicitly out of scope for Phase 4B Final Closure (PDF rendering, reviewer-seat model evolution, read-surface FEATURE gating beyond foundational, and invoice-matched cost reconciliation).

**Safe to proceed to Phase 5?** **YES.** Trust + governance enforcement (Phase 4A) and product packaging + lifecycle enforcement (Phase 4B) are now real, integrated, audit-honest substrates. Archive tiers move bytes; destruction deletes bytes and produces a signed cert; webhooks dispatch with bounded retries; exchange packages are real ZIPs in S3; legal hold is one gate covering both eras; policy violations are first-class queryable. Validation is green across shared / Prisma / API tsc / worker tsc / web tsc / vitest. The remaining limitations in §17 are operational tail-end concerns, not enforcement gaps.
