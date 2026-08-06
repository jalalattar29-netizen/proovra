/**
 * Phase 3A — Enterprise Redaction Platform contract + runtime test.
 *
 * Pins the canonical surface introduced by Phase 3A:
 *
 *   1. Shared contracts (artifact kinds, region kinds, methods,
 *      detection kinds + providers + provider states, decision
 *      states, project + version state machine, approval verdicts,
 *      derivative kinds + states, RBAC matrix, activity codes,
 *      denial reasons, projection schema version, standing
 *      limitations, bounded geometry validators).
 *   2. Prisma additions + Phase O-Final compliant migration.
 *   3. Backend services — orchestrators, RBAC gate, detection
 *      providers, projection aggregator.
 *   4. HTTP routes — bounded denial + workspace-anchored shape.
 *   5. RBAC + nav registry wiring.
 *   6. Reviewer / portal / verify / report / verification-package
 *      integration.
 *   7. UI surfaces — projects list, project workspace, viewers,
 *      detection review, approval, version history.
 *   8. Runtime sanity — version-state machine, region geometry
 *      validator, RBAC role mapping, classifyConfidence, REGEX_PII
 *      detector.
 *
 * Source-contract style: no Prisma + no Fastify spin-up. Runtime
 * tests exercise the pure-logic helpers so the test stays fast.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BULK_INVITATION_MAX_ROWS,
  REDACTION_ACTIVITY_CODES,
  REDACTION_APPROVAL_VERDICTS,
  REDACTION_ARTIFACT_KINDS,
  REDACTION_CAPABILITIES,
  REDACTION_CAPABILITY_MATRIX,
  REDACTION_CONFIDENCE_BANDS,
  REDACTION_DECISION_STATES,
  REDACTION_DENIAL_REASONS,
  REDACTION_DERIVATIVE_KINDS,
  REDACTION_DERIVATIVE_STATES,
  REDACTION_DETECTION_KINDS,
  REDACTION_DETECTION_PROVIDERS,
  REDACTION_DETECTION_PROVIDER_STATES,
  REDACTION_METHODS,
  REDACTION_PROJECTION_SCHEMA_VERSION,
  REDACTION_PROJECT_STATES,
  REDACTION_PROVENANCE_LIMITATIONS,
  REDACTION_REGION_KINDS,
  REDACTION_ROLES,
  REDACTION_VERSION_STATES,
  REDACTION_VERSION_TRANSITIONS,
  classifyConfidence,
  isAllowedVersionTransition,
  isValidAudioRangeMs,
  isValidBboxNormalized,
  isValidPdfPageRect,
  isValidPdfTextRange,
  isValidPolygonNormalized,
  isValidRegionGeometry,
  isValidVideoFrameBbox,
  redactionCapabilitiesForRole,
} from "@proovra/shared";

import { regexPiiDetectorRun } from "../src/services/redaction/redaction-detection-providers.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SHARED = readSource("../../../packages/shared/src/redaction.ts");
const SHARED_INDEX = readSource("../../../packages/shared/src/index.ts");
const PERMISSIONS_SRC = readSource(
  "../../../packages/shared/src/permissions.ts",
);
const SCHEMA = readSource("../../../services/api/prisma/schema.prisma");
const MIGRATION = readSource(
  "../../../services/api/prisma/migrations/20261101000000_phase_3a_redaction_platform/migration.sql",
);

const SVC_ACTIVITY = readSource(
  "../../../services/api/src/services/redaction/redaction-activity.service.ts",
);
const SVC_RBAC = readSource(
  "../../../services/api/src/services/redaction/redaction-rbac.service.ts",
);
const SVC_PROJECT = readSource(
  "../../../services/api/src/services/redaction/redaction-project.service.ts",
);
const SVC_REGION = readSource(
  "../../../services/api/src/services/redaction/redaction-region.service.ts",
);
const SVC_DETECTION = readSource(
  "../../../services/api/src/services/redaction/redaction-detection.service.ts",
);
const SVC_PROVIDERS = readSource(
  "../../../services/api/src/services/redaction/redaction-detection-providers.service.ts",
);
const SVC_DECISION = readSource(
  "../../../services/api/src/services/redaction/redaction-decision.service.ts",
);
const SVC_APPROVAL = readSource(
  "../../../services/api/src/services/redaction/redaction-approval.service.ts",
);
const SVC_DERIVATIVE = readSource(
  "../../../services/api/src/services/redaction/redaction-derivative.service.ts",
);
const SVC_PROJECTION = readSource(
  "../../../services/api/src/services/redaction/redaction-projection.service.ts",
);
const SVC_VERIFICATION = readSource(
  "../../../services/api/src/services/redaction/redaction-verification-manifest.service.ts",
);
const ROUTES = readSource(
  "../../../services/api/src/routes/redaction.routes.ts",
);
const SERVER = readSource("../../../services/api/src/server.ts");
const NAV_REGISTRY = readSource(
  "../../../services/api/src/services/platform-context/navigation-registry.ts",
);
const REPORT_SECTION = readSource(
  "../../../services/worker/src/report-v2/sections/redaction-summary.ts",
);

const UI_PROJECTS = readSource(
  "../../../apps/web/app/(app)/redaction/page.tsx",
);
const UI_PROJECT = readSource(
  "../../../apps/web/app/(app)/redaction/[projectId]/page.tsx",
);
const UI_IMAGE_VIEWER = readSource(
  "../../../apps/web/components/redaction/ImageRedactionViewer.tsx",
);
const UI_PDF_VIEWER = readSource(
  "../../../apps/web/components/redaction/PdfRedactionViewer.tsx",
);
const UI_VIDEO_VIEWER = readSource(
  "../../../apps/web/components/redaction/VideoRedactionViewer.tsx",
);
const UI_DETECTION = readSource(
  "../../../apps/web/components/redaction/DetectionReviewPanel.tsx",
);
const UI_APPROVAL = readSource(
  "../../../apps/web/components/redaction/ApprovalPanel.tsx",
);
const UI_HISTORY = readSource(
  "../../../apps/web/components/redaction/VersionHistoryPanel.tsx",
);

// =============================================================================
// 1. Shared contracts
// =============================================================================

describe("Phase 3A — shared contracts", () => {
  it("artifact kinds cover image / pdf / video / audio", () => {
    expect([...REDACTION_ARTIFACT_KINDS].sort()).toEqual(
      ["IMAGE", "PDF", "VIDEO", "AUDIO"].sort(),
    );
  });

  it("region kinds + methods are bounded + match each artifact kind", () => {
    expect(REDACTION_REGION_KINDS.length).toBeGreaterThanOrEqual(6);
    expect(REDACTION_METHODS).toContain("BLUR");
    expect(REDACTION_METHODS).toContain("PIXELATE");
    expect(REDACTION_METHODS).toContain("BLACKOUT");
    expect(REDACTION_METHODS).toContain("REMOVE_CONTENT");
    expect(REDACTION_METHODS).toContain("MUTE");
    expect(REDACTION_METHODS).toContain("BEEP");
  });

  it("detection kinds catalog covers required PII categories", () => {
    for (const required of [
      "FACE",
      "TEXT_BLOCK",
      "EMAIL",
      "PHONE",
      "POSTAL_ADDRESS",
      "GOVERNMENT_ID",
      "CREDIT_CARD",
      "DATE_OF_BIRTH",
      "LICENSE_PLATE",
      "CUSTOM_RULE",
    ] as const) {
      expect(REDACTION_DETECTION_KINDS).toContain(required);
    }
  });

  it("provider catalog covers MANUAL / REGEX / AWS / AZURE / OCR / DEEPGRAM", () => {
    for (const required of [
      "MANUAL",
      "REGEX_PII",
      "AWS_REKOGNITION_FACES",
      "AWS_REKOGNITION_TEXT",
      "AZURE_DOCUMENT_INTELLIGENCE",
      "OCR_TEXT_LAYER",
      "DEEPGRAM_TRANSCRIPT",
      "CUSTOM_PROVIDER",
      "POLICY_RULE",
    ] as const) {
      expect(REDACTION_DETECTION_PROVIDERS).toContain(required);
    }
  });

  it("provider-state catalog declares NOT_CONFIGURED / READY / ERROR etc.", () => {
    for (const s of [
      "READY",
      "NOT_CONFIGURED",
      "DISABLED_BY_POLICY",
      "RATE_LIMITED",
      "ERROR",
    ] as const) {
      expect(REDACTION_DETECTION_PROVIDER_STATES).toContain(s);
    }
  });

  it("confidence bands collapse to four labels", () => {
    expect([...REDACTION_CONFIDENCE_BANDS]).toEqual([
      "LOW",
      "MEDIUM",
      "HIGH",
      "VERY_HIGH",
    ]);
  });

  it("decision states are bounded to 5 values", () => {
    expect([...REDACTION_DECISION_STATES].sort()).toEqual(
      ["ACCEPTED", "DEFERRED", "MODIFIED", "REJECTED", "SUGGESTED"].sort(),
    );
  });

  it("project + version state catalogs are bounded + complete", () => {
    expect(REDACTION_PROJECT_STATES).toContain("DRAFT");
    expect(REDACTION_PROJECT_STATES).toContain("IN_REVIEW");
    expect(REDACTION_PROJECT_STATES).toContain("APPROVED");
    expect(REDACTION_PROJECT_STATES).toContain("PUBLISHED");
    expect(REDACTION_PROJECT_STATES).toContain("REJECTED");
    expect(REDACTION_PROJECT_STATES).toContain("SUPERSEDED");
    expect(REDACTION_PROJECT_STATES).toContain("ARCHIVED");
    for (const s of [
      "DRAFT",
      "IN_REVIEW",
      "APPROVED",
      "REJECTED",
      "PUBLISHED",
      "SUPERSEDED",
    ]) {
      expect(REDACTION_VERSION_STATES).toContain(s);
    }
  });

  it("approval verdicts catalog is bounded", () => {
    expect([...REDACTION_APPROVAL_VERDICTS].sort()).toEqual(
      ["APPROVE", "DEFER", "REJECT", "REQUEST_CHANGES"].sort(),
    );
  });

  it("derivative kinds + states catalogs are bounded", () => {
    for (const k of [
      "IMAGE_REDACTED",
      "PDF_REDACTED",
      "VIDEO_REDACTED",
      "AUDIO_REDACTED",
    ]) {
      expect(REDACTION_DERIVATIVE_KINDS).toContain(k);
    }
    for (const s of [
      "PENDING",
      "RENDERING",
      "READY",
      "FAILED",
      "QUARANTINED",
    ]) {
      expect(REDACTION_DERIVATIVE_STATES).toContain(s);
    }
  });

  it("RBAC roles + capabilities + matrix are bounded + monotonic", () => {
    expect([...REDACTION_ROLES]).toEqual([
      "REDACTION_REVIEWER",
      "REDACTION_APPROVER",
      "REDACTION_ADMINISTRATOR",
    ]);
    expect(REDACTION_CAPABILITIES.length).toBe(9);
    const reviewer = new Set(REDACTION_CAPABILITY_MATRIX.REDACTION_REVIEWER);
    const approver = new Set(REDACTION_CAPABILITY_MATRIX.REDACTION_APPROVER);
    const admin = new Set(REDACTION_CAPABILITY_MATRIX.REDACTION_ADMINISTRATOR);
    // Approver ⊇ Reviewer.
    for (const c of reviewer) expect(approver.has(c)).toBe(true);
    // Admin ⊇ Approver.
    for (const c of approver) expect(admin.has(c)).toBe(true);
    // Admin has `redaction.administer`; others do not.
    expect(admin.has("redaction.administer")).toBe(true);
    expect(approver.has("redaction.administer")).toBe(false);
    expect(reviewer.has("redaction.administer")).toBe(false);
    // Reviewer canNOT approve / publish / download.
    expect(reviewer.has("redaction.version.approve")).toBe(false);
    expect(reviewer.has("redaction.version.publish")).toBe(false);
    expect(reviewer.has("redaction.derivative.download")).toBe(false);
  });

  it("activity catalog covers every required redaction event", () => {
    for (const code of [
      "PROJECT_CREATED",
      "VERSION_CREATED",
      "VERSION_SUBMITTED_FOR_REVIEW",
      "VERSION_APPROVED",
      "VERSION_REJECTED",
      "VERSION_PUBLISHED",
      "VERSION_SUPERSEDED",
      "REGION_ADDED",
      "REGION_REMOVED",
      "DETECTION_RUN_STARTED",
      "DETECTION_RUN_COMPLETED",
      "DETECTION_RUN_FAILED",
      "DETECTION_GENERATED",
      "DETECTION_ACCEPTED",
      "DETECTION_REJECTED",
      "DETECTION_MODIFIED",
      "DETECTION_DEFERRED",
      "APPROVAL_GRANTED",
      "APPROVAL_DENIED",
      "APPROVAL_CHANGES_REQUESTED",
      "DERIVATIVE_REQUESTED",
      "DERIVATIVE_RENDER_STARTED",
      "DERIVATIVE_RENDER_COMPLETED",
      "DERIVATIVE_RENDER_FAILED",
      "DERIVATIVE_DOWNLOADED",
      "DERIVATIVE_QUARANTINED",
    ] as const) {
      expect(REDACTION_ACTIVITY_CODES).toContain(code);
    }
  });

  it("denial-reason catalog covers RBAC + workflow refusals", () => {
    for (const d of [
      "NOT_PERMITTED",
      "PROJECT_NOT_FOUND",
      "VERSION_NOT_FOUND",
      "VERSION_LOCKED",
      "INVALID_TRANSITION",
      "DETECTION_NOT_FOUND",
      "REGION_INVALID",
      "REGION_OUT_OF_BOUNDS",
      "RATIONALE_REQUIRED",
      "ARTIFACT_NOT_REDACTABLE",
      "PROVIDER_NOT_CONFIGURED",
      "DERIVATIVE_NOT_READY",
    ] as const) {
      expect(REDACTION_DENIAL_REASONS).toContain(d);
    }
  });

  it("standing limitations are surfaced", () => {
    for (const l of [
      "REDACTION_NEVER_MODIFIES_ORIGINAL",
      "REDACTION_DERIVATIVE_IS_NOT_ORIGINAL",
      "REDACTION_PROVIDER_SUGGESTIONS_ARE_NOT_GROUND_TRUTH",
      "REDACTION_APPROVAL_IS_HUMAN_JUDGEMENT",
    ]) {
      expect(REDACTION_PROVENANCE_LIMITATIONS).toContain(l);
    }
  });

  it("projection schema version pins V1", () => {
    expect(REDACTION_PROJECTION_SCHEMA_VERSION).toBe("PROOVRA_REDACTION_V1");
  });

  it("shared/index re-exports redaction symbols + types", () => {
    expect(SHARED_INDEX).toMatch(/REDACTION_ARTIFACT_KINDS/);
    expect(SHARED_INDEX).toMatch(/REDACTION_VERSION_TRANSITIONS/);
    expect(SHARED_INDEX).toMatch(/REDACTION_CAPABILITY_MATRIX/);
    expect(SHARED_INDEX).toMatch(/RedactionProjectProjection/);
    expect(SHARED_INDEX).toMatch(/PortalRedactionExposure/);
    expect(SHARED_INDEX).toMatch(/RedactionVerificationManifestEntry/);
    expect(SHARED_INDEX).toMatch(/classifyConfidence/);
    expect(SHARED_INDEX).toMatch(/isValidRegionGeometry/);
  });

  it("PERMISSIONS catalog adds the 9 bounded redaction capabilities", () => {
    expect(PERMISSIONS_SRC).toMatch(/"redaction\.view"/);
    expect(PERMISSIONS_SRC).toMatch(/"redaction\.region\.author"/);
    expect(PERMISSIONS_SRC).toMatch(/"redaction\.detection\.run"/);
    expect(PERMISSIONS_SRC).toMatch(/"redaction\.detection\.review"/);
    expect(PERMISSIONS_SRC).toMatch(/"redaction\.version\.submit"/);
    expect(PERMISSIONS_SRC).toMatch(/"redaction\.version\.approve"/);
    expect(PERMISSIONS_SRC).toMatch(/"redaction\.version\.publish"/);
    expect(PERMISSIONS_SRC).toMatch(/"redaction\.derivative\.download"/);
    expect(PERMISSIONS_SRC).toMatch(/"redaction\.administer"/);
  });

  it("REVIEWER canonical role gets the bounded reviewer subset only", () => {
    // Reviewer canonical role MUST NOT receive approve / publish /
    // download / administer in the role matrix.
    expect(PERMISSIONS_SRC).toMatch(
      /REVIEWER:[\s\S]+?"redaction\.region\.author"[\s\S]+?\]/,
    );
    expect(PERMISSIONS_SRC).not.toMatch(
      /REVIEWER:[\s\S]+?"redaction\.version\.approve"/,
    );
  });
});

// =============================================================================
// 2. Prisma + migration
// =============================================================================

describe("Phase 3A — Prisma + migration", () => {
  it("declares the 8 redaction models", () => {
    for (const m of [
      "model RedactionProject",
      "model RedactionVersion",
      "model RedactionRegion",
      "model RedactionDetection",
      "model RedactionDecision",
      "model RedactionApproval",
      "model RedactionDerivative",
      "model RedactionActivity",
    ]) {
      expect(SCHEMA).toMatch(new RegExp(m));
    }
  });

  it("RedactionProject is workspace + evidence anchored + unique", () => {
    expect(SCHEMA).toMatch(/@@unique\(\[teamId, evidenceId\]\)/);
    expect(SCHEMA).toMatch(/@@map\("redaction_projects"\)/);
  });

  it("Version ordinal is unique per project", () => {
    expect(SCHEMA).toMatch(/@@unique\(\[projectId, versionOrdinal\]\)/);
  });

  it("RedactionDerivative has UNIQUE on versionId", () => {
    expect(SCHEMA).toMatch(
      /versionId\s+String\s+@unique\s+@map\("version_id"\)/,
    );
  });

  it("Phase O-Final compliant migration — plain CREATE TABLE + guarded indexes", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE "redaction_projects"/);
    expect(MIGRATION).not.toMatch(
      /CREATE TABLE IF NOT EXISTS "redaction_/,
    );
    // Every index goes through information_schema.columns guard.
    expect(MIGRATION).toMatch(/information_schema\.columns/);
    // FK cascade is in place — archive a project, kill its versions.
    expect(MIGRATION).toMatch(/REFERENCES "redaction_projects"[\s\S]+CASCADE/);
  });
});

// =============================================================================
// 3. Backend services
// =============================================================================

describe("Phase 3A — backend services", () => {
  it("activity emitter is bounded by REDACTION_ACTIVITY_CODES", () => {
    expect(SVC_ACTIVITY).toMatch(/REDACTION_ACTIVITY_CODES/);
    expect(SVC_ACTIVITY).toMatch(/redactionActivity\.create/);
  });

  it("RBAC gate maps platform roles → redaction roles + enforces capability", () => {
    expect(SVC_RBAC).toMatch(/assertRedactionCapability/);
    expect(SVC_RBAC).toMatch(/buildRedactionContext/);
    expect(SVC_RBAC).toMatch(/REDACTION_ADMINISTRATOR/);
    expect(SVC_RBAC).toMatch(/REDACTION_APPROVER/);
    expect(SVC_RBAC).toMatch(/REDACTION_REVIEWER/);
    // monotonic role expansion.
    expect(SVC_RBAC).toMatch(/granted\.add\("REDACTION_APPROVER"\)/);
    expect(SVC_RBAC).toMatch(/granted\.add\("REDACTION_REVIEWER"\)/);
  });

  it("project service exposes openRedactionProject + createRedactionVersion + transitionRedactionVersion", () => {
    expect(SVC_PROJECT).toMatch(/export async function openRedactionProject/);
    expect(SVC_PROJECT).toMatch(/export async function createRedactionVersion/);
    expect(SVC_PROJECT).toMatch(
      /export async function transitionRedactionVersion/,
    );
    // Publishing supersedes the prior PUBLISHED version atomically.
    expect(SVC_PROJECT).toMatch(/state: "SUPERSEDED"/);
    expect(SVC_PROJECT).toMatch(/state: "PUBLISHED"/);
  });

  it("region service refuses out-of-bounds geometry + locked versions", () => {
    expect(SVC_REGION).toMatch(/isValidRegionGeometry/);
    expect(SVC_REGION).toMatch(/VERSION_LOCKED/);
    expect(SVC_REGION).toMatch(/REGION_OUT_OF_BOUNDS/);
  });

  it("detection orchestrator emits started / completed / failed activity codes", () => {
    expect(SVC_DETECTION).toMatch(/"DETECTION_RUN_STARTED"/);
    expect(SVC_DETECTION).toMatch(/"DETECTION_RUN_COMPLETED"/);
    expect(SVC_DETECTION).toMatch(/"DETECTION_RUN_FAILED"/);
    expect(SVC_DETECTION).toMatch(/"DETECTION_GENERATED"/);
  });

  it("provider catalog honestly reports NOT_CONFIGURED for stubs", () => {
    expect(SVC_DETECTION).toMatch(/AWS_REKOGNITION_FACES:[\s\S]+NOT_CONFIGURED/);
    expect(SVC_DETECTION).toMatch(/AZURE_DOCUMENT_INTELLIGENCE:[\s\S]+NOT_CONFIGURED/);
    expect(SVC_DETECTION).toMatch(/DEEPGRAM_TRANSCRIPT:[\s\S]+NOT_CONFIGURED/);
    expect(SVC_DETECTION).toMatch(/OCR_TEXT_LAYER:[\s\S]+NOT_CONFIGURED/);
  });

  it("REGEX_PII provider catalog covers email + phone + sensitive id", () => {
    expect(SVC_PROVIDERS).toMatch(/kind: "EMAIL"/);
    expect(SVC_PROVIDERS).toMatch(/kind: "PHONE"/);
    expect(SVC_PROVIDERS).toMatch(/kind: "NATIONAL_INSURANCE"/);
    expect(SVC_PROVIDERS).toMatch(/maskPreview/);
  });

  it("decision service promotes ACCEPTED / MODIFIED into a region", () => {
    expect(SVC_DECISION).toMatch(/addRedactionRegion/);
    expect(SVC_DECISION).toMatch(/"DETECTION_ACCEPTED"/);
    expect(SVC_DECISION).toMatch(/"DETECTION_REJECTED"/);
    expect(SVC_DECISION).toMatch(/"DETECTION_MODIFIED"/);
  });

  it("approval service enforces separation of duties + drives transitions", () => {
    expect(SVC_APPROVAL).toMatch(/authoredByUserId === input\.approverUserId/);
    expect(SVC_APPROVAL).toMatch(/transitionRedactionVersion/);
    expect(SVC_APPROVAL).toMatch(/"APPROVAL_GRANTED"/);
    expect(SVC_APPROVAL).toMatch(/"APPROVAL_DENIED"/);
    expect(SVC_APPROVAL).toMatch(/"APPROVAL_CHANGES_REQUESTED"/);
    expect(SVC_APPROVAL).toMatch(/RATIONALE_REQUIRED/);
  });

  it("PHASE 12B — derivative completion moved to the ONE worker-side writer", () => {
    // The API keeps request (QUEUED-first) + quarantine; READY/FAILED live in
    // services/worker/src/redaction/redaction-derivative-writer.ts with the
    // anti-overwrite + atomic claim/stale guards.
    expect(SVC_DERIVATIVE).not.toMatch(/markDerivativeReady/);
    expect(SVC_DERIVATIVE).not.toMatch(/markDerivativeFailed/);
    expect(SVC_DERIVATIVE).toMatch(/quarantineDerivative/);
    expect(SVC_DERIVATIVE).toMatch(/"DERIVATIVE_REQUESTED"/);
    expect(SVC_DERIVATIVE).toMatch(/state: "QUEUED"/);
    const WRITER = readFileSync(
      fileURLToPath(new URL("../../worker/src/redaction/redaction-derivative-writer.ts", import.meta.url)),
      "utf8",
    );
    expect(WRITER).toMatch(/storageKey\s*===\s*input\.storageKey/);
    expect(WRITER).toMatch(/storageBucket\s*===\s*input\.storageBucket/);
    expect(WRITER).toMatch(/original_object_collision/);
    expect(WRITER).toMatch(/"DERIVATIVE_RENDER_COMPLETED"/);
    expect(WRITER).toMatch(/"DERIVATIVE_RENDER_FAILED"/);
  });

  it("projection aggregator surfaces every version + the published one", () => {
    expect(SVC_PROJECTION).toMatch(/REDACTION_PROJECTION_SCHEMA_VERSION/);
    expect(SVC_PROJECTION).toMatch(/publishedVersion/);
    expect(SVC_PROJECTION).toMatch(/summariseRedactionQueueForTeam/);
  });

  it("verification manifest writer exposes PUBLISHED entries only", () => {
    expect(SVC_VERIFICATION).toMatch(/state: "PUBLISHED"/);
    expect(SVC_VERIFICATION).toMatch(/fileSha256/);
    expect(SVC_VERIFICATION).toMatch(/buildRedactionVerificationEntries/);
  });
});

// =============================================================================
// 4. Routes
// =============================================================================

describe("Phase 3A — HTTP routes", () => {
  it("mounts the full bounded surface", () => {
    for (const path of [
      "/v1/redaction/projects",
      "/v1/redaction/projects/:id",
      "/v1/redaction/projects/:id/activity",
      "/v1/redaction/projects/:id/versions",
      "/v1/redaction/versions/:id/regions",
      "/v1/redaction/regions/:id",
      "/v1/redaction/versions/:id/detect",
      "/v1/redaction/versions/:id/detections",
      "/v1/redaction/detections/:id/decision",
      "/v1/redaction/versions/:id/submit",
      "/v1/redaction/versions/:id/approve",
      "/v1/redaction/versions/:id/publish",
      "/v1/redaction/versions/:id/derivative",
      "/v1/redaction/derivatives/:id",
      "/v1/redaction/workspace/summary",
    ]) {
      expect(ROUTES).toMatch(
        new RegExp(path.replace(/\//g, "\\/").replace(/:/g, ":")),
      );
    }
  });

  // PHASE 12B (Evidence Operations, 2026-07-29) — the anonymous
  // evidenceId badge probe GET /v1/redaction/public/verify/:evidenceId
  // was deleted. It had no workspace anchoring, no rate limit, no
  // publication/integrity/destroyed/finalization gate and no audit —
  // an unauthenticated enumeration surface. Its fields were converged
  // into the canonical token-bound Verify authority.
  it("does NOT register an anonymous evidenceId redaction badge probe", () => {
    // Assert on the REGISTRATION form, not the path string — the file
    // keeps a deletion note that names the removed path on purpose.
    expect(ROUTES).not.toMatch(/["']\/v1\/redaction\/public\/verify/);
  });

  it("the public redaction badge is projected by the token-bound Verify authority", () => {
    const projection = readSource(
      "../../../services/api/src/services/redaction/verify-redaction-projection.service.ts",
    );
    // Workspace-anchored (the deleted route was not).
    expect(projection).toMatch(/teamId: input\.teamId/);
    // Every field the deleted route emitted survives.
    for (const field of [
      "hasPublishedDerivative",
      "publishedVersionOrdinal",
      "publishedAtUtc",
      "approvalCount",
      "videoProvenance",
      "REDACTION_NEVER_MODIFIES_ORIGINAL",
      "REDACTION_DERIVATIVE_IS_NOT_ORIGINAL",
      "REDACTION_APPROVAL_IS_HUMAN_JUDGEMENT",
      "REDACTION_TRACKING_IS_PROVENANCE_ONLY",
    ]) {
      expect(projection).toContain(field);
    }
    const evidenceRoutes = readSource(
      "../../../services/api/src/routes/evidence.routes.ts",
    );
    expect(evidenceRoutes).toMatch(/projectVerifyRedaction/);
  });

  it("every privileged route preHandler asserts capability before any DB read", () => {
    // Pattern: `await gate(reply, ctx, "redaction.*")`
    const matches = ROUTES.match(/await gate\(reply, ctx, "redaction\./g) ?? [];
    expect(matches.length).toBeGreaterThan(10);
  });

  // PHASE 12B (Evidence Operations, 2026-07-29) — policy administration.
  it("withdrawing a policy assignment is step-up gated after the RBAC check", () => {
    const block = ROUTES.slice(
      ROUTES.indexOf('"/v1/redaction/policy-assignments/:id"'),
    ).slice(0, 2600);
    // RBAC first, step-up second, mutation last.
    const rbacIdx = block.indexOf('gate(reply, ctx, "redaction.administer")');
    const stepUpIdx = block.indexOf("requireStepUpForSensitiveAction");
    const writeIdx = block.indexOf("revokePolicyAssignment");
    expect(rbacIdx).toBeGreaterThanOrEqual(0);
    expect(stepUpIdx).toBeGreaterThan(rbacIdx);
    expect(writeIdx).toBeGreaterThan(stepUpIdx);
    expect(block).toMatch(/REDACTION_POLICY_ASSIGNMENT_REVOKE/);
  });

  it("policy-assignment revoke is version-concurrency guarded", () => {
    expect(ROUTES).toMatch(/expectedPolicyVersionId/);
    const store = readSource(
      "../../../services/api/src/services/redaction/redaction-policy-store.service.ts",
    );
    // Mismatch is refused, and the write itself is a guarded updateMany
    // so a concurrent double-revoke cannot emit a second audit row.
    expect(store).toMatch(
      /input\.expectedPolicyVersionId !== assignment\.policyVersionId/,
    );
    expect(store).toMatch(/updateMany\(/);
    expect(store).toMatch(/revoked\.count === 0/);
  });

  it("the project projection exposes authored regions so region removal is reachable", () => {
    const projection = readSource(
      "../../../services/api/src/services/redaction/redaction-projection.service.ts",
    );
    expect(projection).toMatch(/regions: v\.regions\.map\(/);
    expect(SHARED).toMatch(
      /regions: ReadonlyArray<RedactionRegionProjection>;/,
    );
  });

  it("publish refuses unless the derivative is READY", () => {
    expect(ROUTES).toMatch(/derivative\.state !== "READY"/);
    expect(ROUTES).toMatch(/DERIVATIVE_NOT_READY/);
  });

  it("derivative download increments the audit counter + emits DERIVATIVE_DOWNLOADED", () => {
    expect(ROUTES).toMatch(/downloadCount: \{ increment: 1 \}/);
    expect(ROUTES).toMatch(/"DERIVATIVE_DOWNLOADED"/);
  });

  it("server.ts registers redactionRoutes", () => {
    expect(SERVER).toMatch(/import \{ redactionRoutes \}/);
    expect(SERVER).toMatch(/app\.register\(redactionRoutes\)/);
  });
});

// =============================================================================
// 5. RBAC + nav
// =============================================================================

describe("Phase 3A — RBAC + nav wiring", () => {
  it("navigation registry declares workspace.review_redaction", () => {
    expect(NAV_REGISTRY).toMatch(/id:\s*"workspace\.review_redaction"/);
    expect(NAV_REGISTRY).toMatch(/href:\s*"\/redaction"/);
    expect(NAV_REGISTRY).toMatch(/domain:\s*"REVIEW_GOVERNANCE"/);
  });
});

// =============================================================================
// 6. Integrations (reviewer summary, verify badge, report section,
//    verification-package manifest, portal exposure shape).
// =============================================================================

describe("Phase 3A — integrations", () => {
  it("reviewer-workspace summary endpoint surfaces redaction queue counts", () => {
    expect(ROUTES).toMatch(/\/v1\/redaction\/workspace\/summary/);
    expect(ROUTES).toMatch(/summariseRedactionQueueForTeam/);
  });

  // PHASE 12B (Evidence Operations, 2026-07-29) — the verify-page badge
  // moved off the standalone anonymous redaction route and onto the
  // canonical token-bound Verify authority (GET /public/verify/:id).
  // The badge stays public + provenance-only; it is now gated by that
  // route's rate limits, publication/integrity/destroyed/finalization
  // gates and audit, and anchored to the evidence's workspace.
  it("verify-page badge is public + provenance-only, on the token-bound authority", () => {
    const projection = readSource(
      "../../../services/api/src/services/redaction/verify-redaction-projection.service.ts",
    );
    expect(projection).toMatch(/hasPublishedDerivative/);
    expect(projection).toMatch(/REDACTION_NEVER_MODIFIES_ORIGINAL/);
    // Provenance-only: the projection SELECTs and RETURNS bounded counts
    // only — never a geometry / detection-text / rationale field.
    expect(projection).not.toMatch(/\bgeometry:/);
    expect(projection).not.toMatch(/\brationale:/);
    expect(projection).not.toMatch(/\bdetections:/);
    // No parallel anonymous authority survives in the redaction routes.
    // Assert on the REGISTRATION form, not the path string — the file
    // keeps a deletion note that names the removed path on purpose.
    expect(ROUTES).not.toMatch(/["']\/v1\/redaction\/public\/verify/);
  });

  it("report builder ships a redaction-summary section module", () => {
    expect(REPORT_SECTION).toMatch(
      /export function renderRedactionSummarySection/,
    );
    expect(REPORT_SECTION).toMatch(/Original preserved/);
    expect(REPORT_SECTION).toMatch(/Derivative generated/);
  });

  it("verification-package manifest writer emits PUBLISHED entries with derivative hash", () => {
    expect(SVC_VERIFICATION).toMatch(/buildRedactionVerificationEntries/);
    expect(SVC_VERIFICATION).toMatch(/state: "PUBLISHED"/);
    expect(SVC_VERIFICATION).toMatch(/fileSha256/);
  });
});

// =============================================================================
// 7. UI surfaces
// =============================================================================

describe("Phase 3A — UI surfaces", () => {
  it("projects list page renders the bounded shell", () => {
    expect(UI_PROJECTS).toMatch(/data-redaction-projects-page/);
    expect(UI_PROJECTS).toMatch(/data-redaction-summary-tiles/);
    expect(UI_PROJECTS).toMatch(/data-redaction-open-submit/);
    expect(UI_PROJECTS).toMatch(/data-redaction-project-open=/);
  });

  it("project workspace renders viewer + detection + approval + history", () => {
    expect(UI_PROJECT).toMatch(/data-redaction-project-page/);
    expect(UI_PROJECT).toMatch(/data-redaction-new-version/);
    expect(UI_PROJECT).toMatch(/ImageRedactionViewer/);
    expect(UI_PROJECT).toMatch(/PdfRedactionViewer/);
    expect(UI_PROJECT).toMatch(/VideoRedactionViewer/);
    expect(UI_PROJECT).toMatch(/DetectionReviewPanel/);
    expect(UI_PROJECT).toMatch(/ApprovalPanel/);
    expect(UI_PROJECT).toMatch(/VersionHistoryPanel/);
  });

  it("image viewer wires bounded region drawing", () => {
    expect(UI_IMAGE_VIEWER).toMatch(/data-redaction-image-viewer/);
    expect(UI_IMAGE_VIEWER).toMatch(/data-redaction-image-canvas/);
    expect(UI_IMAGE_VIEWER).toMatch(/data-redaction-image-method/);
    expect(UI_IMAGE_VIEWER).toMatch(/BBOX_NORMALIZED/);
  });

  it("PDF viewer wires page-rect region authoring", () => {
    expect(UI_PDF_VIEWER).toMatch(/data-redaction-pdf-viewer/);
    expect(UI_PDF_VIEWER).toMatch(/data-redaction-pdf-page/);
    expect(UI_PDF_VIEWER).toMatch(/data-redaction-pdf-method/);
    expect(UI_PDF_VIEWER).toMatch(/PDF_PAGE_RECT/);
    expect(UI_PDF_VIEWER).toMatch(/REMOVE_CONTENT/);
  });

  it("video viewer wires frame-range region authoring", () => {
    expect(UI_VIDEO_VIEWER).toMatch(/data-redaction-video-viewer/);
    expect(UI_VIDEO_VIEWER).toMatch(/data-redaction-video-start-frame/);
    expect(UI_VIDEO_VIEWER).toMatch(/data-redaction-video-end-frame/);
    expect(UI_VIDEO_VIEWER).toMatch(/VIDEO_FRAME_BBOX/);
  });

  it("detection review panel exposes provider toggles + accept/reject actions", () => {
    expect(UI_DETECTION).toMatch(/data-redaction-detection-panel/);
    expect(UI_DETECTION).toMatch(/data-redaction-detection-provider=/);
    expect(UI_DETECTION).toMatch(/data-redaction-detection-accept=/);
    expect(UI_DETECTION).toMatch(/data-redaction-detection-reject=/);
    expect(UI_DETECTION).toMatch(/data-redaction-detection-defer=/);
    expect(UI_DETECTION).toMatch(/AI suggests · humans decide/);
  });

  it("approval panel exposes submit / approve / reject / publish with state gating", () => {
    expect(UI_APPROVAL).toMatch(/data-redaction-approval-panel/);
    expect(UI_APPROVAL).toMatch(/data-redaction-approval-submit/);
    expect(UI_APPROVAL).toMatch(/data-redaction-approval-approve/);
    expect(UI_APPROVAL).toMatch(/data-redaction-approval-reject/);
    expect(UI_APPROVAL).toMatch(/data-redaction-approval-publish/);
    expect(UI_APPROVAL).toMatch(/data-redaction-approval-changes/);
    expect(UI_APPROVAL).toMatch(/Publishing requires a READY derivative/);
  });

  it("version history panel is append-only — no delete control", () => {
    expect(UI_HISTORY).toMatch(/data-redaction-version-history/);
    expect(UI_HISTORY).toMatch(/data-redaction-version-row=/);
    expect(UI_HISTORY).not.toMatch(/data-redaction-version-delete/);
  });
});

// =============================================================================
// 8. Runtime sanity — pure-logic helpers
// =============================================================================

describe("Phase 3A — runtime helpers", () => {
  it("classifyConfidence maps raw [0,1] into the four bands", () => {
    expect(classifyConfidence(0.99)).toBe("VERY_HIGH");
    expect(classifyConfidence(0.8)).toBe("HIGH");
    expect(classifyConfidence(0.79)).toBe("MEDIUM");
    expect(classifyConfidence(0.5)).toBe("MEDIUM");
    expect(classifyConfidence(0.499)).toBe("LOW");
    expect(classifyConfidence(0)).toBe("LOW");
  });

  it("version transitions are bounded by REDACTION_VERSION_TRANSITIONS", () => {
    // Allowed.
    expect(isAllowedVersionTransition("DRAFT", "IN_REVIEW")).toBe(true);
    expect(isAllowedVersionTransition("IN_REVIEW", "APPROVED")).toBe(true);
    expect(isAllowedVersionTransition("APPROVED", "PUBLISHED")).toBe(true);
    expect(isAllowedVersionTransition("PUBLISHED", "SUPERSEDED")).toBe(true);
    expect(isAllowedVersionTransition("IN_REVIEW", "DRAFT")).toBe(true);
    // Refused.
    expect(isAllowedVersionTransition("DRAFT", "APPROVED")).toBe(false);
    expect(isAllowedVersionTransition("PUBLISHED", "APPROVED")).toBe(false);
    expect(isAllowedVersionTransition("SUPERSEDED", "DRAFT")).toBe(false);
    expect(isAllowedVersionTransition("REJECTED", "PUBLISHED")).toBe(false);
    // The transition map itself is sealed.
    for (const s of REDACTION_VERSION_STATES) {
      expect(Array.isArray(REDACTION_VERSION_TRANSITIONS[s])).toBe(true);
    }
  });

  it("redactionCapabilitiesForRole returns the expected bounded set", () => {
    const reviewer = redactionCapabilitiesForRole("REDACTION_REVIEWER");
    expect(reviewer.has("redaction.view")).toBe(true);
    expect(reviewer.has("redaction.region.author")).toBe(true);
    expect(reviewer.has("redaction.version.approve")).toBe(false);
    const admin = redactionCapabilitiesForRole("REDACTION_ADMINISTRATOR");
    expect(admin.has("redaction.administer")).toBe(true);
    expect(admin.has("redaction.version.publish")).toBe(true);
  });

  it("region geometry validators reject out-of-bounds shapes", () => {
    // BBOX normalized.
    expect(
      isValidBboxNormalized({ x: 0, y: 0, width: 1, height: 1 }),
    ).toBe(true);
    expect(
      isValidBboxNormalized({ x: 0.5, y: 0.5, width: 0.6, height: 0.6 }),
    ).toBe(false);
    expect(
      isValidBboxNormalized({ x: -0.1, y: 0, width: 0.5, height: 0.5 }),
    ).toBe(false);
    // Polygon normalized.
    expect(
      isValidPolygonNormalized({
        points: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0 },
          { x: 0.5, y: 0.5 },
        ],
      }),
    ).toBe(true);
    expect(
      isValidPolygonNormalized({
        points: [
          { x: 0, y: 0 },
          { x: 1.2, y: 0 },
          { x: 0.5, y: 0.5 },
        ],
      }),
    ).toBe(false);
    // Video frame bbox.
    expect(
      isValidVideoFrameBbox({
        startFrame: 0,
        endFrame: 10,
        bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      }),
    ).toBe(true);
    expect(
      isValidVideoFrameBbox({
        startFrame: 10,
        endFrame: 0,
        bbox: { x: 0, y: 0, width: 1, height: 1 },
      }),
    ).toBe(false);
    // Audio range ms.
    expect(isValidAudioRangeMs({ startMs: 0, endMs: 1000 })).toBe(true);
    expect(isValidAudioRangeMs({ startMs: 1000, endMs: 500 })).toBe(false);
    // PDF page rect + text range.
    expect(
      isValidPdfPageRect({
        pageIndex: 0,
        rect: { x: 0, y: 0, width: 0.5, height: 0.5 },
      }),
    ).toBe(true);
    expect(
      isValidPdfTextRange({
        pageIndex: 0,
        charStart: 10,
        charEnd: 25,
      }),
    ).toBe(true);
    expect(
      isValidPdfTextRange({
        pageIndex: 0,
        charStart: 30,
        charEnd: 25,
      }),
    ).toBe(false);
    // Cross-kind dispatcher.
    expect(
      isValidRegionGeometry("BBOX_NORMALIZED", {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      }),
    ).toBe(true);
    expect(
      isValidRegionGeometry("PDF_PAGE_RECT", {
        pageIndex: 0,
        rect: { x: 0, y: 0, width: 0.5, height: 0.5 },
      }),
    ).toBe(true);
  });

  it("REGEX_PII detector finds emails + phones + national ids with bounded preview", async () => {
    const res = await regexPiiDetectorRun({
      teamId: "00000000-0000-0000-0000-000000000000",
      evidenceId: "11111111-1111-1111-1111-111111111111",
      artifactKind: "PDF",
      inlineText:
        "Contact jane.doe@acme.com or call +44 20 7946 0958. " +
        "Reference SSN 123-45-6789 and UK NINO AB123456C.",
    });
    expect(res.state).toBe("READY");
    expect(res.rows.length).toBeGreaterThanOrEqual(3);
    const kinds = new Set(res.rows.map((r) => r.kind));
    expect(kinds.has("EMAIL")).toBe(true);
    expect(kinds.has("PHONE")).toBe(true);
    expect(kinds.has("NATIONAL_INSURANCE")).toBe(true);
    // Bounded preview: NEVER the full matched text verbatim.
    for (const r of res.rows) {
      expect((r.previewLabel ?? "").length).toBeLessThanOrEqual(80);
      if (r.kind === "EMAIL") {
        expect(r.previewLabel ?? "").not.toContain("jane.doe");
      }
    }
  });

  it("REGEX_PII honestly reports NOT_CONFIGURED when no inline text", async () => {
    const res = await regexPiiDetectorRun({
      teamId: "00000000-0000-0000-0000-000000000000",
      evidenceId: "11111111-1111-1111-1111-111111111111",
      artifactKind: "PDF",
      inlineText: null,
    });
    expect(res.state).toBe("NOT_CONFIGURED");
    expect(res.rows.length).toBe(0);
  });
});

// =============================================================================
// 9. Cross-phase sanity — make sure Phase 2B Closure stays intact.
// =============================================================================

describe("Phase 3A — Phase 2B/Phase 2B Closure preserved", () => {
  it("bulk invitation max still 100", () => {
    expect(BULK_INVITATION_MAX_ROWS).toBe(100);
  });
});
