/**
 * Lead adjudication for the remediation ledger. Lane reports (lanes/*.json) carry the per-finding
 * decisions, red and green proofs. This file (a) attributes commits whose message cited an id only
 * inside a range, and (b) adjudicates rows a lane left NEEDS_MIGRATION / NEEDS_CROSS_LANE once the
 * migration or the other half landed — each with the resolving commits and the re-run proof.
 */
export const AUDIT_BRANCH = "audit/universal-evidence-capture-truth";
export const AUDIT_SHA = "3bfffe6b";
export const AUDIT_REMOTE_STATUS =
  "PUSHED by the owner — origin/audit/universal-evidence-capture-truth = 3bfffe6b56ae18086c4f16d49ff5afff8385bbd6, equal to the local head (verified by fetch 2026-10-01)";

/** Feature-CI runs (fix/universal-evidence-capture-closure) that executed the named external proofs. */
const CI = {
  buildTest:
    "ci.yml build-test, run 36864604761 job 110376873717 @ 7145ad51 (also green @ a7e022f0, run 36865158391)",
  schema:
    "schema-reproducibility.yml clean-db-boot, run 36864604662 job 110376873013 @ 7145ad51 (also green @ 394a3a2f, ae7f1b85, 705cfbf8, a7e022f0)",
  native:
    "native-build.yml run 36865158339 @ a7e022f0: ios-simulator-build job 110378735897 (macos-14, Xcode 16.2: xcodebuild app + ProovraBroadcast, then 'Refuse a build without the broadcast extension' PASSED) and android-debug-build job 110378735982 (Gradle :app:assembleDebug)",
  nativeUnit:
    "native-build.yml run 36940211660 @ 3ff95c0b (ios-simulator-build job 110629704934; android-debug-build job 110629704584)",
  browser:
    "uc1-browser-acceptance.yml run 36870336646 @ ca991687: windows-acceptance job 110396168173 (real Google Chrome 4/4 + real Microsoft Edge 153 4/4, 'UC-1 CLOSED (browser gate) [PASS]') and linux-extension-e2e job 110396167871 (Chrome 154 headed under xvfb, 4/4); each project's JSON result counted (executed > 0)",
};
export const BASE_SHA = "47034f45403e87089b29571e3e702311c9d1a2a4";

const RANGE_M = "commit 6934514c cites 'UC-IOS-001..UC-IOS-012' / 'UC-AND-011..013' as a range; it is lane M's native batch";
const range = (ids, commits, reason) => Object.fromEntries(ids.map((id) => [id, { commits, reason }]));

export const COMMIT_ATTRIBUTION = {
  ...range(
    ["UC-IOS-002", "UC-IOS-003", "UC-IOS-004", "UC-IOS-005", "UC-IOS-006", "UC-IOS-007", "UC-IOS-008", "UC-IOS-009", "UC-IOS-010", "UC-IOS-011", "UC-IOS-012", "UC-AND-011", "UC-AND-012", "UC-AND-013"],
    ["6934514c"],
    RANGE_M,
  ),
  // Overrides the range entries above for these three (an object spread keeps
  // the LAST value), so each lists lane M's batch AND the unit-proof commit.
  ...range(
    ["UC-IOS-012", "UC-AND-013"],
    ["6934514c", "5153c237"],
    "lane M's native batch + the missing unit proof (ProovraDarwinNotify's own file + XCTest; CaptureDecisions.kt + JUnit), run by native-build",
  ),
  "UC-ARCH-005": { commits: ["718a4d15"], reason: "the part-writer intake refusal shipped inside lane A's batch" },
  "UC-DER-010": { commits: ["69e995c5", "b4b03538"], reason: "lane D route half + lane T report/package bridge half" },
  "UC-EXT-004": { commits: ["1fd1813d", "6934514c", "5e145b8c"], reason: "extension builder, shared DOM_SNAPSHOT_MISSING code + validator coherence, builder emits the code" },
  "UC-EXT-006": { commits: ["1fd1813d", "0364d89a"], reason: "server sign-in redirect + web /auth/extension/continue page" },
  "UC-LCH-001": { commits: ["0364d89a", "0f6f9244"], reason: "disclosure page + slug registration, corpus and mobile links" },
  "UC-PROV-003": { commits: ["6934514c", "b4b03538"], reason: "persistence (lane M) + display (lane T)" },
  "UC-SEC-002": { commits: ["718a4d15", "1fd1813d"], reason: "server CORS for exact extension origins + extension host access" },
  "UC-SEC-004": { commits: ["1fd1813d", "6934514c"], reason: "extension sessions + target-workspace policy at session open" },
  "UC-TQ-002": { commits: ["1fd1813d", "0364d89a"], reason: "spec launches real chrome/msedge + CI workflow" },
  "UC-TQ-003": { commits: ["69e995c5", "0364d89a"], reason: "behavioural tests + CI worker-integration step" },
  "UC-WEB-001": { commits: ["718a4d15", "0364d89a"], reason: "server resume into the same record + web hook" },
  "UC-ARCH-006": { commits: ["718a4d15", "b4b03538"], reason: "shared digest module + worker switched to it" },
  "UC-ARCH-007": { commits: ["6934514c", "0364d89a"], reason: "dead client surfaces + honest security-center copy and docs" },
  "UC-CASE-005": { commits: ["718a4d15", "0364d89a"], reason: "projection of all visible linked cases + web render" },
  "UC-LCH-002": { commits: ["0364d89a", "7af5861c"], reason: "alert rules/runbook + counters bumped at failure points" },
  "UC-SEC-006": { commits: ["718a4d15", "6934514c", "b4b03538"], reason: "presign + capture-open + verify limiters on the global bound" },
  "UC-TRUST-006": { commits: ["b4b03538", "0364d89a"], reason: "readiness + validator + env template, and the trust configuration doc" },
  "UC-TRUST-003": { commits: ["b4b03538", "5b17f332", "d87a3673"], reason: "key registry + migration + persisted signing-key fingerprint compared at verify" },
  "UC-TRUST-004": { commits: ["b4b03538", "5b17f332", "24846684"], reason: "chain verification + append-only trigger + V2 hash on write" },
  "UC-OUT-005": { commits: ["b4b03538", "d87a3673"], reason: "share route + publication accepts the owner's personal workspace" },
  "UC-ARCH-002": { commits: ["718a4d15", "193e42c4"], reason: "createEvidence applies retention for every channel + legacy backfill migration" },
  "UC-CASE-004": { commits: ["718a4d15"], reason: "conflict-safe insert + migration 20281001000200 in the same batch" },
  "UC-COM-004": { commits: ["718a4d15"], reason: "ensureEntitlement everywhere + migration 20281001000300 in the same batch" },
  "UC-PROV-009": { commits: ["718a4d15"], reason: "trigger function migration 20281001000100 in the same batch" },
};

const RERUN_API = "TEST_DATABASE_URL=postgresql://pv:pv@127.0.0.1:58811/proovra_ucc_test (fully migrated) … npx vitest run --config vitest.integration.config.ts";

/** id -> { status, proofKind?, note, green? } merged over the lane row(s) by build-ledger.mjs */
export const DECISIONS = {
  "UC-ARCH-002": {
    status: "FIXED",
    proofKind: "integration-real-db",
    note: "Forward fix in createEvidence (all channels) plus the legacy backfill 20281001000700 (BACKFILL, Release C after a backup), proven by executing the migration SQL verbatim against seeded legacy rows and controls.",
    migration: "20281001000700_retention_backfill_direct_capture (BACKFILL, Release C WAIT_FOR_BACKFILL_READINESS, after a backup)",
    green: { tests: ["services/api/test/completion-cross-channel.integration.test.ts", "services/api/test/retention-backfill-direct-capture.integration.test.ts"], command: RERUN_API, result: "8 + 1 passed" },
  },
  "UC-ARCH-005": {
    status: "FIXED",
    note: "The owner door of the canonical part writer refuses SECURE_INTAKE_LINK records (lead applied lane A's exact request in the part writer).",
    green: { tests: ["services/api/test/completion-cross-channel.integration.test.ts::the link creator cannot add parts to, or seal, a contributor's in-flight intake record"], command: RERUN_API, result: "8 passed" },
  },
  "UC-DER-010": {
    status: "FIXED",
    note: "Routes bind the personal workspace (lane D); report and package bridges resolve it too (lane T).",
    green: { tests: ["services/api/test/derived-review-release-and-generations.integration.test.ts", "services/worker/test/report-trust-truth.test.ts"], command: "lanes D + T", result: "passed" },
  },
  "UC-EXT-004": {
    status: "FIXED",
    note: "Shared code DOM_SNAPSHOT_MISSING + validator coherence (any limitation forbids COMPLETE); the extension builder now emits the code (red on the previous builder, green now).",
    green: { tests: ["apps/extension/test/manifest-builder.test.mjs::a missing DOM snapshot ... as DOM_SNAPSHOT_MISSING"], command: "pnpm --filter @proovra/extension test", result: "85/85" },
  },
  "UC-EXT-006": {
    status: "FIXED",
    proofKind: "integration-real-db",
    note: "Signed-out users are redirected to web sign-in (server) and returned through /auth/extension/continue, which validates every OAuth parameter before forwarding (web).",
    green: { tests: ["apps/web/__tests__/render/extension-continue.render.test.tsx"], command: "npx vitest run --config vitest.render.config.ts", result: "passed (29 in the re-run batch)" },
  },
  "UC-LCH-001": {
    status: "FIXED",
    proofKind: "unit",
    note: "screen-capture slug registered, corpus regenerated (26 documents, --check fresh), linked from Android UC-2/UC-3 and iOS UC-5 intros; the native destination register records the extension bridge as a platform difference.",
    green: { tests: ["apps/web/__tests__/legal-screen-capture-disclosure.test.ts", "apps/web/__tests__/legal-corpus-freshness.test.ts", "apps/mobile/test/product-manifest-coverage.test.mjs"], command: "node scripts/run-tests.mjs legal ; node --test", result: "56/56 legal; 14/14 manifest coverage" },
  },
  "UC-PROV-003": {
    status: "FIXED",
    note: "Manifest facts persisted on the trust chain (M) and rendered as reported by the capture client, domain-only on Public Verify (T).",
    green: { tests: ["services/api/test/provenance-chain-truth.integration.test.ts"], command: RERUN_API, result: "passed" },
  },
  "UC-SEC-002": {
    status: "FIXED",
    note: "CORS admits exact configured extension origins only (fail closed); release builds declare host access to exactly the API and storage origins.",
    green: { tests: ["services/api/test/cors-browser-headers.integration.test.ts"], command: RERUN_API, result: "2 passed" },
  },
  "UC-SEC-004": {
    status: "FIXED",
    note: "Extension tokens are registered sessions and pass the TARGET workspace's org security policy at session open (fail closed).",
    green: { tests: ["services/api/test/uc1-extension-oauth-session.integration.test.ts", "services/api/test/capture-scope-and-draft-authority.integration.test.ts"], command: RERUN_API, result: "passed" },
  },
  "UC-TQ-002": {
    status: "FIXED",
    proofKind: "runtime",
    note: "The spec launches the project's real channel and asserts browser identity; the shipped harness passed 4/4 fixtures in real Chrome 153 and real Edge 154. Feature CI now runs it on GitHub-hosted Windows and Linux runners and it passed (see the green tests); the workflow refuses a run whose per-browser JSON result executed nothing.",
    green: { tests: ["node scripts/uc1-acceptance-windows.mjs --start-infra --browsers=chromium,edge", CI.browser], command: "lane E acceptance run ; GitHub Actions (feature branch push)", result: "UC-1 CLOSED (browser gate) [PASS] ; Chrome 4/4 + Edge 4/4 (windows), Chrome 4/4 (linux)" },
  },
  "UC-TQ-003": {
    status: "FIXED",
    note: "Behavioural handler tests (DB-free in the unit job, live PG in the new worker-integration CI step).",
    green: { tests: ["services/worker/test/uc4-screen-intelligence-handler.integration.test.ts", "services/worker/test/uc4-screen-intelligence-persistence.integration.test.ts"], command: "lanes D + W", result: "22/22" },
  },
  "UC-WEB-001": {
    status: "FIXED",
    note: "Finish & Sign resumes into the same record (server answers resumed:true with the parts already present; the hook uploads only the missing ones).",
    green: { tests: ["apps/web/__tests__/render/capture-finalize-resume.render.test.tsx"], command: "npx vitest run --config vitest.render.config.ts", result: "passed" },
  },
  "UC-ARCH-006": {
    status: "FIXED",
    note: "One shared integrity digest module; API completion and the worker (integrity recheck, report gate) import it.",
    green: { tests: ["services/api/test/integrity-digest-golden.test.ts", "services/worker/test/integrity-recheck-signed-digest.test.ts"], command: "npx vitest run", result: "3 + 4 passed" },
  },
  "UC-ARCH-007": {
    status: "FIXED",
    note: "Dead device-registration/attestation client surfaces removed after proving no consumer (M); the security-center section and docs no longer imply device-signed or attested capture (W).",
    green: { tests: ["services/api/test/capture-trust-client-surfaces.test.ts", "apps/web/__tests__/render/capture-devices-honesty.render.test.tsx"], command: "npx vitest run", result: "5 + render passed" },
  },
  "UC-CASE-004": {
    status: "FIXED",
    note: "Migration 20281001000200 landed (fail closed, deletes nothing); the concurrent-attach test passes on the fully migrated DB.",
    green: { tests: ["services/api/test/case-hold-and-links.integration.test.ts::CASE-004"], command: RERUN_API, result: "6 passed" },
  },
  "UC-CASE-005": {
    status: "FIXED",
    note: "Every visible linked case projected with case-access narrowing (A) and rendered with per-case removal and the hold refusal (W).",
    green: { tests: ["apps/web/__tests__/render/evidence-linked-cases.render.test.tsx"], command: "npx vitest run --config vitest.render.config.ts", result: "passed" },
  },
  "UC-COM-003": {
    status: "FIXED",
    note: "The full integration run (fresh DB) found the admission arithmetic counted SEALED records over the allowance as credit commitments, so a lapsed tenant's banked credit was never usable (409 while billing said CREDIT_AVAILABLE). Fixed in 068efffd: pending = min(unsealed, occupying - cap); the lapsed-plan race test keeps its settlement proof and now asserts the second HTTP admission is refused.",
    green: {
      tests: [
        "services/api/test/lapsed-plan-creation-policy.integration.test.ts::lapsed with a valid credit: the record is admitted, funded by the credit, and earns its outputs",
        "services/api/test/lapsed-plan-creation-policy.integration.test.ts::two lapsed records settling on ONE credit: exactly one is funded, the balance never goes negative",
      ],
      command: RERUN_API,
      result: "lapsed-plan 9/9 + commitments 8/8 (red before 068efffd: 409 != 201)",
    },
  },
  "UC-DER-012": {
    status: "FIXED",
    proofKind: "runtime",
    note: "The finding's required proof (real browser, cross-origin API) was executed on the final stack: real Chromium on the web origin (:3311) opens the record's Derived Review tab and loads every real keyframe of the record (8) from the API origin (:4000) through an image carrying the component's exact attributes (crossOrigin=use-credentials): all load (non-zero size), every bytes request carries the session cookie and is answered 200. With no OCR engine on this host there are no text blocks, which is where the tab nests the thumbnails, so the component itself is exercised by its render test.",
    green: {
      tests: ["runtime/remediation/derived-thumbnails.json#DER012-derived-thumbnails-cross-origin (6/6)", "apps/web/__tests__/render/media-intelligence-derived-review.render.test.tsx::DER-012"],
      command: "node tooling/derived-thumbnails-probe.mjs <seed> runtime/remediation/journeys-raw.json runtime/remediation/derived-thumbnails.json",
      result: "6/6",
    },
  },
  "UC-TQ-003": {
    status: "FIXED",
    proofKind: "runtime",
    note: "EP-14 CLOSED BY FEATURE CI. The external proof this row waited for has executed and passed: (1) ci.yml 'Test — worker OCR with the real tesseract engine' installs tesseract-ocr from apt, runs services/worker/test/uc4-tesseract-ocr.test.ts with UC4_REQUIRE_TESSERACT=1, and its guard fails the step unless >= 5 tests executed, 0 pending/skipped and all passed — the step succeeded; (2) schema-reproducibility.yml 'Worker UC-4 screen-intelligence integration (live PostgreSQL)' ran the handler + persistence integration suites with a guard refusing zero executed or any skipped — it succeeded.",
    externalProofRemaining: "none",
    green: {
      tests: [
        `${CI.buildTest} :: step 'Test — worker OCR with the real tesseract engine' = success (guard: total >= 5, pending 0, failed 0)`,
        `${CI.schema} :: step 'Worker UC-4 screen-intelligence integration (live PostgreSQL)' = success (guard: executed > 0, skipped 0)`,
      ],
      command: "GitHub Actions (feature branch push)",
      result: "both steps success",
    },
  },
  "UC-TQ-004": {
    status: "FIXED",
    proofKind: "runtime",
    note: "EP-14 CLOSED BY FEATURE CI. ci.yml 'Test — worker Object-Lock publication (MinIO, locked bucket)' ran the 4 publication cases against a disposable Object-Lock-enabled MinIO bucket with the step's refusal of skips — the step succeeded.",
    externalProofRemaining: "none",
    green: {
      tests: [`${CI.buildTest} :: step 'Test — worker Object-Lock publication (MinIO, locked bucket)' = success`],
      command: "GitHub Actions (feature branch push)",
      result: "success",
    },
  },
  "UC-LCH-003": {
    status: "FIXED",
    proofKind: "runtime",
    note: "CLOSED BY FEATURE CI: both workflows the finding required ran on GitHub-hosted macOS and Windows runners and passed. Reaching green took toolchain corrections recorded in the branch history (macos-14 + Xcode 16.2, the SDK-52 toolchain whose fmt pod and iOS 18.2 runtime match; pinned MinIO in place of the withdrawn distribution; pgvector on the Windows runner; the harness's silent exit-0 and the reaped Windows object store), not changes to what the jobs assert. This proves COMPILATION, packaging and browser acceptance — not device behaviour, which stays with the device rows.",
    externalProofRemaining: "none",
    green: {
      tests: [CI.native, CI.browser],
      command: "GitHub Actions (feature branch push)",
      result: "native-build success; uc1-browser-acceptance success",
    },
  },
  "UC-AND-011": {
    status: "FIXED",
    proofKind: "unit",
    note: "The only external proof this row named — Kotlin compilation of the capture services carrying FRAME_CAPTURE_FAILED — executed in CI and passed (android-debug-build: Gradle :app:assembleDebug). The behaviour itself (no SECURE_CONTENT_OMITTED emitted; read/write failures report FRAME_CAPTURE_FAILED) is covered by the contract tests; no device behaviour is claimed.",
    externalProofRemaining: "none",
    green: {
      tests: [`${CI.native} :: android-debug-build 'Gradle assembleDebug (compiles the Kotlin capture services)' = success`],
      command: "GitHub Actions (feature branch push)",
      result: "success",
    },
  },
  "UC-IOS-012": {
    status: "FIXED",
    proofKind: "unit",
    note: "RECLASSIFIED BLOCKED -> FIXED: the missing proof was a test, not hardware. ProovraDarwinNotify moved unchanged into its own Foundation-only file in the same pod (5153c237); the XCTest package apps/mobile/modules/proovra-screen-capture/ios-tests compiles THAT shipped file and drives the real Darwin notify center on macOS. native-build's step refuses < 6 executed, any failure or any skip — it passed.",
    externalProofRemaining: "none",
    green: {
      tests: [
        `${CI.nativeUnit} :: ios-simulator-build 'XCTest — ProovraDarwinNotify (UC-IOS-012)' = success (6 tests: real delivery; same name registered once / delivered once; removeAll with the same token; three sessions deliver 1+1+1; independent bridges; 64 concurrent observe() -> one registration)`,
      ],
      command: "swift test (macos-14, Xcode 16.2) via GitHub Actions",
      result: "success",
    },
  },
  "UC-AND-007": {
    status: "FIXED",
    proofKind: "unit",
    note: "RECLASSIFIED BLOCKED -> FIXED: the decision a throwing MediaRecorder.stop() takes now lives in pure Kotlin (CaptureDecisions.kt closeSegment, 5153c237), called by ContinuousScreenCaptureService.finalizeCurrentSegment, and the JUnit suite drives it with a stop() that throws: segment discarded (DISCARD_WRITE_FAILED -> SEGMENT_WRITE_FAILED recorded, nothing emitted), file deleted, recorder still released. NOT added: an emulator/instrumented test with a real MediaRecorder — CI has no Android emulator toolchain; the defect is the control-flow decision, which runs unchanged in the service.",
    externalProofRemaining: "none",
    green: {
      tests: [`${CI.nativeUnit} :: android-debug-build 'JVM unit tests — capture decisions (UC-AND-007, UC-AND-013)' = success (CaptureDecisionsTest, 8 executed, 0 skipped; guard refuses < 8)`],
      command: "Gradle <module>:testDebugUnitTest via GitHub Actions (8/8 also locally on JDK 17 against the module's sources)",
      result: "success",
    },
  },
  "UC-AND-013": {
    status: "FIXED",
    proofKind: "unit",
    note: "RECLASSIFIED BLOCKED -> FIXED: both services now take the consent / getMediaProjection decision through pure Kotlin obtainProjection (CaptureDecisions.kt, 5153c237); a NULL projection is refused with PROJECTION_UNAVAILABLE (Android asked once), no consent with NO_CONSENT_TOKEN (Android not asked), a throw with START_FAILED — every refusal routed to failStart, which rejects the JS start. Proven by the JUnit suite in CI; the source-contract test pins both services' routing.",
    externalProofRemaining: "none",
    green: {
      tests: [`${CI.nativeUnit} :: android-debug-build 'JVM unit tests — capture decisions (UC-AND-007, UC-AND-013)' = success (CaptureDecisionsTest, 8 executed, 0 skipped)`],
      command: "Gradle <module>:testDebugUnitTest via GitHub Actions",
      result: "success",
    },
  },
  "UC-AND-003": {
    status: "BLOCKED_EXTERNAL_PROOF",
    note: "Code complete; the remaining proof is system-UI behaviour of a running Android build (notification actions on a fresh install).",
    externalProofRemaining: "Android 13/14 device — or an emulator with system-UI automation, which CI does not have — fresh install, notification actions visible and working",
  },
  "UC-AND-004": {
    status: "BLOCKED_EXTERNAL_PROOF",
    note: "Code complete (segments listable, callbacks re-bind); the remaining proof is process death and relaunch of a running Android build.",
    externalProofRemaining: "Android device — or an emulator with MediaProjection consent automation, which CI does not have — kill the UI during recording, relaunch, recording continues and is recovered",
  },
  "UC-AND-012": {
    status: "BLOCKED_EXTERNAL_PROOF",
    note: "Code complete (display listener, per-frame geometry, recorded change); the remaining proof is a real rotation during capture.",
    externalProofRemaining: "Android device — or an emulator with MediaProjection consent automation, which CI does not have — rotate during UC-2 capture, frames carry the new geometry",
  },
  "UC-IOS-001": {
    status: "BLOCKED_EXTERNAL_PROOF",
    note: "Swift COMPILATION of SampleHandler / ProovraBroadcastResult and packaging of ProovraBroadcast.appex are now CI-proven (ios-simulator-build, run 36865158339). A broadcast sealed end to end needs a physical iOS device (ReplayKit does not broadcast in the simulator).",
    externalProofRemaining: "physical iOS device: a ReplayKit broadcast sealed end to end with the extension's real device block accepted by the server (Swift compile proven in CI)",
  },
  "UC-IOS-004": {
    status: "BLOCKED_EXTERNAL_PROOF",
    note: "Swift COMPILATION of the single-PTS-clock segmenter is now CI-proven (ios-simulator-build, run 36865158339); the golden fixtures pass in node --test. Real segment timing needs a physical device.",
    externalProofRemaining: "physical iOS device: segment offsets/durations from a real broadcast match the PTS clock (contiguous segments, final segment ends at the last appended PTS) (Swift compile proven in CI)",
  },
  "UC-TRUST-008": {
    status: "FIXED",
    note: "The remediation journey rerun (J06, disposable stack, unversioned MinIO) showed the lane fix incomplete: after in-place substitution Public Verify still said storedBytes verified_current / VERIFIED inside the 24 h window, because 'current' never required a pinned version. Fixed in a606dcaa: current only when every object the check read is a pinned, immutable version (fail closed); J06 now asserts the stored-bytes row, not only the headline.",
    green: {
      tests: [
        "services/api/test/public-verify-stored-bytes-truth.integration.test.ts::TRUST-008: a fresh pass over an UNVERSIONED object is STALE, never VERIFIED (real MinIO in-place substitution; red on the previous resolver: verified_current)",
        "services/api/test/public-verify-stored-bytes-truth.integration.test.ts::TRUST-008: a fresh pinned-version recheck against MinIO is the only VERIFIED (versioned bucket)",
        "packages/shared/tests/stored-bytes-trust-closure.test.mjs (10)",
        "runtime/remediation/journeys-raw.json#J06-integrity-tamper",
      ],
      command: RERUN_API,
      result: "8/8 + 10/10",
    },
  },
  "UC-DER-013": {
    status: "FIXED",
    note: "The remediation journey rerun found derived production accepted for a record that never sealed (J10 on J09's UPLOADING record: 202 and a COMPLETED reconstruction). Fixed in 0408adaa: the one eligibility gate also requires status SIGNED/REPORTED (evidence_not_sealed).",
    green: {
      tests: [
        "services/api/test/derived-review-release-and-generations.integration.test.ts::a record that never sealed (UPLOADING, or a refused hash-mismatch) is not a source (red: 202 + queued run)",
        "services/worker full suite (1218 passed, 1 skipped)",
      ],
      command: RERUN_API,
      result: "14/14",
    },
  },
  "UC-COM-004": {
    status: "FIXED",
    note: "Migration 20281001000300 landed (fail closed, merges nothing); ensureEntitlement is the only writer (allow-list test updated); ten concurrent first calls create one active row.",
    green: { tests: ["services/api/test/billing-allowance-commitments.integration.test.ts::COM-004", "services/api/test/phase-9-authority-writers.test.ts"], command: RERUN_API, result: "8 + 8 passed" },
  },
  "UC-LCH-002": {
    status: "FIXED",
    proofKind: "unit",
    note: "Ten counters in COUNTER_NAMES, one mode->counter authority, bumped at the seal routes, completion fallthrough, intake submit and extension OAuth refusals; every alert rule's counter exists.",
    green: { tests: ["apps/web/__tests__/capture-alert-rules.test.ts"], command: "node scripts/run-tests.mjs capture-alert", result: "5/5" },
  },
  "UC-PROV-009": {
    status: "FIXED",
    note: "Migration 20281001000100 landed; NULL -> RECORDED_AT_CREATION on UPDATE is refused, BACKFILL_* allowed.",
    green: { tests: ["services/api/test/acquisition-set-once-trigger.integration.test.ts"], command: RERUN_API, result: "2 passed" },
  },
  "UC-SEC-006": {
    status: "FIXED",
    note: "Presign (A), capture-session open (lead) and both Public Verify limiters (T) declare bound: 'global'.",
    green: { tests: ["services/api/test/rate-limit-global-bound.test.ts"], command: "npx vitest run test/rate-limit-global-bound.test.ts", result: "12/12" },
  },
  "UC-TRUST-006": {
    status: "FIXED",
    note: "Production readiness fails on incomplete TSA trust configuration; unparsed genTime is never STAMPED; template + operations doc.",
    green: { tests: ["services/api/test/tsa-trust-configuration.test.ts"], command: "npx vitest run", result: "passed" },
  },
};
