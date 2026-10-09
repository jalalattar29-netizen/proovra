// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPERATIONS TRUTH CLOSURE — source-truth recovery, remediation and titles
 * (live PostgreSQL).
 *
 *   OPS-003  a personal storage add-on condition auto-resolves on provider
 *            truth (CONFIRMED, or the obligation withdrawn to NONE), refuses a
 *            manual close while live, and points at Billing — not "platform
 *            infrastructure". The team payer's condition auto-resolves too.
 *   OPS-023  each obligation state renders its own title, and says who pays.
 *   OPS-018  every PER_RECORD source that promises probe recovery is swept:
 *            OTS budget exhaustion, package denial, review escalation and
 *            identity-provider outage close when their source recovers, and
 *            a denial still in force stays open.
 *   OPS-031  remediation is keyed by SOURCE with record-specific links.
 *   OPS-033  distinct per-record conditions render distinct titles; an
 *            aggregate keeps its count-free label.
 *   OPS-013  "Retry after exhausted failure" is offered to an operator who
 *            holds operations.resolve, and to nobody else.
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

describe("Operations truth closure — recovery, remediation, titles (live PostgreSQL 16)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  async function addon(ownerUserId: string, teamId: string | null, state: string, reasonCode: string | null = null) {
    return c.prisma.workspaceStorageAddon.create({
      data: {
        ownerUserId,
        teamId,
        addonKey: teamId ? "TEAM_100_GB" : "PERSONAL_50_GB",
        extraStorageBytes: BigInt(100) * BigInt(1024) ** BigInt(3),
        billingCycle: "MONTHLY",
        paymentProvider: "STRIPE",
        dependentCancellationState: state,
        dependentCancellationReasonCode: reasonCode,
        dependentCancellationRequestedAtUtc: new Date(),
      },
    });
  }
  const addonCondition = (teamId: string, addonId: string) =>
    c.prisma.operationalIncident.findFirst({
      where: { teamId, fingerprint: `billing_dependent_cancellation:${addonId}` },
    });

  it("OPS-003 / OPS-023 a personal add-on: own title per state, no manual close while live, Billing link, closes on CONFIRMED", async () => {
    const u = await makeUser(c, "addon-personal", { plan: "PRO" });
    const space = await personalSpace(c, u.id);
    const a = await addon(u.id, null, "PENDING");

    await sweep(space);
    let row = await addonCondition(space, a.id);
    expect(row?.status).toBe("OPEN");
    const titleOf = async () =>
      (await c.inj("GET", `/v1/ops/incidents/${row!.id}?teamId=${space}`, u.token)).json();
    let d = await titleOf();
    expect(d.incident.title).toBe("Storage add-on cancellation in progress");
    expect(d.incident.safeSummary).toContain("You pay for this add-on on your personal account");

    await c.prisma.workspaceStorageAddon.update({ where: { id: a.id }, data: { dependentCancellationState: "RETRY_SCHEDULED", dependentCancellationReasonCode: "PROVIDER_UNAVAILABLE" } });
    await sweep(space);
    d = await titleOf();
    expect(d.incident.title).toBe("Storage add-on cancellation waiting for the payment provider");

    await c.prisma.workspaceStorageAddon.update({ where: { id: a.id }, data: { dependentCancellationState: "MANUAL_INTERVENTION", dependentCancellationReasonCode: "RETRY_EXHAUSTED" } });
    await sweep(space);
    d = await titleOf();
    expect(d.incident.title).toBe("Storage add-on still billing — support needed");
    // Source-keyed remediation: Billing owns it.
    expect(d.remediation.deepLink).toMatchObject({ href: "/billing", label: "Open Billing" });
    expect(d.remediation.guidance).toContain("Billing owns this");
    expect(JSON.stringify(d.remediation)).not.toContain("platform infrastructure");

    // Live: a manual close is refused, in every live state.
    const close = await c.inj("POST", `/v1/ops/incidents/${row!.id}/resolve`, u.token, { teamId: space });
    expect(close.statusCode).toBe(409);
    expect(close.json().error?.code ?? close.json().code).toBe("CONDITION_STILL_ACTIVE");

    // Provider truth closes it.
    await c.prisma.workspaceStorageAddon.update({ where: { id: a.id }, data: { dependentCancellationState: "CONFIRMED" } });
    await sweep(space);
    row = await addonCondition(space, a.id);
    expect(row?.status).toBe("RESOLVED");
  });

  it("OPS-003 a withdrawn obligation (NONE) closes the personal condition too", async () => {
    const u = await makeUser(c, "addon-withdrawn", { plan: "PRO" });
    const space = await personalSpace(c, u.id);
    const a = await addon(u.id, null, "ACTION_REQUIRED");
    await sweep(space);
    expect((await addonCondition(space, a.id))?.status).toBe("OPEN");
    await c.prisma.workspaceStorageAddon.update({ where: { id: a.id }, data: { dependentCancellationState: "NONE" } });
    await sweep(space);
    expect((await addonCondition(space, a.id))?.status).toBe("RESOLVED");
  });

  it("OPS-003 the team payer's condition says so and auto-closes on CONFIRMED", async () => {
    const owner = await makeUser(c, "addon-team");
    const w = await makeWorkspace(c, owner.id, { name: "addon-team", billingPlan: "TEAM" });
    const a = await addon(owner.id, w.teamId, "ACTION_REQUIRED");
    await sweep(w.teamId);
    const row = await addonCondition(w.teamId, a.id);
    expect(row?.status).toBe("OPEN");
    expect(row?.title).toBe("Storage add-on may still be billing");
    expect(row?.safeSummary).toContain("This workspace's billing owner pays for this add-on");
    await c.prisma.workspaceStorageAddon.update({ where: { id: a.id }, data: { dependentCancellationState: "CONFIRMED" } });
    await sweep(w.teamId);
    expect((await addonCondition(w.teamId, a.id))?.status).toBe("RESOLVED");
  });

  it("OPS-018 OTS budget exhaustion, review escalation and an identity-provider outage close when their source recovers", async () => {
    const a = c.h.fixtures.teamA;
    const owner = a.ownerUserId;
    // OTS: the record anchored after the budget bridge fired.
    const ev = await seedEvidence(c, a.teamId, owner, { otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date(), otsBitcoinTxid: "b".repeat(64) });
    const ots = await seedIncident(c, a.teamId, {
      sourceId: "evidence_integrity.ots_budget_exhausted",
      category: "WORKER",
      fingerprint: `OTS:${ev.id}:GLOBAL_BUDGET_EXHAUSTED`,
      relatedEvidenceId: ev.id,
    });
    // Review escalation whose escalation was resolved, on a workflow still in
    // review; and one whose escalation is still OPEN, which must stay open.
    const ev2 = await seedEvidence(c, a.teamId, owner);
    const wf = await c.prisma.evidenceReviewWorkflow.create({
      data: { evidenceId: ev2.id, teamId: a.teamId, workspaceType: "TEAM", status: "ESCALATED" },
    });
    await c.prisma.reviewEscalation.create({
      data: { teamId: a.teamId, workflowId: wf.id, reason: "REVIEW_OVERDUE", status: "RESOLVED", safeSummary: "ops-truth", fingerprint: `ops-truth-esc-${wf.id}-1` },
    });
    const esc = await seedIncident(c, a.teamId, {
      sourceId: "review.escalation",
      category: "GOVERNANCE",
      fingerprint: `review-escalation:REVIEW_OVERDUE:${wf.id}`,
    });
    const ev3 = await seedEvidence(c, a.teamId, owner);
    const wfLive = await c.prisma.evidenceReviewWorkflow.create({
      data: { evidenceId: ev3.id, teamId: a.teamId, workspaceType: "TEAM", status: "ESCALATED" },
    });
    await c.prisma.reviewEscalation.create({
      data: { teamId: a.teamId, workflowId: wfLive.id, reason: "REVIEW_OVERDUE", status: "OPEN", safeSummary: "ops-truth", fingerprint: `ops-truth-esc-${wfLive.id}-1` },
    });
    const escLive = await seedIncident(c, a.teamId, {
      sourceId: "review.escalation",
      category: "GOVERNANCE",
      fingerprint: `review-escalation:REVIEW_OVERDUE:${wfLive.id}`,
    });
    // Identity provider recovered (the first success clears the stamp).
    const sso = await c.prisma.ssoConnection.create({
      data: { teamId: a.teamId, provider: "GENERIC_OIDC", displayName: "ops-truth idp", createdByUserId: owner, outageDetectedAtUtc: null, status: "ACTIVE", allowedEmailDomains: [], updatedAt: new Date() },
    });
    const idp = await seedIncident(c, a.teamId, {
      sourceId: "identity.idp_outage",
      category: "IDENTITY_SECURITY",
      fingerprint: `idp-outage:${sso.id}`,
    });

    await sweep(a.teamId);
    for (const row of [ots, esc, idp]) {
      expect((await c.prisma.operationalIncident.findUnique({ where: { id: row.id } }))?.status, row.sourceId).toBe("RESOLVED");
    }
    // The escalation still OPEN keeps its condition open, even though the
    // workflow is not in one of the three statuses the old probe called open.
    expect((await c.prisma.operationalIncident.findUnique({ where: { id: escLive.id } }))?.status).toBe("OPEN");
  });

  it("OPS-018 a package denial closes when the record becomes eligible, and stays open while governance still denies", async () => {
    const a = c.h.fixtures.teamA;
    const eligible = await seedEvidence(c, a.teamId, a.ownerUserId, { lifecycleState: "ACTIVE" });
    const held = await seedEvidence(c, a.teamId, a.ownerUserId, { lifecycleState: "ON_HOLD" });
    const open = await Promise.all(
      [eligible, held].map((e) =>
        seedIncident(c, a.teamId, {
          sourceId: "pipeline.package_generation_denied",
          category: "GOVERNANCE",
          fingerprint: `worker_package_gate:${a.teamId}:${e.id}:BLOCKED_BY_LIFECYCLE`,
          relatedEvidenceId: e.id,
        }),
      ),
    );
    await sweep(a.teamId);
    const [nowEligible, stillHeld] = await Promise.all(
      open.map((r) => c.prisma.operationalIncident.findUnique({ where: { id: r.id } })),
    );
    expect(nowEligible?.status).toBe("RESOLVED");
    expect(stillHeld?.status).toBe("OPEN");

    // OPS-031 — the still-open denial links to ITS record.
    const d = (await c.inj("GET", `/v1/ops/incidents/${stillHeld!.id}?teamId=${a.teamId}`, a.ownerToken)).json();
    expect(d.remediation.deepLink.href).toBe(`/evidence/${held.id}?tab=artifacts`);
    expect(d.remediation.guidance).toContain("governance");
  });

  it("OPS-031 a review backlog points at Review, not at 'background processing'", async () => {
    const a = c.h.fixtures.teamA;
    const row = await seedIncident(c, a.teamId, {
      sourceId: "review.stale_workflows",
      category: "WORKER",
      fingerprint: `dashboard:review:stale_assignments:${a.teamId}`,
    });
    const d = (await c.inj("GET", `/v1/ops/incidents/${row.id}?teamId=${a.teamId}`, a.ownerToken)).json();
    expect(d.remediation.deepLink).toMatchObject({ href: "/review" });
    expect(d.remediation.guidance).not.toContain("Background processing");
  });

  it("OPS-033 distinct per-record conditions keep distinct titles; an aggregate keeps its count-free label", async () => {
    const a = c.h.fixtures.teamA;
    const rows = [
      await seedIncident(c, a.teamId, { sourceId: "governance.policy_condition", title: "Retention policy conflicts with an active legal hold" }),
      await seedIncident(c, a.teamId, { sourceId: "governance.policy_condition", title: "Export policy blocks a shared case (3)" }),
      await seedIncident(c, a.teamId, {
        sourceId: "pipeline.report_backlog",
        category: "REPORT",
        fingerprint: `dashboard:pipeline:report_backlog:ops-truth-${Date.now()}`,
        title: "Report backlog above threshold (26)",
      }),
    ];
    const titles: string[] = [];
    for (const row of rows) {
      const r = await c.inj("GET", `/v1/ops/incidents/${row.id}?teamId=${a.teamId}`, a.ownerToken);
      expect(r.statusCode).toBe(200);
      titles.push(r.json().incident.title);
    }
    expect(titles).toEqual([
      "Retention policy conflicts with an active legal hold",
      "Export policy blocks a shared case",
      "Report generation backlog",
    ]);
  });

  it("OPS-013 an exhausted report failure offers 'Retry after exhausted failure' to an operator with operations.resolve only", async () => {
    // A workspace whose records are entitled to reports — otherwise the
    // record's own decision is "nothing runs" and neither action is offered.
    const owner = await makeUser(c, "ops013-owner", { plan: "TEAM" });
    const viewerUser = await makeUser(c, "ops013-viewer");
    const w = await makeWorkspace(c, owner.id, { name: "ops013", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    await addMember(c, w.teamId, viewerUser.id, "VIEWER");
    const a = { teamId: w.teamId, ownerUserId: owner.id, ownerToken: owner.token, viewerToken: viewerUser.token };
    const ev = await seedEvidence(c, a.teamId, a.ownerUserId);
    // EXHAUSTED for real: the record's durable request spent its budget. The
    // offer is read from the record's own output decision, so a condition
    // that merely says "exhausted" over a record that is not is offered the
    // plain recovery instead (see operations-remediation-registry.test.ts).
    await c.prisma.reportGenerationRequest.create({
      data: {
        teamId: a.teamId,
        evidenceId: ev.id,
        artifactType: "REPORT",
        idempotencyKey: `REPORT:${ev.id}:v0`,
        state: "FAILED_TERMINAL",
        terminalReasonCode: "retry_budget_exhausted",
        attemptCount: 12,
      } as never,
    });
    const row = await seedIncident(c, a.teamId, {
      sourceId: "pipeline.report_generation_failed",
      category: "REPORT",
      fingerprint: `REPORT:${ev.id}:v1:RETRY_BUDGET_EXHAUSTED`,
      relatedEvidenceId: ev.id,
    });
    const actionsFor = async (token: string) =>
      ((await c.inj("GET", `/v1/ops/incidents/${row.id}?teamId=${a.teamId}`, token)).json().remediation?.actions ?? []).map(
        (x: { actionId: string }) => x.actionId,
      );
    // ONE primary action: the supersession, not the recovery beside it.
    expect(await actionsFor(a.ownerToken)).toEqual(["report.supersede_failed_generation"]);
    expect(await actionsFor(a.viewerToken)).not.toContain("report.supersede_failed_generation");
    const link = (await c.inj("GET", `/v1/ops/incidents/${row.id}?teamId=${a.teamId}`, a.ownerToken)).json().remediation.deepLink;
    expect(link.href).toBe(`/evidence/${ev.id}?tab=artifacts`);
  });
});
