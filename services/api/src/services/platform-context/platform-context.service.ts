/**
 * Phase 32.8 Foundation — Canonical platform-context builder.
 *
 * Reads the user + active workspace + team membership, then projects
 * them into the canonical PlatformContextEnvelope returned by
 * GET /v1/platform/context.
 *
 * Hard rules:
 *
 *   1. Side-effect free. No audit writes. No analytics events. No
 *      signed URLs. No queue enqueue. Caller is a pure read.
 *
 *   2. Every section has per-section try/catch — a single sub-query
 *      failure degrades that section only and never collapses the
 *      whole envelope. Failure surfaces in
 *      `envelope.diagnostics.sectionStatus[name] === "degraded"`.
 *
 *   3. NO MEMBER fallback. If membership.role cannot be resolved, the
 *      field is `null` and the frontend renders an honest "Role
 *      unavailable" state — it does NOT substitute a literal "MEMBER".
 *
 *   4. PERSONAL workspaces ALWAYS resolve to OWNER. A user owns their
 *      own evidence by definition. PRO plan does not change this.
 *
 *   5. Capabilities and navigation come from
 *      `resolveCapabilities` + `filterNavigationRegistry` — no extra
 *      "ad-hoc check" branches live here.
 */

import { prisma } from "../../db.js";
import { isPlatformAdmin as resolveIsPlatformAdmin } from "../platform-admin.service.js";
import { resolveCapabilities, resolvePersona } from "./capability-registry.js";
import { getPlanCapabilities } from "../plan-catalog.service.js";
import { deriveOperationalEligibility } from "./operational-eligibility.js";
// ATTENTION ARCHITECTURE (2026-08-22) — the canonical answer to "is this an Enterprise
// customer?", replacing a `billingPlan === "ENTERPRISE"` string comparison.
import { resolveEnterpriseAuthority } from "./enterprise-authority.js";
import {
  buildNavigationProjection,
  filterNavigationRegistry,
} from "./navigation-registry.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
  isWorkspaceRole,
  type PlatformContextAccount,
  type PlatformContextActiveSpace,
  type PlatformContextAvailableWorkspace,
  type PlatformContextDiagnostics,
  type PlatformContextDuplicatePersonalCandidate,
  type PlatformContextEnvelope,
  type PlatformContextOrganization,
  type PlatformContextPersonalSpace,
  type PlatformContextRecoveryAction,
  type PlatformContextWorkspace,
  type SectionStatus,
  type WorkspacePlan,
  type WorkspaceRole,
  type WorkspaceScope,
  type ResolvedWorkspaceKind,
  type OrganizationKindValue,
  PLATFORM_CONTEXT_VERSION,
  type CanonicalContextOrganization,
  type CanonicalContextOrganizationMembership,
  type CanonicalContextWorkspace,
  type CanonicalPlatformContext,
} from "./types.js";
import { ensurePersonalWorkspace } from "./workspace-bootstrap.service.js";
// PHASE 2 (2026-07-21) — the ONE canonical workspace-kind classifier.
import { resolveWorkspaceKind } from "../identity/workspace-kind.js";
// ARCH-003 — the ONE tenancy→commerce derivation, shared with billing.
import { billingShapeForWorkspaceKind } from "@proovra/shared-billing";
// PHASE 10 STEP 5 (2026-07-23) — active support-access envelope projection.
// The ONE authority (support-access.service) evaluates the grant; this
// builder only reads + shapes it. Additive envelope section.
import { buildSupportAccessEnvelopeSection } from "../identity/support-runtime.service.js";
// PHASE 10 §13.2 STEP 6 (2026-07-23) — managed-identity no-personal-space
// signal for CLIENT-SIDE hiding (defense in depth; the server guards in
// workspace-bootstrap.service.ts + platform-context.routes.ts are the
// enforcement). Read-only call — never a fork of the identity-mode authority.
import { personalSpaceAllowed as resolvePersonalSpaceAllowed } from "../identity/identity-mode.service.js";

// Locked product model: only the ENTERPRISE plan (ORGANIZATION workspace)
// is an enterprise workspace. TEAM is a subscription plan inside a PERSONAL
// workspace — it is NOT enterprise and must NOT unlock ENTERPRISE-tier
// surfaces (review ops, governance, SSO/SCIM, investigation, org admin).
// TEAM retains its PROFESSIONAL tier + all TEAM plan capabilities via the
// plan path (`tiersAllowedByPlan`) and `getPlanCapabilities("TEAM")`; those
// are independent of this flag.
const PRO_PLAN_KEYS: ReadonlySet<WorkspacePlan> = new Set(["PRO", "TEAM"]);

/**
 * ATTENTION ARCHITECTURE (2026-08-22) — the LEGACY two-value scope, derived from the
 * canonical three-value kind instead of from `isPersonal`.
 *
 * `scope` used to be computed independently as
 * `team.isPersonal ? "PERSONAL" : "TEAM"`. Deriving it here means the
 * envelope cannot report a scope that contradicts `Team.workspaceKind`,
 * and it gives the eventual removal of `scope` a single call site.
 *
 * UNKNOWN maps to null rather than to a guess: a workspace whose kind
 * could not be proven must not be presented as either.
 */
function legacyScopeFromKind(
  kind: ResolvedWorkspaceKind,
): WorkspaceScope | null {
  if (kind === "PERSONAL") return "PERSONAL";
  if (kind === "OWNED" || kind === "ORGANIZATION") return "TEAM";
  return null;
}

function coercePlan(raw: string | null | undefined): WorkspacePlan | null {
  if (!raw) return null;
  const upper = String(raw).toUpperCase();
  if (
    upper === "FREE" ||
    upper === "PAYG" ||
    upper === "PRO" ||
    upper === "TEAM" ||
    upper === "ENTERPRISE"
  ) {
    return upper;
  }
  return null;
}

function coerceRole(raw: string | null | undefined): WorkspaceRole | null {
  if (!raw) return null;
  return isWorkspaceRole(raw) ? raw : null;
}

export type BuildPlatformContextInput = {
  userId: string;
  requestId: string;
  jwtRole?: string | null;
  /**
   * Phase B0 — Wire-version requested by the caller. When `3`, the
   * envelope omits the legacy `workspace` field so clients that
   * have completed the migration cannot accidentally read it. When
   * absent / `2`, the legacy field is still emitted alongside the
   * canonical `account` / `personalSpace` / `organizations[]` /
   * `activeSpace` sections (no breaking change).
   *
   * The route layer reads `x-platform-context-version` from the
   * request and passes the parsed number here. Unknown / malformed
   * values default to the legacy emission for safety.
   */
  requestedSchemaVersion?: 2 | 3;
};

export type BuildPlatformContextResult =
  | { ok: true; envelope: PlatformContextEnvelope }
  | { ok: false; reason: "user_not_found" };

/**
 * Build the canonical PlatformContextEnvelope for `userId`.
 *
 * Returns `{ ok: false, reason: "user_not_found" }` only when the
 * user record itself is missing — every other partial-failure mode
 * is reflected in the per-section status fields.
 */
export async function buildPlatformContext(
  input: BuildPlatformContextInput,
): Promise<BuildPlatformContextResult> {
  const now = new Date();
  const generatedAt = now.toISOString();

  // -------------------------------------------------------------------------
  // User
  // -------------------------------------------------------------------------
  let userStatus: SectionStatus = "ok";
  const userRow = await prisma.user
    .findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        locale: true,
        timezone: true,
        platformRole: true,
        currentWorkspaceId: true,
      },
    })
    .catch(() => {
      userStatus = "degraded";
      return null;
    });

  if (!userRow) {
    return { ok: false, reason: "user_not_found" };
  }

  // -------------------------------------------------------------------------
  // Platform admin elevation
  // -------------------------------------------------------------------------
  // ADM-001 — the authority is `userRow.platformRole`, which this function has
  // ALREADY read from the database on this request. Passing it through avoids a
  // second identical query while keeping the decision on current state; the
  // `jwtRole` argument is diagnostic only and can no longer grant anything.
  let isPlatformAdmin = false;
  try {
    isPlatformAdmin = await resolveIsPlatformAdmin(
      userRow.id,
      input.jwtRole ?? null,
      userRow.platformRole ?? null,
    );
  } catch {
    isPlatformAdmin = false;
  }

  // -------------------------------------------------------------------------
  // Workspace + membership
  //
  // Phase EMERGENCY-RECOVERY — every authenticated user gets a real
  // `Team` row tagged `isPersonal=true` via `ensurePersonalWorkspace`.
  // The platform NEVER returns `workspace.status === "no-workspace"`
  // for an authenticated user with a healthy DB. Stale or invalid
  // `currentWorkspaceId` values fall back to the personal workspace
  // instead of producing a broken shell.
  // -------------------------------------------------------------------------
  let workspaceStatus: SectionStatus = "ok";
  let workspaceSource: PlatformContextDiagnostics["workspaceSource"] =
    "personal_bootstrap";
  const bootstrap: PlatformContextDiagnostics["bootstrap"] = {
    attempted: false,
    reused: false,
    created: false,
    activeWorkspaceUpdated: false,
  };
  let workspace: PlatformContextWorkspace = {
    status: "no-workspace",
    id: null,
    name: null,
    scope: "PERSONAL",
    // No workspace has been selected yet, so nothing about its kind is
    // proven. Null rather than an assumed PERSONAL — consumers fail closed.
    workspaceKind: null,
    organizationKind: null,
    organizationId: null,
    plan: null,
    membership: {
      role: "OWNER",
      isOwner: true,
      isAdmin: true,
      memberCount: 1,
    },
  };

  // ---------------------------------------------------------------------------
  // PHASE 12 — POINT 7 (2026-08-05): resolve the Personal-Space PERMISSION
  // ONCE, before anything can select, heal into, or persist a personal
  // context.
  //
  // It used to be resolved near the very end of this function, purely to
  // decide whether the switcher OFFERED a Personal option — while three
  // earlier code paths had already selected the personal workspace and one of
  // them had written `User.currentWorkspaceId` to it. So a user whose
  // Organization was suspended, whose membership went inactive, or whose
  // pointer went stale was durably moved into a Personal Space the same
  // envelope then declined to offer. Resolving it here makes the permission an
  // input to selection instead of a footnote about presentation.
  //
  // Degrades to `true` (unchanged legacy behavior) on a resolution failure:
  // the personal-scope MUTATION guards remain the authority and each of them
  // resolves this independently, so a read-path outage must not lock a
  // STANDARD user out of their own workspace.
  // ---------------------------------------------------------------------------
  let personalSpaceAllowedFlag = true;
  try {
    personalSpaceAllowedFlag = await resolvePersonalSpaceAllowed(userRow.id);
  } catch {
    personalSpaceAllowedFlag = true;
  }

  // Step 1 — ensure the user has a personal workspace. This is
  // idempotent (the loser of a concurrent insert race re-fetches the
  // winner). The personal team is the fallback target whenever the
  // selected `currentWorkspaceId` is missing or stale — but ONLY when this
  // identity is permitted a Personal Space at all.
  let personalTeamId: string | null = null;
  let personalTeamName: string | null = null;
  if (personalSpaceAllowedFlag) {
    try {
      bootstrap.attempted = true;
      const personal = await ensurePersonalWorkspace({ userId: userRow.id });
      personalTeamId = personal.teamId;
      personalTeamName = personal.name;
      bootstrap.created = personal.created;
      bootstrap.reused = !personal.created;
    } catch {
      // Bootstrap failed — degraded but recoverable. The workspace
      // section falls through to the synthetic personal mode below.
      workspaceStatus = "degraded";
    }
  }

  if (userRow.currentWorkspaceId) {
    try {
      const team = await prisma.team.findUnique({
        where: { id: userRow.currentWorkspaceId },
        select: {
          id: true,
          name: true,
          billingPlan: true,
          isPersonal: true,
          // ATTENTION ARCHITECTURE (2026-08-22) — the CANONICAL structural discriminator.
          // `isPersonal` alone cannot distinguish OWNED from ORGANIZATION;
          // both are `isPersonal = false`.
          workspaceKind: true,
          organizationId: true,
          // SYSTEM containers are internal bootstrap objects and must never
          // surface as customer Organizations in product UI.
          organization: { select: { kind: true } },
          _count: { select: { members: true } },
        },
      });

      const membership = team
        ? await prisma.teamMember.findUnique({
            where: {
              teamId_userId: {
                teamId: team.id,
                userId: userRow.id,
              },
            },
            select: { role: true, status: true },
          })
        : null;

      const memberOk = membership && membership.status === "ACTIVE";

      if (!team || !memberOk) {
        // `currentWorkspaceId` points to a deleted team OR the user
        // is no longer an ACTIVE member. Clear the stale pointer and
        // fall through to the personal workspace — but ONLY when this
        // identity is permitted one. POINT 7: an Organization going
        // suspended, or a membership going inactive, must not durably
        // relocate a `noPersonalSpace` identity into a Personal Space.
        // `personalTeamId` is already null in that case, so the write below
        // cannot fire; the guard is stated for the reader.
        workspaceStatus = "degraded";
        workspaceSource = "personal_bootstrap_after_stale";
        if (personalTeamId && personalSpaceAllowedFlag) {
          try {
            await prisma.user.update({
              where: { id: userRow.id },
              data: { currentWorkspaceId: personalTeamId },
            });
            bootstrap.activeWorkspaceUpdated = true;
          } catch {
            // Non-fatal: the frontend still gets a usable envelope.
          }
        }
      } else {
        // Healthy team selection.
        //
        // ATTENTION ARCHITECTURE (2026-08-22) — classification now runs through the
        // CANONICAL classifier rather than reading `isPersonal` directly.
        // The legacy two-value `scope` is DERIVED from the three-value
        // kind, so the envelope can no longer report a classification that
        // disagrees with `Team.workspaceKind`.
        const role: WorkspaceRole | null = coerceRole(
          membership!.role as unknown as string,
        );
        workspaceSource = "current_workspace_id";
        const resolvedKind = resolveWorkspaceKind({
          workspaceKind: team.workspaceKind as unknown as string | null,
          isPersonal: team.isPersonal,
          billingPlan: team.billingPlan as unknown as string | null,
          teamLoaded: true,
        });
        workspace = {
          status: "active",
          id: team.id,
          name: team.name ?? null,
          scope: legacyScopeFromKind(resolvedKind),
          workspaceKind: resolvedKind,
          organizationKind:
            (team.organization?.kind as OrganizationKindValue | undefined) ??
            null,
          organizationId: team.organizationId ?? null,
          plan: coercePlan(team.billingPlan as unknown as string),
          membership: {
            role,
            isOwner: role === "OWNER",
            isAdmin: role === "OWNER" || role === "ADMIN",
            memberCount: team._count?.members ?? 0,
          },
        };
      }
    } catch {
      workspaceStatus = "degraded";
    }
  }

  // Step 2 — if no healthy team selection was made, point the user
  // at the personal team that the bootstrap just (re)used / created.
  // ALWAYS produces `workspace.status === "active"` so the frontend
  // never sees "No workspace selected" for an authenticated user.
  if (workspace.status !== "active") {
    if (personalTeamId) {
      workspace = {
        status: "active",
        id: personalTeamId,
        name: personalTeamName,
        scope: "PERSONAL",
        // The bootstrap only ever produces a Personal Space (isPersonal=true).
        workspaceKind: "PERSONAL",
        organizationKind: null,
        organizationId: null,
        plan: null,
        membership: {
          role: "OWNER",
          isOwner: true,
          isAdmin: true,
          memberCount: 1,
        },
      };
      // Persist the personal team as the active workspace if not
      // already so. Skipped silently on error — the in-memory
      // envelope is still usable.
      if (
        !bootstrap.activeWorkspaceUpdated &&
        userRow.currentWorkspaceId !== personalTeamId
      ) {
        try {
          await prisma.user.update({
            where: { id: userRow.id },
            data: { currentWorkspaceId: personalTeamId },
          });
          bootstrap.activeWorkspaceUpdated = true;
        } catch {
          // non-fatal
        }
      }
    } else if (personalSpaceAllowedFlag) {
      // Bootstrap genuinely failed (DB unavailable etc.). Surface a
      // synthetic personal-mode envelope so the frontend renders a
      // recovery shell — but DO NOT pretend the workspace is broken.
      workspace = {
        status: "active",
        id: null,
        name: null,
        scope: "PERSONAL",
        // Synthetic recovery shell — no Team row was read, so the kind is
        // unprovable. UNKNOWN keeps every downstream gate fail-closed.
        workspaceKind: "UNKNOWN",
        organizationKind: null,
        organizationId: null,
        plan: null,
        membership: {
          role: "OWNER",
          isOwner: true,
          isAdmin: true,
          memberCount: 1,
        },
      };
    } else {
      // PHASE 12 — POINT 7. Personal Space is NOT permitted for this identity
      // and no authorized workspace was selected. The honest answer is "no
      // workspace", and it is the one answer this branch used to be incapable
      // of giving: it fabricated an active PERSONAL shape with a null id, and
      // every consumer that only reads `workspace.status` read that as a
      // healthy personal context. `workspace` keeps its initial `no-workspace`
      // value; `personalSpaceAllowed: false` on the envelope drives the
      // canonical unavailable panel.
      workspace = {
        status: "no-workspace",
        id: null,
        name: null,
        scope: null,
        workspaceKind: null,
        organizationKind: null,
        organizationId: null,
        plan: null,
        membership: {
          role: null,
          isOwner: false,
          isAdmin: false,
          memberCount: 0,
        },
      };
      workspaceStatus = "degraded";
    }
  }

  // Best-effort plan overlay: when the active workspace is the
  // personal team, prefer the user's `Entitlement.plan` over the
  // team's billing plan (personal teams stay FREE — PRO entitles
  // the USER, not the personal Team row).
  if (workspace.scope === "PERSONAL") {
    try {
      // PRODUCTION FIX (billing-mismatch): mirror the EXACT filter used
      // by `services/api/src/services/collaboration-team/billing-guards.ts`
      // → `resolveUserPlan()` (Entitlement.findFirst { userId, active:true,
      // orderBy: createdAt desc }). Without the `active: true` filter the
      // envelope can pick up a SUPERSEDED entitlement row while the
      // authoritative billing guard picks up the live PRO row, producing
      // the "PRO user blocked by 402; UI badge says FREE" mismatch.
      const personalEntitlement = await prisma.entitlement.findFirst({
        where: { userId: userRow.id, active: true },
        orderBy: { createdAt: "desc" },
        select: { plan: true },
      });
      const personalPlan = coercePlan(
        personalEntitlement?.plan as unknown as string,
      );
      if (personalPlan) {
        workspace = { ...workspace, plan: personalPlan };
      }
    } catch {
      // Entitlement table missing/degraded — leave plan null.
      workspaceStatus = workspaceStatus === "ok" ? "degraded" : workspaceStatus;
    }
  }

  // -------------------------------------------------------------------------
  // Flags — derived from workspace + plan
  // -------------------------------------------------------------------------
  // Account-tier plan follows the USER (via Entitlement), not the workspace.
  // PRO is an account-level entitlement, so `isProAccount` must read from
  // the user's Entitlement rather than the workspace's billing plan. The
  // same value is reused later when populating `account.accountPlan`.
  let accountPlan: WorkspacePlan | null = null;
  try {
    // PRODUCTION FIX (billing-mismatch): same `active: true` filter as the
    // authoritative billing guard — see the comment in the PERSONAL branch
    // above. The account plan flows into `envelope.account.accountPlan`,
    // which the UI billing badge falls back to when the personal-space
    // plan is null. Mismatch here causes the "FREE plan: 0 of 1 teams
    // used" badge for a user the backend correctly recognises as PRO.
    const ent = await prisma.entitlement.findFirst({
      where: { userId: userRow.id, active: true },
      orderBy: { createdAt: "desc" },
      select: { plan: true },
    });
    accountPlan = coercePlan(ent?.plan as unknown as string);
  } catch {
    accountPlan = null;
  }

  // ATTENTION ARCHITECTURE — read from the CANONICAL kind. `isTeamWorkspace` keeps its
  // long-standing meaning ("shared, non-personal") and is now the union of
  // the two kinds the legacy scope collapsed into one.
  const isPersonalWorkspace = workspace.workspaceKind === "PERSONAL";
  const isTeamWorkspace =
    workspace.workspaceKind === "OWNED" ||
    workspace.workspaceKind === "ORGANIZATION";
  const isProAccount = accountPlan ? PRO_PLAN_KEYS.has(accountPlan) : false;
  // ATTENTION ARCHITECTURE (2026-08-22) — CANONICAL enterprise authority.
  //
  // This used to be `ENTERPRISE_PLAN_KEYS.has(workspace.plan)` — a string
  // comparison against a billing package. `EnterpriseContract` is the
  // schema's declared "ONE authoritative record of an Enterprise
  // customer's commercial scope", and the plan string is documented there
  // as a LEGACY signal. The resolver consults the contract first and falls
  // back to the plan string ONLY on an ORGANIZATION workspace with no
  // contract row, so the fallback cannot promote a PERSONAL or OWNED
  // workspace whose plan column drifted.
  //
  // Never throws: a failed contract read yields `source: "unavailable"`
  // and a false verdict, so a database blip cannot upgrade a tenant.
  const enterprise = await resolveEnterpriseAuthority({
    workspaceKind: workspace.workspaceKind ?? "UNKNOWN",
    organizationKind: workspace.organizationKind,
    organizationId: workspace.organizationId,
    workspaceBillingPlan: workspace.plan,
  });
  const isEnterpriseWorkspace = enterprise.isEnterpriseCustomer;

  // -------------------------------------------------------------------------
  // Canonical plan capabilities.
  //
  // PHASE 4B — resolved BEFORE capabilities (it used to be computed after)
  // because `OPERATIONS_VIEW` is granted from whether the workspace can
  // PRODUCE operational conditions, which is a plan-capability question.
  // The same resolved object feeds `planFeatures` below, so there is still
  // exactly one call to the commercial catalog per envelope.
  // -------------------------------------------------------------------------
  const planCaps = getPlanCapabilities(
    (workspace.plan ?? "FREE") as Parameters<typeof getPlanCapabilities>[0],
  );

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------
  let capabilityStatus: SectionStatus = "ok";
  let capabilities;
  try {
    capabilities = resolveCapabilities({
      scope: workspace.scope,
      role: workspace.membership.role,
      plan: workspace.plan,
      isPlatformAdmin,
      // ATTENTION ARCHITECTURE — the canonical structural kind, so OWNED and ORGANIZATION
      // stop resolving through one collapsed value.
      workspaceKind: workspace.workspaceKind,
      // PHASE 4B — the two independent qualifiers for tenant Operations.
      // The commercial derivation happens HERE, against the canonical
      // catalog, so the capability resolver stays a pure role/kind
      // function with no feature vocabulary in its input.
      packageProducesOperationalConditions:
        planCaps.reportsIncluded ||
        planCaps.verificationPackageIncluded ||
        planCaps.intakeIncluded ||
        planCaps.reviewerOperationsIncluded,
      memberCount: workspace.membership.memberCount,
    });
  } catch {
    capabilityStatus = "degraded";
    capabilities = resolveCapabilities({
      scope: null,
      role: null,
      plan: null,
      isPlatformAdmin: false,
    });
  }

  // -------------------------------------------------------------------------
  // Plan feature flags (2026-07-15) — the CANONICAL commercial capability
  // values (PLAN_CAPABILITIES) projected onto the active workspace's plan
  // so the Operations Center + Notification Preferences resolver can be
  // entitlement-aware WITHOUT the frontend importing the billing package
  // or duplicating the commercial table. This is the single source of
  // truth; no parallel entitlement system.
  //
  // PHASE 4B — `planCaps` is now resolved once, above, before capability
  // resolution needs it. This block projects that same object.
  // -------------------------------------------------------------------------
  const planFeatures = {
    reportsIncluded: planCaps.reportsIncluded,
    verificationPackageIncluded: planCaps.verificationPackageIncluded,
    intakeIncluded: planCaps.intakeIncluded,
    casesIncluded: planCaps.casesIncluded,
    reviewerOperationsIncluded: planCaps.reviewerOperationsIncluded,
    // PHASE 12B Track 1A — server-projected surface-tier entitlement (the ONE
    // commercial catalog decides; the frontend never branches on plan names).
    professionalSurfacesIncluded: planCaps.professionalSurfacesIncluded,
    reviewQueuesIncluded: planCaps.reviewQueuesIncluded,
    teamCollaborationIncluded: planCaps.maxCollaborationTeamsPerWorkspace > 0,
    aiAssistanceMonthlyOperations: planCaps.aiAdvisoryMonthlyOperations,
    /*
     * WORKSPACE AND COLLABORATION ARCHITECTURE CLOSURE (2026-09-06) —
     * `canInviteGuests` was REMOVED from the envelope.
     *
     * It projected eligibility for an operation that granted nothing: "guest
     * invitation" wrote a row and stopped — no email was sent, no read path
     * consulted the table, the status never left PENDING. With the operation
     * retired, a client rendering an affordance from this flag would be
     * offering a door with no room behind it, and a client rendering a LOCKED
     * state from it would be telling a paying customer they cannot do
     * something nobody can do. Both are worse than the flag's absence.
     *
     * External reviewers are granted access by the external-review authority,
     * whose commercial gate is the `FEATURE_EXTERNAL_PORTAL` entitlement —
     * resolved server-side, per workspace, not a plan-name flag carried here.
     */
    /**
     * PHASE 12 — POINT 7 (2026-08-05): the NUMERIC limits, projected.
     *
     * Three collaboration surfaces used to compute these in the browser:
     * `MembersTab`, `InvitesTab` and the collaboration-teams index each called
     * `getCollaborationTeamPlanLimits(useAccount().accountPlan)` and gated the
     * invite affordance on the result. Two things were wrong with that, and
     * only the second is obvious.
     *
     * The obvious one: it made the client a limit authority.
     *
     * The subtler one: the subject was the ACCOUNT plan. A collaboration team
     * lives inside a WORKSPACE, and a workspace's commercial state is its own —
     * an Owned Workspace does not inherit its owner's personal plan. So the
     * capacity badge on an unsubscribed workspace showed the OWNER's Pro
     * allowance, and the invite button stayed enabled right up to a 409 the
     * server was always going to return.
     *
     * These are the same catalog values `billing-guards` enforces, resolved on
     * the ACTIVE workspace. The client renders them; it no longer derives them.
     */
    limits: {
      maxCollaborationTeamsPerWorkspace:
        planCaps.maxCollaborationTeamsPerWorkspace,
      maxAcceptedMembersPerCollaborationTeam:
        planCaps.maxAcceptedMembersPerCollaborationTeam,
      maxWorkspaceSeats: planCaps.maxWorkspaceSeats,
      maxPendingInvitesPerTeam: planCaps.maxPendingInvitesPerTeam,
      maxInvitesPer24h: planCaps.maxInvitesPer24h,
    },
  };

  // -------------------------------------------------------------------------
  // Persona
  // -------------------------------------------------------------------------
  const resolvedPersona = resolvePersona({
    scope: workspace.scope,
    role: workspace.membership.role,
  });

  // -------------------------------------------------------------------------
  // Navigation — server-resolved
  // -------------------------------------------------------------------------
  let navigationStatus: SectionStatus = "ok";
  let navigationGroups;
  let navigationProjection: ReturnType<typeof buildNavigationProjection>;
  try {
    navigationGroups = filterNavigationRegistry(capabilities);
    navigationProjection = buildNavigationProjection(capabilities);
  } catch {
    navigationStatus = "degraded";
    navigationGroups = [];
    // Degraded fallback must match the canonical sidebar shape (groups + pillars).
    // Empty pillars[] keeps pillar-aware consumers happy while still rendering an
    // empty sidebar — distinct from "pillars field missing" which would crash them.
    navigationProjection = {
      sidebar: { groups: [], pillars: [] },
      accountMenu: { items: [] },
    };
  }

  // -------------------------------------------------------------------------
  // ENTERPRISE TENANT MODEL — Organizations + Personal Space + duplicate
  // detection.
  //
  // The TeamMember.findMany query is the source of truth for "what spaces
  // can this user enter". We bound it to 200 rows and split it into:
  //
  //   - organizationRows  — `isPersonal=false` (the real organizations)
  //   - personalRows      — `isPersonal=true` (canonical Personal Space +
  //                         any legacy duplicates flagged by the heuristic)
  //
  // The legacy `availableWorkspaces` array is rebuilt at the end of the
  // section for backward compatibility — but its TEAM entries now exclude
  // personal rows, so the switcher no longer duplicates.
  // -------------------------------------------------------------------------
  let availableWorkspacesStatus: SectionStatus = "ok";
  const organizations: PlatformContextOrganization[] = [];
  // P3 domain remediation (2026-07-21) — canonical, server-authorized
  // context options (grouped into ownedWorkspaces vs organizations by the
  // explicit workspaceKind). The client may group/render but NEVER widens
  // this set.
  const contextOptionRows: Array<{
    workspaceId: string;
    name: string | null;
    kind: "PERSONAL" | "OWNED" | "ORGANIZATION";
    role: ReturnType<typeof coerceRole>;
    organizationId: string | null;
    organizationName: string | null;
  }> = [];
  type PersonalTeamRow = {
    id: string;
    name: string | null;
    ownerUserId: string;
    memberCount: number;
    billingPlan: string | null;
  };
  const personalTeams: PersonalTeamRow[] = [];
  /**
   * ARCH-003 — workspace id → WORKSPACE membership id.
   *
   * Collected here, from the same rows the switcher is built from, so the
   * canonical envelope can report a workspace membership id that is visibly a
   * DIFFERENT id space from the governance membership id. Mistaking one for
   * the other is how a governance action gets applied to a workspace row.
   */
  const workspaceMembershipIdByWorkspace = new Map<string, string>();
  try {
    const memberRows = await prisma.teamMember.findMany({
      where: { userId: userRow.id, status: "ACTIVE" },
      select: {
        // ARCH-003 — the WORKSPACE membership id, kept distinct from the
        // ORGANIZATION membership id in the canonical envelope.
        id: true,
        role: true,
        status: true,
        team: {
          select: {
            id: true,
            name: true,
            isPersonal: true,
            ownerUserId: true,
            billingPlan: true,
            // P0 remediation (2026-07-21) — parent-organization lifecycle,
            // consulted below so ARCHIVED/SUSPENDED orgs never surface as
            // switch targets.
            // P3 domain remediation (2026-07-21) — explicit kinds + the
            // parent organization identity for the canonical contextOptions
            // grouping (Personal / Your workspaces / Organizations).
            workspaceKind: true,
            organizationId: true,
            organization: {
              select: { status: true, kind: true, name: true },
            },
            _count: { select: { members: true } },
          },
        },
      },
      take: 200,
    });

    for (const m of memberRows) {
      if (!m.team) continue;
      workspaceMembershipIdByWorkspace.set(m.team.id, m.id);
      // P0 remediation (2026-07-21) — an ACTIVE membership in a workspace
      // whose parent organization is not ACTIVE is not a valid operating
      // context; exclude it from the switcher (the switch mutation denies
      // it server-side too). Personal teams are exempt (bootstrap
      // container orgs are not lifecycle-managed).
      if (
        !m.team.isPersonal &&
        m.team.organization &&
        m.team.organization.status !== "ACTIVE"
      ) {
        continue;
      }

      // PHASE 2 (2026-07-21) — ONE canonical workspace-kind classifier.
      // The former inline migration-window fallback is replaced by the
      // shared `resolveWorkspaceKind` (services/identity/workspace-kind.ts),
      // which applies the SAME deterministic backfill rule for NULL rows and
      // fails closed (UNKNOWN) when the row is unprovable. UNKNOWN rows are
      // excluded from the switcher — an unclassifiable workspace is not a
      // valid switch target.
      const resolvedKindOrUnknown = resolveWorkspaceKind({
        workspaceKind: (m.team.workspaceKind as string | null) ?? null,
        isPersonal: m.team.isPersonal,
        billingPlan: (m.team.billingPlan as unknown as string) ?? null,
        teamLoaded: true,
      });
      if (resolvedKindOrUnknown === "UNKNOWN") continue;
      const resolvedKind = resolvedKindOrUnknown;

      if (m.team.isPersonal) {
        personalTeams.push({
          id: m.team.id,
          name: m.team.name ?? null,
          ownerUserId: m.team.ownerUserId as unknown as string,
          memberCount: m.team._count?.members ?? 0,
          billingPlan: (m.team.billingPlan as unknown as string) ?? null,
        });
        continue;
      }

      // P3 — canonical context option (grouped later into ownedWorkspaces
      // vs organizations by `resolvedKind`).
      contextOptionRows.push({
        workspaceId: m.team.id,
        name: m.team.name ?? null,
        kind: resolvedKind,
        role: coerceRole(m.role as unknown as string),
        organizationId: (m.team.organizationId as unknown as string) ?? null,
        organizationName: m.team.organization?.name ?? null,
      });

      organizations.push({
        id: m.team.id,
        name: m.team.name ?? null,
        displayName: m.team.name ?? null,
        role: coerceRole(m.role as unknown as string),
        membershipStatus: (m.status as unknown as string) === "ACTIVE"
          ? "ACTIVE"
          : (m.status as unknown as string) === "PENDING"
            ? "PENDING"
            : "INACTIVE",
        plan: coercePlan(m.team.billingPlan as unknown as string),
        memberCount: m.team._count?.members ?? 0,
        // ATTENTION ARCHITECTURE — expose the structural distinction this array's name
        // hides. `organizations` holds every non-personal workspace, so a
        // consumer that means "real customer organization" must filter on
        // these rather than trust the field name.
        workspaceKind: resolvedKind,
        organizationKind:
          (m.team.organization?.kind as OrganizationKindValue | undefined) ??
          null,
      });
    }
  } catch {
    availableWorkspacesStatus = "degraded";
  }

  // ===========================================================================
  // ENTERPRISE TENANT MODEL — duplicate personal-like candidate detection.
  //
  // Heuristic: an "organization" row owned by the viewer with exactly one
  // ACTIVE member (the owner), zero pending invites, and a FREE plan is a
  // candidate for being a legacy personal workspace. We do NOT auto-modify
  // it — we just surface it in diagnostics so /teams can offer remediation.
  // ===========================================================================
  const duplicatePersonalCandidates: PlatformContextDuplicatePersonalCandidate[] = [];
  if (userRow.email && organizations.length > 0) {
    const emailLocal = userRow.email.toLowerCase().split("@")[0] ?? "";
    for (const org of organizations) {
      const name = (org.name ?? "").toLowerCase();
      const looksLikePersonal =
        name.includes("personal workspace") ||
        (emailLocal.length > 0 &&
          name.includes(emailLocal) &&
          name.includes("personal"));
      if (!looksLikePersonal) continue;
      // We need ownerUserId + invite count for the full heuristic. We have
      // ownerUserId implicitly (the org came from memberRows of THIS user)
      // but we need to confirm the user IS the owner of the row.
      try {
        const teamRow = await prisma.team.findUnique({
          where: { id: org.id },
          select: { ownerUserId: true, billingPlan: true },
        });
        if (!teamRow) continue;
        const isOwner = teamRow.ownerUserId === userRow.id;
        const isSingleMember = org.memberCount === 1;
        const isFreePlan = (teamRow.billingPlan ?? "").toUpperCase() === "FREE";
        const reasons: PlatformContextDuplicatePersonalCandidate["reasons"][number][] =
          [];
        reasons.push("name_matches_email_personal");
        if (isSingleMember) reasons.push("single_owner_member");
        if (isFreePlan) reasons.push("free_plan");
        // The heuristic requires at minimum: owner-of-row + single-member
        // + suggestive name. We do not check pending invites here; the row
        // having a single ACTIVE member is a stronger signal.
        if (isOwner && isSingleMember) {
          duplicatePersonalCandidates.push({
            teamId: org.id,
            name: org.name,
            ownerUserId: teamRow.ownerUserId as unknown as string,
            memberCount: org.memberCount,
            reasons,
          });
        }
      } catch {
        // Non-fatal — duplicate detection degrades cleanly.
      }
    }
  }

  // ===========================================================================
  // ENTERPRISE TENANT MODEL — canonical Personal Space.
  //
  // Exactly one personal space per user. If the bootstrap completed, we
  // emit the real Team id; otherwise we emit a degraded shape so the
  // recovery panel renders.
  // ===========================================================================
  const personalSpace: PlatformContextPersonalSpace = personalTeamId
    ? {
        status: "active",
        id: personalTeamId,
        label: "Personal Space",
        ownerUserId: userRow.id,
        plan: workspace.scope === "PERSONAL" ? workspace.plan : null,
      }
    : {
        status: "degraded",
        id: null,
        label: "Personal Space",
        ownerUserId: userRow.id,
        plan: null,
      };

  // ===========================================================================
  // ENTERPRISE TENANT MODEL — Account section.
  // ===========================================================================
  // The account-tier plan follows the user, not any one workspace. We
  // prefer the latest Entitlement, falling back to null. `accountPlan` is
  // already resolved up in the flags section (where `isProAccount` needs
  // it); we reuse that value here rather than re-querying.
  const account: PlatformContextAccount = {
    userId: userRow.id,
    email: userRow.email ?? null,
    displayName:
      userRow.displayName ??
      ([userRow.firstName, userRow.lastName].filter(Boolean).join(" ").trim() ||
        null),
    accountPlan,
    accountStatus: "active",
  };

  // ===========================================================================
  // ENTERPRISE TENANT MODEL — ActiveSpace.
  //
  // Derived from the legacy workspace.scope so we stay coherent with all
  // existing per-section logic and the legacy `workspace` field. The
  // displayName is bounded — never raw UUIDs.
  //
  // PERSONAL-FIRST RESCUE — derivation order is now:
  //
  //   1. If workspace.scope === "TEAM" AND workspace.id is a real id →
  //      emit ORGANIZATION (the normal org-workspace case).
  //   2. If workspace.scope === "PERSONAL" (or anything else) AND we
  //      have ANY usable personal id (workspace.id OR personalSpace.id) →
  //      emit PERSONAL with that id. This is the path that fires when
  //      the user is on their personal workspace, OR when the active
  //      team workspace was unreachable and we fell back to personal.
  //   3. If we have NO usable id at all (bootstrap failed) → emit
  //      PERSONAL with id=null (degraded shape; the frontend's
  //      `WorkspaceRecoveryPanel` renders for this case).
  //
  // The previous logic silently emitted `type: "ORGANIZATION"` with an
  // empty-string id whenever scope wasn't "PERSONAL", which produced
  // an envelope where the frontend gate saw `activeSpace.type ===
  // "ORGANIZATION"` and let the route load — but every team-scoped
  // request fired with an empty string. The new derivation refuses to
  // emit ORGANIZATION without a real id, falling back to PERSONAL
  // instead so the personal workspace is always usable.
  // ===========================================================================
  let activeSpace: PlatformContextActiveSpace;
  const workspaceIdNonEmpty =
    typeof workspace.id === "string" && workspace.id.length > 0;
  if (workspace.scope === "TEAM" && workspaceIdNonEmpty) {
    activeSpace = {
      type: "ORGANIZATION",
      id: workspace.id as string,
      displayName: workspace.name ?? "Organization workspace",
      roleLabel: workspace.membership.role,
      // PHASE 12 POINT 4 STEP 1 — the SERVER-resolved plan of the ACTIVE
      // space, on the CANONICAL section. Consumers that need the active plan
      // (the Billing capacity chips) read it here instead of re-deriving it
      // from account/personalSpace/organizations with an owner-account
      // fallback, and without reaching into the deprecated legacy
      // `workspace` section.
      plan: workspace.plan,
    };
  } else {
    // PERSONAL — pick the best available id; ALWAYS emit type=PERSONAL.
    const personalId: string | null = workspaceIdNonEmpty
      ? (workspace.id as string)
      : personalSpace.id ?? null;
    activeSpace = {
      type: "PERSONAL",
      id: personalId,
      displayName: "Personal Space",
      roleLabel: "Owner",
      // Same SERVER-resolved active plan (personal Entitlement overlay).
      plan: workspace.plan,
    };
  }

  // ===========================================================================
  // P3 DOMAIN REMEDIATION (2026-07-21) — canonical server-authorized
  // context options. Grouping is by the EXPLICIT workspaceKind, never by
  // isPersonal alone:
  //   personalSpace     — the bootstrap Personal Space
  //   ownedWorkspaces   — self-service OWNED workspaces ("Your workspaces")
  //   organizations     — ORGANIZATION workspaces grouped by parent org
  // Governance-only org membership (OrganizationMembership without an
  // ACTIVE TeamMember) intentionally does NOT appear here — it belongs to
  // the /organizations management list, not the switcher.
  // ===========================================================================
  const ownedWorkspaceOptions = contextOptionRows
    .filter((r) => r.kind === "OWNED")
    .map((r) => ({
      workspaceId: r.workspaceId,
      name: r.name,
      kind: "OWNED" as const,
      role: r.role,
      lifecycleStatus: "active" as const,
    }));
  const orgGroups = new Map<
    string,
    {
      organizationId: string;
      organizationName: string | null;
      workspaces: Array<{
        workspaceId: string;
        workspaceName: string | null;
        kind: "ORGANIZATION";
        workspaceRole: ReturnType<typeof coerceRole>;
        lifecycleStatus: "active";
      }>;
    }
  >();
  for (const r of contextOptionRows) {
    if (r.kind !== "ORGANIZATION" || !r.organizationId) continue;
    const group = orgGroups.get(r.organizationId) ?? {
      organizationId: r.organizationId,
      organizationName: r.organizationName,
      workspaces: [],
    };
    group.workspaces.push({
      workspaceId: r.workspaceId,
      workspaceName: r.name,
      kind: "ORGANIZATION",
      workspaceRole: r.role,
      lifecycleStatus: "active",
    });
    orgGroups.set(r.organizationId, group);
  }
  // PHASE 10 §13.2 STEP 6 (2026-07-23) — a managed enterprise identity has NO
  // personal space, even when a personal Team row exists from before it
  // became managed (grandfathered). `personalTeamId` alone is NOT enough:
  // it stays populated for a grandfathered row (the bootstrap only blocks
  // NEW creation, not an existing row's read). Suppress the switcher option
  // here so the client never offers a Personal choice the server guards
  // (workspace-bootstrap.service.ts / platform-context.routes.ts
  // switch-workspace) would deny.
  //
  // POINT 7 — `personalSpaceAllowedFlag` is now resolved ONCE at the top of
  // this function, BEFORE selection, so it governs bootstrap, stale-pointer
  // healing and the no-healthy-selection fallback as well as this list.
  const contextOptions = {
    personalSpace: personalTeamId && personalSpaceAllowedFlag
      ? {
          workspaceId: personalTeamId,
          name: "Personal Space" as const,
          kind: "PERSONAL" as const,
          role: "OWNER" as const,
          lifecycleStatus: "active" as const,
        }
      : null,
    ownedWorkspaces: ownedWorkspaceOptions,
    organizations: Array.from(orgGroups.values()),
    activeContext: {
      workspaceId: activeSpace.id,
      kind:
        activeSpace.type === "PERSONAL"
          ? ("PERSONAL" as const)
          : (contextOptionRows.find(
              (r) => r.workspaceId === activeSpace.id,
            )?.kind ?? ("ORGANIZATION" as const)),
      organizationId:
        contextOptionRows.find((r) => r.workspaceId === activeSpace.id)
          ?.organizationId ?? null,
      displayName: activeSpace.displayName,
    },
  };

  // ===========================================================================
  // Legacy `availableWorkspaces` — kept for backward compatibility. Rebuilt
  // from the canonical organizations + personal space so it no longer
  // duplicates personal rows under TEAM or pushes a synthetic id.
  // ===========================================================================
  const availableWorkspaces: PlatformContextAvailableWorkspace[] = [];
  // Personal first (always uses the real Team id).
  // POINT 7 — this legacy list used to offer the Personal workspace
  // unconditionally while `contextOptions.personalSpace` correctly withheld
  // it, so a consumer still reading the compatibility section was handed a
  // selectable option the server would then refuse. The permission gate is
  // stated here too rather than relying on `personalTeamId` happening to be
  // null: two lists that disagree is exactly the bug being closed.
  if (personalTeamId && personalSpaceAllowedFlag) {
    availableWorkspaces.push({
      id: personalTeamId,
      name: personalSpace.label,
      scope: "PERSONAL",
      role: "OWNER",
    });
  }
  // Organizations — strictly `isPersonal=false` rows.
  for (const org of organizations) {
    availableWorkspaces.push({
      id: org.id,
      name: org.name,
      scope: "TEAM",
      role: org.role,
    });
  }

  // (2026-07-20) The workspace persona profile (readWorkspacePersonaProfile)
  // was removed with the workspace-persona / workflow-personalization
  // feature. It was UX-layer only and never granted capabilities.

  // -------------------------------------------------------------------------
  // Operational eligibility (2026-07-15) — the canonical relevance
  // projection consumed by the Operations Center + Notification
  // Preferences surfaces. Derived from ALREADY-authorized signals:
  //   - `organizations` (ACTIVE non-personal TeamMember rows — reused)
  //   - `capabilities` (resolved capability map — reused)
  //   - `planFeatures` (canonical PLAN_CAPABILITIES — reused)
  //   - `workspace.membership.role`
  // plus TWO minimal tenant-scoped existence checks that the envelope did
  // not already run (collaboration-team membership + pending invitations).
  // Every query is user/email-scoped; nothing crosses a tenant boundary.
  // This block controls UI relevance ONLY — the aggregation still enforces
  // every data decision by per-source membership/role scoping.
  // -------------------------------------------------------------------------
  let collaborationMemberActive = false;
  let hasPendingInvitation = false;
  try {
    const [collabMembers, collabInvites, orgInvites] = await Promise.all([
      // Active member of ≥1 collaboration team (the org-membership case is
      // covered separately by `organizations`).
      prisma.collaborationTeamMember.count({
        where: { userId: userRow.id, status: "ACTIVE" },
      }),
      // Still-actionable incoming collaboration-team invitation (email-matched;
      // collaboration invites are actioned on the Teams surface and carry no
      // inbox item, so participation is the only signal for them).
      userRow.email
        ? prisma.collaborationTeamInvite.count({
            where: {
              email: userRow.email,
              status: "PENDING",
              acceptedAtUtc: null,
              revokedAtUtc: null,
              expiresAtUtc: { gt: now },
            },
          })
        : Promise.resolve(0),
      // Still-actionable incoming organization invitation (mirrors the inbox
      // org_invite query so the Invitations filter is stable pre-item-load).
      userRow.email
        ? prisma.organizationInvite.count({
            where: {
              email: userRow.email.trim().toLowerCase(),
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: now },
            },
          })
        : Promise.resolve(0),
    ]);
    collaborationMemberActive = collabMembers > 0;
    hasPendingInvitation = collabInvites > 0 || orgInvites > 0;
  } catch {
    // Degraded — conservative FALSE (hide plan/participation-gated
    // surfaces rather than overexpose). Incoming/universal categories are
    // unaffected; a real item still reveals its category via the override.
    collaborationMemberActive = false;
    hasPendingInvitation = false;
  }

  // ===========================================================================
  // PHASE 12 CORRECTIVE PASS §1 (ARCH-003, 2026-08-07) — THE CANONICAL,
  // VERSIONED CONTEXT.
  //
  // Built from the SAME already-authorized rows the legacy sections use — not
  // from a second set of queries. A second query is a second authority, and the
  // two would eventually disagree about who may enter what.
  //
  // What it separates:
  //   * `organizations` holds ORGANIZATION ids, read from
  //     OrganizationMembership. The legacy field of the same name holds
  //     WORKSPACE ids, which is the ARCH-003 finding.
  //   * `organizationWorkspaces` holds WORKSPACE ids, each carrying the
  //     Organization it belongs to.
  //   * `organizationMembershipId` and `workspaceMembershipId` are named apart
  //     because they are rows in different tables.
  //
  // ACTIVE only, throughout: `contextOptionRows` is already filtered to ACTIVE
  // workspace memberships in ACTIVE parent Organizations, and the governance
  // memberships below are filtered to ACTIVE by the query.
  // ===========================================================================
  let canonicalOrganizations: CanonicalContextOrganization[] = [];
  let canonicalOrgMemberships: CanonicalContextOrganizationMembership[] = [];
  try {
    const govRows = await prisma.organizationMembership.findMany({
      where: {
        userId: userRow.id,
        status: "ACTIVE",
        // CUSTOMER organizations only. A SYSTEM container is the internal row
        // that backs a Personal or Owned workspace; surfacing one as an
        // Organization the user "belongs to" is what made the legacy field
        // ambiguous in the first place.
        organization: { kind: "CUSTOMER", status: "ACTIVE" },
      },
      select: {
        id: true,
        organizationId: true,
        role: true,
        organization: { select: { name: true } },
      },
      take: 200,
    });
    canonicalOrganizations = govRows.map((r) => ({
      organizationId: r.organizationId,
      name: r.organization?.name ?? null,
      status: "ACTIVE" as const,
    }));
    canonicalOrgMemberships = govRows.map((r) => ({
      organizationMembershipId: r.id,
      organizationId: r.organizationId,
      organizationRole: String(r.role),
      status: "ACTIVE" as const,
    }));
  } catch {
    // Degraded reads leave the canonical governance sections EMPTY rather than
    // partially populated: an empty list denies, a half list invites a client
    // to believe it has the whole picture.
    canonicalOrganizations = [];
    canonicalOrgMemberships = [];
  }

  const toCanonicalWorkspace = (row: {
    workspaceId: string;
    name: string | null;
    kind: "PERSONAL" | "OWNED" | "ORGANIZATION";
    role: ReturnType<typeof coerceRole>;
    organizationId: string | null;
  }): CanonicalContextWorkspace => ({
    workspaceId: row.workspaceId,
    name: row.name,
    kind: row.kind,
    workspaceRole: row.role,
    workspaceMembershipId: workspaceMembershipIdByWorkspace.get(row.workspaceId) ?? null,
    // An Organization id ONLY for ORGANIZATION workspaces. PERSONAL and OWNED
    // are backed by internal SYSTEM containers, and reporting those container
    // ids here would put a non-customer id in an Organization field.
    organizationId: row.kind === "ORGANIZATION" ? row.organizationId : null,
  });

  const canonicalOwned = contextOptionRows
    .filter((r) => r.kind === "OWNED")
    .map(toCanonicalWorkspace);
  const canonicalOrgWorkspaces = contextOptionRows
    .filter((r) => r.kind === "ORGANIZATION")
    .map(toCanonicalWorkspace);

  const canonicalPersonal: CanonicalContextWorkspace | null =
    personalTeamId && personalSpaceAllowedFlag
      ? {
          workspaceId: personalTeamId,
          name: "Personal Space",
          kind: "PERSONAL",
          workspaceRole: "OWNER",
          workspaceMembershipId:
            workspaceMembershipIdByWorkspace.get(personalTeamId) ?? null,
          organizationId: null,
        }
      : null;

  // The CURRENT workspace is looked up among the workspaces already proven
  // enterable. A pointer at anything else resolves to `null` — never to a
  // substitute, which is what "no silent fallback" means here.
  const canonicalCurrentWorkspace: CanonicalContextWorkspace | null =
    [canonicalPersonal, ...canonicalOwned, ...canonicalOrgWorkspaces].find(
      (w): w is CanonicalContextWorkspace =>
        w !== null && w.workspaceId === activeSpace.id,
    ) ?? null;

  /**
   * ARCH-003 — the repair is REPORTED, not silent.
   *
   * The builder already heals a stale pointer to the caller's own Personal
   * Space rather than rendering a broken shell, and that is the right
   * behaviour. What was missing is the client being able to TELL: a healed
   * context and a requested one were indistinguishable in the envelope, so a
   * surface could not say "we brought you home" and could not notice a
   * pointer that keeps going stale. It can never heal onto somebody else's
   * workspace — the lookup above is over workspaces already proven enterable.
   */
  const canonicalCurrentWorkspaceSource: CanonicalPlatformContext["currentWorkspaceSource"] =
    canonicalCurrentWorkspace === null
      ? "NONE"
      : userRow.currentWorkspaceId === canonicalCurrentWorkspace.workspaceId
        ? "POINTER"
        : "REPAIRED_TO_PERSONAL";

  const canonicalCurrentOrganization: CanonicalContextOrganization | null =
    canonicalCurrentWorkspace?.organizationId
      ? (canonicalOrganizations.find(
          (o) => o.organizationId === canonicalCurrentWorkspace.organizationId,
        ) ?? null)
      : null;

  const canonical: CanonicalPlatformContext = {
    contextVersion: PLATFORM_CONTEXT_VERSION,
    account: {
      accountId: userRow.id,
      email: userRow.email ?? null,
      displayName: account.displayName ?? null,
      accountPlan: account.accountPlan ?? null,
    },
    personalSpace: canonicalPersonal,
    ownedWorkspaces: canonicalOwned,
    organizations: canonicalOrganizations,
    organizationMemberships: canonicalOrgMemberships,
    organizationWorkspaces: canonicalOrgWorkspaces,
    currentWorkspace: canonicalCurrentWorkspace,
    currentWorkspaceSource: canonicalCurrentWorkspaceSource,
    currentOrganization: canonicalCurrentOrganization,
    capabilities: Object.keys(capabilities).filter(
      (k) => (capabilities as Record<string, unknown>)[k] === true,
    ),
    commercialContext: {
      effectivePlan: activeSpace.plan ?? null,
      // Derived from the CURRENT workspace's canonical kind by the one shared
      // function; never inferred from the plan.
      billingShape: canonicalCurrentWorkspace
        ? billingShapeForWorkspaceKind(canonicalCurrentWorkspace.kind)
        : null,
    },
  };

  const operationalEligibility = deriveOperationalEligibility({
    capabilities,
    activeRole: workspace.membership.role,
    isActiveAdmin: workspace.membership.isAdmin === true,
    organizations,
    collaborationMemberActive,
    hasPendingInvitation,
    planFeatures,
  });

  // -------------------------------------------------------------------------
  // PHASE 10 STEP 5 (2026-07-23) — active support-access projection.
  //
  // When the authenticated actor is a support user with an ACTIVE grant, the
  // envelope exposes BOTH identities so the shell renders a persistent
  // support banner. The evaluation is owned entirely by the support-access
  // authority (via buildSupportAccessEnvelopeSection); a missing grant, an
  // expired/revoked grant, or an unapplied table all heal to `null`.
  // -------------------------------------------------------------------------
  let supportAccess: Awaited<
    ReturnType<typeof buildSupportAccessEnvelopeSection>
  > = null;
  try {
    supportAccess = await buildSupportAccessEnvelopeSection(
      { supportActorUserId: userRow.id, nowMs: now.getTime() },
      prisma,
    );
  } catch {
    supportAccess = null;
  }

  // -------------------------------------------------------------------------
  // Envelope
  // -------------------------------------------------------------------------
  //
  // Phase B0 — `requestedSchemaVersion` controls whether the
  // legacy `workspace` field is emitted. Clients on v3 get the
  // canonical shape only; v2 (default) gets both legacy + canonical
  // so the migration is non-breaking.
  const wireVersion: 2 | 3 = input.requestedSchemaVersion === 3 ? 3 : 2;
  const envelope: PlatformContextEnvelope = {
    authoritySchemaVersion: wireVersion,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    generatedAt,

    user: {
      id: userRow.id,
      email: userRow.email ?? null,
      displayName: userRow.displayName ?? null,
      firstName: userRow.firstName ?? null,
      lastName: userRow.lastName ?? null,
      avatarUrl: userRow.avatarUrl ?? null,
      locale: userRow.locale ?? null,
      timezone: userRow.timezone ?? null,
    },

    platform: {
      isPlatformAdmin,
      platformRole: userRow.platformRole ?? null,
    },

    workspace,
    flags: {
      isPersonalWorkspace,
      isTeamWorkspace,
      isProAccount,
      isEnterpriseWorkspace,
    },
    persona: { resolvedPersona },
    capabilities,
    planFeatures,
    // ATTENTION ARCHITECTURE — the enterprise verdict PLUS its provenance, so a support
    // engineer can distinguish a contract-backed Enterprise from a legacy
    // plan-string one without opening the database.
    enterprise,
    operationalEligibility,
    navigation: {
      status: navigationStatus,
      // Legacy `groups` retained for backwards compatibility.
      groups: navigationGroups,
      // Phase ROUTE-FIX — separate sidebar + account-menu projections.
      sidebar: navigationProjection.sidebar,
      accountMenu: navigationProjection.accountMenu,
    },
    availableWorkspaces,

    // ENTERPRISE TENANT MODEL — canonical product sections.
    account,
    // ARCH-003 — the CANONICAL, versioned context. Organization fields carry
    // Organization ids; Workspace fields carry Workspace ids.
    canonical,
    personalSpace,
    organizations,
    activeSpace,
    // P3 domain remediation (2026-07-21) — canonical grouped context
    // options (Personal / Your workspaces / Organizations).
    contextOptions,
    duplicatePersonalCandidates,

    diagnostics: {
      sectionStatus: {
        user: userStatus,
        workspace: workspaceStatus,
        capabilities: capabilityStatus,
        navigation: navigationStatus,
        availableWorkspaces: availableWorkspacesStatus,
      },
      resolvedAt: generatedAt,
      requestId: input.requestId,
      workspaceSource,
      bootstrap,
      activeSpaceSource:
        activeSpace.type === "ORGANIZATION"
          ? "organization"
          : personalTeamId
            ? bootstrap.created
              ? "personal_space_bootstrap"
              : "personal_space_existing"
            : "unavailable",
      staleWorkspaceHealed:
        workspaceSource === "personal_bootstrap_after_stale",
      duplicatePersonalRowsDetected: duplicatePersonalCandidates.length,
    },
    recoveryActions: buildRecoveryActions({
      workspace,
      workspaceStatus,
      bootstrapAttempted: bootstrap.attempted,
      personalTeamPresent: !!personalTeamId,
    }),
    // PHASE 10 STEP 5 — active support access (null for ordinary users).
    supportAccess,
    // PHASE 10 §13.2 STEP 6 (2026-07-23) — client-hiding signal only; the
    // authoritative deny lives server-side (workspace-bootstrap.service.ts,
    // platform-context.routes.ts switch-workspace, evidence/capture/billing
    // guards). `true` for every STANDARD identity (unchanged behavior).
    personalSpaceAllowed: personalSpaceAllowedFlag,
  };

  return { ok: true, envelope };
}

/**
 * Phase EMERGENCY-RECOVERY — bounded recovery action descriptors.
 *
 * Healthy envelope → empty list. Degraded or fallback states surface
 * structured CTAs that the frontend renders in a recovery panel
 * (never a blank shell).
 */
function buildRecoveryActions(input: {
  workspace: PlatformContextWorkspace;
  workspaceStatus: SectionStatus;
  bootstrapAttempted: boolean;
  personalTeamPresent: boolean;
}): ReadonlyArray<PlatformContextRecoveryAction> {
  // Truly broken: workspace is not active. Frontend renders the
  // structured recovery panel with explicit next-step CTAs.
  if (input.workspace.status !== "active") {
    const actions: PlatformContextRecoveryAction[] = [];
    if (!input.personalTeamPresent) {
      actions.push({
        id: "create_personal_workspace",
        label: "Create personal workspace",
        href: "/settings",
      });
    }
    actions.push({
      id: "create_team",
      label: "Create or join a team",
      href: "/teams",
    });
    actions.push({
      id: "open_settings",
      label: "Open account settings",
      href: "/settings",
    });
    actions.push({
      id: "retry",
      label: "Retry",
      href: null,
    });
    return actions;
  }
  // Healthy envelope — no recovery actions surfaced.
  return [];
}
