/**
 * Phase B0 — Organization governance write surfaces.
 *
 * Three narrow endpoints that close the read-only-organizations gap
 * inherited from Phase 2.7X Stage 3:
 *
 *   1. POST /v1/orgs/:id/policies/retention
 *      Publish an org-level retention default. Stored in the
 *      `OrganizationPolicy` key-value table under
 *      `key = "retention.default"`. Workspaces in the org inherit
 *      this value when they have no team-level retention policy
 *      of their own.
 *
 *   2. GET /v1/orgs/:id/policies/retention
 *      Read the published default + a summary of which workspaces
 *      currently inherit it (vs. have their own team-level policy).
 *
 *   3. GET /v1/orgs/:id/billing/rollup
 *      Read-only billing rollup across all workspaces bound to the
 *      org. Counts only; no per-payment detail. The endpoint is
 *      ORG_OWNER / ORG_ADMIN / ORG_BILLING_ADMIN gated.
 *
 * Hard rules:
 *   * No new schema. Uses the existing `OrganizationPolicy` table.
 *   * No workspace ownership change. Workspaces stay the operational
 *     unit; organizations remain the governance overlay.
 *   * No nested governance tree. The endpoints operate on a single
 *     organization id.
 *   * All writes require ORG_OWNER or ORG_ADMIN. Read endpoints
 *     require any org membership.
 *   * Every write emits an OrganizationAuditEvent via the existing
 *     `emitOrgAuditEvent` helper for forensic correlation.
 *   * No secrets / certificates / billing tokens are ever returned.
 *
 * Acceptance:
 *   An org-admin can publish a retention template once and every
 *   workspace under that org inherits it for retention policy
 *   resolution. The team-level policy (if any) wins.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { getAuthUserId } from "../auth.js";
import { checkOrgAccess } from "../services/organization/org-access.js";
import type { OrgRole } from "../services/organization/organization-resolver.service.js";
import { emitOrgAuditEvent } from "../services/organization/org-audit.service.js";
import { buildOrgGovernanceControlCenter } from "../services/organization/org-governance-control-center.service.js";

const UuidParam = z.string().uuid();

/**
 * Bounded retention-template shape. Stored on
 * `OrganizationPolicy.value` JSON. Operationally specific so the
 * inheritance resolver can normalize it to the same shape the
 * team-level retention engine consumes.
 */
const RetentionTemplateBody = z.object({
  /**
   * Retention period in days. Null means "indefinite retention" —
   * the workspace will hold evidence until an explicit destruction
   * decision is made.
   */
  retentionDays: z
    .number()
    .int()
    .min(0)
    .max(365 * 50)
    .nullable(),
  /**
   * When true, workspaces inheriting this template cannot scale
   * retention DOWN (only up). When false, workspaces may override
   * with a shorter retention.
   */
  immutable: z.boolean().default(false),
  /** Operator-readable description. Bounded to keep storage tight. */
  description: z.string().trim().max(400).nullable().default(null),
});

type RetentionTemplate = z.infer<typeof RetentionTemplateBody>;

const RETENTION_POLICY_KEY = "retention.default";

async function requireOrgAdmin(input: {
  orgId: string;
  userId: string;
  minRole?: OrgRole;
}): Promise<{ ok: true; role: OrgRole } | { ok: false; code: number }> {
  const result = await checkOrgAccess(prisma, {
    orgId: input.orgId,
    userId: input.userId,
    minRole: input.minRole ?? "ORG_ADMIN",
  });
  if (result.kind !== "ok") {
    // Anti-enumeration: same status code (404) for both
    // `not_found` and `forbidden`.
    return { ok: false, code: 404 };
  }
  return { ok: true, role: result.role };
}

async function requireOrgMember(input: {
  orgId: string;
  userId: string;
}): Promise<{ ok: true; role: OrgRole } | { ok: false; code: number }> {
  const result = await checkOrgAccess(prisma, {
    orgId: input.orgId,
    userId: input.userId,
  });
  if (result.kind !== "ok") return { ok: false, code: 404 };
  return { ok: true, role: result.role };
}

export async function organizationsGovernanceRoutes(app: FastifyInstance) {
  /**
   * POST /v1/orgs/:id/policies/retention
   *
   * Publish (or update) the org-level retention template. Idempotent
   * upsert keyed on (organizationId, "retention.default"). Audit
   * event records the operator + the previous-vs-new value preview.
   */
  app.post(
    "/v1/orgs/:id/policies/retention",
    { preHandler: [requireAuth, requireLegalAcceptance] },
    async (req: FastifyRequest, reply) => {
      const userId = getAuthUserId(req);
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const body = RetentionTemplateBody.parse(req.body);

      const access = await requireOrgAdmin({ orgId, userId });
      if (!access.ok) {
        return reply.code(access.code).send({
          message: "Organization not found",
          code: "org_not_found",
        });
      }

      const value: Prisma.InputJsonValue = {
        retentionDays: body.retentionDays,
        immutable: body.immutable,
        description: body.description,
      };

      const existing = await prisma.organizationPolicy.findUnique({
        where: {
          organization_policies_org_key_uniq: {
            organizationId: orgId,
            key: RETENTION_POLICY_KEY,
          },
        },
        select: { value: true },
      });

      const policy = await prisma.organizationPolicy.upsert({
        where: {
          organization_policies_org_key_uniq: {
            organizationId: orgId,
            key: RETENTION_POLICY_KEY,
          },
        },
        update: {
          value,
          lastUpdatedByUserId: userId,
        },
        create: {
          organizationId: orgId,
          key: RETENTION_POLICY_KEY,
          value,
          lastUpdatedByUserId: userId,
        },
      });

      await emitOrgAuditEvent(prisma, {
        organizationId: orgId,
        actorUserId: userId,
        eventType: "ORG_POLICY_RETENTION_PUBLISHED",
        targetType: "organization",
        targetId: orgId,
        metadata: {
          previousRetentionDays:
            existing && typeof existing.value === "object" && existing.value
              ? (existing.value as Record<string, unknown>).retentionDays ?? null
              : null,
          nextRetentionDays: body.retentionDays,
          immutable: body.immutable,
        },
      });

      return reply.code(200).send({
        organizationId: orgId,
        key: RETENTION_POLICY_KEY,
        value: policy.value,
        updatedAt: policy.updatedAt.toISOString(),
      });
    },
  );

  /**
   * GET /v1/orgs/:id/policies/retention
   *
   * Return the published template + a bounded summary of inheritance
   * status across the org's workspaces. Read-only; any org member
   * may read.
   */
  app.get(
    "/v1/orgs/:id/policies/retention",
    { preHandler: [requireAuth] },
    async (req: FastifyRequest, reply) => {
      const userId = getAuthUserId(req);
      const orgId = UuidParam.parse((req.params as { id: string }).id);

      const access = await requireOrgMember({ orgId, userId });
      if (!access.ok) {
        return reply.code(access.code).send({
          message: "Organization not found",
          code: "org_not_found",
        });
      }

      const policy = await prisma.organizationPolicy.findUnique({
        where: {
          organization_policies_org_key_uniq: {
            organizationId: orgId,
            key: RETENTION_POLICY_KEY,
          },
        },
        select: { value: true, updatedAt: true, lastUpdatedByUserId: true },
      });

      // Bounded inheritance summary. Counts workspaces in the org +
      // a small sample for the admin UI. Never returns evidence
      // content.
      const workspaces = await prisma.team.findMany({
        where: { organizationId: orgId, isPersonal: false },
        select: { id: true, name: true },
        take: 25,
        orderBy: { createdAt: "asc" },
      });
      const workspaceCount = await prisma.team.count({
        where: { organizationId: orgId, isPersonal: false },
      });

      return reply.code(200).send({
        organizationId: orgId,
        key: RETENTION_POLICY_KEY,
        value: policy?.value ?? null,
        updatedAt: policy?.updatedAt?.toISOString() ?? null,
        lastUpdatedByUserId: policy?.lastUpdatedByUserId ?? null,
        inheritance: {
          workspaceCount,
          sample: workspaces,
        },
      });
    },
  );

  /**
   * GET /v1/orgs/:id/billing/rollup
   *
   * Read-only billing rollup across the org's workspaces. Counts +
   * aggregates only — no per-payment detail, no card tokens, no
   * Stripe subscription ids. Operators see "how many subscriptions
   * are active across the org's workspaces" without enumerating
   * customer data.
   *
   * Phase 4 (Enterprise Administration) — extended with seat usage
   * (included vs. used, per-workspace + org totals), an over-seat
   * workspace count, an active-workspace count, and the org billing
   * owner's operator-readable identity (email + display name). All
   * additions are counts / identities only; the counts-only guarantee
   * (no card/Stripe ids) is preserved.
   */
  app.get(
    "/v1/orgs/:id/billing/rollup",
    { preHandler: [requireAuth] },
    async (req: FastifyRequest, reply) => {
      const userId = getAuthUserId(req);
      const orgId = UuidParam.parse((req.params as { id: string }).id);

      // Billing rollup is governance-visible — ORG_BILLING_ADMIN +
      // higher only. ORG_MEMBER + ORG_AUDITOR see counts via the
      // org overview elsewhere.
      const access = await requireOrgAdmin({
        orgId,
        userId,
        minRole: "ORG_BILLING_ADMIN",
      });
      if (!access.ok) {
        return reply.code(access.code).send({
          message: "Organization not found",
          code: "org_not_found",
        });
      }

      const workspaces = await prisma.team.findMany({
        where: { organizationId: orgId, isPersonal: false },
        select: {
          id: true,
          name: true,
          billingPlan: true,
          billingStatus: true,
          includedSeats: true,
          // Used seats = current member count. Same signal the
          // per-workspace billing overview surfaces
          // (billing.service.ts `team._count.members`). Counts only —
          // no member identities cross the wire here.
          _count: { select: { members: true } },
        },
        orderBy: { createdAt: "asc" },
      });

      // Billing owner is an ORG-level field (organizations.billingOwnerUserId).
      // Surface the operator-readable identity (email + display name) so
      // the enterprise billing tab can show a billing contact WITHOUT
      // exposing any payment instrument. Counts-only guarantee is
      // preserved — a user identity is not a card/Stripe id.
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { billingOwnerUserId: true },
      });
      const billingOwnerUserId = org?.billingOwnerUserId ?? null;
      const billingOwner = billingOwnerUserId
        ? await prisma.user.findUnique({
            where: { id: billingOwnerUserId },
            select: { id: true, email: true, displayName: true },
          })
        : null;

      const planCounts: Record<string, number> = {};
      const statusCounts: Record<string, number> = {};
      let totalIncludedSeats = 0;
      let totalUsedSeats = 0;
      let overSeatWorkspaceCount = 0;
      let activeWorkspaceCount = 0;
      for (const ws of workspaces) {
        const plan = String(ws.billingPlan ?? "FREE");
        planCounts[plan] = (planCounts[plan] ?? 0) + 1;
        const status = String(ws.billingStatus ?? "NONE");
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
        const included = ws.includedSeats ?? 0;
        const used = ws._count.members;
        totalIncludedSeats += included;
        totalUsedSeats += used;
        // Over-seat = a workspace whose member count exceeds its
        // included-seat allotment (mirrors billing.service.ts
        // `_count.members > includedSeats`). Only counted when the
        // workspace actually has a seat allotment.
        if (included > 0 && used > included) overSeatWorkspaceCount += 1;
        if (
          status === "ACTIVE" ||
          status === "PAST_DUE"
        ) {
          activeWorkspaceCount += 1;
        }
      }

      return reply.code(200).send({
        organizationId: orgId,
        workspaceCount: workspaces.length,
        activeWorkspaceCount,
        totalIncludedSeats,
        totalUsedSeats,
        overSeatWorkspaceCount,
        planCounts,
        statusCounts,
        // Billing contact — operator identity only. NEVER a payment
        // instrument. Null when the org has no billing owner set.
        billingOwner: billingOwner
          ? {
              userId: billingOwner.id,
              email: billingOwner.email,
              displayName: billingOwner.displayName,
            }
          : null,
        // Bounded per-workspace view — name + plan + status + seat
        // counts only. NEVER includes Stripe subscription ids, customer
        // ids, or payment instrument data.
        workspaces: workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          billingPlan: w.billingPlan,
          billingStatus: w.billingStatus,
          includedSeats: w.includedSeats ?? 0,
          usedSeats: w._count.members,
          overSeat:
            (w.includedSeats ?? 0) > 0 &&
            w._count.members > (w.includedSeats ?? 0),
        })),
      });
    },
  );

  /**
   * GET /v1/orgs/:id/governance/control-center
   *
   * Phase 5 (Enterprise Governance) — the single read-only aggregate
   * behind the org-admin Governance Control Center tab. Resolves the
   * org's non-personal workspaces and projects bounded evidence-
   * governance posture across them: active legal holds, active
   * retention policies, pending destruction reviews, active external-
   * review grants, recent org governance audit, and derived coverage /
   * custody-health indicators.
   *
   * Gate: ORG_AUDITOR+ (read posture — same tier as /audit-events).
   * Anti-enumeration: 404 for any non-OK access outcome (mirrors the
   * sibling org endpoints in this file).
   *
   * READ ONLY: no mutations, no audit emission, no secrets. Each
   * section degrades independently to an honest "unavailable" rather
   * than failing the whole response or fabricating a metric.
   */
  app.get(
    "/v1/orgs/:id/governance/control-center",
    { preHandler: [requireAuth] },
    async (req: FastifyRequest, reply) => {
      const userId = getAuthUserId(req);
      const orgId = UuidParam.parse((req.params as { id: string }).id);

      const access = await requireOrgAdmin({
        orgId,
        userId,
        minRole: "ORG_AUDITOR",
      });
      if (!access.ok) {
        return reply.code(access.code).send({
          message: "Organization not found",
          code: "org_not_found",
        });
      }

      const envelope = await buildOrgGovernanceControlCenter({ orgId });
      return reply.code(200).send(envelope);
    },
  );
}
