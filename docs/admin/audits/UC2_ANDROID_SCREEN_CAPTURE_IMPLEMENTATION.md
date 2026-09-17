# UC-2 — ANDROID DIRECT SCREEN CAPTURE

## Status (multi-field — never collapse to one "all green")

| Field | Value |
| --- | --- |
| IMPLEMENTATION (code/architecture) | **COMPLETE** |
| TARGETED VALIDATION (unit/integration/contract/gates) | **PASS** |
| ANDROID DEVICE ACCEPTANCE | **DEFERRED** (no emulator/device in this environment; not PASS) |
| PUBLICATION READINESS | **PENDING** (store listing, icons, counsel-reviewed disclosures) |
| PRODUCTION | **NOT DEPLOYED** |
| UC-3 READINESS | **MAY BEGIN** (shared acquisition primitives stable; UC-2 adds no P0/P1) |

Date: 2026-09-17. Precondition: UC-0 + UC-1 CODE/ARCHITECTURE COMPLETE.

> **UC-2 CODE/ARCHITECTURE COMPLETE · ANDROID DEVICE ACCEPTANCE DEFERRED.** The
> native MediaProjection capture is real code but has not been run on an Android
> device/emulator here; that is deferred device validation, not a pass.

## 1. Architecture — one evidence truth, extended not duplicated

UC-2 is a new acquisition ADAPTER on the SAME canonical UC-0 direct-capture spine
UC-1 uses. It creates NO second Evidence pipeline, custody chain, authorization
authority, integrity authority, commercial calculator or CaptureSession.

End-to-end path:

```
Android app: Direct Screen Capture
  → native MediaProjection consent (system dialog)
  → bounded foreground-service frame capture (PNG frames in app cache)
  → POST /v1/capture/direct-sessions {mode: DIRECT_SCREEN_CAPTURE_ANDROID}   (server session)
  → POST …/:id/evidence                                                       (reserve ONE Evidence)
  → per frame: POST …/parts/:i/declaration (client SHA-256) + POST /v1/evidence/:id/parts (presign) + PUT
  → build PROOVRA_SCREEN_CAPTURE_MANIFEST_V1, upload + declare it (SCREEN_MANIFEST)
  → POST …/:id/screen-complete {manifestJson}
      completeScreenCaptureSession → validates manifest, ties it to bytes by digest,
      cross-checks 1:1 with declared parts, then completeDirectCapture → completeEvidence
      (server recomputes EVERY frame digest, seals, one CAPTURE_SESSION_BOUND)
  → Evidence → integrity → custody → Library → Detail → Case → Search → Report
     → Verification Package → Package Validator → Public Verify → retention/hold/destruction.
```

## 2. Android native implementation (files)

A local Expo module (Expo SDK 52 managed/prebuild), Android-only:

- `apps/mobile/modules/proovra-screen-capture/index.ts` — typed JS binding
  (`isScreenCaptureSupported`, `requestConsentAndCapture`, `stopScreenCapture`).
- `.../android/.../ProovraScreenCaptureModule.kt` — the Expo module: launches the
  MediaProjection **consent** intent and, on grant, hands the token to the service;
  fails closed if consent is denied.
- `.../android/.../ScreenCaptureService.kt` — a **foreground service** (type
  `mediaProjection`) that becomes foreground with a visible, user-dismissable
  notification BEFORE creating the projection (Android 14 ordering), captures up
  to `maxFrames` PNG frames at `intervalMs` via `ImageReader` + `VirtualDisplay`,
  stops on the notification Stop action / `stop()` / bound reached / OS
  revocation, and reports frames + coarse context + the reason it stopped.
- `.../android/src/main/AndroidManifest.xml` — declares
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`,
  `POST_NOTIFICATIONS` and the foreground `<service>`. Merged at prebuild.
- `apps/mobile/src/screen-capture.ts` — orchestrates the native capture through
  the SAME `direct-capture.ts` upload/completion client (mode parameterised).
- `apps/mobile/app/(stack)/screen-capture.tsx` — user-initiated screen with the
  pre-capture explanation, active state, and result; respects the Personal-Space
  gate; Android-only entry from the home hero.

**Prebuild implication:** the native module + manifest additions require an
`expo prebuild` / EAS Build (the app runs a managed/prebuild workflow with no
committed `android/`); `expo-modules-core` was added as a dependency.

## 3. Consent / anti-surveillance

User-initiated only. Android's own MediaProjection consent dialog gates every
session; **nothing is captured before it is granted**. A visible foreground-service
notification with a **Stop** action runs while active; `stop()` and the Stop
action end acquisition promptly; OS revocation is handled (`PERMISSION_REVOKED`).
No silent/background start, no hidden auto-restart, no Accessibility Service, no
overlay tricks, no `FLAG_SECURE` bypass (secure regions return blank and are
disclosed as `SECURE_CONTENT_OMITTED`).

## 4. Acquisition mode

`DIRECT_SCREEN_CAPTURE_ANDROID` — the second `isDirectCapture: true` mode
(`packages/shared/src/evidence-acquisition.ts`). Distinct from `PROOVRA_MOBILE_APP`
(a generic mobile submission of a file PROOVRA did not observe being produced).
Persisted, set-once (DB trigger), server-set, resolved only through
`resolveEvidenceAcquisition`, category `DIRECT_SCREEN_CAPTURE`. DB CHECK
constraints widened by migration (§10).

## 5. Artifact semantics

ONE Evidence record per session, containing 1..N `screen_frame` ORIGINAL parts +
a `CAPTURE_MANIFEST` part. Direct MediaProjection frames are ORIGINAL (the bytes
the adapter produced). Any later thumbnail/preview/OCR/stitch is DERIVED (existing
lineage). UC-2 does NOT implement conversation reconstruction (UC-4) or continuous
recording/video (UC-3).

## 6. Manifest — `PROOVRA_SCREEN_CAPTURE_MANIFEST_V1`

`packages/shared/src/screen-capture-manifest.ts`: bounded, strictly validated
server-side. Fields: session id, start/end, coarse device+display context
(`osVersion`, `model`, `appVersion`, screen dims, dpi, orientation), `osConsentGranted`,
per-frame descriptors (partIndex, frameIndex, expectedSha256, sizeBytes, dims,
offset, completeness), `completeness`, `stopReason`, `limitations`, `notes`.
**Privacy by omission:** NO app inventory, notification contents, clipboard,
contacts, or hardware identifiers.

## 7. Digest / trust boundary

Client digest is a DECLARATION; the SERVER recomputes each frame's SHA-256 from
the uploaded bytes and refuses the record before signing on any mismatch (session
INTERRUPTED). Identical to UC-0/UC-1. Proven by `uc2-screen-capture.integration.test.ts`.

## 8. Attestation (UC-0 defect not repeated)

The Android session is UNBOUND (no device key), exactly like UC-1 web capture.
There is NO cryptographic Android attestation in UC-2, so it is never labelled
`VERIFIED_*`/`DEVICE_VERIFIED`; the acquisition carries
`SCREEN_DEVICE_INTEGRITY_NOT_VERIFIED`. Device attestation stays UNVERIFIED /
fails closed.

## 9. Authorization / commercial

Every server op runs canonical `requireAuth` + `authorizeOrFail(evidence.create)`
+ workspace/case ownership + commercial lifecycle — no reliance on mobile UI
visibility. A user cannot capture into a workspace/case by submitting its id
(proven by the ownership/anti-enumeration checks). Commercial inherits the general
evidence-creation gate (`assertWorkspaceAllowsEvidenceCreation`); **no
capture-specific plan** is invented — same as UC-1. Product packaging for Direct
Screen Capture is a decision left open; the capability is plan-blind and inherits
eligibility.

## 10. Migration

`20280630000000_uc2_screen_capture_acquisition_mode` — EXPAND / SAFE_TO_APPLY_NOW,
apply BEFORE the UC-2 image. Widens the two `acquisition_mode` CHECK constraints
to admit `DIRECT_SCREEN_CAPTURE_ANDROID` (a constraint SWAP, non-destructive —
recognised by `constraintDropsAreAllSwaps`, so no phase-o allowlist needed).
Registered in: p6 curation + regenerated inventory (0 gate failures),
deployment plan, phase-32-7-2 allowlist, release-materialize PROPOSED_ADDITIONS.
Clean-boot from empty + idempotent on disposable PostgreSQL 16. **NOT APPLIED TO
PRODUCTION.**

## 11. Downstream / claims

All downstream surfaces (Library, Detail, Case, Search, Report V2, Verification
Package, Package Validator, Public Verify, storage/retention/hold/destruction)
read the ONE acquisition authority, so UC-2 flows through them like UC-1 with no
new plumbing (the web Library filter gained a "Screen capture" option; the server
filter is generic). Public Verify shows the neutral "Captured from an Android
screen with PROOVRA" with domain-free, device-free context. Claim safety: the
descriptor asserts only that PROOVRA captured the screen in a server-issued session
and recomputed each digest; it carries `SCREEN_CONTENT_TRUTH_NOT_PROVEN`,
`SCREEN_SOURCE_APP_NOT_PROVEN`, `SCREEN_DEVICE_INTEGRITY_NOT_VERIFIED`. No
"authentic screenshot"/"tamper-proof"/"verified at source".

## 12. Tests

- shared: **931/0** (adds the screen-capture manifest validator suite + updated
  acquisition partition/direct-capture assertions).
- API integration `uc2-screen-capture.integration.test.ts`: **4/4** live PG16
  (seal + server-set mode + manifest classed + bound once + Library filter +
  idempotent; refusals: omitted frame, session mismatch, screen-completing a
  mobile session, forged mode).
- API integration `uc1-web-capture` 4/4, `uc1-extension-oauth` 5/5 (incl. the new
  scope negative tests) — no regressions.
- Migration gates (phase-o, db-010, phase-32-7-2, point8): **94/94**.
- mobile typecheck, API typecheck, worker typecheck, web typecheck, extension MV3
  lint + 13/13 unit, architecture audit (AuditEngineIntegrity PASS, ProductClosure
  CLOSED).

## 13. Deferred validation

**ANDROID DEVICE ACCEPTANCE: DEFERRED.** The native MediaProjection capture has
not run on an Android device/emulator here. Run it on a real Android build (EAS /
prebuild) to validate consent, the foreground service, frame capture, orientation,
zero-frame and revocation paths end to end. Not faked as PASS.

## 14. Remaining risks

- **P0/P1:** none.
- **P2:** device-side capture edge cases (secure-content detection is best-effort;
  same-content-between-frames is not deduplicated) are disclosed via limitations,
  not silently dropped.
- **P3:** UI is functional, not fully themed; the manifest omits an upper cap on
  per-frame `sizeBytes` (server uses `headObject` size, so it fails closed).

---

## User-flow closure (2026-09-17)

The first pass auto-captured frames on a TIMER right after consent — so the user
could not capture what was on another app's screen (the whole point of UC-2). The
native interaction was reworked to be **user-triggered**, without changing the
acquisition mode, manifest, server, CaptureSession or Evidence.

### The release-critical answer (§5): how the user captures another app's screen

After `Start Screen Capture` → Android consent → the foreground-service
**notification** carries **Capture Frame** and **Stop** actions. The user leaves
PROOVRA, shows the target content in any app, and taps **Capture Frame** from the
notification — the SAME `ScreenCaptureService` action the in-app button routes to.
No timer, no overlay/`SYSTEM_ALERT_WINDOW`, no Accessibility service. Returning to
PROOVRA reconnects to the SAME native session and CaptureSession via
`getScreenCaptureState()` (never a new session); events keep the frame count live.

### Button / navigation contract matrix (code-backed)

| Control | File | Visible when | Handler → authority | Success dest | Failure dest | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Direct Screen Capture (entry) | app/(tabs)/index.tsx | Android home hero | router.push("/screen-capture") | screen | — | EXISTS |
| Start Screen Capture | (stack)/screen-capture.tsx | intro | startScreenCapture → native consent | active | error(denied) | EXISTS |
| Cancel | screen-capture.tsx | intro | router.back() | Capture | — | EXISTS |
| Capture Frame (in-app) | screen-capture.tsx | active | captureScreenFrame → ScreenCaptureService ACTION_CAPTURE_FRAME | frameCount++ | toast | EXISTS |
| Capture Frame (notification) | ScreenCaptureService.kt | active (backgrounded) | same ACTION_CAPTURE_FRAME | frameCount++ | ignored if stale | EXISTS |
| Stop & Review | screen-capture.tsx | active | stopScreenCapture → ACTION_STOP | review | error | EXISTS |
| Stop (notification) | ScreenCaptureService.kt | active | same ACTION_STOP | review | — | EXISTS |
| Finalize Evidence | screen-capture.tsx | review | finalizeScreenCapture → open/reserve/upload/screen-complete | success | error | EXISTS |
| Discard | screen-capture.tsx | review | RESET | intro | — | EXISTS |
| View Evidence | screen-capture.tsx | success | router.replace(`/evidence/:id`) | canonical Evidence Detail | — | EXISTS |
| Capture Another | screen-capture.tsx | success | RESET | intro (fresh session) | — | EXISTS |
| Done | screen-capture.tsx | success | router.back() | Capture | — | EXISTS |
| Try Again | screen-capture.tsx | error(recoverable) | RESET | intro | — | EXISTS |
| Back to Capture | screen-capture.tsx | error | router.back() | Capture | — | EXISTS |

No placeholder/TODO/console-only handlers; every state is reachable and total.

### State machine, app-switch, recovery

`src/screen-capture-flow.ts` is a PURE, TOTAL reducer (intro → active → review →
uploading → success; safe-only error branches) — an out-of-phase event never
corrupts state, and a stopped session never appears successful without an explicit
Finalize. Unit-tested (`test/screen-capture-flow.test.mjs`, 7 cases). OS revocation
/ process death / zero-frame end in a recoverable error or `INTERRUPTED`, never a
false COMPLETE. Digest mismatch is refused server-side (no "ignore"); the UI never
shows "Verified" for local acquisition — only after server sealing.

### Android permissions (all UC-2 adds)

`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`, `POST_NOTIFICATIONS`
— nothing else. NO camera/microphone/location/contacts/media-library,
`SYSTEM_ALERT_WINDOW` or Accessibility. Capture uses the MediaProjection system
consent only.

### Claim safety in UI

Strings are neutral: "Screen Capture Active", "Evidence saved", "verifying
integrity on the server". No "authentic/verified/tamper-proof screenshot".

### Tests (this pass)

mobile **15/15** (7 new reducer cases + 8 deep-link) + mobile typecheck GREEN;
architecture audit PASS; `git diff --check` clean. Server/API unchanged
(uc2-screen-capture integration 4/4 still valid). **ANDROID DEVICE ACCEPTANCE
remains DEFERRED** — the native capture is real but unrun on a device here.

**UC-2 USER FLOW COMPLETE (code) · ANDROID DEVICE ACCEPTANCE DEFERRED.**

---

**UC-2 CODE/ARCHITECTURE COMPLETE · ANDROID DEVICE ACCEPTANCE DEFERRED · UC-3 MAY BEGIN.**
Not deployed to Production; not published to the Play Store.
