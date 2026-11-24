/**
 * Team remediation — Stage D (2026-11-24): the Review reads the one Review
 * experience renders. Each case fails on the stage D base (0a42aaaa1).
 *
 *   T-086  a queue row names its assignee (display name, else MASKED e-mail);
 *          the assignable-reviewer picker carries the masked e-mail; the Review
 *          page projection names the assignee — never a full address.
 *   T-085  Monitoring's reviewer-performance rows name the reviewer.
 *   T-096  the Inbox order puts an overdue NORMAL review before an on-track
 *          HIGH one (the deadline first, then priority).
 *   T-083  an automatic escalation is written in catalog copy (no "reconcile"),
 *          and an inbox item for an OLD row with the engine's English reads the
 *          catalog words (the stored row is not rewritten).
 *   T-080  a Copilot run without output (policy denied) is not offered for QC.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, seedUser, type FixtureDeps, type PersonalTenant, type SeededUser } from "./point7/product-fixtures.js";

describe("Stage D — review reads (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let engine: typeof import("../src/services/reviewer-ops/reviewer-operations-engine.service.js");
  let deps: FixtureDeps;
  let team: PersonalTenant;
  let member: SeededUser;

  async function call(token: string, method: "GET" | "POST", url: string, payload?: unknown) {
    const res = await h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { payload: JSON.stringify(payload) } : {}),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  async function review(teamId: string, ownerUserId: string, data: Record<string, unknown> = {}) {
    const t = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: { ownerUserId, teamId, organizationId: t.organizationId, type: "PHOTO" },
      select: { id: true },
    });
    return prisma.evidenceReviewWorkflow.create({
      data: { evidenceId: ev.id, teamId, workspaceType: "TEAM", status: "ASSIGNED", ...data } as never,
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    engine = await import("../src/services/reviewer-ops/reviewer-operations-engine.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `trd-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authAt: Math.floor(Date.now() / 1000), authMethod: "PASSWORD" } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    team = await seedPersonalTenant(deps, "TEAM");
    // A member with NO display name: named by the masked e-mail.
    member = await seedUser(deps, "member");
    await prisma.teamMember.create({
      data: { teamId: team.personalTeamId, userId: member.userId, role: "MEMBER", status: "ACTIVE" } as never,
    });
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  const masked = (email: string) => `${email.slice(0, 1)}***@${email.split("@")[1]}`;

  it("T-086 — a queue row names its assignee by the masked e-mail; the picker and the Review page say the same; no full address", async () => {
    const teamId = team.personalTeamId;
    const wf = await review(teamId, team.owner.userId, { assignedToUserId: member.userId, assignedAtUtc: new Date() });
    const unassigned = await review(teamId, team.owner.userId, { status: "NOT_STARTED" });

    const queue = await call(team.owner.token, "GET", `/v1/reviewer-ops/queue?teamId=${teamId}&queue=OVERDUE&limit=100`);
    expect(queue.status).toBe(200);
    const all = await call(team.owner.token, "GET", `/v1/reviewer-ops/queue?teamId=${teamId}&queue=UNASSIGNED&limit=100`);
    const unassignedRow = (all.body.rows as Array<Record<string, unknown>>).find((r) => r.workflowId === unassigned.id)!;
    expect(unassignedRow.assignee).toBeNull();

    // A workflow is in no slice by default unless it matches; read it through the
    // high-priority slice by marking it.
    await prisma.evidenceReviewWorkflow.update({ where: { id: wf.id }, data: { priority: "HIGH" } as never });
    const high = await call(team.owner.token, "GET", `/v1/reviewer-ops/queue?teamId=${teamId}&queue=HIGH_PRIORITY&limit=100`);
    const row = (high.body.rows as Array<Record<string, unknown>>).find((r) => r.workflowId === wf.id)!;
    expect(row.assignee).toEqual({ displayName: null, maskedEmail: masked(member.email) });
    expect(JSON.stringify(high.body)).not.toContain(member.email);

    const picker = await call(team.owner.token, "GET", `/v1/reviewer-ops/assignable-reviewers?teamId=${teamId}`);
    expect(picker.status).toBe(200);
    const pick = (picker.body.reviewers as Array<Record<string, unknown>>).find((r) => r.userId === member.userId);
    expect(pick?.maskedEmail).toBe(masked(member.email));
    expect(JSON.stringify(picker.body)).not.toContain(member.email);

    const ws = await call(team.owner.token, "GET", `/v1/reviewer-ops/workspace/${wf.id}?teamId=${teamId}`);
    expect(ws.status).toBe(200);
    const projection = ws.body.projection as Record<string, unknown>;
    expect(projection.assignedToMaskedEmail).toBe(masked(member.email));
    expect(projection.assignedToDisplayName).toBeNull();
  });

  it("T-085 — reviewer performance rows name the reviewer", async () => {
    const teamId = team.personalTeamId;
    await review(teamId, team.owner.userId, { assignedToUserId: member.userId, assignedAtUtc: new Date() });
    const res = await call(team.owner.token, "GET", `/v1/reviewer-ops/analytics/reviewers?teamId=${teamId}&rangeDays=14&limit=20`);
    expect(res.status).toBe(200);
    const rows = res.body.rows as Array<Record<string, unknown>>;
    const mine = rows.find((r) => r.reviewerUserId === member.userId);
    expect(mine).toBeTruthy();
    expect(mine!.reviewerMaskedEmail).toBe(masked(member.email));
    expect(mine).toHaveProperty("reviewerDisplayName", null);
  });

  it("T-096 — an overdue NORMAL review sorts before an on-track HIGH review", async () => {
    const own = await seedPersonalTenant(deps, "TEAM");
    const teamId = own.personalTeamId;
    const past = new Date(Date.now() - 3 * 86400_000);
    const future = new Date(Date.now() + 5 * 86400_000);
    const onTrackHigh = await review(teamId, own.owner.userId, {
      assignedToUserId: own.owner.userId,
      priority: "HIGH",
      dueAt: future,
      slaStatus: "ON_TRACK",
    });
    const overdueNormal = await review(teamId, own.owner.userId, {
      assignedToUserId: own.owner.userId,
      priority: "NORMAL",
      dueAt: past,
      slaStatus: "OVERDUE",
    });
    const res = await call(own.owner.token, "GET", `/v1/reviewer-ops/queue?teamId=${teamId}&queue=MY_REVIEWS&limit=100`);
    expect(res.status).toBe(200);
    const ids = (res.body.rows as Array<{ workflowId: string }>).map((r) => r.workflowId);
    expect(ids.indexOf(overdueNormal.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(overdueNormal.id)).toBeLessThan(ids.indexOf(onTrackHigh.id));
  });

  it("T-083 — an automatic escalation is catalog copy; an old row's inbox body reads the catalog words", async () => {
    const own = await seedPersonalTenant(deps, "TEAM");
    const teamId = own.personalTeamId;
    const past = new Date(Date.now() - 24 * 3600_000);
    const wf = await review(teamId, own.owner.userId, {
      assignedToUserId: own.owner.userId,
      assignedAtUtc: new Date(Date.now() - 96 * 3600_000),
      dueAt: past,
      completionDueAtUtc: past,
      firstResponseDueAtUtc: past,
    });
    await engine.runReconcile({ teamId }, prisma as never);
    const esc = await prisma.reviewEscalation.findFirstOrThrow({ where: { teamId, workflowId: wf.id } });
    expect(esc.safeSummary).toBe("Review is past its deadline; raised automatically.");
    expect(esc.safeSummary).not.toMatch(/reconcile/i);

    // An escalation written before this change keeps its stored text…
    const legacy = await review(teamId, own.owner.userId, { assignedToUserId: own.owner.userId });
    const old = await prisma.reviewEscalation.create({
      data: {
        teamId,
        workflowId: legacy.id,
        evidenceId: legacy.evidenceId,
        reason: "REVIEW_OVERDUE",
        severity: "HIGH",
        status: "OPEN",
        safeSummary: "Review past due — automatic escalation by reviewer ops reconcile.",
        assignedToUserId: own.owner.userId,
        fingerprint: `legacy-${legacy.id}`,
      } as never,
    });
    const inbox = await call(own.owner.token, "GET", `/v1/me/inbox?teamId=${teamId}`);
    expect(inbox.status).toBe(200);
    const items = (inbox.body.items ?? []) as Array<Record<string, unknown>>;
    const item = items.find((i) => i.id === `review_escalation:${old.id}`);
    expect(item, "the old escalation is in the inbox").toBeTruthy();
    // …and reads the catalog words.
    expect(String(item!.body)).toBe("Review is past its deadline; raised automatically.");
    expect(JSON.stringify(item)).not.toMatch(/reconcile/i);
    const stored = await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: old.id } });
    expect(stored.safeSummary).toMatch(/reconcile/);
  });

  it("T-080 — a Copilot run without output (policy denied) is not offered for QC; a run with output is", async () => {
    const own = await seedPersonalTenant(deps, "TEAM");
    const teamId = own.personalTeamId;
    const base = {
      workspaceId: teamId,
      userId: own.owner.userId,
      feature: "REVIEWER_COPILOT",
      provider: "openai",
      model: "m",
      promptVersion: "p",
      systemPolicyVersion: "s",
      productKnowledgeVersion: "k",
      contextSchemaVersion: "c",
      outputSchemaVersion: "o",
      workspacePolicyVersion: 1,
      processingMode: "STANDARD",
      selectedObjectVersionsJson: [],
    };
    const denied = await prisma.aiCopilotRun.create({ data: { ...base, requestId: `${deps.tag}-denied`, status: "policy_denied" } as never });
    const ok = await prisma.aiCopilotRun.create({ data: { ...base, requestId: `${deps.tag}-ok`, status: "ok" } as never });
    const res = await call(own.owner.token, "GET", `/v1/ai/qc/samples?teamId=${teamId}&strategy=RANDOM`);
    expect(res.status).toBe(200);
    const ids = ((res.body.samples ?? []) as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(ok.id);
    expect(ids).not.toContain(denied.id);
  });
});
