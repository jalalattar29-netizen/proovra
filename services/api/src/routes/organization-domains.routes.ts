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
 *   - PV-OD-012 — an explicit role set, not precedence: reads take
 *     ORG_DOMAIN_READ_ROLES (owner, admin, security admin, auditor), writes
 *     take ORG_DOMAIN_WRITE_ROLES (owner, admin, security admin). Precedence
 *     (`minRole: ORG_SECURITY_ADMIN`) also admitted ORG_BILLING_ADMIN, which
 *     shares that rank — a billing admin could add, verify and remove the
 *     identity boundary SSO is checked against.
 *   - PV-ORG-001 — denials render through `orgAccessDenial`: a non-member is
 *     told exactly what a caller asking about a missing org is told.
 *   - Enterprise feature gate (`ssoScim`) at the ORG level — domain
 *     verification is an enterprise identity feature.
 *   - verify + delete additionally require step-up (sensitive: they change the
 *     identity boundary that gates SSO logins), bound to a workspace of the
 *     organization the ACTOR belongs to, and REFUSED when there is none —
 *     never skipped. Adding a domain does not step up: an unverified claim
 *     changes no boundary until it is verified, which does.
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
import { conflictRefusal } from "../errors.js";
import {
  checkOrgAccess,
  orgAccessDenial,
  ORG_DOMAIN_READ_ROLES,
  ORG_DOMAIN_WRITE_ROLES,
} from "../services/organization/org-access.js";
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
 * The workspace a domain step-up is bound to (step-up challenges are
 * workspace-scoped): the ACTOR's own earliest ACTIVE workspace in this
 * organization.
 *
 * PV-OD-012 — this used to be the organization's first workspace whoever the
 * actor was, which failed three ways. A security admin who was not a member of
 * that workspace could never start the challenge; the page bound its challenge
 * to whichever workspace happened to be active, so the two rarely met; and an
 * organization with no workspace at all SKIPPED the step-up — the gate failed
 * open. The list response now names this workspace so the page binds to the
 * same one, and a caller with none is refused.
 */
async function resolveStepUpWorkspace(
  orgId: string,
  userId: string,
): Promise<string | null> {
  const team = await prisma.team.findFirst({
    where: {
      organizationId: orgId,
      members: { some: { userId, status: "ACTIVE" } },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return team?.id ?? null;
}

/** Fail closed: a domain write that cannot be stepped up does not happen. */
function stepUpWorkspaceRequired() {
  return conflictRefusal({
    code: "STEP_UP_WORKSPACE_REQUIRED",
    message:
      "Changing a verified domain needs a step-up confirmation, which is made in a workspace. Join a workspace in this organization, then try again.",
  });
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
        roles: ORG_DOMAIN_WRITE_ROLES,
      });
      if (access.kind !== "ok") {
        const denial = orgAccessDenial(access);
        return reply.code(denial.status).send(denial.body);
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
        roles: ORG_DOMAIN_WRITE_ROLES,
      });
      if (access.kind !== "ok") {
        const denial = orgAccessDenial(access);
        return reply.code(denial.status).send(denial.body);
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
      const teamId = await resolveStepUpWorkspace(orgId, userId);
      if (!teamId) throw stepUpWorkspaceRequired();
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
        roles: ORG_DOMAIN_READ_ROLES,
      });
      if (access.kind !== "ok") {
        const denial = orgAccessDenial(access);
        return reply.code(denial.status).send(denial.body);
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

      // PV-OD-012 — what THIS viewer may do, decided here, so the page never
      // offers an auditor a control the server refuses; and the workspace a
      // write's step-up will be bound to, so the page binds its challenge to
      // the same one (null: no workspace to step up in — writes are refused).
      const viewerCanManage = ORG_DOMAIN_WRITE_ROLES.includes(access.role);
      const stepUpWorkspaceId = viewerCanManage
        ? await resolveStepUpWorkspace(orgId, userId)
        : null;

      return reply.code(200).send({
        viewerCanManage,
        stepUpWorkspaceId,
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
        roles: ORG_DOMAIN_WRITE_ROLES,
      });
      if (access.kind !== "ok") {
        const denial = orgAccessDenial(access);
        return reply.code(denial.status).send(denial.body);
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

      const teamId = await resolveStepUpWorkspace(orgId, userId);
      if (!teamId) throw stepUpWorkspaceRequired();
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
