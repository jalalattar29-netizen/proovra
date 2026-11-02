/**
 * What still stands between a record and its destruction, read the way the
 * executor will read it (GOV-007, GOV-013).
 *
 * The operator's question ("can this be destroyed, and if not, when?") used to be
 * answered by the governance vocabulary, which knows nothing about storage. Object
 * Lock was only met at the executor, after approval had already queued the record
 * and blocked its downloads. This is not a second eligibility rule: it gathers the
 * same inputs from the same authorities and asks the canonical
 * `computeEvidenceDestructionEligibility`, so preview, approval and execution can
 * only disagree about what changed between them.
 *
 * The record is judged as if queued (PENDING_DESTRUCTION): a review on an ACTIVE
 * record is the governance path, and approval is what would queue it.
 *
 * GOV-005 — the Phase 4B template policies on /evidence-lifecycle/retention are
 * honoured here: `resolveEffectiveRetention` says how many years a record must be
 * kept, and destruction waits for them. Those policies have no record binding, so
 * they apply at this gate and nowhere else.
 */

import type { PrismaClient } from "@prisma/client";
import {
  computeEvidenceDestructionEligibility,
  type EvidenceLifecycleBlockReason,
} from "@proovra/shared";
import {
  evaluateEffectiveLegalHold,
  readRequiredObjectRetention,
  type EffectiveLegalHoldMatch,
} from "@proovra/shared-runtime";

import { apiEvidenceDestructionStorage } from "../evidence/destruction-storage-port.js";
import { resolveEffectiveRetention } from "../lifecycle/retention-engine.service.js";

export type DestructionBarrierReading = {
  alreadyDestroyed: boolean;
  eligible: boolean;
  blockReason: EvidenceLifecycleBlockReason | "RETENTION_POLICY_IMMUTABLE" | null;
  /** The earliest date every TIME barrier ends. A hold has no date. */
  eligibleAt: Date | null;
  legalHold: boolean;
  holds: readonly EffectiveLegalHoldMatch[];
  immutableRetention: boolean;
  storageRetentionTruth: string;
};

export async function readDestructionBarriers(
  client: PrismaClient,
  evidenceId: string,
  now: Date = new Date(),
): Promise<DestructionBarrierReading> {
  const row = await client.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      teamId: true,
      createdAt: true,
      lifecycleState: true,
      archivedAt: true,
      deletedAt: true,
      destroyedAtUtc: true,
      lockedAt: true,
      deleteScheduledForUtc: true,
      retentionUntilUtc: true,
      retentionPolicyVersionId: true,
      storageObjectLockMode: true,
      storageObjectLockRetainUntilUtc: true,
      caseLinks: { select: { caseId: true } },
    },
  });
  if (!row) {
    return {
      alreadyDestroyed: false,
      eligible: false,
      blockReason: "NOT_TRASHED",
      eligibleAt: null,
      legalHold: false,
      holds: [],
      immutableRetention: false,
      storageRetentionTruth: "UNAVAILABLE",
    };
  }
  if (row.lifecycleState === "DESTROYED" || row.destroyedAtUtc !== null) {
    return {
      alreadyDestroyed: true,
      eligible: false,
      blockReason: "TERMINAL_DESTROYED",
      eligibleAt: null,
      legalHold: false,
      holds: [],
      immutableRetention: false,
      storageRetentionTruth: "VERIFIED",
    };
  }

  // Unreadable hold state is a hold.
  let holds: readonly EffectiveLegalHoldMatch[] = [];
  let legalHold = true;
  try {
    const held = await evaluateEffectiveLegalHold(client, {
      teamId: row.teamId,
      evidenceId,
      caseIds: row.caseLinks.map((l) => l.caseId),
      collectAll: true,
    });
    holds = held.matches;
    legalHold = held.held;
  } catch {
    legalHold = true;
  }

  const reading = await readRequiredObjectRetention(client, evidenceId, apiEvidenceDestructionStorage, {
    objectLockExpected:
      String(process.env.S3_OBJECT_LOCK_ENABLED ?? "").trim().toLowerCase() === "true",
    now,
  });
  const openRestores = await client.evidenceArchiveRestoreRequest.count({
    where: { evidenceId, status: { in: ["REQUESTED", "RUNNING"] } },
  });

  // The named template retention, as one more application retention bound. A
  // policy read that fails is a bound with no date, never permission.
  let templateRetentionUntil: Date | null = null;
  if (row.teamId) {
    const template = await resolveEffectiveRetention({
      prisma: client,
      teamId: row.teamId,
      evidenceId,
    });
    if (template.effectiveYears > 0) {
      templateRetentionUntil = new Date(row.createdAt);
      templateRetentionUntil.setUTCFullYear(
        templateRetentionUntil.getUTCFullYear() + template.effectiveYears,
      );
    }
  }
  const appRetentionUntil =
    row.retentionUntilUtc && templateRetentionUntil
      ? new Date(Math.max(row.retentionUntilUtc.getTime(), templateRetentionUntil.getTime()))
      : row.retentionUntilUtc ?? templateRetentionUntil;

  const eligibility = computeEvidenceDestructionEligibility(
    {
      lifecycleState: "PENDING_DESTRUCTION",
      archivedAt: row.archivedAt,
      trashedAt: row.deletedAt,
      destroyedAt: row.destroyedAtUtc,
      lockedAt: row.lockedAt,
      trashGraceUntil: row.deleteScheduledForUtc,
      appRetentionUntil,
      objectLockRetainUntil: row.storageObjectLockRetainUntilUtc,
      objectLockMode: row.storageObjectLockMode,
      requiredObjectRetainUntil: reading.latestRequiredRetainUntil,
      storageRetentionTruth: reading.truth,
      archiveRestoreInProgress: openRestores > 0,
      legalHold: legalHold || reading.legalHoldVersion,
    },
    now,
  );

  let immutableRetention = false;
  if (row.retentionPolicyVersionId) {
    const version = await client.evidenceRetentionPolicyVersion.findUnique({
      where: { id: row.retentionPolicyVersionId },
      select: { immutable: true },
    });
    immutableRetention = version?.immutable === true;
  }

  return {
    alreadyDestroyed: false,
    eligible: eligibility.eligible && !immutableRetention,
    blockReason: eligibility.blockReason ?? (immutableRetention ? "RETENTION_POLICY_IMMUTABLE" : null),
    eligibleAt: eligibility.destructionEligibleAt,
    legalHold: eligibility.legalHold,
    holds,
    immutableRetention,
    storageRetentionTruth: reading.truth,
  };
}
