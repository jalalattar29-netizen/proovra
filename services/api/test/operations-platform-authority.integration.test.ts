// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * PLATFORM AUTHORITY OVER OPERATIONS — WHO MAY SEE AND DO WHAT (live PostgreSQL 16).
 *
 * The platform has ONE role, `admin`, resolved by `resolvePlatformAdmin` from
 * the database (or the deployment allowlist) — never from a token claim alone.
 * Proven here:
 *
 *   WORKSPACE ROUTES (/v1/ops/*) — the canonical MEMBER authority decides.
 *   A platform admin who is not a member gets 404 for the list, the detail,
 *   the group drill-down and every mutation; the capability envelope grants
 *   no Operations capability. A platform admin who IS a member gets exactly
 *   their member role's capabilities: a VIEWER sees, cannot mutate, and the
 *   envelope agrees; an OWNER may.
 *
 *   PLATFORM ROUTES (/v1/admin/incidents*) — `requirePlatformAdmin`. The admin
 *   sees every tenant's conditions, explicitly cross-tenant by that policy,
 *   but never a tenant's words: no record title in the sentence or subject,
 *   no observation entry that carried stored text. Acknowledge and resolve go
 *   through the same lifecycle authority (a live source-truth condition is
 *   refused); there is no platform "stop notifying". A token that merely
 *   CLAIMS admin, and an ordinary owner, are refused.
 *
 *   CROSS-TENANT DIRECT ID — a workspace member naming another workspace's
 *   condition id is answered 404, whichever workspace they name.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, bootOps, envelopeFor, makeUser, makeWorkspace, seedEvidence, seedIncident, type Ctx } from "./operations-truth-fixtures.js";

const SECRET_TITLE = "Private matter — Smith v. Jones";
const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3600_000);

describe("platform authority over Operations (live PostgreSQL 16)", () => {
  let c: Ctx;
  let owner: { id: string; token: string };
  let admin: { id: string; token: string };
  let teamId: string;
  let incidentId: string;
  let otherTeamId: string;
  let otherIncidentId: string;

  beforeAll(async () => {
    c = await bootOps();
    owner = await makeUser(c, "pa-owner", { plan: "PRO" });
    admin = await makeUser(c, "pa-admin", { platformRole: "admin" });
    teamId = (await makeWorkspace(c, owner.id, { name: "pa-ws", billingPlan: "TEAM", billingStatus: "ACTIVE" })).teamId;
    const other = await makeUser(c, "pa-other", { plan: "PRO" });
    otherTeamId = (await makeWorkspace(c, other.id, { name: "pa-other-ws", billingPlan: "TEAM", billingStatus: "ACTIVE" })).teamId;

    const { recordUploadStalledCondition } = await import("../src/services/reliability/upload-reconciliation.service.js");
    for (const [t, u] of [[teamId, owner.id], [otherTeamId, other.id]] as const) {
      const ev = await seedEvidence(c, t, u, { status: "UPLOADING", title: SECRET_TITLE });
      await c.prisma.uploadSession.create({
        data: { evidenceId: ev.id, teamId: t, status: "STALLED", stalledAtUtc: HOURS_AGO(1), lastActivityAtUtc: HOURS_AGO(3) } as never,
      });
      await recordUploadStalledCondition(
        { teamId: t, evidenceId: ev.id, recordTitle: SECRET_TITLE, minutes: 30, previousStatus: "UPLOADING", stalledAtUtc: HOURS_AGO(1) },
        c.prisma as never,
      );
    }
    incidentId = (await c.prisma.operationalIncident.findFirstOrThrow({ where: { teamId } })).id;
    otherIncidentId = (await c.prisma.operationalIncident.findFirstOrThrow({ where: { teamId: otherTeamId } })).id;
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  const conditionOf = (id: string) => c.prisma.operationalIncident.findUniqueOrThrow({ where: { id } });

  describe("workspace routes: the member authority decides, never the platform role", () => {
    it("a non-member platform admin gets 404 everywhere and no capability", async () => {
      const t = admin.token;
      const reads = [
        `/v1/ops/incidents?teamId=${teamId}`,
        `/v1/ops/incidents/${incidentId}?teamId=${teamId}`,
        `/v1/ops/incident-groups?teamId=${teamId}`,
        `/v1/ops/incident-groups/source:capture.upload_stalled/affected?teamId=${teamId}`,
      ];
      for (const url of reads) expect((await c.inj("GET", url, t)).statusCode, url).toBe(404);
      for (const action of ["ack", "resolve", "suppress", "assign"]) {
        const r = await c.inj("POST", `/v1/ops/incidents/${incidentId}/${action}`, t, {
          teamId,
          resolutionNote: "x",
          reason: "x",
          assigneeUserId: admin.id,
        });
        expect([403, 404], action).toContain(r.statusCode);
      }
      const env = await envelopeFor(c, t, teamId);
      expect(env.caps.OPERATIONS_VIEW ?? false).toBe(false);
      expect(env.caps.OPERATIONS_RESOLVE ?? false).toBe(false);
      expect((await conditionOf(incidentId)).status).toBe("OPEN");
    });

    it("a platform admin who is a VIEWER member reads, cannot mutate, and the envelope agrees", async () => {
      const ws = await makeWorkspace(c, owner.id, { name: "pa-viewer-ws", billingPlan: "TEAM", billingStatus: "ACTIVE" });
      const viewerAdmin = await makeUser(c, "pa-viewer-admin", { platformRole: "admin" });
      await addMember(c, ws.teamId, viewerAdmin.id, "VIEWER");
      const env = await envelopeFor(c, viewerAdmin.token, ws.teamId);
      expect(env.caps.OPERATIONS_VIEW).toBe(true);
      for (const cap of ["OPERATIONS_ACKNOWLEDGE", "OPERATIONS_RESOLVE", "OPERATIONS_SUPPRESS", "OPERATIONS_ASSIGN"]) {
        expect(env.caps[cap] ?? false, cap).toBe(false);
      }
      expect((await c.inj("GET", `/v1/ops/incidents?teamId=${ws.teamId}`, viewerAdmin.token)).statusCode).toBe(200);
      const own = await seedIncident(c, ws.teamId, { sourceId: "governance.notification_escalated" });
      for (const [action, body] of [["ack", {}], ["resolve", { resolutionNote: "Done." }], ["suppress", { reason: "Known." }]] as const) {
        const r = await c.inj("POST", `/v1/ops/incidents/${own.id}/${action}`, viewerAdmin.token, { teamId: ws.teamId, ...body });
        expect(r.statusCode, action).toBe(403);
      }
      expect((await conditionOf(own.id)).status).toBe("OPEN");
    });

    it("the workspace owner holds every Operations capability and the server agrees", async () => {
      const env = await envelopeFor(c, owner.token, teamId);
      for (const cap of ["OPERATIONS_VIEW", "OPERATIONS_ACKNOWLEDGE", "OPERATIONS_RESOLVE", "OPERATIONS_SUPPRESS"]) {
        expect(env.caps[cap], cap).toBe(true);
      }
      const r = await c.inj("GET", `/v1/ops/incidents/${incidentId}?teamId=${teamId}`, owner.token);
      expect(r.statusCode).toBe(200);
      // A member of THIS workspace sees its own record's name.
      expect((r.json() as { incident: { subject: { name: string | null } } }).incident.subject.name).toBe(SECRET_TITLE);
    });

    it("a cross-tenant incident id is 404 whichever workspace is named", async () => {
      for (const t of [teamId, otherTeamId]) {
        const r = await c.inj("GET", `/v1/ops/incidents/${otherIncidentId}?teamId=${t}`, owner.token);
        expect(r.statusCode, t).toBe(404);
        expect(JSON.stringify(r.json())).not.toContain(SECRET_TITLE);
      }
      const ack = await c.inj("POST", `/v1/ops/incidents/${otherIncidentId}/ack`, owner.token, { teamId });
      expect(ack.statusCode).toBe(404);
      expect((await conditionOf(otherIncidentId)).status).toBe("OPEN");
    });
  });

  describe("platform routes: explicit cross-tenant authority, never tenant content", () => {
    it("the list shows every tenant's condition with no record title anywhere", async () => {
      const r = await c.inj("GET", `/v1/admin/incidents?limit=200`, admin.token);
      expect(r.statusCode).toBe(200);
      const items = (r.json() as { items: Array<Record<string, unknown> & { id: string; subject: { name: string | null } }> }).items;
      const mine = items.filter((i) => i.id === incidentId || i.id === otherIncidentId);
      expect(mine).toHaveLength(2);
      for (const i of mine) {
        expect(i.title).toBe("Upload appears stalled");
        expect(i.subject.name).toBeNull();
        expect(JSON.stringify(i)).not.toContain(SECRET_TITLE);
        expect(i.technicalReferences).toContainEqual({ key: "signalCode", value: "upload_stalled" });
      }
    });

    it("the detail withholds observation text and tenant words", async () => {
      const r = await c.inj("GET", `/v1/admin/incidents/${incidentId}`, admin.token);
      expect(r.statusCode).toBe(200);
      const body = r.json() as { incident: { subject: { name: string | null } }; events: Array<{ eventType: string; safeMessage: string | null }> };
      expect(JSON.stringify(body)).not.toContain(SECRET_TITLE);
      expect(body.incident.subject.name).toBeNull();
      expect(body.events.find((e) => e.eventType === "opened")?.safeMessage ?? null).toBeNull();
    });

    it("acknowledge goes through the lifecycle authority; a live source-truth condition cannot be resolved; there is no platform stop-notifying", async () => {
      const ack = await c.inj("POST", `/v1/admin/incidents/${incidentId}/acknowledge`, admin.token, {});
      expect(ack.statusCode).toBe(200);
      expect((await conditionOf(incidentId)).status).toBe("ACKNOWLEDGED");
      expect(JSON.stringify(ack.json())).not.toContain(SECRET_TITLE);

      const res = await c.inj("POST", `/v1/admin/incidents/${incidentId}/resolve`, admin.token, { note: "Looks fine." });
      expect(res.statusCode).not.toBe(200);
      expect((await conditionOf(incidentId)).status).toBe("ACKNOWLEDGED");

      const sup = await c.inj("POST", `/v1/admin/incidents/${incidentId}/suppress`, admin.token, { reason: "x" });
      expect(sup.statusCode).toBe(404);
    });

    it("a token that only claims admin, and an ordinary workspace owner, are refused", async () => {
      const { signJwt } = await import("../src/services/jwt.js");
      const { recordAuthenticatedSession } = await import("../src/services/access-control/session-inventory.service.js");
      const pretender = await makeUser(c, "pa-pretender", { plan: "PRO" });
      const forged = signJwt(
        { sub: pretender.id, provider: "EMAIL", email: pretender.email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000), platformRole: "admin", role: "admin" } as never,
        process.env.AUTH_JWT_SECRET!,
        3600,
      );
      const p = JSON.parse(Buffer.from(forged.split(".")[1]!, "base64url").toString("utf8"));
      await recordAuthenticatedSession({ userId: pretender.id, teamId: null, sid: p.sid, iat: p.iat, exp: p.exp, ipPreview: "127.0.0.1", uaPreview: "pa" });
      for (const t of [forged, owner.token]) {
        expect((await c.inj("GET", `/v1/admin/incidents`, t)).statusCode).toBe(403);
        expect((await c.inj("GET", `/v1/admin/incidents/${incidentId}`, t)).statusCode).toBe(403);
        expect((await c.inj("POST", `/v1/admin/incidents/${otherIncidentId}/acknowledge`, t, {})).statusCode).toBe(403);
      }
      expect((await conditionOf(otherIncidentId)).status).toBe("OPEN");
    });
  });
});
