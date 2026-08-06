/**
 * Phase 9 — Governance routes.
 *
 *   GET   /v1/governance/policy                       — read policy + version
 *   PUT   /v1/governance/policy                       — versioned update (ADMIN+)
 *   GET   /v1/governance/legal-holds?teamId&status    — list workspace holds
 *   POST  /v1/governance/legal-holds                  — place hold (ADMIN+)
 *   POST  /v1/governance/legal-holds/:id/release      — release hold (ADMIN+)
 *   GET   /v1/governance/case-legal-holds?teamId      — list case holds
 *   POST  /v1/governance/case-legal-holds             — place case hold (ADMIN+)
 *   POST  /v1/governance/case-legal-holds/:id/release — release case hold (ADMIN+)
 *   GET   /v1/governance/evidence/:id/holds           — list holds on an evidence record
 *
 * All routes require authentication AND authorization through the canonical
 * primitive (`authorizeOrFail`, via the local `requireMember` wrapper):
 * ACTIVE membership + parent-Organization lifecycle + capability + fail-closed
 * + anti-enumeration. Mutating routes pass the appropriate canonical
 * permission; read routes pass `governance.policy.read`.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import type { Permission } from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { runGovernanceHandler } from "./_governance-error-bound.js";
import { requireIntegrationCronSecret } from "../middleware/cron-secret.js";
import {
  GovernancePolicyVersionConflictError,
  listLegalHoldsForEvidence,
  loadWorkspaceGovernancePolicy,
  loadWorkspaceGovernancePolicyVersion,
  projectEffectivePolicy,
  projectLegalHold,
  updateWorkspaceGovernancePolicyWithVersion,
} from "../services/governance.service.js";
// COMPATIBILITY_TEMPORARY — the /v1/governance/legal-holds and
// /v1/governance/case-legal-holds families stay REGISTERED and delegate to the
// ONE canonical Legal-Hold authority. See the REMOVAL CONDITIONS block below.
import {
  CaseLegalHoldError,
  isEvidenceUnderAnyLegalHold,
  LegalHoldError as CanonicalLegalHoldError,
  listCaseScopedLegalHoldsLegacyShape,
  listEvidenceScopedLegalHoldsLegacyShape,
  placeCanonicalLegalHold,
  releaseLegalHoldAnyStore,
} from "../services/governance/legal-hold.service.js";
import {
  PublicationError,
  projectPublicationState,
  publishPublicVerify,
  restorePublicVerify,
  suspendPublicVerify,
  unpublishPublicVerify,
} from "../services/governance/publication.service.js";
import {
  listRetentionCandidates,
  reconcileRetention,
} from "../services/governance/retention-sweeper.service.js";
// Phase 19 — sensitive governance routes require step-up.
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";

const ParamsId = z.object({ id: z.string().uuid() });

/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization.
 *
 * Replaces the former status-blind `requireMember` + role-only
 * `requirePermission` pair. Routes through `authorizeOrFail`, gaining ACTIVE
 * membership + parent-Organization lifecycle + access-expiry + capability /
 * delegated-admin resolution + fail-closed + anti-enumeration (404 for
 * non-members / cross-tenant probes) + audit — in one call. The permission
 * passed at each call site is UNCHANGED from the pre-Phase-1 gate.
 */
async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
  permission: Permission,
): Promise<{ actorUserId: string } | null> {
  const outcome = await authorizeOrFail(req, reply, {
    teamId,
    permission,
    antiEnumeration: true,
  });
  return outcome ? { actorUserId: outcome.actorUserId } : null;
}

/**
 * PHASE 12B CLUSTER 9 — SERVER-DERIVED workspace subject for the workspace
 * governance policy operations.
 *
 * The policy operations used to take their Workspace subject from the request
 * (`?teamId` on the read, `body.teamId` on the write). Membership was checked,
 * so that was not an escalation — but it did mean the client chose WHICH
 * workspace's deletion mode and legal-hold approval gate it was editing, and
 * the operator's actual active workspace never entered the decision. A stale
 * tab could therefore rewrite the policy of a workspace the operator had
 * already navigated away from, and the audit trail would record it as
 * deliberate.
 *
 * This helper reuses the SAME server-side resolution path as
 * `redaction.routes.ts#resolveWorkspace` and
 * `intelligence-platform.routes.ts#authorizeWorkspace`: the persisted
 * `User.currentWorkspaceId` rail (written only by the audited workspace
 * switcher in `platform-context.routes.ts`) handed to the canonical
 * `authorizeOrFail` primitive, which supplies ACTIVE membership +
 * parent-Organization lifecycle + capability + fail-closed + anti-enumeration.
 *
 * No request field participates. There is no header, query or body override.
 */
async function resolveGovernancePolicyWorkspace(
  req: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
): Promise<{ teamId: string; actorUserId: string } | null> {
  const userId = getAuthUserId(req);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currentWorkspaceId: true },
  });
  if (!user?.currentWorkspaceId) {
    // No active workspace context — anti-enumeration 404, matching the
    // canonical primitive's not-a-member path.
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  const outcome = await authorizeOrFail(req, reply, {
    teamId: user.currentWorkspaceId,
    permission,
    antiEnumeration: true,
  });
  if (!outcome) return null;
  return { teamId: outcome.teamId, actorUserId: outcome.actorUserId };
}

/** Bounded ISO projection — the canonical row may carry Date or string. */
function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * Workspace release-approval gate for the COMPATIBILITY_TEMPORARY release
 * adapters. Reads the workspace governance policy and refuses with 412 when
 * the policy demands an explicit acknowledgement that the caller did not
 * supply. It performs NO release and is evaluated BEFORE step-up.
 */
async function assertReleaseApproval(
  reply: FastifyReply,
  teamId: string,
  acknowledged: boolean,
): Promise<boolean> {
  const policy = await loadWorkspaceGovernancePolicy(teamId);
  const required = Boolean(
    (policy as { requireLegalHoldReleaseApproval?: boolean } | null)
      ?.requireLegalHoldReleaseApproval,
  );
  if (required && !acknowledged) {
    reply.code(412).send({ error: { code: "release_approval_required" } });
    return false;
  }
  return true;
}

export async function governanceRoutes(app: FastifyInstance) {
  // GET policy
  //
  // PHASE 12B CLUSTER 9 — the Workspace subject is resolved SERVER-SIDE. The
  // legacy `?teamId` param stays PARSEABLE so pre-existing callers do not
  // 400, but it is never the authorization subject: it is only permitted to
  // NAME the workspace the server independently resolved. A mismatch is a 404
  // (anti-enumeration) rather than an answer about a subject the server did
  // not derive.
  app.get(
    "/v1/governance/policy",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({ teamId: z.string().uuid().optional() })
        .parse(req.query ?? {});
      const ok = await resolveGovernancePolicyWorkspace(
        req,
        reply,
        "governance.policy.read",
      );
      if (!ok) return;
      if (query.teamId && query.teamId !== ok.teamId) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      // Phase 32.5 — bounded schema-drift handling. When the
      // governance schema is missing on this environment, return a
      // bounded 503 instead of a raw Prisma error.
      await runGovernanceHandler(reply, async () => {
        const policy = await loadWorkspaceGovernancePolicy(ok.teamId);
        const version = await loadWorkspaceGovernancePolicyVersion(ok.teamId);
        reply.code(200).send({
          policy: projectEffectivePolicy(policy),
          // Concurrency token — a sibling of `policy`, never a member of it.
          // 0 means "no policy row exists yet".
          version,
          teamId: ok.teamId,
        });
      });
    },
  );

  // PUT policy (versioned update)
  //
  // PHASE 12B CLUSTER 9. Two things changed and both are load-bearing:
  //
  //   1. `teamId` is GONE from the body. `.strict()` makes sending it a 400,
  //      so a Workspace subject cannot be smuggled past the schema either.
  //      The subject comes from the server-side `currentWorkspaceId` rail.
  //   2. `expectedVersion` is REQUIRED and enforced inside the write itself.
  //      The former handler was a blind upsert: concurrent edits both
  //      returned 200 and the loser's governance decision vanished.
  //
  // Ordering is deliberate and unchanged in spirit: authorization, then
  // step-up, then — and only then — the conditional write. Every denial path
  // returns before any mutation is attempted.
  app.put(
    "/v1/governance/policy",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          /**
           * The version the caller read from GET. 0 asserts "no policy row
           * existed". A stale value is a 409 with zero mutation.
           */
          expectedVersion: z.number().int().min(0),
          defaultRetentionDays: z
            .number()
            .int()
            .min(0)
            .max(365 * 100)
            .nullable()
            .optional(),
          evidenceDeletionMode: z
            .enum(["ALLOWED", "ADMIN_ONLY", "DISABLED"])
            .optional(),
          requireLegalHoldApprovalForDeletion: z.boolean().optional(),
          requireReviewBeforeReport: z.boolean().optional(),
          requireReviewBeforePackage: z.boolean().optional(),
          requireReviewBeforePublicVerify: z.boolean().optional(),
          allowExternalIntake: z.boolean().optional(),
          allowAnonymousIntake: z.boolean().optional(),
          allowPublicVerify: z.boolean().optional(),
          allowPackageDownload: z.boolean().optional(),
          allowReportDownload: z.boolean().optional(),
          allowOriginalDownload: z.boolean().optional(),
          // Phase 14 — governance approval flags.
          requirePublicationApproval: z.boolean().optional(),
          requireLegalHoldReleaseApproval: z.boolean().optional(),
        })
        // No unknown keys: a client that still sends `teamId` gets a 400
        // instead of quietly having it ignored (or, worse, honoured).
        .strict()
        .parse(req.body ?? {});

      // GATE 1 — canonical authorization on the SERVER-DERIVED workspace.
      const ok = await resolveGovernancePolicyWorkspace(
        req,
        reply,
        "governance.policy.manage",
      );
      if (!ok) return;

      // GATE 2 — step-up re-proof. Still before any write.
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: ok.teamId,
        userId: ok.actorUserId,
        purpose: "GOVERNANCE_POLICY_UPDATE",
        resourceKind: "workspace_governance_policy",
        resourceId: ok.teamId,
      });
      if (gate.sent) return;

      const { expectedVersion, ...patch } = body;

      let written;
      try {
        written = await updateWorkspaceGovernancePolicyWithVersion({
          teamId: ok.teamId,
          actorUserId: ok.actorUserId,
          patch,
          expectedVersion,
        });
      } catch (err) {
        if (err instanceof GovernancePolicyVersionConflictError) {
          // ZERO mutation happened: the conditional UPDATE matched no row (or
          // the INSERT lost the unique index). The caller must re-read.
          return reply.code(409).send({
            code: err.code,
            error: {
              code: err.code,
              message:
                "This policy was changed by someone else. Reload the latest values and reapply your change.",
              details: {
                expectedVersion: err.expectedVersion,
                currentVersion: err.currentVersion,
              },
            },
          });
        }
        throw err;
      }

      // Audit: old version → new version and the NAMES of the changed fields.
      // Never the values — a governance policy value is workspace-internal and
      // the audit sink is a different trust boundary from the policy row.
      await emitTenantAudit({
        action: "governance.workspace_policy_updated",
        outcome: "success",
        sourceApp: "API",
        actorUserId: ok.actorUserId,
        workspaceId: ok.teamId,
        resourceType: "workspace_governance_policy",
        resourceId: written.row.id,
        capability: "governance.policy.manage",
        policyId: written.row.id,
        policyVersion: written.newVersion,
        correlationId: req.id ?? null,
        metadata: {
          previousVersion: written.previousVersion,
          newVersion: written.newVersion,
          changedFields: written.changedFields,
        },
      });

      const policy = await loadWorkspaceGovernancePolicy(ok.teamId);
      return reply.code(200).send({
        policy: projectEffectivePolicy(policy),
        version: written.newVersion,
        teamId: ok.teamId,
        id: written.row.id,
      });
    },
  );

  // ===========================================================================
  // COMPATIBILITY_TEMPORARY — Legal-Hold adapters (6 operations).
  //
  // These six operations are RETAINED, not deleted. They own no state: every
  // one is a thin delegate over the ONE canonical Legal-Hold authority in
  // services/governance/legal-hold.service.ts, which is the only module that
  // writes `evidence_legal_holds`. There is no second authority here — no
  // placement, release or list implementation of their own, no legacy Prisma
  // delegate, and no legacy-table fallback.
  //
  // REMOVAL CONDITIONS — all six must hold before these routes may be deleted.
  // Repository callers being zero is NOT sufficient on its own:
  //
  //   1. the owner applies the Legal-Hold expand migration
  //      (20271106000000_legal_hold_canonical);
  //   2. the owner runs the backfill migration
  //      (20271107000000_legal_hold_backfill);
  //   3. `scripts/legal-hold-convergence-report.mjs` reports ZERO unresolved,
  //      conflicting or unconverted rows;
  //   4. the owner applies 20271108000000_legal_hold_legacy_removal;
  //   5. deployed clients and external consumers no longer require these
  //      compatibility URLs. Repo-side there are already ZERO product/machine callers,
  //      machine-checked by phase-12-legal-hold-compatibility;
  //   6. post-deployment production observation confirms zero traffic on them.
  //
  // Until every condition holds, deleting these routes would remove a public
  // surface while the legacy tables still exist in a deployed environment.
  // ===========================================================================

  // GET /v1/governance/legal-holds — evidence-scoped list, legacy shape.
  //
  // Reading whether a preservation control EXISTS is a member-level governance
  // fact, so this gates on the read capability, never on manage.
  app.get(
    "/v1/governance/legal-holds",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          status: z.enum(["ACTIVE", "RELEASED"]).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId, "governance.policy.read");
      if (!ok) return;

      await runGovernanceHandler(reply, async () => {
        const rows = await listEvidenceScopedLegalHoldsLegacyShape({
          teamId: query.teamId,
          status: query.status,
          limit: query.limit,
        });
        reply.code(200).send({ legalHolds: rows });
      });
    },
  );

  // POST /v1/governance/legal-holds — place an EVIDENCE-scoped hold.
  app.post(
    "/v1/governance/legal-holds",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          evidenceId: z.string().uuid(),
          title: z.string().min(1).max(180),
          reason: z.string().max(4000).nullable().optional(),
          caseId: z.string().uuid().nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId, "governance.legal_hold.manage");
      if (!ok) return;

      // Step-up is TARGET-BOUND: the challenge is spent against this exact
      // evidence id, so an elevation obtained for another record cannot place
      // a hold here.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ok.actorUserId,
        purpose: "LEGAL_HOLD_PLACE",
        resourceKind: "evidence_legal_hold",
        resourceId: body.evidenceId,
      });
      if (gate.sent) return;

      try {
        const hold = await placeCanonicalLegalHold({
          teamId: body.teamId,
          scope: "EVIDENCE",
          evidenceId: body.evidenceId,
          caseId: body.caseId ?? null,
          title: body.title,
          reason: body.reason ?? null,
          actorUserId: ok.actorUserId,
        });
        reply.code(201).send({
          legalHold: {
            id: hold.id,
            teamId: hold.teamId,
            evidenceId: hold.evidenceId ?? body.evidenceId,
            caseId: hold.caseId ?? null,
            title: hold.title,
            reason: hold.reason ?? null,
            status: hold.status,
            placedByUserId: hold.placedByUserId,
            placedAtUtc: toIso(hold.placedAtUtc),
            releasedByUserId: hold.releasedByUserId ?? null,
            releasedAtUtc: toIso(hold.releasedAtUtc),
            releaseNote: hold.releaseNote ?? null,
          },
        });
      } catch (err) {
        // A target in ANOTHER workspace is concealed as "not found" — the
        // canonical authority decides this, the adapter only maps the code.
        if (err instanceof CanonicalLegalHoldError) {
          if (err.code === "target_not_in_workspace") {
            return reply
              .code(404)
              .send({ error: { code: "evidence_not_found" } });
          }
          return reply
            .code(err.statusCode ?? 400)
            .send({ error: { code: err.code } });
        }
        throw err;
      }
    },
  );

  // POST /v1/governance/legal-holds/:id/release — release an evidence hold.
  app.post(
    "/v1/governance/legal-holds/:id/release",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          releaseNote: z.string().max(4000).nullable().optional(),
          approvalAcknowledged: z.boolean().optional(),
          expectedVersion: z.coerce.number().int().nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId, "governance.legal_hold.manage");
      if (!ok) return;

      const approval = await assertReleaseApproval(
        reply,
        body.teamId,
        body.approvalAcknowledged === true,
      );
      if (!approval) return;

      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ok.actorUserId,
        purpose: "LEGAL_HOLD_RELEASE",
        resourceKind: "evidence_legal_hold",
        resourceId: id,
      });
      if (gate.sent) return;

      try {
        await releaseLegalHoldAnyStore({
          teamId: body.teamId,
          holdId: id,
          actorUserId: ok.actorUserId,
          releaseNote: body.releaseNote ?? "",
          expectedVersion: body.expectedVersion ?? null,
          approvalAcknowledged: body.approvalAcknowledged === true,
        });
      } catch (err) {
        if (err instanceof CanonicalLegalHoldError) {
          return reply
            .code(err.statusCode ?? 409)
            .send({ error: { code: err.code } });
        }
        throw err;
      }

      // Re-read the row rather than fabricating a released projection: if the
      // canonical store cannot show it, we do not claim it happened.
      const rows = await listEvidenceScopedLegalHoldsLegacyShape({
        teamId: body.teamId,
      });
      const row = rows.find((r) => r.id === id) ?? rows[0];
      if (!row) {
        return reply.code(404).send({ error: { code: "hold_not_found" } });
      }
      reply.code(200).send({ legalHold: row });
    },
  );

  // GET /v1/governance/case-legal-holds — CASE-scoped list, legacy shape.
  app.get(
    "/v1/governance/case-legal-holds",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          caseId: z.string().uuid().optional(),
          status: z.enum(["ACTIVE", "RELEASED"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId, "governance.policy.read");
      if (!ok) return;

      // PHASE 12 POINT 3 — this handler previously caught Prisma P2021/P2022
      // and answered 200 with an empty list plus a "subsystem not enabled"
      // marker, because `case_legal_holds` was an OPTIONAL Phase-14 table. The
      // read now resolves against the ONE canonical store, which is never
      // optional, so an unreadable store must NOT be reported as "no holds":
      // that would call held evidence free. Errors propagate to the governance
      // handler, which surfaces the degraded banner instead.
      await runGovernanceHandler(reply, async () => {
        const rows = await listCaseScopedLegalHoldsLegacyShape({
          teamId: query.teamId,
          caseId: query.caseId,
          status: query.status,
          limit: query.limit,
        });
        reply.code(200).send({ caseLegalHolds: rows });
      });
    },
  );

  // POST /v1/governance/case-legal-holds — place a CASE-scoped hold.
  app.post(
    "/v1/governance/case-legal-holds",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z
        .object({
          teamId: z.string().uuid(),
          caseId: z.string().uuid(),
          title: z.string().min(1).max(180),
          reason: z.string().max(4000).nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId, "governance.legal_hold.manage");
      if (!ok) return;

      // Placing a CASE hold is exactly as custody-relevant as an evidence
      // hold, so it carries the SAME step-up purpose, bound to the case id.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ok.actorUserId,
        purpose: "LEGAL_HOLD_PLACE",
        resourceKind: "evidence_legal_hold",
        resourceId: body.caseId,
      });
      if (gate.sent) return;

      try {
        const hold = await placeCanonicalLegalHold({
          teamId: body.teamId,
          scope: "CASE",
          caseId: body.caseId,
          title: body.title,
          reason: body.reason ?? null,
          actorUserId: ok.actorUserId,
        });
        reply.code(201).send({
          caseLegalHold: {
            id: hold.id,
            teamId: hold.teamId,
            caseId: hold.caseId ?? body.caseId,
            title: hold.title,
            status: hold.status,
            placedByUserId: hold.placedByUserId,
            placedAtUtc: toIso(hold.placedAtUtc),
            releasedByUserId: hold.releasedByUserId ?? null,
            releasedAtUtc: toIso(hold.releasedAtUtc),
          },
        });
      } catch (err) {
        if (err instanceof CanonicalLegalHoldError) {
          if (err.code === "target_not_in_workspace") {
            return reply.code(404).send({ error: { code: "case_not_found" } });
          }
          return reply
            .code(err.statusCode ?? 400)
            .send({ error: { code: err.code } });
        }
        if (err instanceof CaseLegalHoldError) {
          return reply.code(400).send({ error: { code: err.code } });
        }
        throw err;
      }
    },
  );

  // POST /v1/governance/case-legal-holds/:id/release — release a case hold.
  app.post(
    "/v1/governance/case-legal-holds/:id/release",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          releaseNote: z.string().max(4000).nullable().optional(),
          approvalAcknowledged: z.boolean().optional(),
          expectedVersion: z.coerce.number().int().nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId, "governance.legal_hold.manage");
      if (!ok) return;

      // The workspace approval gate runs BEFORE step-up is offered: an
      // operator must not be asked to re-authenticate for a release the
      // workspace policy is going to refuse anyway.
      const approval = await assertReleaseApproval(
        reply,
        body.teamId,
        body.approvalAcknowledged === true,
      );
      if (!approval) return;

      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.teamId,
        userId: ok.actorUserId,
        purpose: "LEGAL_HOLD_RELEASE",
        resourceKind: "evidence_legal_hold",
        resourceId: id,
      });
      if (gate.sent) return;

      try {
        await releaseLegalHoldAnyStore({
          teamId: body.teamId,
          holdId: id,
          actorUserId: ok.actorUserId,
          releaseNote: body.releaseNote ?? "",
          expectedVersion: body.expectedVersion ?? null,
          approvalAcknowledged: body.approvalAcknowledged === true,
        });
      } catch (err) {
        if (err instanceof CanonicalLegalHoldError) {
          return reply
            .code(err.statusCode ?? 409)
            .send({ error: { code: err.code } });
        }
        if (err instanceof CaseLegalHoldError) {
          return reply.code(409).send({ error: { code: err.code } });
        }
        throw err;
      }

      const rows = await listCaseScopedLegalHoldsLegacyShape({
        teamId: body.teamId,
      });
      const row = rows.find((r) => r.id === id) ?? rows[0];
      if (!row) {
        return reply.code(404).send({ error: { code: "hold_not_found" } });
      }
      reply.code(200).send({ caseLegalHold: row });
    },
  );

  // GET governance status badge for one evidence (authenticated-only)
  //
  // Returns the workspace-internal summary used by the evidence detail
  // page to render legal-hold / retention / policy indicators. Public
  // verify NEVER consumes this — it requires authentication and
  // workspace membership.
  app.get(
    "/v1/governance/evidence/:id/status",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId, "governance.policy.read");
      if (!ok) return;

      const evidence = await prisma.evidence.findUnique({
        where: { id },
        select: {
          id: true,
          teamId: true,
          retentionUntilUtc: true,
          archivedAt: true,
        },
      });
      if (!evidence || evidence.teamId !== query.teamId) {
        return reply
          .code(404)
          .send({ error: { code: "evidence_not_found" } });
      }

      const policy = await loadWorkspaceGovernancePolicy(query.teamId);
      // PHASE 12B CLUSTER 8 — explicit EVIDENCE scope. This badge names one
      // record; a CASE / WORKSPACE hold covering it is reported through the
      // effective-hold evaluator, not by pretending it is a record hold.
      const activeHold = await prisma.evidenceLegalHold.findFirst({
        where: { evidenceId: id, scope: "EVIDENCE", status: "ACTIVE" },
        orderBy: { placedAtUtc: "desc" },
      });

      return reply.code(200).send({
        legalHold:
          activeHold && typeof activeHold.evidenceId === "string"
            ? projectLegalHold({ ...activeHold, evidenceId: activeHold.evidenceId })
            : null,
        retention: {
          retentionUntilUtc: evidence.retentionUntilUtc?.toISOString() ?? null,
          policyDefaultDays: policy.defaultRetentionDays,
        },
        policy: {
          source: policy.source,
          evidenceDeletionMode: policy.evidenceDeletionMode,
          requireReviewBeforeReport: policy.requireReviewBeforeReport,
          requireReviewBeforePackage: policy.requireReviewBeforePackage,
          requireReviewBeforePublicVerify: policy.requireReviewBeforePublicVerify,
          allowReportDownload: policy.allowReportDownload,
          allowPackageDownload: policy.allowPackageDownload,
          allowPublicVerify: policy.allowPublicVerify,
          allowOriginalDownload: policy.allowOriginalDownload,
        },
      });
    },
  );

  // GET legal holds for one evidence
  app.get(
    "/v1/governance/evidence/:id/holds",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId, "governance.policy.read");
      if (!ok) return;

      // Verify the evidence is in this workspace.
      const evidence = await prisma.evidence.findUnique({
        where: { id },
        select: { id: true, teamId: true },
      });
      if (!evidence || evidence.teamId !== query.teamId) {
        return reply
          .code(404)
          .send({ error: { code: "evidence_not_found" } });
      }

      const rows = await listLegalHoldsForEvidence(id);
      return reply.code(200).send({
        legalHolds: rows.map(projectLegalHold),
      });
    },
  );

  // Phase 14 — Public verify publication workflow
  // ===========================================================================

  app.post(
    "/v1/governance/evidence/:id/publish",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().max(400).nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId, "evidence.publish_verify");
      if (!ok) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.actorUserId,
        purpose: "PUBLIC_VERIFY_PUBLISH",
        resourceKind: "evidence",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const updated = await publishPublicVerify({
          evidenceId: id,
          teamId: body.teamId,
          actorUserId: ok.actorUserId,
          reason: body.reason ?? null,
        });
        return reply
          .code(200)
          .send({ publication: projectPublicationState(updated) });
      } catch (err) {
        return publicationErrorToReply(err, reply);
      }
    },
  );

  app.post(
    "/v1/governance/evidence/:id/unpublish",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().max(400).nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId, "evidence.publish_verify");
      if (!ok) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.actorUserId,
        purpose: "PUBLIC_VERIFY_UNPUBLISH",
        resourceKind: "evidence",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const updated = await unpublishPublicVerify({
          evidenceId: id,
          teamId: body.teamId,
          actorUserId: ok.actorUserId,
          reason: body.reason ?? null,
        });
        return reply
          .code(200)
          .send({ publication: projectPublicationState(updated) });
      } catch (err) {
        return publicationErrorToReply(err, reply);
      }
    },
  );

  app.post(
    "/v1/governance/evidence/:id/suspend",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().min(1).max(400),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId, "evidence.publish_verify");
      if (!ok) return;
      const gate = await requireStepUpForSensitiveAction({
        req, reply,
        teamId: body.teamId,
        userId: ok.actorUserId,
        purpose: "PUBLIC_VERIFY_SUSPEND",
        resourceKind: "evidence",
        resourceId: id,
      });
      if (gate.sent) return;
      try {
        const updated = await suspendPublicVerify({
          evidenceId: id,
          teamId: body.teamId,
          actorUserId: ok.actorUserId,
          reason: body.reason,
        });
        return reply
          .code(200)
          .send({ publication: projectPublicationState(updated) });
      } catch (err) {
        return publicationErrorToReply(err, reply);
      }
    },
  );

  app.post(
    "/v1/governance/evidence/:id/restore",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const body = z
        .object({
          teamId: z.string().uuid(),
          reason: z.string().max(400).nullable().optional(),
        })
        .parse(req.body ?? {});
      const ok = await requireMember(req, reply, body.teamId, "evidence.publish_verify");
      if (!ok) return;
      try {
        const updated = await restorePublicVerify({
          evidenceId: id,
          teamId: body.teamId,
          actorUserId: ok.actorUserId,
          reason: body.reason ?? null,
        });
        return reply
          .code(200)
          .send({ publication: projectPublicationState(updated) });
      } catch (err) {
        return publicationErrorToReply(err, reply);
      }
    },
  );

  // ===========================================================================
  // Phase 14 — Retention reconciliation (cron-protected)
  // ===========================================================================

  app.get(
    "/v1/governance/retention-candidates",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = z
        .object({
          teamId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId, "governance.retention.manage");
      if (!ok) return;
      // Phase 32.5 — bounded schema-drift handling.
      await runGovernanceHandler(reply, async () => {
        const rows = await listRetentionCandidates({
          teamId: query.teamId,
          limit: query.limit,
        });
        reply.code(200).send({ candidates: rows });
      });
    },
  );

  app.post(
    "/v1/governance/reconcile-retention",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ok = await requireIntegrationCronSecret(req, reply);
      if (!ok) return;
      const body = z
        .object({
          teamId: z.string().uuid().optional(),
          batchSize: z.number().int().min(1).max(2000).optional(),
        })
        .parse(req.body ?? {});
      const summary = await reconcileRetention({
        teamId: body.teamId,
        batchSize: body.batchSize,
      });
      return reply.code(200).send({ summary });
    },
  );

  // ===========================================================================
  // Phase 14 — Workspace-wide governance state (operator dashboard)
  // ===========================================================================

  app.get(
    "/v1/governance/evidence/:id/is-held",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const query = z
        .object({ teamId: z.string().uuid() })
        .parse(req.query ?? {});
      const ok = await requireMember(req, reply, query.teamId, "governance.policy.read");
      if (!ok) return;
      const evidence = await prisma.evidence.findUnique({
        where: { id },
        select: { id: true, teamId: true },
      });
      if (!evidence || evidence.teamId !== query.teamId) {
        return reply
          .code(404)
          .send({ error: { code: "evidence_not_found" } });
      }
      const held = await isEvidenceUnderAnyLegalHold(id);
      return reply.code(200).send({ held });
    },
  );
}

function publicationErrorToReply(err: unknown, reply: FastifyReply): void {
  if (err instanceof PublicationError) {
    const status =
      err.code === "evidence_not_in_workspace"
        ? 404
        : err.code === "invalid_state_transition"
          ? 409
          : err.code === "publication_approval_required"
            ? 412
            : err.code === "reason_required"
              ? 422
              : 400;
    reply.code(status).send({ error: { code: err.code } });
    return;
  }
  reply.code(500).send({ error: { code: "internal_error" } });
}
