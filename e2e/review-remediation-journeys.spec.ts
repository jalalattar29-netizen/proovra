/**
 * REVIEW REMEDIATION — browser acceptance journeys (2026-11-27, PR #13).
 *
 * Every journey drives the REAL controls of the Review UI (Inbox, Review page,
 * decision form, dialogs, Challenged decisions, Coding, bulk bar, External
 * Review) and then reads the saved result back from the database (and, where
 * it names the contract, from the API). A page that merely says the right
 * thing cannot pass: the persisted row is the proof.
 *
 * Fixture set-up that has no user-facing control in the journey under test
 * (seeding a record + workflow, membership rows, a legal hold, an enterprise
 * contract term) is done by SQL or API and is labelled "fixture"; a step that
 * is asserted only through the API is labelled "API-only".
 *
 * Teams: a 1-person Team (owner only), a 3-person Team and a 10-person Team
 * (owner, one ADMIN, seven MEMBERs, one VIEWER), all sold on a Personal
 * Workspace — the shape Team customers have. Enterprise (journey 9) uses a
 * provisioned organization workspace with an active contract.
 *
 * Product behaviour: docs/review/remediation-2026-11-27/BEHAVIOUR-SPEC.md.
 * API/service-level proofs: e2e/review-remediation-acceptance.spec.ts and
 * services/api/test/review-remediation-policy.integration.test.ts.
 *
 * Journey 12 reads the invitation from the isolated email recorder
 * (EMAIL_RECORDER_FILE). Where it is not set (CI), only the mailbox steps are
 * skipped, with an annotation saying why.
 */

import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { test, expect, type Browser, type BrowserContext, type Page, type Response } from "@playwright/test";

import {
  approvedStepUpHeader,
  clearTestRateLimits,
  createGuestSession,
  personalWorkspaceId,
  provisionEnterpriseOrg,
  SESSION_PASSWORD,
  type GuestSession,
} from "./helpers/api-client";
import { answerCookieBanner } from "./helpers/consent";

const WEB = process.env.WEB_BASE ?? "http://localhost:3192";
const MAILBOX = process.env.EMAIL_RECORDER_FILE ?? "";

test.use({ actionTimeout: 10_000, navigationTimeout: 45_000 });
test.setTimeout(300_000);

// ============================================================================
// Database + API helpers
// ============================================================================

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

/** A parameterised statement against the stack's disposable database. */
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

const one = (query: string, params: unknown[] = []) => sql(query, params)[0] ?? {};

const workflowRow = (workflowId: string) =>
  one(
    `SELECT status::text AS status, decision_round, assigned_to_user_id::text AS assignee
       FROM evidence_review_workflows WHERE id = $1`,
    [workflowId],
  ) as { status?: string; decision_round?: number; assignee?: string | null };
const statusOf = (workflowId: string) => String(workflowRow(workflowId).status);
const assigneeOf = (workflowId: string) => workflowRow(workflowId).assignee ?? null;
const roundOf = (workflowId: string) => Number(workflowRow(workflowId).decision_round);
const decisionRows = (workflowId: string) =>
  sql(
    `SELECT round, stage::text AS stage, decision::text AS decision, reviewer_user_id::text AS reviewer
       FROM workflow_review_decisions WHERE workflow_id = $1 ORDER BY decided_at`,
    [workflowId],
  ) as Array<{ round: number; stage: string; decision: string; reviewer: string }>;
const eventsOf = (workflowId: string, type: string) =>
  sql(
    `SELECT event_type, next_value, note, actor_user_id::text AS actor
       FROM evidence_review_workflow_events WHERE workflow_id = $1 AND event_type::text = $2 ORDER BY created_at`,
    [workflowId, type],
  ) as Array<{ event_type: string; next_value: Record<string, unknown> | null; note: string | null; actor: string }>;

async function jsonOf(res: { status(): number; text(): Promise<string> }) {
  const raw = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* not json */
  }
  return { status: res.status(), body, raw };
}

// ============================================================================
// Teams (Personal-workspace Team plan) — members added as the acceptance spec does
// ============================================================================

type Role = "MEMBER" | "ADMIN" | "VIEWER";
type Team = { owner: GuestSession; members: GuestSession[]; teamId: string };

async function makeTeam(size: number, roles: Record<number, Role> = {}): Promise<Team> {
  await clearTestRateLimits();
  const owner = await createGuestSession({ plan: "TEAM" });
  const teamId = await personalWorkspaceId(owner.api);
  const members: GuestSession[] = [];
  for (let i = 0; i < size - 1; i += 1) {
    await clearTestRateLimits();
    const m = await createGuestSession();
    // fixture: membership row (the acceptance spec's pattern), then the member opens the workspace.
    sql(
      `INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, $3, 'ACTIVE') ON CONFLICT DO NOTHING`,
      [teamId, m.userId, roles[i] ?? "MEMBER"],
    );
    const switched = await m.api.post("/v1/platform/context/switch-workspace", { data: { workspaceId: teamId } });
    expect(switched.ok(), await switched.text()).toBe(true);
    members.push(m);
  }
  return { owner, members, teamId };
}

// Lazily built and shared inside one worker; a restarted worker builds them again.
let team1Cache: Team | null = null;
let team3Cache: Team | null = null;
let team10Cache: Team | null = null;
const team1 = async () => (team1Cache ??= await makeTeam(1));
const team3 = async () => (team3Cache ??= await makeTeam(3));
/** members[0] = ADMIN, members[8] = VIEWER, the rest MEMBER. */
const team10 = async () => (team10Cache ??= await makeTeam(10, { 0: "ADMIN", 8: "VIEWER" }));

/** fixture: an evidence record in the workspace with a NOT_STARTED, unassigned review workflow. */
function seedReview(teamId: string, ownerUserId: string, title: string): { workflowId: string; evidenceId: string } {
  const ev = sql(
    `INSERT INTO evidence (type, owner_user_id, team_id, organization_id, status, title, updated_at)
     SELECT 'PHOTO', $1, t.id, t.organization_id, 'SIGNED', $3, now() FROM teams t WHERE t.id = $2 RETURNING id`,
    [ownerUserId, teamId, title],
  );
  const evidenceId = String(ev[0]!.id);
  const wf = sql(
    `INSERT INTO evidence_review_workflows (evidence_id, team_id, workspace_type, status, updated_at)
     VALUES ($1, $2, 'TEAM', 'NOT_STARTED', now()) RETURNING id`,
    [evidenceId, teamId],
  );
  return { workflowId: String(wf[0]!.id), evidenceId };
}

/** fixture (API): assign to `assignee` and start as the assignee. */
async function assignAndStart(t: { owner: GuestSession; teamId: string }, workflowId: string, assignee: GuestSession) {
  const assigned = await t.owner.api.post(`/v1/reviewer-ops/reviews/${workflowId}/assign`, {
    data: { teamId: t.teamId, assignedToUserId: assignee.userId },
  });
  expect(assigned.status(), await assigned.text()).toBe(200);
  const started = await assignee.api.post(`/v1/reviewer-ops/reviews/${workflowId}/start`, { data: { teamId: t.teamId } });
  expect(started.status(), await started.text()).toBe(200);
}

// ============================================================================
// Browser helpers
// ============================================================================

async function signIn(page: Page, s: GuestSession): Promise<void> {
  await clearTestRateLimits();
  await answerCookieBanner(page);
  await page.goto("/login");
  await page.locator('input[placeholder="Email"]:visible').first().fill(s.email);
  await page.locator('input[placeholder="Password"]:visible').first().fill(SESSION_PASSWORD);
  await page.locator('[data-auth-email-cta="SIGN_IN"]:visible').first().click();
  await page.waitForURL(/\/home/, { timeout: 60_000 });
}

async function signedInPage(browser: Browser, s: GuestSession): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: WEB, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await signIn(page, s);
  return { ctx, page };
}

function waitPost(page: Page, path: RegExp, timeout = 30_000): Promise<Response> {
  return page.waitForResponse(
    (r) => r.request().method() === "POST" && path.test(new URL(r.url()).pathname),
    { timeout },
  );
}

function note(a: { type: string; description: string }): void {
  test.info().annotations.push(a);
  console.log(`[${a.type}] ${a.description}`);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: false });
}

async function openReview(page: Page, workflowId: string): Promise<void> {
  await page.goto(`/reviewer-ops/${workflowId}`);
  await expect(page.locator("[data-reviewer-actions]")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("[data-decision-panel]")).toBeVisible({ timeout: 30_000 });
}

/** The decision form: choose, write the rationale, submit; returns the decisions POST. */
async function uiDecide(page: Page, kind: string, rationale: string): Promise<Response> {
  const form = page.locator("[data-decision-form]");
  await expect(form).toBeVisible({ timeout: 30_000 });
  const choice = form.locator(`[data-decision-choice="${kind}"]`);
  await expect(choice).toBeEnabled();
  await choice.click();
  await form.locator("[data-decision-form-rationale]").fill(rationale);
  const posted = waitPost(page, /\/v1\/reviewer-ops\/workspace\/[^/]+\/decisions$/);
  await form.locator("[data-decision-form-submit]").click();
  return posted;
}

/** A Next-step button (Start review / Record response …), its POST awaited. */
async function uiAction(page: Page, action: string, route: RegExp, reason?: string): Promise<Response> {
  const btn = page.locator(`[data-reviewer-actions] [data-reviewer-action="${action}"]`).first();
  await expect(btn).toBeVisible({ timeout: 20_000 });
  const posted = waitPost(page, route);
  await btn.click();
  if (reason !== undefined) {
    const modal = page.locator("[data-reviewer-reason-modal]");
    await expect(modal).toBeVisible();
    await modal.locator("[data-reviewer-reason-input]").fill(reason);
    await page.locator("[data-reviewer-reason-submit]").click();
  }
  return posted;
}

/** Pick an option of an AppListbox by value and make sure the list closed. */
async function chooseOption(page: Page, trigger: string, value: string): Promise<void> {
  await page.locator(trigger).click();
  const option = page.locator(`[role="option"][data-value="${value}"]`);
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.locator('[role="listbox"]')).toHaveCount(0);
}

// ---- TOTP (test factor) for step-up in the browser --------------------------
function b32(input: string): Buffer {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of input.replace(/=+$/, "").toUpperCase()) {
    value = (value << 5) | a.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function totp(secret: Buffer, step: number): string {
  const c = Buffer.alloc(8);
  c.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  c.writeUInt32BE(step >>> 0, 4);
  const h = createHmac("sha1", secret).update(c).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
/** fixture (API): enrol an authenticator; returns the next accepted code each call. */
async function enrolTotp(s: GuestSession): Promise<() => Promise<string>> {
  const st = await jsonOf(await s.api.post("/v1/identity/mfa/enroll/start", { data: { label: "E2E authenticator" } }));
  expect(st.status, st.raw).toBeLessThan(300);
  const secret = b32(st.body.secretBase32);
  let last = Math.floor(Date.now() / 1000 / 30);
  const ver = await s.api.post("/v1/identity/mfa/enroll/verify", { data: { factorId: st.body.factorId, code: totp(secret, last) } });
  expect(ver.ok(), await ver.text()).toBe(true);
  return async () => {
    for (;;) {
      const cur = Math.floor(Date.now() / 1000 / 30);
      if (cur > last) {
        last = cur;
        return totp(secret, cur);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
}
/** Answer the step-up modal with the test factor. */
async function answerStepUp(page: Page, next: () => Promise<string>): Promise<void> {
  const modal = page.locator('[data-step-up-modal]');
  await expect(modal).toBeVisible({ timeout: 20_000 });
  const input = modal.locator("[data-step-up-code-input]");
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill(await next());
  await modal.locator("[data-step-up-verify]").click();
}

// ---- recorded mailbox ---------------------------------------------------------
const aliasOf = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
function mails(email: string): Array<Record<string, any>> {
  if (!MAILBOX || !existsSync(MAILBOX)) return [];
  const a = aliasOf(email);
  return readFileSync(MAILBOX, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, any>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, any> => !!e && e.recipientAlias === a);
}

// ============================================================================
// 1 — one-person Team
// ============================================================================

test("J1 — one-person Team: the owner assigns, starts and approves an ordinary review in the browser", async ({ page }) => {
  const t = await team1();
  const { workflowId } = seedReview(t.teamId, t.owner.userId, "J1 one-person ordinary review");

  await signIn(page, t.owner);
  // Assign through the Inbox row action + reviewer picker.
  await page.goto("/review?view=UNASSIGNED");
  const assign = page.locator(`[data-inbox-row-assign="${workflowId}"]`);
  await expect(assign).toBeVisible({ timeout: 45_000 });
  await assign.click();
  const pick = page.locator(`[data-reviewer-picker-select="${t.owner.userId}"]`);
  await expect(pick).toBeEnabled({ timeout: 20_000 });
  const assigned = waitPost(page, new RegExp(`/reviews/${workflowId}/assign$`));
  await pick.click();
  expect((await assigned).status()).toBe(200);
  await expect.poll(() => assigneeOf(workflowId)).toBe(t.owner.userId);

  await openReview(page, workflowId);
  expect((await uiAction(page, "start", new RegExp(`/reviews/${workflowId}/start$`))).status()).toBe(200);
  await expect.poll(() => statusOf(workflowId)).toBe("IN_REVIEW");
  // An ordinary review states no second-review requirement.
  await expect(page.locator("[data-decision-panel]")).toHaveAttribute("data-decision-requires-second", "false");
  await expect(page.locator("[data-decision-requirement]")).toHaveCount(0);

  const decided = await uiDecide(page, "APPROVE", "J1: metadata and hash are consistent.");
  expect(decided.status(), await decided.text()).toBeLessThan(300);
  await expect.poll(() => statusOf(workflowId)).toBe("APPROVED_INTERNAL");
  expect(decisionRows(workflowId).map((r) => [r.round, r.stage, r.decision, r.reviewer])).toEqual([
    [0, "FIRST", "APPROVE", t.owner.userId],
  ]);
  // What the owner sees: the final outcome, never "waiting for an independent reviewer".
  await expect(page.locator("[data-decision-outcome]")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-decision-panel]")).toHaveAttribute("data-decision-state", "resolved");
  await expect(page.locator("[data-decision-pending-independent]")).toHaveCount(0);
  await shot(page, "j1-approved-by-only-member");
});

// ============================================================================
// 2 — Team of three: UI assignment + ordinary completion; UI hand-off
// ============================================================================

test("J2 — three-person Team: Inbox assignment, Start and approval by the member; Reassign hand-off then completion by the new assignee", async ({ page, browser }) => {
  const t = await team3();
  const [m1, m2] = t.members as [GuestSession, GuestSession];

  // (a) assignment through the Inbox, ordinary completion by the member.
  const a = seedReview(t.teamId, t.owner.userId, "J2 assigned through the inbox");
  await signIn(page, t.owner);
  await page.goto("/review?view=UNASSIGNED");
  await page.locator(`[data-inbox-row-assign="${a.workflowId}"]`).click({ timeout: 45_000 });
  const pick = page.locator(`[data-reviewer-picker-select="${m1.userId}"]`);
  await expect(pick).toBeEnabled({ timeout: 20_000 });
  const assigned = waitPost(page, new RegExp(`/reviews/${a.workflowId}/assign$`));
  await pick.click();
  expect((await assigned).status()).toBe(200);
  await expect.poll(() => assigneeOf(a.workflowId)).toBe(m1.userId);
  await expect(page.getByText("Reviewer assigned.").first()).toBeVisible(); // the row then leaves the Unassigned view

  const p1 = await signedInPage(browser, m1);
  await openReview(p1.page, a.workflowId);
  expect((await uiAction(p1.page, "start", new RegExp(`/reviews/${a.workflowId}/start$`))).status()).toBe(200);
  const d1 = await uiDecide(p1.page, "APPROVE", "J2: consistent with the source file.");
  expect(d1.status(), await d1.text()).toBeLessThan(300);
  await expect.poll(() => statusOf(a.workflowId)).toBe("APPROVED_INTERNAL");
  expect(decisionRows(a.workflowId).map((r) => [r.stage, r.decision, r.reviewer])).toEqual([["FIRST", "APPROVE", m1.userId]]);
  await expect(p1.page.locator("[data-decision-outcome]")).toBeVisible({ timeout: 20_000 });
  await shot(p1.page, "j2a-member-approved");

  // (b) hand-off: the owner reassigns an in-progress review from m1 to m2 in the Reassign dialog.
  const b = seedReview(t.teamId, t.owner.userId, "J2 hand-off");
  await assignAndStart(t, b.workflowId, m1); // fixture (API)
  await openReview(page, b.workflowId);
  await page.locator('[data-reviewer-actions] [data-reviewer-action="reassign"]').click();
  const dialog = page.locator('[data-matter-modal="reviewer-reassign"]');
  await expect(dialog).toBeVisible();
  await chooseOption(page, "[data-reviewer-reassign-picker]", m2.userId);
  const handed = waitPost(page, new RegExp(`/reviews/${b.workflowId}/reassign$`));
  await page.locator('[data-inspector-dialog-confirm="reassign"]').click();
  expect((await handed).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => assigneeOf(b.workflowId)).toBe(m2.userId);
  await shot(page, "j2b-after-reassign");

  const p2 = await signedInPage(browser, m2);
  await openReview(p2.page, b.workflowId);
  const start = p2.page.locator('[data-reviewer-actions] [data-reviewer-action="start"]');
  if (await start.isVisible()) {
    expect((await uiAction(p2.page, "start", new RegExp(`/reviews/${b.workflowId}/start$`))).status()).toBe(200);
  }
  const d2 = await uiDecide(p2.page, "REJECT", "J2: the capture time contradicts the metadata.");
  expect(d2.status(), await d2.text()).toBeLessThan(300);
  await expect.poll(() => statusOf(b.workflowId)).toBe("REJECTED_INSUFFICIENT");
  expect(decisionRows(b.workflowId).map((r) => [r.stage, r.decision, r.reviewer])).toEqual([["FIRST", "REJECT", m2.userId]]);
  await shot(p2.page, "j2b-new-assignee-rejected");
  await p1.ctx.close();
  await p2.ctx.close();
});

// ============================================================================
// 3 — explicit independent review
// ============================================================================

test("J3 — ten-person Team: Request independent review in the UI; first decision pending; UI hand-off; second decision by another member; the first reviewer is not offered the second", async ({ page, browser }) => {
  const t = await team10();
  const m = t.members[1]!;
  const m2 = t.members[2]!;
  const r = seedReview(t.teamId, t.owner.userId, "J3 independent review");
  await assignAndStart(t, r.workflowId, m); // fixture (API)

  const pm = await signedInPage(browser, m);
  await openReview(pm.page, r.workflowId);
  await pm.page.locator('[data-reviewer-actions] [data-reviewer-action="request_independent_review"]').click();
  await expect(pm.page.locator("[data-reviewer-request-independent-form]")).toBeVisible();
  await pm.page.locator("[data-reviewer-request-independent-note]").fill("J3: large claim — a second reviewer please.");
  const requested = waitPost(pm.page, new RegExp(`/reviews/${r.workflowId}/request-independent-review$`));
  await pm.page.locator('[data-inspector-dialog-confirm="request-independent-review"]').click();
  expect((await requested).status()).toBe(201);
  // persisted: an escalation that requires independent review.
  expect(
    sql(`SELECT requires_independent_review FROM review_escalations WHERE workflow_id = $1`, [r.workflowId]).map((x) => x.requires_independent_review),
  ).toContain(true);
  await expect(pm.page.locator("[data-decision-panel]")).toHaveAttribute("data-decision-requires-second", "true", { timeout: 20_000 });

  const first = await uiDecide(pm.page, "APPROVE", "J3: looks right to me.");
  expect(first.status(), await first.text()).toBeLessThan(300);
  // Recorded and pending — never final.
  await expect(pm.page.locator("[data-decision-pending-independent]")).toContainText("waiting for an independent reviewer", { timeout: 20_000 });
  expect(statusOf(r.workflowId)).toBe("IN_REVIEW");
  expect(decisionRows(r.workflowId).map((d) => [d.stage, d.decision, d.reviewer])).toEqual([["FIRST", "APPROVE", m.userId]]);
  // The same reviewer is not offered the second decision.
  await expect(pm.page.locator("[data-decision-form]")).toHaveCount(0);
  await expect(pm.page.locator('[data-decision-blocked-banner="blocked_same_reviewer"]')).toBeVisible();
  await shot(pm.page, "j3-first-recorded-pending");
  // API-only: a second decision by the same person is refused and records nothing.
  const again = await m.api.post(`/v1/reviewer-ops/workspace/${r.workflowId}/decisions`, {
    data: { teamId: t.teamId, decision: "REJECT", rationale: "J3: on second thought, no." },
  });
  expect(again.status()).toBeGreaterThanOrEqual(400);
  expect(decisionRows(r.workflowId)).toHaveLength(1);

  // Hand-off in the UI by the owner; the first reviewer is not offered.
  await signIn(page, t.owner);
  await openReview(page, r.workflowId);
  const handoffBtn = page.locator("[data-reviewer-handoff-assign], [data-decision-pending-assign]").first();
  await expect(handoffBtn).toBeVisible({ timeout: 20_000 });
  await handoffBtn.click();
  await expect(page.locator('[data-reviewer-reassign-form="handoff"]')).toBeVisible();
  await page.locator("[data-reviewer-reassign-picker]").click();
  await expect(page.locator(`[role="option"][data-value="${m2.userId}"]`)).toBeVisible();
  await expect(page.locator(`[role="option"][data-value="${m.userId}"]`)).toHaveCount(0);
  await page.locator(`[role="option"][data-value="${m2.userId}"]`).click();
  await expect(page.locator('[role="listbox"]')).toHaveCount(0);
  const handed = waitPost(page, new RegExp(`/reviews/${r.workflowId}/reassign$`));
  await page.locator('[data-inspector-dialog-confirm="reassign"]').click();
  expect((await handed).status()).toBe(200);
  await expect.poll(() => assigneeOf(r.workflowId)).toBe(m2.userId);

  const p2 = await signedInPage(browser, m2);
  await openReview(p2.page, r.workflowId);
  await expect(p2.page.locator("[data-decision-form]")).toHaveAttribute("data-decision-form-stage", "SECOND");
  const second = await uiDecide(p2.page, "APPROVE", "J3: independently confirmed.");
  expect(second.status(), await second.text()).toBeLessThan(300);
  await expect.poll(() => statusOf(r.workflowId)).toBe("APPROVED_INTERNAL");
  expect(decisionRows(r.workflowId).map((d) => [d.stage, d.decision, d.reviewer])).toEqual([
    ["FIRST", "APPROVE", m.userId],
    ["SECOND", "APPROVE", m2.userId],
  ]);
  await expect(p2.page.locator("[data-decision-outcome]")).toBeVisible({ timeout: 20_000 });
  await shot(p2.page, "j3-second-decision-final");
  await pm.ctx.close();
  await p2.ctx.close();
});

// ============================================================================
// 4 — request information before a first decision
// ============================================================================

test("J4 — three-person Team: Request information in the decision form, listed in the history; Record response, Start, then a decision", async ({ browser }) => {
  const t = await team3();
  const m1 = t.members[0]!;
  const r = seedReview(t.teamId, t.owner.userId, "J4 request information");
  await assignAndStart(t, r.workflowId, m1); // fixture (API)

  const p = await signedInPage(browser, m1);
  await openReview(p.page, r.workflowId);
  const reason = "J4: please upload the original file from the device.";
  const asked = await uiDecide(p.page, "REQUEST_INFO", reason);
  expect(asked.status(), await asked.text()).toBeLessThan(300);
  await expect.poll(() => statusOf(r.workflowId)).toBe("NEEDS_INFO");
  expect(decisionRows(r.workflowId)).toEqual([]); // a workflow action, not a vote
  const ev = eventsOf(r.workflowId, "NEEDS_MORE_INFO");
  expect(ev).toHaveLength(1);
  expect(ev[0]!.next_value).toMatchObject({ reason });
  // The history names the request (not as a decision row).
  const requests = p.page.locator("[data-decision-information-requests]");
  await expect(requests).toContainText("Information requested (1)", { timeout: 20_000 });
  await expect(requests.locator("[data-information-request-row]")).toContainText(reason);
  await expect(p.page.locator("[data-decision-row]")).toHaveCount(0);
  await shot(p.page, "j4-information-requested");

  expect(
    (await uiAction(p.page, "record_response", new RegExp(`/reviews/${r.workflowId}/response-received$`), "J4: original received by e-mail.")).status(),
  ).toBe(200);
  await expect.poll(() => statusOf(r.workflowId)).not.toBe("NEEDS_INFO");
  expect((await uiAction(p.page, "start", new RegExp(`/reviews/${r.workflowId}/start$`))).status()).toBe(200);
  await expect.poll(() => statusOf(r.workflowId)).toBe("IN_REVIEW");
  const decided = await uiDecide(p.page, "APPROVE", "J4: the original matches the hash.");
  expect(decided.status(), await decided.text()).toBeLessThan(300);
  await expect.poll(() => statusOf(r.workflowId)).toBe("APPROVED_INTERNAL");
  expect(decisionRows(r.workflowId).map((d) => [d.stage, d.decision, d.reviewer])).toEqual([["FIRST", "APPROVE", m1.userId]]);
  await expect(p.page.locator("[data-decision-outcome]")).toBeVisible({ timeout: 20_000 });
  await expect(p.page.locator("[data-information-request-row]")).toHaveCount(1);
  await shot(p.page, "j4-decided-after-response");
  await p.ctx.close();
});

// ============================================================================
// 5 — request information after a pinned FIRST decision (legal hold)
// ============================================================================

test("J5 — three-person Team, active legal hold: a request for information after the first decision supersedes it, opens a new round and keeps the requirement", async ({ browser }) => {
  const t = await team3();
  const [m1, m2] = t.members as [GuestSession, GuestSession];
  const r = seedReview(t.teamId, t.owner.userId, "J5 legal hold, information after first");
  await assignAndStart(t, r.workflowId, m1); // fixture (API)
  // fixture (SQL): an ACTIVE legal hold on the evidence → a second decision is required.
  sql(
    `INSERT INTO evidence_legal_holds (team_id, evidence_id, scope, title, reason, status, placed_by_user_id, updated_at)
     VALUES ($1, $2, 'EVIDENCE', 'J5 hold', 'Litigation hold for the journey', 'ACTIVE', $3, now())`,
    [t.teamId, r.evidenceId, t.owner.userId],
  );

  const p1 = await signedInPage(browser, m1);
  await openReview(p1.page, r.workflowId);
  await expect(p1.page.locator("[data-decision-requirement]")).toHaveAttribute("data-decision-second-review-reason", "active_legal_hold");
  const first = await uiDecide(p1.page, "APPROVE", "J5: consistent with the source.");
  expect(first.status(), await first.text()).toBeLessThan(300);
  await expect(p1.page.locator("[data-decision-pending-independent]")).toBeVisible({ timeout: 20_000 });
  const roundBefore = roundOf(r.workflowId);
  const firstId = String(one(`SELECT id FROM workflow_review_decisions WHERE workflow_id = $1`, [r.workflowId]).id);

  // fixture (API): hand-off to m2 (the UI hand-off is journey 3).
  const handed = await t.owner.api.post(`/v1/reviewer-ops/reviews/${r.workflowId}/reassign`, {
    data: { teamId: t.teamId, newAssigneeUserId: m2.userId },
  });
  expect(handed.status(), await handed.text()).toBe(200);

  const p2 = await signedInPage(browser, m2);
  await openReview(p2.page, r.workflowId);
  const reason = "J5: the device log is needed before a second decision.";
  const asked = await uiDecide(p2.page, "REQUEST_INFO", reason);
  expect(asked.status(), await asked.text()).toBeLessThan(300);

  // DB: the round advanced, the first decision stays in history, the cause is carried.
  await expect.poll(() => roundOf(r.workflowId)).toBe(roundBefore + 1);
  expect(statusOf(r.workflowId)).toBe("NEEDS_INFO");
  expect(decisionRows(r.workflowId).map((d) => [d.round, d.stage, d.reviewer])).toEqual([[roundBefore, "FIRST", m1.userId]]);
  const ev = eventsOf(r.workflowId, "NEEDS_MORE_INFO");
  expect(ev).toHaveLength(1);
  expect(ev[0]!.next_value).toMatchObject({ carriedSecondReviewCause: "active_legal_hold", supersededDecisionId: firstId, reason });

  // UI: the request is listed as superseding; the requirement still applies.
  await expect(p2.page.locator('[data-information-request-row][data-information-request-superseded="true"]')).toContainText(reason, { timeout: 20_000 });
  await expect(p2.page.locator("[data-decision-panel]")).toHaveAttribute("data-decision-requires-second", "true");
  await expect(p2.page.locator("[data-decision-requirement], [data-decision-pending-independent]").first()).toBeVisible();
  // The superseded FIRST decision never reads as the outcome (fixed after journeys run 1).
  await expect(p2.page.locator(`[data-decision-row][data-decision-set-aside="true"]`)).toHaveCount(1);
  await expect(p2.page.locator("[data-decision-set-aside-chip]")).toHaveText("Set aside — information was requested");
  await shot(p2.page, "j5-request-supersedes-first");
  await p1.ctx.close();
  await p2.ctx.close();
});

// ============================================================================
// 6 — conflict and independent adjudication
// ============================================================================

test("J6 — ten-person Team: first approves, second rejects in the UI; neither reviewer is offered adjudication; the owner adjudicates in the UI", async ({ page, browser }) => {
  const t = await team10();
  const m = t.members[3]!;
  const m2 = t.members[4]!;
  const r = seedReview(t.teamId, t.owner.userId, "J6 conflict");
  await assignAndStart(t, r.workflowId, m); // fixture (API)
  const req = await m.api.post(`/v1/reviewer-ops/reviews/${r.workflowId}/request-independent-review`, {
    data: { teamId: t.teamId, note: "J6: second reviewer required." },
  }); // fixture (API) — the UI request is journey 3
  expect(req.status(), await req.text()).toBe(201);

  const pm = await signedInPage(browser, m);
  await openReview(pm.page, r.workflowId);
  expect((await uiDecide(pm.page, "APPROVE", "J6: consistent.")).status()).toBeLessThan(300);
  const handed = await t.owner.api.post(`/v1/reviewer-ops/reviews/${r.workflowId}/reassign`, {
    data: { teamId: t.teamId, newAssigneeUserId: m2.userId },
  }); // fixture (API)
  expect(handed.status(), await handed.text()).toBe(200);

  const p2 = await signedInPage(browser, m2);
  await openReview(p2.page, r.workflowId);
  expect((await uiDecide(p2.page, "REJECT", "J6: the metadata contradicts the capture time.")).status()).toBeLessThan(300);
  await expect(p2.page.locator("[data-decision-panel]")).toHaveAttribute("data-decision-panel-mode", "adjudication", { timeout: 20_000 });
  await expect(p2.page.locator("[data-adjudication-form]")).toHaveCount(0);
  await expect(p2.page.locator("[data-adjudication-blocked]")).toBeVisible();
  await pm.page.reload();
  await expect(pm.page.locator("[data-decision-panel]")).toHaveAttribute("data-decision-panel-mode", "adjudication", { timeout: 30_000 });
  await expect(pm.page.locator("[data-adjudication-form]")).toHaveCount(0);
  expect(decisionRows(r.workflowId).map((d) => [d.stage, d.decision, d.reviewer])).toEqual([
    ["FIRST", "APPROVE", m.userId],
    ["SECOND", "REJECT", m2.userId],
  ]);

  await signIn(page, t.owner);
  await openReview(page, r.workflowId);
  const adj = page.locator("[data-adjudication-form]");
  await expect(adj).toBeVisible({ timeout: 20_000 });
  await shot(page, "j6-conflict-adjudication-form");
  const decided = await uiDecide(page, "UPHOLD_SECOND", "J6: the capture-time contradiction holds.");
  expect(decided.status(), await decided.text()).toBeLessThan(300);
  await expect.poll(() => statusOf(r.workflowId)).toBe("REJECTED_INSUFFICIENT");
  const rows = decisionRows(r.workflowId);
  expect(rows).toHaveLength(3);
  expect(rows[2]).toMatchObject({ decision: "UPHOLD_SECOND", reviewer: t.owner.userId });
  await expect(page.locator("[data-decision-outcome]")).toBeVisible({ timeout: 20_000 });
  await shot(page, "j6-adjudicated");
  await pm.ctx.close();
  await p2.ctx.close();
});

// ============================================================================
// 7 — challenge filed and resolved OVERTURNED
// ============================================================================

test("J7 — ten-person Team: the owner files a challenge on the Review page; an independent admin resolves it OVERTURNED on Challenged decisions; the review reopens in a new round", async ({ page, browser }) => {
  const t = await team10();
  const admin = t.members[0]!;
  const m = t.members[5]!;
  const r = seedReview(t.teamId, t.owner.userId, "J7 challenged decision");
  await assignAndStart(t, r.workflowId, m); // fixture (API)
  const pm = await signedInPage(browser, m);
  await openReview(pm.page, r.workflowId);
  expect((await uiDecide(pm.page, "APPROVE", "J7: approve — consistent.")).status()).toBeLessThan(300);
  await expect.poll(() => statusOf(r.workflowId)).toBe("APPROVED_INTERNAL");
  const decisionId = String(one(`SELECT id FROM workflow_review_decisions WHERE workflow_id = $1`, [r.workflowId]).id);
  const roundBefore = roundOf(r.workflowId);

  // The challenge, filed in the Review page's Challenge panel.
  await signIn(page, t.owner);
  await openReview(page, r.workflowId);
  const panel = page.locator("[data-review-challenge]");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await panel.locator("[data-review-challenge-open]").click();
  await chooseOption(page, "[data-review-challenge-decision]", decisionId);
  await panel.locator("[data-review-challenge-rationale]").fill("J7: the review ignored the device log.");
  const filed = waitPost(page, /\/disagree$/);
  await panel.locator("[data-review-challenge-submit]").click();
  expect((await filed).status()).toBeLessThan(300);
  await expect(panel.locator("[data-review-challenge-notice]")).toBeVisible();
  const ch = one(`SELECT id, state::text AS state, challenger_user_id::text AS challenger, original_decision_id::text AS dec FROM reviewer_disagreements WHERE workflow_id = $1`, [r.workflowId]);
  expect(ch).toMatchObject({ state: "FILED", challenger: t.owner.userId, dec: decisionId });
  const challengeId = String(ch.id);
  await shot(page, "j7-challenge-filed");

  // The challenger is not offered the resolution.
  await page.goto("/review/disagreements");
  const ownRow = page.locator(`[data-disagreement-row="${challengeId}"]`);
  await expect(ownRow).toBeVisible({ timeout: 30_000 });
  await expect(ownRow.locator("[data-disagreement-not-independent]")).toBeVisible();
  await expect(ownRow.locator('[data-disagreement-transition-btn="RESOLVED_OVERTURNED"]')).toHaveCount(0);

  // An independent admin moves it to second review, then resolves it OVERTURNED.
  const pa = await signedInPage(browser, admin);
  await pa.page.goto("/review/disagreements");
  const row = pa.page.locator(`[data-disagreement-row="${challengeId}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const moved = waitPost(pa.page, /\/transition$/);
  await row.locator('[data-disagreement-transition-btn="UNDER_SECOND_REVIEW"]').click();
  expect((await moved).status()).toBeLessThan(300);
  await expect.poll(() => String(one(`SELECT state::text AS s FROM reviewer_disagreements WHERE id = $1`, [challengeId]).s)).toBe("UNDER_SECOND_REVIEW");
  await row.locator('[data-disagreement-transition-btn="RESOLVED_OVERTURNED"]').click();
  const picker = pa.page.locator(`[data-disagreement-resolve-picker="${challengeId}"]`);
  await expect(picker).toBeVisible();
  await expect(picker.locator("[data-disagreement-resolve-effect]")).toContainText("reopened");
  await chooseOption(pa.page, "[data-disagreement-resolve-verdict-select]", "REJECT");
  await picker.locator("[data-disagreement-resolve-rationale]").fill("J7: the device log contradicts the approval.");
  const resolved = waitPost(pa.page, /\/transition$/);
  await picker.locator("[data-disagreement-resolve-submit]").click();
  const res = await resolved;
  expect(res.status(), await res.text()).toBeLessThan(300);
  await expect(pa.page.locator("[data-disagreement-banner]")).toBeVisible();
  await shot(pa.page, "j7-resolved-overturned");

  // DB: the challenge is OVERTURNED, the review reopened into a new round, history kept.
  expect(one(`SELECT state::text AS s, resolved_by_user_id::text AS by FROM reviewer_disagreements WHERE id = $1`, [challengeId])).toMatchObject({
    s: "RESOLVED_OVERTURNED",
    by: admin.userId,
  });
  await expect.poll(() => statusOf(r.workflowId)).not.toBe("APPROVED_INTERNAL");
  expect(roundOf(r.workflowId)).toBeGreaterThan(roundBefore);
  expect(decisionRows(r.workflowId)).toHaveLength(1);
  const reopened = eventsOf(r.workflowId, "REOPENED");
  expect(reopened.length).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(reopened[reopened.length - 1])).toContain(challengeId);
  // The Review page shows the reopened state (no final outcome for the new round).
  await openReview(page, r.workflowId);
  await expect(page.locator("[data-decision-outcome]")).toHaveCount(0);
  await shot(page, "j7-review-reopened");
  await pm.ctx.close();
  await pa.ctx.close();
});

// ============================================================================
// 8 — membership loss while a review is open
// ============================================================================

test("J8 — three-person Team (own fixture: the step-up enrols the owner's authenticator): the assignee is removed (API, step-up) while the decision form is open; the submit is refused in the UI and nothing is recorded", async ({ browser }) => {
  const t = await makeTeam(3);
  const m = t.members[0]!;
  const r = seedReview(t.teamId, t.owner.userId, "J8 membership loss");
  await assignAndStart(t, r.workflowId, m); // fixture (API)

  const pm = await signedInPage(browser, m);
  await openReview(pm.page, r.workflowId);
  const form = pm.page.locator("[data-decision-form]");
  await form.locator('[data-decision-choice="APPROVE"]').click();
  await form.locator("[data-decision-form-rationale]").fill("J8: approving after removal must not record.");

  // API (labelled): the owner removes the member with a step-up, as the Members page does.
  const memberRowId = String(one(`SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2`, [t.teamId, m.userId]).id);
  const hdr = await approvedStepUpHeader(t.owner, { teamId: t.teamId, purpose: "MEMBER_REVOKE", resourceKind: "team_member", resourceId: memberRowId });
  const removed = await t.owner.api.delete(`/v1/teams/${t.teamId}/members/${memberRowId}`, { headers: hdr, data: {} });
  expect(removed.status(), await removed.text()).toBeLessThan(300);
  expect(String(one(`SELECT status::text AS s FROM team_members WHERE id = $1`, [memberRowId]).s)).not.toBe("ACTIVE");

  const posted = waitPost(pm.page, /\/v1\/reviewer-ops\/workspace\/[^/]+\/decisions$/);
  await form.locator("[data-decision-form-submit]").click();
  const res = await posted;
  expect(res.status()).toBeGreaterThanOrEqual(400);
  const body = await jsonOf(res);
  note({ type: "J8 refusal (API answer)", description: `${res.status()} ${body.raw.slice(0, 200)}` });
  // UI: the refusal is said. The form first shows "Not recorded: …"; the page then re-reads,
  // the decision panel can no longer load for a removed member, and the page-level alert
  // states the reason. Defect D-1 (fixed): the typed draft stays readable, every action is
  // withdrawn and the header no longer says "You".
  const membershipAlert = pm.page.getByRole("alert").filter({ hasText: /active membership/i });
  await expect(membershipAlert).toBeVisible({ timeout: 20_000 });
  await expect(pm.page.locator("[data-decision-form]")).toHaveCount(0);
  await expect(pm.page.locator("[data-decision-kept-rationale]")).toHaveValue("J8: approving after removal must not record.");
  await expect
    .poll(async () =>
      pm.page
        .locator("[data-reviewer-actions] [data-reviewer-action]")
        .evaluateAll((els) => els.filter((e) => !(e as HTMLButtonElement).disabled && e.getAttribute("aria-disabled") !== "true").map((e) => e.getAttribute("data-reviewer-action"))),
    )
    .toEqual([]);
  await expect(pm.page.getByText(/Assignee:\s*You\b/)).toHaveCount(0);
  await shot(pm.page, "j8-refused-after-removal");
  note({ type: "J8 UI after refusal", description: (await membershipAlert.first().innerText()).slice(0, 200) });
  // DB: nothing recorded.
  expect(decisionRows(r.workflowId)).toEqual([]);
  expect(statusOf(r.workflowId)).not.toBe("APPROVED_INTERNAL");
  // Observation: what the page renders and who holds the review.
  const offered = await pm.page.locator("[data-reviewer-actions] [data-reviewer-action]").evaluateAll((els) => els.map((e) => e.getAttribute("data-reviewer-action")));
  note({
    type: "J8 actions rendered for the removed member (all disabled)",
    description: `${JSON.stringify(offered)} source=${await pm.page.locator("[data-reviewer-actions]").getAttribute("data-reviewer-actions-source")} header=${JSON.stringify((await pm.page.locator("[data-review-header-assignee]").innerText().catch(() => "")).trim())}`,
  });
  note({ type: "J8 assignee after removal (DB)", description: String(assigneeOf(r.workflowId) === m.userId ? "still the removed member" : assigneeOf(r.workflowId)) });
  const wsRead = await jsonOf(await m.api.get(`/v1/reviewer-ops/workspace/${r.workflowId}?teamId=${t.teamId}`));
  note({
    type: "J8 API-only: removed member reads the review projection",
    description: `${wsRead.status} actions=${JSON.stringify((wsRead.body?.viewer?.actions ?? []).filter((a: { allowed?: boolean }) => a.allowed).map((a: { action?: string }) => a.action))} ${wsRead.status >= 400 ? wsRead.raw.slice(0, 120) : ""}`,
  });
  const pauseTry = await jsonOf(await m.api.post(`/v1/reviewer-ops/reviews/${r.workflowId}/pause`, { data: { teamId: t.teamId, pausedReason: "J8 removed member" } }));
  note({ type: "J8 API-only: removed member Pause", description: `${pauseTry.status} ${pauseTry.raw.slice(0, 160)}` });
  expect(pauseTry.status).toBeGreaterThanOrEqual(400);
  await pm.ctx.close();
});

// ============================================================================
// 9 — Enterprise placement policy on/off, restricted-case reach
// ============================================================================

test("J9 — Enterprise organization workspace: contract placement on/off decides who the Inbox picker offers; a restricted case keeps an unreached member out", async ({ page }) => {
  await clearTestRateLimits();
  const owner = await createGuestSession({ plan: "FREE" });
  const org = provisionEnterpriseOrg(owner, "E2E Review Journeys Org"); // fixture
  const teamId = org.workspaceId;
  const sw = await owner.api.post("/v1/platform/context/switch-workspace", { data: { workspaceId: teamId } });
  expect(sw.ok(), await sw.text()).toBe(true);
  const placed = await createGuestSession();
  const unplaced = await createGuestSession();
  for (const s of [placed, unplaced]) {
    // fixture: ACTIVE workspace members of the organization workspace.
    sql(`INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'MEMBER', 'ACTIVE') ON CONFLICT DO NOTHING`, [teamId, s.userId]);
    await s.api.post("/v1/platform/context/switch-workspace", { data: { workspaceId: teamId } });
  }
  // fixture (API): a Collaboration Team with `placed` in it.
  const ct = await jsonOf(await owner.api.post("/v1/collaboration-teams", { data: { teamId, name: `Journeys ${Date.now().toString(36)}` } }));
  expect(ct.status, ct.raw).toBeLessThan(300);
  const ctId = String(ct.body?.team?.id ?? ct.body?.id);
  const add = await owner.api.post(`/v1/collaboration-teams/${ctId}/members`, { data: { teamId, userId: placed.userId, role: "MEMBER" } });
  expect(add.status(), await add.text()).toBeLessThan(300);
  const setPlacement = (on: boolean) =>
    sql(`UPDATE enterprise_contracts SET assignment_requires_team_placement = $2 WHERE organization_id = $1 RETURNING id`, [org.organizationId, on]);

  await signIn(page, owner);
  const openPicker = async (workflowId: string) => {
    await page.goto("/review?view=UNASSIGNED");
    await page.locator(`[data-inbox-row-assign="${workflowId}"]`).click({ timeout: 45_000 });
    await expect(page.locator("[data-reviewer-picker-modal]")).toHaveAttribute("data-reviewer-picker-state", "READY", { timeout: 20_000 });
  };

  // Placement ON: the unplaced member is listed but cannot be selected; the placed one is assigned.
  expect(setPlacement(true)).toHaveLength(1); // fixture (SQL): contract term
  const on = seedReview(teamId, owner.userId, "J9 placement on");
  await openPicker(on.workflowId);
  await expect(page.locator(`[data-reviewer-picker-select="${unplaced.userId}"]`)).toBeDisabled();
  await expect(page.locator(`[data-reviewer-picker-unplaced="${unplaced.userId}"]`)).toBeVisible();
  await shot(page, "j9-placement-on-picker");
  const a1 = waitPost(page, new RegExp(`/reviews/${on.workflowId}/assign$`));
  await page.locator(`[data-reviewer-picker-select="${placed.userId}"]`).click();
  expect((await a1).status()).toBe(200);
  await expect.poll(() => assigneeOf(on.workflowId)).toBe(placed.userId);
  // API-only: the unplaced member is refused by the server too.
  const on2 = seedReview(teamId, owner.userId, "J9 placement on, API");
  const refused = await jsonOf(await owner.api.post(`/v1/reviewer-ops/reviews/${on2.workflowId}/assign`, { data: { teamId, assignedToUserId: unplaced.userId } }));
  expect(refused.status, refused.raw).toBeGreaterThanOrEqual(400);
  expect(assigneeOf(on2.workflowId)).toBeNull();

  // Placement OFF: the unplaced member can be assigned in the picker.
  expect(setPlacement(false)).toHaveLength(1);
  const off = seedReview(teamId, owner.userId, "J9 placement off");
  await openPicker(off.workflowId);
  await expect(page.locator(`[data-reviewer-picker-select="${unplaced.userId}"]`)).toBeEnabled();
  const a2 = waitPost(page, new RegExp(`/reviews/${off.workflowId}/assign$`));
  await page.locator(`[data-reviewer-picker-select="${unplaced.userId}"]`).click();
  expect((await a2).status()).toBe(200);
  await expect.poll(() => assigneeOf(off.workflowId)).toBe(unplaced.userId);
  await shot(page, "j9-placement-off-assigned");

  // Restricted case (placement still off): `unplaced` has no CaseAccess → refused, nothing saved.
  const rc = seedReview(teamId, owner.userId, "J9 restricted case record");
  const kase = one(
    `INSERT INTO cases (name, owner_user_id, team_id, restricted_at_utc, updated_at) VALUES ('J9 restricted', $1, $2, now(), now()) RETURNING id`,
    [owner.userId, teamId],
  );
  const caseId = String(kase.id);
  sql(`INSERT INTO case_access (case_id, user_id) VALUES ($1, $2), ($1, $3)`, [caseId, owner.userId, placed.userId]);
  sql(`INSERT INTO case_evidence_links (team_id, case_id, evidence_id, updated_at) VALUES ($1, $2, $3, now())`, [teamId, caseId, rc.evidenceId]);
  await openPicker(rc.workflowId);
  // The picker lists workspace reviewers (it is not record-scoped); the server decides reach.
  const unreached = page.locator(`[data-reviewer-picker-select="${unplaced.userId}"]`);
  const offered = (await unreached.count()) > 0 && (await unreached.isEnabled());
  note({ type: "restricted-case picker", description: offered ? "unreached member listed + selectable; refused on select" : "unreached member not selectable" });
  if (offered) {
    const a3 = waitPost(page, new RegExp(`/reviews/${rc.workflowId}/assign$`));
    await unreached.click();
    const refusedUi = await a3;
    note({ type: "restricted-case refusal", description: `${refusedUi.status()} ${(await refusedUi.text()).slice(0, 160)}` });
    expect(refusedUi.status()).toBeGreaterThanOrEqual(400);
    await expect(page.getByText(/could not assign|not eligible|cannot/i).first()).toBeVisible();
  }
  await shot(page, "j9-restricted-case");
  expect(assigneeOf(rc.workflowId)).toBeNull();
  // API-only: the same refusal at the server; a reached member is accepted.
  const apiRefused = await owner.api.post(`/v1/reviewer-ops/reviews/${rc.workflowId}/assign`, { data: { teamId, assignedToUserId: unplaced.userId } });
  expect(apiRefused.status()).toBeGreaterThanOrEqual(400);
  const apiOk = await owner.api.post(`/v1/reviewer-ops/reviews/${rc.workflowId}/assign`, { data: { teamId, assignedToUserId: placed.userId } });
  expect(apiOk.status(), await apiOk.text()).toBe(200);
  expect(assigneeOf(rc.workflowId)).toBe(placed.userId);
});

// ============================================================================
// 10 — Coding through the UI
// ============================================================================

test("J10 — one-person Team: bind a schema, save, clear, a refused save then Retry, refresh, rebind, closed review read-only", async ({ page }) => {
  const t = await team1();
  const seeded = await t.owner.api.post("/v1/coding/schemas/seed-defaults", { data: { teamId: t.teamId } }); // fixture (API)
  expect(seeded.status(), await seeded.text()).toBeLessThan(300);
  const list = await jsonOf(await t.owner.api.get(`/v1/coding/schemas?teamId=${t.teamId}`));
  const schemas = (list.body?.schemas ?? list.body?.items ?? []) as Array<{ id: string; slug: string; label: string }>;
  const comp = schemas.find((s) => s.slug === "compliance-audit")!;
  const ins = schemas.find((s) => s.slug === "insurance-review")!;
  expect(comp && ins).toBeTruthy();
  const sch = await jsonOf(await t.owner.api.get(`/v1/coding/schemas/${comp.id}?teamId=${t.teamId}`));
  const notesId = String((sch.body?.schema?.fields ?? []).find((f: { slug: string }) => f.slug === "notes")?.id);
  expect(notesId).toMatch(/[0-9a-f-]{36}/);

  const r = seedReview(t.teamId, t.owner.userId, "J10 coding");
  await assignAndStart(t, r.workflowId, t.owner); // fixture (API)
  await signIn(page, t.owner);
  await openReview(page, r.workflowId);

  const bind = async (label: string) => {
    await page.locator("[data-coding-schema-binding-toggle]").click();
    const panel = page.locator("[data-coding-schema-binding]");
    await panel.getByRole("combobox").first().click();
    await page.getByRole("option", { name: label }).first().click();
    const bound = waitPost(page, /\/bind-schema$/);
    await page.locator("[data-coding-schema-binding-submit]").click();
    const confirm = page.getByRole("dialog").last();
    if (await confirm.isVisible().catch(() => false)) await confirm.getByRole("button").last().click();
    return bound;
  };
  // Bind through the UI; the fields render without a reload.
  expect((await bind(comp.label)).status()).toBeLessThan(300);
  const notesRow = page.locator(`[data-coding-field-id="${notesId}"]`);
  await expect(notesRow).toBeVisible({ timeout: 20_000 });
  const notes = notesRow.locator("textarea");
  const valueOf = () => one(`SELECT value->>'text' AS t FROM coding_values WHERE workflow_id = $1 AND field_id = $2`, [r.workflowId, notesId]).t ?? null;
  const historyCount = () => Number(one(`SELECT count(*)::int AS n FROM coding_value_history WHERE workflow_id = $1 AND field_id = $2`, [r.workflowId, notesId]).n);

  // Save.
  await notes.fill("J10 first note");
  await notes.blur();
  await expect(notesRow.locator('[data-coding-field-status="saved"]')).toBeVisible({ timeout: 20_000 });
  await expect.poll(valueOf).toBe("J10 first note");

  // Clear (explicit).
  await notes.fill("");
  await notes.blur();
  await expect(notesRow.locator('[data-coding-field-status="saved"]')).toBeVisible({ timeout: 20_000 });
  await expect.poll(valueOf).toBeNull();

  // A refused save: fixture (SQL) closes the review behind the open page; the API refuses.
  sql(`UPDATE evidence_review_workflows SET status = 'APPROVED_INTERNAL' WHERE id = $1`, [r.workflowId]);
  await notes.fill("J10 written while closed");
  const refusedWrite = waitPost(page, /\/v1\/reviewer\/work\/[^/]+\/code$/);
  await notes.blur();
  const refusedRes = await refusedWrite;
  console.log(`J10 refused coding write: ${refusedRes.status()} ${(await refusedRes.text()).slice(0, 200)}`);
  expect(refusedRes.status()).toBeGreaterThanOrEqual(400);
  const failed = notesRow.locator('[data-coding-field-status="failed"]');
  await expect(failed).toBeVisible({ timeout: 20_000 });
  console.log(`J10 field status line: ${await failed.innerText()}`);
  await expect(notes).toHaveValue("J10 written while closed"); // the draft is kept
  await shot(page, "j10-save-refused");
  expect(valueOf()).toBeNull();
  // fixture (SQL) reopens it; Retry sends the draft.
  sql(`UPDATE evidence_review_workflows SET status = 'IN_REVIEW' WHERE id = $1`, [r.workflowId]);
  await failed.locator("[data-coding-field-retry]").click();
  await expect(notesRow.locator('[data-coding-field-status="saved"]')).toBeVisible({ timeout: 20_000 });
  await expect.poll(valueOf).toBe("J10 written while closed");
  expect(historyCount()).toBeGreaterThanOrEqual(2);

  // Refresh shows the stored value.
  await page.reload();
  await expect(page.locator(`[data-coding-field-id="${notesId}"] textarea`)).toHaveValue("J10 written while closed", { timeout: 30_000 });

  // Rebind a different schema: its fields replace the old ones; the old value is listed as not current.
  expect((await bind(ins.label)).status()).toBeLessThan(300);
  await expect(page.locator(`[data-coding-field-id="${notesId}"]`)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator("[data-coding-field-row]").first()).toBeVisible();
  await expect(page.locator(`[data-review-coding-other-value="${notesId}"]`)).toHaveCount(1);
  expect(String(one(`SELECT coding_schema_id::text AS s FROM evidence_review_workflows WHERE id = $1`, [r.workflowId]).s)).toBe(ins.id);
  expect(valueOf()).toBe("J10 written while closed"); // nothing was deleted
  await shot(page, "j10-rebound");

  // Closed review: the fields are read-only and say why.
  expect((await uiDecide(page, "APPROVE", "J10: decided; coding is closed.")).status()).toBeLessThan(300);
  await expect.poll(() => statusOf(r.workflowId)).toBe("APPROVED_INTERNAL");
  await page.reload();
  await expect(page.locator('[data-coding-panel][data-coding-read-only="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-coding-read-only-reason]")).toContainText("closed");
  await expect(page.locator("[data-coding-field-row] textarea, [data-coding-field-row] input")).toHaveCount(0);
  await shot(page, "j10-closed-read-only");
});

// ============================================================================
// 11 — bulk partial failure in the Inbox
// ============================================================================

test("J11 — one-person Team: a partial bulk Pause keeps only the failed item selected; Retry failed re-sends only it", async ({ page }) => {
  const t = await team1();
  const rs = [0, 1, 2].map((i) => seedReview(t.teamId, t.owner.userId, `J11 bulk ${i}`));
  for (const r of rs) await assignAndStart(t, r.workflowId, t.owner); // fixture (API)
  // fixture (API): one review is already paused → pausing it again fails.
  const pre = await t.owner.api.post(`/v1/reviewer-ops/reviews/${rs[0]!.workflowId}/pause`, { data: { teamId: t.teamId, pausedReason: "J11 already paused" } });
  expect(pre.status(), await pre.text()).toBe(200);

  await signIn(page, t.owner);
  await page.goto("/review?view=ALL_OPEN");
  for (const r of rs) {
    const box = page.locator(`[data-inbox-row="${r.workflowId}"] input[type="checkbox"]`);
    await expect(box).toBeVisible({ timeout: 45_000 });
    await box.check();
  }
  const bar = page.locator("[data-reviewer-bulk-actions-bar]");
  await expect(bar).toHaveAttribute("data-reviewer-bulk-selected-count", "3");
  await bar.locator("[data-reviewer-bulk-note-action]").click();
  await page.getByRole("option", { name: /Pause/ }).first().click();
  await bar.locator("[data-reviewer-bulk-note-input]").fill("J11 bulk pause");
  const sent = waitPost(page, /\/reviews\/bulk$/);
  await bar.locator('[data-reviewer-bulk-action="WITH_NOTE_APPLY"]').click();
  const confirm = page.getByRole("dialog", { name: /Apply pause to 3 reviews/ });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Apply pause" }).click();
  const res = await sent;
  const body = await jsonOf(res);
  expect(res.status(), body.raw).toBe(207);
  expect(body.body).toMatchObject({ total: 3, succeeded: 2, failed: 1 });

  await expect(page.locator('[data-reviewer-bulk-report="partial"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-reviewer-bulk-failed-workflow="${rs[0]!.workflowId}"]`)).toBeVisible();
  await expect(page.locator("[data-reviewer-bulk-status]")).toContainText("2 updated");
  // Only the failed item stays selected.
  await expect(page.locator(`[data-inbox-row="${rs[0]!.workflowId}"] input[type="checkbox"]`)).toBeChecked();
  for (const r of rs.slice(1)) await expect(page.locator(`[data-inbox-row="${r.workflowId}"] input[type="checkbox"]`)).not.toBeChecked();
  await expect(page.locator("[data-reviewer-bulk-actions-bar]")).toHaveAttribute("data-reviewer-bulk-selected-count", "1");
  await shot(page, "j11-partial-failed-selected");
  // DB: the two others are paused.
  for (const r of rs.slice(1)) expect(one(`SELECT sla_paused_at_utc IS NOT NULL AS p FROM evidence_review_workflows WHERE id = $1`, [r.workflowId]).p).toBe(true);

  // fixture (API): resume the failed one so the retry can succeed; Retry failed sends only it.
  const resumed = await t.owner.api.post(`/v1/reviewer-ops/reviews/${rs[0]!.workflowId}/resume`, { data: { teamId: t.teamId } });
  expect(resumed.status(), await resumed.text()).toBe(200);
  const retried = page.waitForRequest((q) => q.method() === "POST" && /\/reviews\/bulk$/.test(new URL(q.url()).pathname));
  await page.locator("[data-reviewer-bulk-retry-failed]").click();
  const retryReq = await retried;
  expect((retryReq.postDataJSON() as { workflowIds: string[] }).workflowIds).toEqual([rs[0]!.workflowId]);
  const retryRes = await retryReq.response();
  expect(retryRes!.status()).toBe(200);
  await expect(page.locator('[data-reviewer-bulk-report="ok"]')).toBeVisible({ timeout: 20_000 });
  expect(one(`SELECT sla_paused_at_utc IS NOT NULL AS p FROM evidence_review_workflows WHERE id = $1`, [rs[0]!.workflowId]).p).toBe(true);
  await shot(page, "j11-retry-failed-ok");
});

// ============================================================================
// 12 — External Review invitation and renewal (Personal Team workspace)
// ============================================================================

test("J12 — Team Personal workspace: External Review invitation and renewal in the UI with step-up; the recorded invitation opens the portal", async ({ page, browser }) => {
  await clearTestRateLimits();
  const owner = await createGuestSession({ plan: "TEAM" });
  const teamId = await personalWorkspaceId(owner.api);
  const title = `J12 external subject ${Date.now().toString(36)}`;
  // fixture (SQL): a signed evidence record in the workspace (an API-created record without bytes is not listed as active).
  const { evidenceId } = seedReview(teamId, owner.userId, title);
  const listed = await jsonOf(await owner.api.get(`/v1/evidence?${new URLSearchParams({ scope: "active", teamId, search: title })}`));
  note({ type: "scope search (API)", description: `${listed.status} items=${(listed.body?.items ?? []).length}` });
  await signIn(page, owner);
  const next = await enrolTotp(owner); // fixture (API): the step-up test factor
  const ext = `j12-${Date.now()}@example.test`;

  await page.goto("/review/external");
  await page.locator("[data-invite-reviewer-action]").click({ timeout: 45_000 });
  const panel = page.locator("[data-bulk-invite-panel]");
  await expect(panel).toBeVisible();
  await panel.locator('[data-bulk-scope-kind="EVIDENCE"] input').check();
  await panel.locator("[data-bulk-scope-search]").fill(title);
  const option = panel.locator(`[data-bulk-scope-option="${evidenceId}"] input`);
  await expect(option).toBeVisible({ timeout: 20_000 });
  await option.check();
  await panel.locator("[data-bulk-paste]").fill(`${ext},J12 External,J12 Org`);
  const submit = panel.locator("[data-bulk-issue-submit]");
  await expect(submit).toBeEnabled();
  const issued = page.waitForResponse(
    (x) => x.request().method() === "POST" && /\/v1\/external-review\/invitations\/bulk$/.test(new URL(x.url()).pathname) && x.status() < 400,
    { timeout: 120_000 },
  );
  await submit.click();
  await answerStepUp(page, next);
  expect((await issued).status()).toBe(201);
  await expect(page.locator('[data-bulk-outcome="INVITED"]')).toBeVisible({ timeout: 20_000 });
  const grant = one(`SELECT id, team_id::text AS team, state::text AS state, evidence_id::text AS ev, expires_at_utc FROM external_review_grants WHERE reviewer_email = $1`, [ext]);
  expect(grant).toMatchObject({ team: teamId, state: "INVITED", ev: evidenceId });
  const grantId = String(grant.id);
  const expiresBefore = new Date(String(grant.expires_at_utc)).getTime();
  await shot(page, "j12-invited");

  // The recorded invitation (isolated transport) opens the portal.
  if (!MAILBOX) {
    note({ type: "skip-mailbox", description: "EMAIL_RECORDER_FILE is not set: the invitation mailbox steps are skipped (no recorded transport)." });
  } else {
    await expect.poll(() => mails(ext).filter((m) => m.actionableLink).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const link = String(mails(ext).filter((m) => m.actionableLink).pop()!.actionableLink);
    const xctx = await browser.newContext({ baseURL: WEB });
    const xp = await xctx.newPage();
    await answerCookieBanner(xp);
    await xp.goto(link.replace(/^https?:\/\/[^/]+/, WEB));
    await expect(xp.locator("body")).toContainText(/External Reviewer Portal/i, { timeout: 30_000 });
    await shot(xp, "j12-portal-landing");
    await xctx.close();
  }

  // Renewal through the invitation drawer (confirm + step-up).
  await page.goto("/review/external");
  await page.getByRole("tab", { name: /^Pending/ }).click({ timeout: 45_000 });
  await page.locator(`[data-invitation-open="${grantId}"]`).click();
  const renew = page.locator(`[data-invitation-renew="${grantId}"]`);
  await expect(renew).toBeVisible({ timeout: 20_000 });
  const renewed = page.waitForResponse(
    (x) => x.request().method() === "POST" && /\/renew$/.test(new URL(x.url()).pathname) && x.status() < 400,
    { timeout: 120_000 },
  );
  await renew.click();
  await page.getByRole("dialog").last().getByRole("button", { name: /^Renew for/ }).click();
  await answerStepUp(page, next);
  expect((await renewed).status()).toBeLessThan(300);
  await expect.poll(() => new Date(String(one(`SELECT expires_at_utc FROM external_review_grants WHERE id = $1`, [grantId]).expires_at_utc)).getTime()).toBeGreaterThan(expiresBefore);
  await shot(page, "j12-renewed");
});

// ============================================================================
// 13 — saved views: permissions + duplicate name
// ============================================================================

test("J13 — ten-person Team: the owner saves a view, a duplicate name is refused with the message; a Viewer is not offered Save", async ({ page, browser }) => {
  const t = await team10();
  const viewer = t.members[8]!;
  const name = `J13 overdue ${Date.now().toString(36)}`;
  await signIn(page, t.owner);
  await page.goto("/review?view=OVERDUE");
  const create = page.locator("[data-reviewer-saved-view-create]");
  await expect(create).toBeVisible({ timeout: 45_000 });
  const form = page.locator("[data-reviewer-saved-view-form]");
  const save = async () => {
    await create.click();
    await form.locator("[data-reviewer-saved-view-name]").fill(name);
    const posted = waitPost(page, /\/saved-views$/);
    await form.locator("[data-reviewer-saved-view-submit]").click();
    return posted;
  };
  expect((await save()).status()).toBeLessThan(300);
  await expect(page.locator("[data-reviewer-saved-view-row]").filter({ hasText: name })).toBeVisible({ timeout: 20_000 });
  expect(sql(`SELECT name FROM saved_search_views WHERE team_id = $1 AND name = $2`, [t.teamId, name])).toHaveLength(1);

  const dup = await save();
  expect(dup.status()).toBeGreaterThanOrEqual(400);
  await expect(page.locator("[data-reviewer-saved-view-error]")).toContainText(`A view named “${name}” already exists`);
  expect(sql(`SELECT name FROM saved_search_views WHERE team_id = $1 AND name = $2`, [t.teamId, name])).toHaveLength(1);
  await shot(page, "j13-duplicate-name");

  const pv = await signedInPage(browser, viewer);
  await pv.page.goto("/review");
  await expect(pv.page.locator("main")).toBeVisible({ timeout: 45_000 });
  await expect(pv.page.locator("[data-reviewer-saved-views], [data-review-page], main").first()).toBeVisible();
  await expect(pv.page.locator("[data-reviewer-saved-view-create]")).toHaveCount(0);
  await shot(pv.page, "j13-viewer-no-save");
  // API-only: the server refuses a Viewer's saved view too.
  const vCreate = await viewer.api.post("/v1/reviewer-ops/saved-views", {
    data: { teamId: t.teamId, name: "J13 viewer view", visibility: "PRIVATE", filter: { teamId: t.teamId } },
  });
  expect(vCreate.status()).toBeGreaterThanOrEqual(400);
  await pv.ctx.close();
});
