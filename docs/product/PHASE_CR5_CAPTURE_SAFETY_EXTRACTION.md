# Phase CR5 — Capture Safety Extraction

**Status:** CLOSED_WITH_DEFERRED_ITEMS
**Closure date:** 2026-05-26
**Test suite:** `services/api/test/phase-cr5-capture-safety.test.ts` (888 cases passing)
**Component tree:** `apps/web/components/capture-v2/` (pre-existing; no new presentation components added in CR5 — see §11 for rationale)

---

## 1. Intent

CR5 makes the capture surface — the highest-risk product surface — safe
to maintain without changing evidence semantics. Capture controls
evidence intake, staged materials, upload orchestration, integrity
preparation, hashing, finalize/sign, custody creation, report generation
trigger, delegated/external intake, and reviewer downstream flows. A
bad refactor here can silently destroy upload truth, finalize
guarantees, custody integrity, report correctness, and lifecycle
consistency.

CR5 therefore lands the **source-contract test wall FIRST** (~200 cases
across 10 mandatory groups + meta) as the durable safety guarantee.
Extraction is then a bounded, layered, test-protected refactor that
**preserves all backend truth, all finalize guarantees, all custody
semantics, and all AI metadata-only boundaries**.

---

## 2. Entry-gate revalidation (Part 1)

Reproduced from the CR5 entry-gate report (already approved earlier):

- Prior phases: **E10.2** (operational readiness, CLOSED_WITH_DEFERRED_ITEMS, 2026-05-26) + **CR4** (verify decomposition, CLOSED_WITH_DEFERRED_ITEMS, 2026-05-26).
- No open DEF touches capture/upload/finalize/custody.
- Master registry §2 row for Capture: "Frozen — out of scope for all R-CR phases. File-size pinned by CR1.6 Test 7." CR5 honors this — touches **only frontend presentation**, never backend.
- Test infrastructure: API vitest only (no web-side runner). CR5 uses the canonical source-contract pattern, identical to CR4's 175-case suite that landed cleanly.
- E10.2 audit (subsystem #1) marked Capture/upload/finalize ✅ SOUND on every column (determinism / partial-failure-safety / retry-safety / corruption / duplication / stuck-job / audit-consistency / lifecycle-drift). CR5 must NOT regress any of these.

**Pre-condition:** CR1.7 §9 entry gate satisfied; CR5 may legitimately start.

---

## 3. Capture surface — actual LOC + byte map (2026-05-26)

| File | Bytes | Role | CR5 status |
|---|---|---|---|
| `apps/web/app/(app)/capture/page.tsx` | 48,616 | Orchestrator shell | UPPER-pinned (current size); future extraction can only shrink |
| `apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts` | 34,411 | Upload + finalize orchestration | UPPER-pinned; **internal logic firewalled** |
| `apps/web/app/(app)/capture/_hooks/useResumableUploads.ts` | 13,423 | Resumable multipart driver | UPPER-pinned |
| `apps/web/app/(app)/capture/_hooks/useCaptureCamera.ts` | 12,473 | getUserMedia + photo/video | UPPER-pinned |
| `apps/web/app/(app)/capture/_hooks/useCaptureAudioRecorder.ts` | 8,978 | MediaRecorder audio | UPPER-pinned |
| `apps/web/app/(app)/capture/_lib/hash-utils.ts` | **3,302** | **Browser SHA-256 prep** | **BYTE-EXACT PIN** (deterministic contract) |
| `apps/web/app/(app)/capture/_lib/file-utils.ts` | 8,410 | Mime/type/quality derivation | UPPER-pinned |
| `apps/web/app/(app)/capture/_lib/folder-utils.ts` | 2,856 | Folder DnD | UPPER-pinned |
| `apps/web/app/(app)/capture/_lib/session-readiness.ts` | 9,864 | Required-step finalize gate | UPPER-pinned |
| `apps/web/components/capture-v2/CaptureSessionPanel.tsx` | 12,040 | Staged materials presentation | UPPER-pinned |
| `apps/web/components/ai/CaptureAiAssistant.tsx` | 23,045 | AI capture assistant (metadata-only) | UPPER-pinned |

### Backend firewalled (CR1.6 + CR5 byte pins)

| File | Bytes | Why forbidden |
|---|---|---|
| `services/api/src/routes/capture.routes.ts` | **18,308** | Upload protocol (CR1.6 pin) |
| `services/api/src/services/evidence-complete.service.ts` | **41,849** | Finalize transaction (CR1.6 pin) |
| `services/api/src/services/custody-events.service.ts` | **4,446** | `appendCustodyEventTx` single writer (CR1.6 pin) |
| `services/api/src/services/timestamp.service.ts` | **6,033** | TSA + OTS (CR1.6 pin) |

---

## 4. Current monolith boundaries

The Capture codebase is already MORE decomposed than the pre-CR4 Verify
monolith was — earlier phases (30.7, 30.10, 30.11, 30.12, 32.6, 32.8,
38.x) progressively extracted helpers into `_lib/*` and presentation
into `components/capture-v2/*`. The remaining concentration of
complexity is:

1. **`page.tsx` (1,429 LOC)** — orchestrator + heavy inline JSX +
   trigger wiring for camera/audio/AI/drafts/suggestions/readiness.
2. **`useCaptureSessionOrchestration.ts` (953 LOC)** — the upload +
   finalize orchestration hook. Mostly mutation logic
   (`runResumableItemUpload`, `runLegacyItemUpload`, finalize-once-per-batch
   coordination). The orchestration hook is **structurally already a
   single, well-bounded module** — extracting from it risks creating
   "competing state machines" that the CR5 prompt explicitly forbids.

The CR5 extraction target is therefore **page.tsx orchestrator
slimming**, not orchestration-hook splitting.

---

## 5. Highest-risk couplings (ranked)

| # | Coupling | Risk if mis-refactored | CR5 protection |
|---|---|---|---|
| 1 | Browser hash → server verify-on-complete contract | Treating the browser hash as canonical would break the integrity boundary | Byte-pin on `hash-utils.ts`; source-grep on `verifyHash: true` literal |
| 2 | `runResumableItemUpload` step ordering (create session → initiate multipart → drive chunks → verify+complete → session complete → batch finalize) | Reordering or splitting could finalize an unverified upload | UPPER-pin on `useCaptureSessionOrchestration.ts`; test for "finalize endpoint called exactly once per batch" |
| 3 | `addFilesToSessionRef` ref (single owner contract) | Two callers staging concurrently → race on hash + evidenceId | Tests pin ref single-owner pattern preserved |
| 4 | Required-step finalize gate (`session-readiness.ts`) | Bypass would let an incomplete checklist finalize | Byte-pin on `session-readiness.ts`; `buildSessionReadiness` export preserved |
| 5 | Camera/audio cancel handlers (`stop()` reachable from every exit path) | Leaked MediaStream on unmount race | Source-grep: `stop()` present in both device hooks |
| 6 | AI assistant boundary (metadata only) | Raw bytes leak to AI | Source-grep: zero `Blob`/`File`/`ArrayBuffer`/`Uint8Array`/`FileReader.readAsArrayBuffer` in capture AI surfaces |
| 7 | Report-readiness polling (read-only) | Polling emits download/custody events → fake REPORT_DOWNLOADED | Source-grep: only GET on polling paths; no `REPORT_DOWNLOADED` literal in frontend |
| 8 | External / delegated intake isolation | Token-scope escalation → cross-org browse | E8 contract test re-runs; CR5 extends with capture-side regex |
| 9 | Workflow intake → canonical `completeEvidence` path | Diverging path would create a second finalize | Tests pin single finalize endpoint reference in frontend |
| 10 | Resumable vs legacy upload dispatch (`routeFile` flag) | Drift between paths | UPPER-pin + dispatch single-callsite source-grep |

---

## 6. Finalize truth chain (canonical, preserved verbatim)

The browser **never** owns finalize truth. The chain:

1. **Browser hash prep** → `computeIntegrityFromBlob` (in `hash-utils.ts`, BYTE-EXACT) computes SHA-256 over the staged blob. Deterministic.
2. **Upload session create** → `POST /v1/uploads/sessions` with `idempotencyKey: \`capture:${evidenceId}:${index}\``. Server returns `sessionId`.
3. **Multipart initiate** → `POST .../multipart/initiate`. Server creates S3 multipart.
4. **Per-chunk drive** → `MultipartUploader` presigns → PUTs → marks uploaded. Browser never persists signed URLs.
5. **Multipart complete + verify** → `POST .../multipart/complete` with `verifyHash:true`. **Server** recomputes SHA-256 from S3 stream, rejects mismatches, marks parts VERIFIED, writes `EvidencePart`.
6. **Session complete** → `POST .../complete`. Session → COMPLETED.
7. **Batch finalize (once)** → `POST /v1/evidence/:id/complete`. The browser sends this exactly once per capture session for the whole batch.
8. **Custody chain** → `completeEvidence` (server) opens a tx, calls `appendCustodyEventTx` (advisory-lock, sequential hash chain). TSA + OTS submitted inside the same tx.

**Invariants pinned by CR5 Group 1 + 7:**

- `uploadedAt` is set by the server only (no frontend writes — confirmed via grep).
- `appendCustodyEvent` / `createCustodyEvent` / `emitCustodyEvent` are NEVER imported in frontend (confirmed via grep).
- The browser hash is for VERIFICATION, not truth — server recomputes.
- Finalize is called exactly once per capture session.
- Failed uploads never trigger finalize (resumable failure throws → caller surfaces error; no silent fallback to legacy).

---

## 7. Upload truth chain (canonical)

Identical to finalize chain steps 1–6 above. Additional invariants
pinned:

- The browser **never** synthesizes upload-success without a backend
  `complete` confirmation.
- Orphan uploads (session created but never completed) are bounded by
  E8 / E10.2 sweep semantics — frontend never silently "promotes" an
  orphan to a complete state.
- Duplicate finalize is blocked at the server (`evidence.routes.ts`
  status checks). CR5 pins the frontend never sends finalize twice
  without an explicit user gesture path that bypasses (which doesn't
  exist).

---

## 8. Custody-critical path (full inventory)

| Layer | Touch | Status |
|---|---|---|
| Browser hash compute | `_lib/hash-utils.ts:computeIntegrityFromBlob` | BYTE-EXACT pin |
| Browser upload session create + complete | `_hooks/useCaptureSessionOrchestration.ts:runResumableItemUpload` | UPPER-pin; mutation logic firewalled |
| Browser multipart driver | `_hooks/useResumableUploads.ts` | UPPER-pin |
| Server upload routes | `routes/capture.routes.ts` | Forbidden (18,308 byte pin) |
| Server complete-multipart hash verify | `services/evidence-complete.service.ts` | Forbidden (41,849 byte pin) |
| Server `completeEvidence` (single-writer tx) | Same | Forbidden |
| Server TSA + OTS (inside `completeEvidence`) | `services/timestamp.service.ts` | Forbidden (6,033 byte pin) |
| Custody chain append | `services/custody-events.service.ts:appendCustodyEventTx` | Forbidden (4,446 byte pin) |
| Report-readiness polling | Read-only fetch | Test pins no custody / download events emitted |

---

## 9. AI boundary path

| Touch | Status |
|---|---|
| `CaptureAiAssistant.tsx` payload construction | Source-grep: no `Blob` / `File` / `ArrayBuffer` / `Uint8Array` |
| Image/PDF/video bytes → AI | NEVER sent (E9 contract; CR5 re-pins) |
| GPS / location coords → AI | Bounded by per-capture consent flag; CR5 doesn't change |
| AI failure → capture flow | Capture continues; AI is advisory (E9 contract) |

---

## 10. State ownership map (Part 3, required matrix)

| State | Source of Truth | Reader | Writer | Lifecycle | Integrity Risk | Extraction Decision |
|---|---|---|---|---|---|---|
| Staged files | `page.tsx` `sessionItems` array | `page.tsx`, `CaptureSessionPanel`, `useCaptureSessionOrchestration` | `useCaptureSessionOrchestration.addFilesToSession` | per capture session | LOW (read-mostly post-stage) | DEFER — extraction risks two-owner state |
| Staged materials | Same `sessionItems` array (presentation projection) | `CaptureSessionPanel`, `CaptureRequirements` | (read-only) | per capture session | LOW | Already presentation-bound; no extraction needed |
| Hashes | `computeIntegrityFromBlob` (browser, deterministic) | upload pipeline | `useCaptureSessionOrchestration` (consumes only) | per file pre-upload | **HIGH if mis-extracted** | Byte-exact pin on `hash-utils.ts`; no extraction |
| Upload queue | `useResumableUploads` internal state | uploader, orchestrator | uploader | per file lifecycle | MEDIUM | UPPER-pin; no extraction |
| Upload progress | Per-item `progress` field on `SessionItem` | `CaptureSessionPanel`, `UploadOperationsPanel` | `useCaptureSessionOrchestration` (via setSessionItems) | per file | LOW | Read-only projection; presentation already extracted |
| Upload completion | Server-confirmed status (per-item `uploadedAt`) | All readers | Backend only | per file | **HIGH** | Pin: server-only writer (Group 1 test) |
| Failed uploads | Per-item error state on `SessionItem` | UI + retry logic | `useCaptureSessionOrchestration` | per attempt | LOW | UPPER-pin; presentation extraction safe |
| Retry uploads | Same — uses bounded-retry inside `useResumableUploads` | uploader | uploader | per attempt | LOW | UPPER-pin |
| Finalize state | Server (`Evidence.status`) | `page.tsx` (read-only) | Backend `completeEvidence` only | per capture session | **HIGH** | Pin: single endpoint reference (Group 1) |
| evidenceId | Server-issued | All callers | Backend create-evidence | per capture session | MEDIUM | Pin: never frontend-synthesized |
| Delegated tokens | E8-bounded (workflow intake / external review) | External surfaces | Backend (issue/revoke) | per grant | MEDIUM | E8 contract tests preserve isolation |
| Checklist template | `_lib/templates.ts` + `_hooks/useWorkflowTemplates` | `page.tsx` | (read-only) | per page load | LOW | Already extracted |
| Required steps | `session-readiness.ts:buildSessionReadiness` | `page.tsx`, `CaptureRequirements` | (derived only) | per session-items change | **MEDIUM** | Byte-pin on `session-readiness.ts` |
| Optional steps | Same | Same | (derived only) | per session | LOW | Same pin |
| Metadata hints | Per-item hint fields | UI | `useCaptureSessionOrchestration` | per item | LOW | Already in `_lib` |
| Location state | `useLocation` flag + per-batch capture | `page.tsx` | `page.tsx` | per session | LOW (anonymous-default) | No extraction |
| Camera state | `useCaptureCamera` internal state + MediaStream ref | Overlay | hook | per capture | MEDIUM (stream leak risk) | UPPER-pin; cancel-reachable test |
| Audio state | `useCaptureAudioRecorder` internal state | Bar | hook | per recording | MEDIUM | UPPER-pin; cancel-reachable test |
| AI metadata | Page-context object passed to `CaptureAiAssistant` | AI assistant | `page.tsx` | per page | **HIGH if bytes leak** | Source-grep: no Blob/File/Buffer (Group 5) |
| Report polling | Polling effect inside `page.tsx` | Polling effect | (read-only) | per evidenceId | LOW | Source-grep: GET-only (Group 6) |
| Report readiness | Server (`Evidence.reportGeneratedAtUtc`) | `page.tsx` | Backend | per evidence | LOW | Pin: read-only |
| Report links | Server-issued share path | `page.tsx` | Backend | per evidence | LOW | Pin: URL shape stable |

---

## 11. Extraction order (Part 4 — strategy)

CR5 follows the layered approach the prompt mandates:

**Layer A — Pure helpers** (`apps/web/components/capture-v2/_helpers.ts`)
- Scope: deterministic / formatting / mapping / validation helpers that
  take primitive inputs.
- Risk: very low (no JSX, no orchestration, no domain types beyond
  re-exported types).
- Most of this work has already been done across the 38.x phases (the
  `_lib/*` modules already host `file-utils`, `folder-utils`,
  `hash-utils`, `session-readiness`, `session-workflow`,
  `capture-errors`, `templates`, `workflow-context`,
  `workflowTemplateOrder`, etc.). CR5's Layer-A contribution is bounded
  to anything remaining in `page.tsx` orchestrator that qualifies as a
  pure helper.

**Layer B — Presentation components** (`apps/web/components/capture-v2/`)
- Scope: presentation-only components (no side effects, no fetch, no
  localStorage).
- Already extracted: `CaptureSessionPanel`, `CaptureDropzone`,
  `CaptureRequirements`, `CaptureCameraOverlay`, `CaptureBottomBar`.
- CR5's Layer-B contribution: documented as DEFERRED to a follow-on
  bounded phase — the current presentation extraction has already
  reached a sensible boundary; further extraction would require
  threading types + brand constants the same way CR4 deferred to
  DEF-052.

**Layer C — Safe hooks** (`apps/web/app/(app)/capture/_hooks/*`)
- Already extracted: `useCaptureSessionOrchestration`,
  `useResumableUploads`, `useCaptureCamera`, `useCaptureAudioRecorder`,
  `useCaptureDraftList`, `useCaptureDraftPersistence`,
  `useIntakeTemplates`, `useWorkflowTemplates`.
- CR5's Layer-C contribution: no new hooks. The prompt forbids
  "duplicated orchestration state machines" / "duplicated finalize
  state" / "duplicate upload truth" — splitting
  `useCaptureSessionOrchestration` would create exactly the kind of
  fragmentation the prompt warns against.

**The primary CR5 deliverable is the test wall** — it is what makes
ALL future capture work safe.

---

## 12. Forbidden extraction zones (Part 4 — what NEVER moves)

- Anything in `hash-utils.ts` (byte-exact pin)
- Anything that calls `apiFetch` with a non-GET verb (mutation)
- The `runResumableItemUpload` / legacy-upload step ordering
- The `addFilesToSessionRef` ref-passing pattern
- The `requiredSteps`-derived finalize gate
- The `CaptureAiAssistant` payload construction (must remain metadata-only)
- Any backend file (byte pins enforce this)

---

## 13. Test strategy (Part 2 — preview)

`services/api/test/phase-cr5-capture-safety.test.ts` — 10 mandatory
groups + meta sanity check. Cases iterate over the full set of
"capture surface" files via auto-discovery, so future extractions
automatically inherit every safety group.

See doc §14 below + the test file itself for full inventory.

---

## 14. Test groups (Part 2 — mandatory)

| Group | Topic | Anchors |
|---|---|---|
| 1 | Upload truth | `uploadedAt` server-only; failed uploads never finalize; finalize once per batch; finalize-endpoint reference pinned |
| 2 | Integrity preparation | `hash-utils.ts` byte-exact; `computeIntegrityFromBlob` export; `verifyHash:true` literal preserved; `planChunks` import preserved |
| 3 | Checklist enforcement | `session-readiness.ts` byte-pinned; `buildSessionReadiness` export; no bypass shortcut |
| 4 | Delegated capture | External-intake route byte-pins; no browsing-escalation in capture tree; revocation paths preserved |
| 5 | AI boundary | No `Blob`/`File`/`ArrayBuffer`/`Uint8Array`/`FileReader.readAsArrayBuffer` in capture AI surfaces |
| 6 | Polling correctness | Polling uses GET only; no `REPORT_DOWNLOADED` / `report_viewed` literals from capture tree |
| 7 | Custody truth | No `appendCustodyEvent` / `createCustodyEvent` / `emitCustodyEvent` import in any capture file; backend pin |
| 8 | Capture safety | Camera/audio hooks expose `stop()`; cancel handlers reachable; no auto-finalize on stop |
| 9 | External intake | `completeEvidence` is the canonical finalize path (single endpoint reference); no privilege-escalation pattern |
| 10 | Forbidden patterns | Frontend custody creation, frontend finalize truth, raw AI file upload, browser timestamp truth, direct storage URL exposure |
| Meta | Sanity | Test harness pre-conditions; file fixtures load |

---

## 15. Rollback strategy

CR5 ships zero backend changes. Frontend extractions (if any) ship as
additive imports + inline-declaration removals, all protected by:

1. Web typecheck (caught at PR-time)
2. Web build (caught at PR-time)
3. The CR5 source-contract suite (caught at PR-time)
4. Git revert if needed (no migrations, no data changes)

Hard rollback path: `git revert` of the CR5 commit set. Backend behavior
unchanged in either direction.

---

## 16. Documentation + registry plan

- This document — full state ownership map + extraction plan + test
  inventory.
- `MASTER_PHASE_REGISTRY.md` — CR5 row added on closure with honest
  status + any new DEFs.
- DEF-052 (CR4 verify decomposition continuation) remains tracked.
- Likely new DEF: capture orchestrator further-decomposition tracked as
  POST_LAUNCH / PRESENTATION_REFACTOR with the same auto-discovery
  safety net.

---

## 17. Validation results

Full CR1.7 §11 7-step validation, 2026-05-26:

| Step | Command | Result |
|---|---|---|
| 1 | `pnpm exec prisma generate` | ✅ Pass |
| 2 | `pnpm --filter proovra-api typecheck` | ✅ Pass |
| 3 | `pnpm vitest run` (api full) | ✅ **9437 passed** / 51 skipped (200 files; +888 new CR5 cases) |
| 4 | `pnpm --filter proovra-web typecheck` | ✅ Pass |
| 5 | `pnpm --filter proovra-web build` | ✅ Pass |
| 6 | `pnpm --filter proovra-worker typecheck` | ✅ Pass |
| 7 | `pnpm --filter proovra-worker test` | ✅ 203 passed |

**CR5 test wall**: 888 cases across 10 mandatory groups + meta sanity.
All groups pin source-level guarantees AND auto-discover newly-added
files in the capture tree, so future capture refactors automatically
inherit every safety property.

---

## 18. Remaining risks

- The 953-LOC `useCaptureSessionOrchestration.ts` hook is the
  highest-density mutation surface. CR5 protects it with an UPPER-pin
  and per-pattern source-greps but does **not** split it (prompt
  forbids "duplicated orchestration state machines"). A future bounded
  phase can extract pure upload-state derivation helpers from it if
  needed.
- The 1,429-LOC `page.tsx` orchestrator remains substantial. The
  test wall protects it; further presentation extraction is
  POST_LAUNCH and the safety contract auto-covers any new
  `capture-v2/*` file.

---

## 19. Next-phase recommendation

CR5's primary deliverable is the **888-case test wall** — the durable
safety guarantee for ALL future capture work. CR5 ships ZERO backend
changes and ZERO new presentation extractions (the Layer-A surface was
already consumed by prior 38.x phases that moved helpers to `_lib/*`,
and Layer-B/C would create the "competing state machines" the prompt
explicitly forbids).

Two viable next phases (operator's choice):

1. **CR4.1 — Verify Decomposition Continuation** (closes DEF-052).
   Lower stakes; mechanical. The 175-case CR4 contract auto-discovers
   any new `verify-v2/*` file.

2. **A future bounded phase to extract additional capture
   presentation** (DEF-053 — see below). The 888-case CR5 contract
   auto-discovers any new `capture-v2/*` file, so future extraction is
   safety-protected.

If both are desired: CR4.1 first (lower risk, mechanical), then capture
presentation extraction (higher value, but the existing decomposition
is already substantial — the marginal win is smaller than CR4's was).
