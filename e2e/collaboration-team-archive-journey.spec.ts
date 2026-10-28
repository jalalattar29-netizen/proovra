/**
 * ARCHIVE COLLABORATION TEAM — the browser journey (2026-10-28).
 *
 * A TEAM-plan owner creates a Collaboration Team and opens its Settings. The
 * only retirement offered is "Archive Collaboration Team" — there is no
 * delete. The confirmation shows the server's impact preview, requires the
 * team's exact name, and then asks for a recent step-up. This persona has no
 * second factor enrolled, so the step-up says how to set one up and the team
 * is NOT archived: nothing changes before a successful step-up.
 *
 * The full archive (with a real factor) is proven against PostgreSQL in
 * services/api/test/collaboration-team-archive.integration.test.ts.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
  disposeSession,
  SESSION_PASSWORD,
  type GuestSession,
} from "./helpers/api-client";
import { answerCookieBanner } from "./helpers/consent";

let session: GuestSession | null = null;

test.afterAll(async () => {
  if (session) await disposeSession(session);
  session = null;
});

async function signIn(page: Page, s: GuestSession): Promise<void> {
  await clearTestRateLimits();
  await answerCookieBanner(page);
  await page.goto("/login");
  // The visible form only — a production build briefly holds a hidden copy.
  await page.locator('input[placeholder="Email"]:visible').fill(s.email);
  await page.locator('input[placeholder="Password"]:visible').fill(SESSION_PASSWORD);
  await page.locator("input.auth-legal-checkbox:visible").check();
  await page.locator('[data-auth-email-cta="SIGN_IN"]:visible').click();
  await page.waitForURL(/\/home/, { timeout: 30_000 });
}

test("Archive Collaboration Team: exact name, impact preview, step-up before anything changes; no delete", async ({ page }) => {
  await clearTestRateLimits();
  session = await createGuestSession({ plan: "TEAM" });
  const name = `Archive journey ${Date.now().toString(36)}`;
  const created = await session.api.post("/v1/collaboration-teams", { data: { name } });
  expect(created.ok(), await created.text()).toBe(true);
  const teamId = ((await created.json()) as { team: { id: string } }).team.id;

  await signIn(page, session);
  await page.goto(`/collaboration-teams/${teamId}?tab=settings`);

  const archive = page.getByTestId("settings-archive");
  await expect(archive).toHaveText("Archive Collaboration Team");
  await expect(page.getByTestId("settings-delete")).toHaveCount(0);
  await expect(page.getByText(/delete team/i)).toHaveCount(0);

  await archive.click();
  const dialog = page.getByTestId("archive-team-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("archive-impact-members")).toContainText("member");
  await expect(dialog.getByTestId("archive-impact-restore")).toContainText(/restore/i);

  const submit = dialog.getByTestId("archive-team-submit");
  await expect(submit).toHaveText("Archive Collaboration Team");
  await expect(submit).toBeDisabled();
  await dialog.getByTestId("archive-confirm-name").fill(name.toUpperCase());
  await expect(submit).toBeDisabled();
  await dialog.getByTestId("archive-confirm-name").fill(name);
  await expect(submit).toBeEnabled();
  await submit.click();

  // The step-up is asked for; this persona has no factor, so it says how to
  // get one — and the team is untouched.
  const stepUp = page.getByRole("dialog", { name: "Step-up confirmation" });
  await expect(stepUp).toBeVisible({ timeout: 20_000 });
  await expect(stepUp).toHaveAttribute("data-step-up-state", /enrollment_required|verifying/);

  const after = await session.api.get(`/v1/collaboration-teams/${teamId}`);
  expect(after.ok()).toBe(true);
  const body = (await after.json()) as { team?: { status?: string }; status?: string };
  expect(body.team?.status ?? body.status).toBe("ACTIVE");
});
