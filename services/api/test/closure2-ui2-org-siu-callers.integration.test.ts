/**
 * PRO-CENZ-01 (closure phase 2, owner decision K) — the web now calls these
 * routes, so the read projections the web gates on must agree with the write
 * routes, and the data export must never cross organizations. Live PostgreSQL
 * through the integration harness; no provider is contacted (storage reads are
 * a stub, links are presigned locally).
 *
 *   EP-0806  POST /v1/orgs/:id/policies/retention         + GET viewer.canPublish
 *   EP-0842  POST /v1/orgs/:id/data-export
 *   EP-0843  POST /v1/orgs/:id/data-export/:requestId/manifest
 *   EP-0844  POST /v1/orgs/:id/data-export/:requestId/links
 *   EP-1082..EP-1086  SIU checklist / indicator / follow-up writes + GET viewer.canWrite
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { makeEnterpriseOrganizationWorkspace } from "./support/enterprise-organization.js";

type Json = Record<string, unknown>;

describe("PRO-CENZ-01 closure 2 — organization and SIU routes the web now calls (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  // Loaded after the harness points the client at the test database (the
  // harness pattern; a top-level import would bind the placeholder URL).
  let processOrganizationDataExports: (typeof import("../src/services/organization/organization-data-export.service.js"))["processOrganizationDataExports"];
  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;
  const PASSWORD = "Closure2-Ui2-Owner-Pass-1";
  const proof = { stepUp: { method: "password", currentPassword: PASSWORD } };

  const call = (method: "GET" | "POST" | "PUT", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      remoteAddress: "192.0.2.61",
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  const orgOf = async (teamId: string) =>
    (await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } })).organizationId!;

  async function record(teamId: string, ownerUserId: string, extra: Json = {}) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: {
        title: `ui2 ${randomUUID().slice(0, 8)}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
        ...extra,
      } as never,
      select: { id: true },
    });
  }

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ processOrganizationDataExports } = await import("../src/services/organization/organization-data-export.service.js"));
    const { hashPassword } = await import("../src/services/email-password-auth.service.js");
    const hash = await hashPassword(PASSWORD);
    await prisma.user.updateMany({ where: { id: { in: [A().ownerUserId, B().ownerUserId] } }, data: { passwordHash: hash } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  describe("EP-0806 organization retention template", () => {
    it("viewer.canPublish agrees with the publish route for every organization role; a non-member and a SYSTEM organization get neither", async () => {
      const orgId = await orgOf(A().teamId);
      const url = `/v1/orgs/${orgId}/policies/retention`;
      // A's workspace users, and two of B's, given each organization role in A's organization.
      const roles: Array<[string, string, "ORG_ADMIN" | "ORG_SECURITY_ADMIN" | "ORG_AUDITOR" | "ORG_BILLING_ADMIN" | "ORG_MEMBER"]> = [
        [A().adminUserId, A().adminToken, "ORG_ADMIN"],
        [A().memberUserId, A().memberToken, "ORG_SECURITY_ADMIN"],
        [A().viewerUserId, A().viewerToken, "ORG_AUDITOR"],
        [B().adminUserId, B().adminToken, "ORG_BILLING_ADMIN"],
        [B().memberUserId, B().memberToken, "ORG_MEMBER"],
      ];
      const created = [];
      for (const [userId, , role] of roles) {
        created.push(
          (await prisma.organizationMembership.create({ data: { organizationId: orgId, userId, role }, select: { id: true } })).id,
        );
      }
      const stored = async () =>
        (await prisma.organizationPolicy.findFirst({ where: { organizationId: orgId, key: "retention.default" }, select: { value: true } }))
          ?.value ?? null;
      try {
        const actors: Array<[string, string, boolean]> = [
          ["ORG_OWNER", A().ownerToken, true],
          ...roles.map(([, token, role]) => [role, token, role === "ORG_ADMIN"] as [string, string, boolean]),
        ];
        let days = 400;
        for (const [role, token, mayPublish] of actors) {
          const read = await call("GET", url, token);
          expect(read.statusCode, `${role} ${read.body}`).toBe(200);
          expect((read.json() as { viewer: { canPublish: boolean } }).viewer, role).toEqual({ canPublish: mayPublish });

          const before = await stored();
          days += 1;
          const write = await call("POST", url, token, { retentionDays: days, immutable: false, description: `by ${role}` });
          expect(write.statusCode, `${role} ${write.body}`).toBe(mayPublish ? 200 : 403);
          if (mayPublish) {
            expect(await stored()).toMatchObject({ retentionDays: days, description: `by ${role}` });
          } else {
            expect(await stored()).toEqual(before);
          }
        }

        // Another organization's owner: concealed on the read and the write.
        const before = await stored();
        const foreignRead = await call("GET", url, B().ownerToken);
        expect(foreignRead.statusCode, foreignRead.body).toBe(404);
        expect(foreignRead.body).not.toContain("canPublish");
        const foreignWrite = await call("POST", url, B().ownerToken, { retentionDays: 1, immutable: false, description: null });
        expect(foreignWrite.statusCode, foreignWrite.body).toBe(404);
        expect(await stored()).toEqual(before);
      } finally {
        await prisma.organizationMembership.deleteMany({ where: { id: { in: created } } });
      }

      // The owner of a SYSTEM organization (the container behind a personal
      // workspace) is refused both: retention templates are a customer
      // (Enterprise) organization's.
      const system = await prisma.organization.create({
        data: { name: `ui2-system-${randomUUID().slice(0, 6)}`, billingOwnerUserId: A().ownerUserId, status: "ACTIVE", kind: "SYSTEM" },
        select: { id: true },
      });
      await prisma.organizationMembership.create({ data: { organizationId: system.id, userId: A().ownerUserId, role: "ORG_OWNER" } });
      const sysRead = await call("GET", `/v1/orgs/${system.id}/policies/retention`, A().ownerToken);
      expect(sysRead.statusCode, sysRead.body).toBe(403);
      const sysWrite = await call("POST", `/v1/orgs/${system.id}/policies/retention`, A().ownerToken, {
        retentionDays: 30,
        immutable: false,
        description: null,
      });
      expect(sysWrite.statusCode, sysWrite.body).toBe(403);
      expect(await prisma.organizationPolicy.count({ where: { organizationId: system.id } })).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe("EP-0842..EP-0844 organization data export", () => {
    it("the owner requests with a step-up; another organization's owner creates nothing", async () => {
      const orgA = await orgOf(A().teamId);
      const noProof = await call("POST", `/v1/orgs/${orgA}/data-export`, A().ownerToken, {});
      expect(noProof.statusCode, noProof.body).toBe(401);
      expect((noProof.json() as { error: { code: string } }).error.code).toBe("STEP_UP_REQUIRED");
      expect(await prisma.organizationDataExportRequest.count({ where: { organizationId: orgA } })).toBe(0);

      // B's owner, with a valid proof of their own, is concealed and creates nothing.
      const foreign = await call("POST", `/v1/orgs/${orgA}/data-export`, B().ownerToken, proof);
      expect(foreign.statusCode, foreign.body).toBe(404);
      expect(await prisma.organizationDataExportRequest.count({ where: { organizationId: orgA } })).toBe(0);

      // Each verified proof counts against the account's step-up limit (5 a
      // minute), so this suite spends at most five per owner.
      const ok = await call("POST", `/v1/orgs/${orgA}/data-export`, A().ownerToken, proof);
      expect(ok.statusCode, ok.body).toBe(201);
      expect(await prisma.organizationDataExportRequest.count({ where: { organizationId: orgA } })).toBe(1);
    });

    it("a READY export is read only through its own organization: another organization's request id, org id or records are never reached", async () => {
      const orgA = await orgOf(A().teamId);
      const orgB = await orgOf(B().teamId);
      const ownRecord = await record(A().teamId, A().ownerUserId, {
        storageBucket: "ui2-org-export",
        storageKey: `org-a/${randomUUID()}.jpg`,
        storageVersionId: "v-a-1",
        fileSha256: "a".repeat(64),
        sizeBytes: 10n,
      });
      const foreignRecord = await record(B().teamId, B().ownerUserId, {
        storageBucket: "ui2-org-export",
        storageKey: `org-b/${randomUUID()}.jpg`,
        storageVersionId: "v-b-1",
        fileSha256: "b".repeat(64),
        sizeBytes: 10n,
      });
      // B's owner asks for B's own export through the route.
      const bReq = await call("POST", `/v1/orgs/${orgB}/data-export`, B().ownerToken, proof);
      expect(bReq.statusCode, bReq.body).toBe(201);
      const bId = ((bReq.json() as Json).request as { id: string }).id;
      // One active request per organization.
      const again = await call("POST", `/v1/orgs/${orgB}/data-export`, B().ownerToken, proof);
      expect(again.statusCode, again.body).toBe(409);
      expect((again.json() as { error: { code: string } }).error.code).toBe("export_request_active");
      expect(await prisma.organizationDataExportRequest.count({ where: { organizationId: orgB } })).toBe(1);

      const storage = {
        listObjectVersions: async (input: { key?: string } | string) => {
          const key = typeof input === "string" ? input : (input?.key ?? "");
          return [{ versionId: String(key).startsWith("org-a/") ? "v-a-1" : "v-b-1", isDeleteMarker: false }];
        },
      } as never;
      await processOrganizationDataExports(new Date(), { client: prisma as never, storage });

      const aRow = await prisma.organizationDataExportRequest.findFirstOrThrow({ where: { organizationId: orgA }, select: { id: true, status: true } });
      expect(aRow.status).toBe("READY");
      expect((await prisma.organizationDataExportRequest.findUniqueOrThrow({ where: { id: bId } })).status).toBe("READY");

      // History: A's owner sees A's export only; B's org history is concealed.
      const historyA = await call("GET", `/v1/orgs/${orgA}/data-export`, A().ownerToken);
      expect(historyA.statusCode, historyA.body).toBe(200);
      const ids = ((historyA.json() as { requests: Array<{ id: string }> }).requests ?? []).map((r) => r.id);
      expect(ids).toContain(aRow.id);
      expect(ids).not.toContain(bId);
      expect((await call("GET", `/v1/orgs/${orgB}/data-export`, A().ownerToken)).statusCode).toBe(404);

      for (const kind of ["manifest", "links"] as const) {
        // B's request id under A's organization: unknown to A.
        const crossId = await call("POST", `/v1/orgs/${orgA}/data-export/${bId}/${kind}`, A().ownerToken, proof);
        expect(crossId.statusCode, `${kind} ${crossId.body}`).toBe(404);
        expect((crossId.json() as { error: { code: string } }).error.code).toBe("export_not_found");
        // B's organization id: A's owner is not a member there.
        const crossOrg = await call("POST", `/v1/orgs/${orgB}/data-export/${bId}/${kind}`, A().ownerToken, proof);
        expect(crossOrg.statusCode, `${kind} ${crossOrg.body}`).toBe(404);
        expect((crossOrg.json() as { error: { code: string } }).error.code).toBe("not_found");
      }
      const bAfter = await prisma.organizationDataExportRequest.findUniqueOrThrow({ where: { id: bId } });
      expect(bAfter.downloadCount).toBe(0);
      expect(bAfter.lastDownloadedAtUtc).toBeNull();

      // A's own manifest: A's record is in it, B's is not; the download is counted.
      const manifest = await call("POST", `/v1/orgs/${orgA}/data-export/${aRow.id}/manifest`, A().ownerToken, proof);
      expect(manifest.statusCode, manifest.body).toBe(200);
      expect(manifest.body).toContain(ownRecord.id);
      expect(manifest.body).not.toContain(foreignRecord.id);
      expect(manifest.body).not.toContain(B().teamId);
      expect((await prisma.organizationDataExportRequest.findUniqueOrThrow({ where: { id: aRow.id } })).downloadCount).toBe(1);

      // A's own links: bound to A's sealed version, never a B object.
      const links = await call("POST", `/v1/orgs/${orgA}/data-export/${aRow.id}/links`, A().ownerToken, { ...proof, offset: 0 });
      expect(links.statusCode, links.body).toBe(200);
      const page = links.json() as { links: Array<{ evidenceId: string; versionId: string | null; url: string }> };
      expect(page.links.some((l) => l.evidenceId === ownRecord.id && l.versionId === "v-a-1")).toBe(true);
      expect(page.links.some((l) => l.evidenceId === foreignRecord.id)).toBe(false);
      expect(links.body).not.toContain("org-b/");
    });

    it("the owner of a SYSTEM organization is refused the export (a customer organization's capability)", async () => {
      const system = await prisma.organization.create({
        data: { name: `ui2-system-x-${randomUUID().slice(0, 6)}`, billingOwnerUserId: B().ownerUserId, status: "ACTIVE", kind: "SYSTEM" },
        select: { id: true },
      });
      await prisma.organizationMembership.create({ data: { organizationId: system.id, userId: B().ownerUserId, role: "ORG_OWNER" } });
      const read = await call("GET", `/v1/orgs/${system.id}/data-export`, B().ownerToken);
      expect(read.statusCode, read.body).toBe(403);
      const res = await call("POST", `/v1/orgs/${system.id}/data-export`, B().ownerToken, proof);
      expect(res.statusCode, res.body).toBe(403);
      expect(await prisma.organizationDataExportRequest.count({ where: { organizationId: system.id } })).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe("EP-1082..EP-1086 SIU viewer projection", () => {
    it("viewer.canWrite agrees with every SIU write for each role, then for the workspace once it stops being Enterprise", async () => {
      const original = await prisma.team.findUniqueOrThrow({
        where: { id: A().teamId },
        select: { billingPlan: true, billingStatus: true, organizationId: true },
      });
      await makeEnterpriseOrganizationWorkspace(prisma, A().teamId);
      const base = `/v1/cases/${A().caseId}/siu-profile`;
      const put = await call("PUT", base, A().ownerToken, { claimType: "auto" });
      expect(put.statusCode, put.body).toBeLessThan(300);
      await prisma.caseEvidenceLink.create({ data: { caseId: A().caseId, evidenceId: A().evidenceId, teamId: A().teamId } as never });

      type Viewer = { canWrite: boolean; disabledCode: string | null; disabledReason: string | null };
      const viewerOf = async (token: string): Promise<Viewer> => {
        const res = await call("GET", base, token);
        expect(res.statusCode, res.body).toBe(200);
        return (res.json() as { viewer: Viewer }).viewer;
      };

      // Every write route, as the web sends it.
      const writes = async (token: string): Promise<number[]> => {
        const out: number[] = [];
        out.push((await call("POST", `${base}/checklist/scene_overview/map-evidence`, token, { evidenceId: A().evidenceId })).statusCode);
        out.push((await call("POST", `${base}/checklist/police_report/status`, token, { status: "submitted", note: null })).statusCode);
        out.push(
          (await call("POST", `${base}/indicators`, token, {
            code: "MISSING_REQUIRED_EVIDENCE",
            explanation: "Required evidence is missing: Police report",
            severity: "warning",
          })).statusCode,
        );
        const fu = await call("POST", `${base}/follow-ups`, token, { checklistItemId: "police_report", dueByUtc: null, note: null });
        out.push(fu.statusCode);
        const anyFollowUp = await prisma.caseSiuFollowUp.findFirst({
          where: { siuProfile: { caseId: A().caseId } },
          select: { id: true },
        });
        out.push(
          anyFollowUp
            ? (await call("POST", `${base}/follow-ups/${anyFollowUp.id}/status`, token, { status: "sent", receivedEvidenceId: null })).statusCode
            : -1,
        );
        return out;
      };

      // Writers first, so a follow-up exists for the readers' status attempt.
      const owner = await viewerOf(A().ownerToken);
      expect(owner).toEqual({ canWrite: true, disabledCode: null, disabledReason: null });
      expect(await writes(A().ownerToken)).toEqual([200, 200, 200, 200, 200]);

      const admin = await viewerOf(A().adminToken);
      expect(admin.canWrite).toBe(true);
      expect(await writes(A().adminToken)).toEqual([200, 200, 200, 200, 200]);

      const snapshot = async () => ({
        indicators: await prisma.caseSiuReviewIndicator.count({ where: { siuProfile: { caseId: A().caseId } } }),
        followUps: await prisma.caseSiuFollowUp.count({ where: { siuProfile: { caseId: A().caseId } } }),
      });

      // A VIEWER: no write permission at all.
      const viewer = await viewerOf(A().viewerToken);
      expect(viewer.canWrite).toBe(false);
      expect(viewer.disabledCode).toBe("permission");
      expect(viewer.disabledReason).toContain("read this investigation profile but not change it");

      // L-3 — the READ writes no permission_denied security event; the write
      // keeps its auditing check. Reading three times, then one refused write,
      // must leave exactly one new event (the write's): the positive control
      // proves events are being recorded, so the absence is not vacuous.
      const deniedEvents = () =>
        prisma.securityEvent.count({ where: { teamId: A().teamId, eventType: "permission_denied" } });
      const eventsBefore = await deniedEvents();
      for (let i = 0; i < 3; i += 1) expect((await viewerOf(A().viewerToken)).canWrite).toBe(false);
      const refusedWrite = await call("POST", `${base}/checklist/police_report/status`, A().viewerToken, {
        status: "waived",
        note: null,
      });
      expect(refusedWrite.statusCode, refusedWrite.body).toBe(403);
      const until = Date.now() + 10_000;
      while (Date.now() < until && (await deniedEvents()) === eventsBefore) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Let any straggler (a read's event, if one were emitted) land too.
      await new Promise((r) => setTimeout(r, 500));
      expect(await deniedEvents()).toBe(eventsBefore + 1);
      const lastDenied = await prisma.securityEvent.findFirstOrThrow({
        where: { teamId: A().teamId, eventType: "permission_denied" },
        orderBy: { createdAt: "desc" },
      });
      expect(JSON.stringify(lastDenied)).toContain("evidence.update_metadata");

      const before = await snapshot();
      expect(await writes(A().viewerToken)).toEqual([403, 403, 403, 403, 403]);
      expect(await snapshot()).toEqual(before);

      // A VIEWER holding the workspace permission is still refused by the case
      // matrix; the projection names that reason, not the permission.
      const viewerMember = await prisma.teamMember.findUniqueOrThrow({
        where: { teamId_userId: { teamId: A().teamId, userId: A().viewerUserId } },
        select: { id: true },
      });
      await prisma.memberCapabilityGrant.create({
        data: { teamMemberId: viewerMember.id, teamId: A().teamId, permission: "evidence.update_metadata", grantedByUserId: A().ownerUserId },
      });
      try {
        const granted = await viewerOf(A().viewerToken);
        expect(granted).toMatchObject({ canWrite: false, disabledCode: "case_role" });
        expect(await writes(A().viewerToken)).toEqual([403, 403, 403, 403, 403]);
        expect(await snapshot()).toEqual(before);
      } finally {
        await prisma.memberCapabilityGrant.deleteMany({ where: { teamMemberId: viewerMember.id } });
      }

      // Another tenant: the read is concealed, so no projection leaks.
      const foreign = await call("GET", base, B().ownerToken);
      expect(foreign.statusCode, foreign.body).toBe(404);
      expect(foreign.body).not.toContain("canWrite");

      // The workspace stops being an Enterprise organization: the stored
      // profile stays readable (DEC-10), the projection says why nothing is
      // offered, and every write is refused with the plan refusal.
      await prisma.enterpriseContract.deleteMany({ where: { organizationId: original.organizationId! } });
      await prisma.team.update({
        where: { id: A().teamId },
        data: { billingPlan: original.billingPlan, billingStatus: original.billingStatus },
      });
      const lapsed = await viewerOf(A().ownerToken);
      expect(lapsed).toMatchObject({ canWrite: false, disabledCode: "enterprise_required" });
      expect(lapsed.disabledReason).toContain("Enterprise organization workspace");
      const lapsedBefore = await snapshot();
      const refused = await call("POST", `${base}/checklist/police_report/status`, A().ownerToken, { status: "waived", note: null });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", requirement: "ENTERPRISE_ORGANIZATION_WORKSPACE" });
      expect(await writes(A().ownerToken)).toEqual([403, 403, 403, 403, 403]);
      expect(await snapshot()).toEqual(lapsedBefore);
    });
  });
});
