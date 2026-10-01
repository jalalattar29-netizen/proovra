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
  "runtime/remediation/web-screen-capture.json",
  "runtime/remediation/extension-acceptance.json",
];

/** Skips tolerated in the full API integration run (each must be a declared environment skip). */
export const INTEGRATION_SKIPS_ALLOWED = 0;

/** External proofs the audit register did not have a row for. */
export const EXTERNAL_PROOFS_ADDED = [
  {
    id: "EP-14",
    item: "First CI execution of the native-build and browser-acceptance workflows and of the CI steps that refuse skips (real tesseract OCR, Object-Lock publication)",
    locallyProven:
      "Workflows authored (.github/workflows/native-build.yml, uc1-browser-acceptance.yml); the extension acceptance they run passes locally in real Chrome and Edge; the worker OCR test runs when the Tesseract binary exists.",
    unproven:
      "Kotlin and Swift compilation of the native capture modules, the Swift unit tests, the real-tesseract OCR assertion (ci.yml 'Test — worker OCR with the real tesseract engine', UC4_REQUIRE_TESSERACT=1) and the Object-Lock publication step on GitHub runners (no push from this session, so no CI run could be observed). On this host the OCR present-branch test is the worker suite's single skip: the binary is absent and installing it is a package download this session may not make.",
    requires: "The feature branch pushed to GitHub; macOS and Windows runners.",
    procedure: "Push the branch, let both workflows run, read their job logs.",
    passCriteria: "Both workflows green on the branch head; the OCR step executes >= 5 tests with 0 skipped; the Object-Lock step executes 4 with 0 skipped.",
    risk: "Native code that does not compile would only be discovered at release-build time.",
  },
];

/** Code-complete findings and the registered external proof(s) each one waits on. */
export const BLOCKED_EXTERNAL_PROOFS = {
  "UC-AND-003": ["EP-06"],
  "UC-AND-004": ["EP-06"],
  "UC-AND-007": ["EP-06", "EP-14"],
  "UC-AND-011": ["EP-14"],
  "UC-AND-012": ["EP-06"],
  "UC-AND-013": ["EP-06", "EP-14"],
  "UC-IOS-001": ["EP-08", "EP-14"],
  "UC-IOS-002": ["EP-08"],
  "UC-IOS-003": ["EP-08"],
  "UC-IOS-004": ["EP-08", "EP-14"],
  "UC-IOS-005": ["EP-08"],
  "UC-IOS-006": ["EP-08"],
  "UC-IOS-007": ["EP-08"],
  "UC-IOS-008": ["EP-08"],
  "UC-IOS-009": ["EP-08"],
  "UC-IOS-010": ["EP-08"],
  "UC-IOS-012": ["EP-14"],
  "UC-LCH-003": ["EP-14"],
  "UC-TQ-003": ["EP-14"],
  "UC-TQ-004": ["EP-14"],
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
    runs: ["J08-"],
    evidence: ["services/api/test/runtime-proof-evidence-capture-b.integration.test.ts::POST /v1/evidence-requests/:id/send — opens the intake link, notifies the recipient and marks SENT"],
    note: "An Evidence Request delivers through an intake link (no separate byte path): send is proven on real PostgreSQL with the recording mail transport, the byte path by the intake journey on the stack.",
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
    blockers: ["EP-08", "EP-09", "EP-14"],
    evidence: ["services/api/test/uc5-ios-screen-capture.integration.test.ts", "apps/mobile/test/ios-broadcast-contract.test.mjs"],
    note: "The device block the Swift extension writes now seals 200 SIGNED on the real server (it was refused 422 at the baseline); ReplayKit itself needs macOS and a device.",
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
    evidence: ["services/worker/test/uc4-tesseract-ocr.test.ts", "services/worker/test/uc4-screen-intelligence-persistence.integration.test.ts"],
    note: "OCR wiring, bounds and persistence are proven against live PostgreSQL; the Tesseract binary is absent on this host (the worker suite's one skip), and the real-text assertion is REQUIRED in ci.yml's OCR step, which has not run yet.",
  },
  R10: {
    status: "BLOCKED",
    blockers: ["EP-13", "EP-14"],
    evidence: ["packages/shared/tests/screen-reconstruction.test.mjs", "services/worker/test/uc4-reconstruction.test.ts"],
    note: "Reconstruction now merges realistic chat screens (UC-DER-004 fixtures); real conversation apps and real OCR remain external.",
  },
  R11: { runs: ["J03-"], evidence: ["services/api/test/completion-cross-channel.integration.test.ts::an intake link issued for a case puts the submitted record IN the case (once, source INTAKE)"] },
  R12: { runs: ["J01-"] },
  R13: { runs: ["J12-"] },
  R14a: { runs: ["J04-"] },
  R14b: { runs: ["J13-"] },
  R15a: { runs: ["J05-"] },
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
    note: "Server seal and outputs proven on the stack (J09) and real PostgreSQL; the direct-session API accepts a case, the app does not yet send one. Native compile and device behaviour are EP-06/07/14.",
  },
  {
    platform: "iOS",
    capture: "BLOCKED",
    evidencePipeline: "WORKS_LOCALLY",
    caseAtCapture: "SERVER_ONLY",
    build: "PARTIAL",
    realBrowser: "N/A",
    distribution: "BLOCKED",
    note: "The device block the extension writes now seals SIGNED on the real server (golden fixture); Swift compile, ReplayKit and TestFlight are EP-08/09/14. The direct-session API accepts a case, the app does not yet send one.",
  },
];

export const CONVERGENCE_AFTER = {
  verdict: "CONVERGED WRITERS AND SIDE EFFECTS",
  statement:
    "Every live capture channel still reaches ONE Evidence writer, ONE part writer, ONE custody appender, ONE report builder, ONE package builder and ONE Public Verify route, and now also ONE canonical finalizer that owns the completion side effects: custody EVIDENCE_COMPLETED, reviewer-workflow initialisation, tenant audit and workspace retention run exactly once for web upload, direct capture and intake alike (UC-ARCH-002/003, proven on real PostgreSQL by completion-cross-channel.integration.test.ts). The iOS manifest reaches the finalizer (UC-IOS-001 server side); its native half awaits EP-08.",
};
