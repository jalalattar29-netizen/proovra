/**
 * Lead adjudication for the remediation ledger. Lane reports (lanes/*.json) carry the per-finding
 * decisions, red and green proofs. This file (a) attributes commits whose message cited an id only
 * inside a range, and (b) adjudicates rows a lane left NEEDS_MIGRATION / NEEDS_CROSS_LANE once the
 * migration or the other half landed — each with the resolving commits and the re-run proof.
 */
export const AUDIT_BRANCH = "audit/universal-evidence-capture-truth";
export const AUDIT_SHA = "dae43b40";
export const AUDIT_REMOTE_STATUS =
  "NOT PUSHED — the push was refused by the session's permission classifier; the owner must push it (git push -u origin audit/universal-evidence-capture-truth)";
export const BASE_SHA = "47034f45403e87089b29571e3e702311c9d1a2a4";

const RANGE_M = "commit 6934514c cites 'UC-IOS-001..UC-IOS-012' / 'UC-AND-011..013' as a range; it is lane M's native batch";
const range = (ids, commits, reason) => Object.fromEntries(ids.map((id) => [id, { commits, reason }]));

export const COMMIT_ATTRIBUTION = {
  ...range(
    ["UC-IOS-002", "UC-IOS-003", "UC-IOS-004", "UC-IOS-005", "UC-IOS-006", "UC-IOS-007", "UC-IOS-008", "UC-IOS-009", "UC-IOS-010", "UC-IOS-011", "UC-IOS-012", "UC-AND-011", "UC-AND-012", "UC-AND-013"],
    ["6934514c"],
    RANGE_M,
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
    note: "The spec launches the project's real channel and asserts browser identity; the shipped harness passed 4/4 fixtures in real Chrome 153 and real Edge 154. A CI workflow runs it (uc1-browser-acceptance.yml); its first GitHub run is not observed in this session because pushing was refused.",
    green: { tests: ["node scripts/uc1-acceptance-windows.mjs --start-infra --browsers=chromium,edge"], command: "lane E acceptance run", result: "UC-1 CLOSED (browser gate) [PASS]" },
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
    status: "BLOCKED_EXTERNAL_PROOF",
    note: "Reclassified FIXED -> BLOCKED_EXTERNAL_PROOF at the external-proof reconciliation: the code is complete (handler proof runs DB-free in CI's worker unit job; live-PG suites run in schema-reproducibility.yml; the real-text assertion exists and FAILS instead of skipping under UC4_REQUIRE_TESSERACT=1), but the finding requires an EXECUTED assertion on real tesseract output and none has run anywhere: no CI job installed the engine (the step 'Test — worker OCR with the real tesseract engine' is added to ci.yml now) and fetching the binary here is a package download this session may not make.",
    externalProofRemaining: "EP-14: first CI run of ci.yml 'Test — worker OCR with the real tesseract engine' (apt tesseract-ocr, UC4_REQUIRE_TESSERACT=1, >= 5 executed, 0 skipped) and of schema-reproducibility.yml's worker integration step",
    green: {
      tests: ["services/worker/test/uc4-tesseract-ocr.test.ts (4 executed, 1 skipped: binary absent)", "services/worker/test/uc4-screen-intelligence-handler.test.ts", "services/worker/test/uc4-screen-intelligence-handler.integration.test.ts", "services/worker/test/uc4-screen-intelligence-persistence.integration.test.ts"],
      command: "services/worker: npx vitest run (live PG16/Redis/MinIO)",
      result: "worker suite 1218 passed, 1 skipped",
    },
  },
  "UC-TQ-004": {
    status: "BLOCKED_EXTERNAL_PROOF",
    note: "Reclassified FIXED -> BLOCKED_EXTERNAL_PROOF at the external-proof reconciliation: the finding's required proof is 'the existing 4 cases executed in CI'. The ci.yml step (locked bucket + OBJECT_LOCK_MINIO_* + refusal of skips) is in place and the suite passes locally 4/4 against a locked MinIO bucket, but no CI run of the branch has been observed (push refused).",
    externalProofRemaining: "EP-14: first CI run of ci.yml 'Test — worker Object-Lock publication (MinIO, locked bucket)' showing 4 executed, 0 skipped",
    green: {
      tests: ["services/worker/test/verification-package-publication.minio.test.ts (4/4 against the local locked bucket uca-olc-locked)"],
      command: "OBJECT_LOCK_MINIO_* npx vitest run test/verification-package-publication.minio.test.ts",
      result: "4 passed, 0 pending",
    },
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
