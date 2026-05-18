/**
 * Phase 27.5 — Compliance Export Lineage Snapshots.
 *
 * Every compliance-grade export from the workspace gets a frozen
 * `GovernanceExportSnapshot` row. The snapshot captures the governance
 * state at the exact moment of export — lifecycle state, active holds,
 * effective retention policy version, governance incidents, and the
 * export-eligibility decision result.
 *
 * The snapshot is:
 *   - canonical-JSON serialized
 *   - SHA-256 hashed (`snapshotHash`)
 *   - persisted in `governance_export_snapshots` (forward-only)
 *
 * The caller (package builder / audit export / compliance bundler)
 * receives both the row and the canonical payload, so the bundle being
 * shipped to the operator can embed the lineage block alongside the
 * exported artifact.
 *
 * Hard rules:
 *   - NEVER carries privileged legal text. Hold rows are referenced by
 *     ID + status only; the `reason` column on EvidenceLegalHold is
 *     explicitly excluded from the snapshot payload.
 *   - Snapshot rows are forward-only. They are NEVER edited and NEVER
 *     deleted by the platform. An export does not need to "succeed" to
 *     be recorded — a BLOCKED outcome is still a recorded snapshot.
 *   - The snapshot is the canonical record of the export decision. The
 *     hash is reproducible from the payload; operators can re-verify
 *     by re-canonicalizing the payload and rehashing it.
 */

import type {
  PrismaClient,
  GovernanceExportSnapshot as DbSnapshot,
} from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  type ExportEligibilityResult,
  type GovernanceExportSnapshotKind,
  GOVERNANCE_EXPORT_SNAPSHOT_KINDS,
  GovernanceExportSnapshotInputSchema,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { canonicalJson, sha256Hex } from "../../crypto.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { checkExportEligibility } from "./export-governance.service.js";

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

export class GovernanceExportSnapshotError extends Error {
  constructor(
    public readonly code:
      | "EXPORT_SNAPSHOT_INVALID"
      | "EXPORT_SNAPSHOT_EVIDENCE_NOT_FOUND",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "GovernanceExportSnapshotError";
  }
}

// -----------------------------------------------------------------------------
// Snapshot payload — canonical JSON shape persisted on the row.
// -----------------------------------------------------------------------------

export type GovernanceExportSnapshotPayload = {
  kind: "governance_export_snapshot";
  version: 1;
  capturedAtUtc: string;
  teamId: string;
  snapshotKind: GovernanceExportSnapshotKind;
  evidenceId: string | null;
  lifecycleState: string;
  retentionPolicyVersionId: string | null;
  retentionPolicyId: string | null;
  retentionDays: number | null;
  retentionImmutable: boolean;
  /** Holds are referenced by ID + status only — never reason text. */
  activeHolds: ReadonlyArray<{
    id: string;
    placedAtUtc: string;
    caseId: string | null;
  }>;
  governanceIncidents: ReadonlyArray<{
    id: string;
    severity: string;
    status: string;
  }>;
  exportEligibility: ExportEligibilityResult;
  /** Pointer at the chain-of-custody anchor on the evidence, if any. */
  custodyAnchorHash: string | null;
};

// -----------------------------------------------------------------------------
// Projection
// -----------------------------------------------------------------------------

export type GovernanceExportSnapshotProjection = {
  id: string;
  teamId: string;
  evidenceId: string | null;
  snapshotKind: GovernanceExportSnapshotKind;
  createdByUserId: string | null;
  createdAt: string;
  lifecycleState: string;
  retentionPolicyVersionId: string | null;
  activeHoldIds: ReadonlyArray<string>;
  governanceIncidentIds: ReadonlyArray<string>;
  exportEligibilityOutcome: string;
  exportEligibilityReason: string;
  snapshotHash: string;
  snapshotPayload: GovernanceExportSnapshotPayload;
};

function projectSnapshot(row: DbSnapshot): GovernanceExportSnapshotProjection {
  return {
    id: row.id,
    teamId: row.teamId,
    evidenceId: row.evidenceId,
    snapshotKind: row.snapshotKind as GovernanceExportSnapshotKind,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    lifecycleState: row.lifecycleState,
    retentionPolicyVersionId: row.retentionPolicyVersionId,
    activeHoldIds: row.activeHoldIds,
    governanceIncidentIds: row.governanceIncidentIds,
    exportEligibilityOutcome: row.exportEligibilityOutcome,
    exportEligibilityReason: row.exportEligibilityReason,
    snapshotHash: row.snapshotHash,
    snapshotPayload: row.snapshotPayload as unknown as GovernanceExportSnapshotPayload,
  };
}

const VALID_KINDS = new Set<string>(GOVERNANCE_EXPORT_SNAPSHOT_KINDS);

// -----------------------------------------------------------------------------
// Capture — single entry point for any export pipeline.
// -----------------------------------------------------------------------------

export type CaptureExportSnapshotInput = {
  teamId: string;
  evidenceId: string | null;
  snapshotKind: GovernanceExportSnapshotKind;
  createdByUserId: string | null;
};

export async function captureExportSnapshot(
  input: CaptureExportSnapshotInput,
  client: PrismaClient = defaultPrisma,
): Promise<GovernanceExportSnapshotProjection> {
  const parsed = GovernanceExportSnapshotInputSchema.safeParse(input);
  if (!parsed.success || !VALID_KINDS.has(input.snapshotKind)) {
    throw new GovernanceExportSnapshotError("EXPORT_SNAPSHOT_INVALID", {
      detail: parsed.success ? null : parsed.error.flatten(),
    });
  }

  // Resolve the governance state we need to capture. When evidenceId is
  // null (case- or audit-level export) we still capture a workspace-
  // level snapshot — lifecycleState is reported as "WORKSPACE" and
  // holds list covers every ACTIVE hold in the workspace.
  let lifecycleState = "WORKSPACE";
  let retentionPolicyVersionId: string | null = null;
  let retentionPolicyId: string | null = null;
  let retentionDays: number | null = null;
  let retentionImmutable = false;
  let custodyAnchorHash: string | null = null;
  let exportEligibility: ExportEligibilityResult = {
    outcome: "ALLOWED",
    reason: "workspace_scope",
    lifecycleState: null,
  };
  let activeHolds: GovernanceExportSnapshotPayload["activeHolds"] = [];

  if (input.evidenceId) {
    const ev = await client.evidence.findFirst({
      where: { id: input.evidenceId, teamId: input.teamId },
      select: {
        id: true,
        caseId: true,
        lifecycleState: true,
        retentionPolicyVersionId: true,
        anchor: { select: { anchorHash: true } },
      },
    });
    if (!ev) {
      throw new GovernanceExportSnapshotError(
        "EXPORT_SNAPSHOT_EVIDENCE_NOT_FOUND",
      );
    }
    lifecycleState = ev.lifecycleState;
    retentionPolicyVersionId = ev.retentionPolicyVersionId;
    custodyAnchorHash = ev.anchor?.anchorHash ?? null;

    // Resolve effective policy version snapshot fields.
    if (retentionPolicyVersionId) {
      const version = await client.evidenceRetentionPolicyVersion.findUnique({
        where: { id: retentionPolicyVersionId },
        select: {
          retentionPolicyId: true,
          retentionDays: true,
          immutable: true,
        },
      });
      if (version) {
        retentionPolicyId = version.retentionPolicyId;
        retentionDays = version.retentionDays;
        retentionImmutable = version.immutable;
      }
    }

    // Active direct + case-level holds, IDs + placedAt only.
    const directHolds = await client.evidenceLegalHold.findMany({
      where: { evidenceId: ev.id, status: prismaPkg.LegalHoldStatus.ACTIVE },
      select: { id: true, placedAtUtc: true, caseId: true },
    });
    let caseHolds: Array<{ id: string; placedAtUtc: Date; caseId: string }> = [];
    if (ev.caseId) {
      const ch = await client.caseLegalHold.findMany({
        where: {
          caseId: ev.caseId,
          status: prismaPkg.CaseLegalHoldStatus.ACTIVE,
        },
        select: { id: true, placedAtUtc: true, caseId: true },
      });
      caseHolds = ch;
    }
    activeHolds = [
      ...directHolds.map((h) => ({
        id: h.id,
        placedAtUtc: h.placedAtUtc.toISOString(),
        caseId: h.caseId,
      })),
      ...caseHolds.map((h) => ({
        id: h.id,
        placedAtUtc: h.placedAtUtc.toISOString(),
        caseId: h.caseId,
      })),
    ];

    // Export-eligibility decision at this moment. Workspace-scope
    // snapshots default to ALLOWED above; per-evidence snapshots use
    // the canonical decision service.
    exportEligibility = await checkExportEligibility(
      {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        actorUserId: input.createdByUserId ?? null,
      },
      client,
    );
  } else {
    // Workspace-level — capture every ACTIVE direct hold.
    const directHolds = await client.evidenceLegalHold.findMany({
      where: { teamId: input.teamId, status: prismaPkg.LegalHoldStatus.ACTIVE },
      select: { id: true, placedAtUtc: true, caseId: true },
      take: 500,
    });
    activeHolds = directHolds.map((h) => ({
      id: h.id,
      placedAtUtc: h.placedAtUtc.toISOString(),
      caseId: h.caseId,
    }));
  }

  // Open governance incidents at the moment of capture (operator's
  // working set, capped).
  const governanceIncidents = await client.operationalIncident.findMany({
    where: {
      teamId: input.teamId,
      category: prismaPkg.IncidentCategory.GOVERNANCE,
      status: { in: [prismaPkg.IncidentStatus.OPEN, prismaPkg.IncidentStatus.ACKNOWLEDGED] },
      ...(input.evidenceId ? { relatedEvidenceId: input.evidenceId } : {}),
    },
    select: { id: true, severity: true, status: true },
    take: 50,
  });

  const capturedAtUtc = new Date().toISOString();
  const payload: GovernanceExportSnapshotPayload = {
    kind: "governance_export_snapshot",
    version: 1,
    capturedAtUtc,
    teamId: input.teamId,
    snapshotKind: input.snapshotKind,
    evidenceId: input.evidenceId,
    lifecycleState,
    retentionPolicyVersionId,
    retentionPolicyId,
    retentionDays,
    retentionImmutable,
    activeHolds,
    governanceIncidents: governanceIncidents.map((i) => ({
      id: i.id,
      severity: i.severity,
      status: i.status,
    })),
    exportEligibility,
    custodyAnchorHash,
  };
  const snapshotHash = sha256Hex(canonicalJson(payload));

  const row = await client.governanceExportSnapshot.create({
    data: {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      snapshotKind: input.snapshotKind as prismaPkg.GovernanceExportSnapshotKind,
      createdByUserId: input.createdByUserId,
      lifecycleState,
      retentionPolicyVersionId,
      activeHoldIds: activeHolds.map((h) => h.id),
      governanceIncidentIds: governanceIncidents.map((i) => i.id),
      exportEligibilityOutcome: exportEligibility.outcome,
      exportEligibilityReason: exportEligibility.reason.slice(0, 120),
      snapshotHash,
      snapshotPayload: payload as unknown as prismaPkg.Prisma.InputJsonValue,
    },
  });

  bump("governance_export_snapshot_created_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "governance_export_snapshot_created",
    severity: exportEligibility.outcome === "ALLOWED" ? "INFO" : "WARNING",
    evidenceId: input.evidenceId,
    details: {
      snapshotId: row.id,
      snapshotKind: input.snapshotKind,
      snapshotHash,
      exportEligibilityOutcome: exportEligibility.outcome,
    },
  });
  if (input.createdByUserId) {
    await appendPlatformAuditLog({
      userId: input.createdByUserId,
      action: "governance.export_snapshot.create",
      category: "governance",
      severity: exportEligibility.outcome === "ALLOWED" ? "info" : "warning",
      source: "export_lineage",
      outcome: "success",
      resourceType: "governance_export_snapshot",
      resourceId: row.id,
      metadata: {
        teamId: input.teamId,
        snapshotKind: input.snapshotKind,
        exportEligibilityOutcome: exportEligibility.outcome,
      },
      db: client,
    });
  }

  return projectSnapshot(row);
}

// -----------------------------------------------------------------------------
// Read
// -----------------------------------------------------------------------------

export async function getExportSnapshot(
  input: { teamId: string; id: string },
  client: PrismaClient = defaultPrisma,
): Promise<GovernanceExportSnapshotProjection | null> {
  const row = await client.governanceExportSnapshot.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  return row ? projectSnapshot(row) : null;
}

export async function listExportSnapshots(
  input: {
    teamId: string;
    snapshotKind?: GovernanceExportSnapshotKind;
    evidenceId?: string | null;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<GovernanceExportSnapshotProjection>> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const where: prismaPkg.Prisma.GovernanceExportSnapshotWhereInput = {
    teamId: input.teamId,
    ...(input.snapshotKind
      ? {
          snapshotKind:
            input.snapshotKind as prismaPkg.GovernanceExportSnapshotKind,
        }
      : {}),
    ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}),
  };
  const rows = await client.governanceExportSnapshot.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(projectSnapshot);
}

// -----------------------------------------------------------------------------
// Verify a snapshot hash — re-canonicalize the payload and rehash. The
// operator can call this to prove the row was not tampered after write.
// -----------------------------------------------------------------------------

export function verifyExportSnapshotHash(
  snapshot: GovernanceExportSnapshotProjection,
): boolean {
  const recomputed = sha256Hex(canonicalJson(snapshot.snapshotPayload));
  return recomputed === snapshot.snapshotHash;
}
