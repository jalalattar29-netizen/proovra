/**
 * PROOVRA Phase 3A Elite Closure — Policy + Video Intelligence
 * shared contracts.
 *
 * Bounded vocabulary for:
 *
 *   * Redaction policy lifecycle (version state machine, scope
 *     hierarchy, per-detection-kind action vocabulary, custom
 *     regex rule shape).
 *   * Video frame extraction, tracking, and timeline events.
 *
 * Hard rules:
 *
 *   1. Append-only enums.
 *   2. Policy inheritance is GLOBAL → WORKSPACE → CASE → PROJECT
 *      with deterministic precedence — PROJECT wins over CASE wins
 *      over WORKSPACE wins over GLOBAL.
 *   3. Tracks NEVER mutate the original video bytes; they record
 *      the bounded redaction intent across frames. The worker
 *      derivative pipeline reads the track + decision and renders.
 */

import type {
  RedactionConfidenceBand,
  RedactionDetectionKind,
  RedactionDetectionProvider,
  RedactionMethod,
} from "./redaction.js";

// ===========================================================================
// 1. Policy version state machine
// ===========================================================================

export const REDACTION_POLICY_VERSION_STATES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "PUBLISHED",
  "REJECTED",
  "SUPERSEDED",
  "ROLLED_BACK",
] as const;
export type RedactionPolicyVersionState =
  (typeof REDACTION_POLICY_VERSION_STATES)[number];

export const REDACTION_POLICY_VERSION_TRANSITIONS: Readonly<
  Record<RedactionPolicyVersionState, ReadonlyArray<RedactionPolicyVersionState>>
> = {
  DRAFT: ["IN_REVIEW", "REJECTED"],
  IN_REVIEW: ["APPROVED", "REJECTED", "DRAFT"],
  APPROVED: ["PUBLISHED", "REJECTED"],
  REJECTED: ["DRAFT"],
  PUBLISHED: ["SUPERSEDED", "ROLLED_BACK"],
  SUPERSEDED: [],
  ROLLED_BACK: ["DRAFT"],
};

export function isAllowedPolicyVersionTransition(
  from: RedactionPolicyVersionState,
  to: RedactionPolicyVersionState,
): boolean {
  return REDACTION_POLICY_VERSION_TRANSITIONS[from].includes(to);
}

// ===========================================================================
// 2. Policy assignment scope + inheritance precedence
// ===========================================================================

export const POLICY_ASSIGNMENT_SCOPES = [
  "GLOBAL",
  "WORKSPACE",
  "CASE",
  "PROJECT",
] as const;
export type PolicyAssignmentScope =
  (typeof POLICY_ASSIGNMENT_SCOPES)[number];

/**
 * Deterministic precedence — higher number wins. The inheritance
 * resolver returns the highest-precedence assignment that applies
 * to the (workspace, case, project) triple.
 */
export const POLICY_ASSIGNMENT_PRECEDENCE: Readonly<
  Record<PolicyAssignmentScope, number>
> = {
  GLOBAL: 0,
  WORKSPACE: 1,
  CASE: 2,
  PROJECT: 3,
};

// ===========================================================================
// 3. Per-detection-kind rule action
// ===========================================================================

export const POLICY_DETECTION_RULE_ACTIONS = [
  // Run the detector but do NOT surface the suggestion to the
  // reviewer. Used to honestly disable a detection class without
  // disabling the provider entirely.
  "DETECT_ONLY",
  // Surface the suggestion to the reviewer queue (default).
  "SUGGEST",
  // Surface AND require a senior approver before the version can
  // be published.
  "REQUIRE_APPROVAL",
  // Block publication while any suggestion of this kind remains
  // un-resolved.
  "BLOCK_PUBLICATION",
] as const;
export type PolicyDetectionRuleAction =
  (typeof POLICY_DETECTION_RULE_ACTIONS)[number];

// ===========================================================================
// 4. Custom regex rule shape
// ===========================================================================

export type PolicyCustomRegexRule = {
  /** Bounded operator-visible name (≤ 80 chars). */
  name: string;
  /** Bounded detection kind this rule maps to. */
  kind: RedactionDetectionKind;
  /** Bounded regex pattern (≤ 400 chars). */
  pattern: string;
  /** Bounded regex flags subset: i, m, s, u. */
  flags?: string;
  /** Bounded raw confidence in [0, 1]. */
  rawConfidence: number;
  /** Bounded action. */
  action: PolicyDetectionRuleAction;
};

// ===========================================================================
// 5. Policy document shape (versioned snapshot)
// ===========================================================================

export const REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION =
  "PROOVRA_REDACTION_POLICY_V1" as const;

export type RedactionPolicyDocument = {
  schemaVersion: typeof REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION;
  /** Bounded provider on/off map. */
  providers: Partial<Record<RedactionDetectionProvider, boolean>>;
  /** Bounded detection-kind on/off map. */
  kinds: Partial<Record<RedactionDetectionKind, boolean>>;
  /** Per-kind action map. */
  ruleActions: Partial<Record<RedactionDetectionKind, PolicyDetectionRuleAction>>;
  /** Bounded custom regex rules. */
  customRules: ReadonlyArray<PolicyCustomRegexRule>;
};

// ===========================================================================
// 6. Policy audit codes
// ===========================================================================

export const REDACTION_POLICY_ACTIVITY_CODES = [
  "POLICY_CREATED",
  "POLICY_ARCHIVED",
  "POLICY_VERSION_CREATED",
  "POLICY_VERSION_SUBMITTED",
  "POLICY_VERSION_APPROVED",
  "POLICY_VERSION_REJECTED",
  "POLICY_VERSION_PUBLISHED",
  "POLICY_VERSION_SUPERSEDED",
  "POLICY_VERSION_ROLLED_BACK",
  "POLICY_ASSIGNMENT_CREATED",
  "POLICY_ASSIGNMENT_REVOKED",
  "POLICY_RULE_FIRED",
  "POLICY_CONFLICT_RESOLVED",
] as const;
export type RedactionPolicyActivityCode =
  (typeof REDACTION_POLICY_ACTIVITY_CODES)[number];

// ===========================================================================
// 7. Effective-policy projection — resolved + flattened across the
//    workspace / case / project triple, ready for the orchestrator
//    + the policy UI's "preview" pane.
// ===========================================================================

export type EffectivePolicy = {
  schemaVersion: typeof REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION;
  effectiveAtUtc: string;
  /** Bounded resolved provider on/off map (no missing keys). */
  providers: Record<RedactionDetectionProvider, boolean>;
  /** Bounded resolved kind on/off map. */
  kinds: Partial<Record<RedactionDetectionKind, boolean>>;
  /** Resolved per-kind actions. */
  ruleActions: Partial<Record<RedactionDetectionKind, PolicyDetectionRuleAction>>;
  customRules: ReadonlyArray<PolicyCustomRegexRule>;
  /** Bounded trail of which assignment fed each setting. */
  resolution: ReadonlyArray<{
    scope: PolicyAssignmentScope;
    scopeTargetId: string | null;
    policyId: string;
    policyVersionId: string;
    versionOrdinal: number;
  }>;
};

// ===========================================================================
// 8. Video intelligence — track kinds + states + timeline layers
// ===========================================================================

export const VIDEO_TRACK_KINDS = [
  "FACE",
  "OBJECT",
  "TEXT",
  "LICENSE_PLATE",
  "SCREEN_CONTENT",
  "CUSTOM",
] as const;
export type VideoTrackKind = (typeof VIDEO_TRACK_KINDS)[number];

export const VIDEO_TRACK_STATES = [
  "SUGGESTED",
  "ACCEPTED",
  "MODIFIED",
  "REJECTED",
  "MERGED",
  "SPLIT",
] as const;
export type VideoTrackState = (typeof VIDEO_TRACK_STATES)[number];

export const VIDEO_FRAME_EXTRACTORS = [
  "FFMPEG_SAMPLE",
  "FFMPEG_KEYFRAME",
  "OPERATOR_INLINE",
] as const;
export type VideoFrameExtractor = (typeof VIDEO_FRAME_EXTRACTORS)[number];

export const VIDEO_TIMELINE_LAYERS = [
  "FRAME",
  "DETECTION",
  "TRACKING",
  "APPROVAL",
  "CONFIDENCE",
  "COMMENT",
  "DECISION",
  "DERIVATIVE",
] as const;
export type VideoTimelineLayer = (typeof VIDEO_TIMELINE_LAYERS)[number];

export const VIDEO_TIMELINE_EVENT_CODES = [
  // FRAME layer
  "FRAME_EXTRACTED",
  // DETECTION layer
  "DETECTION_GENERATED",
  // TRACKING layer
  "TRACK_CREATED",
  "TRACK_EXTENDED",
  "TRACK_MERGED",
  "TRACK_SPLIT",
  "TRACK_PROPAGATED",
  // APPROVAL layer
  "TRACK_ACCEPTED",
  "TRACK_REJECTED",
  "RANGE_ACCEPTED",
  "RANGE_REJECTED",
  // CONFIDENCE layer
  "CONFIDENCE_RECOMPUTED",
  // COMMENT layer
  "COMMENT_ADDED",
  // DECISION layer
  "DECISION_BULK_APPLIED",
  // DERIVATIVE layer
  "DERIVATIVE_RENDER_REQUESTED",
] as const;
export type VideoTimelineEventCode =
  (typeof VIDEO_TIMELINE_EVENT_CODES)[number];

// ===========================================================================
// 9. Video track bulk operations
// ===========================================================================

export const VIDEO_TRACK_BULK_OPS = [
  "APPROVE_RANGE",
  "REJECT_RANGE",
  "APPLY_TO_TRACK",
  "SPLIT_TRACK",
  "MERGE_TRACKS",
  "BULK_DECISION",
] as const;
export type VideoTrackBulkOp = (typeof VIDEO_TRACK_BULK_OPS)[number];

// ===========================================================================
// 10. Frame extraction sampling presets
// ===========================================================================

export const VIDEO_FRAME_SAMPLE_PRESETS = [
  "EVERY_FRAME",
  "EVERY_500MS",
  "EVERY_1S",
  "EVERY_5S",
  "EVERY_KEYFRAME",
] as const;
export type VideoFrameSamplePreset =
  (typeof VIDEO_FRAME_SAMPLE_PRESETS)[number];

export const VIDEO_FRAME_SAMPLE_MS: Readonly<
  Record<VideoFrameSamplePreset, number | null>
> = {
  EVERY_FRAME: 0,
  EVERY_500MS: 500,
  EVERY_1S: 1000,
  EVERY_5S: 5000,
  EVERY_KEYFRAME: null,
};

// ===========================================================================
// 11. Bounded projection shapes — consumed by UI + verify + report
// ===========================================================================

export type VideoTrackProjection = {
  id: string;
  kind: VideoTrackKind;
  label: string | null;
  method: RedactionMethod;
  startFrame: number;
  endFrame: number;
  state: VideoTrackState;
  confidenceBand: RedactionConfidenceBand;
  decisionByUserId: string | null;
  decidedAtUtc: string | null;
  detectionCount: number;
};

export type VideoFrameProjection = {
  id: string;
  frameIndex: number;
  timestampMs: number;
  extractor: VideoFrameExtractor;
  storageKey: string | null;
};

export type VideoTimelineProjection = {
  schemaVersion: "PROOVRA_VIDEO_TIMELINE_V1";
  generatedAtUtc: string;
  evidenceId: string;
  totalFrames: number;
  totalDurationMs: number;
  layers: Partial<
    Record<
      VideoTimelineLayer,
      ReadonlyArray<{
        id: string;
        code: VideoTimelineEventCode;
        label: string | null;
        startFrame: number;
        endFrame: number;
        startMs: number;
        endMs: number;
        trackId: string | null;
        actorUserId: string | null;
        occurredAtUtc: string;
      }>
    >
  >;
  tracks: ReadonlyArray<VideoTrackProjection>;
};

// ===========================================================================
// 12. Verification-package manifest extensions
// ===========================================================================

export type VideoTrackingVerificationManifestEntry = {
  evidenceId: string;
  versionId: string | null;
  totalFrames: number;
  totalTracks: number;
  acceptedTracks: number;
  rejectedTracks: number;
  perTrackKind: Partial<Record<VideoTrackKind, number>>;
};

export type PolicyVerificationManifestEntry = {
  policyId: string;
  policyName: string;
  versionOrdinal: number;
  policyVersionId: string;
  publishedAtUtc: string | null;
  approverUserId: string | null;
  document: RedactionPolicyDocument;
  assignmentScopes: ReadonlyArray<{
    scope: PolicyAssignmentScope;
    scopeTargetId: string | null;
  }>;
};
