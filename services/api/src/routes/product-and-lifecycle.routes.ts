/**
 * PROOVRA Phase 4B — Product & Lifecycle HTTP routes.
 *
 * Covers:
 *   * Entitlement / packaging endpoints.
 *   * Evidence exchange packages + signed delivery.
 *   * Chain-of-custody transfers.
 *   * Webhook endpoints + delivery log.
 *   * Retention policies.
 *   * Legal holds.
 *   * Archive tier transitions.
 *   * Destruction governance (request → approve → execute → certificate).
 *   * Lifecycle dashboard.
 *   * Lifecycle verification-package preview.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
// PHASE 12 VERTICAL C — canonical authorization for the integration
// delivery-history read. `resolveWorkspace` below derives the workspace
// server-side but checks neither ACTIVE membership, parent-Organization
// lifecycle, access expiry, nor capability.
import { authorizeOrFail } from "../middleware/authorize.js";
import {
  requireDelegatedTier,
  requireDelegatedTierAny,
} from "../middleware/require-delegated-tier.js";
import {
  extractPrismaDiagnostic,
  isPrismaTableOrColumnMissing,
} from "./_governance-error-bound.js";

import {
  assertFeatureEntitlement,
  assertQuotaEntitlement,
  applyProductLine,
  listEntitlements,
  upsertEntitlementGrant,
} from "../services/packaging/entitlement.service.js";
import {
  createExchangePackage,
  generateSignedUrl,
  listPackages,
  listPackageDeliveries,
  recordPackageDelivery,
  recordPackageDownload,
  revokePackage,
} from "../services/exchange/evidence-exchange.service.js";
import { listDeliveryActivity } from "../services/exchange/signed-delivery.service.js";
import {
  acceptChainTransfer,
  initiateChainTransfer,
  listChainTransfers,
  rejectChainTransfer,
  revokeChainTransfer,
  completeChainTransfer,
} from "../services/exchange/chain-transfer.service.js";
import {
  createWebhookEndpoint,
  deactivateWebhookEndpoint,
  listWebhookEndpoints,
} from "../services/packaging/webhooks/webhook-platform.service.js";
import {
  computeUpcomingExpirations,
  createRetentionPolicy,
  listRetentionPolicies,
  releaseRetentionPolicy,
} from "../services/lifecycle/retention-engine.service.js";
// PHASE 12B CLUSTER 8 — the /v1/lifecycle/legal-holds routes stay REGISTERED
// (the Legal Holds product surface consumes them) but are now THIN ADAPTERS
// over the ONE canonical Legal-Hold authority. Physical route deletion is
// gated on the applied + verified backfill migration.
import {
  LegalHoldError,
  listLifecycleLegalHoldsLegacyShape,
  placeCanonicalLegalHold,
  releaseLegalHoldAnyStore,
} from "../services/governance/legal-hold.service.js";
import {
  listArchiveTransitions,
  projectArchiveCostsByTier,
  transitionEvidenceTier,
} from "../services/lifecycle/archive-tier.service.js";
import {
  createDestructionRequest,
  getDestructionCertificate,
  getDestructionCertificateArtifact,
  listDestructionRequests,
  recordApproval,
  rejectDestructionRequest,
  executeDestruction,
} from "../services/lifecycle/destruction-governance.service.js";
import { projectLifecycleDashboard } from "../services/lifecycle/lifecycle-dashboard.service.js";
import { computeLifecycleCapabilityStatus } from "../services/lifecycle/capability-status.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import {
  VERIFICATION_PACKAGE_LIFECYCLE_PREVIEW_KINDS,
  buildLifecyclePackagePreview,
} from "../services/lifecycle/lifecycle-manifest.service.js";
import {
  POLICY_VIOLATION_CODES,
  listPolicyViolations,
  countPolicyViolations,
  type PolicyViolationCode,
} from "../services/lifecycle/policy-violation.service.js";

import {
  LEGAL_HOLD_KINDS,
  PRODUCT_LINES,
  EXCHANGE_PACKAGE_KINDS,
  type EntitlementKey,
  type WebhookEventKind,
} from "@proovra/shared";

// ---------------------------------------------------------------------------
// Workspace resolver (identical pattern to trust-and-governance.routes.ts)
// ---------------------------------------------------------------------------

async function resolveWorkspace(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ teamId: string; userId: string } | null> {
  const userId = getAuthUserId(req);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currentWorkspaceId: true },
  });
  if (!user?.currentWorkspaceId) {
    reply.code(403).send({ denial: "WORKSPACE_NOT_FOUND" });
    return null;
  }
  return { teamId: user.currentWorkspaceId, userId };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function productAndLifecycleRoutes(app: FastifyInstance) {
  // =========================================================================
  // Entitlements
  // =========================================================================

  app.get(
    "/v1/packaging/entitlements",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: entitlement state is commercial plan data.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "billing.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const entitlements = await listEntitlements({ teamId: ctx.teamId });
      return reply.code(200).send({ entitlements });
    },
  );

  app.post(
    "/v1/packaging/entitlements/apply-product-line",
    { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const body = z
        .object({ line: z.enum(PRODUCT_LINES) })
        .parse(req.body);
      // Phase O — Sentry NODE-1K safety net. The repair migration
      // 20270802000000_phase_sentry_batch_schema_drift_repair adds
      // the missing `delegated_admin_grants` columns
      // (`granted_to_user_id`, `scope_target_id`, `created_at`,
      // `updated_at`). `hasDelegatedTier` is already hardened to
      // return false on P2022/P2021 (see delegated-admin.service.ts),
      // so the middleware path is safe. Belt-and-braces: catch any
      // residual P2022/P2021 raised by `applyProductLine` itself —
      // the route returns an explicit degraded payload instead of
      // 500ing. NEVER a silent suppression: the caller sees
      // `degraded: true` + `reason: "SCHEMA_NOT_READY"` and can
      // surface a banner.
      try {
        const res = await applyProductLine({
          teamId: ctx.teamId,
          line: body.line,
          grantedByUserId: ctx.userId,
        });
        return reply.code(200).send({ ok: res.ok, granted: res.granted });
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        if (code === "P2022" || code === "P2021") {
          return reply.code(200).send({
            ok: false,
            granted: 0,
            applied: false,
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/packaging/entitlements/grant",
    { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const body = z
        .object({
          key: z.string().min(1).max(80) as z.ZodType<EntitlementKey>,
          value: z.union([z.boolean(), z.number()]),
          kind: z.enum(["FEATURE", "QUOTA", "LIMIT"] as const),
          source: z.enum(["PLAN", "CUSTOM", "PROMO"] as const).optional(),
          productLine: z.enum(PRODUCT_LINES).nullable().optional(),
          expiresAtUtc: z.string().datetime().nullable().optional(),
        })
        .parse(req.body);
      const res = await upsertEntitlementGrant({
        teamId: ctx.teamId,
        key: body.key,
        value: body.value,
        kind: body.kind,
        source: body.source,
        productLine: body.productLine ?? null,
        grantedByUserId: ctx.userId,
        expiresAtUtc: body.expiresAtUtc ? new Date(body.expiresAtUtc) : null,
      });
      return reply.code(201).send({ grantId: res.grantId });
    },
  );

  // =========================================================================
  // Exchange packages
  // =========================================================================

  app.get(
    "/v1/exchange/packages",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate. resolveWorkspace above
      // resolves the workspace but authorizes nothing; listing packages is a member-level read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "evidence.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      // Phase O Stream B — schema-drift safety net for NODE-1R
      // (evidence_exchange_packages.updated_at missing on production
      // until repair migration is applied). On Prisma P2021/P2022 we
      // return a bounded empty payload with `degraded: true` so the
      // UI can render an honest empty/degraded state instead of a
      // Prisma 500. All other errors propagate to the central
      // handler so real bugs are NOT swallowed.
      try {
        const packages = await listPackages({ teamId: ctx.teamId });
        return reply.code(200).send({ packages });
      } catch (err) {
        if (isPrismaTableOrColumnMissing(err)) {
          const diag = extractPrismaDiagnostic(err);
          reply.log.warn(
            {
              event: "exchange.packages.schema_not_ready",
              requestId: reply.request?.id ?? null,
              teamId: ctx.teamId,
              prismaName: diag.name,
              prismaCode: diag.code,
              missingColumn: diag.missingColumn,
              missingTable: diag.missingTable,
              modelName: diag.modelName,
              message: diag.message,
            },
            "GET /v1/exchange/packages degraded: schema not ready",
          );
          return reply.code(200).send({
            packages: [],
            degraded: true,
            reason: "SCHEMA_NOT_READY",
          });
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/exchange/packages",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate. resolveWorkspace above
      // resolves the workspace but authorizes nothing; creating an exchange package exports evidence.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "evidence.generate_package",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }

      // Feature gate
      const featureOk = await assertFeatureEntitlement({
        teamId: ctx.teamId,
        key: "FEATURE_EVIDENCE_EXCHANGE",
      });
      if (!featureOk.ok) {
        return reply.code(403).send({
          denial: "ENTITLEMENT_REQUIRED",
          key: "FEATURE_EVIDENCE_EXCHANGE",
        });
      }

      // Quota gate
      const quotaOk = await assertQuotaEntitlement({
        teamId: ctx.teamId,
        key: "QUOTA_EXPORT_PACKAGES_PER_MONTH",
        requested: 1,
      });
      if (!quotaOk.ok) {
        return reply.code(429).send({
          denial: "QUOTA_EXCEEDED",
          key: "QUOTA_EXPORT_PACKAGES_PER_MONTH",
        });
      }

      const body = z
        .object({
          kind: z.enum(EXCHANGE_PACKAGE_KINDS),
          evidenceIds: z.array(z.string().uuid()).min(1).max(500),
          caseId: z.string().uuid().nullable().optional(),
          scopeNote: z.string().min(1).max(400).optional(),
        })
        .parse(req.body);
      const res = await createExchangePackage({
        teamId: ctx.teamId,
        kind: body.kind,
        evidenceIds: body.evidenceIds,
        caseId: body.caseId ?? null,
        scopeNote: body.scopeNote ?? null,
        createdByUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({ packageId: res.packageId });
    },
  );

  app.post(
    "/v1/exchange/packages/:id/ready",
    { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          storageKey: z.string().min(1).max(400),
          packageSha256: z.string().min(1).max(64),
          packageSizeBytes: z.number().int().nonnegative(),
        })
        .parse(req.body);
      await generateSignedUrl({
        teamId: ctx.teamId,
        packageId: id,
        ttlSeconds: 3600,
      });
      // markPackageReady is lower-level; for this route we use it by
      // importing the function directly since the route needs explicit fields.
      const { markPackageReady } = await import(
        "../services/exchange/evidence-exchange.service.js"
      );
      const mr = await markPackageReady({
        teamId: ctx.teamId,
        packageId: id,
        storageKey: body.storageKey,
        packageSha256: body.packageSha256,
        packageSizeBytes: body.packageSizeBytes,
      });
      if (!mr.ok) return reply.code(404).send({ denial: "NOT_FOUND" });
      return reply.code(200).send({ ok: true });
    },
  );

  app.post(
    "/v1/exchange/packages/:id/sign-url",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate. resolveWorkspace above
      // resolves the workspace but authorizes nothing; minting a signed URL hands out evidence access.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "evidence.generate_package",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }

      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      // PHASE 12 POINT 4 — minting a signed URL hands out storage access to evidence.
      // Canonical step-up, evaluated AFTER the capability gate so a denial
      // never even offers a challenge. Target-bound to this exact package,
      // so an elevation obtained for another package cannot be replayed here.
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: ctx.teamId,
        userId: ctx.userId,
        purpose: "PACKAGE_EXPORT_HIGH_RISK",
        resourceKind: "evidence_exchange_package",
        resourceId: id,
      });
      if (stepUp.sent) return reply;
      const q = z
        .object({ ttlSeconds: z.coerce.number().int().positive().optional() })
        .parse(req.query ?? {});
      const res = await generateSignedUrl({
        teamId: ctx.teamId,
        packageId: id,
        ttlSeconds: q.ttlSeconds ?? 3600,
      });
      if (!res.ok) return reply.code(404).send({ denial: res.denial });
      return reply.code(200).send({ signedUrl: res.signedUrl, expiresAtUtc: res.expiresAtUtc });
    },
  );

  // PHASE 12B — durable delivery history (the Exchange page previously kept
  // this in session state only). Workspace comes from resolveWorkspace and the
  // package is re-resolved from persistence, so a client cannot widen scope.
  // Projection carries no bucket/key/signed URL. A package in another
  // workspace 404s exactly like a missing one.
  app.get(
    "/v1/exchange/packages/:packageId/deliveries",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate. resolveWorkspace above
      // resolves the workspace but authorizes nothing; listing deliveries is a member-level read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "evidence.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const { packageId } = z
        .object({ packageId: z.string().uuid() })
        .parse(req.params);
      const query = z
        .object({
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .parse(req.query ?? {});
      const res = await listPackageDeliveries({
        teamId: ctx.teamId,
        packageId,
        cursor: query.cursor ?? null,
        limit: query.limit,
      });
      if (!res.ok) return reply.code(404).send({ denial: "NOT_FOUND" });
      return reply
        .code(200)
        .send({ deliveries: res.deliveries, nextCursor: res.nextCursor });
    },
  );

  app.post(
    "/v1/exchange/packages/:id/deliveries",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate. resolveWorkspace above
      // resolves the workspace but authorizes nothing; recording a delivery sends evidence to a recipient.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "evidence.generate_package",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }

      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      // PHASE 12 POINT 4 — recording a delivery transmits the package to an external recipient.
      // Canonical step-up, evaluated AFTER the capability gate so a denial
      // never even offers a challenge. Target-bound to this exact package,
      // so an elevation obtained for another package cannot be replayed here.
      const stepUp = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: ctx.teamId,
        userId: ctx.userId,
        purpose: "PACKAGE_EXPORT_HIGH_RISK",
        resourceKind: "evidence_exchange_package",
        resourceId: id,
      });
      if (stepUp.sent) return reply;
      const body = z
        .object({
          recipientEmail: z.string().email().max(320).optional(),
          recipientOrgSlug: z.string().min(1).max(120).optional(),
          channel: z.string().min(1).max(20).optional(),
        })
        .parse(req.body ?? {});
      const res = await recordPackageDelivery({
        teamId: ctx.teamId,
        packageId: id,
        recipientEmail: body.recipientEmail ?? null,
        recipientOrgSlug: body.recipientOrgSlug ?? null,
        channel: body.channel ?? "SIGNED_URL",
      });
      if (!res.ok) return reply.code(404).send({ denial: "NOT_FOUND" });
      return reply.code(201).send({ deliveryId: res.deliveryId });
    },
  );

  app.post(
    "/v1/exchange/deliveries/:id/download",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate. resolveWorkspace above
      // resolves the workspace but authorizes nothing; recording a download is weaker than issuing the delivery.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "evidence.download_package",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await recordPackageDownload({
        teamId: ctx.teamId,
        deliveryId: id,
      });
      if (!res.ok) return reply.code(404).send({ denial: "NOT_FOUND" });
      return reply.code(200).send({ ok: true });
    },
  );

  app.post(
    "/v1/exchange/packages/:id/revoke",
    { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await revokePackage({
        teamId: ctx.teamId,
        packageId: id,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(404).send({ denial: "NOT_FOUND" });
      return reply.code(200).send({ ok: true });
    },
  );

  // =========================================================================
  // Chain transfers
  // =========================================================================

  app.get(
    "/v1/exchange/chain-transfers",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate. resolveWorkspace above
      // resolves the workspace but authorizes nothing; listing chain transfers is a member-level read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "evidence.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const transfers = await listChainTransfers({ teamId: ctx.teamId });
      return reply.code(200).send({ transfers });
    },
  );

  app.post(
    "/v1/exchange/chain-transfers",
    {
      preHandler: [
        requireAuth,
        requireDelegatedTierAny(["ORG_ADMIN", "REVIEWER_LEAD"]),
      ],
    },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;

      // Feature gate
      const featureOk = await assertFeatureEntitlement({
        teamId: ctx.teamId,
        key: "FEATURE_CHAIN_TRANSFER",
      });
      if (!featureOk.ok) {
        return reply.code(403).send({
          denial: "ENTITLEMENT_REQUIRED",
          key: "FEATURE_CHAIN_TRANSFER",
        });
      }

      const body = z
        .object({
          fromOrganizationId: z.string().uuid(),
          toOrganizationSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/),
          evidenceIds: z.array(z.string().uuid()).min(1).max(500),
          caseId: z.string().uuid().nullable().optional(),
          reasonNote: z.string().min(1).max(400).optional(),
          expiresAtUtc: z.string().datetime().nullable().optional(),
        })
        .parse(req.body);
      const res = await initiateChainTransfer({
        teamId: ctx.teamId,
        fromOrganizationId: body.fromOrganizationId,
        toOrganizationSlug: body.toOrganizationSlug,
        evidenceIds: body.evidenceIds,
        caseId: body.caseId ?? null,
        reasonNote: body.reasonNote ?? null,
        initiatedByUserId: ctx.userId,
        expiresAtUtc: body.expiresAtUtc ?? null,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({ transferId: res.transferId });
    },
  );

  app.post(
    "/v1/exchange/chain-transfers/:id/accept",
    { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ acceptingOrgId: z.string().uuid().optional() })
        .parse(req.body ?? {});
      const res = await acceptChainTransfer({
        teamId: ctx.teamId,
        transferId: id,
        acceptingUserId: ctx.userId,
        acceptingOrgId: body.acceptingOrgId ?? null,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true });
    },
  );

  app.post(
    "/v1/exchange/chain-transfers/:id/reject",
    { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ reason: z.string().min(1).max(400).optional() })
        .parse(req.body ?? {});
      const res = await rejectChainTransfer({
        teamId: ctx.teamId,
        transferId: id,
        rejectingUserId: ctx.userId,
        reason: body.reason ?? null,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true });
    },
  );

  app.post(
    "/v1/exchange/chain-transfers/:id/revoke",
    { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await revokeChainTransfer({
        teamId: ctx.teamId,
        transferId: id,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true });
    },
  );

  app.post(
    "/v1/exchange/chain-transfers/:id/complete",
    { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ packageId: z.string().uuid() })
        .parse(req.body);
      const res = await completeChainTransfer({
        teamId: ctx.teamId,
        transferId: id,
        packageId: body.packageId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(200).send({ ok: true });
    },
  );

  // =========================================================================
  // Webhooks
  // =========================================================================

  app.get(
    "/v1/integrations/webhooks/endpoints",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: webhook endpoint config is integration-owner data.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "integration.webhook.manage",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const featureOk = await assertFeatureEntitlement({
        teamId: ctx.teamId,
        key: "FEATURE_WEBHOOKS",
      });
      if (!featureOk.ok) {
        return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_WEBHOOKS" });
      }
      const endpoints = await listWebhookEndpoints({ teamId: ctx.teamId });
      return reply.code(200).send({ endpoints });
    },
  );

  app.post(
    "/v1/integrations/webhooks/endpoints",
    { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;

      // Feature gate
      const featureOk = await assertFeatureEntitlement({
        teamId: ctx.teamId,
        key: "FEATURE_WEBHOOKS",
      });
      if (!featureOk.ok) {
        return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_WEBHOOKS" });
      }

      // Limit gate
      const limitOk = await assertQuotaEntitlement({
        teamId: ctx.teamId,
        key: "INTEGRATION_WEBHOOK_ENDPOINTS_MAX",
        requested: 1,
      });
      if (!limitOk.ok) {
        return reply.code(429).send({
          denial: "LIMIT_EXCEEDED",
          key: "INTEGRATION_WEBHOOK_ENDPOINTS_MAX",
        });
      }

      const body = z
        .object({
          url: z.string().url().max(2000),
          subscribedEvents: z.array(z.string().min(1).max(80)).min(1),
        })
        .parse(req.body);
      const res = await createWebhookEndpoint({
        teamId: ctx.teamId,
        url: body.url,
        subscribedEvents: body.subscribedEvents as ReadonlyArray<WebhookEventKind>,
        createdByUserId: ctx.userId,
      });
      // secret is ONLY returned in this response
      return reply.code(201).send({
        endpointId: res.endpointId,
        secret: res.secret,
      });
    },
  );

  app.post(
    "/v1/integrations/webhooks/endpoints/:id/deactivate",
    { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await deactivateWebhookEndpoint({
        teamId: ctx.teamId,
        endpointId: id,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(404).send({ denial: "NOT_FOUND" });
      return reply.code(200).send({ ok: true });
    },
  );

  app.get(
    "/v1/integrations/webhooks/deliveries",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 VERTICAL C — authorization BEFORE the query. Delivery
      // history names external recipients, so it is gated on the integration
      // capability rather than bare authentication, and a cross-Organization
      // probe is concealed as 404 by `antiEnumeration`.
      const authorized = await authorizeOrFail(req, reply, {
        teamId: ctx.teamId,
        permission: "integration.webhook.manage",
        antiEnumeration: true,
      });
      if (!authorized) return reply;
      const q = z
        .object({
          packageId: z.string().uuid().optional(),
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});
      const page = await listDeliveryActivity({
        teamId: ctx.teamId,
        packageId: q.packageId,
        limit: q.limit,
        cursorId: q.cursor ?? null,
      });
      return reply
        .code(200)
        .send({ deliveries: page.deliveries, nextCursor: page.nextCursor });
    },
  );

  // Phase 4B Final Closure C4 — LifecycleWebhookDelivery observability.
  //
  //   GET  /v1/integrations/webhooks/lifecycle-deliveries
  //        Returns the 200 most recent LifecycleWebhookDelivery rows with
  //        extended observability fields: responseStatus, responseBodyExcerpt,
  //        attemptCount, nextAttemptAtUtc.
  //
  //   POST /v1/integrations/webhooks/lifecycle-deliveries/:id/replay
  //        Requires ORG_ADMIN. Resets state=PENDING + nextAttemptAtUtc=now +
  //        attemptCount=0 so the dispatcher picks it up on its next tick.
  //        Dead-lettered deliveries can be replayed this way.

  app.get(
    "/v1/integrations/webhooks/lifecycle-deliveries",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: delivery history is integration-owner data.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "integration.webhook.manage",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const rows = await prisma.lifecycleWebhookDelivery.findMany({
        where: { teamId: ctx.teamId },
        orderBy: { enqueuedAtUtc: "desc" },
        take: 200,
        select: {
          id: true,
          endpointId: true,
          eventKind: true,
          state: true,
          attemptCount: true,
          responseStatus: true,
          responseBodyPreview: true,
          enqueuedAtUtc: true,
          lastAttemptAtUtc: true,
          deliveredAtUtc: true,
          deadLetteredAtUtc: true,
          nextAttemptAtUtc: true,
        },
      });
      return reply.code(200).send({
        deliveries: rows.map((r) => ({
          id: r.id,
          endpointId: r.endpointId,
          eventKind: r.eventKind,
          state: r.state,
          attemptCount: r.attemptCount,
          responseStatus: r.responseStatus,
          responseBodyExcerpt: r.responseBodyPreview,
          enqueuedAtUtc: r.enqueuedAtUtc.toISOString(),
          lastAttemptAtUtc: r.lastAttemptAtUtc?.toISOString() ?? null,
          deliveredAtUtc: r.deliveredAtUtc?.toISOString() ?? null,
          deadLetteredAtUtc: r.deadLetteredAtUtc?.toISOString() ?? null,
          nextAttemptAtUtc: r.nextAttemptAtUtc?.toISOString() ?? null,
        })),
      });
    },
  );

  app.post(
    "/v1/integrations/webhooks/lifecycle-deliveries/:id/replay",
    { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

      const row = await prisma.lifecycleWebhookDelivery.findFirst({
        where: { id, teamId: ctx.teamId },
        select: { id: true, state: true },
      });
      if (!row) return reply.code(404).send({ denial: "NOT_FOUND" });

      await prisma.lifecycleWebhookDelivery.update({
        where: { id },
        data: {
          state: "PENDING",
          nextAttemptAtUtc: new Date(),
          attemptCount: 0,
          lastAttemptAtUtc: null,
          responseStatus: null,
          responseBodyPreview: null,
        },
      });
      return reply.code(200).send({ ok: true, replayedId: id });
    },
  );

  // =========================================================================
  // Retention policies
  // =========================================================================

  app.get(
    "/v1/lifecycle/retention/policies",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: retention policy read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "retention.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const policies = await listRetentionPolicies({ teamId: ctx.teamId });
      return reply.code(200).send({ policies });
    },
  );

  app.post(
    "/v1/lifecycle/retention/policies",
    {
      preHandler: [
        requireAuth,
        requireDelegatedTierAny(["ORG_ADMIN", "COMPLIANCE_OFFICER"]),
      ],
    },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const body = z
        .object({
          name: z.string().min(1).max(200),
          template: z.string().min(1).max(60),
          years: z.number().int().positive().optional(),
          scopeKind: z.enum(["WORKSPACE", "DEPARTMENT", "CASE"] as const),
          scopeTargetId: z.string().uuid().optional(),
          inheritsFromId: z.string().uuid().optional(),
          isOverride: z.boolean().optional(),
          exceptions: z.array(z.string().uuid()).optional(),
        })
        .parse(req.body);
      const res = await createRetentionPolicy({
        teamId: ctx.teamId,
        name: body.name,
        template: body.template as never,
        years: body.years,
        scopeKind: body.scopeKind,
        scopeTargetId: body.scopeTargetId,
        inheritsFromId: body.inheritsFromId,
        isOverride: body.isOverride,
        exceptions: body.exceptions,
        createdByUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial });
      return reply.code(201).send({ policyId: res.policyId });
    },
  );

  app.post(
    "/v1/lifecycle/retention/policies/:id/release",
    {
      preHandler: [
        requireAuth,
        requireDelegatedTierAny(["ORG_ADMIN", "COMPLIANCE_OFFICER"]),
      ],
    },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await releaseRetentionPolicy({
        teamId: ctx.teamId,
        policyId: id,
        actorUserId: ctx.userId,
      });
      if (!res.ok) return reply.code(404).send({ denial: "NOT_FOUND" });
      return reply.code(200).send({ ok: true });
    },
  );

  app.get(
    "/v1/lifecycle/retention/upcoming-expirations",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: retention projection read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "retention.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const expirations = await computeUpcomingExpirations({
        teamId: ctx.teamId,
      });
      return reply.code(200).send({ expirations });
    },
  );

  // =========================================================================
  // Legal holds
  // =========================================================================

  app.get(
    "/v1/lifecycle/legal-holds",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 3 — canonical capability gate. `resolveWorkspace`
      // resolves the workspace but authorizes NOTHING. The retired
      // /v1/governance/legal-holds list enforced this same check through
      // `authorizeOrFail`, so it moves here with the surface rather than being
      // dropped: ACTIVE membership + parent-Organization lifecycle +
      // capability + fail-closed + anti-enumeration.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "governance.policy.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const featureOk = await assertFeatureEntitlement({
        teamId: ctx.teamId,
        key: "FEATURE_LEGAL_HOLD",
      });
      if (!featureOk.ok) {
        return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_LEGAL_HOLD" });
      }
      // ONE surface: every scope (evidence / case / workspace) from the ONE
      // authority, plus any legacy row the backfill has not converted yet so
      // no existing hold disappears from the operator's view.
      const holds = await listLifecycleLegalHoldsLegacyShape({
        teamId: ctx.teamId,
      });
      return reply.code(200).send({ holds });
    },
  );

  app.post(
    "/v1/lifecycle/legal-holds",
    {
      preHandler: [
        requireAuth,
        requireDelegatedTierAny(["ORG_ADMIN", "COMPLIANCE_OFFICER"]),
      ],
    },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 3 — the delegated-tier preHandler above restricts WHO
      // may reach this route; it does not check the legal-hold capability on
      // THIS workspace. The retired /v1/governance/legal-holds placement
      // gated on `governance.legal_hold.manage`, so that check moves here.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "governance.legal_hold.manage",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }

      const featureOk = await assertFeatureEntitlement({
        teamId: ctx.teamId,
        key: "FEATURE_LEGAL_HOLD",
      });
      if (!featureOk.ok) {
        return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_LEGAL_HOLD" });
      }

      const limitOk = await assertQuotaEntitlement({
        teamId: ctx.teamId,
        key: "LEGAL_HOLD_MAX_ACTIVE",
        requested: 1,
      });
      if (!limitOk.ok) {
        return reply.code(429).send({ denial: "LIMIT_EXCEEDED", key: "LEGAL_HOLD_MAX_ACTIVE" });
      }

      const body = z
        .object({
          kind: z.enum(LEGAL_HOLD_KINDS),
          scopeTargetId: z.string().uuid().nullable().optional(),
          name: z.string().min(1).max(200),
          reason: z.string().min(1).max(600),
          expiresAtUtc: z.string().datetime().nullable().optional(),
        })
        .parse(req.body);

      // Phase 3 blocker closure — this lifecycle route is the canonical
      // Legal Hold CREATE path used by the enterprise UI. Placing a hold
      // is a sensitive custody action (LEGAL_HOLD_PLACE is in the MFA
      // force-list), so it must require step-up re-proof when org policy
      // demands it — matching the governance PLACE/RELEASE gates. Additive
      // guard; runs BEFORE createLegalHold; no hold/custody logic changed.
      const stepUpGate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: ctx.teamId,
        userId: ctx.userId,
        purpose: "LEGAL_HOLD_PLACE",
        resourceKind: "evidence_legal_hold",
        resourceId: body.scopeTargetId ?? null,
      });
      if (stepUpGate.sent) return;

      // Map the legacy `kind` vocabulary onto canonical scope. ORGANIZATION
      // and WORKSPACE both mean "every record in this workspace" — the
      // organization binding is carried by the hold's organizationId, which
      // the canonical service resolves from the workspace.
      const scope =
        body.kind === "EVIDENCE"
          ? "EVIDENCE"
          : body.kind === "CASE"
            ? "CASE"
            : "WORKSPACE";
      try {
        const hold = await placeCanonicalLegalHold({
          teamId: ctx.teamId,
          scope,
          evidenceId: scope === "EVIDENCE" ? (body.scopeTargetId ?? null) : null,
          caseId: scope === "CASE" ? (body.scopeTargetId ?? null) : null,
          actorUserId: ctx.userId,
          title: body.name,
          reason: body.reason,
          expiresAtUtc: body.expiresAtUtc ? new Date(body.expiresAtUtc) : null,
        });
        return reply.code(201).send({ holdId: hold.id });
      } catch (err) {
        if (err instanceof LegalHoldError) {
          return reply.code(err.statusCode === 404 ? 409 : err.statusCode).send({
            denial:
              err.code === "scope_target_required"
                ? "SCOPE_TARGET_REQUIRED"
                : err.code === "target_not_in_workspace"
                  ? "TARGET_NOT_IN_WORKSPACE"
                  : err.code.toUpperCase(),
          });
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/lifecycle/legal-holds/:id/release",
    {
      preHandler: [
        requireAuth,
        requireDelegatedTierAny(["ORG_ADMIN", "COMPLIANCE_OFFICER"]),
      ],
    },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 3 — same canonical capability gate as placement. The
      // retired /v1/governance/legal-holds/:id/release enforced it; releasing
      // a preservation control must not be reachable on a weaker check than
      // placing one.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "governance.legal_hold.manage",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          reason: z.string().min(1).max(600).optional(),
          // CLUSTER 8 — release note, optimistic concurrency and the
          // approval acknowledgement now apply to EVERY scope, not just the
          // case-scoped surface that used to enforce them.
          releaseNote: z.string().min(1).max(4000).optional(),
          expectedVersion: z.number().int().min(1).optional(),
          approvalAcknowledged: z.boolean().optional(),
        })
        .parse(req.body ?? {});

      // CLUSTER 8 — releasing a hold is a sensitive custody action.
      // LEGAL_HOLD_RELEASE is in the MFA force-list and the sibling
      // governance route already gated on it; this route did not.
      const stepUpGate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: ctx.teamId,
        userId: ctx.userId,
        purpose: "LEGAL_HOLD_RELEASE",
        resourceKind: "evidence_legal_hold",
        resourceId: id,
      });
      if (stepUpGate.sent) return;

      try {
        await releaseLegalHoldAnyStore({
          teamId: ctx.teamId,
          holdId: id,
          actorUserId: ctx.userId,
          releaseNote: body.releaseNote ?? body.reason ?? "Released by operator.",
          expectedVersion: body.expectedVersion ?? null,
          approvalAcknowledged: body.approvalAcknowledged === true,
        });
        return reply.code(200).send({ ok: true });
      } catch (err) {
        if (err instanceof LegalHoldError) {
          return reply.code(err.statusCode).send({
            denial:
              err.code === "hold_not_found"
                ? "NOT_FOUND"
                : err.code.toUpperCase(),
          });
        }
        throw err;
      }
    },
  );

  // =========================================================================
  // Archive tier
  // =========================================================================

  app.get(
    "/v1/lifecycle/archive/transitions",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: archive lifecycle read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "governance.policy.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const featureOk = await assertFeatureEntitlement({
        teamId: ctx.teamId,
        key: "FEATURE_ARCHIVE_TIERS",
      });
      if (!featureOk.ok) {
        return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_ARCHIVE_TIERS" });
      }
      const transitions = await listArchiveTransitions({ teamId: ctx.teamId });
      return reply.code(200).send({ transitions });
    },
  );

  app.post(
    "/v1/lifecycle/archive/transition",
    { preHandler: [requireAuth, requireDelegatedTier("ORG_ADMIN")] },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const body = z
        .object({
          evidenceId: z.string().uuid(),
          toTier: z.string().min(1).max(60),
          reason: z.string().min(1).max(600).optional(),
        })
        .parse(req.body);
      try {
        const res = await transitionEvidenceTier({
          teamId: ctx.teamId,
          evidenceId: body.evidenceId,
          toTier: body.toTier as never,
          reason: body.reason ?? null,
          initiatedByUserId: ctx.userId,
        });
        return reply.code(200).send({ transitionId: res.transitionId, costEstimateUsdMicros: res.costEstimateUsdMicros });
      } catch (err) {
        const code = err instanceof Error ? err.message : "TRANSITION_ERROR";
        return reply.code(409).send({ denial: code });
      }
    },
  );

  app.get(
    "/v1/lifecycle/archive/costs",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: archive cost read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "governance.policy.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const costs = await projectArchiveCostsByTier({ teamId: ctx.teamId });
      return reply.code(200).send({ costs });
    },
  );

  // =========================================================================
  // Destruction governance
  // =========================================================================

  app.get(
    "/v1/lifecycle/destruction/requests",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: destruction governance read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "governance.policy.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const featureOk = await assertFeatureEntitlement({
        teamId: ctx.teamId,
        key: "FEATURE_DESTRUCTION_GOVERNANCE",
      });
      if (!featureOk.ok) {
        return reply.code(403).send({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_DESTRUCTION_GOVERNANCE" });
      }
      const requests = await listDestructionRequests({ teamId: ctx.teamId });
      return reply.code(200).send({ requests });
    },
  );

  app.post(
    "/v1/lifecycle/destruction/requests",
    {
      preHandler: [
        requireAuth,
        requireDelegatedTierAny(["ORG_ADMIN", "COMPLIANCE_OFFICER"]),
      ],
    },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const body = z
        .object({
          evidenceIds: z.array(z.string().uuid()).min(1).max(500),
          reason: z.string().min(1).max(600),
          policyRef: z.string().max(200).nullable().optional(),
          requiredApproverUserIds: z.array(z.string().uuid()).min(1),
        })
        .parse(req.body);
      const res = await createDestructionRequest({
        teamId: ctx.teamId,
        evidenceIds: body.evidenceIds,
        reason: body.reason,
        policyRef: body.policyRef ?? null,
        requestedByUserId: ctx.userId,
        requiredApproverUserIds: body.requiredApproverUserIds,
      });
      if (!res.ok) return reply.code(409).send({ denial: res.denial, holdIds: res.holdIds ?? [] });
      return reply.code(201).send({ requestId: res.requestId });
    },
  );

  app.post(
    "/v1/lifecycle/destruction/requests/:id/approve",
    {
      preHandler: [
        requireAuth,
        requireDelegatedTierAny(["ORG_ADMIN", "COMPLIANCE_OFFICER", "SECURITY_OFFICER"]),
      ],
    },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await recordApproval({
        teamId: ctx.teamId,
        requestId: id,
        approverUserId: ctx.userId,
      });
      return reply.code(200).send({ ok: res.ok, state: res.state, allApproved: res.allApproved });
    },
  );

  app.post(
    "/v1/lifecycle/destruction/requests/:id/reject",
    {
      preHandler: [
        requireAuth,
        requireDelegatedTierAny(["ORG_ADMIN", "COMPLIANCE_OFFICER"]),
      ],
    },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ reason: z.string().min(1).max(600) })
        .parse(req.body ?? { reason: "rejected" });
      const res = await rejectDestructionRequest({
        teamId: ctx.teamId,
        requestId: id,
        rejectorUserId: ctx.userId,
        reason: body.reason,
      });
      if (!res.ok) return reply.code(404).send({ denial: "NOT_FOUND" });
      return reply.code(200).send({ ok: true });
    },
  );

  app.post(
    "/v1/lifecycle/destruction/requests/:id/execute",
    {
      preHandler: [requireAuth, requireDelegatedTier("COMPLIANCE_OFFICER")],
    },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      try {
        const res = await executeDestruction({
          teamId: ctx.teamId,
          requestId: id,
          executorUserId: ctx.userId,
        });
        return reply.code(200).send({ ok: true, certificateId: res.certificateId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "EXECUTE_ERROR";
        return reply.code(409).send({ denial: msg });
      }
    },
  );

  app.get(
    "/v1/lifecycle/destruction/requests/:id/certificate",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: destruction certificate read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "governance.policy.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const cert = await getDestructionCertificate({
        teamId: ctx.teamId,
        requestId: id,
      });
      if (!cert) return reply.code(404).send({ denial: "NOT_FOUND" });
      return reply.code(200).send({ certificate: cert });
    },
  );

  app.get(
    "/v1/lifecycle/destruction/requests/:id/certificate.json",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: destruction certificate read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "governance.policy.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const res = await getDestructionCertificateArtifact({
        teamId: ctx.teamId,
        requestId: id,
      });
      if (!res.ok) {
        return reply.code(res.denial === "NOT_FOUND" ? 404 : 503).send({ denial: res.denial });
      }
      void reply.header("Content-Type", "application/json");
      void reply.header(
        "Content-Disposition",
        `attachment; filename="destruction-cert-${id}.json"`,
      );
      if (res.sha256) void reply.header("X-Proovra-Certificate-Sha256", res.sha256);
      return reply.code(200).send(res.bytes);
    },
  );


  // =========================================================================
  // Lifecycle dashboard + VP preview
  // =========================================================================

  app.get(
    "/v1/lifecycle/dashboard",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: destruction certificate read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "governance.policy.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }
      // Evidence Lifecycle REAL FIX — the wholesale FEATURE_LIFECYCLE_DASHBOARD
      // 403 gate was wrong. The dashboard is the INDEX page of the console
      // and must always be reachable so the operator can see what they have.
      // Per-section entitlement gating already lives on the sub-routes (legal
      // holds, archive, destruction, chain transfers all have their own
      // FEATURE_* checks) AND on the `capabilities` field in the dashboard
      // response itself. The previous gate produced 403 → frontend "Unable to
      // load lifecycle dashboard" red error for every workspace that never
      // had the placeholder FEATURE_LIFECYCLE_DASHBOARD entitlement seeded.
      // We surface entitlement state via the existing capabilities chip
      // mechanism instead of failing the whole page.
      let entitlementMissing = false;
      try {
        const feOk = await assertFeatureEntitlement({
          prisma,
          teamId: ctx.teamId,
          key: "FEATURE_LIFECYCLE_DASHBOARD",
          actorUserId: ctx.userId,
        });
        entitlementMissing = !feOk.ok;
      } catch {
        // Engine failure must not break the route — leave the flag false
        // so the user sees the console even if the gate engine is down.
      }
      // Evidence Lifecycle Final Fix — the projector may throw on a
      // freshly-bootstrapped workspace (no events, no entitlement rows)
      // OR when a Prisma schema column is in flight to production.
      // Both cases used to surface as "Unable to load lifecycle dashboard"
      // because the frontend interpreted a 5xx body as an unexpected
      // shape. Tolerate both by returning a fully-typed empty projection
      // and a `degraded: true` flag so the UI can label the state instead
      // of erroring out. Real failures (e.g. authentication) still raise
      // — only DATA-projection failures are converted to a degraded read.
      let dashboard: Awaited<ReturnType<typeof projectLifecycleDashboard>> & {
        degraded?: boolean;
        degradedReason?: string;
      };
      try {
        dashboard = await projectLifecycleDashboard({ teamId: ctx.teamId });
      } catch (err) {
        req.log?.warn?.(
          { err: err instanceof Error ? err.message : "dashboard_projection_failed" },
          "lifecycle_dashboard_projection_failed",
        );
        dashboard = {
          retention: {},
          legalHolds: {},
          archive: {},
          destruction: {},
          upcomingExpirations: {},
          violations: {
            totalLegalHoldViolations: 0,
            totalRetentionViolations: 0,
            byCode: {
              POLICY_VIOLATION_ENTITLEMENT: 0,
              POLICY_VIOLATION_LEGAL_HOLD: 0,
              POLICY_VIOLATION_RETENTION: 0,
              POLICY_VIOLATION_QUOTA: 0,
            },
            totalBounded: 0,
          },
          degraded: true,
          degradedReason:
            "Lifecycle activity projection is temporarily unavailable. Counts will populate once it recovers.",
        } as never;
      }
      // Lifecycle Consolidation — attach per-team capability enforcement status.
      // Additive: failure to compute MUST NOT break the dashboard envelope; the
      // frontend tolerates absence (capabilities is optional in the shared type).
      try {
        const capabilities = await computeLifecycleCapabilityStatus({
          prisma,
          teamId: ctx.teamId,
        });
        (dashboard as { capabilities?: typeof capabilities }).capabilities = capabilities;
      } catch (err) {
        req.log?.warn?.(
          { err: err instanceof Error ? err.message : "capability_status_failed" },
          "lifecycle_capability_status_compute_failed",
        );
      }
      // Surface dashboard entitlement state inside the envelope so the UI
      // can show a soft "upgrade to enable advanced metrics" callout
      // WITHOUT failing the whole page. This is the right granularity:
      // the index page always renders; specific paid features advertise
      // their gated status non-destructively.
      (dashboard as { entitlementMissing?: boolean }).entitlementMissing =
        entitlementMissing;
      return reply.code(200).send({ dashboard });
    },
  );

  app.get(
    "/v1/lifecycle/verification-package/preview",
    {
      preHandler: [
        requireAuth,
        requireDelegatedTierAny(["ORG_ADMIN", "COMPLIANCE_OFFICER"]),
      ],
    },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      const q = z
        .object({
          kind: z.enum(VERIFICATION_PACKAGE_LIFECYCLE_PREVIEW_KINDS),
        })
        .parse(req.query ?? {});
      const manifest = await buildLifecyclePackagePreview({
        teamId: ctx.teamId,
        kind: q.kind,
      });
      return reply.code(200).send({ kind: q.kind, manifest });
    },
  );

  // =========================================================================
  // Phase 4B Final Closure C7 — Policy violation observability
  // =========================================================================

  // GET /v1/lifecycle/violations
  // Returns the most recent POLICY_VIOLATION_* events (cap 200) with
  // optional ?kind= and ?since= filters. Bounded codes only.
  app.get(
    "/v1/lifecycle/violations",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: policy violation read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "governance.policy.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }

      const q = z
        .object({
          kind: z
            .enum(POLICY_VIOLATION_CODES as unknown as [string, ...string[]])
            .optional(),
          since: z.string().datetime().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query ?? {});

      const violations = await listPolicyViolations({
        teamId: ctx.teamId,
        kind: q.kind as PolicyViolationCode | undefined,
        since: q.since ? new Date(q.since) : undefined,
        limit: q.limit,
      });

      return reply.code(200).send({ violations });
    },
  );

  // GET /v1/lifecycle/violations/counts
  // Returns aggregated per-code counts for the last 30 days (or ?since=).
  app.get(
    "/v1/lifecycle/violations/counts",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ctx = await resolveWorkspace(req, reply);
      if (!ctx) return reply;
      // PHASE 12 POINT 4 — canonical capability gate: policy violation read.
      if (
        !(await authorizeOrFail(req, reply, {
          teamId: ctx.teamId,
          permission: "governance.policy.read",
          antiEnumeration: true,
        }))
      ) {
        return reply;
      }

      const q = z
        .object({
          since: z.string().datetime().optional(),
        })
        .parse(req.query ?? {});

      const counts = await countPolicyViolations({
        teamId: ctx.teamId,
        since: q.since ? new Date(q.since) : undefined,
      });

      return reply.code(200).send({ counts });
    },
  );
}
