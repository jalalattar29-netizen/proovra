/**
 * Source review D (2026-11-27) — an information request keeps its FULL
 * accepted reason. It accepts up to REVIEW_DECISION_RATIONALE_MAX (4000)
 * characters, writes no decision row, and its event `note` column is
 * VARCHAR(1000): the full reason is stored in the event value and every
 * history read returns it. Real routes, real PostgreSQL.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let requiredLegalVersions: Record<string, unknown>;
let ensurePersonalWorkspace: typeof import("../src/services/platform-context/workspace-bootstrap.service.js").ensurePersonalWorkspace;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };
type Actor = { userId: string; token: string };

async function call(token: string, method: "GET" | "POST", url: string, payload?: unknown): Promise<Res> {
  const res = await harness.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  await harness.handlersSettled();
  return { status: res.statusCode, body, raw: res.body };
}

let seq = 0;
async function newUser(label: string): Promise<Actor> {
  seq += 1;
  const email = `rinfo-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "RInfo", lastName: label, displayName: `RInfo ${label}`, provider: "EMAIL", providerUserId: email },
    select: { id: true },
  });
  await prisma.userLegalAcceptance.createMany({
    data: Object.entries(requiredLegalVersions).map(([policyKey, policyVersion]) => ({
      userId: user.id,
      policyKey,
      policyVersion: policyVersion as string,
      source: "integration-harness",
    })),
  });
  return { userId: user.id, token: await harness.mintSessionToken(user.id, email) };
}

let teamId: string;
let owner: Actor;
let member: Actor;

async function inReview(assignee: string, opts: { hold?: boolean } = {}) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title: `rinfo ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "CREATED", teamId, organizationId: t.organizationId, ownerUserId: owner.userId },
      select: { id: true },
    })
  ).id;
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId, status: "IN_REVIEW", workspaceType: "TEAM", assignedToUserId: assignee, assignedAtUtc: new Date() } as never,
      select: { id: true },
    })
  ).id;
  if (opts.hold) {
    await prisma.evidenceLegalHold.create({
      data: { scope: "EVIDENCE", evidenceId, teamId, status: "ACTIVE", title: "Hold", placedByUserId: owner.userId } as never,
    });
  }
  return { evidenceId, workflowId };
}

const decide = (a: Actor, wf: string, decision: string, rationale: string) =>
  call(a.token, "POST", `/v1/reviewer-ops/workspace/${wf}/decisions`, { teamId, decision, rationale });
const requestInfoDoor = (a: Actor, wf: string, note: string) =>
  call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/request-info`, { teamId, note });
const evidenceDoor = (a: Actor, evidenceId: string, note: string) =>
  call(a.token, "POST", `/v1/review-operations/evidence/${evidenceId}/decision`, { decision: "REQUEST_MORE_INFO", note });
const lineage = (a: Actor, wf: string) => call(a.token, "GET", `/v1/reviewer-ops/workspace/${wf}/decisions?teamId=${teamId}`);
const eventsFeed = (a: Actor, evidenceId: string) => call(a.token, "GET", `/v1/evidence/${evidenceId}/reviewer-workflow/events`);

/** A reason of exactly `n` characters, Arabic and multiline, never trimmed at its ends. */
function reasonOf(n: number): string {
  const unit = "يرجى رفع الملف الأصلي مع البيانات الوصفية.\nPlease upload the original file. ";
  let s = "";
  while (s.length < n) s += unit;
  s = s.slice(0, n - 1) + "X";
  return s;
}

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
  owner = await newUser("owner");
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan: "TEAM" } });
  teamId = space.teamId;
  member = await newUser("member");
  await prisma.teamMember.create({ data: { teamId, userId: member.userId, role: "MEMBER", status: "ACTIVE" } });
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe("source review D — the full information-request reason is kept", () => {
  for (const n of [999, 1000, 1001, 2500, 4000]) {
    it(`a ${n}-character Arabic/multiline reason is stored and read back in full (decisions door)`, async () => {
      const r = await inReview(member.userId);
      const reason = reasonOf(n);
      const res = await decide(member, r.workflowId, "REQUEST_INFO", reason);
      expect(res.status, res.raw).toBe(201);
      // No decision row; the event value holds the whole reason; the note is a bounded, marked summary.
      expect(await prisma.workflowReviewDecision.count({ where: { workflowId: r.workflowId } })).toBe(0);
      const ev = await prisma.evidenceReviewWorkflowEvent.findFirstOrThrow({ where: { workflowId: r.workflowId, eventType: "NEEDS_MORE_INFO" } });
      expect((ev.nextValue as { reason?: string }).reason).toBe(reason);
      expect((ev.note ?? "").length).toBeLessThanOrEqual(1000);
      if (n > 1000) expect(ev.note).toMatch(/shortened; the full reason is kept with the request\)$/);
      else expect(ev.note).toBe(reason);
      // History API and the Evidence event feed return the full reason.
      const hist = await lineage(owner, r.workflowId);
      expect(hist.status, hist.raw).toBe(200);
      expect(hist.body.informationRequests).toHaveLength(1);
      expect(hist.body.informationRequests[0].reason).toBe(reason);
      const feed = await eventsFeed(owner, r.evidenceId);
      expect(feed.status, feed.raw).toBe(200);
      const item = (feed.body.items as Array<{ eventType: string; note: string | null }>).find((i) => i.eventType === "NEEDS_MORE_INFO");
      expect(item?.note).toBe(reason);
    });
  }

  it("refuses 4001 characters on every door, recording nothing", async () => {
    const r = await inReview(member.userId);
    const tooLong = reasonOf(4001);
    for (const res of [
      await decide(member, r.workflowId, "REQUEST_INFO", tooLong),
      await requestInfoDoor(member, r.workflowId, tooLong),
      await evidenceDoor(member, r.evidenceId, tooLong),
    ]) {
      expect(res.status, res.raw).toBeGreaterThanOrEqual(400);
      expect(res.raw).toContain("rationale_too_long");
    }
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: r.workflowId, eventType: "NEEDS_MORE_INFO" } })).toBe(0);
    expect(String((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: r.workflowId } })).status)).toBe("IN_REVIEW");
  });

  it("the legacy request-info door and the Evidence-page door (mobile) keep the full reason too", async () => {
    const a = await inReview(member.userId);
    const reasonA = reasonOf(3333);
    expect((await requestInfoDoor(member, a.workflowId, reasonA)).status).toBe(200);
    expect((await lineage(owner, a.workflowId)).body.informationRequests[0].reason).toBe(reasonA);

    const b = await inReview(member.userId);
    const reasonB = reasonOf(1777);
    const res = await evidenceDoor(member, b.evidenceId, reasonB);
    expect(res.status, res.raw).toBe(200);
    expect((await lineage(owner, b.workflowId)).body.informationRequests[0].reason).toBe(reasonB);
  });

  it("after a pinned FIRST decision the request supersedes it, carries the requirement, and keeps its full reason; a replay records nothing", async () => {
    const r = await inReview(member.userId, { hold: true });
    expect((await decide(member, r.workflowId, "APPROVE", "complete")).status).toBe(201);
    const reason = reasonOf(2048);
    const res = await decide(member, r.workflowId, "REQUEST_INFO", reason);
    expect(res.status, res.raw).toBe(201);
    const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: r.workflowId } });
    expect(wf.decisionRound).toBe(1);
    expect(String(wf.status)).toBe("NEEDS_INFO");
    const ev = await prisma.evidenceReviewWorkflowEvent.findFirstOrThrow({ where: { workflowId: r.workflowId, eventType: "NEEDS_MORE_INFO" } });
    expect(ev.nextValue).toMatchObject({ reason, round: 1, carriedSecondReviewCause: "active_legal_hold" });
    // The FIRST decision stays on the record; no decision row for the request.
    expect((await prisma.workflowReviewDecision.findMany({ where: { workflowId: r.workflowId } })).map((d) => [d.round, d.stage, d.decision])).toEqual([[0, "FIRST", "APPROVE"]]);
    // Replay by the same requester: nothing new.
    const again = await decide(member, r.workflowId, "REQUEST_INFO", reason);
    expect(again.status, again.raw).toBe(200); // a replay records nothing
    expect(again.body.outcome).toMatchObject({ idempotent: true, stageRecorded: "NONE" });
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: r.workflowId, eventType: "NEEDS_MORE_INFO" } })).toBe(1);
    // The FIRST_REVIEW deadline stamp is unchanged by the replay.
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: r.workflowId } })).firstDecidedAtUtc?.toISOString()).toBe(
      wf.firstDecidedAtUtc?.toISOString(),
    );
  });

  it("an emoji at the summary boundary is never split", async () => {
    const r = await inReview(member.userId);
    const reason = "a".repeat(930) + "😀".repeat(100);
    expect((await decide(member, r.workflowId, "REQUEST_INFO", reason)).status).toBe(201);
    const ev = await prisma.evidenceReviewWorkflowEvent.findFirstOrThrow({ where: { workflowId: r.workflowId, eventType: "NEEDS_MORE_INFO" } });
    expect((ev.nextValue as { reason: string }).reason).toBe(reason);
    expect(ev.note!.length).toBeLessThanOrEqual(1000);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(ev.note!)).toBe(false);
  });
});
