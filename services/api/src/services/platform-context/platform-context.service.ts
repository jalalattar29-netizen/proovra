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
import { filterNavigationRegistry } from "./navigation-registry.js";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
  isWorkspaceRole,
  type PlatformContextAvailableWorkspace,
  type PlatformContextEnvelope,
  type PlatformContextWorkspace,
  type SectionStatus,
  type WorkspacePlan,
  type WorkspaceRole,
} from "./types.js";

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
  // -------------------------------------------------------------------------
  let workspaceStatus: SectionStatus = "ok";
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

  if (userRow.currentWorkspaceId) {
    try {
      const team = await prisma.team.findUnique({
        where: { id: userRow.currentWorkspaceId },
        select: {
          id: true,
          name: true,
          billingPlan: true,
          _count: { select: { members: true } },
        },
      });

      if (!team) {
        // currentWorkspaceId points at a deleted/inaccessible team.
        // Fall through to PERSONAL — the workspace switcher will let
        // the user pick another one. Status is degraded so the
        // frontend can surface a hint.
        workspaceStatus = "degraded";
      } else {
        const membership = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: team.id,
              userId: userRow.id,
            },
          },
          select: { role: true, status: true },
        });

        const role: WorkspaceRole | null =
          membership && membership.status === "ACTIVE"
            ? coerceRole(membership.role as unknown as string)
            : null;

        workspace = {
          status: "active",
          id: team.id,
          name: team.name ?? null,
          scope: "TEAM",
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
  } else {
    // Personal workspace — synthesize OWNER membership. PRO plan
    // surfaces via flags but does NOT change the role.
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

    // Best-effort plan resolution from the user's personal
    // entitlement, so flags.isProAccount can be set correctly.
    try {
      const personalEntitlement = await prisma.entitlement.findFirst({
        where: { userId: userRow.id },
        orderBy: { createdAt: "desc" },
        select: { plan: true },
      });
      const personalPlan = coercePlan(
        personalEntitlement?.plan as unknown as string,
      );
      workspace = { ...workspace, plan: personalPlan };
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
  try {
    navigationGroups = filterNavigationRegistry(capabilities);
  } catch {
    navigationStatus = "degraded";
    navigationGroups = [];
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
      groups: navigationGroups,
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
    },
  };

  return { ok: true, envelope };
}
