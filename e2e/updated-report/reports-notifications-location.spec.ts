/**
 * ONE DISPOSABLE JOURNEY across the three repaired surfaces, on the real stack
 * (production API + worker images, production web build, Postgres, Redis,
 * MinIO, TSA) — no mocked API anywhere:
 *
 *   1. LOCATION — three records created the way capture clients create them:
 *      no location facts (an upload / legacy shape), real coordinates, and a
 *      declined location request. Each reads its canonical state on the owner
 *      Evidence page and in the review workspace; only the recorded one draws
 *      a map; nothing reads "Blocked"; and absence or a declined request never
 *      stops the report + verification package from being issued.
 *   2. REPORTS & ARTIFACTS — the compact summary (at most six metrics), each
 *      metric applying exactly its filter, and the listed records matching the
 *      metric; no raw internal code on the page.
 *   3. NOTIFICATIONS — a real @mention (a discussion thread opened through the
 *      product) reaches the member; marking it read keeps it under All and
 *      Read, removes it from Unread, survives a reload, and moves the server's
 *      unread count by exactly one; reading the thread itself never deletes it.
 */
import { test, expect, type Page } from "@playwright/test";

import { clearTestRateLimits, createGuestSession, type GuestSession } from "../helpers/api-client";
import { signIn } from "./_browser";
import { addWorkspaceMember, createFinalizedEvidence, personalTeamId, sql, waitForPair } from "./_stack";

test.describe.configure({ mode: "serial" });

let A: GuestSession;
let B: GuestSession;
let teamId = "";
const ids = { none: "", recorded: "", declined: "" };

/** Visible text that looks like an internal code: SCREAMING_SNAKE or snake_case words. */
const RAW_CODE = /\b[A-Z]{2,}(?:_[A-Z0-9]{2,})+\b|\b[a-z]{2,}(?:_[a-z0-9]{2,})+\b/;

test.beforeAll(async () => {
  await clearTestRateLimits();
  A = await createGuestSession();
  B = await createGuestSession();
  teamId = await personalTeamId(A.api);
  addWorkspaceMember(teamId, B.userId, "ADMIN");
  ids.none = (await createFinalizedEvidence(A.api, teamId, "rnl-no-location")).id;
  ids.recorded = (
    await createFinalizedEvidence(A.api, teamId, "rnl-recorded-location", undefined, {
      gps: { lat: 52.520008, lng: 13.404954, accuracyMeters: 12 },
    })
  ).id;
  ids.declined = (
    await createFinalizedEvidence(A.api, teamId, "rnl-declined-location", undefined, { locationRequestOutcome: "DENIED" })
  ).id;
  // Optional location never blocks issuance: every record gets its pair.
  for (const id of Object.values(ids)) await waitForPair(A.api, id, 1, 300_000);
});

async function openIntegrity(page: Page, evidenceId: string) {
  await page.goto(`/evidence/${evidenceId}`);
  await page.waitForSelector(".evidence-detail-hero", { timeout: 60_000 });
  await page.getByRole("tab", { name: "Integrity" }).click();
}

test("LOCATION: each record states its canonical location; only recorded coordinates draw a map; nothing is Blocked", async ({ page }) => {
  test.setTimeout(300_000);
  const want = { none: "NOT_RECORDED", recorded: "RECORDED", declined: "NOT_SHARED" } as const;
  for (const [k, state] of Object.entries(want) as Array<[keyof typeof ids, string]>) {
    const ws = await A.api.get(`/v1/evidence/${ids[k]}/review-workspace`);
    expect(ws.ok(), await ws.text()).toBe(true);
    expect(((await ws.json()) as { locationState?: { state?: string } }).locationState?.state, k).toBe(state);
  }

  await signIn(page, A.email);
  await openIntegrity(page, ids.none);
  // Plain absence: stated neutrally, no map, no failure.
  await expect(page.locator("main")).toContainText("Location not recorded");
  await expect(page.locator("[data-capture-location-source-label]")).toHaveCount(0);

  await openIntegrity(page, ids.recorded);
  const recorded = page.locator('[data-location-state="RECORDED"]').first();
  await expect(recorded).toBeVisible();
  await expect(recorded).toContainText("Location recorded");
  await expect(page.locator("[data-capture-location-source-label]").first()).toBeVisible();

  await openIntegrity(page, ids.declined);
  const declined = page.locator('[data-location-state="NOT_SHARED"]').first();
  await expect(declined).toBeVisible();
  await expect(declined).toContainText("Location not shared");
  await expect(page.locator("[data-capture-location-source-label]")).toHaveCount(0);

  for (const id of Object.values(ids)) {
    await openIntegrity(page, id);
    const section = page.locator('[data-evidence-section="capture-location"]');
    if ((await section.count()) > 0) await expect(section.first()).not.toContainText(/Blocked/i);
  }
});

test("REPORTS: exactly four semantic metrics; each applies exactly its filter; a compact one-line table; shared controls; no raw codes", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, A.email);
  await page.goto("/reports");
  const summary = page.locator("[data-reports-summary]");
  await expect(summary).toBeVisible({ timeout: 60_000 });
  const metrics = summary.locator("[data-reports-summary-key]");
  await expect(metrics.first()).toBeVisible();
  const keys = await metrics.evaluateAll((els) => els.map((e) => e.getAttribute("data-reports-summary-key")));
  // Exactly four, in order, in the canonical semantic tones.
  expect(keys).toEqual(["records", "in_progress", "needs_attention", "incomplete"]);
  const tones = await metrics.evaluateAll((els) => els.map((e) => e.getAttribute("data-app-metric-tone")));
  expect(tones).toEqual(["info", "accent", "warning", "danger"]);
  // The four sit in ONE row on a desktop page column.
  const tops = await metrics.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await expect(page.locator("[data-reports-breakdown]")).toHaveCount(1);
  await expect(page.locator("[data-reports-status-selector]")).toHaveCount(1);

  const valueOf = async (key: string) =>
    Number(await summary.locator(`[data-reports-summary-key="${key}"]`).first().getAttribute("data-reports-summary-value"));
  // All three records were issued: three records, nothing in progress or needing attention.
  expect(await valueOf("records")).toBe(3);
  expect(await valueOf("needs_attention")).toBe(0);
  await expect(page.locator('[data-reports-summary-key="reports_ready"], [data-reports-summary-key="packages_ready"]')).toHaveCount(0);

  // THE COMPACT TABLE: a real table (not stacked cards) on a desktop column,
  // one normal-height row per record, its actions on ONE line.
  const table = page.locator("table[data-reports-list-items]");
  await expect(table).toBeVisible();
  expect(await table.evaluate((t) => getComputedStyle(t).display)).toBe("table");
  await expect(page.locator("[data-reports-row-id]")).toHaveCount(3);
  for (const row of await page.locator("[data-reports-row-id]").all()) {
    const actions = row.locator("[data-reports-row-actions]");
    const h = await actions.evaluate((el) => el.getBoundingClientRect().height);
    expect(h, "the row's actions wrapped onto a second line").toBeLessThan(48);
    await expect(row.locator("[data-reports-download-report]")).toHaveAttribute("aria-label", "Download Report PDF");
  }
  // Shared controls: search field, AppListbox sort (no native select).
  await expect(page.locator(".app-search-field [data-reports-search-input]")).toBeVisible();
  await expect(page.locator("[data-reports-sort] [role='combobox']")).toBeVisible();
  await expect(page.locator("[data-reports-index] select")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("reports-desktop.png"), fullPage: true });

  // The Ready segment and the summary cards share ONE filter state.
  await page.locator('[data-reports-status-filter="ready"]').click();
  await expect(page).toHaveURL(/status=ready/);
  await expect(page.locator("[data-reports-row-id]")).toHaveCount(3);
  await summary.locator('[data-reports-summary-key="records"]').first().click();
  await expect(page.locator('[data-reports-status-filter="all"]')).toHaveAttribute("aria-pressed", "true");

  await summary.locator('[data-reports-summary-key="needs_attention"]').first().click();
  await expect(page).toHaveURL(/status=needs_attention/);
  await expect(page.locator("[data-reports-row-id]")).toHaveCount(0);
  await expect(page.locator('[data-reports-empty-kind]')).toBeVisible();

  // A stale deep link falls back safely instead of breaking the page.
  await page.goto("/reports?status=not_a_status&report=garbage");
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-reports-row-id]")).toHaveCount(3);

  const text = await page.locator("[data-reports-index]").innerText();
  expect(text, "a raw internal code reached the Reports page").not.toMatch(RAW_CODE);

  // NARROW: the established stacked rows — no horizontal page scroll hiding actions.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/reports");
  await expect(summary).toBeVisible({ timeout: 60_000 });
  expect(await table.evaluate((t) => getComputedStyle(t).display)).toBe("block");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
  await expect(page.locator("[data-reports-download-report]").first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("reports-narrow.png"), fullPage: true });
  await page.setViewportSize({ width: 1366, height: 900 });
});

test("NOTIFICATIONS: a read mention stays in All and Read, leaves Unread, survives a reload (and at 45 days old), and the count moves by exactly one", async ({ page }) => {
  test.setTimeout(300_000);
  const handle = B.email.split("@")[0]!.toLowerCase();
  const thread = await A.api.post("/v1/collaboration/threads", {
    data: {
      teamId,
      evidenceId: ids.none,
      kind: "EVIDENCE_GENERAL",
      visibility: "INTERNAL",
      title: "Please review this record",
      initialBody: `@${handle} please review the location statement`,
    },
  });
  expect(thread.ok(), await thread.text()).toBe(true);
  const threadId = ((await thread.json()) as { thread: { id: string } }).thread.id;

  const unread = async () => {
    const r = await B.api.get("/v1/me/inbox/summary");
    expect(r.ok(), await r.text()).toBe(true);
    return ((await r.json()) as { unread: number }).unread;
  };
  const before = await unread();
  expect(before).toBeGreaterThanOrEqual(1);

  await signIn(page, B.email);
  await page.goto("/notifications");
  const item = page.locator('[data-inbox-item-category]').filter({ hasText: "Please review this record" }).first();
  await expect(item).toBeVisible({ timeout: 60_000 });
  await expect(item).toHaveAttribute("data-inbox-item-read", "false");
  await item.getByRole("button", { name: /^Mark as read:/ }).click();
  await expect(item).toHaveAttribute("data-inbox-item-read", "true");
  await expect.poll(unread, { timeout: 30_000 }).toBe(before - 1);

  const find = () => page.locator('[data-inbox-item-category]').filter({ hasText: "Please review this record" });
  await page.locator('[data-inbox-filter-chip="read"]').click();
  await expect(find()).toHaveCount(1);
  await page.locator('[data-inbox-filter-chip="unread"]').click();
  await expect(find()).toHaveCount(0);
  await page.locator('[data-inbox-filter-chip="all"]').click();
  await expect(find()).toHaveCount(1);

  // Opening the discussion (which stamps the mention as seen) never deletes it.
  const seen = await B.api.post(`/v1/collaboration/threads/${threadId}/mark-mentions-read?teamId=${teamId}`, { data: {} });
  expect(seen.ok(), await seen.text()).toBe(true);
  await page.reload();
  await page.locator('[data-inbox-filter-chip="read"]').click();
  await expect(find()).toHaveCount(1);
  expect(await unread()).toBe(before - 1);

  // OLDER THAN 30 DAYS: history has no creation-time window — a read
  // notification from 45 days ago is still in All and Read, never in Unread,
  // and the bell count does not move.
  sql(`UPDATE discussion_mentions SET created_at = now() - interval '45 days' WHERE thread_id = $1 AND mentioned_user_id = $2`, [threadId, B.userId]);
  sql(`UPDATE discussion_messages SET created_at = now() - interval '45 days' WHERE thread_id = $1`, [threadId]);
  await page.reload();
  await page.locator('[data-inbox-filter-chip="read"]').click();
  await expect(find()).toHaveCount(1);
  await page.locator('[data-inbox-filter-chip="unread"]').click();
  await expect(find()).toHaveCount(0);
  await page.locator('[data-inbox-filter-chip="all"]').click();
  await expect(find()).toHaveCount(1);
  expect(await unread()).toBe(before - 1);

  const text = await page.locator("main").innerText();
  expect(text, "a raw internal code reached the Notifications page").not.toMatch(RAW_CODE);

  // AN INBOX, NOT A DASHBOARD (2026-10-17): no KPI cards; All lists the read
  // history with NO empty panel and never claims there is nothing.
  await page.locator('[data-inbox-filter-chip="all"]').click();
  await expect(find()).toHaveCount(1);
  await expect(page.locator("[data-notifications-metric]")).toHaveCount(0);
  await expect(page.locator('[data-state="empty"]')).toHaveCount(0);
  expect(await page.locator("main").innerText()).not.toMatch(/don.t have any notifications/i);
  await page.screenshot({ path: test.info().outputPath("notifications-all-read-history.png"), fullPage: true });
  // Everything read (the bell's mark-all-read): Unread = 0 while All keeps the
  // whole history.
  const all = await B.api.post("/v1/me/inbox/mark-all-read", { data: {} });
  expect(all.ok(), await all.text()).toBe(true);
  await expect.poll(unread, { timeout: 30_000 }).toBe(0);
  await page.reload();
  await page.locator('[data-inbox-filter-chip="all"]').click();
  await expect(find()).toHaveCount(1);
  await expect(page.locator('[data-state="empty"]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("notifications-all-zero-unread.png"), fullPage: true });
  // Unread = 0: a scoped all-caught-up in the list's place, no history under it.
  await page.locator('[data-inbox-filter-chip="unread"]').click();
  const empty = page.locator('[data-state="empty"][data-inbox-empty-view="unread"]');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("There are no unread notifications.");
  await expect(page.locator("[data-inbox-item]")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("notifications-unread-zero.png"), fullPage: true });
});
