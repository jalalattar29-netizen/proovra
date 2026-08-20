/**
 * The server, as the Search console sees it — served by route interception.
 *
 * WHY NOT A REAL STACK
 * ---------------------------------------------------------------------------
 * This project measures GEOMETRY: overflow, containment, stacking, target size,
 * reflow. None of that is a property of the database. What it IS a property of
 * is the real production bundle, the real stylesheet, the real cascade and a
 * real layout engine — which is exactly what jsdom cannot provide and what a
 * `next build` + `next start` under Chromium does.
 *
 * So the API is intercepted and the WEB TIER is real. Every fixture below is
 * shaped like the contract the route actually projects; nothing is invented
 * that the server could not send.
 */

import type { Page } from "@playwright/test";

import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../apps/web/lib/platform-context/types";

export type LayoutContext = "personal" | "organization" | "enterprise" | "admin";

const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";

/** A deliberately hostile row: long title, long pointers, long summary. */
const LONG =
  "Q4-incident-bundle-with-an-extremely-long-operator-supplied-filename-that-nobody-would-shorten-2026-08-20-final-v7-REVIEWED.zip";

export function envelopeFor(context: LayoutContext): Record<string, unknown> {
  const enterprise = context === "enterprise" || context === "admin";
  const type = context === "personal" ? "PERSONAL" : "ORGANIZATION";
  return {
    // The REAL accepted versions. An envelope carrying anything else is
    // refused by `versionsAreCompatible` and the shell falls back to its
    // unknown-projection state — which renders a sidebar and no console, and
    // looks exactly like a layout bug.
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { SEARCH_VIEW: true },
    diagnostics: { requestId: `layout-${context}` },
    workspace: {
      id: WORKSPACE_ID,
      name: context === "personal" ? "Personal Space" : "Meridian Legal",
      status: "active",
      scope: type,
    },
    activeSpace: {
      type,
      id: WORKSPACE_ID,
      displayName: context === "personal" ? "Personal Space" : "Meridian Legal",
      roleLabel: "Owner",
    },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: WORKSPACE_ID,
        kind: type,
        organizationId: null,
        displayName: "Meridian Legal",
      },
    },
    account: { accountPlan: enterprise ? "ENTERPRISE" : "FREE", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: enterprise },
    platform: { isPlatformAdmin: context === "admin" },
    planFeatures: {},
    user: { id: "user-1", email: "operator@example.invalid", name: "Operator" },
  };
}

function row(i: number, over: Record<string, unknown> = {}) {
  return {
    documentId: `00000000-0000-4000-8000-00000000000${i}`,
    documentType: i % 2 === 0 ? "EVIDENCE" : "CASE",
    title: i === 1 ? LONG : `incident-bundle-${i}.zip`,
    subtitle: "Active",
    summary:
      "A recorded incident bundle captured through the web uploader and held under the workspace retention policy.",
    evidenceId: `11111111-1111-4111-8111-00000000000${i}`,
    workflowInstanceId: `22222222-2222-4222-8222-00000000000${i}`,
    workflowStepInstanceId: `33333333-3333-4333-8333-00000000000${i}`,
    caseId: `44444444-4444-4444-8444-00000000000${i}`,
    reviewState: null,
    workflowState: null,
    exportState: null,
    retentionState: null,
    legalHoldState: null,
    contributorScoped: false,
    reviewerRestricted: false,
    badges: i === 2 ? ["in_trash", "archived", "locked"] : [],
    updatedAtUtc: "2026-08-20T11:22:33.456Z",
    ...over,
  };
}

export type ReadinessOverride = Record<string, unknown> | null;

function readiness(over: ReadinessOverride): Record<string, unknown> | null {
  if (over === null) return null;
  return {
    state: "READY",
    eligibleCount: 12,
    indexedCount: 12,
    outstandingCount: 0,
    unresolvedRemovals: 0,
    lastIndexedAtUtc: "2026-08-20T11:00:00.000Z",
    progressing: false,
    runStatus: "SUCCEEDED",
    runStartedAtUtc: "2026-08-20T10:59:00.000Z",
    runFinishedAtUtc: "2026-08-20T11:00:00.000Z",
    failureReason: null,
    degradedCapabilities: [],
    shouldPoll: false,
    resultsAreComplete: true,
    canRecover: false,
    ...over,
  };
}

/**
 * Install the whole API surface for one context.
 *
 * Every `/v1/**` request is answered here, so the run touches nothing outside
 * the browser and the web server.
 */
export async function installApi(
  page: Page,
  context: LayoutContext,
  over: { readiness?: ReadinessOverride; rowCount?: number } = {},
): Promise<void> {
  const envelope = envelopeFor(context);
  const rows = Array.from({ length: over.rowCount ?? 6 }, (_, i) => row(i));
  const ready = readiness(over.readiness ?? {});

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path.endsWith("/v1/platform/context")) return json(envelope);
    if (path.endsWith("/v1/auth/me") || path.endsWith("/v1/users/me")) {
      return json({ id: "user-1", email: "operator@example.invalid" });
    }
    if (path.endsWith("/v1/search/diagnostics")) {
      if (!ready) return json({});
      return json({
        workspace: { id: WORKSPACE_ID, name: "Meridian Legal", isPersonal: false },
        readiness: ready,
        evidence: { total: ready.eligibleCount },
        index: {
          total: ready.indexedCount,
          byType: { EVIDENCE: ready.indexedCount },
          evidenceIndexed: ready.indexedCount,
          evidenceTotal: ready.eligibleCount,
          coverage: 100,
          breakdown: {},
        },
        health: "healthy",
        runtime: { dbServerIp: null, dbName: null },
      });
    }
    if (path.endsWith("/v1/search/saved-views")) return json({ views: [] });
    if (path.endsWith("/v1/search/semantic/status")) {
      return json({
        enabled: false,
        providerName: "disabled",
        semanticAvailable: false,
        fallbackReason: null,
        usage: null,
      });
    }
    if (path.endsWith("/v1/search/audit")) return json({ rows: [], nextCursor: null });
    if (path.endsWith("/v1/search/reconcile")) {
      return json({ accepted: true, status: "COMPLETED" });
    }
    if (path.endsWith("/v1/search")) {
      return json({
        rows,
        totalReturned: rows.length,
        nextCursor: null,
        withheld: 0,
      });
    }
    if (path.endsWith("/v1/search/suggest")) {
      // Real suggestions, so the typeahead actually OPENS. An empty list makes
      // the overlay never mount, and the layering assertion then skips — a
      // stacking gate that never sees a popup proves nothing about stacking.
      return json({
        suggestions: [
          { documentId: "s-1", documentType: "EVIDENCE", title: "incident-bundle-0.zip" },
          { documentId: "s-2", documentType: "CASE", title: "incident review 2026" },
          { documentId: "s-3", documentType: "EVIDENCE", title: "incident-bundle-2.zip" },
        ],
      });
    }
    // Anything else the shell asks for: an empty, well-formed answer. A 404
    // here would push the layout into an error state and measure the wrong
    // page.
    return json({});
  });
}

/** Load `/search` and wait for the console (not the pending placeholder). */
export async function openSearch(
  page: Page,
  context: LayoutContext,
  over: { readiness?: ReadinessOverride; rowCount?: number } = {},
): Promise<void> {
  await installApi(page, context, over);
  await page.goto("/search");
  await page.waitForSelector('[data-search-page]:not([data-search-page="pending"])', {
    timeout: 30_000,
  });
  // Let the result query and the diagnostics fetch settle so the measured tree
  // is the settled one rather than the first paint.
  await page.waitForSelector("[data-search-results]", { timeout: 30_000 });
}

/** Switch the document to RTL, the way a locale would. */
export async function setDirection(page: Page, dir: "ltr" | "rtl"): Promise<void> {
  await page.evaluate((d) => {
    document.documentElement.setAttribute("dir", d);
  }, dir);
  // One frame, so the layout the assertions read is the reflowed one.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => r(null))),
  );
}

export const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 800 },
  { name: "390", width: 390, height: 844 },
] as const;

export const DIRECTIONS = ["ltr", "rtl"] as const;
