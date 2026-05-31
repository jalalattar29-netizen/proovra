/**
 * Phase 3A Elite Closure — Policy Engine + Advanced Video
 * Intelligence integration test.
 *
 * Pins the closure surface introduced by the Elite phase:
 *
 *   1. Shared contracts (policy version states + transitions,
 *      assignment scopes, rule actions, video track kinds /
 *      states, timeline layers / event codes, bulk ops, sample
 *      presets, verification manifest shapes).
 *   2. Prisma additions + Phase O-Final compliant migration.
 *   3. Prisma-backed policy store with bounded version state
 *     machine + separation-of-duties + inheritance resolver.
 *   4. Policy HTTP routes (CRUD, version transitions, assignments,
 *     audit, effective).
 *   5. Policy Management Console UI surfaces.
 *   6. Video intelligence services (frame, track, timeline,
 *     tracking heuristic, bulk operations).
 *   7. Video HTTP routes.
 *   8. Video Review Workspace UI surfaces.
 *   9. Verify + report + verification-package extensions.
 *  10. Runtime sanity — bounded version transitions, inheritance
 *     precedence, track-grouping IoU helper, timeline emitter.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  POLICY_ASSIGNMENT_PRECEDENCE,
  POLICY_ASSIGNMENT_SCOPES,
  POLICY_DETECTION_RULE_ACTIONS,
  REDACTION_POLICY_ACTIVITY_CODES,
  REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION,
  REDACTION_POLICY_VERSION_STATES,
  REDACTION_POLICY_VERSION_TRANSITIONS,
  VIDEO_FRAME_EXTRACTORS,
  VIDEO_FRAME_SAMPLE_MS,
  VIDEO_FRAME_SAMPLE_PRESETS,
  VIDEO_TIMELINE_EVENT_CODES,
  VIDEO_TIMELINE_LAYERS,
  VIDEO_TRACK_BULK_OPS,
  VIDEO_TRACK_KINDS,
  VIDEO_TRACK_STATES,
  isAllowedPolicyVersionTransition,
} from "@proovra/shared";

import { iou } from "../src/services/redaction/video/video-tracking.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SHARED = readSource("../../../packages/shared/src/redaction-elite.ts");
const SHARED_INDEX = readSource("../../../packages/shared/src/index.ts");
const SCHEMA = readSource("../../../services/api/prisma/schema.prisma");
const MIGRATION = readSource(
  "../../../services/api/prisma/migrations/20261201000000_phase_3a_elite_closure_policy_video/migration.sql",
);

const POLICY_STORE = readSource(
  "../../../services/api/src/services/redaction/redaction-policy-store.service.ts",
);
const POLICY_SHIM = readSource(
  "../../../services/api/src/services/redaction/redaction-policy.service.ts",
);
const POLICY_MANIFEST = readSource(
  "../../../services/api/src/services/redaction/policy-verification-manifest.service.ts",
);

const VIDEO_FRAME = readSource(
  "../../../services/api/src/services/redaction/video/video-frame.service.ts",
);
const VIDEO_TRACK = readSource(
  "../../../services/api/src/services/redaction/video/video-track.service.ts",
);
const VIDEO_TIMELINE = readSource(
  "../../../services/api/src/services/redaction/video/video-timeline.service.ts",
);
const VIDEO_TRACKING = readSource(
  "../../../services/api/src/services/redaction/video/video-tracking.service.ts",
);
const VIDEO_VERIFICATION = readSource(
  "../../../services/api/src/services/redaction/video/video-verification-manifest.service.ts",
);

const ROUTES = readSource(
  "../../../services/api/src/routes/redaction.routes.ts",
);
const REPORT_SECTION = readSource(
  "../../../services/worker/src/report-v2/sections/video-intelligence.ts",
);

const UI_POLICY = readSource(
  "../../../apps/web/app/(app)/redaction/policy/page.tsx",
);
const UI_VIDEO_WORKSPACE = readSource(
  "../../../apps/web/components/redaction/VideoReviewWorkspace.tsx",
);

// =============================================================================
// 1. Shared contracts
// =============================================================================

describe("Phase 3A Elite — shared contracts", () => {
  it("policy version state machine is bounded + deterministic", () => {
    expect(REDACTION_POLICY_VERSION_STATES).toContain("DRAFT");
    expect(REDACTION_POLICY_VERSION_STATES).toContain("PUBLISHED");
    expect(REDACTION_POLICY_VERSION_STATES).toContain("ROLLED_BACK");
    for (const s of REDACTION_POLICY_VERSION_STATES) {
      expect(Array.isArray(REDACTION_POLICY_VERSION_TRANSITIONS[s])).toBe(true);
    }
    expect(isAllowedPolicyVersionTransition("DRAFT", "IN_REVIEW")).toBe(true);
    expect(isAllowedPolicyVersionTransition("IN_REVIEW", "APPROVED")).toBe(true);
    expect(isAllowedPolicyVersionTransition("APPROVED", "PUBLISHED")).toBe(true);
    expect(isAllowedPolicyVersionTransition("PUBLISHED", "ROLLED_BACK")).toBe(true);
    expect(isAllowedPolicyVersionTransition("DRAFT", "APPROVED")).toBe(false);
    expect(isAllowedPolicyVersionTransition("SUPERSEDED", "DRAFT")).toBe(false);
  });

  it("assignment scopes + bounded precedence catalog", () => {
    expect([...POLICY_ASSIGNMENT_SCOPES].sort()).toEqual(
      ["CASE", "GLOBAL", "PROJECT", "WORKSPACE"].sort(),
    );
    expect(POLICY_ASSIGNMENT_PRECEDENCE.PROJECT).toBeGreaterThan(
      POLICY_ASSIGNMENT_PRECEDENCE.CASE,
    );
    expect(POLICY_ASSIGNMENT_PRECEDENCE.CASE).toBeGreaterThan(
      POLICY_ASSIGNMENT_PRECEDENCE.WORKSPACE,
    );
    expect(POLICY_ASSIGNMENT_PRECEDENCE.WORKSPACE).toBeGreaterThan(
      POLICY_ASSIGNMENT_PRECEDENCE.GLOBAL,
    );
  });

  it("policy rule actions catalog is bounded", () => {
    expect([...POLICY_DETECTION_RULE_ACTIONS].sort()).toEqual(
      [
        "BLOCK_PUBLICATION",
        "DETECT_ONLY",
        "REQUIRE_APPROVAL",
        "SUGGEST",
      ].sort(),
    );
  });

  it("policy activity codes cover the full lifecycle", () => {
    for (const code of [
      "POLICY_CREATED",
      "POLICY_VERSION_CREATED",
      "POLICY_VERSION_SUBMITTED",
      "POLICY_VERSION_APPROVED",
      "POLICY_VERSION_REJECTED",
      "POLICY_VERSION_PUBLISHED",
      "POLICY_VERSION_SUPERSEDED",
      "POLICY_VERSION_ROLLED_BACK",
      "POLICY_ASSIGNMENT_CREATED",
      "POLICY_ASSIGNMENT_REVOKED",
    ]) {
      expect(REDACTION_POLICY_ACTIVITY_CODES).toContain(code);
    }
  });

  it("video track kinds + states catalogs are bounded", () => {
    for (const k of [
      "FACE",
      "OBJECT",
      "TEXT",
      "LICENSE_PLATE",
      "SCREEN_CONTENT",
      "CUSTOM",
    ]) {
      expect(VIDEO_TRACK_KINDS).toContain(k);
    }
    for (const s of [
      "SUGGESTED",
      "ACCEPTED",
      "MODIFIED",
      "REJECTED",
      "MERGED",
      "SPLIT",
    ]) {
      expect(VIDEO_TRACK_STATES).toContain(s);
    }
  });

  it("timeline layers + event codes are bounded", () => {
    for (const layer of [
      "FRAME",
      "DETECTION",
      "TRACKING",
      "APPROVAL",
      "CONFIDENCE",
      "COMMENT",
      "DECISION",
      "DERIVATIVE",
    ]) {
      expect(VIDEO_TIMELINE_LAYERS).toContain(layer);
    }
    for (const code of [
      "FRAME_EXTRACTED",
      "TRACK_CREATED",
      "TRACK_MERGED",
      "TRACK_SPLIT",
      "TRACK_PROPAGATED",
      "TRACK_ACCEPTED",
      "TRACK_REJECTED",
      "RANGE_ACCEPTED",
      "DECISION_BULK_APPLIED",
      "DERIVATIVE_RENDER_REQUESTED",
    ]) {
      expect(VIDEO_TIMELINE_EVENT_CODES).toContain(code);
    }
  });

  it("video frame extractor + sample presets are bounded", () => {
    for (const e of ["FFMPEG_SAMPLE", "FFMPEG_KEYFRAME", "OPERATOR_INLINE"]) {
      expect(VIDEO_FRAME_EXTRACTORS).toContain(e);
    }
    expect([...VIDEO_FRAME_SAMPLE_PRESETS].sort()).toEqual(
      [
        "EVERY_1S",
        "EVERY_500MS",
        "EVERY_5S",
        "EVERY_FRAME",
        "EVERY_KEYFRAME",
      ].sort(),
    );
    expect(VIDEO_FRAME_SAMPLE_MS.EVERY_500MS).toBe(500);
    expect(VIDEO_FRAME_SAMPLE_MS.EVERY_KEYFRAME).toBeNull();
  });

  it("video track bulk-op catalog is bounded", () => {
    expect([...VIDEO_TRACK_BULK_OPS].sort()).toEqual(
      [
        "APPLY_TO_TRACK",
        "APPROVE_RANGE",
        "BULK_DECISION",
        "MERGE_TRACKS",
        "REJECT_RANGE",
        "SPLIT_TRACK",
      ].sort(),
    );
  });

  it("policy document schema version pin matches V1", () => {
    expect(REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION).toBe(
      "PROOVRA_REDACTION_POLICY_V1",
    );
  });

  it("shared/index re-exports elite symbols + types", () => {
    expect(SHARED_INDEX).toMatch(/REDACTION_POLICY_VERSION_STATES/);
    expect(SHARED_INDEX).toMatch(/POLICY_ASSIGNMENT_PRECEDENCE/);
    expect(SHARED_INDEX).toMatch(/VIDEO_TIMELINE_LAYERS/);
    expect(SHARED_INDEX).toMatch(/VideoTrackingVerificationManifestEntry/);
    expect(SHARED_INDEX).toMatch(/PolicyVerificationManifestEntry/);
    expect(SHARED_INDEX).toMatch(/EffectivePolicy/);
  });

  it("EffectivePolicy projection shape is documented in source", () => {
    expect(SHARED).toMatch(/resolution: ReadonlyArray/);
    expect(SHARED).toMatch(/scope:\s*PolicyAssignmentScope/);
  });
});

// =============================================================================
// 2. Prisma + migration
// =============================================================================

describe("Phase 3A Elite — Prisma + migration", () => {
  it("declares the 8 elite-closure models", () => {
    for (const m of [
      "model RedactionPolicy",
      "model RedactionPolicyVersion",
      "model RedactionPolicyAssignment",
      "model RedactionPolicyAudit",
      "model VideoFrame",
      "model VideoTrack",
      "model VideoTrackDetection",
      "model VideoTimelineEvent",
    ]) {
      expect(SCHEMA).toMatch(new RegExp(m));
    }
  });

  it("policy table is uniquely keyed per workspace + name", () => {
    expect(SCHEMA).toMatch(/@@unique\(\[teamId, name\]\)[\s\S]+redaction_policies/);
    expect(SCHEMA).toMatch(/@@unique\(\[policyId, versionOrdinal\]\)/);
  });

  it("video_frames is uniquely keyed per (team, evidence, frameIndex)", () => {
    expect(SCHEMA).toMatch(
      /@@unique\(\[teamId, evidenceId, frameIndex\]\)/,
    );
    expect(SCHEMA).toMatch(
      /@@unique\(\[trackId, frameId\]\)/,
    );
  });

  it("migration is Phase O-Final compliant (plain CREATE TABLE + guards)", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE "redaction_policies"/);
    expect(MIGRATION).not.toMatch(/CREATE TABLE IF NOT EXISTS "redaction_policies"/);
    expect(MIGRATION).toMatch(/CREATE TABLE "video_frames"/);
    expect(MIGRATION).not.toMatch(/CREATE TABLE IF NOT EXISTS "video_frames"/);
    expect(MIGRATION).toMatch(/information_schema\.columns/);
    expect(MIGRATION).toMatch(
      /REFERENCES "redaction_policies"[\s\S]+CASCADE/,
    );
    expect(MIGRATION).toMatch(/REFERENCES "video_tracks"[\s\S]+CASCADE/);
  });
});

// =============================================================================
// 3. Prisma-backed policy store
// =============================================================================

describe("Phase 3A Elite — Prisma-backed policy store", () => {
  it("exposes the full lifecycle surface", () => {
    for (const fn of [
      "export async function createPolicy",
      "export async function archivePolicy",
      "export async function createPolicyVersion",
      "export async function transitionPolicyVersion",
      "export async function assignPolicyVersion",
      "export async function revokePolicyAssignment",
      "export async function listPolicies",
      "export async function listPolicyVersions",
      "export async function listAssignmentsForScope",
      "export async function listAuditForPolicy",
      "export async function resolveEffectivePolicy",
      "export async function appendPolicyAudit",
    ]) {
      expect(POLICY_STORE).toMatch(new RegExp(fn));
    }
  });

  it("transitions enforce separation of duties for APPROVE + PUBLISH", () => {
    expect(POLICY_STORE).toMatch(
      /authoredByUserId === input\.actorUserId/,
    );
  });

  it("publishing supersedes the prior PUBLISHED version atomically", () => {
    expect(POLICY_STORE).toMatch(/\$transaction/);
    expect(POLICY_STORE).toMatch(/state: "SUPERSEDED"/);
  });

  it("inheritance resolver orders by precedence GLOBAL→PROJECT", () => {
    expect(POLICY_STORE).toMatch(/POLICY_ASSIGNMENT_PRECEDENCE\[/);
    expect(POLICY_STORE).toMatch(/state: "PUBLISHED"/);
    // The resolver returns a deterministic resolution trail.
    expect(POLICY_STORE).toMatch(/resolution\.push/);
  });

  it("policy shim preserves Phase 3A Closure signature + delegates to Prisma store", () => {
    expect(POLICY_SHIM).toMatch(/from "\.\/redaction-policy-store\.service\.js"/);
    expect(POLICY_SHIM).toMatch(/export async function isPolicyAllowed/);
    expect(POLICY_SHIM).toMatch(/export async function getRedactionDetectionPolicy/);
    expect(POLICY_SHIM).toMatch(/export async function setRedactionDetectionPolicy/);
    // The in-memory cache is gone — `__resetPolicyCacheForTests` is now a no-op.
    expect(POLICY_SHIM).toMatch(/no-op — policy now lives in Prisma/);
  });

  it("policy verification manifest writer returns only PUBLISHED versions", () => {
    expect(POLICY_MANIFEST).toMatch(/state !== "PUBLISHED"/);
    expect(POLICY_MANIFEST).toMatch(/PolicyVerificationManifestEntry/);
  });
});

// =============================================================================
// 4. HTTP routes — policy
// =============================================================================

describe("Phase 3A Elite — policy HTTP routes", () => {
  it("mounts the full policy management surface", () => {
    for (const path of [
      "/v1/redaction/policies",
      "/v1/redaction/policies/:id",
      "/v1/redaction/policies/:id/versions",
      "/v1/redaction/policy-versions/:id/transition",
      "/v1/redaction/policies/:id/assignments",
      "/v1/redaction/policy-assignments/:id",
      "/v1/redaction/policies/:id/audit",
      "/v1/redaction/policy/effective",
      "/v1/redaction/policy/assignments",
    ]) {
      expect(ROUTES).toMatch(
        new RegExp(path.replace(/\//g, "\\/")),
      );
    }
  });

  it("policy writes require redaction.administer; reads require redaction.view", () => {
    expect(ROUTES).toMatch(
      /\/v1\/redaction\/policies"[\s\S]+?gate\(reply, ctx, "redaction\.administer"\)/,
    );
    expect(ROUTES).toMatch(
      /\/v1\/redaction\/policy\/effective[\s\S]+?gate\(reply, ctx, "redaction\.view"\)/,
    );
  });
});

// =============================================================================
// 5. Policy Management Console UI
// =============================================================================

describe("Phase 3A Elite — Policy Management Console UI", () => {
  it("renders the bounded console surface", () => {
    expect(UI_POLICY).toMatch(/data-redaction-policy-console/);
    expect(UI_POLICY).toMatch(/data-redaction-policy-list/);
    expect(UI_POLICY).toMatch(/data-redaction-policy-versions/);
    expect(UI_POLICY).toMatch(/data-redaction-policy-versions-table/);
    expect(UI_POLICY).toMatch(/data-redaction-policy-compare/);
    expect(UI_POLICY).toMatch(/data-redaction-policy-audit/);
  });

  it("exposes the publish workflow actions per version", () => {
    expect(UI_POLICY).toMatch(/data-redaction-policy-submit=/);
    expect(UI_POLICY).toMatch(/data-redaction-policy-approve=/);
    expect(UI_POLICY).toMatch(/data-redaction-policy-reject=/);
    expect(UI_POLICY).toMatch(/data-redaction-policy-publish=/);
    expect(UI_POLICY).toMatch(/data-redaction-policy-rollback=/);
  });

  it("exposes the assignment + compare controls", () => {
    expect(UI_POLICY).toMatch(/data-redaction-policy-assign-scope=/);
    expect(UI_POLICY).toMatch(/data-redaction-policy-compare-left=/);
    expect(UI_POLICY).toMatch(/data-redaction-policy-compare-right=/);
  });
});

// =============================================================================
// 6. Video intelligence services
// =============================================================================

describe("Phase 3A Elite — video intelligence services", () => {
  it("frame service exposes register + batch + read + summary", () => {
    expect(VIDEO_FRAME).toMatch(/export async function registerVideoFrame/);
    expect(VIDEO_FRAME).toMatch(/export async function registerVideoFrameBatch/);
    expect(VIDEO_FRAME).toMatch(/export async function listVideoFrames/);
    expect(VIDEO_FRAME).toMatch(/export async function getVideoFrameSummary/);
  });

  it("track service exposes create / decide / merge / split / propagate", () => {
    for (const fn of [
      "export async function createVideoTrack",
      "export async function appendTrackDetection",
      "export async function decideVideoTrack",
      "export async function mergeTracks",
      "export async function splitTrack",
      "export async function propagateRangeDecision",
      "export async function listVideoTracksForEvidence",
    ]) {
      expect(VIDEO_TRACK).toMatch(new RegExp(fn));
    }
  });

  it("track service emits timeline events for every state change", () => {
    expect(VIDEO_TRACK).toMatch(/emitVideoTimelineEvent/);
    expect(VIDEO_TRACK).toMatch(/"TRACK_CREATED"/);
    expect(VIDEO_TRACK).toMatch(/"TRACK_ACCEPTED"/);
    expect(VIDEO_TRACK).toMatch(/"TRACK_REJECTED"/);
    expect(VIDEO_TRACK).toMatch(/"TRACK_MERGED"/);
    expect(VIDEO_TRACK).toMatch(/"TRACK_SPLIT"/);
    expect(VIDEO_TRACK).toMatch(/"DECISION_BULK_APPLIED"/);
  });

  it("timeline aggregator returns a bounded multi-layer projection", () => {
    expect(VIDEO_TIMELINE).toMatch(/export async function projectVideoTimeline/);
    expect(VIDEO_TIMELINE).toMatch(/PROOVRA_VIDEO_TIMELINE_V1/);
    expect(VIDEO_TIMELINE).toMatch(/VIDEO_TIMELINE_LAYERS/);
  });

  it("tracking heuristic groups by IoU + same-kind continuity", () => {
    expect(VIDEO_TRACKING).toMatch(/iouThreshold/);
    expect(VIDEO_TRACKING).toMatch(/export function iou/);
    expect(VIDEO_TRACKING).toMatch(/groupDetectionsIntoTracks/);
  });

  it("video verification manifest never includes geometry", () => {
    expect(VIDEO_VERIFICATION).toMatch(/totalTracks/);
    expect(VIDEO_VERIFICATION).toMatch(/perTrackKind/);
    expect(VIDEO_VERIFICATION).not.toMatch(/bbox/);
  });
});

// =============================================================================
// 7. HTTP routes — video
// =============================================================================

describe("Phase 3A Elite — video HTTP routes", () => {
  it("mounts the full video intelligence surface", () => {
    for (const path of [
      "/v1/redaction/videos/:evidenceId/frames",
      "/v1/redaction/videos/:evidenceId/frames/batch",
      "/v1/redaction/videos/:evidenceId/tracks",
      "/v1/redaction/videos/:evidenceId/tracks/group",
      "/v1/redaction/video-tracks/:id/decision",
      "/v1/redaction/video-tracks/merge",
      "/v1/redaction/video-tracks/:id/split",
      "/v1/redaction/videos/:evidenceId/decisions/range",
      "/v1/redaction/videos/:evidenceId/timeline",
    ]) {
      expect(ROUTES).toMatch(new RegExp(path.replace(/\//g, "\\/")));
    }
  });

  it("video review-tier routes require redaction.detection.review", () => {
    expect(ROUTES).toMatch(
      /\/v1\/redaction\/video-tracks\/:id\/decision[\s\S]+?gate\(reply, ctx, "redaction\.detection\.review"\)/,
    );
    expect(ROUTES).toMatch(
      /\/v1\/redaction\/videos\/:evidenceId\/decisions\/range[\s\S]+?gate\(reply, ctx, "redaction\.detection\.review"\)/,
    );
  });
});

// =============================================================================
// 8. Video Review Workspace UI
// =============================================================================

describe("Phase 3A Elite — Video Review Workspace UI", () => {
  it("renders the bounded multi-layer timeline + bulk action bar", () => {
    expect(UI_VIDEO_WORKSPACE).toMatch(/data-redaction-video-review-workspace/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/data-redaction-video-timeline/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/data-redaction-video-timeline-layer=/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/data-redaction-video-bulk-bar/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/data-redaction-video-range-approve/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/data-redaction-video-range-reject/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/data-redaction-video-merge-selected/);
  });

  it("renders per-track action buttons (approve / reject / split)", () => {
    expect(UI_VIDEO_WORKSPACE).toMatch(/data-redaction-video-track-approve=/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/data-redaction-video-track-reject=/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/data-redaction-video-track-split=/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/data-redaction-video-track-select=/);
  });

  it("hits the bounded API endpoints", () => {
    expect(UI_VIDEO_WORKSPACE).toMatch(/\/v1\/redaction\/videos\/.+?\/timeline/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/\/v1\/redaction\/videos\/.+?\/decisions\/range/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/\/v1\/redaction\/video-tracks\/merge/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/\/v1\/redaction\/video-tracks\/.+?\/split/);
    expect(UI_VIDEO_WORKSPACE).toMatch(/\/v1\/redaction\/video-tracks\/.+?\/decision/);
  });
});

// =============================================================================
// 9. Integrations — verify + report + verification package
// =============================================================================

describe("Phase 3A Elite — cross-surface integrations", () => {
  it("verify-page badge surfaces bounded video provenance (counts only)", () => {
    expect(ROUTES).toMatch(/videoProvenance/);
    expect(ROUTES).toMatch(/REDACTION_TRACKING_IS_PROVENANCE_ONLY/);
  });

  it("report builder ships a video-intelligence section", () => {
    expect(REPORT_SECTION).toMatch(
      /export function renderVideoIntelligenceSection/,
    );
    expect(REPORT_SECTION).toMatch(/Tracking-assisted redaction/);
    expect(REPORT_SECTION).toMatch(/NEVER published in this report/);
  });

  it("video verification manifest writer surfaces bounded counts only", () => {
    expect(VIDEO_VERIFICATION).toMatch(
      /export async function buildVideoTrackingVerificationEntry/,
    );
  });

  it("policy verification manifest writer surfaces only PUBLISHED policy versions", () => {
    expect(POLICY_MANIFEST).toMatch(/state !== "PUBLISHED"/);
  });
});

// =============================================================================
// 10. Runtime sanity — pure helpers
// =============================================================================

describe("Phase 3A Elite — runtime helpers", () => {
  it("IoU helper returns expected values for overlapping bboxes", () => {
    expect(
      iou(
        { x: 0, y: 0, width: 0.5, height: 0.5 },
        { x: 0, y: 0, width: 0.5, height: 0.5 },
      ),
    ).toBeCloseTo(1.0, 5);
    expect(
      iou(
        { x: 0, y: 0, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
      ),
    ).toBeCloseTo(0, 5);
    const partial = iou(
      { x: 0, y: 0, width: 0.4, height: 0.4 },
      { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
    );
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });

  it("policy version transitions reject illegal paths", () => {
    expect(isAllowedPolicyVersionTransition("PUBLISHED", "DRAFT")).toBe(false);
    expect(isAllowedPolicyVersionTransition("SUPERSEDED", "PUBLISHED")).toBe(false);
    expect(isAllowedPolicyVersionTransition("REJECTED", "APPROVED")).toBe(false);
    expect(isAllowedPolicyVersionTransition("ROLLED_BACK", "DRAFT")).toBe(true);
  });

  it("policy precedence is strictly ordered + monotonic", () => {
    expect(POLICY_ASSIGNMENT_PRECEDENCE.GLOBAL).toBe(0);
    expect(POLICY_ASSIGNMENT_PRECEDENCE.WORKSPACE).toBe(1);
    expect(POLICY_ASSIGNMENT_PRECEDENCE.CASE).toBe(2);
    expect(POLICY_ASSIGNMENT_PRECEDENCE.PROJECT).toBe(3);
  });
});
