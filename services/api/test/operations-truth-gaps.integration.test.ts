// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPERATIONS TRUTH CLOSURE — the remaining contract points (live PostgreSQL).
 *
 *   OPS-030  "Resume notifications" is the authorized way back from a
 *            suppression; only a SUPPRESSED condition moves, and both moves
 *            are in the condition's history.
 *   OPS-031  record links land on the exact Evidence tab that owns the fix.
 *   OPS-003  a storage add-on whose payer changes does not orphan the old
 *            payer's condition: it closes there and is raised for the new one.
 *   OPS-003  an add-on the provider activated and PROOVRA refused keeps its
 *            obligation through failed cancellation attempts: the condition
 *            stays open until the provider confirms, never closed because a
 *            failed attempt rewrote why the stop is owed.
 *   OPS-008  with more than 500 workspaces, every due workspace is reached,
 *            each exactly once per pass; Platform Admin sees the coverage.
 *   OPS-032  "Check again" re-examines the sources inside the freshness
 *            window: a record repaired after the last run closes on the
 *            click, not 45 minutes later. A repeated click seconds apart does
 *            not start a second run.
 *   OPS-034  the organisation list returns ORIGINAL conditions of readable
 *            workspaces only, filterable and paged; an action on a listed row
 *            runs against the original condition.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  bootOps,
  makeUser,
  makeWorkspace,
  personalSpace,
  seedEvidence,
  seedIncident,
  sweep,
  type Ctx,
} from "./operations-truth-fixtures.js";

describe("Operations truth closure — remaining contract points (live PostgreSQL 16)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  it("OPS-030 Resume notifications returns a SUPPRESSED condition to OPEN, with both moves in history", async () => {
    const a = c.h.fixtures.teamA;
    const row = await seedIncident(c, a.teamId, { sourceId: "governance.policy_condition" });
    const early = await c.inj("POST", `/v1/ops/incidents/${row.id}/unsuppress`, a.ownerToken, { teamId: a.teamId });
    expect(early.statusCode).toBe(409);
    await c.inj("POST", `/v1/ops/incidents/${row.id}/suppress`, a.ownerToken, { teamId: a.teamId, reason: "Planned maintenance" });
    const resumed = await c.inj("POST", `/v1/ops/incidents/${row.id}/unsuppress`, a.ownerToken, { teamId: a.teamId });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().incident.status).toBe("OPEN");
    const viewer = await c.inj("POST", `/v1/ops/incidents/${row.id}/unsuppress`, a.viewerToken, { teamId: a.teamId });
    expect(viewer.statusCode).toBe(403);
    const detail = (await c.inj("GET", `/v1/ops/incidents/${row.id}?teamId=${a.teamId}`, a.ownerToken)).json();
    const messages = detail.incident.timeline.map((e: { safeMessage: string }) => e.safeMessage).join(" | ");
    expect(messages).toContain("Planned maintenance");
    expect(messages).toContain("Notifications resumed by an operator.");
  });

  it("OPS-031 an integrity condition links to the record's Integrity tab", async () => {
    const a = c.h.fixtures.teamA;
    const ev = await seedEvidence(c, a.teamId, a.ownerUserId, { tsaStatus: "FAILED" });
    const row = await seedIncident(c, a.teamId, {
      sourceId: "evidence_integrity.tsa_failed",
      category: "EVIDENCE_INTEGRITY",
      fingerprint: `tsa_failure:${ev.id}`,
      relatedEvidenceId: ev.id,
    });
    const d = (await c.inj("GET", `/v1/ops/incidents/${row.id}?teamId=${a.teamId}`, a.ownerToken)).json();
    expect(d.remediation.deepLink.href).toBe(`/evidence/${ev.id}?tab=integrity`);
  });

  it("OPS-003 a payer change closes the old payer's condition and raises it for the new payer", async () => {
    const first = await makeUser(c, "payer-first", { plan: "PRO" });
    const second = await makeUser(c, "payer-second", { plan: "PRO" });
    const s1 = await personalSpace(c, first.id);
    const s2 = await personalSpace(c, second.id);
    const addon = await c.prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: first.id,
        teamId: null,
        addonKey: "PERSONAL_50_GB",
        extraStorageBytes: BigInt(50) * BigInt(1024) ** BigInt(3),
        billingCycle: "MONTHLY",
        paymentProvider: "STRIPE",
        dependentCancellationState: "ACTION_REQUIRED",
        dependentCancellationRequestedAtUtc: new Date(),
      },
    });
    await sweep(s1);
    const fp = `billing_dependent_cancellation:${addon.id}`;
    expect((await c.prisma.operationalIncident.findFirst({ where: { teamId: s1, fingerprint: fp } }))?.status).toBe("OPEN");
    await c.prisma.workspaceStorageAddon.update({ where: { id: addon.id }, data: { ownerUserId: second.id } });
    await sweep(s1);
    await sweep(s2);
    expect((await c.prisma.operationalIncident.findFirst({ where: { teamId: s1, fingerprint: fp } }))?.status).toBe("RESOLVED");
    expect((await c.prisma.operationalIncident.findFirst({ where: { teamId: s2, fingerprint: fp } }))?.status).toBe("OPEN");
  });

  it("OPS-008 more than 500 workspaces: every due workspace is reached once per pass, and Platform Admin sees the coverage", async () => {
    const owner = await makeUser(c, "fair-owner");
    const base = await makeWorkspace(c, owner.id, { name: "fair-base" });
    // Everything already in the database is current, so the pass below is
    // about exactly the 520 new workspaces.
    await c.prisma.$executeRawUnsafe(
      `INSERT INTO governance_reconciliation_runs (team_id, kind, "trigger", status, started_at_utc, finished_at_utc, lock_key)
       SELECT t.id, 'WORKSPACE_OPERATIONS', 'ops-truth', 'SUCCEEDED', now(), now(), 'ops-truth:' || t.id FROM teams t`,
    );
    const stamp = Date.now();
    await c.prisma.team.createMany({
      data: Array.from({ length: 520 }, (_, i) => ({
        name: `fair-${stamp}-${String(i).padStart(3, "0")}`,
        ownerUserId: owner.id,
        organizationId: base.orgId,
        workspaceKind: "ORGANIZATION",
        isPersonal: false,
      })),
    });
    const fresh = await c.prisma.team.findMany({ where: { name: { startsWith: `fair-${stamp}-` } }, select: { id: true } });
    expect(fresh).toHaveLength(520);

    const { workspacesNeedingReconciliation, operationsSweepCoverage } = await import(
      "../src/jobs/workspace-operations-reconciliation.job.js"
    );
    const before = await operationsSweepCoverage();
    expect(before.due).toBeGreaterThanOrEqual(520);

    const visited: string[] = [];
    for (let tick = 0; tick < 10; tick++) {
      const ranked = await workspacesNeedingReconciliation(200, new Date());
      if (ranked.ids.length === 0) break;
      visited.push(...ranked.ids);
      // Each selected workspace records its run, as the reconciliation does.
      await c.prisma.governanceReconciliationRun.createMany({
        data: ranked.ids.map((id) => ({
          teamId: id,
          kind: "WORKSPACE_OPERATIONS",
          trigger: "ops-truth",
          status: "SUCCEEDED",
          startedAtUtc: new Date(),
          finishedAtUtc: new Date(),
          lockKey: `ops-truth:${id}:${tick}`,
        })),
      });
    }
    expect(new Set(visited).size).toBe(visited.length);
    expect(new Set(visited)).toEqual(new Set(fresh.map((t: { id: string }) => t.id)));
    expect((await operationsSweepCoverage()).due).toBe(0);

    // The coverage reaches Platform Admin, and only Platform Admin.
    const admin = await makeUser(c, "fair-admin", { platformRole: "admin" });
    await addMember(c, base.teamId, admin.id, "ADMIN");
    const asAdmin = (await c.inj("GET", `/v1/ops/health?teamId=${base.teamId}`, admin.token)).json();
    expect(asAdmin.platform?.operationsSweep).toMatchObject({ due: 0 });
    expect(asAdmin.platform.operationsSweep.workspaces).toBeGreaterThanOrEqual(521);
    const asOwner = (await c.inj("GET", `/v1/ops/health?teamId=${base.teamId}`, owner.token)).json();
    expect(asOwner.platform).toBeUndefined();

    // The 520 workspaces exist for this proof only. Left behind, they fall due
    // again 45 minutes later and every later sweep test in a shared database
    // has to work through them first.
    await c.prisma.governanceReconciliationRun.deleteMany({ where: { teamId: { in: fresh.map((t: { id: string }) => t.id) } } });
    await c.prisma.team.deleteMany({ where: { id: { in: fresh.map((t: { id: string }) => t.id) } } });
  });

  it("OPS-034 the organisation list is the original conditions of readable workspaces, filtered and paged; actions hit the original", async () => {
    const owner = await makeUser(c, "orglist-owner");
    const outsider = await makeUser(c, "orglist-other");
    const w1 = await makeWorkspace(c, owner.id, { name: "orglist-1", billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    const w2 = await makeWorkspace(c, owner.id, { name: "orglist-2", orgId: w1.orgId, billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    const w3 = await makeWorkspace(c, outsider.id, { name: "orglist-3", orgId: w1.orgId, billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
    const own = [] as string[];
    for (const [teamId, n] of [[w1.teamId, 3], [w2.teamId, 2]] as const) {
      for (let i = 0; i < n; i++) {
        own.push((await seedIncident(c, teamId, { sourceId: "governance.policy_condition", severity: i === 0 ? "CRITICAL" : "HIGH" })).id);
      }
    }
    const hidden = await seedIncident(c, w3.teamId, { sourceId: "governance.policy_condition" });

    const page1 = (await c.inj("GET", `/v1/orgs/${w1.orgId}/operations/incidents?limit=3`, owner.token)).json();
    expect(page1.incidents).toHaveLength(3);
    expect(page1.pagination.nextCursor).toBeTruthy();
    const page2 = (await c.inj("GET", `/v1/orgs/${w1.orgId}/operations/incidents?limit=3&cursor=${page1.pagination.nextCursor}`, owner.token)).json();
    const all = [...page1.incidents, ...page2.incidents];
    expect(all.map((i: { id: string }) => i.id).sort()).toEqual([...own].sort());
    expect(JSON.stringify(all)).not.toContain(hidden.id);
    for (const i of all) expect([w1.teamId, w2.teamId]).toContain(i.workspaceId);

    const critical = (await c.inj("GET", `/v1/orgs/${w1.orgId}/operations/incidents?severity=CRITICAL`, owner.token)).json();
    expect(critical.incidents).toHaveLength(2);
    const onlyW2 = (await c.inj("GET", `/v1/orgs/${w1.orgId}/operations/incidents?workspaceId=${w2.teamId}`, owner.token)).json();
    expect(onlyW2.incidents.every((i: { workspaceId: string }) => i.workspaceId === w2.teamId)).toBe(true);

    // Drilldown: the listed id IS the original condition; acting on it in its
    // own workspace changes that row, and no second record exists.
    const target = all[0];
    const ack = await c.inj("POST", `/v1/ops/incidents/${target.id}/ack`, owner.token, { teamId: target.workspaceId });
    expect(ack.statusCode).toBe(200);
    expect((await c.prisma.operationalIncident.findUnique({ where: { id: target.id } }))?.status).toBe("ACKNOWLEDGED");
    expect(await c.prisma.operationalIncident.count({ where: { id: { in: own } } })).toBe(own.length);

    const stranger = await makeUser(c, "orglist-stranger");
    const refused = await c.inj("GET", `/v1/orgs/${w1.orgId}/operations/incidents`, stranger.token);
    expect([403, 404]).toContain(refused.statusCode);
  });

  it("OPS-032 an explicit Check again re-examines the sources inside the freshness window", async () => {
    const owner = await makeUser(c, "recheck-owner", { plan: "PRO" });
    const w = await makeWorkspace(c, owner.id, { name: "recheck", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const ev = await seedEvidence(c, w.teamId, owner.id, { tsaStatus: "FAILED" });
    const row = await seedIncident(c, w.teamId, {
      sourceId: "evidence_integrity.tsa_failed",
      category: "EVIDENCE_INTEGRITY",
      fingerprint: `tsa_failure:${ev.id}`,
      relatedEvidenceId: ev.id,
    });
    const { ensureWorkspaceOperationsFresh } = await import("../src/services/operations/operations-reconciliation.service.js");
    const first = await ensureWorkspaceOperationsFresh({ workspaceId: w.teamId });
    expect(first.ran).toBe(true);
    expect((await c.prisma.operationalIncident.findUnique({ where: { id: row.id } }))?.status).toBe("OPEN");

    // The record is repaired after the run: a validated timestamp.
    await c.prisma.evidence.update({ where: { id: ev.id }, data: { tsaStatus: "STAMPED", tsaValidatedAtUtc: new Date() } });
    const later = new Date(Date.now() + 11_000);

    // A page load inside the window does not churn ...
    expect((await ensureWorkspaceOperationsFresh({ workspaceId: w.teamId, now: later })).ran).toBe(false);
    expect((await c.prisma.operationalIncident.findUnique({ where: { id: row.id } }))?.status).toBe("OPEN");
    // ... a click seconds after a run does not start another ...
    expect((await ensureWorkspaceOperationsFresh({ workspaceId: w.teamId, explicit: true })).ran).toBe(false);
    // ... and a person asking again re-examines the source, which closes it.
    const asked = await ensureWorkspaceOperationsFresh({ workspaceId: w.teamId, explicit: true, now: later });
    expect(asked.ran).toBe(true);
    expect((await c.prisma.operationalIncident.findUnique({ where: { id: row.id } }))?.status).toBe("RESOLVED");

    // The route carries the flag.
    const viaRoute = await c.inj("POST", "/v1/ops/workspace-reconcile", owner.token, { teamId: w.teamId, explicit: true });
    expect(viaRoute.statusCode).toBe(202);
  });

  it("OPS-003 an ungrantable add-on keeps its obligation through failed attempts, and closes only on provider confirmation", async () => {
    const payer = await makeUser(c, "ungrantable-payer", { plan: "PRO" });
    const space = await personalSpace(c, payer.id);
    const addon = await c.prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId: payer.id,
        teamId: null,
        addonKey: "PERSONAL_50_GB",
        extraStorageBytes: BigInt(50) * BigInt(1024) ** BigInt(3),
        billingCycle: "MONTHLY",
        // As storage-activation writes it: the provider activated it, PROOVRA
        // refused the grant, and stopping the charge is owed.
        status: "FAILED",
        paymentProvider: "PAYPAL",
        externalSubscriptionId: `I-UNGRANTABLE-${Date.now()}`,
        dependentCancellationState: "PENDING",
        dependentCancellationReasonCode: "UNGRANTABLE_PROVIDER_ACTIVE",
        dependentCancellationRequestedAtUtc: new Date(),
        dependentCancellationNextRetryAtUtc: new Date(),
      },
    });
    const { attemptDependentCancellations } = await import("../src/services/billing/dependent-cancellation.service.js");
    const fp = `billing_dependent_cancellation:${addon.id}`;
    const condition = async () => (await c.prisma.operationalIncident.findFirst({ where: { teamId: space, fingerprint: fp } }))?.status;

    await sweep(space);
    expect(await condition()).toBe("OPEN");

    // The provider is unreachable, twice.
    for (let i = 0; i < 2; i++) {
      await c.prisma.workspaceStorageAddon.update({ where: { id: addon.id }, data: { dependentCancellationLeaseUntilUtc: null } });
      await attemptDependentCancellations({
        ownerUserId: payer.id,
        teamId: null,
        cancelAtProvider: async ({ mode }) => ({ ok: false, mode, reasonCode: "PROVIDER_UNAVAILABLE" }),
      });
    }
    const after = await c.prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: addon.id } });
    expect(after.dependentCancellationState).toBe("RETRY_SCHEDULED");
    expect(after.dependentCancellationReasonCode).toBe("UNGRANTABLE_PROVIDER_ACTIVE");
    await sweep(space);
    expect(await condition()).toBe("OPEN");

    // The provider confirms the stop.
    await c.prisma.workspaceStorageAddon.update({ where: { id: addon.id }, data: { dependentCancellationLeaseUntilUtc: null } });
    await attemptDependentCancellations({
      ownerUserId: payer.id,
      teamId: null,
      cancelAtProvider: async ({ mode }) => ({ ok: true, mode, terminal: true }),
    });
    expect((await c.prisma.workspaceStorageAddon.findUniqueOrThrow({ where: { id: addon.id } })).dependentCancellationState).toBe("CONFIRMED");
    await sweep(space);
    expect(await condition()).toBe("RESOLVED");
  });
});
