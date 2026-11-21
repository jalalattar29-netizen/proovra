/**
 * NEW-RG-11-3 (owner decision D, 2026-11-21) — the organization download-audit
 * export lists record-level rows only for records the caller can reach.
 *
 * Real routes, real PostgreSQL. An ORG_AUDITOR is admitted to the export by the
 * organization oversight role; the rows that name a record (evidence id, actor,
 * workspace, time) follow canonical workspace membership and record/case reach
 * — the rule `GET /v1/audit/tenant` applies (PRO-BLZ-01). Organization-wide
 * volume comes from the separate aggregate export, which names no record.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";

type Prisma = import("@prisma/client").PrismaClient;

describe("NEW-RG-11-3 — org download-audit export respects record reach (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let emitTenantAudit: typeof import("../src/services/audit/tenant-audit.service.js").emitTenantAudit;

  let orgId: string;
  let teamId: string;
  let openEvidenceId: string;
  let closedEvidenceId: string;
  let restrictedCaseId: string;
  let otherTenantEvidenceId: string;
  let downloaderId: string;
  let auditor: Person;

  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;
  const exportUrl = () => `/v1/orgs/${orgId}/reports/download-audit.csv`;
  const summaryUrl = () => `/v1/orgs/${orgId}/reports/download-audit-summary.csv`;

  /** toCsv writes RFC-4180 CRLF rows (and may lead with a BOM). */
  const csvLines = (body: string) => body.replace(/^\uFEFF/, "").trim().split(/\r?\n/);

  const scopeHeader = (res: unknown) =>
    (res as { headers: Record<string, string | string[] | undefined> }).headers["x-report-scope"];

  async function download(workspaceId: string, evidenceId: string, actorUserId: string) {
    await emitTenantAudit(
      {
        action: "evidence.report.downloaded",
        outcome: "success",
        sourceApp: "API",
        actorUserId,
        workspaceId,
        resourceType: "evidence",
        resourceId: evidenceId,
      } as never,
      prisma as never,
    );
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    ({ emitTenantAudit } = await import("../src/services/audit/tenant-audit.service.js"));
    kit = await coverageKit(h);

    teamId = A().teamId;
    orgId = (await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } })).organizationId!;
    const ownerId = A().ownerUserId;
    downloaderId = A().memberUserId;

    const mk = (title: string, team: string, org: string, owner: string) =>
      prisma.evidence.create({
        data: { title, type: "PHOTO", status: "CREATED", teamId: team, organizationId: org, ownerUserId: owner },
        select: { id: true },
      });
    openEvidenceId = (await mk(`rg113-open-${randomUUID().slice(0, 6)}`, teamId, orgId, ownerId)).id;
    closedEvidenceId = (await mk(`rg113-closed-${randomUUID().slice(0, 6)}`, teamId, orgId, ownerId)).id;
    restrictedCaseId = (
      await prisma.case.create({
        data: { name: `rg113-restricted-${randomUUID().slice(0, 6)}`, teamId, ownerUserId: ownerId, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      })
    ).id;
    await prisma.caseEvidenceLink.create({
      data: { caseId: restrictedCaseId, evidenceId: closedEvidenceId, teamId, linkedByUserId: ownerId },
    });

    const orgB = (await prisma.team.findUniqueOrThrow({ where: { id: B().teamId }, select: { organizationId: true } })).organizationId!;
    otherTenantEvidenceId = (await mk(`rg113-b-${randomUUID().slice(0, 6)}`, B().teamId, orgB, B().ownerUserId)).id;

    await download(teamId, openEvidenceId, downloaderId);
    await download(teamId, closedEvidenceId, downloaderId);
    await download(teamId, closedEvidenceId, ownerId);
    await download(B().teamId, otherTenantEvidenceId, B().memberUserId);

    // An organization auditor with NO workspace membership.
    auditor = await kit.person(null);
    await prisma.organizationMembership.create({ data: { organizationId: orgId, userId: auditor.id, role: "ORG_AUDITOR" } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("an ORG_AUDITOR without workspace membership or case reach sees no record-level rows", async () => {
    const res = await kit.call("GET", exportUrl(), auditor);
    expect(res.statusCode, res.body).toBe(200);
    expect(scopeHeader(res)).toBe("caller-record-reach");
    expect(res.body).toContain("evidenceId");
    expect(res.body).not.toContain(openEvidenceId);
    expect(res.body).not.toContain(closedEvidenceId);
    expect(res.body).not.toContain(downloaderId);
    expect(csvLines(res.body)).toHaveLength(1); // header only
  });

  it("as a workspace member: the open record's rows appear, the restricted case's record stays hidden", async () => {
    await prisma.teamMember.create({ data: { teamId, userId: auditor.id, role: "VIEWER", status: "ACTIVE" } as never });
    const res = await kit.call("GET", exportUrl(), auditor);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain(openEvidenceId);
    expect(res.body).not.toContain(closedEvidenceId);
  });

  it("with case reach (CaseAccess on the restricted case) the restricted record's rows appear", async () => {
    await prisma.caseAccess.create({ data: { caseId: restrictedCaseId, userId: auditor.id } });
    const res = await kit.call("GET", exportUrl(), auditor);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain(openEvidenceId);
    const closedRows = csvLines(res.body).filter((l) => l.includes(closedEvidenceId));
    expect(closedRows).toHaveLength(2);
    await prisma.caseAccess.deleteMany({ where: { caseId: restrictedCaseId, userId: auditor.id } });
  });

  it("a suspended workspace membership contributes nothing again", async () => {
    await prisma.teamMember.updateMany({ where: { teamId, userId: auditor.id }, data: { status: "SUSPENDED" } as never });
    const res = await kit.call("GET", exportUrl(), auditor);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(openEvidenceId);
    expect(res.body).not.toContain(closedEvidenceId);
    await prisma.teamMember.updateMany({ where: { teamId, userId: auditor.id }, data: { status: "ACTIVE" } as never });
  });

  it("cross-tenant: another organization's owner is refused, and no export carries the other tenant's rows", async () => {
    for (const url of [exportUrl(), summaryUrl()]) {
      const res = await kit.call("GET", url, { token: B().ownerToken });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(404);
      expect(res.body).not.toContain(openEvidenceId);
    }
    // The org A owner (a workspace OWNER, so full reach in A) never sees team B's record.
    const own = await kit.call("GET", exportUrl(), { token: A().ownerToken });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.body).toContain(openEvidenceId);
    expect(own.body).toContain(closedEvidenceId);
    expect(own.body).not.toContain(otherTenantEvidenceId);
    expect(own.body).not.toContain(B().teamId);
  });

  it("the organization-wide aggregate counts every download and identifies no record, actor or event", async () => {
    const res = await kit.call("GET", summaryUrl(), auditor);
    expect(res.statusCode, res.body).toBe(200);
    expect(scopeHeader(res)).toBe("organization-aggregate");
    const lines = csvLines(res.body);
    expect(lines[0]).toBe("dayUtc,workspaceId,workspaceName,action,eventCount");
    const mine = lines.slice(1).filter((l) => l.includes(teamId) && l.includes("evidence.report.downloaded"));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.split(",").at(-1)).toBe("3");
    for (const id of [openEvidenceId, closedEvidenceId, otherTenantEvidenceId, downloaderId, A().ownerUserId, B().teamId]) {
      expect(res.body).not.toContain(id);
    }
    const eventIds = (
      await prisma.adminAuditLog.findMany({ where: { workspaceId: teamId, action: "evidence.report.downloaded" }, select: { id: true } })
    ).map((r) => r.id);
    expect(eventIds.length).toBeGreaterThanOrEqual(3);
    for (const id of eventIds) expect(res.body).not.toContain(id);
  });

  it("the aggregate stays behind the oversight roles (an ORG_MEMBER is refused)", async () => {
    const member = await kit.person(teamId, "MEMBER");
    await prisma.organizationMembership.create({ data: { organizationId: orgId, userId: member.id, role: "ORG_MEMBER" } });
    const res = await kit.call("GET", summaryUrl(), member);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).not.toContain(teamId);
  });
});
