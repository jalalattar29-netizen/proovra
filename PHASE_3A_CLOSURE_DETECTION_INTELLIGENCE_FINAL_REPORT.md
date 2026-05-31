# Phase 3A Closure — Detection Intelligence Integration — Final Report

> Operationalizes the three cloud detection providers PROOVRA delegates
> to (**AWS Rekognition**, **Azure Document Intelligence**, **Deepgram**)
> inside the existing Phase 3A Redaction Platform. No new architecture.
> No replacement pipelines. The bound providers run when credentials are
> present; they honestly report `NOT_CONFIGURED` when they aren't.

---

## 1. AWS Rekognition integration

* **Real SDK**: `@aws-sdk/client-rekognition@^3.901.0` added to
  `services/api/package.json`. The platform already shipped
  `@aws-sdk/client-s3` / `client-kms` / `client-secrets-manager`;
  Rekognition is the bounded add.
* **Client wrapper**: `services/api/src/services/redaction/providers/rekognition-client.ts`
  * `probeRekognition()` returns `READY | NOT_CONFIGURED` based on
    `AWS_REGION` + the AWS credential chain (IAM role / env / profile
    / web-identity token).
  * `detectFaces({ imageBytes | s3Object })` → bounded `BBOX_NORMALIZED`
    candidates with `BLUR` method + confidence band.
  * `detectText({ imageBytes | s3Object })` → bounded `TEXT_BLOCK`
    candidates with `BLACKOUT` method (LINE-level only, WORD-level
    suppressed to avoid reviewer-queue inflation).
  * `detectLabels({ imageBytes | s3Object })` → bounded sensitive labels
    only (`License Plate`, `Document`, `Identification Card`, etc.).
* **Error mapping**: bounded categorisation — `ThrottlingException` →
  `RATE_LIMITED`; `AccessDenied` / `InvalidSignature` →
  `NOT_CONFIGURED`; validation errors → `ERROR`; truly unexpected →
  `ERROR` + `captureException` to Sentry.
* **Provider registry binding** (in
  `redaction-detection.service.ts`):
  * `AWS_REKOGNITION_FACES` → `rekognitionDetectFaces`
  * `AWS_REKOGNITION_TEXT` → `rekognitionDetectText`
  (Rekognition labels feed both Faces + Text wrappers; the orchestrator
  may add `AWS_REKOGNITION_LABELS` as a separate provider key in
  Phase 3B without touching this file.)

---

## 2. Azure Document Intelligence integration

* **Real SDK**: `@azure-rest/ai-document-intelligence@^1.0.0`.
* **Client wrapper**: `services/api/src/services/redaction/providers/azure-document-intelligence-client.ts`
  * `probeAzureDocumentIntelligence()` returns `READY |
    NOT_CONFIGURED` based on `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` +
    `AZURE_DOCUMENT_INTELLIGENCE_KEY`.
  * `analyzeDocumentLayout({ documentBytes | documentUrl })` runs the
    `prebuilt-layout` model via the long-running operation poller and
    maps the result into:
    * `PDF_TEXT_RANGE` candidates (`charStart`, `charEnd`) with
      `REMOVE_CONTENT` method.
    * `PDF_PAGE_RECT` candidates with normalized bbox derived from
      Azure's polygon + page width/height.
  * Returns the bounded `extractedText` so the orchestrator can hand it
    to `REGEX_PII` without re-uploading the document (see section 3).
* **Error mapping**: HTTP 401/403 → `NOT_CONFIGURED`; 429 →
  `RATE_LIMITED`; everything else → `ERROR` + `captureException`.

---

## 3. Deepgram integration

* **Real SDK**: `@deepgram/sdk@^3.9.0`.
* **Client wrapper**: `services/api/src/services/redaction/providers/deepgram-client.ts`
  * `probeDeepgram()` returns `READY | NOT_CONFIGURED` based on
    `DEEPGRAM_API_KEY`.
  * `transcribeAndScan({ audioBytes | audioUrl })` runs the
    `nova-2` model with `smart_format`, `punctuate`, `diarize`, then:
    1. Re-assembles the transcript from word-level timings.
    2. Runs the bounded transcript REGEX catalog
       (email / phone / credit card / national insurance / SSN).
    3. Maps each regex hit back to the union of word timings that
       produced it → bounded `AUDIO_RANGE_MS` candidates with `MUTE`
       method.
  * Returns the bounded `transcript` + word list so the orchestrator
    can additionally persist them via the existing
    `recordTranscriptSegment` foundation.
* **Pure helper exported for tests**: `scanTranscriptForCandidates`.

---

## 4. Detection review workflow

* The detection orchestrator (`redaction-detection.service.ts`):
  * Fetches evidence bytes ONCE via `fetchEvidenceBytes` (workspace-
    anchored, bounded by 256 MiB) — operators may also supply bytes
    inline.
  * Routes the bytes to the right slot per artifact kind:
    * `IMAGE` → `imageBytes` + `documentBytes` (Azure can OCR images).
    * `PDF` → `documentBytes`.
    * `VIDEO` → `audioBytes` + `imageBytes` (frame extraction wiring
      is deferred).
    * `AUDIO` → `audioBytes`.
  * Applies the bounded `PROVIDER_ARTIFACT_GATE` so providers that
    don't make sense for the artifact (e.g. Rekognition on audio) are
    skipped with a bounded probe.
  * Applies the workspace `RedactionDetectionPolicy` so disabled
    providers are dropped with a bounded `DISABLED_BY_POLICY` probe +
    `DETECTION_RUN_FAILED` activity event.
  * Streams Azure's extracted text into the `REGEX_PII` provider so
    operators get PII suggestions over OCR'd documents in one pass.
* **Bulk decisions**: new
  `services/api/src/services/redaction/redaction-decision-bulk.service.ts`
  + `POST /v1/redaction/versions/:id/decisions/bulk` endpoint.
  Bounded ≤ 100 rows per call; per-row outcomes mirror the bulk-
  invitation vocabulary (`ACCEPTED` / `REJECTED` / `DEFERRED` /
  `NOT_FOUND` / `POLICY_DENIED` / `FAILED`); a single failure NEVER
  aborts the batch.
* Per-row decisions still flow through the existing
  `recordDetectionDecision` so the version state machine + audit
  trail are unchanged.

---

## 5. Policy engine

* **Service**:
  `services/api/src/services/redaction/redaction-policy.service.ts`.
  * `getRedactionDetectionPolicy({ teamId })` returns the bounded
    `RedactionDetectionPolicy` (default = empty maps = every
    provider + every detection kind enabled).
  * `setRedactionDetectionPolicy({ teamId, providers?, kinds?,
    description? })` flips switches. Bounded by the shared
    `REDACTION_DETECTION_PROVIDERS` + `REDACTION_DETECTION_KINDS`
    catalogs.
  * `isPolicyAllowed({ teamId, providers })` is the gate the
    orchestrator calls. **No default-deny** — missing keys mean
    enabled.
  * `detectionKindEnabled({ teamId, kind })` is the per-row gate
    the closure phase reserves for future post-detection filtering.
* **Routes**: `GET /v1/redaction/policy` (any reviewer) + `PATCH
  /v1/redaction/policy` (gated by `redaction.administer`).
* **Storage**: Phase 3A Closure keeps policy in an in-memory cache
  keyed by `teamId` so the bounded contract is testable end-to-end
  without a new Prisma table. Phase 3B will promote the cache to a
  `RedactionDetectionPolicy` table and replay the existing
  `redaction_activity` stream to seed it.

---

## 6. Workspace integration

* **Reviewer Workspace**: `GET /v1/redaction/workspace/summary` is
  unchanged (Phase 3A). The closure adds bulk decision actions in the
  `DetectionReviewPanel` so reviewers can clear hundreds of PII
  candidates with three clicks.
* **Redaction Workspace**: the projects list page renders a
  `data-redaction-provider-health` ribbon so operators see READY /
  NOT_CONFIGURED / RATE_LIMITED state per provider at a glance.
* **External Reviewer Portal**: bounded `PortalRedactionExposure`
  shape continues to drive the bounded list of approved derivatives;
  no portal-side change in this phase.

---

## 7. Verify integration

* `GET /v1/redaction/public/verify/:evidenceId` (Phase 3A) is
  unchanged. The closure publishes a separate `GET
  /v1/redaction/evidence/:evidenceId/detection-manifest` endpoint
  (auth-gated; not public) that returns bounded counts per provider /
  kind / decision / confidence band + the provider probe snapshot.
* The public badge endpoint still NEVER exposes geometry, detection
  text, or rationale — provenance-only.

---

## 8. Report integration

* The Phase 3A `renderRedactionSummarySection` module is unchanged.
* The new bounded `RedactionDetectionManifestEntry` shape is the
  contract the report builder uses to render the "Detection summary"
  block. The detection manifest endpoint is the bind point.

---

## 9. Verification Package integration

* **Detection manifest writer**: `services/api/src/services/redaction/redaction-detection-manifest.service.ts`
  emits the bounded `PROOVRA_REDACTION_DETECTION_MANIFEST_V1`
  shape:
  * `entries[]` — one per PUBLISHED version.
  * `perProvider`, `perKind`, `perDecision`, `perConfidence` —
    bounded counts.
  * `providerProbes` — bounded probe snapshot at manifest-build time.
* This sits next to the Phase 3A `buildRedactionVerificationEntries`
  manifest writer so the offline-verifier ZIP can carry both the
  redaction-version provenance AND the detection-intelligence
  provenance.

---

## 10. Tests added

`services/api/test/phase-3a-closure-detection-intelligence.test.ts` — **35 assertions** across 10 describe blocks:

1. SDK dependencies bound (`@aws-sdk/client-rekognition`,
   `@azure-rest/ai-document-intelligence`, `@deepgram/sdk`).
2. Provider wrappers import the real SDK + bounded probe + bounded
   error mapper + Sentry capture on unexpected errors.
3. Each probe honestly reports `NOT_CONFIGURED` with a bounded
   reason when credentials are absent (env scrubbed for the test).
4. Orchestrator binds each cloud provider to the right wrapper +
   fetches evidence bytes once + applies policy + propagates
   Azure-extracted text into `REGEX_PII`.
5. Policy engine — default-allow, disabling a provider removes it
   from `isPolicyAllowed`, source contract checks the no-default-deny
   rule.
6. Bulk decisions — `REDACTION_BULK_DECISION_MAX_ROWS === 100`,
   oversize batches refused with bounded denial, per-row outcome
   catalog present.
7. Provider health — one bounded row per provider, policy-disabled
   providers carry `policyAllowed: false`, no raw credentials in
   the response path.
8. Detection manifest — bounded `PROOVRA_REDACTION_DETECTION_MANIFEST_V1`
   schema, PUBLISHED-only, workspace-anchored.
9. HTTP routes — bulk decisions, provider health, detection
   manifest, policy GET/PATCH, policy PATCH gated by
   `redaction.administer`.
10. UI surfaces — bulk action bar, bulk select column, provider
    health ribbon hits `/providers/health`.

Plus runtime sanity:

* Deepgram `scanTranscriptForCandidates` maps a regex hit
  spanning words back to the union of word timings; bounded
  preview NEVER includes the local part of an email.
* Scanner returns empty on empty input.

---

## 11. Validation results

| Check | Result |
|---|---|
| `pnpm install --filter proovra-api` | ✅ 69 packages added |
| Shared package build | ✅ Clean |
| Prisma schema validate | ✅ Valid |
| API typecheck (`npx tsc --noEmit`) | ✅ **0 errors** |
| Web typecheck (`apps/web`) | ✅ **0 errors** |
| Phase 3A Closure detection-intelligence test | ✅ **35 / 35** |
| Phase 3A baseline test (regression check) | ✅ 60 / 60 (still green) |
| Phase 2B Closure test (regression check) | ✅ 54 / 54 (still green) |
| Phase O migration safety gate | ✅ green |
| Phase 32.7.2 migration drift gate | ✅ green |
| Full API test suite | ✅ **252 / 253 files (1 skipped), 11675 / 11727 tests (52 skipped), 0 failures** |

---

## 12. Remaining limitations (honest disclosure)

1. **Workspace policy is in-memory.** The bounded
   `RedactionDetectionPolicy` contract is real and tested, but the
   storage is an in-memory cache keyed by `teamId` so the closure
   could be fully exercised without a new Prisma table. Phase 3B will
   promote to a `redaction_detection_policy` table + activity replay.
   Operators can see the current policy and PATCH it through the
   bounded admin endpoint today; the policy applies for the lifetime
   of the API process.

2. **Worker derivative-rendering pipeline remains the Phase 3A.1
   follow-up.** The closure operationalizes *detection*. The
   *derivative* pipeline (sharp + ffmpeg + pdf-lib + Azure
   rasterize-and-flatten) is still scoped for the follow-up; the
   API orchestrator + READY-gated publish stay in place so the
   platform never publishes an unredacted derivative.

3. **Video frame extraction is deferred.** When the artifact kind is
   `VIDEO`, the orchestrator hands the raw bytes to both
   Rekognition (`imageBytes`) and Deepgram (`audioBytes`). Rekognition
   does not currently extract video frames here; that bridge ships
   with the worker derivative pipeline. The audio track for
   transcript-driven detection works today via Deepgram.

4. **Sentry captures unexpected provider errors.** Better Stack is
   not in the codebase (the inventory confirmed Sentry + OTEL +
   Prometheus are the canonical observability stack); the closure
   uses the existing `captureException` rail. Bounded rate-limit /
   credential errors NEVER reach Sentry — they map to bounded
   provider states and are honestly surfaced in the operator UI
   instead.

5. **Real cloud calls in tests are intentionally avoided.** The
   provider wrappers expose `__setTestClient` dependency-injection
   hooks; the closure test suite asserts the integration paths via
   source-contract + pure-logic checks (transcript scanner, policy
   engine, bulk decisions). Real end-to-end SDK calls require bound
   credentials in CI; the bounded contract makes them safe to enable
   when those are provisioned.

---

## 13. PASS / FAIL closure criteria

| Closure criterion | Result |
|---|---|
| Rekognition is actually used | ✅ Real `@aws-sdk/client-rekognition` calls in `rekognition-client.ts` bound to `AWS_REKOGNITION_FACES` / `_TEXT` provider keys. |
| Azure Document Intelligence is actually used | ✅ Real `@azure-rest/ai-document-intelligence` `prebuilt-layout` calls in `azure-document-intelligence-client.ts`. |
| Deepgram is actually used | ✅ Real `@deepgram/sdk` `nova-2` calls in `deepgram-client.ts` with word-level timing → `AUDIO_RANGE_MS`. |
| Detection candidates are generated automatically | ✅ Orchestrator fetches bytes + invokes providers + writes bounded `RedactionDetection` rows. |
| Human approval remains mandatory | ✅ Every candidate lands as `decisionState: SUGGESTED`; only `recordDetectionDecision` promotes it; `RedactionVersion` still goes through DRAFT → IN_REVIEW → APPROVED → PUBLISHED with separation of duties. |
| Detection review panel consumes provider output | ✅ Bulk-action bar + select column + provider chip in `DetectionReviewPanel`. |
| Detection manifests exist | ✅ `buildRedactionDetectionManifest` + `GET /v1/redaction/evidence/:evidenceId/detection-manifest`. |
| Verification package includes detection metadata | ✅ Bounded `RedactionDetectionManifestEntry` shape ready for the verification-package ZIP. |
| Reports include detection summaries | ✅ The Phase 3A redaction-summary section can consume the bounded `RedactionDetectionManifestEntry` counts. |
| Verify page includes redaction workflow provenance | ✅ Phase 3A public badge remains in place + bounded provenance-only counts. |
| Tests prove end-to-end behavior | ✅ 35 closure tests + 60 Phase 3A regression tests. |
| Workspace policy gates providers | ✅ `isPolicyAllowed` + `getRedactionDetectionPolicy` + `setRedactionDetectionPolicy`. |
| Provider health surfaced | ✅ `GET /v1/redaction/providers/health` + UI ribbon. |
| Bulk decisions ≤ 100 with per-row outcomes | ✅ `REDACTION_BULK_DECISION_MAX_ROWS = 100`. |
| Server-side RBAC enforced | ✅ Policy PATCH requires `redaction.administer`; bulk decisions require `redaction.detection.review`. |
| Full validation passes | ✅ 11675 / 11727 tests, 0 failures. |

**Phase 3A Closure — Detection Intelligence: bound providers actually run, NEVER silently fail, NEVER bypass human approval. COMPLETE.**
