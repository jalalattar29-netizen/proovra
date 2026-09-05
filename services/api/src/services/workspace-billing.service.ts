import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { ensureEntitlement } from "./billing.service.js";
// §9.4 corrected — the canonical API classifier entry (delegates to the
// shared single implementation).
import { resolveWorkspaceKind } from "./identity/workspace-kind.js";
import {
  type BillingWorkspaceScope,
  type WorkspaceBillingShape,
  billingShapeForWorkspaceKind,
  getEffectiveSeatLimit,
  assertWorkspacePlanCompatible,
  // PHASE 9 §9.4 — the canonical PURE commercial policy (the decisions
  // formerly made inline in this file now live in shared-billing).
  resolveWorkspaceEffectivePlan,
  type WorkspaceBillingStatus,
} from "@proovra/shared-billing";
import {
  NO_CONTRACT_LIMITS,
  resolveEnterpriseContractLimits,
  type EnterpriseContractLimits,
} from "./billing/enterprise-contract-limits.js";
import { resolveEnterpriseContract } from "./organization/enterprise-contract.service.js";

export type WorkspaceScope = {
  /**
   * ARCH-001 (2026-08-07) — the COMMERCIAL shape, derived from the canonical
   * WorkspaceKind by `billingShapeForWorkspaceKind`. Renamed from
   * `billingShape: "SINGLE_OCCUPANT" | "TEAM"`, whose values read as tenancy kinds
   * next to a TEAM plan and were used as if they were.
   */
  billingShape: WorkspaceBillingShape;
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
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the CUSTOMER organization's
   * contracted limits, resolved once here so storage, seats, evidence and AI
   * enforcement all read the same contract instead of a flat catalog
   * placeholder. `contractGovernsCapability: false` for every non-Enterprise
   * subject and for any contract that is not ACTIVE (fail closed).
   */
  contractLimits: EnterpriseContractLimits;
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
    billingShape: scope.billingShape,
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

/**
 * WHO PAYS FOR ONE EVIDENCE RECORD — as a value that can be compared.
 *
 * A record is admitted at creation and funded at completion, and until now
 * nothing named the thing those two decisions were supposed to agree about.
 * They resolved a `WorkspaceScope` each, from different inputs, and compared
 * nothing: a difference between them could only be discovered by a customer.
 *
 * The principal is derived from the BILLING SHAPE, which is itself derived
 * from the canonical `WorkspaceKind` — never from a plan name, an
 * `isPersonal` flag read at a call site, or the presence of a `teamId`.
 *
 *   SINGLE_OCCUPANT  the person is the payer. Their Personal Space is a Team
 *                    row too, so the same subject is reachable BY TEAM ID and
 *                    BY USER ID; the principal is the user either way, which
 *                    is exactly what makes the two phases comparable.
 *   SHARED           the workspace is the payer. Deliberately NOT the owner:
 *                    a member's personal wallet must never fund shared
 *                    workspace evidence.
 */
export type CommercialPrincipal = `PERSONAL:${string}` | `WORKSPACE:${string}`;

export function commercialPrincipalOf(scope: {
  billingShape: WorkspaceBillingShape;
  ownerUserId: string;
  teamId: string | null;
}): CommercialPrincipal {
  if (scope.billingShape === "SINGLE_OCCUPANT") {
    return `PERSONAL:${scope.ownerUserId}`;
  }
  /*
   * A SHARED scope without a team id cannot name its payer. Failing here is
   * the point: the alternative is silently charging somebody.
   */
  if (!scope.teamId) {
    throw new Error(
      "commercialPrincipalOf: SHARED scope carries no teamId — the payer is unidentifiable",
    );
  }
  return `WORKSPACE:${scope.teamId}`;
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

  // PHASE 12 — POINT 7 (2026-08-05). The PERSONAL space of a TEAM-plan
  // account used to resolve as **PRO** — a plan the account does not hold and
  // no catalog row grants it. It was introduced to stop
  // `assertWorkspacePlanCompatible` throwing (TEAM has
  // `allowsPersonalWorkspace: false`), which had 500'd `/v1/billing/overview`
  // and broken personal capture for every TEAM account. The 500 was real; the
  // fix was a silent plan substitution, and a substituted plan is a commercial
  // decision made by an input adapter.
  //
  // The account's plan IS its plan. `allowsPersonalWorkspace` describes which
  // workspace kinds a plan may CREATE, not what a personal space that already
  // exists resolves to, so the compatibility assert is scoped below to the
  // TEAM-workspace subject where that question is actually being asked. A
  // TEAM-plan account's personal space therefore resolves at TEAM — its real,
  // strictly more generous entitlement — and nothing is invented.
  const personalPlan = entitlement.plan;

  const scope: WorkspaceScope = {
    // ARCH-001 — a Personal Space is SINGLE_OCCUPANT by definition.
    billingShape: "SINGLE_OCCUPANT",
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
    // A Personal Space is never governed by an organization contract.
    contractLimits: NO_CONTRACT_LIMITS,
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

  const workspaceKind = resolveWorkspaceKind({
    workspaceKind: (team as { workspaceKind?: string | null }).workspaceKind ?? null,
    isPersonal: (team as { isPersonal?: boolean | null }).isPersonal ?? null,
    billingPlan: team.billingPlan,
    teamLoaded: true,
  });

  const effective = resolveWorkspaceEffectivePlan({
    workspaceKind,
    billingPlan: team.billingPlan as prismaPkg.PlanType,
    billingStatus: team.billingStatus as WorkspaceBillingStatus,
    ownerPlan: ownerEntitlement.plan as prismaPkg.PlanType,
  });
  const effectivePlan = effective.plan as prismaPkg.PlanType;

  /**
   * PHASE 12 — POINT 7 (2026-08-05): the BILLING-SCOPE vocabulary now derives
   * from the canonical KIND instead of being hardcoded.
   *
   * `getTeamWorkspaceScope` is reached by team ID, and it stamped every scope
   * `billingShape: "SHARED"` — including the user's PERSONAL workspace, which
   * is also a `Team` row. Everything downstream reads that field as "this is a
   * collaboration workspace", and two of them then contradicted the
   * effective-plan policy in the same package:
   *
   *   - `assertWorkspacePlanCompatible` rejects PAYG on a TEAM scope, because
   *     PAYG is an operation entitlement and never a workspace plan. But
   *     `resolveWorkspaceEffectivePlan` returns PAYG for exactly one case —
   *     a PERSONAL workspace whose owner is on PAYG — so the assert could
   *     only ever fire on a workspace that was not a team. Result: EVERY PAYG
   *     account got an unhandled 500 from `/v1/billing/overview`.
   *   - `assertWorkspaceAllowsEvidenceCreation` refuses TEAM scope on a plan
   *     without `allowsTeamWorkspace`, which is right for an Owned workspace
   *     on FREE and wrong for a FREE user's own Personal Space.
   *
   * PHASE 12 CORRECTIVE PASS §1 (ARCH-001, 2026-08-07) — and the derivation is
   * now a CALL, not a ternary written here.
   *
   * `billingShapeForWorkspaceKind` is the one place tenancy becomes commerce.
   * Writing the mapping inline — as this line used to — is how a second copy
   * of it comes to exist somewhere else and then disagrees.
   *
   * UNKNOWN keeps the stricter SHARED reading, which fails closed: a workspace
   * whose kind cannot be proven is treated as one that could hold other people.
   */
  const billingShape: WorkspaceBillingShape =
    workspaceKind === "UNKNOWN"
      ? "SHARED"
      : billingShapeForWorkspaceKind(workspaceKind);

  /*
   * THE ADD-ONS FOLLOW THE PRINCIPAL, FOR THE SAME REASON THE WALLET DOES.
   *
   * `workspace_storage_addons` is keyed `(owner_user_id, team_id)`, and a
   * PERSONAL add-on is bought through the personal checkout, which passes no
   * team — so its row carries `team_id NULL`. Asking by team id for a
   * SINGLE_OCCUPANT subject therefore matches nothing, and the storage
   * allowance SHRINKS between the phase that admits a record and the phase
   * that finalises it.
   *
   * That is the storage twin of the credits defect above, with the same
   * consequence: `createEvidence` counts the add-on and admits the record,
   * `completeEvidence` does not and refuses it, and a customer who has paid
   * for extra storage watches an upload finish and then fail. Found while
   * auditing the wallet; fixed here rather than left to be discovered the
   * expensive way.
   *
   * Keyed on the resolved SHAPE, not on `team.isPersonal`, so the two
   * allowances that travel on this scope answer to the same principal.
   */
  const activeStorageAddonBytes = await getActiveWorkspaceStorageAddonBytes(
    billingShape === "SINGLE_OCCUPANT"
      ? { ownerUserId: team.ownerUserId, teamId: null }
      : { ownerUserId: team.ownerUserId, teamId: team.id },
  );

  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the contract is resolved
  // ONCE, here, and travels on the scope. Every downstream limit (storage,
  // seats, evidence, AI) reads it from the scope rather than re-fetching or —
  // as before — ignoring it entirely and using the catalog placeholder.
  const contractLimits = resolveEnterpriseContractLimits(
    team.organizationId
      ? await resolveEnterpriseContract(team.organizationId)
      : null,
  );

  const scope: WorkspaceScope = {
    billingShape,
    ownerUserId: team.ownerUserId,
    teamId: team.id,
    // Phase A1 — Stage 6 makes this column NOT NULL at the schema
    // level. The non-null assertion here is intentional: a Team
    // returned by the query above whose `organizationId` is null
    // would violate the schema invariant. Surface the violation as
    // an error rather than letting it propagate as a silent fallback.
    organizationId: team.organizationId,
    plan: effectivePlan,
    /*
     * THE WALLET FOLLOWS THE COMMERCIAL PRINCIPAL.
     *
     * PROVEN AGAINST THE LOCAL FIXTURE (2026-09-05). A Personal PRO account at
     * its 100-record cap holding 3 evidence credits: `POST /v1/evidence`
     * returned 201, the bytes uploaded, and `POST /v1/evidence/:id/complete`
     * returned 402 INSUFFICIENT_EVIDENCE_CREDITS with the wallet untouched at
     * 3. The record stranded in UPLOADING and the purchased credit was
     * unspendable.
     *
     * The cause was this line. Both phases resolve the SAME subject and agree
     * on everything else — the probe printed
     * `billingShape=SINGLE_OCCUPANT plan=PRO` for both — but creation reaches
     * it through `getPersonalWorkspaceScope` (teamId null) while completion
     * reaches it through here, because `evidence.team_id` is never null since
     * HOME-DATA-OWNERSHIP: a personal record carries its owner's personal Team
     * id, so `resolveEvidenceWorkspaceScope` takes the by-team branch. One
     * subject, two builders, and only one of them carried the wallet.
     *
     * `credits: 0` was right when this function only ever answered for a
     * collaboration workspace, and it stays right for one: a member's personal
     * wallet must never fund shared workspace evidence, and `billingShape`
     * SHARED is what says so. What was wrong is that a Personal Space is also
     * a Team row, so this builder answers for SINGLE_OCCUPANT subjects too —
     * and for those the payer IS `ownerUserId`, whose entitlement is already
     * loaded above for the effective plan and the grandfather override.
     *
     * Keyed on the resolved SHAPE, not on `team.isPersonal` and not on a plan
     * name: the shape is the one place tenancy has already become commerce.
     */
    credits:
      billingShape === "SINGLE_OCCUPANT" ? (ownerEntitlement.credits ?? 0) : 0,
    // Canonical seat cap lives in @proovra/shared-billing; this service
    // must not re-derive the plan-cap precedence itself.
    teamSeats: getEffectiveSeatLimit({
      // POINT 7 — the SAME resolved shape, not a second hardcoded one. A
      // Personal Space has no seats to sell; passing the shared shape here gave
      // it the plan's member cap, which the seat projection then reported as
      // capacity that cannot be filled.
      billingShape,
      ownerUserId: team.ownerUserId,
      teamId: team.id,
      plan: effectivePlan,
      credits: 0,
      teamSeats: team.includedSeats ?? 0,
    }),
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
    contractLimits,
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
