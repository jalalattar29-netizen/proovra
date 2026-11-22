import * as prismaPkg from "@prisma/client";
import { prisma } from "./db.js";
import { resolveEvidenceOutputIssuance } from "./output-issuance.js";
// NEW-RG-13-2 — the one Worker reader of the entitlement facts (standing + lapse).
import { workerEntitlementFacts } from "./governance/workspace-entitlement.js";
import {
  getPlanCapabilities,
  resolveWorkspaceEffectivePlan,
  resolvePersonalEffectivePlan,
  type EvidenceFundingSource,
  type WorkspaceBillingStatus,
} from "@proovra/shared-billing";
// Domain classifier — single implementation in the general domain package.
import { firstIssuanceExemptFromStorageLimit, normalizeWorkspaceKind } from "@proovra/shared";
// PHASE 12 REMEDIATION §6.1 (2026-08-06) — the ONE seat-occupancy authority,
// shared with the API so their arithmetic cannot diverge.
import {
  countActiveSeatOccupancy,
  evidenceScopeFor,
  isAllowanceExcludedFirstIssuance,
  isKeyCompromiseReplacementVersion,
  measureFirstIssuanceAllowanceExclusion,
  liveWorkspaceWhere,
  lockWorkspaceCapacityTx,
  readActiveInternalPlanGrant,
  storageAddonCapacityStatusWhere,
  readEvidenceExchangeEntitlement,
  sumDerivedAssetStorageBytes,
  sumExchangePackageStorageBytes,
  sumLiveArtifactStorageReservationBytes,
  clearOwnDerivedAssetStorageReservationTx,
  writeDerivedAssetStorageReservationHeldTx,
  resolveDerivedAssetStorageIntentsTx,
  releaseDerivedAssetStorageReservation,
  renewDerivedAssetStorageReservation,
  derivedAssetReservationWriteDeadline,
  type DerivedAssetReservationKey,
  type DerivedAssetWriteTarget,
} from "@proovra/shared-runtime";

/**
 * AUD-0017 (TXP-023/024) — the client a scope or funding read runs on. A caller
 * holding an interactive transaction (the report and package commit admission)
 * passes its `tx`, so the reads use that connection instead of waiting on a
 * second one from the pool. Every other caller keeps the global client.
 */
export type WorkerDbClient = prismaPkg.Prisma.TransactionClient;

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
  /** Customer-facing: stored bytes minus `firstIssuanceExcludedBytes` (AUDIT D-03). */
  storageBytesUsed: bigint;
  /** AUDIT D-03 — bytes actually stored, before the Free first-issuance exclusion. */
  actualStorageBytes: bigint;
  /** AUDIT D-03 — first-issued outputs of entitled Free records (shared-runtime measure). */
  firstIssuanceExcludedBytes: bigint;
  evidenceStorageBytes: bigint;
  reportStorageBytes: bigint;
  verificationPackageStorageBytes: bigint;
  /** PRO-W1-07 — stored Evidence Exchange package ZIPs (shared-runtime sum). */
  exchangePackageStorageBytes: bigint;
  /** PRO-W1-06 — bytes artifact runs in flight have reserved (in `storageBytesUsed`). */
  reservedStorageBytes: bigint;
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

async function getActiveStorageAddonBytes(
  params: {
    ownerUserId: string;
    teamId?: string | null;
  },
  client: WorkerDbClient = prisma,
) {
  // The API's `storageAddonQuotaWhere`, stated per host. A row stamped with the
  // owner's PERSONAL workspace is the Personal subject too, or the storage gate
  // here refuses what the Billing meter shows and the API admits.
  const subject: prismaPkg.Prisma.WorkspaceStorageAddonWhereInput = params.teamId
    ? { teamId: params.teamId }
    : {
        OR: [
          { teamId: null },
          { team: { ownerUserId: params.ownerUserId, workspaceKind: prismaPkg.WorkspaceKind.PERSONAL } },
        ],
      };
  const aggregate = await client.workspaceStorageAddon.aggregate({
    where: {
      // PRO-BL1-04 / DEC-02 — the same capacity rule as the API meter: ACTIVE,
      // or PAST_DUE inside the one 7-day grace after its known paid period.
      AND: [{ ownerUserId: params.ownerUserId, ...subject }, storageAddonCapacityStatusWhere()],
    },
    _sum: {
      extraStorageBytes: true,
    },
  });

  return toBigIntOrZero(aggregate._sum.extraStorageBytes);
}

export async function getPersonalWorkspaceScope(
  ownerUserId: string,
  client: WorkerDbClient = prisma,
): Promise<WorkerWorkspaceScope> {
  const entitlement = await client.entitlement.findFirst({
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

  const activeStorageAddonBytes = await getActiveStorageAddonBytes(
    {
      ownerUserId,
      teamId: null,
    },
    client,
  );

  // F-09 (Free audit) — the same subject reached by team id reads its personal
  // Team row's `storage_bytes_override` (getTeamWorkspaceScope), and so does
  // the API's personal builder. Reached by user id (legacy NULL-team records)
  // the worker read nothing, so one subject had two storage allowances.
  const personalTeam = await client.team.findFirst({
    where: { ownerUserId, isPersonal: true },
    select: { storageBytesOverride: true },
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
  //
  // INTERNAL PLAN GRANT — the same shared policy and the same reader as the
  // API: the HIGHER of the provider-derived entitlement and an active grant.
  const internalGrant = await readActiveInternalPlanGrant(client, ownerUserId);
  const personalPlan = resolvePersonalEffectivePlan({
    providerPlan: (entitlement?.plan ?? prismaPkg.PlanType.FREE) as prismaPkg.PlanType,
    internalGrantPlan: (internalGrant?.plan ?? null) as prismaPkg.PlanType | null,
  }).plan as prismaPkg.PlanType;

  return {
    billingShape: "SINGLE_OCCUPANT",
    ownerUserId,
    teamId: null,
    plan: personalPlan,
    credits: entitlement?.credits ?? 0,
    teamSeats: entitlement?.teamSeats ?? 0,
    // A Personal Space is never governed by an organization contract.
    contractStorageBytes: null,
    storageBytesOverride: personalTeam?.storageBytesOverride ?? null,
    activeStorageAddonBytes,
  };
}

export async function getTeamWorkspaceScope(
  teamId: string,
  client: WorkerDbClient = prisma,
): Promise<WorkerWorkspaceScope> {
  const team = await client.team.findUnique({
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
  const ownerEntitlement = await client.entitlement.findFirst({
    where: { userId: team.ownerUserId, active: true },
    orderBy: { createdAt: "desc" },
    select: { plan: true },
  });
  const ownerPlan = ownerEntitlement?.plan ?? prismaPkg.PlanType.FREE;
  // INTERNAL PLAN GRANT — governs only the owner's PERSONAL workspace kind.
  const ownerInternalGrant = await readActiveInternalPlanGrant(client, team.ownerUserId);
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
    internalGrantPlan: (ownerInternalGrant?.plan ?? null) as prismaPkg.PlanType | null,
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
  const activeStorageAddonBytes = await getActiveStorageAddonBytes(
    {
      ownerUserId: team.ownerUserId,
      teamId: isPersonalSubject ? null : team.id,
    },
    client,
  );

  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — read the ACTIVE contract's
  // storage term. Deliberately a direct, bounded read rather than an import of
  // the API's resolver: the two hosts generate their own Prisma clients, and
  // the DECISION (contract wins when ACTIVE and stated, catalog default
  // otherwise) is the same rule stated in one place per host, exactly as the
  // effective-plan policy already is.
  const contract = team.organizationId
    ? await client.enterpriseContract.findUnique({
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

/**
 * An Enterprise workspace no ACTIVE contract governs takes no new AI spend
 * (BILLING-007). The API asks `enterpriseContractWithheld`; this host cannot
 * import it, so the rule is stated here too, as the storage term above is.
 */
export async function workspaceContractWithheld(teamId: string): Promise<boolean> {
  const scope = await getTeamWorkspaceScope(teamId);
  if (scope?.plan !== "ENTERPRISE") return false;
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { organizationId: true },
  });
  if (!team?.organizationId) return true;
  const contract = await prisma.enterpriseContract.findUnique({
    where: { organizationId: team.organizationId },
    select: { status: true },
  });
  return contract?.status !== "ACTIVE";
}

export async function resolveWorkspaceScopeForEvidence(
  params: {
    ownerUserId: string;
    teamId?: string | null;
  },
  client: WorkerDbClient = prisma,
): Promise<WorkerWorkspaceScope> {
  if (params.teamId) {
    return getTeamWorkspaceScope(params.teamId, client);
  }

  return getPersonalWorkspaceScope(params.ownerUserId, client);
}

export async function resolveEffectivePlanForEvidence(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<prismaPkg.PlanType> {
  const scope = await resolveWorkspaceScopeForEvidence(params);
  return scope.plan;
}

export async function getWorkspaceUsage(
  scope: WorkerWorkspaceScope,
  options: {
    /** PRO-W1-06 — the reservation transaction reads on its own connection. */
    client?: WorkerDbClient;
    /** PRO-W1-06 — the caller's own request: its reservation is not counted. */
    excludeReservationRequestId?: string | null;
  } = {},
): Promise<WorkerWorkspaceUsage> {
  const db: WorkerDbClient = options.client ?? prisma;
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
  //
  // F-02 (2026-11-13) — THE SAME POPULATION AS THE API'S USAGE MEASURE
  // (`evidenceScopeFor`, workspace-usage.service.ts): a PERSONAL workspace
  // widens to its owner's legacy NULL-team rows, and a scope reached without a
  // team (a legacy NULL-team record) is measured over its owner's personal
  // workspace. This host counted only `team_id = <personal team>` (or only the
  // NULL-team rows), so its storage gate saw fewer bytes than the API's for
  // the same payer.
  const personalOwnerUserId = scope.billingShape === "SINGLE_OCCUPANT" ? scope.ownerUserId : null;
  const usageTeamId =
    scope.teamId ??
    (personalOwnerUserId
      ? (
          await db.team.findFirst({
            where: { ownerUserId: personalOwnerUserId, isPersonal: true },
            select: { id: true },
          })
        )?.id ?? null
      : null);
  const populationWhere: prismaPkg.Prisma.EvidenceWhereInput = usageTeamId
    ? (evidenceScopeFor({
        physicalWorkspaceId: usageTeamId,
        workspaceKind: personalOwnerUserId ? "PERSONAL" : "ORGANIZATION",
        personalOwnerUserId,
      }) as prismaPkg.Prisma.EvidenceWhereInput)
    : { AND: [{ ownerUserId: scope.ownerUserId }, { teamId: null }] };
  const evidenceWhere: prismaPkg.Prisma.EvidenceWhereInput = {
    AND: [
      populationWhere,
      { lifecycleState: { notIn: ["DESTROYED", "RETENTION_ARCHIVED"] as prismaPkg.EvidenceLifecycleState[] } },
    ],
  };
  const reportWhere = { evidence: evidenceWhere };
  const verificationPackageWhere = { evidence: evidenceWhere };

  const [
    evidenceAggregate,
    reportAggregate,
    verificationPackageAggregate,
    evidenceCount,
    teamMemberCount,
    derivedStorageBytes,
    firstIssuanceExclusion,
    exchangePackageStorageBytes,
    reservedStorageBytes,
  ] = await Promise.all([
    db.evidence.aggregate({
      where: evidenceWhere,
      _sum: { sizeBytes: true },
    }),
    db.report.aggregate({
      where: reportWhere,
      _sum: { sizeBytes: true },
    }),
    // Every PUBLISHED package artifact (each profile is its own stored object).
    db.verificationPackage.aggregate({
      where: { ...verificationPackageWhere, state: "PUBLISHED" },
      _sum: { sizeBytes: true },
    }),
    db.evidence.count({
      where: evidenceWhere,
    }),
    // PHASE 12 REMEDIATION — COMM-001 (2026-08-06). This counted EVERY
    // TeamMember row regardless of status, so worker-side seat
    // reconciliation overstated occupancy by every suspended and revoked
    // member. It now uses the ONE shared occupancy authority, identical to
    // the API's — the two can no longer report different numbers for the
    // same workspace.
    scope.teamId
      ? countActiveSeatOccupancy({ teamId: scope.teamId }, db)
      : Promise.resolve(0),
    // UC-0 (D5) — same derived-bytes authority as the API, over the same
    // workspace (F-02: the owner's personal workspace for a NULL-team scope).
    sumDerivedAssetStorageBytes(db, { teamId: usageTeamId }),
    // AUDIT D-03 — the API's measure, over the same population and lifecycle
    // filter as the report and package sums above.
    measureFirstIssuanceAllowanceExclusion(db, evidenceWhere),
    // PRO-W1-07 (DEC-04) — exchange package ZIPs are customer-requested
    // derived artifacts: the API's sum, over the same workspace Team.
    sumExchangePackageStorageBytes(db, { teamId: usageTeamId }),
    // PRO-W1-06 — bytes other artifact runs have reserved and not yet
    // committed (live claims only); the API's meter adds the same sum.
    sumLiveArtifactStorageReservationBytes(db, {
      teamId: usageTeamId,
      excludeRequestId: options.excludeReservationRequestId ?? null,
    }),
  ]);

  const evidenceStorageBytes = toBigIntOrZero(evidenceAggregate._sum.sizeBytes);
  const reportStorageBytes = toBigIntOrZero(reportAggregate._sum.sizeBytes);
  const verificationPackageStorageBytes = toBigIntOrZero(
    verificationPackageAggregate._sum.sizeBytes
  );

  const actualStorageBytes =
    evidenceStorageBytes +
    reportStorageBytes +
    verificationPackageStorageBytes +
    derivedStorageBytes +
    exchangePackageStorageBytes;
  // AUDIT D-03 — the customer-facing figure the API gates and meters read:
  // originals once, an entitled Free record's first issuance left out.
  const firstIssuanceExcludedBytes =
    firstIssuanceExclusion.totalBytes < actualStorageBytes
      ? firstIssuanceExclusion.totalBytes
      : actualStorageBytes;
  // PRO-W1-06 — plus what runs in flight have reserved: not stored yet, but
  // already promised, so no gate on either host admits against it.
  const storageBytesUsed = actualStorageBytes - firstIssuanceExcludedBytes + reservedStorageBytes;

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
    actualStorageBytes,
    firstIssuanceExcludedBytes,
    evidenceStorageBytes,
    reportStorageBytes,
    verificationPackageStorageBytes,
    exchangePackageStorageBytes,
    reservedStorageBytes,
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
  /** PRO-W1-06 — see `getWorkspaceUsage`. */
  usageOptions?: Parameters<typeof getWorkspaceUsage>[1];
}) {
  const usage = await getWorkspaceUsage(params.scope, params.usageOptions);

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
      // AUDIT D-03 — refusal telemetry keeps the real stored bytes beside the
      // customer-facing figure the decision used.
      actualStorageBytes: usage.actualStorageBytes.toString(),
      firstIssuanceExcludedBytes: usage.firstIssuanceExcludedBytes.toString(),
      storageBytesLimit: usage.storageBytesLimit.toString(),
      incomingBytes: incoming.toString(),
      nextStorageBytes: nextValue.toString(),
      evidenceStorageBytes: usage.evidenceStorageBytes.toString(),
      reportStorageBytes: usage.reportStorageBytes.toString(),
      verificationPackageStorageBytes:
        usage.verificationPackageStorageBytes.toString(),
      exchangePackageStorageBytes: usage.exchangePackageStorageBytes.toString(),
      reservedStorageBytes: usage.reservedStorageBytes.toString(),
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
  client: WorkerDbClient = prisma,
): Promise<EvidenceFundingSource> {
  const entry = await client.evidenceCreditLedgerEntry.findUnique({
    where: { evidenceId },
    select: { entryType: true },
  });
  return entry?.entryType === "CONSUMPTION" ? "EVIDENCE_CREDIT" : "PLAN";
}

/**
 * An artifact gate without a record has nothing to ask the per-record
 * authority, and the old plan-only fallback answered a per-record question
 * from the plan (which grants every FREE workspace reports). Refused instead.
 */
function requireArtifactEvidenceId(evidenceId: string | null | undefined): string {
  if (typeof evidenceId !== "string" || evidenceId.trim().length === 0) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Output eligibility requires the evidence record",
    );
    err.statusCode = 409;
    err.code = "OUTPUT_ELIGIBILITY_UNRESOLVED";
    throw err;
  }
  return evidenceId;
}

export async function assertWorkspaceAllowsReportArtifact(params: {
  ownerUserId: string;
  teamId?: string | null;
  incomingBytes?: bigint | number | null;
  /**
   * The Evidence record this artifact belongs to — REQUIRED. Output
   * eligibility is a per-record question (funding, the stored earned fact,
   * lifecycle); there is no plan-only answer for an artifact, so a caller
   * without a record is refused rather than answered from the plan.
   */
  evidenceId: string;
  /**
   * F-02 — the report version this artifact is issued for (the reserved
   * version; the package's paired report version). Absent = gated as any
   * later artifact.
   */
  issuanceVersion?: number;
  /**
   * AUDIT D-01 (2026-11-14) — this run builds the version's verification
   * package after the report commits. A version that is not exempt is then
   * admitted against the PAIR (report bytes + the estimated package), so a
   * report that fits alone is not committed only for its package to be
   * refused, leaving the latest report without its package.
   */
  packagePairFollows?: boolean;
  /** PRO-W1-06 — the claimed request that holds this run's storage reservation. */
  reservation?: ArtifactStorageReservationHolder;
}) {
  const scope = await resolveWorkspaceScopeForEvidence(params);
  // FREE THREE-RECORD CONTRACT — a single record is answered by THE issuance
  // decision (funding, the stored earned fact, lifecycle), exactly as the
  // generation claim asked it; a plan-only answer here could refuse a record
  // the claim had just entitled (or entitle a FREE record outside the three).
  const outputs = await resolveEvidenceOutputIssuance({
    id: requireArtifactEvidenceId(params.evidenceId),
    ownerUserId: params.ownerUserId,
    teamId: params.teamId ?? null,
  });

  if (!outputs.reportsIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Report generation is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "REPORT_NOT_INCLUDED";
    throw err;
  }

  const admitted = await assertArtifactStorage({
    scope,
    incomingBytes: params.incomingBytes ?? 0n,
    evidenceId: params.evidenceId,
    issuanceVersion: params.issuanceVersion,
    outputs,
    pairEstimate:
      params.packagePairFollows === true && outputs.verificationPackageIncluded
        ? () => estimatePairedPackageBytes(params.evidenceId, params.issuanceVersion)
        : undefined,
    reservation: params.reservation,
  });

  return {
    scope,
    usage: admitted.usage,
    /**
     * PRO-W1-06 — what stays reserved once THIS artifact commits (the paired
     * package's estimate), or null when the run holds no reservation. The
     * report commit writes it in its own transaction.
     */
    reservedFollowingBytes: admitted.reservedFollowingBytes,
  };
}

/**
 * AUDIT D-01 — the package a new report version will be paired with, estimated
 * on the basis the API's NEW_VERSION offer uses (`estimateNewVersionStorage`,
 * output-recovery.service.ts): the published package bytes of the previous
 * report version (every profile: each is its own stored object, as the package
 * gate counts them), or, with no earlier package, the original evidence bytes
 * (FULL_FORENSIC embeds them). An unknown size estimates nothing.
 */
async function estimatePairedPackageBytes(evidenceId: string, version: number | undefined): Promise<bigint> {
  const previous = await prisma.verificationPackage.findFirst({
    where: {
      evidenceId,
      state: "PUBLISHED",
      ...(typeof version === "number" ? { version: { lt: version } } : {}),
    },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  if (previous) {
    const pair = await prisma.verificationPackage.aggregate({
      where: { evidenceId, state: "PUBLISHED", version: previous.version },
      _sum: { sizeBytes: true },
    });
    return toBigIntOrZero(pair._sum.sizeBytes);
  }
  const original = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: { sizeBytes: true },
  });
  return toBigIntOrZero(original?.sizeBytes);
}

/**
 * B5B-F-402 (free audit 0ea0) — would a rebuild of the package for this report
 * version now fit the customer-facing allowance? Asked by the package-recovery
 * sweep before it re-requests a package the storage gate already refused
 * (NOT_APPLICABLE_STORAGE_LIMIT): the producer decision has no storage input,
 * so without this the sweep rebuilt both ZIP profiles every tick only for the
 * gate to refuse them again. Same usage figure and same package estimate as
 * the gate's (`getWorkspaceUsage`, `estimatePairedPackageBytes`); the gate
 * still decides on the bytes actually built.
 */
export async function packageRebuildFitsStorage(params: {
  ownerUserId: string;
  teamId?: string | null;
  evidenceId: string;
  version: number;
}): Promise<boolean> {
  const scope = await resolveWorkspaceScopeForEvidence(params);
  const [usage, estimate] = await Promise.all([
    getWorkspaceUsage(scope),
    estimatePairedPackageBytes(params.evidenceId, params.version),
  ]);
  return usage.storageBytesUsed + estimate <= usage.storageBytesLimit;
}

/**
 * F-02 (2026-11-13) — the storage step of both artifact gates. The FIRST
 * issuance a record earned at finalization (its first report version and that
 * version's package pair) is owed by the product promise and is not refused
 * by the allowance (`firstIssuanceExemptFromStorageLimit`, @proovra/shared —
 * the API's offer reads the same rule). AUDIT D-03 — for an entitled FREE
 * record (stored FREE_ALLOWANCE fact) those bytes are also left out of the
 * customer-facing usage (`measureFirstIssuanceAllowanceExclusion`, applied in
 * `getWorkspaceUsage`); a paid-plan record's first issuance still counts.
 * Free audit 0ea0 — a credit-funded record's first issuance (B5B-F-403) and
 * the automatic chain-verified version of a covered record (B5B-F-400, request
 * purpose `ots_upgrade_completed`) are first issuance by the same shared rule
 * (`isAllowanceExcludedFirstIssuance`). Every other artifact is gated exactly
 * as before, against that same customer-facing usage.
 */
async function assertArtifactStorage(params: {
  scope: WorkerWorkspaceScope;
  incomingBytes: bigint | number;
  evidenceId: string;
  issuanceVersion: number | undefined;
  outputs: { decision: string; basis: string };
  /** AUDIT D-01 — bytes that will follow this artifact (its package), when not exempt. */
  pairEstimate?: () => Promise<bigint>;
  /** PRO-W1-06 — reserve the admitted bytes on this claimed request. */
  reservation?: ArtifactStorageReservationHolder;
}): Promise<{ usage: WorkerWorkspaceUsage; reservedFollowingBytes: bigint | null }> {
  const exempt = async () => ({ usage: await getWorkspaceUsage(params.scope), reservedFollowingBytes: null });
  const version = params.issuanceVersion;
  if (typeof version === "number" && Number.isInteger(version) && version >= 1) {
    const earlierReports = await prisma.report.count({
      where: { evidenceId: params.evidenceId, version: { lt: version } },
    });
    if (
      firstIssuanceExemptFromStorageLimit({
        decision: params.outputs.decision,
        basis: params.outputs.basis,
        isFirstReportVersion: earlierReports === 0,
      })
    ) {
      return exempt();
    }
    // AUDIT D-03 — the server-verified recovery of a proven-missing first-issued
    // file of an entitled FREE record (request purpose `missing_output_recovery`)
    // IS that first issuance: not customer storage, so never refused for it.
    // B5B-F-400 — so is the automatic chain-verified version (purpose
    // `ots_upgrade_completed`, machine principal) of such a record.
    if (
      params.outputs.decision === "ENTITLED" &&
      (await isAllowanceExcludedFirstIssuance(prisma, { evidenceId: params.evidenceId, version }))
    ) {
      return exempt();
    }
    // B7A-F-006 — the replacement PROOVRA owes after withdrawing a signing key
    // (request purpose `signing_key_compromise_replacement`, server-minted) is
    // not customer storage: `getWorkspaceUsage` leaves its bytes out
    // (`measureFirstIssuanceAllowanceExclusion`), and it is never refused for it.
    if (await isKeyCompromiseReplacementVersion(prisma, { evidenceId: params.evidenceId, version })) {
      return exempt();
    }
  }
  const following = params.pairEstimate ? await params.pairEstimate() : 0n;
  const own =
    typeof params.incomingBytes === "bigint"
      ? params.incomingBytes
      : BigInt(Math.max(0, Math.trunc(Number.isFinite(params.incomingBytes) ? params.incomingBytes : 0)));
  if (!params.reservation) {
    const usage = await assertWorkspaceStorageAvailable({ scope: params.scope, incomingBytes: own + following });
    return { usage, reservedFollowingBytes: null };
  }
  const usage = await reserveArtifactStorage({
    scope: params.scope,
    bytes: own + following,
    holder: params.reservation,
  });
  return { usage, reservedFollowingBytes: following };
}

/** PRO-W1-06 — the claimed request row that carries a run's storage reservation. */
export type ArtifactStorageReservationHolder = { requestId: string; claimedAtUtc: Date };

/** Bounded like the issuance transactions (F-37): the wait for the lock is inside it. */
const ARTIFACT_STORAGE_RESERVATION_TRANSACTION = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * WS-SCHED / PRO-W1-06 (DEC-04) — RESERVE the bytes of an artifact BEFORE any
 * of them is written, under the workspace's capacity lock (the lock the API's
 * admission and completion take): usage plus every other run's live
 * reservation is read on this transaction, and when the artifact fits its size
 * is recorded on the request this run holds. Two runs that jointly exceed are
 * serialized here, so exactly one is admitted; the other is refused with
 * STORAGE_LIMIT_REACHED having written nothing. The transaction ends before
 * the upload begins. A refusal, and a run whose claim is no longer its own,
 * leave no reservation behind.
 */
async function reserveArtifactStorage(params: {
  scope: WorkerWorkspaceScope;
  bytes: bigint;
  holder: ArtifactStorageReservationHolder;
}): Promise<WorkerWorkspaceUsage> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockWorkspaceCapacityTx(tx, params.scope);
      const usage = await assertWorkspaceStorageAvailable({
        scope: params.scope,
        incomingBytes: params.bytes,
        usageOptions: { client: tx, excludeReservationRequestId: params.holder.requestId },
      });
      const held = await tx.reportGenerationRequest.updateMany({
        where: { id: params.holder.requestId, state: "PROCESSING", claimedAtUtc: params.holder.claimedAtUtc },
        data: { storageReservedBytes: params.bytes },
      });
      if (held.count !== 1) {
        // The claim was taken over: this run may not publish at all.
        const lost: Error & { code?: string; retriable?: boolean } = new Error(
          `REPORT_CLAIM_LOST:${params.holder.requestId}`,
        );
        lost.code = "REPORT_CLAIM_LOST";
        lost.retriable = true;
        throw lost;
      }
      return usage;
    }, ARTIFACT_STORAGE_RESERVATION_TRANSACTION);
  } catch (err) {
    if ((err as { code?: string }).code === "STORAGE_LIMIT_REACHED") {
      // Refused: an earlier reservation of this request (its report's pair
      // estimate) must not keep counting against the workspace.
      await releaseArtifactStorageReservation(params.holder).catch(() => undefined);
    }
    throw err;
  }
}

/**
 * PRO-W1-06 — RELEASE this run's reservation (fenced by its claim; a run whose
 * claim was taken over releases nothing: the new holder owns the row). Called
 * when a run ends without committing what it reserved; the commit
 * transactions convert it themselves.
 */
export async function releaseArtifactStorageReservation(
  holder: ArtifactStorageReservationHolder,
  client: WorkerDbClient = prisma,
): Promise<void> {
  await client.reportGenerationRequest.updateMany({
    where: {
      id: holder.requestId,
      state: "PROCESSING",
      claimedAtUtc: holder.claimedAtUtc,
      storageReservedBytes: { not: null },
    },
    data: { storageReservedBytes: null },
  });
}

/**
 * PRO-W1-06 — inside a COMMIT transaction: the artifact's bytes are now a
 * committed row the meters count, so the reservation shrinks to what is still
 * to come (`remainingBytes`: the paired package's estimate after a report
 * commit) or ends (null / 0). Same transaction, so the bytes are never counted
 * twice and never uncounted.
 */
export async function settleArtifactStorageReservationTx(
  tx: WorkerDbClient,
  holder: ArtifactStorageReservationHolder,
  remainingBytes: bigint | null,
): Promise<void> {
  await tx.reportGenerationRequest.updateMany({
    where: {
      id: holder.requestId,
      state: "PROCESSING",
      claimedAtUtc: holder.claimedAtUtc,
      storageReservedBytes: { not: null },
    },
    data: { storageReservedBytes: remainingBytes !== null && remainingBytes > 0n ? remainingBytes : null },
  });
}

/**
 * WS-SCHED / PRO-W1-05, PRO-W1C-03 (DEC-04) — THE storage gate for a derived
 * object (thumbnail, frame, waveform, proxy, combined recording) BEFORE it is
 * written under the record's Object Lock. Those bytes count in workspace usage
 * (`sumDerivedAssetStorageBytes`, both hosts) and can never be deleted by the
 * customer, so they are admitted like any other customer-requested growth:
 * refused with STORAGE_LIMIT_REACHED when they would not fit. Reads, exports
 * and reductions are untouched. Returns false (refused) instead of throwing so
 * every producer settles its row the same way.
 *
 * M676 — no longer check-then-write. Under the workspace capacity lock (the
 * advisory lock the API's admission and completion and the worker's artifact
 * runs take) a SHORT transaction drops this row's own earlier reservation,
 * reads usage plus every live reservation (artifact runs and derived jobs),
 * and when the object fits records its size on the derived row
 * (`storage_reserved_bytes` / `storage_reserved_at_utc`). Two concurrent
 * derived jobs that jointly exceed the allowance are serialized here: exactly
 * one is admitted. The transaction ends before the caller uploads a byte. The
 * caller's settling `recordDerivedAsset` clears the reservation in the same
 * statement; an aborted job calls `releaseDerivedArtifactReservation`; a job
 * that died stops counting after DERIVED_ASSET_STORAGE_RESERVATION_TTL_MS.
 */
export async function workspaceAllowsDerivedArtifact(params: {
  evidenceId: string;
  incomingBytes: bigint | number;
  /**
   * The derived row (canonical identity) the reservation is held on. Absent:
   * the gate checks under the same workspace capacity lock but holds no
   * durable reservation. (The redaction page preview no longer asks this gate:
   * closure3/store admits and declares its bytes on its own row under the
   * same lock, redaction-page-preview-storage.ts.)
   */
  reservation?: Omit<DerivedAssetReservationKey, "evidenceId">;
}): Promise<{ allowed: true } | { allowed: false; reason: "storage_limit" | "evidence_not_found" }> {
  const verdict = await admitDerivedArtifact(params);
  return verdict.allowed ? { allowed: true } : verdict;
}

/**
 * M676 follow-up — what an admitted derived job HOLDS: the row, the database
 * stamp it wrote (its fence token), and the local time by which it must have
 * finished writing (`derivedAssetReservationWriteDeadline`). Renewed with
 * `renewDerivedArtifactReservation`, never assumed.
 */
export type DerivedArtifactReservationHold = {
  key: DerivedAssetReservationKey;
  reservedAtUtc: Date;
  writeDeadlineAt: number;
  /**
   * FINAL-VERIFY-2 closure — the durable intent of this attempt's declared
   * write (null: a plain reservation with no declared target). While OPEN it
   * keeps the bytes counted whatever happens to the reservation.
   */
  intentId?: string | null;
};

/**
 * M676 follow-up — `workspaceAllowsDerivedArtifact` for a producer that holds
 * a derived row: the same gate and reservation, returning the hold the
 * producer renews before and during its upload and fences its release with.
 */
export async function reserveDerivedArtifactStorage(params: {
  evidenceId: string;
  incomingBytes: bigint | number;
  reservation: Omit<DerivedAssetReservationKey, "evidenceId">;
  /**
   * FINAL-VERIFY-2 closure — the object the producer will write. Declared, it
   * gets a durable intent in the reservation's own statement, before any byte
   * is sent (every worker producer declares it).
   */
  target?: DerivedAssetWriteTarget;
}): Promise<
  | { allowed: true; hold: DerivedArtifactReservationHold }
  | { allowed: false; reason: "storage_limit" | "evidence_not_found" }
> {
  const verdict = await admitDerivedArtifact(params);
  if (!verdict.allowed) return verdict;
  if (!verdict.hold) throw new Error("derived_storage_reservation_not_held");
  return { allowed: true, hold: verdict.hold };
}

/**
 * M676 follow-up — RENEW a held reservation (database clock, fenced on the
 * holder's stamp). Null: the reservation is gone (settled, released, expired
 * or replaced) and the holder must stop writing. A database error throws: the
 * holder cannot prove its reservation and treats it like any transient
 * failure (nothing more is written).
 */
export async function renewDerivedArtifactReservation(
  hold: DerivedArtifactReservationHold,
): Promise<DerivedArtifactReservationHold | null> {
  const sentAt = Date.now();
  const stamp = await renewDerivedAssetStorageReservation(prisma, hold.key, hold.reservedAtUtc);
  if (!stamp) return null;
  return {
    key: hold.key,
    reservedAtUtc: stamp,
    writeDeadlineAt: derivedAssetReservationWriteDeadline(sentAt),
    intentId: hold.intentId ?? null,
  };
}

async function admitDerivedArtifact(params: {
  evidenceId: string;
  incomingBytes: bigint | number;
  reservation?: Omit<DerivedAssetReservationKey, "evidenceId">;
  target?: DerivedAssetWriteTarget;
}): Promise<
  | { allowed: true; hold: DerivedArtifactReservationHold | null }
  | { allowed: false; reason: "storage_limit" | "evidence_not_found" }
> {
  const ev = await prisma.evidence.findUnique({
    where: { id: params.evidenceId },
    select: { ownerUserId: true, teamId: true },
  });
  if (!ev) return { allowed: false, reason: "evidence_not_found" };
  const scope = await resolveWorkspaceScopeForEvidence({ ownerUserId: ev.ownerUserId, teamId: ev.teamId });
  const bytes =
    typeof params.incomingBytes === "bigint"
      ? params.incomingBytes
      : BigInt(Math.max(0, Math.trunc(Number.isFinite(params.incomingBytes) ? params.incomingBytes : 0)));
  const key: DerivedAssetReservationKey | null = params.reservation
    ? { ...params.reservation, evidenceId: params.evidenceId }
    : null;
  try {
    // M676 follow-up — the write deadline is measured from BEFORE the stamp.
    const sentAt = Date.now();
    const held = await prisma.$transaction(async (tx) => {
      await lockWorkspaceCapacityTx(tx, scope);
      if (key) await clearOwnDerivedAssetStorageReservationTx(tx, key);
      await assertWorkspaceStorageAvailable({ scope, incomingBytes: bytes, usageOptions: { client: tx } });
      // FINAL-VERIFY-2 closure — a declared target gets its durable intent in
      // the same statement as the reservation.
      return key ? await writeDerivedAssetStorageReservationHeldTx(tx, key, bytes, params.target ?? null) : null;
    }, ARTIFACT_STORAGE_RESERVATION_TRANSACTION);
    return {
      allowed: true,
      hold:
        key && held
          ? {
              key,
              reservedAtUtc: held.reservedAtUtc,
              writeDeadlineAt: derivedAssetReservationWriteDeadline(sentAt),
              intentId: held.intentId,
            }
          : null,
    };
  } catch (err) {
    if ((err as { code?: string }).code === "STORAGE_LIMIT_REACHED") {
      // Refused: an earlier reservation of this row (a crashed attempt) must
      // not keep counting against the workspace.
      if (key) await releaseDerivedAssetStorageReservation(prisma, key).catch(() => undefined);
      return { allowed: false, reason: "storage_limit" };
    }
    throw err;
  }
}

/**
 * M676 — an admitted derived job that ends WITHOUT its settling write (upload
 * failed, claim lost, record failed) gives its reservation back; a placeholder
 * row that never received an object is removed. Best effort: an unreleased
 * reservation stops counting at its TTL anyway.
 */
export async function releaseDerivedArtifactReservation(
  key: DerivedAssetReservationKey,
  /** M676 follow-up — the holder's stamp: release only its own reservation. */
  heldSince?: Date | null,
): Promise<void> {
  await releaseDerivedAssetStorageReservation(prisma, key, heldSince ?? null).catch(() => undefined);
}

/**
 * FINAL-VERIFY-2 closure — a holder that NEVER STARTED a write gives back its
 * reservation (fenced on its stamp) and resolves its intent RELEASED. Only for
 * a holder that sent no byte: once a write started, the intent leaves OPEN
 * only by settle, proven deletion, adoption or reconciliation. Best effort: an
 * unresolved intent keeps counting until the reconciler judges it.
 */
export async function releaseUnwrittenDerivedArtifactHold(hold: DerivedArtifactReservationHold): Promise<void> {
  await releaseDerivedArtifactReservation(hold.key, hold.reservedAtUtc);
  if (!hold.intentId) return;
  await resolveDerivedAssetStorageIntentsTx(prisma, {
    intentIds: [hold.intentId],
    state: "RELEASED",
    resolution: "write_never_started",
  }).catch(() => undefined);
}

export type ExchangeBuildAdmission =
  | { admitted: true }
  | {
      admitted: false;
      reason: "workspace_closed" | "organization_not_active" | "exchange_not_entitled";
    };

/**
 * WS-SCHED / PRO-W1-07 (DEC-04) — may an Evidence Exchange package build run
 * for this workspace NOW? Asked by the builder when it claims a build, instead
 * of trusting the BUILDING row the API wrote earlier:
 *
 *   - workspace liveness: the canonical predicate (`liveWorkspaceWhere`,
 *     Team.closedAtUtc) — a closed or missing workspace builds nothing;
 *   - organization status: ACTIVE, the rule every output run is admitted by
 *     (`decideRunAdmission`);
 *   - the FEATURE_EVIDENCE_EXCHANGE entitlement, re-read through the shared
 *     reader that is pinned against the API engine, with the Enterprise
 *     standing of this host's own commercial scope.
 *
 * Storage is deliberately NOT a refusal here: DEC-04 keeps authorized exports
 * available to a workspace over its allowance. The ZIP's bytes are counted
 * (`sumExchangePackageStorageBytes`), so they hold back later growth.
 */
export async function resolveExchangeBuildAdmission(
  teamId: string,
  client: WorkerDbClient = prisma,
): Promise<ExchangeBuildAdmission> {
  const team = await client.team.findFirst({
    where: { AND: [{ id: teamId }, liveWorkspaceWhere()] },
    select: { organizationId: true },
  });
  if (!team) return { admitted: false, reason: "workspace_closed" };
  const organization = team.organizationId
    ? await client.organization.findUnique({
        where: { id: team.organizationId },
        select: { status: true },
      })
    : null;
  if (!organization || organization.status !== "ACTIVE") {
    return { admitted: false, reason: "organization_not_active" };
  }
  // Matrix review NEW-RG-13-2 — the standing and the paid lapse come from the
  // ONE Worker reader every entitlement question uses (contract term end and
  // PRO-R3-07 lapse included); this admission used to read the contract status
  // alone and no lapse, so a PLAN grant still admitted a build after a terminal
  // lapse. A fact that cannot be read admits nothing (fail closed).
  let facts: Awaited<ReturnType<typeof workerEntitlementFacts>>;
  try {
    facts = await workerEntitlementFacts(teamId, client);
  } catch {
    return { admitted: false, reason: "exchange_not_entitled" };
  }
  const entitled = await readEvidenceExchangeEntitlement(client, { teamId, ...facts });
  return entitled ? { admitted: true } : { admitted: false, reason: "exchange_not_entitled" };
}

export async function assertWorkspaceAllowsVerificationPackageArtifact(params: {
  ownerUserId: string;
  teamId?: string | null;
  incomingBytes?: bigint | number | null;
  /** REQUIRED — see `assertWorkspaceAllowsReportArtifact`. */
  evidenceId: string;
  /** F-02 — see `assertWorkspaceAllowsReportArtifact`. */
  issuanceVersion?: number;
  /** PRO-W1-06 — the claimed request that holds this run's storage reservation. */
  reservation?: ArtifactStorageReservationHolder;
}) {
  const scope = await resolveWorkspaceScopeForEvidence(params);
  // FREE THREE-RECORD CONTRACT — a single record is answered by THE issuance
  // decision (funding, the stored earned fact, lifecycle), exactly as the
  // generation claim asked it; a plan-only answer here could refuse a record
  // the claim had just entitled (or entitle a FREE record outside the three).
  const outputs = await resolveEvidenceOutputIssuance({
    id: requireArtifactEvidenceId(params.evidenceId),
    ownerUserId: params.ownerUserId,
    teamId: params.teamId ?? null,
  });

  if (!outputs.verificationPackageIncluded) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Verification package is not included in the current plan"
    );
    err.statusCode = 409;
    err.code = "VERIFICATION_PACKAGE_NOT_INCLUDED";
    throw err;
  }

  const { usage } = await assertArtifactStorage({
    scope,
    incomingBytes: params.incomingBytes ?? 0n,
    evidenceId: params.evidenceId,
    issuanceVersion: params.issuanceVersion,
    outputs,
    reservation: params.reservation,
  });

  return {
    scope,
    usage,
  };
}