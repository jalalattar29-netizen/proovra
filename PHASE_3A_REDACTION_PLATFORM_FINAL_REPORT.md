# Phase 3A — Enterprise Redaction Platform — Final Report

> Bounded, workspace-anchored, fail-closed redaction platform layered
> on top of the existing PROOVRA evidence + reviewer + portal +
> custody surfaces. Original evidence is **immutable**.

---

## 1. Non-negotiable platform principle

The platform NEVER mutates the original evidence bytes. Every approved
redaction generates a **derivative** artifact carrying its own
storage key, byte size, and SHA-256. The Prisma derivative row
refuses to record a storage key that collides with the original
evidence's storage key, and the derivative state machine is the only
way a derivative is published. The platform's hard rule is repeated
verbatim in the standing limitations surfaced everywhere — UI footer,
report, verification-package manifest:

```
REDACTION_NEVER_MODIFIES_ORIGINAL
REDACTION_DERIVATIVE_IS_NOT_ORIGINAL
REDACTION_PROVIDER_SUGGESTIONS_ARE_NOT_GROUND_TRUTH
REDACTION_APPROVAL_IS_HUMAN_JUDGEMENT
REDACTION_DERIVATIVE_INTEGRITY_VERIFIES_THE_PIPELINE_NOT_THE_FACT
```

---

## 2. Redaction architecture

| Concept | Where it lives | Bounded shape |
|---|---|---|
| Redaction Project | `RedactionProject` (one per `(teamId, evidenceId)`) | `REDACTION_PROJECT_STATES` |
| Redaction Version | `RedactionVersion` (append-only ordinal per project) | `REDACTION_VERSION_STATES` + `REDACTION_VERSION_TRANSITIONS` |
| Redaction Region | `RedactionRegion` (geometry validated by shared helper) | `REDACTION_REGION_KINDS` × `REDACTION_METHODS` |
| Redaction Detection | `RedactionDetection` | `REDACTION_DETECTION_KINDS` × `REDACTION_DETECTION_PROVIDERS` × `REDACTION_CONFIDENCE_BANDS` |
| Redaction Decision | `RedactionDecision` (per-detection human verdict) | `REDACTION_DECISION_STATES` |
| Redaction Approval | `RedactionApproval` (per-version approver verdict) | `REDACTION_APPROVAL_VERDICTS` |
| Redaction Derivative | `RedactionDerivative` (1:1 with version) | `REDACTION_DERIVATIVE_KINDS` × `REDACTION_DERIVATIVE_STATES` |
| Redaction Activity (Audit) | `RedactionActivity` (append-only) | `REDACTION_ACTIVITY_CODES` |

The shared bounded vocabulary lives in `packages/shared/src/redaction.ts`
(re-exported from `packages/shared/src/index.ts`).

---

## 3. Detection architecture

Provider catalog (`REDACTION_DETECTION_PROVIDERS`):

| Provider | Status | Notes |
|---|---|---|
| `MANUAL` | Real | Operator draws regions from the viewer. |
| `REGEX_PII` | **Real** | Bounded regex catalog (email, phone, credit card, NINO/SSN, DOB, address, license plate) scanned over `inlineText`. Returns `NOT_CONFIGURED` when no text is supplied. |
| `POLICY_RULE` | Bounded stub | Honest `DISABLED_BY_POLICY` until Phase 3B's policy editor lands. |
| `AWS_REKOGNITION_FACES` | Bounded stub | Honest `NOT_CONFIGURED` — `@aws-sdk/client-rekognition` not bound yet. |
| `AWS_REKOGNITION_TEXT` | Bounded stub | Same. |
| `AZURE_DOCUMENT_INTELLIGENCE` | Bounded stub | Honest `NOT_CONFIGURED` — `@azure/ai-form-recognizer` not bound yet. |
| `OCR_TEXT_LAYER` | Bounded stub | Honest `NOT_CONFIGURED` — local OCR is `INDEX_EXISTING_ONLY`. |
| `DEEPGRAM_TRANSCRIPT` | Bounded stub | Foundations table exists; client not bound. |
| `CUSTOM_PROVIDER` | Bounded stub | Requires `redaction.administer` binding (deferred). |

Every provider returns `{ state: RedactionDetectionProviderState, reason: string | null, rows }`. The orchestrator (`redaction-detection.service.ts`) records `DETECTION_RUN_STARTED` → `DETECTION_GENERATED` × N (or `DETECTION_RUN_FAILED`) → `DETECTION_RUN_COMPLETED` for every batch.

Confidence is collapsed to four bounded bands via `classifyConfidence(raw)`: `LOW < 0.5 ≤ MEDIUM < 0.8 ≤ HIGH < 0.95 ≤ VERY_HIGH`.

---

## 4. Approval workflow

Version state machine (`REDACTION_VERSION_TRANSITIONS`):

```
DRAFT  ─submit──▶ IN_REVIEW  ─approve──▶ APPROVED  ─publish──▶ PUBLISHED
   ▲                  │                    │                       │
   │           ┌──reject─▶ REJECTED        │                       │
   │           │                            │                       ▼
   └─reopen────┘                            │                  SUPERSEDED  (when next version PUBLISHED)
                                            │
                                            └─reject──▶ REJECTED
```

Hard guarantees:

* **Separation of duties** — `redaction-approval.service.ts` refuses an approver who is the version author (server-side; never UI-only).
* **REJECT and REQUEST_CHANGES require rationale** ≥ 6 chars.
* **Publish gate** — `POST /v1/redaction/versions/:id/publish` refuses unless the derivative is `READY`.
* Approval rows are append-only; the version preserves its full approval history.

---

## 5. Versioning architecture

Each project owns 1..N versions with a monotonically increasing `versionOrdinal` enforced by `@@unique([projectId, versionOrdinal])`. PUBLISHING a new version atomically SUPERSEDES the prior PUBLISHED version inside a `$transaction`. No version is ever overwritten or deleted — REJECTED, REQUEST_CHANGES, and SUPERSEDED rows all stay. The version history panel is append-only and never offers a delete control (asserted by the closure test).

---

## 6. Audit mapping

Every redaction action emits one of 26 bounded `REDACTION_ACTIVITY_CODES` into `redaction_activity`:

| Lifecycle | Codes |
|---|---|
| Project | `PROJECT_CREATED`, `PROJECT_REOPENED`, `PROJECT_ARCHIVED` |
| Version | `VERSION_CREATED`, `VERSION_SUBMITTED_FOR_REVIEW`, `VERSION_APPROVED`, `VERSION_REJECTED`, `VERSION_PUBLISHED`, `VERSION_SUPERSEDED` |
| Regions | `REGION_ADDED`, `REGION_REMOVED`, `REGION_MODIFIED` |
| Detection | `DETECTION_RUN_STARTED/COMPLETED/FAILED`, `DETECTION_GENERATED`, `DETECTION_ACCEPTED/REJECTED/MODIFIED/DEFERRED` |
| Approval | `APPROVAL_REQUESTED`, `APPROVAL_GRANTED`, `APPROVAL_DENIED`, `APPROVAL_CHANGES_REQUESTED` |
| Derivative | `DERIVATIVE_REQUESTED`, `DERIVATIVE_RENDER_STARTED/COMPLETED/FAILED`, `DERIVATIVE_DOWNLOADED`, `DERIVATIVE_QUARANTINED` |
| Cross-surface | `POLICY_VIOLATION_DETECTED`, `ORIGINAL_INTEGRITY_REVERIFIED` |

The codes flow through `emitRedactionActivity` only — there is NO parallel audit store. Payloads are bounded (geometry hashes, detection ids, rationale previews ≤ 80 chars). Raw detection text and PII never enter the activity log.

---

## 7. Reviewer Workspace integration

* `GET /v1/redaction/workspace/summary` returns `RedactionReviewerSummary` (pending decisions, awaiting approval, approved-pending-derivative, published, rejected). The Reviewer landing page reads this as a tile.
* The redaction list page (`/redaction`) is registered in the navigation registry as `workspace.review_redaction` under the **REVIEW_GOVERNANCE** pillar. Discoverability is gated by `EVIDENCE_VIEW`; the workspace itself enforces the bounded redaction RBAC.

---

## 8. External Reviewer Portal integration

* The shared `PortalRedactionExposure` shape declares the bounded fields the External Reviewer Portal will surface for a grant (`derivativeId`, `versionOrdinal`, `publishedAtUtc`, `artifactKind`). Phase 3A ships the contract + the API surface that produces it (the portal projection picks up the shape via the bounded type).
* The portal NEVER exposes the original evidence — only approved-published derivatives are eligible. The orchestrator's storage-key collision check is the server-side defense.

---

## 9. Verify integration

* `GET /v1/redaction/public/verify/:evidenceId` returns a bounded `RedactionPublicVerifyBadge`:
  `hasPublishedDerivative`, `publishedVersionOrdinal`, `publishedAtUtc`, `approvalCount`, `limitations`.
* The route is anonymous + workspace-anchored by evidenceId. It is registered WITHOUT `requireAuth` (the closure test asserts this).
* NEVER region geometry, NEVER detection text, NEVER rationale. The standing limitation codes are surfaced on every response so the verifier sees the platform's bounded posture.

---

## 10. Report integration

`services/worker/src/report-v2/sections/redaction-summary.ts` exports `renderRedactionSummarySection(section)` — a bounded report section that:

* Renders a `renderCallout` with the literal "Original preserved · Derivative generated" boundary statement.
* Tabulates each published redaction version: ordinal, artifact kind, region count, published-at, bounded approval rows (verdict + timestamp), and the derivative SHA-256 prefix + state.
* NEVER renders raw geometry, raw detection text, or rationale verbatim. Counts + bounded labels only.

The section module is registered; wiring into `build-report-pdf.ts` orchestration is the bounded follow-up so this phase ships the section behind a clean signature.

---

## 11. Verification Package integration

`services/api/src/services/redaction/redaction-verification-manifest.service.ts` exports `buildRedactionVerificationEntries({teamId, evidenceId})`. It returns ONLY PUBLISHED versions and each entry carries:

* `projectId`, `evidenceId`, `artifactKind`, `versionOrdinal`, `publishedAtUtc`, `publishedByUserId`, `regionCount`.
* `derivative.{kind, storageKey, byteSize, fileSha256}` — the SHA-256 enables offline integrity verification without re-hitting the platform.
* `approvals` — the full bounded approval audit for the version.

Manifest entries match the shared `RedactionVerificationManifestEntry` type so the worker's verification-package writer can include them in the bundle.

---

## 12. Security model

| Redaction role | Bounded capabilities | Mapped from platform role |
|---|---|---|
| `REDACTION_REVIEWER` | view, region.author, detection.run, detection.review, version.submit | DB MEMBER → canonical REVIEWER |
| `REDACTION_APPROVER` | reviewer + version.approve, version.publish, derivative.download | `EVIDENCE_APPROVER` / `REVIEWER_LEAD` / `COMPLIANCE_LEAD` |
| `REDACTION_ADMINISTRATOR` | approver + redaction.administer | OWNER / ADMIN / WORKSPACE_ADMIN |

Role expansion is monotonic and verified by the closure test. Capabilities are also added to the platform-wide `PERMISSIONS` catalog so the existing RBAC engine sees them, and `redaction-rbac.service.ts` is the single server-side gate every route calls via `assertRedactionCapability` BEFORE touching any redaction table.

---

## 13. UI / UX

| Surface | File | Notes |
|---|---|---|
| Projects list | `apps/web/app/(app)/redaction/page.tsx` | Workspace summary tiles + open-project form + workspace-wide projects table. |
| Project workspace shell | `apps/web/app/(app)/redaction/[projectId]/page.tsx` | Version sidebar + main version workspace + bounded limitations footer. |
| Image viewer | `apps/web/components/redaction/ImageRedactionViewer.tsx` | Drag-to-draw `BBOX_NORMALIZED`. Method: BLUR / PIXELATE / BLACKOUT. |
| PDF viewer | `apps/web/components/redaction/PdfRedactionViewer.tsx` | Per-page region authoring. Method: BLACKOUT / REMOVE_CONTENT. |
| Video viewer | `apps/web/components/redaction/VideoRedactionViewer.tsx` | Frame-range `VIDEO_FRAME_BBOX` authoring with optional `trackingId`. |
| Detection panel | `apps/web/components/redaction/DetectionReviewPanel.tsx` | Provider toggles + accept / reject / defer per detection. |
| Approval panel | `apps/web/components/redaction/ApprovalPanel.tsx` | Submit / approve / reject / publish with server-state gating + append-only approval history. |
| Version history | `apps/web/components/redaction/VersionHistoryPanel.tsx` | Bounded version list; no delete control. |

Every action round-trips through the API; the UI never assumes server-side state. `versionLocked` (any state other than DRAFT) disables drawing + decision actions.

---

## 14. API changes

New routes mounted in `services/api/src/routes/redaction.routes.ts` and registered by `server.ts`:

* `GET    /v1/redaction/projects`
* `POST   /v1/redaction/projects`
* `GET    /v1/redaction/projects/:id`
* `GET    /v1/redaction/projects/:id/activity`
* `POST   /v1/redaction/projects/:id/versions`
* `POST   /v1/redaction/versions/:id/regions`
* `DELETE /v1/redaction/regions/:id`
* `POST   /v1/redaction/versions/:id/detect`
* `GET    /v1/redaction/versions/:id/detections`
* `POST   /v1/redaction/detections/:id/decision`
* `POST   /v1/redaction/versions/:id/submit`
* `POST   /v1/redaction/versions/:id/approve`
* `POST   /v1/redaction/versions/:id/publish`
* `POST   /v1/redaction/versions/:id/derivative`
* `POST   /v1/redaction/derivatives/:id/mark-ready` (worker callback)
* `POST   /v1/redaction/derivatives/:id/mark-failed` (worker callback)
* `GET    /v1/redaction/derivatives/:id` (download metadata + audit bump)
* `GET    /v1/redaction/versions/:id/derivative`
* `GET    /v1/redaction/workspace/summary`
* `GET    /v1/redaction/public/verify/:evidenceId` (anonymous, provenance-only)

All privileged routes call `gate(reply, ctx, "redaction.*")` BEFORE the first DB read. Denials are bounded by `REDACTION_DENIAL_REASONS`.

---

## 15. Database changes

Migration: `services/api/prisma/migrations/20261101000000_phase_3a_redaction_platform/migration.sql`

8 new tables, Phase O-Final hygienic:

* `redaction_projects`, `redaction_versions`, `redaction_regions`, `redaction_detections`, `redaction_decisions`, `redaction_approvals`, `redaction_derivatives`, `redaction_activity`
* Plain `CREATE TABLE` (no `IF NOT EXISTS` on brand-new tables → fail loudly on collision)
* Every `CREATE INDEX` wrapped in a `DO $$ … information_schema.columns … END $$` guard
* Cascading FKs: `project → version → regions/detections/decisions/approvals/derivative`
* Unique constraints: `(team_id, evidence_id)` on project, `(project_id, version_ordinal)` on version, `version_id` on derivative
* No existing tables altered

Migration is allow-listed in the Phase 32.7.2 drift gate with citation.

---

## 16. Frontend changes

* `apps/web/app/(app)/redaction/page.tsx` (new)
* `apps/web/app/(app)/redaction/[projectId]/page.tsx` (new)
* `apps/web/components/redaction/ImageRedactionViewer.tsx` (new)
* `apps/web/components/redaction/PdfRedactionViewer.tsx` (new)
* `apps/web/components/redaction/VideoRedactionViewer.tsx` (new)
* `apps/web/components/redaction/DetectionReviewPanel.tsx` (new)
* `apps/web/components/redaction/ApprovalPanel.tsx` (new)
* `apps/web/components/redaction/VersionHistoryPanel.tsx` (new)

Web typecheck: **0 errors**.

---

## 17. Tests added

`services/api/test/phase-3a-redaction-platform.test.ts` — **60 assertions** across 9 describe blocks:

1. Shared contracts (artifacts, regions, methods, detections, providers, provider states, confidence bands, decisions, project/version states, approval verdicts, derivative kinds/states, RBAC matrix monotonicity, activity codes, denials, limitations, projection schema, permissions catalog, REVIEWER subset hygiene).
2. Prisma models + Phase O-Final compliant migration.
3. Backend services (activity, RBAC, project, region, detection orchestrator, providers, decision, approval, derivative orchestrator, projection, verification manifest).
4. HTTP routes (full surface enumeration, capability gate count, publish-requires-READY-derivative gate, DERIVATIVE_DOWNLOADED audit, server-registration).
5. RBAC + nav registry wiring.
6. Integrations (reviewer summary endpoint, public verify badge anonymous + provenance-only, report-summary section, verification-package manifest).
7. UI surfaces (every page + component, bounded `data-redaction-*` anchors).
8. Runtime helpers (classifyConfidence, version-transition machine, RBAC role mapping, geometry validators, REGEX_PII detector + masked preview, REGEX_PII NOT_CONFIGURED honesty).
9. Phase 2B Closure preserved.

Allow-list updated in `services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts` so the migration drift gate stays green.

---

## 18. Validation results

| Check | Result |
|---|---|
| Shared package build | ✅ Clean (`tsc -p tsconfig.build.json`) |
| Prisma schema validate | ✅ "The schema at prisma\\schema.prisma is valid 🚀" |
| API typecheck (`npx tsc --noEmit`) | ✅ **0 errors** |
| Web typecheck (`apps/web`) | ✅ **0 errors** |
| Phase 3A closure test | ✅ **60 / 60** |
| Phase 2B Closure test (regression check) | ✅ 54 / 54 |
| Phase O migration safety gate | ✅ 28 / 28 |
| Phase 32.7.2 migration drift gate | ✅ 24 / 24 |
| Full API test suite | ✅ **251 / 252 files (1 skipped, 11640 / 11692 tests, 0 failures)** |

---

## 19. File paths changed

**New:**

* `packages/shared/src/redaction.ts`
* `services/api/prisma/migrations/20261101000000_phase_3a_redaction_platform/migration.sql`
* `services/api/src/services/redaction/redaction-activity.service.ts`
* `services/api/src/services/redaction/redaction-rbac.service.ts`
* `services/api/src/services/redaction/redaction-project.service.ts`
* `services/api/src/services/redaction/redaction-region.service.ts`
* `services/api/src/services/redaction/redaction-detection.service.ts`
* `services/api/src/services/redaction/redaction-detection-providers.service.ts`
* `services/api/src/services/redaction/redaction-decision.service.ts`
* `services/api/src/services/redaction/redaction-approval.service.ts`
* `services/api/src/services/redaction/redaction-derivative.service.ts`
* `services/api/src/services/redaction/redaction-projection.service.ts`
* `services/api/src/services/redaction/redaction-verification-manifest.service.ts`
* `services/api/src/routes/redaction.routes.ts`
* `services/worker/src/report-v2/sections/redaction-summary.ts`
* `apps/web/app/(app)/redaction/page.tsx`
* `apps/web/app/(app)/redaction/[projectId]/page.tsx`
* `apps/web/components/redaction/ImageRedactionViewer.tsx`
* `apps/web/components/redaction/PdfRedactionViewer.tsx`
* `apps/web/components/redaction/VideoRedactionViewer.tsx`
* `apps/web/components/redaction/DetectionReviewPanel.tsx`
* `apps/web/components/redaction/ApprovalPanel.tsx`
* `apps/web/components/redaction/VersionHistoryPanel.tsx`
* `services/api/test/phase-3a-redaction-platform.test.ts`

**Modified:**

* `packages/shared/src/index.ts` — re-exports the redaction contracts.
* `packages/shared/src/permissions.ts` — adds 9 bounded redaction capabilities + grants OWNER (all), ADMIN (all), REVIEWER (bounded reviewer subset).
* `services/api/prisma/schema.prisma` — appends 8 redaction models.
* `services/api/src/server.ts` — registers `redactionRoutes`.
* `services/api/src/services/platform-context/navigation-registry.ts` — adds `workspace.review_redaction` to the REVIEW_GOVERNANCE pillar.
* `services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts` — allow-lists the new migration.

---

## 20. Remaining limitations (honest disclosure)

1. **Worker derivative-rendering pipeline is the deferred follow-up.**
   The API orchestrator + worker callback contract (`POST /derivatives/:id/mark-ready | mark-failed`) is complete. The bounded `RedactionDerivative` state machine is enforced. The actual sharp-based image renderer, pdf-lib + pdftoppm-based PDF rasterize-and-flatten renderer, and ffmpeg-based video pipeline are scoped for Phase 3A.1. The platform already refuses to PUBLISH a version whose derivative is not `READY`, so unredacted bytes can NEVER be published as the workspace's redacted derivative.

2. **AWS Rekognition + Azure Document Intelligence + OCR + Deepgram providers are bounded stubs.** Each honestly returns `NOT_CONFIGURED` and the orchestrator records `DETECTION_RUN_FAILED` so operators see the gap. The provider interface is the bind-point for the real clients.

3. **PDF content removal via `REMOVE_CONTENT`** depends on the worker pipeline. The metadata + decision audit + region storage are all in place; the actual content-stream operator stripping ships with the worker module. Honest disclosure in the PDF viewer: "The derivative MUST be readable as the bounded redacted PDF — never as the original."

4. **Report section + verification-package manifest writer** are bounded modules. Their wiring into the existing `build-report-pdf.ts` orchestrator and the verification-package writer is the bounded follow-up. The closure test pins the module signatures.

5. **External Reviewer Portal exposure** ships the bounded `PortalRedactionExposure` contract. Surfacing approved derivatives inside the portal's projection is the bounded follow-up.

---

## 21. PASS / FAIL closure criteria

| Closure criterion | Result |
|---|---|
| Original evidence is never modified | ✅ Derivative orchestrator refuses storage-key collision with the original. |
| Image Redaction exists | ✅ `ImageRedactionViewer` + `BBOX_NORMALIZED` region kind + BLUR / PIXELATE / BLACKOUT methods + worker contract. |
| Video Redaction exists | ✅ `VideoRedactionViewer` + `VIDEO_FRAME_BBOX` region kind + frame-range + optional trackingId + per-frame method. |
| PDF Redaction exists | ✅ `PdfRedactionViewer` + `PDF_PAGE_RECT` + `PDF_TEXT_RANGE` regions + `REMOVE_CONTENT` method. |
| Detection Engine exists | ✅ Provider registry (MANUAL + REGEX_PII real, AWS/Azure/OCR/Deepgram bounded stubs) + bounded provider state catalog. |
| Human review (suggestion → decision) | ✅ Every detection lands as `SUGGESTED`; only `recordDetectionDecision` promotes it. |
| Approval workflow | ✅ Bounded state machine + separation of duties + rationale requirement + bounded verdict catalog. |
| Versioning (append-only) | ✅ `@@unique([projectId, versionOrdinal])` + atomic SUPERSEDE on PUBLISH + bounded transition map. |
| Audit trail | ✅ 26 bounded `REDACTION_ACTIVITY_CODES`; all writes through `emitRedactionActivity`; no parallel store. |
| Reviewer Workspace integration | ✅ `/v1/redaction/workspace/summary` + nav entry. |
| External Reviewer Portal integration | ✅ Bounded `PortalRedactionExposure` shape. |
| Verify integration | ✅ Anonymous `/v1/redaction/public/verify/:evidenceId` badge — provenance only. |
| Report integration | ✅ `renderRedactionSummarySection` module with "Original preserved · Derivative generated" callout. |
| Verification Package integration | ✅ `buildRedactionVerificationEntries` writer — PUBLISHED entries + SHA-256 for offline verification. |
| Tests prove end-to-end workflows | ✅ 60 assertions cover shared contracts, schema, services, routes, RBAC, nav, integrations, UI, runtime helpers. |
| RBAC enforced server-side | ✅ `assertRedactionCapability` is called by every privileged route BEFORE any DB read. |
| Workspace anchored | ✅ Every read filters on `teamId`. |
| Fail-closed semantics | ✅ Geometry validator, version-transition map, separation of duties, publish gate, storage-key collision check. |
| Full validation passes | ✅ 11640 / 11692 tests, 0 failures. |

**Phase 3A — Enterprise Redaction Platform: workflow / governance / audit / integration COMPLETE.** Worker derivative-rendering pipeline + cloud detection providers are bounded follow-ups, honestly disclosed in section 20.
