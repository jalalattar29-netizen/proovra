/**
 * /operations — the 2026-10-14 default view, empty states, grouped hierarchy
 * and resolution note, driven for real.
 *
 * Production opened `/operations` on the GROUPED view with lifecycle
 * UNRESOLVED, and a workspace whose only conditions were resolved rendered a
 * large "Workspace operations are clear" panel — with Evidence library and
 * Workspace overview links — directly above the resolved conditions it then
 * listed. Each case below mounts the REAL page against contract-shaped
 * replies and pins one property of the repaired behaviour:
 *
 *   A. no query → the flat "All conditions" list with lifecycle ALL, said
 *      plainly; explicit params win; the drawer address, refresh and
 *      Back/Forward keep the exact state;
 *   B. emptiness is decided from AUTHORITATIVE unfiltered counts (the
 *      summary's unresolved + all-time resolved), never from the filtered
 *      page — only a retained total of ZERO earns the first-use panel;
 *   C. the grouped view ranks Action required > Monitoring > Resolved, and an
 *      empty section is one line, never a block;
 *   D. the resolution note is trimmed, bounded by the server's own limit,
 *      sent once, and its success updates the lists without a page refresh.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";

import { operationsDict } from "@proovra/shared/i18n";
import { RESOLUTION_NOTE_MAX } from "../../app/(app)/operations/_components/IncidentInspector";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type Handler = (path: string, method: string, body?: string) => unknown;

let requestLog: Array<{ path: string; method: string; body?: string }> = [];
let handler: Handler = () => ({});
let replaced: string[] = [];
let currentSearch = "";

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    requestLog.push({ path, method, body: init?.body });
    const r = await handler(path, method, init?.body);
    if (r instanceof Error) throw r;
    return r;
  },
  setActiveWorkspaceId: () => {},
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("../../app/providers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalLocale: () => "en",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    /* A filter, presentation or reset change PUSHES a history entry (2026-10-14);
       a drawer only rewrites the address. Both move the page's URL. */
    push: (href: string) => {
      replaced.push(href);
      currentSearch = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
    },
    replace: (href: string) => {
      replaced.push(href);
      currentSearch = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
    },
    back: () => {},
  }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/operations",
  useParams: () => ({}),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import OperationsPage from "../../app/(app)/operations/page";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const HOURS_AGO = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const EN = operationsDict.en;

function incident(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    category: "EVIDENCE_INTEGRITY",
    severity: "HIGH",
    status: "OPEN",
    title: `Condition ${id}`,
    safeSummary: "The timestamp authority did not return a token.",
    fingerprint: `tsa_failure:${id}`,
    occurrenceCount: 1,
    firstSeenAtUtc: HOURS_AGO(30),
    lastSeenAtUtc: HOURS_AGO(2),
    requestId: null,
    traceId: null,
    relatedEvidenceId: null,
    relatedJobId: null,
    relatedProvider: null,
    runbookSlug: null,
    acknowledgedByUserId: null,
    resolvedByUserId: null,
    assignedOperatorUserId: null,
    assignedAtUtc: null,
    acknowledgedAtUtc: null,
    resolvedAtUtc: null,
    lifecycle: {
      sourceId: "intake.delivery_failed",
      sourceMatch: "CATEGORY_RESIDUAL",
      resolutionAuthority: "OPERATOR_DECISION",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      recoveryPolicy: "OPERATOR_CLOSES",
      manualResolution: true,
    },
    metric: null,
    ...over,
  };
}

const resolvedIncident = (id: string) =>
  incident(id, {
    status: "RESOLVED",
    resolvedAtUtc: HOURS_AGO(5),
    resolvedByUserId: ME,
  });

/** Every count zero: the shape a summary takes when nothing is unresolved. */
const ZERO_ACTIVE = {
  open: 0,
  critical: 0,
  high: 0,
  warning: 0,
  info: 0,
  acknowledged: 0,
  assignedToMe: 0,
  unassigned: 0,
  slaBreached: 0,
  slaAtRisk: 0,
  slaOnTrack: 0,
  slaUntracked: 0,
};

function summaryOf(over: Record<string, unknown> = {}) {
  return {
    summary: {
      workspaceId: WS,
      generatedAtUtc: new Date(NOW).toISOString(),
      open: 3,
      critical: 1,
      high: 1,
      warning: 1,
      info: 0,
      acknowledged: 1,
      assignedToMe: 0,
      unassigned: 3,
      slaBreached: 0,
      slaAtRisk: 0,
      slaOnTrack: 0,
      slaUntracked: 3,
      resolved: 2,
      complete: true,
      mayAssertAllClear: false,
      incompleteReason: null,
      readiness: "READY",
      clearRefusalReason: "UNRESOLVED_CONDITIONS",
      reconciliation: null,
      ...over,
    },
    workspace: { operatorCount: 1 },
  };
}

function listOf(rows: unknown[], complete = true) {
  return {
    incidents: rows,
    pagination: { nextCursor: null, returned: rows.length },
    completeness: { complete, mayAssertAllClear: complete },
  };
}

function group(groupKey: string, over: Record<string, unknown> = {}) {
  return {
    groupKey,
    sourceId: groupKey,
    category: "EVIDENCE_INTEGRITY",
    title: `Group ${groupKey}`,
    conditionCount: 1,
    affectedRecordCount: null,
    affectedUnit: null,
    observations: 1,
    durationSeconds: null,
    lastObservedAtUtc: null,
    severity: "HIGH",
    statusPosture: "OPEN",
    firstSeenAtUtc: HOURS_AGO(30),
    lastSeenAtUtc: HOURS_AGO(1),
    latestActivityAtUtc: HOURS_AGO(1),
    latestResolvedAtUtc: null,
    assignedCount: 0,
    failureGroups: [],
    affectedSample: [],
    hasMoreAffected: false,
    availableActions: [],
    metric: null,
    ...over,
  };
}

type Caps = Record<string, boolean>;
const TEAM_ADMIN: Caps = {
  OPERATIONS_VIEW: true,
  OPERATIONS_ACKNOWLEDGE: true,
  OPERATIONS_RESOLVE: true,
  OPERATIONS_SUPPRESS: true,
  OPERATIONS_ASSIGN: true,
  OPERATIONS_SAVED_VIEWS_MANAGE: true,
};

function envelope(capabilities: Caps = TEAM_ADMIN) {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities,
    diagnostics: { requestId: "test" },
    workspace: { id: WS, name: "Northgate Team", status: "active", scope: "TEAM" },
    activeSpace: { type: "TEAM", id: WS, displayName: "Northgate Team", roleLabel: "Admin" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: WS,
        kind: "ORGANIZATION",
        organizationId: null,
        displayName: "Northgate Team",
      },
    },
    account: { userId: ME, accountPlan: "PRO", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
  };
}

type Replies = {
  summary?: () => unknown;
  list?: (path: string) => unknown;
  groups?: (path: string) => unknown;
  resolvedGroups?: () => unknown;
  views?: () => unknown;
  detail?: (path: string) => unknown;
  mutation?: (path: string, body?: string) => unknown;
};

function routes(r: Replies = {}): Handler {
  return (path, method, body) => {
    if (path.startsWith("/v1/ops/summary")) return (r.summary ?? (() => summaryOf()))();
    if (path.startsWith("/v1/ops/incident-groups?")) {
      if (path.includes("resolvedWithinDays")) {
        return (r.resolvedGroups ?? (() => ({ groups: [], totals: { groups: 0, conditions: 0 }, completeness: { complete: true } })))();
      }
      return (r.groups ?? (() => ({ groups: [], totals: { groups: 0, conditions: 0 }, completeness: { complete: true } })))(path);
    }
    if (path.includes("/affected")) return { records: [], pagination: { nextCursor: null } };
    if (path.startsWith("/v1/ops/saved-views")) return (r.views ?? (() => ({ views: [] })))();
    if (path.startsWith("/v1/ops/assignable-operators")) return { operators: [], selfUserId: ME };
    if (method === "GET" && /^\/v1\/ops\/incidents\/[^/?]+\?/.test(path)) {
      if (r.detail) return r.detail(path);
      const id = decodeURIComponent(path.split("/")[4]!.split("?")[0]!);
      return { incident: { ...incident(id), timeline: [], timelineComplete: true } };
    }
    if (method === "GET" && path.startsWith("/v1/ops/incidents?")) {
      return (r.list ?? (() => listOf([incident("i-1"), incident("i-2", { severity: "CRITICAL" })])))(path);
    }
    if (method === "POST" && path === "/v1/ops/workspace-reconcile") return { refusedReason: null };
    return (r.mutation ?? (() => ({ ok: true })))(path, body);
  };
}

function tree() {
  return (
    <PlatformContextProvider testEnvelope={envelope() as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <OperationsPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>
  );
}

async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function mount() {
  cleanup();
  const utils = render(tree());
  await settle();
  return utils;
}

/** Browser Back/Forward: the address changes under a mounted page. */
async function navigateTo(utils: ReturnType<typeof render>, search: string) {
  currentSearch = search;
  utils.rerender(tree());
  await settle();
}

async function click(el: Element | null) {
  expect(el, "the control to press is on screen").not.toBeNull();
  await act(async () => {
    fireEvent.click(el as HTMLElement);
  });
  await settle();
}

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => Array.from(document.querySelectorAll(sel));
const gets = () => requestLog.filter((r) => r.method === "GET").map((r) => r.path);
const posts = () => requestLog.filter((r) => r.method === "POST");
const lastList = () => gets().filter((p) => p.startsWith("/v1/ops/incidents?")).at(-1) ?? "";
const groupReads = () =>
  gets().filter((p) => p.startsWith("/v1/ops/incident-groups?") && !p.includes("resolvedWithinDays"));
const resultLine = () => q("[data-ops-result-summary]")?.textContent ?? "";
const tableRowIds = () =>
  qa("[data-ops-table-surface] [data-ops-row]").map((el) => el.getAttribute("data-ops-row"));
const pressed = (view: "flat" | "grouped") =>
  q(`[data-ops-view="${view}"]`)?.getAttribute("aria-pressed");

/** The lifecycle control: the combobox labelled "Filter by lifecycle status". */
function statusControl(): HTMLElement {
  const label = qa("[data-ops-controls] .app-visually-hidden").find(
    (el) => el.textContent === EN.filterStatusLabel,
  );
  expect(label).toBeTruthy();
  const trigger = q(`[aria-labelledby="${label!.id}"]`);
  expect(trigger).not.toBeNull();
  return trigger as HTMLElement;
}

/** The first-use panel's fingerprints: none of them may appear outside state A. */
function expectNoOnboarding() {
  expect(q('[data-ops-empty="clear"]')).toBeNull();
  expect(document.body.textContent).not.toContain(EN.clearTitle);
  expect(q('a[href="/evidence"]')).toBeNull();
  expect(q('a[href="/home"]')).toBeNull();
  expect(document.body.textContent).not.toContain(EN.clearEvidenceLink);
  expect(document.body.textContent).not.toContain(EN.clearOverviewLink);
}

beforeEach(() => {
  cleanup();
  requestLog = [];
  replaced = [];
  currentSearch = "";
  handler = routes();
});

// ===========================================================================
// A. The default view and filters
// ===========================================================================

describe("A — /operations with no query opens All conditions with lifecycle All", () => {
  it("renders the flat list, reads lifecycle ALL, reads no groups, and SAYS every state is included", async () => {
    await mount();
    // Presentation: the flat "All conditions" list.
    expect(pressed("flat")).toBe("true");
    expect(pressed("grouped")).toBe("false");
    expect(q("[data-ops-view-toggle]")?.getAttribute("data-ops-presentation")).toBe("flat");
    expect(tableRowIds()).toEqual(["i-1", "i-2"]);
    expect(groupReads()).toHaveLength(0);
    // Lifecycle: ALL, sent explicitly — no hidden unresolved filter.
    expect(lastList()).toMatch(/status=ALL/);
    expect(lastList()).not.toMatch(/status=UNRESOLVED/);
    // …and the UI says so: the control reads "All", the count names its scope.
    expect(statusControl().textContent).toBe(EN.statusAll);
    expect(q("[data-ops-controls]")?.textContent).not.toContain(EN.statusUnresolvedDefault);
    expect(resultLine()).toBe("2 conditions · all statuses");
    expect(resultLine()).not.toContain(EN.resultFiltered);
    // The clean address is the default; nothing was written.
    expect(replaced).toEqual([]);
  });

  it("offers the lifecycle states as their own dimension: All, Unresolved, Open, Acknowledged, Silenced, Resolved", async () => {
    await mount();
    await click(statusControl());
    const options = qa('[role="option"]').map((o) => o.textContent?.trim());
    expect(options).toEqual([
      EN.statusAll,
      EN.statusUnresolved,
      EN.status.OPEN.label,
      EN.status.ACKNOWLEDGED.label,
      EN.statusSilencedOption,
      EN.status.RESOLVED.label,
    ]);
    // Choosing one writes ONLY the lifecycle; the presentation is untouched.
    const silenced = qa('[role="option"]').find((o) => o.textContent?.trim() === EN.statusSilencedOption);
    await click(silenced!);
    expect(replaced.at(-1)).toBe("/operations?status=SUPPRESSED");
    expect(pressed("flat")).toBe("true");
  });

  it("explicit URL params override every default, presentation included", async () => {
    currentSearch = "view=grouped&status=RESOLVED&severity=HIGH&category=REPORT&sla=BREACHED&q=tsa";
    await mount();
    expect(pressed("grouped")).toBe("true");
    const read = groupReads().at(-1)!;
    for (const re of [/status=RESOLVED/, /severity=HIGH/, /category=REPORT/, /sla=BREACHED/, /q=tsa/]) {
      expect(read).toMatch(re);
      expect(lastList()).toMatch(re);
    }
    expect(statusControl().textContent).toBe(EN.status.RESOLVED.label);
    // A narrowed count is labelled as filtered.
    expect(resultLine()).toContain(EN.resultFiltered);
  });

  it("search, severity, source and commitment compose with lifecycle ALL — no hidden unresolved filter", async () => {
    currentSearch = "severity=CRITICAL&category=REPORT&sla=AT_RISK&q=report";
    await mount();
    const read = lastList();
    for (const re of [/status=ALL/, /severity=CRITICAL/, /category=REPORT/, /sla=AT_RISK/, /q=report/]) {
      expect(read).toMatch(re);
    }
    expect(read).not.toMatch(/status=UNRESOLVED/);
    expect(resultLine()).toBe("2 conditions · all statuses · filtered");
  });

  it("switching presentation keeps the filters, and refresh restores the explicit state", async () => {
    currentSearch = "status=OPEN&severity=HIGH";
    await mount();
    await click(q('[data-ops-view="grouped"]'));
    expect(replaced.at(-1)).toBe("/operations?status=OPEN&severity=HIGH&view=grouped");
    expect(pressed("grouped")).toBe("true");
    // The presentation is not a filter: the list was not re-read for it.
    const listReads = gets().filter((p) => p.startsWith("/v1/ops/incidents?")).length;
    expect(listReads).toBe(1);

    // REFRESH — a new mount at the same address comes back exactly.
    await mount();
    expect(pressed("grouped")).toBe("true");
    expect(groupReads().at(-1)).toMatch(/status=OPEN/);
    expect(lastList()).toMatch(/status=OPEN/);
    expect(lastList()).toMatch(/severity=HIGH/);

    await click(q('[data-ops-view="flat"]'));
    expect(replaced.at(-1)).toBe("/operations?status=OPEN&severity=HIGH");
  });

  it("a filter change in the grouped view keeps the grouped view", async () => {
    currentSearch = "view=grouped";
    await mount();
    await click(q('[data-ops-metric="critical"]'));
    expect(replaced.at(-1)).toContain("view=grouped");
    expect(replaced.at(-1)).toContain("status=UNRESOLVED");
    expect(replaced.at(-1)).toContain("severity=CRITICAL");
  });

  it("opening and closing ?incident= never resets the filters, and a filter change keeps the drawer", async () => {
    currentSearch = "status=OPEN&severity=HIGH";
    await mount();
    const listReadsBefore = gets().filter((p) => p.startsWith("/v1/ops/incidents?")).length;
    await click(q('[data-ops-open="i-1"]'));
    expect(q('[data-ops-inspector="i-1"]')).not.toBeNull();
    expect(replaced.at(-1)).toBe("/operations?status=OPEN&severity=HIGH&incident=i-1");
    // Opening the drawer re-read nothing in the queue.
    expect(gets().filter((p) => p.startsWith("/v1/ops/incidents?")).length).toBe(listReadsBefore);

    // A filter changed WHILE the drawer is open keeps its address.
    await click(q('[data-ops-metric="resolved"]'));
    expect(replaced.at(-1)).toContain("incident=i-1");
    expect(replaced.at(-1)).toContain("status=RESOLVED");

    await click(q(`[aria-label="${EN.closeCondition}"]`));
    expect(q("[data-ops-inspector]")).toBeNull();
    expect(replaced.at(-1)).toBe("/operations?status=RESOLVED");
  });

  it("browser Back and Forward restore the exact presentation and lifecycle", async () => {
    const utils = await mount();
    await click(q('[data-ops-view="grouped"]'));
    expect(replaced.at(-1)).toBe("/operations?view=grouped");
    expect(pressed("grouped")).toBe("true");

    // BACK — to the clean default address.
    await navigateTo(utils, "");
    expect(pressed("flat")).toBe("true");
    expect(tableRowIds()).toEqual(["i-1", "i-2"]);
    expect(statusControl().textContent).toBe(EN.statusAll);

    // FORWARD — grouped again.
    await navigateTo(utils, "view=grouped");
    expect(pressed("grouped")).toBe("true");

    // …and to a narrowed history entry: exactly that lifecycle comes back.
    await navigateTo(utils, "status=RESOLVED");
    expect(pressed("flat")).toBe("true");
    expect(statusControl().textContent).toBe(EN.status.RESOLVED.label);
    expect(lastList()).toMatch(/status=RESOLVED/);
  });

  it("a saved view still applies its explicit params, and keeps the presentation on screen", async () => {
    currentSearch = "view=grouped";
    handler = routes({
      views: () => ({
        views: [
          {
            id: "v-crit",
            name: "Critical, unresolved",
            description: null,
            visibility: "PRIVATE",
            pinned: false,
            createdByUserId: ME,
            ownedByViewer: true,
            createdAt: HOURS_AGO(2),
            updatedAt: HOURS_AGO(2),
            filter: { teamId: WS, status: "UNRESOLVED", severity: "CRITICAL" },
          },
        ],
      }),
    });
    await mount();
    await click(q('[data-ops-saved-view="v-crit"]'));
    expect(replaced.at(-1)).toBe("/operations?status=UNRESOLVED&severity=CRITICAL&view=grouped");
  });
});

// ===========================================================================
// B. Empty-state semantics — from authoritative, unfiltered counts
// ===========================================================================

describe("B — global emptiness comes from authoritative counts, never from the filtered page", () => {
  it("FIXTURE 1: nothing active, two resolved (total 2) → both resolved visible under All/All, no panel, no CTAs, no zero total", async () => {
    handler = routes({
      summary: () => summaryOf({ ...ZERO_ACTIVE, resolved: 2, mayAssertAllClear: true, clearRefusalReason: null }),
      list: () => listOf([resolvedIncident("r-1"), resolvedIncident("r-2")]),
      resolvedGroups: () => ({
        groups: [
          group("resolved.one", { statusPosture: "RESOLVED", latestResolvedAtUtc: HOURS_AGO(5) }),
          group("resolved.two", { statusPosture: "RESOLVED", latestResolvedAtUtc: HOURS_AGO(6) }),
        ],
        totals: { groups: 2, conditions: 2 },
        completeness: { complete: true },
      }),
    });
    await mount();

    // Default All conditions + All.
    expect(pressed("flat")).toBe("true");
    expect(statusControl().textContent).toBe(EN.statusAll);
    expect(lastList()).toMatch(/status=ALL/);
    // Both resolved records are visible immediately.
    expect(tableRowIds()).toEqual(["r-1", "r-2"]);
    // No large clear panel, no Evidence Library / Workspace Overview CTAs.
    expectNoOnboarding();
    expect(q("[data-ops-empty]")).toBeNull();
    // No misleading zero total: the count states the real scope.
    expect(resultLine()).toBe("2 conditions · all statuses");
    expect(resultLine()).not.toMatch(/(^|\D)0 conditions/);
    // No large empty sections in the flat list.
    expect(q("[data-ops-section]")).toBeNull();
    // One small quiet positive line, and nothing louder.
    expect(q("[data-ops-quiet-clear]")?.textContent).toBe(EN.quietNoActive);
    expect(q("[data-ops-quiet-clear]")?.closest(".app-empty")).toBeNull();

    // The SAME workspace in the grouped presentation.
    await click(q('[data-ops-view="grouped"]'));
    expectNoOnboarding();
    expect(q("[data-ops-empty]")).toBeNull();
    // Action required and Monitoring collapse into ONE compact line…
    expect(qa("[data-ops-section-empty]")).toHaveLength(1);
    expect(q('[data-ops-section="active"]')?.textContent).toBe(EN.sectionEmptyActive);
    expect(q('[data-ops-section="action-required"]')).toBeNull();
    expect(q('[data-ops-section="monitoring"]')).toBeNull();
    // …and the resolved history is right there.
    const resolved = q('[data-ops-section="recently-resolved"]') as HTMLElement;
    expect(resolved.querySelectorAll("[data-ops-group]")).toHaveLength(2);
  });

  it("FIXTURE 2: authoritative total 5, filtered result 0 → 'No conditions match these filters.' + Reset filters, no onboarding", async () => {
    currentSearch = "severity=CRITICAL&q=nothing-matches";
    handler = routes({
      summary: () => summaryOf({ open: 3, resolved: 2 }),
      list: () => listOf([]),
    });
    await mount();
    const empty = q('[data-ops-empty="filtered"]') as HTMLElement;
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain("No conditions match these filters.");
    const reset = empty.querySelector("[data-ops-reset-filters]") as HTMLButtonElement;
    expect(reset.textContent).toBe("Reset filters");
    expectNoOnboarding();
    expect(empty.querySelector("a")).toBeNull();
    // Filtered zero never reads as global zero.
    expect(resultLine()).toBe("0 conditions · all statuses · filtered");

    // Reset → the Part A defaults: the clean address, flat, ALL.
    await click(reset);
    expect(replaced.at(-1)).toBe("/operations");
  });

  it("FIXTURE 2 (grouped): a filtered grouped view with no groups resets to the flat default too", async () => {
    currentSearch = "view=grouped&severity=CRITICAL";
    handler = routes({ summary: () => summaryOf({ open: 3, resolved: 2 }), list: () => listOf([]) });
    await mount();
    expect(q('[data-ops-empty="filtered"]')).not.toBeNull();
    expectNoOnboarding();
    await click(q("[data-ops-reset-filters]"));
    expect(replaced.at(-1)).toBe("/operations");
    expect(pressed("flat")).toBe("true");
  });

  it("FIXTURE 3: authoritative unfiltered total 0 → the ONLY state with the full first-use panel", async () => {
    handler = routes({
      summary: () => summaryOf({ ...ZERO_ACTIVE, resolved: 0, mayAssertAllClear: true, clearRefusalReason: null }),
      list: () => listOf([]),
    });
    await mount();
    const panel = q('[data-ops-empty="clear"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain(EN.clearTitle);
    expect(Array.from(panel.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual([
      "/evidence",
      "/home",
    ]);
    expect(q("[data-ops-quiet-clear]")).toBeNull();

    // In the grouped presentation it is the same single panel, with no
    // resolved section (there is no history) and no section blocks.
    await click(q('[data-ops-view="grouped"]'));
    expect(qa('[data-ops-empty="clear"]')).toHaveLength(1);
    expect(q("[data-ops-section]")).toBeNull();
  });

  it("an empty page is never 'clear' when the resolved count could not be read", async () => {
    handler = routes({
      summary: () => summaryOf({ ...ZERO_ACTIVE, resolved: null, mayAssertAllClear: true, clearRefusalReason: null }),
      list: () => listOf([]),
    });
    await mount();
    expectNoOnboarding();
    expect(q('[data-ops-empty="unconfirmed"]')?.getAttribute("data-ops-unconfirmed-reason")).toBe("check");
  });

  it("a zero total the server did not license (a partial check) is never 'clear' either", async () => {
    handler = routes({
      summary: () =>
        summaryOf({ ...ZERO_ACTIVE, resolved: 0, mayAssertAllClear: false, readiness: "PARTIAL", clearRefusalReason: "PARTIAL_SOURCES" }),
      list: () => listOf([]),
    });
    await mount();
    expectNoOnboarding();
    expect(q('[data-ops-empty="unconfirmed"]')).not.toBeNull();
    expect(q('[data-ops-empty="filtered"]')).toBeNull();
  });

  it("STATE E: active records exist → they are listed with their history, and no quiet 'nothing needs action' line", async () => {
    handler = routes({
      summary: () => summaryOf({ open: 1, resolved: 1 }),
      list: () => listOf([incident("i-open"), resolvedIncident("r-old")]),
      groups: () => ({ groups: [group("live.source")], totals: { groups: 1, conditions: 1 }, completeness: { complete: true } }),
    });
    await mount();
    expect(tableRowIds()).toEqual(["i-open", "r-old"]);
    expect(q("[data-ops-quiet-clear]")).toBeNull();
    expectNoOnboarding();
    await click(q('[data-ops-view="grouped"]'));
    expect(q('[data-ops-section="action-required"] [data-ops-group="live.source"]')).not.toBeNull();
    expect(q("[data-ops-quiet-clear]")).toBeNull();
  });
});

// ===========================================================================
// C. The grouped view's information architecture
// ===========================================================================

describe("C — Action required is primary, Monitoring secondary, Resolved quiet; empty sections are one line", () => {
  it("only Action required populated: one full section, the others one line each", async () => {
    currentSearch = "view=grouped";
    handler = routes({
      groups: () => ({ groups: [group("act.source")], totals: { groups: 1, conditions: 1 }, completeness: { complete: true } }),
    });
    await mount();
    const action = q('[data-ops-section="action-required"]') as HTMLElement;
    expect(action.tagName).toBe("SECTION");
    expect(action.getAttribute("data-ops-section-rank")).toBe("primary");
    expect(action.classList.contains("opsw-section--primary")).toBe(true);
    expect(action.querySelector("h2")?.textContent).toBe(EN.sectionActionRequired);

    const monitoring = q('[data-ops-section="monitoring"]') as HTMLElement;
    expect(monitoring.getAttribute("data-ops-section-collapsed")).toBe("true");
    expect(monitoring.querySelector("h2")).toBeNull();
    expect(monitoring.textContent).toBe(EN.sectionEmptyMonitoring);

    const resolved = q('[data-ops-section="recently-resolved"]') as HTMLElement;
    expect(resolved.getAttribute("data-ops-section-collapsed")).toBe("true");
    expect(resolved.querySelector("h2")).toBeNull();
    expect(resolved.textContent).toBe(EN.sectionEmptyResolved);

    // ONE heading for ONE populated section — no stack of empty blocks.
    expect(qa("[data-ops-section] h2")).toHaveLength(1);
    expect(q("[data-ops-empty]")).toBeNull();
  });

  it("only Monitoring populated: Action required is one line, Monitoring is the secondary section", async () => {
    currentSearch = "view=grouped";
    handler = routes({
      groups: () => ({
        groups: [group("watch.source", { statusPosture: "ACKNOWLEDGED" })],
        totals: { groups: 1, conditions: 1 },
        completeness: { complete: true },
      }),
    });
    await mount();
    expect(q('[data-ops-section="action-required"]')?.getAttribute("data-ops-section-collapsed")).toBe("true");
    expect(q('[data-ops-section="action-required"]')?.textContent).toBe(EN.sectionEmptyAction);
    const monitoring = q('[data-ops-section="monitoring"]') as HTMLElement;
    expect(monitoring.getAttribute("data-ops-section-rank")).toBe("secondary");
    expect(monitoring.querySelector('[data-ops-group="watch.source"]')).not.toBeNull();
  });

  it("all three populated: heading order follows rank, and Resolved is quiet reference content", async () => {
    currentSearch = "view=grouped";
    handler = routes({
      groups: () => ({
        groups: [group("act.source"), group("watch.source", { statusPosture: "SUPPRESSED" })],
        totals: { groups: 2, conditions: 2 },
        completeness: { complete: true },
      }),
      resolvedGroups: () => ({
        groups: [group("done.source", { statusPosture: "RESOLVED", latestResolvedAtUtc: HOURS_AGO(3) })],
        totals: { groups: 1, conditions: 1 },
        completeness: { complete: true },
      }),
    });
    await mount();
    const headings = qa("h1, h2:not(.app-visually-hidden)").map((h) => h.textContent);
    expect(headings).toEqual([
      EN.pageTitle,
      EN.sectionActionRequired,
      EN.sectionMonitoring,
      EN.sectionRecentlyResolved,
    ]);
    const resolved = q('[data-ops-section="recently-resolved"]') as HTMLElement;
    expect(resolved.getAttribute("data-ops-section-rank")).toBe("reference");
    expect(resolved.classList.contains("opsw-section--quiet")).toBe(true);
    // Every section is labelled by its own heading, for screen readers.
    for (const s of qa("section[data-ops-section]")) {
      const id = s.getAttribute("aria-labelledby");
      expect(id && document.getElementById(id)?.tagName).toBe("H2");
    }
    // Each group row keeps its facts: title, severity and status posture.
    const row = q('[data-ops-group="act.source"]') as HTMLElement;
    expect(row.textContent).toContain("Group act.source");
  });
});

// ===========================================================================
// D. The resolution note
// ===========================================================================

describe("D — the resolution note is trimmed, bounded, sent once, and its success shows at once", () => {
  const NOTE_REQUIRED = incident("i-note", {
    title: "Retention policy conflicts with an active legal hold",
    category: "GOVERNANCE",
    lifecycle: {
      sourceId: "governance.notification_escalated",
      sourceMatch: "CATEGORY_RESIDUAL",
      resolutionAuthority: "OPERATOR_DECISION",
      audience: "TENANT_ACTIONABLE",
      cardinality: "EVENT",
      recoveryPolicy: "OPERATOR_CLOSES",
      manualResolution: true,
      requiresResolutionNote: true,
    },
  });

  let resolvedOnServer = false;
  function noteRoutes(mutation?: Replies["mutation"]) {
    resolvedOnServer = false;
    const current = () =>
      resolvedOnServer
        ? { ...NOTE_REQUIRED, status: "RESOLVED", resolvedAtUtc: HOURS_AGO(0), resolvedByUserId: ME }
        : NOTE_REQUIRED;
    return routes({
      summary: () =>
        resolvedOnServer ? summaryOf({ ...ZERO_ACTIVE, resolved: 3 }) : summaryOf({ ...ZERO_ACTIVE, open: 1, high: 1, unassigned: 1, resolved: 2 }),
      list: () => listOf([current()]),
      detail: () => ({ incident: { ...current(), timeline: [], timelineComplete: true } }),
      mutation:
        mutation ??
        ((path) => {
          if (path.endsWith("/resolve")) resolvedOnServer = true;
          return { ok: true };
        }),
    });
  }

  async function openNoteDrawer() {
    await mount();
    await click(q('[data-ops-open="i-note"]'));
    const field = q("[data-ops-resolution-note-input]") as HTMLTextAreaElement;
    const resolve = q('[data-ops-inspector] [data-ops-action="resolve"]') as HTMLButtonElement;
    expect(field).not.toBeNull();
    expect(resolve).not.toBeNull();
    return { field, resolve };
  }
  async function type(field: HTMLTextAreaElement, value: string) {
    await act(async () => {
      fireEvent.change(field, { target: { value } });
    });
  }

  it("shows the helper text exactly, tied to the field", async () => {
    handler = noteRoutes();
    const { field } = await openNoteDrawer();
    expect(EN.resolveNoteHelper).toBe(
      "Add a short conclusion so future reviewers know why this condition was closed.",
    );
    const helper = q("[data-ops-resolution-note-helper]") as HTMLElement;
    expect(helper.textContent).toBe(EN.resolveNoteHelper);
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(helper.id);
    expect(field.required).toBe(true);
    // German and Arabic carry their own sentence.
    expect(operationsDict.de.resolveNoteHelper).not.toBe(EN.resolveNoteHelper);
    expect(operationsDict.ar.resolveNoteHelper).not.toBe(EN.resolveNoteHelper);
  });

  it("rejects an empty or whitespace-only note, and sends a TRIMMED one", async () => {
    handler = noteRoutes();
    const { field, resolve } = await openNoteDrawer();
    expect(resolve.disabled).toBe(true);
    await type(field, "   \n\t  ");
    expect(resolve.disabled).toBe(true);
    expect(q("[data-ops-disabled-reason]")?.textContent).toBe(EN.resolveNoteRequiredHint);
    await click(resolve);
    expect(posts().filter((p) => p.path.endsWith("/resolve"))).toHaveLength(0);

    await type(field, "   Hold released by counsel.   ");
    expect(resolve.disabled).toBe(false);
    await click(resolve);
    const sent = posts().filter((p) => p.path.endsWith("/resolve"));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body as string).resolutionNote).toBe("Hold released by counsel.");
  });

  it("is bounded by the server's own limit, with a counter near it and a message past it", async () => {
    handler = noteRoutes();
    expect(RESOLUTION_NOTE_MAX).toBe(400);
    const { field, resolve } = await openNoteDrawer();
    expect(field.maxLength).toBe(400);
    await type(field, "a".repeat(200));
    expect(q("[data-ops-resolution-note-counter]")).toBeNull();
    await type(field, "a".repeat(330));
    expect(q("[data-ops-resolution-note-counter]")?.textContent).toBe("330 of 400 characters");
    expect(resolve.disabled).toBe(false);
    await type(field, "a".repeat(400));
    expect(resolve.disabled).toBe(false);
    // A pasted or programmatic value past the bound is refused here, not by
    // the server after the press.
    await type(field, "a".repeat(401));
    expect(q("[data-ops-resolution-note-counter]")?.getAttribute("data-ops-resolution-note-too-long")).toBe("true");
    expect(q("[data-ops-resolution-note-counter]")?.textContent).toBe("Shorten the note to 400 characters or fewer.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(resolve.disabled).toBe(true);
  });

  it("disables Resolve while submitting, and a double press is ONE request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    handler = noteRoutes(async (path) => {
      if (path.endsWith("/resolve")) {
        await gate;
        resolvedOnServer = true;
      }
      return { ok: true };
    });
    const { field, resolve } = await openNoteDrawer();
    await type(field, "Duplicate delivery confirmed and closed upstream.");
    // Two presses inside ONE frame — before any re-render could disable it.
    await act(async () => {
      fireEvent.click(resolve);
      fireEvent.click(resolve);
    });
    await settle();
    expect(posts().filter((p) => p.path.endsWith("/resolve"))).toHaveLength(1);
    const during = q('[data-ops-inspector] [data-ops-action="resolve"]') as HTMLButtonElement;
    expect(during.disabled).toBe(true);
    await click(during);
    expect(posts().filter((p) => p.path.endsWith("/resolve"))).toHaveLength(1);
    await act(async () => {
      release();
    });
    await settle();
    expect(posts().filter((p) => p.path.endsWith("/resolve"))).toHaveLength(1);
  });

  it("a successful Resolve updates the list, the counts and the drawer at once — no page refresh", async () => {
    handler = noteRoutes();
    const { field, resolve } = await openNoteDrawer();
    expect(q('[data-ops-metric="open"]')?.getAttribute("data-ops-metric-value")).toBe("1");
    const listReads = gets().filter((p) => p.startsWith("/v1/ops/incidents?")).length;
    await type(field, "Hold released by counsel.");
    await click(resolve);
    // The SAME mounted page re-read its sources…
    expect(gets().filter((p) => p.startsWith("/v1/ops/incidents?")).length).toBe(listReads + 1);
    // …so the row, the summary and the drawer show the new state.
    const row = q('[data-ops-table-surface] [data-ops-row="i-note"]') as HTMLElement;
    expect(row.textContent).toContain(EN.status.RESOLVED.label);
    expect(row.textContent).not.toContain(EN.status.OPEN.label);
    expect(q('[data-ops-metric="open"]')?.getAttribute("data-ops-metric-value")).toBe("0");
    expect(q('[data-ops-metric="resolved"]')?.getAttribute("data-ops-metric-value")).toBe("3");
    expect(q("[data-ops-resolution-note-input]")).toBeNull();
    expect(q('[data-ops-inspector] [data-ops-action="resolve"]')).toBeNull();
  });

  it("a refused Resolve keeps the operator's note", async () => {
    handler = noteRoutes(() => {
      const err = new Error("request failed") as Error & { statusCode: number };
      err.statusCode = 500;
      return err;
    });
    const { field, resolve } = await openNoteDrawer();
    await type(field, "Closed after the provider confirmed the fix.");
    await click(resolve);
    const after = q("[data-ops-resolution-note-input]") as HTMLTextAreaElement;
    expect(after.value).toBe("Closed after the provider confirmed the fix.");
  });

  it("the action copy is truthful: Acknowledge is ownership, Stop notifying is notifications only", () => {
    expect(EN.status.ACKNOWLEDGED.explanation).toMatch(/does not mean the underlying problem is fixed/);
    expect(EN.suppressConfirmBody).toMatch(/only notifications stop/);
    // No canned conclusion: the field asks, it never claims a repair.
    expect(EN.resolveNoteHelper).not.toMatch(/fixed|repaired|resolved the/i);
  });
});
