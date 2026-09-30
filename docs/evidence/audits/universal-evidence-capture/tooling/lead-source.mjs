/**
 * LEAD ADJUDICATION SOURCE — Definitive Universal Evidence Capture audit.
 *
 * This file is the auditor's only hand-written input to the canonical artifacts.
 * Area findings come from ../sources/*.json (each verified first-hand at file:line);
 * runtime evidence comes from ../runtime/*. build.mjs merges the three, applies the
 * consolidations and runtime bindings below, runs the conservation gates and writes
 * the eight artifacts deterministically.
 */

export const META = {
  title: "Definitive Universal Evidence Capture Truth",
  baselineSha: "47034f45403e87089b29571e3e702311c9d1a2a4",
  baselineRef: "origin/main (== local main) at audit start, 2026-09-30",
  auditBranch: "audit/universal-evidence-capture-truth",
  auditWorktree: "D:/pv-uca (fresh worktree from origin/main; contains no .env files)",
  auditDate: "2026-09-30",
  runtime: { node: "v24.12.0", pnpm: "10.28.2", docker: "29.2.1", os: "Windows 11 Pro 10.0.26200" },
  environmentLimits: [
    "No macOS/Xcode: iOS native compilation, prebuild and device execution are BLOCKED.",
    "No JDK/Android SDK/emulator/device: Android native compilation and device execution are BLOCKED; Android prebuild (native project generation) ran.",
    "No sandbox credentials for TSA, OpenTimestamps, AWS S3 Object Lock, Stripe, PayPal, Chrome Web Store, Edge Add-ons, App Store Connect or Google Play: every such proof is in the external proof register, never counted as passed.",
  ],
  scope: [
    "apps/web (Web/PWA), apps/extension (Chrome/Edge MV3), apps/mobile (Expo; Android + iOS native module and broadcast extension)",
    "services/api, services/worker, packages/shared, shared-runtime, shared-evidence-presentation, shared-billing",
    "Prisma schema/migrations, BullMQ queues and scheduled sweeps, storage/Object Lock integration",
    "reports, verification packages, Public Verify, share links, TSA/OTS, custody, cases, intake links and Evidence Requests, commercial admission",
  ],
  safety: {
    productionContacted: "NO",
    deployed: "NO",
    migratedProduction: "NO",
    productionDataChanged: "NO",
    mainTouched: "NO",
    productSourceFilesChanged: 0,
    notes: [
      "Every database, Redis, object store and API used was a disposable loopback container or process started by this audit.",
      "prisma generate refused to run without DATABASE_URL because the audit worktree has no .env: the Production fallback is absent by construction.",
      "Web build pinned NEXT_PUBLIC_API_BASE=http://127.0.0.1:9; extension build pinned PROOVRA_API_ORIGIN=http://127.0.0.1:4000; mobile export pinned EXPO_PUBLIC_API_BASE=http://127.0.0.1:9 with EXPO_OFFLINE=1.",
      "Two generated files touched by runs (docs/architecture/point5-family-proven-cases.json by the integration ledger; apps/mobile/package.json and apps/mobile/android/ by expo prebuild) were restored/removed immediately; the final product diff is zero.",
    ],
  },
};

/** One root cause = one finding. The consolidated id survives as an alias of the kept one. */
export const CONSOLIDATIONS = [
  { id: "UC-TQ-001", into: "UC-IOS-001", reason: "Same root cause (Swift device block vs shared validator). The test-authoring gap is carried in UC-IOS-001.requiredTests." },
  { id: "UC-EXT-011", into: "UC-PROV-004", reason: "Same stale Direct Web Capture legal/card copy (session-before-capture, 'participates')." },
];

/** Findings the lead auditor raised from runtime journeys (not present in any area file). */
export const ADDED_FINDINGS = [
  {
    id: "UC-TRUST-008",
    severity: "P2",
    title: "After the stored original is replaced, Public Verify keeps stating 'original verified' and stored bytes 'verified_current' for up to the 30-day recheck interval; report regeneration answers NOTHING_TO_RECOVER",
    ucs: ["UC-0b", "UC-6"],
    platforms: ["api", "worker", "web"],
    userImpact: "A third party opening a share link sees a Verified badge for bytes that no longer exist in that form.",
    legalImpact: "Public Verify's stored-bytes claim is a periodic attestation presented as current; between rechecks it cannot detect storage-side substitution.",
    securityImpact: "Mitigated in production only if every read is pinned to an Object-Lock-retained VersionId (external proof EP-01).",
    locations: [
      { file: "packages/shared/src/basic-verification.ts", line: 305 },
      { file: "packages/shared-runtime/src/integrity-recheck/authority.ts", line: 81 },
      { file: "services/worker/src/integrity-recheck.ts", line: 11 },
    ],
    reproduction: "Runtime journey J06: web upload → report+package READY → overwrite the stored original object in the disposable (non-locked) MinIO → mint share link → GET /public/verify/<token> → POST /v1/evidence/:id/reports/regenerate → GET again.",
    observed: "basicVerification.original.state='verified' (signature+fingerprint+custody over the recorded digest) and storedBytes.state='verified_current' with lastVerifiedAtUtc before the tamper; regenerate returned outcome NOTHING_TO_RECOVER.",
    expected: "A byte-level claim shown as current either re-reads the pinned version or is labelled with its as-of time and never as a present-tense 'Verified' badge once the interval has not been re-proven; an owner-initiated regeneration re-checks bytes.",
    rootCause: "STORED_BYTES_INTEGRITY 'verified_current' is time-window based (INTEGRITY_RECHECK_INTERVAL_DAYS default 30) and maps to the badge 'Verified'; no read path re-hashes.",
    proof: "runtime-proven",
    remediation: "Render stored-bytes as 'last verified <date>' outside a short window; let owner regeneration/verify trigger a pinned-version recheck; shorten the default interval for public records.",
    requiredTests: "Integration: tamper object then assert Public Verify never renders 'Verified' for storedBytes beyond the configured freshness window; worker recheck test against a versioned bucket.",
    migrationImpact: "none",
    dependsOn: ["UC-TRUST-005"],
    aliases: ["ET-SM-07"],
    runtimeEvidence: ["runtime/journeys-raw.json#J06-integrity-tamper"],
  },
  {
    id: "UC-TQ-007",
    severity: "P2",
    title: "The canonical UC-1 browser acceptance harness cannot pass on main: ET-DC-04 made the OAuth redirect allow-list fail closed, the harness never sets it, and the fixture-env safety scanner refuses to carry it",
    ucs: ["UC-1", "UC-6"],
    platforms: ["extension"],
    userImpact: "The only end-to-end proof of Direct Web Capture fails at AUTH in both projects; nobody can currently re-prove UC-1 with the shipped tooling.",
    legalImpact: "none directly; removes the release gate for the extension channel.",
    securityImpact: "none (the fail-closed product behaviour is correct).",
    locations: [
      { file: "services/api/src/services/auth/extension-oauth.service.ts", line: 37 },
      { file: "scripts/uc1-acceptance-windows.mjs", line: 438 },
      { file: "scripts/local-fixture-env/index.mjs", line: 543 },
      { file: "apps/extension/e2e/direct-web-capture.spec.ts", line: 47 },
    ],
    reproduction: "node scripts/uc1-acceptance-windows.mjs --start-infra --browsers=chromium,edge on a disposable stack.",
    observed: "AUTH FAIL (0.0s) authorize expected 302, got 400 INVALID_CLIENT_OR_REDIRECT in chromium and edge (runtime/uc1-acceptance.log). Supplying EXTENSION_OAUTH_REDIRECT_ALLOW through the fixture env's extra settings is refused: 'UnsafeFixtureEnvironmentError: The fixture environment reaches off this machine' (runtime/uc1-acceptance-audit-copy.log, attempt 2).",
    expected: "The acceptance harness configures the same allow-list the release checklist requires of operators, as a non-dialled redirect value exempt from the outbound-endpoint scan.",
    rootCause: "Commit 5621aeb4 (ET-DC-04) changed isAllowedExtensionRedirect to require an explicit allow-list without updating the harness or the fixture-env scanner.",
    proof: "runtime-proven",
    remediation: "Teach local-fixture-env a typed 'redirect allow-list' setting that is not treated as an endpoint; set it in uc1-acceptance-windows.mjs for the spec's redirect.",
    requiredTests: "Run the acceptance harness in CI (see UC-LCH-003/UC-TQ-002).",
    migrationImpact: "none",
    dependsOn: ["UC-TQ-002"],
    aliases: ["ET-DC-04"],
    runtimeEvidence: ["runtime/uc1-acceptance.log", "runtime/uc1-acceptance-audit-copy.log"],
  },
];

ADDED_FINDINGS.push({
  id: "UC-TQ-008",
  severity: "P2",
  title: "The UC-1 acceptance spec drives capture by having the extension service worker send runtime.sendMessage to itself, which Chrome never delivers; the spec cannot pass even with auth fixed, and several spec steps are unbounded",
  ucs: ["UC-1"],
  platforms: ["extension"],
  userImpact: "No automated proof of the extension capture exists or can exist with this spec.",
  legalImpact: "none directly",
  securityImpact: "none",
  locations: [
    { file: "apps/extension/e2e/direct-web-capture.spec.ts", line: 435 },
    { file: "apps/extension/e2e/direct-web-capture.spec.ts", line: 376 },
    { file: "apps/extension/src/background.ts", line: 153 },
  ],
  reproduction: "tooling/extension-step-probe.mjs on the disposable stack: the spec's exact sw.evaluate(chrome.runtime.sendMessage({kind:'PRESERVE',…})).",
  observed: "worker.evaluate: Error: Could not establish connection. Receiving end does not exist. The same PRESERVE sent from the extension's own page reaches the background but is refused without a user gesture ('Cannot access contents of the page…'), because the manifest relies on activeTab. With auth fixed, the shipped spec's first test hung until its 11.2-minute backstop before any bounded stage printed.",
  expected: "The spec triggers capture through a surface Chrome delivers (an extension page or the action) and grants activeTab the way a user click does (or the test build carries a test-only host permission), with every step bounded.",
  rootCause: "chrome.runtime.sendMessage does not dispatch to listeners in the sending context; the spec was never executed successfully (memory: 'browser E2E needs a real gesture').",
  proof: "runtime-proven",
  remediation: "Drive capture from the popup page with a test-only optional host permission, or via chrome.action.onClicked in a test build; bound serviceWorker(), storage and navigation steps.",
  requiredTests: "The fixed spec green in CI on real Chrome and real Edge channels (see UC-TQ-002).",
  migrationImpact: "none",
  dependsOn: ["UC-TQ-007"],
  aliases: [],
  runtimeEvidence: ["runtime/probes/extension-steps.json", "runtime/uc1-acceptance-audit-copy.log"],
});

/** Runtime evidence that upgrades an area finding from source-proven to runtime-proven. */
export const RUNTIME_BINDINGS = {
  "UC-OUT-001": {
    evidence: ["runtime/probes/report-printed-verify-link.json"],
    observed: "Fresh web-upload record, never published: its report PDF prints a pvs_ 'Public Verification' link; GET /public/verify/<that token> → 404 {message:'Evidence not found'}; publicVerifyState NOT_PUBLISHED; the owner's links panel lists the REPORT link as state ACTIVE.",
  },
  "UC-PROV-002": {
    evidence: ["runtime/probes/j09-report-text-excerpt.txt", "runtime/journeys-phase2-raw.json#J09-continuous-direct-capture-to-public-verify"],
    observed: "Rendered report for an Android continuous record: header 'Android screen recording -- PROOVRA app (client-attested)' but the body field 'CAPTURE METHOD' reads 'Not recorded' (report line 492); the report snapshot JSON carries the correct captureMethodLabel.",
  },
  "UC-ARCH-003": {
    evidence: ["runtime/journeys-phase2-raw.json#J09-continuous-direct-capture-to-public-verify", "runtime/journeys-raw.json#J01-web-upload-to-public-verify"],
    observed: "On the same stack: EVIDENCE_COMPLETED custody events — PROOVRA_WEB_UPLOAD 3 records / 3 events, SECURE_INTAKE_LINK 1 / 0, DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS 1 / 0. The continuous record has no evidence.create / evidence.complete audit action (the web record has both) and 0 reviewer-workflow rows.",
  },
  "UC-DER-001": {
    evidence: ["runtime/journeys-phase2-raw.json#J10-uc4-derived-review"],
    observed: "Generate → 202 queued; reconstruct_screen COMPLETED (4 video_keyframe + 1 screen_reconstruction). Second Generate → 202 {queued:true}; 10 s later the run is still COMPLETED with attempt_count 1 — nothing re-ran.",
  },
  "UC-IOS-001": {
    evidence: ["runtime/probes/continuous-ios.json#iosDeviceShape"],
    observed: "Sealing with the exact device block ProovraBroadcastShared.swift writes ({platform, osVersion, model, appVersion}) → HTTP 422 CONTINUOUS_MANIFEST_INVALID; record stays UPLOADING.",
  },
  "UC-STR-001": {
    evidence: ["runtime/probes/continuous-ios.json#partIndexCap"],
    observed: "POST /v1/evidence/:id/parts partIndex 199 → 201; partIndex 200 → 400 'Too big: expected number to be <=199'; declaration for part 200 → 400.",
  },
  "UC-STR-002": {
    evidence: ["runtime/probes/continuous-ios.json#missingTail"],
    observed: "4 segments recorded (manifest totalDurationMs 4000), tail never declared, 3 segments listed (sum 3000 ms), sessionCompleteness COMPLETE_SESSION → HTTP 200, evidence SIGNED.",
  },
  "UC-EXT-001": {
    evidence: ["runtime/probes/platform-context-shape.json", "runtime/probes/extension-steps.json", "runtime/probes/extension-popup.png"],
    observed: "Real popup (loaded unpacked in Chromium, signed in via real OAuth/PKCE): workspace select shows only No workspace available and both Capture buttons are disabled (screenshot). GET /v1/platform/context → 200 with top-level keys including availableWorkspaces (2 entries) and neither 'workspaces' nor 'teams'; popup.ts returns body.workspaces ?? body.teams ?? [] → [].",
  },
  "UC-SEC-001": {
    evidence: ["runtime/journeys-raw.json#J07-upload-session-member-injection"],
    observed: "Same-workspace MEMBER: presign on the OWNER's session → 200; PUT → 200; parts/0/uploaded → 200; multipart/complete → 200 (serverSha256 = injected digest). evidence_parts row 0 of the owner's record now carries the member's digest and the multipart key. Owner finalize then blocked only by the session's pending verification step (409).",
  },
};

/** Area-finding severity changes made by the lead, with reasons. */
export const SEVERITY_ADJUSTMENTS = [];

export const UC_BUCKET = {
  COMPLETE: "complete",
  "PARTIALLY COMPLETE": "partial",
  "PRESENT BUT UNTRUTHFUL": "partial",
  "PLATFORM-LIMITED": "partial",
  "PRESENT BUT UNREACHABLE": "missing",
  "PRESENT BUT DISCONNECTED": "missing",
  "TEST-ONLY / FIXTURE-ONLY": "missing",
  "NOT IMPLEMENTED": "missing",
  "UNKNOWN WITH AN EXPLICIT BLOCKER": "blocked",
};

export const UC_VERDICTS = [
  {
    uc: "UC-0a",
    name: "Provenance Truth Repair",
    verdict: "PRESENT BUT UNTRUTHFUL",
    rationale: "The acquisition-mode authority, set-once trigger and fail-closed attestation are real and runtime-visible (J01/J08/J09 report snapshots and Public Verify carry the server-recorded mode and IMPORTED_EXISTING_MEDIA tier). But server record-creation time is presented as capture time and on Public Verify as 'declared by the capturing device'; every direct-capture record reads 'Capture Method: Not recorded' in the rendered report (runtime-proven on an Android continuous record) and package; the client still chooses the direct-capture mode label; validated manifest facts (URL, title, browser, completeness) are dropped.",
    keyFindings: ["UC-PROV-001", "UC-PROV-002", "UC-ARCH-001", "UC-PROV-003", "UC-PROV-004", "UC-PROV-005"],
    blockers: [],
  },
  {
    uc: "UC-0b",
    name: "Trust / Attestation Repair",
    verdict: "PARTIALLY COMPLETE",
    rationale: "Signing, custody chain, package seal and share-token verify work end to end (J01, J02; 463/463 API integration incl. public-verify-*, ots-integrity-lifecycle, integrity-recheck). RFC 3161 tokens are now validated with openssl against a configured anchor (tested with a local TSA). Open: OTS PENDING shown as 'Anchored', stored-bytes 'Verified' survives substitution for the recheck window (runtime J06), verdict ignores recheck, signing-key identity mutable, capture trust-event sub-chain never verified. Real TSA/OTS/Object Lock authority is external.",
    keyFindings: ["UC-TRUST-008", "UC-TRUST-005", "UC-TRUST-002", "UC-TRUST-001", "UC-TRUST-003", "UC-TRUST-004"],
    blockers: ["EP-01", "EP-02", "EP-03"],
  },
  {
    uc: "UC-0c",
    name: "Derivative Lifecycle Closure",
    verdict: "PARTIALLY COMPLETE",
    rationale: "One derived-asset authority, tenant binding, destruction sweep and redaction byte gate are in place (worker 1152/1152 executed, 4 Object-Lock cases run separately 4/4). Open: derived bytes bypass the byte-release gate (VIEWER can fetch OCR/keyframes), regeneration overwrites lineage and deletes prior objects, provenance (tool version, parameters, text digest) dropped, package derived manifests silently truncated.",
    keyFindings: ["UC-DER-002", "UC-DER-006", "UC-DER-005", "UC-DER-007", "UC-DER-013", "UC-DER-014"],
    blockers: [],
  },
  {
    uc: "UC-1",
    name: "Chrome / Edge Web Capture",
    verdict: "PRESENT BUT UNREACHABLE",
    rationale: "The server side of Direct Web Capture works (uc1-web-capture + uc1-extension-oauth integration pass). A real user cannot capture: the popup never lists a workspace (runtime-proven), the extension origin is absent from production CORS and host_permissions, it is unpublished, and the shipped acceptance harness fails at AUTH on main. Full-page capture exceeds Chrome's captureVisibleTab quota by construction. No case selection.",
    keyFindings: ["UC-EXT-001", "UC-EXT-003", "UC-SEC-002", "UC-TQ-007", "UC-EXT-004", "UC-EXT-005"],
    blockers: ["EP-04", "EP-05", "EP-12"],
  },
  {
    uc: "UC-2",
    name: "Android Direct Screen Capture",
    verdict: "PARTIALLY COMPLETE",
    rationale: "Server seal path runtime-proven (uc2-screen-capture integration); JS↔Kotlin parity, manifest service declarations and foreground-service typing verified; Android prebuild generated the native project; Hermes bundle builds. Unproven on any device; POST_NOTIFICATIONS is never requested, so on Android 13+ the capture-frame notification action (the only way to capture another app) is suppressed. No share-into-PROOVRA, logout does not stop capture.",
    keyFindings: ["UC-AND-003", "UC-AND-006", "UC-AND-007", "UC-AND-011", "UC-AND-012"],
    blockers: ["EP-06", "EP-07"],
  },
  {
    uc: "UC-3",
    name: "Continuous Capture + Streaming",
    verdict: "PRESENT BUT UNTRUTHFUL",
    rationale: "Seal refuses missing/duplicate/out-of-order/tampered declared segments (uc3 integration, real PG) and the full pipeline to Public Verify works for a sealed session (J09). But a lost TAIL segment seals as SIGNED COMPLETE_SESSION (runtime-proven), part index 200+ is refused while the client allows 600 segments so long recordings are discarded (runtime-proven), and a session is not resumable after app restart.",
    keyFindings: ["UC-STR-002", "UC-STR-001", "UC-AND-004", "UC-STR-003", "UC-STR-006"],
    blockers: ["EP-06"],
  },
  {
    uc: "UC-4",
    name: "Keyframes / OCR / Conversation Reconstruction",
    verdict: "PARTIALLY COMPLETE",
    rationale: "Runtime J10 (real worker, real ffmpeg-static): Generate → reconstruct_screen COMPLETED with 4 keyframes and 1 reconstruction descriptor, labelled DERIVED_RECONSTRUCTED; OCR did not run (ocrAllowed defaults OFF; coverage PARTIAL). A single manual 'Generate Derived Review' path exists, labelled as derived and never as original, with no actor-attribution claims. There is no conversation-capture channel; 'conversation' is OCR screen reconstruction. Retry/Regenerate never run again, OCR runs on ≤256 px keyframes for video sources, dedup cannot merge real chat screens, provenance fields are dropped, and the worker path has no CI-executed behavioural test.",
    keyFindings: ["UC-DER-001", "UC-DER-003", "UC-DER-004", "UC-DER-005", "UC-TQ-003", "UC-DER-010"],
    blockers: [],
  },
  {
    uc: "UC-5",
    name: "iOS",
    verdict: "PRESENT BUT DISCONNECTED",
    rationale: "Swift module, broadcast upload extension, App Group and entitlements exist and are internally consistent, and the server accepts DIRECT_SCREEN_CAPTURE_IOS. But no real iOS recording can be sealed: the device block the Swift code writes is refused by the shared validator (runtime-proven 422). The app cannot stop the broadcast, the last segment always has duration 0, and there is no crash recovery. Native compilation and ReplayKit behaviour are BLOCKED here (no macOS/Xcode).",
    keyFindings: ["UC-IOS-001", "UC-IOS-002", "UC-IOS-004", "UC-IOS-003", "UC-IOS-010"],
    blockers: ["EP-08", "EP-09"],
  },
  {
    uc: "UC-6",
    name: "Full Public Launch",
    verdict: "PARTIALLY COMPLETE",
    rationale: "Web build, extension build, both Hermes bundles and the API/worker suites are green locally; CI runs the API integration project against real PG. Not launched: extension unpublished and unusable, iOS cannot seal, Android unproven on device, PWA not installable, no capture monitoring/runbook, no mobile screen-recording privacy disclosure, extension/native never compiled or run in CI.",
    keyFindings: ["UC-LCH-001", "UC-LCH-002", "UC-LCH-003", "UC-LCH-004", "UC-TQ-002", "UC-TQ-004"],
    blockers: ["EP-04", "EP-05", "EP-06", "EP-07", "EP-08", "EP-09"],
  },
];

/** Product-surface statement per platform. status ∈ WORKS_LOCALLY | BROKEN | NOT_IMPLEMENTED | BLOCKED | PARTIAL */
export const PLATFORM_MATRIX = [
  { platform: "Browser Extension", capture: "BROKEN", evidencePipeline: "WORKS_LOCALLY", caseAtCapture: "NOT_IMPLEMENTED", build: "WORKS_LOCALLY", realBrowser: "SEE_JOURNEY_R05", distribution: "BLOCKED", note: "Popup cannot select a workspace (UC-EXT-001); server path proven by uc1 integration." },
  { platform: "Web", capture: "PARTIAL", evidencePipeline: "WORKS_LOCALLY", caseAtCapture: "NOT_IMPLEMENTED", build: "WORKS_LOCALLY", realBrowser: "NOT_EXECUTED_IN_UI", distribution: "N/A", note: "File/drag/camera/mic upload proven via the product API sequence (J01); no screen capture (getDisplayMedia) or clipboard." },
  { platform: "PWA", capture: "PARTIAL", evidencePipeline: "WORKS_LOCALLY", caseAtCapture: "NOT_IMPLEMENTED", build: "WORKS_LOCALLY", realBrowser: "NOT_EXECUTED_IN_UI", distribution: "BROKEN", note: "Same code as Web; not installable (one 'any' icon, no service worker), no offline, no share_target." },
  { platform: "Android", capture: "BLOCKED", evidencePipeline: "WORKS_LOCALLY", caseAtCapture: "NOT_IMPLEMENTED", build: "PARTIAL", realBrowser: "N/A", distribution: "BLOCKED", note: "Server seal + outputs proven (uc2/uc3 integration, J09). Native compile/device BLOCKED; POST_NOTIFICATIONS never requested (UC-AND-003)." },
  { platform: "iOS", capture: "BROKEN", evidencePipeline: "BROKEN", caseAtCapture: "NOT_IMPLEMENTED", build: "PARTIAL", realBrowser: "N/A", distribution: "BLOCKED", note: "Real device block refused at seal (UC-IOS-001, runtime); native build/device BLOCKED (no macOS)." },
];

/** The 17 required journeys (R15 split into its executed and provider halves). status ∈ PASS | FAIL | BLOCKED */
export const JOURNEYS = [
  { id: "R01", title: "Web/PWA file upload → finalize → report → package → Public Verify", status: "PASS", evidence: ["runtime/journeys-raw.json#J01-web-upload-to-public-verify", "runtime/journeys-raw.json#J02-package-independent-recompute", "runtime/probes/package-recompute.json"], note: "Independent node:crypto recompute of the downloaded package 14/14 (ZIP digest, Ed25519 seal + key fingerprint, checksum index, report digest, fingerprint, evidence signature, original vs SIGNED digest, custody chain replay, 2 negative controls). J01 22/22 checks: server-hashed SIGNED record, report+package READY from the real worker, share link minted through TOTP step-up, token hashed at rest, revoke/rotate/guess all 404, audit trail complete (admin_audit_logs)." },
  { id: "R02", title: "Web/PWA screen capture → outputs", status: "FAIL", evidence: ["sources/ARCH.json#facts.absentChannels"], note: "Channel does not exist: 0 getDisplayMedia call sites in apps/web." },
  { id: "R03", title: "Intake-link submission → outputs", status: "PENDING_PHASE2", evidence: ["runtime/journeys-phase2-raw.json#J08-intake-link-to-public-verify"], note: "" },
  { id: "R04", title: "Evidence Request submission → outputs", status: "BLOCKED", evidence: ["sources/ARCH.json#facts.surfaces.evidence-requests"], note: "Evidence Requests deliver through intake links (no separate byte path); the request send/delivery step needs the communications provider, which is disabled on the disposable stack. The byte path is R03." },
  { id: "R05", title: "Browser extension capture → outputs", status: "PENDING_EXT", evidence: ["runtime/uc1-acceptance.log", "runtime/uc1-acceptance-audit-copy.log"], note: "" },
  { id: "R06", title: "Android flow (strongest available environment)", status: "BLOCKED", evidence: ["runtime/api-integration-capture.json", "runtime/mobile-export.log", "runtime/prebuild/app-AndroidManifest.xml"], note: "No JDK/SDK/device. Strongest available: server seal (uc2/uc3 integration) + Hermes bundle + prebuild manifest; see R08/J09 for the API-driven continuous journey." },
  { id: "R07", title: "iOS flow (strongest available environment)", status: "FAIL", evidence: ["runtime/probes/continuous-ios.json#iosDeviceShape"], note: "Strongest available environment = the real server with the device block the Swift code writes: refused 422." },
  { id: "R08", title: "Continuous/streaming capture with interruption and resume", status: "FAIL", evidence: ["runtime/probes/continuous-ios.json#missingTail", "runtime/probes/continuous-ios.json#partIndexCap", "runtime/journeys-phase2-raw.json#J09-continuous-direct-capture-to-public-verify"], note: "A lost tail seals as COMPLETE_SESSION; >200 segments refused; no resume after app restart (UC-AND-004)." },
  { id: "R09a", title: "Video → keyframes", status: "PENDING_PHASE2", evidence: ["runtime/journeys-phase2-raw.json#J10-uc4-derived-review"], note: "" },
  { id: "R09b", title: "Video → OCR", status: "BLOCKED", evidence: ["runtime/journeys-phase2-raw.json#J10-uc4-derived-review"], note: "Not exercised: workspace AI policy ocrAllowed defaults OFF (projection ocrEnabled:false, coverage PARTIAL) and no Tesseract binary exists on this host; the worker Docker image carries it. Real Tesseract extraction is also unasserted in CI (UC-TQ-003)." },
  { id: "R10", title: "Conversation capture / reconstruction", status: "FAIL", evidence: ["sources/DER.json#facts.uc4"], note: "No conversation-capture channel exists; reconstruction is OCR over screen keyframes whose dedup cannot merge real chat screens (UC-DER-004)." },
  { id: "R11", title: "Add capture to existing Case", status: "PASS", evidence: ["runtime/journeys-raw.json#J03-case-attach-and-tenancy"], note: "Post-hoc link only (no channel accepts a case at capture time). 18/18 incl. cross-tenant, unknown-id, viewer negatives; unlink keeps evidence and workspace." },
  { id: "R12", title: "Create new Evidence from capture", status: "PASS", evidence: ["runtime/journeys-raw.json#J01-web-upload-to-public-verify"], note: "" },
  { id: "R13", title: "Failure and recovery journey", status: "BLOCKED", evidence: ["runtime/api-integration-capture.json"], note: "Not induced end-to-end with the worker in the loop. Integration-level only: report-generation-supersession-recovery, package-recovery-backfill, reports-blocked-update-failed (real PG, storage/signer doubled). Healthy record regenerate → NOTHING_TO_RECOVER (J06)." },
  { id: "R14a", title: "Trash / restore", status: "PASS", evidence: ["runtime/journeys-raw.json#J04-trash-restore"], note: "Soft trash keeps the row (deleted_at set), hides it from the library, restore brings it back live; viewer cannot trash." },
  { id: "R14b", title: "Permanent destruction", status: "BLOCKED", evidence: ["runtime/journeys-phase2-raw.json#J11-destroy-and-free-slot", "runtime/api-integration-capture.json"], note: "Not executed end to end: destruction runs only by executing an approved destruction review (Enterprise feature). J11: FREE record PENDING_DESTRUCTION → 402 ENTERPRISE_FEATURE_REQUIRED, DESTROYED → 409 LIFECYCLE_DESTRUCTION_REQUIRES_REVIEW, row unchanged, FREE slot still held. Integration-level: evidence-destruction-storage, legal-hold-destruction-serialization, defects-destruction-refusals (real PG)." },
  { id: "R15a", title: "FREE allowance: three records, fourth refused, trash keeps the slot", status: "PASS", evidence: ["runtime/journeys-raw.json#J05-free-allowance"], note: "Product-provisioned FREE personal workspace; 4th → 409 FREE_LIMIT_REACHED; after trash still 409." },
  { id: "R15b", title: "Credit purchase / upgrade / downgrade / webhook replay", status: "BLOCKED", evidence: ["runtime/api-integration-capture.json"], note: "Needs Stripe/PayPal sandbox (EP-10/EP-11). Integration-level: stripe-credit-refund-reversal, billing-paypal-integrity, admin-evidence-credit-grant, trash-keeps-allowance-slot passed on real PG." },
  { id: "R16", title: "Share-link create / revoke / replace", status: "PASS", evidence: ["runtime/journeys-raw.json#J01-web-upload-to-public-verify"], note: "" },
  { id: "R17", title: "Integrity mismatch and stale-status journey", status: "FAIL", evidence: ["runtime/journeys-raw.json#J06-integrity-tamper"], note: "After byte substitution Public Verify still states original 'verified' and stored bytes 'verified_current' (UC-TRUST-008)." },
];

export const EXTERNAL_PROOFS = [
  { id: "EP-01", item: "Real Object Lock / WORM retention", locallyProven: "Worker publication suite 4/4 against a MinIO bucket created --with-lock and default COMPLIANCE 1d (checksum kept, retention applied, VersionId pinned, single write per key, locked version survives key delete).", unproven: "AWS acceptance of the exact PUT/copy shapes (MinIO accepts a checksum-less PUT AWS refuses); production bucket default retention; that every read pins VersionId.", requires: "Non-production AWS account + bucket configured like proovra-evidence-prod-eu (Object Lock COMPLIANCE, versioning).", procedure: "Run services/worker/test/verification-package-publication.minio.test.ts with OBJECT_LOCK_MINIO_* pointed at the AWS staging bucket; then tamper-by-new-version and run the integrity recheck.", passCriteria: "4/4 pass; recheck of a record whose key gained a new version still verifies the pinned version; delete of pinned version refused.", risk: "Without it UC-TRUST-008 is unmitigated in production." },
  { id: "EP-02", item: "Real RFC 3161 TSA authority", locallyProven: "openssl ts -verify path tested against a locally minted TSA: forged, expired signer, wrong imprint/nonce/policy, missing anchor, test anchor in production.", unproven: "The configured production TSA's chain, policy OID and availability; TSA_TRUST_BUNDLE_PATH present in production.", requires: "The production TSA endpoint in a staging environment with its trust bundle.", procedure: "Stamp one staging record; assert tsaStatus=STAMPED with validation time; corrupt token → FAILED.", passCriteria: "Validated STAMPED, never RECORDED_NOT_VALIDATED, for new records.", risk: "Timestamps would read RECORDED_NOT_VALIDATED or FAILED at launch." },
  { id: "EP-03", item: "Real OpenTimestamps anchoring", locallyProven: "ots-integrity-lifecycle integration (real PG) and worker OTS recovery tests with the ots binary mocked.", unproven: "Calendar submission, upgrade to a Bitcoin attestation, verification after restart.", requires: "Network access to OTS calendars from staging; days of elapsed time.", procedure: "Enable OTS in staging, create a record, wait for upgrade, run `ots verify` independently.", passCriteria: "ANCHORED only with a Bitcoin attestation that ots verify accepts; PENDING never shown as anchored (UC-TRUST-002).", risk: "'Anchored' claims unproven; currently mislabelled for PENDING." },
  { id: "EP-04", item: "Chrome Web Store distribution", locallyProven: "MV3 manifest validates; release.mjs refuses non-https/localhost origins; local build OK.", unproven: "Store listing, review, production extension id, OAuth redirect registration.", requires: "Chrome Web Store developer account.", procedure: "Publish unlisted; install; complete a capture against staging.", passCriteria: "Capture → Public Verify on the store build.", risk: "UC-1 has no distribution channel." },
  { id: "EP-05", item: "Edge Add-ons distribution", locallyProven: "Same as EP-04; note the acceptance 'edge' project runs bundled Chromium (UC-TQ-002).", unproven: "Store listing and real Edge behaviour.", requires: "Microsoft Partner Center account.", procedure: "As EP-04 with msedge channel.", passCriteria: "Capture → Public Verify in real Edge.", risk: "Edge compatibility unproven." },
  { id: "EP-06", item: "Android physical-device capture (UC-2/UC-3)", locallyProven: "Server seal paths (integration), JS bundle, prebuild manifest with both services declared.", unproven: "MediaProjection consent, foreground service, notification action on API 33+, long recording, rotation, process death.", requires: "Android 13+ physical device with the internal APK.", procedure: "Run the UC-2 and UC-3 device scripts from docs; include a fresh install for POST_NOTIFICATIONS.", passCriteria: "Frames and segments captured from another app, sealed, outputs READY, Public Verify reachable.", risk: "UC-AND-003 likely blocks UC-2 on fresh installs." },
  { id: "EP-07", item: "Android signed release", locallyProven: "eas.json profiles; applicationId com.jalalattar29.proovra.", unproven: "Signed production AAB, Play Console listing.", requires: "EAS credentials + Play Console.", procedure: "eas build -p android --profile production; internal track.", passCriteria: "Installable signed build from Play internal testing.", risk: "No distribution." },
  { id: "EP-08", item: "iOS physical-device ReplayKit behaviour", locallyProven: "Nothing native (no macOS). Server refuses the device block the Swift code writes (runtime).", unproven: "Broadcast start/stop, extension memory limit, App Group handoff, orientation, interruptions.", requires: "macOS + Xcode + device + Apple Developer team 4LCZK75N86.", procedure: "Fix UC-IOS-001/002/004 first, then run the UC-5 device script.", passCriteria: "A broadcast from another app seals SIGNED and verifies publicly.", risk: "UC-5 cannot work today regardless of device." },
  { id: "EP-09", item: "iOS signed / TestFlight release", locallyProven: "Bundle and App Group identifiers consistent across 5 places; AASA carries Team ID 4LCZK75N86.", unproven: "Associated Domains capability on the App ID, provisioning of the broadcast extension, TestFlight build.", requires: "Apple Developer account + EAS.", procedure: "eas build -p ios --profile production; TestFlight.", passCriteria: "TestFlight build installs with the broadcast extension.", risk: "No iOS distribution." },
  { id: "EP-10", item: "Stripe sandbox purchase + webhooks", locallyProven: "stripe-credit-refund-reversal and admin-evidence-credit-grant integration on real PG.", unproven: "Checkout, signed webhooks, replay against Stripe test mode.", requires: "Stripe test-mode keys + webhook secret.", procedure: "Buy one credit as a FREE user, replay the webhook, refund.", passCriteria: "Exactly one credit granted then reversed; 4th record admitted once.", risk: "Purchase path unproven end to end." },
  { id: "EP-11", item: "PayPal sandbox purchase + webhooks", locallyProven: "billing-paypal-integrity integration on real PG.", unproven: "Sandbox order capture and webhook signatures.", requires: "PayPal sandbox app credentials.", procedure: "As EP-10 via PayPal.", passCriteria: "As EP-10.", risk: "Purchase path unproven end to end." },
  { id: "EP-12", item: "Extension OAuth against production configuration", locallyProven: "PKCE, single-use code, capture.direct scope, fail-closed allow-list (integration + the audit-copy browser run).", unproven: "EXTENSION_OAUTH_REDIRECT_ALLOW with the store extension id; CORS for the extension origin (UC-SEC-002); login redirect for signed-out users (UC-EXT-006).", requires: "Store extension id + staging API.", procedure: "Sign in from the store build while signed out of PROOVRA.", passCriteria: "Token issued, capture succeeds, sign-out revokes.", risk: "Extension cannot authenticate in production." },
  { id: "EP-13", item: "Real social-platform capture behaviour", locallyProven: "Nothing platform-specific exists or is claimed (no site logic for Facebook/Instagram/TikTok/X/LinkedIn/marketplaces).", unproven: "Behaviour on login-walled, infinite-scroll and anti-automation pages; captureVisibleTab quota on tall pages (UC-EXT-003).", requires: "Real accounts on each platform, manual operator session.", procedure: "Capture a representative page per platform; inspect manifest limitations.", passCriteria: "Capture completes or records a truthful limitation; nothing claims more than viewport/DOM snapshot.", risk: "Customer expectations for social evidence unproven." },
];

/** Remediation order: dependency-respecting waves. Every open P0/P1 appears; P2/P3 grouped. */
export const REMEDIATION_ORDER = [
  { wave: 1, title: "Make the claimed capture channels able to complete", findings: ["UC-IOS-001", "UC-IOS-004", "UC-IOS-002", "UC-EXT-001", "UC-EXT-003", "UC-SEC-002", "UC-AND-003", "UC-STR-001"], why: "Primary channels that cannot produce a record at all; no migration; mobile needs one native build, extension one store build." },
  { wave: 2, title: "Stop false completeness and false time/verification claims", findings: ["UC-STR-002", "UC-PROV-001", "UC-OUT-001", "UC-CASE-001", "UC-TRUST-008", "UC-TRUST-005", "UC-TRUST-002", "UC-PROV-002"], why: "Records, reports and Public Verify must not say more than was proven; case holds must hold." },
  { wave: 3, title: "Close authorization and byte-release gaps", findings: ["UC-SEC-001", "UC-DER-002", "UC-ARCH-005", "UC-CASE-002", "UC-ARCH-001", "UC-SEC-003", "UC-SEC-004"], why: "Same-workspace and derived-byte exposure; no cross-tenant P0 found." },
  { wave: 4, title: "Converge the per-channel side effects onto the canonical finalizer", findings: ["UC-ARCH-003", "UC-ARCH-002", "UC-CASE-003", "UC-PROV-003", "UC-EXT-004"], why: "Direct-capture and intake records miss custody/audit/reviewer/retention steps only the web route performs." },
  { wave: 5, title: "Restore the proof instruments", findings: ["UC-TQ-007", "UC-TQ-002", "UC-TQ-003", "UC-TQ-004", "UC-LCH-003"], why: "Wire the extension, native and Object-Lock suites into CI so the next regression is visible." },
  { wave: 6, title: "Remaining P2/P3 by area", findings: [], why: "All other open findings, ordered by severity inside each area (see findings.json)." },
];

/** Lead corrections to executed journey runs whose own checks were too weak to grade them. */
export const EXECUTED_RUN_OVERRIDES = {
  "J06-integrity-tamper": {
    gradedVerdict: "FAIL",
    reason: "The driver's final check matched only 'verdict'/'headline' keys and passed vacuously; the captured Public Verify answer after byte substitution reads basicVerification.original.state='verified' and storedBytes.state='verified_current'. Graded by the lead as FAIL (UC-TRUST-008, journey R17).",
  },
  "J11-destroy-and-free-slot": {
    gradedVerdict: "BLOCKED",
    reason: "Its only check is 'governed, non-5xx response'; no destruction was executed (402 ENTERPRISE_FEATURE_REQUIRED, 409 LIFECYCLE_DESTRUCTION_REQUIRES_REVIEW). Graded as BLOCKED for destruction (journey R14b).",
  },
};
