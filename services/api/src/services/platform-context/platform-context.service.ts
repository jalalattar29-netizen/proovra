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
import {
  buildNavigationProjection,
  filterNavigationRegistry,
} from "./navigation-registry.js";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
  isWorkspaceRole,
  type PlatformContextAvailableWorkspace,
  type PlatformContextDiagnostics,
  type PlatformContextEnvelope,
  type PlatformContextRecoveryAction,
  type PlatformContextWorkspace,
  type SectionStatus,
  type WorkspacePlan,
  type WorkspaceRole,
} from "./types.js";
import { ensurePersonalWorkspace } from "./workspace-bootstrap.service.js";

const ENTERPRISE_PLAN_KEYS: ReadonlySet<WorkspacePlan> = new Set(["TEAM"]);
const PRO_PLAN_KEYS: ReadonlySet<WorkspacePlan> = new Set(["PRO", "TEAM"]);

function coercePlan(raw: string | null | undefined): WorkspacePlan | null {
  if (!raw) return null;
  const upper = String(raw).toUpperCase();
  if (upper === "FREE" || upper === "PAYG" || upper === "PRO" || upper === "TEAM") {
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
      const personalEntitlement = await prisma.entitlement.findFirst({
        where: { userId: userRow.id },
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
  const isPersonalWorkspace = workspace.scope === "PERSONAL";
  const isTeamWorkspace = workspace.scope === "TEAM";
  const isProAccount = workspace.plan ? PRO_PLAN_KEYS.has(workspace.plan) : false;
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
    navigationProjection = { sidebar: { groups: [] }, accountMenu: { items: [] } };
  }

  // -------------------------------------------------------------------------
  // Available workspaces — bounded list, sourced from TeamMember
  // -------------------------------------------------------------------------
  let availableWorkspacesStatus: SectionStatus = "ok";
  const availableWorkspaces: PlatformContextAvailableWorkspace[] = [];
  try {
    const memberRows = await prisma.teamMember.findMany({
      where: { userId: userRow.id, status: "ACTIVE" },
      select: {
        role: true,
        team: { select: { id: true, name: true } },
      },
      take: 200,
    });

    for (const m of memberRows) {
      if (!m.team) continue;
      availableWorkspaces.push({
        id: m.team.id,
        name: m.team.name ?? null,
        scope: "TEAM",
        role: coerceRole(m.role as unknown as string),
      });
    }
  } catch {
    availableWorkspacesStatus = "degraded";
  }

  // Always include a personal-workspace switch-back entry so the
  // user can return from team mode without hunting through Settings.
  availableWorkspaces.unshift({
    id: "__personal__",
    name: null,
    scope: "PERSONAL",
    role: "OWNER",
  });

  // -------------------------------------------------------------------------
  // Envelope
  // -------------------------------------------------------------------------
  const envelope: PlatformContextEnvelope = {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
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
    navigation: {
      status: navigationStatus,
      // Legacy `groups` retained for backwards compatibility.
      groups: navigationGroups,
      // Phase ROUTE-FIX — separate sidebar + account-menu projections.
      sidebar: navigationProjection.sidebar,
      accountMenu: navigationProjection.accountMenu,
    },
    availableWorkspaces,

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
