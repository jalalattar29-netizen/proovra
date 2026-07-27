/**
 * Phase 32.8 Foundation — Canonical platform-context route.
 *
 * GET /v1/platform/context
 *
 * Single read endpoint returning the canonical PlatformContextEnvelope
 * consumed by the web shell (header, sidebar, workspace switcher, and
 * every operator page). Strictly side-effect free.
 *
 * Hard rules — enforced by source-contract tests:
 *
 *   1. NO mutation. The route is GET only.
 *   2. NO audit emission. The platform-context service is a pure read.
 *   3. NO signed URLs. NO queue enqueue. NO custody events.
 *   4. Returns 401 if unauthenticated; 200 + envelope otherwise.
 *   5. The envelope shape is frozen by AUTHORITY_SCHEMA_VERSION and
 *      bumping it requires bumping that constant.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { buildPlatformContext } from "../services/platform-context/platform-context.service.js";
// P0 remediation (2026-07-21) — tenant-scoped context-switch audit events.
// NOTE: the GET route remains strictly read-only/no-audit; only the
// switch MUTATION below emits.
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
// PHASE 10 §10.2/§10.7 — canonical org security-policy gates + auth provenance.
import {
  evaluateOrgLoginMethod,
  evaluateSessionAgainstPolicy,
} from "../services/identity/org-security-policy.service.js";
import {
  establishOrganizationSessionContext,
  releaseOrganizationSessionContext,
} from "../services/identity/concurrent-session.service.js";
import { provenanceToPolicyAuthMethod } from "../services/jwt.js";
// PHASE 10 §13.2 STEP 6 (2026-07-23) — managed-identity no-personal guard.
import { assertPersonalSpaceAllowed } from "../services/identity/identity-mode.service.js";

const SwitchWorkspaceBody = z.object({
  /**
   * `null` switches the user back to their PERSONAL workspace (clears
   * users.current_workspace_id). A UUID string switches to a team
   * workspace the user is an ACTIVE member of.
   */
  workspaceId: z.string().uuid().nullable(),
});

/**
 * Phase B0 — Read the `x-platform-context-version` request header.
 * Returns `3` when the client opts into the canonical post-B0
 * envelope (legacy `workspace` field deprecated); otherwise `2`
 * (the pre-B0 shape, unchanged). Unknown / malformed values fall
 * back to `2` for safety.
 */
function readRequestedSchemaVersion(req: {
  headers: Record<string, string | string[] | undefined>;
}): 2 | 3 {
  const raw = req.headers["x-platform-context-version"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "3") return 3;
  return 2;
}

export async function platformContextRoutes(app: FastifyInstance) {
  app.get(
    "/v1/platform/context",
    { preHandler: requireAuth },
    async (req: any, reply) => {
      const userId = getAuthUserId(req);
      const jwtRole =
        typeof req.user?.role === "string" ? (req.user.role as string) : null;

      const result = await buildPlatformContext({
        userId,
        requestId: req.id,
        jwtRole,
        requestedSchemaVersion: readRequestedSchemaVersion(req),
      });

      if (!result.ok) {
        return reply.code(404).send({
          message: "User not found",
          code: "user_not_found",
          requestId: req.id,
        });
      }

      return reply.code(200).send(result.envelope);
    },
  );

  /**
   * Atomic workspace-switch endpoint. Verifies the user is a member
   * of the target team (or returns 403), persists currentWorkspaceId,
   * then returns the freshly-built PlatformContextEnvelope. The
   * frontend state machine consumes the response in one render —
   * never mixes old/new authority states.
   */
  app.post(
    "/v1/platform/context/switch-workspace",
    { preHandler: requireAuth },
    async (req: any, reply) => {
      const userId = getAuthUserId(req);
      const jwtRole =
        typeof req.user?.role === "string" ? (req.user.role as string) : null;
      const body = SwitchWorkspaceBody.parse(req.body);

      // P0 remediation (2026-07-21) — capture the previous pointer for the
      // tenant-scoped context-switch audit trail.
      const prevRow = await prisma.user.findUnique({
        where: { id: userId },
        select: { currentWorkspaceId: true },
      });
      const previousWorkspaceId = prevRow?.currentWorkspaceId ?? null;

      const auditSwitch = (result: "allowed" | "denied", reason?: string) => {
        safeEmitSecurityEvent({
          teamId: body.workspaceId ?? previousWorkspaceId,
          eventType: "workspace_context_switched",
          severity: result === "denied" ? "WARNING" : "INFO",
          details: {
            actorUserId: userId,
            previousWorkspaceId,
            targetWorkspaceId: body.workspaceId,
            result,
            ...(reason ? { reason } : {}),
            requestId: req.id,
          },
        });
      };

      // PHASE 10 §13.2 STEP 6 (2026-07-23) — NO-PERSONAL enforcement on CONTEXT
      // ESTABLISHMENT. `workspaceId: null` switches into the PERSONAL workspace
      // (clears currentWorkspaceId). A managed enterprise identity has no
      // personal space, so deny the personal switch and perform ZERO mutation —
      // there is NO silent denied-org→Personal fallback. Fails closed for
      // MANAGED + MANAGED_UNRESOLVED. Switching INTO a team workspace is
      // unaffected (governed by the membership + org-policy gates below).
      if (body.workspaceId === null) {
        try {
          await assertPersonalSpaceAllowed(userId);
        } catch (err) {
          const e = err as { statusCode?: number; code?: string; message?: string };
          auditSwitch("denied", e.code ?? "MANAGED_IDENTITY_NO_PERSONAL_SPACE");
          return reply.code(e.statusCode ?? 403).send({
            message:
              e.message ??
              "Managed enterprise identities do not have a personal workspace.",
            code: e.code ?? "MANAGED_IDENTITY_NO_PERSONAL_SPACE",
            requestId: req.id,
          });
        }
      }

      if (body.workspaceId) {
        const membership = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: body.workspaceId,
              userId,
            },
          },
          select: { status: true },
        });
        if (!membership || membership.status !== "ACTIVE") {
          auditSwitch("denied", "workspace_membership_required");
          return reply.code(403).send({
            message: "Not a member of this workspace",
            code: "workspace_membership_required",
            requestId: req.id,
          });
        }

        // P0 remediation (2026-07-21) — lifecycle gate: an ACTIVE membership
        // in an ARCHIVED/SUSPENDED organization's workspace must not be
        // switchable. Personal teams are exempt (their bootstrap container
        // org is not lifecycle-managed).
        const targetTeam = await prisma.team.findUnique({
          where: { id: body.workspaceId },
          select: {
            isPersonal: true,
            organizationId: true,
            organization: { select: { status: true } },
          },
        });
        if (!targetTeam) {
          auditSwitch("denied", "workspace_not_found");
          return reply.code(403).send({
            message: "Not a member of this workspace",
            code: "workspace_membership_required",
            requestId: req.id,
          });
        }
        if (
          !targetTeam.isPersonal &&
          targetTeam.organization &&
          targetTeam.organization.status !== "ACTIVE"
        ) {
          auditSwitch("denied", "organization_unavailable");
          return reply.code(403).send({
            message: "This organization is not currently active",
            code: "organization_unavailable",
            requestId: req.id,
          });
        }

        // PHASE 10 §10.2/§10.7 — org security-policy gate at org-context
        // ESTABLISHMENT. Applies ONLY to ORGANIZATION workspaces (personal
        // scope is exempt). Method comes from the session's SERVER-VERIFIED
        // provenance (never a client field). Denials perform ZERO mutation and
        // reuse the existing membership_required shape (no org-existence leak).
        if (!targetTeam.isPersonal) {
          // Provenance is guaranteed SUPPORTED by requireAuth (unsupported /
          // missing / legacy-GUEST tokens are rejected at the door). `method`
          // is therefore non-null here; the `null` guard is defence-in-depth —
          // an unproven provenance can NEVER establish org context.
          const method = provenanceToPolicyAuthMethod(req.user?.authMethod);
          if (method === null) {
            auditSwitch("denied", "reauthentication_required");
            return reply.code(401).send({
              message: "Session no longer satisfies the organization security policy",
              code: "session_policy_reauth_required",
              reason: "reauthentication_required",
              requestId: req.id,
            });
          }
          const ssoConnId = req.user?.ssoConnId ?? null;
          const loginGate = await evaluateOrgLoginMethod({
            teamId: body.workspaceId,
            userId,
            method,
            ssoConnId,
          });
          if (!loginGate.allowed) {
            auditSwitch("denied", loginGate.reason);
            return reply.code(403).send({
              message: "Not a member of this workspace",
              code: "workspace_membership_required",
              requestId: req.id,
            });
          }
          // §10.7 correction — session AGE keys off the PRIMARY authentication
          // time (`authAt`), which is preserved across any future token
          // reissue, NOT the token `iat`. Idle uses server-side activity;
          // this seam IS an active request, so "now" is the activity time.
          const authAt = Number(req.user?.authAt ?? 0);
          if (authAt > 0) {
            const sessionGate = await evaluateSessionAgainstPolicy({
              teamId: body.workspaceId,
              issuedAtMs: authAt * 1000,
              lastSeenAtMs: Date.now(),
              sessionPolicyVersion: null, // global session — live policy is authoritative
            });
            if (!sessionGate.allowed) {
              auditSwitch("denied", sessionGate.reason);
              return reply.code(401).send({
                message: "Session no longer satisfies the organization security policy",
                code: "session_policy_reauth_required",
                reason: sessionGate.reason,
                requestId: req.id,
              });
            }
          }

          // PHASE 10 §2 — CONCURRENT ORGANIZATION-SESSION LIMIT. Switching into
          // an ORGANIZATION workspace ESTABLISHES this global session's Org
          // context. The canonical authority counts DISTINCT active sessionIds
          // per (user, Organization) under a per-(user,org) advisory lock and
          // fails closed (DENY) beyond the limit — a new context never evicts a
          // legitimate session. Idempotent: re-switching within the same Org (or
          // between its workspaces) with the same sessionId counts ONCE. Runs
          // AFTER lifecycle + login-method + session-policy gates (max-age/idle
          // failures occur before any allowance is created). Denial performs
          // ZERO mutation (no currentWorkspaceId change).
          if (targetTeam.organizationId && req.user?.sessionIdHash) {
            const seat = await establishOrganizationSessionContext({
              userId,
              organizationId: targetTeam.organizationId,
              sessionIdHash: req.user.sessionIdHash,
            });
            if (!seat.allowed) {
              auditSwitch("denied", seat.reason);
              const status = seat.reason === "concurrent_session_limit_reached" ? 429 : 403;
              return reply.code(status).send({
                message:
                  seat.reason === "concurrent_session_limit_reached"
                    ? "The organization's concurrent session limit has been reached."
                    : "Not a member of this workspace",
                code: seat.reason,
                requestId: req.id,
              });
            }
          }
        }

        // PHASE 10 §2 — switching into a Personal/OWNED (non-Organization)
        // workspace RELEASES any Organization context this session held, so it
        // stops counting against that Organization's concurrent-session limit.
        if ((targetTeam.isPersonal || !targetTeam.organizationId) && req.user?.sessionIdHash) {
          await releaseOrganizationSessionContext({ userId, sessionIdHash: req.user.sessionIdHash });
        }
      }

      await prisma.user.update({
        where: { id: userId },
        data: { currentWorkspaceId: body.workspaceId },
      });
      auditSwitch("allowed");

      const result = await buildPlatformContext({
        userId,
        requestId: req.id,
        jwtRole,
        requestedSchemaVersion: readRequestedSchemaVersion(req),
      });

      if (!result.ok) {
        return reply.code(404).send({
          message: "User not found",
          code: "user_not_found",
          requestId: req.id,
        });
      }

      return reply.code(200).send(result.envelope);
    },
  );
}
