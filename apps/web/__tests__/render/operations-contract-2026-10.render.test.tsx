/**
 * Operations — the 2026-10-12 contract, driven for real.
 *
 * Each case mounts a REAL page (the workbench, Workspace Health or the
 * organisation readiness roll-up) against contract-shaped replies and asserts
 * one property the audit found broken:
 *
 *   - every KPI opens the list with EXACTLY the predicate that counted it;
 *   - a summary that could not be read renders Unavailable — never 0, never an
 *     all-clear, never an automatic re-check — and a bounded one "at least N";
 *   - a workspace switch discards every late response from the previous
 *     workspace, resolved out of order (D1/D2/D3);
 *   - a remediation answer for a condition the drawer no longer shows is
 *     dropped (D8);
 *   - a saved view keeps its SLA filter on save AND on apply (D11);
 *   - the Enterprise roll-up says Unavailable / at least N and that its totals
 *     are incomplete;
 *   - Workspace Health renders UNKNOWN with its reason, never Healthy.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";

import {
  filtersForMetric,
  metricForFilters,
  DEFAULT_FILTERS,
} from "../../app/(app)/operations/_lib/filters";
import { QUEUE_METRIC_ORDER } from "../../app/(app)/operations/_lib/vocabulary";
import { classifyOpsError, classifyReconcileRefusal } from "../../app/(app)/operations/_lib/errors";
import { operationsDict } from "@proovra/shared/i18n";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type Handler = (path: string, method: string, body?: string) => unknown;

let requestLog: Array<{ path: string; method: string; body?: string }> = [];
let handler: Handler = () => ({});
let replaced: string[] = [];
let currentSearch = "";
const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));

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

/** The reader's locale, for the German and Arabic cases. */
const localeState = vi.hoisted(() => ({ locale: "en" as string }));
vi.mock("../../app/providers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalLocale: () => localeState.locale,
}));

const pushed: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      pushed.push(href);
    },
    replace: (href: string) => {
      replaced.push(href);
      currentSearch = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
    },
    back: () => {},
  }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/operations",
  useParams: () => routeParams.value,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import {
  PlatformContextProvider,
  usePlatformContext,
} from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import OperationsPage from "../../app/(app)/operations/page";
import WorkspaceHealthPage from "../../app/(app)/operations/health/page";
import OrganizationAdminReadinessPage from "../../app/(app)/organizations/[id]/admin/readiness/page";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-10-12T12:00:00.000Z");
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
    firstSeenAtUtc: HOURS_AGO(2),
    lastSeenAtUtc: HOURS_AGO(1),
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

function summaryOf(over: Record<string, unknown> = {}, workspaceId = WS) {
  return {
    summary: {
      workspaceId,
      generatedAtUtc: new Date(NOW).toISOString(),
      open: 3,
      critical: 1,
      high: 1,
      warning: 1,
      info: 0,
      acknowledged: 1,
      assignedToMe: 1,
      unassigned: 2,
      slaBreached: 1,
      slaAtRisk: 0,
      slaOnTrack: 0,
      slaUntracked: 2,
      resolved: 4,
      complete: true,
      mayAssertAllClear: false,
      incompleteReason: null,
      readiness: "READY",
      clearRefusalReason: "UNRESOLVED_CONDITIONS",
      reconciliation: null,
      groups: [],
      ...over,
    },
    workspace: { operatorCount: 3 },
  };
}

/** The server's answer for a summary it could NOT read. */
function unreadableSummary() {
  return summaryOf({
    open: null,
    critical: null,
    high: null,
    warning: null,
    info: null,
    acknowledged: null,
    assignedToMe: null,
    unassigned: null,
    slaBreached: null,
    slaAtRisk: null,
    slaOnTrack: null,
    slaUntracked: null,
    resolved: null,
    complete: false,
    mayAssertAllClear: false,
    incompleteReason: "SOURCE_FAILED",
    // The honest floor an unreadable summary reports — NOT a fact about
    // discovery, and never a reason to start a re-check.
    readiness: "NEVER_RUN",
    clearRefusalReason: "NEVER_RUN",
  });
}

function listOf(rows: unknown[]) {
  return {
    incidents: rows,
    pagination: { nextCursor: null, returned: rows.length },
    completeness: { complete: true, mayAssertAllClear: false },
  };
}

function group(groupKey: string, over: Record<string, unknown> = {}) {
  return {
    groupKey,
    sourceId: groupKey,
    category: "EVIDENCE_INTEGRITY",
    title: `Group ${groupKey}`,
    conditionCount: 2,
    affectedRecordCount: null,
    affectedUnit: null,
    observations: 2,
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
  WORKSPACE_HEALTH_VIEW: true,
};

function envelope(
  capabilities: Caps,
  workspaceId = WS,
  name = "Northgate Team",
  flags: Record<string, unknown> = { isEnterpriseWorkspace: false },
) {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities,
    diagnostics: { requestId: "test" },
    workspace: { id: workspaceId, name, status: "active", scope: "TEAM" },
    activeSpace: { type: "TEAM", id: workspaceId, displayName: name, roleLabel: "Admin" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId,
        kind: "ORGANIZATION",
        organizationId: null,
        displayName: name,
      },
    },
    account: { userId: ME, accountPlan: "PRO", accountStatus: "active" },
    flags,
    platform: { isPlatformAdmin: false },
  };
}

function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function settleTimers(ms = 60) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
  await settle();
}

/** Captures the provider's real `switchWorkspace` for the test to call. */
let switchTo: ((id: string | null) => Promise<void>) | null = null;
function SwitchProbe() {
  const ctx = usePlatformContext() as unknown as {
    switchWorkspace: (id: string | null) => Promise<void>;
  };
  switchTo = ctx.switchWorkspace;
  return null;
}

async function mount(page: React.ReactElement, env: unknown) {
  cleanup();
  const utils = render(
    <PlatformContextProvider testEnvelope={env as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <SwitchProbe />
          {page}
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
  return utils;
}

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => Array.from(document.querySelectorAll(sel));
const gets = () => requestLog.filter((r) => r.method === "GET").map((r) => r.path);
const posts = () => requestLog.filter((r) => r.method === "POST");
const lastList = () => gets().filter((p) => p.startsWith("/v1/ops/incidents?")).at(-1) ?? "";

/** A default router: one readable workspace with three conditions. */
function defaultHandler(over: Partial<Record<string, Handler>> = {}): Handler {
  return (path, method, body) => {
    for (const [prefix, h] of Object.entries(over)) {
      if (path.startsWith(prefix) && h) return h(path, method, body);
    }
    if (path.startsWith("/v1/ops/summary")) return summaryOf();
    if (path.startsWith("/v1/ops/incident-groups?")) {
      return {
        groups: [],
        totals: { groups: 0, conditions: 0 },
        completeness: { complete: true, mayAssertAllClear: false },
      };
    }
    if (path.includes("/affected")) return { records: [], pagination: { nextCursor: null } };
    if (path.startsWith("/v1/ops/assignable-operators")) return { operators: [], selfUserId: ME };
    if (path.startsWith("/v1/ops/saved-views")) return method === "GET" ? { views: [] } : { ok: true };
    if (method === "GET" && /^\/v1\/ops\/incidents\/[^/?]+\?/.test(path)) {
      const id = path.split("/")[4]!.split("?")[0]!;
      return { incident: { ...incident(id), timeline: [], timelineComplete: true }, remediation: null };
    }
    if (method === "GET" && path.startsWith("/v1/ops/incidents?")) {
      return listOf([incident("i-1"), incident("i-2", { severity: "CRITICAL" })]);
    }
    if (path === "/v1/ops/workspace-reconcile") return { ran: true, readiness: "READY", retryable: true, refusedReason: null };
    return { ok: true };
  };
}

beforeEach(() => {
  requestLog = [];
  replaced = [];
  pushed.length = 0;
  currentSearch = "";
  switchTo = null;
  routeParams.value = {};
  handler = defaultHandler();
});

// ===========================================================================
// 1. KPI -> list predicate
// ===========================================================================

describe("every KPI opens the list with the exact predicate that counted it", () => {
  it("the mapping is total, and round-trips through the filter state", () => {
    for (const key of QUEUE_METRIC_ORDER) {
      const f = filtersForMetric(key);
      // Every unresolved KPI is UNRESOLVED; Resolved is RESOLVED.
      expect(f.status).toBe(key === "resolved" ? "RESOLVED" : "UNRESOLVED");
      // The default view (Unresolved) is not "a card selected".
      expect(metricForFilters(f)).toBe(key === "open" ? null : key);
    }
    expect(filtersForMetric("critical")).toMatchObject({ severity: "CRITICAL", sla: "", owner: "any" });
    expect(filtersForMetric("slaBreached")).toMatchObject({ sla: "BREACHED", severity: "" });
    expect(filtersForMetric("slaAtRisk")).toMatchObject({ sla: "AT_RISK" });
    expect(filtersForMetric("unassigned")).toMatchObject({ owner: "unassigned" });
    expect(DEFAULT_FILTERS.status).toBe("UNRESOLVED");
  });

  it("pressing each card re-reads with status, severity, SLA and owner exactly as counted", async () => {
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    const expectations: Array<[string, RegExp[], RegExp[]]> = [
      ["critical", [/status=UNRESOLVED/, /severity=CRITICAL/], [/sla=/, /owner=/]],
      ["high", [/status=UNRESOLVED/, /severity=HIGH/], [/sla=/]],
      ["warning", [/status=UNRESOLVED/, /severity=WARNING/], [/sla=/]],
      ["slaBreached", [/status=UNRESOLVED/, /sla=BREACHED/], [/severity=/]],
      ["slaAtRisk", [/status=UNRESOLVED/, /sla=AT_RISK/], [/severity=/]],
      ["assignedToMe", [/status=UNRESOLVED/, /owner=me/], [/severity=/, /sla=/]],
      ["unassigned", [/status=UNRESOLVED/, /owner=unassigned/], [/severity=/]],
      ["resolved", [/status=RESOLVED/], [/severity=/, /sla=/, /owner=/]],
      ["open", [/status=UNRESOLVED/], [/severity=/, /sla=/, /owner=/]],
    ];
    for (const [key, must, mustNot] of expectations) {
      await act(async () => {
        fireEvent.click(q(`[data-ops-metric="${key}"]`) as HTMLElement);
      });
      await settle();
      for (const re of must) expect(lastList(), `${key}: ${re}`).toMatch(re);
      for (const re of mustNot) expect(lastList(), `${key}: not ${re}`).not.toMatch(re);
      if (key !== "open") {
        expect(q(`[data-ops-metric="${key}"]`)?.getAttribute("aria-pressed")).toBe("true");
      }
    }
  });

  it("the Unresolved card says what it counts, and the status filter names the default", async () => {
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    expect(q('[data-ops-metric="open"]')?.textContent).toContain("Open, acknowledged or suppressed.");
    expect(document.body.textContent).toContain(EN.statusUnresolvedDefault);
  });
});

// ===========================================================================
// 2. An unreadable summary is UNKNOWN
// ===========================================================================

describe("a summary that could not be read is unavailable, never zero", () => {
  it("renders — / Unavailable, no 0, no all-clear, and starts no re-check", async () => {
    handler = defaultHandler({
      "/v1/ops/summary": () => unreadableSummary(),
      "/v1/ops/incidents?": () => listOf([]),
    });
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    await settleTimers();

    expect(q("[data-ops-summary-unavailable]")?.textContent).toBe(EN.metricsUnavailableNote);
    for (const card of qa("[data-ops-metric]")) {
      expect(card.getAttribute("data-ops-metric-value")).toBe("—");
      expect(card.querySelector(".app-metric-card__value")?.textContent).toBe("—");
      expect(card.textContent).toContain(EN.metricUnavailable);
    }
    expect(qa("[data-ops-metric]").some((c) => /(^|\D)0(\D|$)/.test(c.querySelector(".app-metric-card__value")?.textContent ?? ""))).toBe(false);
    // Not clear, and not "Preparing — the first check is running".
    expect(q('[data-ops-empty="clear"]')).toBeNull();
    expect(q('[data-ops-empty="preparing"]')).toBeNull();
    expect(q('[data-ops-empty="unconfirmed"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain(EN.clearTitle);
    // NEVER_RUN on an UNREADABLE summary is a floor, not a fact: no auto check.
    expect(posts().filter((p) => p.path === "/v1/ops/workspace-reconcile")).toHaveLength(0);
  });

  it("a summary that was READ and says NEVER_RUN does start the first check, once", async () => {
    handler = defaultHandler({
      "/v1/ops/summary": () =>
        summaryOf({ open: 0, critical: 0, high: 0, warning: 0, readiness: "NEVER_RUN", clearRefusalReason: "NEVER_RUN" }),
      "/v1/ops/incidents?": () => listOf([]),
    });
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    await settleTimers();
    expect(posts().filter((p) => p.path === "/v1/ops/workspace-reconcile")).toHaveLength(1);
  });

  it("a bounded summary reads 'at least N', and Resolved stays exact", async () => {
    handler = defaultHandler({
      "/v1/ops/summary": () =>
        summaryOf({ open: 5000, critical: 12, complete: false, incompleteReason: "SCAN_BOUND_REACHED" }),
    });
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    expect(q('[data-ops-metric="open"]')?.getAttribute("data-ops-metric-value")).toBe("at least 5,000");
    expect(q('[data-ops-metric="critical"]')?.getAttribute("data-ops-metric-value")).toBe("at least 12");
    expect(q('[data-ops-metric="resolved"]')?.getAttribute("data-ops-metric-value")).toBe("4");
    expect(q("[data-ops-summary-floor]")).not.toBeNull();
  });
});

// ===========================================================================
// 3. Workspace switch — out-of-order responses are discarded
// ===========================================================================

describe("a workspace switch discards every late response from the previous workspace", () => {
  it("summary, list, groups, saved views and operators from A never paint under B", async () => {
    const slowA = {
      summary: deferred(),
      list: deferred(),
      groups: deferred(),
      views: deferred(),
      operators: deferred(),
    };
    handler = (path, method, body) => {
      const isA = path.includes(WS);
      if (path === "/v1/platform/context/switch-workspace") {
        return envelope(TEAM_ADMIN, OTHER_WS, "Other Team");
      }
      if (isA) {
        if (path.startsWith("/v1/ops/summary")) return slowA.summary.promise;
        if (path.startsWith("/v1/ops/incidents?")) return slowA.list.promise;
        if (path.startsWith("/v1/ops/incident-groups?") && !path.includes("resolvedWithinDays")) return slowA.groups.promise;
        if (path.startsWith("/v1/ops/saved-views")) return slowA.views.promise;
        if (path.startsWith("/v1/ops/assignable-operators")) return slowA.operators.promise;
      }
      if (path.startsWith("/v1/ops/summary")) return summaryOf({ open: 1, critical: 0, high: 0, warning: 1 }, OTHER_WS);
      if (path.startsWith("/v1/ops/incidents?")) return listOf([incident("b-1")]);
      if (path.startsWith("/v1/ops/incident-groups?") && !path.includes("resolvedWithinDays")) {
        return { groups: [group("b.source")], totals: { groups: 1, conditions: 2 }, completeness: { complete: true } };
      }
      if (path.startsWith("/v1/ops/saved-views")) return { views: [] };
      if (path.startsWith("/v1/ops/assignable-operators")) return { operators: [], selfUserId: ME };
      return defaultHandler()(path, method, body);
    };

    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    // A's reads are all in flight. Switch to B.
    await act(async () => {
      await switchTo!(OTHER_WS);
    });
    await settle();
    expect(q("[data-context-workspace]")?.textContent).toBe("Other Team");
    expect(q('[data-ops-group="b.source"]')).not.toBeNull();

    // NOW A's responses land — out of order, after B's.
    await act(async () => {
      slowA.groups.resolve({ groups: [group("a.source")], totals: { groups: 1, conditions: 2 }, completeness: { complete: true } });
      slowA.views.resolve({
        views: [
          {
            id: "v-a",
            name: "A's private view",
            description: null,
            visibility: "PRIVATE",
            pinned: false,
            createdByUserId: ME,
            ownedByViewer: true,
            createdAt: HOURS_AGO(1),
            updatedAt: HOURS_AGO(1),
            filter: { teamId: WS, severity: "CRITICAL" },
          },
        ],
      });
      slowA.operators.resolve({
        operators: [{ userId: "op-a", displayName: "Only in A", email: null, role: "ADMIN" }],
        selfUserId: ME,
      });
      slowA.summary.resolve(summaryOf({ open: 999, critical: 999 }));
      slowA.list.resolve(listOf([incident("a-leak")]));
    });
    await settle();

    expect(q('[data-ops-group="a.source"]')).toBeNull();
    expect(q('[data-ops-group="b.source"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("A's private view");
    expect(document.body.textContent).not.toContain("Only in A");
    expect(q('[data-ops-metric="open"]')?.getAttribute("data-ops-metric-value")).toBe("1");
    expect(document.body.textContent).not.toContain("999");
    // The flat list too.
    await act(async () => {
      fireEvent.click(q('[data-ops-view="flat"]') as HTMLElement);
    });
    await settle();
    expect(q('[data-ops-row="a-leak"]')).toBeNull();
    expect(q('[data-ops-row="b-1"]')).not.toBeNull();
  });
});

// ===========================================================================
// 4. The drawer remediation race (D8)
// ===========================================================================

describe("a remediation answer is bound to the condition and workspace that asked", () => {
  it("an answer that lands after the drawer moved to another condition is dropped", async () => {
    const slowRemediation = deferred();
    handler = defaultHandler({
      "/v1/ops/incidents/i-1?": () => ({
        incident: { ...incident("i-1"), timeline: [], timelineComplete: true },
        remediation: {
          disposition: "DIRECT_REMEDIATION",
          actions: [{ actionId: "retry", label: "Retry it", description: "Retries.", confirm: false, async: true }],
          deepLink: null,
          guidance: null,
          unsafeReason: null,
        },
      }),
      "/v1/ops/incidents/i-1/remediate": () => slowRemediation.promise,
    });
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q('[data-ops-view="flat"]') as HTMLElement);
    });
    await settle();
    await act(async () => {
      fireEvent.click(q('[data-ops-open="i-1"]') as HTMLElement);
    });
    await settle();
    await act(async () => {
      fireEvent.click(q('[data-ops-remediate="retry"]') as HTMLElement);
    });
    await settle();
    expect(posts().some((p) => p.path === "/v1/ops/incidents/i-1/remediate")).toBe(true);

    // The operator moves on to another condition while the request is out.
    currentSearch = "incident=i-2";
    await act(async () => {
      fireEvent.click(q('[data-ops-open="i-2"]') as HTMLElement);
    });
    await settle();
    expect(q("[data-ops-inspector]")?.textContent).toContain("Condition i-2");

    await act(async () => {
      slowRemediation.resolve({ remediation: { result: "QUEUED", message: "Accepted and queued for i-1." } });
    });
    await settle();
    expect(q("[data-ops-remediation-result]")).toBeNull();
    expect(document.body.textContent).not.toContain("Accepted and queued for i-1.");
  });
});

// ===========================================================================
// 5. Saved views keep the SLA filter (D11)
// ===========================================================================

describe("a saved view keeps its SLA filter", () => {
  it("is SENT on save and RESTORED on apply", async () => {
    currentSearch = "sla=BREACHED&owner=unassigned";
    handler = defaultHandler({
      "/v1/ops/saved-views": (_p, method) =>
        method === "GET"
          ? {
              views: [
                {
                  id: "v-1",
                  name: "Overdue",
                  description: null,
                  visibility: "PRIVATE",
                  pinned: false,
                  createdByUserId: ME,
                  ownedByViewer: true,
                  createdAt: HOURS_AGO(2),
                  updatedAt: HOURS_AGO(2),
                  filter: { teamId: WS, sla: "AT_RISK", severity: "HIGH" },
                },
              ],
            }
          : { ok: true },
    });
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q("[data-ops-view-start-save]") as HTMLElement);
    });
    await act(async () => {
      fireEvent.change(q("[data-ops-view-name]") as HTMLInputElement, { target: { value: "Late and unowned" } });
    });
    await act(async () => {
      fireEvent.click(q("[data-ops-view-save]") as HTMLElement);
    });
    await settle();
    const save = posts().find((p) => p.path === "/v1/ops/saved-views");
    expect(save).toBeTruthy();
    const filter = (JSON.parse(save!.body as string) as { filter: Record<string, string> }).filter;
    // The status is stored EXPLICITLY, the default included, so the view
    // replays as itself even if the queue default ever changes.
    expect(filter).toMatchObject({ teamId: WS, sla: "BREACHED", owner: "unassigned", status: "UNRESOLVED" });

    await act(async () => {
      fireEvent.click(q('[data-ops-saved-view="v-1"]') as HTMLElement);
    });
    await settle();
    expect(replaced.at(-1)).toContain("sla=AT_RISK");
    expect(replaced.at(-1)).toContain("severity=HIGH");
    // The harness router does not re-render on replace; re-open the page at
    // the URL the view wrote, as the real router would.
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    expect(lastList()).toMatch(/sla=AT_RISK/);
    expect(lastList()).toMatch(/severity=HIGH/);
    expect(lastList()).toMatch(/status=UNRESOLVED/);
  });
});

// ===========================================================================
// 6. Refusal copy (D6 / OPS-11)
// ===========================================================================

describe("a refused re-check says which refusal it was", () => {
  it("classifies: temporary is retryable; schema_mismatch and permission are not", () => {
    expect(classifyReconcileRefusal({ refusedReason: "database_unavailable", retryable: true })).toMatchObject({
      kind: "temporary",
      retryable: true,
    });
    expect(classifyReconcileRefusal({ refusedReason: "schema_mismatch", retryable: false }).kind).toBe("deployment");
    expect(classifyReconcileRefusal({ refusedReason: "permission_denied", retryable: false }).kind).toBe("permission");
    const e502 = Object.assign(new Error("x"), {
      code: "remediation_failed",
      statusCode: 502,
      body: { error: { code: "remediation_failed", retryable: true } },
    });
    expect(classifyOpsError(e502)).toMatchObject({ kind: "temporary", retryable: true });
    const e403 = Object.assign(new Error("x"), { code: "remediation_not_permitted", statusCode: 403 });
    expect(classifyOpsError(e403)).toMatchObject({ kind: "permission", retryable: false });
    const changed = Object.assign(new Error("x"), { code: "CONDITION_STATE_CHANGED", statusCode: 409 });
    expect(classifyOpsError(changed).kind).toBe("state_changed");
  });

  it("a temporary refusal offers Try again; a schema mismatch shows the deployment copy and no retry", async () => {
    let reply: Record<string, unknown> = { refusedReason: "timeout", retryable: true, readiness: "READY" };
    handler = defaultHandler({ "/v1/ops/workspace-reconcile": () => reply });
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q("[data-ops-refresh]") as HTMLElement);
    });
    await settle();
    expect(q("[data-ops-mutation-error]")?.textContent).toContain(EN.errors.checkTemporary);
    expect(q("[data-ops-mutation-retry]")).not.toBeNull();
    expect(document.body.textContent).not.toContain("data store");

    reply = { refusedReason: "schema_mismatch", retryable: false, readiness: "READY" };
    await act(async () => {
      fireEvent.click(q("[data-ops-mutation-retry]") as HTMLElement);
    });
    await settle();
    expect(q("[data-ops-mutation-error]")?.textContent).toContain(EN.errors.checkDeployment);
    expect(q("[data-ops-mutation-retry]")).toBeNull();
  });
});

// ===========================================================================
// 7. The live region announces a repeated sentence (D9)
// ===========================================================================

describe("the live region", () => {
  it("announces the same outcome twice in a row", async () => {
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q('[data-ops-view="flat"]') as HTMLElement);
    });
    await settle();
    const live = () => q("[data-ops-live]")?.textContent ?? "";
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(live()));
    observer.observe(q("[data-ops-live]") as Node, { childList: true, characterData: true, subtree: true });
    for (const id of ["i-1", "i-2"]) {
      await act(async () => {
        fireEvent.click(q(`[data-ops-open="${id}"]`) as HTMLElement);
      });
      await settle();
      await act(async () => {
        fireEvent.click(q('[data-ops-action="acknowledge"]') as HTMLElement);
      });
      await settleTimers();
    }
    observer.disconnect();
    expect(seen.filter((t) => t === EN.announceAcknowledged).length).toBe(2);
  });
});

// ===========================================================================
// 8. Workspace Health — UNKNOWN is never Healthy
// ===========================================================================

describe("Workspace Health", () => {
  it("renders UNKNOWN with its reason in plain words, and the canonical labels", async () => {
    handler = (path) => {
      if (path.endsWith("/operations/health")) {
        return {
          scope: "WORKSPACE",
          workspaceId: WS,
          state: "UNKNOWN",
          unknownReason: "NEVER_RUN",
          readiness: "NEVER_RUN",
          openIncidents: { total: 0, bySeverity: {} },
          unresolvedIncidents: 0,
          untriagedIncidents: 0,
          lastIncidentActivityUtc: null,
          evaluatedAtUtc: new Date(NOW).toISOString(),
        };
      }
      if (path.endsWith("/operations/alerts")) {
        return { scope: "WORKSPACE", workspaceId: WS, items: [], counts: { total: 0, critical: 0, high: 0 }, complete: true, evaluatedAtUtc: new Date(NOW).toISOString() };
      }
      return {};
    };
    await mount(<WorkspaceHealthPage />, envelope(TEAM_ADMIN));
    await settle();
    expect(q("[data-wsh-state]")?.getAttribute("data-wsh-state")).toBe("UNKNOWN");
    expect(q("[data-wsh-state-reason]")?.textContent).toBe(EN.health.unknownReason.NEVER_RUN);
    expect(document.body.textContent).not.toContain(EN.health.state.HEALTHY);
    expect(document.body.textContent).toContain(EN.health.factUnresolved);
    expect(document.body.textContent).toContain(EN.health.factUntriaged);
    // An empty list under an UNKNOWN posture is not an all-clear.
    expect(q("[data-wsh-alerts-empty]")?.textContent).toBe(EN.health.alertsEmptyUnconfirmed);
  });

  it("renders ATTENTION, and says when the alert list is capped", async () => {
    handler = (path) => {
      if (path.endsWith("/operations/health")) {
        return {
          scope: "WORKSPACE",
          workspaceId: WS,
          state: "ATTENTION",
          unknownReason: null,
          openIncidents: { total: 140, bySeverity: { WARNING: 140 } },
          unresolvedIncidents: 140,
          untriagedIncidents: 90,
          lastIncidentActivityUtc: HOURS_AGO(1),
          evaluatedAtUtc: new Date(NOW).toISOString(),
        };
      }
      if (path.endsWith("/operations/alerts")) {
        return {
          scope: "WORKSPACE",
          workspaceId: WS,
          items: [incident("w-1", { severity: "WARNING" })],
          counts: { total: 140, critical: 0, high: 0 },
          complete: false,
          evaluatedAtUtc: new Date(NOW).toISOString(),
        };
      }
      return {};
    };
    await mount(<WorkspaceHealthPage />, envelope(TEAM_ADMIN));
    await settle();
    expect(q("[data-wsh-state]")?.getAttribute("data-wsh-state")).toBe("ATTENTION");
    expect(q("[data-wsh-unresolved]")?.textContent).toBe("140");
    expect(q("[data-wsh-untriaged]")?.textContent).toBe("90");
    expect(q("[data-wsh-alerts-incomplete]")?.textContent).toContain("140");
  });

  it("an unrecognised state is rendered as Unknown, never Healthy", async () => {
    handler = (path) =>
      path.endsWith("/operations/health")
        ? {
            scope: "WORKSPACE",
            workspaceId: WS,
            state: "SOMETHING_NEW",
            openIncidents: { total: 0, bySeverity: {} },
            unresolvedIncidents: 0,
            lastIncidentActivityUtc: null,
            evaluatedAtUtc: new Date(NOW).toISOString(),
          }
        : { scope: "WORKSPACE", workspaceId: WS, items: [], counts: { total: 0, critical: 0, high: 0 }, evaluatedAtUtc: new Date(NOW).toISOString() };
    await mount(<WorkspaceHealthPage />, envelope(TEAM_ADMIN));
    await settle();
    expect(q("[data-wsh-state]")?.getAttribute("data-wsh-state")).toBe("UNKNOWN");
  });
});

// ===========================================================================
// 9. The Enterprise roll-up
// ===========================================================================

describe("the Enterprise roll-up", () => {
  function rollupHandler(over: Partial<Record<string, Handler>> = {}): Handler {
    return (path, method, body) => {
      for (const [prefix, h] of Object.entries(over)) {
        if (path.startsWith(prefix) && h) return h(path, method, body);
      }
      if (path.endsWith("/operations/rollup")) {
        return {
          organizationId: ORG,
          workspaces: [
            {
              workspaceId: WS,
              name: "Known WS",
              coverage: "KNOWN",
              summary: { open: 3, critical: 1, high: 1, warning: 1, info: 0, unassigned: 1, readiness: "READY", mayAssertAllClear: false, complete: true, incompleteReason: null },
            },
            {
              workspaceId: OTHER_WS,
              name: "Unknown WS",
              coverage: "UNKNOWN",
              summary: { open: null, critical: null, high: null, warning: null, info: null, unassigned: null, readiness: "NEVER_RUN", mayAssertAllClear: false, complete: false, incompleteReason: "SOURCE_FAILED" },
            },
            {
              workspaceId: "44444444-4444-4444-8444-444444444444",
              name: "Partial WS",
              coverage: "PARTIAL",
              summary: { open: 5000, critical: 7, high: 9, warning: 0, info: 0, unassigned: 10, readiness: "READY", mayAssertAllClear: false, complete: false, incompleteReason: "SCAN_BOUND_REACHED" },
            },
          ],
          totals: { open: 5003, critical: 8, high: 10, warning: 1, info: 0, unassigned: 11 },
          coverage: {
            workspacesInOrganization: 4,
            workspacesIncluded: 3,
            workspacesNotReadable: 1,
            workspacesUnknown: 1,
            workspacesPartial: 1,
            workspaceListTruncated: false,
            complete: false,
          },
        };
      }
      if (path.includes("/operations/incidents")) {
        return { incidents: [], pagination: { nextCursor: null } };
      }
      if (path.endsWith("/workspaces")) return { organizationId: ORG, summary: { totalWorkspaces: 0 }, workspaces: [] };
      return {};
    };
  }

  it("UNKNOWN is Unavailable (never 0), PARTIAL is 'at least N', and the totals say they are incomplete", async () => {
    routeParams.value = { id: ORG };
    handler = rollupHandler();
    await mount(
      <OrganizationAdminReadinessPage />,
      envelope(TEAM_ADMIN, WS, "Northgate Team", { isEnterpriseWorkspace: true }),
    );
    await settle();
    const unknown = q(`[data-rollup-workspace="${OTHER_WS}"]`) as HTMLElement;
    expect(unknown.getAttribute("data-rollup-coverage")).toBe("UNKNOWN");
    expect(unknown.textContent).toContain(EN.rollup.workspaceUnavailable);
    expect(unknown.textContent).not.toMatch(/\b0 unresolved/);
    const partial = q('[data-rollup-workspace="44444444-4444-4444-8444-444444444444"]') as HTMLElement;
    expect(partial.textContent).toContain("at least 5,000 unresolved");
    const totals = q("[data-rollup-totals]")?.textContent ?? "";
    // Readable workspaces only (the unknown one is not among them), and the
    // unavailable ones are counted: 1 unknown + 1 not readable.
    expect(totals).toContain("5,003 unresolved across 2 workspaces");
    expect(totals).toContain("2 unavailable");
    const partialNote = q("[data-rollup-partial]")?.textContent ?? "";
    expect(partialNote).toContain(EN.rollup.incompleteLead);
    expect(partialNote).toContain("1 not readable by you");
    expect(partialNote).toContain("1 could not be read");
    expect(partialNote).toContain("1 counted as a minimum");
  });

  it("an invalid cursor reloads the list from the start and says so", async () => {
    routeParams.value = { id: ORG };
    let call = 0;
    handler = rollupHandler({
      [`/v1/orgs/${ORG}/operations/incidents`]: (path) => {
        call += 1;
        if (path.includes("cursor=")) {
          return Object.assign(new Error("bad cursor"), {
            code: "invalid_cursor",
            statusCode: 400,
            body: { error: { code: "invalid_cursor" } },
          });
        }
        return {
          incidents: [
            { id: `row-${call}`, title: `Row ${call}`, severity: "HIGH", status: "OPEN", lastSeenAtUtc: HOURS_AGO(1), workspaceId: WS, workspaceName: "Known WS" },
          ],
          pagination: { nextCursor: "stale-cursor" },
        };
      },
    });
    await mount(
      <OrganizationAdminReadinessPage />,
      envelope(TEAM_ADMIN, WS, "Northgate Team", { isEnterpriseWorkspace: true }),
    );
    await settle();
    // The default read is the canonical unresolved set.
    const first = gets().find((p) => p.includes("/operations/incidents"));
    expect(first).toMatch(/status=UNRESOLVED/);
    await act(async () => {
      fireEvent.click(q("[data-rollup-more]") as HTMLElement);
    });
    await settle();
    expect(q("[data-rollup-notice]")?.textContent).toBe(EN.rollup.cursorReset);
    expect(q("[data-rollup-incidents-error]")).toBeNull();
    // The list was reloaded from the start (no cursor on the last read).
    const last = gets().filter((p) => p.includes("/operations/incidents")).at(-1)!;
    expect(last).not.toMatch(/cursor=/);
  });
});

// ===========================================================================
// 10. The grouped default view: sections, and a drill-down in its own context
// ===========================================================================

describe("the grouped default view", () => {
  it("one source in Action required AND Resolved opens the group from the section clicked, and drills down in that section's status", async () => {
    handler = defaultHandler({
      "/v1/ops/incident-groups?": (path) =>
        path.includes("resolvedWithinDays=7")
          ? {
              groups: [group("shared.source", { statusPosture: "RESOLVED", title: "Resolved twin", conditionCount: 1 })],
              totals: { groups: 1, conditions: 1 },
              completeness: { complete: true },
            }
          : {
              groups: [
                group("shared.source", { statusPosture: "OPEN", title: "Unresolved twin" }),
                group("watched.source", { statusPosture: "SUPPRESSED", title: "Watched" }),
              ],
              totals: { groups: 2, conditions: 4 },
              completeness: { complete: true },
            },
    });
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    const action = q('[data-ops-section="action-required"]') as HTMLElement;
    const monitoring = q('[data-ops-section="monitoring"]') as HTMLElement;
    const resolved = q('[data-ops-section="recently-resolved"]') as HTMLElement;
    // Section titles are headings.
    for (const section of [action, monitoring, resolved]) {
      expect(section.querySelector("h2")).not.toBeNull();
    }
    expect(action.querySelector('[data-ops-group="shared.source"]')).not.toBeNull();
    expect(monitoring.querySelector('[data-ops-group="watched.source"]')).not.toBeNull();
    expect(monitoring.querySelector('[data-ops-group="shared.source"]')).toBeNull();

    // Open it from the RESOLVED section.
    await act(async () => {
      fireEvent.click(resolved.querySelector('[data-ops-group-open-button="shared.source"]') as HTMLElement);
    });
    await settle();
    expect(q("[data-ops-group-inspector]")?.textContent).toContain("Resolved twin");
    let drill = gets().filter((p) => p.includes("/affected")).at(-1)!;
    expect(drill).toMatch(/status=RESOLVED/);

    // ...and from Action required: the unresolved group, read UNRESOLVED.
    await act(async () => {
      fireEvent.click(q('[data-ops-group-inspector-overlay]') as HTMLElement);
    });
    await act(async () => {
      fireEvent.click(action.querySelector('[data-ops-group-open-button="shared.source"]') as HTMLElement);
    });
    await settle();
    expect(q("[data-ops-group-inspector]")?.textContent).toContain("Unresolved twin");
    drill = gets().filter((p) => p.includes("/affected")).at(-1)!;
    expect(drill).toMatch(/status=UNRESOLVED/);
  });

  it("the sort control is not offered where it cannot apply, so it cannot hide the sections", async () => {
    currentSearch = "sort=oldest";
    handler = defaultHandler({
      "/v1/ops/incident-groups?": (path) =>
        path.includes("resolvedWithinDays")
          ? { groups: [], totals: { groups: 0, conditions: 0 }, completeness: { complete: true } }
          : { groups: [group("a.source")], totals: { groups: 1, conditions: 2 }, completeness: { complete: true } },
    });
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    // Grouped (default): no sort control, and the sections still render.
    expect(q("[data-ops-sort]")).toBeNull();
    expect(q('[data-ops-section="action-required"]')).not.toBeNull();
    await act(async () => {
      fireEvent.click(q('[data-ops-view="flat"]') as HTMLElement);
    });
    await settle();
    expect(q("[data-ops-sort]")).not.toBeNull();
  });
});

// ===========================================================================
// 11. "All, including resolved" is a view like any other
// ===========================================================================

describe("a saved view may hold ALL statuses", () => {
  it("is saved with status ALL and replays as ALL", async () => {
    currentSearch = "status=ALL&severity=CRITICAL";
    handler = defaultHandler({
      "/v1/ops/saved-views": (_p, method) =>
        method === "GET"
          ? {
              views: [
                {
                  id: "v-all",
                  name: "Everything critical",
                  description: null,
                  visibility: "PRIVATE",
                  pinned: false,
                  createdByUserId: ME,
                  ownedByViewer: true,
                  createdAt: HOURS_AGO(2),
                  updatedAt: HOURS_AGO(2),
                  filter: { teamId: WS, status: "ALL", severity: "CRITICAL" },
                },
              ],
            }
          : { ok: true },
    });
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    // Saving is OFFERED (no longer blocked for ALL)...
    const start = q("[data-ops-view-start-save]") as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(start);
    });
    await act(async () => {
      fireEvent.change(q("[data-ops-view-name]") as HTMLInputElement, { target: { value: "All critical" } });
    });
    await act(async () => {
      fireEvent.click(q("[data-ops-view-save]") as HTMLElement);
    });
    await settle();
    const save = posts().find((p) => p.path === "/v1/ops/saved-views")!;
    expect((JSON.parse(save.body as string) as { filter: Record<string, string> }).filter).toMatchObject({
      status: "ALL",
      severity: "CRITICAL",
    });

    // ...and a stored ALL view replays as ALL, history included.
    currentSearch = "";
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q('[data-ops-saved-view="v-all"]') as HTMLElement);
    });
    await settle();
    expect(replaced.at(-1)).toContain("status=ALL");
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    expect(lastList()).toMatch(/status=ALL/);
  });
});

// ===========================================================================
// 12. German and Arabic reach the drawer, the group row and relative time
// ===========================================================================

describe("the remaining Operations text is localized", () => {
  it("German drawer facts, SLA explanation and relative time", async () => {
    localeState.locale = "de";
    try {
      handler = defaultHandler({
        "/v1/ops/incidents?": () =>
          listOf([
            incident("i-de", {
              lastSeenAtUtc: new Date(Date.now() - 2 * 3600_000).toISOString(),
              sla: {
                posture: "BREACHED",
                obligation: "ACKNOWLEDGEMENT",
                dueAtUtc: HOURS_AGO(1),
                targetHours: 4,
                policyVersionId: null,
                cycleNumber: 1,
                acknowledgementBreached: true,
                resolutionBreached: false,
              },
            }),
          ]),
      });
      await mount(<OperationsPage />, envelope(TEAM_ADMIN));
      await act(async () => {
        fireEvent.click(q('[data-ops-view="flat"]') as HTMLElement);
      });
      await settle();
      expect(q("[data-ops-table-surface]")?.textContent).toContain("vor 2 Std.");
      await act(async () => {
        fireEvent.click(q('[data-ops-open="i-de"]') as HTMLElement);
      });
      await settle();
      const drawer = q("[data-ops-inspector]")?.textContent ?? "";
      const DE = operationsDict.de;
      expect(drawer).toContain(DE.drawer.factFirstSeen);
      expect(drawer).toContain(DE.drawer.factTimeCommitment);
      expect(drawer).toContain(DE.slaExplain.breachedAck);
      expect(drawer).toContain(DE.slaExplain.promiseAck.replace("{hours}", "4 Stunden"));
      expect(drawer).not.toContain("First seen");
      expect(drawer).not.toContain("Past the time");
    } finally {
      localeState.locale = "en";
    }
  });

  it("Arabic group row phrases", async () => {
    localeState.locale = "ar";
    try {
      handler = defaultHandler({
        "/v1/ops/incident-groups?": (path) =>
          path.includes("resolvedWithinDays")
            ? { groups: [], totals: { groups: 0, conditions: 0 }, completeness: { complete: true } }
            : {
                groups: [group("ar.source", { affectedRecordCount: 26, affectedUnit: "records", assignedCount: 2 })],
                totals: { groups: 1, conditions: 2 },
                completeness: { complete: true },
              },
      });
      await mount(<OperationsPage />, envelope(TEAM_ADMIN));
      const row = q('[data-ops-group="ar.source"]')?.textContent ?? "";
      const AR = operationsDict.ar;
      expect(row).toContain(AR.group.affected.records.replace("{n}", new Intl.NumberFormat("ar").format(26)));
      expect(row).not.toContain("affected records");
      expect(row).not.toContain("last seen");
      expect(row).not.toContain("owned");
    } finally {
      localeState.locale = "en";
    }
  });
});

// ===========================================================================
// 13. `?incidentId=` is a legacy alias for `?incident=`
// ===========================================================================

describe("a legacy ?incidentId= link opens the drawer", () => {
  const ID = "55555555-5555-4555-8555-555555555555";

  it("opens the condition, normalises the address, and drops the alias on close", async () => {
    currentSearch = `severity=HIGH&incidentId=${ID}`;
    await mount(<OperationsPage />, envelope(TEAM_ADMIN));
    await settle();
    // The drawer's own detail read was issued for that id...
    expect(gets().some((p) => p.startsWith(`/v1/ops/incidents/${ID}?`))).toBe(true);
    expect(q(`[data-ops-inspector="${ID}"]`)).not.toBeNull();
    // ...the URL now names it the canonical way, filters untouched...
    const normalised = replaced.find((h) => h.includes(`incident=${ID}`));
    expect(normalised).toBeTruthy();
    expect(normalised).not.toContain("incidentId");
    expect(normalised).toContain("severity=HIGH");
    // ...and the alias is never read as a filter.
    expect(lastList()).not.toContain("incidentId");

    // Closing the drawer leaves neither spelling behind.
    currentSearch = `severity=HIGH&incidentId=${ID}`;
    await act(async () => {
      fireEvent.click(q(`[data-ops-inspector] [aria-label="${EN.closeCondition}"]`) as HTMLElement);
    });
    await settle();
    const last = replaced.at(-1)!;
    expect(last).not.toContain("incidentId");
    expect(last).not.toContain("incident=");
    expect(last).toContain("severity=HIGH");
  });
});
