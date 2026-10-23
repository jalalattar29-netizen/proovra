/**
 * /operations — ONE STATUS, rendered the same in both presentations, and a
 * Refresh that really re-checks (2026-10-14).
 *
 * Production: a TEAM owner's Personal Space, `/operations?view=grouped`,
 * showed the large "No conditions were returned, but this workspace's status
 * is unconfirmed" panel directly above three RESOLVED groups, and its Refresh
 * button changed nothing visible. The summary was STALE (the scheduler only
 * reached a workspace after its picture had expired), the page had no STALE
 * state so it fell through to the generic unconfirmed panel, and that panel's
 * Refresh re-read the same stale run instead of asking for a new check.
 *
 * Each case mounts the REAL page against contract-shaped replies:
 *   1. resolved-only + confirmed → the resolved groups, no panel, no onboarding;
 *   2. resolved-only + STALE → a compact stale notice with the last complete
 *      check, the resolved groups, no panel, no all-clear;
 *   3. empty + confirmed → the first-use panel (and only then);
 *   4. resolved + PARTIAL → named unseen sources, data kept;
 *   5. request failures → a load error, never an empty-state lie;
 *   6. Refresh / Check again → a real check (POST + re-read), busy while
 *      pending, one request for a double click, the new state rendered,
 *      failure shown;
 *   7. flat and grouped render the same status;
 *   8. a late response from the previous workspace never paints.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";

import { operationsDict } from "@proovra/shared/i18n";

type Handler = (path: string, method: string, body?: string) => unknown;

let requestLog: Array<{ path: string; method: string; body?: string }> = [];
let handler: Handler = () => ({});
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
    push: (href: string) => {
      currentSearch = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
    },
    replace: (href: string) => {
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

import { PlatformContextProvider, usePlatformContext } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import OperationsPage from "../../app/(app)/operations/page";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const HOURS_AGO = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const EN = operationsDict.en;

function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function incident(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    category: "REPORT",
    severity: "CRITICAL",
    status: "RESOLVED",
    title: `Condition ${id}`,
    safeSummary: "A report could not be generated.",
    fingerprint: `report_failure:${id}`,
    occurrenceCount: 1,
    firstSeenAtUtc: HOURS_AGO(120),
    lastSeenAtUtc: HOURS_AGO(100),
    requestId: null,
    traceId: null,
    relatedEvidenceId: null,
    relatedJobId: null,
    relatedProvider: null,
    runbookSlug: null,
    acknowledgedByUserId: null,
    resolvedByUserId: ME,
    assignedOperatorUserId: null,
    assignedAtUtc: null,
    acknowledgedAtUtc: null,
    resolvedAtUtc: HOURS_AGO(96),
    metric: null,
    ...over,
  };
}

/** The production shape: three sources whose conditions closed four days ago. */
const RESOLVED_GROUPS = [
  { groupKey: "pipeline.report_generation_failed", title: "Report generation failed", severity: "CRITICAL", category: "REPORT", conditionCount: 2 },
  { groupKey: "billing.dependent_cancellation_failed", title: "Storage add-on still billing after cancellation", severity: "HIGH", category: "STORAGE", conditionCount: 1 },
  { groupKey: "intake.delivery_failed", title: "Uploads could not be started or resumed", severity: "WARNING", category: "UPLOAD", conditionCount: 1 },
].map((g) => ({
  sourceId: g.groupKey,
  affectedRecordCount: g.conditionCount,
  affectedUnit: "records",
  observations: 1,
  durationSeconds: null,
  lastObservedAtUtc: null,
  statusPosture: "RESOLVED",
  firstSeenAtUtc: HOURS_AGO(120),
  lastSeenAtUtc: HOURS_AGO(100),
  latestActivityAtUtc: HOURS_AGO(96),
  latestResolvedAtUtc: HOURS_AGO(96),
  assignedCount: 0,
  failureGroups: [],
  affectedSample: [],
  hasMoreAffected: false,
  availableActions: [],
  metric: null,
  ...g,
}));

type State = "CONFIRMED_CLEAR" | "STALE" | "PARTIAL" | "ACTIVE_CONDITIONS";

/** A summary as the server now produces it: the counts, the run, and the ONE status. */
function summaryFor(state: State, opts: { resolved?: number; open?: number; workspaceId?: string } = {}) {
  const resolved = opts.resolved ?? 4;
  const open = opts.open ?? 0;
  const readiness = state === "CONFIRMED_CLEAR" || state === "ACTIVE_CONDITIONS" ? "READY" : state;
  const failed = state === "PARTIAL" ? ["evidence_integrity.tsa_failed"] : [];
  const lastCheck = state === "STALE" ? HOURS_AGO(3) : HOURS_AGO(0.1);
  return {
    summary: {
      workspaceId: opts.workspaceId ?? WS,
      generatedAtUtc: new Date(NOW).toISOString(),
      open,
      critical: 0,
      high: 0,
      warning: open,
      info: 0,
      acknowledged: 0,
      assignedToMe: 0,
      unassigned: open,
      slaBreached: 0,
      slaAtRisk: 0,
      slaOnTrack: 0,
      slaUntracked: open,
      resolved,
      complete: true,
      mayAssertAllClear: state === "CONFIRMED_CLEAR",
      incompleteReason: null,
      readiness,
      clearRefusalReason:
        state === "CONFIRMED_CLEAR" ? null : state === "PARTIAL" ? "PARTIAL_SOURCES" : state === "STALE" ? "STALE" : "UNRESOLVED_CONDITIONS",
      reconciliation: {
        readiness,
        startedAtUtc: lastCheck,
        completedAtUtc: lastCheck,
        leaseExpiresAtUtc: null,
        sourceSnapshotAtUtc: lastCheck,
        sources: {
          requiredSources: ["evidence_integrity.tsa_failed"],
          attemptedSources: ["evidence_integrity.tsa_failed"],
          successfulSources: failed.length ? [] : ["evidence_integrity.tsa_failed"],
          failedSources: failed,
          truncatedSources: [],
          continuationScheduled: false,
          sourceFailures: failed.map((sourceId) => ({ sourceId, stage: "SCAN", category: "timeout", retryable: true })),
        },
        safeFailureCategory: null,
        recorded: 0,
      },
      status: {
        state,
        reason: state === "CONFIRMED_CLEAR" ? null : state === "PARTIAL" ? "PARTIAL_SOURCES" : state === "STALE" ? "STALE" : null,
        checkedAtUtc: new Date(NOW).toISOString(),
        lastCheckAtUtc: lastCheck,
        lastCompleteCheckAtUtc: state === "PARTIAL" ? null : lastCheck,
        freshness: state === "STALE" ? "STALE" : "FRESH",
        failedSourceIds: failed,
        truncatedSourceIds: [],
        activeCount: open,
        resolvedCount: resolved,
      },
    },
    workspace: { operatorCount: 1 },
  };
}

function envelope(ws = WS, name = "Personal Space") {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {
      OPERATIONS_VIEW: true,
      OPERATIONS_ACKNOWLEDGE: true,
      OPERATIONS_RESOLVE: true,
      OPERATIONS_SUPPRESS: true,
      OPERATIONS_ASSIGN: true,
      OPERATIONS_SAVED_VIEWS_MANAGE: true,
    },
    diagnostics: { requestId: "test" },
    workspace: { id: ws, name, status: "active", scope: "PERSONAL" },
    activeSpace: { type: "PERSONAL", id: ws, displayName: name, roleLabel: "Owner" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: ws, kind: "PERSONAL", organizationId: null, displayName: name },
    },
    account: { userId: ME, accountPlan: "TEAM", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
  };
}

type Replies = {
  summary?: () => unknown;
  list?: () => unknown;
  resolvedGroups?: () => unknown;
  reconcile?: () => unknown;
};

function routes(r: Replies = {}): Handler {
  return (path, method) => {
    if (path === "/v1/platform/context/switch-workspace") return envelope(OTHER_WS, "Second workspace");
    if (path.startsWith("/v1/ops/summary")) return (r.summary ?? (() => summaryFor("CONFIRMED_CLEAR")))();
    if (path.startsWith("/v1/ops/incident-groups?")) {
      if (/[?&]status=RESOLVED(&|$)/.test(path)) {
        return (r.resolvedGroups ?? (() => ({ groups: RESOLVED_GROUPS, totals: { groups: 3, conditions: 4 }, completeness: { complete: true } })))();
      }
      return { groups: [], totals: { groups: 0, conditions: 0 }, completeness: { complete: true } };
    }
    if (path.startsWith("/v1/ops/saved-views")) return { views: [] };
    if (path.startsWith("/v1/ops/assignable-operators")) return { operators: [], selfUserId: ME };
    if (method === "GET" && path.startsWith("/v1/ops/incidents?")) {
      return (r.list ??
        (() => ({
          incidents: [incident("r-1"), incident("r-2"), incident("r-3", { severity: "HIGH", category: "STORAGE" }), incident("r-4", { severity: "WARNING", category: "UPLOAD" })],
          pagination: { nextCursor: null },
          completeness: { complete: true, mayAssertAllClear: true },
        })))();
    }
    if (method === "POST" && path === "/v1/ops/workspace-reconcile") {
      return (r.reconcile ?? (() => ({ started: true, ran: true, alreadyRunning: false, refusedReason: null, retryable: true, readiness: "READY" })))();
    }
    return { ok: true };
  };
}

let switchTo: ((id: string | null) => Promise<void>) | null = null;
function SwitchProbe() {
  const ctx = usePlatformContext() as unknown as { switchWorkspace: (id: string | null) => Promise<void> };
  switchTo = ctx.switchWorkspace;
  return null;
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function mount(search = "") {
  cleanup();
  currentSearch = search;
  const utils = render(
    <PlatformContextProvider testEnvelope={envelope() as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <SwitchProbe />
          <OperationsPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
  return utils;
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
const posts = (path: string) => requestLog.filter((r) => r.method === "POST" && r.path === path);
const summaryReads = () => requestLog.filter((r) => r.method === "GET" && r.path.startsWith("/v1/ops/summary"));
const resolvedGroupKeys = () =>
  qa('[data-ops-section="recently-resolved"] [data-ops-group]').map((el) => el.getAttribute("data-ops-group"));
/** The large panel: the one thing a resolved-history workspace must never show. */
const bigUnconfirmedPanel = () => q('.app-empty[data-ops-empty="unconfirmed"]');

function expectNoOnboarding() {
  expect(q('[data-ops-empty="clear"]')).toBeNull();
  expect(document.body.textContent).not.toContain(EN.clearTitle);
  expect(document.body.textContent).not.toContain(EN.clearEvidenceLink);
}

beforeEach(() => {
  requestLog = [];
  currentSearch = "";
  switchTo = null;
  handler = routes();
});

describe("1. the reproduced TEAM Owner case — resolved-only, confirmed", () => {
  it("grouped: the three resolved groups render; no unconfirmed panel; no first-use state", async () => {
    await mount("view=grouped");
    expect(resolvedGroupKeys()).toEqual(RESOLVED_GROUPS.map((g) => g.groupKey));
    expect(q('[data-ops-empty="unconfirmed"]')).toBeNull();
    expect(document.body.textContent).not.toContain(EN.unconfirmedTitle);
    expectNoOnboarding();
    // One compact, non-dominant line — never a panel.
    expect(q("[data-ops-quiet-clear]")?.closest(".app-empty")).toBeNull();
    expect(q("[data-ops-stale]")).toBeNull();
  });

  it("flat: the resolved rows render under the same status", async () => {
    await mount();
    expect(qa("[data-ops-row]")).toHaveLength(4);
    expect(q('[data-ops-empty="unconfirmed"]')).toBeNull();
    expectNoOnboarding();
  });
});

describe("2. resolved-only but STALE — stated, compact, never an all-clear", () => {
  it("grouped: a stale notice with the last complete check; resolved groups stay primary; no panel", async () => {
    handler = routes({ summary: () => summaryFor("STALE") });
    await mount("view=grouped");
    const notice = q("[data-ops-stale]");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain(EN.statusStaleTitle);
    expect(q("[data-ops-stale-detail]")?.textContent).toContain("Last complete check:");
    expect(resolvedGroupKeys()).toHaveLength(3);
    expect(bigUnconfirmedPanel()).toBeNull();
    expect(document.body.textContent).not.toContain(EN.unconfirmedTitle);
    // Never the all-clear line, never onboarding.
    expect(q("[data-ops-quiet-clear]")).toBeNull();
    expectNoOnboarding();
    // One re-check control, not two.
    expect(qa("[data-ops-check-now]")).toHaveLength(1);
  });

  it("flat: the same stale notice — the presentation never changes the status", async () => {
    handler = routes({ summary: () => summaryFor("STALE") });
    await mount();
    expect(q("[data-ops-stale]")).not.toBeNull();
    expect(qa("[data-ops-row]")).toHaveLength(4);
    expect(bigUnconfirmedPanel()).toBeNull();
  });
});

describe("3. truly empty and confirmed — the only first-use state", () => {
  it("renders the first-use panel", async () => {
    handler = routes({
      summary: () => summaryFor("CONFIRMED_CLEAR", { resolved: 0 }),
      resolvedGroups: () => ({ groups: [], totals: { groups: 0, conditions: 0 }, completeness: { complete: true } }),
      list: () => ({ incidents: [], pagination: { nextCursor: null }, completeness: { complete: true, mayAssertAllClear: true } }),
    });
    await mount("view=grouped");
    expect(q('[data-ops-empty="clear"]')).not.toBeNull();
    expect(q('[data-ops-empty="unconfirmed"]')).toBeNull();
  });

  it("empty but STALE never earns the first-use panel", async () => {
    handler = routes({
      summary: () => summaryFor("STALE", { resolved: 0 }),
      resolvedGroups: () => ({ groups: [], totals: { groups: 0, conditions: 0 }, completeness: { complete: true } }),
      list: () => ({ incidents: [], pagination: { nextCursor: null }, completeness: { complete: true, mayAssertAllClear: true } }),
    });
    await mount();
    expect(q('[data-ops-empty="clear"]')).toBeNull();
    expect(q("[data-ops-stale]")).not.toBeNull();
    expect(bigUnconfirmedPanel()).toBeNull();
  });
});

describe("4. PARTIAL with resolved history — named sources, data kept", () => {
  it("names the unseen source and keeps the resolved groups", async () => {
    handler = routes({ summary: () => summaryFor("PARTIAL") });
    await mount("view=grouped");
    const partial = q("[data-ops-partial]");
    expect(partial).not.toBeNull();
    const names = q("[data-ops-partial-sources]")?.textContent ?? "";
    expect(names).toContain("Not checked:");
    expect(names).not.toMatch(/evidence_integrity|tsa_failed/);
    expect(resolvedGroupKeys()).toHaveLength(3);
    expect(q("[data-ops-quiet-clear]")).toBeNull();
    expect(bigUnconfirmedPanel()).toBeNull();
  });
});

describe("5. request failures — a load error, never an empty-state lie", () => {
  it("a failed summary degrades; a failed list is unavailable; nothing says clear", async () => {
    handler = (path, method, body) => {
      if (path.startsWith("/v1/ops/summary")) return new Error("summary down");
      if (path.startsWith("/v1/ops/incidents?")) return new Error("list down");
      return routes()(path, method, body);
    };
    await mount();
    expect(q("[data-ops-degraded]")).not.toBeNull();
    expect(q("[data-ops-unavailable]")).not.toBeNull();
    expectNoOnboarding();
    expect(q("[data-ops-quiet-clear]")).toBeNull();
  });
});

describe("6. Refresh — a real check, observable, single-flight", () => {
  it("POSTs a check, shows busy and refuses a second press, then renders the new state", async () => {
    let state: State = "STALE";
    const check = deferred();
    handler = routes({ summary: () => summaryFor(state), reconcile: () => check.promise });
    await mount("view=grouped");
    const button = q("[data-ops-check-now]") as HTMLButtonElement;
    expect(button).not.toBeNull();
    const readsBefore = summaryReads().length;

    await click(button);
    expect(posts("/v1/ops/workspace-reconcile")).toHaveLength(1);
    expect(JSON.parse(posts("/v1/ops/workspace-reconcile")[0]!.body!)).toEqual({ teamId: WS, explicit: true });
    // Busy, and a second press sends nothing.
    const busy = q("[data-ops-check-now]") as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.textContent).toBe(EN.refreshing);
    await click(busy);
    expect(posts("/v1/ops/workspace-reconcile")).toHaveLength(1);
    expect(q('[data-ops-refresh]')?.hasAttribute("disabled")).toBe(true);

    // The check finishes and the workspace is now confirmed.
    state = "CONFIRMED_CLEAR";
    await act(async () => {
      check.resolve({ started: true, ran: true, alreadyRunning: false, refusedReason: null, retryable: true, readiness: "READY" });
    });
    await settle(10);
    expect(summaryReads().length).toBeGreaterThan(readsBefore);
    expect(q("[data-ops-stale]")).toBeNull();
    expect(q("[data-ops-quiet-clear]")).not.toBeNull();
    expect(resolvedGroupKeys()).toHaveLength(3);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(q("[data-ops-live]")?.textContent).toBe(EN.checkFinished);
  });

  it("a failed check is shown, and the button comes back", async () => {
    handler = routes({ summary: () => summaryFor("STALE"), reconcile: () => new Error("network down") });
    await mount("view=grouped");
    await click(q("[data-ops-check-now]"));
    await settle(10);
    expect(q("[data-ops-mutation-error]")).not.toBeNull();
    const again = q("[data-ops-check-now]") as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    // Still not an all-clear.
    expect(q("[data-ops-stale]")).not.toBeNull();
  });

  it("the header Refresh runs the same check in either view", async () => {
    handler = routes({ summary: () => summaryFor("STALE") });
    await mount();
    await click(q("[data-ops-refresh]"));
    expect(posts("/v1/ops/workspace-reconcile")).toHaveLength(1);
    await click(q('[data-ops-view="grouped"]'));
    await click(q("[data-ops-refresh]"));
    expect(posts("/v1/ops/workspace-reconcile")).toHaveLength(2);
  });
});

describe("7. flat and grouped share one truth", () => {
  for (const state of ["CONFIRMED_CLEAR", "STALE", "PARTIAL"] as const) {
    it(`${state}: switching views never changes the status shown`, async () => {
      handler = routes({ summary: () => summaryFor(state) });
      await mount();
      const read = () => ({
        stale: q("[data-ops-stale]") !== null,
        partial: q("[data-ops-partial]") !== null,
        panel: bigUnconfirmedPanel() !== null,
        onboarding: q('[data-ops-empty="clear"]') !== null,
      });
      const flat = read();
      await click(q('[data-ops-view="grouped"]'));
      const grouped = read();
      await click(q('[data-ops-view="flat"]'));
      expect(grouped).toEqual(flat);
      expect(read()).toEqual(flat);
      expect(flat.panel).toBe(false);
      expect(flat.onboarding).toBe(false);
    });
  }
});

describe("8. a late response from the previous workspace never paints", () => {
  it("A's slow STALE summary arrives after the switch to B and is discarded", async () => {
    const slowA = deferred();
    handler = (path, method, body) => {
      if (path.startsWith("/v1/ops/summary") && path.includes(WS)) return slowA.promise;
      if (path.startsWith("/v1/ops/summary")) return summaryFor("CONFIRMED_CLEAR", { workspaceId: OTHER_WS });
      return routes()(path, method, body);
    };
    await mount("view=grouped");
    await act(async () => {
      await switchTo!(OTHER_WS);
    });
    await settle(10);
    expect(q("[data-ops-quiet-clear]")).not.toBeNull();
    await act(async () => {
      slowA.resolve(summaryFor("STALE"));
    });
    await settle(10);
    expect(q("[data-ops-stale]")).toBeNull();
    expect(q("[data-ops-quiet-clear]")).not.toBeNull();
  });
});
