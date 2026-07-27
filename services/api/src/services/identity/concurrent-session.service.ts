import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { resolveOrgSecurityPolicy } from "./org-security-policy.service.js";

/**
 * PHASE 10 §2 — CONCURRENT ORGANIZATION-SESSION LIMIT (the ONE authority).
 *
 * `OrganizationSecurityPolicy.concurrentSessionLimit` is ORGANIZATION-scoped;
 * the JWT is global-authentication-only. This service enforces the limit when a
 * global session ESTABLISHES an Organization context, counting DISTINCT active
 * sessionIds per (userId, organizationId) — never per workspace, never against
 * another Organization, never against Personal/OWNED scope.
 *
 * Concurrency-safe: a PostgreSQL transaction-scoped ADVISORY LOCK keyed on
 * (userId, organizationId) serialises concurrent establishment so two last-slot
 * requests cannot both succeed (the repo's canonical `pg_advisory_xact_lock`
 * pattern — NOT an in-process mutex; safe across API instances).
 *
 * Idempotent: a session already holding this Organization's context (its
 * `organizationContextId` already equals the org) counts ONCE — repeated
 * requests + workspace switches inside the same Organization do not re-count.
 * Moving a session Org-A→Org-B repoints its context (Org-A count drops, Org-B is
 * re-evaluated); Org-A policy satisfaction is not reused.
 *
 * FAIL-CLOSED DENY: there is no existing product eviction contract, so a new
 * context beyond the limit is DENIED (`concurrent_session_limit_reached`) with
 * ZERO mutation — a potentially unauthorized login never silently evicts a
 * legitimate existing session.
 */

export type ConcurrentSessionDecision =
  | { allowed: true; established: boolean; activeCount: number; limit: number | null }
  | { allowed: false; reason: "concurrent_session_limit_reached" | "session_not_in_inventory" | "organization_suspended" };

/** Stable advisory-lock key for a (user, org) pair. hashtext → int4 is fine. */
function lockKey(userId: string, organizationId: string): string {
  return `concurrent-session:${userId}:${organizationId}`;
}

/**
 * Establish (and count) this global session's context in `organizationId`,
 * enforcing the Organization's concurrent-session limit under a per-(user,org)
 * advisory lock. The session MUST already exist in the inventory
 * (`AuthenticatedSession` keyed by userId+sessionIdHash) — org-context
 * establishment requires a real, recorded session; a missing/legacy sessionId
 * fails closed.
 *
 * Returns a decision; performs the establishing write ONLY when allowed. Callers
 * MUST treat `allowed:false` as a hard deny with zero downstream mutation.
 */
export async function establishOrganizationSessionContext(
  input: {
    userId: string;
    /** The Organization whose context is being established (POLICY + COUNT + LOCK
     *  scope). The concurrent-session limit is read from the ONE
     *  OrganizationSecurityPolicy keyed by this organizationId — never per-workspace. */
    organizationId: string;
    sessionIdHash: string;
    nowMs?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<ConcurrentSessionDecision> {
  return client.$transaction(async (tx) => {
    // (4) serialise per (userId, organizationId) across all API instances.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(input.userId, input.organizationId)}))`;

    // (1) re-load live Organization lifecycle; suspended/archived → no allowance.
    const org = await tx.organization.findUnique({
      where: { id: input.organizationId },
      select: { status: true },
    });
    if (!org || org.status !== "ACTIVE") {
      return { allowed: false, reason: "organization_suspended" };
    }

    // This session's inventory row (must exist — org context needs inventory).
    const session = await tx.authenticatedSession.findUnique({
      where: { userId_sessionIdHash: { userId: input.userId, sessionIdHash: input.sessionIdHash } },
      select: { id: true, organizationContextId: true, expiresAtUtc: true, revokedAtUtc: true },
    });
    const now = new Date(input.nowMs ?? Date.now());
    if (!session || session.revokedAtUtc !== null || session.expiresAtUtc <= now) {
      return { allowed: false, reason: "session_not_in_inventory" };
    }

    // (2) live policy limit — the ONE Organization policy (keyed by
    // organizationId). Not per-workspace: every workspace of the Org shares it.
    const policy = await resolveOrgSecurityPolicy(input.organizationId, tx as unknown as PrismaClient);
    const limit = policy.concurrentSessionLimit;

    // (6) IDEMPOTENT — this session already holds this Org's context → count once.
    if (session.organizationContextId === input.organizationId) {
      const activeCount = await countActiveOrgSessions(tx, input.userId, input.organizationId, now);
      return { allowed: true, established: false, activeCount, limit };
    }

    // (3)(4)(5) count DISTINCT active sessions already in this Org context,
    // excluding this session (it is not yet counted here). Expired/revoked are
    // excluded by the query.
    const activeCount = await countActiveOrgSessions(tx, input.userId, input.organizationId, now);

    // (7) locked deny behavior: fail-closed when at/over the limit.
    if (limit !== null && activeCount >= limit) {
      return { allowed: false, reason: "concurrent_session_limit_reached" };
    }

    // (8) persist the Organization session context (the count-authoritative write).
    await tx.authenticatedSession.update({
      where: { id: session.id },
      data: { organizationContextId: input.organizationId },
    });
    return { allowed: true, established: true, activeCount: activeCount + 1, limit };
  });
}

/**
 * PHASE 10 §2 — release this session's Organization context (switching into a
 * Personal/OWNED workspace, or otherwise leaving the org). Clears
 * `organizationContextId` so the session stops counting against that
 * Organization's limit. Scoped to THIS session's own row (no lock needed — it
 * only decrements its own prior context); a no-op when it held no org context.
 */
export async function releaseOrganizationSessionContext(
  input: { userId: string; sessionIdHash: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  await client.authenticatedSession.updateMany({
    where: { userId: input.userId, sessionIdHash: input.sessionIdHash, organizationContextId: { not: null } },
    data: { organizationContextId: null },
  });
}

/** Count active (non-expired, non-revoked) sessions holding this Org's context. */
async function countActiveOrgSessions(
  tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">,
  userId: string,
  organizationId: string,
  now: Date,
): Promise<number> {
  return tx.authenticatedSession.count({
    where: {
      userId,
      organizationContextId: organizationId,
      revokedAtUtc: null,
      expiresAtUtc: { gt: now },
    },
  });
}
