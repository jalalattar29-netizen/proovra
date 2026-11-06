/**
 * GOV-015 — the organization owner's offboarding data export.
 *
 *   GET  /v1/orgs/:id/data-export                       request history
 *   POST /v1/orgs/:id/data-export                       request an export (step-up;
 *                                                       one active request per org)
 *   POST /v1/orgs/:id/data-export/:requestId/manifest   the manifest (step-up)
 *   POST /v1/orgs/:id/data-export/:requestId/links      a page of sealed-version
 *                                                       download links (step-up)
 *
 * ORG_OWNER only: the return of an organization's data is the owner's act under
 * the DPA. A non-member gets 404, a member without the role 403 (checkOrgAccess).
 * Proof travels in the POST body, never in a query string.
 *
 * TENANT_SCOPE_EXCEPTION: organization_tier — every query is keyed by the path's
 * organization id after checkOrgAccess.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { AppError, ErrorCode } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import {
  verifyAccountStepUp,
  type AccountStepUpProof,
} from "../services/identity-security/account-step-up.service.js";
import { checkOrgAccess, orgAccessDenial } from "../services/organization/org-access.js";
import {
  issueOrganizationExportLinks,
  type OrganizationExportPackage,
} from "../services/organization/organization-data-export.service.js";

const OrgParams = z.object({ id: z.string().uuid() });
const RequestParams = z.object({ id: z.string().uuid(), requestId: z.string().uuid() });
const ProofBody = z.object({ stepUp: z.unknown().optional() }).passthrough();
const LinksBody = z.object({ stepUp: z.unknown().optional(), offset: z.number().int().min(0).optional() });

async function ownerOrDeny(req: FastifyRequest, reply: FastifyReply, orgId: string): Promise<string | null> {
  const userId = getAuthUserId(req);
  if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
  const access = await checkOrgAccess(prisma, { orgId, userId, roles: ["ORG_OWNER"] });
  if (access.kind !== "ok") {
    const d = orgAccessDenial(access);
    reply.code(d.status).send(d.body);
    return null;
  }
  return userId;
}

async function readyExport(orgId: string, requestId: string) {
  const row = await prisma.organizationDataExportRequest.findFirst({
    where: { id: requestId, organizationId: orgId },
    select: { id: true, status: true, expiresAtUtc: true, manifestJson: true, manifestSha256: true },
  });
  if (!row) return { kind: "not_found" as const };
  if (row.status !== "READY" || !row.manifestJson || (row.expiresAtUtc && row.expiresAtUtc.getTime() < Date.now())) {
    return { kind: "not_ready" as const };
  }
  return { kind: "ok" as const, row, pkg: JSON.parse(row.manifestJson) as OrganizationExportPackage };
}

export async function organizationDataExportRoutes(app: FastifyInstance) {
  app.get("/v1/orgs/:id/data-export", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = OrgParams.parse(req.params);
    if (!(await ownerOrDeny(req, reply, id))) return reply;
    const requests = await prisma.organizationDataExportRequest.findMany({
      where: { organizationId: id },
      select: {
        id: true,
        status: true,
        requestedAtUtc: true,
        completedAtUtc: true,
        expiresAtUtc: true,
        failureCode: true,
        manifestSha256: true,
        recordCount: true,
        objectCount: true,
        heldRecordCount: true,
        missingObjectCount: true,
        downloadCount: true,
      },
      orderBy: { requestedAtUtc: "desc" },
      take: 10,
    });
    return { requests };
  });

  app.post("/v1/orgs/:id/data-export", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = OrgParams.parse(req.params);
    const userId = await ownerOrDeny(req, reply, id);
    if (!userId) return reply;
    const body = ProofBody.parse(req.body ?? {});
    const stepUp = await verifyAccountStepUp({
      req,
      reply,
      userId,
      action: "org_data_export_request",
      proof: body.stepUp as AccountStepUpProof | undefined,
    });
    if (!stepUp.ok) return reply.code(stepUp.denial.status).send(stepUp.denial.body);
    const active = await prisma.organizationDataExportRequest.findFirst({
      where: { organizationId: id, status: { in: ["REQUESTED", "PROCESSING", "READY"] } },
      select: { id: true },
    });
    if (active) {
      return reply.code(409).send({
        error: {
          code: "export_request_active",
          message: "An export is already requested or ready. Download it or wait for it to expire before requesting another.",
        },
      });
    }
    const created = await prisma.organizationDataExportRequest.create({
      data: { organizationId: id, requestedByUserId: userId, status: "REQUESTED" },
      select: { id: true, status: true, requestedAtUtc: true },
    });
    await emitPlatformAudit({
      action: "organization.data_export_requested",
      outcome: "success",
      sourceApp: "API",
      actorUserId: userId,
      resourceType: "organization_data_export_request",
      resourceId: created.id,
      correlationId: req.id,
      metadata: { organizationId: id },
    }).catch(() => null);
    return reply.code(201).send({ request: created });
  });

  app.post("/v1/orgs/:id/data-export/:requestId/manifest", { preHandler: requireAuth }, async (req, reply) => {
    const { id, requestId } = RequestParams.parse(req.params);
    const userId = await ownerOrDeny(req, reply, id);
    if (!userId) return reply;
    const body = ProofBody.parse(req.body ?? {});
    const stepUp = await verifyAccountStepUp({
      req,
      reply,
      userId,
      action: "org_data_export_download",
      proof: body.stepUp as AccountStepUpProof | undefined,
    });
    if (!stepUp.ok) return reply.code(stepUp.denial.status).send(stepUp.denial.body);
    const found = await readyExport(id, requestId);
    if (found.kind === "not_found") return reply.code(404).send({ error: { code: "export_not_found" } });
    if (found.kind === "not_ready") {
      return reply.code(409).send({ error: { code: "export_not_ready", message: "This export is not available for download." } });
    }
    await prisma.organizationDataExportRequest.update({
      where: { id: found.row.id },
      data: { downloadCount: { increment: 1 }, lastDownloadedAtUtc: new Date() },
    });
    await emitPlatformAudit({
      action: "organization.data_export_downloaded",
      outcome: "success",
      sourceApp: "API",
      actorUserId: userId,
      resourceType: "organization_data_export_request",
      resourceId: found.row.id,
      correlationId: req.id,
      metadata: { organizationId: id, sha256: found.row.manifestSha256 },
    }).catch(() => null);
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="proovra-organization-export-${found.row.id}.json"`);
    reply.header("x-package-sha256", found.row.manifestSha256 ?? "");
    return reply.code(200).send(found.row.manifestJson);
  });

  app.post("/v1/orgs/:id/data-export/:requestId/links", { preHandler: requireAuth }, async (req, reply) => {
    const { id, requestId } = RequestParams.parse(req.params);
    const userId = await ownerOrDeny(req, reply, id);
    if (!userId) return reply;
    const body = LinksBody.parse(req.body ?? {});
    const stepUp = await verifyAccountStepUp({
      req,
      reply,
      userId,
      action: "org_data_export_download",
      proof: body.stepUp as AccountStepUpProof | undefined,
    });
    if (!stepUp.ok) return reply.code(stepUp.denial.status).send(stepUp.denial.body);
    const found = await readyExport(id, requestId);
    if (found.kind === "not_found") return reply.code(404).send({ error: { code: "export_not_found" } });
    if (found.kind === "not_ready") {
      return reply.code(409).send({ error: { code: "export_not_ready", message: "This export is not available for download." } });
    }
    const page = await issueOrganizationExportLinks({
      manifest: found.pkg.manifest,
      exportId: found.row.id,
      actorUserId: userId,
      offset: body.offset ?? 0,
    });
    await emitPlatformAudit({
      action: "organization.data_export_links_issued",
      outcome: "success",
      sourceApp: "API",
      actorUserId: userId,
      resourceType: "organization_data_export_request",
      resourceId: found.row.id,
      correlationId: req.id,
      metadata: { organizationId: id, offset: body.offset ?? 0, issued: page.links.length },
    }).catch(() => null);
    return reply.code(200).send(page);
  });
}
