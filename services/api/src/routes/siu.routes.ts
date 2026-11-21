/**
 * Phase M3 — Insurance SIU routes.
 *
 *   GET    /v1/cases/:id/siu-profile               — load bounded profile
 *   PUT    /v1/cases/:id/siu-profile               — upsert profile
 *   POST   /v1/cases/:id/siu-profile/checklist/:itemId/map-evidence — map evidence
 *   POST   /v1/cases/:id/siu-profile/checklist/:itemId/status        — set status
 *   POST   /v1/cases/:id/siu-profile/indicators                       — add indicator
 *   POST   /v1/cases/:id/siu-profile/follow-ups                       — create follow-up
 *   POST   /v1/cases/:id/siu-profile/follow-ups/:followUpId/status    — update follow-up
 *   GET    /v1/cases/:id/siu-export/preflight                         — run preflight
 *   POST   /v1/cases/:id/siu-export                                    — build bundle (step-up)
 *   GET    /v1/siu/intake-templates                                    — list bounded templates
 *
 * All routes are auth-gated, workspace-scoped, and emit bounded audit
 * events.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { ENTERPRISE_ORGANIZATION_REFUSAL, refuseUnlessEnterpriseOrganization } from "./_enterprise-surface-gate.js";
import { workspaceIsEnterpriseOrganization } from "../services/platform-context/enterprise-authority.js";
import {
  evaluateAccess,
  evaluateMemberAccess,
  loadMemberAccessSnapshot,
} from "../services/identity/access-policy.service.js";
import { gateRequestSessionForWorkspace } from "../services/identity/workspace-session-gate.service.js";
import { caseVisibleToWhere, evidenceVisibleThroughCasesWhere } from "../services/cases/case-visibility.js";
import { isMembershipDenial } from "../services/access/membership-denial.js";
import { evaluateArtifactDownload } from "../services/evidence/artifact-download-gate.service.js";
import { workspaceEvidenceWhere } from "@proovra/shared-runtime";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { refuseIfSessionQuarantined } from "../services/access-control/adaptive-runtime-gate.service.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import {
  caseOwnerAccessRole,
  evaluateCaseMutationPermission,
  getCaseAssignmentRoles,
  type CaseAccessRole,
  type CaseMutation,
} from "../services/cases/case-permission.service.js";
import { CASE_PLAN_WRITE_REASON, casePlanWriteRefusal } from "../services/cases/case-plan-gate.js";
import {
  SIU_INTAKE_TEMPLATES,
  SIU_REVIEW_INDICATOR_CODES,
  SIU_CHECKLIST_ITEM_STATUSES,
  SIU_FOLLOW_UP_STATUSES,
  SIU_SAVED_VIEW_PRESETS,
  SiuProfileUpsertInputSchema,
} from "@proovra/shared";
import {
  addReviewIndicator,
  createFollowUpRequest,
  loadSiuProfile,
  siuProfileInReach,
  mapEvidenceToChecklistItem,
  setChecklistItemStatus,
  updateFollowUpStatus,
  upsertSiuProfile,
} from "../services/siu/siu-profile.service.js";
import { runSiuExportPreflight } from "../services/siu/siu-preflight.service.js";
import {
  buildSiuExportBundle,
  authorizeSiuExportDownload,
  downloadSiuExportArtifact,
  markSiuExportDelivered,
  listSiuExports,
} from "../services/siu/siu-export-bundle.service.js";
import {
  evaluateSiuCapability,
} from "../services/siu/siu-capabilities.service.js";
import {
  CreateSavedViewSchema,
  UpdateSavedViewSchema,
  createSavedView,
  deleteSavedView,
  listCustomSavedViews,
  markSavedViewUsed,
  updateSavedView,
} from "../services/siu/siu-saved-views.service.js";
// PHASE 12 — VERTICAL B. Saved views are EXECUTED, not just stored.
import {
  listExecutableSiuViews,
  resolveSiuView,
  runSiuWorklist,
  type ResolvedSiuView,
} from "../services/siu/siu-view-query.service.js";

/**
 * PHASE 12 — VERTICAL B. Workspace-scoped SIU actor gate for the
 * worklist + saved-view surfaces (these are workspace-level, not
 * case-level, so `requireCaseActor` does not apply).
 *
 * Anti-enumeration: a non-member and a non-existent workspace both
 * resolve to 404. An INACTIVE member gets an explicit, distinct
 * `member_inactive` denial so the UI can say why instead of rendering
 * an empty list.
 */
async function requireSiuWorkspaceActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string; teamId: string } | null> {
  const userId = getAuthUserId(req);
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true, status: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (member.status !== "ACTIVE") {
    reply.code(403).send({ error: { code: "member_inactive" } });
    return null;
  }
  const decision = await evaluateMemberAccess({
    teamId,
    userId,
    permission: "identity.member.read",
  });
  if (!decision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: decision.reason,
        detail: decision.detail ?? null,
      },
    });
    return null;
  }
  // PRO-K1-03 — SIU worklists and saved views are an Enterprise organization tool.
  if (await refuseUnlessEnterpriseOrganization(reply, teamId)) return null;
  return { userId, teamId };
}

/**
 * B5B-F-303 (free-audit 0ea0) — WHAT A MEMBER MAY DO WITH SHARED SIU VIEWS.
 *
 * Two secondary decisions on the canonical snapshot, asked AFTER
 * `requireSiuWorkspaceActor` admitted the caller, with the pure canonical
 * evaluator (a "no" narrows what the caller may do with a view; it is not a
 * refusal of the request and writes no permission-denied event):
 *
 *   - PUBLISH (team / organization visibility): a write role. Any member, a
 *     VIEWER included, could publish one into every colleague's worklist
 *     toolbar; A2-14 makes the Viewer read-only. Members keep publishing
 *     (D22: shared views are a member feature). `evidence.update_metadata`
 *     is the write every role but VIEWER holds — the same rule as the search
 *     and evidence saved views.
 *   - MANAGE a colleague's shared view: `operations.saved_views.manage`
 *     (OWNER / ADMIN, or a grant) — the role matrix's shared-view permission,
 *     replacing the role-name comparison.
 *
 * A member's PRIVATE views stay theirs.
 */
async function siuSavedViewAuthority(
  teamId: string,
  userId: string,
): Promise<{ mayPublishShared: boolean; canManageShared: boolean }> {
  const snapshot = await loadMemberAccessSnapshot({ teamId, userId });
  if (!snapshot) return { mayPublishShared: false, canManageShared: false };
  const actor = { kind: "MEMBER" as const, member: snapshot };
  return {
    mayPublishShared: evaluateAccess(actor, { permission: "evidence.update_metadata" }).allowed,
    canManageShared: evaluateAccess(actor, { permission: "operations.saved_views.manage" }).allowed,
  };
}

/**
 * PRO-K1-04 / B3C-F-007 — the SIU profile, checklist, indicator and follow-up
 * writes: an EVIDENCE_LINK-class case mutation (a VIEWER, or a creator demoted
 * to VIEWER, never writes) answering to the case plan gate.
 */
const SIU_CASE_WRITE = { mutation: "EVIDENCE_LINK", planGated: true } as const satisfies {
  mutation: CaseMutation;
  planGated: boolean;
};

const SHARED_VIEW_REQUIRES_WRITER = {
  error: {
    code: "permission_denied",
    reason: "shared_view_requires_write_role",
  },
} as const;

type SiuGateRefusal = {
  status: number;
  body: unknown;
  /** Bounded reason code for the read projection (`viewer.disabledCode`). */
  code: "enterprise_required" | "case_role" | "plan";
  /** The sentence the web shows beside a withheld control. */
  message: string;
};

/**
 * PRO-K1-03 / PRO-K1-04 — the Enterprise-organization, case-mutation and plan
 * questions an SIU write asks after membership and the workspace permission
 * were proven. ONE function, so the write routes (through requireCaseActor)
 * and the profile read's `viewer` projection (PRO-CENZ-01, EP-1082..EP-1086)
 * cannot disagree about who may write.
 */
async function siuCaseGateRefusal(input: {
  caseId: string;
  teamId: string;
  userId: string;
  memberRole: string | null;
  caseOwnerUserId: string | null;
  requireEnterprise: boolean;
  mutation?: CaseMutation;
  planGated?: boolean;
}): Promise<SiuGateRefusal | null> {
  if (input.requireEnterprise) {
    let enterprise = false;
    try {
      enterprise = await workspaceIsEnterpriseOrganization(input.teamId);
    } catch {
      enterprise = false;
    }
    if (!enterprise) {
      return {
        status: 403,
        body: ENTERPRISE_ORGANIZATION_REFUSAL,
        code: "enterprise_required",
        message: ENTERPRISE_ORGANIZATION_REFUSAL.message,
      };
    }
  }
  if (input.mutation) {
    const accessRole: CaseAccessRole =
      input.caseOwnerUserId === input.userId
        ? caseOwnerAccessRole(input.memberRole)
        : (String(input.memberRole) as CaseAccessRole);
    const mutation = evaluateCaseMutationPermission({
      mutation: input.mutation,
      accessRole,
      assignmentRoles: await getCaseAssignmentRoles(input.caseId, input.userId),
    });
    if (!mutation.allowed) {
      return {
        status: 403,
        body: { error: { code: "permission_denied", reason: "case_mutation_denied", detail: mutation.reason } },
        code: "case_role",
        message: SIU_READ_ONLY_ROLE_REASON,
      };
    }
    if (input.planGated) {
      const plan = await casePlanWriteRefusal(input.caseId);
      if (plan) {
        return {
          status: plan.statusCode,
          body: { code: plan.code, message: plan.message, error: { code: plan.code, message: plan.message } },
          code: "plan",
          message: CASE_PLAN_WRITE_REASON,
        };
      }
    }
  }
  return null;
}

const SIU_READ_ONLY_ROLE_REASON =
  "Your role can read this investigation profile but not change it. A workspace member, admin or owner who can edit this case can.";

/**
 * PRO-CENZ-01 (EP-1082..EP-1086) — what the profile read tells the web about
 * the SIU writes: the same permission and gate the write routes ask, for the
 * reader. Never authority: every write still asks requireCaseActor.
 */
async function projectSiuViewer(
  caseId: string,
  ctx: { userId: string; teamId: string; role: string | null; caseOwnerUserId: string | null },
): Promise<{ canWrite: boolean; disabledCode: SiuGateRefusal["code"] | "permission" | null; disabledReason: string | null }> {
  // L-3 (closure2 review) — the PURE evaluator on the canonical snapshot, not
  // `evaluateMemberAccess`: that one audits every deny, so each profile read by
  // a non-writer wrote a false `permission_denied` security event. This is the
  // same decision the write routes' auditing check makes (snapshot, canonical
  // evaluator, then the organization session gate on an allow), without the
  // event. A "no" here narrows the controls offered; it refuses nothing.
  const snapshot = await loadMemberAccessSnapshot({ teamId: ctx.teamId, userId: ctx.userId });
  let mayWrite =
    snapshot !== null &&
    evaluateAccess({ kind: "MEMBER", member: snapshot }, { permission: "evidence.update_metadata" }).allowed;
  if (mayWrite && snapshot?.workspaceKind === "ORGANIZATION") {
    mayWrite = (await gateRequestSessionForWorkspace({ teamId: ctx.teamId, userId: ctx.userId })).allowed;
  }
  // The Enterprise question comes first on the write routes for a member who
  // holds the permission; a member without it is refused on role before it.
  if (!mayWrite) {
    return { canWrite: false, disabledCode: "permission", disabledReason: SIU_READ_ONLY_ROLE_REASON };
  }
  const refusal = await siuCaseGateRefusal({
    caseId,
    teamId: ctx.teamId,
    userId: ctx.userId,
    memberRole: ctx.role,
    caseOwnerUserId: ctx.caseOwnerUserId,
    requireEnterprise: true,
    mutation: SIU_CASE_WRITE.mutation,
    planGated: SIU_CASE_WRITE.planGated,
  });
  if (refusal) return { canWrite: false, disabledCode: refusal.code, disabledReason: refusal.message };
  return { canWrite: true, disabledCode: null, disabledReason: null };
}

async function requireCaseActor(
  req: FastifyRequest,
  reply: FastifyReply,
  caseId: string,
  permission: "identity.member.read" | "evidence.update_metadata" = "identity.member.read",
  /**
   * PRO-K1-03 / DEC-10 — retainedRead: a READ of material already stored (the
   * profile, the list of stored export bundles, a stored bundle's download)
   * stays open to an authorized member after the workspace stops being an
   * Enterprise organization; every write, every new export and every compute
   * route asks the Enterprise-organization authority.
   *
   * PRO-K1-04 / B3C-F-007 — mutation: an SIU write is a case write, decided by
   * the case mutation matrix (owner rank from the CURRENT role, A2-14) and,
   * when planGated is set, by the case plan gate every other case write asks.
   */
  options: { retainedRead?: boolean; mutation?: CaseMutation; planGated?: boolean } = {},
): Promise<{ userId: string; teamId: string; exposePii: boolean; role: string | null; caseOwnerUserId: string | null } | null> {
  const userId = getAuthUserId(req);
  /*
   * THE RESTRICTED-CASE RULE APPLIES HERE TOO (2026-09-29, audit H1).
   *
   * Every SIU route — including the export, which bundles each record's report
   * and verification package (and so its original bytes) — authorized any
   * ACTIVE workspace member with identity.member.read, ignoring the case's
   * access list. A case with an access list is now visible only to its owner
   * and the people on the list, by the same predicate Reports and exchange
   * use; any other caller gets the same 404 as a missing case.
   */
  const c = await prisma.case.findFirst({
    where: { id: caseId, ...caseVisibleToWhere(userId) },
    select: { id: true, teamId: true, ownerUserId: true },
  });
  if (!c) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  /*
   * B3C-F-011 (free-audit 0ea0): the case was located before membership was
   * proven, so a suspended or expired former member — or anyone, for another
   * person's unworkspaced case — got a 403 that confirmed the case exists. A
   * refusal about WHO the caller is now answers like a missing case; only a
   * valid member lacking a permission (or the owner of a personal case) is told.
   */
  if (!c.teamId) {
    if (c.ownerUserId !== userId) {
      reply.code(404).send({ error: { code: "not_found" } });
      return null;
    }
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: "siu_requires_team_case",
      },
    });
    return null;
  }
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: c.teamId, userId } },
    select: { id: true, status: true, role: true },
  });
  if (!member || member.status !== "ACTIVE") {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const decision = await evaluateMemberAccess({
    teamId: c.teamId,
    userId,
    permission,
  });
  if (!decision.allowed && isMembershipDenial(decision.reason)) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (!decision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: decision.reason,
        detail: decision.detail ?? null,
      },
    });
    return null;
  }
  const gate = await siuCaseGateRefusal({
    caseId,
    teamId: c.teamId,
    userId,
    memberRole: member.role ? String(member.role) : null,
    caseOwnerUserId: c.ownerUserId,
    requireEnterprise: !options.retainedRead,
    mutation: options.mutation,
    planGated: options.planGated,
  });
  if (gate) {
    reply.code(gate.status).send(gate.body);
    return null;
  }
  // PRO-K1-04 — claimant PII is exposed by the siu.pii.export capability,
  // decided on the CURRENT role (a creator demoted to Viewer no longer holds it).
  const exposePii = (
    await evaluateSiuCapability({
      teamId: c.teamId,
      userId,
      caseOwnerUserId: c.ownerUserId,
      currentRole: member.role ? String(member.role) : null,
      capability: "siu.pii.export",
    })
  ).allowed;
  return {
    userId,
    teamId: c.teamId,
    exposePii,
    role: member.role ? String(member.role) : null,
    caseOwnerUserId: c.ownerUserId,
  };
}

/**
 * How many of the case's records would NOT release their report or package on
 * their own download route (2026-09-29, audits H1 and M2) — THE per-record
 * download gate, applied to each artifact a bundle carries. Case access was
 * established by requireCaseActor, and each record is in this case and this
 * workspace's population, so the gate's read step is already satisfied.
 * Used when a bundle is built AND when a stored bundle is downloaded again: a
 * legal hold placed after generation stops the stored bytes leaving too.
 */
async function countSiuRecordsWithheld(
  req: FastifyRequest,
  ctx: { teamId: string; userId: string },
  caseId: string,
): Promise<number> {
  const scope = await workspaceEvidenceWhere(ctx.teamId, prisma);
  // B3C-F-003 (free-audit 0ea0): the records of this case the actor can open.
  // A record another restricted case closes to them is neither exported nor
  // counted, so the withheld count never measures records they cannot see.
  const caseEvidence = await prisma.evidence.findMany({
    where: {
      caseLinks: { some: { caseId } },
      AND: [scope, evidenceVisibleThroughCasesWhere(ctx.userId)],
      deletedAt: null,
    },
    select: { id: true },
  });
  let withheld = 0;
  for (const ev of caseEvidence) {
    for (const kind of ["report", "package"] as const) {
      const decision = await evaluateArtifactDownload({
        evidenceId: ev.id,
        actorUserId: ctx.userId,
        kind,
        ip: req.ip,
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
        readAccess: async () => undefined,
      });
      if (!decision.allowed) {
        withheld++;
        break;
      }
    }
  }
  return withheld;
}

/**
 * AUD-0029 — a saved view's name is unique per (workspace, creator). Saving or
 * renaming onto a name the person already used reached the database's unique
 * constraint and answered 500 with a critical operational alert; it is the
 * person's choice to resolve, so it is a 409 that says so.
 */
const SAVED_VIEW_NAME_TAKEN = {
  error: {
    code: "saved_view_name_taken",
    message: "You already have a saved view with this name. Choose another name.",
  },
} as const;

function isSavedViewNameTaken(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

export async function siuRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------
  // Intake templates (bounded, static)
  // -------------------------------------------------------------------
  app.get(
    "/v1/siu/intake-templates",
    { preHandler: requireAuth },
    async (req, reply) => {
      // PHASE 12 — VERTICAL B. The template catalog drives SIU profile
      // creation, so it is now workspace-scoped like every other SIU
      // read: a caller must name a workspace they are an ACTIVE member
      // of. `teamId` stays optional for backwards compatibility with
      // callers that only need the static catalog shape.
      const q = z
        .object({ teamId: z.string().uuid().optional() })
        .parse(req.query ?? {});
      if (q.teamId) {
        const ctx = await requireSiuWorkspaceActor(req, reply, q.teamId);
        if (!ctx) return;
      }
      return reply.code(200).send({
        templates: SIU_INTAKE_TEMPLATES.map((t) => ({
          id: t.id,
          name: t.name,
          claimType: t.claimType,
          description: t.description,
          itemCount: t.items.length,
          requiredItemCount: t.items.filter((i) => i.required).length,
          items: t.items,
        })),
      });
    },
  );

  // -------------------------------------------------------------------
  // PHASE 12 — VERTICAL B. The SIU worklist. This is the query saved
  // views actually AFFECT.
  //
  //   GET /v1/siu/worklist?teamId=&viewId=&limit=
  //
  // `viewId` accepts a built-in preset id OR a durable custom saved-view
  // row id. Omitting it returns the unfiltered workspace worklist —
  // never an empty list, so "no view selected" and "view matched
  // nothing" stay distinguishable in the UI.
  // -------------------------------------------------------------------
  app.get(
    "/v1/siu/worklist",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({
          teamId: z.string().uuid(),
          viewId: z.string().min(1).max(120).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requireSiuWorkspaceActor(req, reply, q.teamId);
      if (!ctx) return;
      let view: ResolvedSiuView | null = null;
      if (q.viewId) {
        const resolved = await resolveSiuView({
          teamId: ctx.teamId,
          userId: ctx.userId,
          viewId: q.viewId,
        });
        if (!resolved.ok) {
          return reply.code(404).send({
            error: { code: "saved_view_not_found", reason: resolved.reason },
          });
        }
        view = resolved.view;
      }
      const result = await runSiuWorklist({
        teamId: ctx.teamId,
        userId: ctx.userId,
        view,
        limit: q.limit,
      });
      return reply.code(200).send({
        view: result.view,
        rows: result.rows,
        total: result.total,
        truncated: result.truncated,
        durable: true as const,
        storage: "prisma" as const,
      });
    },
  );

  // -------------------------------------------------------------------
  // Profile read
  // -------------------------------------------------------------------
  app.get(
    "/v1/cases/:id/siu-profile",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const ctx = await requireCaseActor(req, reply, params.id, "identity.member.read", { retainedRead: true });
      if (!ctx) return;
      // Phase M3.1 — basic profile read returns PII-redacted projection
      // regardless of caller role. PII is only exposed via the dedicated
      // `reveal-pii` endpoint, which requires step-up + audit.
      const profile = await loadSiuProfile({
        caseId: params.id,
        teamId: ctx.teamId,
        exposePii: false,
      });
      if (!profile) {
        return reply.code(404).send({
          error: { code: "siu_profile_not_found" },
          durable: true as const,
          storage: "prisma" as const,
        });
      }
      return reply.code(200).send({
        profile: await siuProfileInReach(profile, ctx.teamId, ctx.userId),
        durable: true as const,
        storage: "prisma" as const,
        piiRedacted: true as const,
        // PRO-CENZ-01 — whether the checklist, indicator and follow-up
        // controls are offered to this reader, and why not.
        viewer: await projectSiuViewer(params.id, ctx),
      });
    },
  );

  // -------------------------------------------------------------------
  // Profile upsert
  // -------------------------------------------------------------------
  app.put(
    "/v1/cases/:id/siu-profile",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const ctx = await requireCaseActor(req, reply, params.id, "evidence.update_metadata", SIU_CASE_WRITE);
      if (!ctx) return;
      const patch = SiuProfileUpsertInputSchema.parse(req.body);
      // PRO-K1-04 — claimant PII is written only under siu.pii.edit.
      const touchesPii = ["claimantName", "claimantContact"].some(
        (k) => (patch as Record<string, unknown>)[k] !== undefined,
      );
      if (touchesPii) {
        const piiEdit = await evaluateSiuCapability({
          teamId: ctx.teamId,
          userId: ctx.userId,
          caseOwnerUserId: ctx.caseOwnerUserId,
          currentRole: ctx.role,
          capability: "siu.pii.edit",
        });
        if (!piiEdit.allowed) {
          return reply.code(403).send({
            error: { code: "siu_pii_capability_required", capability: "siu.pii.edit", reason: piiEdit.reason },
          });
        }
      }
      const profile = await upsertSiuProfile({
        caseId: params.id,
        teamId: ctx.teamId,
        patch,
        actorUserId: ctx.userId,
      });
      if (!profile) {
        return reply.code(404).send({ error: { code: "case_not_found" } });
      }
      await emitTenantAudit({
        action: "siu_profile_updated",
        outcome: "success",
        sourceApp: "API",
        actorUserId: ctx.userId,
        workspaceId: ctx.teamId,
        resourceType: "case",
        resourceId: params.id,
        correlationId: req.id ?? null,
        metadata: {
          teamId: ctx.teamId,
          claimType: patch.claimType,
          investigationStatus: patch.investigationStatus ?? null,
        },
      }).catch(() => {});
      return reply.code(200).send({ profile: await siuProfileInReach(profile, ctx.teamId, ctx.userId) });
    },
  );

  // -------------------------------------------------------------------
  // Checklist — map evidence
  // -------------------------------------------------------------------
  app.post(
    "/v1/cases/:id/siu-profile/checklist/:itemId/map-evidence",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid(), itemId: z.string().min(1).max(120) })
        .parse(req.params);
      const body = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.body ?? {});
      const ctx = await requireCaseActor(req, reply, params.id, "evidence.update_metadata", SIU_CASE_WRITE);
      if (!ctx) return;
      const profile = await mapEvidenceToChecklistItem({
        caseId: params.id,
        teamId: ctx.teamId,
        itemId: params.itemId,
        evidenceId: body.evidenceId,
        actorUserId: ctx.userId,
      });
      if (!profile) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ profile: await siuProfileInReach(profile, ctx.teamId, ctx.userId) });
    },
  );

  // -------------------------------------------------------------------
  // Checklist — set status
  // -------------------------------------------------------------------
  app.post(
    "/v1/cases/:id/siu-profile/checklist/:itemId/status",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({ id: z.string().uuid(), itemId: z.string().min(1).max(120) })
        .parse(req.params);
      const body = z
        .object({
          status: z.enum(SIU_CHECKLIST_ITEM_STATUSES),
          note: z.string().max(240).optional().nullable(),
        })
        .parse(req.body ?? {});
      const ctx = await requireCaseActor(req, reply, params.id, "evidence.update_metadata", SIU_CASE_WRITE);
      if (!ctx) return;
      const profile = await setChecklistItemStatus({
        caseId: params.id,
        teamId: ctx.teamId,
        itemId: params.itemId,
        status: body.status,
        note: body.note,
        actorUserId: ctx.userId,
      });
      if (!profile) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ profile: await siuProfileInReach(profile, ctx.teamId, ctx.userId) });
    },
  );

  // -------------------------------------------------------------------
  // Review indicators
  // -------------------------------------------------------------------
  app.post(
    "/v1/cases/:id/siu-profile/indicators",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          code: z.enum(SIU_REVIEW_INDICATOR_CODES),
          explanation: z.string().min(1).max(240),
          severity: z.enum(["info", "warning", "block_export"]),
          evidenceId: z.string().uuid().optional().nullable(),
        })
        .parse(req.body ?? {});
      const ctx = await requireCaseActor(req, reply, params.id, "evidence.update_metadata", SIU_CASE_WRITE);
      if (!ctx) return;
      const profile = await addReviewIndicator({
        caseId: params.id,
        teamId: ctx.teamId,
        code: body.code,
        explanation: body.explanation,
        severity: body.severity,
        evidenceId: body.evidenceId,
        actorUserId: ctx.userId,
      });
      if (!profile) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      await emitTenantAudit({
        action: "siu_review_indicator_added",
        outcome: "success",
        severity: body.severity === "block_export" ? "warning" : "info",
        sourceApp: "API",
        actorUserId: ctx.userId,
        workspaceId: ctx.teamId,
        resourceType: "case",
        resourceId: params.id,
        correlationId: req.id ?? null,
        metadata: { teamId: ctx.teamId, code: body.code },
      }).catch(() => {});
      return reply.code(200).send({ profile: await siuProfileInReach(profile, ctx.teamId, ctx.userId) });
    },
  );

  // -------------------------------------------------------------------
  // Follow-up create
  // -------------------------------------------------------------------
  app.post(
    "/v1/cases/:id/siu-profile/follow-ups",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          checklistItemId: z.string().min(1).max(120),
          dueByUtc: z.string().datetime().optional().nullable(),
          note: z.string().max(240).optional().nullable(),
          intakeLinkId: z.string().uuid().optional().nullable(),
        })
        .parse(req.body ?? {});
      const ctx = await requireCaseActor(req, reply, params.id, "evidence.update_metadata", SIU_CASE_WRITE);
      if (!ctx) return;
      const followUp = await createFollowUpRequest({
        caseId: params.id,
        teamId: ctx.teamId,
        checklistItemId: body.checklistItemId,
        dueByUtc: body.dueByUtc,
        note: body.note,
        intakeLinkId: body.intakeLinkId,
        actorUserId: ctx.userId,
      });
      if (!followUp) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      await emitTenantAudit({
        action: "siu_follow_up_requested",
        outcome: "success",
        sourceApp: "API",
        actorUserId: ctx.userId,
        workspaceId: ctx.teamId,
        resourceType: "case",
        resourceId: params.id,
        correlationId: req.id ?? null,
        metadata: {
          teamId: ctx.teamId,
          followUpId: followUp.id,
          checklistItemId: body.checklistItemId,
        },
      }).catch(() => {});
      return reply.code(200).send({ followUp });
    },
  );

  // -------------------------------------------------------------------
  // Follow-up status update
  // -------------------------------------------------------------------
  app.post(
    "/v1/cases/:id/siu-profile/follow-ups/:followUpId/status",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z
        .object({
          id: z.string().uuid(),
          followUpId: z.string().uuid(),
        })
        .parse(req.params);
      const body = z
        .object({
          status: z.enum(SIU_FOLLOW_UP_STATUSES),
          receivedEvidenceId: z.string().uuid().optional().nullable(),
        })
        .parse(req.body ?? {});
      const ctx = await requireCaseActor(req, reply, params.id, "evidence.update_metadata", SIU_CASE_WRITE);
      if (!ctx) return;
      const followUp = await updateFollowUpStatus({
        caseId: params.id,
        teamId: ctx.teamId,
        followUpId: params.followUpId,
        status: body.status,
        receivedEvidenceId: body.receivedEvidenceId,
        actorUserId: ctx.userId,
      });
      if (!followUp) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      if (body.status === "received" || body.status === "satisfied") {
        await emitTenantAudit({
          action: "siu_follow_up_received",
          outcome: "success",
          sourceApp: "API",
          actorUserId: ctx.userId,
          workspaceId: ctx.teamId,
          resourceType: "case",
          resourceId: params.id,
          correlationId: req.id ?? null,
          metadata: {
            teamId: ctx.teamId,
            followUpId: followUp.id,
            status: body.status,
          },
        }).catch(() => {});
      }
      return reply.code(200).send({ followUp });
    },
  );

  // -------------------------------------------------------------------
  // Export preflight
  // -------------------------------------------------------------------
  app.get(
    "/v1/cases/:id/siu-export/preflight",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const ctx = await requireCaseActor(req, reply, params.id);
      if (!ctx) return;
      const result = await runSiuExportPreflight({
        caseId: params.id,
        teamId: ctx.teamId,
        actorUserId: ctx.userId,
      });
      if (!result) {
        return reply.code(404).send({ error: { code: "siu_profile_not_found" } });
      }
      await emitTenantAudit({
        action: "siu_export_preflight_run",
        outcome: "success",
        severity: result.readiness === "blocked" ? "warning" : "info",
        sourceApp: "API",
        actorUserId: ctx.userId,
        workspaceId: ctx.teamId,
        resourceType: "case",
        resourceId: params.id,
        correlationId: req.id ?? null,
        metadata: {
          teamId: ctx.teamId,
          readiness: result.readiness,
          warnings: result.totals.warnings,
          blockers: result.totals.blockers,
        },
      }).catch(() => {});
      return reply.code(200).send({ preflight: result });
    },
  );

  // -------------------------------------------------------------------
  // Export generate (step-up gated)
  // -------------------------------------------------------------------
  app.post(
    "/v1/cases/:id/siu-export",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          warningExportReason: z.string().max(240).optional().nullable(),
        })
        .parse(req.body ?? {});
      // PRO-K1-04 — generating a stored bundle is not a read: a VIEWER (or a
      // demoted creator) is refused by the case mutation matrix. Not plan
      // gated: export stays available after a downgrade (B3C-F-007).
      const ctx = await requireCaseActor(req, reply, params.id, "identity.member.read", {
        mutation: "EVIDENCE_LINK",
        planGated: false,
      });
      if (!ctx) return;
      // IDENT-019 — a quarantined session keeps reads; this is refused.
      if ((await refuseIfSessionQuarantined({ req, reply, teamId: ctx.teamId, userId: ctx.userId, action: "EXPORT_GENERATE_PACKAGE" })).refused) return;
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: ctx.teamId,
        userId: ctx.userId,
        purpose: "SIU_EXPORT_GENERATE",
        resourceKind: "case",
        resourceId: params.id,
      });
      if (stepUp.sent) return;
      const preflight = await runSiuExportPreflight({
        caseId: params.id,
        teamId: ctx.teamId,
        actorUserId: ctx.userId,
      });
      if (!preflight) {
        return reply.code(404).send({ error: { code: "siu_profile_not_found" } });
      }
      if (preflight.readiness === "blocked") {
        await emitTenantAudit({
          action: "siu_export_blocked",
          outcome: "denied",
          severity: "warning",
          sourceApp: "API",
          actorUserId: ctx.userId,
          workspaceId: ctx.teamId,
          resourceType: "case",
          resourceId: params.id,
          correlationId: req.id ?? null,
          metadata: {
            teamId: ctx.teamId,
            blockers: preflight.totals.blockers,
          },
        }).catch(() => {});
        return reply.code(409).send({
          error: {
            code: "siu_export_blocked",
            preflight,
          },
        });
      }
      if (
        preflight.readiness === "ready_with_warnings" &&
        (!body.warningExportReason ||
          body.warningExportReason.trim().length < 8)
      ) {
        return reply.code(400).send({
          error: {
            code: "siu_export_warning_reason_required",
            preflight,
          },
        });
      }
      /*
       * EVERY ARTIFACT IN THE BUNDLE PASSES THE SAME DOWNLOAD GATE (2026-09-29,
       * audits H1 and M2). The bundle carries each record's report and
       * verification package; each is released only if THE per-record download
       * gate (evaluateArtifactDownload) would release it on its own route —
       * workspace policy, the template overlay, the verification publish
       * policy, export eligibility (a legal hold of any scope, a trashed or
       * destruction-bound lifecycle, an active destruction review) and, for a
       * record with no workspace row, the Personal-owner rule. The package-only
       * check this replaces let a held record's report and package leave in a
       * bundle. Any refusal withholds the whole export, with a count — never a
       * bundle that silently drops or includes an artifact.
       */
      const withheld = await countSiuRecordsWithheld(req, ctx, params.id);
      if (withheld > 0) {
        await emitTenantAudit({
          action: "siu_export_blocked",
          outcome: "denied",
          severity: "warning",
          sourceApp: "API",
          actorUserId: ctx.userId,
          workspaceId: ctx.teamId,
          resourceType: "case",
          resourceId: params.id,
          correlationId: req.id ?? null,
          metadata: { teamId: ctx.teamId, withheldByPolicy: withheld },
        }).catch(() => {});
        return reply.code(403).send({
          error: { code: "siu_export_blocked_by_policy", withheldRecords: withheld },
        });
      }
      const profile = await loadSiuProfile({
        caseId: params.id,
        teamId: ctx.teamId,
        exposePii: ctx.exposePii,
      });
      if (!profile) {
        return reply.code(404).send({ error: { code: "siu_profile_not_found" } });
      }
      const out = await buildSiuExportBundle({
        caseId: params.id,
        teamId: ctx.teamId,
        profile: await siuProfileInReach(profile, ctx.teamId, ctx.userId),
        preflight,
        warningExportReason: body.warningExportReason ?? null,
        actorUserId: ctx.userId,
        includesPii: ctx.exposePii,
      });
      await emitTenantAudit({
        action: "siu_export_generated",
        outcome: "success",
        sourceApp: "API",
        actorUserId: ctx.userId,
        workspaceId: ctx.teamId,
        resourceType: "case",
        resourceId: params.id,
        correlationId: req.id ?? null,
        metadata: {
          teamId: ctx.teamId,
          fileCount: out.files.length,
          readiness: preflight.readiness,
          exportRowId: out.exportRowId,
          reportsIncluded: out.artifactInclusion.reportsIncluded,
          reportsMissing: out.artifactInclusion.reportsMissing,
          verificationPackagesIncluded:
            out.artifactInclusion.verificationPackagesIncluded,
          verificationPackagesMissing:
            out.artifactInclusion.verificationPackagesMissing,
        },
      }).catch(() => {});
      reply
        .header("content-type", "application/zip")
        .header(
          "content-disposition",
          `attachment; filename="siu-export-${params.id}.zip"`,
        )
        .header("x-proovra-siu-export-id", out.exportRowId)
        .header("x-proovra-siu-artifact-sha256", out.artifactSha256)
        .header("x-proovra-siu-manifest-sha256", out.manifestSha256);
      return reply.code(200).send(out.buffer);
    },
  );

  // -------------------------------------------------------------------
  // Phase M3.1 — durable export history
  // -------------------------------------------------------------------
  app.get(
    "/v1/cases/:id/siu-exports",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const q = z
        .object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ctx = await requireCaseActor(req, reply, params.id, "identity.member.read", { retainedRead: true });
      if (!ctx) return;
      const exports = await listSiuExports({
        caseId: params.id,
        teamId: ctx.teamId,
        limit: q.limit,
      });
      return reply.code(200).send({
        exports,
        durable: true as const,
        storage: "prisma" as const,
      });
    },
  );

  // -------------------------------------------------------------------
  // Phase M3.1 — saved-view presets (bounded)
  // -------------------------------------------------------------------
  //
  // PHASE 12 — VERTICAL B. This is now the ONE list an operator picks
  // from: built-in presets merged with the durable custom rows visible
  // to them, each carrying the resolved filter/sort the worklist route
  // will execute. `presets` is still returned separately so existing
  // callers that only read the static catalog keep working.
  //
  // `teamId` is optional purely for that backwards compatibility. When
  // present the caller must be an ACTIVE member; the custom rows are
  // only ever merged in for a workspace they belong to.
  app.get(
    "/v1/siu/saved-views",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const q = z
        .object({ teamId: z.string().uuid().optional() })
        .parse(req.query ?? {});
      if (!q.teamId) {
        return reply
          .code(200)
          .send({ views: SIU_SAVED_VIEW_PRESETS, presets: SIU_SAVED_VIEW_PRESETS });
      }
      const ctx = await requireSiuWorkspaceActor(req, reply, q.teamId);
      if (!ctx) return;
      const views = await listExecutableSiuViews({
        teamId: ctx.teamId,
        userId: ctx.userId,
      });
      return reply.code(200).send({
        views,
        presets: SIU_SAVED_VIEW_PRESETS,
        durable: true as const,
        storage: "prisma" as const,
      });
    },
  );

  // -------------------------------------------------------------------
  // Phase M3.1 — PII reveal (step-up + audit). Returns the SIU
  // profile with claimant fields un-redacted. Caller MUST have the
  // `siu.pii.view` capability AND a fresh step-up.
  // -------------------------------------------------------------------
  app.post(
    "/v1/cases/:id/siu-profile/reveal-pii",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const ctx = await requireCaseActor(req, reply, params.id);
      if (!ctx) return;
      // Phase M3.2 — bounded capability evaluation.
      const ownerRow = await prisma.case.findUnique({
        where: { id: params.id },
        select: { ownerUserId: true },
      });
      const decision = await evaluateSiuCapability({
        teamId: ctx.teamId,
        userId: ctx.userId,
        caseOwnerUserId: ownerRow?.ownerUserId ?? null,
        currentRole: ctx.role,
        capability: "siu.pii.view",
      });
      if (!decision.allowed) {
        await emitTenantAudit({
          action: "siu_pii_revealed",
          outcome: "denied",
          denialReason: decision.reason ?? null,
          severity: "warning",
          sourceApp: "API",
          actorUserId: ctx.userId,
          workspaceId: ctx.teamId,
          resourceType: "case",
          resourceId: params.id,
          correlationId: req.id ?? null,
          metadata: {
            teamId: ctx.teamId,
            capability: decision.capability,
            reason: decision.reason,
          },
        }).catch(() => {});
        return reply.code(403).send({
          error: {
            code: "siu_pii_capability_required",
            reason:
              "siu.pii.view capability required to reveal claimant PII.",
            decisionReason: decision.reason,
          },
        });
      }
      // Phase M3.2 — dedicated step-up purpose `SIU_PII_REVEAL`.
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: ctx.teamId,
        userId: ctx.userId,
        purpose: "SIU_PII_REVEAL",
        resourceKind: "case",
        resourceId: params.id,
      });
      if (stepUp.sent) return;
      const profile = await loadSiuProfile({
        caseId: params.id,
        teamId: ctx.teamId,
        exposePii: true,
      });
      if (!profile) {
        return reply
          .code(404)
          .send({ error: { code: "siu_profile_not_found" } });
      }
      await emitTenantAudit({
        action: "siu_pii_revealed",
        outcome: "success",
        severity: "warning",
        sourceApp: "API",
        actorUserId: ctx.userId,
        workspaceId: ctx.teamId,
        resourceType: "case",
        resourceId: params.id,
        correlationId: req.id ?? null,
        metadata: {
          teamId: ctx.teamId,
          capability: decision.capability,
          reason: decision.reason,
        },
      }).catch(() => {});
      return reply.code(200).send({
        profile: await siuProfileInReach(profile, ctx.teamId, ctx.userId),
        piiRedacted: false as const,
        durable: true as const,
        capability: "siu.pii.view" as const,
      });
    },
  );

  // -------------------------------------------------------------------
  // Phase M3.2 — durable saved-view CRUD
  // -------------------------------------------------------------------
  app.get(
    "/v1/siu/saved-views/custom",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      // B5B-F-303 (free-audit 0ea0) — the canonical member authority (status,
      // access expiry, organization lifecycle, permission), the one
      // GET /v1/siu/worklist uses, instead of an ACTIVE-row read: an expired
      // member or a member of a suspended organization holds an ACTIVE row.
      const ctx = await requireSiuWorkspaceActor(req, reply, q.teamId);
      if (!ctx) return;
      const userId = ctx.userId;
      const views = await listCustomSavedViews({
        teamId: q.teamId,
        userId,
      });
      return reply.code(200).send({ views });
    },
  );

  app.post(
    "/v1/siu/saved-views",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = CreateSavedViewSchema.parse(req.body);
      // B5B-F-303 — canonical authority, then the shared-view permission.
      const ctx = await requireSiuWorkspaceActor(req, reply, body.teamId);
      if (!ctx) return;
      const userId = ctx.userId;
      if (
        body.visibility !== "private" &&
        !(await siuSavedViewAuthority(body.teamId, userId)).mayPublishShared
      ) {
        return reply.code(403).send(SHARED_VIEW_REQUIRES_WRITER);
      }
      const team = await prisma.team.findUnique({
        where: { id: body.teamId },
        select: { organizationId: true },
      });
      let view;
      try {
        view = await createSavedView({
          payload: body,
          userId,
          organizationId: team?.organizationId ?? null,
        });
      } catch (err) {
        if (isSavedViewNameTaken(err)) return reply.code(409).send(SAVED_VIEW_NAME_TAKEN);
        throw err;
      }
      return reply.code(201).send({ view });
    },
  );

  app.patch(
    "/v1/siu/saved-views/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = z
        .object({ id: z.string().uuid() })
        .parse(req.params);
      const body = UpdateSavedViewSchema.parse(req.body);
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      // B5B-F-303 — canonical authority; publishing (a non-private
      // visibility) and managing a colleague's shared view need the
      // shared-view permission, not a role-name comparison.
      const ctx = await requireSiuWorkspaceActor(req, reply, q.teamId);
      if (!ctx) return;
      const userId = ctx.userId;
      const authority = await siuSavedViewAuthority(q.teamId, userId);
      let view;
      try {
        view = await updateSavedView({
          id: params.id,
          teamId: q.teamId,
          userId,
          payload: body,
          canManageShared: authority.canManageShared,
          mayPublishShared: authority.mayPublishShared,
        });
      } catch (err) {
        if (isSavedViewNameTaken(err)) return reply.code(409).send(SAVED_VIEW_NAME_TAKEN);
        throw err;
      }
      if (view === "publish_refused") {
        return reply.code(403).send(SHARED_VIEW_REQUIRES_WRITER);
      }
      if (!view) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ view });
    },
  );

  app.delete(
    "/v1/siu/saved-views/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const q = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      // B5B-F-303 — canonical authority.
      const ctx = await requireSiuWorkspaceActor(req, reply, q.teamId);
      if (!ctx) return;
      const userId = ctx.userId;
      const ok = await deleteSavedView({
        id: params.id,
        teamId: q.teamId,
        userId,
        canManageShared: (await siuSavedViewAuthority(q.teamId, userId)).canManageShared,
      });
      if (!ok) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send({ deleted: true });
    },
  );

  app.post(
    "/v1/siu/saved-views/:id/use",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ teamId: z.string().uuid() })
        .parse(req.body ?? {});
      // B5B-F-303 — canonical authority: /use returns the workspace worklist,
      // so it is refused to exactly whom GET /v1/siu/worklist refuses.
      const ctx = await requireSiuWorkspaceActor(req, reply, body.teamId);
      if (!ctx) return;
      const userId = ctx.userId;
      const view = await markSavedViewUsed({
        id: params.id,
        teamId: body.teamId,
        userId,
      });
      if (!view) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      // PHASE 12 — VERTICAL B. "Use" is not a bookkeeping no-op: it
      // returns the worklist the view resolves to, so the client applies
      // a SERVER-executed query rather than re-deriving the filter.
      const resolved = await resolveSiuView({
        teamId: body.teamId,
        userId,
        viewId: params.id,
      });
      const worklist = resolved.ok
        ? await runSiuWorklist({
            teamId: body.teamId,
            userId,
            view: resolved.view,
            limit: 50,
          })
        : null;
      return reply.code(200).send({
        view,
        worklist: worklist
          ? {
              rows: worklist.rows,
              total: worklist.total,
              truncated: worklist.truncated,
            }
          : null,
      });
    },
  );

  // -------------------------------------------------------------------
  // Phase M3.2 — download a previously generated SIU export
  // -------------------------------------------------------------------
  app.get(
    "/v1/cases/:id/siu-exports/:exportId/download",
    { preHandler: requireAuth },
    async (req, reply) => {
      const params = z
        .object({
          id: z.string().uuid(),
          exportId: z.string().uuid(),
        })
        .parse(req.params);
      const ctx = await requireCaseActor(req, reply, params.id, "identity.member.read", { retainedRead: true });
      if (!ctx) return;
      // PRO-K1-01 — a stored bundle leaves the platform again: a quarantined
      // session is refused as the generator is (KZ note).
      if ((await refuseIfSessionQuarantined({ req, reply, teamId: ctx.teamId, userId: ctx.userId, action: "EXPORT_GENERATE_PACKAGE" })).refused) return;
      // PRO-K1-01 — decided by what the stored bundle CONTAINS: its PII (the
      // siu.pii.export capability now, plus a fresh step-up) and every record
      // it carries (each must be open to this downloader now).
      const disclosure = await authorizeSiuExportDownload({
        caseId: params.id,
        teamId: ctx.teamId,
        exportId: params.exportId,
        actorUserId: ctx.userId,
        mayExportPii: ctx.exposePii,
      });
      if (!disclosure.allowed) {
        await emitTenantAudit({
          action: "siu_export_download_refused",
          outcome: "denied",
          severity: "warning",
          sourceApp: "API",
          actorUserId: ctx.userId,
          workspaceId: ctx.teamId,
          resourceType: "case",
          resourceId: params.id,
          correlationId: req.id ?? null,
          metadata: { teamId: ctx.teamId, exportId: params.exportId, reason: disclosure.code },
        }).catch(() => {});
        return reply.code(disclosure.status).send({ error: { code: disclosure.code } });
      }
      if (disclosure.piiBearing) {
        const piiStepUp = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId: ctx.teamId,
          userId: ctx.userId,
          purpose: "SIU_PII_REVEAL",
          resourceKind: "case",
          resourceId: params.id,
        });
        if (piiStepUp.sent) return;
      }
      // The stored bundle carries the same artifacts; the same gate applies
      // NOW, not only when it was generated (2026-09-29, audit M2).
      const withheldNow = await countSiuRecordsWithheld(req, ctx, params.id);
      if (withheldNow > 0) {
        return reply.code(403).send({
          error: { code: "siu_export_blocked_by_policy", withheldRecords: withheldNow },
        });
      }
      const outcome = await downloadSiuExportArtifact({
        caseId: params.id,
        teamId: ctx.teamId,
        exportId: params.exportId,
        actorUserId: ctx.userId,
      });
      if ("notFound" in outcome) {
        return reply
          .code(404)
          .send({ error: { code: "siu_export_not_found" } });
      }
      if ("notAvailable" in outcome) {
        return reply.code(409).send({
          error: {
            code: "siu_export_not_downloadable",
            reason: outcome.reason,
          },
        });
      }
      // PHASE 13 §4 (2026-08-17) — THE AUDIT AND THE DURABLE STAMP NOW FOLLOW
      // THE BYTES.
      //
      // `siu_export_downloaded` was emitted here, before `reply.send(stream)`,
      // and the service stamped `downloaded_at_utc` earlier still — at the
      // moment the S3 stream was opened. Between them they guaranteed a
      // success record for every download that was ATTEMPTED, including the
      // ones that died halfway. For an evidence product an audit trail that
      // over-reports delivery is worse than one that reports nothing.
      //
      // Both are now bound to the response's own lifecycle:
      //
      //   'finish' — the response was fully flushed to the socket. This is the
      //              only place a success audit and the `downloaded` stamp are
      //              written.
      //   'close'  — the connection ended. If `writableFinished` is false the
      //              transfer was cut short, and that is recorded as its own
      //              audit outcome rather than left silent: an operator who
      //              believes they have the bundle and does not is exactly the
      //              case the record has to be able to answer.
      //
      // Both handlers are best-effort and detached: an audit failure must never
      // affect a transfer that has already happened.
      const auditBase = {
        action: "siu_export_downloaded" as const,
        sourceApp: "API" as const,
        actorUserId: ctx.userId,
        workspaceId: ctx.teamId,
        resourceType: "case",
        resourceId: params.id,
        correlationId: req.id ?? null,
        metadata: {
          teamId: ctx.teamId,
          exportRowId: outcome.exportRowId,
          artifactSha256: outcome.artifactSha256,
        },
      };
      reply.raw.once("finish", () => {
        void markSiuExportDelivered({ exportRowId: outcome.exportRowId }).catch(
          () => {},
        );
        void emitTenantAudit({ ...auditBase, outcome: "success" }).catch(
          () => {},
        );
      });
      reply.raw.once("close", () => {
        if (reply.raw.writableFinished) return;
        void emitTenantAudit({
          ...auditBase,
          outcome: "error",
          denialReason: "download_stream_interrupted",
        }).catch(() => {});
      });
      reply
        .header("content-type", "application/zip")
        .header(
          "content-disposition",
          `attachment; filename="siu-export-${params.id}.zip"`,
        )
        .header("x-proovra-siu-export-id", outcome.exportRowId);
      if (outcome.artifactSha256) {
        reply.header("x-proovra-siu-artifact-sha256", outcome.artifactSha256);
      }
      return reply.code(200).send(outcome.stream);
    },
  );
}
