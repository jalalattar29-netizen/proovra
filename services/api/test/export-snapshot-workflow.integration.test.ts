import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IntegrationHarness } from "./integration-harness.js";

describe("governance export snapshots operator workflow", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const root = "/v1/governance/export-snapshots";
  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => { await harness?.cleanup(); });
  function request(method: "GET" | "POST", url: string, token: string, payload?: object) {
    return harness.app.inject({ method, url, headers: { authorization: "Bearer " + token }, payload });
  }
  async function create(kind = "AUDIT_EXPORT") {
    const a = harness.fixtures.teamA;
    const response = await request("POST", root, a.ownerToken, { teamId: a.teamId, snapshotKind: kind });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().snapshot;
  }
  it("creates an immutable workspace snapshot and rereads authoritative actor, scope and hash", async () => {
    const a = harness.fixtures.teamA;
    const snapshot = await create();
    expect(snapshot).toMatchObject({ teamId: a.teamId, evidenceId: null, createdByUserId: a.ownerUserId, snapshotKind: "AUDIT_EXPORT" });
    const read = await request("GET", root + "/" + snapshot.id + "?teamId=" + a.teamId, a.ownerToken);
    expect(read.statusCode).toBe(200);
    expect(read.json().snapshot).toEqual(snapshot);
    const verify = await request("GET", root + "/" + snapshot.id + "/verify?teamId=" + a.teamId, a.ownerToken);
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toEqual({ snapshotId: snapshot.id, valid: true, snapshotHash: snapshot.snapshotHash });
    const row = await prisma.governanceExportSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } });
    expect(row.createdByUserId).toBe(a.ownerUserId);
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { resourceId: snapshot.id, action: "governance.export_snapshot.create" } });
    expect(audit).toMatchObject({ userId: a.ownerUserId, workspaceId: a.teamId, resourceType: "governance_export_snapshot", outcome: "success", actorType: "HUMAN" });
    expect(audit.hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("paginates tied timestamps without duplicates and projects canonical creation authority", async () => {
    const a = harness.fixtures.teamA;
    const rows = [await create("COMPLIANCE_BUNDLE"), await create("COMPLIANCE_BUNDLE"), await create("COMPLIANCE_BUNDLE")];
    await prisma.governanceExportSnapshot.updateMany({ where: { id: { in: rows.map(row => row.id) } }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } });
    const query = "?teamId=" + a.teamId + "&snapshotKind=COMPLIANCE_BUNDLE&limit=2";
    const first = await request("GET", root + query, a.ownerToken);
    expect(first.statusCode).toBe(200);
    expect(first.json().creation).toEqual({ allowed: true, reason: null });
    expect(first.json().snapshots).toHaveLength(2);
    expect(first.json().nextCursor).toEqual(expect.any(String));
    const second = await request("GET", root + query + "&cursor=" + encodeURIComponent(first.json().nextCursor), a.ownerToken);
    expect(second.statusCode).toBe(200);
    expect(second.json().snapshots).toHaveLength(1);
    expect(second.json().nextCursor).toBeNull();
    const changedFilter = await request("GET", root + "?teamId=" + a.teamId + "&snapshotKind=AUDIT_EXPORT&cursor=" + encodeURIComponent(first.json().nextCursor), a.ownerToken);
    expect(changedFilter.statusCode).toBe(400);
    const foreignCursor = await request("GET", root + "?teamId=" + harness.fixtures.teamB.teamId + "&snapshotKind=COMPLIANCE_BUNDLE&cursor=" + encodeURIComponent(first.json().nextCursor), harness.fixtures.teamB.ownerToken);
    expect(foreignCursor.statusCode).toBe(400);
    expect(new Set([...first.json().snapshots, ...second.json().snapshots].map(row => row.id))).toEqual(new Set(rows.map(row => row.id)));
  });
  it("refuses foreign evidence and snapshot IDs without writing a snapshot", async () => {
    const { teamA: a, teamB: b } = harness.fixtures;
    const before = await prisma.governanceExportSnapshot.count({ where: { teamId: a.teamId } });
    const refused = await request("POST", root, a.ownerToken, { teamId: a.teamId, evidenceId: b.evidenceId, snapshotKind: "EVIDENCE_PACKAGE" });
    expect(refused.statusCode).toBe(404);
    expect(await prisma.governanceExportSnapshot.count({ where: { teamId: a.teamId } })).toBe(before);
    const snapshot = await create();
    for (const suffix of ["", "/verify"]) {
      const foreign = await request("GET", root + "/" + snapshot.id + suffix + "?teamId=" + b.teamId, b.ownerToken);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).not.toContain(snapshot.snapshotHash);
    }
  });
  it("rejects an invalid cursor with bounded validation instead of silently restarting", async () => {
    const a = harness.fixtures.teamA;
    const response = await request("GET", root + "?teamId=" + a.teamId + "&cursor=invalid", a.ownerToken);
    expect(response.statusCode).toBe(400);
  });
  it("refuses a viewer mutation and conceals a foreign workspace list", async () => {
    const { teamA: a, teamB: b } = harness.fixtures;
    const refused = await request("POST", root, a.viewerToken, { teamId: a.teamId, snapshotKind: "AUDIT_EXPORT" });
    expect(refused.statusCode).toBe(403);
    const foreign = await request("GET", root + "?teamId=" + b.teamId, a.ownerToken);
    expect(foreign.statusCode).toBe(404);
  });
});
