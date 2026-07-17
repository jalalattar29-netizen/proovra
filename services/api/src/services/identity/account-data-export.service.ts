/**
 * Lifecycle Phase 4 (2026-07-17) — personal account data export.
 *
 * ONE canonical generator + processor for the account-level privacy
 * export. Universal (never plan-gated). Asynchronous: routes only create
 * the request row; generation runs on the existing digest cron via
 * `processAccountDataExports` (the same piggyback pattern as
 * operations-snapshot pruning — no parallel job infrastructure).
 *
 * DATA BOUNDARY — the package contains ONLY the caller's own account
 * data:
 *   - profile identity (name/email/locale/timezone/created)
 *   - login-method metadata (provider, linked/last-used — NEVER subject
 *     ids, tokens, or secrets)
 *   - notification preferences (type/channel/enabled/frequency)
 *   - consent + legal-acceptance records
 *   - cookie-consent records
 *   - personal security/account activity (bounded window)
 *   - session metadata (bounded; UA/IP previews as already stored)
 *   - organization membership list (org name + role)
 * NEVER included: evidence or verification material, other users' data,
 * organization audit data, webhook/API secrets, password hashes, MFA
 * secrets, recovery codes, legal-hold material. Evidence export remains
 * an Operations surface; organization compliance export remains
 * Organization Administration.
 *
 * RETENTION: packages expire EXPORT_TTL_MS after completion; the cron
 * nulls expired payloads (secure deletion) and flips status to EXPIRED,
 * keeping the request row as the audit record.
 */

import { createHash } from "node:crypto";

import { prisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";

export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const EXPORT_SCHEMA_VERSION = 1;
const ACTIVITY_LIMIT = 200;
const SESSION_LIMIT = 50;
const PROCESS_BATCH = 10;

export async function buildAccountExportPackage(userId: string): Promise<{
  json: string;
  sha256: string;
}> {
  const [user, links, prefs, acceptances, cookieConsents, activity, sessions, orgs] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          displayName: true,
          firstName: true,
          lastName: true,
          locale: true,
          timezone: true,
          country: true,
          createdAt: true,
          emailVerifiedAt: true,
          provider: true,
        },
      }),
      prisma.userIdentityLink.findMany({
        where: { userId },
        select: {
          provider: true,
          status: true,
          normalizedEmail: true,
          linkedAtUtc: true,
          lastUsedAtUtc: true,
          revokedAtUtc: true,
        },
      }),
      prisma.workspaceNotificationPreference.findMany({
        where: { userId },
        select: {
          teamId: true,
          preferenceType: true,
          channel: true,
          enabled: true,
          frequency: true,
          updatedAt: true,
        },
        take: 500,
      }),
      prisma.userLegalAcceptance.findMany({
        where: { userId },
        select: { policyKey: true, policyVersion: true, acceptedAt: true, source: true },
        take: 100,
      }),
      prisma.cookieConsentRecord.findMany({
        where: { userId },
        select: {
          consentVersion: true,
          necessary: true,
          analytics: true,
          marketing: true,
          preferences: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.adminAuditLog.findMany({
        where: {
          userId,
          OR: [
            { action: { startsWith: "identity_security." } },
            { action: { startsWith: "auth." } },
            { action: { startsWith: "identity." } },
          ],
        },
        select: { action: true, outcome: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: ACTIVITY_LIMIT,
      }),
      prisma.authenticatedSession.findMany({
        where: { userId },
        select: {
          issuedAtUtc: true,
          lastSeenAtUtc: true,
          expiresAtUtc: true,
          revokedAtUtc: true,
          uaPreview: true,
          ipPreview: true,
          countryCode: true,
        },
        orderBy: { issuedAtUtc: "desc" },
        take: SESSION_LIMIT,
      }),
      prisma.organizationMembership.findMany({
        where: { userId },
        select: {
          role: true,
          createdAt: true,
          organization: { select: { name: true } },
        },
        take: 100,
      }),
    ]);

  const pkg = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    scope:
      "Personal account data only. Evidence, workspace, and organization records are excluded by design and are available through their own authorized surfaces.",
    profile: user,
    loginMethods: links,
    notificationPreferences: prefs,
    legalAcceptances: acceptances,
    cookieConsents: cookieConsents,
    accountActivity: activity,
    sessions,
    organizationMemberships: orgs.map((m) => ({
      organization: m.organization?.name ?? null,
      role: m.role,
      joinedAtUtc: m.createdAt,
    })),
  };
  const json = JSON.stringify(pkg, null, 2);
  const sha256 = createHash("sha256").update(json, "utf8").digest("hex");
  return { json, sha256 };
}

/**
 * Cron-invoked processor (piggybacked on the digest scheduler): generates
 * pending exports and securely expires stale packages. Idempotent — the
 * REQUESTED→PROCESSING flip is an atomic guarded updateMany, so a
 * concurrent cron firing can never double-process a request.
 */
export async function processAccountDataExports(now: Date): Promise<{
  generated: number;
  failed: number;
  expired: number;
}> {
  const summary = { generated: 0, failed: 0, expired: 0 };

  // 1. Secure expiry — null payloads past their TTL (audit row remains).
  const expired = await prisma.accountDataExportRequest.updateMany({
    where: { status: "READY", expiresAtUtc: { lt: now } },
    data: { status: "EXPIRED", packageJson: null, packageSha256: null },
  });
  summary.expired = expired.count;

  // 2. Generate pending requests (bounded batch per firing).
  const pending = await prisma.accountDataExportRequest.findMany({
    where: { status: "REQUESTED" },
    select: { id: true, userId: true },
    orderBy: { requestedAtUtc: "asc" },
    take: PROCESS_BATCH,
  });

  for (const req of pending) {
    // Atomic claim — only one firing may move REQUESTED → PROCESSING.
    const claimed = await prisma.accountDataExportRequest.updateMany({
      where: { id: req.id, status: "REQUESTED" },
      data: { status: "PROCESSING", startedAtUtc: now },
    });
    if (claimed.count === 0) continue;

    try {
      const { json, sha256 } = await buildAccountExportPackage(req.userId);
      await prisma.accountDataExportRequest.update({
        where: { id: req.id },
        data: {
          status: "READY",
          completedAtUtc: new Date(),
          expiresAtUtc: new Date(Date.now() + EXPORT_TTL_MS),
          packageJson: json,
          packageSha256: sha256,
          schemaVersion: EXPORT_SCHEMA_VERSION,
        },
      });
      summary.generated += 1;
      await appendPlatformAuditLog({
        userId: req.userId,
        action: "identity.data_export_ready",
        category: "identity",
        severity: "info",
        source: "api_data_export_cron",
        outcome: "success",
        resourceType: "account_data_export_request",
        resourceId: req.id,
        requestId: null,
        metadata: { sha256 },
        ipAddress: null,
        userAgent: null,
      }).catch(() => null);
    } catch {
      await prisma.accountDataExportRequest
        .update({
          where: { id: req.id },
          data: { status: "FAILED", failureCode: "generation_failed" },
        })
        .catch(() => null);
      summary.failed += 1;
      await appendPlatformAuditLog({
        userId: req.userId,
        action: "identity.data_export_failed",
        category: "identity",
        severity: "warning",
        source: "api_data_export_cron",
        outcome: "failure",
        resourceType: "account_data_export_request",
        resourceId: req.id,
        requestId: null,
        metadata: { failureCode: "generation_failed" },
        ipAddress: null,
        userAgent: null,
      }).catch(() => null);
    }
  }

  return summary;
}
