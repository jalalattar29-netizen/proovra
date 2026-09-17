# UC-3 — ANDROID CONTINUOUS / STREAMING SCREEN CAPTURE

## Status (multi-field — never collapse to one "all green")

| Field | Value |
| --- | --- |
| IMPLEMENTATION (code/architecture) | **COMPLETE** |
| TARGETED VALIDATION (unit/integration/contract/gates) | **PASS** |
| ANDROID DEVICE ACCEPTANCE | **DEFERRED** (no emulator/device in this environment; not PASS) |
| PUBLICATION READINESS | **PENDING** (store listing, icons, counsel-reviewed disclosures) |
| PRODUCTION | **NOT DEPLOYED** |
| UC-4 READINESS | **MAY BEGIN** (segments are ORIGINAL; keyframes/OCR/reconstruction are DERIVED = UC-4, not implemented) |

Date: 2026-09-17. Precondition: UC-0 + UC-1 + UC-2 CODE/ARCHITECTURE COMPLETE.

> **UC-3 CODE/ARCHITECTURE COMPLETE · ANDROID DEVICE ACCEPTANCE DEFERRED.** The
> native MediaRecorder segmented recording is real code but has not been run on an
> Android device/emulator here; that is deferred device validation, not a pass.

## 1. Architecture — one evidence truth, extended not duplicated

UC-3 is a new acquisition ADAPTER on the SAME canonical UC-0 direct-capture spine
UC-1/UC-2 use. It creates NO second Evidence pipeline, custody chain, authorization
authority, integrity authority, commercial calculator, CaptureSession, or
completion authority, and NO `ContinuousEvidence`/second model. **ONE logical
continuous session = ONE Evidence Record** (N ORIGINAL segment artifacts + ONE
`CAPTURE_MANIFEST`), never one Evidence per segment/chunk/minute.

End-to-end path (the PROOVRA session opens at START so segments stream WHILE
recording — never a giant in-memory recording):

```
Android app: Continuous Screen Capture
  → native MediaProjection consent (system dialog)
  → POST /v1/capture/direct-sessions {mode: DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS}  (server session, at START)
  → POST …/:id/evidence                                                                (reserve ONE Evidence, VIDEO)
  → bounded foreground-service MediaRecorder recording, split into short mp4 SEGMENTS
     (native setMaxDuration rollover), each finalized segment streamed out:
        per segment: POST …/parts/:seq/declaration (client SHA-256)
                   + POST /v1/evidence/:id/parts (presign) + PUT (bytes to storage, not RAM/JSON)
  → on Stop: drain pending uploads
  → build PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V1, upload + declare it (CONTINUOUS_MANIFEST)
  → POST …/:id/continuous-complete {manifestJson}
      completeContinuousCaptureSession → validates manifest, ties it to bytes by digest,
      cross-checks 1:1 with declared segment parts, then completeDirectCapture → completeEvidence
      (server recomputes EVERY segment digest, seals, one CAPTURE_SESSION_BOUND)
  → Evidence → integrity → custody → Library → Detail → Case → Search → Report
     → Verification Package → Package Validator → Public Verify → retention/hold/destruction.
```

## 2. Android native implementation (files)

A local Expo module (Expo SDK 52 managed/prebuild), Android-only, EXTENDS the UC-2
module (both frame and continuous flows share one module + consent/notification
pattern):

- `apps/mobile/modules/proovra-screen-capture/index.ts` — typed JS binding; UC-3
  adds `isScreenContinuousSupported`, `getScreenContinuousState`,
  `startContinuousCapture` (clamps `segmentMs` 2000–30000, `maxSegments` 1–600),
  `stopContinuousCapture`, and `onScreenSegment` / `onScreenContinuousStopped`
  event subscriptions.
- `.../android/.../ProovraScreenCaptureModule.kt` — one Expo module for BOTH flows;
  launches MediaProjection **consent** and, on grant, routes a `continuous` request
  to `ContinuousScreenCaptureService`; fails closed if consent is denied; refuses a
  second concurrent capture.
- `.../android/.../ContinuousScreenCaptureService.kt` — a **foreground service**
  (type `mediaProjection`) that becomes foreground with a visible notification
  BEFORE creating the projection (Android 14 ordering), records via **MediaRecorder**
  (`VideoSource.SURFACE`, **no audio**), splits on `setMaxDuration(segmentMs)`
  rollover — finalize current mp4 to `cacheDir`, emit `onSegment`, repoint the
  `VirtualDisplay` surface, start the next — up to `maxSegments` (`BOUNDS_REACHED`).
  Stops on the notification **Stop** action / `stop()` / bound reached / OS
  revocation (`PERMISSION_REVOKED`), and reports `sessionCompleteness`
  (`COMPLETE_SESSION` / `INTERRUPTED_SESSION`).
- `apps/mobile/src/continuous-capture.ts` — orchestrates the streaming upload
  through the SAME `direct-capture.ts` client (pure `buildContinuousManifest` /
  `deriveSessionCompleteness`; `beginContinuousSession`; `uploadContinuousSegment`
  with bounded retry; `finalizeContinuousCapture`).
- `apps/mobile/src/continuous-capture-flow.ts` — the PURE, TOTAL UI reducer.
- `apps/mobile/app/(stack)/continuous-capture.tsx` — user-initiated screen
  (intro/disclosure → active → review → finalizing → success/error); respects the
  Personal-Space gate; Android-only entry from the home hero.

**Prebuild implication:** the native service + manifest additions require an
`expo prebuild` / EAS Build (no committed `android/`).

## 3. Consent / anti-surveillance

User-initiated only. Android's own MediaProjection consent dialog gates every
session; **nothing is recorded before it is granted**. A visible foreground-service
notification with a **Stop** action runs while active, so **the user can stop
without returning to the app**. No silent/background start, no hidden auto-restart,
no Accessibility Service, no overlay/`SYSTEM_ALERT_WINDOW`, no `FLAG_SECURE` bypass
(secure regions are blank and disclosed as `SECURE_CONTENT_OMITTED`). Screen-only:
NO microphone/audio is recorded.

## 4. Bounded / streaming discipline (technical safety limits ≠ entitlements)

Enforced in native + shared + server, NONE of which is a subscription limit:
per-segment duration (2–30 s) and the on-disk mp4 segment ceiling; total session
bound `maxSegments` (≤ 600) so a bounded session fits inside the CaptureSession
TTL; bounded pending-upload draining; bounded per-segment retry (2, backoff);
server manifest JSON ceiling (512 KiB). Bytes go to disk then storage — never RAM,
base64 or JSON bodies. Local temp segments live in `cacheDir`.

## 5. Acquisition mode

`DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS` — the THIRD `isDirectCapture: true`
mode (`packages/shared/src/evidence-acquisition.ts`), a distinct set-once mode (it
does NOT overload `DIRECT_SCREEN_CAPTURE_ANDROID`). Persisted, set-once (DB
trigger), server-set, resolved only through `resolveEvidenceAcquisition`, category
reused `DIRECT_SCREEN_CAPTURE`. Adds limitation `SCREEN_SESSION_CONTINUITY_LIMITED`
on top of the UC-2 screen limitations. DB CHECK constraints widened by migration
(§10).

## 6. Segment / continuity model — `PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V1`

`packages/shared/src/screen-continuous-manifest.ts`: bounded, strictly validated
server-side. Deterministic and continuity-honest:

- **Session binding:** `captureSessionId` (checked against the session).
- **Explicit ordering:** each segment has a 0-based `partIndex` and a **contiguous
  0-based `sequence`**; the validator REJECTS a gap
  (`"segment sequence numbers are not contiguous from 0"`) — a missing segment
  cannot present as continuous. Duplicate `partIndex`/`sequence` rejected.
  Out-of-order arrival is safe (sorted; the set must still be 0..N-1).
- **Server-authoritative digest:** `expectedSha256` is a client CLAIM; the server
  recomputes each segment's SHA-256 and fails closed on mismatch (no ignore).
- **COMPLETE_SESSION vs INTERRUPTED_SESSION:** `sessionCompleteness` +
  `terminationReason`; no continuity is claimed across a known gap; an interrupted
  session is preserved and labelled interrupted, never as complete.
- **Privacy by omission:** coarse device/display + segment structure only — NO app
  inventory, notification contents, clipboard, contacts, or hardware identifiers.

## 7. ORIGINAL vs DERIVED

Segments are `screen_segment` ORIGINAL parts (the bytes the adapter produced) + one
`CAPTURE_MANIFEST` part. Keyframes, OCR and conversation reconstruction are DERIVED
= **UC-4, NOT implemented here**.

## 8. Interruption / recovery

Resume ≠ upload retry. A crash/revocation ends the session as `INTERRUPTED_SESSION`;
segments already streamed are preserved (they were uploaded during recording), and
the manifest records the interruption. The reducer (`continuous-capture-flow.ts`)
is TOTAL: a stopped session never appears successful without an explicit Finalize,
and an out-of-phase event never corrupts state. `getScreenContinuousState()`
reconnects the UI to the SAME native session (never a new CaptureSession).

## 9. Digest / attestation / authorization / commercial

Identical trust boundary to UC-0/1/2: server recomputes digests, seals only on
match. The session is UNBOUND (no device key) — no Android attestation, never
labelled `VERIFIED_*`; carries `SCREEN_DEVICE_INTEGRITY_NOT_VERIFIED`. Every server
op runs canonical `requireAuth` + `authorizeOrFail(evidence.create)` + ownership +
commercial lifecycle (`assertWorkspaceAllowsEvidenceCreation`); no capture-specific
plan is invented; the capability is plan-blind and inherits eligibility.

## 10. Migration

`20280640000000_uc3_continuous_screen_capture_acquisition_mode` — EXPAND /
SAFE_TO_APPLY_NOW, apply BEFORE the UC-3 image. Widens the two `acquisition_mode`
CHECK constraints (`evidence_acquisition_mode_check`,
`capture_sessions_acquisition_mode_check`) to admit
`DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS` (a constraint SWAP, non-destructive —
recognised by `constraintDropsAreAllSwaps`, so no phase-o allowlist needed).
Registered in: p6 curation + regenerated inventory (0 gate failures), deployment
plan, phase-32-7-2 allowlist, release-materialize PROPOSED_ADDITIONS. Clean-boot
from empty + idempotent, rehearsed on disposable PostgreSQL 16. **NOT APPLIED TO
PRODUCTION.**

## 11. Downstream / claims

All downstream surfaces (Library, Detail/Inspector, Case, Search — no auto OCR,
Report V2, Verification Package, Package Validator representing ALL ORIGINAL
segments, Public Verify, storage/retention/legal-hold/destruction) read the ONE
acquisition authority and canonical lifecycle, so UC-3 flows through them with no
new plumbing (the existing "Screen capture" category covers it; the server filter
is generic). Public Verify shows the neutral "Recorded from an Android screen with
PROOVRA" as a neutral block, domain-free and device-free. **Claim safety:** the
descriptor asserts only that PROOVRA acquired and preserved this screen-capture
session through an Android MediaProjection-authorized acquisition session and that
server-side integrity verification was applied; it carries
`SCREEN_CONTENT_TRUTH_NOT_PROVEN`, `SCREEN_SOURCE_APP_NOT_PROVEN`,
`SCREEN_DEVICE_INTEGRITY_NOT_VERIFIED`, `SCREEN_SESSION_CONTINUITY_LIMITED`. It does
NOT establish truth/identity/authorship/origin/device integrity/complete
context/admissibility. No "authentic/verified/tamper-proof".

## 12. Capability-map note (route registration)

`POST /v1/capture/direct-sessions/:id/continuous-complete` is declared
PRODUCT_CONNECTED in `route-dispositions.json` (consumer
`apps/mobile/src/continuous-capture.ts`). Its two mobile UI call sites build a
runtime capture-session path that cannot be static (the session is opened at START
for streaming), so both are recorded in `dynamic-resolutions.json` — the same
reviewed treatment every runtime-session path requires. Deltas from the pre-UC-3
tree: +1 route, +1 writer; `DynamicUnresolvedConsumers 0`, `UndisposedRoutes 0`,
`MutationClosurePass true`, `AuditEngineIntegrity PASS`.

## 13. Button / navigation contract matrix (code-backed)

| Control | File | Visible when | Handler → authority | Success dest | Failure dest |
| --- | --- | --- | --- | --- | --- |
| Continuous Screen Capture (entry) | app/(tabs)/index.tsx | Android home hero | router.push("/continuous-capture") | screen | — |
| Start Continuous Capture | (stack)/continuous-capture.tsx | intro | beginContinuousSession → startContinuousCapture → native consent | active | error(denied) |
| Cancel | continuous-capture.tsx | intro | router.back() | Capture | — |
| (segment stream) | continuous-capture.tsx | active | onScreenSegment → uploadContinuousSegment | captured/uploaded++ | toast (segment) |
| Stop (notification) | ContinuousScreenCaptureService.kt | active (backgrounded) | ACTION_STOP | review | — |
| Stop & Review | continuous-capture.tsx | active | stopContinuousCapture → drain uploads | review | error |
| Finalize Evidence | continuous-capture.tsx | review | finalizeContinuousCapture → continuous-complete | success | error |
| Discard | continuous-capture.tsx | review | RESET (pre-finalize cleanup) | intro | — |
| View Evidence | continuous-capture.tsx | success | router.replace(`/evidence/:id`) | Evidence Detail | — |
| Capture Another | continuous-capture.tsx | success | RESET (fresh session) | intro | — |
| Done | continuous-capture.tsx | success | router.back() | Capture | — |
| Try Again | continuous-capture.tsx | error(recoverable) | RESET | intro | — |
| Back to Capture | continuous-capture.tsx | error | router.back() | Capture | — |

No placeholder/TODO/console-only handlers; every state is reachable and total.
Discard is pre-finalize cleanup (no sealed Evidence) — distinct from post-seal
destruction, which is the canonical lifecycle.

## 14. Tests

- shared: **945/0** (adds the continuous-manifest validator suite incl. the
  non-contiguous-sequence continuity assertion + updated acquisition
  partition/direct-capture assertions for the third direct-capture mode).
- API integration `uc3-continuous-capture.integration.test.ts`: **5/5** live PG16
  on a fresh clean-boot DB (seal ONE Evidence from 3 segments + manifest = 4 parts,
  server-set mode, bound once, Library `DIRECT_SCREEN_CAPTURE`, idempotent;
  refusals: omitted segment → `CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH`,
  non-contiguous sequence → `CONTINUOUS_MANIFEST_INVALID`, session mismatch →
  `CONTINUOUS_MANIFEST_INVALID`, continuous-completing a UC-2 frame session →
  `UNSUPPORTED_MODE`, forged mode → 400/422).
- mobile **23/23** (7 new continuous reducer cases + 8 UC-2 reducer + 8 deep-link)
  + mobile typecheck GREEN.
- Migration gates (phase-o, db-010, phase-32-7-2, migration-chain-order,
  point6 closure, point8 manifest/artifact): **all PASS**.
- API/worker/web typecheck GREEN; architecture audit `AuditEngineIntegrity PASS`.

## 15. Deferred validation

**ANDROID DEVICE ACCEPTANCE: DEFERRED.** The native MediaRecorder segmented
recording has not run on an Android device/emulator here. Run it on a real Android
build (EAS / prebuild) to validate consent, the foreground service, segment
rollover, orientation change, the bound, the zero-segment path, and OS-revocation
mid-recording end to end. Not faked as PASS.

## 16. Remaining risks

- **P0/P1:** none.
- **P2:** device-side recording edge cases (secure-content detection is
  best-effort; codec/bitrate availability varies) are disclosed via limitations,
  not silently dropped.
- **P3:** UI is functional, not fully themed; report/package worker buffers evidence
  bytes (bounded by the canonical 1 GiB cap — see §17); a defensive worker-side
  size assertion could be added.

---

## 17. FINAL RESOURCE / RECOVERY / DOWNSTREAM CLOSURE (2026-09-18)

A narrow closure pass hardened the resource, backpressure, temp-file and downstream
paths that the first report asserted but did not fully prove. All bounds now trace
to ONE authority: `SCREEN_CONTINUOUS_STREAM_BOUNDS`
(`packages/shared/src/screen-continuous-manifest.ts`), shared by the JS binding and
streaming client, and kept in agreement by value with the native Kotlin constants.

### A. Resource-bound matrix (authority → value)

| Bound | Authority | Value |
| --- | --- | --- |
| max segment duration | `STREAM_BOUNDS.maxSegmentMs`; native `setMaxDuration` | 30 s (min 2 s) |
| max segment bytes | native `MAX_SEGMENT_BYTES` = `STREAM_BOUNDS.maxSegmentBytes`; `setMaxFileSize` → rollover | 64 MiB (defence-in-depth; ~22 MB at 6 Mbps/30 s in practice) |
| max total session duration | native `MAX_SESSION_MS` = `STREAM_BOUNDS.maxSessionMs` | 50 min (below the 1 h session TTL) |
| max total session bytes | `STREAM_BOUNDS.maxSessionBytes`; client controlled-stop | 512 MiB (< canonical 1 GiB completion cap) |
| max pending segments (backlog) | `STREAM_BOUNDS.maxPendingSegments`; `shouldStopForBackpressure` | 8 |
| upload concurrency | `STREAM_BOUNDS.uploadConcurrency`; worker pump | 1 |
| upload retries | `STREAM_BOUNDS.uploadRetries` | 2 |
| retry backoff | `STREAM_BOUNDS.retryBackoffMs` × attempt | 500 ms × n |
| encoder bitrate | native `BITRATE` = `STREAM_BOUNDS.videoBitrateBps` | 6 Mbps |
| frame rate | native `FRAME_RATE` = `STREAM_BOUNDS.videoFrameRate` | 12 fps |
| capture resolution | native display metrics (device screen) | device WxH (fixed for the session) |
| maxSegments | `STREAM_BOUNDS.maxSegments`; native `maxSegments` | 600 |

These are technical safety limits, NOT commercial entitlements.

### B. Backpressure

Recorded segments enter a queue drained by a fixed number of upload workers
(`uploadConcurrency` = 1), so in-flight uploads and the transient per-segment
hashing buffer cannot grow without bound. When the recorded-but-unuploaded backlog
reaches `maxPendingSegments`, OR the uploaded-bytes total reaches `maxSessionBytes`,
the client triggers a **controlled stop** (`requestControlledStop`) — native stops
emitting, the queue drains, the session seals COMPLETE with the truthful limitation
(`SEGMENT_UPLOAD_BACKPRESSURE` / `SESSION_BOUNDS_REACHED`). No unbounded RAM, no
unbounded temp disk, no unbounded promises, no silent drop. If a segment ultimately
fails upload, its sequence is absent from the manifest and the server's contiguity
check refuses the seal (fail closed) — it never becomes a COMPLETE with a gap.

### C. Temp-file lifecycle

Segments record to app-private `cacheDir` with deterministic session-scoped names
(`proovra-continuous-<startedAtMs>-<seq>.mp4`) — never the public gallery. Each
segment file is deleted **only after** its bytes are durably in storage (PUT 200)
and its size was already measured; completion re-hashes from storage, never the
device, so deletion is safe. Discard (`cleanupContinuousTempFiles`) removes any
not-yet-uploaded segment files pre-finalize; the manifest temp file is removed after
a successful seal. A killed process leaves at most the in-flight segments in the OS
cache, which the OS reclaims — no indefinite accumulation.

### D. Process / service death

Native `onDestroy` → `finish("INTERRUPTED")`; MediaProjection `onStop` (revocation)
→ `PERMISSION_REVOKED`; encoder failure → `ERROR`. All non-clean reasons mark
`INTERRUPTED_SESSION` with `CAPTURE_INTERRUPTED` — a known interruption is **never**
COMPLETE. Segments already streamed are preserved server-side. An abandoned session
is not orphaned: the server-issued CaptureSession has a TTL (default 1 h) and any
later request flips an expired session to `INTERRUPTED`
(`direct-capture-ingest.service.ts`); `MAX_SESSION_MS` (50 min) guarantees a live
session stops with margin to finalize before that TTL. Resume is not attempted
across a projection break (continuity would be lost); the user starts a fresh
session.

### E. Orientation / display change

The recording surface stays at the session's initial geometry and `AUTO_MIRROR`
scales rotated content into it — never corrupted, just letterboxed. A rotation is
detected at each segment boundary (`orientationChangedFromStart`) and flagged once
with `ORIENTATION_CHANGED_DURING_CAPTURE`. Geometry reconfiguration mid-session is
DIFFERENT-BY-DESIGN (not attempted) and documented rather than faked.

### F. Secure content / screen lock

DIFFERENT-BY-DESIGN: MediaProjection returns blank frames for `FLAG_SECURE`
surfaces and honours screen lock; PROOVRA does not bypass either and uses no
Accessibility. PROOVRA does **not** claim to reliably distinguish blank protected
content, so it does not assert `SECURE_CONTENT_OMITTED` on a guess — the limitation
code exists for a future reliable detector. No false statement that protected
content was acquired.

### G. Large-evidence downstream memory

The Report/Verification-Package worker buffers evidence part bytes in memory
(`processor.ts` `streamToBuffer` into `verificationEvidenceFiles`/`loadedArtifacts`;
`verification-package.ts` `Buffer.concat`), so peak ≈ total evidence bytes. This is
**bounded** by the ONE canonical cap `MAX_EVIDENCE_SIZE_MB` (default 1 GiB total),
enforced fail-closed at `completeEvidence` — the single completion path every ingest
route funnels through, including continuous-complete → `completeDirectCapture` →
`completeEvidence`. UC-3's `maxSessionBytes` (512 MiB) is deliberately set below that
cap (with headroom for the backlog + manifest), so a sealed continuous session is
always under it and therefore always packageable, reportable and destroyable — the
worker never sees a UC-3 payload larger than any other sealed evidence. Download /
export is streamed via presigned URLs (no buffering). A defensive worker-side size
assertion is noted as an optional P3 backstop.

### H. Package / validator completeness

The completion service cross-checks manifest segments ↔ declared parts 1:1 on
partIndex AND digest (`continuous-capture.service.ts`), the shared validator refuses
a non-contiguous or duplicate sequence, and `completeEvidence` recomputes every part
digest from storage. The canonical package embeds every ORIGINAL part under
`evidence-parts/` plus `evidence-manifest.json`. New tests cover missing / omitted,
non-contiguous, duplicate sequence, digest substitution (manifest ≠ declared),
out-of-order upload (still seals), stored-byte tamper (server recompute fails
closed), session mismatch, unsupported/forged mode.

### I. Storage / governance

Part-generic and canonical (verified by read): destruction (`executeEvidence
destruction` → `enumerateStorageTargets` iterates `evidencePart.findMany` + reports
+ packages + derived assets) destroys and counts every segment + manifest; storage
accounting reads `Evidence.sizeBytes` which stores the summed multipart total;
legal hold blocks destruction via the one hold authority. No UC-3-specific
governance.

### J. Authorization / commercial mid-session

Every segment declaration, part presign and continuous-complete re-runs canonical
`requireAuth` + session ownership + evidence-creation commercial gate — client state
is never authority. A mid-session revocation makes subsequent calls fail closed;
uploaded bytes remain in the workspace-owned evidence (not leaked to the actor's
gallery), and local temp files are cleaned on discard. No shadow commercial logic.

### K. ONE Evidence

Re-proven by test `seals a continuous session … bound once` and the out-of-order
test: 1 session → N `screen_segment` ORIGINAL parts + 1 `CAPTURE_MANIFEST` →
exactly ONE Evidence, one `CAPTURE_SESSION_BOUND`. No Evidence creation in the
per-segment loop (segments only declare + upload; the single reserve happens once in
`beginContinuousSession`).

---

**UC-3 CODE/ARCHITECTURE COMPLETE · FINAL CLOSURE COMPLETE · ANDROID DEVICE ACCEPTANCE DEFERRED · UC-4 MAY BEGIN.**
Not deployed to Production; not published to the Play Store.
