/**
 * OPERATIONS — saved views and workspace switching, in the production bundle
 * (2026-10-23).
 *
 * Every read is answered by a stateful fake that keys EVERYTHING by the
 * workspace the request names, so a request carrying the wrong workspace, or
 * a list that shows the previous workspace's rows, fails here:
 *
 *   1. applying a saved view writes its filters to the address, reads the
 *      ACTIVE workspace's list with exactly those filters, and survives a
 *      reload and Back/Forward;
 *   2. a STALE view (values a later build no longer knows) applies what is
 *      still valid, never sends the rest, and says so;
 *   3. a view whose stored filter names ANOTHER workspace never makes the
 *      page read that workspace;
 *   4. saving sends the current filters under the active workspace;
 *   5. a workspace switch re-reads views and conditions for the new
 *      workspace and shows none of the previous one's;
 *   6. at 390 and 768 px the views strip and toolbar never scroll sideways.
 */

import { expect, test, type Page, type Route } from "@playwright/test";

import { OTHER_WORKSPACE_ID, WORKSPACE_ID, envelopeFor, hasHorizontalOverflow, incident, installApi } from "./_fixtures";

type Row = ReturnType<typeof incident>;

const ROWS_A: Row[] = [
  { ...incident(1), status: "OPEN", severity: "CRITICAL", category: "EVIDENCE_INTEGRITY", title: "A — timestamp missing" } as Row,
  { ...incident(2), status: "OPEN", severity: "WARNING", category: "UPLOAD", title: "A — upload stalled" } as Row,
  { ...incident(3), status: "RESOLVED", severity: "HIGH", category: "REPORT", title: "A — report backlog" } as Row,
];
const ROWS_B: Row[] = [{ ...incident(7), status: "OPEN", severity: "HIGH", category: "REPORT", title: "B — only in the second workspace" } as Row];

const VIEWS = (team: string) =>
  team === WORKSPACE_ID
    ? [
        { id: "v-critical", name: "Open critical", filter: { teamId: WORKSPACE_ID, status: "UNRESOLVED", severity: "CRITICAL" } },
        // Saved by an earlier build: "EXTREME" and "RETIRED_SOURCE" no longer exist.
        { id: "v-stale", name: "Old triage", filter: { teamId: WORKSPACE_ID, status: "RESOLVED", severity: "EXTREME", category: "RETIRED_SOURCE" } },
        // Saved before ALL was upper-case: the legacy spelling still means ALL.
        { id: "v-legacy-all", name: "Everything high", filter: { teamId: WORKSPACE_ID, status: "all", severity: "HIGH" } },
        // Stale AND empty: the valid part (open report items) matches nothing.
        { id: "v-stale-empty", name: "Old reports", filter: { teamId: WORKSPACE_ID, status: "UNRESOLVED", category: "REPORT", severity: "EXTREME" } },
        // A view whose stored filter names ANOTHER workspace.
        { id: "v-foreign", name: "Copied from elsewhere", filter: { teamId: OTHER_WORKSPACE_ID, category: "UPLOAD" } },
      ]
    : [{ id: "v-b-only", name: "Second workspace view", filter: { teamId: OTHER_WORKSPACE_ID, severity: "HIGH" } }];

type Server = {
  listQueries: URLSearchParams[];
  viewReads: string[];
  saves: Array<Record<string, unknown>>;
  /** PATCH / DELETE calls against one view (2026-10-24). */
  edits: Array<{ method: string; id: string; teamId: string | null; body: Record<string, unknown> | null }>;
  contextFetches: () => number;
};

async function serve(page: Page): Promise<Server> {
  await installApi(page, "team-admin");
  let workspaceId = WORKSPACE_ID;
  let contextFetches = 0;
  const listQueries: URLSearchParams[] = [];
  const viewReads: string[] = [];
  const saves: Array<Record<string, unknown>> = [];
  const edits: Server["edits"] = [];
  // The views each workspace holds — mutable, so an edit persists across a
  // reload and never crosses into another workspace.
  const viewsByTeam = new Map<string, ReturnType<typeof VIEWS>>([
    [WORKSPACE_ID, VIEWS(WORKSPACE_ID)],
    [OTHER_WORKSPACE_ID, VIEWS(OTHER_WORKSPACE_ID)],
  ]);
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const envelope = () => {
    const env = envelopeFor("team-admin") as Record<string, Record<string, unknown>>;
    const owned = [
      { workspaceId: WORKSPACE_ID, name: "Meridian Legal", kind: "OWNED", role: "OWNER", lifecycleStatus: "active" },
      { workspaceId: OTHER_WORKSPACE_ID, name: "Second workspace", kind: "OWNED", role: "OWNER", lifecycleStatus: "active" },
    ];
    const name = workspaceId === WORKSPACE_ID ? "Meridian Legal" : "Second workspace";
    env.workspace = { ...env.workspace, id: workspaceId, name };
    env.activeSpace = { ...env.activeSpace, id: workspaceId, displayName: name };
    const opts = env.contextOptions as Record<string, unknown>;
    env.contextOptions = { ...opts, ownedWorkspaces: owned, activeContext: { ...(opts.activeContext as object), workspaceId, displayName: name } };
    return env;
  };
  await page.route("**/v1/platform/context", (route) => {
    contextFetches += 1;
    return json(route, envelope());
  });
  await page.route("**/v1/platform/context/switch-workspace", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { workspaceId?: string };
    if (body.workspaceId) workspaceId = body.workspaceId;
    contextFetches += 1;
    return json(route, envelope());
  });
  await page.route(/\/v1\/ops\/saved-views(\?.*)?$/, (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      saves.push(JSON.parse(req.postData() ?? "{}"));
      return json(route, { view: { id: "v-new", name: "New", filter: {} } }, 201);
    }
    const team = new URL(req.url()).searchParams.get("teamId") ?? "";
    viewReads.push(team);
    return json(route, {
      views: (viewsByTeam.get(team) ?? []).map((v) => ({
        ...v,
        description: null,
        visibility: "PRIVATE",
        pinned: false,
        createdByUserId: "user-self",
        ownedByViewer: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    });
  });
  await page.route(/\/v1\/ops\/saved-views\/[^/?]+(\?.*)?$/, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const body = req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : null;
    const teamId = (body?.teamId as string | undefined) ?? url.searchParams.get("teamId");
    edits.push({ method: req.method(), id, teamId, body });
    const list = viewsByTeam.get(teamId ?? "") ?? [];
    const view = list.find((v) => v.id === id);
    if (!view) return json(route, { error: { code: "NOT_FOUND" } }, 404);
    if (req.method() === "PATCH") {
      if (typeof body?.name === "string") view.name = body.name;
      return json(route, { view: { ...view } });
    }
    if (req.method() === "DELETE") {
      viewsByTeam.set(teamId!, list.filter((v) => v.id !== id));
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fallback();
  });
  await page.route(/\/v1\/ops\/incidents(\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const q = new URL(route.request().url()).searchParams;
    listQueries.push(q);
    const source = q.get("teamId") === WORKSPACE_ID ? ROWS_A : q.get("teamId") === OTHER_WORKSPACE_ID ? ROWS_B : [];
    const status = q.get("status") ?? "ALL";
    const list = source.filter(
      (r) =>
        (status === "ALL" || (status === "UNRESOLVED" ? r.status !== "RESOLVED" : r.status === status)) &&
        (!q.get("severity") || r.severity === q.get("severity")) &&
        (!q.get("category") || r.category === q.get("category")),
    );
    return json(route, {
      incidents: list,
      pagination: { nextCursor: null, returned: list.length },
      completeness: { complete: true, mayAssertAllClear: true },
      sla: { postures: ["UNTRACKED_LEGACY", "NOT_APPLICABLE", "ON_TRACK", "AT_RISK", "BREACHED", "ACKNOWLEDGED", "RESOLVED"], attentionPostures: ["BREACHED", "AT_RISK"] },
    });
  });
  return { listQueries, viewReads, saves, edits, contextFetches: () => contextFetches };
}

async function open(page: Page, query = "") {
  await page.goto(`/operations${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await expect(page.locator("[data-ops-view-toggle]")).toBeVisible({ timeout: 30_000 });
}

const lastList = (s: Server) => s.listQueries.filter((q) => q.has("sort")).at(-1)!;
const search = (page: Page) => new URL(page.url()).searchParams;
const titles = (page: Page) => page.locator("[data-ops-row]").allInnerTexts();

test("applying a saved view: address, list read, reload and Back/Forward agree", async ({ page }) => {
  const s = await serve(page);
  await open(page);
  await page.locator('[data-ops-saved-view="v-critical"]').click();
  await expect.poll(() => search(page).get("severity")).toBe("CRITICAL");
  expect(search(page).get("status")).toBe("UNRESOLVED");
  await expect.poll(() => lastList(s).get("severity")).toBe("CRITICAL");
  expect(lastList(s).get("teamId")).toBe(WORKSPACE_ID);
  expect((await titles(page)).join("|")).toContain("A — timestamp missing");
  expect((await titles(page)).join("|")).not.toContain("upload stalled");
  await expect(page.locator("[data-ops-saved-view-notice]")).toHaveCount(0);

  await page.reload();
  await expect(page.locator("[data-ops-view-toggle]")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => lastList(s).get("severity")).toBe("CRITICAL");

  await page.goBack();
  await expect.poll(() => search(page).get("severity")).toBeNull();
  await page.goForward();
  await expect.poll(() => search(page).get("severity")).toBe("CRITICAL");
});

test("a stale saved view applies what is still valid, never sends the rest, and says so", async ({ page }) => {
  const s = await serve(page);
  await open(page);
  await page.locator('[data-ops-saved-view="v-stale"]').click();
  await expect(page.locator("[data-ops-saved-view-notice]")).toContainText("Old triage");
  await expect.poll(() => search(page).get("status")).toBe("RESOLVED");
  const q = lastList(s);
  expect(q.get("status")).toBe("RESOLVED");
  expect(q.get("severity")).toBeNull();
  expect(q.get("category")).toBeNull();
  for (const sent of s.listQueries) {
    expect(sent.get("severity")).not.toBe("EXTREME");
    expect(sent.get("category")).not.toBe("RETIRED_SOURCE");
  }
  expect((await titles(page)).join("|")).toContain("A — report backlog");
});

test("a legacy lower-case status is applied, not reported as dropped (audit F13)", async ({ page }) => {
  const s = await serve(page);
  await open(page);
  await page.locator('[data-ops-saved-view="v-legacy-all"]').click();
  await expect.poll(() => search(page).get("severity")).toBe("HIGH");
  await expect.poll(() => lastList(s).get("severity")).toBe("HIGH");
  await expect(page.locator("[data-ops-saved-view-notice]")).toHaveCount(0);
  expect((await titles(page)).join("|")).toContain("A — report backlog");
});

test("the partly-applied notice clears when the reader changes the filters themselves (audit F13)", async ({ page }) => {
  await serve(page);
  await open(page);
  await page.locator('[data-ops-saved-view="v-stale"]').click();
  await expect(page.locator("[data-ops-saved-view-notice]")).toBeVisible();
  await page.locator("[data-ops-clear-filters]").click();
  await expect.poll(() => search(page).get("status")).toBeNull();
  await expect(page.locator("[data-ops-saved-view-notice]")).toHaveCount(0);
});

test("the notice is not shown once the queue no longer shows the view: Reset, Back and a workspace switch (second audit)", async ({ page }) => {
  const s = await serve(page);
  await open(page);
  const notice = page.locator("[data-ops-saved-view-notice]");

  // Reset on the no-match state.
  await page.locator('[data-ops-saved-view="v-stale-empty"]').click();
  await expect(notice).toContainText("Old reports");
  await page.locator("[data-ops-reset-filters]").click();
  await expect.poll(() => search(page).get("category")).toBeNull();
  await expect(notice).toHaveCount(0);

  // Back to the filters before the view; Forward returns to the view's filters.
  await page.locator('[data-ops-saved-view="v-stale"]').click();
  await expect(notice).toContainText("Old triage");
  await page.goBack();
  await expect.poll(() => search(page).get("status")).not.toBe("RESOLVED");
  await expect(notice).toHaveCount(0);
  await page.goForward();
  await expect.poll(() => search(page).get("status")).toBe("RESOLVED");
  await expect(notice).toContainText("Old triage");

  // A workspace switch: the previous workspace's view is not named.
  await page.locator(".app-topbar-v2-workspace-button").first().dispatchEvent("click");
  await page.locator(`[data-context-option="${OTHER_WORKSPACE_ID}"]`).first().dispatchEvent("click");
  await expect.poll(() => lastList(s).get("teamId"), { timeout: 15_000 }).toBe(OTHER_WORKSPACE_ID);
  await expect(notice).toHaveCount(0);
});

test("editing a saved view renames it in the active workspace only, and the new name persists across a reload", async ({ page }) => {
  const s = await serve(page);
  await open(page);
  await page.getByTestId("ops-view-menu-v-critical").click();
  await page.locator('[data-ops-view-row-action="rename"]').click();
  const nameField = page.locator("[data-ops-view-name]");
  await expect(nameField).toHaveValue("Open critical");
  await nameField.fill("Critical now");
  await nameField.press("Enter");
  await expect.poll(() => s.edits.filter((e) => e.method === "PATCH").length).toBe(1);
  const patch = s.edits.find((e) => e.method === "PATCH")!;
  expect(patch).toMatchObject({ id: "v-critical", teamId: WORKSPACE_ID, body: { name: "Critical now" } });
  await expect(page.locator('[data-ops-saved-view="v-critical"]')).toContainText("Critical now");
  await page.reload();
  await expect(page.locator("[data-ops-view-toggle]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-ops-saved-view="v-critical"]')).toContainText("Critical now");
});

test("deleting a saved view asks first, removes it from the active workspace only, and it stays gone after a reload", async ({ page }) => {
  const s = await serve(page);
  await open(page);
  await page.getByTestId("ops-view-menu-v-stale").click();
  await page.locator('[data-ops-view-row-action="delete"]').click();
  const confirm = page.locator('[data-confirm-action-modal="ops-view-delete-confirm"]');
  await expect(confirm).toBeVisible();
  // Cancel first: nothing is sent.
  await confirm.locator("[data-confirm-action-cancel]").first().click();
  await expect(page.locator('[data-ops-saved-view="v-stale"]')).toBeVisible();
  expect(s.edits.filter((e) => e.method === "DELETE")).toHaveLength(0);
  // Then delete.
  await page.getByTestId("ops-view-menu-v-stale").click();
  await page.locator('[data-ops-view-row-action="delete"]').click();
  await page.locator('[data-confirm-action-modal="ops-view-delete-confirm"] [data-confirm-action-submit]').click();
  await expect.poll(() => s.edits.filter((e) => e.method === "DELETE").length).toBe(1);
  expect(s.edits.find((e) => e.method === "DELETE")).toMatchObject({ id: "v-stale", teamId: WORKSPACE_ID });
  await expect(page.locator('[data-ops-saved-view="v-stale"]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-ops-view-toggle]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-ops-saved-view="v-critical"]')).toBeVisible();
  await expect(page.locator('[data-ops-saved-view="v-stale"]')).toHaveCount(0);
});

test("a view naming another workspace never makes the page read that workspace", async ({ page }) => {
  const s = await serve(page);
  await open(page);
  await page.locator('[data-ops-saved-view="v-foreign"]').click();
  await expect.poll(() => lastList(s).get("category")).toBe("UPLOAD");
  for (const q of s.listQueries) expect(q.get("teamId")).toBe(WORKSPACE_ID);
  expect((await titles(page)).join("|")).not.toContain("B — only in the second workspace");
});

test("saving a view sends the current filters under the active workspace", async ({ page }) => {
  const s = await serve(page);
  await open(page, "?severity=WARNING");
  await page.locator("[data-ops-view-start-save]").click();
  await page.locator("[data-ops-view-name]").fill("Warnings");
  await page.locator("[data-ops-view-save]").click();
  await expect.poll(() => s.saves.length).toBe(1);
  const body = s.saves[0]!;
  expect(body.teamId).toBe(WORKSPACE_ID);
  expect(body.filter).toMatchObject({ teamId: WORKSPACE_ID, severity: "WARNING" });
});

test("a workspace switch re-reads views and conditions for the new workspace and shows none of the old", async ({ page }) => {
  const s = await serve(page);
  await open(page);
  await expect(page.locator('[data-ops-saved-view="v-critical"]')).toBeVisible();
  const before = s.contextFetches();
  await page.locator(".app-topbar-v2-workspace-button").first().dispatchEvent("click");
  await page.locator(`[data-context-option="${OTHER_WORKSPACE_ID}"]`).first().dispatchEvent("click");
  await expect.poll(() => s.contextFetches(), { timeout: 15_000 }).toBeGreaterThan(before);
  await expect.poll(() => s.viewReads.at(-1), { timeout: 15_000 }).toBe(OTHER_WORKSPACE_ID);
  await expect.poll(() => lastList(s).get("teamId"), { timeout: 15_000 }).toBe(OTHER_WORKSPACE_ID);
  await expect(page.locator('[data-ops-saved-view="v-b-only"]')).toBeVisible();
  for (const id of ["v-critical", "v-stale", "v-foreign"]) {
    await expect(page.locator(`[data-ops-saved-view="${id}"]`)).toHaveCount(0);
  }
  const shown = (await titles(page)).join("|");
  expect(shown).toContain("B — only in the second workspace");
  expect(shown).not.toMatch(/A — /);
});

for (const width of [390, 768]) {
  test(`${width}px: the views strip and toolbar never scroll sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await serve(page);
    await open(page);
    await page.locator('[data-ops-saved-view="v-stale"]').click();
    await expect(page.locator("[data-ops-saved-view-notice]")).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
}
