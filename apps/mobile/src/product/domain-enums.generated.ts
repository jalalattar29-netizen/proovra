/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Sources:   services/api/prisma/schema.prisma
 *            packages/shared/src/collaboration-team.ts
 *            packages/shared/src/evidence-output-lifecycle.ts
 *            services/api/src/services/evidence-review/review-status-vocabulary.ts
 * Generator: apps/mobile/tools/generate-domain-enums.mjs
 * Guard:     apps/mobile/test/domain-enums-generated.test.mjs
 *
 * These are the canonical domain values, not a native copy of them. Labels and
 * tones remain authored in src/product/domain-display.ts, which must map every
 * value here or the guard fails.
 */

/** Prisma enum `EvidenceType`. */
export const EVIDENCE_TYPES = [
  "VIDEO",
  "AUDIO",
  "PHOTO",
  "DOCUMENT",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** Prisma enum `EvidenceStatus`. */
export const EVIDENCE_STATUSES = [
  "CREATED",
  "UPLOADING",
  "UPLOADED",
  "SIGNED",
  "REPORTED",
  "FAILED_HASH_MISMATCH",
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** Prisma enum `VerificationStatus`. */
export const VERIFICATION_STATUSES = [
  "MATERIALS_AVAILABLE",
  "RECORDED_INTEGRITY_VERIFIED",
  "REVIEW_REQUIRED",
  "FAILED",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Prisma enum `EvidenceLifecycleState`. */
export const EVIDENCE_LIFECYCLE_STATES = [
  "ACTIVE",
  "UNDER_REVIEW",
  "ON_HOLD",
  "RETENTION_LOCKED",
  "PENDING_DESTRUCTION",
  "DESTROYED",
  "ARCHIVED",
  "TRASHED",
] as const;
export type EvidenceLifecycleState = (typeof EVIDENCE_LIFECYCLE_STATES)[number];

/** Prisma enum `CaseStatus`. */
export const CASE_STATUSES = [
  "OPEN",
  "INVESTIGATING",
  "ON_HOLD",
  "RESOLVED",
  "CLOSED",
  "ARCHIVED",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Prisma enum `EvidenceLegalNoteType`. */
export const EVIDENCE_LEGAL_NOTE_TYPES = [
  "GENERAL",
  "PRIVILEGED",
  "DISCLOSURE",
  "REVIEW_BOUNDARY",
  "HANDOFF",
] as const;
export type EvidenceLegalNoteType = (typeof EVIDENCE_LEGAL_NOTE_TYPES)[number];

/** Prisma enum `EvidenceAnnotationType`. */
export const EVIDENCE_ANNOTATION_TYPES = [
  "POINT",
  "BOX",
  "REGION",
  "TIMESTAMP",
  "TEXT",
] as const;
export type EvidenceAnnotationType = (typeof EVIDENCE_ANNOTATION_TYPES)[number];

/** Prisma enum `EvidenceAnnotationCoordinateSpace`. */
export const EVIDENCE_ANNOTATION_COORDINATE_SPACES = [
  "NORMALIZED",
  "PIXEL",
  "TIME_ONLY",
  "DOCUMENT_PAGE",
] as const;
export type EvidenceAnnotationCoordinateSpace = (typeof EVIDENCE_ANNOTATION_COORDINATE_SPACES)[number];

/** Prisma enum `EvidenceRelationshipType`. */
export const EVIDENCE_RELATIONSHIP_TYPES = [
  "RELATED",
  "SUPPORTS",
  "DUPLICATE_OF",
  "DERIVED_FROM",
  "SAME_INCIDENT",
  "CONTRADICTS",
  "REPLACES",
  "REFERENCES",
] as const;
export type EvidenceRelationshipType = (typeof EVIDENCE_RELATIONSHIP_TYPES)[number];

/** Prisma enum `EvidenceReviewWorkflowStatus`. */
export const EVIDENCE_REVIEW_WORKFLOW_STATUSES = [
  "NOT_STARTED",
  "IN_REVIEW",
  "NEEDS_INFO",
  "READY_FOR_EXTERNAL_REVIEW",
  "APPROVED_INTERNAL",
  "ESCALATED",
  "CLOSED",
  "QUEUED",
  "ASSIGNED",
  "RESPONSE_RECEIVED",
  "REJECTED_INSUFFICIENT",
  "REOPENED",
] as const;
export type EvidenceReviewWorkflowStatus = (typeof EVIDENCE_REVIEW_WORKFLOW_STATUSES)[number];

/** Prisma enum `EvidenceReviewWorkflowPriority`. */
export const EVIDENCE_REVIEW_WORKFLOW_PRIORITIES = [
  "LOW",
  "NORMAL",
  "HIGH",
  "URGENT",
] as const;
export type EvidenceReviewWorkflowPriority = (typeof EVIDENCE_REVIEW_WORKFLOW_PRIORITIES)[number];

/** `@proovra/shared` `COLLABORATION_TEAM_ASSIGNMENT_STATUSES`. */
export const COLLABORATION_TEAM_ASSIGNMENT_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "COMPLETED",
  "REASSIGNED",
  "CANCELLED",
] as const;
export type CollaborationTeamAssignmentStatus = (typeof COLLABORATION_TEAM_ASSIGNMENT_STATUSES)[number];

/** `@proovra/shared` `COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES`. */
export const COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES = [
  "LOW",
  "NORMAL",
  "HIGH",
  "URGENT",
] as const;
export type CollaborationTeamAssignmentPriority = (typeof COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES)[number];

/** `@proovra/shared` `COLLABORATION_TEAM_ASSIGNMENT_TARGETS`. */
export const COLLABORATION_TEAM_ASSIGNMENT_TARGETS = [
  "CASE",
  "EVIDENCE",
  "REVIEW",
] as const;
export type CollaborationTeamAssignmentTarget = (typeof COLLABORATION_TEAM_ASSIGNMENT_TARGETS)[number];

/** `@proovra/shared` `COLLABORATION_TEAM_ROLES`. */
export const COLLABORATION_TEAM_ROLES = [
  "LEAD",
  "ADMIN",
  "MEMBER",
  "VIEWER",
  "EXTERNAL",
] as const;
export type CollaborationTeamRole = (typeof COLLABORATION_TEAM_ROLES)[number];

/** `@proovra/shared` `COLLABORATION_TEAM_TYPES`. */
export const COLLABORATION_TEAM_TYPES = [
  "GENERAL",
  "INVESTIGATION",
  "LEGAL",
  "REVIEW",
  "COMPLIANCE",
] as const;
export type CollaborationTeamType = (typeof COLLABORATION_TEAM_TYPES)[number];

/** `@proovra/shared` `GENERATION_REQUEST_OUTCOMES`. */
export const GENERATION_REQUEST_OUTCOMES = [
  "ENQUEUED",
  "ALREADY_ACTIVE",
  "QUEUE_UNAVAILABLE",
  "NOT_INCLUDED",
  "RECOVERABLE_BLOCKED",
  "TERMINAL",
  "SUPERSEDED",
  "REQUEST_PERSIST_FAILED",
  "EVIDENCE_NOT_FOUND",
  "WORKSPACE_UNRESOLVED",
  "REQUESTER_REQUIRED",
] as const;
export type GenerationRequestOutcome = (typeof GENERATION_REQUEST_OUTCOMES)[number];

/**
 * `review-status-vocabulary.ts` `DECISION_DERIVED_WORKFLOW_STATUSES`.
 *
 * Statuses only the decision authority may produce. A surface that OFFERED
 * one would be offering to forge a verdict.
 */
export const DECISION_DERIVED_WORKFLOW_STATUSES = [
  "APPROVED_INTERNAL",
  "REJECTED_INSUFFICIENT",
  "NEEDS_INFO",
] as const;
