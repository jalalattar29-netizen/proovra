import * as prismaPkg from "@prisma/client";
import { prisma } from "./db.js";
import {
  getPlanCapabilities,
  resolveEvidenceOutputEntitlements,
  resolveWorkspaceEffectivePlan,
  type EvidenceFundingSource,
  type WorkspaceBillingStatus,
} from "@proovra/shared-billing";
// Domain classifier — single implementation in the general domain package.
import { normalizeWorkspaceKind } from "@proovra/shared";
// PHASE 12 REMEDIATION §6.1 (2026-08-06) — the ONE seat-occupancy authority,
// shared with the API so their arithmetic cannot diverge.
import { countActiveSeatOccupancy } from "@proovra/shared-runtime";

export type WorkerWorkspaceScope = {
  billingShape: "SINGLE_OCCUPANT" | "SHARED";
  ownerUserId: string;
  teamId: string | null;
  plan: prismaPkg.PlanType;
  credits: number;
  teamSeats: number;
  storageBytesOverride: bigint | null;
  activeStorageAddonBytes: bigint;
  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the CUSTOMER organization's
   * contracted cumulative storage, in bytes, when its contract is ACTIVE and
   * states one. `null` means the canonical catalog default applies.
   *
   * The worker enforces artifact storage on the SAME capacity the API does; it
   * previously used `PLAN_CAPABILITIES.ENTERPRISE.includedStorageBytes` — a
   * flat 500 GB placeholder — so an Enterprise workspace contracted for more
   * had its reports and verification packages refused by the worker while the
   * API accepted the evidence.
   */
  contractStorageBytes: bigint | null;
};

export type WorkerWorkspaceUsage = {
  storageBytesUsed: bigint;
  evidenceStorageBytes: bigint;
  reportStorageBytes: bigint;
  verificationPackageStorageBytes: bigint;
  evidenceCount: number;
  teamMemberCount: number;
  storageBytesLimit: bigint;
  storageBytesRemaining: bigint;
  storageUsageRatio: number;
};

function toBigIntOrZero(value: unknown): bigint {
  if (typeof value === "bigint") return value;

  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.max(0, Math.trunc(value)));
  }

  return 0n;
}

async function getActiveStorageAddonBytes(params: {
  ownerUserId: string;
  teamId?: string | null;
}) {
  const aggregate = await prisma.workspaceStorageAddon.aggregate({
    where: {
      ownerUserId: params.ownerUserId,
      teamId: params.teamId ?? null,
      status: {
        in: [
          prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
          prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
        ],
      },
    },
    _sum: {
      extraStorageBytes: true,
    },
  });

  return toBigIntOrZero(aggregate._sum.extraStorageBytes);
}

export async function getPersonalWorkspaceScope(
  ownerUserId: string
): Promise<WorkerWorkspaceScope> {
  const entitlement = await prisma.entitlement.findFirst({
    where: {
      userId: ownerUserId,
      active: true,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      plan: true,
      credits: true,
      teamSeats: true,
    },
  });

  const activeStorageAddonBytes = await getActiveStorageAddonBytes({
    ownerUserId,
    teamId: null,
  });

  // PHASE 12 — POINT 7 (2026-08-05). This used to mirror the API's
  // PERSONAL-scope "PRO upgrade": a TEAM-plan owner's personal space resolved
  // at PRO in BOTH processes, kept in sync by a comment pointing at a line
  // number. Parity was the right instinct and the wrong mechanism — it was two
  // copies of a commercial decision, and the decision itself invented a plan
  // the account does not hold. The API no longer substitutes, so neither does
  // the worker: the owner's entitlement plan IS the personal scope's plan,
  // which keeps API and worker agreeing on `REPORT_NOT_INCLUDED_IN_PLAN`
  // because they now read the same fact rather than reproduce the same
  // workaround. (TEAM includes reports, so the mismatch this guarded against
  // cannot reappear.)
  const personalPlan = entitlement?.plan ?? prismaPkg.PlanType.FREE;

  return {
    billingShape: "SINGLE_OCCUPANT",
    ownerUserId,
    teamId: null,
    plan: personalPlan,
    credits: entitlement?.credits ?? 0,
    teamSeats: entitlement?.teamSeats ?? 0,
    // A Personal Space is never governed by an organization contract.
    contractStorageBytes: null,
    storageBytesOverride: null,
    activeStorageAddonBytes,
  };
}

export async function getTeamWorkspaceScope(
  teamId: string
): Promise<WorkerWorkspaceScope> {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      ownerUserId: true,
      organizationId: true,
      billingPlan: true,
      billingStatus: true,
      includedSeats: true,
      storageBytesOverride: true,
      // §9.4 corrected — subject-aware policy inputs.
      workspaceKind: true,
      isPersonal: true,
    },
  });

  if (!team) {
    throw new Error("TEAM_NOT_FOUND_FOR_EVIDENCE");
  }

  // PHASE 9 §9.4/§9.11 CORRECTED (2026-07-22) — the worker uses the SAME
  // subject-correct canonical pure policy as the API
  // (`resolveWorkspaceEffectivePlan` + `normalizeWorkspaceKind`,
  // shared-billing; one implementation each). OWNED workspaces resolve from
  // their OWN commercial state only; the owner's entitlement participates
  // ONLY for the PERSONAL workspace kind (the personal-space subject — this
  // is what keeps personal captures on auto-bootstrapped personal teams
  // resolving at the owner's real plan).
  const ownerEntitlement = await prisma.entitlement.findFirst({
    where: { userId: team.ownerUserId, active: true },
    orderBy: { createdAt: "desc" },
    select: { plan: true },
  });
  const ownerPlan = ownerEntitlement?.plan ?? prismaPkg.PlanType.FREE;
  const workspaceKind = normalizeWorkspaceKind({
    workspaceKind: (team as { workspaceKind?: string | null }).workspaceKind ?? null,
    isPersonal: (team as { isPersonal?: boolean | null }).isPersonal ?? null,
    billingPlan: team.billingPlan,
    teamLoaded: true,
  });
  const effectivePlan = resolveWorkspaceEffectivePlan({
    workspaceKind,
    billingPlan: team.billingPlan as prismaPkg.PlanType,
    billingStatus: team.billingStatus as WorkspaceBillingStatus,
    ownerPlan: ownerPlan as prismaPkg.PlanType,
  }).plan as prismaPkg.PlanType;

  /*
   * A PERSONAL SPACE IS A TEAM ROW, HERE TOO.
   *
   * This function is reached by team id, and every evidence record carries one
   * since HOME-DATA-OWNERSHIP — including a personal record, which carries its
   * owner's personal Team. The kind above already knows the difference; two
   * fields below did not.
   *
   * The add-on lookup is the one that decides something. Storage add-ons are
   * keyed `(owner_user_id, team_id)` and a PERSONAL add-on is bought with no
   * team, so its row carries `team_id NULL`: asking by team id for a personal
   * subject matched nothing, and the worker's artifact-storage gate did not
   * see storage the customer had paid for. It is the same defect proven on the
   * API side, one host along — an allowance visible to one phase and invisible
   * to the next, for the same payer.
   */
  const isPersonalSubject = workspaceKind === "PERSONAL";
  const activeStorageAddonBytes = await getActiveStorageAddonBytes({
    ownerUserId: team.ownerUserId,
    teamId: isPersonalSubject ? null : team.id,
  });

  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — read the ACTIVE contract's
  // storage term. Deliberately a direct, bounded read rather than an import of
  // the API's resolver: the two hosts generate their own Prisma clients, and
  // the DECISION (contract wins when ACTIVE and stated, catalog default
  // otherwise) is the same rule stated in one place per host, exactly as the
  // effective-plan policy already is.
  const contract = team.organizationId
    ? await prisma.enterpriseContract.findUnique({
        where: { organizationId: team.organizationId },
        select: { status: true, storageGb: true },
      })
    : null;
  const contractStorageBytes =
    contract && contract.status === "ACTIVE" && (contract.storageGb ?? 0) > 0
      ? BigInt(contract.storageGb as number) * 1024n * 1024n * 1024n
      : null;

  return {
    /*
     * Derived, not asserted. This read "SHARED" for every subject, which was
     * wrong for a Personal Space and travelled into the STORAGE_LIMIT_REACHED
     * diagnostic — the one place an operator looks to find out whose limit was
     * reached. It decides nothing in this host; a diagnostic that misnames the
     * subject is still a diagnostic that sends someone to the wrong place.
     */
    billingShape: isPersonalSubject ? "SINGLE_OCCUPANT" : "SHARED",
    ownerUserId: team.ownerUserId,
    teamId: team.id,
    plan: effectivePlan,
    /*
     * The worker never settles a credit — settlement is the API's, inside the
     * completion transaction — so this is a shape requirement, not a balance.
     * Left at zero deliberately: a wallet that nothing here spends should not
     * be carried around looking spendable.
     */
    credits: 0,
    teamSeats: Math.max(0, team.includedSeats ?? 0),
    storageBytesOverride: team.storageBytesOverride ?? null,
    contractStorageBytes,
    activeStorageAddonBytes,
  };
}

export async function resolveWorkspaceScopeForEvidence(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<WorkerWorkspaceScope> {
  if (params.teamId) {
    return getTeamWorkspaceScope(params.teamId);
  }

  return getPersonalWorkspaceScope(params.ownerUserId);
}

export async function resolveEffectivePlanForEvidence(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<prismaPkg.PlanType> {
  const scope = await resolveWorkspaceScopeForEvidence(params);
  return scope.plan;
}

export async function getWorkspaceUsage(
  scope: WorkerWorkspaceScope
): Promise<WorkerWorkspaceUsage> {
  const caps = getPlanCapabilities(scope.plan);

  // STORAGE ACCOUNTING — EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24).
  //
  // These filters excluded `deletedAt != null`, so a record stopped counting
  // toward the workspace's storage the moment a user moved it to trash. Nothing
  // had left the bucket: trash is recoverable and the objects sit there for the
  // full 90-day grace window and then for however long retention, Object Lock
  // or a legal hold keeps them — which can be years. A workspace could
  // therefore trash its way under quota while its actual stored bytes never
  // moved, and the invoice, the quota gate and the bucket all disagreed.
  //
  // The line is now DESTROYED, which is the only state in which the bytes are
  // provably gone: the canonical executor writes it after verifying the objects
  // no longer exist. ACTIVE, ARCHIVED and TRASHED all consume storage, because
  // they all are storage.
  const evidenceWhere = scope.teamId
    ? {
        teamId: scope.teamId,
        lifecycleState: { not: "DESTROYED" as const },
      }
    : {
        ownerUserId: scope.ownerUserId,
        teamId: null,
        lifecycleState: { not: "DESTROYED" as const },
      };

  const reportWhere = scope.teamId
    ? {
        evidence: {
          teamId: scope.teamId,
          lifecycleState: { not: "DESTROYED" as const },
        },
      }
    : {
        evidence: {
          ownerUserId: scope.ownerUserId,
          teamId: null,
          lifecycleState: { not: "DESTROYED" as const },
        },
      };

  const verificationPackageWhere = scope.teamId
    ? {
        evidence: {
          teamId: scope.teamId,
          lifecycleState: { not: "DESTROYED" as const },
        },
      }
    : {
        evidence: {
          ownerUserId: scope.ownerUserId,
          teamId: null,
          lifecycleState: { not: "DESTROYED" as const },
        },
      };

  const [
    evidenceAggregate,
    reportAggregate,
    verificationPackageAggregate,
    evidenceCount,
    teamMemberCount,
  ] = await Promise.all([
    prisma.evidence.aggregate({
      where: evidenceWhere,
      _sum: { sizeBytes: true },
    }),
    prisma.report.aggregate({
      where: reportWhere,
      _sum: { sizeBytes: true },
    }),
    prisma.verificationPackage.aggregate({
      where: verificationPackageWhere,
      _sum: { sizeBytes: true },
    }),
    prisma.evidence.count({
      where: evidenceWhere,
    }),
    // PHASE 12 REMEDIATION — COMM-001 (2026-08-06). This counted EVERY
    // TeamMember row regardless of status, so worker-side seat
    // reconciliation overstated occupancy by every suspended and revoked
    // member. It now uses the ONE shared occupancy authority, identical to
    // the API's — the two can no longer report different numbers for the
    // same workspace.
    scope.teamId
      ? countActiveSeatOccupancy({ teamId: scope.teamId }, prisma)
      : Promise.resolve(0),
  ]);

  const evidenceStorageBytes = toBigIntOrZero(evidenceAggregate._sum.sizeBytes);
  const reportStorageBytes = toBigIntOrZero(reportAggregate._sum.sizeBytes);
  const verificationPackageStorageBytes = toBigIntOrZero(
    verificationPackageAggregate._sum.sizeBytes
  );

  const storageBytesUsed =
    evidenceStorageBytes + reportStorageBytes + verificationPackageStorageBytes;

// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — a contracted figure is the
  // base capacity; the catalog default applies only when the contract is
  // silent. Same rule as the API, so the two hosts cannot disagree about how
  // much room an Enterprise workspace has.
  const baseStorageBytesLimit =
    scope.contractStorageBytes ?? caps.includedStorageBytes;
const storageFromPlanAndAddons =
  baseStorageBytesLimit + scope.activeStorageAddonBytes;

const storageBytesLimit =
  scope.storageBytesOverride && scope.storageBytesOverride > 0n
    ? (scope.storageBytesOverride > storageFromPlanAndAddons
        ? scope.storageBytesOverride
        : storageFromPlanAndAddons)
    : storageFromPlanAndAddons;
    
  const storageBytesRemaining =
    storageBytesLimit > storageBytesUsed ? storageBytesLimit - storageBytesUsed : 0n;

  const ratio =
    storageBytesLimit > 0n
      ? Number(storageBytesUsed) / Number(storageBytesLimit)
      : 0;

  return {
    storageBytesUsed,
    evidenceStorageBytes,
    reportStorageBytes,
    verificationPackageStorageBytes,
    evidenceCount,
    teamMemberCount,
    storageBytesLimit,
    storageBytesRemaining,
    storageUsageRatio: Number.isFinite(ratio) ? ratio : 0,
  };
}

export async function assertWorkspaceStorageAvailable(params: {
  scope: WorkerWorkspaceScope;
  incomingBytes?: bigint | number | null;
}) {
  const usage = await getWorkspaceUsage(params.scope);

  const incoming =
    typeof params.incomingBytes === "bigint"
      ? params.incomingBytes
      : typeof params.incomingBytes === "number" && Number.isFinite(params.incomingBytes)
        ? BigInt(Math.max(0, Math.trunc(params.incomingBytes)))
        : 0n;

  const nextValue = usage.storageBytesUsed + incoming;

  if (nextValue > usage.storageBytesLimit) {
    const err: Error & {
      statusCode?: number;
      code?: string;
      details?: Record<string, unknown>;
    } = new Error("Storage limit reached");

    err.statusCode = 409;
    err.code = "STORAGE_LIMIT_REACHED";
    err.details = {
      billingShape: params.scope.billingShape,
      teamId: params.scope.teamId,
      ownerUserId: params.scope.ownerUserId,
      plan: params.scope.plan,
      storageBytesUsed: usage.storageBytesUsed.toString(),
      storageBytesLimit: usage.storageBytesLimit.toString(),
      incomingBytes: incoming.toString(),
      nextStorageBytes: nextValue.toString(),
      evidenceStorageBytes: usage.evidenceStorageBytes.toString(),
      reportStorageBytes: usage.reportStorageBytes.toString(),
      verificationPackageStorageBytes:
        usage.verificationPackageStorageBytes.toString(),
      activeStorageAddonBytes: params.scope.activeStorageAddonBytes.toString(),
    };

    throw err;
  }

  return usage;
}

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — how ONE Evidence record's
 * completion was funded, read from the canonical credit ledger.
 *
 * The worker needs this because the artifact gates below used to ask only
 * "does this workspace's PLAN include reports?" — which is FREE for every
 * evidence-credit buyer, so a record the customer had paid for was refused its
 * report and verification package by the worker even after the API had
 * enqueued them.
 *
 * This is a thin input ADAPTER, not a second authority: the DECISION lives in
 * `resolveEvidenceOutputEntitlements` (@proovra/shared-billing) and the API
 * reads the same ledger row through its own adapter.
 */
export async function resolveEvidenceFundingSource(
  evidenceId: string,
): Promise<EvidenceFundingSource> {
  const entry = await prisma.evidenceCreditLedgerEntry.findUnique({
    where: { evidenceId },
    select: { entryType: true },
  });
  return entry?.entryType === "CONSUMPTION" ? "EVIDENCE_CREDIT" : "PLAN";
}

export async function assertWorkspaceAllowsReportArtifact(params: {
  ownerUserId: string;
  teamId?: string | null;
  incomingBytes?: bigint | number | null;
  /**
   * The Evidence record this artifact belongs to. When supplied, a
   * credit-funded record earns its report regardless of the workspace plan.
   * Omitted only by callers that have no single record in hand.
   */
  evidenceId?: string | null;
}) {
  const scope = await resolveWorkspaceScopeForEvidence(params);
  const outputs = resolveEvidenceOutputEntitlements({
    plan: scope.plan,
    funding: params.evidenceId
      ? await resolveEvidenceFundingSource(params.evidenceId)
      : "PLAN",
  });

  if (!outputs.reportsIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Report generation is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "REPORT_NOT_INCLUDED";
    throw err;
  }

  const usage = await assertWorkspaceStorageAvailable({
    scope,
    incomingBytes: params.incomingBytes ?? 0n,
  });

  return {
    scope,
    usage,
  };
}

export async function assertWorkspaceAllowsVerificationPackageArtifact(params: {
  ownerUserId: string;
  teamId?: string | null;
  incomingBytes?: bigint | number | null;
  /** See `assertWorkspaceAllowsReportArtifact`. */
  evidenceId?: string | null;
}) {
  const scope = await resolveWorkspaceScopeForEvidence(params);
  const outputs = resolveEvidenceOutputEntitlements({
    plan: scope.plan,
    funding: params.evidenceId
      ? await resolveEvidenceFundingSource(params.evidenceId)
      : "PLAN",
  });

  if (!outputs.verificationPackageIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Verification package is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "VERIFICATION_PACKAGE_NOT_INCLUDED";
    throw err;
  }

  const usage = await assertWorkspaceStorageAvailable({
    scope,
    incomingBytes: params.incomingBytes ?? 0n,
  });

  return {
    scope,
    usage,
  };
}