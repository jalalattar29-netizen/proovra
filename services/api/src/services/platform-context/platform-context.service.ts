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
import {
  buildNavigationProjection,
  filterNavigationRegistry,
} from "./navigation-registry.js";
import {
  AUTHORITY_SCHEMA_VERSION,
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
} from "./types.js";
import { ensurePersonalWorkspace } from "./workspace-bootstrap.service.js";
import { readWorkspacePersonaProfile } from "./persona-profile.service.js";

// Locked product model: only the ENTERPRISE plan (ORGANIZATION workspace)
// is an enterprise workspace. TEAM is a subscription plan inside a PERSONAL
// workspace — it is NOT enterprise and must NOT unlock ENTERPRISE-tier
// surfaces (review ops, governance, SSO/SCIM, investigation, org admin).
// TEAM retains its PROFESSIONAL tier + all TEAM plan capabilities via the
// plan path (`tiersAllowedByPlan`) and `getPlanCapabilities("TEAM")`; those
// are independent of this flag.
const ENTERPRISE_PLAN_KEYS: ReadonlySet<WorkspacePlan> = new Set(["ENTERPRISE"]);
const PRO_PLAN_KEYS: ReadonlySet<WorkspacePlan> = new Set(["PRO", "TEAM"]);

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
  let isPlatformAdmin = false;
  try {
    isPlatformAdmin = await resolveIsPlatformAdmin(
      userRow.id,
      input.jwtRole ?? null,
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
    plan: null,
    membership: {
      role: "OWNER",
      isOwner: true,
      isAdmin: true,
      memberCount: 1,
    },
  };

  // Step 1 — ensure the user has a personal workspace. This is
  // idempotent (the loser of a concurrent insert race re-fetches the
  // winner). The personal team is the fallback target whenever the
  // selected `currentWorkspaceId` is missing or stale.
  let personalTeamId: string | null = null;
  let personalTeamName: string | null = null;
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

  if (userRow.currentWorkspaceId) {
    try {
      const team = await prisma.team.findUnique({
        where: { id: userRow.currentWorkspaceId },
        select: {
          id: true,
          name: true,
          billingPlan: true,
          isPersonal: true,
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
        // fall through to the personal workspace.
        workspaceStatus = "degraded";
        workspaceSource = "personal_bootstrap_after_stale";
        if (personalTeamId) {
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
        // Healthy team selection. Distinguish PERSONAL vs TEAM scope
        // via the `isPersonal` column.
        const role: WorkspaceRole | null = coerceRole(
          membership!.role as unknown as string,
        );
        workspaceSource = "current_workspace_id";
        workspace = {
          status: "active",
          id: team.id,
          name: team.name ?? null,
          scope: team.isPersonal ? "PERSONAL" : "TEAM",
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
    } else {
      // Bootstrap genuinely failed (DB unavailable etc.). Surface a
      // synthetic personal-mode envelope so the frontend renders a
      // recovery shell — but DO NOT pretend the workspace is broken.
      workspace = {
        status: "active",
        id: null,
        name: null,
        scope: "PERSONAL",
        plan: null,
        membership: {
          role: "OWNER",
          isOwner: true,
          isAdmin: true,
          memberCount: 1,
        },
      };
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

  const isPersonalWorkspace = workspace.scope === "PERSONAL";
  const isTeamWorkspace = workspace.scope === "TEAM";
  const isProAccount = accountPlan ? PRO_PLAN_KEYS.has(accountPlan) : false;
  // `isEnterpriseWorkspace` is intentionally workspace-scoped — Enterprise
  // is a workspace/team tier, distinct from the account-level PRO flag above.
  const isEnterpriseWorkspace = workspace.plan
    ? ENTERPRISE_PLAN_KEYS.has(workspace.plan)
    : false;

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
  // -------------------------------------------------------------------------
  const planCaps = getPlanCapabilities(
    (workspace.plan ?? "FREE") as Parameters<typeof getPlanCapabilities>[0],
  );
  const planFeatures = {
    reportsIncluded: planCaps.reportsIncluded,
    verificationPackageIncluded: planCaps.verificationPackageIncluded,
    intakeIncluded: planCaps.intakeIncluded,
    casesIncluded: planCaps.casesIncluded,
    reviewerOperationsIncluded: planCaps.reviewerOperationsIncluded,
    reviewQueuesIncluded: planCaps.reviewQueuesIncluded,
    teamCollaborationIncluded: planCaps.maxOwnedTeams > 0,
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
  type PersonalTeamRow = {
    id: string;
    name: string | null;
    ownerUserId: string;
    memberCount: number;
    billingPlan: string | null;
  };
  const personalTeams: PersonalTeamRow[] = [];
  try {
    const memberRows = await prisma.teamMember.findMany({
      where: { userId: userRow.id, status: "ACTIVE" },
      select: {
        role: true,
        status: true,
        team: {
          select: {
            id: true,
            name: true,
            isPersonal: true,
            ownerUserId: true,
            billingPlan: true,
            _count: { select: { members: true } },
          },
        },
      },
      take: 200,
    });

    for (const m of memberRows) {
      if (!m.team) continue;
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
    };
  }

  // ===========================================================================
  // Legacy `availableWorkspaces` — kept for backward compatibility. Rebuilt
  // from the canonical organizations + personal space so it no longer
  // duplicates personal rows under TEAM or pushes a synthetic id.
  // ===========================================================================
  const availableWorkspaces: PlatformContextAvailableWorkspace[] = [];
  // Personal first (always uses the real Team id).
  if (personalTeamId) {
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

  // -------------------------------------------------------------------------
  // PHASE 38 — Workspace persona profile (UX-layer only).
  //
  // The profile NEVER grants capabilities. It only changes ordering,
  // defaults, and terminology on the client. The resolver always returns
  // a complete profile (defaulted when no row exists or the read fails).
  // -------------------------------------------------------------------------
  const personaProfile = await readWorkspacePersonaProfile({
    teamId: activeSpace.type === "PERSONAL" ? activeSpace.id : activeSpace.id,
    resolvedRolePersona: resolvedPersona,
  });

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
    personalSpace,
    organizations,
    activeSpace,
    personaProfile,
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
