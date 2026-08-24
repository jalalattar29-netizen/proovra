/**
 * PHASE 12 REMEDIATION — §4.6 / AUTH-002 (2026-08-06).
 *
 * ONE canonical answer to "which workspaces may this user operate in right
 * now, and with what role?"
 *
 * The defect this replaces
 * ------------------------
 * `GET /v1/me/inbox` derived the caller's workspace set from
 * `prisma.teamMember.findMany({ where: { userId } })` — NO status predicate.
 * The set then scoped every inbox source, so a SUSPENDED or REVOKED member
 * kept seeing that workspace's governance notifications, workflow items and
 * reviewer work. The same status-blind shape appeared three more times in
 * the same handler: adjudicator privilege was derived from a bare `role`,
 * the `?workspaceId` narrowing accepted any membership row, and — most
 * pointedly — the MEMBERSHIP-LOSS REDACTION, whose whole purpose is to
 * withhold history from workspaces the caller "can no longer access",
 * rebuilt its accessible set the same status-blind way. A REVOKED row
 * satisfied its test, so the redaction never fired.
 *
 * Why a resolver rather than four fixes
 * -------------------------------------
 * "Which workspaces can this user see?" is ONE question. Answering it in
 * four places is what allowed three of the four answers to drift from the
 * fourth. This module answers it once; the handler asks.
 *
 * The rules, all enforced here
 * ----------------------------
 *   * Only an ACTIVE TeamMember row contributes a workspace.
 *   * A member whose `accessExpiresAtUtc` has passed contributes nothing —
 *     the same expiry rule the canonical access-policy engine applies.
 *   * ORGANIZATION-provisioned workspaces additionally require their parent
 *     CUSTOMER Organization to be ACTIVE. A SUSPENDED or ARCHIVED
 *     organization removes its workspaces from the set.
 *   * A workspace whose kind cannot be proven contributes nothing (fail
 *     closed — never "assume PERSONAL", never "assume exempt").
 *   * PERSONAL Space follows the IDENTITY-MODE path: the owner of a
 *     personal workspace reaches it by OWNERSHIP. That fallback is
 *     restricted to `isPersonal = true` rows and grants the canonical OWNER
 *     role. No synthetic TeamMember row is fabricated for it.
 *
 * Relationship to the authorization primitive
 * -------------------------------------------
 * This is an ENUMERATION helper, not an authorization gate. It answers
 * "what may I list?"; `authorizeWorkspaceOrFail` answers "may I do X here?".
 * Both derive from the same facts, and this module deliberately reuses the
 * same canonical classifier (`resolveWorkspaceKind`,
 * `organizationLifecycleApplies`) and the same status predicate
 * (`teamMemberStatusGrantsAccess`) so the two can never disagree about who
 * is inside a workspace.
 */

import type { PrismaClient } from "@prisma/client";
import {
  mapTeamRoleToCanonical,
  teamMemberStatusGrantsAccess,
  type CanonicalRole,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  organizationLifecycleApplies,
  resolveWorkspaceKind,
} from "../identity/workspace-kind.js";

export type AccessibleWorkspaceKind = "PERSONAL" | "OWNED" | "ORGANIZATION";

export type AccessibleWorkspace = {
  workspaceId: string;
  name: string;
  kind: AccessibleWorkspaceKind;
  /** Canonical role. OWNER/ADMIN map 1:1; DB MEMBER maps to REVIEWER. */
  role: CanonicalRole;
  organizationId: string | null;
  /**
   * WORKSPACE-SCOPE CONVERGENCE — the workspace owner.
   *
   * Carried so a multi-workspace read can build the canonical Evidence scope
   * for every workspace in this list WITHOUT a second query per workspace.
   * The personal-workspace arm of that scope is owner-bound, and this is the
   * id it binds to; without it a caller would have to guess that "the owner
   * of a personal workspace I can reach is me", which is true today and is
   * not a thing a read scope should be resting on.
   */
  ownerUserId: string | null;
  /**
   * How this workspace entered the set:
   *   `membership` — an ACTIVE TeamMember row;
   *   `personal_ownership` — the identity-mode Personal Space path.
   */
  via: "membership" | "personal_ownership";
};

/**
 * Every workspace the user may currently operate in.
 *
 * Ordering is not guaranteed and must not be relied on for selection — a
 * caller that needs "a default context" must ask context restoration, which
 * applies the Organization's `noPersonalSpace` policy. This function only
 * reports what is reachable.
 */
export async function listAccessibleWorkspaces(
  input: { userId: string },
  client: PrismaClient = defaultPrisma,
): Promise<AccessibleWorkspace[]> {
  const now = Date.now();
  const rows = await client.teamMember.findMany({
    where: { userId: input.userId },
    select: {
      teamId: true,
      role: true,
      status: true,
      accessExpiresAtUtc: true,
      team: {
        select: {
          id: true,
          name: true,
          isPersonal: true,
          ownerUserId: true,
          workspaceKind: true,
          billingPlan: true,
          organizationId: true,
          organization: { select: { status: true } },
        },
      },
    },
  });

  const out = new Map<string, AccessibleWorkspace>();
  for (const row of rows) {
    // 1. Membership must be ACTIVE. SUSPENDED and REVOKED contribute
    //    nothing — not the workspace, and therefore not its stored role.
    if (!teamMemberStatusGrantsAccess(row.status)) continue;
    // 2. Time-boxed access must not have elapsed.
    if (
      row.accessExpiresAtUtc !== null &&
      row.accessExpiresAtUtc.getTime() <= now
    ) {
      continue;
    }
    const team = row.team;
    if (!team) continue;
    // 3. Kind must be provable; UNKNOWN fails closed.
    const kind = resolveWorkspaceKind({
      workspaceKind: team.workspaceKind,
      isPersonal: team.isPersonal,
      billingPlan: team.billingPlan,
      teamLoaded: true,
    });
    if (kind === "UNKNOWN") continue;
    // 4. ORGANIZATION-provisioned workspaces inherit their organization's
    //    lifecycle. Missing, SUSPENDED and ARCHIVED all remove the
    //    workspace from the set.
    if (organizationLifecycleApplies(kind)) {
      if (team.organization?.status !== "ACTIVE") continue;
    }
    out.set(team.id, {
      workspaceId: team.id,
      name: team.name,
      kind,
      role: mapTeamRoleToCanonical(row.role),
      organizationId: team.organizationId ?? null,
      ownerUserId: team.ownerUserId ?? null,
      via: "membership",
    });
  }

  // 5. PERSONAL Space identity-mode path. Some bootstrap/seeding paths
  //    create the personal Team row without a TeamMember row; the owner
  //    still reaches it, by OWNERSHIP, as its canonical OWNER. Restricted
  //    to `isPersonal = true` — a self-service OWNED workspace is NOT
  //    reachable by ownership alone and must have an ACTIVE membership like
  //    any other collaborative context.
  const ownedPersonal = await client.team.findMany({
    where: { ownerUserId: input.userId, isPersonal: true },
    select: { id: true, name: true, organizationId: true, ownerUserId: true },
  });
  for (const t of ownedPersonal) {
    if (out.has(t.id)) continue;
    out.set(t.id, {
      workspaceId: t.id,
      name: t.name,
      kind: "PERSONAL",
      role: "OWNER",
      organizationId: t.organizationId ?? null,
      ownerUserId: t.ownerUserId ?? null,
      via: "personal_ownership",
    });
  }

  return Array.from(out.values());
}

/**
 * Whether ONE named workspace is currently accessible to the user, and with
 * what role. Returns `null` when it is not — the caller must then conceal
 * the workspace's existence, never distinguish "absent" from "forbidden".
 */
export async function resolveAccessibleWorkspace(
  input: { userId: string; workspaceId: string },
  client: PrismaClient = defaultPrisma,
): Promise<AccessibleWorkspace | null> {
  const all = await listAccessibleWorkspaces(
    { userId: input.userId },
    client,
  );
  return all.find((w) => w.workspaceId === input.workspaceId) ?? null;
}
