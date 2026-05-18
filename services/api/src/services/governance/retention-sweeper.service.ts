/**
 * Phase 14 — Retention reconciliation sweeper.
 *
 * Identifies expired evidence rows and flags / archives them
 * safely. Behavior:
 *
 *   - Walks evidence rows where `retentionUntilUtc <= now` and the
 *     row is NOT already archived / deleted.
 *   - For each candidate, runs the legal-hold inheritance resolver
 *     (per-record + case-level). If the evidence is held, the row
 *     is SKIPPED — never auto-deleted, never auto-archived. A
 *     DELETE_BLOCKED_BY_LEGAL_HOLD custody event is recorded so
 *     operators see the block.
 *   - For non-held candidates, the sweeper records a
 *     RETENTION_CANDIDATE_IDENTIFIED custody event and timestamps
 *     the evidence row so operators can triage. Phase 14 deliberately
 *     does NOT auto-delete — destructive deletion is deferred until
 *     the policy explicitly opts in.
 *
 * Idempotency: rows with `retentionReconciliationFlaggedAtUtc` set
 * in the last 24h are skipped. So repeated sweeps within the day
 * are no-ops; the next day re-flags so operators see "still
 * expired" signals.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { appendCustodyEvent } from "../custody-events.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { isEvidenceUnderAnyLegalHold } from "./case-legal-hold.service.js";

const FLAG_REISSUE_WINDOW_MS = 24 * 3600 * 1000;

export type ReconcileRetentionInput = {
  teamId?: string;
  batchSize?: number;
};

export type ReconcileRetentionSummary = {
  scanned: number;
  flagged: number;
  skippedHeld: number;
  skippedRecentlyFlagged: number;
  skippedAlreadyArchived: number;
  errors: number;
};

export async function reconcileRetention(
  input: ReconcileRetentionInput = {},
  client: PrismaClient = defaultPrisma,
): Promise<ReconcileRetentionSummary> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 2000);
  const now = new Date();
  const reissueCutoff = new Date(now.getTime() - FLAG_REISSUE_WINDOW_MS);

  const candidates = await client.evidence.findMany({
    where: {
      ...(input.teamId ? { teamId: input.teamId } : {}),
      retentionUntilUtc: { not: null, lte: now },
      deletedAt: null,
      // Skip rows already archived.
      archivedAt: null,
    },
    select: {
      id: true,
      teamId: true,
      caseId: true,
      retentionUntilUtc: true,
      retentionReconciliationFlaggedAtUtc: true,
      archivedAt: true,
      publicVerifyState: true,
    },
    take: batchSize,
    orderBy: { retentionUntilUtc: "asc" },
  });

  let flagged = 0;
  let skippedHeld = 0;
  let skippedRecentlyFlagged = 0;
  let skippedAlreadyArchived = 0;
  let errors = 0;

  for (const ev of candidates) {
    try {
      if (ev.archivedAt) {
        skippedAlreadyArchived += 1;
        continue;
      }
      if (
        ev.retentionReconciliationFlaggedAtUtc &&
        ev.retentionReconciliationFlaggedAtUtc > reissueCutoff
      ) {
        skippedRecentlyFlagged += 1;
        continue;
      }
      const held = await isEvidenceUnderAnyLegalHold(ev.id, client);
      if (held) {
        skippedHeld += 1;
        // Audit the block so reviewers can see retention pressure
        // was applied + blocked by hold.
        await appendCustodyEvent({
          evidenceId: ev.id,
          eventType: "DELETE_BLOCKED_BY_LEGAL_HOLD",
          payload: {
            reason: "retention_expired_but_under_legal_hold",
            retentionUntilUtc: ev.retentionUntilUtc?.toISOString() ?? null,
          },
        }).catch(() => null);
        continue;
      }
      // Mark the row as a retention candidate. NOT a deletion — the
      // operator still has to act in the /governance ops UI.
      await client.evidence.update({
        where: { id: ev.id },
        data: { retentionReconciliationFlaggedAtUtc: now },
      });
      await appendCustodyEvent({
        evidenceId: ev.id,
        eventType: "RETENTION_CANDIDATE_IDENTIFIED",
        payload: {
          retentionUntilUtc: ev.retentionUntilUtc?.toISOString() ?? null,
          // Operator-readable note; never destructive.
          reasonInternal: "retention_expired",
        },
      }).catch(() => null);
      flagged += 1;
    } catch {
      errors += 1;
    }
  }

  // Workspace-level signal so the /security or /governance UI can show
  // a sweeper-run heartbeat without trawling the custody chain.
  safeEmitSecurityEvent({
    teamId: input.teamId ?? null,
    // Phase 14 reuses existing SecurityEvent infrastructure; the
    // event type string is canonical via shared/security.ts.
    eventType: "reconciliation_triggered",
    severity: "INFO",
    details: {
      kind: "retention",
      scanned: candidates.length,
      flagged,
      skippedHeld,
      skippedRecentlyFlagged,
      skippedAlreadyArchived,
      errors,
    },
  });

  return {
    scanned: candidates.length,
    flagged,
    skippedHeld,
    skippedRecentlyFlagged,
    skippedAlreadyArchived,
    errors,
  };
}

// -----------------------------------------------------------------------------
// Read helpers for the operations UI.
// -----------------------------------------------------------------------------

export type RetentionCandidateRow = {
  id: string;
  retentionUntilUtc: string;
  retentionPolicySource: string | null;
  flaggedAtUtc: string | null;
  caseId: string | null;
  publicVerifyState: string;
};

export async function listRetentionCandidates(
  input: { teamId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<RetentionCandidateRow[]> {
  const rows = await client.evidence.findMany({
    where: {
      teamId: input.teamId,
      retentionReconciliationFlaggedAtUtc: { not: null },
      archivedAt: null,
      deletedAt: null,
    },
    select: {
      id: true,
      retentionUntilUtc: true,
      retentionPolicySource: true,
      retentionReconciliationFlaggedAtUtc: true,
      caseId: true,
      publicVerifyState: true,
    },
    orderBy: { retentionReconciliationFlaggedAtUtc: "desc" },
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
  return rows
    .filter((r) => r.retentionUntilUtc)
    .map((r) => ({
      id: r.id,
      retentionUntilUtc: (r.retentionUntilUtc as Date).toISOString(),
      retentionPolicySource: r.retentionPolicySource,
      flaggedAtUtc:
        r.retentionReconciliationFlaggedAtUtc?.toISOString() ?? null,
      caseId: r.caseId,
      publicVerifyState: r.publicVerifyState,
    }));
}
