/**
 * Phase 8 (Enterprise Production Readiness) — SCOPE C.
 * Enterprise OPERATIONAL reports: CSV exports over EXISTING real data.
 *
 * This plugin EXPOSES data the platform already owns as downloadable
 * CSV. It re-uses the underlying queries/models the canonical read
 * endpoints use — it does NOT re-implement data logic, and it does NOT
 * fabricate anything. Where a data source does not exist at the org
 * tier, the endpoint returns an HONEST "not available" CSV (a single
 * note row) rather than a 500 or an invented dataset.
 *
 * It is deliberately DISTINCT from the evidence report/verification-
 * package PDF pipeline: nothing here touches hashing, signing, TSA,
 * OTS, custody, or verification-package internals.
 *
 * Endpoints (each org-role gated; the backend is the authoritative gate):
 *   GET /v1/orgs/:id/reports/members.csv         (ORG_AUDITOR+)
 *   GET /v1/orgs/:id/reports/seats.csv           (ORG_BILLING_ADMIN+)
 *   GET /v1/orgs/:id/reports/audit.csv           (ORG_AUDITOR+)
 *   GET /v1/orgs/:id/reports/governance.csv      (ORG_AUDITOR+)
 *   GET /v1/orgs/:id/reports/external-access.csv (ORG_AUDITOR+)
 *   GET /v1/orgs/:id/reports/download-audit.csv  (ORG_AUDITOR+)
 *
 * Every successful export emits an ORG_REPORT_EXPORTED org-audit event
 * (report name + row count only — never the report body).
 *
 * Anti-enumeration: a non-member (or insufficient role) gets 404 for
 * both "org doesn't exist" and "forbidden", mirroring the sibling org
 * governance routes.
 *
 * NOTE ON THE P5-B DOWNLOAD AUDIT (CONNECT vs. honest-unavailable):
 *   The Phase 5 evidence-download defensibility audit writes distinct
 *   queryable actions (evidence.report.downloaded /
 *   evidence.verification_package.downloaded / evidence.original.downloaded)
 *   into the PLATFORM AdminAuditLog (category "evidence"), scoped to a
 *   user + evidence id — NOT to an organization. There is no org-tier
 *   mapping from those platform rows back to a single org's workspaces,
 *   so this org-scoped report cannot honestly attribute platform
 *   download events to one org without fabricating that linkage. We
 *   therefore return an HONEST "not available at the org tier" CSV and
 *   document where the real data lives (platform audit-log export).
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { getAuthUserId } from "../auth.js";
import { checkOrgAccess } from "../services/organization/org-access.js";
import type { OrgRole } from "../services/organization/organization-resolver.service.js";
import { emitOrgAuditEvent } from "../services/organization/org-audit.service.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import {
  toCsv,
  csvDownloadHeaders,
  type CsvColumn,
} from "../services/reporting/csv-export.js";

const UuidParam = z.string().uuid();

// The audit-report row cap. Beyond this we truncate + set a header note
// so the export never becomes an unbounded query / download.
const AUDIT_ROW_CAP = 5000;

/**
 * Resolve org access at `minRole`, returning the caller role on success
 * or a bounded, anti-enumeration 404 payload on any non-OK outcome.
 * Mirrors `requireOrgAdmin` in organizations-governance.routes.ts.
 */
async function requireOrgRole(
  orgId: string,
  userId: string,
  minRole: OrgRole,
): Promise<{ ok: true; role: OrgRole } | { ok: false; code: number }> {
  const result = await checkOrgAccess(prisma, { orgId, userId, minRole });
  if (result.kind !== "ok") return { ok: false, code: 404 };
  return { ok: true, role: result.role };
}

/**
 * Per-export rate limit. Reuses the shared limiter; keyed per
 * (user, report). Generous — these are operator-driven downloads.
 */
async function reportRateLimit(
  userId: string,
  report: string,
): Promise<boolean> {
  const rate = await enforceRateLimit({
    key: `ratelimit:org_report_export:${report}:${userId}`,
    max: 60,
    windowSec: 60,
  });
  return rate.allowed;
}

/**
 * Emit the ORG_REPORT_EXPORTED audit event (best-effort with respect to
 * the response — the audit write runs inside its own tx and is awaited,
 * consistent with the sibling governance routes' emitOrgAuditEvent use).
 */
async function auditExport(
  orgId: string,
  userId: string,
  report: string,
  rowCount: number,
  extra?: Record<string, unknown>,
): Promise<void> {
  await emitOrgAuditEvent(prisma, {
    organizationId: orgId,
    actorUserId: userId,
    eventType: "ORG_REPORT_EXPORTED",
    targetType: "organization",
    targetId: orgId,
    metadata: { report, rowCount, ...(extra ?? {}) },
  });
}

/** Standard CSV reply. */
function sendCsv(reply: FastifyReply, filename: string, body: string): FastifyReply {
  const headers = csvDownloadHeaders(filename);
  return reply
    .header("content-type", headers["content-type"])
    .header("content-disposition", headers["content-disposition"])
    .send(body);
}

const RATE_LIMITED = { message: "Too many report exports. Try again shortly." };
const NOT_FOUND = { message: "Organization not found", code: "org_not_found" };

export async function organizationsReportsRoutes(app: FastifyInstance) {
  const preHandler = [requireAuth, requireLegalAcceptance];

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id/reports/members.csv  (ORG_AUDITOR+)
  //
  // Reuses the EXACT query behind GET /v1/orgs/:id/members
  // (organizations.routes.ts:405-415) — membership id, user id, email,
  // display name, role, memberSince. No evidence/case/workspace data.
  // -------------------------------------------------------------------------
  app.get("/v1/orgs/:id/reports/members.csv", { preHandler }, async (req, reply) => {
    const orgId = UuidParam.parse((req.params as { id: string }).id);
    const userId = getAuthUserId(req);

    const access = await requireOrgRole(orgId, userId, "ORG_AUDITOR");
    if (!access.ok) return reply.code(access.code).send(NOT_FOUND);
    if (!(await reportRateLimit(userId, "members"))) {
      return reply.code(429).send(RATE_LIMITED);
    }

    // ARCH-004 — a GOVERNANCE EXPORT deliberately includes suspended and
    // revoked memberships: an auditor asking "who had access and when did it
    // end?" is asking precisely about the rows an ACTIVE filter would hide.
    // The status and its timestamps travel with each row so the export states
    // the lifecycle rather than implying everyone listed is current.
    const memberships = await prisma.organizationMembership.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        userId: true,
        role: true,
        createdAt: true,
        status: true,
        statusChangedAtUtc: true,
        revokedAtUtc: true,
        user: { select: { email: true, displayName: true } },
      },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    });

    type Row = (typeof memberships)[number];
    const columns: CsvColumn<Row>[] = [
      { header: "membershipId", value: (m) => m.id },
      { header: "userId", value: (m) => m.userId },
      { header: "email", value: (m) => m.user.email },
      { header: "displayName", value: (m) => m.user.displayName },
      { header: "role", value: (m) => m.role },
      { header: "memberSince", value: (m) => m.createdAt.toISOString() },
      // ARCH-004 — without these three, an export that now INCLUDES suspended
      // and revoked memberships would read as a list of current members, which
      // is a worse answer than the one it replaced.
      { header: "status", value: (m) => m.status },
      {
        header: "statusChangedAtUtc",
        value: (m) =>
          m.statusChangedAtUtc ? m.statusChangedAtUtc.toISOString() : null,
      },
      {
        header: "revokedAtUtc",
        value: (m) => (m.revokedAtUtc ? m.revokedAtUtc.toISOString() : null),
      },
    ];

    const csv = toCsv(memberships, columns);
    await auditExport(orgId, userId, "members", memberships.length);
    return sendCsv(reply, "org-members.csv", csv);
  });

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id/reports/seats.csv  (ORG_BILLING_ADMIN+)
  //
  // Reuses the billing-rollup query behind GET /v1/orgs/:id/billing/rollup
  // (organizations-governance.routes.ts:299-314) — per-workspace plan /
  // status / included vs. used seats / over-seat. COUNTS ONLY. NEVER a
  // Stripe subscription id, customer id, or payment instrument.
  // -------------------------------------------------------------------------
  app.get("/v1/orgs/:id/reports/seats.csv", { preHandler }, async (req, reply) => {
    const orgId = UuidParam.parse((req.params as { id: string }).id);
    const userId = getAuthUserId(req);

    const access = await requireOrgRole(orgId, userId, "ORG_BILLING_ADMIN");
    if (!access.ok) return reply.code(access.code).send(NOT_FOUND);
    if (!(await reportRateLimit(userId, "seats"))) {
      return reply.code(429).send(RATE_LIMITED);
    }

    const workspaces = await prisma.team.findMany({
      where: { organizationId: orgId, isPersonal: false },
      select: {
        id: true,
        name: true,
        billingPlan: true,
        billingStatus: true,
        includedSeats: true,
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    type Row = (typeof workspaces)[number];
    const columns: CsvColumn<Row>[] = [
      { header: "workspaceId", value: (w) => w.id },
      { header: "workspaceName", value: (w) => w.name },
      { header: "billingPlan", value: (w) => w.billingPlan ?? "FREE" },
      { header: "billingStatus", value: (w) => w.billingStatus ?? "NONE" },
      { header: "includedSeats", value: (w) => w.includedSeats ?? 0 },
      { header: "usedSeats", value: (w) => w._count.members },
      {
        header: "overSeat",
        value: (w) =>
          (w.includedSeats ?? 0) > 0 && w._count.members > (w.includedSeats ?? 0),
      },
    ];

    const csv = toCsv(workspaces, columns);
    await auditExport(orgId, userId, "seats", workspaces.length);
    return sendCsv(reply, "org-seats.csv", csv);
  });

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id/reports/audit.csv  (ORG_AUDITOR+)
  //
  // Reuses the org audit-event query behind GET /v1/orgs/:id/audit-events
  // (organizations.routes.ts:1590-1611). Supports ?eventType=A,B and a
  // bounded row cap (AUDIT_ROW_CAP). When capped, a truncation note is
  // returned via the X-Report-Truncated header + recorded in the audit
  // metadata (honest signalling — no silent data loss).
  // -------------------------------------------------------------------------
  app.get("/v1/orgs/:id/reports/audit.csv", { preHandler }, async (req, reply) => {
    const orgId = UuidParam.parse((req.params as { id: string }).id);
    const userId = getAuthUserId(req);

    const q = z
      .object({ eventType: z.string().optional() })
      .parse(req.query);
    const eventTypeFilter = q.eventType
      ? q.eventType
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : null;

    const access = await requireOrgRole(orgId, userId, "ORG_AUDITOR");
    if (!access.ok) return reply.code(access.code).send(NOT_FOUND);
    if (!(await reportRateLimit(userId, "audit"))) {
      return reply.code(429).send(RATE_LIMITED);
    }

    // Fetch one past the cap so we can detect truncation honestly.
    const events = await prisma.organizationAuditEvent.findMany({
      where: {
        organizationId: orgId,
        ...(eventTypeFilter && eventTypeFilter.length > 0
          ? { eventType: { in: eventTypeFilter } }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: AUDIT_ROW_CAP + 1,
      select: {
        id: true,
        actorUserId: true,
        eventType: true,
        targetType: true,
        targetId: true,
        metadata: true,
        createdAt: true,
      },
    });

    const truncated = events.length > AUDIT_ROW_CAP;
    const rows = truncated ? events.slice(0, AUDIT_ROW_CAP) : events;

    // Denormalize actor identity for operator-readable display (same
    // enrichment the /audit-events endpoint performs).
    const actorIds = Array.from(
      new Set(rows.map((e) => e.actorUserId).filter((x): x is string => !!x)),
    );
    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, email: true, displayName: true },
        })
      : [];
    const actorById = new Map(actors.map((a) => [a.id, a]));

    type Row = (typeof rows)[number];
    const columns: CsvColumn<Row>[] = [
      { header: "createdAt", value: (e) => e.createdAt.toISOString() },
      { header: "eventType", value: (e) => e.eventType },
      { header: "actorUserId", value: (e) => e.actorUserId },
      {
        header: "actorEmail",
        value: (e) => (e.actorUserId ? actorById.get(e.actorUserId)?.email ?? null : null),
      },
      {
        header: "actorDisplayName",
        value: (e) =>
          e.actorUserId ? actorById.get(e.actorUserId)?.displayName ?? null : null,
      },
      { header: "targetType", value: (e) => e.targetType },
      { header: "targetId", value: (e) => e.targetId },
      {
        header: "metadata",
        value: (e) => (e.metadata == null ? "" : JSON.stringify(e.metadata)),
      },
    ];

    const csv = toCsv(rows, columns);
    await auditExport(orgId, userId, "audit", rows.length, {
      eventType: eventTypeFilter,
      truncated,
      ...(truncated ? { rowCap: AUDIT_ROW_CAP } : {}),
    });

    if (truncated) {
      reply.header("x-report-truncated", "true");
      reply.header("x-report-row-cap", String(AUDIT_ROW_CAP));
    }
    return sendCsv(reply, "org-audit.csv", csv);
  });

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id/reports/governance.csv  (ORG_AUDITOR+)
  //
  // Reuses the retention-policy read behind GET /v1/orgs/:id/policies/retention
  // (organizations-governance.routes.ts:224-245) plus governance-posture
  // summary rows (workspace count, published retention default). Rendered
  // as key/value posture rows so an auditor gets a single governance
  // snapshot CSV. Honest nulls where a policy has never been published.
  // -------------------------------------------------------------------------
  app.get("/v1/orgs/:id/reports/governance.csv", { preHandler }, async (req, reply) => {
    const orgId = UuidParam.parse((req.params as { id: string }).id);
    const userId = getAuthUserId(req);

    const access = await requireOrgRole(orgId, userId, "ORG_AUDITOR");
    if (!access.ok) return reply.code(access.code).send(NOT_FOUND);
    if (!(await reportRateLimit(userId, "governance"))) {
      return reply.code(429).send(RATE_LIMITED);
    }

    const policy = await prisma.organizationPolicy.findUnique({
      where: {
        organization_policies_org_key_uniq: {
          organizationId: orgId,
          key: "retention.default",
        },
      },
      select: { value: true, updatedAt: true, lastUpdatedByUserId: true },
    });
    const workspaceCount = await prisma.team.count({
      where: { organizationId: orgId, isPersonal: false },
    });

    // Read the retention template fields honestly — null where unpublished.
    const value =
      policy?.value && typeof policy.value === "object"
        ? (policy.value as Record<string, unknown>)
        : null;
    const retentionDays = value ? (value.retentionDays ?? null) : null;
    const immutable = value ? (value.immutable ?? null) : null;
    const description = value ? (value.description ?? null) : null;

    // Posture rows: (metric, value). A value of "" is an HONEST
    // "not published / not available" — never fabricated.
    const rows: Array<{ metric: string; value: unknown }> = [
      { metric: "organizationId", value: orgId },
      { metric: "nonPersonalWorkspaceCount", value: workspaceCount },
      {
        metric: "retentionPolicyPublished",
        value: policy ? "true" : "false",
      },
      { metric: "retentionDefaultDays", value: retentionDays },
      { metric: "retentionImmutable", value: immutable },
      { metric: "retentionDescription", value: description },
      {
        metric: "retentionLastUpdatedAt",
        value: policy?.updatedAt ? policy.updatedAt.toISOString() : null,
      },
      {
        metric: "retentionLastUpdatedByUserId",
        value: policy?.lastUpdatedByUserId ?? null,
      },
    ];

    const columns: CsvColumn<(typeof rows)[number]>[] = [
      { header: "metric", value: (r) => r.metric },
      { header: "value", value: (r) => r.value },
    ];

    const csv = toCsv(rows, columns);
    await auditExport(orgId, userId, "governance", rows.length);
    return sendCsv(reply, "org-governance.csv", csv);
  });

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id/reports/external-access.csv  (ORG_AUDITOR+)
  //
  // Who was granted EXTERNAL reviewer access across the org's workspaces.
  // ExternalReviewerRoleAssignment is TEAM-scoped, so we resolve the org's
  // non-personal workspaces first, then read grants for those teams. State,
  // role, expiry, revoked, and an access-activity count per grant. NEVER
  // exposes raw tokens / token hashes / SSO subject hashes.
  // -------------------------------------------------------------------------
  app.get(
    "/v1/orgs/:id/reports/external-access.csv",
    { preHandler },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const access = await requireOrgRole(orgId, userId, "ORG_AUDITOR");
      if (!access.ok) return reply.code(access.code).send(NOT_FOUND);
      if (!(await reportRateLimit(userId, "external-access"))) {
        return reply.code(429).send(RATE_LIMITED);
      }

      const teams = await prisma.team.findMany({
        where: { organizationId: orgId, isPersonal: false },
        select: { id: true, name: true },
      });
      const teamById = new Map(teams.map((t) => [t.id, t.name]));
      const teamIds = teams.map((t) => t.id);

      /**
       * PHASE 12 CORRECTIVE PASS §2 (INV-001, 2026-08-06) — THE LIFECYCLE
       * COMES FROM THE GRANT, NOT FROM THE SIDECAR.
       *
       * This export used to read `grantState`, `expiresAtUtc` and
       * `revokedAtUtc` off `ExternalReviewerRoleAssignment`. Those columns
       * were added by a model catch-up migration and NO writer has ever
       * populated them: `grant_state` is NOT NULL DEFAULT 'PENDING' and the
       * other two are always NULL. So this compliance export reported every
       * external-review grant as PENDING, never expiring and never revoked —
       * including grants that were ACTIVE, EXPIRED or REVOKED. An auditor
       * reading it was told the opposite of the truth.
       *
       * `ExternalReviewGrant` is the sole lifecycle authority. The two rows
       * share one id by construction (`issueInvitation` creates the sidecar
       * with `id` set to the grant's id), so the join is on `id`.
       */
      const assignments =
        teamIds.length === 0
          ? []
          : await prisma.externalReviewerRoleAssignment.findMany({
              where: { teamId: { in: teamIds } },
              select: {
                id: true,
                teamId: true,
                evidenceId: true,
                externalEmail: true,
                inviteEmail: true,
                role: true,
                authMethod: true,
                inviteAcceptedAtUtc: true,
                grantedByUserId: true,
                createdAt: true,
                _count: { select: { activities: true } },
              },
              orderBy: { createdAt: "desc" },
              take: AUDIT_ROW_CAP,
            });

      const lifecycleById = new Map(
        (assignments.length === 0
          ? []
          : await prisma.externalReviewGrant.findMany({
              where: { id: { in: assignments.map((a) => a.id) } },
              select: {
                id: true,
                state: true,
                expiresAtUtc: true,
                revokedAtUtc: true,
                acceptedAtUtc: true,
              },
            })
        ).map((g) => [g.id, g] as const),
      );

      const grants = assignments.map((a) => {
        const lifecycle = lifecycleById.get(a.id) ?? null;
        return {
          ...a,
          // A sidecar with no grant is an orphan the contract migration
          // forbids. Until that constraint is applied everywhere, report the
          // absence honestly rather than substituting a default that reads
          // like a real state.
          grantState: lifecycle?.state ?? "UNKNOWN_NO_GRANT",
          expiresAtUtc: lifecycle?.expiresAtUtc ?? null,
          revokedAtUtc: lifecycle?.revokedAtUtc ?? null,
          // Acceptance is the grant's fact too; the sidecar's stamp is the
          // console's convenience copy and is used only as a fallback.
          inviteAcceptedAtUtc:
            lifecycle?.acceptedAtUtc ?? a.inviteAcceptedAtUtc ?? null,
        };
      });

      type Row = (typeof grants)[number];
      const columns: CsvColumn<Row>[] = [
        { header: "grantId", value: (g) => g.id },
        { header: "workspaceId", value: (g) => g.teamId },
        { header: "workspaceName", value: (g) => teamById.get(g.teamId) ?? null },
        { header: "evidenceId", value: (g) => g.evidenceId },
        {
          header: "externalEmail",
          value: (g) => g.externalEmail ?? g.inviteEmail ?? null,
        },
        { header: "role", value: (g) => g.role },
        { header: "grantState", value: (g) => g.grantState },
        { header: "authMethod", value: (g) => g.authMethod },
        {
          header: "expiresAtUtc",
          value: (g) => (g.expiresAtUtc ? g.expiresAtUtc.toISOString() : null),
        },
        {
          header: "revokedAtUtc",
          value: (g) => (g.revokedAtUtc ? g.revokedAtUtc.toISOString() : null),
        },
        {
          header: "inviteAcceptedAtUtc",
          value: (g) =>
            g.inviteAcceptedAtUtc ? g.inviteAcceptedAtUtc.toISOString() : null,
        },
        { header: "grantedByUserId", value: (g) => g.grantedByUserId },
        { header: "accessActivityCount", value: (g) => g._count.activities },
        { header: "createdAt", value: (g) => g.createdAt.toISOString() },
      ];

      const csv = toCsv(grants, columns);
      await auditExport(orgId, userId, "external-access", grants.length);
      return sendCsv(reply, "org-external-access.csv", csv);
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id/reports/download-audit.csv  (ORG_AUDITOR+)
  //
  // HONEST-UNAVAILABLE. The Phase 5 (P5-B) evidence-download audit exists,
  // but it lives in the PLATFORM AdminAuditLog (category "evidence") scoped
  // to user + evidence id — there is NO org-tier attribution from those
  // rows back to a single org's workspaces. Rather than fabricate that
  // linkage, we return 200 with a single documented "not available at the
  // org tier" note row and point the operator at the real source. This is
  // intentionally NOT a 500 and NOT an empty/fake dataset.
  // -------------------------------------------------------------------------
  app.get(
    "/v1/orgs/:id/reports/download-audit.csv",
    { preHandler },
    async (req, reply) => {
      const orgId = UuidParam.parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const access = await requireOrgRole(orgId, userId, "ORG_AUDITOR");
      if (!access.ok) return reply.code(access.code).send(NOT_FOUND);
      if (!(await reportRateLimit(userId, "download-audit"))) {
        return reply.code(429).send(RATE_LIMITED);
      }

      const rows = [
        {
          status: "not_available_at_org_tier",
          note:
            "Evidence report/package/original download events are recorded in the platform audit log (category=evidence), scoped to user + evidence id. They are not attributed to an organization, so an org-scoped download-audit report is not available. Query the platform audit log (GET /v1/admin/audit-log) for the raw download events.",
        },
      ];
      const columns: CsvColumn<(typeof rows)[number]>[] = [
        { header: "status", value: (r) => r.status },
        { header: "note", value: (r) => r.note },
      ];

      const csv = toCsv(rows, columns);
      // Signal unavailability honestly via a header + audit metadata; the
      // body itself is a documented note, not fabricated data.
      reply.header("x-report-available", "false");
      await auditExport(orgId, userId, "download-audit", 0, {
        available: false,
      });
      return sendCsv(reply, "org-download-audit.csv", csv);
    },
  );
}
