/**
 * WS-SHELL remediation (RG-32 / RG-34) — behavioural regressions on live
 * PostgreSQL with the real route registration and the real services. Only the
 * webhook HTTP transport is stubbed (the provider boundary).
 *
 *   PRO-G1-06  API-key intake-link create follows record reach (AZ-R04).
 *   PRO-G1-03  API-key evidence list pages on the ORDER key: a walk returns
 *              every record exactly once; old UUID cursors still work.
 *   PRO-E1-02  Search: the legal-hold filter survives a text query.
 *   PRO-E1-04  Search: "Incident linked" narrows.
 *   PRO-G1-09  Integration + lifecycle webhooks of a suspended organization
 *              send nothing; they deliver after it resumes.
 *   PRO-G1-07  Re-enabling an auto-disabled webhook restarts its failure count.
 *   PRO-G1-11 / PRO-G2-11  Quotas: API keys of the proven workspace against
 *              the enforced limit.
 *   PRO-P1-04  /v1/ops/workflows rejects an unknown status with 400.
 *   PRO-P1C-01 Workflow action projection follows the routes' permissions.
 *   PRO-P1-05  Bulk recommendation dismissal needs the review domain's authority.
 *   PRO-P1C-02 Workflow writers compare-and-set; the bulk runner obeys the
 *              state machine.
 *   PRO-P1-06  Idempotency keys are reserved before the effect.
 *   PRO-G1-01  An unwired automation action ends SKIPPED, never SUCCEEDED.
 *   PRO-K2-13  Malformed list paging on group lists is a 400.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Tenant = { teamId: string; orgId: string; owner: Person };

describe("WS-SHELL remediation regressions (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let T: Tenant;
  let restrictedCaseId: string;
  let openCaseId: string;

  const tag = () => randomUUID().slice(0, 8);

  async function tenant(plan: "TEAM" | "ENTERPRISE", owner?: Person): Promise<Tenant> {
    const who = owner ?? (await kit.person(null));
    const org = await prisma.organization.create({
      data: { name: `ws-${tag()}`, billingOwnerUserId: who.id, status: "ACTIVE", kind: "CUSTOMER" } as never,
      select: { id: true },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, userId: who.id, role: "ORG_OWNER" } as never,
    });
    const team = await prisma.team.create({
      data: {
        name: `ws-${tag()}`,
        ownerUserId: who.id,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "ORGANIZATION",
        billingPlan: plan,
        billingStatus: "ACTIVE",
      } as never,
      select: { id: true },
    });
    await prisma.organizationSecurityPolicy.create({ data: { organizationId: org.id, teamId: team.id } as never });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: who.id, role: "OWNER", status: "ACTIVE" } as never });
    if (!owner) await prisma.user.update({ where: { id: who.id }, data: { currentWorkspaceId: team.id } as never });
    return { teamId: team.id, orgId: org.id, owner: who };
  }

  async function record(t: Tenant, title: string, createdAt?: Date): Promise<string> {
    return (
      await prisma.evidence.create({
        data: {
          title,
          displayFileName: `${title}.pdf`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: t.teamId,
          organizationId: t.orgId,
          ownerUserId: t.owner.id,
          sizeBytes: 1_000n,
          ...(createdAt ? { createdAt } : {}),
        } as never,
        select: { id: true },
      })
    ).id;
  }

  async function apiKey(t: Tenant, scopes: string[], limit = 5): Promise<string> {
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    await upsertEntitlementGrant({ teamId: t.teamId, key: "INTEGRATION_API_KEYS_MAX", value: limit, kind: "LIMIT", source: "CUSTOM", grantedByUserId: t.owner.id });
    const { createApiCredential } = await import("../src/services/integrations/api-keys.service.js");
    return (await createApiCredential({ teamId: t.teamId, name: `ws-${tag()}`, scopes, actorUserId: t.owner.id })).rawKey;
  }

  const withKey = (method: string, url: string, key: string, payload?: unknown) =>
    h.app.inject({
      method: method as never,
      url,
      headers: { authorization: `Bearer ${key}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = randomBytes(32).toString("hex");
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = process.env.API_KEY_SECRET ?? randomBytes(32).toString("hex");
    process.env.WEB_BASE_URL = "https://ws-shell.canonical.test";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    kit = await coverageKit(h);

    T = await tenant("TEAM");
    restrictedCaseId = (
      await prisma.case.create({
        data: { name: `R-${tag()}`, teamId: T.teamId, ownerUserId: T.owner.id, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      })
    ).id;
    // The key's creator (the owner) is ON the restricted case's list: the
    // defect evaluated the creator's reach, so this is the case that leaked.
    await prisma.caseAccess.create({ data: { caseId: restrictedCaseId, userId: T.owner.id } });
    openCaseId = (
      await prisma.case.create({
        data: { name: `O-${tag()}`, teamId: T.teamId, ownerUserId: T.owner.id } as never,
        select: { id: true },
      })
    ).id;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // PRO-G1-06
  // ===========================================================================
  it("PRO-G1-06: an API key cannot bind an intake link to a restricted case; it answers like a foreign case and writes nothing", async () => {
    const key = await apiKey(T, ["integration.intake_link.create"]);
    const body = (caseId: string) => ({
      workflowTemplateSlug: "general-evidence-record",
      intakeMode: "EXTERNAL_ONE_TIME",
      caseId,
      expiresAtUtc: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    });
    const before = await prisma.workflowIntakeLink.count({ where: { teamId: T.teamId, caseId: restrictedCaseId } });
    const closed = await withKey("POST", "/v1/integrations/api/intake-links", key, body(restrictedCaseId));
    const foreign = await withKey("POST", "/v1/integrations/api/intake-links", key, body(randomUUID()));
    expect(closed.statusCode, closed.body).toBe(404);
    expect(closed.json()).toEqual(foreign.json());
    expect(await prisma.workflowIntakeLink.count({ where: { teamId: T.teamId, caseId: restrictedCaseId } })).toBe(before);

    const open = await withKey("POST", "/v1/integrations/api/intake-links", key, body(openCaseId));
    expect(open.statusCode, open.body).toBe(201);
  });

  // ===========================================================================
  // PRO-G1-03
  // ===========================================================================
  it("PRO-G1-03: walking the API-key evidence list returns every record exactly once; a bare-UUID cursor still continues; a malformed cursor is 400", async () => {
    const W = await tenant("TEAM");
    const key = await apiKey(W, ["integration.evidence.read"]);
    const base = Date.now() - 3_600_000;
    const ids: string[] = [];
    // 23 records, several sharing one createdAt (ties are the hard case), and
    // random UUIDs unrelated to time order.
    for (let i = 0; i < 23; i += 1) ids.push(await record(W, `walk-${i}`, new Date(base + Math.floor(i / 3) * 1000)));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 20; pages += 1) {
      const res = await withKey("GET", `/v1/integrations/api/evidence?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, key);
      expect(res.statusCode, res.body).toBe(200);
      const json = res.json() as { evidence: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...json.evidence.map((e) => e.id));
      cursor = json.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length); // no repeats
    expect([...seen].sort()).toEqual([...ids].sort()); // no omissions

    // An integration holding an old cursor (a bare record id) continues from it.
    const first = (await withKey("GET", "/v1/integrations/api/evidence?limit=5", key)).json() as { evidence: Array<{ id: string }> };
    const legacy = await withKey("GET", `/v1/integrations/api/evidence?limit=50&cursor=${first.evidence[4]!.id}`, key);
    expect(legacy.statusCode, legacy.body).toBe(200);
    const rest = (legacy.json() as { evidence: Array<{ id: string }> }).evidence.map((e) => e.id);
    expect(rest).toEqual(seen.slice(5));

    const bad = await withKey("GET", "/v1/integrations/api/evidence?cursor=not-a-cursor", key);
    expect(bad.statusCode, bad.body).toBe(400);
  });

  // ===========================================================================
  // PRO-E1-02 / PRO-E1-04
  // ===========================================================================
  describe("search filters compose with the text query", () => {
    let held: string;
    let notHeld: string;
    let linked: string;
    const term = `zebra${tag()}`;

    beforeAll(async () => {
      held = await record(T, `${term}-held`);
      notHeld = await record(T, `${term}-open`);
      linked = await record(T, `${term}-incident`);
      for (const id of [held, notHeld, linked]) {
        await prisma.evidenceSearchDocument.create({
          data: {
            teamId: T.teamId,
            documentType: "EVIDENCE",
            sourceId: id,
            evidenceId: id,
            title: `${term} ${id.slice(0, 6)}`,
            searchableText: term,
            sourceUpdatedAtUtc: new Date(),
          } as never,
        });
      }
      await prisma.evidenceLegalHold.create({
        data: { teamId: T.teamId, evidenceId: held, scope: "EVIDENCE", title: "ws hold", status: "ACTIVE", placedByUserId: T.owner.id } as never,
      });
      await prisma.operationalIncident.create({
        data: {
          teamId: T.teamId,
          category: "REPORT",
          fingerprint: `ws-${tag()}`,
          title: "ws incident",
          safeSummary: "ws incident",
          relatedEvidenceId: linked,
        } as never,
      });
    });

    const search = (qs: string) => kit.call("GET", `/v1/search?teamId=${T.teamId}&q=${term}&${qs}`, T.owner);

    it("PRO-E1-02: q + onLegalHold returns only the held match", async () => {
      const res = await search("onLegalHold=true");
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toContain(held);
      expect(res.body).not.toContain(notHeld);
      expect(res.body).not.toContain(linked);
    });

    it("PRO-E1-04: incidentLinked=true narrows to records an incident names; false excludes them", async () => {
      const on = await search("incidentLinked=true");
      expect(on.statusCode, on.body).toBe(200);
      expect(on.body).toContain(linked);
      expect(on.body).not.toContain(held);
      const off = await search("incidentLinked=false");
      expect(off.body).not.toContain(linked);
      expect(off.body).toContain(held);
    });
  });

  // ===========================================================================
  // PRO-G1-09 / B7B-F02 and PRO-G1-07
  // ===========================================================================
  describe("webhook egress follows workspace liveness", () => {
    it("PRO-G1-09: a suspended organization's due integration delivery is deferred without any request, and delivers after resume", async () => {
      const S = await tenant("ENTERPRISE");
      const { createWebhookEndpoint } = await import("../src/services/integrations/webhooks.service.js");
      const { __setWebhookHttpClientForTests } = await import("../src/services/integrations/webhook-dispatcher.js");
      const { processDueWebhookRetries } = await import("../src/services/integrations/webhook-retry-processor.js");
      const { endpoint } = await createWebhookEndpoint({
        teamId: S.teamId,
        url: `https://203.0.113.10/ws-shell/${tag()}`,
        eventTypes: [],
        actorUserId: S.owner.id,
      });
      const delivery = await prisma.integrationWebhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          teamId: S.teamId,
          eventId: randomUUID(),
          eventType: "evidence.completed",
          payloadJson: { event: "evidence.completed" },
          status: "RETRY_SCHEDULED",
          attemptCount: 0,
          nextAttemptAtUtc: new Date(Date.now() - 1000),
        } as never,
      });
      await prisma.organization.update({ where: { id: S.orgId }, data: { status: "SUSPENDED" } as never });

      const calls: string[] = [];
      const restore = __setWebhookHttpClientForTests(async (req) => {
        calls.push(req.url);
        return { status: 200, bodyPreview: null, errorMessage: null } as never;
      });
      try {
        await processDueWebhookRetries({ batchSize: 500 });
        expect(calls.filter((u) => u === endpoint.url)).toEqual([]);
        const deferred = await prisma.integrationWebhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
        expect(deferred.status).toBe("RETRY_SCHEDULED");
        expect(deferred.attemptCount).toBe(0);
        expect(deferred.errorMessage).toBe("workspace_not_operating");
        expect(deferred.nextAttemptAtUtc!.getTime()).toBeGreaterThan(Date.now());

        // Resume: the same row, once due again, is delivered.
        await prisma.organization.update({ where: { id: S.orgId }, data: { status: "ACTIVE" } as never });
        await prisma.integrationWebhookDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAtUtc: new Date(Date.now() - 1000) } });
        await processDueWebhookRetries({ batchSize: 500 });
        expect(calls.filter((u) => u === endpoint.url)).toHaveLength(1);
      } finally {
        restore();
      }
    });

    it("PRO-G1-09: a lifecycle delivery queued before a suspension is not sent by the worker", async () => {
      const S = await tenant("ENTERPRISE");
      const ep = await prisma.lifecycleWebhookEndpoint.create({
        data: {
          teamId: S.teamId,
          url: `https://203.0.113.10/ws-life/${tag()}`,
          secret: Buffer.from(randomUUID()).toString("base64"),
          subscribedEvents: ["EVIDENCE_CREATED"],
          state: "ACTIVE",
          createdByUserId: S.owner.id,
        } as never,
        select: { id: true, url: true },
      });
      const d = await prisma.lifecycleWebhookDelivery.create({
        data: { teamId: S.teamId, endpointId: ep.id, eventKind: "EVIDENCE_CREATED", payload: { evidenceId: randomUUID() }, signature: "", state: "PENDING" } as never,
        select: { id: true },
      });
      await prisma.organization.update({ where: { id: S.orgId }, data: { status: "SUSPENDED" } as never });
      const dispatcher = await import("../../worker/src/webhook-dispatcher.js");
      const calls: string[] = [];
      await dispatcher.runWebhookDispatcherTick({
        fetcher: (async (url: string) => {
          calls.push(url);
          return { status: 200, text: async () => "" };
        }) as never,
      });
      expect(calls).not.toContain(ep.url);
      const row = await prisma.lifecycleWebhookDelivery.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.state).toBe("RETRYING");
      expect(row.attemptCount).toBe(0);
    });

    it("PRO-G1-07: re-enabling a disabled endpoint restarts its failure count; an ACTIVE→ACTIVE update does not", async () => {
      const { createWebhookEndpoint, updateWebhookEndpoint } = await import("../src/services/integrations/webhooks.service.js");
      const { endpoint } = await createWebhookEndpoint({
        teamId: T.teamId,
        url: `https://203.0.113.10/ws-reenable/${tag()}`,
        eventTypes: [],
        actorUserId: T.owner.id,
      });
      await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { status: "DISABLED", failureCount: 20 } });
      const enabled = await updateWebhookEndpoint({ id: endpoint.id, teamId: T.teamId, status: "ACTIVE" });
      expect(enabled.failureCount).toBe(0);
      await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { failureCount: 7 } });
      const again = await updateWebhookEndpoint({ id: endpoint.id, teamId: T.teamId, status: "ACTIVE" });
      expect(again.failureCount).toBe(7);
    });
  });

  // ===========================================================================
  // PRO-G1-11 / PRO-G2-11
  // ===========================================================================
  it("PRO-G1-11 / PRO-G2-11: Quotas counts the proven workspace's keys against the enforced limit, not every owned workspace's", async () => {
    const Q = await tenant("ENTERPRISE");
    await apiKey(Q, ["integration.evidence.read"], 3);
    const other = await tenant("ENTERPRISE", Q.owner); // same owner, second workspace
    await apiKey(other, ["integration.evidence.read"], 3);
    await apiKey(other, ["integration.evidence.read"], 3);
    const res = await h.app.inject({ method: "GET", url: "/v1/quotas", headers: { authorization: `Bearer ${Q.owner.token}` } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.apiKeys).toEqual({ limit: 3, used: 1, remaining: 2 });
  });

  // ===========================================================================
  // Operations workbench — PRO-P1-04, PRO-P1C-01, PRO-P1-05
  // ===========================================================================
  describe("Operations workbench", () => {
    let workflowId: string;

    beforeAll(async () => {
      // T is a TEAM workspace with ONE active member (its owner): it has the
      // workbench, and assignment needs somebody to assign to (not shared).
      workflowId = (
        await prisma.operationalWorkflow.create({
          data: { teamId: T.teamId, workflowKey: `ws-${tag()}`, workflowType: "REPORT_RETRY", title: "ws workflow", safeSummary: "ws workflow" } as never,
          select: { id: true },
        })
      ).id;
    });

    it("PRO-P1-04: an unknown status or type filter is a 400, not a 500", async () => {
      for (const qs of ["status=NOPE", "workflowType=NOPE"]) {
        const res = await kit.call("GET", `/v1/ops/workflows?teamId=${T.teamId}&${qs}`, T.owner);
        expect(res.statusCode, `${qs} ${res.body}`).toBe(400);
      }
      const ok = await kit.call("GET", `/v1/ops/workflows?teamId=${T.teamId}&status=OPEN`, T.owner);
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("PRO-P1C-01: the projection offers what the routes allow — Start yes, Assign/Escalate not in a single-member workspace", async () => {
      const res = await kit.call("GET", `/v1/ops/workflows?teamId=${T.teamId}`, T.owner);
      expect(res.statusCode, res.body).toBe(200);
      const wf = (res.json().workflows as Array<{ id: string; projection: { actions: Array<{ action: string; available: boolean; reason: string | null; permission: string }> } }>).find((w) => w.id === workflowId)!;
      const by = Object.fromEntries(wf.projection.actions.map((a) => [a.action, a]));
      expect(by.start!.available).toBe(true);
      expect(by.start!.permission).toBe("operations.acknowledge");
      expect(by.assign!.available).toBe(false);
      expect(by.assign!.reason).toBe("CAPABILITY_REQUIRED");
      expect(by.escalate!.available).toBe(false);
      // The route agrees: assign is refused for the same missing capability.
      const assign = await kit.call("POST", `/v1/ops/workflows/${workflowId}/assign`, T.owner, { teamId: T.teamId, assigneeUserId: T.owner.id });
      expect(assign.statusCode, assign.body).toBe(403);
    });

    it("PRO-P1-05: dismissing reviewer routing recommendations needs the plan's REVIEW_ASSIGNMENTS — refused on a shared FREE workspace and nothing changes", async () => {
      // A shared (2-member) FREE workspace HAS the Operations workbench (a
      // shared workspace qualifies) but its plan has no review assignment.
      const F = await tenant("TEAM");
      await kit.person(F.teamId, "MEMBER");
      await prisma.team.update({ where: { id: F.teamId }, data: { billingPlan: "FREE", billingStatus: "INACTIVE" } as never });
      const rec = await prisma.reviewerRoutingRecommendation.create({
        data: { teamId: F.teamId, recommendationType: "REASSIGN", reasonCode: "WS_TEST", explanation: "ws", recommendationKey: `ws-${tag()}` } as never,
        select: { id: true },
      });
      const res = await kit.call("POST", "/v1/ops/bulk-actions", F.owner, {
        teamId: F.teamId,
        actionType: "BULK_DISMISS_RECOMMENDATIONS",
        targetIds: [rec.id],
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe("ENTITLEMENT_REQUIRED");
      expect(res.json().error.entitlement).toBe("REVIEW_ASSIGNMENTS");
      expect((await prisma.reviewerRoutingRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("OPEN");
    });
  });
  // ===========================================================================
  // PRO-P1C-02 / PRO-P1-06 — the writers and the reservations
  // ===========================================================================
  describe("workflow writers and idempotency reservations", () => {
    const newWorkflow = async (status: "OPEN" | "RESOLVED" = "OPEN") =>
      (
        await prisma.operationalWorkflow.create({
          data: { teamId: T.teamId, workflowKey: `ws-${tag()}`, workflowType: "REPORT_RETRY", title: "w", safeSummary: "w", status } as never,
        })
      ).id;

    it("PRO-P1C-02: two concurrent escalations apply once; the other is a stale-state refusal", async () => {
      const id = await newWorkflow();
      const { escalateWorkflow } = await import("../src/services/observability/workflow.service.js");
      const results = await Promise.allSettled(
        [0, 1].map(() => escalateWorkflow({ workflowId: id, teamId: T.teamId, actorUserId: T.owner.id })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect((lost.reason as { code: string }).code).toBe("stale_workflow_state");
      expect((await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id } })).escalationLevel).toBe(1);
    });

    it("PRO-P1C-02: the bulk runner refuses to resolve an already RESOLVED workflow (invalid_transition), writing nothing", async () => {
      const id = await newWorkflow("RESOLVED");
      const before = await prisma.operationalWorkflowEvent.count({ where: { workflowId: id } });
      const { runBulkAction } = await import("../src/services/dashboard/bulk-actions.service.js");
      const run = await runBulkAction({ teamId: T.teamId, actionType: "BULK_RESOLVE_WORKFLOWS", targetIds: [id], note: "again", actorUserId: T.owner.id });
      expect(run.failed).toBe(1);
      const item = await prisma.bulkOperationalActionItem.findFirstOrThrow({ where: { runId: run.runId } });
      expect(item.errorCode).toBe("invalid_transition");
      expect(await prisma.operationalWorkflowEvent.count({ where: { workflowId: id } })).toBe(before);
    });

    it("PRO-P1-06: two concurrent bulk runs with one key fan out once", async () => {
      const ids = [await newWorkflow(), await newWorkflow()];
      const { runBulkAction, BulkIdempotencyReplay } = await import("../src/services/dashboard/bulk-actions.service.js");
      const token = `BULK_ADD_MITIGATION:${tag()}-key`;
      const results = await Promise.allSettled(
        [0, 1].map(() =>
          runBulkAction({ teamId: T.teamId, actionType: "BULK_ADD_MITIGATION", targetIds: ids, note: "mitigated", actorUserId: T.owner.id, idempotencyToken: token }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(BulkIdempotencyReplay);
      expect(await prisma.bulkOperationalActionRun.count({ where: { teamId: T.teamId, idempotencyToken: token } })).toBe(1);
      for (const id of ids) {
        expect(await prisma.operationalWorkflowEvent.count({ where: { workflowId: id, eventType: "MITIGATION_ADDED" } })).toBe(1);
      }
    });

    it("PRO-P1-06: a workflow action key is reserved once; a released reservation lets a retry run", async () => {
      const id = await newWorkflow();
      const svc = await import("../src/services/observability/workflow-actions.service.js");
      const reserve = () =>
        svc.reserveWorkflowActionIdempotency({ workflowId: id, teamId: T.teamId, action: "escalate", idempotencyKey: "same-key-123", actorUserId: T.owner.id, currentStatus: "OPEN" });
      const both = await Promise.all([reserve(), reserve()]);
      expect(both.map((r) => r.kind).sort()).toEqual(["replay", "reserved"]);
      const reserved = both.find((r) => r.kind === "reserved") as { kind: "reserved"; markerId: string };
      await svc.releaseWorkflowActionIdempotency(reserved.markerId);
      expect((await reserve()).kind).toBe("reserved");
    });
  });

  // ===========================================================================
  // PRO-G1-01
  // ===========================================================================
  it("PRO-G1-01: an unwired action (NOTIFY_USER) is not reported as performed; the run ends SKIPPED action_not_implemented", async () => {
    const { executeAutomationAction } = await import("../src/services/automation/automation-actions.service.js");
    const result = await executeAutomationAction({
      teamId: T.teamId,
      ruleId: randomUUID(),
      runId: randomUUID(),
      actionType: "NOTIFY_USER",
      actionConfig: { userId: T.owner.id, template: "hold_placed" },
      triggerType: "LEGAL_HOLD_CREATED",
      targetType: "EVIDENCE",
      targetId: randomUUID(),
      context: {},
    } as never);
    expect(result.executed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("action_not_implemented");
  });

  // ===========================================================================
  // PRO-K2-13
  // ===========================================================================
  it("PRO-K2-13: malformed paging on a group's activity and assignments is a 400; valid paging is 200", async () => {
    const group = await prisma.collaborationTeam.create({
      data: { workspaceId: T.teamId, name: `ws-${tag()}`, createdByUserId: T.owner.id, status: "ACTIVE" } as never,
      select: { id: true },
    });
    await prisma.collaborationTeamMember.create({ data: { teamId: group.id, userId: T.owner.id, status: "ACTIVE", role: "LEAD" } as never });
    for (const url of [
      `/v1/collaboration-teams/${group.id}/activity?limit=abc`,
      `/v1/collaboration-teams/${group.id}/activity?cursor=nope`,
      `/v1/collaboration-teams/${group.id}/assignments?limit=abc`,
      `/v1/collaboration-teams/${group.id}/assignments?assignee=nope`,
    ]) {
      const res = await kit.call("GET", url, T.owner);
      expect(res.statusCode, `${url} ${res.body}`).toBe(400);
    }
    // Integration: PRO-K2-19 (WS-WSP) retired activity/v2 to a typed 410 tombstone, so
    // its malformed dates can no longer reach Prisma; the refusal is the tombstone.
    const retired = await kit.call("GET", `/v1/collaboration-teams/${group.id}/activity/v2?since=not-a-date`, T.owner);
    expect(retired.statusCode, retired.body).toBe(410);
    const ok = await kit.call("GET", `/v1/collaboration-teams/${group.id}/activity?limit=10`, T.owner);
    expect(ok.statusCode, ok.body).toBe(200);
  });
});
