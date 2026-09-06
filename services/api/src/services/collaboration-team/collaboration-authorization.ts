/**
 * THE ONE authorization entry point for every Collaboration Teams surface.
 *
 * =============================================================================
 * WHY THIS MODULE EXISTS
 * =============================================================================
 * `collaboration-teams.routes.ts` and `collaboration-completion.routes.ts` were
 * the only two production consumers of `resolveActiveOperationalWorkspace`, and
 * they were the only three route files in the API (with `teams.routes.ts`) that
 * never called the canonical authorization primitive. That resolver reads an
 * `x-team-id` header the web client never sent, and then FALLS BACK to the
 * caller's Personal Space — so every collaboration read and write operated on
 * the caller's personal workspace no matter which workspace the product said
 * they were in. An Organization owner saw "0 of 5 teams used" on a workspace
 * that held a Collaboration Team with a thousand members.
 *
 * The fix is not a better fallback. It is to stop having one: a request that
 * cannot prove which workspace it is operating in is a DENIAL, not an
 * invitation to pick a workspace on the caller's behalf.
 *
 * =============================================================================
 * WHAT IT GUARANTEES
 * =============================================================================
 *   1. The workspace is named by the request (header / query) or by the
 *      caller's own `User.currentWorkspaceId` pointer, and either way it is
 *      REVALIDATED in full by `evaluateAuthorizedWorkspace`: identity,
 *      workspace existence, workspace kind, EXPLICIT membership, membership
 *      status, access expiry, Organization lifecycle, canonical permission and
 *      the support-access guard.
 *   2. There is NO personal fallback. A missing or unusable workspace context
 *      conceals as 404 through the canonical anti-enumeration path.
 *   3. A Collaboration Team is only reachable when
 *      `collaborationTeam.workspaceId === ctx.workspaceId`. A caller holding a
 *      foreign team id gets the same 404 as one holding a nonexistent id.
 *   4. Group-local authority (LEAD / ADMIN / MEMBER / VIEWER / EXTERNAL) is
 *      evaluated on top of workspace authority, never instead of it.
 *
 * =============================================================================
 * TWO LAYERS, BOTH REQUIRED
 * =============================================================================
 * A Collaboration Team is a grouping INSIDE a workspace. It grants nothing on
 * its own. So every operation answers two questions in this order:
 *
 *   "may this actor act in this WORKSPACE at all?"   → canonical Permission
 *   "may this actor act on this GROUP?"              → CollaborationTeamPermission
 *
 * Collapsing them — which the old code did, by checking only the second — is
 * how a workspace member who had been suspended kept full access to the
 * group, and how a workspace VIEWER could post into a team discussion.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Permission } from "@proovra/shared";
import {
  collaborationTeamRoleHasPermission,
  type CollaborationTeamPermission,
  type CollaborationTeamRole,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  authorizeWorkspaceOrFail,
  authorizeCurrentWorkspaceOrFail,
  type AuthorizedWorkspaceContext,
} from "../../middleware/authorize.js";

/**
 * The header the web client sets on every request from the canonical active
 * workspace (`apps/web/lib/api.ts`).
 *
 * `x-team-id` is accepted as an alias because integrations and older clients
 * send it, and because refusing a correct-but-differently-named binding would
 * push callers back onto the pointer fallback for no security gain. Both are
 * candidates only — neither authorizes anything by itself.
 */
const WORKSPACE_HEADER = "x-proovra-workspace-id";
const LEGACY_WORKSPACE_HEADER = "x-team-id";

function headerValue(req: FastifyRequest, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].length > 0) {
    return raw[0];
  }
  return null;
}

/**
 * The workspace the request NAMES, or null.
 *
 * Deliberately does NOT read `teamId` from the body or the route params. On
 * every one of these routes `:teamId` is the COLLABORATION TEAM id — the same
 * word for a different entity — and the old resolver's willingness to accept
 * it as a workspace id is exactly the confusion this module exists to end.
 * `workspaceId` is read from the query because a few GET surfaces pass it
 * there; nothing reads it from a body.
 */
export function readNamedWorkspaceId(req: FastifyRequest): string | null {
  const header =
    headerValue(req, WORKSPACE_HEADER) ??
    headerValue(req, LEGACY_WORKSPACE_HEADER);
  if (header) return header;
  const query = (req.query as Record<string, unknown> | undefined)?.workspaceId;
  if (typeof query === "string" && query.length > 0) return query;
  return null;
}

/**
 * Authorize the actor in the workspace this request operates on.
 *
 * A named workspace DECIDES the outcome: it is revalidated, and if the actor
 * cannot act there the request is refused. It is never quietly replaced with a
 * workspace the actor CAN act in. Only when nothing is named does the caller's
 * own `currentWorkspaceId` pointer supply a candidate — and that candidate is
 * revalidated by the same evaluator, so a pointer at a workspace the caller was
 * removed from authorizes nothing.
 *
 * Returns `null` after the canonical denial response has been sent.
 */
export async function authorizeCollaborationWorkspace(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
  client: PrismaClient = defaultPrisma,
): Promise<AuthorizedWorkspaceContext | null> {
  const named = readNamedWorkspaceId(req);
  const ctx = named
    ? await authorizeWorkspaceOrFail(req, reply, {
        workspaceId: named,
        permission,
        antiEnumeration: true,
      })
    : await authorizeCurrentWorkspaceOrFail(req, reply, {
        permission,
        antiEnumeration: true,
      });
  if (!ctx) return null;

  /**
   * A CLOSED WORKSPACE IS NOT AN OPERATIONAL ONE.
   *
   * Closure mass-revokes every membership, so the authorization above already
   * refuses a closed workspace in practice — that is the primary defence and it
   * is a good one. This is the second: `Team.closedAtUtc` is THE liveness
   * authority (ADM-004), a membership row that outlived a closure for any
   * reason must not become a way back in, and a collaboration surface is
   * exactly where such a row would go unnoticed, because closure does not
   * touch a single `collaboration_team*` table.
   */
  const workspace = await client.team.findUnique({
    where: { id: ctx.workspaceId },
    select: { closedAtUtc: true },
  });
  if (!workspace || workspace.closedAtUtc !== null) {
    void reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  return ctx;
}

export type CollaborationTeamBinding = {
  /** Proven workspace authority. Every predicate is written against this. */
  readonly workspace: AuthorizedWorkspaceContext;
  readonly team: {
    readonly id: string;
    readonly workspaceId: string;
    readonly status: string;
  };
  /** The actor's ACTIVE group role, or null when membership was not required. */
  readonly groupRole: CollaborationTeamRole | null;
};

export type CollaborationTeamBindingOptions = {
  /** The `:teamId` route param — a CollaborationTeam id. */
  collaborationTeamId: string;
  /** Workspace-level permission the actor must hold. */
  permission: Permission;
  /**
   * Group-level permission the actor must hold. When omitted, ACTIVE group
   * membership is still required (reading a group you are not in is not a
   * thing) unless `requireGroupMembership` is explicitly false.
   */
  groupPermission?: CollaborationTeamPermission;
  /**
   * Set false ONLY for operations whose subject is the workspace rather than
   * the group's own membership (there are none today; the flag exists so a
   * future caller states its intent rather than dropping the check silently).
   */
  requireGroupMembership?: boolean;
  /** Refuse when the group is ARCHIVED. Mutations pass true. */
  requireActiveTeam?: boolean;
};

/**
 * ONE opaque refusal for every "you cannot reach this group" outcome.
 *
 * The group does not exist, it belongs to another workspace, you are not a
 * member of it, or your group role does not carry the permission — all four
 * answer 404. Distinguishing them would let a caller holding a guessed uuid
 * learn which Collaboration Teams exist in tenants they cannot see, which is
 * the anti-enumeration rule the rest of the platform already follows
 * (`collaboration.routes.ts`) and this surface did not.
 */
function refuse(reply: FastifyReply): null {
  void reply.code(404).send({ error: { code: "not_found" } });
  return null;
}

/**
 * Bind a request to ONE Collaboration Team inside ONE proven workspace.
 *
 * Returns `null` after the refusal has been sent.
 */
export async function authorizeCollaborationTeam(
  req: FastifyRequest,
  reply: FastifyReply,
  options: CollaborationTeamBindingOptions,
  client: PrismaClient = defaultPrisma,
): Promise<CollaborationTeamBinding | null> {
  const workspace = await authorizeCollaborationWorkspace(
    req,
    reply,
    options.permission,
    client,
  );
  if (!workspace) return null;

  const team = await client.collaborationTeam.findUnique({
    where: { id: options.collaborationTeamId },
    select: { id: true, workspaceId: true, status: true },
  });

  // THE containment check. A Collaboration Team is reachable only from the
  // workspace that contains it — never by id alone, which is how
  // `getCollaborationTeamDetail` used to be reachable across tenants.
  if (!team || team.workspaceId !== workspace.workspaceId) {
    return refuse(reply);
  }

  if (options.requireActiveTeam && team.status !== "ACTIVE") {
    void reply.code(409).send({
      error: { code: "collaboration_team_archived" },
      message: "This team is archived. Reopen it before making changes.",
    });
    return null;
  }

  if (options.requireGroupMembership === false) {
    return { workspace, team, groupRole: null };
  }

  const member = await client.collaborationTeamMember.findFirst({
    where: {
      teamId: team.id,
      userId: workspace.userId,
      status: "ACTIVE",
    },
    select: { role: true },
  });
  if (!member) return refuse(reply);

  const groupRole = member.role as CollaborationTeamRole;
  if (
    options.groupPermission &&
    !collaborationTeamRoleHasPermission(groupRole, options.groupPermission)
  ) {
    return refuse(reply);
  }

  return { workspace, team, groupRole };
}
