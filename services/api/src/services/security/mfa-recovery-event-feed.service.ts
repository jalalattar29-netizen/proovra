/**
 * PHASE R8.1.9 — Admin recovery event feed service.
 *
 * Reads the canonical `SecurityEvent` table for the last N days
 * of `mfa_recovery_*` events scoped to the teams the calling user
 * is an ACTIVE OWNER/ADMIN of. Returns a bounded, LABELED list
 * suitable for inline rendering in the recovery admin SPA — never
 * a raw `details` JSON dump.
 *
 * Hard rules:
 *   - Tenant-scoped strictly to the actor's own ACTIVE OWNER/ADMIN
 *     memberships. NEVER reads events from another admin's teams.
 *   - NEVER returns OTPs, recovery codes, signed tokens, TOTP
 *     secrets, ciphertext, IVs, auth tags, or raw user emails.
 *     The summary label is built from the bounded `eventType`
 *     enum + the actor/target id slice — nothing else.
 *   - Read-only. No event WRITE is performed by this service.
 *     The route layer may emit one analytics ping
 *     (`mfa_recovery_event_feed_viewed`) for adoption tracking.
 *   - Bounded page size — defends against a runaway page request
 *     pulling thousands of events.
 */

import { prisma } from "../../db.js";

const DEFAULT_WINDOW_DAYS = 14;
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 100;

export interface ReadRecoveryEventFeedInput {
  actorUserId: string;
  /** Bounded page size, default 100, hard cap 200. */
  limit?: number;
  /** Lookback window, default 14 days. */
  windowDays?: number;
}

export interface RecoveryFeedRow {
  id: string;
  eventType: string;
  severity: string;
  createdAt: string;
  teamId: string | null;
  teamName: string | null;
  /** Bounded, human-readable summary — never a raw payload dump.
   *  Built from the eventType enum + actor/target id slices. */
  summary: string;
}

export interface RecoveryEventFeedResult {
  events: ReadonlyArray<RecoveryFeedRow>;
  windowDays: number;
  pageSize: number;
}

/**
 * Bounded read. Returns rows ordered by `createdAt` descending.
 */
export async function readRecoveryEventFeed(
  input: ReadRecoveryEventFeedInput,
): Promise<RecoveryEventFeedResult> {
  const pageSize = Math.max(
    1,
    Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  );
  const windowDays = Math.max(
    1,
    Math.min(input.windowDays ?? DEFAULT_WINDOW_DAYS, 60),
  );
  const cutoff = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000,
  );

  // 1. Discover the actor's ACTIVE OWNER/ADMIN memberships.
  const memberships = await prisma.teamMember.findMany({
    where: {
      userId: input.actorUserId,
      status: "ACTIVE",
      role: { in: ["OWNER", "ADMIN"] },
    },
    select: { teamId: true },
  });
  if (memberships.length === 0) {
    return { events: [], windowDays, pageSize };
  }
  const teamIds = memberships.map((m) => m.teamId);

  // 2. Pull bounded MFA-recovery events from the scoped teams.
  //    The eventType filter (`startsWith: "mfa_recovery_"`)
  //    matches every event in the R8.1.4 / R8.1.5 / R8.1.6 /
  //    R8.1.7 / R8.1.8 / R8.1.9 vocabulary without us having to
  //    enumerate them — defends against quietly missing a new
  //    event added in a future phase.
  const rows = await prisma.securityEvent.findMany({
    where: {
      teamId: { in: teamIds },
      eventType: { startsWith: "mfa_recovery_" },
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "desc" },
    take: pageSize,
    select: {
      id: true,
      eventType: true,
      severity: true,
      createdAt: true,
      teamId: true,
      details: true,
    },
  });

  // 3. Resolve team names in one batched query.
  const distinctTeamIds = [
    ...new Set(rows.map((r) => r.teamId).filter((t): t is string => Boolean(t))),
  ];
  const teams = distinctTeamIds.length
    ? await prisma.team.findMany({
        where: { id: { in: distinctTeamIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(teams.map((t) => [t.id, t.name ?? null]));

  // 4. Build bounded summary labels from the eventType + a
  //    short hash-prefix of the actor/target id when present. We
  //    DO NOT include raw `details` payload in the response.
  return {
    events: rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      severity: r.severity,
      createdAt: r.createdAt.toISOString(),
      teamId: r.teamId,
      teamName: r.teamId ? nameById.get(r.teamId) ?? null : null,
      summary: buildSummary(r.eventType, r.details),
    })),
    windowDays,
    pageSize,
  };
}

/**
 * Build a bounded, human-readable summary from the eventType enum
 * + a SHORT id slice from `details` when present. Never returns
 * raw `details` payload, never includes email addresses, never
 * includes tokens.
 */
function buildSummary(eventType: string, details: unknown): string {
  const slice = pickShortIdSlice(details);
  switch (eventType) {
    case "mfa_recovery_requested":
      return `User ${slice ?? "(unknown)"} requested MFA recovery`;
    case "mfa_recovery_approved":
      return `MFA recovery approved for user ${slice ?? "(unknown)"}`;
    case "mfa_recovery_completed":
      return `User ${slice ?? "(unknown)"} completed re-enrollment after recovery`;
    case "mfa_recovery_cancelled":
      return `User ${slice ?? "(unknown)"} cancelled their recovery request`;
    case "mfa_recovery_email_verification_sent":
      return `Recovery email sent to user ${slice ?? "(unknown)"}`;
    case "mfa_recovery_email_verified":
      return `User ${slice ?? "(unknown)"} verified their recovery email`;
    case "mfa_recovery_email_expired":
      return `Recovery email link expired for user ${slice ?? "(unknown)"}`;
    case "mfa_recovery_throttled":
      return `User ${slice ?? "(unknown)"} hit the recovery request throttle`;
    case "mfa_recovery_digest_sent":
      return "Digest email delivered to admin";
    case "mfa_recovery_digest_failed":
      return "Digest email transport failed (will retry)";
    case "mfa_recovery_digest_preference_updated":
      return `Admin ${slice ?? "(unknown)"} updated digest preferences`;
    case "mfa_recovery_digest_snooze_link_used":
      return `Admin ${slice ?? "(unknown)"} snoozed digests via one-click link`;
    case "mfa_recovery_digest_test_sent":
      return `Admin ${slice ?? "(unknown)"} sent themselves a test digest`;
    case "mfa_recovery_digest_test_failed":
      return `Test digest transport failed for admin ${slice ?? "(unknown)"}`;
    default:
      // Bounded fallback — never include `details`.
      return eventType.replace(/_/g, " ");
  }
}

/**
 * Pull a short id slice (first 8 hex chars) from the `details`
 * JSON if present. NEVER returns email addresses, tokens, or any
 * other free-form string. Only the bounded id fields we know
 * about: actorUserId, targetUserId.
 */
function pickShortIdSlice(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const obj = details as Record<string, unknown>;
  const candidate =
    typeof obj.actorUserId === "string"
      ? obj.actorUserId
      : typeof obj.targetUserId === "string"
        ? obj.targetUserId
        : null;
  if (!candidate) return null;
  return `${candidate.slice(0, 8)}…`;
}
