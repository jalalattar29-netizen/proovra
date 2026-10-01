/**
 * Lead adjudication AFTER remediation — the inputs build.mjs needs to restate the audit's
 * verdicts on the remediated source. Everything mechanical (finding status, UC verdict,
 * journey PASS/FAIL from runs, conservation) is computed by build.mjs from the ledger and
 * the recorded runs; this file holds only what a run cannot decide by itself:
 *   - which registered external proof each code-complete-but-unproven finding waits on,
 *   - which runs / tests / external proofs decide each required journey,
 *   - which journeys exercise which UC,
 *   - the restated platform matrix and convergence verdict (with the evidence named).
 */

export const REMEDIATION_META = {
  branch: "fix/universal-evidence-capture-closure",
  baseSha: "47034f45403e87089b29571e3e702311c9d1a2a4",
  notes: [
    "Every finding has exactly one ledger row; dispositions are FIXED_RUNTIME_PROVEN, FIXED_SOURCE_AND_TEST_PROVEN or BLOCKED_EXTERNAL_PROOF only (no deferred, unknown or accepted-risk row).",
    "BLOCKED_EXTERNAL_PROOF means the code change is made and tested to the limit of this host; the remaining proof needs a device, macOS, a store, a sandbox or a CI runner that this environment does not have.",
    "Remediated runtime evidence was produced on disposable loopback infrastructure only (PostgreSQL 16, Redis 7, MinIO); no Production system, credential or data was touched.",
    "The audit's findings, observations and baseline verdicts are kept verbatim; the post-remediation state is added beside them, never written over them.",
  ],
};

/** Run files produced on the remediated stack (each holds { journeys: [...] }). */
export const REMEDIATION_RUN_FILES = [
  "runtime/remediation/journeys-raw.json",
  // J11 on its own seed: it needs a FREE user whose allowance J05 has not used.
  "runtime/remediation/journeys-j11-raw.json",
  // J16 on its own seed: a FREE user whose allowance nothing else has used.
  "runtime/remediation/journeys-j16-raw.json",
  "runtime/remediation/derived-thumbnails.json",
  "runtime/remediation/web-screen-capture.json",
  "runtime/remediation/extension-acceptance.json",
];

/** Skips tolerated in the full API integration run (each must be a declared environment skip). */
export const INTEGRATION_SKIPS_ALLOWED = 0;

/** External proofs the audit register did not have a row for. */
export const EXTERNAL_PROOFS_ADDED = [
  {
    id: "EP-14",
    item: "Native unit tests on CI runners (Swift XCTest on macOS; Android JVM/instrumented tests) and a stack-level Video -> OCR run with the real engine — the remainder after feature CI closed compilation, browser acceptance, real-tesseract OCR on fixtures and Object-Lock publication",
    locallyProven:
      "FEATURE CI, fix/universal-evidence-capture-closure (2026-10-01): native-build.yml run 36865158339 — Swift compiled for the iOS simulator on macos-14 / Xcode 16.2 with ProovraBroadcast.appex embedded (refusal gate passed) and Kotlin compiled (Gradle :app:assembleDebug); uc1-browser-acceptance.yml run 36870336646 — real Chrome 4/4 + real Edge 4/4 on Windows, Chrome 4/4 headed on Linux, per-browser results counted; ci.yml build-test run 36864604761 — 'Test — worker OCR with the real tesseract engine' (UC4_REQUIRE_TESSERACT=1, >= 5 executed, 0 skipped) and 'Test — worker Object-Lock publication (MinIO, locked bucket)' both success; schema-reproducibility.yml run 36864604662 — the worker UC-4 live-PostgreSQL integration step success. These closed UC-TQ-003, UC-TQ-004, UC-LCH-003 and UC-AND-011.",
    unproven:
      "No Swift unit test (XCTest) exists or runs for ProovraDarwinNotify's observer identity (UC-IOS-012). The Android stop()-throws instrumented test (UC-AND-007) and the null-projection unit test (UC-AND-013) have not executed; those two also need EP-06 for device behaviour. Journey R09b (a recorded video through derived OCR on a running stack with the real engine) has not run: CI proves the engine on fixtures and the persistence path, and this host has no Tesseract binary.",
    requires: "An XCTest target for the native module run on a macOS runner; an Android test source set run by Gradle on CI (an emulator for the instrumented case).",
    procedure: "Add the tests, wire them into native-build.yml, push, read the job results.",
    passCriteria: "The named tests execute (not skipped) and pass on the branch head.",
    risk: "Native lifecycle regressions in the observer/teardown paths would be caught only on a device.",
  },
];

/** Code-complete findings and the registered external proof(s) each one waits on. */
export const BLOCKED_EXTERNAL_PROOFS = {
  "UC-AND-003": ["EP-06"],
  "UC-AND-004": ["EP-06"],
  "UC-AND-007": ["EP-06", "EP-14"],
  "UC-AND-012": ["EP-06"],
  "UC-AND-013": ["EP-06", "EP-14"],
  "UC-IOS-001": ["EP-08"],
  "UC-IOS-002": ["EP-08"],
  "UC-IOS-003": ["EP-08"],
  "UC-IOS-004": ["EP-08"],
  "UC-IOS-005": ["EP-08"],
  "UC-IOS-006": ["EP-08"],
  "UC-IOS-007": ["EP-08"],
  "UC-IOS-008": ["EP-08"],
  "UC-IOS-009": ["EP-08"],
  "UC-IOS-010": ["EP-08"],
  "UC-IOS-012": ["EP-14"],
};

/**
 * Each required journey after remediation. `runs` = run-id prefixes in REMEDIATION_RUN_FILES
 * (every one must PASS); `status` = decided without a stack run, with the evidence named;
 * BLOCKED always names the external proof(s).
 */
export const JOURNEYS_AFTER = {
  R01: { runs: ["J01-", "J02-"], evidence: ["runtime/remediation/package-recompute.json"] },
  R02: { runs: ["R02-web-screen-capture"] },
  R03: { runs: ["J08-"] },
  R04: {
    runs: ["J14-"],
    evidence: ["services/api/test/runtime-proof-evidence-capture-b.integration.test.ts::POST /v1/evidence-requests/:id/send — opens the intake link, notifies the recipient and marks SENT"],
    note: "Driven end to end on the stack (Evidence Requests enabled): create, send with intake link and recorded recipient notification, contributor submission, record in the requesting workspace, outputs. External mail delivery itself is not exercised (recording transport).",
  },
  R05: { runs: ["R05-extension-real-browsers"] },
  R06: {
    status: "BLOCKED",
    blockers: ["EP-06", "EP-07"],
    evidence: ["services/api/test/uc2-android-screen-capture.integration.test.ts", "services/api/test/uc3-continuous-capture.integration.test.ts", "runtime/remediation/journeys-raw.json#J09-continuous-direct-capture-to-public-verify"],
    note: "Server side proven on the stack and on real PostgreSQL; MediaProjection, foreground service and notifications need a physical Android device.",
  },
  R07: {
    status: "BLOCKED",
    blockers: ["EP-08", "EP-09"],
    evidence: ["services/api/test/uc5-ios-screen-capture.integration.test.ts", "apps/mobile/test/ios-broadcast-contract.test.mjs", "native-build.yml run 36865158339 ios-simulator-build (Swift compiled, ProovraBroadcast.appex embedded)"],
    note: "The device block the Swift extension writes now seals 200 SIGNED on the real server (it was refused 422 at the baseline), and the app + Broadcast Upload Extension compile and package on macOS CI; ReplayKit broadcasting itself needs a physical device.",
  },
  R08: {
    runs: ["J09-"],
    blockers: ["EP-06"],
    evidence: ["services/api/test/uc3-continuous-completeness.integration.test.ts"],
    note: "Missing tail/middle, duplicate and conflicting segments, seal racing and interruption are proven on real PostgreSQL; resume after an app/process restart needs a device.",
  },
  R09a: { runs: ["J10-"] },
  R09b: {
    status: "BLOCKED",
    blockers: ["EP-14"],
    evidence: [
      "services/worker/test/uc4-tesseract-ocr.test.ts",
      "services/worker/test/uc4-screen-intelligence-persistence.integration.test.ts",
      "ci.yml build-test run 36864604761: 'Test — worker OCR with the real tesseract engine' success (UC4_REQUIRE_TESSERACT=1, >= 5 executed, 0 skipped)",
      "schema-reproducibility.yml run 36864604662: worker UC-4 live-PostgreSQL integration success",
    ],
    note: "OCR wiring, bounds and persistence are proven against live PostgreSQL, and real-text extraction by the real Tesseract engine is now proven in feature CI on fixtures. The journey itself — a recorded video through derived OCR on a running stack — has not run with the real engine (this host has no binary).",
  },
  R10: {
    status: "BLOCKED",
    blockers: ["EP-13"],
    evidence: ["packages/shared/tests/screen-reconstruction.test.mjs", "services/worker/test/uc4-reconstruction.test.ts", "ci.yml build-test run 36864604761: real-tesseract OCR step success"],
    note: "Reconstruction now merges realistic chat screens (UC-DER-004 fixtures) and the real OCR engine is CI-proven on fixtures; real conversation apps remain external.",
  },
  R11: { runs: ["J03-"], evidence: ["services/api/test/completion-cross-channel.integration.test.ts::an intake link issued for a case puts the submitted record IN the case (once, source INTAKE)"] },
  R12: { runs: ["J01-"] },
  R13: { runs: ["J12-"] },
  R14a: { runs: ["J04-"] },
  R14b: { runs: ["J13-"] },
  R15a: { runs: ["J05-", "J16-"] },
  R15b: {
    status: "BLOCKED",
    blockers: ["EP-10", "EP-11"],
    evidence: ["services/api/test/billing-paypal-integrity.integration.test.ts", "services/api/test/billing-allowance-commitments.integration.test.ts"],
    note: "Needs Stripe/PayPal sandboxes; the commercial rules are proven on real PostgreSQL.",
  },
  R16: { runs: ["J01-"] },
  R17: { runs: ["J06-"], evidence: ["services/api/test/public-verify-stored-bytes-truth.integration.test.ts"] },
};

/** Which required journeys exercise which UC (a FAIL here keeps the UC from COMPLETE). */
export const UC_JOURNEYS = {
  "UC-0a": ["R01", "R03"],
  "UC-0b": ["R01", "R17"],
  "UC-0c": ["R09a"],
  "UC-1": ["R05"],
  "UC-2": ["R06"],
  "UC-3": ["R08"],
  "UC-4": ["R09a", "R09b", "R10"],
  "UC-5": ["R07"],
  "UC-6": ["R01", "R02", "R03", "R04", "R11", "R12", "R13", "R14a", "R14b", "R15a", "R15b", "R16"],
};

export const UC_BUCKET_AFTER = {
  "CODE COMPLETE, EXTERNAL PROOF REQUIRED": "blocked",
  "COMPLETE LOCALLY, EXTERNAL PROOF PENDING": "blocked",
};

export const PLATFORM_AFTER = [
  {
    platform: "Browser Extension",
    capture: "WORKS_LOCALLY",
    evidencePipeline: "WORKS_LOCALLY",
    caseAtCapture: "WORKS_LOCALLY",
    build: "WORKS_LOCALLY",
    realBrowser: "SEE_JOURNEY_R05",
    distribution: "BLOCKED",
    note: "Workspace selection, case at capture and DOM-snapshot truth fixed; real Chrome and Edge acceptance on the remediated stack (R05). Store listing and production OAuth are EP-04/05/12.",
  },
  {
    platform: "Web",
    capture: "WORKS_LOCALLY",
    evidencePipeline: "WORKS_LOCALLY",
    caseAtCapture: "NOT_IMPLEMENTED",
    build: "WORKS_LOCALLY",
    realBrowser: "SEE_JOURNEY_R02",
    distribution: "N/A",
    note: "File/camera/mic upload (R01) and browser screen recording through getDisplayMedia in real Chromium (R02). The Capture page does not take a case; records are linked to a case afterwards (R11).",
  },
  {
    platform: "PWA",
    capture: "WORKS_LOCALLY",
    evidencePipeline: "WORKS_LOCALLY",
    caseAtCapture: "NOT_IMPLEMENTED",
    build: "WORKS_LOCALLY",
    realBrowser: "WORKS_LOCALLY",
    distribution: "WORKS_LOCALLY",
    note: "Installable by Chromium's own criteria (CDP getInstallabilityErrors empty), service worker with a network-only policy for API and evidence bytes, offline page (UC-LCH-004).",
  },
  {
    platform: "Android",
    capture: "BLOCKED",
    evidencePipeline: "WORKS_LOCALLY",
    caseAtCapture: "SERVER_ONLY",
    build: "PARTIAL",
    realBrowser: "N/A",
    distribution: "BLOCKED",
    note: "Server seal and outputs proven on the stack (J09) and real PostgreSQL; the direct-session API accepts a case, the app does not yet send one. The Kotlin capture services COMPILE in feature CI (native-build run 36865158339, Gradle :app:assembleDebug); device behaviour, the native unit/instrumented tests and the signed release are EP-06/14/07.",
  },
  {
    platform: "iOS",
    capture: "BLOCKED",
    evidencePipeline: "WORKS_LOCALLY",
    caseAtCapture: "SERVER_ONLY",
    build: "PARTIAL",
    realBrowser: "N/A",
    distribution: "BLOCKED",
    note: "The device block the extension writes now seals SIGNED on the real server (golden fixture), and the app + ProovraBroadcast extension COMPILE and package in feature CI (native-build run 36865158339, macos-14 / Xcode 16.2, .appex embedded); ReplayKit on a device, the Swift unit test and TestFlight are EP-08/14/09. The direct-session API accepts a case, the app does not yet send one.",
  },
];

export const CONVERGENCE_AFTER = {
  verdict: "CONVERGED WRITERS AND SIDE EFFECTS",
  statement:
    "Every live capture channel still reaches ONE Evidence writer, ONE part writer, ONE custody appender, ONE report builder, ONE package builder and ONE Public Verify route, and now also ONE canonical finalizer that owns the completion side effects: custody EVIDENCE_COMPLETED, reviewer-workflow initialisation, tenant audit and workspace retention run exactly once for web upload, direct capture and intake alike (UC-ARCH-002/003, proven on real PostgreSQL by completion-cross-channel.integration.test.ts). The iOS manifest reaches the finalizer (UC-IOS-001 server side); its native half awaits EP-08.",
};
