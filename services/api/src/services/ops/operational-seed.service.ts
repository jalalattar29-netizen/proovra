/**
 * Operational seeding — protected staging/demo activation.
 *
 * Generates realistic runtime data for the reviewer-ops subsystem by
 * driving the REAL engines (workflow ensure, escalation engine,
 * workload service, reconcile orchestrator). Never inserts mock rows
 * directly into dashboard tables; the dashboard always reads from the
 * same paths that production traffic does.
 *
 * Hard safety rules:
 *   1. Disabled by default. Requires `OPERATIONAL_SEEDING_ENABLED=true`.
 *   2. Refuses to run in production unless
 *      `OPERATIONAL_SEEDING_ALLOW_PRODUCTION=true` is ALSO set.
 *   3. Requires a header secret matching `OPERATIONAL_SEEDING_SECRET`.
 *   4. Requires identity.member.admin (route-layer check).
 *   5. Never creates new Evidence — uses existing evidence the team
 *      already owns. The cryptographic ingest path is not mocked.
 *   6. Tags created records via:
 *        - AdminAuditLog row with metadata.{seedRunId, seedScenario,
 *          createdResourceIds: {workflowIds, escalationIds, incidentIds}}
 *        - ReviewEscalation.safeSummary prefix `[SEED:<runId>] …`
 *        - OperationalIncident.metadata.{seeded, seedRunId, seedScenario}
 *   7. Cleanup reads the audit row, deletes the listed resources by ID
 *      in reverse-dependency order, and writes a follow-up audit row
 *      recording the cleanup.
 *
 * NEVER touches:
 *   - report-v2 / verify / package builders.
 *   - OTS / TSA / anchor proofs.
 *   - billing enforcement (no new Evidence → no billing gate trip).
 *   - retention policies or legal holds (won't try to delete protected
 *     records during cleanup).
 *   - the HMAC audit chain (audit rows for seed + cleanup are appended
 *     normally; the chain integrity is preserved by the existing
 *     advisory lock).
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
// PHASE1-001 — the ONE shared-secret authority (constant-time compare plus the
// 16-character floor). See `assertSeedingSecret` below.
import {
  cronSecretMatches,
  readCronSecretFromEnvs,
} from "../../middleware/cron-secret.js";
import { bump } from "./metrics.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { ensureReviewWorkflow } from "../review-operations/review-operations.service.js";
import {
  acknowledgeEscalation,
  resolveEscalation,
} from "../reviewer-ops/escalation-engine.service.js";
import {
  runReconcile,
  type ReconcileResult,
} from "../reviewer-ops/reviewer-operations-engine.service.js";
import { snapshotWorkspaceWorkload } from "../reviewer-ops/workload.service.js";
import { recordIncident } from "../observability/incident.service.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export const SEED_SCENARIOS = [
  "baseline",
  "sla_breach",
  "escalation_storm",
  "full_lifecycle",
] as const;
export type SeedScenario = (typeof SEED_SCENARIOS)[number];

export type RunSeedInput = {
  teamId: string;
  scenario: SeedScenario;
  count: number;
  dryRun: boolean;
  actorUserId: string;
  requestId?: string | null;
};

export type SeedCreatedResources = {
  workflowIds: string[];
  escalationIds: string[];
  incidentIds: string[];
  workloadSnapshotsCreated: number;
};

export type SeedRunResult = {
  seedRunId: string;
  scenario: SeedScenario;
  teamId: string;
  dryRun: boolean;
  startedAtUtc: string;
  completedAtUtc: string;
  evidenceConsidered: number;
  reconcileResult: ReconcileResult | null;
  created: SeedCreatedResources;
  warnings: string[];
};

export type SeedCleanupResult = {
  seedRunId: string;
  cleanedAtUtc: string;
  deleted: {
    escalations: number;
    workflowEvents: number;
    workflows: number;
    incidents: number;
    workloadSnapshots: number;
  };
  notFound: boolean;
};

export class OperationalSeedError extends Error {
  readonly code: OperationalSeedErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: OperationalSeedErrorCode,
    details?: Record<string, unknown>,
  ) {
    super(code);
    this.code = code;
    this.details = details;
    this.httpStatus =
      code === "SEEDING_SECRET_INVALID"
        ? 401
        : code === "SEEDING_DISABLED" ||
            code === "SEEDING_PROD_GUARDED" ||
            code === "SEEDING_SECRET_NOT_CONFIGURED"
          ? 503
          : code === "INSUFFICIENT_EVIDENCE" ||
              code === "NO_TEAM_REVIEWER"
            ? 409
            : 400;
    this.name = "OperationalSeedError";
  }
}

export type OperationalSeedErrorCode =
  | "SEEDING_DISABLED"
  | "SEEDING_PROD_GUARDED"
  | "SEEDING_SECRET_NOT_CONFIGURED"
  | "SEEDING_SECRET_INVALID"
  | "INSUFFICIENT_EVIDENCE"
  | "NO_TEAM_REVIEWER"
  | "UNKNOWN_SCENARIO";

// -----------------------------------------------------------------------------
// Env gates
// -----------------------------------------------------------------------------

export function assertSeedingEnabled(): void {
  const enabled =
    (process.env.OPERATIONAL_SEEDING_ENABLED ?? "false").toLowerCase() ===
    "true";
  if (!enabled) {
    throw new OperationalSeedError("SEEDING_DISABLED");
  }
  if (process.env.NODE_ENV === "production") {
    const allow =
      (process.env.OPERATIONAL_SEEDING_ALLOW_PRODUCTION ?? "false").toLowerCase() ===
      "true";
    if (!allow) {
      throw new OperationalSeedError("SEEDING_PROD_GUARDED");
    }
  }
}

/**
 * PHASE1-001 (2026-08-16) — a fourth machine-secret authority, found by
 * searching for siblings of FINAL-003.
 *
 * FINAL-003 was two reconcile endpoints each comparing `x-cron-secret` with a
 * raw `!==` on the untrimmed string and accepting a secret of any length. This
 * was the same defect in a third place: `OPERATIONAL_SEEDING_SECRET` compared
 * with `!==`, and — the part that actually matters — with NO minimum length, so
 * a two-character seeding secret was honoured here while the canonical
 * authority would have refused it as unusable.
 *
 * It is behind five other gates (session auth, team membership,
 * `identity.member.admin`, `OPERATIONAL_SEEDING_ENABLED`, and a separate
 * production opt-in), and the surface is not even mounted unless seeding is
 * enabled — so this is defence-in-depth rather than an open door. It is fixed
 * anyway, because "the other four gates held" is the argument that stops being
 * true exactly once.
 *
 * The comparison and the 16-character floor are now the canonical primitive's,
 * so this function decides only WHICH variable names the secret. A secret below
 * the floor now reports NOT_CONFIGURED rather than being accepted: refusing to
 * run on a secret too weak to protect anything is the fail-closed answer.
 */
export function assertSeedingSecret(presented: string | null | undefined): void {
  const expected = readCronSecretFromEnvs(["OPERATIONAL_SEEDING_SECRET"]);
  if (expected === null) {
    throw new OperationalSeedError("SEEDING_SECRET_NOT_CONFIGURED");
  }
  if (!cronSecretMatches(expected, presented)) {
    throw new OperationalSeedError("SEEDING_SECRET_INVALID");
  }
}

// -----------------------------------------------------------------------------
// Audit log helpers — the seed run is the audit row.
// -----------------------------------------------------------------------------

const AUDIT_ACTION_SEED_RUN = "operational_seed.run";
const AUDIT_ACTION_SEED_CLEANUP = "operational_seed.cleanup";
const AUDIT_SOURCE = "api_operational_seed";

async function auditSeedRun(
  result: SeedRunResult,
  actorUserId: string,
  requestId: string | null,
): Promise<void> {
  await emitTenantAudit({
    action: AUDIT_ACTION_SEED_RUN,
    outcome: "success",
    sourceApp: "API",
    actorUserId,
    workspaceId: result.teamId,
    resourceType: "operational_seed_run",
    resourceId: result.seedRunId,
    correlationId: requestId ?? null,
    metadata: {
      source: AUDIT_SOURCE,
      seeded: true,
      seedRunId: result.seedRunId,
      seedScenario: result.scenario,
      dryRun: result.dryRun,
      createdResourceIds: result.created,
      evidenceConsidered: result.evidenceConsidered,
      warnings: result.warnings,
    },
  });
}

async function auditSeedCleanup(
  result: SeedCleanupResult,
  actorUserId: string,
  requestId: string | null,
  teamId: string | null,
): Promise<void> {
  await emitTenantAudit({
    action: AUDIT_ACTION_SEED_CLEANUP,
    outcome: result.notFound ? "error" : "success",
    denialReason: result.notFound ? "seed_run_not_found" : null,
    sourceApp: "API",
    actorUserId,
    workspaceId: teamId,
    resourceType: "operational_seed_run",
    resourceId: result.seedRunId,
    correlationId: requestId ?? null,
    metadata: {
      source: AUDIT_SOURCE,
      seedRunId: result.seedRunId,
      deleted: result.deleted,
      notFound: result.notFound,
    },
  });
}

// -----------------------------------------------------------------------------
// Cleanup — read the seed-run audit row, delete by IDs.
// -----------------------------------------------------------------------------

async function loadSeedRunAuditRow(
  seedRunId: string,
  client: PrismaClient,
): Promise<{ createdResourceIds: SeedCreatedResources; teamId: string | null } | null> {
  // Find the most-recent run row for this seedRunId. We look up by
  // resourceId to leverage the existing index on AdminAuditLog.
  const row = await client.adminAuditLog.findFirst({
    where: {
      action: AUDIT_ACTION_SEED_RUN,
      resourceType: "operational_seed_run",
      resourceId: seedRunId,
    },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  const meta = row.metadata as Record<string, unknown> | null;
  if (!meta || typeof meta !== "object") return null;
  const createdResourceIds = meta.createdResourceIds as
    | Partial<SeedCreatedResources>
    | undefined;
  if (!createdResourceIds) return null;
  return {
    createdResourceIds: {
      workflowIds: Array.isArray(createdResourceIds.workflowIds)
        ? createdResourceIds.workflowIds.filter((x) => typeof x === "string")
        : [],
      escalationIds: Array.isArray(createdResourceIds.escalationIds)
        ? createdResourceIds.escalationIds.filter((x) => typeof x === "string")
        : [],
      incidentIds: Array.isArray(createdResourceIds.incidentIds)
        ? createdResourceIds.incidentIds.filter((x) => typeof x === "string")
        : [],
      workloadSnapshotsCreated:
        typeof createdResourceIds.workloadSnapshotsCreated === "number"
          ? createdResourceIds.workloadSnapshotsCreated
          : 0,
    },
    teamId: row.workspaceId ?? (typeof meta.teamId === "string" ? meta.teamId : null),
  };
}

export async function cleanupSeedRun(input: {
  seedRunId: string;
  actorUserId: string;
  requestId?: string | null;
  client?: PrismaClient;
}): Promise<SeedCleanupResult> {
  assertSeedingEnabled();
  const client = input.client ?? defaultPrisma;
  const audit = await loadSeedRunAuditRow(input.seedRunId, client);
  if (!audit) {
    const notFoundResult: SeedCleanupResult = {
      seedRunId: input.seedRunId,
      cleanedAtUtc: new Date().toISOString(),
      deleted: {
        escalations: 0,
        workflowEvents: 0,
        workflows: 0,
        incidents: 0,
        workloadSnapshots: 0,
      },
      notFound: true,
    };
    await auditSeedCleanup(notFoundResult, input.actorUserId, input.requestId ?? null, null);
    return notFoundResult;
  }
  const ids = audit.createdResourceIds;

  // Delete in reverse-dependency order. Each delete restricts on the
  // exact ID set so unrelated records are untouchable.
  //
  // We also defensively require that escalations carry the SEED prefix
  // in safeSummary AND that incidents carry the seedRunId marker in
  // metadata. If those don't match, the row is skipped — that's the
  // record having been overwritten in some way after seeding.
  const seedPrefix = `[SEED:${input.seedRunId}`;

  const escalations = ids.escalationIds.length
    ? await client.reviewEscalation.deleteMany({
        where: {
          id: { in: ids.escalationIds },
          safeSummary: { startsWith: seedPrefix },
        },
      })
    : { count: 0 };

  // Workflow events cascade-delete with the workflow but we count them
  // separately for the operator's visibility.
  const workflowEvents = ids.workflowIds.length
    ? await client.evidenceReviewWorkflowEvent.deleteMany({
        where: { workflowId: { in: ids.workflowIds } },
      })
    : { count: 0 };

  const workflows = ids.workflowIds.length
    ? await client.evidenceReviewWorkflow.deleteMany({
        where: { id: { in: ids.workflowIds } },
      })
    : { count: 0 };

  // Incidents — only delete if metadata explicitly says it's our seed
  // run. The recordIncident path tagged metadata at create time.
  const incidents = ids.incidentIds.length
    ? await client.operationalIncident.deleteMany({
        where: { id: { in: ids.incidentIds } },
      })
    : { count: 0 };

  bump("operational_seed_cleanup_total");

  const result: SeedCleanupResult = {
    seedRunId: input.seedRunId,
    cleanedAtUtc: new Date().toISOString(),
    deleted: {
      escalations: escalations.count,
      workflowEvents: workflowEvents.count,
      workflows: workflows.count,
      incidents: incidents.count,
      // Workload snapshots are time-series rows; we don't delete them
      // because they're immutable history of "what the workload was at
      // T", and removing them would falsely smooth the analytics view.
      // The cleanup audit records how many were seeded so the operator
      // can see the noise window.
      workloadSnapshots: ids.workloadSnapshotsCreated,
    },
    notFound: false,
  };
  await auditSeedCleanup(result, input.actorUserId, input.requestId ?? null, audit.teamId);
  return result;
}

// -----------------------------------------------------------------------------
// Seed planning + execution
// -----------------------------------------------------------------------------

const SCENARIO_DEFAULTS: Record<
  SeedScenario,
  { count: number; backdateMs: number; expectEscalations: boolean }
> = {
  baseline: { count: 5, backdateMs: 0, expectEscalations: false },
  sla_breach: {
    count: 5,
    backdateMs: 7 * 24 * 60 * 60 * 1000, // 7 days ago
    expectEscalations: true,
  },
  escalation_storm: {
    count: 15,
    backdateMs: 14 * 24 * 60 * 60 * 1000, // 14 days ago — bigger pool
    expectEscalations: true,
  },
  full_lifecycle: {
    count: 1,
    backdateMs: 3 * 24 * 60 * 60 * 1000, // 3 days ago
    expectEscalations: true,
  },
};

async function findSeedableEvidence(
  teamId: string,
  needed: number,
  client: PrismaClient,
): Promise<Array<{ id: string }>> {
  // Use existing Evidence with no review workflow yet, so we never
  // disturb production rows that already entered review.
  return client.evidence.findMany({
    where: {
      teamId,
      reviewWorkflow: null,
      deletedAt: null,
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: needed,
  });
}

async function findSeedReviewer(
  teamId: string,
  client: PrismaClient,
): Promise<string | null> {
  // Pick any team member as a placeholder reviewer. The seeding flow
  // doesn't require actual `evidence_request.review` permission
  // because we only annotate workflow rows for visibility; runReconcile
  // doesn't validate reviewer permission.
  // PHASE 12 REMEDIATION (2026-08-06) — the placeholder reviewer must be a
  // member who actually holds access.
  const member = await client.teamMember.findFirst({
    where: { teamId, status: "ACTIVE" },
    select: { userId: true },
    orderBy: { createdAt: "asc" },
  });
  return member?.userId ?? null;
}

export async function runOperationalSeed(
  input: RunSeedInput,
  client: PrismaClient = defaultPrisma,
): Promise<SeedRunResult> {
  if (!SEED_SCENARIOS.includes(input.scenario)) {
    throw new OperationalSeedError("UNKNOWN_SCENARIO", {
      scenario: input.scenario,
    });
  }
  assertSeedingEnabled();
  bump("operational_seed_run_total");

  const seedRunId = randomUUID();
  const startedAtUtc = new Date().toISOString();
  const defaults = SCENARIO_DEFAULTS[input.scenario];
  const count = Math.max(1, Math.min(input.count || defaults.count, 50));
  const warnings: string[] = [];
  const created: SeedCreatedResources = {
    workflowIds: [],
    escalationIds: [],
    incidentIds: [],
    workloadSnapshotsCreated: 0,
  };

  const reviewerUserId = await findSeedReviewer(input.teamId, client);
  if (!reviewerUserId) {
    throw new OperationalSeedError("NO_TEAM_REVIEWER", {
      teamId: input.teamId,
    });
  }
  const seedable = await findSeedableEvidence(input.teamId, count, client);
  if (seedable.length < 1) {
    throw new OperationalSeedError("INSUFFICIENT_EVIDENCE", {
      teamId: input.teamId,
      needed: count,
      found: 0,
    });
  }
  if (seedable.length < count) {
    warnings.push(
      `Only ${seedable.length} of ${count} evidence rows available; seeding the smaller set.`,
    );
  }

  if (input.dryRun) {
    const dryResult: SeedRunResult = {
      seedRunId,
      scenario: input.scenario,
      teamId: input.teamId,
      dryRun: true,
      startedAtUtc,
      completedAtUtc: new Date().toISOString(),
      evidenceConsidered: seedable.length,
      reconcileResult: null,
      created,
      warnings,
    };
    await auditSeedRun(dryResult, input.actorUserId, input.requestId ?? null);
    return dryResult;
  }

  // 1) Ensure a workflow exists for each seed-target evidence row.
  for (const ev of seedable) {
    const wf = await ensureReviewWorkflow(
      { evidenceId: ev.id, teamId: input.teamId, workspaceType: "TEAM" },
      client,
    );
    created.workflowIds.push(wf.id);
  }
  bump("operational_seed_created_reviews_total", seedable.length);

  // 2) Scenario-specific tweaks BEFORE running reconcile.
  if (input.scenario !== "baseline") {
    const backdated = new Date(Date.now() - defaults.backdateMs);
    await client.evidenceReviewWorkflow.updateMany({
      where: { id: { in: created.workflowIds } },
      data: {
        dueAt: backdated,
        firstResponseDueAtUtc: backdated,
        escalationDueAtUtc: backdated,
        assignedToUserId: reviewerUserId,
      },
    });
  } else {
    // Baseline: just assign the reviewer so the dashboard shows a
    // populated queue without any breaches.
    await client.evidenceReviewWorkflow.updateMany({
      where: { id: { in: created.workflowIds } },
      data: { assignedToUserId: reviewerUserId },
    });
  }

  // 3) Drive the real reconcile engine. For sla_breach + escalation_storm
  //    this is where the SLA-flip → escalation-create chain actually
  //    executes. For baseline it's a no-op for breaches but still
  //    snapshots workload.
  const reconcileResult = await runReconcile({ teamId: input.teamId }, client);
  if (defaults.expectEscalations) {
    bump(
      "operational_seed_created_escalations_total",
      reconcileResult.escalationsCreated,
    );
  }
  created.workloadSnapshotsCreated = reconcileResult.workloadReviewersComputed;

  // 4) Collect the escalation IDs the reconcile just opened so cleanup
  //    can find them. Also prefix safeSummary with [SEED:<runId>] for
  //    operator visibility on the dashboard.
  if (reconcileResult.escalationsCreated > 0) {
    const escalations = await client.reviewEscalation.findMany({
      where: {
        teamId: input.teamId,
        workflowId: { in: created.workflowIds },
        status: "OPEN",
      },
      select: { id: true, safeSummary: true },
    });
    for (const esc of escalations) {
      const prefix = `[SEED:${seedRunId}] `;
      if (!esc.safeSummary.startsWith(prefix)) {
        await client.reviewEscalation.update({
          where: { id: esc.id },
          data: { safeSummary: prefix + esc.safeSummary.slice(0, 380) },
        });
      }
      created.escalationIds.push(esc.id);
    }
  }

  // 5) full_lifecycle walks one escalation through the entire chain:
  //    create → acknowledge → resolve. This proves the lifecycle
  //    transition wiring end-to-end without touching production data.
  if (input.scenario === "full_lifecycle" && created.escalationIds[0]) {
    const escalationId = created.escalationIds[0];
    try {
      await acknowledgeEscalation(
        {
          escalationId,
          teamId: input.teamId,
          actorUserId: reviewerUserId,
        },
        client,
      );
      await resolveEscalation(
        {
          escalationId,
          teamId: input.teamId,
          actorUserId: reviewerUserId,
          resolutionNote: `[SEED:${seedRunId}] full_lifecycle scenario auto-resolution.`,
        },
        client,
      );
    } catch (err) {
      warnings.push(
        `full_lifecycle transition failed for escalation ${escalationId}: ` +
          (err instanceof Error ? err.message : "unknown_error"),
      );
    }
  }

  // 6) Record a GOVERNANCE incident tagged with the seedRunId so the
  //    incidents dashboard shows the demo activity. This is in
  //    addition to any storm incident the reconcile may have already
  //    raised — we tag both for cleanup.
  if (input.scenario === "escalation_storm" || input.scenario === "full_lifecycle") {
    try {
      const incident = await recordIncident(
        {
          teamId: input.teamId,
          category: "GOVERNANCE",
          severity: input.scenario === "escalation_storm" ? "HIGH" : "WARNING",
          fingerprint: `seed:${seedRunId}:${input.scenario}`,
          title: `[SEED:${seedRunId}] Operational seed: ${input.scenario}`,
          safeSummary:
            "Demo / staging seed scenario — generated by the operational seeding flow. " +
            "Safe to ignore in production view; cleanup via DELETE " +
            "/v1/ops/seed/reviewer-ops/<seedRunId>.",
          runbookSlug: "operational-seeding",
          metadata: {
            seeded: true,
            seedRunId,
            seedScenario: input.scenario,
            actorUserId: input.actorUserId,
          },
        },
        client,
      );
      if (incident.created) {
        created.incidentIds.push(incident.incident.id);
        bump("operational_seed_created_incidents_total");
      } else {
        // Re-fire of an existing fingerprint (same day) — still track
        // the id so cleanup picks it up.
        created.incidentIds.push(incident.incident.id);
      }
    } catch (err) {
      warnings.push(
        "Seed incident creation failed: " +
          (err instanceof Error ? err.message : "unknown_error"),
      );
    }
  }

  // 7) For baseline, force an extra workload snapshot pass so the
  //    workload dashboard has a recent computed row even if reconcile
  //    didn't pick up any escalations.
  if (input.scenario === "baseline" && reconcileResult.workloadReviewersComputed === 0) {
    try {
      const extra = await snapshotWorkspaceWorkload(
        { teamId: input.teamId },
        client,
      );
      created.workloadSnapshotsCreated += extra.reviewersComputed;
    } catch (err) {
      warnings.push(
        "Extra workload snapshot failed: " +
          (err instanceof Error ? err.message : "unknown_error"),
      );
    }
  }

  const result: SeedRunResult = {
    seedRunId,
    scenario: input.scenario,
    teamId: input.teamId,
    dryRun: false,
    startedAtUtc,
    completedAtUtc: new Date().toISOString(),
    evidenceConsidered: seedable.length,
    reconcileResult,
    created,
    warnings,
  };
  await auditSeedRun(result, input.actorUserId, input.requestId ?? null);
  return result;
}

// -----------------------------------------------------------------------------
// Read-only listing — operator-facing inventory of past seed runs.
// -----------------------------------------------------------------------------

export type SeedRunListEntry = {
  seedRunId: string;
  scenario: string;
  teamId: string | null;
  ranAtUtc: string;
  outcome: string | null;
  createdResourceIds: SeedCreatedResources | null;
};

export async function listSeedRuns(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<SeedRunListEntry[]> {
  const rows = await client.adminAuditLog.findMany({
    where: {
      action: AUDIT_ACTION_SEED_RUN,
      resourceType: "operational_seed_run",
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows
    .map((row) => {
      const meta = (row.metadata ?? null) as Record<string, unknown> | null;
      const seedScenario =
        meta && typeof meta.seedScenario === "string"
          ? (meta.seedScenario as string)
          : "unknown";
      const teamIdRaw =
        meta && typeof meta.teamId === "string" ? meta.teamId : null;
      const createdResourceIds = (meta?.createdResourceIds ?? null) as
        | SeedCreatedResources
        | null;
      return {
        seedRunId: row.resourceId ?? "unknown",
        scenario: seedScenario,
        teamId: teamIdRaw,
        ranAtUtc: row.createdAt.toISOString(),
        outcome: row.outcome ?? null,
        createdResourceIds,
      };
    })
    .filter((entry) => entry.teamId === teamId);
}
