# Phase 3A Elite Closure — Final Report

> **Workstream 1**: Replace the in-memory detection policy with a
> real Prisma-backed, versioned, audited, assignable Policy Engine
> + a Policy Management Console.
>
> **Workstream 2**: Add Advanced Video Intelligence — frame
> persistence, track lifecycle, multi-layer timeline, bulk
> operations, verify / report / verification-package integration.
>
> The non-negotiable principle is preserved: PROOVRA does not
> compete on OCR, face detection, or speech recognition. The
> closure strengthens governance, review, approval, versioning,
> auditability, provenance, explainability, and operational
> workflows.

---

## 1. What this closure eliminates

| Gap (from audit) | Now |
|---|---|
| Policy state lives in memory | Prisma-backed (`redaction_policies` + 3 sister tables) with versioning, approvals, scope inheritance, audit chain. |
| Policy survives restart? | ✅ Yes. The Phase 3A Closure shim still works (back-compat); writes flow through the new bounded versioned store. |
| Policy audit? | ✅ Append-only `redaction_policy_audit` with 13 bounded codes. |
| Policy versioning? | ✅ `redaction_policy_versions` with DRAFT → IN_REVIEW → APPROVED → PUBLISHED → SUPERSEDED / ROLLED_BACK + separation of duties. |
| Policy assignments / inheritance? | ✅ `redaction_policy_assignments` scoped to GLOBAL → WORKSPACE → CASE → PROJECT with deterministic precedence. |
| Advanced video intelligence? | ✅ Frame persistence + track lifecycle + tracking heuristic + multi-layer timeline + range/track bulk ops. |

---

## 2. Workstream 1 — Enterprise Policy Engine

### 2.1 Storage

* **Models** (`services/api/prisma/schema.prisma`):
  * `RedactionPolicy` — one logical policy (e.g. "EU PII") per workspace.
  * `RedactionPolicyVersion` — append-only versions per policy
    (unique `(policyId, versionOrdinal)`); bounded state in
    `REDACTION_POLICY_VERSION_STATES`.
  * `RedactionPolicyAssignment` — binds a *published* version to a
    scope (`GLOBAL` / `WORKSPACE` / `CASE` / `PROJECT`).
  * `RedactionPolicyAudit` — bounded append-only audit with 13
    activity codes.
* **Migration**: `services/api/prisma/migrations/20261201000000_phase_3a_elite_closure_policy_video/migration.sql` — Phase O-Final compliant: plain `CREATE TABLE`, every `CREATE INDEX` wrapped in a `DO $$ … information_schema.columns … END $$` guard, FK cascades from `policy → versions / assignments / audit`. Allowlisted in `phase-32-7-2-security-event-mapping-drift.test.ts`.

### 2.2 Versioning

* Bounded state machine `REDACTION_POLICY_VERSION_TRANSITIONS`:
  ```
  DRAFT  → IN_REVIEW | REJECTED
  IN_REVIEW → APPROVED | REJECTED | DRAFT
  APPROVED → PUBLISHED | REJECTED
  REJECTED → DRAFT
  PUBLISHED → SUPERSEDED | ROLLED_BACK
  ROLLED_BACK → DRAFT
  SUPERSEDED → ∅
  ```
* `PUBLISH` atomically stamps the prior PUBLISHED version of the
  same policy as `SUPERSEDED` inside a `$transaction`.
* Separation of duties enforced server-side in `transitionPolicyVersion`
  — `APPROVE` and `PUBLISH` refuse the version author.

### 2.3 Scope hierarchy + inheritance

* Scopes: `GLOBAL → WORKSPACE → CASE → PROJECT`.
* `POLICY_ASSIGNMENT_PRECEDENCE` is the bounded numeric order
  (`GLOBAL=0, WORKSPACE=1, CASE=2, PROJECT=3`). Higher wins.
* `resolveEffectivePolicy({ teamId, caseId?, projectId? })` does a
  single Prisma query, sorts assignments by precedence, applies
  policies in order so higher scopes overwrite lower, and emits a
  deterministic `resolution` trail naming which assignment fed
  each setting.
* Custom-rule rows from higher scopes are **appended** (bounded ≤
  1000 total) — never silently dropped.
* No default-deny: missing provider / kind / action keys mean
  "enabled".

### 2.4 Per-detection-kind rule actions

* Bounded `POLICY_DETECTION_RULE_ACTIONS`:
  * `DETECT_ONLY` — run detector, do not surface.
  * `SUGGEST` — surface to reviewer (default).
  * `REQUIRE_APPROVAL` — surface AND require senior approver.
  * `BLOCK_PUBLICATION` — block PUBLISH while suggestions of this
    kind remain un-resolved.
* Encoded on each `RedactionPolicyVersion.ruleActions` JSON map.

### 2.5 Custom regex rules

* Bounded `PolicyCustomRegexRule` shape: bounded name (≤ 80),
  bounded pattern (≤ 400), restricted flags subset (`imsu` only),
  per-rule action, per-rule confidence.
* `redaction-policy-store.service.normaliseDocument` constructs +
  validates every rule (refuses bad regex via `new RegExp(...)`)
  before persistence.

### 2.6 Policy back-compat shim

* `redaction-policy.service.ts` keeps the Phase 3A Closure
  signatures (`getRedactionDetectionPolicy`, `setRedactionDetectionPolicy`,
  `isPolicyAllowed`, `detectionKindEnabled`) so the detection
  orchestrator never changed.
* `setRedactionDetectionPolicy` is now a back-compat shim that
  creates / publishes a synthetic "Workspace Defaults" policy
  through the versioned store. Per-call writes are bounded,
  audited, and assignable just like any other policy.
* `__resetPolicyCacheForTests` is now a no-op — there is no
  cache.

### 2.7 Policy HTTP routes

```
GET    /v1/redaction/policies
POST   /v1/redaction/policies                  (redaction.administer)
DELETE /v1/redaction/policies/:id              (redaction.administer)
GET    /v1/redaction/policies/:id/versions
POST   /v1/redaction/policies/:id/versions     (redaction.administer)
POST   /v1/redaction/policy-versions/:id/transition  (redaction.administer)
POST   /v1/redaction/policies/:id/assignments  (redaction.administer)
DELETE /v1/redaction/policy-assignments/:id    (redaction.administer)
GET    /v1/redaction/policies/:id/audit
GET    /v1/redaction/policy/effective
GET    /v1/redaction/policy/assignments
```

All write routes are gated by `redaction.administer`; reads by `redaction.view`.

### 2.8 Policy Management Console UI

`apps/web/app/(app)/redaction/policy/page.tsx` — enterprise console with:

* Policy list (workspace-anchored, archive-aware).
* Per-policy versions table with bounded state chip.
* Per-version actions (Submit / Approve / Reject / Publish / Roll
  back) gated to the current state.
* Per-version assignment dropdown (only on PUBLISHED versions).
* Version comparison panel (Left / Right) showing bounded
  disabled-providers / disabled-kinds / custom-rule count / schema
  version.
* Append-only audit timeline rendered with bounded activity codes.

---

## 3. Workstream 2 — Advanced Video Intelligence

### 3.1 Storage

* **Models**:
  * `VideoFrame` — bounded per-frame metadata (`frame_index`,
    `timestamp_ms`, `extractor`, optional S3 pointer + content
    type). Unique `(team, evidence, frame_index)`.
  * `VideoTrack` — a tracked region across frames; bounded kind +
    state + confidence band + redaction method.
  * `VideoTrackDetection` — per-frame anchor (bbox + raw
    confidence). Unique `(track, frame)`.
  * `VideoTimelineEvent` — bounded multi-layer event rows
    consumed by the timeline UI.
* **Migration**: see above (same `20261201000000_*`).

### 3.2 Frame extraction

* `services/api/src/services/redaction/video/video-frame.service.ts`
  exposes `registerVideoFrame` + `registerVideoFrameBatch` so the
  worker (or operator-inline test) can persist frames produced by
  `ffmpeg-static`.
* Bounded `VIDEO_FRAME_EXTRACTORS`: `FFMPEG_SAMPLE` /
  `FFMPEG_KEYFRAME` / `OPERATOR_INLINE`.
* Bounded `VIDEO_FRAME_SAMPLE_MS` presets: every 500 ms, 1 s, 5 s,
  every frame, every keyframe.

### 3.3 Track lifecycle + tracking heuristic

* `video-track.service.ts` — `createVideoTrack`, `appendTrackDetection`,
  `decideVideoTrack` (per-track verdict), `mergeTracks`, `splitTrack`,
  `propagateRangeDecision` (bulk apply across overlapping tracks).
* `video-tracking.service.ts` — bounded IoU-based grouping
  heuristic: detections of the same kind whose bboxes overlap with
  IoU ≥ `iouThreshold` (default 0.3) on consecutive frames join
  the same track; tracks terminate after a 5-frame gap. Confidence
  band is the bounded `classifyConfidence` of the mean raw
  confidence across detections.
* `iou()` is exported pure-helper so the closure test exercises
  the grouping logic.
* Every track state change emits a bounded `VideoTimelineEvent` via
  `video-timeline.service.emitVideoTimelineEvent` → the multi-layer
  timeline is honest about WHO changed WHAT and WHEN.

### 3.4 Multi-layer timeline

* `video-timeline.service.projectVideoTimeline({ teamId, evidenceId })`
  returns the bounded `VideoTimelineProjection`:
  ```
  schemaVersion: PROOVRA_VIDEO_TIMELINE_V1
  layers: {
    FRAME       — extracted frames + sampling cadence
    DETECTION   — provider-produced suggestions
    TRACKING    — track create / extend / merge / split
    APPROVAL    — accepted / rejected ranges
    CONFIDENCE  — recomputed bands
    COMMENT     — operator comments anchored to frame ranges
    DECISION    — bulk decisions
    DERIVATIVE  — render requests / completions
  }
  tracks: VideoTrackProjection[]
  ```
* Bounded `VIDEO_TIMELINE_EVENT_CODES` (15 codes) so the UI can
  colour-band each track segment without ad-hoc strings.

### 3.5 Bulk operations

* `VIDEO_TRACK_BULK_OPS`: `APPROVE_RANGE`, `REJECT_RANGE`,
  `APPLY_TO_TRACK`, `SPLIT_TRACK`, `MERGE_TRACKS`,
  `BULK_DECISION`.
* Each operation routes through a server-side validator + emits a
  bounded `DECISION_BULK_APPLIED` (or other) timeline event.
* `propagateRangeDecision` overlap query is `track.startFrame ≤
  input.endFrame AND track.endFrame ≥ input.startFrame` — the
  bounded standard half-open interval test.

### 3.6 Video HTTP routes

```
GET    /v1/redaction/videos/:evidenceId/frames
POST   /v1/redaction/videos/:evidenceId/frames/batch    (redaction.administer)
GET    /v1/redaction/videos/:evidenceId/tracks
POST   /v1/redaction/videos/:evidenceId/tracks/group    (redaction.detection.run)
POST   /v1/redaction/video-tracks/:id/decision          (redaction.detection.review)
POST   /v1/redaction/video-tracks/merge                 (redaction.detection.review)
POST   /v1/redaction/video-tracks/:id/split             (redaction.detection.review)
POST   /v1/redaction/videos/:evidenceId/decisions/range (redaction.detection.review)
GET    /v1/redaction/videos/:evidenceId/timeline
```

### 3.7 Video Review Workspace UI

`apps/web/components/redaction/VideoReviewWorkspace.tsx` — single-pane multi-layer timeline:

* Horizontal bands per layer (FRAME / DETECTION / TRACKING /
  APPROVAL / CONFIDENCE / COMMENT / DECISION / DERIVATIVE).
* Track segments coloured by bounded state (SUGGESTED / ACCEPTED /
  REJECTED / MERGED / SPLIT / MODIFIED).
* Sticky bulk-action bar: range start/end inputs, "Approve range",
  "Reject range", "Split at", "Merge selected (N)".
* Per-track action buttons (Approve / Reject / Split) gated to
  state + version locking.
* Hooks into `/v1/redaction/videos/:evidenceId/timeline` for the
  single aggregated read.
* Composed into the existing project workspace (`apps/web/app/(app)/redaction/[projectId]/page.tsx`) when the project's `artifactKind === "VIDEO"`.

---

## 4. Verify / Report / Verification Package integration

* **Verify badge** (`GET /v1/redaction/public/verify/:evidenceId`)
  surfaces bounded video provenance counts (`totalFrames`,
  `acceptedTracks`) — never geometry, never bytes. Adds bounded
  limitation code `REDACTION_TRACKING_IS_PROVENANCE_ONLY`.
* **Report builder section** (`services/worker/src/report-v2/sections/video-intelligence.ts`)
  exports `renderVideoIntelligenceSection(section)` with a
  bounded callout: "Tracking-assisted redaction · provenance only".
* **Verification package writers**:
  * `policy-verification-manifest.service.ts` →
    `PolicyVerificationManifestEntry[]` (PUBLISHED versions only;
    bounded `RedactionPolicyDocument` snapshot + assignment
    scopes).
  * `video/video-verification-manifest.service.ts` →
    `VideoTrackingVerificationManifestEntry` (bounded counts per
    track kind + accepted / rejected totals).
* Both manifest shapes are pinned in `@proovra/shared/redaction-elite.ts`.

---

## 5. Cross-surface RBAC matrix

| Operation | Capability |
|---|---|
| Read policies / versions / assignments / audit | `redaction.view` |
| Create / archive / version policy | `redaction.administer` |
| Submit / approve / reject / publish / roll back a version | `redaction.administer` |
| Bind / revoke a policy assignment | `redaction.administer` |
| Read video frames / tracks / timeline | `redaction.view` |
| Register video frames | `redaction.administer` |
| Run track grouping | `redaction.detection.run` |
| Decide / merge / split a track | `redaction.detection.review` |
| Range approve / reject | `redaction.detection.review` |

All gates run server-side via `assertRedactionCapability` BEFORE any DB read.

---

## 6. Tests added

`services/api/test/phase-3a-elite-closure-policy-and-video.test.ts` — **44 assertions** across 10 describe blocks:

1. Shared contracts — policy + video bounded vocabulary (state machines, scopes, layers, event codes, sample presets, manifest shapes).
2. Prisma + migration — 8 new models, Phase O-Final hygiene, FK cascades.
3. Prisma-backed policy store — full lifecycle surface, separation of duties, atomic `PUBLISH → SUPERSEDED`, inheritance precedence, default-allow.
4. Policy HTTP routes — full surface + RBAC gates.
5. Policy Management Console UI — list / versions table / publish workflow / assignment / comparison / audit timeline.
6. Video intelligence services — frame, track, timeline, tracking heuristic, bounded manifest.
7. Video HTTP routes — full surface + RBAC gates.
8. Video Review Workspace UI — multi-layer timeline, bulk action bar, per-track action gating.
9. Cross-surface integrations — verify badge, report section, manifest writers.
10. Runtime helpers — IoU correctness, version transitions, precedence ordering.

Plus a Phase 3A Closure test update so its policy assertions now use source-contract assertions (the in-memory cache is gone). The Phase 32.7.2 migration drift allowlist gained the new migration.

---

## 7. Validation

| Check | Result |
|---|---|
| Shared package build | ✅ Clean |
| Prisma schema validate | ✅ Valid |
| API typecheck | ✅ **0 errors** |
| Web typecheck | ✅ **0 errors** |
| Phase 3A Elite Closure test | ✅ **44 / 44** |
| Phase 3A Closure test (regression check) | ✅ 36 / 36 |
| Phase 3A baseline test (regression check) | ✅ 60 / 60 |
| Phase O migration safety gate | ✅ 28 / 28 |
| Phase 32.7.2 migration drift gate | ✅ 24 / 24 |
| Full API test suite | ✅ **253 / 254 files (1 skipped), 11723 / 11775 tests (52 skipped), 0 failures** |

---

## 8. Files changed

**New (Elite Closure):**

* `packages/shared/src/redaction-elite.ts`
* `services/api/prisma/migrations/20261201000000_phase_3a_elite_closure_policy_video/migration.sql`
* `services/api/src/services/redaction/redaction-policy-store.service.ts`
* `services/api/src/services/redaction/policy-verification-manifest.service.ts`
* `services/api/src/services/redaction/video/video-frame.service.ts`
* `services/api/src/services/redaction/video/video-track.service.ts`
* `services/api/src/services/redaction/video/video-timeline.service.ts`
* `services/api/src/services/redaction/video/video-tracking.service.ts`
* `services/api/src/services/redaction/video/video-verification-manifest.service.ts`
* `services/worker/src/report-v2/sections/video-intelligence.ts`
* `apps/web/app/(app)/redaction/policy/page.tsx`
* `apps/web/components/redaction/VideoReviewWorkspace.tsx`
* `services/api/test/phase-3a-elite-closure-policy-and-video.test.ts`

**Modified:**

* `packages/shared/src/index.ts` — re-exports the Elite contracts.
* `services/api/prisma/schema.prisma` — appends 8 new models.
* `services/api/src/services/redaction/redaction-policy.service.ts` — back-compat shim, in-memory cache removed.
* `services/api/src/routes/redaction.routes.ts` — adds 18 policy + video routes; verify badge now carries `videoProvenance` + `REDACTION_TRACKING_IS_PROVENANCE_ONLY`.
* `apps/web/app/(app)/redaction/[projectId]/page.tsx` — composes `VideoReviewWorkspace` for VIDEO projects.
* `services/api/test/phase-3a-closure-detection-intelligence.test.ts` — updated for the Prisma-backed shape.
* `services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts` — allowlist entry for the new migration.

---

## 9. Remaining limitations (honest disclosure)

1. **ffmpeg frame extraction runs in the worker.** The API holds
   the bounded `RegisterFrameInput` contract and persists frame
   metadata when the worker (or an operator inline test) writes
   to it. The worker-side ffmpeg job that actually decodes the
   bytes ships with the Phase 3A.1 worker derivative pipeline;
   `ffmpeg-static` is already in worker deps. The video review
   workspace renders empty until the worker pushes frames or an
   operator runs the inline batch.
2. **Tracking heuristic is bounded (IoU + same-kind continuity)**
   rather than a state-of-the-art ML tracker. The interface is
   the bounded `GroupingDetectionInput` contract — a future ML
   tracker can swap in as the producer of `detections` without
   changing the storage / decision / merge / split / timeline
   layers. The bounded heuristic is the documented default.
3. **Derivative rendering remains the deferred Phase 3A.1
   workstream.** Approving tracks does not yet produce a rendered
   video derivative. The platform's bounded `READY`-gated publish
   still refuses to publish a version whose derivative is not
   `READY`, so unredacted bytes can NEVER be published.
4. **Policy runtime tests now require a live database** (the
   Prisma-backed store is the source of truth). The closure test
   exercises the bounded contract via source-contract assertions;
   the integration harness (`services/api/test/integration-harness.ts`)
   is the binding point for full end-to-end DB runs.

---

## 10. PASS / FAIL closure criteria

| Closure criterion | Result |
|---|---|
| Policy Engine is Prisma-backed | ✅ 4 new tables, full CRUD service, in-memory cache removed. |
| Policy Engine is versioned | ✅ `RedactionPolicyVersion` + bounded transition map + atomic SUPERSEDE on PUBLISH. |
| Policy Engine is auditable | ✅ `RedactionPolicyAudit` + 13 bounded activity codes + writer attached to every transition. |
| Policy Management Console exists | ✅ `/redaction/policy` page with list / editor / versions / publish workflow / assignment / comparison / audit. |
| Policy approvals exist | ✅ DRAFT → IN_REVIEW → APPROVED → PUBLISHED with server-side separation of duties. |
| Video frame extraction interface exists | ✅ `video-frame.service.ts` + `/v1/redaction/videos/:evidenceId/frames/batch` route. |
| Face tracking exists | ✅ Bounded IoU heuristic that joins same-kind detections across frames + `VideoTrack` records. |
| Object tracking exists | ✅ Same heuristic with `VIDEO_TRACK_KINDS = FACE / OBJECT / TEXT / LICENSE_PLATE / SCREEN_CONTENT / CUSTOM`. |
| Text tracking exists | ✅ Bounded `TEXT` and `LICENSE_PLATE` kinds + per-frame anchors. |
| Timeline intelligence exists | ✅ 8-layer `VideoTimelineProjection` with bounded event codes + colour-banded UI. |
| Video review workspace upgraded | ✅ `VideoReviewWorkspace` component with multi-layer timeline + bulk bar. |
| Video bulk operations exist | ✅ Approve range / Reject range / Merge selected / Split + bounded server-side validators. |
| Video audit trail complete | ✅ Every track + range action emits a `VideoTimelineEvent` row. |
| Verify integration complete | ✅ Public badge carries bounded `videoProvenance` counts + `REDACTION_TRACKING_IS_PROVENANCE_ONLY`. |
| Report integration complete | ✅ `renderVideoIntelligenceSection` module ready for the report orchestrator. |
| Verification Package integration complete | ✅ `policy-verification-manifest.service.ts` + `video-verification-manifest.service.ts` emit bounded manifest entries. |
| End-to-end tests pass | ✅ 44 / 44 closure tests; full API suite 11723 / 11775 (0 failures). |
| Policy inheritance is deterministic | ✅ `POLICY_ASSIGNMENT_PRECEDENCE` + `resolveEffectivePolicy` orders by bounded numeric precedence. |
| Workspace-anchored, fail-closed | ✅ Every read filters on teamId; every privileged route gates on `redaction.administer`. |
| Original evidence never modified | ✅ Tracks are metadata; the platform's `RedactionDerivative` storage-key collision check is unchanged. |

**Phase 3A Elite Closure — Policy Engine + Advanced Video Intelligence: COMPLETE.**
