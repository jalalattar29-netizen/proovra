/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source:    services/api/prisma/schema.prisma
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
