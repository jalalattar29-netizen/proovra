import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { createEvidence } from "../services/evidence.service.js";
import { completeEvidence } from "../services/evidence-complete.service.js";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import {
  presignGetObject,
  presignPutObject,
  headObject,
} from "../storage.js";
import { verifyJwt } from "../services/jwt.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import {
  appendCustodyEvent,
  evaluateCustodyChain,
  isAccessCustodyEventType,
} from "../services/custody-events.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { ed25519VerifyHexSignature, sha256Hex } from "../crypto.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import { readBillingOverview } from "../services/billing-overview.service.js";

const EvidenceTypeSchema = prismaPkg.EvidenceType
  ? z.nativeEnum(prismaPkg.EvidenceType)
  : z.enum(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]);

const CreateEvidenceBody = z.object({
  type: EvidenceTypeSchema,
  mimeType: z.string().min(1).max(128).optional(),
  deviceTimeIso: z.string().min(1).max(64).optional(),
  checksumSha256Base64: z.string().min(1).max(128).optional(),
  contentMd5Base64: z.string().min(1).max(128).optional(),
  gps: z
    .object({
      lat: z.number(),
      lng: z.number(),
      accuracyMeters: z.number().positive().optional(),
    })
    .optional(),
});

const ClaimBody = z.object({
  guestToken: z.string().min(1).optional(),
  evidenceIds: z.array(z.string().uuid()).optional(),
});

const LockBody = z.object({
  locked: z.boolean().optional().default(true),
});

const CreatePartBody = z.object({
  partIndex: z.number().int().min(0),
  mimeType: z.string().min(1).max(128).optional(),
  originalFileName: z.string().trim().min(1).max(255).optional(),
  durationMs: z.number().int().positive().optional(),
  checksumSha256Base64: z.string().min(1).max(128).optional(),
  contentMd5Base64: z.string().min(1).max(128).optional(),
});

const UpdateEvidenceLabelBody = z.object({
  label: z.string().trim().min(1).max(160),
});

const RestoreDeletedEvidenceBody = z.object({
  restore: z.boolean().optional().default(true),
});

type ParamsId = { id: string };

const { EvidenceStatus, PlanType, VerificationSource, VerificationViewerType } =
  prismaPkg;

type PublicCustodyEventCategory = "forensic" | "access";

type PublicVerifyTimelineEvent = {
  sequence: number;
  atUtc: string;
  eventType: prismaPkg.CustodyEventType;
  payloadSummary: string | null;
  prevEventHash: string | null;
  eventHash: string | null;
  category: PublicCustodyEventCategory;
};

async function requireAuthAndLegal(req: FastifyRequest, reply: any) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  await requireLegalAcceptance(req, reply);
}

const SAFE_EVIDENCE_SELECT = {
  id: true,
  title: true,
  ownerUserId: true,
  organizationId: true,
  type: true,
  status: true,
  verificationStatus: true,
  captureMethod: true,
  identityLevelSnapshot: true,
  submittedByEmail: true,
  submittedByAuthProvider: true,
  submittedByUserId: true,
  createdByUserId: true,
  uploadedByUserId: true,
  lastAccessedByUserId: true,
  lastAccessedAtUtc: true,
  workspaceNameSnapshot: true,
  organizationNameSnapshot: true,
  organizationVerifiedSnapshot: true,
  recordedIntegrityVerifiedAtUtc: true,
  lastVerifiedAtUtc: true,
  lastVerifiedSource: true,
  verificationPackageGeneratedAtUtc: true,
  verificationPackageVersion: true,
  latestReportVersion: true,
  reviewReadyAtUtc: true,
  reviewerSummaryVersion: true,
  createdAt: true,
  uploadedAtUtc: true,
  signedAtUtc: true,
  capturedAtUtc: true,
  reportGeneratedAtUtc: true,
  deviceTimeIso: true,
  lat: true,
  lng: true,
  accuracyMeters: true,
  mimeType: true,
  storageBucket: true,
  storageKey: true,
  storageRegion: true,
  storageObjectLockMode: true,
  storageObjectLockRetainUntilUtc: true,
  storageObjectLockLegalHoldStatus: true,
  sizeBytes: true,
  fileSha256: true,
  fingerprintHash: true,
  signatureBase64: true,
  signingKeyId: true,
  signingKeyVersion: true,
  deletedByUserId: true,
  lockedAt: true,
  lockedByUserId: true,
  archivedAt: true,
  caseId: true,
  teamId: true,
  deletedAt: true,
  deletedAtUtc: true,
  deleteScheduledForUtc: true,
} as const;

type SelectedEvidence = prismaPkg.Prisma.EvidenceGetPayload<{
  select: typeof SAFE_EVIDENCE_SELECT;
}>;

type StorageProtectionSummary = {
  immutable: boolean;
  mode: string | null;
  retainUntil: string | null;
  legalHold: string | null;
  region: string | null;
  verified: boolean;
} | null;

type AnchorStatusSummary = {
  mode: "off" | "ready" | "active";
  provider: string | null;
  publicBaseUrl: string | null;
  configured: boolean;
  published: boolean;
  anchorHash: string | null;
  receiptId: string | null;
  transactionId: string | null;
  publicUrl: string | null;
  anchoredAtUtc: string | null;
};

type SafeEvidence = {
  id: string;
  title: string;
  ownerUserId?: string;
  organizationId: string | null;
  type: prismaPkg.EvidenceType;
  status: prismaPkg.EvidenceStatus;
  verificationStatus: prismaPkg.VerificationStatus | null;
  captureMethod: prismaPkg.CaptureMethod | null;
  identityLevelSnapshot: prismaPkg.IdentityLevel | null;
  submittedByEmail: string | null;
  submittedByAuthProvider: prismaPkg.AuthProvider | null;
  submittedByUserId: string | null;
  createdByUserId: string | null;
  uploadedByUserId: string | null;
  lastAccessedByUserId: string | null;
  lastAccessedAtUtc: string | null;
  workspaceNameSnapshot: string | null;
  organizationNameSnapshot: string | null;
  organizationVerifiedSnapshot: boolean | null;
  recordedIntegrityVerifiedAtUtc: string | null;
  lastVerifiedAtUtc: string | null;
  lastVerifiedSource: prismaPkg.VerificationSource | null;
  verificationPackageGeneratedAtUtc: string | null;
  verificationPackageVersion: number | null;
  latestReportVersion: number | null;
  reviewReadyAtUtc: string | null;
  reviewerSummaryVersion: number | null;
  createdAt: string;
  uploadedAtUtc: string | null;
  signedAtUtc: string | null;
  capturedAtUtc: string | null;
  reportGeneratedAtUtc: string | null;
  deviceTimeIso: string | null;
  lat: number | null;
  lng: number | null;
  accuracyMeters: number | null;
  mimeType: string | null;
  storageBucket: string | null;
  storageKey: string | null;
  storageRegion: string | null;
  storageObjectLockMode: string | null;
  storageObjectLockRetainUntilUtc: string | null;
  storageObjectLockLegalHoldStatus: string | null;
  sizeBytes: string | null;
  fileSha256: string | null;
  fingerprintHash: string | null;
  signatureBase64: string | null;
  signingKeyId: string | null;
  signingKeyVersion: number | null;
  deletedByUserId: string | null;
  lockedAt: string | null;
  lockedByUserId: string | null;
  archivedAt: string | null;
  caseId: string | null;
  teamId: string | null;
  deletedAt: string | null;
  deletedAtUtc: string | null;
  deleteScheduledForUtc: string | null;
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getTierLimit(plan: prismaPkg.PlanType) {
  switch (plan) {
    case PlanType.PAYG:
      return { max: 30, windowSec: 60 };
    case PlanType.PRO:
    case PlanType.TEAM:
      return { max: 60, windowSec: 60 };
    case PlanType.FREE:
    default:
      return { max: 10, windowSec: 60 };
  }
}

function getVerifyLimit() {
  return {
    max: readPositiveIntEnv("VERIFY_RATE_LIMIT_MAX", 60),
    windowSec: readPositiveIntEnv("VERIFY_RATE_LIMIT_WINDOW_SEC", 60),
  };
}

function readUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

function getRequestPath(req: FastifyRequest): string {
  const url = req.url || "";
  const qIndex = url.indexOf("?");
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

function auditEvidenceAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  void appendPlatformAuditLog({
    userId: params.userId,
    action: params.action,
    category: "evidence",
    severity: params.severity ?? "info",
    source: "api_evidence",
    outcome: params.outcome ?? "success",
    resourceType: "evidence",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function auditVerificationAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  void appendPlatformAuditLog({
    userId: params.userId,
    isPublic: params.userId === null,
    action: params.action,
    category: "verification",
    severity: "info",
    source: "public_verify",
    outcome: "success",
    resourceType: "evidence_verification",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function fireEvidenceAnalyticsEvent(params: {
  eventType: string;
  userId: string;
  req?: FastifyRequest;
  entityType?: string | null;
  entityId?: string | null;
  severity?: string | null;
  metadata?: Record<string, unknown>;
}) {
  void writeAnalyticsEvent({
    eventType: params.eventType,
    userId: params.userId,
    path: params.req ? getRequestPath(params.req) : null,
    entityType: params.entityType ?? "evidence",
    entityId: params.entityId ?? null,
    severity: params.severity ?? "info",
    metadata: params.metadata ?? {},
    req: params.req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

async function getUserPlan(userId: string) {
  const entitlement = await prisma.entitlement.findFirst({
    where: { userId, active: true },
  });
  return entitlement?.plan ?? PlanType.FREE;
}

function bigintToString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function decimalToNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;

  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }

  if (
    typeof v === "object" &&
    v !== null &&
    "toNumber" in v &&
    typeof (v as { toNumber: () => number }).toNumber === "function"
  ) {
    const n = (v as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }

  if (
    typeof v === "object" &&
    v !== null &&
    "toString" in v &&
    typeof (v as { toString: () => string }).toString === "function"
  ) {
    const n = Number((v as { toString: () => string }).toString());
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function shortHash(
  value: string | null | undefined,
  head = 12,
  tail = 10
): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function normalizeMimeType(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text) return null;
  if (text.length > 128) return null;
  if (/[\r\n]/.test(text)) return null;
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(text)) return null;
  return text;
}

function normalizeChecksumSha256Base64(
  value: string | null | undefined
): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length > 128) return null;
  if (/[\r\n]/.test(text)) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(text)) return null;
  return text;
}

function normalizeContentMd5Base64(
  value: string | null | undefined
): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length > 128) return null;
  if (/[\r\n]/.test(text)) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(text)) return null;
  return text;
}

function normalizePublicPayloadValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const t = value.trim();
    return t || null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function resolveEvidenceTitle(title: string | null | undefined): string {
  const t = typeof title === "string" ? title.trim() : "";
  return t || "Digital Evidence Record";
}

function mapRecordStatusLabel(status: prismaPkg.EvidenceStatus | string): string {
  switch (String(status).toUpperCase()) {
    case "REPORTED":
      return "Reported";
    case "SIGNED":
      return "Signed";
    case "UPLOADED":
      return "Uploaded";
    case "UPLOADING":
      return "Uploading";
    case "CREATED":
    default:
      return "Created";
  }
}

function mapVerificationStatusLabel(
  status: prismaPkg.VerificationStatus | string | null | undefined
): string {
  switch (String(status ?? "").toUpperCase()) {
    case "RECORDED_INTEGRITY_VERIFIED":
      return "Recorded integrity state verified";
    case "MATERIALS_AVAILABLE":
      return "Technical materials available";
    case "REVIEW_REQUIRED":
      return "Review required";
    case "FAILED":
      return "Verification failed";
    default:
      return "Verification status not recorded";
  }
}

function mapAuthProviderLabel(
  provider: prismaPkg.AuthProvider | string | null | undefined
): string | null {
  switch (String(provider ?? "").toUpperCase()) {
    case "GOOGLE":
      return "Google";
    case "APPLE":
      return "Apple";
    case "EMAIL":
      return "Email";
    case "GUEST":
      return "Guest";
    default:
      return null;
  }
}

function mapIdentityLevelLabel(
  level: prismaPkg.IdentityLevel | string | null | undefined
): string {
  switch (String(level ?? "").toUpperCase()) {
    case "BASIC_ACCOUNT":
      return "Basic account";
    case "VERIFIED_EMAIL":
      return "Verified email";
    case "OAUTH_BACKED_IDENTITY":
      return "OAuth-backed identity";
    case "ORGANIZATION_ACCOUNT":
      return "Organization account";
    case "VERIFIED_ORGANIZATION":
      return "Verified organization";
    default:
      return "Identity level not recorded";
  }
}

function mapVerificationSourceLabel(
  source: prismaPkg.VerificationSource | string | null | undefined
): string {
  switch (String(source ?? "").toUpperCase()) {
    case "REPORT_GENERATED":
      return "Report generated";
    case "PUBLIC_VERIFY_VIEWED":
      return "Public verify viewed";
    case "TECHNICAL_VERIFICATION_CHECKED":
      return "Technical verification checked";
    default:
      return "Verification source not recorded";
  }
}

function formatDisplayDateUtc(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";

  const day = d.getUTCDate().toString().padStart(2, "0");
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const year = d.getUTCFullYear();
  const hours = d.getUTCHours().toString().padStart(2, "0");
  const minutes = d.getUTCMinutes().toString().padStart(2, "0");
  const seconds = d.getUTCSeconds().toString().padStart(2, "0");

  return `${day} ${month} ${year}, ${hours}:${minutes}:${seconds} UTC`;
}

function buildEvidenceSubtitle(params: {
  itemCount: number;
  status: prismaPkg.EvidenceStatus | string;
  createdAt: Date | string;
}) {
  const count = Math.max(1, params.itemCount || 1);
  return `${count} ${count === 1 ? "item" : "items"} • ${mapRecordStatusLabel(
    params.status
  )} • ${formatDisplayDateUtc(params.createdAt)}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function getCompletedEvidenceLabel(itemCount: number | null): string {
  const count =
    typeof itemCount === "number" && Number.isFinite(itemCount)
      ? Math.max(0, itemCount)
      : 0;
  return count <= 1
    ? "Single evidence item completed"
    : "Multipart evidence package completed";
}

function normalizeAnchorMode(
  value: string | null | undefined
): "off" | "ready" | "active" {
  const raw = String(value ?? "ready").trim().toLowerCase();
  if (raw === "off" || raw === "active") return raw;
  return "ready";
}

function normalizeTimestampStatus(
  status: string | null | undefined
): string | null {
  const text = typeof status === "string" ? status.trim().toUpperCase() : "";
  return text || null;
}

function normalizeOtsStatus(status: string | null | undefined): string | null {
  const text = typeof status === "string" ? status.trim().toUpperCase() : "";
  return text || null;
}

function mapEvidenceTypeLabel(
  type: prismaPkg.EvidenceType | string | null | undefined
): string {
  switch (String(type ?? "").toUpperCase()) {
    case "PHOTO":
      return "Photo";
    case "VIDEO":
      return "Video";
    case "AUDIO":
      return "Audio";
    case "DOCUMENT":
      return "Document";
    default:
      return "Evidence";
  }
}

function mapCaptureMethodLabel(
  captureMethod: prismaPkg.CaptureMethod | string | null | undefined
): string {
  switch (String(captureMethod ?? "").toUpperCase()) {
    case "SECURE_CAMERA":
      return "Captured with PROOVRA secure camera";
    case "UPLOADED_FILE":
      return "Uploaded existing file";
    case "IMPORTED_DOCUMENT":
      return "Imported document";
    case "MULTIPART_PACKAGE":
      return "Multipart package";
    default:
      return "Capture method not recorded";
  }
}

function mapIntegrityHeadline(
  overallIntegrity: boolean | null | undefined
): string {
  if (overallIntegrity === true) return "Recorded Integrity Verified";
  if (overallIntegrity === false) return "Recorded Integrity Review Required";
  return "Recorded Integrity Materials Available";
}

function mapIntegritySummaryText(params: {
  overallIntegrity: boolean | null | undefined;
  canonicalHashMatches: boolean;
  signatureValid: boolean;
  custodyChainValid: boolean;
  timestampDigestMatches: boolean;
  otsHashMatches: boolean;
}) {
  if (
    params.overallIntegrity === true &&
    params.canonicalHashMatches &&
    params.signatureValid &&
    params.custodyChainValid &&
    params.timestampDigestMatches &&
    params.otsHashMatches
  ) {
    return "Recorded integrity checks passed for the available fingerprint, signature, custody chain, timestamp linkage, and OpenTimestamps linkage.";
  }

  if (params.overallIntegrity === false) {
    return "One or more recorded integrity checks did not pass. Manual review is recommended before relying on this evidence record.";
  }

  return "Recorded technical verification materials are available for review.";
}

function mapStorageStatusLabel(storage: StorageProtectionSummary): string {
  if (!storage) return "Not reported";
  if (
    storage.immutable &&
    String(storage.mode ?? "").toUpperCase() === "COMPLIANCE"
  ) {
    return "Immutable storage verified";
  }
  if (
    storage.verified &&
    String(storage.mode ?? "").toUpperCase() === "GOVERNANCE"
  ) {
    return "Governance retention active";
  }
  if (storage.verified) {
    return "Storage protection reported";
  }
  return "Storage protection unverified";
}

function mapTimestampStatusLabel(status: string | null | undefined): string {
  const normalized = normalizeTimestampStatus(status);
  switch (normalized) {
    case "STAMPED":
    case "GRANTED":
    case "SUCCEEDED":
    case "VERIFIED":
      return "Trusted timestamp recorded";
    case "PENDING":
      return "Timestamp pending";
    case "FAILED":
      return "Timestamp failed";
    default:
      return "Timestamp unavailable";
  }
}

function mapOtsStatusLabel(status: string | null | undefined): string {
  const normalized = normalizeOtsStatus(status);
  switch (normalized) {
    case "ANCHORED":
      return "OpenTimestamps anchored";
    case "PENDING":
      return "OpenTimestamps pending";
    case "FAILED":
      return "OpenTimestamps failed";
    case "DISABLED":
      return "OpenTimestamps disabled";
    default:
      return "OpenTimestamps not reported";
  }
}

function summarizePublicPayload(
  eventType: prismaPkg.CustodyEventType,
  payload: prismaPkg.Prisma.JsonValue | null
): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    if (eventType === prismaPkg.CustodyEventType.VERIFY_VIEWED) {
      return "Public verification page viewed.";
    }
    return null;
  }

  const obj = payload as Record<string, unknown>;

  switch (eventType) {
    case prismaPkg.CustodyEventType.EVIDENCE_CREATED:
      return "Evidence record created.";

    case prismaPkg.CustodyEventType.UPLOAD_STARTED: {
      const uploadKind =
        normalizePublicPayloadValue(obj.uploadKind) ??
        normalizePublicPayloadValue(obj.mode);
      return ["Upload session started", uploadKind ? `Mode: ${uploadKind}` : null]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.UPLOAD_COMPLETED: {
      const itemCount =
        typeof obj.itemCount === "number" && Number.isFinite(obj.itemCount)
          ? obj.itemCount
          : null;
      const sizeBytes = normalizePublicPayloadValue(obj.sizeBytes);
      return [
        getCompletedEvidenceLabel(itemCount),
        itemCount != null ? `Items: ${itemCount}` : null,
        sizeBytes ? `Size: ${sizeBytes} bytes` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.SIGNATURE_APPLIED: {
      const signingKeyId = normalizePublicPayloadValue(obj.signingKeyId);
      const signingKeyVersion = normalizePublicPayloadValue(
        obj.signingKeyVersion
      );
      const tsaStatus = normalizePublicPayloadValue(obj.tsaStatus);
      const tsaProvider = normalizePublicPayloadValue(obj.tsaProvider);
      return [
        "Cryptographic signature applied",
        signingKeyId ? `Key: ${signingKeyId}` : null,
        signingKeyVersion ? `Version: ${signingKeyVersion}` : null,
        tsaStatus ? `Timestamp: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.TIMESTAMP_APPLIED: {
      const tsaStatus = normalizePublicPayloadValue(obj.tsaStatus);
      const tsaProvider = normalizePublicPayloadValue(obj.tsaProvider);
      return [
        "Timestamp applied",
        tsaStatus ? `Status: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.TIMESTAMP_FAILED: {
      const tsaStatus = normalizePublicPayloadValue(obj.tsaStatus);
      const tsaProvider = normalizePublicPayloadValue(obj.tsaProvider);
      return [
        "Timestamp failed",
        tsaStatus ? `Status: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.OTS_APPLIED: {
      const otsStatus = normalizePublicPayloadValue(obj.otsStatus);
      const calendar = normalizePublicPayloadValue(obj.otsCalendar);
      const bitcoinTxid = normalizePublicPayloadValue(obj.otsBitcoinTxid);
      return [
        "OpenTimestamps proof recorded",
        otsStatus ? `Status: ${otsStatus}` : null,
        calendar ? `Calendar: ${calendar}` : null,
        bitcoinTxid ? `Bitcoin Tx: ${shortHash(bitcoinTxid)}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.OTS_FAILED: {
      const otsStatus = normalizePublicPayloadValue(obj.otsStatus);
      const reason = normalizePublicPayloadValue(obj.otsFailureReason);
      const genericReason = normalizePublicPayloadValue(obj.failureReason);
      return [
        "OpenTimestamps failed",
        otsStatus ? `Status: ${otsStatus}` : null,
        reason
          ? `Reason: ${reason}`
          : genericReason
            ? `Reason: ${genericReason}`
            : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.REPORT_GENERATED: {
      const reportVersion = normalizePublicPayloadValue(obj.reportVersion);
      const anchorMode = normalizePublicPayloadValue(obj.anchorMode);
      const anchorHash = normalizePublicPayloadValue(obj.anchorHash);
      return [
        reportVersion
          ? `Verification report generated • Version: ${reportVersion}`
          : "Verification report generated.",
        anchorMode ? `Anchor Mode: ${anchorMode}` : null,
        anchorHash ? `Anchor: ${shortHash(anchorHash)}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.VERIFICATION_PACKAGE_GENERATED: {
      const version = normalizePublicPayloadValue(obj.version);
      const packageType = normalizePublicPayloadValue(obj.packageType);
      return [
        "Verification package generated",
        version ? `Version: ${version}` : null,
        packageType ? `Type: ${packageType}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.VERIFICATION_PACKAGE_DOWNLOADED: {
      const version = normalizePublicPayloadValue(obj.version);
      return version
        ? `Verification package downloaded • Version: ${version}`
        : "Verification package downloaded.";
    }

    case prismaPkg.CustodyEventType.TECHNICAL_VERIFICATION_CHECKED: {
      const source = normalizePublicPayloadValue(obj.source);
      const overallIntegrity = normalizePublicPayloadValue(obj.overallIntegrity);
      return [
        "Technical verification checked",
        source ? `Source: ${source}` : null,
        overallIntegrity ? `Overall integrity: ${overallIntegrity}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.REVIEW_READY: {
      const reviewerSummaryVersion = normalizePublicPayloadValue(
        obj.reviewerSummaryVersion
      );
      return [
        "Evidence marked review ready",
        reviewerSummaryVersion
          ? `Reviewer summary version: ${reviewerSummaryVersion}`
          : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.IDENTITY_SNAPSHOT_RECORDED: {
      const identityLevel = normalizePublicPayloadValue(
        obj.identityLevelSnapshot
      );
      const submittedByEmail = normalizePublicPayloadValue(obj.submittedByEmail);
      const authProvider = normalizePublicPayloadValue(
        obj.submittedByAuthProvider
      );
      return [
        "Identity snapshot recorded",
        identityLevel ? `Identity: ${identityLevel}` : null,
        submittedByEmail ? `Email: ${submittedByEmail}` : null,
        authProvider ? `Provider: ${authProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.ANCHOR_PUBLISHED: {
      const provider = normalizePublicPayloadValue(obj.provider);
      const receiptId = normalizePublicPayloadValue(obj.receiptId);
      const transactionId = normalizePublicPayloadValue(obj.transactionId);
      return [
        "External anchor publication recorded",
        provider ? `Provider: ${provider}` : null,
        receiptId ? `Receipt: ${shortHash(receiptId)}` : null,
        transactionId ? `Tx: ${shortHash(transactionId)}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.ANCHOR_FAILED: {
      const provider = normalizePublicPayloadValue(obj.provider);
      const reason = normalizePublicPayloadValue(obj.reason);
      return [
        "External anchor publication failed",
        provider ? `Provider: ${provider}` : null,
        reason ? `Reason: ${reason}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.REPORT_DOWNLOADED: {
      const reportVersion = normalizePublicPayloadValue(obj.reportVersion);
      return reportVersion
        ? `Report downloaded • Version: ${reportVersion}`
        : "Report downloaded.";
    }

    case prismaPkg.CustodyEventType.VERIFY_VIEWED:
      return "Public verification page viewed.";

    case prismaPkg.CustodyEventType.EVIDENCE_VIEWED:
      return "Protected evidence file accessed.";

    case prismaPkg.CustodyEventType.EVIDENCE_LOCKED:
      return "Evidence record locked.";

    case prismaPkg.CustodyEventType.EVIDENCE_ARCHIVED:
      return "Evidence record archived.";

    case prismaPkg.CustodyEventType.EVIDENCE_RESTORED:
      return "Evidence record restored.";

    case prismaPkg.CustodyEventType.EVIDENCE_DELETED:
      return "Evidence record deleted.";

    case prismaPkg.CustodyEventType.EVIDENCE_CLAIMED:
      return "Guest evidence ownership claimed.";

    default: {
      const safeEntries = Object.entries(obj)
        .filter(([key, value]) => {
          const lowered = key.toLowerCase();
          if (
            lowered.includes("bucket") ||
            lowered.includes("storagekey") ||
            lowered === "key" ||
            lowered.includes("token") ||
            lowered.includes("secret") ||
            lowered.includes("password") ||
            lowered.includes("lat") ||
            lowered.includes("lng") ||
            lowered.includes("accuracy") ||
            lowered.includes("ip") ||
            lowered.includes("useragent")
          ) {
            return false;
          }

          return (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          );
        })
        .slice(0, 5)
        .map(([key, value]) => `${key}: ${String(value)}`);

      return safeEntries.length > 0 ? safeEntries.join(" • ") : null;
    }
  }
}

function toSafeEvidence(e: SelectedEvidence): SafeEvidence {
  return {
    id: e.id,
    title: resolveEvidenceTitle(e.title),
    organizationId: e.organizationId ?? null,
    type: e.type,
    status: e.status,
    verificationStatus: e.verificationStatus ?? null,
    captureMethod: e.captureMethod ?? null,
    identityLevelSnapshot: e.identityLevelSnapshot ?? null,
    submittedByEmail: e.submittedByEmail ?? null,
    submittedByAuthProvider: e.submittedByAuthProvider ?? null,
    submittedByUserId: e.submittedByUserId ?? null,
    createdByUserId: e.createdByUserId ?? null,
    uploadedByUserId: e.uploadedByUserId ?? null,
    lastAccessedByUserId: e.lastAccessedByUserId ?? null,
    lastAccessedAtUtc: e.lastAccessedAtUtc
      ? e.lastAccessedAtUtc.toISOString()
      : null,
    workspaceNameSnapshot: e.workspaceNameSnapshot ?? null,
    organizationNameSnapshot: e.organizationNameSnapshot ?? null,
    organizationVerifiedSnapshot: e.organizationVerifiedSnapshot ?? null,
    recordedIntegrityVerifiedAtUtc: e.recordedIntegrityVerifiedAtUtc
      ? e.recordedIntegrityVerifiedAtUtc.toISOString()
      : null,
    lastVerifiedAtUtc: e.lastVerifiedAtUtc
      ? e.lastVerifiedAtUtc.toISOString()
      : null,
    lastVerifiedSource: e.lastVerifiedSource ?? null,
    verificationPackageGeneratedAtUtc: e.verificationPackageGeneratedAtUtc
      ? e.verificationPackageGeneratedAtUtc.toISOString()
      : null,
    verificationPackageVersion: e.verificationPackageVersion ?? null,
    latestReportVersion: e.latestReportVersion ?? null,
    reviewReadyAtUtc: e.reviewReadyAtUtc
      ? e.reviewReadyAtUtc.toISOString()
      : null,
    reviewerSummaryVersion: e.reviewerSummaryVersion ?? null,
    createdAt: e.createdAt.toISOString(),
    uploadedAtUtc: e.uploadedAtUtc ? e.uploadedAtUtc.toISOString() : null,
    signedAtUtc: e.signedAtUtc ? e.signedAtUtc.toISOString() : null,
    capturedAtUtc: e.capturedAtUtc ? e.capturedAtUtc.toISOString() : null,
    reportGeneratedAtUtc: e.reportGeneratedAtUtc
      ? e.reportGeneratedAtUtc.toISOString()
      : null,
    deviceTimeIso: e.deviceTimeIso ?? null,
    lat: decimalToNumber(e.lat),
    lng: decimalToNumber(e.lng),
    accuracyMeters: decimalToNumber(e.accuracyMeters),
    mimeType: e.mimeType ?? null,
    storageBucket: e.storageBucket ?? null,
    storageKey: e.storageKey ?? null,
    storageRegion: e.storageRegion ?? null,
    storageObjectLockMode: e.storageObjectLockMode ?? null,
    storageObjectLockRetainUntilUtc: e.storageObjectLockRetainUntilUtc
      ? e.storageObjectLockRetainUntilUtc.toISOString()
      : null,
    storageObjectLockLegalHoldStatus:
      e.storageObjectLockLegalHoldStatus ?? null,
    sizeBytes: bigintToString(e.sizeBytes),
    fileSha256: e.fileSha256 ?? null,
    fingerprintHash: e.fingerprintHash ?? null,
    signatureBase64: e.signatureBase64 ?? null,
    signingKeyId: e.signingKeyId ?? null,
    signingKeyVersion: e.signingKeyVersion ?? null,
    deletedByUserId: e.deletedByUserId ?? null,
    lockedAt: e.lockedAt ? e.lockedAt.toISOString() : null,
    lockedByUserId: e.lockedByUserId ?? null,
    archivedAt: e.archivedAt ? e.archivedAt.toISOString() : null,
    caseId: e.caseId ?? null,
    teamId: e.teamId ?? null,
    deletedAt: e.deletedAt ? e.deletedAt.toISOString() : null,
    deletedAtUtc: e.deletedAtUtc ? e.deletedAtUtc.toISOString() : null,
    deleteScheduledForUtc: e.deleteScheduledForUtc
      ? e.deleteScheduledForUtc.toISOString()
      : null,
  };
}

async function getEvidenceItemCount(evidenceId: string): Promise<number> {
  const count = await prisma.evidencePart.count({
    where: { evidenceId },
  });
  return count > 0 ? count : 1;
}

async function getStorageProtectionSummary(
  bucket: string | null | undefined,
  key: string | null | undefined,
  snapshot?: {
    storageRegion?: string | null;
    storageObjectLockMode?: string | null;
    storageObjectLockRetainUntilUtc?: Date | string | null;
    storageObjectLockLegalHoldStatus?: string | null;
  }
): Promise<StorageProtectionSummary> {
  const snapshotMode =
    typeof snapshot?.storageObjectLockMode === "string"
      ? snapshot.storageObjectLockMode
      : null;

  const snapshotRetainUntil =
    snapshot?.storageObjectLockRetainUntilUtc instanceof Date
      ? snapshot.storageObjectLockRetainUntilUtc.toISOString()
      : typeof snapshot?.storageObjectLockRetainUntilUtc === "string"
        ? snapshot.storageObjectLockRetainUntilUtc
        : null;

  const snapshotLegalHold =
    typeof snapshot?.storageObjectLockLegalHoldStatus === "string"
      ? snapshot.storageObjectLockLegalHoldStatus
      : null;

  const snapshotRegion =
    typeof snapshot?.storageRegion === "string" && snapshot.storageRegion.trim()
      ? snapshot.storageRegion.trim()
      : process.env.S3_REGION?.trim() || null;

  if (snapshotMode || snapshotRetainUntil || snapshotLegalHold) {
    return {
      immutable: snapshotMode === "COMPLIANCE" && Boolean(snapshotRetainUntil),
      mode: snapshotMode,
      retainUntil: snapshotRetainUntil,
      legalHold: snapshotLegalHold,
      region: snapshotRegion,
      verified: true,
    };
  }

  if (!bucket || !key) return null;

  try {
    const meta = await headObject({ bucket, key });
    const mode = meta.objectLockMode ? String(meta.objectLockMode) : null;
    const retainUntil =
      meta.objectLockRetainUntilDate instanceof Date
        ? meta.objectLockRetainUntilDate.toISOString()
        : null;
    const legalHold = meta.objectLockLegalHoldStatus
      ? String(meta.objectLockLegalHoldStatus)
      : null;
    const immutable = mode === "COMPLIANCE" && Boolean(retainUntil);

    return {
      immutable,
      mode,
      retainUntil,
      legalHold,
      region: process.env.S3_REGION?.trim() || null,
      verified: Boolean(mode || retainUntil || legalHold),
    };
  } catch {
    return {
      immutable: false,
      mode: null,
      retainUntil: null,
      legalHold: null,
      region: process.env.S3_REGION?.trim() || null,
      verified: false,
    };
  }
}

async function getAnchorStatus(
  evidenceId: string
): Promise<AnchorStatusSummary> {
  const mode = normalizeAnchorMode(process.env.ANCHOR_MODE);
  const provider = process.env.ANCHOR_PROVIDER?.trim() || null;
  const publicBaseUrl = process.env.ANCHOR_PUBLIC_BASE_URL?.trim() || null;

  const anchor = await prisma.evidenceAnchor.findUnique({
    where: { evidenceId },
    select: {
      mode: true,
      provider: true,
      anchorHash: true,
      receiptId: true,
      transactionId: true,
      publicUrl: true,
      anchoredAtUtc: true,
    },
  });

  if (!anchor) {
    return {
      mode,
      provider,
      publicBaseUrl,
      configured: Boolean(provider),
      published: false,
      anchorHash: null,
      receiptId: null,
      transactionId: null,
      publicUrl: null,
      anchoredAtUtc: null,
    };
  }

  return {
    mode: normalizeAnchorMode(anchor.mode),
    provider: anchor.provider ?? provider,
    publicBaseUrl,
    configured: Boolean(anchor.provider ?? provider),
    published: true,
    anchorHash: anchor.anchorHash ?? null,
    receiptId: anchor.receiptId ?? null,
    transactionId: anchor.transactionId ?? null,
    publicUrl: anchor.publicUrl ?? null,
    anchoredAtUtc: anchor.anchoredAtUtc
      ? anchor.anchoredAtUtc.toISOString()
      : null,
  };
}

async function assertCaseAccess(userId: string, caseId: string) {
  const item = await prisma.case.findUnique({
    where: { id: caseId },
    include: { access: true },
  });

  if (!item) {
    const err: Error & { statusCode?: number } = new Error("Case not found");
    err.statusCode = 404;
    throw err;
  }

  if (item.ownerUserId === userId) return;
  if (item.access.some((a) => a.userId === userId)) return;

  if (item.teamId && item.access.length === 0) {
    const member = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: item.teamId, userId } },
    });
    if (member) return;
  }

  const err: Error & { statusCode?: number } = new Error("Forbidden");
  err.statusCode = 403;
  throw err;
}

async function getEvidenceWithReadAccess(
  userId: string,
  evidenceId: string
): Promise<SelectedEvidence> {
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: SAFE_EVIDENCE_SELECT,
  });

  if (!evidence) {
    const err: Error & { statusCode?: number } = new Error("Evidence not found");
    err.statusCode = 404;
    throw err;
  }

  if (evidence.ownerUserId === userId) {
    return evidence;
  }

  if (evidence.caseId) {
    const caseItem = await prisma.case.findUnique({
      where: { id: evidence.caseId },
      include: { access: true },
    });

    if (caseItem) {
      if (caseItem.ownerUserId === userId) {
        return evidence;
      }

      if (caseItem.access.some((a) => a.userId === userId)) {
        return evidence;
      }

      if (caseItem.teamId && caseItem.access.length === 0) {
        const member = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: caseItem.teamId,
              userId,
            },
          },
        });

        if (member) {
          return evidence;
        }
      }
    }
  }

  if (evidence.teamId) {
    const member = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: evidence.teamId,
          userId,
        },
      },
    });

    if (member) {
      return evidence;
    }
  }

  const err: Error & { statusCode?: number } = new Error("Forbidden");
  err.statusCode = 403;
  throw err;
}

async function getEvidenceWithOwnerAccess(
  userId: string,
  evidenceId: string
): Promise<SelectedEvidence> {
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: SAFE_EVIDENCE_SELECT,
  });

  if (!evidence) {
    const err: Error & { statusCode?: number } = new Error("Evidence not found");
    err.statusCode = 404;
    throw err;
  }

  if (evidence.ownerUserId !== userId) {
    const err: Error & { statusCode?: number } = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }

  return evidence;
}

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

const EvidenceListScopeSchema = z.enum([
  "active",
  "archived",
  "deleted",
  "locked",
  "all",
]);

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}

function buildPublicVerifyOverview(params: {
  evidence: {
    id: string;
    title: string | null;
    type?: prismaPkg.EvidenceType | null;
    status: prismaPkg.EvidenceStatus;
    verificationStatus: prismaPkg.VerificationStatus | null;
    captureMethod: prismaPkg.CaptureMethod | null;
    identityLevelSnapshot: prismaPkg.IdentityLevel | null;
    submittedByEmail: string | null;
    submittedByAuthProvider: prismaPkg.AuthProvider | null;
    workspaceNameSnapshot: string | null;
    organizationNameSnapshot: string | null;
    organizationVerifiedSnapshot: boolean | null;
    mimeType: string | null;
    createdAt: Date;
    capturedAtUtc: Date | null;
    uploadedAtUtc: Date | null;
    signedAtUtc: Date | null;
    recordedIntegrityVerifiedAtUtc: Date | null;
    lastVerifiedAtUtc: Date | null;
    lastVerifiedSource: prismaPkg.VerificationSource | null;
    reviewReadyAtUtc: Date | null;
    verificationPackageGeneratedAtUtc: Date | null;
    verificationPackageVersion: number | null;
    latestReportVersion: number | null;
    reviewerSummaryVersion: number | null;
    reportGeneratedAtUtc: Date | null;
  };
  latestReport: { version: number; generatedAtUtc: Date } | null;
  itemCount: number;
  storageProtection: StorageProtectionSummary;
  timestampStatus: string | null;
  otsStatus: string | null;
  overallIntegrity: boolean;
  chainOfCustodyPresent: boolean;
  anchor: AnchorStatusSummary;
}) {
  const reportGeneratedAtUtc = params.latestReport?.generatedAtUtc
    ? params.latestReport.generatedAtUtc.toISOString()
    : params.evidence.reportGeneratedAtUtc
      ? params.evidence.reportGeneratedAtUtc.toISOString()
      : null;

  const reportVersion =
    params.latestReport?.version ?? params.evidence.latestReportVersion ?? null;

  return {
    recordStatus: mapRecordStatusLabel(params.evidence.status),
    recordLifecycleStatus: params.evidence.status,
    verificationStatus: mapVerificationStatusLabel(
      params.evidence.verificationStatus
    ),
    verificationStatusCode: params.evidence.verificationStatus,
    integrityHeadline: mapIntegrityHeadline(params.overallIntegrity),
    evidenceTitle: resolveEvidenceTitle(params.evidence.title),
    evidenceId: params.evidence.id,
    evidenceType: mapEvidenceTypeLabel(params.evidence.type),
    evidenceStructure:
      params.itemCount > 1 ? "Multipart evidence package" : "Single evidence item",
    itemCount: params.itemCount,
    captureMethod: mapCaptureMethodLabel(params.evidence.captureMethod),
    captureMethodCode: params.evidence.captureMethod,
    mimeType: params.evidence.mimeType ?? null,
    submittedByEmail: params.evidence.submittedByEmail ?? null,
    submittedByAuthProvider: mapAuthProviderLabel(
      params.evidence.submittedByAuthProvider
    ),
    submittedByAuthProviderCode: params.evidence.submittedByAuthProvider ?? null,
    identityLevel: mapIdentityLevelLabel(params.evidence.identityLevelSnapshot),
    identityLevelCode: params.evidence.identityLevelSnapshot ?? null,
    workspaceName: params.evidence.workspaceNameSnapshot ?? null,
    organizationName: params.evidence.organizationNameSnapshot ?? null,
    organizationVerified: params.evidence.organizationVerifiedSnapshot ?? null,
    createdAt: params.evidence.createdAt.toISOString(),
    capturedAtUtc: params.evidence.capturedAtUtc
      ? params.evidence.capturedAtUtc.toISOString()
      : null,
    uploadedAtUtc: params.evidence.uploadedAtUtc
      ? params.evidence.uploadedAtUtc.toISOString()
      : null,
    signedAtUtc: params.evidence.signedAtUtc
      ? params.evidence.signedAtUtc.toISOString()
      : null,
    recordedIntegrityVerifiedAtUtc:
      params.evidence.recordedIntegrityVerifiedAtUtc
        ? params.evidence.recordedIntegrityVerifiedAtUtc.toISOString()
        : null,
    lastVerifiedAtUtc: params.evidence.lastVerifiedAtUtc
      ? params.evidence.lastVerifiedAtUtc.toISOString()
      : null,
    lastVerifiedSource: mapVerificationSourceLabel(
      params.evidence.lastVerifiedSource
    ),
    lastVerifiedSourceCode: params.evidence.lastVerifiedSource ?? null,
    reviewReadyAtUtc: params.evidence.reviewReadyAtUtc
      ? params.evidence.reviewReadyAtUtc.toISOString()
      : null,
    verificationPackageGeneratedAtUtc:
      params.evidence.verificationPackageGeneratedAtUtc
        ? params.evidence.verificationPackageGeneratedAtUtc.toISOString()
        : null,
    verificationPackageVersion:
      params.evidence.verificationPackageVersion ?? null,
    reviewerSummaryVersion: params.evidence.reviewerSummaryVersion ?? null,
    reportVersion,
    reportGeneratedAtUtc,
    timestampStatus: mapTimestampStatusLabel(params.timestampStatus),
    otsStatus: mapOtsStatusLabel(params.otsStatus),
    storageProtection: mapStorageStatusLabel(params.storageProtection),
    chainOfCustodyPresent: params.chainOfCustodyPresent,
    externalPublicationPresent: params.anchor.published,
    externalPublicationProvider: params.anchor.provider,
    externalPublicationUrl: params.anchor.publicUrl,
    externalPublicationAnchoredAtUtc: params.anchor.anchoredAtUtc,
  };
}

function buildPublicVerifyHumanSummary(params: {
  overview: ReturnType<typeof buildPublicVerifyOverview>;
  canonicalHashMatches: boolean;
  signatureValid: boolean;
  custodyChainValid: boolean;
  timestampDigestMatches: boolean;
  otsHashMatches: boolean;
  overallIntegrity: boolean;
}) {
  return {
    integrityStatus: params.overview.integrityHeadline,
    recordStatus: params.overview.recordStatus,
    verificationStatus: params.overview.verificationStatus,
    summary: mapIntegritySummaryText({
      overallIntegrity: params.overallIntegrity,
      canonicalHashMatches: params.canonicalHashMatches,
      signatureValid: params.signatureValid,
      custodyChainValid: params.custodyChainValid,
      timestampDigestMatches: params.timestampDigestMatches,
      otsHashMatches: params.otsHashMatches,
    }),
    whatIsVerified:
      "This verification checks the recorded integrity state of the evidence record, including fingerprint consistency, signature validation, recorded custody chain continuity, timestamp linkage, and OpenTimestamps linkage where available.",
    evidenceTitle: params.overview.evidenceTitle,
    evidenceId: params.overview.evidenceId,
    evidenceType: params.overview.evidenceType,
    evidenceStructure: params.overview.evidenceStructure,
    captureMethod: params.overview.captureMethod,
    fileType: params.overview.mimeType,
    submittedBy: params.overview.submittedByEmail,
    authProvider: params.overview.submittedByAuthProvider,
    identityLevel: params.overview.identityLevel,
    organization: params.overview.organizationName,
    workspace: params.overview.workspaceName,
    organizationVerified: params.overview.organizationVerified,
    createdAt: params.overview.createdAt,
    capturedAtUtc: params.overview.capturedAtUtc,
    uploadedAtUtc: params.overview.uploadedAtUtc,
    signedAtUtc: params.overview.signedAtUtc,
    recordedIntegrityVerifiedAtUtc:
      params.overview.recordedIntegrityVerifiedAtUtc,
    lastVerifiedAtUtc: params.overview.lastVerifiedAtUtc,
    lastVerifiedSource: params.overview.lastVerifiedSource,
    chainOfCustodyPresent: params.overview.chainOfCustodyPresent,
    reportVersion: params.overview.reportVersion,
    reportGeneratedAtUtc: params.overview.reportGeneratedAtUtc,
    verificationPackageVersion: params.overview.verificationPackageVersion,
    verificationPackageGeneratedAtUtc:
      params.overview.verificationPackageGeneratedAtUtc,
    reviewerSummaryVersion: params.overview.reviewerSummaryVersion,
    timestampStatus: params.overview.timestampStatus,
    otsStatus: params.overview.otsStatus,
    storageProtection: params.overview.storageProtection,
    externalPublicationPresent: params.overview.externalPublicationPresent,
    externalPublicationProvider: params.overview.externalPublicationProvider,
    externalPublicationUrl: params.overview.externalPublicationUrl,
    externalPublicationAnchoredAtUtc:
      params.overview.externalPublicationAnchoredAtUtc,
  };
}

function buildPublicVerifyLimitations() {
  return {
    short:
      "This page verifies the recorded integrity state of the evidence record. It does not independently prove factual truth, authorship, context, or legal admissibility.",
    detailed:
      "Technical verification supports detection of post-completion changes to the recorded evidence state. It does not by itself establish who created the content, whether the depicted events are true, or whether any court, insurer, regulator, or authority must accept the material.",
  };
}

function mapPublicCustodyEvent(ev: {
  sequence: number;
  atUtc: Date;
  eventType: prismaPkg.CustodyEventType;
  payload: prismaPkg.Prisma.JsonValue | null;
  prevEventHash: string | null;
  eventHash: string | null;
}): PublicVerifyTimelineEvent {
  return {
    sequence: ev.sequence,
    atUtc: ev.atUtc.toISOString(),
    eventType: ev.eventType,
    payloadSummary: summarizePublicPayload(ev.eventType, ev.payload),
    prevEventHash: shortHash(ev.prevEventHash, 10, 8),
    eventHash: shortHash(ev.eventHash, 10, 8),
    category: isAccessCustodyEventType(ev.eventType) ? "access" : "forensic",
  };
}

async function buildStorageLimitPayload(params: {
  ownerUserId: string;
  evidenceId?: string | null;
  teamId?: string | null;
  req?: FastifyRequest;
  reason?: string | null;
  incomingBytes?: string | null;
}) {
  const overview = await readBillingOverview(params.ownerUserId);

  const workspace =
    params.teamId != null
      ? overview.workspaces.teams.find((team) => team.id === params.teamId) ?? null
      : overview.workspaces.personal;

  const upgradeSuggestion =
    workspace && workspace.workspaceType === "PERSONAL"
      ? workspace.plan === prismaPkg.PlanType.PAYG
        ? "Upgrading to PRO may be more cost-effective if you need recurring storage."
        : workspace.plan === prismaPkg.PlanType.PRO
          ? "If you need much larger storage, upgrading to TEAM may be more cost-effective."
          : "Upgrade your base plan to unlock more storage options."
      : workspace && workspace.workspaceType === "TEAM"
        ? "If your team keeps growing, a larger recurring storage add-on may be more cost-effective."
        : null;

  return {
    code: "STORAGE_LIMIT_REACHED",
    message: "Storage limit reached",
    billingWall: {
      type: "storage_limit_reached",
      reason: params.reason ?? "workspace_storage_exhausted",
      evidenceId: params.evidenceId ?? null,
      workspace,
      summary: overview.summary,
      storageAddons: overview.storageAddons,
      suggestedActions: [
        "add_storage",
        "upgrade_plan",
        "review_archived_evidence",
      ],
      upgradeSuggestion,
      incomingBytes: params.incomingBytes ?? null,
    },
  };
}

export async function evidenceRoutes(app: FastifyInstance) {
  app.post("/v1/evidence", { preHandler: requireAuthAndLegal }, async (req, reply) => {
    const body = CreateEvidenceBody.parse(req.body);
    const ownerUserId = getAuthUserId(req);
    const plan = await getUserPlan(ownerUserId);
    const limit = getTierLimit(plan);
    const rate = await enforceRateLimit({
      key: `ratelimit:evidence:create:${plan}:${ownerUserId}`,
      max: limit.max,
      windowSec: limit.windowSec,
    });

    if (!rate.allowed) {
      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.create",
        outcome: "blocked",
        severity: "warning",
        metadata: { reason: "rate_limit_exceeded", plan },
      });
      return reply.code(429).send({ message: "Rate limit exceeded" });
    }

    const normalizedChecksum = normalizeChecksumSha256Base64(
      body.checksumSha256Base64
    );
    const normalizedContentMd5 = normalizeContentMd5Base64(
      body.contentMd5Base64
    );

    if (body.checksumSha256Base64 && !normalizedChecksum) {
      return reply.code(400).send({ message: "Invalid checksumSha256Base64" });
    }

    if (body.contentMd5Base64 && !normalizedContentMd5) {
      return reply.code(400).send({ message: "Invalid contentMd5Base64" });
    }

    try {
      const result = await createEvidence({
        ownerUserId,
        type: body.type,
        mimeType: body.mimeType,
        deviceTimeIso: body.deviceTimeIso,
        gps: body.gps,
        checksumSha256Base64: normalizedChecksum,
        contentMd5Base64: normalizedContentMd5,
      });

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = result.id;
      req.log = req.log.child({ evidenceId: result.id });

      fireEvidenceAnalyticsEvent({
        eventType: "evidence_created",
        userId: ownerUserId,
        req,
        entityType: "evidence",
        entityId: result.id,
        severity: "info",
        metadata: {
          type: body.type,
          mimeType: body.mimeType ?? null,
          hasGps: Boolean(body.gps),
        },
      });

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.create",
        outcome: "success",
        resourceId: result.id,
        metadata: {
          type: body.type,
          mimeType: body.mimeType ?? null,
          hasGps: Boolean(body.gps),
        },
      });

      return reply.code(201).send(result);
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as Error & { code?: string }).code === "STORAGE_LIMIT_REACHED"
      ) {
        const payload = await buildStorageLimitPayload({
          ownerUserId,
          req,
          reason: "create_evidence_blocked",
        });

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.create",
          outcome: "blocked",
          severity: "warning",
          metadata: {
            reason: "STORAGE_LIMIT_REACHED",
          },
        });

        return reply.code(409).send(payload);
      }

if (
  err instanceof Error &&
  "code" in err &&
  (err as Error & { code?: string }).code === "INSUFFICIENT_CREDITS"
) {
  auditEvidenceAction(req, {
    userId: ownerUserId,
    action: "evidence.create",
    outcome: "blocked",
    severity: "warning",
    metadata: { reason: "INSUFFICIENT_CREDITS" },
  });
  return reply.code(402).send({
    code: "INSUFFICIENT_CREDITS",
    message: "Insufficient credits",
  });
}

      if (err instanceof Error && err.message === "FREE_LIMIT_REACHED") {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.create",
          outcome: "blocked",
          severity: "warning",
          metadata: { reason: "FREE_LIMIT_REACHED" },
        });
        return reply.code(402).send({ message: "Free plan limit reached" });
      }

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.create",
        outcome: "failure",
        severity: "critical",
        metadata: {
          reason: err instanceof Error ? err.message : "unknown_error",
        },
      });

      throw err;
    }
  });

  app.patch(
    "/v1/evidence/:id/label",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = UpdateEvidenceLabelBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (evidence.deletedAt) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.update_label",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "deleted_evidence" },
        });
        return reply.code(409).send({ message: "Evidence is deleted" });
      }

      const updated = await prisma.evidence.update({
        where: { id },
        data: { title: body.label },
        select: SAFE_EVIDENCE_SELECT,
      });

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.update_label",
        outcome: "success",
        resourceId: id,
        metadata: { label: body.label },
      });

      const itemCount = await getEvidenceItemCount(id);
      const storage = await getStorageProtectionSummary(
        updated.storageBucket,
        updated.storageKey,
        {
          storageRegion: updated.storageRegion,
          storageObjectLockMode: updated.storageObjectLockMode,
          storageObjectLockRetainUntilUtc:
            updated.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus:
            updated.storageObjectLockLegalHoldStatus,
        }
      );

      return reply.code(200).send({
        evidence: {
          ...toSafeEvidence(updated),
          storage,
        },
        itemCount,
        displayLabel: resolveEvidenceTitle(updated.title),
        displaySubtitle: buildEvidenceSubtitle({
          itemCount,
          status: updated.status,
          createdAt: updated.createdAt,
        }),
      });
    }
  );

  app.post(
    "/v1/evidence/:id/parts",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = CreatePartBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      const normalizedChecksum = normalizeChecksumSha256Base64(
        body.checksumSha256Base64
      );
      const normalizedContentMd5 = normalizeContentMd5Base64(
        body.contentMd5Base64
      );

      if (body.checksumSha256Base64 && !normalizedChecksum) {
        return reply.code(400).send({ message: "Invalid checksumSha256Base64" });
      }

      if (body.contentMd5Base64 && !normalizedContentMd5) {
        return reply.code(400).send({ message: "Invalid contentMd5Base64" });
      }

      try {
        await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtext(${id}))
          `;

          const evidence = await tx.evidence.findUnique({
            where: { id },
            select: SAFE_EVIDENCE_SELECT,
          });

          if (!evidence || evidence.deletedAt) {
            const err: Error & { statusCode?: number } = new Error(
              "Evidence not found"
            );
            err.statusCode = 404;
            throw err;
          }

          if (evidence.ownerUserId !== ownerUserId) {
            const err: Error & { statusCode?: number } = new Error("Forbidden");
            err.statusCode = 403;
            throw err;
          }

          if (
            evidence.status === EvidenceStatus.SIGNED ||
            evidence.status === EvidenceStatus.REPORTED ||
            evidence.lockedAt
          ) {
            const err: Error & { statusCode?: number } = new Error(
              "Evidence is immutable"
            );
            err.statusCode = 409;
            throw err;
          }

          const existing = await tx.evidencePart.findFirst({
            where: { evidenceId: id, partIndex: body.partIndex },
          });

          if (existing) {
            return { part: existing, created: false as const };
          }

          const bucket = must("S3_BUCKET");
          const key = `evidence/${id}/parts/${body.partIndex}`;
          const normalizedMimeType =
            normalizeMimeType(body.mimeType) ?? "application/octet-stream";

          const part = await tx.evidencePart.create({
            data: {
              evidenceId: id,
              partIndex: body.partIndex,
              storageBucket: bucket,
              storageKey: key,
              originalFileName: body.originalFileName?.trim() || null,
              mimeType: normalizedMimeType,
              durationMs: body.durationMs ?? null,
              uploadedByUserId: ownerUserId,
              uploadedAtUtc: new Date(),
            },
          });

          return { part, created: true as const };
        });

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.part_presign_created",
          outcome: "success",
          resourceId: id,
          metadata: {
            partIndex: body.partIndex,
            created: result.created,
          },
        });

        const putUrl = await presignPutObject({
          bucket: result.part.storageBucket,
          key: result.part.storageKey,
          contentType: result.part.mimeType ?? "application/octet-stream",
          checksumSha256Base64: normalizedChecksum,
          contentMd5Base64: normalizedContentMd5,
          expiresInSeconds: 600,
        });

        if (!result.created) {
          return reply.code(200).send({
            part: result.part,
            upload: {
              bucket: result.part.storageBucket,
              key: result.part.storageKey,
              putUrl,
              checksumRequired: Boolean(normalizedChecksum),
              contentMd5Required: Boolean(normalizedContentMd5),
              expiresInSeconds: 600,
            },
          });
        }

        return reply.code(201).send({
          part: result.part,
          upload: {
            bucket: result.part.storageBucket,
            key: result.part.storageKey,
            putUrl,
            checksumRequired: Boolean(normalizedChecksum),
            contentMd5Required: Boolean(normalizedContentMd5),
            expiresInSeconds: 600,
          },
        });
      } catch (err) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.part_presign_created",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: {
            reason: err instanceof Error ? err.message : "unknown_error",
            partIndex: body.partIndex,
          },
        });

        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
    }
  );

  app.get(
    "/v1/evidence/:id/parts",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      const parts = await prisma.evidencePart.findMany({
        where: { evidenceId: id },
        orderBy: { partIndex: "asc" },
      });

      const enrichedParts = await Promise.all(
        parts.map(async (part) => {
          const url = await presignGetObject({
            bucket: part.storageBucket,
            key: part.storageKey,
            expiresInSeconds: 600,
          });

          const storage = await getStorageProtectionSummary(
            part.storageBucket,
            part.storageKey,
            {
              storageRegion: part.storageRegion ?? null,
              storageObjectLockMode: part.storageObjectLockMode ?? null,
              storageObjectLockRetainUntilUtc:
                part.storageObjectLockRetainUntilUtc ?? null,
              storageObjectLockLegalHoldStatus:
                part.storageObjectLockLegalHoldStatus ?? null,
            }
          );

          return {
            ...toJsonSafe(part),
            url,
            isPrimary:
              evidence.storageBucket === part.storageBucket &&
              evidence.storageKey === part.storageKey,
            storage,
          };
        })
      );

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.parts_listed",
        outcome: "success",
        resourceId: id,
        metadata: { partCount: parts.length },
      });

      return reply.code(200).send({
        evidenceId: id,
        multipart: enrichedParts.length > 1,
        primary:
          evidence.storageBucket && evidence.storageKey
            ? {
                bucket: evidence.storageBucket,
                key: evidence.storageKey,
              }
            : null,
        parts: enrichedParts,
      });
    }
  );

  app.post(
    "/v1/evidence/claim",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = ClaimBody.parse(req.body);

      if (!body.guestToken) {
        return reply.code(400).send({ message: "guest_token_required" });
      }

      const secret = process.env.AUTH_JWT_SECRET;
      if (!secret) {
        return reply.code(500).send({ message: "AUTH_JWT_SECRET is not set" });
      }

      const payload = verifyJwt(body.guestToken, secret);
      if (payload.provider !== "GUEST") {
        return reply.code(400).send({ message: "invalid_guest_token" });
      }

      const guestUserId = payload.sub;
      const userId = getAuthUserId(req);

      const where = {
        ownerUserId: guestUserId,
        deletedAt: null,
        status: {
          notIn: [
            EvidenceStatus.SIGNED,
            EvidenceStatus.REPORTED,
          ] as prismaPkg.EvidenceStatus[],
        },
        ...(body.evidenceIds?.length ? { id: { in: body.evidenceIds } } : {}),
      };

      const evidence = await prisma.evidence.findMany({
        where,
        select: { id: true },
      });

      if (evidence.length === 0) {
        return reply.code(200).send({ claimed: 0 });
      }

      await prisma.evidence.updateMany({
        where,
        data: { ownerUserId: userId },
      });

      await prisma.guestIdentity.updateMany({
        where: { userId: guestUserId },
        data: { claimedByUserId: userId, claimedAt: new Date() },
      });

      for (const item of evidence) {
        await appendCustodyEvent({
          evidenceId: item.id,
          eventType: prismaPkg.CustodyEventType.EVIDENCE_CLAIMED,
          payload: { fromUserId: guestUserId, toUserId: userId },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        }).catch(() => null);

        auditEvidenceAction(req, {
          userId,
          action: "evidence.claimed",
          outcome: "success",
          resourceId: item.id,
          metadata: {
            fromUserId: guestUserId,
            toUserId: userId,
          },
        });
      }

      return reply.code(200).send({ claimed: evidence.length });
    }
  );

  app.post(
    "/v1/evidence/:id/lock",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = LockBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (
        evidence.status !== prismaPkg.EvidenceStatus.SIGNED &&
        evidence.status !== prismaPkg.EvidenceStatus.REPORTED
      ) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.lock",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_signed_yet" },
        });
        return reply
          .code(400)
          .send({ message: "Evidence must be signed before lock" });
      }

      if (body.locked) {
        const updated = await prisma.evidence.update({
          where: { id },
          data: { lockedAt: new Date(), lockedByUserId: ownerUserId },
          select: SAFE_EVIDENCE_SELECT,
        });

        await appendCustodyEvent({
          evidenceId: id,
          eventType: prismaPkg.CustodyEventType.EVIDENCE_LOCKED,
          payload: { lockedByUserId: ownerUserId },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        }).catch(() => null);

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.lock",
          outcome: "success",
          resourceId: id,
          metadata: { lockedByUserId: ownerUserId },
        });

        const storage = await getStorageProtectionSummary(
          updated.storageBucket,
          updated.storageKey,
          {
            storageRegion: updated.storageRegion,
            storageObjectLockMode: updated.storageObjectLockMode,
            storageObjectLockRetainUntilUtc:
              updated.storageObjectLockRetainUntilUtc,
            storageObjectLockLegalHoldStatus:
              updated.storageObjectLockLegalHoldStatus,
          }
        );

        return reply.code(200).send({
          evidence: {
            ...toSafeEvidence(updated),
            storage,
          },
        });
      }

      return reply.code(400).send({ message: "Unlock is not allowed" });
    }
  );

  app.post(
    "/v1/evidence/:id/archive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (evidence.archivedAt) {
        const storage = await getStorageProtectionSummary(
          evidence.storageBucket,
          evidence.storageKey,
          {
            storageRegion: evidence.storageRegion,
            storageObjectLockMode: evidence.storageObjectLockMode,
            storageObjectLockRetainUntilUtc:
              evidence.storageObjectLockRetainUntilUtc,
            storageObjectLockLegalHoldStatus:
              evidence.storageObjectLockLegalHoldStatus,
          }
        );
        return reply.code(200).send({
          evidence: {
            ...toSafeEvidence(evidence),
            storage,
          },
        });
      }

      const updated = await prisma.evidence.update({
        where: { id },
        data: { archivedAt: new Date() },
        select: SAFE_EVIDENCE_SELECT,
      });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_ARCHIVED,
        payload: { archivedByUserId: ownerUserId },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.archive",
        outcome: "success",
        resourceId: id,
        metadata: { archivedByUserId: ownerUserId },
      });

      const storage = await getStorageProtectionSummary(
        updated.storageBucket,
        updated.storageKey,
        {
          storageRegion: updated.storageRegion,
          storageObjectLockMode: updated.storageObjectLockMode,
          storageObjectLockRetainUntilUtc:
            updated.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus:
            updated.storageObjectLockLegalHoldStatus,
        }
      );

      return reply.code(200).send({
        evidence: {
          ...toSafeEvidence(updated),
          storage,
        },
      });
    }
  );

  app.post(
    "/v1/evidence/:id/unarchive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (!evidence.archivedAt) {
        const storage = await getStorageProtectionSummary(
          evidence.storageBucket,
          evidence.storageKey,
          {
            storageRegion: evidence.storageRegion,
            storageObjectLockMode: evidence.storageObjectLockMode,
            storageObjectLockRetainUntilUtc:
              evidence.storageObjectLockRetainUntilUtc,
            storageObjectLockLegalHoldStatus:
              evidence.storageObjectLockLegalHoldStatus,
          }
        );
        return reply.code(200).send({
          evidence: {
            ...toSafeEvidence(evidence),
            storage,
          },
        });
      }

      const updated = await prisma.evidence.update({
        where: { id },
        data: { archivedAt: null },
        select: SAFE_EVIDENCE_SELECT,
      });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_RESTORED,
        payload: { restoredByUserId: ownerUserId, restoreSource: "archive" },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.unarchive",
        outcome: "success",
        resourceId: id,
        metadata: { restoredByUserId: ownerUserId },
      });

      const storage = await getStorageProtectionSummary(
        updated.storageBucket,
        updated.storageKey,
        {
          storageRegion: updated.storageRegion,
          storageObjectLockMode: updated.storageObjectLockMode,
          storageObjectLockRetainUntilUtc:
            updated.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus:
            updated.storageObjectLockLegalHoldStatus,
        }
      );

      return reply.code(200).send({
        evidence: {
          ...toSafeEvidence(updated),
          storage,
        },
      });
    }
  );

  app.delete(
    "/v1/evidence/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (evidence.deletedAt) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.delete",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "already_deleted" },
        });
        return reply.code(409).send({ message: "Evidence is already deleted" });
      }

      const now = new Date();
      const deleteScheduledForUtc = addDays(now, 90);

      const updated = await prisma.evidence.update({
        where: { id },
        data: {
          deletedAt: now,
          deletedAtUtc: now,
          deletedByUserId: ownerUserId,
          deleteScheduledForUtc,
        },
        select: SAFE_EVIDENCE_SELECT,
      });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_DELETE_SCHEDULED,
        payload: {
          deletedByUserId: ownerUserId,
          deletedAtUtc: now.toISOString(),
          deleteScheduledForUtc: deleteScheduledForUtc.toISOString(),
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.delete",
        outcome: "success",
        resourceId: id,
        metadata: {
          deletedByUserId: ownerUserId,
          deleteScheduledForUtc: deleteScheduledForUtc.toISOString(),
        },
      });

      return reply.code(200).send({
        deleted: true,
        evidence: toJsonSafe({
          ...toSafeEvidence(updated),
        }),
      });
    }
  );

  app.post(
    "/v1/evidence/:id/restore",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = RestoreDeletedEvidenceBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence | null;
      try {
        evidence = await prisma.evidence.findUnique({
          where: { id },
          select: SAFE_EVIDENCE_SELECT,
        });

        if (!evidence) {
          return reply.code(404).send({ message: "Evidence not found" });
        }

        if (evidence.ownerUserId !== ownerUserId) {
          return reply.code(403).send({ message: "Forbidden" });
        }
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (!body.restore) {
        return reply.code(400).send({ message: "Restore is required" });
      }

      if (!evidence.deletedAt) {
        return reply.code(409).send({ message: "Evidence is not deleted" });
      }

      const updated = await prisma.evidence.update({
        where: { id },
        data: {
          deletedAt: null,
          deletedAtUtc: null,
          deletedByUserId: null,
          deleteScheduledForUtc: null,
        },
        select: SAFE_EVIDENCE_SELECT,
      });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_RESTORED,
        payload: { restoredByUserId: ownerUserId, restoreSource: "trash" },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.restore",
        outcome: "success",
        resourceId: id,
        metadata: { restoredByUserId: ownerUserId, restoreSource: "trash" },
      });

      return reply.code(200).send({
        restored: true,
        evidence: toJsonSafe({
          ...toSafeEvidence(updated),
        }),
      });
    }
  );

  app.get("/v1/evidence", { preHandler: requireAuth }, async (req, reply) => {
    const ownerUserId = getAuthUserId(req);
    const query = req.query as {
      caseId?: string;
      scope?: string;
      includeArchived?: string;
      includeDeleted?: string;
    };

    const caseId = query.caseId ? z.string().uuid().parse(query.caseId) : null;

    const scope =
      typeof query.scope === "string" && query.scope.trim().length > 0
        ? EvidenceListScopeSchema.parse(query.scope.trim().toLowerCase())
        : query.includeDeleted === "true"
          ? "deleted"
          : query.includeArchived === "true"
            ? "all"
            : "active";

    const archivedFilter =
      scope === "archived"
        ? { archivedAt: { not: null as null | object } }
        : scope === "active" || scope === "locked"
          ? { archivedAt: null }
          : {};

    const deletedFilter =
      scope === "deleted"
        ? { deletedAt: { not: null as null | object } }
        : { deletedAt: null };

    const lockedFilter =
      scope === "locked"
        ? { lockedAt: { not: null as null | object } }
        : scope === "active" || scope === "archived"
          ? { lockedAt: null }
          : {};

    const mapEvidenceListItem = async (item: {
      id: string;
      title: string | null;
      type: prismaPkg.EvidenceType;
      status: prismaPkg.EvidenceStatus;
      verificationStatus: prismaPkg.VerificationStatus | null;
      captureMethod: prismaPkg.CaptureMethod | null;
      identityLevelSnapshot: prismaPkg.IdentityLevel | null;
      submittedByEmail: string | null;
      latestReportVersion: number | null;
      reviewReadyAtUtc: Date | null;
      createdAt: Date;
      archivedAt: Date | null;
      deletedAt: Date | null;
      deleteScheduledForUtc: Date | null;
      caseId: string | null;
      teamId: string | null;
      ownerUserId: string;
      storageBucket: string | null;
      storageKey: string | null;
      storageRegion: string | null;
      storageObjectLockMode: string | null;
      storageObjectLockRetainUntilUtc: Date | null;
      storageObjectLockLegalHoldStatus: string | null;
      _count: { parts: number };
    }) => {
      const itemCount = item._count.parts > 0 ? item._count.parts : 1;
      const storage = await getStorageProtectionSummary(
        item.storageBucket,
        item.storageKey,
        {
          storageRegion: item.storageRegion,
          storageObjectLockMode: item.storageObjectLockMode,
          storageObjectLockRetainUntilUtc: item.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus: item.storageObjectLockLegalHoldStatus,
        }
      );

      return {
        id: item.id,
        title: resolveEvidenceTitle(item.title),
        type: item.type,
        status: item.status,
        statusLabel: mapRecordStatusLabel(item.status),
        verificationStatus: item.verificationStatus,
        verificationStatusLabel: mapVerificationStatusLabel(
          item.verificationStatus
        ),
        captureMethod: item.captureMethod,
        captureMethodLabel: mapCaptureMethodLabel(item.captureMethod),
        identityLevel: item.identityLevelSnapshot,
        identityLevelLabel: mapIdentityLevelLabel(item.identityLevelSnapshot),
        submittedByEmail: item.submittedByEmail,
        latestReportVersion: item.latestReportVersion,
        reviewReadyAtUtc: item.reviewReadyAtUtc
          ? item.reviewReadyAtUtc.toISOString()
          : null,
        createdAt: item.createdAt.toISOString(),
        archivedAt: item.archivedAt ? item.archivedAt.toISOString() : null,
        deletedAt: item.deletedAt ? item.deletedAt.toISOString() : null,
        deleteScheduledForUtc: item.deleteScheduledForUtc
          ? item.deleteScheduledForUtc.toISOString()
          : null,
        caseId: item.caseId,
        teamId: item.teamId,
        ownerUserId: item.ownerUserId,
        itemCount,
        storage,
        displaySubtitle: buildEvidenceSubtitle({
          itemCount,
          status: item.status,
          createdAt: item.createdAt,
        }),
      };
    };

    if (caseId) {
      await assertCaseAccess(ownerUserId, caseId);

      const items = await prisma.evidence.findMany({
        where: {
          ...deletedFilter,
          ...archivedFilter,
          ...lockedFilter,
          caseId,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          title: true,
          type: true,
          status: true,
          verificationStatus: true,
          captureMethod: true,
          identityLevelSnapshot: true,
          submittedByEmail: true,
          latestReportVersion: true,
          reviewReadyAtUtc: true,
          createdAt: true,
          archivedAt: true,
          deletedAt: true,
          deleteScheduledForUtc: true,
          caseId: true,
          teamId: true,
          ownerUserId: true,
          storageBucket: true,
          storageKey: true,
          storageRegion: true,
          storageObjectLockMode: true,
          storageObjectLockRetainUntilUtc: true,
          storageObjectLockLegalHoldStatus: true,
          _count: {
            select: { parts: true },
          },
        },
      });

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.list",
        outcome: "success",
        metadata: {
          caseId,
          scope,
          count: items.length,
        },
      });

      return reply.code(200).send({
        scope,
        items: await Promise.all(items.map(mapEvidenceListItem)),
      });
    }

    const memberTeams = await prisma.teamMember.findMany({
      where: { userId: ownerUserId },
      select: { teamId: true },
    });
    const memberTeamIds = memberTeams.map((t) => t.teamId);

    const accessibleCases = await prisma.case.findMany({
      where: {
        OR: [
          { ownerUserId },
          { access: { some: { userId: ownerUserId } } },
          ...(memberTeamIds.length > 0
            ? [
                {
                  teamId: { in: memberTeamIds },
                  access: { none: {} },
                },
              ]
            : []),
        ],
      },
      select: { id: true },
    });
    const accessibleCaseIds = accessibleCases.map((c) => c.id);

    const items = await prisma.evidence.findMany({
      where: {
        ...deletedFilter,
        ...archivedFilter,
        ...lockedFilter,
        OR: [
          { ownerUserId },
          ...(accessibleCaseIds.length > 0
            ? [{ caseId: { in: accessibleCaseIds } }]
            : []),
          ...(memberTeamIds.length > 0
            ? [{ teamId: { in: memberTeamIds } }]
            : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        verificationStatus: true,
        captureMethod: true,
        identityLevelSnapshot: true,
        submittedByEmail: true,
        latestReportVersion: true,
        reviewReadyAtUtc: true,
        createdAt: true,
        archivedAt: true,
        deletedAt: true,
        deleteScheduledForUtc: true,
        caseId: true,
        teamId: true,
        ownerUserId: true,
        storageBucket: true,
        storageKey: true,
        storageRegion: true,
        storageObjectLockMode: true,
        storageObjectLockRetainUntilUtc: true,
        storageObjectLockLegalHoldStatus: true,
        _count: {
          select: { parts: true },
        },
      },
    });

    auditEvidenceAction(req, {
      userId: ownerUserId,
      action: "evidence.list",
      outcome: "success",
      metadata: {
        scope,
        count: items.length,
      },
    });

    return reply.code(200).send({
      scope,
      items: await Promise.all(items.map(mapEvidenceListItem)),
    });
  });

  app.get(
    "/v1/evidence/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const ownerUserId = getAuthUserId(req);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        const evidence = await getEvidenceWithReadAccess(ownerUserId, id);
        const itemCount = await getEvidenceItemCount(id);
        const storage = await getStorageProtectionSummary(
          evidence.storageBucket,
          evidence.storageKey,
          {
            storageRegion: evidence.storageRegion,
            storageObjectLockMode: evidence.storageObjectLockMode,
            storageObjectLockRetainUntilUtc:
              evidence.storageObjectLockRetainUntilUtc,
            storageObjectLockLegalHoldStatus:
              evidence.storageObjectLockLegalHoldStatus,
          }
        );
        const anchor = await getAnchorStatus(id);

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.view",
          outcome: "success",
          resourceId: id,
          metadata: {
            itemCount,
            status: evidence.status,
            verificationStatus: evidence.verificationStatus,
          },
        });

        return reply.code(200).send({
          evidence: toJsonSafe({
            ...toSafeEvidence(evidence),
            itemCount,
            displayTitle: resolveEvidenceTitle(evidence.title),
            displaySubtitle: buildEvidenceSubtitle({
              itemCount,
              status: evidence.status,
              createdAt: evidence.createdAt,
            }),
            storage,
            anchor,
          }),
        });
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
    }
  );

  app.post(
    "/v1/evidence/:id/complete",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      const plan = await getUserPlan(ownerUserId);
      const limit = getTierLimit(plan);
      const rate = await enforceRateLimit({
        key: `ratelimit:evidence:complete:${plan}:${ownerUserId}`,
        max: limit.max,
        windowSec: limit.windowSec,
      });

      if (!rate.allowed) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.complete",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "rate_limit_exceeded", plan },
        });
        return reply.code(429).send({ message: "Rate limit exceeded" });
      }

      try {
        const result = await completeEvidence({ evidenceId: id, ownerUserId });

        const refreshed = await prisma.evidence.findUnique({
          where: { id },
          select: SAFE_EVIDENCE_SELECT,
        });

        if (!refreshed) {
          return reply.code(404).send({ message: "Evidence not found" });
        }

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.complete",
          outcome: "success",
          resourceId: id,
          metadata: {
            status: refreshed.status,
            verificationStatus: refreshed.verificationStatus,
            result: "completed",
          },
        });

        const storage = await getStorageProtectionSummary(
          refreshed.storageBucket,
          refreshed.storageKey,
          {
            storageRegion: refreshed.storageRegion,
            storageObjectLockMode: refreshed.storageObjectLockMode,
            storageObjectLockRetainUntilUtc:
              refreshed.storageObjectLockRetainUntilUtc,
            storageObjectLockLegalHoldStatus:
              refreshed.storageObjectLockLegalHoldStatus,
          }
        );

        return reply.code(200).send({
          ...toJsonSafe(result),
          evidence: toJsonSafe(toSafeEvidence(refreshed)),
          storage,
        });
      } catch (err) {
if (
  err instanceof Error &&
  "code" in err &&
  (err as Error & { code?: string }).code === "INSUFFICIENT_CREDITS"
) {
  auditEvidenceAction(req, {
    userId: ownerUserId,
    action: "evidence.complete",
    outcome: "blocked",
    severity: "warning",
    resourceId: id,
    metadata: { reason: "INSUFFICIENT_CREDITS" },
  });
  return reply.code(402).send({
    code: "INSUFFICIENT_CREDITS",
    message: "Insufficient credits",
  });
}

        if (
          err instanceof Error &&
          err.message === "Cannot complete evidence without an uploaded file"
        ) {
          auditEvidenceAction(req, {
            userId: ownerUserId,
            action: "evidence.complete",
            outcome: "failure",
            severity: "warning",
            resourceId: id,
            metadata: { reason: err.message },
          });
          return reply.code(400).send({ message: err.message });
        }

        if (
          err instanceof Error &&
          (err.message.startsWith("OBJECT_HEAD_FAILED:") ||
            err.message.startsWith("OBJECT_GET_FAILED:"))
        ) {
          auditEvidenceAction(req, {
            userId: ownerUserId,
            action: "evidence.complete",
            outcome: "failure",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "uploaded_object_not_found" },
          });
          return reply.code(404).send({ message: "Uploaded object not found" });
        }

                if (
          err instanceof Error &&
          "code" in err &&
          (err as Error & { code?: string }).code === "STORAGE_LIMIT_REACHED"
        ) {
          const lockedEvidence = await prisma.evidence.findUnique({
            where: { id },
            select: {
              teamId: true,
            },
          });

          const details =
            "details" in err
              ? ((err as Error & { details?: Record<string, unknown> }).details ?? {})
              : {};

          const payload = await buildStorageLimitPayload({
            ownerUserId,
            evidenceId: id,
            teamId: lockedEvidence?.teamId ?? null,
            req,
            reason: "complete_evidence_blocked",
            incomingBytes:
              typeof details?.incomingBytes === "string"
                ? details.incomingBytes
                : null,
          });

          auditEvidenceAction(req, {
            userId: ownerUserId,
            action: "evidence.complete",
            outcome: "blocked",
            severity: "warning",
            resourceId: id,
            metadata: {
              reason: "STORAGE_LIMIT_REACHED",
            },
          });

          return reply.code(409).send(payload);
        }

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.complete",
          outcome: "failure",
          severity: "critical",
          resourceId: id,
          metadata: {
            reason: err instanceof Error ? err.message : "unknown_error",
          },
        });

        throw err;
      }
    }
  );

  app.get(
    "/v1/evidence/:id/report/latest",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      const latest = await prisma.report.findFirst({
        where: { evidenceId: id },
        orderBy: { version: "desc" },
        select: {
          version: true,
          storageBucket: true,
          storageKey: true,
          storageRegion: true,
          storageObjectLockMode: true,
          storageObjectLockRetainUntilUtc: true,
          storageObjectLockLegalHoldStatus: true,
          generatedAtUtc: true,
          verificationStatusSnapshot: true,
          identityLevelSnapshot: true,
          submittedByEmailSnapshot: true,
          submittedByAuthProviderSnapshot: true,
          captureMethodSnapshot: true,
          reviewerSummaryVersion: true,
          verificationPackageVersion: true,
        },
      });

      if (!latest) {
        return reply.code(404).send({ message: "Report not found" });
      }

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.REPORT_DOWNLOADED,
        payload: { reportVersion: latest.version },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.report_viewed",
        outcome: "success",
        resourceId: id,
        metadata: {
          reportVersion: latest.version,
        },
      });

      const url = await presignGetObject({
        bucket: latest.storageBucket,
        key: latest.storageKey,
        expiresInSeconds: 600,
      });

      const storage = await getStorageProtectionSummary(
        latest.storageBucket,
        latest.storageKey,
        {
          storageRegion: latest.storageRegion,
          storageObjectLockMode: latest.storageObjectLockMode,
          storageObjectLockRetainUntilUtc:
            latest.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus:
            latest.storageObjectLockLegalHoldStatus,
        }
      );

      return reply.code(200).send({
        evidenceId: id,
        version: latest.version,
        bucket: latest.storageBucket,
        key: latest.storageKey,
        url,
        generatedAtUtc: latest.generatedAtUtc.toISOString(),
        storage,
        snapshots: {
          verificationStatus: latest.verificationStatusSnapshot ?? null,
          verificationStatusLabel: mapVerificationStatusLabel(
            latest.verificationStatusSnapshot
          ),
          identityLevel: latest.identityLevelSnapshot ?? null,
          identityLevelLabel: mapIdentityLevelLabel(
            latest.identityLevelSnapshot
          ),
          submittedByEmail: latest.submittedByEmailSnapshot ?? null,
          submittedByAuthProvider: latest.submittedByAuthProviderSnapshot ?? null,
          submittedByAuthProviderLabel: mapAuthProviderLabel(
            latest.submittedByAuthProviderSnapshot
          ),
          captureMethod: latest.captureMethodSnapshot ?? null,
          captureMethodLabel: mapCaptureMethodLabel(
            latest.captureMethodSnapshot
          ),
          reviewerSummaryVersion: latest.reviewerSummaryVersion ?? null,
          verificationPackageVersion: latest.verificationPackageVersion ?? null,
        },
      });
    }
  );

  app.get(
    "/v1/evidence/:id/original",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (!evidence.storageBucket || !evidence.storageKey) {
        return reply.code(404).send({ message: "Original file not found" });
      }

      const url = await presignGetObject({
        bucket: evidence.storageBucket,
        key: evidence.storageKey,
        expiresInSeconds: 600,
      });

      const accessedAt = new Date();

      await prisma.evidence.update({
        where: { id },
        data: {
          lastAccessedByUserId: ownerUserId,
          lastAccessedAtUtc: accessedAt,
        },
      });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_VIEWED,
        payload: {
          mimeType: evidence.mimeType ?? null,
          accessMode: "authenticated_original_access",
          accessedByUserId: ownerUserId,
          accessedAtUtc: accessedAt.toISOString(),
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.downloaded",
        outcome: "success",
        resourceId: id,
        metadata: {
          accessMode: "original_presign",
        },
      });

      const storage = await getStorageProtectionSummary(
        evidence.storageBucket,
        evidence.storageKey,
        {
          storageRegion: evidence.storageRegion,
          storageObjectLockMode: evidence.storageObjectLockMode,
          storageObjectLockRetainUntilUtc:
            evidence.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus:
            evidence.storageObjectLockLegalHoldStatus,
        }
      );

      const originalFileName =
        evidence.storageKey?.split("/").pop()?.trim() || null;

      return reply.code(200).send({
        evidenceId: id,
        bucket: evidence.storageBucket,
        key: evidence.storageKey,
        originalFileName,
        url,
        mimeType: evidence.mimeType,
        sizeBytes: evidence.sizeBytes?.toString() ?? null,
        lastAccessedByUserId: ownerUserId,
        lastAccessedAtUtc: accessedAt.toISOString(),
        storage,
      });
    }
  );

  app.get(
    "/v1/evidence/:id/verification-package",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      const latest = await prisma.verificationPackage.findFirst({
        where: { evidenceId: id },
        orderBy: { version: "desc" },
        select: {
          version: true,
          storageBucket: true,
          storageKey: true,
          storageRegion: true,
          storageObjectLockMode: true,
          storageObjectLockRetainUntilUtc: true,
          storageObjectLockLegalHoldStatus: true,
          generatedAtUtc: true,
          packageType: true,
        },
      });

      if (!latest) {
        return reply
          .code(404)
          .send({ message: "Verification package not found" });
      }

      try {
        const meta = await headObject({
          bucket: latest.storageBucket,
          key: latest.storageKey,
        });
        if (!meta.sizeBytes || meta.sizeBytes <= 0) {
          return reply
            .code(404)
            .send({ message: "Verification package not found" });
        }
      } catch {
        return reply
          .code(404)
          .send({ message: "Verification package not found" });
      }

      const url = await presignGetObject({
        bucket: latest.storageBucket,
        key: latest.storageKey,
        expiresInSeconds: 600,
      });

      const storage = await getStorageProtectionSummary(
        latest.storageBucket,
        latest.storageKey,
        {
          storageRegion: latest.storageRegion,
          storageObjectLockMode: latest.storageObjectLockMode,
          storageObjectLockRetainUntilUtc:
            latest.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus:
            latest.storageObjectLockLegalHoldStatus,
        }
      );

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.VERIFICATION_PACKAGE_DOWNLOADED,
        payload: {
          version: latest.version,
          packageType: latest.packageType ?? null,
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "verification.package_accessed",
        outcome: "success",
        resourceId: id,
        metadata: {
          packageKey: latest.storageKey,
          version: latest.version,
          packageType: latest.packageType ?? null,
        },
      });

      return reply.code(200).send({
        evidenceId: id,
        version: latest.version,
        packageType: latest.packageType ?? null,
        key: latest.storageKey,
        url,
        generatedAtUtc: latest.generatedAtUtc.toISOString(),
        storage,
      });
    }
  );

  app.get("/public/verify/:id", async (req: FastifyRequest, reply) => {
    const limit = getVerifyLimit();
    const rate = await enforceRateLimit({
      key: `ratelimit:verify:${req.ip}`,
      max: limit.max,
      windowSec: limit.windowSec,
    });

    if (!rate.allowed) {
      auditVerificationAction(req, {
        userId: null,
        action: "verification.page_opened",
        resourceId: null,
        metadata: { outcome: "rate_limited" },
      });
      return reply.code(429).send({ message: "Rate limit exceeded" });
    }

    const id = z.string().uuid().parse((req.params as ParamsId).id);

    (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
    req.log = req.log.child({ evidenceId: id });

    const evidence = await prisma.evidence.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        verificationStatus: true,
        captureMethod: true,
        identityLevelSnapshot: true,
        submittedByEmail: true,
        submittedByAuthProvider: true,
        submittedByUserId: true,
        workspaceNameSnapshot: true,
        organizationNameSnapshot: true,
        organizationVerifiedSnapshot: true,
        createdAt: true,
        capturedAtUtc: true,
        uploadedAtUtc: true,
        signedAtUtc: true,
        recordedIntegrityVerifiedAtUtc: true,
        lastVerifiedAtUtc: true,
        lastVerifiedSource: true,
        verificationPackageGeneratedAtUtc: true,
        verificationPackageVersion: true,
        latestReportVersion: true,
        reviewReadyAtUtc: true,
        reviewerSummaryVersion: true,
        mimeType: true,
        reportGeneratedAtUtc: true,
        fingerprintCanonicalJson: true,
        fingerprintHash: true,
        signatureBase64: true,
        signingKeyId: true,
        signingKeyVersion: true,
        fileSha256: true,
        tsaProvider: true,
        tsaUrl: true,
        tsaSerialNumber: true,
        tsaGenTimeUtc: true,
        tsaMessageImprint: true,
        tsaHashAlgorithm: true,
        tsaStatus: true,
        tsaFailureReason: true,
        otsProofBase64: true,
        otsHash: true,
        otsStatus: true,
        otsCalendar: true,
        otsBitcoinTxid: true,
        otsAnchoredAtUtc: true,
        otsUpgradedAtUtc: true,
        otsFailureReason: true,
        storageBucket: true,
        storageKey: true,
        storageRegion: true,
        storageObjectLockMode: true,
        storageObjectLockRetainUntilUtc: true,
        storageObjectLockLegalHoldStatus: true,
      },
    });

    if (!evidence) {
      return reply.code(404).send({ message: "Evidence not found" });
    }

    if (
      !evidence.fingerprintCanonicalJson ||
      !evidence.fingerprintHash ||
      !evidence.signatureBase64 ||
      !evidence.signingKeyId ||
      !evidence.signingKeyVersion ||
      !evidence.fileSha256
    ) {
      return reply.code(404).send({ message: "Evidence not signed" });
    }

    const signingKey = await prisma.signingKey.findUnique({
      where: {
        keyId_version: {
          keyId: evidence.signingKeyId,
          version: evidence.signingKeyVersion,
        },
      },
      select: { publicKeyPem: true },
    });

    if (!signingKey) {
      return reply.code(404).send({ message: "Signing key not found" });
    }

    const allCustodyEvents = await prisma.custodyEvent.findMany({
      where: { evidenceId: id },
      orderBy: { sequence: "asc" },
      take: 500,
      select: {
        sequence: true,
        atUtc: true,
        eventType: true,
        payload: true,
        prevEventHash: true,
        eventHash: true,
      },
    });

    const forensicCustodyEvents = allCustodyEvents.filter(
      (ev) => !isAccessCustodyEventType(ev.eventType)
    );

    const accessCustodyEvents = allCustodyEvents.filter((ev) =>
      isAccessCustodyEventType(ev.eventType)
    );

    const latestReport = await prisma.report.findFirst({
      where: { evidenceId: id },
      orderBy: { version: "desc" },
      select: {
        version: true,
        generatedAtUtc: true,
      },
    });

    const itemCount = await getEvidenceItemCount(id);

    const recomputedFingerprintHash = sha256Hex(
      evidence.fingerprintCanonicalJson
    );
    const canonicalHashMatches =
      recomputedFingerprintHash === evidence.fingerprintHash;

    let signatureValid = false;
    try {
      signatureValid = ed25519VerifyHexSignature({
        messageHex: recomputedFingerprintHash,
        signatureBase64: evidence.signatureBase64,
        publicKeyPem: signingKey.publicKeyPem,
      });
    } catch {
      signatureValid = false;
    }

    const timestampDigestMatches =
      evidence.tsaStatus === "STAMPED"
        ? (evidence.tsaMessageImprint ?? "").toLowerCase() ===
          evidence.fileSha256.toLowerCase()
        : true;

    const otsHashMatches =
      evidence.otsHash && evidence.fingerprintHash
        ? evidence.otsHash.toLowerCase() ===
          evidence.fingerprintHash.toLowerCase()
        : evidence.otsStatus
          ? false
          : true;

    const custodyChain = evaluateCustodyChain({
      evidenceId: id,
      records: allCustodyEvents.map((ev) => ({
        sequence: ev.sequence,
        eventType: ev.eventType,
        atUtc: ev.atUtc,
        payload: ev.payload,
        prevEventHash: ev.prevEventHash,
        eventHash: ev.eventHash,
      })),
    });

    const storageProtection = await getStorageProtectionSummary(
      evidence.storageBucket,
      evidence.storageKey,
      {
        storageRegion: evidence.storageRegion,
        storageObjectLockMode: evidence.storageObjectLockMode,
        storageObjectLockRetainUntilUtc:
          evidence.storageObjectLockRetainUntilUtc,
        storageObjectLockLegalHoldStatus:
          evidence.storageObjectLockLegalHoldStatus,
      }
    );

    const anchor = await getAnchorStatus(id);

    const overallIntegrity =
      canonicalHashMatches &&
      signatureValid &&
      custodyChain.valid &&
      timestampDigestMatches &&
      otsHashMatches;

    const verifiedAt = new Date();
    const effectiveVerificationStatus = overallIntegrity
      ? prismaPkg.VerificationStatus.RECORDED_INTEGRITY_VERIFIED
      : prismaPkg.VerificationStatus.REVIEW_REQUIRED;

    await prisma.$transaction([
      prisma.evidence.update({
        where: { id },
        data: {
          lastVerifiedAtUtc: verifiedAt,
          lastVerifiedSource: VerificationSource.PUBLIC_VERIFY_VIEWED,
          verificationStatus: effectiveVerificationStatus,
          recordedIntegrityVerifiedAtUtc: overallIntegrity
            ? evidence.recordedIntegrityVerifiedAtUtc ?? verifiedAt
            : evidence.recordedIntegrityVerifiedAtUtc,
        },
      }),
      prisma.verificationView.create({
        data: {
          evidenceId: id,
          viewerType: VerificationViewerType.PUBLIC,
          viewerUserId: null,
          accessMode: "public_verify",
          ipAddress: req.ip,
          userAgent: readUserAgent(req),
        },
      }),
    ]);

    void appendCustodyEvent({
      evidenceId: id,
      eventType: prismaPkg.CustodyEventType.VERIFY_VIEWED,
      payload: {
        accessMode: "public_verify",
      },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    }).catch(() => null);

    void appendCustodyEvent({
      evidenceId: id,
      eventType: prismaPkg.CustodyEventType.TECHNICAL_VERIFICATION_CHECKED,
      payload: {
        source: VerificationSource.PUBLIC_VERIFY_VIEWED,
        canonicalHashMatches,
        signatureValid,
        custodyChainValid: custodyChain.valid,
        timestampDigestMatches,
        otsHashMatches,
        overallIntegrity,
      },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    }).catch(() => null);

    auditVerificationAction(req, {
      userId: null,
      action: "verification.page_opened",
      resourceId: id,
      metadata: {
        evidenceId: id,
        overallIntegrity,
      },
    });

    const mappedCustodyEvents = allCustodyEvents.map(mapPublicCustodyEvent);
    const mappedForensicEvents = forensicCustodyEvents.map(mapPublicCustodyEvent);
    const mappedAccessEvents = accessCustodyEvents.map(mapPublicCustodyEvent);

    const effectiveRecordedIntegrityVerifiedAtUtc = overallIntegrity
      ? evidence.recordedIntegrityVerifiedAtUtc ?? verifiedAt
      : evidence.recordedIntegrityVerifiedAtUtc;

    const overview = buildPublicVerifyOverview({
      evidence: {
        id: evidence.id,
        title: evidence.title,
        type: evidence.type,
        status: evidence.status,
        verificationStatus: effectiveVerificationStatus,
        captureMethod: evidence.captureMethod ?? null,
        identityLevelSnapshot: evidence.identityLevelSnapshot ?? null,
        submittedByEmail: evidence.submittedByEmail ?? null,
        submittedByAuthProvider: evidence.submittedByAuthProvider ?? null,
        workspaceNameSnapshot: evidence.workspaceNameSnapshot ?? null,
        organizationNameSnapshot: evidence.organizationNameSnapshot ?? null,
        organizationVerifiedSnapshot:
          evidence.organizationVerifiedSnapshot ?? null,
        mimeType: evidence.mimeType,
        createdAt: evidence.createdAt,
        capturedAtUtc: evidence.capturedAtUtc,
        uploadedAtUtc: evidence.uploadedAtUtc,
        signedAtUtc: evidence.signedAtUtc,
        recordedIntegrityVerifiedAtUtc:
          effectiveRecordedIntegrityVerifiedAtUtc,
        lastVerifiedAtUtc: verifiedAt,
        lastVerifiedSource: VerificationSource.PUBLIC_VERIFY_VIEWED,
        reviewReadyAtUtc: evidence.reviewReadyAtUtc,
        verificationPackageGeneratedAtUtc:
          evidence.verificationPackageGeneratedAtUtc,
        verificationPackageVersion: evidence.verificationPackageVersion,
        latestReportVersion: evidence.latestReportVersion,
        reviewerSummaryVersion: evidence.reviewerSummaryVersion,
        reportGeneratedAtUtc: evidence.reportGeneratedAtUtc,
      },
      latestReport,
      itemCount,
      storageProtection,
      timestampStatus: evidence.tsaStatus,
      otsStatus: evidence.otsStatus,
      overallIntegrity,
      chainOfCustodyPresent: forensicCustodyEvents.length > 0,
      anchor,
    });

    const humanSummary = buildPublicVerifyHumanSummary({
      overview,
      canonicalHashMatches,
      signatureValid,
      custodyChainValid: custodyChain.valid,
      timestampDigestMatches,
      otsHashMatches,
      overallIntegrity,
    });

    const limitations = buildPublicVerifyLimitations();

    return reply.code(200).send({
      evidenceId: evidence.id,
      title: resolveEvidenceTitle(evidence.title),
      status: evidence.status,
      verificationStatus: effectiveVerificationStatus,
      captureMethod: evidence.captureMethod ?? null,
      identityLevelSnapshot: evidence.identityLevelSnapshot ?? null,
      mimeType: evidence.mimeType,

      reportGeneratedAtUtc: latestReport?.generatedAtUtc
        ? latestReport.generatedAtUtc.toISOString()
        : evidence.reportGeneratedAtUtc
          ? evidence.reportGeneratedAtUtc.toISOString()
          : null,
      reportVersion:
        latestReport?.version ?? evidence.latestReportVersion ?? null,

      fileSha256: evidence.fileSha256,
      fingerprintHash: evidence.fingerprintHash,
      signatureBase64: evidence.signatureBase64,
      signingKeyId: evidence.signingKeyId,
      signingKeyVersion: evidence.signingKeyVersion,
      publicKeyPem: signingKey.publicKeyPem,

      verification: {
        canonicalHashMatches,
        signatureValid,
        custodyChainValid: custodyChain.valid,
        custodyChainMode: custodyChain.mode,
        custodyChainFailureReason: custodyChain.reason,
        timestampDigestMatches,
        otsHashMatches,
        overallIntegrity,
        forensicEventCount: forensicCustodyEvents.length,
        accessEventCount: accessCustodyEvents.length,
      },

      identity: {
        submittedByEmail: evidence.submittedByEmail ?? null,
        submittedByAuthProvider: evidence.submittedByAuthProvider ?? null,
        submittedByAuthProviderLabel: mapAuthProviderLabel(
          evidence.submittedByAuthProvider
        ),
        submittedByUserId: evidence.submittedByUserId ?? null,
        identityLevel: evidence.identityLevelSnapshot ?? null,
        identityLevelLabel: mapIdentityLevelLabel(
          evidence.identityLevelSnapshot
        ),
        workspaceName: evidence.workspaceNameSnapshot ?? null,
        organizationName: evidence.organizationNameSnapshot ?? null,
        organizationVerified: evidence.organizationVerifiedSnapshot ?? null,
      },

      storage: storageProtection,
      anchor,

      tsaStatus: evidence.tsaStatus,
      tsaProvider: evidence.tsaProvider,
      tsaUrl: evidence.tsaUrl,
      tsaSerialNumber: evidence.tsaSerialNumber,
      tsaGenTimeUtc: evidence.tsaGenTimeUtc
        ? evidence.tsaGenTimeUtc.toISOString()
        : null,
      tsaMessageImprint: shortHash(evidence.tsaMessageImprint),
      tsaHashAlgorithm: evidence.tsaHashAlgorithm,
      tsaFailureReason: evidence.tsaFailureReason,

      tsa: {
        status: evidence.tsaStatus,
        provider: evidence.tsaProvider,
        url: evidence.tsaUrl,
        serialNumber: evidence.tsaSerialNumber,
        genTimeUtc: evidence.tsaGenTimeUtc
          ? evidence.tsaGenTimeUtc.toISOString()
          : null,
        hashAlgorithm: evidence.tsaHashAlgorithm,
        messageImprint: shortHash(evidence.tsaMessageImprint),
        failureReason: evidence.tsaFailureReason,
        digestMatchesFileHash: timestampDigestMatches,
      },

      ots: {
        status: evidence.otsStatus ?? null,
        hash: evidence.otsHash ?? null,
        calendar: evidence.otsCalendar ?? null,
        bitcoinTxid: evidence.otsBitcoinTxid ?? null,
        anchoredAtUtc: evidence.otsAnchoredAtUtc
          ? evidence.otsAnchoredAtUtc.toISOString()
          : null,
        upgradedAtUtc: evidence.otsUpgradedAtUtc
          ? evidence.otsUpgradedAtUtc.toISOString()
          : null,
        failureReason: evidence.otsFailureReason ?? null,
        proofPresent: Boolean(evidence.otsProofBase64),
        hashMatchesFingerprintHash: otsHashMatches,
      },

      custodyEvents: mappedCustodyEvents,
      forensicCustodyEvents: mappedForensicEvents,
      accessCustodyEvents: mappedAccessEvents,

      overview,
      humanSummary,
      reviewTrail: {
        forensicEventCount: mappedForensicEvents.length,
        accessEventCount: mappedAccessEvents.length,
        forensicCustodyEvents: mappedForensicEvents,
        accessCustodyEvents: mappedAccessEvents,
      },
      technicalMaterials: {
        fileSha256: evidence.fileSha256,
        fingerprintHash: evidence.fingerprintHash,
        signatureBase64: evidence.signatureBase64,
        publicKeyPem: signingKey.publicKeyPem,
        signingKeyId: evidence.signingKeyId,
        signingKeyVersion: evidence.signingKeyVersion,
        otsProofPresent: Boolean(evidence.otsProofBase64),
      },
      storageAndTimestamping: {
        storage: storageProtection,
        tsa: {
          status: evidence.tsaStatus,
          provider: evidence.tsaProvider,
          url: evidence.tsaUrl,
          serialNumber: evidence.tsaSerialNumber,
          genTimeUtc: evidence.tsaGenTimeUtc
            ? evidence.tsaGenTimeUtc.toISOString()
            : null,
          hashAlgorithm: evidence.tsaHashAlgorithm,
          messageImprint: shortHash(evidence.tsaMessageImprint),
          failureReason: evidence.tsaFailureReason,
          digestMatchesFileHash: timestampDigestMatches,
        },
        ots: {
          status: evidence.otsStatus ?? null,
          hash: evidence.otsHash ?? null,
          calendar: evidence.otsCalendar ?? null,
          bitcoinTxid: evidence.otsBitcoinTxid ?? null,
          anchoredAtUtc: evidence.otsAnchoredAtUtc
            ? evidence.otsAnchoredAtUtc.toISOString()
            : null,
          upgradedAtUtc: evidence.otsUpgradedAtUtc
            ? evidence.otsUpgradedAtUtc.toISOString()
            : null,
          failureReason: evidence.otsFailureReason ?? null,
          proofPresent: Boolean(evidence.otsProofBase64),
          hashMatchesFingerprintHash: otsHashMatches,
        },
      },
      limitations,
    });
  });
}