/**
 * REVIEW REMEDIATION — independent-review corrections in the browser
 * (2026-11-28, PR #13: IR-01, IR-02 and the media / navigation journey).
 *
 * Every journey drives the real Review page and reads the saved result back
 * from the database. Fixture steps with no user-facing control in the journey
 * (seeding a review, binding a schema, a second reviewer's decision) are done
 * by SQL or API and are labelled "fixture".
 *
 *  - IR-01: a value saved in this tab, replaced from ANOTHER TAB, re-read in
 *    page (the same mounted panel: a refused decision reloads the page's
 *    panels) and edited back is sent on the new revision and stored.
 *  - IR-02: recording a decision first saves what is entered in Coding and
 *    waits for it (a delayed save with a newer pending edit: approval and
 *    adjudication); a save that fails or conflicts holds the decision with
 *    the reason, keeps both drafts and records nothing until it is resolved
 *    (rejection after a network failure; approval after a conflict).
 *  - IR-02 boundary (second review): from Record decision until recorded / held /
 *    refused / cancelled, Coding is paused (A: edit during a delayed save; B: edit
 *    while identity confirmation is pending; C: cancelled confirmation releases it;
 *    D: failed and timed-out saves send no decision; F: adjudication).
 *  - Media: a real MP4 (VP9) plays, pauses and steps frames; a real PNG and a
 *    real PDF preview; a record with no stored file says so; Back returns to
 *    the Inbox view the review was opened from.
 */

import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { test, expect, type Browser, type BrowserContext, type Page, type Request, type Response } from "@playwright/test";

import {
  authorizeOriginalPart,
  clearTestRateLimits,
  createGuestSession,
  personalWorkspaceId,
  SESSION_PASSWORD,
  type GuestSession,
} from "./helpers/api-client";
import { answerCookieBanner } from "./helpers/consent";

const WEB = process.env.WEB_BASE ?? "http://localhost:3192";

test.use({ actionTimeout: 10_000, navigationTimeout: 45_000 });
test.setTimeout(300_000);

// ============================================================================
// Database helpers (the stack's disposable database)
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

function fixturePath(name: string): string {
  return join(dirname(apiDir()), "..", "e2e", "fixtures", "review-media", name);
}

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
const statusOf = (workflowId: string) =>
  String(one(`SELECT status::text AS s FROM evidence_review_workflows WHERE id = $1`, [workflowId]).s);
const codedText = (workflowId: string, fieldId: string) =>
  (one(`SELECT value->>'text' AS t FROM coding_values WHERE workflow_id = $1 AND field_id = $2`, [workflowId, fieldId]).t as string | null) ?? null;
const decisionRows = (workflowId: string) =>
  sql(
    `SELECT stage::text AS stage, decision::text AS decision FROM workflow_review_decisions WHERE workflow_id = $1 ORDER BY decided_at`,
    [workflowId],
  ) as Array<{ stage: string; decision: string }>;
/** The coding snapshot stored with the newest finalizing decision event. */
function snapshotNotes(workflowId: string): unknown {
  const row = one(
    `SELECT next_value FROM evidence_review_workflow_events
      WHERE workflow_id = $1 AND event_type::text = 'DECISION_LOGGED' AND next_value ? 'codingSnapshot'
      ORDER BY created_at DESC LIMIT 1`,
    [workflowId],
  ) as { next_value?: { codingSnapshot?: { values?: Array<{ slug: string; value: { text?: string } | null }> } } };
  return row.next_value?.codingSnapshot?.values?.find((v) => v.slug === "notes")?.value?.text ?? null;
}

async function jsonOf(res: { text(): Promise<string> }) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ============================================================================
// Teams and reviews
// ============================================================================

type Team = { owner: GuestSession; members: GuestSession[]; teamId: string };

async function makeTeam(size: number): Promise<Team> {
  await clearTestRateLimits();
  const owner = await createGuestSession({ plan: "TEAM" });
  const teamId = await personalWorkspaceId(owner.api);
  const members: GuestSession[] = [];
  for (let i = 0; i < size - 1; i += 1) {
    await clearTestRateLimits();
    const m = await createGuestSession();
    sql(`INSERT INTO team_members (team_id, user_id, role, status) VALUES ($1, $2, 'MEMBER', 'ACTIVE') ON CONFLICT DO NOTHING`, [teamId, m.userId]); // fixture
    const switched = await m.api.post("/v1/platform/context/switch-workspace", { data: { workspaceId: teamId } });
    expect(switched.ok(), await switched.text()).toBe(true);
    members.push(m);
  }
  return { owner, members, teamId };
}

/** fixture: a NOT_STARTED, unassigned review of an existing (or a new file-less) evidence record. */
function seedReview(teamId: string, ownerUserId: string, title: string, evidenceId?: string): { workflowId: string; evidenceId: string } {
  const id =
    evidenceId ??
    String(
      sql(
        `INSERT INTO evidence (type, owner_user_id, team_id, organization_id, status, title, updated_at)
         SELECT 'PHOTO', $1, t.id, t.organization_id, 'SIGNED', $3, now() FROM teams t WHERE t.id = $2 RETURNING id`,
        [ownerUserId, teamId, title],
      )[0]!.id,
    );
  // A completed upload already opened its review workflow; reuse it.
  const existing = sql(`SELECT id FROM evidence_review_workflows WHERE evidence_id = $1`, [id]);
  if (existing.length > 0) return { workflowId: String(existing[0]!.id), evidenceId: id };
  const wf = sql(
    `INSERT INTO evidence_review_workflows (evidence_id, team_id, workspace_type, status, updated_at)
     VALUES ($1, $2, 'TEAM', 'NOT_STARTED', now()) RETURNING id`,
    [id, teamId],
  );
  return { workflowId: String(wf[0]!.id), evidenceId: id };
}

async function assignAndStart(t: Team, workflowId: string, assignee: GuestSession) {
  const assigned = await t.owner.api.post(`/v1/reviewer-ops/reviews/${workflowId}/assign`, { data: { teamId: t.teamId, assignedToUserId: assignee.userId } });
  expect(assigned.status(), await assigned.text()).toBe(200);
  const started = await assignee.api.post(`/v1/reviewer-ops/reviews/${workflowId}/start`, { data: { teamId: t.teamId } });
  expect(started.status(), await started.text()).toBe(200);
}

/** fixture (API): seed the default schemas and bind compliance-audit; returns its "notes" field id. */
async function bindNotesSchema(t: Team, workflowId: string): Promise<string> {
  const seeded = await t.owner.api.post("/v1/coding/schemas/seed-defaults", { data: { teamId: t.teamId } });
  expect(seeded.status(), await seeded.text()).toBeLessThan(300);
  const list = await jsonOf(await t.owner.api.get(`/v1/coding/schemas?teamId=${t.teamId}`));
  const schemas = (list?.schemas ?? list?.items ?? []) as Array<{ id: string; slug: string }>;
  const comp = schemas.find((s) => s.slug === "compliance-audit")!;
  const bound = await t.owner.api.post(`/v1/reviewer/work/${workflowId}/bind-schema?teamId=${t.teamId}`, { data: { schemaId: comp.id } });
  expect(bound.status(), await bound.text()).toBeLessThan(300);
  const sch = await jsonOf(await t.owner.api.get(`/v1/coding/schemas/${comp.id}?teamId=${t.teamId}`));
  const notesId = String((sch?.schema?.fields ?? []).find((f: { slug: string }) => f.slug === "notes")?.id);
  expect(notesId).toMatch(/[0-9a-f-]{36}/);
  return notesId;
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

async function openReview(page: Page, workflowId: string, query = ""): Promise<void> {
  await page.goto(`/reviewer-ops/${workflowId}${query}`);
  await expect(page.locator("[data-reviewer-actions]")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("[data-decision-panel]")).toBeVisible({ timeout: 30_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: false });
}

const isDecisionPost = (r: Request) => r.method() === "POST" && /\/v1\/reviewer-ops\/workspace\/[^/]+\/decisions$/.test(new URL(r.url()).pathname);
const isCodePost = (r: Request) => r.method() === "POST" && /\/v1\/reviewer\/work\/[^/]+\/code$/.test(new URL(r.url()).pathname);

/** Count the decision POSTs a page sends (to prove a held decision sent none). */
function countDecisionPosts(page: Page): { count: () => number } {
  let n = 0;
  page.on("request", (r) => {
    if (isDecisionPost(r)) n += 1;
  });
  return { count: () => n };
}

/** Choose a decision and fill the rationale (no submit). */
async function fillDecision(page: Page, kind: string, rationale: string) {
  const form = page.locator("[data-decision-form]");
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.locator(`[data-decision-choice="${kind}"]`).click();
  await form.locator("[data-decision-form-rationale]").fill(rationale);
  return form;
}

/**
 * Hold every coding write the page sends until `release()` (a slow network
 * the test controls). The held requests then continue to the real API.
 */
async function holdCodingWrites(page: Page) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const held: string[] = [];
  await page.route("**/v1/reviewer/work/*/code*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    held.push(String(route.request().postData() ?? ""));
    await gate;
    await route.continue();
  });
  return { held, release: () => open() };
}

// ============================================================================
// IR-01
// ============================================================================

test("IR-01 — save A, another tab stores B, an in-page reread shows B; editing back to A is sent on the new revision and stored", async ({ browser }) => {
  const t = await makeTeam(1);
  const r = seedReview(t.teamId, t.owner.userId, "IR-01 refresh");
  await assignAndStart(t, r.workflowId, t.owner); // fixture (API)
  const notesId = await bindNotesSchema(t, r.workflowId); // fixture (API)

  const tab1 = await signedInPage(browser, t.owner);
  await openReview(tab1.page, r.workflowId);
  const row1 = tab1.page.locator(`[data-coding-field-id="${notesId}"]`);
  const notes1 = row1.locator("textarea");
  await notes1.fill("A — this tab");
  await notes1.blur();
  await expect(row1.locator('[data-coding-field-status="saved"]')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => codedText(r.workflowId, notesId)).toBe("A — this tab");

  // ANOTHER TAB of the same reviewer stores B.
  const tab2 = await tab1.ctx.newPage();
  await openReview(tab2, r.workflowId);
  const notes2 = tab2.locator(`[data-coding-field-id="${notesId}"] textarea`);
  await expect(notes2).toHaveValue("A — this tab", { timeout: 20_000 });
  await notes2.fill("B — other tab");
  await notes2.blur();
  await expect(tab2.locator(`[data-coding-field-id="${notesId}"] [data-coding-field-status="saved"]`)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => codedText(r.workflowId, notesId)).toBe("B — other tab");

  // In tab 1, a refused decision (forbidden wording) reloads the page's panels
  // in place — the same mounted coding panel re-reads B. The decision draft stays.
  const form = await fillDecision(tab1.page, "APPROVE", "The file is tamper-proof.");
  const refused = tab1.page.waitForResponse((res) => isDecisionPost(res.request()));
  await form.locator("[data-decision-form-submit]").click();
  expect((await refused).status()).toBeGreaterThanOrEqual(400);
  await expect(form.locator("[data-decision-form-rationale]")).toHaveValue("The file is tamper-proof.");
  await expect(notes1).toHaveValue("B — other tab", { timeout: 20_000 });
  // The old "Saved" (for A) no longer stands next to B.
  await expect(row1.locator('[data-coding-field-status="saved"]')).toHaveCount(0);
  await shot(tab1.page, "ir01-reread-shows-other-tab");

  // Editing back to A is SENT (before IR-01 it was skipped as "already A").
  await notes1.fill("A — this tab");
  const write = tab1.page.waitForRequest(isCodePost);
  await notes1.blur();
  const body = JSON.parse(String((await write).postData()));
  expect(body).toMatchObject({ fieldId: notesId, value: { text: "A — this tab" }, expectedRevision: 2 });
  await expect(row1.locator('[data-coding-field-status="saved"]')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => codedText(r.workflowId, notesId)).toBe("A — this tab");
  await tab1.ctx.close();
});

// ============================================================================
// IR-02
// ============================================================================

test("IR-02 — approval while a coding save is delayed and a newer edit is pending: the decision waits, then records with the latest value in its snapshot", async ({ browser }) => {
  const t = await makeTeam(1);
  const r = seedReview(t.teamId, t.owner.userId, "IR-02 delayed");
  await assignAndStart(t, r.workflowId, t.owner); // fixture (API)
  const notesId = await bindNotesSchema(t, r.workflowId); // fixture (API)
  const { ctx, page } = await signedInPage(browser, t.owner);
  await openReview(page, r.workflowId);
  const posts = countDecisionPosts(page);
  const hold = await holdCodingWrites(page);
  const notes = page.locator(`[data-coding-field-id="${notesId}"] textarea`);

  await notes.fill("first entry");
  await notes.blur();
  await expect.poll(() => hold.held.length).toBe(1);
  await notes.fill("latest entry");
  await notes.blur(); // queued behind the delayed save

  const form = await fillDecision(page, "APPROVE", "IR-02: consistent; coding saved first.");
  await form.locator("[data-decision-form-submit]").click();
  await expect(form.locator("[data-decision-form-submit]")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator('[data-coding-paused="true"]')).toBeVisible();
  expect(posts.count(), "no decision is sent while the coding save is pending").toBe(0);
  await shot(page, "ir02-decision-waits-for-coding");

  hold.release();
  await expect.poll(() => statusOf(r.workflowId), { timeout: 30_000 }).toBe("APPROVED_INTERNAL");
  expect(posts.count()).toBe(1);
  expect(codedText(r.workflowId, notesId)).toBe("latest entry");
  expect(snapshotNotes(r.workflowId)).toBe("latest entry");
  await ctx.close();
});

test("IR-02 — rejection after a coding save failed (network): held with the reason, both drafts kept, nothing recorded; Retry, then the rejection records with the value", async ({ browser }) => {
  const t = await makeTeam(1);
  const r = seedReview(t.teamId, t.owner.userId, "IR-02 failure");
  await assignAndStart(t, r.workflowId, t.owner); // fixture (API)
  const notesId = await bindNotesSchema(t, r.workflowId); // fixture (API)
  const { ctx, page } = await signedInPage(browser, t.owner);
  await openReview(page, r.workflowId);
  const posts = countDecisionPosts(page);
  const row = page.locator(`[data-coding-field-id="${notesId}"]`);
  const notes = row.locator("textarea");

  await page.route("**/v1/reviewer/work/*/code*", (route) =>
    route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue(),
  );
  await notes.fill("written while offline");
  await notes.blur();
  await expect(row.locator('[data-coding-field-status="failed"]')).toBeVisible({ timeout: 20_000 });

  const form = await fillDecision(page, "REJECT", "IR-02: the export log is missing.");
  await form.locator("[data-decision-form-submit]").click();
  await expect(form).toContainText("is not saved", { timeout: 30_000 });
  await expect(form).toContainText("Reviewer notes");
  await expect(form.locator("[data-decision-form-rationale]")).toHaveValue("IR-02: the export log is missing.");
  await expect(notes).toHaveValue("written while offline");
  expect(posts.count()).toBe(0);
  expect(decisionRows(r.workflowId)).toEqual([]);
  expect(statusOf(r.workflowId)).toBe("IN_REVIEW");
  await shot(page, "ir02-held-coding-failed");

  await page.unroute("**/v1/reviewer/work/*/code*");
  await row.locator("[data-coding-field-retry]").click();
  await expect(row.locator('[data-coding-field-status="saved"]')).toBeVisible({ timeout: 20_000 });
  await form.locator("[data-decision-form-submit]").click();
  await expect.poll(() => statusOf(r.workflowId), { timeout: 30_000 }).toBe("REJECTED_INSUFFICIENT");
  expect(snapshotNotes(r.workflowId)).toBe("written while offline");
  await ctx.close();
});

test("IR-02 — approval after a coding conflict: held, Reload shows the stored value, then the approval records it", async ({ browser }) => {
  const t = await makeTeam(1);
  const r = seedReview(t.teamId, t.owner.userId, "IR-02 conflict");
  await assignAndStart(t, r.workflowId, t.owner); // fixture (API)
  const notesId = await bindNotesSchema(t, r.workflowId); // fixture (API)
  const { ctx, page } = await signedInPage(browser, t.owner);
  await openReview(page, r.workflowId);
  const posts = countDecisionPosts(page);
  const row = page.locator(`[data-coding-field-id="${notesId}"]`);

  // fixture (API): another reviewer's write after this page loaded.
  const other = await t.owner.api.post(`/v1/reviewer/work/${r.workflowId}/code?teamId=${t.teamId}`, { data: { fieldId: notesId, value: { text: "theirs" } } });
  expect(other.status(), await other.text()).toBe(200);
  await row.locator("textarea").fill("mine");
  await row.locator("textarea").blur();
  await expect(row.locator('[data-coding-field-failure="conflict"]')).toBeVisible({ timeout: 20_000 });

  const form = await fillDecision(page, "APPROVE", "IR-02: consistent.");
  await form.locator("[data-decision-form-submit]").click();
  await expect(form).toContainText("is not saved", { timeout: 30_000 });
  expect(posts.count()).toBe(0);
  await row.locator("[data-coding-field-reload]").click();
  await expect(row.locator("textarea")).toHaveValue("theirs", { timeout: 20_000 });
  await form.locator("[data-decision-form-submit]").click();
  await expect.poll(() => statusOf(r.workflowId), { timeout: 30_000 }).toBe("APPROVED_INTERNAL");
  expect(snapshotNotes(r.workflowId)).toBe("theirs");
  await ctx.close();
});

test("IR-02 — adjudication while the adjudicator's coding save is delayed: recorded only after it, with the latest value in the snapshot", async ({ browser }) => {
  const t = await makeTeam(3);
  const [m1, m2] = t.members as [GuestSession, GuestSession];
  const r = seedReview(t.teamId, t.owner.userId, "IR-02 adjudication");
  sql(
    `INSERT INTO evidence_legal_holds (scope, evidence_id, team_id, status, title, placed_by_user_id, updated_at) VALUES ('EVIDENCE', $1, $2, 'ACTIVE', 'Hold', $3, now())`,
    [r.evidenceId, t.teamId, t.owner.userId],
  ); // fixture: a second review is required
  const notesId = await bindNotesSchema(t, r.workflowId); // fixture (API)
  await assignAndStart(t, r.workflowId, m1); // fixture (API)
  const d1 = await m1.api.post(`/v1/reviewer-ops/workspace/${r.workflowId}/decisions`, { data: { teamId: t.teamId, decision: "APPROVE", rationale: "first: consistent" } });
  expect(d1.status(), await d1.text()).toBeLessThan(300);
  const handed = await t.owner.api.post(`/v1/reviewer-ops/reviews/${r.workflowId}/reassign`, { data: { teamId: t.teamId, newAssigneeUserId: m2.userId } });
  expect(handed.status(), await handed.text()).toBe(200);
  const d2 = await m2.api.post(`/v1/reviewer-ops/workspace/${r.workflowId}/decisions`, { data: { teamId: t.teamId, decision: "REJECT", rationale: "second: gap" } });
  expect(d2.status(), await d2.text()).toBeLessThan(300); // fixture (API): the conflict

  const { ctx, page } = await signedInPage(browser, t.owner);
  await openReview(page, r.workflowId);
  await expect(page.locator("[data-adjudication-form]")).toBeVisible({ timeout: 30_000 });
  const posts = countDecisionPosts(page);
  const hold = await holdCodingWrites(page);
  const notes = page.locator(`[data-coding-field-id="${notesId}"] textarea`);
  await notes.fill("adjudicator draft");
  await notes.blur();
  await expect.poll(() => hold.held.length).toBe(1);
  await notes.fill("adjudicator final note");
  await notes.blur();

  const form = await fillDecision(page, "UPHOLD_SECOND", "IR-02: the gap holds.");
  await form.locator("[data-decision-form-submit]").click();
  await expect(form.locator("[data-decision-form-submit]")).toHaveAttribute("aria-busy", "true");
  // IR-02 boundary F — an edit attempted while the adjudication waits.
  const accepted = await tryEdit(confidenceInput(page), "55");
  expect(posts.count()).toBe(0);
  hold.release();
  await expect.poll(() => statusOf(r.workflowId), { timeout: 30_000 }).toBe("REJECTED_INSUFFICIENT");
  expect(decisionRows(r.workflowId).map((d) => `${d.stage}:${d.decision}`)).toEqual(["FIRST:APPROVE", "SECOND:REJECT", "ADJUDICATION:UPHOLD_SECOND"]);
  expect(snapshotNotes(r.workflowId)).toBe("adjudicator final note");
  expect((snapshotValue(r.workflowId, "confidence")?.confidence as number | undefined) ?? null).toBe(accepted ? 55 : null);
  expect(accepted, "Coding is paused while the adjudication is recorded").toBe(false);
  await ctx.close();
});

// ============================================================================
// IR-02 closure — the decision-submission boundary (2026-11-28)
//
// From the click on Record decision until the decision is recorded, held,
// refused or cancelled, an edit must never enter Coding and then be left out
// of the round's snapshot. Each journey states the OUTCOME first (whatever the
// UI accepted is what the snapshot holds), then that the pause refused it.
// Barriers are explicit request gates, never sleeps.
// ============================================================================

/** The stored snapshot value of a field (by slug) on the newest finalizing decision event. */
function snapshotValue(workflowId: string, slug: string): Record<string, unknown> | null {
  const row = one(
    `SELECT next_value FROM evidence_review_workflow_events
      WHERE workflow_id = $1 AND event_type::text = 'DECISION_LOGGED' AND next_value ? 'codingSnapshot'
      ORDER BY created_at DESC LIMIT 1`,
    [workflowId],
  ) as { next_value?: { codingSnapshot?: { values?: Array<{ slug: string; value: Record<string, unknown> | null }> } } };
  return row.next_value?.codingSnapshot?.values?.find((v) => v.slug === slug)?.value ?? null;
}

/** Try to type into a control; true only when the UI accepted the edit. */
async function tryEdit(field: ReturnType<Page["locator"]>, text: string): Promise<boolean> {
  try {
    await field.fill(text, { timeout: 2_000 });
    return (await field.inputValue()) === text;
  } catch {
    return false;
  }
}

/** fixture (API): the workspace requires identity confirmation for approvals (the Review policy checkbox). */
function requireStepUpForApprove(teamId: string): void {
  sql(
    `INSERT INTO workspace_governance_policies (team_id, require_step_up_for_approve, updated_at) VALUES ($1, true, now())
     ON CONFLICT (team_id) DO UPDATE SET require_step_up_for_approve = true`,
    [teamId],
  );
}

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
/** fixture (API): enrol the test authenticator; each call returns the next accepted code. */
async function enrolTotp(s: GuestSession): Promise<() => Promise<string>> {
  const st = await jsonOf(await s.api.post("/v1/identity/mfa/enroll/start", { data: { label: "E2E authenticator" } }));
  expect(st?.secretBase32 ?? st?.body?.secretBase32, JSON.stringify(st)).toBeTruthy();
  const body = st?.secretBase32 ? st : st.body;
  const secret = b32(body.secretBase32);
  let last = Math.floor(Date.now() / 1000 / 30);
  const ver = await s.api.post("/v1/identity/mfa/enroll/verify", { data: { factorId: body.factorId, code: totp(secret, last) } });
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

const confidenceInput = (page: Page) => page.locator('[data-coding-confidence] input[type="number"]');

test("IR-02 boundary A — approval while field A's save is delayed: an edit to field B during the wait is refused by the pause, never left out of the snapshot", async ({ browser }) => {
  const t = await makeTeam(1);
  const r = seedReview(t.teamId, t.owner.userId, "IR-02 boundary A");
  await assignAndStart(t, r.workflowId, t.owner); // fixture (API)
  const notesId = await bindNotesSchema(t, r.workflowId); // fixture (API)
  const { ctx, page } = await signedInPage(browser, t.owner);
  await openReview(page, r.workflowId);
  const posts = countDecisionPosts(page);
  const hold = await holdCodingWrites(page);
  const notes = page.locator(`[data-coding-field-id="${notesId}"] textarea`);

  // Field A (confidence) is saving behind the barrier.
  await confidenceInput(page).fill("70");
  await expect.poll(() => hold.held.length, { timeout: 10_000 }).toBe(1);

  const form = await fillDecision(page, "APPROVE", "IR-02 boundary A: consistent.");
  await form.locator("[data-decision-form-submit]").click();
  await expect(form.locator("[data-decision-form-submit]")).toHaveAttribute("aria-busy", "true");
  // While the page waits for A, the reviewer tries to type into field B (no blur).
  const typed = "typed while the decision waited";
  const accepted = await tryEdit(notes, typed);
  await shot(page, "ir02-boundary-a-paused");
  expect(posts.count(), "no decision is sent while field A is saving").toBe(0);

  hold.release();
  await expect.poll(() => statusOf(r.workflowId), { timeout: 30_000 }).toBe("APPROVED_INTERNAL");
  // OUTCOME: whatever the UI accepted is in the decision's snapshot.
  expect(snapshotValue(r.workflowId, "notes")?.text ?? null, "an edit the UI accepted must be in the snapshot").toBe(accepted ? typed : null);
  // The pause refused the edit; A's value is in the snapshot.
  expect(accepted, "Coding is paused during the submission").toBe(false);
  expect(snapshotValue(r.workflowId, "confidence")).toEqual({ confidence: 70 });
  expect(posts.count()).toBe(1);
  // E — finished: the panel shows the stored state, read-only, no pause line.
  await expect(page.locator("[data-coding-panel]")).toHaveAttribute("data-coding-read-only", "true", { timeout: 20_000 });
  await expect(page.locator("[data-coding-submission-note]")).toHaveCount(0);
  await ctx.close();
});

test("IR-02 boundary B+E — an edit after the coding flush while identity confirmation is pending is refused; the confirmed approval records the pre-boundary entry", async ({ browser }) => {
  const t = await makeTeam(1);
  const r = seedReview(t.teamId, t.owner.userId, "IR-02 boundary B");
  await assignAndStart(t, r.workflowId, t.owner); // fixture (API)
  const notesId = await bindNotesSchema(t, r.workflowId); // fixture (API)
  requireStepUpForApprove(t.teamId); // fixture
  // Sign in first: once a factor is enrolled, sign-in itself asks for it.
  const { ctx, page } = await signedInPage(browser, t.owner);
  const next = await enrolTotp(t.owner); // fixture (API): the test authenticator
  await openReview(page, r.workflowId);
  const notes = page.locator(`[data-coding-field-id="${notesId}"] textarea`);

  // Entered before the boundary, still focused (never blurred).
  await notes.fill("entered before the decision");
  const form = await fillDecision(page, "APPROVE", "IR-02 boundary B: consistent.");
  await form.locator("[data-decision-form-submit]").click();
  // The flush stored the entry; identity confirmation is now pending.
  const modal = page.locator("[data-step-up-modal]");
  await expect(modal).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => codedText(r.workflowId, notesId)).toBe("entered before the decision");
  const typed = "typed while confirming identity";
  const accepted = await tryEdit(notes, typed);
  await shot(page, "ir02-boundary-b-step-up-pending");

  const input = modal.locator("[data-step-up-code-input]");
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill(await next());
  await modal.locator("[data-step-up-verify]").click();
  await expect.poll(() => statusOf(r.workflowId), { timeout: 60_000 }).toBe("APPROVED_INTERNAL");
  expect(snapshotValue(r.workflowId, "notes")?.text ?? null, "an edit the UI accepted must be in the snapshot").toBe(
    accepted ? typed : "entered before the decision",
  );
  expect(accepted, "Coding is paused while identity confirmation is pending").toBe(false);
  await expect(page.locator("[data-coding-panel]")).toHaveAttribute("data-coding-read-only", "true", { timeout: 20_000 });
  await ctx.close();
});

test("IR-02 boundary C — cancelling identity confirmation releases the pause: Coding and the decision form are usable again with both drafts kept", async ({ browser }) => {
  const t = await makeTeam(1);
  const r = seedReview(t.teamId, t.owner.userId, "IR-02 boundary C");
  await assignAndStart(t, r.workflowId, t.owner); // fixture (API)
  const notesId = await bindNotesSchema(t, r.workflowId); // fixture (API)
  requireStepUpForApprove(t.teamId); // fixture
  // Sign in first: once a factor is enrolled, sign-in itself asks for it.
  const { ctx, page } = await signedInPage(browser, t.owner);
  const next = await enrolTotp(t.owner); // fixture (API): the test authenticator
  await openReview(page, r.workflowId);
  const posts = countDecisionPosts(page);
  const row = page.locator(`[data-coding-field-id="${notesId}"]`);
  const notes = row.locator("textarea");

  await notes.fill("draft before cancel");
  const form = await fillDecision(page, "APPROVE", "IR-02 boundary C: consistent.");
  await form.locator("[data-decision-form-submit]").click();
  const modal = page.locator("[data-step-up-modal]");
  await expect(modal).toBeVisible({ timeout: 20_000 });
  await expect(notes).toBeDisabled();
  await modal.locator("[data-step-up-cancel]").first().click();
  await expect(form).toContainText("cancelled", { timeout: 20_000 });
  // Released: both drafts are there and editable.
  await expect(form.locator("[data-decision-form-rationale]")).toHaveValue("IR-02 boundary C: consistent.");
  await expect(form.locator("[data-decision-form-rationale]")).toBeEnabled();
  await expect(notes).toBeEnabled();
  await expect(notes).toHaveValue("draft before cancel");
  await expect(page.locator("[data-coding-submission-note]")).toHaveCount(0);
  expect(decisionRows(r.workflowId)).toEqual([]);
  await shot(page, "ir02-boundary-c-cancelled-released");

  // Edit again, then confirm: the new entry is recorded.
  await notes.fill("edited after cancel");
  await notes.blur();
  await expect(row.locator('[data-coding-field-status="saved"]')).toBeVisible({ timeout: 20_000 });
  await form.locator("[data-decision-form-submit]").click();
  await expect(modal).toBeVisible({ timeout: 20_000 });
  const input = modal.locator("[data-step-up-code-input]");
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill(await next());
  await modal.locator("[data-step-up-verify]").click();
  await expect.poll(() => statusOf(r.workflowId), { timeout: 60_000 }).toBe("APPROVED_INTERNAL");
  expect(snapshotValue(r.workflowId, "notes")).toEqual({ text: "edited after cancel" });
  expect(posts.count()).toBeGreaterThanOrEqual(2); // the step-up challenge answer + the confirmed decision
  await ctx.close();
});

test("IR-02 boundary D — rejection: a coding save that fails inside the boundary holds the decision (no decision POST), releases the pause and keeps both drafts; a save that never settles holds at the timeout", async ({ browser }) => {
  test.setTimeout(240_000);
  const t = await makeTeam(1);
  const r = seedReview(t.teamId, t.owner.userId, "IR-02 boundary D");
  await assignAndStart(t, r.workflowId, t.owner); // fixture (API)
  const notesId = await bindNotesSchema(t, r.workflowId); // fixture (API)
  const { ctx, page } = await signedInPage(browser, t.owner);
  await openReview(page, r.workflowId);
  const posts = countDecisionPosts(page);
  const row = page.locator(`[data-coding-field-id="${notesId}"]`);
  const notes = row.locator("textarea");

  // (1) The save the flush sends fails at the barrier.
  let failNext = true;
  let releaseHang!: () => void;
  let hang = false;
  const hung = new Promise<void>((res) => (releaseHang = res));
  await page.route("**/v1/reviewer/work/*/code*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    if (failNext) {
      failNext = false;
      return route.abort("internetdisconnected");
    }
    if (hang) {
      await hung;
      return route.continue();
    }
    return route.continue();
  });
  await notes.fill("entered, then the save fails");
  const form = await fillDecision(page, "REJECT", "IR-02 boundary D: the log is missing.");
  await form.locator("[data-decision-form-submit]").click();
  await expect(form).toContainText("is not saved", { timeout: 30_000 });
  expect(posts.count(), "no decision POST after a failed save").toBe(0);
  expect(decisionRows(r.workflowId)).toEqual([]);
  await expect(notes).toBeEnabled();
  await expect(notes).toHaveValue("entered, then the save fails");
  await expect(form.locator("[data-decision-form-rationale]")).toHaveValue("IR-02 boundary D: the log is missing.");
  await shot(page, "ir02-boundary-d-failed-held");

  // (2) A save that never settles: held at the flush timeout, nothing sent.
  hang = true;
  await notes.fill("entered, then the save hangs");
  await form.locator("[data-decision-form-submit]").click();
  await expect(page.locator('[data-coding-submission-note="saving"]')).toBeVisible();
  await expect(form).toContainText("is not saved", { timeout: 45_000 });
  expect(posts.count(), "no decision POST after the timeout").toBe(0);
  await expect(notes).toBeEnabled();
  await expect(notes).toHaveValue("entered, then the save hangs");
  releaseHang();
  await expect(row.locator('[data-coding-field-status="saved"]')).toBeVisible({ timeout: 20_000 });

  // Resolved: the rejection records with the stored entry.
  await form.locator("[data-decision-form-submit]").click();
  await expect.poll(() => statusOf(r.workflowId), { timeout: 30_000 }).toBe("REJECTED_INSUFFICIENT");
  expect(posts.count()).toBe(1);
  expect(snapshotValue(r.workflowId, "notes")).toEqual({ text: "entered, then the save hangs" });
  await ctx.close();
});

// ============================================================================
// Real media + Inbox navigation
// ============================================================================

/** A small, valid one-page PDF with a line of text (xref offsets computed). */
function tinyPdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null, // content stream, below
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 14 Tf 24 72 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** fixture (API): a SIGNED evidence record whose original is the given bytes. */
async function uploadEvidence(t: Team, type: "VIDEO" | "PHOTO" | "DOCUMENT", mimeType: string, fileName: string, bytes: Buffer): Promise<string> {
  const created = await t.owner.api.post("/v1/evidence", { data: { type, mimeType, teamId: t.teamId } });
  expect(created.ok(), await created.text()).toBe(true);
  const id = String(((await created.json()) as { id: string }).id);
  const putUrl = await authorizeOriginalPart(t.owner.api, id, { mimeType, sizeBytes: bytes.length, originalFileName: fileName });
  const put = await fetch(putUrl, { method: "PUT", body: new Uint8Array(bytes), headers: { "Content-Type": mimeType } });
  expect(put.ok, `PUT ${put.status}`).toBe(true);
  const done = await t.owner.api.post(`/v1/evidence/${id}/complete`, { data: {} });
  expect(done.ok(), await done.text()).toBe(true);
  return id;
}

test("Media — a real MP4 plays, pauses and steps frames; a real PNG and PDF preview; a file-less record says so; Back returns to the Inbox view", async ({ page }) => {
  const t = await makeTeam(1);
  const video = seedReview(t.teamId, t.owner.userId, "IR media video", await uploadEvidence(t, "VIDEO", "video/mp4", "ir-journey.mp4", readFileSync(fixturePath("ir-journey.mp4"))));
  const image = seedReview(t.teamId, t.owner.userId, "IR media image", await uploadEvidence(t, "PHOTO", "image/png", "ir-journey.png", readFileSync(fixturePath("ir-journey.png"))));
  const pdf = seedReview(t.teamId, t.owner.userId, "IR media pdf", await uploadEvidence(t, "DOCUMENT", "application/pdf", "ir-journey.pdf", tinyPdf("PROOVRA review media journey")));
  const fileless = seedReview(t.teamId, t.owner.userId, "IR media no file");
  for (const r of [video, image, pdf, fileless]) await assignAndStart(t, r.workflowId, t.owner); // fixture (API)

  await signIn(page, t.owner);
  // Open the video review FROM a non-default Inbox view ("All open reviews";
  // the default view's link carries no parameter, so it would prove nothing).
  await page.goto("/review?view=ALL_OPEN");
  const openLink = page.locator(`a[href^="/reviewer-ops/${video.workflowId}?"]`).first();
  await expect(openLink).toBeVisible({ timeout: 45_000 });
  await openLink.click();
  await page.waitForURL(new RegExp(`/reviewer-ops/${video.workflowId}\\?.*view=ALL_OPEN`));
  await expect(page.locator('[data-review-evidence-preview][data-review-evidence-preview-state="ready"]')).toBeVisible({ timeout: 45_000 });
  const el = page.locator("[data-video-element]");
  await expect.poll(() => el.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  const duration = await el.evaluate((v: HTMLVideoElement) => v.duration);
  expect(duration).toBeGreaterThan(2.5);
  expect(duration).toBeLessThan(3.5);
  expect(await el.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(320);

  // Play / pause through the viewer's own controls.
  await page.locator('[data-video-toolbar-btn="video-play-pause"]').click();
  await expect.poll(() => el.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.3);
  expect(await el.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await page.locator('[data-video-toolbar-btn="video-play-pause"]').click();
  await expect.poll(() => el.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const paused = await el.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.waitForTimeout(400);
  expect(await el.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(paused, 3);
  // Frame stepping: one frame (1/30 s) forward, then back.
  await page.locator('[data-video-toolbar-btn="video-frame-fwd"]').click();
  await expect.poll(() => el.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(paused + 1 / 30, 2);
  await page.locator('[data-video-toolbar-btn="video-frame-back"]').click();
  await expect.poll(() => el.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(paused, 2);
  await expect(page.locator("[data-video-time]")).not.toContainText("0:00 / 0:00");
  await shot(page, "media-video-stepped");

  // Back returns to the Inbox view it was opened from.
  await page.locator("[data-review-back-link]").click();
  await page.waitForURL(/\/review\?(.*&)?view=ALL_OPEN/);
  await expect(page.locator('a[aria-current="page"]', { hasText: "All open reviews" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`a[href^="/reviewer-ops/${image.workflowId}?"]`).first()).toBeVisible({ timeout: 30_000 });

  // A real PNG.
  await openReview(page, image.workflowId);
  const img = page.locator("[data-image-viewer] img").first();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => (i.complete ? i.naturalWidth : 0)), { timeout: 30_000 }).toBe(640);
  await shot(page, "media-image");

  // A real PDF: the frame's document is the stored PDF.
  await openReview(page, pdf.workflowId);
  const frame = page.locator("[data-pdf-iframe]");
  await expect(frame).toBeVisible({ timeout: 30_000 });
  const src = String(await frame.getAttribute("src")).split("#")[0]!;
  const fetched = await page.request.get(src);
  expect(fetched.status()).toBe(200);
  expect(fetched.headers()["content-type"] ?? "").toContain("pdf");
  expect((await fetched.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  await shot(page, "media-pdf");

  // A record with no stored file says so instead of an empty player.
  await openReview(page, fileless.workflowId);
  const pv = page.locator("[data-review-evidence-preview]");
  await expect(pv).not.toHaveAttribute("data-review-evidence-preview-state", "loading", { timeout: 30_000 });
  await expect(pv).not.toHaveAttribute("data-review-evidence-preview-state", "ready");
  await expect(pv.locator("[data-media-viewer-unavailable]")).toBeVisible();
  await expect(pv.locator("video, [data-pdf-iframe]")).toHaveCount(0);
});
