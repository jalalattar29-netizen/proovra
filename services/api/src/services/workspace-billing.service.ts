import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { ensureEntitlement } from "./billing.service.js";
// §9.4 corrected — the canonical API classifier entry (delegates to the
// shared single implementation).
import { resolveWorkspaceKind } from "./identity/workspace-kind.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
import {
  type BillingWorkspaceScope,
  type WorkspaceScopeType,
  getEffectiveSeatLimit,
  assertWorkspacePlanCompatible,
  // PHASE 9 §9.4 — the canonical PURE commercial policy (the decisions
  // formerly made inline in this file now live in shared-billing).
  resolveWorkspaceEffectivePlan,
  type WorkspaceBillingStatus,
} from "@proovra/shared-billing";

export type WorkspaceScope = {
  workspaceType: WorkspaceScopeType;
  ownerUserId: string;
  teamId: string | null;
  /**
   * Phase A1 — Organization id for tenancy + governance inheritance.
   *
   * Resolution rules:
   *   * TEAM scope        → always the Team's organization_id (Stage 6
   *                         tightening guarantees it is non-null).
   *   * PERSONAL scope    → resolved from the bootstrap personal Team
   *                         when one exists; null in the legacy
   *                         "no personal team yet" case so existing
   *                         solo workflows remain functional.
   *
   * Write paths MUST persist `organizationId` exactly as returned
   * here, NEVER substitute `teamId` for it. The matching CHECK
   * constraint on `evidence` rejects the bad combination
   * `team_id IS NOT NULL AND organization_id IS NULL`, so a future
   * regression is database-rejected rather than silently accepted.
   */
  organizationId: string | null;
  plan: prismaPkg.PlanType;
  credits: number;
  teamSeats: number;
  storageBytesOverride: bigint | null;
  activeStorageAddonBytes: bigint;
  /**
   * Grandfather override for the lifetime evidence-record cap. Set on
   * the active Entitlement row for users that already exceeded the
   * new per-plan caps at migration time so existing records remain
   * accessible. `null` means "use the plan default". For TEAM-scope
   * scopes this is sourced from the team owner's entitlement.
   */
  legacyRecordCapOverride: number | null;
  /**
   * Email of the REQUESTING authenticated user, looked up server-side
   * from `users.email` by the enforcement chokepoint
   * (`resolveEnforcementScopeForRequester`). Observability metadata ONLY —
   * the email-based limit bypass was REMOVED in the Phase 9 final closure;
   * no commercial decision reads this field. Never sourced from a request
   * body, header, or query string.
   */
  authenticatedUserEmail?: string | null;
  /**
   * §9.7 (2026-07-22) — envelope-resolved effective limits, attached ONLY by
   * the enforcement chokepoint (`resolveEnforcementScopeForRequester`) from
   * `resolveCommercialContext(...).limits`. The raw
   * `legacyRecordCapOverride` above is a PERSISTED PROJECTION (class T) that
   * no consumer may interpret — the envelope is the single interpreter.
   */
  commercialLimits?: {
    effectiveLifetimeRecordCap: number | null;
    effectiveMonthlyRecordCap: number | null;
    source: "PLAN_DEFAULT" | "LEGACY_RECORD_CAP_OVERRIDE";
  };
  /**
   * §9.5 (2026-07-22) — envelope-resolved lifecycle verdict, attached by the
   * enforcement chokepoint. Paid-mutation asserts FAIL CLOSED when
   * `mutationsAllowed` is false (grace expired / cancelled / ambiguous
   * provider state). Reads/custody/legal-hold paths never consult this.
   */
  commercialLifecycle?: {
    state: string;
    paidActive: boolean;
    mutationsAllowed: boolean;
    graceEndsAtUtc: Date | null;
  };
};

function toBillingWorkspaceScope(scope: WorkspaceScope): BillingWorkspaceScope {
  return {
    workspaceType: scope.workspaceType,
    ownerUserId: scope.ownerUserId,
    teamId: scope.teamId,
    plan: scope.plan,
    credits: scope.credits,
    teamSeats: scope.teamSeats,
  };
}

async function getActiveWorkspaceStorageAddonBytes(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<bigint> {
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

  return aggregate._sum.extraStorageBytes ?? 0n;
}

export async function getPersonalWorkspaceScope(
  userId: string
): Promise<WorkspaceScope> {
  const [entitlement, activeStorageAddonBytes, personalTeam] =
    await Promise.all([
      ensureEntitlement(userId),
      getActiveWorkspaceStorageAddonBytes({
        ownerUserId: userId,
        teamId: null,
      }),
      // Phase A1 — read the personal Team (created by
      // `ensurePersonalWorkspace` on first authenticated request) so
      // we can return its organizationId. Read-only lookup; we never
      // bootstrap from this path. If the row does not exist yet,
      // organizationId stays null and the existing legacy
      // personal-mode behaviour is preserved.
      prisma.team.findFirst({
        where: { ownerUserId: userId, isPersonal: true },
        select: { organizationId: true },
      }),
    ]);

  // Phase HOME-DATA-OWNERSHIP — a TEAM-tier account still owns a
  // personal workspace. `getPlanCapabilities(TEAM).allowsPersonalWorkspace`
  // is false, and the previous behaviour was to let
  // assertWorkspacePlanCompatible THROW here — which 500'd
  // /v1/billing/overview and broke personal-scope resolution (incl.
  // capture) for every TEAM-plan account. The platform already treats
  // TEAM accounts as pro-grade (PRO_PLAN_KEYS = {PRO, TEAM} in
  // platform-context), so resolve the personal scope at PRO grade
  // instead of throwing. Team workspaces keep full TEAM semantics via
  // getTeamWorkspaceScope; this only affects the PERSONAL space.
  const personalPlan = getPlanCapabilities(entitlement.plan)
    .allowsPersonalWorkspace
    ? entitlement.plan
    : prismaPkg.PlanType.PRO;

  const scope: WorkspaceScope = {
    workspaceType: "PERSONAL",
    ownerUserId: userId,
    teamId: null,
    organizationId: personalTeam?.organizationId ?? null,
    plan: personalPlan,
    credits: entitlement.credits ?? 0,
    teamSeats: 0,
    storageBytesOverride: null,
    activeStorageAddonBytes,
    // Phase HOME-DATA-OWNERSHIP — `legacyRecordCapOverride` was
    // added by the pricing-hardening migration. The Prisma client
    // picks it up after `prisma generate`; the cast below survives
    // both pre- and post-generate states without weakening the
    // surrounding type.
    legacyRecordCapOverride:
      (entitlement as { legacyRecordCapOverride?: number | null })
        .legacyRecordCapOverride ?? null,
  };

  assertWorkspacePlanCompatible(toBillingWorkspaceScope(scope));
  return scope;
}

export async function getTeamWorkspaceScope(
  teamId: string
): Promise<WorkspaceScope> {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      ownerUserId: true,
      // Phase A1 — organization id is now NOT NULL at the schema
      // level (Stage 6). Selecting it explicitly here makes the
      // tenancy resolution path readable and lets the Phase B0
      // governance inheritance lookups consume the same scope object
      // without an additional join.
      organizationId: true,
      billingPlan: true,
      billingStatus: true,
      includedSeats: true,
      storageBytesOverride: true,
      // §9.4 corrected — the effective-plan policy is SUBJECT-AWARE; the
      // canonical kind inputs travel with the billing fields.
      workspaceKind: true,
      isPersonal: true,
    },
  });

  if (!team) {
    const err: Error & { statusCode?: number } = new Error("Team not found");
    err.statusCode = 404;
    throw err;
  }

  // PHASE 9 §9.4 CORRECTED (2026-07-22) — this service is an INPUT ADAPTER:
  // it loads the persisted workspace fields and DELEGATES the effective-plan
  // decision to the SUBJECT-CORRECT canonical pure policy
  // (`resolveWorkspaceEffectivePlan`, shared-billing). the owner-coverage rule
  // is REMOVED: an existing OWNED workspace never inherits the owner's
  // Personal plan (owner entitlement participates ONLY for the PERSONAL
  // workspace kind — the personal-space subject — and for the
  // legacyRecordCapOverride, which is a per-payer cap, not a plan).
  const ownerEntitlement = await ensureEntitlement(team.ownerUserId);

  const effective = resolveWorkspaceEffectivePlan({
    workspaceKind: resolveWorkspaceKind({
      workspaceKind: (team as { workspaceKind?: string | null }).workspaceKind ?? null,
      isPersonal: (team as { isPersonal?: boolean | null }).isPersonal ?? null,
      billingPlan: team.billingPlan,
      teamLoaded: true,
    }),
    billingPlan: team.billingPlan as prismaPkg.PlanType,
    billingStatus: team.billingStatus as WorkspaceBillingStatus,
    ownerPlan: ownerEntitlement.plan as prismaPkg.PlanType,
  });
  const effectivePlan = effective.plan as prismaPkg.PlanType;

  const activeStorageAddonBytes = await getActiveWorkspaceStorageAddonBytes({
    ownerUserId: team.ownerUserId,
    teamId: team.id,
  });

  const effectiveCaps = getPlanCapabilities(effectivePlan);

  const scope: WorkspaceScope = {
    workspaceType: "TEAM",
    ownerUserId: team.ownerUserId,
    teamId: team.id,
    // Phase A1 — Stage 6 makes this column NOT NULL at the schema
    // level. The non-null assertion here is intentional: a Team
    // returned by the query above whose `organizationId` is null
    // would violate the schema invariant. Surface the violation as
    // an error rather than letting it propagate as a silent fallback.
    organizationId: team.organizationId,
    plan: effectivePlan,
    credits: 0,
    teamSeats: Math.max(
      0,
      team.includedSeats ?? 0,
      effectiveCaps.maxMembersPerTeam ?? 0,
      effectiveCaps.includedSeats ?? 0
    ),
    storageBytesOverride: team.storageBytesOverride ?? null,
    activeStorageAddonBytes,
    // Pricing-hardening: TEAM workspaces inherit the team OWNER's
    // grandfather override (the legacy cap is per-payer, not per-team
    // workspace). Personal-only sub-accounts won't have an override
    // here; this only applies to existing Pro/Team payers that hit
    // the new cap before the migration ran.
    legacyRecordCapOverride:
      (ownerEntitlement as { legacyRecordCapOverride?: number | null })
        .legacyRecordCapOverride ?? null,
  };

  assertWorkspacePlanCompatible(toBillingWorkspaceScope(scope));
  return scope;
}

export async function resolveEvidenceWorkspaceScope(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<WorkspaceScope> {
  if (params.teamId) {
    return getTeamWorkspaceScope(params.teamId);
  }
  return getPersonalWorkspaceScope(params.ownerUserId);
}

export async function resolveWorkspaceScopeForUser(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<WorkspaceScope> {
  return resolveEvidenceWorkspaceScope(params);
}

// PHASE 9 CONVERGENCE (2026-07-22) — `getWorkspaceCapabilities` DELETED: it
// was a dead duplicate effective-capability authority with ZERO production
// callers (proven repo-wide). Effective capabilities are derived exclusively
// through `resolveCommercialContext` (`capabilities` + storage on the scope).
// PHASE 9 §9.4 (2026-07-22) — `isPaidTeamSubscriptionActive` DELETED: the
// decision has exactly ONE implementation (`isWorkspaceSubscriptionActive`,
// @proovra/shared-billing) and its last consumer (webhooks.routes) imports it
// directly. No temporary adapter remains for this rule.
