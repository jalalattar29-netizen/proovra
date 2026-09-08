/**
 * PROOVRA Phase 5 — Collaboration Teams API routes.
 *
 * Mounted under `/v1/collaboration-teams` (distinct from the legacy
 * `/v1/teams` workspace-admin endpoints which remain authoritative
 * for runtime workspace administration).
 *
 * Constitutional rules:
 *
 *   - Personal users CAN create collaboration teams (no Organization
 *     required).
 *   - Every mutation goes through the canonical service module.
 *   - Every successful mutation emits a tenant-audit event via the
 *     canonical `emitTenantAudit` facade.
 *   - Invitations are EMAIL-ONLY (Teams Entitlement Alignment,
 *     2026-07-14). Raw invite tokens are NEVER returned by the API —
 *     the token is delivered out-of-band via the invite email and the
 *     database stores the sha256 hash only.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  collaborationTeamRoleHasPermission,
  type Permission,
} from "@proovra/shared";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { contextHasCapability } from "../middleware/authorize.js";
import { getAuthUserId } from "../auth.js";
import {
  authorizeCollaborationTeam,
  authorizeCollaborationWorkspace,
} from "../services/collaboration-team/collaboration-authorization.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import {
  CollaborationTeamError,
  acceptInvite,
  addExistingMember,
  archiveCollaborationTeam,
  assessCollaborationTeamDisposability,
  deleteCollaborationTeam,
  changeMemberRole,
  createAssignment,
  createCollaborationTeam,
  getCollaborationTeamDetail,
  listAssignments,
  listCollaborationTeamMembers,
  listCollaborationTeams,
  listAssignableTargets,
  getTeamOverview,
  listResponsibilityForTarget,
  listEligibleWorkspaceMembersForTeam,
  listTeamActivity,
  reinstateMember,
  removeMember,
  revokeInvite,
  suspendMember,
  unarchiveCollaborationTeam,
  updateAssignment,
  updateCollaborationTeam,
} from "../services/collaboration-team/collaboration-team.service.js";
import { resolveCollaborationEntitlement } from "../services/collaboration-team/collaboration-entitlement.service.js";
import {
  BillingLimitError,
  assertCanCreateCollaborationTeam,
  assertCollaborationTeamMemberLimit,
  assertSubscriptionActiveOrGraceAllowed,
} from "../services/collaboration-team/billing-guards.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Phase 10 — translate a `BillingLimitError` thrown by the canonical
 * billing-guard helpers into the canonical structured HTTP response.
 *
 * Shape (fixed by Phase 10):
 *   {
 *     code:        <CollaborationTeamBillingErrorCode>,
 *     message:     <operator-readable string>,
 *     details:     <machine-readable context: plan/limit/usage/...>,
 *     upgradeHref: "/billing",
 *     requestId:   <existing request id | null>,
 *   }
 *
 * Returns `true` if the error was a billing-limit error (and was
 * responded to); `false` otherwise so the caller can fall through to
 * its normal error pipeline.
 */
function handleBillingError(
  reply: FastifyReply,
  err: unknown,
  requestId: string | null,
): boolean {
  if (err instanceof BillingLimitError) {
    void reply.code(err.httpStatus).send({
      code: err.code,
      message: err.message,
      details: err.details,
      upgradeHref: err.upgradeCta,
      requestId,
    });
    return true;
  }
  return false;
}

/**
 * Resolve the PROVEN workspace this request operates in.
 *
 * Replaces `requireWorkspaceMembership`, which called
 * `resolveActiveOperationalWorkspace` and therefore silently answered "your
 * Personal Space" whenever the client named no workspace — which the web
 * client never did. Every caller below now receives a workspace it has been
 * authorized in, or nothing.
 *
 * `permission` is the WORKSPACE-level floor for the operation. Group-local
 * authority is a second, separate check (`authorizeCollaborationTeam`).
 */
async function requireWorkspace(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
): Promise<{
  workspaceId: string;
  userId: string;
  /**
   * WCR-6A — does this actor administer the workspace, as opposed to merely
   * participating in it?
   *
   * `identity.member.role.change` is held by OWNER and ADMIN and by nobody
   * else (REVIEWER, CONTRIBUTOR and VIEWER do not carry it). It is the
   * canonical statement of "you decide who is in this workspace and what they
   * may do", which is exactly the authority that should also be able to see
   * how those people are grouped. No new permission was minted for this: a
   * governance capability invented for one surface is a second authority by
   * another name.
   *
   * It grants VISIBILITY only. It is never read as group membership, never
   * confers Discussion or Assignment participation, and never widens Evidence
   * access — those remain gated by their own checks.
   */
  canGovernWorkspace: boolean;
} | null> {
  const ctx = await authorizeCollaborationWorkspace(req, reply, permission);
  if (!ctx) return null;
  return {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    canGovernWorkspace: contextHasCapability(ctx, "identity.member.role.change"),
  };
}

/**
 * WCR-19 — the mutation variant: refuse, and record that the refusal happened.
 *
 * Kept separate from `handleServiceError` rather than adding an optional
 * argument to it, because "did this refusal get audited?" is then answerable by
 * reading the call site instead of by reading whether a fourth parameter was
 * passed. Reads keep the plain helper: a denied read is already covered by the
 * authorization layer's own emission, and duplicating it here would double-count.
 */
async function handleMutationError(
  reply: FastifyReply,
  err: unknown,
  requestId: string | null,
  audit: {
    userId: string;
    workspaceId: string;
    action: string;
    resourceType: string;
    resourceId: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await auditDenial({ ...audit, err, requestId });
  handleServiceError(reply, err, requestId);
}

function handleServiceError(
  reply: FastifyReply,
  err: unknown,
  requestId: string | null,
): void {
  // Phase 10 billing-guard errors get the canonical structured response.
  if (handleBillingError(reply, err, requestId)) {
    return;
  }
  if (err instanceof CollaborationTeamError) {
    // `code` is the stable machine code (INVITE_EXPIRED, INVITE_REVOKED,
    // WORKSPACE_MEMBERSHIP_REQUIRED, ...). `error` mirrors it for
    // backwards compatibility with older consumers.
    void reply.code(err.httpStatus).send({
      code: err.code,
      error: err.code,
      message: err.message,
      requestId,
    });
    return;
  }
  void reply.code(500).send({
    error: "internal_error",
    message: "Something went wrong.",
    requestId,
  });
}

async function auditEvent(args: {
  userId: string;
  workspaceId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: "success" | "failure" | "blocked";
  requestId: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await emitTenantAudit({
    action: args.action,
    outcome: args.outcome === "blocked" ? "denied" : args.outcome === "failure" ? "error" : "success",
    sourceApp: "API",
    actorUserId: args.userId,
    workspaceId: args.workspaceId,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
    correlationId: args.requestId,
    metadata: args.metadata ?? {},
  });
}

/**
 * WCR-19 (2026-09-07) — A REFUSAL IS AN AUDITABLE FACT.
 *
 * `auditEvent` has always accepted `blocked` and `failure`, and exactly one
 * caller used either: the retired email-invite endpoint. Every other refusal on
 * this surface — a plan ceiling, a lapsed subscription, a group-role denial,
 * an anti-enumeration 404 against another tenant's group id — left no tenant
 * audit record at all.
 *
 * That is the wrong way round for an evidence platform. Successes are visible
 * in the data they produce; a refused attempt leaves nothing behind unless it
 * is written down, and repeated refusals are precisely the pattern an operator
 * needs to see. The anti-enumeration design assumes someone may be walking
 * ids — and then said nothing when they did.
 *
 * `denied` versus `error` follows the canonical vocabulary: a decision the
 * platform MADE (capacity, plan, permission, lifecycle) is `denied`; an
 * unexpected fault is `error`. Both distinguish themselves from `success`, so
 * no false success is ever emitted.
 *
 * Audit emission never blocks the response: the refusal the caller receives is
 * decided before this runs and is not conditional on it.
 */
async function auditDenial(args: {
  userId: string;
  workspaceId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  err: unknown;
  requestId: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const decided =
    args.err instanceof BillingLimitError ||
    args.err instanceof CollaborationTeamError;
  const code =
    args.err instanceof BillingLimitError
      ? args.err.code
      : args.err instanceof CollaborationTeamError
        ? args.err.code
        : "internal_error";
  try {
    await emitTenantAudit({
      action: args.action,
      outcome: decided ? "denied" : "error",
      sourceApp: "API",
      actorUserId: args.userId,
      workspaceId: args.workspaceId,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      correlationId: args.requestId,
      metadata: { ...(args.metadata ?? {}), reason: code },
    });
  } catch {
    /* an audit failure must not convert a clean refusal into a 500 */
  }
}

// -----------------------------------------------------------------------------
// Request schemas
// -----------------------------------------------------------------------------

const CreateTeamBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(600).optional().nullable(),
  teamType: z
    .enum(["GENERAL", "INVESTIGATION", "LEGAL", "REVIEW", "COMPLIANCE"])
    .optional(),
});

const UpdateTeamBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(600).optional().nullable(),
  teamType: z
    .enum(["GENERAL", "INVESTIGATION", "LEGAL", "REVIEW", "COMPLIANCE"])
    .optional(),
});

const AddMemberBody = z.object({
  userId: z.string().uuid(),
  role: z
    .enum(["LEAD", "ADMIN", "MEMBER", "VIEWER", "EXTERNAL"])
    .optional(),
});

/**
 * WCR-15 (2026-09-07) — THE SCHEMA NOW DESCRIBES WHAT THE HANDLER DOES.
 *
 * `status` accepted `ACTIVE | SUSPENDED | REMOVED` and the handler implemented
 * exactly one of them. `SUSPENDED` suspended; `ACTIVE` and `REMOVED` fell
 * through every branch and returned `{ ok: true }` with no write, no activity
 * row and no audit. A client was told a removal had succeeded when nothing had
 * happened — the worst possible answer, because it is indistinguishable from
 * the true one.
 *
 * Both gaps are now closed rather than hidden: `REMOVED` routes to the
 * canonical `removeMember` (which protects the last LEAD), and `ACTIVE` routes
 * to reinstatement, which had no path at all — a suspended member could be
 * suspended and never un-suspended through this API.
 */
const UpdateMemberBody = z.object({
  role: z.enum(["LEAD", "ADMIN", "MEMBER", "VIEWER", "EXTERNAL"]).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "REMOVED"]).optional(),
  reason: z.string().max(400).optional().nullable(),
});

const CreateAssignmentBody = z.object({
  targetType: z.enum(["CASE", "EVIDENCE", "REVIEW"]),
  targetId: z.string().uuid(),
  assigneeUserId: z.string().uuid().optional().nullable(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  dueAtUtc: z
    .string()
    .datetime()
    .optional()
    .nullable()
    .transform((s) => (s ? new Date(s) : null)),
  note: z.string().max(600).optional().nullable(),
});

const UpdateAssignmentBody = z.object({
  status: z
    .enum(["OPEN", "IN_PROGRESS", "COMPLETED", "REASSIGNED", "CANCELLED"])
    .optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  assigneeUserId: z.string().uuid().optional().nullable(),
  dueAtUtc: z
    .string()
    .datetime()
    .optional()
    .nullable()
    .transform((s) => (s ? new Date(s) : null)),
  note: z.string().max(600).optional().nullable(),
});

// -----------------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------------

export async function collaborationTeamsRoutes(app: FastifyInstance) {
  // Global prefix is set at register-time; routes here are relative.

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams  — list teams visible to actor in active workspace
  // ---------------------------------------------------------------------------
  app.get("/v1/collaboration-teams", {
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const ctx = await requireWorkspace(req, reply, "collaboration.thread.read");
      if (!ctx) return;
      try {
        const q = (req.query as Record<string, string | undefined>) ?? {};
        /**
         * WCR-6A — the scope is REQUESTED by the client and GRANTED by the
         * server. `?scope=all` is honoured only for an actor who holds the
         * workspace governance capability; for anyone else it silently
         * degrades to their participation view rather than refusing, because
         * a shared link to the governance view should show a non-admin the
         * groups they are in, not an error.
         *
         * `scopeGranted` on the response says which one they actually got, so
         * the surface labels the list truthfully instead of assuming.
         */
        const scope =
          q.scope === "all" && ctx.canGovernWorkspace ? "ALL" : "PARTICIPATING";
        const res = await listCollaborationTeams({
          workspaceId: ctx.workspaceId,
          actorUserId: ctx.userId,
          includeArchived: q.includeArchived === "true",
          search: q.q ?? null,
          limit: q.limit ? parseInt(q.limit, 10) : undefined,
          cursor: q.cursor ?? null,
          scope,
        });
        return reply.send({
          ...res,
          canGovernWorkspace: ctx.canGovernWorkspace,
        });
      } catch (err) {
        return handleServiceError(reply, err, req.id ?? null);
      }
    },
  });

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams  — create team
  // ---------------------------------------------------------------------------
  app.post("/v1/collaboration-teams", {
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const ctx = await requireWorkspace(req, reply, "collaboration.thread.create");
      if (!ctx) return;
      const parsed = CreateTeamBody.safeParse(req.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "invalid_body", message: parsed.error.message });
      try {
        // Phase 10 — billing guards (pre-mutation).
        await assertSubscriptionActiveOrGraceAllowed({ workspaceId: ctx.workspaceId });
        await assertCanCreateCollaborationTeam({
          workspaceId: ctx.workspaceId,
          actorUserId: ctx.userId,
        });
        const result = await createCollaborationTeam({
          workspaceId: ctx.workspaceId,
          actorUserId: ctx.userId,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          teamType: parsed.data.teamType ?? null,
        });
        await auditEvent({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          action: "collaboration_team.created",
          resourceType: "collaboration_team",
          resourceId: result.id,
          outcome: "success",
          requestId: req.id ?? null,
          metadata: { name: parsed.data.name },
        });
        return reply.code(201).send({ team: { id: result.id } });
      } catch (err) {
        return handleServiceError(reply, err, req.id ?? null);
      }
    },
  });

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/:teamId  — detail
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.read",
          // A workspace OWNER/ADMIN could ENUMERATE every group here
          // (`?scope=all`) and then met a 404 on every one they opened. This is
          // the bounded READ that closes that; it confers no group role and
          // every mutation below still demands ACTIVE membership.
          allowWorkspaceGovernorRead: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          const detail = await getCollaborationTeamDetail({
            teamId: req.params.teamId,
            workspaceId: ctx.workspaceId,
            actorUserId: ctx.userId,
            viaWorkspaceGovernance: binding.viaWorkspaceGovernance,
          });
          return reply.send({
            team: detail,
            // The surface must be able to SAY why every action is missing.
            // Without this it looks broken rather than deliberately read-only.
            viaWorkspaceGovernance: binding.viaWorkspaceGovernance,
          });
        } catch (err) {
          return handleMutationError(reply, err, req.id ?? null, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.created",
            resourceType: "collaboration_team",
            resourceId: null,
          });
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /v1/collaboration-teams/:teamId  — update
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.update_settings",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = UpdateTeamBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          // Phase 10 — billing write-gate (no quota for plain updates).
          await assertSubscriptionActiveOrGraceAllowed({ workspaceId: ctx.workspaceId });
          await updateCollaborationTeam({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            name: parsed.data.name,
            description: parsed.data.description,
            teamType: parsed.data.teamType,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.updated",
            resourceType: "collaboration_team",
            resourceId: req.params.teamId,
            outcome: "success",
            requestId: req.id ?? null,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleMutationError(reply, err, req.id ?? null, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.updated",
            resourceType: "collaboration_team",
            resourceId: req.params.teamId,
          });
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams/:teamId/archive  — archive
  // ---------------------------------------------------------------------------
  /**
   * GET /v1/collaboration-teams/:teamId/disposability
   *
   * WHETHER PERMANENT DELETION IS SAFE, ANSWERED BEFORE IT IS ATTEMPTED.
   *
   * §15.28 is explicit that a failed DELETE must not be how an operator learns
   * that deletion is unsafe. This projection lets the surface offer "Delete
   * team" only where it can actually work, and explain the alternative where it
   * cannot — rather than presenting a destructive control that answers 409.
   *
   * A READ of the group's own disposition, authorized like any other read of
   * the group. It discloses counts of the group's own history and nothing about
   * the records that history points at.
   */
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/disposability",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.read",
          allowWorkspaceGovernorRead: true,
        });
        if (!binding) return;
        try {
          const disposition = await assessCollaborationTeamDisposability({
            teamId: req.params.teamId,
            actorUserId: binding.workspace.userId,
          });
          return reply.send({ disposition });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  /**
   * DELETE /v1/collaboration-teams/:teamId
   *
   * Permanent removal of a group that carries no operational record — the
   * accidental-creation case, handled without ceremony.
   *
   * NOT a commercial workaround: ARCHIVED groups already consume no active
   * capacity, so nobody ever needs to delete history to free a slot. Deletion
   * exists for structural cleanup and archiving for retirement, and the two
   * stay distinct.
   *
   * The service re-checks disposability inside its transaction and refuses a
   * history-bearing group with a typed 409 — this route cannot widen that.
   */
  app.delete<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          // The authority that retires a group, not the creator. Creator
          // ownership is not an authorization model in this product.
          groupPermission: "team.archive",
          // Deliberately NOT `requireActiveTeam`: an archived accidental group
          // must remain deletable, and freezing it would force an operator to
          // reopen — consuming a capacity slot — merely to tidy up.
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          await deleteCollaborationTeam({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.deleted",
            resourceType: "collaboration_team",
            resourceId: req.params.teamId,
            outcome: "success",
            requestId: req.id ?? null,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleMutationError(reply, err, req.id ?? null, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.deleted",
            resourceType: "collaboration_team",
            resourceId: req.params.teamId,
          });
        }
      },
    },
  );

  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/archive",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.archive",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          await archiveCollaborationTeam({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.archived",
            resourceType: "collaboration_team",
            resourceId: req.params.teamId,
            outcome: "success",
            requestId: req.id ?? null,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleMutationError(reply, err, req.id ?? null, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.archived",
            resourceType: "collaboration_team",
            resourceId: req.params.teamId,
          });
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams/:teamId/unarchive  — reopen
  //
  // WCR-13 — the inverse of the route above, which did not exist while the
  // archive confirmation told operators members would lose access "until the
  // team is unarchived".
  //
  // `requireActiveTeam` is deliberately FALSE and this is the only mutation on
  // the surface where that is true: the whole point is to act on an archived
  // group. Everything else about it is the archive route's authority —
  // `team.archive` at group level, `collaboration.thread.create` at workspace
  // level — because reopening is the same decision taken the other way.
  //
  // Capacity is re-checked inside the service, under the creation lock: an
  // archived group frees a slot, so reopening one competes with creating one.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/unarchive",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.archive",
          requireActiveTeam: false,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          await assertSubscriptionActiveOrGraceAllowed({
            workspaceId: ctx.workspaceId,
          });
          await unarchiveCollaborationTeam({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.unarchived",
            resourceType: "collaboration_team",
            resourceId: req.params.teamId,
            outcome: "success",
            requestId: req.id ?? null,
          });
          return reply.send({ ok: true });
        } catch (err) {
          await auditDenial({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.unarchived",
            resourceType: "collaboration_team",
            resourceId: req.params.teamId,
            err,
            requestId: req.id ?? null,
          });
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams/:teamId/members/bulk  — add several at once
  //
  // Building a group of twelve took twelve round trips through a radio-button
  // picker that accepted ONE selection per submit. On an Enterprise workspace
  // provisioned by SSO or SCIM — where people arrive in cohorts — that is not
  // a workflow anybody performs twice.
  //
  // It is a LOOP OVER THE CANONICAL WRITER, deliberately, not a batch insert:
  // `addExistingMember` re-checks the actor's group permission, re-checks that
  // the target is an ACTIVE member of the parent workspace, applies the plan's
  // per-group member limit, and emits its own audit event — per person. A
  // bulk path that skipped any of that to go faster would be a second, weaker
  // membership writer wearing a convenience label.
  //
  // Partial success is the honest outcome and is reported as such: one person
  // hitting the group ceiling must not silently discard the eleven that
  // succeeded, and must not roll them back either.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/members/bulk",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.member.invite",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = z
          .object({
            // Bounded: a page of the eligible-members directory is 100, and a
            // request that names more than that is not a UI action.
            userIds: z.array(z.string().uuid()).min(1).max(100),
            role: z
              .enum(["LEAD", "ADMIN", "MEMBER", "VIEWER", "EXTERNAL"])
              .optional(),
          })
          .safeParse(req.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        }
        try {
          await assertSubscriptionActiveOrGraceAllowed({
            workspaceId: ctx.workspaceId,
          });
        } catch (err) {
          return handleMutationError(reply, err, req.id ?? null, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.member.added",
            resourceType: "collaboration_team_member",
            resourceId: null,
          });
        }

        const added: string[] = [];
        const failed: Array<{ userId: string; reason: string }> = [];
        // Sequential on purpose: the per-group member limit is evaluated per
        // add, and running them concurrently would race that ceiling.
        for (const userId of Array.from(new Set(parsed.data.userIds))) {
          try {
            await assertCollaborationTeamMemberLimit(req.params.teamId, 1);
            const { id } = await addExistingMember({
              teamId: req.params.teamId,
              actorUserId: ctx.userId,
              userIdToAdd: userId,
              role: parsed.data.role,
            });
            await auditEvent({
              userId: ctx.userId,
              workspaceId: ctx.workspaceId,
              action: "collaboration_team.member.added",
              resourceType: "collaboration_team_member",
              resourceId: id,
              outcome: "success",
              requestId: req.id ?? null,
              metadata: {
                teamId: req.params.teamId,
                role: parsed.data.role,
                viaBulk: true,
              },
            });
            added.push(userId);
          } catch (err) {
            failed.push({
              userId,
              reason:
                err instanceof CollaborationTeamError
                  ? err.code
                  : "add_failed",
            });
          }
        }
        return reply.code(added.length > 0 ? 201 : 409).send({ added, failed });
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams/:teamId/members  — add existing member
  // ---------------------------------------------------------------------------
  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/members",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.member.invite",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = AddMemberBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          // Phase 10 — billing guards (pre-mutation).
          await assertSubscriptionActiveOrGraceAllowed({ workspaceId: ctx.workspaceId });
          await assertCollaborationTeamMemberLimit(req.params.teamId, 1);
          const { id } = await addExistingMember({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            userIdToAdd: parsed.data.userId,
            role: parsed.data.role,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.member.added",
            resourceType: "collaboration_team_member",
            resourceId: id,
            outcome: "success",
            requestId: req.id ?? null,
            metadata: { teamId: req.params.teamId, role: parsed.data.role },
          });
          return reply.code(201).send({ member: { id } });
        } catch (err) {
          return handleMutationError(reply, err, req.id ?? null, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.member.added",
            resourceType: "collaboration_team_member",
            resourceId: null,
          });
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /v1/collaboration-teams/:teamId/members/:memberId  — role or status
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { teamId: string; memberId: string } }>(
    "/v1/collaboration-teams/:teamId/members/:memberId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = UpdateMemberBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          // Phase 10 — billing write-gate (no quota for role/status changes).
          await assertSubscriptionActiveOrGraceAllowed({ workspaceId: ctx.workspaceId });
          if (parsed.data.role) {
            await changeMemberRole({
              teamId: req.params.teamId,
              actorUserId: ctx.userId,
              memberId: req.params.memberId,
              role: parsed.data.role,
            });
            await auditEvent({
              userId: ctx.userId,
              workspaceId: ctx.workspaceId,
              action: "collaboration_team.member.role_changed",
              resourceType: "collaboration_team_member",
              resourceId: req.params.memberId,
              outcome: "success",
              requestId: req.id ?? null,
              metadata: { newRole: parsed.data.role },
            });
          }
          if (parsed.data.status === "SUSPENDED") {
            await suspendMember({
              teamId: req.params.teamId,
              actorUserId: ctx.userId,
              memberId: req.params.memberId,
              reason: parsed.data.reason,
            });
            await auditEvent({
              userId: ctx.userId,
              workspaceId: ctx.workspaceId,
              action: "collaboration_team.member.suspended",
              resourceType: "collaboration_team_member",
              resourceId: req.params.memberId,
              outcome: "success",
              requestId: req.id ?? null,
            });
          }
          // WCR-15 — `REMOVED` used to fall through to `{ ok: true }` having
          // done nothing. It routes to the canonical writer, which is the same
          // one `DELETE .../members/:memberId` calls, so last-LEAD protection
          // and the activity row apply identically whichever door is used.
          if (parsed.data.status === "REMOVED") {
            await removeMember({
              teamId: req.params.teamId,
              actorUserId: ctx.userId,
              memberId: req.params.memberId,
            });
            await auditEvent({
              userId: ctx.userId,
              workspaceId: ctx.workspaceId,
              action: "collaboration_team.member.removed",
              resourceType: "collaboration_team_member",
              resourceId: req.params.memberId,
              outcome: "success",
              requestId: req.id ?? null,
            });
          }
          // WCR-15 — reinstatement. There was no path back from SUSPENDED
          // through this API at all: a member could be suspended and never
          // un-suspended, and `ACTIVE` silently reported success.
          if (parsed.data.status === "ACTIVE") {
            await reinstateMember({
              teamId: req.params.teamId,
              actorUserId: ctx.userId,
              memberId: req.params.memberId,
            });
            await auditEvent({
              userId: ctx.userId,
              workspaceId: ctx.workspaceId,
              action: "collaboration_team.member.reinstated",
              resourceType: "collaboration_team_member",
              resourceId: req.params.memberId,
              outcome: "success",
              requestId: req.id ?? null,
            });
          }
          return reply.send({ ok: true });
        } catch (err) {
          return handleMutationError(reply, err, req.id ?? null, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.member.role_changed",
            resourceType: "collaboration_team_member",
            resourceId: req.params.memberId,
          });
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /v1/collaboration-teams/:teamId/members/:memberId  — remove
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { teamId: string; memberId: string } }>(
    "/v1/collaboration-teams/:teamId/members/:memberId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.member.remove",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          await removeMember({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            memberId: req.params.memberId,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.member.removed",
            resourceType: "collaboration_team_member",
            resourceId: req.params.memberId,
            outcome: "success",
            requestId: req.id ?? null,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleMutationError(reply, err, req.id ?? null, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.member.removed",
            resourceType: "collaboration_team_member",
            resourceId: req.params.memberId,
          });
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams/:teamId/invites/email  — RETIRED
  //
  // A Collaboration Team does not invite people. It groups people who already
  // hold authority in the workspace that contains it.
  //
  // This endpoint modelled the opposite: it was shaped like a workspace
  // invitation — address, token, delivery, expiry, single use — while its own
  // acceptance path required the recipient to ALREADY be an active member of
  // the parent workspace. Everything that made it an invitation was therefore
  // redundant, and every one of its defects lived in that redundant machinery:
  // no binding to the invited address, a non-atomic claim, no resend, an
  // unrecoverable delivery failure, and a token in a URL.
  //
  // The two real operations are separate and both already exist:
  //
  //   1. bring the person into the WORKSPACE — POST /v1/teams/:id/invites
  //      (or an Organization invitation with workspace assignments, or SCIM);
  //   2. assign an existing active workspace member to the group —
  //      POST /v1/collaboration-teams/:teamId/members.
  //
  // Outstanding links keep working: the accept path is repaired, bound to the
  // invited address and atomic. Revocation stays reachable so operators can
  // clear pending rows. Nothing new is written.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/invites/email",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.member.invite",
          requireActiveTeam: true,
        });
        if (!binding) return;
        await auditEvent({
          userId: binding.workspace.userId,
          workspaceId: binding.workspace.workspaceId,
          action: "collaboration_team.invite.email.retired",
          resourceType: "collaboration_team",
          resourceId: req.params.teamId,
          outcome: "blocked",
          requestId: req.id ?? null,
        });
        return reply.code(410).send({
          code: "COLLABORATION_TEAM_INVITE_RETIRED",
          error: "COLLABORATION_TEAM_INVITE_RETIRED",
          message:
            "Teams are made from people who are already in this workspace. Invite them to the workspace first, then add them to the team.",
          nextSteps: {
            inviteToWorkspace: "/v1/teams/{workspaceId}/invites",
            addExistingMember:
              "/v1/collaboration-teams/{teamId}/members",
            eligibleMembers:
              "/v1/collaboration-teams/{teamId}/eligible-members",
          },
          requestId: req.id ?? null,
        });
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams/:teamId/invites/:inviteId/revoke
  // ---------------------------------------------------------------------------
  app.post<{ Params: { teamId: string; inviteId: string } }>(
    "/v1/collaboration-teams/:teamId/invites/:inviteId/revoke",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.invite.revoke",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          await revokeInvite({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            inviteId: req.params.inviteId,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.invite.revoked",
            resourceType: "collaboration_team_invite",
            resourceId: req.params.inviteId,
            outcome: "success",
            requestId: req.id ?? null,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleMutationError(reply, err, req.id ?? null, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.invite.revoked",
            resourceType: "collaboration_team_invite",
            resourceId: req.params.inviteId,
          });
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-team-invites/:token/accept
  // ---------------------------------------------------------------------------
  /**
   * WCR-20 (2026-09-07) — THE TOKEN MOVES OUT OF THE URL.
   *
   * `POST /v1/collaboration-team-invites/:token/accept` put a live credential
   * in a request path, where it reaches access logs, proxy logs, APM traces and
   * `Referer` headers. The retired-invite note a few hundred lines above lists
   * "a token in a URL" among the defects that justified retiring the writer;
   * the accept path kept doing it.
   *
   * The body form is canonical now. The PATH form is RETAINED, because links
   * are already in people's mailboxes and an obligation that was validly issued
   * has to stay completable — but it forwards to the same handler rather than
   * carrying its own logic, and it is the shape that disappears when no PENDING
   * legacy invitation can still be in flight.
   */
  const acceptInviteHandler = async (
    req: FastifyRequest,
    reply: FastifyReply,
    rawToken: string,
  ) => {
    {
      {
        const userId = await getAuthUserId(req);
        if (!userId)
          return reply.code(401).send({ error: "auth_required" });
        try {
          // No subscription gate here: acceptance is by the invitee,
          // not the team owner. The owner's plan controls the per-team
          // cap — the service calls the canonical
          // `assertCollaborationTeamMemberLimit` guard AFTER the
          // already-a-member short-circuit and BEFORE the membership
          // write, so:
          //   - already-member re-accepts succeed even on a full team,
          //   - capacity / plan-restriction failures propagate with
          //     their stable billing codes (TEAM_MEMBER_LIMIT_REACHED /
          //     TEAM_INVITES_NOT_INCLUDED) + details via
          //     handleServiceError → handleBillingError.
          const result = await acceptInvite({
            rawToken,
            actorUserId: userId,
          });
          await auditEvent({
            userId,
            workspaceId: result.workspaceId,
            action: "collaboration_team.invite.accepted",
            resourceType: "collaboration_team_member",
            resourceId: result.memberId,
            outcome: "success",
            requestId: req.id ?? null,
            metadata: {
              teamId: result.teamId,
              alreadyMember: result.alreadyMember,
            },
          });
          return reply.send({
            teamId: result.teamId,
            memberId: result.memberId,
            alreadyMember: result.alreadyMember,
          });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      }
    }
  };

  /**
   * CANONICAL — the token travels in the body, where it is not logged by any
   * intermediary and does not leak through `Referer`.
   */
  app.post<{ Body: { token?: unknown } }>(
    "/v1/collaboration-team-invites/accept",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const parsed = z
          .object({ token: z.string().min(8).max(512) })
          .safeParse(req.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "invalid_body", message: "A token is required." });
        }
        return acceptInviteHandler(req, reply, parsed.data.token);
      },
    },
  );

  /**
   * LEGACY COMPATIBILITY — links already in mailboxes.
   *
   * Retained deliberately and bounded: no writer can create another
   * `CollaborationTeamInvite`, so the set of tokens that can arrive here only
   * shrinks. `Referrer-Policy: no-referrer` is set on the response so the token
   * in this path cannot travel onward from a browser that followed the link.
   */
  app.post<{ Params: { token: string } }>(
    "/v1/collaboration-team-invites/:token/accept",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        void reply.header("Referrer-Policy", "no-referrer");
        void reply.header("Cache-Control", "no-store");
        return acceptInviteHandler(req, reply, req.params.token);
      },
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/entitlement
  //
  // THE commercial projection for this surface, and the only place the browser
  // may learn a limit from.
  //
  // The console used to compute capacity itself — `team?.maxMembersPerTeam ??
  // team?.includedSeats ?? 5` over raw columns the API happened to return —
  // which is how a 1,005-member workspace on the TEAM plan was told "the actual
  // member cap is 0 per team" and "Members: 1005 / 0 · 0 remaining".
  //
  // Two numbers, deliberately separate, because they answer different
  // questions: how many PEOPLE may hold access (seats), and how many GROUPS
  // they may be organised into. Being in several groups does not multiply the
  // first.
  // ---------------------------------------------------------------------------
  app.get("/v1/collaboration-teams/entitlement", {
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const ctx = await requireWorkspace(req, reply, "collaboration.thread.read");
      if (!ctx) return;
      try {
        const projection = await resolveCollaborationEntitlement(
          ctx.workspaceId,
          { canViewAllTeams: ctx.canGovernWorkspace },
        );
        return reply.send(projection);
      } catch (err) {
        return handleServiceError(reply, err, req.id ?? null);
      }
    },
  });

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/:teamId/assignable-targets
  //
  // What the assignment picker offers. Same scope predicates as the validation
  // on the write path, so the picker can only ever offer something the write
  // will accept — and the operator is never asked to paste a uuid.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/assignable-targets",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.read",
          groupPermission: "team.assignment.create",
        });
        if (!binding) return;
        const q = (req.query as Record<string, string | undefined>) ?? {};
        const parsed = z
          .enum(["CASE", "EVIDENCE", "REVIEW"])
          .safeParse(q.type);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "invalid_query", message: "type must be CASE, EVIDENCE or REVIEW." });
        }
        try {
          const res = await listAssignableTargets({
            workspaceId: binding.workspace.workspaceId,
            targetType: parsed.data,
            search: q.q ?? null,
            limit: q.limit ? parseInt(q.limit, 10) : undefined,
          });
          return reply.send(res);
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/:teamId/overview
  //
  // The group's operational snapshot: open / in-progress / overdue / due-soon /
  // high-priority / unassigned work, the split by target type, exact
  // membership counts, and per-member open workload.
  //
  // It exists because Overview computed all of this from `team.members` and
  // `team.invites` — BOUNDED PREVIEWS — so a four-hundred-person Enterprise
  // group read "25/25 active". Everything here is counted by the database.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/overview",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.read",
          // Supervising a workspace means being able to see whether a group is
          // drowning, which is what this endpoint answers.
          allowWorkspaceGovernorRead: true,
        });
        if (!binding) return;
        try {
          const overview = await getTeamOverview({
            teamId: req.params.teamId,
            actorUserId: binding.workspace.userId,
            viaWorkspaceGovernance: binding.viaWorkspaceGovernance,
          });
          return reply.send({ overview });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/responsibility
  //
  // THE REVERSE PROJECTION — the same relationship, read from the record's side.
  //
  // A Collaboration Team could be made responsible for a case since the
  // assignment model shipped, and the case could never say so: nothing outside
  // this module read `collaboration_team_assignments`. So responsibility was
  // real, tenant-safe, and invisible to everyone who did not already know to
  // open that group's Work tab.
  //
  // This is a READ of the one authority — not a second store, and not a
  // second writer. It is workspace-bound before it reads anything, and it
  // grants nothing: a caller sees the group responsible for a record they can
  // already reach, because `/cases/:id` and `/evidence/:id` authorize
  // themselves independently and always did.
  //
  // Static path, mounted BEFORE nothing that could shadow it: `:teamId` is a
  // sibling segment, and Fastify prefers a static segment over a parametric
  // one — the same precedence that made `/entitlement` resolve.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/collaboration-teams/responsibility",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const ctx = await requireWorkspace(req, reply, "collaboration.thread.read");
        if (!ctx) return;
        const q = (req.query as Record<string, string | undefined>) ?? {};
        const parsed = z
          .object({
            targetType: z.enum(["CASE", "EVIDENCE", "REVIEW"]),
            targetId: z.string().uuid(),
          })
          .safeParse({ targetType: q.targetType, targetId: q.targetId });
        if (!parsed.success) {
          return reply.code(400).send({
            error: "invalid_query",
            message:
              "targetType must be CASE, EVIDENCE or REVIEW and targetId must be a uuid.",
          });
        }
        try {
          const res = await listResponsibilityForTarget({
            workspaceId: ctx.workspaceId,
            actorUserId: ctx.userId,
            targetType: parsed.data.targetType,
            targetId: parsed.data.targetId,
          });
          return reply.send(res);
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/:teamId/eligible-members
  //
  // The directory a team is BUILT FROM, and the replacement for inviting by
  // address from inside a group.
  //
  // It answers one question — "which people already authorized in this
  // workspace are not yet in this team?" — and it answers it on the server,
  // paginated and searchable, because the alternative is what the members tab
  // used to do: fetch every member and filter in the browser.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/eligible-members",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "identity.member.read",
          groupPermission: "team.member.invite",
        });
        if (!binding) return;
        try {
          const q = (req.query as Record<string, string | undefined>) ?? {};
          const res = await listEligibleWorkspaceMembersForTeam({
            workspaceId: binding.workspace.workspaceId,
            teamId: req.params.teamId,
            search: q.q ?? null,
            limit: q.limit ? parseInt(q.limit, 10) : undefined,
            cursor: q.cursor ?? null,
          });
          return reply.send(res);
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/:teamId/members
  //
  // Paginated, searchable membership. The detail endpoint used to return every
  // member of a team in one unbounded array — 386 KB at a thousand members,
  // every address included, with no search anywhere to escape it.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/members",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.read",
          // Who is in a group is a governance question. Note that CONTACT
          // details stay behind `team.member.invite` below — a governor
          // resolves to no group role, so they see the roster and NOT every
          // member's address, which is the WCR-16 least-privilege rule holding
          // for the new state without needing to know about it.
          allowWorkspaceGovernorRead: true,
        });
        if (!binding) return;
        try {
          const q = (req.query as Record<string, string | undefined>) ?? {};
          const res = await listCollaborationTeamMembers({
            teamId: req.params.teamId,
            workspaceId: binding.workspace.workspaceId,
            viewerCanSeeContact: binding.groupRole
              ? collaborationTeamRoleHasPermission(
                  binding.groupRole,
                  "team.member.invite",
                )
              : false,
            search: q.q ?? null,
            status: q.status ?? null,
            role: q.role ?? null,
            limit: q.limit ? parseInt(q.limit, 10) : undefined,
            cursor: q.cursor ?? null,
          });
          return reply.send(res);
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/:teamId/activity
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/activity",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.read",
          groupPermission: "team.activity.read",
          // A group's administrative history is exactly what an accountable
          // workspace owner audits. VIEWER carries `team.activity.read`, so
          // the group-permission check above is satisfied by the bounded role
          // the governor state resolves to.
          allowWorkspaceGovernorRead: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          const q = (req.query as Record<string, string | undefined>) ?? {};
          const limit = q.limit ? parseInt(q.limit, 10) : undefined;
          const cursor = q.cursor ?? null;
          const result = await listTeamActivity({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            viaWorkspaceGovernance: binding.viaWorkspaceGovernance,
            limit,
            cursor,
          });
          return reply.send(result);
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/collaboration-teams/:teamId/assignments
  // ---------------------------------------------------------------------------
  app.get<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/assignments",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.read",
          // "What is this group carrying, and what is late" is the governance
          // question. Reading it changes nothing.
          allowWorkspaceGovernorRead: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        try {
          const q = (req.query ?? {}) as Record<string, string | undefined>;
          // EVERY Work filter is the server's. The surface used to narrow an
          // already-fetched cursor page by search, assignee and priority,
          // which on a group with more work than one page hides rows the
          // operator can see and counts only what happened to be loaded. The
          // service validates each value against its closed vocabulary.
          const page = await listAssignments({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            viaWorkspaceGovernance: binding.viaWorkspaceGovernance,
            status: q.status ?? null,
            targetType: q.targetType ?? null,
            priority: q.priority ?? null,
            assigneeUserId: q.assignee ?? null,
            overdueOnly: q.overdue === "true",
            search: q.q ?? null,
            limit: q.limit ? Number.parseInt(q.limit, 10) : undefined,
            cursor: q.cursor ?? null,
          });
          return reply.send({
            assignments: page.items,
            nextCursor: page.nextCursor,
            total: page.total,
          });
        } catch (err) {
          return handleServiceError(reply, err, req.id ?? null);
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/collaboration-teams/:teamId/assignments
  // ---------------------------------------------------------------------------
  app.post<{ Params: { teamId: string } }>(
    "/v1/collaboration-teams/:teamId/assignments",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          groupPermission: "team.assignment.create",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = CreateAssignmentBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          // Phase 10 — billing write-gate.
          await assertSubscriptionActiveOrGraceAllowed({ workspaceId: ctx.workspaceId });
          const result = await createAssignment({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            targetType: parsed.data.targetType,
            targetId: parsed.data.targetId,
            assigneeUserId: parsed.data.assigneeUserId,
            priority: parsed.data.priority,
            dueAtUtc: parsed.data.dueAtUtc,
            note: parsed.data.note,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.assignment.created",
            resourceType: "collaboration_team_assignment",
            resourceId: result.id,
            outcome: "success",
            requestId: req.id ?? null,
            metadata: {
              teamId: req.params.teamId,
              targetType: parsed.data.targetType,
              targetId: parsed.data.targetId,
            },
          });
          return reply.code(201).send({ assignment: { id: result.id } });
        } catch (err) {
          return handleMutationError(reply, err, req.id ?? null, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.assignment.created",
            resourceType: "collaboration_team_assignment",
            resourceId: null,
          });
        }
      },
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /v1/collaboration-teams/:teamId/assignments/:assignmentId
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { teamId: string; assignmentId: string } }>(
    "/v1/collaboration-teams/:teamId/assignments/:assignmentId",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => {
        const binding = await authorizeCollaborationTeam(req, reply, {
          collaborationTeamId: req.params.teamId,
          permission: "collaboration.thread.create",
          requireActiveTeam: true,
        });
        if (!binding) return;
        const ctx = {
          workspaceId: binding.workspace.workspaceId,
          userId: binding.workspace.userId,
        };
        const parsed = UpdateAssignmentBody.safeParse(req.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "invalid_body", message: parsed.error.message });
        try {
          // Phase 10 — billing write-gate.
          await assertSubscriptionActiveOrGraceAllowed({ workspaceId: ctx.workspaceId });
          await updateAssignment({
            teamId: req.params.teamId,
            actorUserId: ctx.userId,
            assignmentId: req.params.assignmentId,
            status: parsed.data.status,
            priority: parsed.data.priority,
            assigneeUserId: parsed.data.assigneeUserId,
            dueAtUtc: parsed.data.dueAtUtc,
            note: parsed.data.note,
          });
          await auditEvent({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.assignment.updated",
            resourceType: "collaboration_team_assignment",
            resourceId: req.params.assignmentId,
            outcome: "success",
            requestId: req.id ?? null,
          });
          return reply.send({ ok: true });
        } catch (err) {
          return handleMutationError(reply, err, req.id ?? null, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            action: "collaboration_team.assignment.updated",
            resourceType: "collaboration_team_assignment",
            resourceId: req.params.assignmentId,
          });
        }
      },
    },
  );
}

