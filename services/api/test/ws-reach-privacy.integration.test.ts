/* eslint-disable @typescript-eslint/no-explicit-any -- test support reads Prisma delegates and JSON bodies of many shapes. */
/**
 * WS-REACH (cdcb8ae remediation) — field privacy, attribution and the reach
 * residuals on sibling reads, on real routes and PostgreSQL. Each refusal has
 * the entitled caller's success beside it.
 *
 *   PRO-C1-08  a per-file note "private to you" is returned only to its author
 *   PRO-E2-03  a manager cannot rewrite another member's comment (DEC-15)
 *   PRO-E2-02  an external submitter's address is masked for record readers
 *   PRO-T1-17  workspace operations alerts follow record reach
 *   PRO-BLZ-01 the tenant audit omits rows about records closed to the reader
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";
import { RowFactory, RowSet, type Tenant } from "./support/write-sweep-engine.js";
import { enterpriseTenantMaker } from "./support/write-sweep-world.js";

describe("WS-REACH privacy and reach residuals (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let audit: typeof import("../src/services/audit/tenant-audit.service.js");
  let kit: CoverageKit;
  let tenant: Tenant;
  let rows: RowSet;
  let off: Person;
  let listed: Person;
  let member: Person;
  let viewer: Person;
  let hiddenEvidence: string;
  const tag = () => randomUUID().slice(0, 8);
  const headers = () => ({ "x-proovra-workspace-id": tenant.teamId });
  const get = (url: string, who: Person | { token: string }) => kit.call("GET", url, who, undefined, headers());
  const send = (method: string, url: string, who: Person | { token: string }, body: unknown = {}) =>
    kit.call(method, url, who, body, headers());
  const make = async (model: string, data: Record<string, unknown>) => {
    const fresh = new RowSet(rows.factory, prisma, tenant);
    const id = await rows.factory.make(fresh, model);
    if (!id) throw new Error(`fixture ${model}: ${rows.factory.failures.get(model)}`);
    const accessor = (prisma as any)[model.charAt(0).toLowerCase() + model.slice(1)];
    await accessor.update({ where: { id }, data });
    return id;
  };
  const record = async (ownerUserId: string, extra: Record<string, unknown> = {}) =>
    (
      await prisma.evidence.create({
        data: {
          title: `rec-${tag()}`,
          displayFileName: `rec-${tag()}.pdf`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: tenant.teamId,
          organizationId: tenant.orgId,
          ownerUserId,
          sizeBytes: 1_000n,
          ...extra,
        } as never,
        select: { id: true },
      })
    ).id;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    audit = await import("../src/services/audit/tenant-audit.service.js");
    kit = await coverageKit(h);
    tenant = await (await enterpriseTenantMaker(h))();
    rows = new RowSet(new RowFactory(prisma), prisma, tenant);
    off = await kit.person(tenant.teamId, "OWNER");
    listed = await kit.person(tenant.teamId, "OWNER");
    member = await kit.person(tenant.teamId, "MEMBER");
    viewer = await kit.person(tenant.teamId, "VIEWER");

    const restricted = (
      await prisma.case.create({
        data: { name: `ws-reach ${tag()}`, teamId: tenant.teamId, ownerUserId: listed.id, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      })
    ).id;
    await prisma.caseAccess.create({ data: { caseId: restricted, userId: listed.id } });
    hiddenEvidence = await record(listed.id);
    await prisma.caseEvidenceLink.create({
      data: { caseId: restricted, evidenceId: hiddenEvidence, teamId: tenant.teamId } as never,
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("PRO-C1-08 — the per-file private note is returned to its author only", async () => {
    const ev = await record(member.id);
    const partId = await make("EvidencePart", {
      evidenceId: ev,
      uploadedByUserId: member.id,
      privateNote: "candid-sentinel-note",
      privateRole: "sentinel-role",
    });
    const mine = await get(`/v1/evidence/${ev}/parts`, member);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.body).toContain("candid-sentinel-note");
    const theirs = await get(`/v1/evidence/${ev}/parts`, viewer);
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(theirs.body).toContain(partId);
    expect(theirs.body).not.toContain("candid-sentinel-note");
    expect(theirs.body).not.toContain("sentinel-role");
  });

  it("PRO-E2-03 — a manager cannot rewrite another member's comment; the author can", async () => {
    const ev = await record(member.id);
    const posted = await send("POST", `/v1/evidence/${ev}/comments`, member, { body: "original words", visibility: "INTERNAL" });
    expect(posted.statusCode, posted.body).toBe(201);
    const commentId = posted.json().comment.id as string;
    const refused = await send("PATCH", `/v1/evidence/${ev}/comments/${commentId}`, tenant.owner, { body: "words never written" });
    expect(refused.statusCode, refused.body).toBe(403);
    const row = await prisma.evidenceReviewerComment.findUniqueOrThrow({ where: { id: commentId } });
    expect(row.body).toBe("original words");
    const own = await send("PATCH", `/v1/evidence/${ev}/comments/${commentId}`, member, { body: "my own edit" });
    expect(own.statusCode, own.body).toBe(200);
  });

  it("PRO-E2-02 — an external submitter's address is masked for a record reader", async () => {
    const address = `ext-submitter-${tag()}@example.test`;
    const ev = await record(tenant.owner.id, { acquisitionMode: "SECURE_INTAKE_LINK", acquisitionModeSource: "RECORDED_AT_CREATION", submittedByEmail: address });
    const res = await get(`/v1/evidence/${ev}`, viewer);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(address);
  });

  it("PRO-T1-17 — operations alerts leave out an incident about a closed record", async () => {
    const incident = await make("OperationalIncident", {
      teamId: tenant.teamId,
      relatedEvidenceId: hiddenEvidence,
      status: "OPEN",
      severity: "CRITICAL",
    });
    const mine = await get(`/v1/teams/${tenant.teamId}/operations/alerts`, listed);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.body).toContain(incident);
    const theirs = await get(`/v1/teams/${tenant.teamId}/operations/alerts`, off);
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(theirs.body).not.toContain(incident);
  });

  it("PRO-BLZ-01 — the tenant audit omits a row about a closed record", async () => {
    await audit.emitTenantAudit({
      action: "evidence.sentinel_action",
      outcome: "success",
      sourceApp: "API",
      actorUserId: listed.id,
      workspaceId: tenant.teamId,
      resourceType: "evidence",
      resourceId: hiddenEvidence,
      metadata: {},
    } as never);
    const url = `/v1/audit/tenant?teamId=${tenant.teamId}&action=evidence.sentinel_action`;
    const mine = await get(url, listed);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.body).toContain(hiddenEvidence);
    const theirs = await get(url, off);
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(theirs.body).not.toContain(hiddenEvidence);
  });
});
