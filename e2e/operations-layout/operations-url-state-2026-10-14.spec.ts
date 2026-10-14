/**
 * OPERATIONS — URL STATE, EMPTY STATES AND RESPONSIVE DRAWERS, IN A REAL BROWSER
 * (2026-10-14).
 *
 * Executed against the PRODUCTION build (this project's web server), with the
 * API intercepted. Unlike the shared fixture's list, the list here is FILTERED
 * BY THE INTERCEPTOR EXACTLY AS THE SERVER FILTERS (status, severity, source
 * category, commitment, search), so what the page shows for a URL is the
 * server's answer to the query the page actually sent.
 *
 *   1. /operations with no query: All conditions, lifecycle All, resolved rows
 *      visible at once.
 *   2. Explicit URL state overrides every default and composes.
 *   3. Back / Forward / refresh restore exact filters; opening and closing a
 *      condition drawer or a group drawer keeps them; Reset restores the
 *      canonical default.
 *   4. A workspace switch drops the previous tenant's `?incident=`; a foreign
 *      incident id exposes no condition data.
 *   5. Empty states: resolved-only, filtered-zero, truly empty.
 *   6. Condition and group drawers at desktop and mobile widths, LTR and RTL.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import {
  OTHER_WORKSPACE_ID,
  WORKSPACE_ID,
  envelopeFor,
  hasHorizontalOverflow,
  incident,
  installApi,
} from "./_fixtures";

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

type Row = ReturnType<typeof incident> & { sla: { posture: string } };

function row(i: number, over: Record<string, unknown>, posture: string): Row {
  const base = incident(i) as Row;
  return {
    ...base,
    ...over,
    sla: { ...(base.sla as object), posture },
    resolvedAtUtc: over.status === "RESOLVED" ? hoursAgo(2) : null,
    acknowledgedAtUtc: over.status === "ACKNOWLEDGED" ? hoursAgo(3) : null,
  } as Row;
}

const OPEN_CRITICAL = row(1, { status: "OPEN", severity: "CRITICAL", category: "EVIDENCE_INTEGRITY", title: "Trusted timestamp missing for Roof survey" }, "BREACHED");
const ACK_HIGH = row(2, { status: "ACKNOWLEDGED", severity: "HIGH", category: "REPORT", title: "Report backlog above threshold" }, "AT_RISK");
const SILENCED = row(3, { status: "SUPPRESSED", severity: "WARNING", category: "UPLOAD", title: "Upload appears stalled" }, "NOT_APPLICABLE");
const RESOLVED_LEGACY = row(4, { status: "RESOLVED", severity: "WARNING", category: "UPLOAD", title: "Legacy upload-session signal" }, "RESOLVED");
const RESOLVED_INFO = row(5, { status: "RESOLVED", severity: "INFO", category: "GOVERNANCE", title: "Governance notice escalated" }, "RESOLVED");
const FULL = [OPEN_CRITICAL, ACK_HIGH, SILENCED, RESOLVED_LEGACY, RESOLVED_INFO];
const FOREIGN_ID = "99999999-9999-4999-8999-999999999999";

/** The server's own predicate, applied to the query the page sent. */
function filtered(rows: Row[], q: URLSearchParams): Row[] {
  const status = q.get("status") ?? "ALL";
  const match = (r: Row) =>
    (status === "ALL" ||
      (status === "UNRESOLVED" ? ["OPEN", "ACKNOWLEDGED"].includes(r.status) : r.status === status)) &&
    (!q.get("severity") || r.severity === q.get("severity")) &&
    (!q.get("category") || r.category === q.get("category")) &&
    (!q.get("sla") || r.sla.posture === q.get("sla")) &&
    (!q.get("q") || r.title.toLowerCase().includes(q.get("q")!.toLowerCase()));
  return rows.filter(match);
}

function summaryOf(rows: Row[]) {
  const active = rows.filter((r) => r.status === "OPEN" || r.status === "ACKNOWLEDGED");
  const sev = (s: string) => active.filter((r) => r.severity === s).length;
  return {
    workspaceId: WORKSPACE_ID,
    generatedAtUtc: new Date(NOW).toISOString(),
    open: active.length,
    critical: sev("CRITICAL"),
    high: sev("HIGH"),
    warning: sev("WARNING"),
    info: sev("INFO"),
    acknowledged: rows.filter((r) => r.status === "ACKNOWLEDGED").length,
    assignedToMe: 0,
    unassigned: active.length,
    resolved: rows.filter((r) => r.status === "RESOLVED").length,
    slaBreached: active.filter((r) => r.sla.posture === "BREACHED").length,
    slaAtRisk: active.filter((r) => r.sla.posture === "AT_RISK").length,
    slaOnTrack: 0,
    slaUntracked: 0,
    complete: true,
    mayAssertAllClear: active.length === 0,
    incompleteReason: null,
    readiness: "READY",
    clearRefusalReason: active.length === 0 ? null : "UNRESOLVED_CONDITIONS",
    reconciliation: null,
  };
}

type Server = { listQueries: URLSearchParams[]; detailIds: string[]; contextFetches: () => number; setWorkspace: (id: string) => void };

/** The shared shell fixture, with the list, detail and summary answered by THIS dataset. */
async function serve(page: Page, rows: Row[]): Promise<Server> {
  await installApi(page, "team-admin");
  const listQueries: URLSearchParams[] = [];
  const detailIds: string[] = [];
  let workspaceId = WORKSPACE_ID;
  let contextFetches = 0;
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  // The envelope offers TWO owned workspaces, so the shell's own switcher can
  // move between them; the switch endpoint answers with the new envelope.
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
  await page.route("**/v1/ops/summary**", (route) =>
    json(route, { summary: { ...summaryOf(rows), workspaceId }, workspace: { operatorCount: 1 } }),
  );
  await page.route(/\/v1\/ops\/incidents(\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const q = new URL(route.request().url()).searchParams;
    listQueries.push(q);
    const list = q.get("teamId") === WORKSPACE_ID ? filtered(rows, q) : [];
    return json(route, {
      incidents: list,
      pagination: { nextCursor: null, returned: list.length },
      completeness: { complete: true, mayAssertAllClear: true },
      sla: {
        postures: ["UNTRACKED_LEGACY", "NOT_APPLICABLE", "ON_TRACK", "AT_RISK", "BREACHED", "ACKNOWLEDGED", "RESOLVED"],
        attentionPostures: ["BREACHED", "AT_RISK"],
      },
    });
  });
  await page.route(/\/v1\/ops\/incidents\/[0-9a-f-]{36}(\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const url = new URL(route.request().url());
    const id = url.pathname.split("/").pop()!;
    detailIds.push(id);
    const found = url.searchParams.get("teamId") === WORKSPACE_ID ? rows.find((r) => r.id === id) : undefined;
    // The server's answer to an id outside the workspace: not found, nothing else.
    if (!found) return json(route, { error: { code: "incident_not_found" } }, 404);
    return json(route, {
      incident: {
        ...found,
        subject: { kind: "RECORD", name: "Roof survey", reference: "66666666", version: null, state: "AVAILABLE" },
        technicalReferences: [
          { key: "signalCode", value: "tsa_failed" },
          { key: "evidenceId", value: found.relatedEvidenceId },
        ],
        timeline: [{ id: "e1", eventType: "opened", safeMessage: "The condition was opened.", occurredAtUtc: hoursAgo(5) }],
        timelineComplete: true,
      },
      remediation: {
        disposition: "SAFE_DEEP_LINK",
        actions: [],
        deepLink: { href: `/evidence/${found.relatedEvidenceId}`, label: "Open the record", requiredPermission: "evidence.read", recordScoped: true },
        guidance:
          "No upload progress has been recorded for this record past the inactivity threshold. The person uploading can resume it; an upload that is not resumed is closed as abandoned. This closes on its own when the upload completes, is resumed or abandoned, or the record is finalized or deleted.",
        unsafeReason: null,
      },
    });
  });
  return { listQueries, detailIds, contextFetches: () => contextFetches, setWorkspace: (id) => (workspaceId = id) };
}

async function open(page: Page, query = "") {
  await page.goto(`/operations${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await expect(page.locator("[data-ops-view-toggle]")).toBeVisible({ timeout: 30_000 });
}

/** The WORKBENCH's list reads (it always sends a sort); the shell polls the same route without one. */
const lastList = (s: Server) => s.listQueries.filter((q) => q.has("sort")).at(-1)!;
const rowIds = (page: Page) =>
  page.locator("[data-ops-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-ops-row")));
const search = (page: Page) => new URL(page.url()).searchParams;

// ===========================================================================
// 1 + 2. Defaults, and explicit state overriding them
// ===========================================================================

test("default entry: All conditions, lifecycle All, resolved history visible at once", async ({ page }) => {
  const s = await serve(page, FULL);
  await open(page);
  await expect(page.locator("[data-ops-view-toggle]")).toHaveAttribute("data-ops-presentation", "flat");
  await expect(page.locator('[data-ops-view="flat"]')).toHaveAttribute("aria-pressed", "true");
  expect(lastList(s).get("status")).toBe("ALL");
  await expect(page.locator("[data-ops-row]")).toHaveCount(5);
  await expect(page.locator(`[data-ops-row="${RESOLVED_LEGACY.id}"]`)).toBeVisible();
  await expect(page.locator("[data-ops-result-summary]")).toContainText("all statuses");
  await expect(page.locator("[data-ops-result-summary]")).not.toContainText("filtered");
  await expect(page.locator("[data-ops-empty]")).toHaveCount(0);
});

test("explicit URL state overrides every default and the filters compose", async ({ page }) => {
  const s = await serve(page, FULL);
  await open(page, "?status=UNRESOLVED&severity=HIGH&category=REPORT&sla=AT_RISK&q=backlog");
  const q = lastList(s);
  expect([q.get("status"), q.get("severity"), q.get("category"), q.get("sla"), q.get("q")]).toEqual([
    "UNRESOLVED",
    "HIGH",
    "REPORT",
    "AT_RISK",
    "backlog",
  ]);
  expect(await rowIds(page)).toEqual([ACK_HIGH.id]);
  await expect(page.locator("[data-ops-result-summary]")).toContainText("filtered");
  await expect(page.locator("[data-ops-search]")).toHaveValue("backlog");

  // Presentation is its own dimension, explicit too.
  await open(page, "?view=grouped&status=RESOLVED");
  await expect(page.locator("[data-ops-view-toggle]")).toHaveAttribute("data-ops-presentation", "grouped");
  expect(search(page).get("status")).toBe("RESOLVED");
});

test("All conditions never applies a hidden unresolved filter, and Reset restores the canonical default", async ({ page }) => {
  const s = await serve(page, FULL);
  await open(page, "?status=OPEN&severity=CRITICAL");
  expect(await rowIds(page)).toEqual([OPEN_CRITICAL.id]);
  await page.locator("[data-ops-clear-filters]").click();
  await expect.poll(() => page.url()).toMatch(/\/operations$/);
  await expect(page.locator("[data-ops-row]")).toHaveCount(5);
  expect(lastList(s).get("status")).toBe("ALL");
  expect(lastList(s).get("severity")).toBeNull();
});

// ===========================================================================
// 3. Navigation state
// ===========================================================================

test("Back and Forward step through exact filter states; refresh keeps explicit state", async ({ page }) => {
  const s = await serve(page, FULL);
  await open(page);
  // Two deliberate changes through the real controls: a search, then the
  // Status listbox.
  await page.locator("[data-ops-search]").fill("upload");
  await expect.poll(() => search(page).get("q")).toBe("upload");
  await expect(page.locator("[data-ops-row]")).toHaveCount(2);

  await page.locator("[data-ops-controls] .app-listbox__trigger").first().click();
  await page.locator(".app-listbox__popup [role='option']").filter({ hasText: /^Resolved$/ }).first().click();
  await expect.poll(() => search(page).get("status")).toBe("RESOLVED");
  expect(await rowIds(page)).toEqual([RESOLVED_LEGACY.id]);

  await page.goBack();
  await expect.poll(() => search(page).get("status")).toBeNull();
  expect(search(page).get("q")).toBe("upload");
  await expect.poll(async () => (await rowIds(page)).sort()).toEqual([SILENCED.id, RESOLVED_LEGACY.id].sort());
  expect(lastList(s).get("status")).toBe("ALL");

  await page.goForward();
  await expect.poll(() => search(page).get("status")).toBe("RESOLVED");
  await expect.poll(() => rowIds(page)).toEqual([RESOLVED_LEGACY.id]);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-ops-view-toggle]")).toBeVisible({ timeout: 30_000 });
  expect(search(page).get("status")).toBe("RESOLVED");
  expect(search(page).get("q")).toBe("upload");
  expect(await rowIds(page)).toEqual([RESOLVED_LEGACY.id]);
});

test("opening and closing a condition drawer, or a group drawer, keeps every filter", async ({ page }) => {
  const s = await serve(page, FULL);
  const filters = "status=UNRESOLVED&severity=CRITICAL&sla=BREACHED&q=timestamp";
  await open(page, `?${filters}&incident=${OPEN_CRITICAL.id}`);
  await expect(page.locator(`[data-ops-inspector="${OPEN_CRITICAL.id}"]`)).toBeVisible();
  for (const [k, v] of new URLSearchParams(filters)) expect(search(page).get(k), k).toBe(v);
  const listReads = s.listQueries.length;
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-ops-inspector]")).toHaveCount(0);
  await expect.poll(() => search(page).get("incident")).toBeNull();
  for (const [k, v] of new URLSearchParams(filters)) expect(search(page).get(k), k).toBe(v);
  // Closing a drawer is not a filter change: the queue is not re-read.
  expect(s.listQueries.length).toBe(listReads);

  await open(page, "?view=grouped&severity=WARNING");
  const groupButton = page.locator("[data-ops-group-open-button]").first();
  {
    await expect(groupButton).toBeVisible();
    await groupButton.click();
    await expect(page.locator("[data-ops-group-inspector]")).toBeVisible();
    expect(search(page).get("severity")).toBe("WARNING");
    expect(search(page).get("view")).toBe("grouped");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-ops-group-inspector]")).toHaveCount(0);
    expect(search(page).get("severity")).toBe("WARNING");
    expect(search(page).get("view")).toBe("grouped");
  }
});

// ===========================================================================
// 4. Tenant boundaries in the address
// ===========================================================================

test("a workspace switch drops the previous tenant's incident; a foreign id exposes nothing", async ({ page }) => {
  const s = await serve(page, FULL);
  await open(page, `?status=ALL&severity=CRITICAL&incident=${OPEN_CRITICAL.id}`);
  await expect(page.locator(`[data-ops-inspector="${OPEN_CRITICAL.id}"]`)).toBeVisible();

  // Switch through the shell's own switcher. The modal drawer covers the
  // top bar, so the clicks are dispatched to the controls directly — the
  // same handlers a click runs.
  const fetchesBefore = s.contextFetches();
  await page.locator(".app-topbar-v2-workspace-button").first().dispatchEvent("click");
  await page.locator(`[data-context-option="${OTHER_WORKSPACE_ID}"]`).first().dispatchEvent("click");
  await expect.poll(() => s.contextFetches(), { timeout: 15_000 }).toBeGreaterThan(fetchesBefore);
  await expect.poll(() => search(page).get("incident"), { timeout: 15_000 }).toBeNull();
  await expect(page.locator("[data-ops-inspector]")).toHaveCount(0);
  expect(search(page).get("severity")).toBe("CRITICAL");

  // A foreign id: the server says not found, and the page shows no condition data.
  s.setWorkspace(WORKSPACE_ID);
  await open(page, `?incident=${FOREIGN_ID}`);
  await expect.poll(() => s.detailIds.includes(FOREIGN_ID)).toBe(true);
  const text = await page.locator("body").innerText();
  expect(text).not.toContain(FOREIGN_ID.slice(0, 8));
  await expect(page.locator(`[data-ops-inspector="${FOREIGN_ID}"] h2`)).toHaveCount(0);
});

// ===========================================================================
// 5. Empty states
// ===========================================================================

test("resolved-only: resolved rows show, no clear panel, no onboarding links, no misleading zero", async ({ page }) => {
  await serve(page, [RESOLVED_LEGACY, RESOLVED_INFO]);
  await open(page);
  await expect(page.locator("[data-ops-row]")).toHaveCount(2);
  await expect(page.locator('[data-ops-empty="clear"]')).toHaveCount(0);
  await expect(page.locator("[data-ops-empty]")).toHaveCount(0);
  await expect(page.locator('a[href="/evidence"]', { hasText: /Evidence library/i })).toHaveCount(0);
  await expect(page.locator("[data-ops-result-summary]")).not.toContainText(/^0 /);
  await expect(page.locator('[data-ops-view="flat"]')).toHaveAttribute("aria-pressed", "true");
});

test("filtered-zero: says no conditions match, offers Reset, shows no onboarding", async ({ page }) => {
  await serve(page, FULL);
  await open(page, "?severity=INFO&status=OPEN");
  const empty = page.locator('[data-ops-empty="filtered"]');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("No conditions match these filters.");
  await expect(empty.locator("[data-ops-reset-filters]")).toBeVisible();
  await expect(page.locator('[data-ops-empty="clear"]')).toHaveCount(0);
  await expect(page.locator("[data-ops-result-summary]")).toContainText("filtered");
  await empty.locator("[data-ops-reset-filters]").click();
  await expect(page.locator("[data-ops-row]")).toHaveCount(5);
});

test("truly empty: only this state renders the first-use panel and its links", async ({ page }) => {
  await serve(page, []);
  await open(page);
  const panel = page.locator('[data-ops-empty="clear"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator("a")).not.toHaveCount(0);
  await expect(page.locator("[data-ops-row]")).toHaveCount(0);
});

// ===========================================================================
// 6. Responsive drawers
// ===========================================================================

for (const vp of [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "mobile-320", width: 320, height: 720 },
]) {
  for (const dir of ["ltr", "rtl"] as const) {
    test(`condition drawer at ${vp.name} ${dir}: in viewport, no overflow, readable, reachable`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      if (dir === "rtl") {
        await page.addInitScript(() => {
          try {
            localStorage.setItem("proovra-locale", "ar");
            localStorage.setItem("proovra-locale-mode", "manual");
          } catch {
            /* storage unavailable */
          }
        });
      }
      await serve(page, FULL);
      await open(page, `?incident=${OPEN_CRITICAL.id}`);
      if (dir === "rtl") {
        await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"));
      }
      const drawer = page.locator(`[data-ops-inspector="${OPEN_CRITICAL.id}"]`);
      await expect(drawer).toBeVisible();
      const box = (await drawer.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
      expect(await hasHorizontalOverflow(page)).toBe(false);
      // Nothing inside the drawer scrolls sideways.
      const sideways = await drawer.evaluate((el) =>
        [el, ...Array.from(el.querySelectorAll<HTMLElement>("*"))]
          .filter((n) => {
            const o = getComputedStyle(n);
            return o.overflowX === "visible" && n.scrollWidth - n.clientWidth > 1 && n.tagName !== "CODE";
          })
          .map((n) => n.className || n.tagName),
      );
      expect(sideways).toEqual([]);
      // Title and badges wrap inside the drawer.
      const head = (await drawer.locator("h2").boundingBox())!;
      expect(head.x + head.width).toBeLessThanOrEqual(box.x + box.width + 1);
      // Affected subject, technical references (copyable), link and close all reachable.
      await expect(drawer.locator("[data-ops-affected-link]")).toBeVisible();
      const refs = drawer.locator("[data-ops-technical-references]");
      await refs.scrollIntoViewIfNeeded();
      await expect(refs.locator("code").first()).toHaveAttribute("dir", "ltr");
      await expect(refs.locator("button").first()).toBeVisible();
      // The close control, whatever the locale names it.
      const close = drawer.locator("header [data-dialog-initial-focus]").first();
      await expect(close).toBeVisible();
      // Buttons never overlap one another.
      const overlaps = await drawer.evaluate((el) => {
        const bs = Array.from(el.querySelectorAll<HTMLElement>("button, a.app-secondary-action"))
          .map((b) => b.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0);
        let n = 0;
        for (let i = 0; i < bs.length; i += 1)
          for (let j = i + 1; j < bs.length; j += 1) {
            const a = bs[i]!, b = bs[j]!;
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) n += 1;
          }
        return n;
      });
      expect(overlaps).toBe(0);
      // The canonical family applies inside the drawer (never the OS fallback).
      const families = await drawer.evaluate((el) => {
        const body = getComputedStyle(document.body).fontFamily;
        const inner = getComputedStyle(el.querySelector(".opsw-drawer__section-title") ?? el).fontFamily;
        return { body, inner };
      });
      expect(families.inner).toBe(families.body);
      expect(families.inner).not.toMatch(/^-apple-system/);
      if (dir === "rtl") {
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe("rtl");
      }
      // A user's wheel gesture scrolls the drawer, never the page behind it
      // (programmatic scrollBy is not a user gesture and is not the contract).
      const pageBefore = await page.evaluate(() => window.scrollY);
      await page.mouse.move(Math.max(5, box.x + 10), vp.height / 2);
      await page.mouse.wheel(0, 600);
      await page.mouse.move(5, vp.height / 2);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(250);
      expect(await page.evaluate(() => window.scrollY)).toBe(pageBefore);
      // Focus is trapped in the drawer and restored on close.
      for (let i = 0; i < 25; i += 1) await page.keyboard.press("Tab");
      expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      await close.click();
      await expect(drawer).toHaveCount(0);
    });
  }
}

test("group drawer at mobile width stays within the viewport with no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serve(page, FULL);
  await open(page, "?view=grouped");
  const button = page.locator("[data-ops-group-open-button]").first();
  await expect(button).toBeVisible();
  await button.click();
  const drawer = page.locator("[data-ops-group-inspector]");
  await expect(drawer).toBeVisible();
  const box = (await drawer.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(391);
  expect(await hasHorizontalOverflow(page)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});
