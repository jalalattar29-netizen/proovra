// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPERATIONS TRUTH CLOSURE — P1 security batch (live PostgreSQL + Redis).
 *
 *   OPS-025  investigation diagnostics must not return another tenant's
 *            global queue failure text / ids / backlog to a workspace member.
 *   OPS-026  runtime secrets / OTEL health are platform-only.
 *   OPS-010  /v1/ops/health returns workspace-scoped fields to members and
 *            process-wide configuration only to the platform authority.
 *   OPS-005  the Operations workbench API applies the same capability
 *            decision as the web envelope (plan, grant, lifecycle).
 *   OPS-021  the envelope counts ACTIVE members only and follows the member
 *            lifecycle the API enforces.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  bootOps,
  envelopeFor,
  makeUser,
  makeWorkspace,
  personalSpace,
  seedIncident,
  type Ctx,
} from "./operations-truth-fixtures.js";

describe("Operations truth closure — P1 security (live PostgreSQL 16 + Redis)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  it("OPS-025 a workspace member never receives another tenant's queue failure text, ids or backlog; the platform authority does", async () => {
    const a = c.h.fixtures.teamA;
    const b = c.h.fixtures.teamB;
    const { getQueueHandle } = await import("../src/services/operations/queue-inventory.service.js");
    const { Worker } = await import("bullmq");
    const q = getQueueHandle("report")!;
    const url = new URL(process.env.REDIS_URL!);
    const marker = `TENANT-B-${Date.now()}`;
    const w = new Worker(
      "report",
      async () => {
        throw new Error(`${marker} evidence ${b.evidenceId} team ${b.teamId}`);
      },
      { connection: { host: url.hostname, port: Number(url.port) } },
    );
    await q.add("GenerateReport", { evidenceId: b.evidenceId }, { jobId: `ops-truth-b-${Date.now()}`, attempts: 1 });
    const until = Date.now() + 15_000;
    while (Date.now() < until && (await q.getJobCounts("failed")).failed === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await w.close();
    expect((await q.getJobCounts("failed")).failed).toBeGreaterThan(0);

    for (const token of [a.viewerToken, a.ownerToken]) {
      const r = await c.inj("GET", `/v1/investigation/diagnostics?teamId=${a.teamId}`, token);
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain(marker);
      expect(r.body).not.toContain(b.teamId);
      expect(r.body).not.toContain(b.evidenceId);
      const j = r.json();
      expect(j.queues.report).toEqual({ depth: null, lastError: null, lastRunAt: null });
      expect(j.warnings).toContain("queues_platform_restricted");
    }

    const admin = await makeUser(c, "diag-platform", { platformRole: "admin" });
    await addMember(c, a.teamId, admin.id, "ADMIN");
    const p = await c.inj("GET", `/v1/investigation/diagnostics?teamId=${a.teamId}`, admin.token);
    expect(p.statusCode).toBe(200);
    expect(p.json().queues.report.lastError).toContain(marker);
  });

  it("OPS-026 secrets and OTEL health refuse every workspace role and serve the platform authority", async () => {
    const a = c.h.fixtures.teamA;
    for (const path of ["/v1/runtime/secrets-health", "/v1/runtime/otel-health"]) {
      for (const token of [a.viewerToken, a.memberToken, a.adminToken, a.ownerToken]) {
        const r = await c.inj("GET", `${path}?teamId=${a.teamId}`, token);
        expect(r.statusCode).toBe(403);
        expect(r.body).not.toMatch(/secretName|fallbackMode|migrated|OPENAI_API_KEY|region/);
      }
      expect((await c.inj("GET", path)).statusCode).toBe(401);
    }
    const admin = await makeUser(c, "secrets-platform", { platformRole: "admin" });
    expect((await c.inj("GET", "/v1/runtime/secrets-health", admin.token)).statusCode).toBe(200);
    expect((await c.inj("GET", "/v1/runtime/otel-health", admin.token)).statusCode).toBe(200);
  });

  it("OPS-010 /v1/ops/health gives a member tenant-scoped fields only; platform facts only to the platform authority", async () => {
    const a = c.h.fixtures.teamA;
    // A platform-internal condition written per workspace must not be counted.
    await seedIncident(c, a.teamId, { sourceId: "platform.worker_heartbeat_stale", category: "WORKER", severity: "CRITICAL", fingerprint: `dashboard:worker:heartbeat_stale:${a.teamId}` });
    const r = await c.inj("GET", `/v1/ops/health?teamId=${a.teamId}`, a.viewerToken);
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(Object.keys(j).sort()).toEqual(["database", "incidents", "ok"]);
    expect(r.body).not.toMatch(/TWILIO|snapshot|violations|observability|alerts/);
    expect(j.incidents.openCritical).toBe(0);
    const admin = await makeUser(c, "health-platform", { platformRole: "admin" });
    await addMember(c, a.teamId, admin.id, "VIEWER");
    const p = await c.inj("GET", `/v1/ops/health?teamId=${a.teamId}`, admin.token);
    expect(p.statusCode).toBe(200);
    expect(Object.keys(p.json().platform).sort()).toEqual(["alerts", "observability", "snapshot", "violations"]);
  });

  it("OPS-005 the workbench API follows the envelope's capability decision for every plan and grant state", async () => {
    type Probe = { label: string; token: string; teamId: string };
    const probes: Array<Probe & { expectWorkbench: boolean }> = [];

    const free = await makeUser(c, "free", { plan: "FREE" });
    probes.push({ label: "FREE personal owner", token: free.token, teamId: await personalSpace(c, free.id), expectWorkbench: false });
    const pro = await makeUser(c, "pro", { plan: "PRO" });
    probes.push({ label: "PRO personal owner", token: pro.token, teamId: await personalSpace(c, pro.id), expectWorkbench: true });

    const g = await makeUser(c, "grant", { plan: "FREE" });
    const gws = await personalSpace(c, g.id);
    const grant = await c.prisma.planGrant.create({ data: { userId: g.id, plan: "TEAM", source: "INTERNAL_TEST", reason: "ops-truth", grantedByUserId: g.id, idempotencyKey: `ops-truth-${g.id}`, grantedAtUtc: new Date(Date.now() - 7_200_000) } });
    probes.push({ label: "internal TEAM grant", token: g.token, teamId: gws, expectWorkbench: true });

    const ownedActive = await makeUser(c, "owned-active");
    const wsActive = await makeWorkspace(c, ownedActive.id, { name: "owned-active", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    probes.push({ label: "owned TEAM ACTIVE owner", token: ownedActive.token, teamId: wsActive.teamId, expectWorkbench: true });
    const ownedCancelled = await makeUser(c, "owned-cancelled");
    const wsCancelled = await makeWorkspace(c, ownedCancelled.id, { name: "owned-cancelled", kind: "OWNED", billingPlan: "TEAM", billingStatus: "CANCELED" });
    probes.push({ label: "owned TEAM CANCELED owner", token: ownedCancelled.token, teamId: wsCancelled.teamId, expectWorkbench: false });

    const check = async (p: Probe) => {
      const env = await envelopeFor(c, p.token, p.teamId);
      const incident = await seedIncident(c, p.teamId);
      const list = await c.inj("GET", `/v1/ops/incidents?teamId=${p.teamId}`, p.token);
      const detail = await c.inj("GET", `/v1/ops/incidents/${incident.id}?teamId=${p.teamId}`, p.token);
      const ack = await c.inj("POST", `/v1/ops/incidents/${incident.id}/ack`, p.token, { teamId: p.teamId });
      const groups = await c.inj("GET", `/v1/ops/incident-groups?teamId=${p.teamId}`, p.token);
      const summary = await c.inj("GET", `/v1/ops/summary?teamId=${p.teamId}`, p.token);
      return { env, list, detail, ack, groups, summary };
    };

    for (const p of probes) {
      const r = await check(p);
      expect(r.env.caps.OPERATIONS_VIEW, p.label).toBe(p.expectWorkbench);
      const expected = p.expectWorkbench ? 200 : 403;
      expect(r.list.statusCode, `${p.label} list`).toBe(expected);
      expect(r.detail.statusCode, `${p.label} detail`).toBe(expected);
      expect(r.ack.statusCode, `${p.label} ack`).toBe(expected);
      expect(r.groups.statusCode, `${p.label} groups`).toBe(expected);
      if (!p.expectWorkbench) {
        expect(r.list.json().error.reason).toBe("operations_not_included");
      }
      // Home's own-records summary stays readable for every ACTIVE member.
      expect(r.summary.statusCode, `${p.label} summary`).toBe(200);
    }

    // The grant expires: the SAME API calls now refuse, with no session change.
    await c.prisma.planGrant.update({ where: { id: grant.id }, data: { expiresAtUtc: new Date(Date.now() - 1000) } });
    const expired = await check({ label: "expired grant", token: g.token, teamId: gws });
    expect(expired.env.caps.OPERATIONS_VIEW).toBe(false);
    expect(expired.list.statusCode).toBe(403);
    expect(expired.ack.statusCode).toBe(403);
    await c.prisma.planGrant.update({ where: { id: grant.id }, data: { expiresAtUtc: null, revokedAtUtc: new Date(), revocationReason: "ops-truth" } });
    const revoked = await check({ label: "revoked grant", token: g.token, teamId: gws });
    expect(revoked.list.statusCode).toBe(403);
  });

  it("OPS-005 role actions follow the capability map: viewer reads, member acknowledges, admin suppresses, assign needs a shared workspace", async () => {
    const o = await makeUser(c, "roles-owner");
    const ws = await makeWorkspace(c, o.id, { name: "roles", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const viewer = await makeUser(c, "roles-viewer");
    const member = await makeUser(c, "roles-member");
    await addMember(c, ws.teamId, viewer.id, "VIEWER");
    await addMember(c, ws.teamId, member.id, "MEMBER");
    const inc = await seedIncident(c, ws.teamId);
    expect((await c.inj("GET", `/v1/ops/incidents?teamId=${ws.teamId}`, viewer.token)).statusCode).toBe(200);
    const vAck = await c.inj("POST", `/v1/ops/incidents/${inc.id}/ack`, viewer.token, { teamId: ws.teamId });
    expect(vAck.statusCode).toBe(403);
    expect((await c.inj("POST", `/v1/ops/incidents/${inc.id}/suppress`, member.token, { teamId: ws.teamId })).statusCode).toBe(403);
    expect((await c.inj("POST", `/v1/ops/incidents/${inc.id}/ack`, member.token, { teamId: ws.teamId })).statusCode).toBe(200);

    // A sole operator (one ACTIVE member + a revoked row) holds no ASSIGN.
    const solo = await makeUser(c, "solo-owner");
    const soloWs = await makeWorkspace(c, solo.id, { name: "solo", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const gone = await makeUser(c, "solo-gone");
    await addMember(c, soloWs.teamId, gone.id, "MEMBER", "REVOKED");
    const soloEnv = await envelopeFor(c, solo.token, soloWs.teamId);
    expect(soloEnv.caps.OPERATIONS_ASSIGN).toBe(false);
    expect((await c.inj("GET", `/v1/ops/assignable-operators?teamId=${soloWs.teamId}`, solo.token)).statusCode).toBe(403);
  });

  it("OPS-021 the envelope counts ACTIVE members only and withdraws Operations for an expired member or a suspended organization", async () => {
    const f = await makeUser(c, "free-owned");
    const fws = await makeWorkspace(c, f.id, { name: "free-owned", kind: "OWNED", billingPlan: "FREE", billingStatus: "INACTIVE" });
    const gone = await makeUser(c, "free-owned-gone");
    await addMember(c, fws.teamId, gone.id, "MEMBER", "REVOKED");
    const env = await envelopeFor(c, f.token, fws.teamId);
    expect(env.caps.OPERATIONS_VIEW).toBe(false);
    expect((await c.inj("GET", `/v1/ops/incidents?teamId=${fws.teamId}`, f.token)).statusCode).toBe(403);

    const o = await makeUser(c, "expiry-owner");
    const ws = await makeWorkspace(c, o.id, { name: "expiry", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const m = await makeUser(c, "expiry-member");
    await addMember(c, ws.teamId, m.id, "MEMBER");
    const before = await envelopeFor(c, m.token, ws.teamId);
    expect(before.caps.OPERATIONS_VIEW).toBe(true);
    await c.prisma.teamMember.updateMany({ where: { teamId: ws.teamId, userId: m.id }, data: { accessExpiresAtUtc: new Date(Date.now() - 1000) } });
    const after = await c.inj("GET", "/v1/platform/context", m.token);
    expect(after.json().capabilities.OPERATIONS_VIEW).toBe(false);
    expect((await c.inj("GET", `/v1/ops/incidents?teamId=${ws.teamId}`, m.token)).statusCode).toBe(403);

    const eo = await makeUser(c, "suspended-owner");
    const ews = await makeWorkspace(c, eo.id, { name: "suspended", billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    const ok = await envelopeFor(c, eo.token, ews.teamId);
    expect(ok.caps.OPERATIONS_VIEW).toBe(true);
    await c.prisma.organization.update({ where: { id: ews.orgId }, data: { status: "SUSPENDED" } });
    const suspended = await c.inj("GET", "/v1/platform/context", eo.token);
    expect(suspended.json().capabilities?.OPERATIONS_VIEW ?? false).toBe(false);
    expect((await c.inj("GET", `/v1/ops/incidents?teamId=${ews.teamId}`, eo.token)).statusCode).toBe(403);
  });

  it("cross-tenant: another tenant's incident is indistinguishable from a missing one and cannot be mutated", async () => {
    const a = c.h.fixtures.teamA;
    const b = c.h.fixtures.teamB;
    const own = await makeUser(c, "xt-owner");
    const ws = await makeWorkspace(c, own.id, { name: "xt", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const foreign = await seedIncident(c, b.teamId);
    const other = await c.inj("GET", `/v1/ops/incidents/${foreign.id}?teamId=${ws.teamId}`, own.token);
    const missing = await c.inj("GET", `/v1/ops/incidents/00000000-0000-4000-8000-00000000abcd?teamId=${ws.teamId}`, own.token);
    expect(other.statusCode).toBe(404);
    expect(other.body).toBe(missing.body);
    expect((await c.inj("POST", `/v1/ops/incidents/${foreign.id}/ack`, own.token, { teamId: ws.teamId })).statusCode).toBe(404);
    expect((await c.inj("GET", `/v1/ops/incidents?teamId=${a.teamId}`, own.token)).statusCode).toBe(404);
  });
});
