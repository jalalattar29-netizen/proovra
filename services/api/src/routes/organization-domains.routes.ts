/**
 * Phase 3 — Enterprise Identity: Organization domain verification routes.
 *
 *   POST   /v1/orgs/:orgId/domains            — add a domain; returns the DNS
 *                                               TXT challenge the admin must
 *                                               publish. (DOMAIN_ADDED)
 *   POST   /v1/orgs/:orgId/domains/:id/verify — check DNS TXT + mark verified.
 *                                               Step-up required. (DOMAIN_VERIFIED)
 *   GET    /v1/orgs/:orgId/domains            — list domains + status.
 *   DELETE /v1/orgs/:orgId/domains/:id        — remove a domain claim. Step-up
 *                                               required. (DOMAIN_REMOVED)
 *
 * Gating (every endpoint):
 *   - requireAuth + legal acceptance.
 *   - ORG_ADMIN or ORG_SECURITY_ADMIN on the org (checkOrgAccess).
 *   - Enterprise feature gate (`ssoScim`) at the ORG level — domain
 *     verification is an enterprise identity feature.
 *   - verify + delete additionally require step-up (sensitive: they change the
 *     identity boundary that gates SSO logins).
 *
 * Every mutation writes an OrganizationAuditEvent inside its own transaction
 * (DOMAIN_ADDED / DOMAIN_VERIFIED / DOMAIN_REMOVED). DNS challenge tokens are
 * NOT credentials and are safe to surface to the publishing admin; they are
 * still never written to the audit metadata.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { getAuthUserId } from "../auth.js";
import { checkOrgAccess } from "../services/organization/org-access.js";
import { emitOrgAuditEvent } from "../services/organization/org-audit.service.js";
import { resolveOrgEnterpriseFeatureGate } from "../services/enterprise-gate-resolvers.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import {
  normalizeDomain,
  generateVerificationToken,
  checkDomainDnsTxt,
  DOMAIN_VERIFY_DNS_PREFIX,
  DOMAIN_VERIFY_TXT_PREFIX,
} from "../services/organization/organization-domain.service.js";

const UuidParam = z.string().uuid();
const AddDomainBody = z.object({
  domain: z.string().trim().min(3).max(255),
});

async function requireAuthAndLegal(
  req: FastifyRequest,
  reply: Parameters<typeof requireAuth>[1],
) {
  await requireAuth(req, reply);
  // See me-inbox.routes.ts for the full account: `requireAuth` REPLIES rather
  // than throwing, so without this the next guard sends a second 401 and
  // Fastify logs FST_ERR_REP_ALREADY_SENT at error level.
  if (reply.sent) return;
  await requireLegalAcceptance(req, reply);
}

/**
 * Resolves a representative workspace (Team) id for the org so the step-up
 * middleware (which is team-scoped) has a teamId to bind the challenge and
 * risk snapshot to. Any workspace of the org is acceptable — org admins act
 * across the org, not a single workspace.
 */
async function resolveOrgTeamId(orgId: string): Promise<string | null> {
  const team = await prisma.team.findFirst({
    where: { organizationId: orgId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return team?.id ?? null;
}

function dnsChallenge(domain: string, token: string) {
  return {
    recordName: `${DOMAIN_VERIFY_DNS_PREFIX}.${domain}`,
    recordType: "TXT" as const,
    recordValue: `${DOMAIN_VERIFY_TXT_PREFIX}${token}`,
  };
}

export async function organizationDomainsRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /v1/orgs/:orgId/domains — add a domain, return the DNS challenge.
  // -------------------------------------------------------------------------
  app.post(
    "/v1/orgs/:orgId/domains",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { orgId: string }).orgId);
      const userId = getAuthUserId(req);
      const body = AddDomainBody.parse(req.body);

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_SECURITY_ADMIN",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ error: { code: "forbidden" } });
      }

      const gate = await resolveOrgEnterpriseFeatureGate(orgId, "ssoScim");
      if (!gate.ok) {
        return reply
          .code(gate.statusCode)
          .send({ error: { code: gate.reason, upgradeCta: "/contact-sales" } });
      }

      const domain = normalizeDomain(body.domain);
      if (!domain) {
        return reply.code(400).send({ error: { code: "invalid_domain" } });
      }

      const token = generateVerificationToken();

      const created = await prisma.$transaction(async (tx) => {
        const existing = await tx.organizationDomain.findFirst({
          where: { organizationId: orgId, domain },
          select: { id: true },
        });
        if (existing) return null;

        const row = await tx.organizationDomain.create({
          data: {
            organizationId: orgId,
            domain,
            verificationToken: token,
            createdByUserId: userId,
          },
          select: {
            id: true,
            domain: true,
            verificationToken: true,
            verifiedAt: true,
            createdAt: true,
          },
        });

        await emitOrgAuditEvent(tx, {
          organizationId: orgId,
          actorUserId: userId,
          eventType: "DOMAIN_ADDED",
          targetType: "organization_domain",
          targetId: row.id,
          // Token is intentionally NOT recorded in audit metadata.
          metadata: { domain: row.domain },
        });

        return row;
      });

      if (!created) {
        return reply.code(409).send({ error: { code: "domain_already_exists" } });
      }

      return reply.code(201).send({
        id: created.id,
        domain: created.domain,
        verified: false,
        verifiedAt: null,
        createdAt: created.createdAt.toISOString(),
        challenge: dnsChallenge(created.domain, created.verificationToken),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:orgId/domains/:id/verify — DNS TXT check + mark verified.
  // Step-up required.
  // -------------------------------------------------------------------------
  app.post(
    "/v1/orgs/:orgId/domains/:id/verify",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const params = req.params as { orgId: string; id: string };
      const orgId = UuidParam.parse(params.orgId);
      const domainId = UuidParam.parse(params.id);
      const userId = getAuthUserId(req);

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_SECURITY_ADMIN",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ error: { code: "forbidden" } });
      }

      const gate = await resolveOrgEnterpriseFeatureGate(orgId, "ssoScim");
      if (!gate.ok) {
        return reply
          .code(gate.statusCode)
          .send({ error: { code: gate.reason, upgradeCta: "/contact-sales" } });
      }

      const row = await prisma.organizationDomain.findFirst({
        where: { id: domainId, organizationId: orgId },
        select: { id: true, domain: true, verificationToken: true, verifiedAt: true },
      });
      if (!row) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      // Step-up AFTER permission + resource resolution, BEFORE the mutation.
      const teamId = await resolveOrgTeamId(orgId);
      if (teamId) {
        const stepUp = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId,
          userId,
          purpose: "ORG_DOMAIN_VERIFY",
          resourceKind: "organization_domain",
          resourceId: row.id,
        });
        if (stepUp.sent) return; // response already written
      }

      if (row.verifiedAt) {
        return reply.code(200).send({
          id: row.id,
          domain: row.domain,
          verified: true,
          verifiedAt: row.verifiedAt.toISOString(),
        });
      }

      const dnsOk = await checkDomainDnsTxt(row.domain, row.verificationToken);
      if (!dnsOk) {
        return reply.code(422).send({
          error: { code: "dns_verification_failed" },
          challenge: dnsChallenge(row.domain, row.verificationToken),
        });
      }

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.organizationDomain.update({
          where: { id: row.id },
          data: { verifiedAt: new Date() },
          select: { id: true, domain: true, verifiedAt: true },
        });
        await emitOrgAuditEvent(tx, {
          organizationId: orgId,
          actorUserId: userId,
          eventType: "DOMAIN_VERIFIED",
          targetType: "organization_domain",
          targetId: u.id,
          metadata: { domain: u.domain },
        });
        return u;
      });

      return reply.code(200).send({
        id: updated.id,
        domain: updated.domain,
        verified: true,
        verifiedAt: updated.verifiedAt?.toISOString() ?? null,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:orgId/domains — list domains + verification status.
  // -------------------------------------------------------------------------
  app.get(
    "/v1/orgs/:orgId/domains",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { orgId: string }).orgId);
      const userId = getAuthUserId(req);

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_ADMIN",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ error: { code: "forbidden" } });
      }

      const gate = await resolveOrgEnterpriseFeatureGate(orgId, "ssoScim");
      if (!gate.ok) {
        return reply
          .code(gate.statusCode)
          .send({ error: { code: gate.reason, upgradeCta: "/contact-sales" } });
      }

      const rows = await prisma.organizationDomain.findMany({
        where: { organizationId: orgId },
        orderBy: [{ verifiedAt: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          domain: true,
          verifiedAt: true,
          verificationToken: true,
          createdAt: true,
        },
        take: 200,
      });

      return reply.code(200).send({
        domains: rows.map((r) => ({
          id: r.id,
          domain: r.domain,
          verified: r.verifiedAt !== null,
          verifiedAt: r.verifiedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
          // Pending rows carry the challenge so the admin can re-copy it.
          challenge:
            r.verifiedAt === null
              ? dnsChallenge(r.domain, r.verificationToken)
              : null,
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /v1/orgs/:orgId/domains/:id — remove a domain claim. Step-up.
  // -------------------------------------------------------------------------
  app.delete(
    "/v1/orgs/:orgId/domains/:id",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const params = req.params as { orgId: string; id: string };
      const orgId = UuidParam.parse(params.orgId);
      const domainId = UuidParam.parse(params.id);
      const userId = getAuthUserId(req);

      const access = await checkOrgAccess(prisma, {
        orgId,
        userId,
        minRole: "ORG_SECURITY_ADMIN",
      });
      if (access.kind !== "ok") {
        return reply.code(403).send({ error: { code: "forbidden" } });
      }

      const gate = await resolveOrgEnterpriseFeatureGate(orgId, "ssoScim");
      if (!gate.ok) {
        return reply
          .code(gate.statusCode)
          .send({ error: { code: gate.reason, upgradeCta: "/contact-sales" } });
      }

      const row = await prisma.organizationDomain.findFirst({
        where: { id: domainId, organizationId: orgId },
        select: { id: true, domain: true },
      });
      if (!row) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      const teamId = await resolveOrgTeamId(orgId);
      if (teamId) {
        const stepUp = await requireStepUpForSensitiveAction({
          req,
          reply,
          teamId,
          userId,
          purpose: "ORG_DOMAIN_REMOVE",
          resourceKind: "organization_domain",
          resourceId: row.id,
        });
        if (stepUp.sent) return;
      }

      await prisma.$transaction(async (tx) => {
        await tx.organizationDomain.delete({ where: { id: row.id } });
        await emitOrgAuditEvent(tx, {
          organizationId: orgId,
          actorUserId: userId,
          eventType: "DOMAIN_REMOVED",
          targetType: "organization_domain",
          targetId: row.id,
          metadata: { domain: row.domain },
        });
      });

      return reply.code(200).send({ ok: true, id: row.id });
    },
  );
}
