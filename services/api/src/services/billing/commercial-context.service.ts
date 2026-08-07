/**
 * PHASE 9 §12.1 (2026-07-22) — ONE canonical commercial-context resolver.
 *
 * This is a COMPOSER, not a parallel billing model (§12 hard rule "do not
 * create a parallel billing model"). It unifies the already-canonical
 * pieces into the single envelope the mandate specifies so that API,
 * navigation, checkout, and billing UIs read ONE shape instead of each
 * re-deriving plan/seat/contract facts:
 *
 *   - account plan + personal entitlements  → WorkspaceScope (personal)
 *   - owned-workspace subscription          → WorkspaceScope (team)
 *   - effective limits + capabilities       → getPlanCapabilities + usage
 *   - enterprise organization contract      → resolveEnterpriseContract (§7.2)
 *   - billing owner                         → Team.billingOwnerUserId / owner
 *   - seat consumption                      → §12.7 ACTIVE-only rule
 *
 * §12.7 seat rule (single source of truth): a seat is consumed by an
 * ACTIVE TeamMember only. SUSPENDED and REVOKED members do NOT consume a
 * seat (they are denied access). Governance-only org members, external
 * reviewers (grant-based, never TeamMembers), and managed identities are
 * therefore never seats unless they hold an ACTIVE workspace membership.
 * `getWorkspaceUsage.teamMemberCount` already counts ACTIVE-only; this
 * resolver surfaces that as the canonical seat figure.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { getPlanCapabilities } from "../plan-catalog.service.js";
import {
  resolveWorkspaceScopeForUser,
  type WorkspaceScope,
} from "../workspace-billing.service.js";
import { getWorkspaceUsage } from "../workspace-usage.service.js";
import { resolveEnterpriseContract } from "../organization/enterprise-contract.service.js";

/**
 * PHASE 9 STEP 4 (2026-07-22) — THE ONE commercial lifecycle/grace policy.
 *
 * Every "is this commercial subject currently allowed to use its paid
 * capability / mutate?" decision resolves here. This centralizes what was
 * previously re-derived independently (notably billing-guards' own 7-day
 * grace window over raw `Subscription.status`). There is exactly ONE grace
 * rule and ONE clock (the authoritative Subscription row's currentPeriodEnd).
 *
 * SCOPE NOTE (honest): this pass computes lifecycle for the PERSONAL /
 * OWNED-workspace subjects that `resolveWorkspaceScopeForUser` already
 * resolves — the subjects billing-guards (STEP 5) consumes. The Owned-
 * Workspace grace-CLOCK unification (Team.billing* stores no period-end;
 * multiple Subscription rows with nullable teamId) is a genuine product
 * decision deferred to Batch 3 and is NOT on STEP 5's path — see the
 * ledger "flagged product decision". Enterprise-contract lifecycle
 * (status ACTIVE/SUSPENDED/TERMINATED) is surfaced via `enterpriseContract`.
 */
export const COMMERCIAL_GRACE_PERIOD_DAYS = 7;
const COMMERCIAL_GRACE_PERIOD_MS =
  COMMERCIAL_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

export type CommercialLifecycleState =
  | "ACTIVE"
  | "GRACE"
  | "PAST_DUE_EXPIRED"
  | "CANCELLED"
  | "INACTIVE";

export type CommercialLifecycle = {
  state: CommercialLifecycleState;
  /** May the subject use PAID capability right now (ACTIVE or in-grace). */
  paidActive: boolean;
  /**
   * May the subject perform gated mutations right now. TRUE for ACTIVE,
   * GRACE, and INACTIVE (FREE tier — gated by per-feature limits, not by
   * subscription state). FALSE only for terminal PAST_DUE_EXPIRED /
   * CANCELLED. This is the single replacement for billing-guards'
   * `assertSubscriptionActiveOrGraceAllowed`.
   */
  mutationsAllowed: boolean;
  /** When the current grace window ends (null unless state === GRACE). */
  graceEndsAtUtc: Date | null;
  /** The Subscription.status the decision was derived from, when any. */
  providerStatus: prismaPkg.SubscriptionStatus | null;
};

/**
 * THE single grace/lifecycle resolver. Reads the authoritative Subscription
 * row for the scope and applies the ONE bounded-grace rule. Fail-closed on
 * terminal states; tolerant of webhook lag (no row → authoritative field
 * governs → ACTIVE) so a legitimately-paying, webhook-lagged subject is not
 * locked out of custody/evidence access.
 */
const LIFE_ACTIVE: CommercialLifecycle = {
  state: "ACTIVE",
  paidActive: true,
  mutationsAllowed: true,
  graceEndsAtUtc: null,
  providerStatus: null,
};

/** The ONE grace-window evaluation for a matching PAST_DUE row. */
function evalPastDueGrace(
  currentPeriodEnd: Date | null,
): CommercialLifecycle {
  const periodEndMs = currentPeriodEnd?.getTime() ?? null;
  // §9.5 HARDENED (2026-07-22): PAST_DUE with NO trustworthy clock FAILS
  // CLOSED for new paid mutations (deterministic graceEndsAt is required
  // for grace). Evidence/custody/legal-hold access is untouched — the
  // lifecycle gate restricts only the paid-mutation assert surface.
  if (periodEndMs === null) {
    return {
      state: "PAST_DUE_EXPIRED",
      paidActive: false,
      mutationsAllowed: false,
      graceEndsAtUtc: null,
      providerStatus: prismaPkg.SubscriptionStatus.PAST_DUE,
    };
  }
  const graceEndMs = periodEndMs + COMMERCIAL_GRACE_PERIOD_MS;
  const inGrace = Date.now() <= graceEndMs;
  return inGrace
    ? {
        state: "GRACE",
        paidActive: true,
        mutationsAllowed: true,
        graceEndsAtUtc: new Date(graceEndMs),
        providerStatus: prismaPkg.SubscriptionStatus.PAST_DUE,
      }
    : {
        state: "PAST_DUE_EXPIRED",
        paidActive: false,
        mutationsAllowed: false,
        graceEndsAtUtc: null,
        providerStatus: prismaPkg.SubscriptionStatus.PAST_DUE,
      };
}

async function resolvePaidLifecycle(
  scope: WorkspaceScope,
): Promise<CommercialLifecycle> {
  // FREE tier has no paid subscription state. Mutations remain allowed
  // (gated by per-feature plan limits, mirroring the prior billing-guards
  // FREE short-circuit); paid capability is not active.
  if (scope.plan === prismaPkg.PlanType.FREE) {
    return {
      state: "INACTIVE",
      paidActive: false,
      mutationsAllowed: true,
      graceEndsAtUtc: null,
      providerStatus: null,
    };
  }

  const S = prismaPkg.SubscriptionStatus;
  // Team-scoped workspace subscription (owned-workspace subject).
  const scopeWhere = scope.teamId
    ? { teamId: scope.teamId }
    : { userId: scope.ownerUserId, plan: scope.plan };

  // Faithful relocation of billing-guards' corroboration policy (protects
  // the production stale-row 402 regression): prefer a LIVE row, then a
  // matching PAST_DUE row's grace, then tolerate webhook lag, then deny.
  // Step 1 — live (ACTIVE/TRIALING) matching row(s).
  // §9.5 HARDENED: MULTIPLE live rows for the same subject are AMBIGUOUS
  // provider state — fail closed for paid mutations rather than silently
  // selecting the latest row.
  const liveRows = await prisma.subscription.findMany({
    where: { ...scopeWhere, status: { in: [S.ACTIVE, S.TRIALING] } },
    orderBy: { updatedAt: "desc" },
    select: { status: true },
    take: 2,
  });
  if (liveRows.length > 1) {
    return {
      state: "CANCELLED",
      paidActive: false,
      mutationsAllowed: false,
      graceEndsAtUtc: null,
      providerStatus: liveRows[0].status,
    };
  }
  if (liveRows.length === 1)
    return { ...LIFE_ACTIVE, providerStatus: liveRows[0].status };

  // Step 2 — matching PAST_DUE row → the ONE grace rule.
  const pastDue = await prisma.subscription.findFirst({
    where: { ...scopeWhere, status: S.PAST_DUE },
    orderBy: { updatedAt: "desc" },
    select: { currentPeriodEnd: true },
  });
  if (pastDue) return evalPastDueGrace(pastDue.currentPeriodEnd);

  // Step 3 — no matching-scope row at all → authoritative field governs;
  // tolerate provider-webhook lag. ACTIVE.
  const anyMatching = await prisma.subscription.findFirst({
    where: scopeWhere,
    orderBy: { updatedAt: "desc" },
    select: { status: true, currentPeriodEnd: true },
  });
  if (!anyMatching) return LIFE_ACTIVE;

  // Step 4 — terminal matching row. §9.5: an explicit canonical PAID-THROUGH
  // date is respected — a CANCELED subscription remains commercially active
  // until its paid period ends; after that (or with no valid date) paid
  // capability is inactive, fail closed.
  if (
    anyMatching.status === S.CANCELED &&
    anyMatching.currentPeriodEnd &&
    anyMatching.currentPeriodEnd.getTime() > Date.now()
  ) {
    return {
      state: "ACTIVE",
      paidActive: true,
      mutationsAllowed: true,
      graceEndsAtUtc: anyMatching.currentPeriodEnd,
      providerStatus: anyMatching.status,
    };
  }
  return {
    state: "CANCELLED",
    paidActive: false,
    mutationsAllowed: false,
    graceEndsAtUtc: null,
    providerStatus: anyMatching.status,
  };
}

export type SeatConsumption = {
  /** ACTIVE-only members (§12.7). Null when the plan has no seat concept. */
  consumed: number;
  limit: number;
  remaining: number;
};

export type CommercialContext = {
  billingShape: "SINGLE_OCCUPANT" | "SHARED";
  ownerUserId: string;
  teamId: string | null;
  organizationId: string | null;

  /** Effective plan governing this workspace (personal entitlement or team billing). */
  plan: WorkspaceScope["plan"];
  /** Full plan capability record — the effective limits/features. */
  capabilities: ReturnType<typeof getPlanCapabilities>;

  /** Who owns the bill for this workspace. */
  billingOwnerUserId: string | null;

  /** §12.7 canonical seat figure (ACTIVE-only). */
  seats: SeatConsumption;

  /** STEP 4 — the ONE lifecycle/grace verdict for this subject. */
  lifecycle: CommercialLifecycle;

  /**
   * §9.7 (2026-07-22) — effective record-cap limits, resolved HERE (the one
   * place the legacy grandfather override is interpreted). The override can
   * only substitute the lifetime record cap — it cannot change plan, kind,
   * lifecycle or Enterprise coverage (it is not consulted for any of those).
   */
  limits: {
    effectiveLifetimeRecordCap: number | null;
    effectiveMonthlyRecordCap: number | null;
    source: "PLAN_DEFAULT" | "LEGACY_RECORD_CAP_OVERRIDE";
  };

  /** §12.4 — the canonical Enterprise contract, or null for non-CUSTOMER. */
  enterpriseContract: Awaited<ReturnType<typeof resolveEnterpriseContract>>;

  /** The underlying scope, for callers that still need the raw shape. */
  scope: WorkspaceScope;
};

/**
 * §9.7 (2026-07-22) — EXPLICIT DISCRIMINATED COMMERCIAL SUBJECT.
 *
 * Callers declare WHICH aggregate they mean; nothing is inferred from field
 * presence. Declared workspace types are VERIFIED against the persisted
 * canonical kind — a mismatch FAILS CLOSED (error), never silently resolves
 * a different subject. `WORKSPACE` declares "the workspace aggregate with
 * this persisted id, whose kind the canonical classifier determines" — for
 * enforcement paths that operate on an id before knowing its kind; the
 * resolved kind is returned in the envelope.
 */
export type CommercialSubject =
  | { type: "PERSONAL_ACCOUNT"; userId: string }
  | { type: "OWNED_WORKSPACE"; teamId: string; requesterUserId: string }
  | { type: "ORGANIZATION_WORKSPACE"; teamId: string; requesterUserId: string }
  | { type: "WORKSPACE"; teamId: string; requesterUserId: string };

/**
 * Resolve the full commercial context for an EXPLICIT subject. The legacy
 * `{ ownerUserId, teamId? }` shape remains accepted ONLY as a deprecated
 * compatibility signature during §9.7 caller migration (Phase 12 removal);
 * new callers must pass a discriminated `CommercialSubject`.
 */
export async function resolveCommercialContext(
  params:
    | CommercialSubject
    | {
        ownerUserId: string;
        teamId?: string | null;
      },
): Promise<CommercialContext> {
  if ("type" in params) {
    const subject = params;
    if (subject.type === "PERSONAL_ACCOUNT") {
      return resolveCommercialContextLegacy({
        ownerUserId: subject.userId,
        teamId: null,
      });
    }
    const ctx = await resolveCommercialContextLegacy({
      ownerUserId: subject.requesterUserId,
      teamId: subject.teamId,
    });
    // Declared-kind verification, FAIL CLOSED on mismatch. The envelope's
    // `enterpriseContract` is non-null exactly when the workspace is backed
    // by a CUSTOMER organization (resolveEnterpriseContract returns null for
    // SYSTEM containers), so it is the authoritative discriminator here.
    const customerBacked = ctx.enterpriseContract !== null;
    if (subject.type === "OWNED_WORKSPACE" && customerBacked) {
      throw Object.assign(
        new Error("COMMERCIAL_SUBJECT_MISMATCH: declared OWNED_WORKSPACE resolves to an ORGANIZATION workspace"),
        { statusCode: 409, code: "COMMERCIAL_SUBJECT_MISMATCH" },
      );
    }
    if (subject.type === "ORGANIZATION_WORKSPACE" && !customerBacked) {
      throw Object.assign(
        new Error("COMMERCIAL_SUBJECT_MISMATCH: declared ORGANIZATION_WORKSPACE is not backed by a CUSTOMER organization"),
        { statusCode: 409, code: "COMMERCIAL_SUBJECT_MISMATCH" },
      );
    }
    return ctx;
  }
  return resolveCommercialContextLegacy(params);
}

async function resolveCommercialContextLegacy(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<CommercialContext> {
  const scope = await resolveWorkspaceScopeForUser({
    ownerUserId: params.ownerUserId,
    teamId: params.teamId ?? null,
  });
  const capabilities = getPlanCapabilities(scope.plan);
  const usage = await getWorkspaceUsage(scope);
  const lifecycle = await resolvePaidLifecycle(scope);

  // Billing owner: team workspaces bill the team's billing owner; personal
  // workspaces bill the owner themselves.
  let billingOwnerUserId: string | null = scope.ownerUserId;
  if (scope.teamId) {
    const team = await prisma.team.findUnique({
      where: { id: scope.teamId },
      select: { billingOwnerUserId: true, ownerUserId: true },
    });
    billingOwnerUserId =
      team?.billingOwnerUserId ?? team?.ownerUserId ?? scope.ownerUserId;
  }

  // Enterprise contract only for a CUSTOMER organization (resolver returns
  // null for SYSTEM containers / missing orgs).
  const enterpriseContract = scope.organizationId
    ? await resolveEnterpriseContract(scope.organizationId)
    : null;

  return {
    billingShape: scope.billingShape,
    ownerUserId: scope.ownerUserId,
    teamId: scope.teamId,
    organizationId: scope.organizationId,
    plan: scope.plan,
    capabilities,
    billingOwnerUserId,
    seats: {
      consumed: usage.teamMemberCount,
      limit: usage.seatLimit,
      remaining: usage.seatRemaining,
    },
    lifecycle,
    // §9.7 — THE one interpretation of the grandfather record-cap override:
    // it may only SUBSTITUTE the lifetime record cap (per-payer compat).
    // Plan/kind/lifecycle/coverage above are resolved without consulting it.
    limits: {
      effectiveLifetimeRecordCap:
        scope.legacyRecordCapOverride ?? capabilities.maxEvidenceRecords,
      effectiveMonthlyRecordCap: capabilities.maxEvidenceRecordsPerMonth,
      source:
        scope.legacyRecordCapOverride !== null &&
        scope.legacyRecordCapOverride !== undefined
          ? "LEGACY_RECORD_CAP_OVERRIDE"
          : "PLAN_DEFAULT",
    },
    enterpriseContract,
    scope,
  };
}
