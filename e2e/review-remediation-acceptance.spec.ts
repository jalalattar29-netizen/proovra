/**
 * REVIEW REMEDIATION — acceptance journeys (2026-11-27).
 *
 * Browser → API → persisted record, on a Team plan sold on a Personal
 * Workspace (the shape Team customers actually have). Each journey reads the
 * result back from the API AND from the database, so a page that merely says
 * the right thing cannot pass.
 *
 *   1. Ordinary review: ONE authorized assigned reviewer finishes it (F-01).
 *   2. Request information is a workflow action, not a vote: no decision row,
 *      the review waits, the history names the request, the verdict after the
 *      response is the round's FIRST and only decision (F-04).
 *   3. An explicit independent-review request: the first decision is recorded
 *      and shown as pending — never final; the same person cannot give the
 *      second; a different eligible reviewer completes it (F-05/F-06/F-09).
 *   4. An administrative escalation adds no second reviewer (F-02/F-09).
 *   5. Bulk coding: an all-failed batch is reported as a failure, with the
 *      reason per item — never as success (F-30).
 *
 * The behaviour spec is docs/review/remediation-2026-11-27/BEHAVIOUR-SPEC.md;
 * the service-level proofs live in
 * services/api/test/review-remediation-policy.integration.test.ts.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { test, expect, type Page } from "@playwright/test";

import {
  clearTestRateLimits,
  createGuestSession,
  disposeSession,
  personalWorkspaceId,
  SESSION_PASSWORD,
  type GuestSession,
} from "./helpers/api-client";
import { answerCookieBanner } from "./helpers/consent";

function apiDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, "services", "api");
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error("Could not find the workspace root for services/api.");
}

/** A parameterised statement against the stack's disposable database (the e2e helpers' own pattern). */
function sql(query: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const script = `
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const r = await c.query(${JSON.stringify(query)}, ${JSON.stringify(params)});
      process.stdout.write(JSON.stringify(r.rows));
      await c.end();
    })().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
  `;
  const run = spawnSync(process.execPath, ["-e", script], { cwd: apiDir(), encoding: "utf8" });
  if (run.status !== 0) throw new Error(`sql failed: ${run.stderr}`);
  return JSON.parse(run.stdout || "[]");
}

async function signIn(page: Page, s: GuestSession): Promise<void> {
  await clearTestRateLimits();
  await answerCookieBanner(page);
  await page.goto("/login");
  await page.locator('input[placeholder="Email"]:visible').first().fill(s.email);
  await page.locator('input[placeholder="Password"]:visible').first().fill(SESSION_PASSWORD);
  await page.locator('[data-auth-email-cta="SIGN_IN"]:visible').first().click();
  await page.waitForURL(/\/home/, { timeout: 30_000 });
}

type Team = { owner: GuestSession; member: GuestSession; member2: GuestSession; teamId: string };
let team: Team | null = null;

/** A Team-plan owner's Personal Workspace with two ACTIVE members. */
async function teamOfThree(): Promise<Team> {
  const owner = await createGuestSession({ plan: "TEAM" });
  const member = await createGuestSession();
  const member2 = await createGuestSession();
  const teamId = await personalWorkspaceId(owner.api);
  for (const m of [member, member2]) {
    sql(
      `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'MEMBER', 'ACTIVE')
       ON CONFLICT DO NOTHING`,
      [teamId, m.userId],
    );
    const switched = await m.api.post("/v1/platform/context/switch-workspace", { data: { workspaceId: teamId } });
    expect(switched.ok(), await switched.text()).toBe(true);
  }
  return { owner, member, member2, teamId };
}

/** A record in the workspace with a review workflow, assigned to `assignee` and started. */
async function startedReview(t: Team, assignee: GuestSession, title: string): Promise<{ workflowId: string; evidenceId: string }> {
  const ev = sql(
    `INSERT INTO evidence (type, owner_user_id, team_id, organization_id, status, title, updated_at)
     SELECT 'PHOTO', $1, t.id, t.organization_id, 'SIGNED', $3, now() FROM teams t WHERE t.id = $2 RETURNING id`,
    [t.owner.userId, t.teamId, title],
  );
  const evidenceId = String(ev[0]!.id);
  const wf = sql(
    `INSERT INTO evidence_review_workflows (evidence_id, team_id, workspace_type, status, updated_at)
     VALUES ($1, $2, 'TEAM', 'NOT_STARTED', now()) RETURNING id`,
    [evidenceId, t.teamId],
  );
  const workflowId = String(wf[0]!.id);
  const assigned = await t.owner.api.post(`/v1/reviewer-ops/reviews/${workflowId}/assign`, {
    data: { teamId: t.teamId, assignedToUserId: assignee.userId },
  });
  expect(assigned.status(), await assigned.text()).toBe(200);
  const started = await assignee.api.post(`/v1/reviewer-ops/reviews/${workflowId}/start`, { data: { teamId: t.teamId } });
  expect(started.status(), await started.text()).toBe(200);
  return { workflowId, evidenceId };
}

const statusOf = (workflowId: string) =>
  String(sql(`SELECT status FROM evidence_review_workflows WHERE id = $1`, [workflowId])[0]!.status);
const decisionRows = (workflowId: string) =>
  sql(
    `SELECT round, stage::text AS stage, decision::text AS decision, reviewer_user_id
       FROM workflow_review_decisions WHERE workflow_id = $1 ORDER BY decided_at`,
    [workflowId],
  );
async function lineage(s: GuestSession, t: Team, workflowId: string) {
  const res = await s.api.get(`/v1/reviewer-ops/workspace/${workflowId}/decisions?teamId=${t.teamId}`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as {
    state: string;
    informationRequests?: Array<{ requestedBy: { userId: string } | null; reason: string | null }>;
    callerContext: { nextAction: string };
  };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await clearTestRateLimits();
  team = await teamOfThree();
});

test.afterAll(async () => {
  if (team) for (const s of [team.owner, team.member, team.member2]) await disposeSession(s);
  team = null;
});

test("1 — an ordinary review is finished by the one assigned reviewer, in the browser", async ({ page }) => {
  const t = team!;
  const { workflowId } = await startedReview(t, t.member, "Acceptance — ordinary review");

  await signIn(page, t.member);
  await page.goto(`/reviewer-ops/${workflowId}`);
  const form = page.locator("[data-decision-form]");
  await expect(form).toBeVisible({ timeout: 30_000 });
  // No second-review requirement is stated for an ordinary review.
  await expect(page.locator("[data-decision-requirement]")).toHaveCount(0);
  await form.locator('[data-decision-choice="APPROVE"]').click();
  await form.locator("[data-decision-form-rationale]").fill("Metadata and hash are consistent.");
  await form.locator("[data-decision-form-submit]").click();

  await expect.poll(() => statusOf(workflowId), { timeout: 20_000 }).toBe("APPROVED_INTERNAL");
  expect(decisionRows(workflowId).map((r) => [r.round, r.stage, r.decision, r.reviewer_user_id])).toEqual([
    [0, "FIRST", "APPROVE", t.member.userId],
  ]);
  expect((await lineage(t.owner, t, workflowId)).state).toBe("resolved");
  // The page shows the finished state, not a pending one.
  await expect(page.locator("[data-decision-pending-independent]")).toHaveCount(0);
});

test("2 — request information is a workflow action: no decision slot, the history names it, the next verdict decides", async () => {
  const t = team!;
  const { workflowId } = await startedReview(t, t.member, "Acceptance — request information");
  const asked = await t.member.api.post(`/v1/reviewer-ops/reviews/${workflowId}/request-info`, {
    data: { teamId: t.teamId, note: "Please upload the original file." },
  });
  expect(asked.status(), await asked.text()).toBe(200);
  expect(statusOf(workflowId)).toBe("NEEDS_INFO");
  expect(decisionRows(workflowId)).toEqual([]);
  const read = await lineage(t.owner, t, workflowId);
  expect(read.state).toBe("first_required");
  expect(read.informationRequests).toEqual([
    expect.objectContaining({ requestedBy: expect.objectContaining({ userId: t.member.userId }), reason: "Please upload the original file." }),
  ]);

  const received = await t.member.api.post(`/v1/reviewer-ops/reviews/${workflowId}/response-received`, {
    data: { teamId: t.teamId, note: "Original received." },
  });
  expect(received.status(), await received.text()).toBe(200);
  const approved = await t.member.api.post(`/v1/reviewer-ops/reviews/${workflowId}/approve`, {
    data: { teamId: t.teamId, note: "Original matches the hash." },
  });
  expect(approved.status(), await approved.text()).toBe(200);
  expect(statusOf(workflowId)).toBe("APPROVED_INTERNAL");
  expect(decisionRows(workflowId).map((r) => [r.round, r.stage, r.decision])).toEqual([[0, "FIRST", "APPROVE"]]);
});

test("3 — an explicit independent-review request: the first decision is pending, never final; only another reviewer completes it", async () => {
  const t = team!;
  const { workflowId } = await startedReview(t, t.member, "Acceptance — independent review");
  const requested = await t.member.api.post(`/v1/reviewer-ops/reviews/${workflowId}/request-independent-review`, {
    data: { teamId: t.teamId, note: "Large claim — a second reviewer please." },
  });
  expect(requested.status(), await requested.text()).toBe(201);

  const first = await t.member.api.post(`/v1/reviewer-ops/reviews/${workflowId}/approve`, {
    data: { teamId: t.teamId, note: "Looks right to me." },
  });
  expect(first.status(), await first.text()).toBe(200);
  // Recorded, and pending — the review is not finished.
  expect(statusOf(workflowId)).toBe("IN_REVIEW");
  expect((await lineage(t.owner, t, workflowId)).state).toBe("second_required");
  expect((await lineage(t.member, t, workflowId)).callerContext.nextAction).toBe("blocked_same_reviewer");

  // A repeat of the same approval is a replay: nothing new is recorded.
  const replay = await t.member.api.post(`/v1/reviewer-ops/reviews/${workflowId}/approve`, {
    data: { teamId: t.teamId, note: "Looks right to me." },
  });
  expect(replay.status(), await replay.text()).toBe(200);
  expect(decisionRows(workflowId)).toHaveLength(1);
  // The same person can never give the second decision.
  const again = await t.member.api.post(`/v1/reviewer-ops/reviews/${workflowId}/reject`, {
    data: { teamId: t.teamId, note: "On second thought, no." },
  });
  expect(again.status(), await again.text()).toBeGreaterThanOrEqual(400);
  expect(decisionRows(workflowId)).toHaveLength(1);
  expect(statusOf(workflowId)).toBe("IN_REVIEW");

  // The hand-off: a different eligible reviewer completes it.
  const handed = await t.owner.api.post(`/v1/reviewer-ops/reviews/${workflowId}/reassign`, {
    data: { teamId: t.teamId, newAssigneeUserId: t.member2.userId },
  });
  expect(handed.status(), await handed.text()).toBe(200);
  const second = await t.member2.api.post(`/v1/reviewer-ops/reviews/${workflowId}/approve`, {
    data: { teamId: t.teamId, note: "Independently confirmed." },
  });
  expect(second.status(), await second.text()).toBe(200);
  expect(statusOf(workflowId)).toBe("APPROVED_INTERNAL");
  expect(decisionRows(workflowId).map((r) => [r.stage, r.reviewer_user_id])).toEqual([
    ["FIRST", t.member.userId],
    ["SECOND", t.member2.userId],
  ]);
});

test("4 — an administrative escalation adds no second reviewer", async () => {
  const t = team!;
  const { workflowId } = await startedReview(t, t.member, "Acceptance — administrative escalation");
  const raised = await t.member.api.post("/v1/reviewer-ops/escalations", {
    data: { teamId: t.teamId, workflowId, reason: "REVIEW_OVERDUE", severity: "WARNING", safeSummary: "Running late" },
  });
  expect(raised.status(), await raised.text()).toBe(201);
  expect(((await raised.json()) as { escalation: { forcesIndependentReview: boolean } }).escalation.forcesIndependentReview).toBe(false);
  const decided = await t.member.api.post(`/v1/reviewer-ops/reviews/${workflowId}/reject`, {
    data: { teamId: t.teamId, note: "Chain of custody gap." },
  });
  expect(decided.status(), await decided.text()).toBe(200);
  expect(statusOf(workflowId)).toBe("REJECTED_INSUFFICIENT");
  expect(decisionRows(workflowId)).toHaveLength(1);
});

test("5 — bulk coding: an all-failed batch is a failure with a reason per item, never a success", async () => {
  const t = team!;
  const { workflowId } = await startedReview(t, t.member, "Acceptance — bulk all failed");
  const res = await t.owner.api.post(`/v1/reviewer/bulk/code?teamId=${t.teamId}`, {
    data: { teamId: t.teamId, fieldSlug: "estimate", value: { number: 1 }, workflowIds: [workflowId] },
  });
  expect(res.status(), await res.text()).toBe(207);
  const body = (await res.json()) as { ok: boolean; succeeded: number; failed: number; items: Array<{ ok: boolean; message?: string }> };
  expect(body).toMatchObject({ ok: false, succeeded: 0, failed: 1 });
  expect(body.items[0]).toMatchObject({ ok: false, message: expect.any(String) });
});
