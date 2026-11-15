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
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { checkExportEligibility } from "./export-governance.service.js";
import {
  holdInReach,
  incidentInReach,
  type ViewerReach,
} from "../access/record-reach.js";

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
  /**
   * A2-12 — true when hold or incident references to records closed to this
   * reader were withheld from `activeHoldIds`, `governanceIncidentIds` and the
   * payload. The stored row is untouched; `snapshotHash` covers the stored
   * payload, which the verify route re-hashes server-side.
   */
  payloadRedacted: boolean;
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
    payloadRedacted: false,
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
  /**
   * A2-12 — the creator's record reach (`viewerReachInWorkspace`). When given,
   * a record closed to the creator is refused exactly like a missing one, and
   * holds and incidents naming closed records or cases are not captured.
   */
  reach?: ViewerReach | null;
};

export async function captureExportSnapshot(
  input: CaptureExportSnapshotInput,
  client: PrismaClient = defaultPrisma,
): Promise<GovernanceExportSnapshotProjection> {
  // `reach` is the caller's authority, not part of the snapshot input contract.
  const parsed = GovernanceExportSnapshotInputSchema.safeParse({
    teamId: input.teamId,
    evidenceId: input.evidenceId,
    snapshotKind: input.snapshotKind,
    createdByUserId: input.createdByUserId,
  });
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
      where: { AND: [{ id: input.evidenceId, teamId: input.teamId }, input.reach?.evidence ?? {}] },
      select: {
        id: true,
        caseLinks: { select: { caseId: true }, take: 100 },
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
    // Track 1B closure — case-level holds are gathered from ALL linked
    // cases (canonical CaseEvidenceLink), not a single primary case.
    let caseHolds: Array<{ id: string; placedAtUtc: Date; caseId: string }> = [];
    const linkedCaseIds = ev.caseLinks.map((l) => l.caseId);
    if (linkedCaseIds.length > 0) {
      const ch = await client.evidenceLegalHold.findMany({
        // P12.3 canonical-only (scope='CASE').
        where: { scope: "CASE",
          caseId: { in: linkedCaseIds },
          status: prismaPkg.LegalHoldStatus.ACTIVE,
        },
        select: { id: true, placedAtUtc: true, caseId: true },
      });
      // scope='CASE' guarantees a case target; narrow rather than assert.
      caseHolds = ch.flatMap((h) =>
        h.caseId ? [{ id: h.id, placedAtUtc: h.placedAtUtc, caseId: h.caseId }] : [],
      );
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
      where: {
        teamId: input.teamId,
        status: prismaPkg.LegalHoldStatus.ACTIVE,
        AND: input.reach ? holdInReach(input.reach) : [],
      },
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
      AND: input.reach ? [incidentInReach(input.reach)] : [],
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
    await emitTenantAudit({
      action: "governance.export_snapshot.create",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.createdByUserId,
      workspaceId: input.teamId,
      resourceType: "governance_export_snapshot",
      resourceId: row.id,
      metadata: {
        snapshotKind: input.snapshotKind,
        exportEligibilityOutcome: exportEligibility.outcome,
      },
    }, client);
  }

  return projectSnapshot(row);
}

// -----------------------------------------------------------------------------
// Read
// -----------------------------------------------------------------------------

/**
 * A2-12 — a snapshot of a record closed to the reader is that record's row:
 * not listed, and answered like a missing snapshot. A workspace snapshot stays
 * readable; references inside it to closed records are withheld on projection.
 */
function snapshotInReachWhere(
  reach: ViewerReach | null | undefined,
): prismaPkg.Prisma.GovernanceExportSnapshotWhereInput[] {
  const hidden = reach?.hidden.evidenceIds ?? [];
  return hidden.length === 0
    ? []
    : [{ OR: [{ evidenceId: null }, { evidenceId: { notIn: hidden } }] }];
}

async function findSnapshotRowInReach(
  input: { teamId: string; id: string; reach?: ViewerReach | null },
  client: PrismaClient,
): Promise<DbSnapshot | null> {
  return client.governanceExportSnapshot.findFirst({
    where: { id: input.id, teamId: input.teamId, AND: snapshotInReachWhere(input.reach) },
  });
}

/**
 * Withhold, per reader, the hold and incident ids a snapshot names whose
 * record or case is closed to them — `holdInReach` / `incidentInReach` asked
 * from the other end (which of the NAMED rows are closed). The stored row is
 * never changed.
 */
async function projectSnapshotsForReader(
  rows: ReadonlyArray<DbSnapshot>,
  reach: ViewerReach | null | undefined,
  client: PrismaClient,
): Promise<GovernanceExportSnapshotProjection[]> {
  const projected = rows.map(projectSnapshot);
  if (!reach || (reach.hidden.evidenceIds.length === 0 && reach.hidden.caseIds.length === 0)) {
    return projected;
  }
  const holdIds = [...new Set(rows.flatMap((r) => r.activeHoldIds))];
  const incidentIds = [...new Set(rows.flatMap((r) => r.governanceIncidentIds))];
  const [closedHolds, closedIncidents] = await Promise.all([
    holdIds.length === 0
      ? Promise.resolve([] as Array<{ id: string }>)
      : client.evidenceLegalHold.findMany({
          where: {
            id: { in: holdIds },
            OR: [
              { evidenceId: { in: reach.hidden.evidenceIds } },
              { caseId: { in: reach.hidden.caseIds } },
            ],
          },
          select: { id: true },
        }),
    incidentIds.length === 0 || reach.hidden.evidenceIds.length === 0
      ? Promise.resolve([] as Array<{ id: string }>)
      : client.operationalIncident.findMany({
          where: { id: { in: incidentIds }, relatedEvidenceId: { in: reach.hidden.evidenceIds } },
          select: { id: true },
        }),
  ]);
  const closedHoldIds = new Set(closedHolds.map((h) => h.id));
  const closedIncidentIds = new Set(closedIncidents.map((i) => i.id));
  const closedCaseIds = new Set(reach.hidden.caseIds);
  return projected.map((p) => {
    const payload = p.snapshotPayload;
    const storedHolds = payload.activeHolds ?? [];
    const storedIncidents = payload.governanceIncidents ?? [];
    // A hold is closed when its row names a closed record or case, or when the
    // payload names a closed case for it (the row may since have moved).
    const closedHere = new Set([
      ...closedHoldIds,
      ...storedHolds.filter((h) => h.caseId !== null && closedCaseIds.has(h.caseId)).map((h) => h.id),
    ]);
    const holds = storedHolds.filter((h) => !closedHere.has(h.id));
    const incidents = storedIncidents.filter((i) => !closedIncidentIds.has(i.id));
    const activeHoldIds = p.activeHoldIds.filter((id) => !closedHere.has(id));
    const governanceIncidentIds = p.governanceIncidentIds.filter((id) => !closedIncidentIds.has(id));
    const redacted =
      activeHoldIds.length !== p.activeHoldIds.length ||
      governanceIncidentIds.length !== p.governanceIncidentIds.length ||
      holds.length !== storedHolds.length ||
      incidents.length !== storedIncidents.length;
    if (!redacted) return p;
    return {
      ...p,
      activeHoldIds,
      governanceIncidentIds,
      snapshotPayload: { ...payload, activeHolds: holds, governanceIncidents: incidents },
      payloadRedacted: true,
    };
  });
}

export async function getExportSnapshot(
  input: { teamId: string; id: string; reach?: ViewerReach | null },
  client: PrismaClient = defaultPrisma,
): Promise<GovernanceExportSnapshotProjection | null> {
  const row = await findSnapshotRowInReach(input, client);
  if (!row) return null;
  return (await projectSnapshotsForReader([row], input.reach, client))[0] ?? null;
}

/**
 * Re-hash the STORED payload of a snapshot the reader may open. A redacted
 * projection would not re-hash to `snapshotHash`, so verification reads the
 * row itself and answers only the verdict and the hash.
 */
export async function verifyStoredExportSnapshot(
  input: { teamId: string; id: string; reach?: ViewerReach | null },
  client: PrismaClient = defaultPrisma,
): Promise<{ snapshotId: string; valid: boolean; snapshotHash: string } | null> {
  const row = await findSnapshotRowInReach(input, client);
  if (!row) return null;
  return {
    snapshotId: row.id,
    valid: verifyExportSnapshotHash(projectSnapshot(row)),
    snapshotHash: row.snapshotHash,
  };
}

type SnapshotListInput = {
  teamId: string;
  snapshotKind?: GovernanceExportSnapshotKind;
  evidenceId?: string | null;
  limit?: number;
  before?: { createdAt: string; id: string };
  /** A2-12 — the reader's record reach; see `snapshotInReachWhere`. */
  reach?: ViewerReach | null;
};

async function queryExportSnapshots(
  input: SnapshotListInput,
  take: number,
  client: PrismaClient,
): Promise<ReadonlyArray<GovernanceExportSnapshotProjection>> {
  const where: prismaPkg.Prisma.GovernanceExportSnapshotWhereInput = {
    teamId: input.teamId,
    ...(input.snapshotKind ? { snapshotKind: input.snapshotKind as prismaPkg.GovernanceExportSnapshotKind } : {}),
    ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}),
    ...(input.before ? { OR: [
      { createdAt: { lt: new Date(input.before.createdAt) } },
      { createdAt: new Date(input.before.createdAt), id: { lt: input.before.id } },
    ] } : {}),
    AND: snapshotInReachWhere(input.reach),
  };
  const rows = await client.governanceExportSnapshot.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
  return projectSnapshotsForReader(rows, input.reach, client);
}

export async function listExportSnapshots(
  input: SnapshotListInput,
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<GovernanceExportSnapshotProjection>> {
  return queryExportSnapshots(input, Math.min(Math.max(input.limit ?? 100, 1), 500), client);
}

export async function listExportSnapshotsPage(
  input: SnapshotListInput,
  client: PrismaClient = defaultPrisma,
) {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = await queryExportSnapshots(input, limit + 1, client);
  const snapshots = rows.slice(0, limit);
  const last = snapshots.at(-1);
  const nextCursor = rows.length > limit && last
    ? Buffer.from(JSON.stringify({
        teamId: input.teamId,
        snapshotKind: input.snapshotKind ?? null,
        evidenceId: input.evidenceId ?? null,
        createdAt: last.createdAt,
        id: last.id,
      })).toString("base64url")
    : null;
  return { snapshots, nextCursor };
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
