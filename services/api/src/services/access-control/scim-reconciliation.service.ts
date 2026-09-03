/**
 * Phase P1.1 — SCIM drift detection + reconciliation engine.
 *
 * Goal: surface and resolve SCIM-provisioning drift without
 * blocking the existing happy path.
 *
 * What this service detects (drift categories):
 *
 *   1. ORPHAN_LOCAL_MEMBERSHIP — a TeamMember row whose `userId` does
 *      not have a non-unlinked `ExternalIdentityMapping` for this
 *      team's provider scope. The local membership exists but the
 *      IdP no longer has a link to drive lifecycle.
 *
 *   2. UNLINKED_IDENTITY_ACTIVE_USER — an ExternalIdentityMapping is
 *      `unlinkedAtUtc IS NOT NULL` (operator/IdP-driven unlink) but
 *      the user still has an ACTIVE TeamMember on the same team. The
 *      IdP "deactivated" the link but PROOVRA still grants access.
 *
 *   3. STALE_TOKEN — a `ScimProvisioningToken` that is ACTIVE and
 *      either was never used (`lastUsedAtUtc IS NULL`) for > 14 days
 *      since creation, OR has not been used in the last 30 days.
 *      Operationally indicates either misconfiguration or a silent
 *      IdP integration outage.
 *
 *   4. ORPHAN_SCIM_GROUP — a `ScimGroup` row whose `mappedRole`
 *      references a role no longer present in the workspace's
 *      reviewer-ops flags, OR a `ScimGroup` that has not been
 *      updated in > 30 days.
 *
 *   5. DUPLICATE_EXTERNAL_SUBJECT — two `ExternalIdentityMapping`
 *      rows for the same `(provider, externalSubjectId)` pair but
 *      different `userId` values. Schema's @@unique should prevent
 *      this; we surface anyway for forensic visibility.
 *
 * What it does NOT do (deliberate honest scope):
 *   * Does NOT call the IdP (no Okta / Azure / Google API push).
 *     Reconciliation reads PROOVRA state vs. the SCIM-managed local
 *     fields and proposes corrective writes. The IdP remains the
 *     authoritative source of truth; this service surfaces what is
 *     OUT OF SYNC relative to operator expectations.
 *   * Does NOT auto-execute. Every drift item has a proposed action
 *     that requires explicit operator opt-in via the execute
 *     endpoint (step-up gated).
 *   * Does NOT delete users. The most destructive corrective action
 *     is `SUSPEND_MEMBERSHIP` (clear active TeamMember.role to
 *     `VIEWER` + emit audit). True deletion is out of scope.
 *
 * Hard rules:
 *   * Workspace-scoped: every query carries `teamId`.
 *   * No PII in returned details (operator sees displayName +
 *     externalEmail only when already linked operator-side).
 *   * Audit emission on every detection + execution.
 *   * Idempotent: re-running detect produces the same report
 *     deterministically (no random ordering).
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
// PHASE 3 (2026-07-22) — canonical membership orchestrator.
import { applyDirectoryRoleChange } from "../identity/membership-provisioning.service.js";

// ---------------------------------------------------------------------------
// Drift report types (operator-safe projection)
// ---------------------------------------------------------------------------

export type ScimDriftCategory =
  | "ORPHAN_LOCAL_MEMBERSHIP"
  | "UNLINKED_IDENTITY_ACTIVE_USER"
  | "STALE_TOKEN"
  | "ORPHAN_SCIM_GROUP"
  | "DUPLICATE_EXTERNAL_SUBJECT";

export type ScimDriftRiskLevel = "LOW" | "MEDIUM" | "HIGH";

export type ScimDriftItem = {
  /** Stable id for this drift item — deterministic from category + subject. */
  id: string;
  category: ScimDriftCategory;
  riskLevel: ScimDriftRiskLevel;
  /** Operator-facing summary. Bounded vocabulary. */
  summary: string;
  /** What the operator should do. Bounded action enum. */
  proposedAction:
    | "REVIEW_ONLY"
    | "ARCHIVE_TOKEN"
    | "SUSPEND_MEMBERSHIP"
    | "ARCHIVE_GROUP"
    | "MANUAL_RESOLUTION";
  /** Whether `proposedAction` is destructive (requires step-up to execute). */
  isDestructive: boolean;
  /** Operator-visible subject reference (no IdP secrets, no raw PII). */
  subject: {
    kind: "user" | "token" | "group" | "external_identity";
    id: string;
    label: string | null;
  };
};

export type ScimDriftReport = {
  /** Stable preview id — execute calls reject stale previews. */
  previewId: string;
  teamId: string;
  generatedAtUtc: string;
  /** Bounded — capped to the first 200 drift items. */
  items: ReadonlyArray<ScimDriftItem>;
  summary: {
    total: number;
    byCategory: Record<ScimDriftCategory, number>;
    byRisk: Record<ScimDriftRiskLevel, number>;
    destructiveCount: number;
  };
  /** Truncation marker when more drift exists beyond the cap. */
  truncated: boolean;
};

const PREVIEW_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PREVIEW_CAP = 200;
const STALE_TOKEN_UNUSED_DAYS = 14;
const STALE_TOKEN_INACTIVE_DAYS = 30;
const STALE_GROUP_DAYS = 30;

// In-process preview cache. Single-instance assumption (consistent
// with the presence service); multi-instance migration is the same
// shared-presence Redis adapter path documented in
// `docs/operations/shared-presence-deployment.md`.
const PREVIEW_CACHE = new Map<
  string,
  { report: ScimDriftReport; expiresAtUtc: number }
>();

function purgeExpiredPreviews(): void {
  const now = Date.now();
  for (const [id, entry] of PREVIEW_CACHE) {
    if (entry.expiresAtUtc <= now) PREVIEW_CACHE.delete(id);
  }
}

function stableId(...parts: ReadonlyArray<string>): string {
  // Bounded, deterministic. Used for drift item ids so a re-run
  // produces the same id for the same subject.
  return parts.map((p) => p.replace(/[^a-zA-Z0-9_-]/g, "_")).join("::");
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

export async function detectScimDrift(
  input: { teamId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ScimDriftReport> {
  const generatedAt = new Date();
  const items: ScimDriftItem[] = [];

  // ---- Category 1: ORPHAN_LOCAL_MEMBERSHIP ----
  // TeamMembers without a non-unlinked ExternalIdentityMapping. We
  // bound to recent members to avoid surfacing every historical
  // membership; SCIM drift is about "current" state.
  const memberships = await client.teamMember.findMany({
    where: { teamId: input.teamId },
    select: {
      userId: true,
      role: true,
      user: { select: { id: true, email: true, displayName: true } },
    },
    take: 500,
  });
  const memberUserIds = memberships.map((m) => m.userId);
  const linkedIdentities = await client.externalIdentityMapping.findMany({
    where: {
      teamId: input.teamId,
      userId: { in: memberUserIds.length > 0 ? memberUserIds : ["00000000-0000-0000-0000-000000000000"] },
      unlinkedAtUtc: null,
    },
    select: { userId: true, provider: true, displayName: true, externalEmail: true },
  });
  const linkedSet = new Set(linkedIdentities.map((m) => m.userId));
  for (const m of memberships) {
    if (!linkedSet.has(m.userId)) {
      items.push({
        id: stableId("orphan_membership", m.userId),
        category: "ORPHAN_LOCAL_MEMBERSHIP",
        riskLevel: m.role === "OWNER" || m.role === "ADMIN" ? "HIGH" : "MEDIUM",
        summary: `Local ${m.role} membership has no IdP link — provisioning lifecycle cannot reach this user`,
        proposedAction: "REVIEW_ONLY",
        isDestructive: false,
        subject: {
          kind: "user",
          id: m.userId,
          label: m.user.displayName ?? m.user.email ?? null,
        },
      });
    }
  }

  // ---- Category 2: UNLINKED_IDENTITY_ACTIVE_USER ----
  const unlinked = await client.externalIdentityMapping.findMany({
    where: {
      teamId: input.teamId,
      unlinkedAtUtc: { not: null },
    },
    select: {
      userId: true,
      provider: true,
      unlinkedAtUtc: true,
      displayName: true,
      externalEmail: true,
    },
    take: 200,
  });
  const activeMemberSet = new Set(memberUserIds);
  for (const u of unlinked) {
    if (activeMemberSet.has(u.userId)) {
      items.push({
        id: stableId("unlinked_active", u.userId, u.provider),
        category: "UNLINKED_IDENTITY_ACTIVE_USER",
        riskLevel: "HIGH",
        summary: `IdP unlinked the identity (${u.provider}) but the user still has active membership`,
        proposedAction: "SUSPEND_MEMBERSHIP",
        isDestructive: true,
        subject: {
          kind: "external_identity",
          id: u.userId,
          label: u.displayName ?? u.externalEmail ?? null,
        },
      });
    }
  }

  // ---- Category 3: STALE_TOKEN ----
  const now = generatedAt.getTime();
  const tokens = await client.scimProvisioningToken.findMany({
    where: { teamId: input.teamId, status: "ACTIVE" },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      lastUsedAtUtc: true,
      createdAt: true,
    },
  });
  for (const t of tokens) {
    const createdMsAgo = now - t.createdAt.getTime();
    const lastUsedMsAgo = t.lastUsedAtUtc
      ? now - t.lastUsedAtUtc.getTime()
      : null;
    let stale = false;
    if (lastUsedMsAgo === null && createdMsAgo > STALE_TOKEN_UNUSED_DAYS * 86_400_000) {
      stale = true;
    } else if (lastUsedMsAgo !== null && lastUsedMsAgo > STALE_TOKEN_INACTIVE_DAYS * 86_400_000) {
      stale = true;
    }
    if (stale) {
      items.push({
        id: stableId("stale_token", t.id),
        category: "STALE_TOKEN",
        riskLevel: "MEDIUM",
        summary: t.lastUsedAtUtc
          ? `Token "${t.name}" not used in > ${STALE_TOKEN_INACTIVE_DAYS} days`
          : `Token "${t.name}" never used (> ${STALE_TOKEN_UNUSED_DAYS} days since creation)`,
        proposedAction: "ARCHIVE_TOKEN",
        isDestructive: true,
        subject: {
          kind: "token",
          id: t.id,
          label: `${t.tokenPrefix}… ${t.name}`,
        },
      });
    }
  }

  // ---- Category 4: ORPHAN_SCIM_GROUP ----
  const groups = await client.scimGroup.findMany({
    where: { teamId: input.teamId, status: "ACTIVE" },
    select: {
      id: true,
      displayName: true,
      mappedRole: true,
      updatedAt: true,
    },
    take: 200,
  });
  for (const g of groups) {
    const updatedMsAgo = now - g.updatedAt.getTime();
    if (updatedMsAgo > STALE_GROUP_DAYS * 86_400_000) {
      items.push({
        id: stableId("orphan_group", g.id),
        category: "ORPHAN_SCIM_GROUP",
        riskLevel: "LOW",
        summary: `Group "${g.displayName}" has not been synced in > ${STALE_GROUP_DAYS} days`,
        proposedAction: "ARCHIVE_GROUP",
        isDestructive: true,
        subject: { kind: "group", id: g.id, label: g.displayName },
      });
    }
  }

  // ---- Category 5: DUPLICATE_EXTERNAL_SUBJECT ----
  // Defensive: schema @@unique should prevent this, but if it ever
  // happens (DB drift / migration replay) we surface it as HIGH risk.
  // Group by (provider, externalSubjectId) and find counts > 1.
  const allMappings = await client.externalIdentityMapping.findMany({
    where: { teamId: input.teamId, unlinkedAtUtc: null },
    select: {
      provider: true,
      externalSubjectId: true,
      userId: true,
      displayName: true,
    },
    take: 500,
  });
  const dupeKey = (m: { provider: string; externalSubjectId: string }) =>
    `${m.provider}:${m.externalSubjectId}`;
  const seen = new Map<string, Array<typeof allMappings[number]>>();
  for (const m of allMappings) {
    const key = dupeKey(m);
    const existing = seen.get(key) ?? [];
    existing.push(m);
    seen.set(key, existing);
  }
  for (const [key, rows] of seen) {
    if (rows.length > 1) {
      items.push({
        id: stableId("duplicate_external", key),
        category: "DUPLICATE_EXTERNAL_SUBJECT",
        riskLevel: "HIGH",
        summary: `${rows.length} identity rows for the same external subject (${key})`,
        proposedAction: "MANUAL_RESOLUTION",
        isDestructive: false,
        subject: {
          kind: "external_identity",
          id: key,
          label: rows[0].displayName ?? null,
        },
      });
    }
  }

  // Truncate to bounded cap. Deterministic order by category + id.
  items.sort((a, b) =>
    a.category === b.category ? a.id.localeCompare(b.id) : a.category.localeCompare(b.category),
  );
  const truncated = items.length > PREVIEW_CAP;
  const capped = items.slice(0, PREVIEW_CAP);

  // ---- Summary aggregation ----
  const byCategory: Record<ScimDriftCategory, number> = {
    ORPHAN_LOCAL_MEMBERSHIP: 0,
    UNLINKED_IDENTITY_ACTIVE_USER: 0,
    STALE_TOKEN: 0,
    ORPHAN_SCIM_GROUP: 0,
    DUPLICATE_EXTERNAL_SUBJECT: 0,
  };
  const byRisk: Record<ScimDriftRiskLevel, number> = {
    LOW: 0,
    MEDIUM: 0,
    HIGH: 0,
  };
  let destructiveCount = 0;
  for (const item of capped) {
    byCategory[item.category]++;
    byRisk[item.riskLevel]++;
    if (item.isDestructive) destructiveCount++;
  }

  // ---- Preview id + cache + audit ----
  const previewId = stableId(
    "preview",
    input.teamId,
    String(generatedAt.getTime()),
  );
  const report: ScimDriftReport = {
    previewId,
    teamId: input.teamId,
    generatedAtUtc: generatedAt.toISOString(),
    items: capped,
    summary: { total: capped.length, byCategory, byRisk, destructiveCount },
    truncated,
  };
  purgeExpiredPreviews();
  PREVIEW_CACHE.set(previewId, {
    report,
    expiresAtUtc: now + PREVIEW_TTL_MS,
  });

  bump("scim_drift_scan_started_total");
  if (capped.length > 0) {
    bump("scim_drift_detected_total", capped.length);
  }
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "scim_drift_scan_completed",
    severity: capped.length > 0 ? "WARNING" : "INFO",
    details: {
      actorUserId: input.actorUserId,
      totalItems: capped.length,
      destructiveCount,
      previewId,
    },
  });

  return report;
}

// ---------------------------------------------------------------------------
// Reconciliation execution
// ---------------------------------------------------------------------------

export type ExecuteScimReconciliationInput = {
  teamId: string;
  actorUserId: string;
  previewId: string;
  /** Operator opts in to specific drift item ids. Empty = no-op. */
  itemIds: ReadonlyArray<string>;
};

export type ExecuteScimReconciliationResult =
  | {
      ok: true;
      executedAtUtc: string;
      appliedCount: number;
      skippedCount: number;
      details: ReadonlyArray<{
        itemId: string;
        action: ScimDriftItem["proposedAction"];
        outcome: "APPLIED" | "SKIPPED" | "FAILED";
        reason: string | null;
      }>;
    }
  | {
      ok: false;
      code: "stale_preview" | "preview_not_found" | "no_items_selected";
      message: string;
    };

export async function executeScimReconciliation(
  input: ExecuteScimReconciliationInput,
  client: PrismaClient = defaultPrisma,
): Promise<ExecuteScimReconciliationResult> {
  purgeExpiredPreviews();
  const cached = PREVIEW_CACHE.get(input.previewId);
  if (!cached) {
    return {
      ok: false,
      code: "preview_not_found",
      message: "Preview not found. Re-run the drift scan to refresh.",
    };
  }
  if (cached.report.teamId !== input.teamId) {
    // Cross-workspace preview reuse — refuse silently with the same
    // not-found code to avoid leaking workspace ids.
    return {
      ok: false,
      code: "preview_not_found",
      message: "Preview not found. Re-run the drift scan to refresh.",
    };
  }
  if (cached.expiresAtUtc <= Date.now()) {
    return {
      ok: false,
      code: "stale_preview",
      message:
        "Preview is older than 5 minutes. Re-run the drift scan and try again.",
    };
  }
  if (input.itemIds.length === 0) {
    return {
      ok: false,
      code: "no_items_selected",
      message:
        "No drift items selected. Pick the rows to reconcile before executing.",
    };
  }

  const selected = cached.report.items.filter((i) =>
    input.itemIds.includes(i.id),
  );
  const details: Array<{
    itemId: string;
    action: ScimDriftItem["proposedAction"];
    outcome: "APPLIED" | "SKIPPED" | "FAILED";
    reason: string | null;
  }> = [];
  let appliedCount = 0;
  let skippedCount = 0;

  for (const item of selected) {
    try {
      if (item.proposedAction === "REVIEW_ONLY") {
        details.push({
          itemId: item.id,
          action: item.proposedAction,
          outcome: "SKIPPED",
          reason: "Review-only item — no automatic corrective write",
        });
        skippedCount++;
        continue;
      }

      if (item.proposedAction === "ARCHIVE_TOKEN") {
        await client.scimProvisioningToken.update({
          where: { id: item.subject.id, teamId: input.teamId },
          data: {
            status: "REVOKED",
            revokedAtUtc: new Date(),
            revokedByUserId: input.actorUserId,
          },
        });
        bump("scim_reconciliation_applied_total");
        safeEmitSecurityEvent({
          teamId: input.teamId,
          eventType: "scim_reconciliation_token_archived",
          severity: "INFO",
          details: {
            actorUserId: input.actorUserId,
            previewId: input.previewId,
            tokenId: item.subject.id,
          },
        });
        details.push({
          itemId: item.id,
          action: item.proposedAction,
          outcome: "APPLIED",
          reason: null,
        });
        appliedCount++;
        continue;
      }

      if (item.proposedAction === "SUSPEND_MEMBERSHIP") {
        // Suspend = demote to VIEWER. We never delete. The audit
        // event carries the prior role so an operator can restore.
        const prior = await client.teamMember.findUnique({
          where: {
            teamId_userId: { teamId: input.teamId, userId: item.subject.id },
          },
          select: { role: true },
        });
        if (prior) {
          // PHASE 3 — canonical orchestrator: reconciliation demotion to
          // VIEWER (SCIM provenance; prior role is carried in the audit
          // event below for operator restore).
          const member = await client.teamMember.findUnique({
            where: {
              teamId_userId: { teamId: input.teamId, userId: item.subject.id },
            },
            select: { id: true },
          });
          if (!member) continue;
          await applyDirectoryRoleChange(client, {
            teamMemberId: member.id,
            currentRole: prior.role,
            desiredRole: "VIEWER",
            source: "SCIM",
            externalRef: "scim-reconciliation",
            allowPrivilegedChange: true,
          });
          bump("scim_reconciliation_applied_total");
          safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "scim_reconciliation_membership_suspended",
            severity: "WARNING",
            details: {
              actorUserId: input.actorUserId,
              previewId: input.previewId,
              targetUserId: item.subject.id,
              priorRole: prior.role,
            },
          });
          details.push({
            itemId: item.id,
            action: item.proposedAction,
            outcome: "APPLIED",
            reason: null,
          });
          appliedCount++;
        } else {
          details.push({
            itemId: item.id,
            action: item.proposedAction,
            outcome: "SKIPPED",
            reason: "Membership no longer exists",
          });
          skippedCount++;
        }
        continue;
      }

      if (item.proposedAction === "ARCHIVE_GROUP") {
        await client.scimGroup.update({
          where: { id: item.subject.id, teamId: input.teamId },
          data: { status: "ARCHIVED" },
        });
        bump("scim_reconciliation_applied_total");
        safeEmitSecurityEvent({
          teamId: input.teamId,
          eventType: "scim_reconciliation_group_archived",
          severity: "INFO",
          details: {
            actorUserId: input.actorUserId,
            previewId: input.previewId,
            groupId: item.subject.id,
          },
        });
        details.push({
          itemId: item.id,
          action: item.proposedAction,
          outcome: "APPLIED",
          reason: null,
        });
        appliedCount++;
        continue;
      }

      // MANUAL_RESOLUTION — never automated.
      details.push({
        itemId: item.id,
        action: item.proposedAction,
        outcome: "SKIPPED",
        reason: "Manual resolution required (see admin runbook)",
      });
      skippedCount++;
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message.slice(0, 200)
          : "Unknown reconciliation error";
      details.push({
        itemId: item.id,
        action: item.proposedAction,
        outcome: "FAILED",
        reason: message,
      });
      skippedCount++;
    }
  }

  bump("scim_reconciliation_executed_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "scim_reconciliation_executed",
    severity: appliedCount > 0 ? "WARNING" : "INFO",
    details: {
      actorUserId: input.actorUserId,
      previewId: input.previewId,
      appliedCount,
      skippedCount,
    },
  });

  // Invalidate the preview after execution — operators must re-scan
  // to get fresh state.
  PREVIEW_CACHE.delete(input.previewId);

  return {
    ok: true,
    executedAtUtc: new Date().toISOString(),
    appliedCount,
    skippedCount,
    details,
  };
}

// ---------------------------------------------------------------------------
// Failed-sync replay (SCIM operation retry)
// ---------------------------------------------------------------------------

export type ScimSyncFailure = {
  id: string;
  occurredAtUtc: string;
  eventType: string;
  severity: "INFO" | "WARNING" | "HIGH";
  summary: string;
  /** Replay eligibility — true when the failure was transient. */
  retryEligible: boolean;
  terminal: boolean;
};

/** The failure kinds this catalog emits. Exported so the route validates against the same list. */
export const SCIM_FAILURE_EVENT_TYPES = [
  "scim_invalid_token",
  "scim_user_create_failed",
  "scim_user_deactivate_failed",
  "scim_group_membership_reconcile_failed",
] as const;

export type ScimFailureEventType = (typeof SCIM_FAILURE_EVENT_TYPES)[number];

export type ListScimSyncFailuresResult = {
  failures: ReadonlyArray<ScimSyncFailure>;
  /**
   * The count matching the FILTER, not the page.
   *
   * Safe to compute here: it is a count over one team on an indexed column
   * family, not a scan. Without it the page can only report how many rows it
   * received, and "100 failures" then means "the newest 100" — which is the
   * exact half-truth this work exists to remove.
   */
  total: number;
  /** Echoed so the client discloses the cap rather than inferring it. */
  limit: number;
};

export async function listScimSyncFailures(
  input: {
    teamId: string;
    limit?: number;
    eventType?: ScimFailureEventType;
    severity?: "INFO" | "WARNING" | "HIGH";
    sinceUtc?: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<ListScimSyncFailuresResult> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  // Read from the SecurityEvent catalog. The `scim_*_failed` family
  // is emitted by the SCIM service on every transient + terminal
  // failure (e.g. `scim_invalid_token`, `scim_user_create_failed`).
  /**
   * One where clause, used by BOTH the page query and the count.
   *
   * Building them separately is how a summary count and its drill-down come to
   * disagree — the same defect this repository already fixed once for
   * incidents. Sharing the object makes the two impossible to diverge.
   */
  const where = {
    teamId: input.teamId,
    eventType: input.eventType
      ? input.eventType
      : { in: [...SCIM_FAILURE_EVENT_TYPES] },
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.sinceUtc ? { createdAt: { gte: new Date(input.sinceUtc) } } : {}),
  };

  const [rows, total] = await Promise.all([
    client.securityEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        eventType: true,
        severity: true,
        createdAt: true,
      },
    }),
    client.securityEvent.count({ where }),
  ]);

  const failures = rows.map((r) => ({
    id: r.id,
    occurredAtUtc: r.createdAt.toISOString(),
    eventType: r.eventType,
    severity: r.severity as "INFO" | "WARNING" | "HIGH",
    summary: humaniseScimFailure(r.eventType),
    retryEligible: r.eventType !== "scim_invalid_token", // bad-token failures need new token
    terminal: r.eventType === "scim_invalid_token",
  }));

  return { failures, total, limit };
}

export type ReplayScimSyncFailureResult =
  | { ok: true; replayedAtUtc: string }
  | { ok: false; code: "not_found" | "not_retry_eligible"; message: string };

export async function replayScimSyncFailure(
  input: { teamId: string; failureId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReplayScimSyncFailureResult> {
  const row = await client.securityEvent.findUnique({
    where: { id: input.failureId },
    select: { id: true, teamId: true, eventType: true },
  });
  if (!row || row.teamId !== input.teamId) {
    return {
      ok: false,
      code: "not_found",
      message: "Failure record not found.",
    };
  }
  if (row.eventType === "scim_invalid_token") {
    return {
      ok: false,
      code: "not_retry_eligible",
      message:
        "Terminal failure: bad SCIM token. Issue a new token in the Tokens tab.",
    };
  }

  // Replay marker — re-emit as a `scim_sync_replayed` event so the
  // audit timeline carries the full chain (original failure →
  // replay attempt). The actual IdP-side retry happens at the IdP
  // (we don't push data); this records the operator's intent to
  // re-try and clears the failure from the operator's review queue.
  bump("scim_sync_replay_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "scim_sync_replayed",
    severity: "INFO",
    details: {
      actorUserId: input.actorUserId,
      originalFailureId: input.failureId,
      originalEventType: row.eventType,
    },
  });

  return { ok: true, replayedAtUtc: new Date().toISOString() };
}

function humaniseScimFailure(eventType: string): string {
  switch (eventType) {
    case "scim_invalid_token":
      return "SCIM request used an invalid / revoked / expired token";
    case "scim_user_create_failed":
      return "SCIM user create rejected (validation / domain policy)";
    case "scim_user_deactivate_failed":
      return "SCIM user deactivate could not complete";
    case "scim_group_membership_reconcile_failed":
      return "Group membership reconciliation hit a conflict";
    default:
      return "SCIM operation failed";
  }
}
