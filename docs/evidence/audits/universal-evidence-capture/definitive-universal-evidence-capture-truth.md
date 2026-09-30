# Definitive Universal Evidence Capture Truth

**C. UNIVERSAL EVIDENCE CAPTURE NOT READY**

Baseline `47034f45403e87089b29571e3e702311c9d1a2a4` (origin/main (== local main) at audit start, 2026-09-30). Branch `audit/universal-evidence-capture-truth`. Generated from `definitive-universal-evidence-capture-truth.json` by `tooling/build.mjs`; do not edit by hand.

## Safety

- productionContacted: **NO**
- deployed: **NO**
- migratedProduction: **NO**
- productionDataChanged: **NO**
- mainTouched: **NO**
- productSourceFilesChanged: **0**
- Every database, Redis, object store and API used was a disposable loopback container or process started by this audit.
- prisma generate refused to run without DATABASE_URL because the audit worktree has no .env: the Production fallback is absent by construction.
- Web build pinned NEXT_PUBLIC_API_BASE=http://127.0.0.1:9; extension build pinned PROOVRA_API_ORIGIN=http://127.0.0.1:4000; mobile export pinned EXPO_PUBLIC_API_BASE=http://127.0.0.1:9 with EXPO_OFFLINE=1.
- Two generated files touched by runs (docs/architecture/point5-family-proven-cases.json by the integration ledger; apps/mobile/package.json and apps/mobile/android/ by expo prebuild) were restored/removed immediately; the final product diff is zero.

## Environment limits

- No macOS/Xcode: iOS native compilation, prebuild and device execution are BLOCKED.
- No JDK/Android SDK/emulator/device: Android native compilation and device execution are BLOCKED; Android prebuild (native project generation) ran.
- No sandbox credentials for TSA, OpenTimestamps, AWS S3 Object Lock, Stripe, PayPal, Chrome Web Store, Edge Add-ons, App Store Connect or Google Play: every such proof is in the external proof register, never counted as passed.

## UC verdicts

| UC | Name | Verdict | Key findings | External blockers |
|---|---|---|---|---|
| UC-0a | Provenance Truth Repair | **PRESENT BUT UNTRUTHFUL** | UC-PROV-001, UC-PROV-002, UC-ARCH-001, UC-PROV-003, UC-PROV-004, UC-PROV-005 | — |
| UC-0b | Trust / Attestation Repair | **PARTIALLY COMPLETE** | UC-TRUST-008, UC-TRUST-005, UC-TRUST-002, UC-TRUST-001, UC-TRUST-003, UC-TRUST-004 | EP-01, EP-02, EP-03 |
| UC-0c | Derivative Lifecycle Closure | **PARTIALLY COMPLETE** | UC-DER-002, UC-DER-006, UC-DER-005, UC-DER-007, UC-DER-013, UC-DER-014 | — |
| UC-1 | Chrome / Edge Web Capture | **PRESENT BUT UNREACHABLE** | UC-EXT-001, UC-EXT-003, UC-SEC-002, UC-TQ-007, UC-EXT-004, UC-EXT-005 | EP-04, EP-05, EP-12 |
| UC-2 | Android Direct Screen Capture | **PARTIALLY COMPLETE** | UC-AND-003, UC-AND-006, UC-AND-007, UC-AND-011, UC-AND-012 | EP-06, EP-07 |
| UC-3 | Continuous Capture + Streaming | **PRESENT BUT UNTRUTHFUL** | UC-STR-002, UC-STR-001, UC-AND-004, UC-STR-003, UC-STR-006 | EP-06 |
| UC-4 | Keyframes / OCR / Conversation Reconstruction | **PARTIALLY COMPLETE** | UC-DER-001, UC-DER-003, UC-DER-004, UC-DER-005, UC-TQ-003, UC-DER-010 | — |
| UC-5 | iOS | **PRESENT BUT DISCONNECTED** | UC-IOS-001, UC-IOS-002, UC-IOS-004, UC-IOS-003, UC-IOS-010 | EP-08, EP-09 |
| UC-6 | Full Public Launch | **PARTIALLY COMPLETE** | UC-LCH-001, UC-LCH-002, UC-LCH-003, UC-LCH-004, UC-TQ-002, UC-TQ-004 | EP-04, EP-05, EP-06, EP-07, EP-08, EP-09 |

- **UC-0a** — The acquisition-mode authority, set-once trigger and fail-closed attestation are real and runtime-visible (J01/J08/J09 report snapshots and Public Verify carry the server-recorded mode and IMPORTED_EXISTING_MEDIA tier). But server record-creation time is presented as capture time and on Public Verify as 'declared by the capturing device'; every direct-capture record reads 'Capture Method: Not recorded' in the rendered report (runtime-proven on an Android continuous record) and package; the client still chooses the direct-capture mode label; validated manifest facts (URL, title, browser, completeness) are dropped.
- **UC-0b** — Signing, custody chain, package seal and share-token verify work end to end (J01, J02; 463/463 API integration incl. public-verify-*, ots-integrity-lifecycle, integrity-recheck). RFC 3161 tokens are now validated with openssl against a configured anchor (tested with a local TSA). Open: OTS PENDING shown as 'Anchored', stored-bytes 'Verified' survives substitution for the recheck window (runtime J06), verdict ignores recheck, signing-key identity mutable, capture trust-event sub-chain never verified. Real TSA/OTS/Object Lock authority is external.
- **UC-0c** — One derived-asset authority, tenant binding, destruction sweep and redaction byte gate are in place (worker 1152/1152 executed, 4 Object-Lock cases run separately 4/4). Open: derived bytes bypass the byte-release gate (VIEWER can fetch OCR/keyframes), regeneration overwrites lineage and deletes prior objects, provenance (tool version, parameters, text digest) dropped, package derived manifests silently truncated.
- **UC-1** — The server side of Direct Web Capture works (uc1-web-capture + uc1-extension-oauth integration pass). A real user cannot capture: the popup never lists a workspace (runtime-proven), the extension origin is absent from production CORS and host_permissions, it is unpublished, and the shipped acceptance harness fails at AUTH on main. Full-page capture exceeds Chrome's captureVisibleTab quota by construction. No case selection.
- **UC-2** — Server seal path runtime-proven (uc2-screen-capture integration); JS↔Kotlin parity, manifest service declarations and foreground-service typing verified; Android prebuild generated the native project; Hermes bundle builds. Unproven on any device; POST_NOTIFICATIONS is never requested, so on Android 13+ the capture-frame notification action (the only way to capture another app) is suppressed. No share-into-PROOVRA, logout does not stop capture.
- **UC-3** — Seal refuses missing/duplicate/out-of-order/tampered declared segments (uc3 integration, real PG) and the full pipeline to Public Verify works for a sealed session (J09). But a lost TAIL segment seals as SIGNED COMPLETE_SESSION (runtime-proven), part index 200+ is refused while the client allows 600 segments so long recordings are discarded (runtime-proven), and a session is not resumable after app restart.
- **UC-4** — Runtime J10 (real worker, real ffmpeg-static): Generate → reconstruct_screen COMPLETED with 4 keyframes and 1 reconstruction descriptor, labelled DERIVED_RECONSTRUCTED; OCR did not run (ocrAllowed defaults OFF; coverage PARTIAL). A single manual 'Generate Derived Review' path exists, labelled as derived and never as original, with no actor-attribution claims. There is no conversation-capture channel; 'conversation' is OCR screen reconstruction. Retry/Regenerate never run again, OCR runs on ≤256 px keyframes for video sources, dedup cannot merge real chat screens, provenance fields are dropped, and the worker path has no CI-executed behavioural test.
- **UC-5** — Swift module, broadcast upload extension, App Group and entitlements exist and are internally consistent, and the server accepts DIRECT_SCREEN_CAPTURE_IOS. But no real iOS recording can be sealed: the device block the Swift code writes is refused by the shared validator (runtime-proven 422). The app cannot stop the broadcast, the last segment always has duration 0, and there is no crash recovery. Native compilation and ReplayKit behaviour are BLOCKED here (no macOS/Xcode).
- **UC-6** — Web build, extension build, both Hermes bundles and the API/worker suites are green locally; CI runs the API integration project against real PG. Not launched: extension unpublished and unusable, iOS cannot seal, Android unproven on device, PWA not installable, no capture monitoring/runbook, no mobile screen-recording privacy disclosure, extension/native never compiled or run in CI.

## Platform matrix

| Platform | Capture | Evidence pipeline | Case at capture | Build | Real browser/device | Distribution | Note |
|---|---|---|---|---|---|---|---|
| Browser Extension | BROKEN | WORKS_LOCALLY | NOT_IMPLEMENTED | WORKS_LOCALLY | FAIL | BLOCKED | Popup cannot select a workspace (UC-EXT-001); server path proven by uc1 integration. |
| Web | PARTIAL | WORKS_LOCALLY | NOT_IMPLEMENTED | WORKS_LOCALLY | NOT_EXECUTED_IN_UI | N/A | File/drag/camera/mic upload proven via the product API sequence (J01); no screen capture (getDisplayMedia) or clipboard. |
| PWA | PARTIAL | WORKS_LOCALLY | NOT_IMPLEMENTED | WORKS_LOCALLY | NOT_EXECUTED_IN_UI | BROKEN | Same code as Web; not installable (one 'any' icon, no service worker), no offline, no share_target. |
| Android | BLOCKED | WORKS_LOCALLY | NOT_IMPLEMENTED | PARTIAL | N/A | BLOCKED | Server seal + outputs proven (uc2/uc3 integration, J09). Native compile/device BLOCKED; POST_NOTIFICATIONS never requested (UC-AND-003). |
| iOS | BROKEN | BROKEN | NOT_IMPLEMENTED | PARTIAL | N/A | BLOCKED | Real device block refused at seal (UC-IOS-001, runtime); native build/device BLOCKED (no macOS). |

## Capture-to-Public-Verify convergence

**CONVERGED WRITERS, DIVERGENT SIDE EFFECTS** — Every live capture channel reaches ONE Evidence writer, ONE part writer, ONE finalizer (completeEvidence), ONE custody appender, ONE report builder, ONE package builder and ONE Public Verify route; no duplicate evidence model or writer was found and every queue has a consumer. The divergence is in what surrounds the finalizer: custody EVIDENCE_COMPLETED, reviewer-workflow initialisation, tenant audit and workspace retention run only in the web route, so direct-capture and intake records differ from uploads (UC-ARCH-002/003). iOS never reaches the finalizer (UC-IOS-001).

## Counts

- Findings: 119 open (P0 0 · P1 11 · P2 55 · P3 53); 2 consolidated into kept findings.
- Proof: runtime-proven 12 · source-proven (device behaviour of the attachment per Apple ReplayKit documentation; device confirmation BLOCKED) 1 · source-proven 106
- Required journeys: PASS 8 · FAIL 6 · BLOCKED 6 (of 20).
- API integration (capture-relevant, real PG16/Redis/MinIO): 463/463 passed, 0 skipped, 64 files.
- Worker suite: 1152/1156 passed, 4 skipped (the 4 skipped Object-Lock cases were run separately: see commands).

## Open P0/P1

### UC-AND-003 (P1, source-proven) — POST_NOTIFICATIONS is declared but never requested, so on Android 13+ the 'Capture Frame'/'Stop' notification — UC-2's only way to capture another app — is not shown

- UCs: UC-2, UC-3 · Platforms: android
- Where: `apps/mobile/modules/proovra-screen-capture/android/src/main/AndroidManifest.xml:13`, `apps/mobile/modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture/ScreenCaptureService.kt:136`, `apps/mobile/modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture/ContinuousScreenCaptureService.kt:131`, `apps/mobile/app/(stack)/screen-capture.tsx:227`, `apps/mobile/app/(stack)/continuous-capture.tsx:428`
- Observed: Manifest-only declaration; no runtime permission request before starting either foreground service.
- Expected: Request POST_NOTIFICATIONS (PermissionsAndroid.request on API 33+) before startCapture/startContinuousCapture; if denied, disclose that out-of-app Capture Frame/Stop will be unavailable (or refuse UC-2 cross-app mode).
- Root cause: Android 13 runtime notification permission was treated as a manifest declaration.
- User impact: On a fresh Android 13+ install the notification permission is off by default and PROOVRA never asks for it. The foreground service still runs, but its notification (with the Capture Frame and Stop actions) does not appear in the shade. The screen tells the user to 'open the app you want to capture, then tap Capture Frame from the notification'; the in-app button can only capture PROOVRA itself. UC-2 cannot capture third-party content; UC-3 loses its out-of-app Stop control.
- Legal/evidentiary: none directly; the primary UC-2 acquisition is unreachable.
- Security/tenancy: none
- Remediation: Add a pre-start permission step in screen-capture.tsx/continuous-capture.tsx (PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS') when Platform.Version >= 33) and a denied-state explanation.
- Required tests: Mobile unit: start() requests the permission on API 33+ before calling the native start. Device acceptance: fresh install on Android 13/14, verify notification actions visible.
- Migration: none · Depends on: — · Aliases: —

### UC-CASE-001 (P1, source-proven) — Evidence can be unlinked from a case under an active CASE legal hold, silently removing the hold's protection

- UCs: UC-0 · Platforms: android, api, ios, web
- Where: `services/api/src/services/cases/case-evidence-link.service.ts:218`, `services/api/src/routes/cases.routes.ts:1571`, `services/api/src/routes/evidence.routes.ts:7441`, `services/api/src/services/cases/case-lifecycle.service.ts:687`, `packages/shared-runtime/src/governance/effective-legal-hold.ts:210`, `services/api/src/routes/cases.routes.ts:1262`
- Observed: detachEvidenceFromCase deletes the link row with no hold evaluation; none of its three callers evaluates holds. evaluateCaseDeletionHold is used only for case DELETE.
- Expected: Detaching evidence from a case that carries an ACTIVE CASE hold (or while the evidence is otherwise held via that case) is refused (403 LEGAL_HOLD_BLOCKED, fail-closed 503 when hold state unreadable), inside the one detach authority so no caller can skip it.
- Root cause: The case-hold scope is computed dynamically from mutable links (resolveLinkedCaseIds), but the one detach authority treats linkage as a pure relationship edit and has no preservation gate.
- User impact: Any case writer (MEMBER, assigned INVESTIGATOR) can remove a held record from the held case via Remove from case, bulk REMOVE_FROM_CASE or matter-workspace unlink; afterwards the record is no longer held and can be trashed, and later destroyed by retention.
- Legal/evidentiary: Defeats a preservation obligation: a case-scoped legal hold covers exactly the records currently linked, and linkage is mutable by non-admins with no hold check. Case deletion is refused under the same hold precisely because it detaches links, so the gap is inconsistent with the platform's own rule.
- Security/tenancy: Within-tenant integrity/preservation bypass; no cross-tenant access.
- Remediation: In detachEvidenceFromCase (and detachAllEvidenceFromCase) evaluate ACTIVE holds with scope=CASE for caseId (and historical holds) inside the transaction, fail closed; map to 403 in cases.routes, case-workspace and bulk. Alternatively snapshot case-hold membership at hold placement.
- Required tests: Integration: CASE hold active -> single, bulk and case-workspace unlink all refused with zero mutation; hold store unreadable -> 503 zero mutation; after hold release unlink succeeds; trash after refused unlink still blocked.
- Migration: none · Depends on: — · Aliases: ET-SEC-16, ET-SEC-17

### UC-EXT-001 (P1, runtime-proven) — Extension popup reads `workspaces`/`teams` from /v1/platform/context, which returns neither, so the workspace list is always empty and both Capture buttons are disabled

- UCs: UC-1 · Platforms: api, extension
- Where: `apps/extension/src/popup.ts:32`, `apps/extension/src/popup.ts:138`, `apps/extension/src/popup.ts:143`, `services/api/src/services/platform-context/types.ts:1097`, `services/api/src/routes/platform-context.routes.ts:94`, `apps/extension/e2e/direct-web-capture.spec.ts:435`
- Observed: Workspace list always empty; capture disabled for every user. RUNTIME: Real popup (loaded unpacked in Chromium, signed in via real OAuth/PKCE): workspace select shows only No workspace available and both Capture buttons are disabled (screenshot). GET /v1/platform/context → 200 with top-level keys including availableWorkspaces (2 entries) and neither 'workspaces' nor 'teams'; popup.ts returns body.workspaces ?? body.teams ?? [] → [].
- Expected: The popup lists the user's capture-eligible workspaces from the canonical envelope field.
- Root cause: Popup parses an invented envelope key. The acceptance spec never opens the popup: it writes the token into storage and sends PRESERVE with PROOVRA_E2E_TEAM_ID directly from the service worker (direct-web-capture.spec.ts:409-449), so the defect is structurally invisible to every existing test.
- User impact: A signed-in user can never start a Direct Web Capture from the popup: the select shows 'No workspace available' and busy(true) disables both capture buttons. The UC-1 channel is unusable end to end.
- Legal/evidentiary: No web-capture evidence can be produced through the product surface.
- Security/tenancy: none
- Remediation: Read the canonical workspace options (availableWorkspaces or contextOptions via the shared projection), filtered to workspaces where evidence.create is permitted; add a contract test in tools/contract-audit style that the popup's parsed keys exist in PlatformContextEnvelope.
- Required tests: Popup unit test against a recorded /v1/platform/context envelope; e2e that drives the real popup (click action, choose workspace, click Capture).
- Migration: none · Depends on: — · Aliases: —
- Runtime evidence: runtime/probes/platform-context-shape.json, runtime/probes/extension-steps.json, runtime/probes/extension-popup.png

### UC-EXT-003 (P1, source-proven) — Full-page capture calls captureVisibleTab roughly every 250ms+capture time, above Chrome's 2-calls-per-second quota; the quota error aborts the whole capture

- UCs: UC-1 · Platforms: extension
- Where: `apps/extension/src/lib/capture.ts:114`, `apps/extension/src/lib/capture.ts:124`, `apps/extension/src/lib/capture.ts:125`, `apps/extension/src/lib/capture.ts:43`, `apps/extension/src/lib/config.ts:32`
- Observed: No rate pacing against the documented quota; no catch around captureVisibleTab; no partial manifest on tile failure.
- Expected: Pace tiles to >=500ms apart (or retry on the quota error with backoff) and, if a tile still fails, finish as PARTIAL with CAPTURE_INTERRUPTED rather than discarding everything.
- Root cause: Tile timing chosen for lazy-load settling only, ignoring the platform capture quota; real-browser acceptance never passed (UC1 doc §K), so it was never observed.
- User impact: 'Capture full page' likely fails with the generic error on any page taller than about two viewports; nothing is preserved (no partial fallback).
- Legal/evidentiary: Full-page preservation, the mode most relevant to long posts/threads, cannot complete.
- Security/tenancy: none
- Remediation: Enforce a minimum interval between captureVisibleTab calls; wrap in retry-on-quota; on persistent failure truncate tiles and mark PARTIAL.
- Required tests: Unit test of the pacing scheduler; real-Chrome e2e on apps/extension/e2e/fixtures/long.html with >=6 viewports.
- Migration: none · Depends on: — · Aliases: —

### UC-IOS-001 (P1, runtime-proven) — Every iOS continuous-capture manifest is refused at seal: the Swift result's device object lacks screenW/screenH/densityDpi/orientation that the server validator requires

- UCs: UC-5 · Platforms: api, ios
- Where: `apps/mobile/modules/proovra-screen-capture/ios/ProovraBroadcastShared.swift:58`, `apps/mobile/src/continuous-capture.ts:121`, `packages/shared/src/screen-continuous-manifest.ts:286`, `packages/shared/src/screen-continuous-manifest.ts:289`, `services/api/src/services/capture-trust/continuous-capture.service.ts:94`, `services/api/test/uc5-ios-screen-capture.integration.test.ts:253`, `apps/mobile/test/native-module-contract.test.mjs:75`
- Observed: Swift device map has 4 keys; validator requires 8. The UC-5 integration test hand-builds a device with screenW:1179, screenH:2556, densityDpi:460, orientation:'portrait' (uc5-ios-screen-capture.integration.test.ts:253-262) that the Swift never produces, so the suite passes against a fictional payload; the native contract test compares method/event NAMES only (native-module-contract.test.mjs:75-99). RUNTIME: Sealing with the exact device block ProovraBroadcastShared.swift writes ({platform, osVersion, model, appVersion}) → HTTP 422 CONTINUOUS_MANIFEST_INVALID; record stays UPLOADING.
- Expected: The iOS result carries every device field the server requires (UIScreen.main.nativeBounds/scale for pixels, a documented densityDpi convention for iOS, orientation), or the validator accepts an iOS-specific device shape; and a test drives the manifest from the exact map the Swift emits.
- Root cause: The iOS device shape was never reconciled with the manifest schema; server tests fabricate the device object instead of deriving it from the native payload.
- User impact: No iOS screen recording can ever be sealed. The user records, uploads every segment, stages, opens Capture, taps Finish & Sign, and continuous-complete answers CONTINUOUS_MANIFEST_INVALID. The reserved record is eventually reaped; the recording is lost as evidence.
- Legal/evidentiary: UC-5 is documented as code-complete / PASS (docs/uc6-release-acceptance.md:141) while it cannot produce a single sealed record.
- Security/tenancy: none
- Remediation: Emit screenW/screenH (native pixels), densityDpi (e.g. scale*160 or points-per-inch table, documented) and orientation from the extension (it knows the buffer geometry) via result.json, and fill them in ProovraBroadcastResult.toJsMap. Add a golden fixture of the Swift result map shared by a mobile unit test (buildContinuousManifest → validateScreenContinuousManifest) and the API integration test.
- Required tests: Mobile: buildContinuousManifest(fixture-from-Swift-map) passes validateScreenContinuousManifest(expectedPlatform:'ios'). API: uc5 integration test must load the same fixture rather than an inline device literal. Test-authoring gap (consolidated UC-TQ-001): every UC-5 test hand-authors an Android-shaped device block; add a contract test that feeds the Swift result.json shape through buildContinuousManifest → validator.
- Migration: none · Depends on: — · Aliases: ET-DC-09, UC-TQ-001
- Runtime evidence: runtime/probes/continuous-ios.json#iosDeviceShape

### UC-IOS-002 (P1, source-proven) — The app cannot stop the iOS broadcast: in-app Stop and every controlled stop post a Darwin note the extension never observes, then return a fabricated INTERRUPTED summary while recording continues

- UCs: UC-5 · Platforms: ios
- Where: `apps/mobile/modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift:100`, `apps/mobile/modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift:119`, `apps/mobile/plugins/broadcast-extension/SampleHandler.swift:35`, `apps/mobile/modules/proovra-screen-capture/ios/ProovraBroadcastShared.swift:136`, `apps/mobile/app/(stack)/continuous-capture.tsx:112`, `apps/mobile/app/(stack)/continuous-capture.tsx:273`
- Observed: One-way IPC (extension→app only).
- Expected: An app→extension stop channel: the extension observes a stop Darwin note (or polls a stop flag in state.json on each buffer) and calls finishBroadcastWithError / finalizes and writes result.json with USER_STOPPED; the app waits (bounded) for result.json before resolving.
- Root cause: The extension side of the stop handshake was never implemented; the app-side comment (:98-99) assumes it exists.
- User impact: Tapping 'Stop & Review' (or hitting the byte ceiling / upload backpressure) does not stop recording: the status-bar indicator stays on and the extension keeps writing up to 600 segments into the container. The review shows 'Interrupted' for a session the user ended cleanly; everything recorded after the tap is never emitted or uploaded and is wiped at the next start.
- Legal/evidentiary: The sealed manifest (if it could seal) would state INTERRUPTED_SESSION/terminationReason INTERRUPTED with captureStartedAtUtc equal to the stop instant and totalDurationMs 0 — false provenance for a clean stop. The client byte/backpressure bounds (SESSION_BOUNDS_REACHED, SEGMENT_UPLOAD_BACKPRESSURE) are unenforceable on iOS.
- Security/tenancy: Recording of the screen continues after the user asked PROOVRA to stop (OS indicator remains visible; user can still stop from Control Center).
- Remediation: In SampleHandler.broadcastStarted register a Darwin observer for a dedicated stop name (not the 'finished' name the app itself listens to) that sets a flag; on the next buffer finalize the segment, write result.json (USER_STOPPED/COMPLETE or the client limitation), and finishBroadcastWithError with a user-facing 'stopped from PROOVRA' message. In the module, wait up to N seconds for result.json before reading, and never synthesize startedAtUtc=now.
- Required tests: Device acceptance: start broadcast, stop in-app → indicator disappears, result terminationReason USER_STOPPED, last segment emitted. Unit: a Swift-free JS test that the stop path waits for a result instead of accepting the fallback.
- Migration: none · Depends on: — · Aliases: —

### UC-IOS-004 (P1, source-proven) — Extension segment timing is wrong: the final segment is recorded with durationMs 0 and a start offset equal to the session end, so COMPLETE iOS sessions are refused as having an undeclared gap

- UCs: UC-5 · Platforms: api, ios
- Where: `apps/mobile/plugins/broadcast-extension/SampleHandler.swift:74`, `apps/mobile/plugins/broadcast-extension/SampleHandler.swift:121`, `packages/shared/src/screen-continuous-manifest.ts:391`, `packages/shared/src/screen-continuous-manifest.ts:402`
- Observed: Final segment duration hard-coded to 0; offsets mix wall clock and PTS.
- Expected: Final segment duration = last appended PTS − segmentStartPts; offsets derived from one clock (PTS relative to the first frame of the session).
- Root cause: finalizeSegment's force path passes a literal 0 instead of measuring the segment.
- User impact: Even with UC-IOS-001 fixed, a cleanly stopped session whose last segment is longer than 3 s (roughly half of all sessions at 6 s segments) fails Finish & Sign with CONTINUOUS_MANIFEST_INVALID. Static screens (ReplayKit delivers no new frames when nothing changes) also create >3 s wall-clock gaps between segments.
- Legal/evidentiary: The last segment's declared duration (0) is false provenance in the manifest.
- Security/tenancy: none
- Remediation: Track lastPts; on force-finalize use lastPts − segmentStartPts; compute startedAtOffsetMs from segmentStartPts − sessionFirstPts. Record a limitation when a segment spans a long no-frame interval rather than letting it read as a gap.
- Required tests: Pure timing function extracted from SampleHandler (or mirrored in TS) with a test: 6 s segments + 4 s final → contiguous offsets, validator accepts COMPLETE.
- Migration: none · Depends on: UC-IOS-001 · Aliases: ET-DC-09

### UC-OUT-001 (P1, runtime-proven) — Every report issued since share tokens prints a 'Public Verification' QR/link that answers 'Evidence not found' by default, and package README seal step 2c depends on that page

- UCs: UC-0 · Platforms: api, web, worker
- Where: `services/worker/src/processor.ts:2685`, `services/worker/src/processor.ts:4247`, `services/worker/src/report-v2/sections/cover.ts:253`, `services/api/src/services/evidence-complete.service.ts:1258`, `services/api/src/routes/evidence.routes.ts:12832`, `services/worker/src/verification-package.ts:2176`, `apps/web/components/evidence-outputs/PublicVerificationLinksPanel.tsx:81`
- Observed: Report text and README promise a live public verification path; the path is closed by default and the closure is indistinguishable from non-existence. RUNTIME: Fresh web-upload record, never published: its report PDF prints a pvs_ 'Public Verification' link; GET /public/verify/<that token> → 404 {message:'Evidence not found'}; publicVerifyState NOT_PUBLISHED; the owner's links panel lists the REPORT link as state ACTIVE.
- Expected: Either (a) the report/README state that the link works only once the owner enables public verification, and the owner is told at download that the printed link is inactive; or (b) the 404 for a real-but-unpublished token answers a distinct 'not currently published by its owner' state (410-style) that does not deny existence; and the links panel shows REPORT links as 'Inactive — record not published'.
- Root cause: ET-PKG-07 made records private by default and gave reports their own token, but the report template, README and owner UI were not updated for the unpublished state; the public route collapses unpublished into not-found.
- User impact: Records finalize NOT_PUBLISHED. The worker mints a REPORT-purpose pvs_ token and prints it on the report cover as 'Public Verification — Scan QR code or open verification page'. Until the owner separately publishes the record, /public/verify/<token> returns 404 'Evidence not found' — byte-identical to a forged/unknown link. The owner's links panel says the record is private but lists the printed link with a green 'Active' badge; nothing tells the owner that reports they hand out have a dead link.
- Legal/evidentiary: A recipient (court, counterparty) following the report's own verification instruction is told the evidence does not exist. The package README's seal verification step 2c (compare seal key fingerprint with Public Verify) and step 6 (signing key published on Public Verify) cannot be completed for a private record, so the package's independent-verification claim is unavailable by default.
- Security/tenancy: none
- Remediation: Add a report-cover caveat and README note conditioned on publication at issuance; add a download-time/owner-panel warning; consider a dedicated 'withheld by owner' response for valid tokens on unpublished records (no metadata).
- Required tests: Worker render test asserting the cover caveat for NOT_PUBLISHED records; API test: valid REPORT token on unpublished record -> documented response; web render test for the REPORT link badge when private.
- Migration: none · Depends on: — · Aliases: ET-PKG-02, ET-PKG-03, ET-PKG-07
- Runtime evidence: runtime/probes/report-printed-verify-link.json

### UC-PROV-001 (P1, source-proven) — Server record-creation time (Evidence.capturedAtUtc = server now() at reserve/upload) is presented as capture time, and public Basic Verify says it was 'declared by the capturing device'

- UCs: UC-0a, UC-1, UC-2, UC-3, UC-5 · Platforms: android, api, ios, pwa, web, worker
- Where: `services/api/src/services/evidence.service.ts:446`, `services/api/src/services/evidence.service.ts:531`, `packages/shared/src/basic-verification.ts:51`, `packages/shared/src/basic-verification.ts:253`, `apps/web/app/verify/[token]/BasicVerificationView.tsx:216`, `apps/mobile/src/ui/basic-verification-view.tsx:122`, `apps/web/app/verify/[token]/page.tsx:4098`, `apps/web/app/verify/[token]/page.tsx:3661`, `apps/mobile/src/product/public-verify.ts:1513`, `services/worker/src/report-v2/build-view-model.ts:365`, `services/worker/src/report-v2/sections/executive-summary.ts:356`, `services/worker/src/report-v2/build-view-model.ts:1654`, `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx:378`, `apps/mobile/src/product/evidence-record.ts:985`, `packages/shared/src/evidence-acquisition.ts:454`, `apps/extension/src/background.ts:46`, `apps/extension/src/background.ts:59`, `services/api/src/routes/evidence.routes.ts:5054`
- Observed: One server clock value (record creation) is labelled 'declared by the capturing device', 'Captured At', 'Captured & Signed', 'Captured at'. The API already knows better: it emits capturedAtUtcLabel 'Server-recorded intake time' / capturedAtUtcProvenance 'server_clock' (evidence.routes.ts:5054-5055), which the UI drops. The report Capture Context row labelled '(server UTC)' falls back to deviceTimeIso (client clock) when capturedAtUtc is null (build-view-model.ts:1654-1658); Verify's 'Capture timestamp' does the same (page.tsx:3658-3663). The actual client capture window (manifest captureStartedAtUtc/EndedAtUtc) is never projected.
- Expected: Label the value as what it is ('Recorded by PROOVRA (server UTC)' / 'Record created'); never attribute it to a device; show client-reported capture window (manifest) separately and labelled client-reported; never mix server and device clocks under one label.
- Root cause: The column is named capturedAtUtc but holds server creation time; surfaces label it by its name, and basic-verification.ts invented a 'Declared' semantics for it.
- User impact: Reviewers read a server bookkeeping time as the moment the material was captured. For uploads and intake there is no capturing device at all; for the extension the value is when the session was reserved, after the capture ran.
- Legal/evidentiary: Public Verify makes a false provenance statement (attributing a server timestamp to the device); reports/Verify give a 'Captured At' time that is neither the capture time nor labelled as server receipt, which can be relied on for timeline arguments.
- Security/tenancy: none
- Remediation: Rename the projection field (e.g. recordedAtUtc) in BasicVerification (keep old key as alias), relabel all listed surfaces to server-receipt wording, surface manifest captureStartedAtUtc as 'Capture started (reported by client)', and remove the deviceTimeIso fallback under server-UTC labels.
- Required tests: Render tests for BasicVerificationView / mobile basic view / Verify summary / report exec grid asserting no 'Captured' or 'declared by device' wording for capturedAtUtc; unit test that basic-verification output does not claim device origin.
- Migration: none · Depends on: — · Aliases: ET-DC-02

### UC-STR-001 (P1, runtime-proven) — Continuous capture advertises 600 segments / 50 min but the server accepts part indexes 0..199 only; any recording that reaches 200 segments is discarded in full at staging

- UCs: UC-3, UC-5 · Platforms: android, api, ios
- Where: `services/api/src/services/evidence/evidence-part-writer.service.ts:42`, `services/api/src/routes/capture-trust.routes.ts:230`, `services/api/src/services/capture-trust/direct-capture-ingest.service.ts:495`, `services/api/src/routes/evidence.routes.ts:464`, `packages/shared/src/screen-continuous-manifest.ts:131`, `packages/shared/src/screen-continuous-manifest.ts:60`, `apps/mobile/modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture/ProovraScreenCaptureModule.kt:123`, `apps/mobile/modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture/ContinuousScreenCaptureService.kt:222`, `apps/mobile/modules/proovra-screen-capture/index.ts:269`, `apps/mobile/src/continuous-capture.ts:261`, `apps/mobile/app/(stack)/continuous-capture.tsx:319`, `apps/mobile/src/direct-capture.ts:273`
- Observed: Client/native/manifest bound = 600 segments (+1 manifest part) and 50 min; server bound = 200 parts total (indexes 0..199). RUNTIME: POST /v1/evidence/:id/parts partIndex 199 → 201; partIndex 200 → 400 'Too big: expected number to be <=199'; declaration for part 200 → 400.
- Expected: One bound shared by native, client, manifest validator and the part writer; recording stops (COMPLETE, BOUNDS_REACHED) before the server limit, with room for the manifest part.
- Root cause: SCREEN_CONTINUOUS_STREAM_BOUNDS.maxSegments / SCREEN_CONTINUOUS_MANIFEST_BOUNDS.maxSegments (600) were never reconciled with MAX_EVIDENCE_PARTS (200) introduced by ET-ACQ-07.
- User impact: A continuous screen recording that runs past ~19.9 minutes at the default 6 s segments (fewer with rotation rollovers) cannot be staged. Segment 200+ uploads fail, backpressure stops recording, and at 'Continue to Finish & Sign' the manifest part is refused, sealDirectCapture discards the session and the reserved record: every already-uploaded segment is released and the local copies were already deleted. The user loses the whole recording.
- Legal/evidentiary: Destructive loss of an acquisition the user was told was bounded at 50 minutes; nothing is sealed.
- Security/tenancy: none
- Remediation: Make MAX_EVIDENCE_PARTS the single authority imported by the shared stream bounds (maxSegments = MAX_EVIDENCE_PARTS - 1) and the native clamp, or raise MAX_EVIDENCE_PARTS for continuous modes; additionally never discard a session whose segments are all verified — stage failure after segments exist should keep the session, not release it.
- Required tests: Integration: open a DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS session, declare partIndex 199 and 200 -> assert the configured maxSegments+1 fits. Shared unit: assert SCREEN_CONTINUOUS_STREAM_BOUNDS.maxSegments + 1 <= MAX_EVIDENCE_PARTS. Mobile: stage with 200 declared segments.
- Migration: none · Depends on: — · Aliases: ET-ACQ-07
- Runtime evidence: runtime/probes/continuous-ios.json#partIndexCap

### UC-STR-002 (P1, runtime-proven) — Lost segments are never reconciled against the recorded count: a lost TAIL seals as COMPLETE_SESSION, a lost middle segment discards the whole recording

- UCs: UC-3, UC-5 · Platforms: android, api, ios
- Where: `apps/mobile/app/(stack)/continuous-capture.tsx:138`, `apps/mobile/app/(stack)/continuous-capture.tsx:303`, `apps/mobile/app/(stack)/continuous-capture.tsx:450`, `apps/mobile/src/continuous-capture.ts:102`, `apps/mobile/src/continuous-capture.ts:110`, `apps/mobile/src/continuous-capture.ts:261`, `packages/shared/src/screen-continuous-manifest.ts:395`, `services/api/src/services/capture-trust/continuous-capture.service.ts:118`
- Observed: The manifest does not carry the recorded segment count; the client never compares declared vs recorded; the validator's COMPLETE rules do not bound the tail; manifestPartIndex is derived from declared.length. RUNTIME: 4 segments recorded (manifest totalDurationMs 4000), tail never declared, 3 segments listed (sum 3000 ms), sessionCompleteness COMPLETE_SESSION → HTTP 200, evidence SIGNED.
- Expected: Before staging, declared.length must equal the native segmentCount or the manifest must be downgraded to INTERRUPTED_SESSION with a limitation; the manifest should state recordedSegmentCount and the server should refuse COMPLETE when segments.length != recordedSegmentCount or when last.startedAtOffsetMs + last.durationMs falls short of totalDurationMs by more than maxGapMs. The manifest part index should be a reserved index (e.g. max(declared partIndex)+1 or a fixed slot), not declared.length.
- Root cause: Completeness is taken from the native recorder's termination only; upload-side loss is not an input to completeness, and the server cannot see segments that were never declared.
- User impact: If the network drops near the end of a recording, the final segment(s) fail at the declaration step, the review card shows 'N recorded, M uploaded and ready to seal', and Continue seals the M-segment prefix labelled 'Complete — no known interruption'. If instead a middle segment is lost, the manifest part collides with an existing part index, staging fails and the whole session (all good segments) is discarded.
- Legal/evidentiary: A truncated recording is sealed and reported as a COMPLETE continuous session: the record claims continuity/completeness over content it does not contain.
- Security/tenancy: none
- Remediation: Client: in finalize, compare declaredRef.current.length with resultRef.current.segmentCount; retry missing segments from seenRef (files still on disk) and, if still missing, mark INTERRUPTED_SESSION + a new limitation (e.g. SEGMENT_UPLOAD_LOST) and seal the contiguous prefix instead of discarding. Shared: add recordedSegmentCount to the manifest and a tail-coverage check to validateScreenContinuousManifest for COMPLETE. Use max(partIndex)+1 for the manifest part.
- Required tests: Shared: COMPLETE manifest whose last segment ends > maxGapMs before totalDurationMs is refused; COMPLETE with segments.length < recordedSegmentCount refused. Integration: seal with a missing tail -> must be INTERRUPTED or refused. Mobile: finalize with declared < recorded downgrades completeness and keeps the session.
- Migration: none · Depends on: — · Aliases: ET-DC-09
- Runtime evidence: runtime/probes/continuous-ios.json#missingTail

## Required runtime journeys

| # | Journey | Status | Evidence | Note |
|---|---|---|---|---|
| R01 | Web/PWA file upload → finalize → report → package → Public Verify | **PASS** | runtime/journeys-raw.json#J01-web-upload-to-public-verify<br>runtime/journeys-raw.json#J02-package-independent-recompute<br>runtime/probes/package-recompute.json | Independent node:crypto recompute of the downloaded package 14/14 (ZIP digest, Ed25519 seal + key fingerprint, checksum index, report digest, fingerprint, evidence signature, original vs SIGNED digest, custody chain replay, 2 negative controls). J01 22/22 checks: server-hashed SIGNED record, report+package READY from the real worker, share link minted through TOTP step-up, token hashed at rest, revoke/rotate/guess all 404, audit trail complete (admin_audit_logs). |
| R02 | Web/PWA screen capture → outputs | **FAIL** | sources/ARCH.json#facts.absentChannels | Channel does not exist: 0 getDisplayMedia call sites in apps/web. |
| R03 | Intake-link submission → outputs | **PASS** | runtime/journeys-phase2-raw.json#J08-intake-link-to-public-verify | J08-intake-link-to-public-verify: PASS (10/10) |
| R04 | Evidence Request submission → outputs | **BLOCKED** | sources/ARCH.json#facts.surfaces.evidence-requests | Evidence Requests deliver through intake links (no separate byte path); the request send/delivery step needs the communications provider, which is disabled on the disposable stack. The byte path is R03. |
| R05 | Browser extension capture → outputs | **FAIL** | runtime/uc1-acceptance.log<br>runtime/uc1-acceptance-audit-copy.log<br>runtime/extension-acceptance-result.json | Extension capture cannot be completed by a user or by the shipped acceptance spec. (1) Shipped harness: AUTH fails INVALID_CLIENT_OR_REDIRECT in both projects (UC-TQ-007). (2) With the operator allow-list supplied after the fixture scan, AUTH passes but the first spec test hung until its 11.2-min backstop without reaching CAPTURE; the run was stopped. (3) Step probe on the same stack: real OAuth/PKCE token OK, service worker registers, but the real popup lists only No workspace available with both Capture buttons disabled (UC-EXT-001); PRESERVE from the extension page without a user gesture is refused (activeTab not granted); the spec capture path (service worker messaging itself) fails Receiving end does not exist (UC-TQ-008). Gesture-driven capture in real Chrome/Edge is therefore unproven (EP-04/EP-05/EP-13). |
| R06 | Android flow (strongest available environment) | **BLOCKED** | runtime/api-integration-capture.json<br>runtime/mobile-export.log<br>runtime/prebuild/app-AndroidManifest.xml | No JDK/SDK/device. Strongest available: server seal (uc2/uc3 integration) + Hermes bundle + prebuild manifest; see R08/J09 for the API-driven continuous journey. |
| R07 | iOS flow (strongest available environment) | **FAIL** | runtime/probes/continuous-ios.json#iosDeviceShape | Strongest available environment = the real server with the device block the Swift code writes: refused 422. |
| R08 | Continuous/streaming capture with interruption and resume | **FAIL** | runtime/probes/continuous-ios.json#missingTail<br>runtime/probes/continuous-ios.json#partIndexCap<br>runtime/journeys-phase2-raw.json#J09-continuous-direct-capture-to-public-verify | A lost tail seals as COMPLETE_SESSION; >200 segments refused; no resume after app restart (UC-AND-004). |
| R09a | Video → keyframes | **PASS** | runtime/journeys-phase2-raw.json#J10-uc4-derived-review | J10-uc4-derived-review: PASS (2/2) |
| R09b | Video → OCR | **BLOCKED** | runtime/journeys-phase2-raw.json#J10-uc4-derived-review | Not exercised: workspace AI policy ocrAllowed defaults OFF (projection ocrEnabled:false, coverage PARTIAL) and no Tesseract binary exists on this host; the worker Docker image carries it. Real Tesseract extraction is also unasserted in CI (UC-TQ-003). |
| R10 | Conversation capture / reconstruction | **FAIL** | sources/DER.json#facts.uc4 | No conversation-capture channel exists; reconstruction is OCR over screen keyframes whose dedup cannot merge real chat screens (UC-DER-004). |
| R11 | Add capture to existing Case | **PASS** | runtime/journeys-raw.json#J03-case-attach-and-tenancy | Post-hoc link only (no channel accepts a case at capture time). 18/18 incl. cross-tenant, unknown-id, viewer negatives; unlink keeps evidence and workspace. |
| R12 | Create new Evidence from capture | **PASS** | runtime/journeys-raw.json#J01-web-upload-to-public-verify |  |
| R13 | Failure and recovery journey | **BLOCKED** | runtime/api-integration-capture.json | Not induced end-to-end with the worker in the loop. Integration-level only: report-generation-supersession-recovery, package-recovery-backfill, reports-blocked-update-failed (real PG, storage/signer doubled). Healthy record regenerate → NOTHING_TO_RECOVER (J06). |
| R14a | Trash / restore | **PASS** | runtime/journeys-raw.json#J04-trash-restore | Soft trash keeps the row (deleted_at set), hides it from the library, restore brings it back live; viewer cannot trash. |
| R14b | Permanent destruction | **BLOCKED** | runtime/journeys-phase2-raw.json#J11-destroy-and-free-slot<br>runtime/api-integration-capture.json | Not executed end to end: destruction runs only by executing an approved destruction review (Enterprise feature). J11: FREE record PENDING_DESTRUCTION → 402 ENTERPRISE_FEATURE_REQUIRED, DESTROYED → 409 LIFECYCLE_DESTRUCTION_REQUIRES_REVIEW, row unchanged, FREE slot still held. Integration-level: evidence-destruction-storage, legal-hold-destruction-serialization, defects-destruction-refusals (real PG). |
| R15a | FREE allowance: three records, fourth refused, trash keeps the slot | **PASS** | runtime/journeys-raw.json#J05-free-allowance | Product-provisioned FREE personal workspace; 4th → 409 FREE_LIMIT_REACHED; after trash still 409. |
| R15b | Credit purchase / upgrade / downgrade / webhook replay | **BLOCKED** | runtime/api-integration-capture.json | Needs Stripe/PayPal sandbox (EP-10/EP-11). Integration-level: stripe-credit-refund-reversal, billing-paypal-integrity, admin-evidence-credit-grant, trash-keeps-allowance-slot passed on real PG. |
| R16 | Share-link create / revoke / replace | **PASS** | runtime/journeys-raw.json#J01-web-upload-to-public-verify |  |
| R17 | Integrity mismatch and stale-status journey | **FAIL** | runtime/journeys-raw.json#J06-integrity-tamper | After byte substitution Public Verify still states original 'verified' and stored bytes 'verified_current' (UC-TRUST-008). |

## Executed journey runs (driver)

| Run | Driver verdict | Lead-graded verdict | Checks | Lead note |
|---|---|---|---|---|
| J01-web-upload-to-public-verify | PASS | **PASS** | 22/22 |  |
| J02-package-independent-recompute | PASS | **PASS** | 2/2 |  |
| J03-case-attach-and-tenancy | PASS | **PASS** | 18/18 |  |
| J04-trash-restore | PASS | **PASS** | 6/6 |  |
| J05-free-allowance | PASS | **PASS** | 3/3 |  |
| J06-integrity-tamper | PASS | **FAIL** | 6/6 | The driver's final check matched only 'verdict'/'headline' keys and passed vacuously; the captured Public Verify answer after byte substitution reads basicVerification.original.state='verified' and storedBytes.state='verified_current'. Graded by the lead as FAIL (UC-TRUST-008, journey R17). |
| J07-upload-session-member-injection | FAIL | **FAIL** | 2/3 |  |
| J08-intake-link-to-public-verify | PASS | **PASS** | 10/10 |  |
| J09-continuous-direct-capture-to-public-verify | PASS | **PASS** | 10/10 |  |
| J10-uc4-derived-review | PASS | **PASS** | 2/2 |  |
| J11-destroy-and-free-slot | PASS | **BLOCKED** | 2/2 | Its only check is 'governed, non-5xx response'; no destruction was executed (402 ENTERPRISE_FEATURE_REQUIRED, 409 LIFECYCLE_DESTRUCTION_REQUIRES_REVIEW). Graded as BLOCKED for destruction (journey R14b). |

## Conservation gates

| Gate | Result | Detail |
|---|---|---|
| discovered capture surfaces = dispositioned capture surfaces | PASS | 27 surfaces |
| discovered mutations = dispositioned mutations | PASS | 59 mutations |
| discovered queues = classified queues | PASS | 13 queue rows |
| runtime journeys = passed + failed + blocked | PASS | {"PASS":8,"FAIL":6,"BLOCKED":6} |
| findings = fixed + partial + present + accepted-risk | PASS | 119 |
| every UC = complete + partial + missing + blocked | PASS | {"complete":0,"partial":7,"missing":2,"blocked":0} |
| no UNKNOWN without explicit blocker | PASS |  |
| no NOT_REVIEWED | PASS | 301 reviewed topics |
| no duplicate finding IDs | PASS |  |
| consolidations point at a kept finding | PASS |  |
| every finding has the required fields | PASS |  |
| every finding id matches UC-AREA-NNN | PASS |  |
| every UC key finding exists | PASS |  |
| every remediation-order finding exists | PASS |  |
| every open P0/P1 is in the remediation order | PASS | UC-AND-003,UC-CASE-001,UC-EXT-001,UC-EXT-003,UC-IOS-001,UC-IOS-002,UC-IOS-004,UC-OUT-001,UC-PROV-001,UC-STR-001,UC-STR-002 |
| every dependsOn resolves | PASS |  |
| executed-run overrides name executed runs | PASS |  |
| runtime-bound findings exist | PASS |  |
| every blocker names an external proof row | PASS |  |
| every command in the ledger has an exit code | PASS | 39 commands |
| API integration run executed (not skipped) and green | PASS | 463/463 |
| independent package recompute passed (incl. negative controls) | PASS | 14/14 |
| worker run green | PASS | 1152/1156 (4 skipped) |
| no artifact/render disagreement | PASS |  |
| no undefined, placeholder or TODO in final artifacts | PASS |  |

## Validation commands

| Label | Exit | Log |
|---|---|---|
| ext-lint | 0 | ext-lint.log |
| ext-test | 0 | ext-test.log |
| ext-build | 0 | ext-build.log |
| mobile-typecheck | 0 | mobile-typecheck.log |
| mobile-test | 0 | mobile-test.log |
| mobile-export-android-ios | 0 | mobile-export.log |
| mobile-prebuild | 0 | mobile-prebuild.log |
| web-build | 0 | web-build.log |
| api-integration-capture | 0 | api-integration-capture.log |
| seed-journeys | 0 | seed.json |
| journeys-run1 | 0 | journeys-run1.log |
| seed-journeys-2 | 0 | seed2.json |
| journeys-run2 | 0 | journeys-run2.log |
| probes-integration | 0 | probes-integration.log |
| seed-journeys-3 | 0 | seed3.json |
| journeys-run3 | 0 | journeys-run3.log |
| seed-journeys-4 | 0 | seed4.json |
| journeys-run4 | 0 | journeys-run4.log |
| uc1-acceptance-fullstack | 1 | uc1-acceptance.log — Playwright result FAIL in both projects (AUTH INVALID_CLIENT_OR_REDIRECT); stack then kept up intentionally for journeys J01-J07 and torn down by the auditor (processes on 4000/3311/4599 killed, uc1-acc-* containers removed) |
| uc1-acceptance-audit-copy | 1 | uc1-acceptance-audit-copy.log |
| worker-tests | 0 | worker-tests.log |
| uc1-acceptance-audit-copy-2 | 1 | uc1-acceptance-audit-copy.log |
| worker-object-lock-minio | 0 | worker-object-lock-minio.log |
| uc1-stack-phase2 | 1 | uc1-stack-phase2.log |
| seed-journeys-phase2 | 0 | seed5.json |
| extension-step-probe | 0 | extension-step-probe.log |
| uc1-acceptance-audit-copy-3 | 1 | uc1-acceptance-audit-copy.log |
| uc1-acceptance-audit-copy-3 | 1 | uc1-acceptance-audit-copy.log — AUTH PASS; first test x after 11.2m backstop without reaching CAPTURE; stopped by the auditor (TaskStop), ports 4000/3311/4599 killed, uc1-acc-* removed |
| journeys-phase2 | 0 | journeys-phase2.log |
| uc1-stack-phase2 (attempt 1) | 1 | uc1-stack-phase2.log — INVALID RUN (auditor teardown gap): worker died EADDRINUSE 0.0.0.0:4001 held by an orphaned worker from the previous stack; phase-2 journey results from this stack for report/package availability are discarded and rerun |
| seed-journeys-phase2b | 0 | seed6.json |
| audit-engine-check | 0 | audit-engine-check.log |
| journeys-phase2b | 0 | journeys-phase2.log |
| uc1-stack-phase2b | 0 | uc1-stack-phase2b.log — intentional keep-up server for J08-J11 and the report-link probe; worker healthy; torn down by the auditor (4000/4001/3311/4599 killed, uc1-acc-* removed) |
| package-independent-recompute | 0 | package-recompute.log |
| api-typecheck | 0 | api-typecheck.log |
| worker-typecheck | 0 | worker-typecheck.log |
| web-typecheck | 0 | web-typecheck.log |
| audit-tooling-syntax | 0 | audit-tooling-syntax.log |

## Artifacts

- `definitive-universal-evidence-capture-truth.json`
- `definitive-universal-evidence-capture-truth.md`
- `universal-capture-surface-inventory.json`
- `universal-capture-convergence-map.json`
- `universal-capture-runtime-journeys.json`
- `universal-capture-findings.json`
- `universal-capture-external-proof-register.md`
- `universal-capture-remediation-order.md`
