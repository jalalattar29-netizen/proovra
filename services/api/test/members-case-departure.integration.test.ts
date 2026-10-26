/**
 * RE-AUDIT DEFECT 6 — A RESTRICTED CASE STAYS RESTRICTED WHEN ITS LAST NAMED
 * MEMBER LEAVES.
 *
 * Ending a member's standing reach deletes their case-access rows. While
 * "restricted" meant only "has at least one access row", the departure of a
 * case's ONLY named member emptied its list and opened the case — and its
 * evidence — to every member of the workspace, viewers included. Restriction
 * is now a property of the case (cases.restricted_at_utc): a grant sets it, a
 * departure leaves it, and only a manager removing the last entry through the
 * case-access routes lifts it. Real routes and the canonical member-lifecycle
 * writers, against a real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { readZipEntries } from "./point5/_zip-entries.js";

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations/20281026000800_case_restriction_flag/migration.sql",
);

describe("re-audit defect 6 — departure never opens a restricted case (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let evidenceAccess: typeof import("../src/services/evidence/evidence-record-access.service.js");
  const W = () => h.fixtures.personal;
  const owner = () => W().userId;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    ({ signJwt } = await import("../src/services/jwt.js"));
    rbac = await import("../src/services/identity/rbac.service.js");
    evidenceAccess = await import("../src/services/evidence/evidence-record-access.service.js");
    await prisma.entitlement.updateMany({ where: { userId: owner() }, data: { active: false } });
    await prisma.entitlement.create({ data: { userId: owner(), plan: "TEAM", active: true, credits: 0 } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function person(role: "MEMBER" | "VIEWER" = "MEMBER") {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `departure-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    const m = await prisma.teamMember.create({ data: { teamId: W().teamId, userId: user.id, role, status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, memberId: m.id, token };
  }

  /** A case with one linked record, restricted to `named` through the real route. */
  async function restrictedCaseFor(named: { id: string }) {
    const c = await prisma.case.create({
      data: { name: `Matter ${tag()}`, teamId: W().teamId, ownerUserId: owner() },
      select: { id: true },
    });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: W().teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: { title: `Record ${tag()}`, type: "PHOTO", status: "CREATED", teamId: W().teamId, organizationId: team.organizationId, ownerUserId: owner() },
      select: { id: true },
    });
    await prisma.caseEvidenceLink.create({ data: { caseId: c.id, evidenceId: ev.id } as never });
    const granted = await h.app.inject({
      method: "POST",
      url: `/v1/cases/${c.id}/access`,
      headers: bearer(W().token),
      payload: { userId: named.id },
    });
    expect([200, 201]).toContain(granted.statusCode);
    return { caseId: c.id, evidenceId: ev.id };
  }

  const view = (caseId: string, token: string) =>
    h.app.inject({ method: "GET", url: `/v1/cases/${caseId}`, headers: bearer(token) });
  const reachesRecord = async (evidenceId: string, userId: string) =>
    (await evidenceAccess.resolveEvidenceRecordAccess({ evidenceId, userId, permission: "evidence.read" }, prisma)).allowed;

  it("granting access flags the case restricted", async () => {
    const named = await person();
    const { caseId } = await restrictedCaseFor(named);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).restrictedAtUtc).not.toBeNull();
  });

  it("REVOKE: the only named member leaves — the case and its record stay closed to everyone else, viewers included", async () => {
    const named = await person();
    const bystander = await person();
    const viewer = await person("VIEWER");
    const { caseId, evidenceId } = await restrictedCaseFor(named);
    expect((await view(caseId, bystander.token)).statusCode).toBe(404);
    // Positive controls: the named member reaches the case and its record, and
    // the record is closed to the bystander — the resolver distinguishes them.
    expect((await view(caseId, named.token)).statusCode).toBe(200);
    expect(await reachesRecord(evidenceId, named.id)).toBe(true);
    expect(await reachesRecord(evidenceId, bystander.id)).toBe(false);

    await rbac.revokeMember({ teamId: W().teamId, teamMemberId: named.memberId, actorUserId: owner(), reason: "left" }, prisma);

    expect(await prisma.caseAccess.count({ where: { caseId } })).toBe(0);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).restrictedAtUtc).not.toBeNull();
    for (const p of [bystander, viewer]) {
      expect((await view(caseId, p.token)).statusCode).toBe(404);
      expect(await reachesRecord(evidenceId, p.id)).toBe(false);
    }
    // The case owner keeps reach, so the case is never orphaned.
    expect((await view(caseId, W().token)).statusCode).toBe(200);
  });

  it("SUSPEND (reversible) does not open the case either", async () => {
    const named = await person();
    const bystander = await person();
    const { caseId, evidenceId } = await restrictedCaseFor(named);
    await rbac.suspendMember({ teamId: W().teamId, teamMemberId: named.memberId, actorUserId: owner(), reason: "pause" }, prisma);
    expect((await view(caseId, bystander.token)).statusCode).toBe(404);
    expect(await reachesRecord(evidenceId, bystander.id)).toBe(false);
  });

  it("a manager removing the last entry through the access route is the explicit act that opens the case", async () => {
    const named = await person();
    const bystander = await person();
    const { caseId } = await restrictedCaseFor(named);
    const row = await prisma.caseAccess.findFirstOrThrow({ where: { caseId, userId: named.id } });
    const removed = await h.app.inject({
      method: "DELETE",
      url: `/v1/cases/${caseId}/access/${row.id}`,
      headers: bearer(W().token),
    });
    expect([200, 204]).toContain(removed.statusCode);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).restrictedAtUtc).toBeNull();
    expect((await view(caseId, bystander.token)).statusCode).toBe(200);
  });

  it("removing one of several entries keeps the case restricted", async () => {
    const a = await person();
    const b = await person();
    const bystander = await person();
    const { caseId } = await restrictedCaseFor(a);
    await h.app.inject({ method: "POST", url: `/v1/cases/${caseId}/access`, headers: bearer(W().token), payload: { userId: b.id } });
    const row = await prisma.caseAccess.findFirstOrThrow({ where: { caseId, userId: a.id } });
    await h.app.inject({ method: "DELETE", url: `/v1/cases/${caseId}/access/${row.id}`, headers: bearer(W().token) });
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).restrictedAtUtc).not.toBeNull();
    expect((await view(caseId, bystander.token)).statusCode).toBe(404);
    expect((await view(caseId, b.token)).statusCode).toBe(200);
  });

  it("defect 7 — a case export leaves out a linked record the caller cannot reach (no id, no status, no report)", async () => {
    const exporter = await person();
    const other = await person();
    const { caseId, evidenceId: shared } = await restrictedCaseFor(exporter);
    // The same record is also linked to a SECOND case, restricted to someone else.
    const closed = await prisma.case.create({
      data: { name: `Closed ${tag()}`, teamId: W().teamId, ownerUserId: owner() },
      select: { id: true },
    });
    await prisma.caseEvidenceLink.create({ data: { caseId: closed.id, evidenceId: shared } as never });
    await h.app.inject({ method: "POST", url: `/v1/cases/${closed.id}/access`, headers: bearer(W().token), payload: { userId: other.id } });
    // And one record the exporter can read, linked only to the exported case.
    const team = await prisma.team.findUniqueOrThrow({ where: { id: W().teamId }, select: { organizationId: true } });
    const visible = await prisma.evidence.create({
      data: { title: `Visible ${tag()}`, type: "PHOTO", status: "CREATED", teamId: W().teamId, organizationId: team.organizationId, ownerUserId: owner() },
      select: { id: true },
    });
    await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId: visible.id } as never });

    expect(await reachesRecord(shared, exporter.id)).toBe(false);
    const res = await h.app.inject({ method: "GET", url: `/v1/cases/${caseId}/export`, headers: bearer(exporter.token) });
    expect(res.statusCode).toBe(200);
    const manifest = JSON.parse(readZipEntries(res.rawPayload).get("manifest.json")!.toString("utf8")) as {
      evidence: Array<{ id: string }>;
    };
    const ids = manifest.evidence.map((e) => e.id);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(shared);
    expect(res.rawPayload.toString("latin1")).not.toContain(shared);
  });

  it("the backfill flags every case that carries an access list, and invents no reach", async () => {
    const named = await person();
    const listed = await prisma.case.create({ data: { name: `Legacy ${tag()}`, teamId: W().teamId, ownerUserId: owner() }, select: { id: true } });
    await prisma.caseAccess.create({ data: { caseId: listed.id, userId: named.id } });
    const open = await prisma.case.create({ data: { name: `Open ${tag()}`, teamId: W().teamId, ownerUserId: owner() }, select: { id: true } });
    const conn = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await conn.connect();
    try {
      await conn.query(readFileSync(MIGRATION, "utf8"));
      await conn.query(readFileSync(MIGRATION, "utf8")); // idempotent
    } finally {
      await conn.end();
    }
    expect((await prisma.case.findUniqueOrThrow({ where: { id: listed.id } })).restrictedAtUtc).not.toBeNull();
    expect((await prisma.case.findUniqueOrThrow({ where: { id: open.id } })).restrictedAtUtc).toBeNull();
  });
});
