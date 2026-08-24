/**
 * BROWSER VERIFICATION — the Evidence Library scopes: Active / Archived / Trash.
 *
 * The scope named "Deleted" described an operation it never performed. Every
 * record in it is physically present in storage and restorable by its owner;
 * physical destruction is a separate, governed pipeline whose results are
 * tombstones and appear in no regular scope at all.
 *
 * A source guard can prove the union was renamed. It cannot prove what the
 * filter control actually offers a user, nor what the page requests when they
 * pick it — and the second is the part that matters, because the wire alias
 * means a client sending the OLD value still works, so a rename that silently
 * kept sending `deleted` would pass every source check and change nothing.
 *
 * So this reads the rendered options and captures the request the page issues.
 * The API is intercepted; nothing here reaches a database.
 */

import { expect, test, type Page } from "@playwright/test";

import { envelopeFor } from "./_fixtures";

function evidenceRow(i: number) {
  return {
    id: `ev-${i}`,
    title: `incident-${i}.jpg`,
    displayTitle: `incident-${i}.jpg`,
    status: "REPORTED",
    statusLabel: "Reported",
    verificationStatus: null,
    createdAt: "2026-08-20T11:22:33.456Z",
    updatedAt: "2026-08-20T11:22:33.456Z",
    deletedAt: null,
    archivedAt: null,
    caseId: null,
    reportReady: true,
    mimeType: "image/jpeg",
    sizeBytes: 12345,
    lifecycle: {
      productState: "ACTIVE",
      canArchive: true,
      canUnarchive: false,
      canTrash: true,
      canRestoreFromTrash: false,
      trashBlockReason: null,
      archiveBlockReason: null,
      trashGraceUntilUtc: null,
      appRetentionUntilUtc: null,
      objectLockRetainUntilUtc: null,
      effectiveRetentionUntilUtc: null,
      objectLockCompliance: false,
      legalHold: false,
      destructionEligibleAtUtc: null,
      destructionBlockReason: null,
    },
  };
}

/** Every `scope=` the page asked the API for, in order. */
const requestedScopes: string[] = [];

async function openLibrary(page: Page): Promise<void> {
  requestedScopes.length = 0;
  const envelope = envelopeFor("organization");
  const items = [evidenceRow(1), evidenceRow(2)];

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/v1/platform/context")) return json(envelope);
    if (path.endsWith("/v1/auth/me") || path.endsWith("/v1/users/me")) {
      return json({ id: "user-1", email: "reviewer@example.invalid" });
    }
    if (path.endsWith("/v1/evidence")) {
      const scope = url.searchParams.get("scope");
      if (scope) requestedScopes.push(scope);
      return json({ scope: scope ?? "active", items, totalCount: items.length });
    }
    if (path.endsWith("/v1/evidence/library-summary")) {
      return json({ scope: "active", totalActive: items.length, totalTrash: 0 });
    }
    if (path.endsWith("/v1/evidence/saved-views")) return json({ views: [] });
    if (path.endsWith("/v1/cases")) return json({ cases: [], items: [] });
    return json({});
  });

  await page.goto("/evidence");
  await page.waitForSelector("[data-evidence-row]", { timeout: 30_000 });
}

/**
 * The workspace-scope filter's rendered options.
 *
 * The wait is not politeness. `AppListbox` mounts its popup through an anchored
 * OVERLAY, so the options do not exist in the document on the tick the click
 * returns; reading straight afterwards returned `[]`. That made
 * `toContain("Trash")` fail and — worse — made `not.toContain("Deleted")` pass
 * against nothing at all, which is the shape of a guard that reports green
 * because it measured an empty page.
 */
async function scopeOptions(page: Page): Promise<string[]> {
  await page.locator("#scope-filter").click();
  const options = page.locator('[role="listbox"] [role="option"]');
  await options.first().waitFor({ state: "visible", timeout: 10_000 });
  const labels = await options.allInnerTexts();
  await page.keyboard.press("Escape");
  return labels.map((t) => t.trim()).filter(Boolean);
}

test.describe("Evidence Library — Active / Archived / Trash", () => {
  test("the scope filter offers Trash, and never offers Deleted", async ({
    page,
  }) => {
    await openLibrary(page);
    const options = await scopeOptions(page);

    expect(options).toContain("Trash");
    expect(options).toContain("Active");
    expect(options).toContain("Archived");
    expect(options).not.toContain("Deleted");
  });

  test("choosing Trash asks the API for scope=trash, not the legacy alias", async ({
    page,
  }) => {
    // The part a source guard cannot reach. `deleted` is still ACCEPTED on the
    // wire for clients that shipped, so a half-done rename — new label, old
    // request — would look correct everywhere except here.
    await openLibrary(page);

    await page.locator("#scope-filter").click();
    await page.getByRole("option", { name: "Trash", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-evidence-row]").length > 0,
    );
    await expect
      .poll(() => requestedScopes.filter((s) => s === "trash").length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    expect(requestedScopes).not.toContain("deleted");
  });

  test("no library surface paints the word Deleted", async ({ page }) => {
    await openLibrary(page);
    // Whole page, not a scoped slice: the point is that the vocabulary is gone,
    // not that one control was edited.
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/\bDeleted\b/);
  });
});
