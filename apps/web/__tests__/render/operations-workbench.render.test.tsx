/**
 * /operations — the workbench, driven for real.
 *
 * Source text cannot prove that a summary card filters the queue, that a
 * read-only viewer is offered nothing to press, that a failed source stops the
 * page saying "clear", or that the desktop row and the narrow card say the
 * same thing about the same condition. This file mounts the REAL page against
 * contract-shaped fixtures and asserts the behaviour.
 *
 * The properties under test:
 *   - the tenant page reads NO platform runtime, and a caller without the
 *     capability causes ZERO Operations requests at all;
 *   - one <h1>, one header, no hub bar, no platform link;
 *   - density is capability- and operator-count-driven: Personal Pro loses the
 *     ownership axis entirely, a shared workspace gains it, and a VIEWER in a
 *     shared workspace keeps the axis while losing every mutation;
 *   - every filter is a SERVER filter — the query the page sends is the query
 *     the operator asked for, and pagination resets with it;
 *   - "Workspace operations are clear" is unreachable over a filtered,
 *     truncated or failed read;
 *   - the inspector opens, loads its own history, survives that history
 *     failing, and returns focus on close;
 *   - acknowledge / resolve / suppress / assign hit the canonical routes, once;
 *   - a response for a workspace the operator has left is discarded.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  within,
  act,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import {
  OPERATIONS_TONE,
  QUEUE_METRIC_ORDER,
  QUEUE_METRIC_VOCABULARY,
  SEVERITY_TONE_STRENGTH,
  SEVERITY_VOCABULARY,
  STATUS_VOCABULARY,
  slaTone,
} from "../../app/(app)/operations/_lib/vocabulary";
// The SLA fixture below is typed against the PAGE'S OWN contract rather than
// shaped by hand. A hand-written block drifts from the server projection
// silently; borrowing the real type means a change to the contract breaks the
// fixture at COMPILE time, which is where it should break.
import type {
  IncidentGroup,
  IncidentSla,
} from "../../app/(app)/operations/_lib/types";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type Reply = Record<string, unknown> | Error | null;

let requestLog: Array<{ path: string; method: string; body?: string }> = [];
let summaryReply: () => Reply = () => ({});
let incidentsReply: (path: string) => Reply = () => ({});
let detailReply: () => Reply = () => ({});
let operatorsReply: () => Reply = () => ({ operators: [], selfUserId: null });
let mutationReply: (path: string) => Reply = () => ({ ok: true });
/** The grouped queue, and one group's paged members. */
let groupsReply: () => Reply = () => ({
  groups: [],
  conservation: { conditions: 0, grouped: 0 },
  completeness: { complete: true, mayAssertAllClear: true },
});
let affectedReply: () => Reply = () => ({
  records: [],
  pagination: { nextCursor: null, returned: 0 },
});
let replaced: string[] = [];

/**
 * A rejection shaped exactly like the one `apiFetch` throws: a real Error
 * carrying `statusCode`. Built by a function rather than a class so it is not
 * in the temporal dead zone when Vitest hoists the `vi.mock` factory.
 */
function apiFailure(statusCode: number): Error {
  const err = new Error("request failed") as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/**
 * The same rejection, carrying the server's canonical error CODE.
 *
 * `apiFetch` puts `error.code` on the thrown Error, and the page branches on
 * that rather than on the status: 409 covers several different refusals and
 * only one of them is a notice about the condition itself.
 */
function apiCodeFailure(statusCode: number, code: string): Error {
  const err = apiFailure(statusCode) as Error & {
    statusCode: number;
    code: string;
  };
  err.code = code;
  return err;
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    requestLog.push({ path, method, body: init?.body });
    const pick = (r: Reply) => {
      if (r instanceof Error) throw r;
      return r;
    };
    if (path.startsWith("/v1/ops/summary")) return pick(summaryReply());
    if (path.includes("/v1/ops/incident-groups/") && path.includes("/affected")) {
      return pick(affectedReply());
    }
    if (path.startsWith("/v1/ops/incident-groups?")) return pick(groupsReply());
    if (path.startsWith("/v1/ops/assignable-operators")) {
      return pick(operatorsReply());
    }
    if (method === "GET" && /^\/v1\/ops\/incidents\/[^/?]+\?/.test(path)) {
      return pick(detailReply());
    }
    if (method === "GET" && path.startsWith("/v1/ops/incidents?")) {
      return pick(incidentsReply(path));
    }
    return pick(mutationReply(path));
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
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
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const COLLEAGUE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
const HOURS_AGO = (h: number) => new Date(NOW - h * 3600_000).toISOString();

type IncidentOver = {
  id: string;
  title?: string;
  severity?: string;
  status?: string;
  category?: string;
  owner?: string | null;
  firstSeenHoursAgo?: number;
  lastSeenHoursAgo?: number;
  occurrences?: number;
  evidenceId?: string | null;
  /**
   * The SOURCE contract the server projected for this condition.
   *
   * The default is `OPERATOR_DECISION`, because every pre-existing case in
   * this file is about the ACTION MACHINERY — does pressing Resolve reach the
   * server, does a 409 open the right dialog, does focus return — and those
   * cases need a row that offers the control. The cases that are about the
   * contract itself override it explicitly and by name.
   */
  lifecycle?: Partial<{
    sourceId: string;
    sourceMatch: string;
    resolutionAuthority: string;
    audience: string;
    cardinality: string;
    recoveryPolicy: string;
    manualResolution: boolean;
    /** NONE, AGGREGATE_THRESHOLD or AGE_THRESHOLD. What the number MEANS. */
    metricContract: string;
  }> | null;
  /** The live aggregate value, for the sources that carry one. */
  metric?: {
    currentValue: number;
    previousValue?: number | null;
    delta?: number | null;
    thresholdValue: number;
    criticalThresholdValue?: number | null;
    unit: string;
    observedAtUtc?: string;
    stale?: boolean;
    truncated?: boolean;
    affectedEntityType?: string | null;
  } | null;
};

function incident(over: IncidentOver) {
  return {
    lifecycle:
      over.lifecycle === null
        ? undefined
        : {
            sourceId: "intake.delivery_failed",
            sourceMatch: "CATEGORY_RESIDUAL",
            resolutionAuthority: "OPERATOR_DECISION",
            audience: "TENANT_ACTIONABLE",
            cardinality: "EVENT",
            recoveryPolicy: "OPERATOR_CLOSES",
            manualResolution: true,
            ...(over.lifecycle ?? {}),
          },
    metric: over.metric
      ? {
          previousValue: null,
          delta: null,
          criticalThresholdValue: null,
          observedAtUtc: HOURS_AGO(0.1),
          stale: false,
          truncated: false,
          affectedEntityType: null,
          ...over.metric,
        }
      : null,
    // Absent by default: most conditions carry no recorded promise, and a
    // fixture that always supplied one would hide the untracked case.
    sla: undefined as IncidentSla | undefined,
    id: over.id,
    category: over.category ?? "EVIDENCE_INTEGRITY",
    severity: over.severity ?? "HIGH",
    status: over.status ?? "OPEN",
    title: over.title ?? "Trusted timestamp failed",
    safeSummary: "The timestamp authority did not return a token.",
    fingerprint: `tsa_failure:${over.id}`,
    occurrenceCount: over.occurrences ?? 1,
    firstSeenAtUtc: HOURS_AGO(over.firstSeenHoursAgo ?? 2),
    lastSeenAtUtc: HOURS_AGO(over.lastSeenHoursAgo ?? 1),
    requestId: "req-0123456789abcdef",
    traceId: null,
    relatedEvidenceId:
      over.evidenceId === undefined
        ? "99999999-9999-4999-8999-999999999999"
        : over.evidenceId,
    relatedJobId: null,
    relatedProvider: "freetsa",
    runbookSlug: "tsa-failure",
    acknowledgedByUserId: null,
    resolvedByUserId: null,
    assignedOperatorUserId: over.owner ?? null,
    assignedAtUtc: over.owner ? HOURS_AGO(1) : null,
  };
}

function summary(over: Record<string, number | boolean | string | null> = {}) {
  return {
    summary: {
      workspaceId: WS,
      generatedAtUtc: new Date(NOW).toISOString(),
      open: 3,
      critical: 1,
      high: 2,
      warning: 0,
      info: 0,
      acknowledged: 0,
      assignedToMe: 1,
      unassigned: 2,
      overdue: 1,
      complete: true,
      mayAssertAllClear: true,
      incompleteReason: null,
      // WORKSPACE-SCOPE CONVERGENCE (§8/§16) — the reconciliation facts now
      // travel with the summary. The default is a fresh, complete READY run,
      // because every pre-existing case in this file describes a workspace
      // that HAS been checked; the new cases below override it to describe
      // the states that previously rendered as "clear".
      readiness: "READY",
      clearRefusalReason: null,
      reconciliation: {
        startedAtUtc: new Date(NOW - 60_000).toISOString(),
        completedAtUtc: new Date(NOW - 30_000).toISOString(),
        sources: {
          requiredSources: ["evidence_integrity.tsa_failed"],
          successfulSources: ["evidence_integrity.tsa_failed"],
          failedSources: [],
          truncatedSources: [],
        },
        safeFailureCategory: null,
      },
      ...over,
    },
    workspace: { operatorCount: (over.operatorCount as number) ?? 1 },
  };
}

function list(
  incidents: ReturnType<typeof incident>[],
  over: { complete?: boolean; nextCursor?: string | null } = {},
) {
  return {
    incidents,
    pagination: {
      nextCursor: over.nextCursor ?? null,
      returned: incidents.length,
    },
    completeness: {
      complete: over.complete ?? true,
      mayAssertAllClear: over.complete ?? true,
    },
  };
}

const THREE = [
  incident({ id: "i-crit", title: "Report generation failed", severity: "CRITICAL", category: "REPORT" }),
  incident({ id: "i-high", title: "Trusted timestamp failed", severity: "HIGH", owner: ME }),
  incident({ id: "i-old", title: "Bitcoin anchoring stalled", severity: "WARNING", firstSeenHoursAgo: 100 }),
];

// ---------------------------------------------------------------------------
// Envelope — the ONLY thing that varies between workspace shapes
// ---------------------------------------------------------------------------

type Caps = Record<string, boolean>;

const PERSONAL_PRO: Caps = {
  OPERATIONS_VIEW: true,
  OPERATIONS_ACKNOWLEDGE: true,
  OPERATIONS_RESOLVE: true,
  OPERATIONS_SUPPRESS: true,
};
const TEAM_ADMIN: Caps = { ...PERSONAL_PRO, OPERATIONS_ASSIGN: true };
const VIEWER: Caps = { OPERATIONS_VIEW: true };
const FREE: Caps = {};

function envelope(capabilities: Caps, over: Record<string, unknown> = {}) {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities,
    diagnostics: { requestId: "test" },
    workspace: { id: WS, name: "Northgate Team", status: "active", scope: "TEAM" },
    activeSpace: {
      type: "TEAM",
      id: WS,
      displayName: "Northgate Team",
      roleLabel: "Admin",
    },
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
    ...over,
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Wait past the search box's real 250ms debounce, then settle.
 *
 * The one place in this suite that waits on a wall-clock delay, and it is
 * deliberate: the debounce is a product contract — the box types locally, the
 * URL is written once — so a test that mocked the clock away would no longer
 * be testing it.
 */
const SEARCH_DEBOUNCE_MS = 250;

async function settleDebounce() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 50));
  });
  await settle();
}

/** Flush a macrotask too — the deferred focus restore lands on one. */
async function settleTimers() {
  await settle();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * Mount the page.
 *
 * The grouped queue is the DEFAULT now, and the pre-existing cases in this
 * file are all about the FLAT surface — the table, the row menus, the
 * inspector. `view` lets a case say which surface it is about instead of
 * every one of them learning to press a toggle.
 */
async function mount(env: unknown, view: "grouped" | "flat" = "flat") {
  cleanup();
  const utils = render(
    <PlatformContextProvider testEnvelope={env as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <OperationsPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
  if (view === "flat") {
    const toggle = document.querySelector('[data-ops-view="flat"]');
    if (toggle) {
      await act(async () => {
        fireEvent.click(toggle as HTMLElement);
      });
      await settle();
    }
  }
  return utils;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => Array.from(document.querySelectorAll(sel));

/** Condition ids in the WIDE table, in render order. */
const rowIds = () =>
  qa("[data-ops-row]").map((el) => el.getAttribute("data-ops-row") as string);
/** Condition ids in the NARROW card list, in render order. */
const cardIds = () =>
  qa("[data-ops-card]").map((el) => el.getAttribute("data-ops-card") as string);

const metric = (key: string) =>
  q(`[data-ops-metric="${key}"]`) as HTMLButtonElement | null;

/**
 * The WIDE table, scoped so its narrow-card twin cannot answer for it.
 *
 * jsdom applies no stylesheet, so both renderers are in the document at once
 * — the route's own CSS is what puts exactly one of them in the layout and in
 * the accessibility tree. A reader that queries the whole document therefore
 * sees every fact twice, which is a property of the harness and not of the
 * page.
 */
function table() {
  const el = q("[data-ops-table-surface]");
  if (!el) throw new Error("no table rendered");
  return el as HTMLElement;
}
const tableOwners = () =>
  Array.from(table().querySelectorAll("[data-ops-owner]"));

const gets = () =>
  requestLog.filter((r) => r.method === "GET").map((r) => r.path);
const posts = () => requestLog.filter((r) => r.method === "POST");
/** The most recent list read, which is the one the queue is showing. */
const lastListQuery = () =>
  gets()
    .filter((p) => p.startsWith("/v1/ops/incidents?"))
    .at(-1) ?? "";

beforeEach(() => {
  requestLog = [];
  replaced = [];
  currentSearch = "";
  summaryReply = () => summary();
  incidentsReply = () => list(THREE);
  detailReply = () => ({
    incident: {
      ...THREE[1],
      timeline: [
        {
          id: "e1",
          eventType: "occurrence",
          safeMessage: "The condition was observed again.",
          occurredAtUtc: HOURS_AGO(1),
        },
        {
          id: "e2",
          eventType: "opened",
          safeMessage: "The condition was opened.",
          occurredAtUtc: HOURS_AGO(2),
        },
      ],
      timelineComplete: true,
    },
  });
  operatorsReply = () => ({ operators: [], selfUserId: ME });
  mutationReply = () => ({ ok: true });
});

// ===========================================================================
// 1. The tenant / platform boundary
// ===========================================================================

describe("Operations — the tenant page is not a platform console", () => {
  it("reads no platform runtime endpoint", async () => {
    await mount(envelope(TEAM_ADMIN));
    for (const platform of ["/v1/ops/health", "/v1/ops/metrics", "/v1/ops/alerts"]) {
      expect(
        gets().some((p) => p.startsWith(platform)),
        `${platform} is platform runtime and must not be read here`,
      ).toBe(false);
    }
    // Every read is workspace-scoped.
    for (const path of gets()) {
      expect(path).toMatch(/teamId=/);
    }
  });

  it("renders no link to a platform-admin console", async () => {
    await mount(envelope(TEAM_ADMIN));
    const hrefs = qa("a[href]").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/admin/platform/"))).toBe(false);
  });

  it("has exactly one h1, and it says Operations", async () => {
    await mount(envelope(TEAM_ADMIN));
    const h1s = qa("h1");
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe("Operations");
    // The hub bar's markers are gone with it.
    expect(q("[data-hub-bar]")).toBeNull();
    expect(q("[data-hub-title]")).toBeNull();
  });

  it("shows no process counters, uptime or gauge vocabulary", async () => {
    await mount(envelope(TEAM_ADMIN));
    const text = document.body.textContent ?? "";
    for (const word of ["Process uptime", "gauges", "counters", "Sentry", "5xx"]) {
      expect(text.includes(word), `${word} is platform vocabulary`).toBe(false);
    }
  });
});

// ===========================================================================
// 2. Access — a workspace without the capability asks for NOTHING
// ===========================================================================

describe("Operations — access", () => {
  it("Personal Free is refused by the canonical route gate and makes ZERO requests", async () => {
    await mount(envelope(FREE));
    // The refusal is the CANONICAL one — the same structured panel every other
    // capability-gated route uses — not a bespoke disabled workbench.
    const gate = q('[data-page-route-gate-route-id="workspace.operations"]');
    expect(gate).not.toBeNull();
    expect(gate?.getAttribute("data-page-route-gate-state")).not.toBe("ALLOWED");
    // The point of the assertion: not a 403 the panel then explains. No call.
    expect(requestLog.filter((r) => r.path.startsWith("/v1/ops/"))).toHaveLength(
      0,
    );
    // And no workbench chrome leaked out behind the panel.
    expect(q("[data-ops-summary]")).toBeNull();
    expect(q("[data-ops-controls]")).toBeNull();
    expect(q("[data-ops-table-surface]")).toBeNull();
  });

  it("a workspace whose envelope grants the capability but has no id gets the page's own truthful state", async () => {
    // Reachable mid-bootstrap: the capability resolved, the workspace has not.
    await mount(
      envelope(PERSONAL_PRO, {
        workspace: { id: null, name: null, status: "active", scope: "PERSONAL" },
        activeSpace: null,
        contextOptions: {
          personalSpace: null,
          ownedWorkspaces: [],
          organizations: [],
          activeContext: null,
        },
      }),
    );
    expect(requestLog.filter((r) => r.path.startsWith("/v1/ops/"))).toHaveLength(
      0,
    );
  });
});

// ===========================================================================
// 3. Density is capability-driven, not plan-driven
// ===========================================================================

describe("Operations — one design, three densities", () => {
  it("Personal Pro (sole operator) loses the ownership axis entirely", async () => {
    summaryReply = () => summary({ operatorCount: 1 });
    await mount(envelope(PERSONAL_PRO));

    // No owner column, no owner filter, no collaborative summary cards.
    expect(q("[data-ops-owner-filter]")).toBeNull();
    expect(metric("assignedToMe")).toBeNull();
    expect(metric("unassigned")).toBeNull();
    expect(q("[data-ops-owner]")).toBeNull();
    // The severity axis is untouched — this is not a smaller product.
    //
    // `overdue` is deliberately NOT here. The Overdue card counted conditions
    // open past a fixed 48 hours, which was a SECOND authority on lateness
    // competing with the workspace's own SLA promise: a four-hour promise was
    // breached at hour five while the card called it fine, and a seven-day
    // promise had conditions called overdue on day two. Lateness is now
    // measured in exactly one place — the persisted SLA cycle — and the cards
    // that replaced it are `slaBreached` / `slaAtRisk`.
    expect(metric("open")).not.toBeNull();
    expect(metric("critical")).not.toBeNull();
    expect(metric("slaBreached")).not.toBeNull();
    expect(metric("slaAtRisk")).not.toBeNull();
    expect(metric("overdue")).toBeNull();
    // And it never asked who could be assigned, because nobody could be.
    expect(gets().some((p) => p.includes("assignable-operators"))).toBe(false);
  });

  it("a shared workspace gains ownership, on the SAME table", async () => {
    summaryReply = () => summary({ operatorCount: 3 });
    operatorsReply = () => ({
      operators: [
        { userId: ME, displayName: "Jalal", email: null, role: "ADMIN" },
        { userId: COLLEAGUE, displayName: "Sam", email: null, role: "MEMBER" },
      ],
      selfUserId: ME,
    });
    await mount(envelope(TEAM_ADMIN));

    expect(q("[data-ops-owner-filter]")).not.toBeNull();
    expect(metric("assignedToMe")).not.toBeNull();
    expect(metric("unassigned")).not.toBeNull();
    // The row anatomy did not fork: the same table gained one column.
    expect(rowIds()).toEqual(["i-crit", "i-high", "i-old"]);
    const owners = tableOwners();
    expect(owners.length).toBe(3);
    // "Unassigned" is a WORD, never an empty cell.
    expect(owners[0].textContent).toBe("Unassigned");
    // The caller's own conditions say "You" rather than their own id.
    expect(owners[1].textContent).toBe("You");
  });

  it("a VIEWER in a shared workspace keeps the ownership axis and loses every mutation", async () => {
    summaryReply = () => summary({ operatorCount: 3 });
    await mount(envelope(VIEWER));

    // Sees WHO has what — that is part of understanding the workspace.
    expect(q("[data-ops-owner-filter]")).not.toBeNull();
    expect(tableOwners().length).toBe(3);
    // And is offered nothing to press: no row menu, no selection, no bulk bar.
    expect(qa("[data-ops-row-menu-trigger]").length).toBe(0);
    expect(qa('input[type="checkbox"]').length).toBe(0);
    expect(q("[data-ops-bulk-toolbar]")).toBeNull();
    // The header says so in words rather than leaving dead controls around.
    expect(document.body.textContent).toMatch(/needs an operator role/i);
  });

  it("the ownership axis follows the OPERATOR COUNT, not the caller's own assign capability", async () => {
    // The distinction that matters: a viewer holds no OPERATIONS_ASSIGN and
    // must still be able to ask who is on something.
    summaryReply = () => summary({ operatorCount: 3 });
    await mount(envelope(VIEWER));
    expect(q("[data-ops-owner-filter]")).not.toBeNull();

    summaryReply = () => summary({ operatorCount: 1 });
    await mount(envelope(VIEWER));
    expect(q("[data-ops-owner-filter]")).toBeNull();
  });
});

// ===========================================================================
// 4. Filters are SERVER filters
// ===========================================================================

describe("Operations — filtering asks the server, not the page", () => {
  it("opens on every status, and still sends one when it is chosen", async () => {
    /*
     * THE DEFAULT DELIBERATELY DOES NOT NARROW.
     *
     * This asserted `status=OPEN` on the opening read, which is what the page
     * used to send. `DEFAULT_FILTERS` was changed on purpose — the page
     * presented itself as the queue while silently withholding everything
     * acknowledged, suppressed or resolved, and the Status control read "Open"
     * as though the operator had asked for it. A default that narrows the
     * collection is indistinguishable from a collection that is small.
     *
     * So the opening read must carry NO status, and the assertion that a
     * status still reaches the server moves to where a status is actually
     * chosen — otherwise correcting the default would have deleted the only
     * proof that this filter is a server filter at all.
     */
    await mount(envelope(TEAM_ADMIN));
    expect(lastListQuery()).not.toMatch(/status=/);
    expect(lastListQuery()).toMatch(/limit=50/);

    // ...and an explicit status still reaches the server, which is the half
    // that must not be lost. `filtersFromParams` is documented to let an
    // explicit `?status=` win over the default precisely so a shared link, a
    // saved view and the Back button keep saying what they said before.
    cleanup();
    currentSearch = "status=OPEN";
    await mount(envelope(TEAM_ADMIN));
    expect(lastListQuery()).toMatch(/status=OPEN/);
  });

  it("a summary card sets one coherent view and re-reads", async () => {
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(metric("critical") as HTMLButtonElement);
    });
    await settle();
    expect(replaced.at(-1)).toContain("severity=CRITICAL");
    expect(lastListQuery()).toMatch(/severity=CRITICAL/);
    // It CLEARS what it does not imply, so pressing Critical cannot return
    // nothing because an unrelated filter was still applied.
    expect(lastListQuery()).not.toMatch(/category=/);
    expect(lastListQuery()).not.toMatch(/owner=/);
  });

  it("only one summary card is the primary filter at a time", async () => {
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(metric("critical") as HTMLButtonElement);
    });
    await settle();
    expect(metric("critical")?.getAttribute("aria-pressed")).toBe("true");
    expect(metric("high")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("typing in search puts the term in the URL, so a filtered queue is shareable", async () => {
    await mount(envelope(TEAM_ADMIN));
    const box = q("[data-ops-search]") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(box, { target: { value: "timestamp" } });
    });
    // THE INPUT TYPES AT KEYBOARD SPEED; THE URL WRITE IS DEBOUNCED.
    //
    // `useDebouncedSearchInput` holds the commit for 250ms, because binding the
    // box straight to the applied filter made every keystroke a
    // `router.replace()` — an App Router navigation with an RSC round trip —
    // AND a `GET /v1/ops/incidents`, and the character only appeared once all
    // of that had come back. The character still has to reach the URL; it
    // simply reaches it once the typing settles.
    //
    // The value is in the box immediately, which is the half a user feels…
    expect(box.value).toBe("timestamp");
    // …and in the URL after the debounce, which is the half a shared link
    // needs. Waiting past the real timer rather than mocking it: the delay is
    // part of the contract, and a fake clock would let a regression that
    // removed the commit entirely still pass.
    await settleDebounce();
    expect(replaced.at(-1)).toContain("q=timestamp");
  });

  it("a search term in the URL is sent to the SERVER, not applied to the loaded page", async () => {
    currentSearch = "q=timestamp&severity=CRITICAL";
    await mount(envelope(TEAM_ADMIN));
    expect(lastListQuery()).toMatch(/q=timestamp/);
    expect(lastListQuery()).toMatch(/severity=CRITICAL/);
  });

  it("an unknown filter value in a shared link widens rather than crashing", async () => {
    currentSearch = "severity=NONSENSE&sort=made-up";
    await mount(envelope(TEAM_ADMIN));
    expect(q("[data-ops-table-surface]")).not.toBeNull();
    expect(lastListQuery()).not.toMatch(/severity=NONSENSE/);
    expect(lastListQuery()).toMatch(/sort=recent/);
  });

  it("every filter is re-sent with the next page, so page 2 cannot use a different predicate", async () => {
    incidentsReply = () => list(THREE, { nextCursor: "cur-1", complete: false });
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(metric("critical") as HTMLButtonElement);
    });
    await settle();
    const more = q("[data-ops-load-more]") as HTMLButtonElement;
    expect(more).not.toBeNull();
    await act(async () => {
      fireEvent.click(more);
    });
    await settle();
    const page2 = lastListQuery();
    expect(page2).toMatch(/cursor=cur-1/);
    expect(page2).toMatch(/severity=CRITICAL/);
  });

  it("no native select survived anywhere on the route", async () => {
    await mount(envelope(TEAM_ADMIN));
    expect(qa("select").length).toBe(0);
    // The canonical listboxes are present and each has an accessible name.
    const boxes = qa('[role="combobox"], .app-listbox__trigger');
    expect(boxes.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 5. Honesty — "clear" is a claim, not a default
// ===========================================================================

describe("Operations — an all-clear is a claim about a COMPLETE read", () => {
  it("an empty, complete, unfiltered read is genuinely clear", async () => {
    incidentsReply = () => list([]);
    summaryReply = () => summary({ open: 0, critical: 0, high: 0, overdue: 0 });
    await mount(envelope(TEAM_ADMIN));
    expect(q('[data-ops-empty="clear"]')).not.toBeNull();
    expect(document.body.textContent).toMatch(/Workspace operations are clear/);
  });

  it("the clear state offers only destinations a tenant can open", async () => {
    incidentsReply = () => list([]);
    await mount(envelope(TEAM_ADMIN));
    const panel = q('[data-ops-empty="clear"]') as HTMLElement;
    const hrefs = Array.from(panel.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(["/evidence", "/home"]);
  });

  it("an empty FILTERED read is not clear", async () => {
    incidentsReply = () => list([]);
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(metric("critical") as HTMLButtonElement);
    });
    await settle();
    expect(q('[data-ops-empty="clear"]')).toBeNull();
    expect(q('[data-ops-empty="filtered"]')).not.toBeNull();
  });

  it("an empty TRUNCATED read is not clear, and says so", async () => {
    incidentsReply = () => list([], { complete: false, nextCursor: "c" });
    await mount(envelope(TEAM_ADMIN));
    expect(q('[data-ops-empty="clear"]')).toBeNull();
    expect(q("[data-ops-degraded]")).not.toBeNull();
  });

  it("a FAILED incident read shows unavailable, never clear", async () => {
    incidentsReply = () => apiFailure(503);
    await mount(envelope(TEAM_ADMIN));
    expect(q("[data-ops-unavailable]")).not.toBeNull();
    expect(q('[data-ops-empty="clear"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/operations are clear/i);
  });

  it("a failed SUMMARY degrades the strip without blanking the queue", async () => {
    summaryReply = () => apiFailure(503);
    await mount(envelope(TEAM_ADMIN));
    // The queue is still there — one source failing must not take the others.
    expect(rowIds()).toEqual(["i-crit", "i-high", "i-old"]);
    const degraded = q("[data-ops-degraded]") as HTMLElement;
    expect(degraded).not.toBeNull();
    expect(degraded.getAttribute("role")).toBe("alert");
  });

  it("a failed read never leaks the provider's own words", async () => {
    incidentsReply = () => apiFailure(500);
    await mount(envelope(TEAM_ADMIN));
    expect(document.body.textContent).not.toContain("request failed");
  });
});

// ===========================================================================
// 6. The row and the card say the same thing
// ===========================================================================

describe("Operations — two renderers, one model", () => {
  it("the table and the cards carry the same conditions in the same order", async () => {
    summaryReply = () => summary({ operatorCount: 3 });
    await mount(envelope(TEAM_ADMIN));
    expect(cardIds()).toEqual(rowIds());
  });

  it("every condition states its severity and status as TEXT, not only colour", async () => {
    await mount(envelope(TEAM_ADMIN));
    const sevs = qa("[data-ops-severity]").map((el) => el.textContent);
    expect(sevs).toContain("Critical");
    expect(sevs).toContain("High");
    const statuses = qa("[data-ops-status]").map((el) => el.textContent);
    expect(statuses.every((s) => s === "Open")).toBe(true);
    // The raw enum token never reaches the operator.
    expect(document.body.textContent).not.toContain("EVIDENCE_INTEGRITY");
    expect(document.body.textContent).not.toContain("ACKNOWLEDGED");
  });

  it("a condition that is late against its OWN promise is marked in words", async () => {
    // Was "past the overdue age" — a fixed 48-hour heuristic that has been
    // removed. Lateness is now the workspace's own recorded commitment, so the
    // row carries an SLA POSTURE rather than an age verdict.
    //
    // The assertion is stronger than the one it replaces: it requires the
    // posture to be one of the bounded values AND the badge to say so in
    // words, because an operator who cannot distinguish two reds still has to
    // be able to triage.
    incidentsReply = () => ({
      // The SLA VOCABULARY travels with the rows it governs. `needsAttention`
      // is derived from `attentionPostures` — the postures the SERVER
      // considers late — so a page that never received the envelope makes no
      // claim about lateness at all. That is the correct default and it is why
      // the badge is absent without this.
      sla: {
        postures: [
          "UNTRACKED_LEGACY",
          "NOT_APPLICABLE",
          "ON_TRACK",
          "AT_RISK",
          "BREACHED",
          "ACKNOWLEDGED",
          "RESOLVED",
        ],
        attentionPostures: ["BREACHED", "AT_RISK"],
      },
      ...list([
        {
          ...incident({ id: "11111111-1111-4111-8111-111111111111" }),
          // The workspace's OWN recorded promise, breached. The posture and
          // its words come from the server projection; the browser renders the
          // verdict and never recomputes it, which is what stopped the page
          // from becoming a second SLA authority.
          sla: {
            posture: "BREACHED",
            obligation: "RESOLUTION",
            dueAtUtc: HOURS_AGO(1),
            targetHours: 4,
            policyVersionId: "22222222-2222-4222-8222-222222222222",
            cycleNumber: 1,
            acknowledgementBreached: false,
            resolutionBreached: true,
          },
        },
      ]),
    });
    await mount(envelope(TEAM_ADMIN));
    const late = qa("[data-ops-sla-badge]");
    expect(late.length).toBeGreaterThan(0);
    for (const badge of late) {
      expect(badge.getAttribute("data-ops-sla-badge")).toMatch(
        /^(BREACHED|AT_RISK)$/,
      );
      expect((badge.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// 7. The inspector
// ===========================================================================

describe("Operations — the inspector", () => {
  it("opens from the condition title and loads its OWN history", async () => {
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q('[data-ops-open="i-high"]') as HTMLElement);
    });
    await settle();
    expect(q("[data-ops-inspector]")).not.toBeNull();
    expect(
      gets().some((p) => p.startsWith("/v1/ops/incidents/i-high?")),
    ).toBe(true);
    const timeline = q("[data-ops-timeline]") as HTMLElement;
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(2);
  });

  it("a history that FAILED to load is not an empty history", async () => {
    detailReply = () => apiFailure(503);
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q('[data-ops-open="i-high"]') as HTMLElement);
    });
    await settle();
    const err = q("[data-ops-timeline-error]") as HTMLElement;
    expect(err).not.toBeNull();
    expect(err.textContent).toMatch(/not the full record/i);
    expect(q("[data-ops-timeline]")).toBeNull();
  });

  it("links to the affected record, and only when there is one", async () => {
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q('[data-ops-open="i-high"]') as HTMLElement);
    });
    await settle();
    const link = q("[data-ops-affected-link]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "/evidence/99999999-9999-4999-8999-999999999999",
    );
  });

  it("renders no SLA, no due date and no runbook link", async () => {
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q('[data-ops-open="i-high"]') as HTMLElement);
    });
    await settle();
    const panel = q("[data-ops-inspector]") as HTMLElement;
    // The platform owns no SLA authority for conditions; inventing one from an
    // age threshold would be a promise the product cannot keep.
    expect(panel.textContent).not.toMatch(/\bdue\b/i);
    expect(panel.textContent).not.toMatch(/\bSLA\b/);
    // `runbookSlug` points into docs/runbooks/*, which no tenant can open.
    expect(panel.textContent).not.toContain("tsa-failure");
  });

  it("Escape closes it and focus returns to the control that opened it", async () => {
    await mount(envelope(TEAM_ADMIN));
    const opener = q('[data-ops-open="i-high"]') as HTMLElement;
    opener.focus();
    await act(async () => {
      fireEvent.click(opener);
    });
    await settle();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await settle();
    expect(q("[data-ops-inspector]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("the queue geometry is unchanged while it is open", async () => {
    await mount(envelope(TEAM_ADMIN));
    const before = rowIds();
    await act(async () => {
      fireEvent.click(q('[data-ops-open="i-high"]') as HTMLElement);
    });
    await settle();
    expect(rowIds()).toEqual(before);
    expect(
      q('[data-ops-row="i-high"]')?.getAttribute("data-ops-row-open"),
    ).toBe("true");
  });
});

// ===========================================================================
// 8. Mutations
// ===========================================================================

describe("Operations — acting on a condition", () => {
  async function openMenu(id: string) {
    const trigger = within(
      q(`[data-ops-row="${id}"]`) as HTMLElement,
    ).getByRole("button", { name: /Actions for/ });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await settle();
  }

  it("acknowledge posts to the canonical route, once, with the workspace claim", async () => {
    await mount(envelope(TEAM_ADMIN));
    await openMenu("i-crit");
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-ops-row-action="acknowledge"]') as HTMLElement,
      );
    });
    await settle();
    const acks = posts().filter((p) => p.path.endsWith("/ack"));
    expect(acks).toHaveLength(1);
    expect(acks[0].path).toBe("/v1/ops/incidents/i-crit/ack");
    expect(JSON.parse(acks[0].body as string)).toEqual({ teamId: WS });
  });

  it("a mutation re-reads from the server rather than patching the row", async () => {
    await mount(envelope(TEAM_ADMIN));
    const readsBefore = gets().filter((p) =>
      p.startsWith("/v1/ops/incidents?"),
    ).length;
    await openMenu("i-crit");
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-ops-row-action="acknowledge"]') as HTMLElement,
      );
    });
    await settle();
    const readsAfter = gets().filter((p) =>
      p.startsWith("/v1/ops/incidents?"),
    ).length;
    expect(readsAfter).toBeGreaterThan(readsBefore);
  });

  it("a refused mutation is reported safely and changes nothing", async () => {
    mutationReply = () => apiFailure(403);
    await mount(envelope(TEAM_ADMIN));
    await openMenu("i-crit");
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-ops-row-action="acknowledge"]') as HTMLElement,
      );
    });
    await settle();
    const err = q("[data-ops-mutation-error]") as HTMLElement;
    expect(err).not.toBeNull();
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).not.toContain("request failed");
    expect(rowIds()).toEqual(["i-crit", "i-high", "i-old"]);
  });

  it("an already-acknowledged condition is offered no Acknowledge", async () => {
    incidentsReply = () =>
      list([incident({ id: "i-ack", status: "ACKNOWLEDGED" })]);
    await mount(envelope(TEAM_ADMIN));
    await openMenu("i-ack");
    expect(document.querySelector('[data-ops-row-action="acknowledge"]')).toBeNull();
    // Resolve is still available — the condition is unresolved.
    expect(document.querySelector('[data-ops-row-action="resolve"]')).not.toBeNull();
  });

  it("assignment goes through the canonical route with null meaning unassign", async () => {
    summaryReply = () => summary({ operatorCount: 3 });
    operatorsReply = () => ({
      operators: [
        { userId: COLLEAGUE, displayName: "Sam", email: null, role: "MEMBER" },
      ],
      selfUserId: ME,
    });
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q('[data-ops-open="i-crit"]') as HTMLElement);
    });
    await settle();
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-ops-action="self-assign"]') as HTMLElement,
      );
    });
    await settle();
    const assigns = posts().filter((p) => p.path.endsWith("/assign"));
    expect(assigns).toHaveLength(1);
    expect(JSON.parse(assigns[0].body as string)).toEqual({
      teamId: WS,
      assigneeUserId: ME,
    });
  });

  // =========================================================================
  // CONDITION_STILL_ACTIVE — the refusal an operator must not be able to miss
  // =========================================================================
  //
  // The server refuses a Resolve whose condition its own source still reports.
  // That refusal used to land in the page-level banner at the top of the
  // queue — off-screen on any real backlog — so the visible outcome of
  // pressing Resolve was nothing at all, which reads as success.
  //
  // These cases hold the correction AND its boundary: this one code opens the
  // dialog, every other failure keeps the banner, and nothing about the
  // condition changes either way.

  /** The dialog the page opens for this refusal, or null. */
  const noticeDialog = () =>
    q('[data-confirm-action-modal="ops-condition-still-active"]') as
      | HTMLElement
      | null;

  async function resolveFromRow(id: string) {
    await openMenu(id);
    const control = document.querySelector(
      '[data-ops-row-action="resolve"]',
    ) as HTMLElement;
    control.focus();
    await act(async () => {
      fireEvent.click(control);
    });
    await settle();
    return control;
  }

  it("a still-active condition opens the dialog instead of the page banner", async () => {
    mutationReply = () => apiCodeFailure(409, "CONDITION_STILL_ACTIVE");
    await mount(envelope(TEAM_ADMIN));
    await resolveFromRow("i-crit");

    const dialog = noticeDialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("role")).toBe("dialog");
    expect(dialog!.getAttribute("aria-modal")).toBe("true");

    const titleId = dialog!.getAttribute("aria-labelledby");
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId!)?.textContent).toBe(
      "Condition is still active",
    );
    const describedBy = dialog!.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "This condition is still being reported by its source. Complete the required remediation, or suppress it with a recorded reason if notifications should stop.",
    );

    // ONE footer action, named Close. Not "Dismiss": dismiss, suppress and
    // resolve are three different things an operator can do to a condition,
    // and two of them mutate it.
    const submit = dialog!.querySelector(
      "[data-confirm-action-submit]",
    ) as HTMLElement;
    expect(submit.textContent).toBe("Close");
    expect(submit.getAttribute("aria-disabled")).toBe("false");
    expect(dialog!.querySelector("[data-confirm-action-cancel]")).toBeNull();

    // A close icon with an accessible name, distinct from the footer action.
    const icon = dialog!.querySelector(
      "[data-confirm-action-close]",
    ) as HTMLElement;
    expect(icon).not.toBeNull();
    expect(icon.getAttribute("aria-label")).toBe("Close");

    // THE OLD PRESENTATION IS ABSENT for this code.
    expect(q("[data-ops-mutation-error]")).toBeNull();
  });

  it("the condition keeps the status the SERVER returned, never RESOLVED", async () => {
    mutationReply = () => apiCodeFailure(409, "CONDITION_STILL_ACTIVE");
    incidentsReply = () =>
      list([
        incident({ id: "i-open", status: "OPEN" }),
        incident({ id: "i-ack", status: "ACKNOWLEDGED" }),
      ]);
    await mount(envelope(TEAM_ADMIN));
    await resolveFromRow("i-open");

    expect(noticeDialog()).not.toBeNull();
    // Both rows still present, in the status the read returned. Nothing was
    // applied optimistically, and the refusal re-read rather than guessed.
    expect(rowIds()).toEqual(["i-open", "i-ack"]);
    const status = (id: string) =>
      (q(`[data-ops-row="${id}"]`) as HTMLElement).textContent ?? "";
    expect(status("i-open")).not.toContain("Resolved");
    expect(status("i-ack")).not.toContain("Resolved");
  });

  it("closing the dialog mutates nothing and returns focus into the row that opened it", async () => {
    mutationReply = () => apiCodeFailure(409, "CONDITION_STILL_ACTIVE");
    await mount(envelope(TEAM_ADMIN));
    await resolveFromRow("i-crit");

    const postsBefore = posts().length;
    const dialog = noticeDialog()!;
    await act(async () => {
      fireEvent.click(
        dialog.querySelector("[data-confirm-action-submit]") as HTMLElement,
      );
    });
    await settleTimers();

    expect(noticeDialog()).toBeNull();
    // NOT ONE further request. Close closes; it does not suppress, dismiss or
    // resolve anything.
    expect(posts().length).toBe(postsBefore);

    // FOCUS LANDS BACK IN THE ROW THE OPERATOR ACTED ON.
    //
    // Asserted as the row's menu TRIGGER rather than the Resolve item,
    // because the item is a menu child that the menu unmounts when it closes:
    // there is no element left to focus. The trigger is the durable control
    // that owns it, and the keyboard user resumes exactly where they were —
    // one keystroke from the same menu. The Inspector case below, where the
    // Resolve button persists, restores that button itself.
    const active = document.activeElement as HTMLElement;
    expect(q('[data-ops-row="i-crit"]')!.contains(active)).toBe(true);
    expect(active.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("Escape closes it, and it still mutates nothing", async () => {
    mutationReply = () => apiCodeFailure(409, "CONDITION_STILL_ACTIVE");
    await mount(envelope(TEAM_ADMIN));
    await resolveFromRow("i-crit");
    const postsBefore = posts().length;

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await settle();

    expect(noticeDialog()).toBeNull();
    expect(posts().length).toBe(postsBefore);
  });

  it("the same refusal from the INSPECTOR opens the same dialog", async () => {
    mutationReply = () => apiCodeFailure(409, "CONDITION_STILL_ACTIVE");
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q('[data-ops-open="i-crit"]') as HTMLElement);
    });
    await settle();

    const control = document.querySelector(
      '[data-ops-action="resolve"]',
    ) as HTMLElement;
    expect(control).not.toBeNull();
    control.focus();
    await act(async () => {
      fireEvent.click(control);
    });
    await settle();

    expect(noticeDialog()).not.toBeNull();
    expect(q("[data-ops-mutation-error]")).toBeNull();

    // The Inspector's Resolve button survives the round trip, so focus is
    // restored to THAT control — the one the operator pressed.
    const dialog = noticeDialog()!;
    await act(async () => {
      fireEvent.click(
        dialog.querySelector("[data-confirm-action-submit]") as HTMLElement,
      );
    });
    await settleTimers();
    expect(document.activeElement).toBe(control);
  });

  it("there is no BULK Resolve, so the dialog has no third entry point to cover", async () => {
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-ops-row-mark="i-crit"]') as HTMLElement,
      );
    });
    await settle();
    const bar = q("[data-ops-bulk-toolbar]") as HTMLElement;
    expect(bar).not.toBeNull();
    // Stated rather than assumed: if a bulk Resolve is ever added, this fails
    // and whoever adds it has to route it through the same dialog.
    expect(bar.querySelector('[data-ops-bulk-action="resolve"]')).toBeNull();
  });

  it("a DIFFERENT error code keeps the existing banner and opens no dialog", async () => {
    mutationReply = () => apiCodeFailure(409, "INVALID_STATUS_TRANSITION");
    await mount(envelope(TEAM_ADMIN));
    await resolveFromRow("i-crit");

    expect(noticeDialog()).toBeNull();
    const err = q("[data-ops-mutation-error]") as HTMLElement;
    expect(err).not.toBeNull();
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).not.toContain("request failed");
  });

  it("the bulk toolbar appears only after a selection, and fans out to the canonical runner", async () => {
    await mount(envelope(TEAM_ADMIN));
    expect(q("[data-ops-bulk-toolbar]")).toBeNull();
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-ops-row-mark="i-crit"]') as HTMLElement,
      );
    });
    await settle();
    const bar = q("[data-ops-bulk-toolbar]") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("data-ops-bulk-count")).toBe("1");
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-ops-bulk-action="acknowledge"]') as HTMLElement,
      );
    });
    await settle();
    const bulk = posts().filter((p) => p.path === "/v1/ops/bulk-actions");
    expect(bulk).toHaveLength(1);
    expect(JSON.parse(bulk[0].body as string)).toEqual({
      teamId: WS,
      actionType: "BULK_ACKNOWLEDGE_INCIDENTS",
      targetIds: ["i-crit"],
    });
  });
});

// ===========================================================================
// 9. Tenant boundary in the BROWSER
// ===========================================================================

describe("Operations — a response for another workspace is discarded", () => {
  it("a slow read that resolves after the workspace changed never paints", async () => {
    // The server answered both questions correctly; only the browser can get
    // this wrong, by rendering the first answer into the second workspace.
    incidentsReply = (() => {
      let first = true;
      return () => {
        if (first) {
          first = false;
          return {
            incidents: [incident({ id: "leaked-from-ws-a" })],
            pagination: { nextCursor: null, returned: 1 },
            completeness: { complete: true, mayAssertAllClear: true },
          };
        }
        return list([incident({ id: "belongs-to-ws-b" })]);
      };
    })();

    await mount(envelope(TEAM_ADMIN));
    // Re-mount under a DIFFERENT workspace while the first read is in flight.
    await mount(
      envelope(TEAM_ADMIN, {
        workspace: { id: OTHER_WS, name: "Other", status: "active", scope: "TEAM" },
        activeSpace: {
          type: "TEAM",
          id: OTHER_WS,
          displayName: "Other",
          roleLabel: "Admin",
        },
        contextOptions: {
          personalSpace: null,
          ownedWorkspaces: [],
          organizations: [],
          activeContext: {
            workspaceId: OTHER_WS,
            kind: "ORGANIZATION",
            organizationId: null,
            displayName: "Other",
          },
        },
      }),
    );
    expect(rowIds()).not.toContain("leaked-from-ws-a");
    // And every read the second mount made named the second workspace.
    const reads = gets().filter((p) => p.startsWith("/v1/ops/incidents?"));
    expect(reads.at(-1)).toContain(OTHER_WS);
  });
});

// ===========================================================================
// 10. Accessibility
// ===========================================================================

describe("Operations — accessibility", () => {
  it("every summary card is a real button announcing its filter state", async () => {
    summaryReply = () => summary({ operatorCount: 3 });
    await mount(envelope(TEAM_ADMIN));
    const cards = qa("[data-ops-metric]");
    // ONE ASSERTION, AGAINST THE VOCABULARY.
    //
    // There used to be a second line pinning the literal 7, directly beneath a
    // comment claiming the count was "asserted against the vocabulary rather
    // than a literal so a card added there cannot pass here by coincidence".
    // The literal is exactly the coupling that comment disclaims, and it is
    // what broke when the Resolved card was added — a card with its own
    // server-side count, deliberately, because the bounded scan the other
    // fields derive from covers only UNRESOLVED statuses.
    //
    // `QUEUE_METRIC_ORDER` is the canonical strip. A card silently
    // disappearing still fails here, which is the property worth having.
    expect(cards.length).toBe(QUEUE_METRIC_ORDER.length);
    expect(QUEUE_METRIC_ORDER).toContain("resolved");
    for (const card of cards) {
      expect(card.tagName).toBe("BUTTON");
      expect(card.getAttribute("aria-pressed")).toMatch(/^(true|false)$/);
      // The number is never alone: a label and an explanation travel with it.
      expect(card.querySelector(".app-metric-card__label")).not.toBeNull();
      expect(card.getAttribute("aria-describedby")).toBeTruthy();
    }
  });

  it("the row menu names the CONDITION, not just 'Actions'", async () => {
    await mount(envelope(TEAM_ADMIN));
    const trigger = within(
      q('[data-ops-row="i-crit"]') as HTMLElement,
    ).getByRole("button", { name: "Actions for Report generation failed" });
    expect(trigger).toBeTruthy();
  });

  it("the row menu is a real menu, keyboard-openable, that closes on Escape", async () => {
    await mount(envelope(TEAM_ADMIN));
    const trigger = within(
      q('[data-ops-row="i-crit"]') as HTMLElement,
    ).getByRole("button", { name: /Actions for/ }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    });
    await settle();
    const menu = q("[data-ops-row-menu-panel]") as HTMLElement;
    expect(menu.getAttribute("role")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      fireEvent.keyDown(menu, { key: "Escape" });
    });
    await settle();
    expect(q("[data-ops-row-menu-panel]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("the inspector is a labelled modal dialog", async () => {
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q('[data-ops-open="i-high"]') as HTMLElement);
    });
    await settle();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    const labelId = dialog.getAttribute("aria-labelledby") as string;
    expect(document.getElementById(labelId)?.textContent).toBe(
      "Trusted timestamp failed",
    );
  });

  it("the pending state of a refresh is announced, not only drawn", async () => {
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q("[data-ops-refresh]") as HTMLElement);
    });
    // The refreshing notice carries role=status so it is spoken.
    const notice = q("[data-ops-refreshing]");
    if (notice) expect(notice.getAttribute("role")).toBe("status");
    await settle();
  });
});

// ===========================================================================
// WORKSPACE-SCOPE CONVERGENCE (§16) — the reconciliation states.
//
// Before discovery became a scheduled run, every one of these rendered as
// "Workspace operations are clear". That sentence tells an operator to stop
// looking, and each case below is a workspace where they should not.
// ===========================================================================

describe("Operations — reconciliation state is visible, and gates the all-clear", () => {
  it("a NEVER-RUN workspace says PREPARING, never clear", async () => {
    incidentsReply = () => list([]);
    summaryReply = () =>
      summary({
        open: 0,
        critical: 0,
        high: 0,
        overdue: 0,
        readiness: "NEVER_RUN",
        mayAssertAllClear: false,
        clearRefusalReason: "NEVER_RUN",
      });
    await mount(envelope(TEAM_ADMIN));

    // The exact combination that used to license the all-clear: zero
    // conditions, a complete read, no filters — over a workspace nothing has
    // ever examined.
    expect(q('[data-ops-empty="clear"]')).toBeNull();
    expect(q('[data-ops-empty="preparing"]')).not.toBeNull();
    expect(document.body.textContent).toMatch(/Preparing workspace operations/);
    expect(document.body.textContent).not.toMatch(
      /Workspace operations are clear/,
    );
  });

  it("a RUNNING reconciliation is announced while the queue stays readable", async () => {
    summaryReply = () => summary({ readiness: "RUNNING" });
    await mount(envelope(TEAM_ADMIN));
    expect(q('[data-ops-reconciling="true"]')).not.toBeNull();
    // The existing rows are still on screen — a refresh in flight is not a
    // reason to blank the queue somebody is working.
    expect(q("[data-ops-row]") ?? q("table")).not.toBeNull();
  });

  it("a PARTIAL run warns that the counts are a floor", async () => {
    summaryReply = () =>
      summary({
        readiness: "PARTIAL",
        mayAssertAllClear: false,
        clearRefusalReason: "PARTIAL_SOURCES",
      });
    await mount(envelope(TEAM_ADMIN));
    expect(q('[data-ops-partial="true"]')).not.toBeNull();
    expect(document.body.textContent).toMatch(/not necessarily all of them/i);
  });

  /**
   * A PARTIAL run whose recorded reasons are all NON-retryable.
   *
   * This is the production shape: six sources failed, every one of them on a
   * deployment/schema disagreement. Offering "Check again" here is an
   * instruction to waste an operator's time during an incident, and worse, a
   * suggestion that the problem is transient when it is not.
   */
  function partialWith(failures: Array<Record<string, unknown>>) {
    const base = summary({
      readiness: "PARTIAL",
      mayAssertAllClear: false,
      clearRefusalReason: "PARTIAL_SOURCES",
    });
    return {
      ...base,
      summary: {
        ...base.summary,
        reconciliation: {
          ...base.summary.reconciliation,
          sources: {
            ...base.summary.reconciliation.sources,
            failedSources: failures.map((f) => f.sourceId as string),
            sourceFailures: failures,
          },
        },
      },
    };
  }

  const SIX_PRODUCTION_FAILURES = [
    "evidence_integrity.tsa_failed",
    "evidence_integrity.ots_failed",
    "evidence_integrity.ots_pending_aged",
    "pipeline.report_backlog",
    "pipeline.package_backlog",
    "platform.telemetry_stale",
  ].map((sourceId) => ({
    sourceId,
    stage: "WRITE",
    category: "schema_mismatch",
    retryable: false,
  }));

  it("a NON-retryable PARTIAL run withholds 'Check again' and says why", async () => {
    summaryReply = () => partialWith(SIX_PRODUCTION_FAILURES);
    await mount(envelope(TEAM_ADMIN));

    const panel = q('[data-ops-partial="true"]') as HTMLElement;
    expect(panel).not.toBeNull();
    // The control is ABSENT, not disabled: a disabled button still says "this
    // is the thing to press once conditions change", and nothing the operator
    // can do from here will change these conditions.
    expect(within(panel).queryByRole("button", { name: /check again/i })).toBeNull();
    expect(panel.querySelector("[data-ops-partial-nonretryable]")).not.toBeNull();
    expect(panel.textContent).toMatch(/won.t change this/i);
    // And still no internals.
    expect(panel.textContent).not.toMatch(/select |prisma|column|schema_mismatch/i);
  });

  it("a RETRYABLE PARTIAL run still offers 'Check again'", async () => {
    summaryReply = () =>
      partialWith([
        {
          sourceId: "pipeline.report_backlog",
          stage: "SCAN",
          category: "timeout",
          retryable: true,
        },
      ]);
    await mount(envelope(TEAM_ADMIN));
    const panel = q('[data-ops-partial="true"]') as HTMLElement;
    expect(
      within(panel).queryByRole("button", { name: /check again/i }),
    ).not.toBeNull();
  });

  it("a run recorded by an OLDER image, carrying no reasons, still offers the retry", async () => {
    // An unknown cause is not evidence that a retry is pointless, and
    // withholding the control on a guess is worse than offering one that may
    // not help.
    summaryReply = () =>
      summary({
        readiness: "PARTIAL",
        mayAssertAllClear: false,
        clearRefusalReason: "PARTIAL_SOURCES",
      });
    await mount(envelope(TEAM_ADMIN));
    const panel = q('[data-ops-partial="true"]') as HTMLElement;
    expect(
      within(panel).queryByRole("button", { name: /check again/i }),
    ).not.toBeNull();
  });

  it("'Check again' asks for a NEW CHECK — it does not re-read the same summary", async () => {
    summaryReply = () =>
      partialWith([
        {
          sourceId: "pipeline.report_backlog",
          stage: "SCAN",
          category: "timeout",
          retryable: true,
        },
      ]);
    await mount(envelope(TEAM_ADMIN));
    requestLog = [];

    const panel = q('[data-ops-partial="true"]') as HTMLElement;
    const button = within(panel).getByRole("button", { name: /check again/i });
    await act(async () => {
      fireEvent.click(button);
    });

    // The whole correction. It used to bump a token and re-fetch the SAME
    // summary, so a PARTIAL run re-rendered the same warning and the control
    // appeared to do nothing.
    const reconcile = requestLog.filter((r) =>
      r.path.startsWith("/v1/ops/workspace-reconcile"),
    );
    expect(reconcile).toHaveLength(1);
    expect(reconcile[0].method).toBe("POST");
    expect(reconcile[0].body).toContain(WS);
  });

  it("a FAILED run on a schema mismatch offers no retry at all", async () => {
    summaryReply = () => {
      // `safeFailureCategory` lives on the RUN, not on the summary — the
      // category is a property of the reconciliation that failed, not of the
      // projection that reports it.
      const base = summary({
        readiness: "FAILED",
        mayAssertAllClear: false,
        clearRefusalReason: "FAILED",
      });
      return {
        ...base,
        summary: {
          ...base.summary,
          reconciliation: {
            ...base.summary.reconciliation,
            safeFailureCategory: "schema_mismatch",
          },
        },
      };
    };
    await mount(envelope(TEAM_ADMIN));
    const panel = q("[data-ops-reconcile-failed]") as HTMLElement;
    expect(panel.getAttribute("data-ops-reconcile-retryable")).toBe("false");
    expect(within(panel).queryByRole("button", { name: /try again/i })).toBeNull();
    expect(panel.textContent).toMatch(/don.t currently match/i);
  });

  it("a STALLED run is reported as unfinished, not as busy", async () => {
    summaryReply = () =>
      summary({
        readiness: "STALLED",
        mayAssertAllClear: false,
        clearRefusalReason: "STALLED",
      });
    await mount(envelope(TEAM_ADMIN));
    expect(q('[data-ops-stalled="true"]')).not.toBeNull();
    expect(document.body.textContent).toMatch(/didn’t finish|didn't finish/i);
  });

  it("a FAILED run explains the bounded category and never a provider message", async () => {
    summaryReply = () =>
      summary({
        readiness: "FAILED",
        mayAssertAllClear: false,
        clearRefusalReason: "FAILED",
      });
    await mount(envelope(TEAM_ADMIN));
    const panel = q("[data-ops-reconcile-failed]") as HTMLElement;
    expect(panel).not.toBeNull();
    // The category is a bounded server classification. A stack, a SQL fragment
    // or a connection string reaching here would be the leak the API boundary
    // reduces it to prevent.
    expect(panel.textContent).not.toMatch(/select |prisma|postgres|:\/\//i);
  });

  it("a STALE run says the conditions may be out of date", async () => {
    summaryReply = () =>
      summary({
        readiness: "STALE",
        mayAssertAllClear: false,
        clearRefusalReason: "STALE",
      });
    await mount(envelope(TEAM_ADMIN));
    expect(q('[data-ops-stale="true"]')).not.toBeNull();
  });

  it("the page NEVER says clear when the server withholds permission", async () => {
    // The single most important assertion in this file. Enumerated over every
    // refusing state so a future edit that reintroduces a client-side
    // derivation fails here rather than in production.
    for (const readiness of [
      "NEVER_RUN",
      "RUNNING",
      "STALE",
      "FAILED",
      "STALLED",
      "PARTIAL",
    ] as const) {
      cleanup();
      incidentsReply = () => list([]);
      summaryReply = () =>
        summary({
          open: 0,
          critical: 0,
          high: 0,
          overdue: 0,
          readiness,
          mayAssertAllClear: false,
          clearRefusalReason: readiness,
        });
      await mount(envelope(TEAM_ADMIN));
      expect(
        q('[data-ops-empty="clear"]'),
        `rendered the all-clear under ${readiness}`,
      ).toBeNull();
    }
  });
});

// ===========================================================================
// THE SOURCE CONTRACT DECIDES WHICH ACTIONS ARE OFFERED
// ===========================================================================
//
// Resolve used to be offered on EVERY unresolved condition to any capability
// holder. That was a client-side derivation of a server-side rule, and it was
// wrong for two whole classes of condition:
//
//   SOURCE_TRUTH          the server refuses it — recovery closes these — so
//                         the control could only ever produce a 409;
//   NO_DIRECT_RESOLUTION  nobody in the workspace can truthfully close it.
//
// The projection now carries the decision per row and the browser renders it.
// These cases hold that the three authorities produce three different rows,
// that remediation and assignment are UNAFFECTED by any of it, and that the
// row and the inspector agree — they used to decide independently.

describe("Operations — Resolve is offered by the SOURCE contract, not by capability alone", () => {
  /**
   * Open the row's action menu, then read what it offers.
   *
   * The menu is rendered at document level, not inside the row, so the reader
   * opens it first and queries globally — the same shape the pre-existing
   * action cases in this file use.
   */
  async function actionsFor(id: string): Promise<Set<string>> {
    const trigger = within(
      q(`[data-ops-row="${id}"]`) as HTMLElement,
    ).getByRole("button", { name: /Actions for/ });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await settle();
    return new Set(
      qa("[data-ops-row-action]").map(
        (el) => el.getAttribute("data-ops-row-action") as string,
      ),
    );
  }

  beforeEach(() => {
    detailReply = () => ({
      incident: { ...incident({ id: "x" }), timeline: [], timelineComplete: true },
      remediation: {
        disposition: "READ_ONLY_GUIDANCE",
        actions: [],
        deepLink: null,
        guidance: null,
        unsafeReason: null,
      },
    });
  });

  it("hides Resolve for a SOURCE_TRUTH condition, for a full-capability admin", async () => {
    incidentsReply = () =>
      list([
        incident({
          id: "i-source-truth",
          title: "Report generation backlog",
          category: "REPORT",
          lifecycle: {
            sourceId: "pipeline.report_backlog",
            sourceMatch: "FINGERPRINT",
            resolutionAuthority: "SOURCE_TRUTH",
            cardinality: "AGGREGATE",
            recoveryPolicy: "PROBE_AUTO_RESOLVE",
            manualResolution: false,
          },
          metric: { currentValue: 26, thresholdValue: 20, unit: "records" },
        }),
      ]);
    await mount(envelope(TEAM_ADMIN));
    const actions = await actionsFor("i-source-truth");
    // The capability IS held — this is not a permission story.
    expect(actions.has("resolve")).toBe(false);
    // …and everything the operator CAN honestly do is still there.
    expect(actions.has("acknowledge")).toBe(true);
    expect(actions.has("suppress")).toBe(true);
  });

  it("hides Resolve for a NO_DIRECT_RESOLUTION condition", async () => {
    incidentsReply = () =>
      list([
        incident({
          id: "i-platform",
          title: "Background processing fault",
          category: "WORKER",
          lifecycle: {
            sourceId: "job.background_failure",
            resolutionAuthority: "NO_DIRECT_RESOLUTION",
            audience: "TENANT_ADVISORY",
            recoveryPolicy: "NO_RECOVERY_SIGNAL",
            manualResolution: false,
          },
        }),
      ]);
    await mount(envelope(TEAM_ADMIN));
    const actions = await actionsFor("i-platform");
    expect(actions.has("resolve")).toBe(false);
    expect(actions.has("acknowledge")).toBe(true);
  });

  it("shows Resolve for an OPERATOR_DECISION condition, and only with the capability", async () => {
    const rows = () =>
      list([
        incident({
          id: "i-operator",
          title: "Intake delivery failed",
          category: "UPLOAD",
          lifecycle: {
            sourceId: "intake.delivery_failed",
            resolutionAuthority: "OPERATOR_DECISION",
            manualResolution: true,
          },
        }),
      ]);
    incidentsReply = rows;
    await mount(envelope(TEAM_ADMIN));
    expect((await actionsFor("i-operator")).has("resolve")).toBe(true);

    // The SAME condition, for a caller without the mutation capability.
    incidentsReply = rows;
    await mount(envelope(VIEWER));
    // A viewer has no action menu at all, so there is nothing to open.
    expect(qa("[data-ops-row-action]")).toHaveLength(0);
  });

  it("an older server that sends no lifecycle gets NO Resolve control", async () => {
    // Fail closed. A control that should not be there is a worse error than
    // one briefly missing, because the first teaches an operator that the
    // button does not mean anything.
    incidentsReply = () => list([incident({ id: "i-legacy", lifecycle: null })]);
    await mount(envelope(TEAM_ADMIN));
    const actions = await actionsFor("i-legacy");
    expect(actions.has("resolve")).toBe(false);
    expect(actions.has("acknowledge")).toBe(true);
  });

  it("the inspector and the row agree — one projection, not two", async () => {
    incidentsReply = () =>
      list([
        incident({
          id: "i-source-truth",
          title: "Report generation backlog",
          category: "REPORT",
          lifecycle: {
            sourceId: "pipeline.report_backlog",
            resolutionAuthority: "SOURCE_TRUTH",
            manualResolution: false,
          },
          metric: { currentValue: 26, thresholdValue: 20, unit: "records" },
        }),
      ]);
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q('[data-ops-row="i-source-truth"] [data-ops-open]')!);
    });
    await settle();
    const inspector = q("[data-ops-inspector]") as HTMLElement;
    expect(inspector).not.toBeNull();
    expect(inspector.querySelector('[data-ops-action="resolve"]')).toBeNull();
    // Acknowledge and Suppress survive — the contract removes ONE action.
    expect(
      inspector.querySelector('[data-ops-action="acknowledge"]'),
    ).not.toBeNull();
    expect(inspector.querySelector('[data-ops-action="suppress"]')).not.toBeNull();
    // And the absence is EXPLAINED rather than left as a gap an operator
    // would go looking for a permission to fill.
    const note = inspector.querySelector("[data-ops-resolution-note]");
    expect(note).not.toBeNull();
    expect(note!.textContent).toMatch(/closes itself when its source recovers/i);
  });

  it("remediation is projected independently of Resolve", async () => {
    // The conflation this closure removed: a real remediation on a condition
    // nobody may declare over. Pressing the button is allowed; calling the
    // backlog gone is not.
    incidentsReply = () =>
      list([
        incident({
          id: "i-source-truth",
          category: "REPORT",
          lifecycle: {
            sourceId: "pipeline.report_backlog",
            resolutionAuthority: "SOURCE_TRUTH",
            manualResolution: false,
          },
        }),
      ]);
    detailReply = () => ({
      incident: {
        ...incident({ id: "i-source-truth" }),
        timeline: [],
        timelineComplete: true,
      },
      remediation: {
        disposition: "DIRECT_REMEDIATION",
        actions: [
          {
            actionId: "report.regenerate_artifacts",
            label: "Regenerate report & verification package",
            description: "Re-runs the artifact pipeline for this record.",
            confirm: true,
            async: true,
          },
        ],
        deepLink: null,
        guidance: null,
        unsafeReason: null,
      },
    });
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(q('[data-ops-row="i-source-truth"] [data-ops-open]')!);
    });
    await settle();
    const inspector = q("[data-ops-inspector]") as HTMLElement;
    expect(inspector.querySelector('[data-ops-action="resolve"]')).toBeNull();
    expect(
      inspector.querySelector(
        '[data-ops-remediate="report.regenerate_artifacts"]',
      ),
    ).not.toBeNull();
  });
});

// ===========================================================================
// THE METRIC AND THE OCCURRENCE COUNT ARE DIFFERENT NUMBERS
// ===========================================================================

describe("Operations — the current value is live, labelled, and not the occurrence count", () => {
  it("renders the affected count, its unit and its threshold, beside a count-free title", async () => {
    incidentsReply = () =>
      list([
        incident({
          id: "i-backlog",
          title: "Report generation backlog",
          category: "REPORT",
          occurrences: 4,
          lifecycle: {
            sourceId: "pipeline.report_backlog",
            resolutionAuthority: "SOURCE_TRUTH",
            cardinality: "AGGREGATE",
            manualResolution: false,
          },
          metric: {
            currentValue: 26,
            previousValue: 30,
            delta: -4,
            thresholdValue: 20,
            criticalThresholdValue: 100,
            unit: "records",
          },
        }),
      ]);
    await mount(envelope(TEAM_ADMIN));
    const row = q('[data-ops-row="i-backlog"]') as HTMLElement;
    // THE TITLE CARRIES NO NUMBER. It used to read "(26)" and never change.
    expect(row.textContent).toContain("Report generation backlog");
    expect(
      row.querySelector(".opsw-condition__title")!.textContent,
    ).not.toMatch(/\d/);
    // THE VALUE IS ITS OWN, LABELLED FACT.
    const value = row.querySelector("[data-ops-metric-value]") as HTMLElement;
    expect(value).not.toBeNull();
    expect(value.getAttribute("data-ops-metric-value")).toBe("26");
    expect(value.textContent).toBe("26 affected records");
    expect(row.textContent).toContain("threshold 20");
    // …and the OBSERVATION count is a different number, said in words that
    // name it. "4 occurrences" named nothing — an occurrence of what, counted
    // how — while sitting one span away from "26 affected records", which is
    // also a 26-shaped number about the same row.
    expect(row.textContent).toContain("Observed in 4 checks");
    expect(row.textContent).not.toContain("occurrences");
  });

  it("AN AGE-BASED CONDITION READS AS A SPAN IN THE FLAT ROW TOO", async () => {
    // The grouped surface is not the only place a minute count reached a
    // person. The flat row handed every metric to one formatter, so a sampler
    // fifteen hours behind read "902 affected minutes" beside "threshold 15".
    incidentsReply = () =>
      list([
        incident({
          id: "i-telemetry",
          title: "Queue telemetry sampler delayed",
          category: "WORKER",
          occurrences: 3,
          lifecycle: {
            sourceId: "platform.telemetry_stale",
            resolutionAuthority: "SOURCE_TRUTH",
            cardinality: "AGGREGATE",
            manualResolution: false,
            metricContract: "AGE_THRESHOLD",
          },
          metric: {
            currentValue: 902,
            previousValue: null,
            delta: null,
            thresholdValue: 15,
            criticalThresholdValue: 60,
            unit: "minutes",
          },
        }),
      ]);
    await mount(envelope(TEAM_ADMIN));
    const row = q('[data-ops-row="i-telemetry"]') as HTMLElement;
    expect(row.textContent).toContain("last sample 15h 2m ago");
    expect(row.textContent).toContain("window 15m");
    expect(row.textContent).not.toContain("affected minutes");
    expect(row.textContent).not.toContain("902");
    expect(
      row.querySelector(".opsw-condition__title")!.textContent,
    ).not.toMatch(/[0-9]/);
  });

  it("says so when the last observation failed, instead of showing a stale value as current", async () => {
    incidentsReply = () =>
      list([
        incident({
          id: "i-stale",
          title: "Report generation backlog",
          category: "REPORT",
          lifecycle: {
            sourceId: "pipeline.report_backlog",
            resolutionAuthority: "SOURCE_TRUTH",
            manualResolution: false,
          },
          metric: {
            currentValue: 26,
            thresholdValue: 20,
            unit: "records",
            stale: true,
          },
        }),
      ]);
    await mount(envelope(TEAM_ADMIN));
    const row = q('[data-ops-row="i-stale"]') as HTMLElement;
    expect(row.querySelector('[data-ops-metric-stale="true"]')).not.toBeNull();
    expect(row.textContent).toMatch(/last confirmed/i);
    // The value is still shown — it was true when it was read. It is not
    // replaced with a zero, which would render as recovery.
    expect(row.textContent).toContain("26 affected records");
  });

  it("bounds a five-figure Enterprise value in the row and keeps the exact one in the inspector", async () => {
    incidentsReply = () =>
      list([
        incident({
          id: "i-enterprise",
          title: "Report generation backlog",
          category: "REPORT",
          lifecycle: {
            sourceId: "pipeline.report_backlog",
            resolutionAuthority: "SOURCE_TRUTH",
            manualResolution: false,
          },
          metric: {
            currentValue: 41338,
            thresholdValue: 20,
            criticalThresholdValue: 100,
            unit: "records",
          },
        }),
      ]);
    detailReply = () => ({
      incident: {
        ...incident({ id: "i-enterprise" }),
        timeline: [],
        timelineComplete: true,
      },
      remediation: {
        disposition: "READ_ONLY_GUIDANCE",
        actions: [],
        deepLink: null,
        guidance: null,
        unsafeReason: null,
      },
    });
    await mount(envelope(TEAM_ADMIN));
    const row = q('[data-ops-row="i-enterprise"]') as HTMLElement;
    // A floor, not an exact figure that would be wrong by the time it is read.
    expect(row.textContent).toContain("2,000+ affected records");
    expect(row.textContent).not.toContain("41,338");

    await act(async () => {
      fireEvent.click(q('[data-ops-row="i-enterprise"] [data-ops-open]')!);
    });
    await settle();
    const inspector = q("[data-ops-inspector]") as HTMLElement;
    const exact = inspector.querySelector("[data-ops-metric-exact]");
    expect(exact).not.toBeNull();
    expect(exact!.getAttribute("data-ops-metric-exact")).toBe("41338");
    expect(exact!.textContent).toContain("41,338");
  });

  it("a source with no metric renders no metric, rather than a zero", async () => {
    incidentsReply = () =>
      list([
        incident({
          id: "i-record",
          lifecycle: {
            sourceId: "evidence_integrity.tsa_failed",
            resolutionAuthority: "SOURCE_TRUTH",
            cardinality: "PER_RECORD",
            manualResolution: false,
          },
        }),
      ]);
    await mount(envelope(TEAM_ADMIN));
    const row = q('[data-ops-row="i-record"]') as HTMLElement;
    expect(row.querySelector("[data-ops-metric-value]")).toBeNull();
    expect(row.textContent).not.toContain("affected records");
  });
});

// ===========================================================================
// THE THREE REFUSALS REACH THE OPERATOR, AND SAY DIFFERENT THINGS
// ===========================================================================

describe("Operations — a stale client's Resolve is refused with the right sentence", () => {
  /** A row that DOES offer Resolve, so the refusal can be reached at all. */
  const resolvable = () =>
    list([
      incident({
        id: "i-operator",
        category: "UPLOAD",
        lifecycle: {
          sourceId: "intake.delivery_failed",
          resolutionAuthority: "OPERATOR_DECISION",
          manualResolution: true,
        },
      }),
    ]);

  it.each([
    [
      "CONDITION_STILL_ACTIVE",
      "ops-condition-still-active",
      /still being reported by its source/i,
    ],
    [
      "CONDITION_ACTIVITY_UNKNOWN",
      "ops-condition-activity-unknown",
      /could not confirm that the underlying condition has recovered/i,
    ],
    [
      "CONDITION_NOT_DIRECTLY_RESOLVABLE",
      "ops-condition-not-directly-resolvable",
      /owned by the surface that reported it/i,
    ],
  ])("%s opens its OWN notice", async (code, testId, copy) => {
    incidentsReply = resolvable;
    mutationReply = () => apiCodeFailure(409, code);
    await mount(envelope(TEAM_ADMIN));
    const trigger = within(
      q('[data-ops-row="i-operator"]') as HTMLElement,
    ).getByRole("button", { name: /Actions for/ });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await settle();
    const control = q('[data-ops-row-action="resolve"]') as HTMLElement;
    expect(control, `no Resolve control to press for ${code}`).not.toBeNull();
    control.focus();
    await act(async () => {
      fireEvent.click(control);
    });
    await settleTimers();
    const dialog = q(`[data-confirm-action-modal="${testId}"]`) as HTMLElement;
    expect(dialog, `${code} did not open its notice`).not.toBeNull();
    expect(dialog.textContent).toMatch(copy);
    // No provider name, no SQL, no identifier — the three things a refusal
    // must never carry into a browser.
    expect(dialog.textContent).not.toMatch(/select |prisma|postgres|relation/i);
  });
});

// ===========================================================================
// THE TOUCHED CONTROLS DO NOT OVERFLOW, AND DO NOT ASSUME A DIRECTION
// ===========================================================================
//
// jsdom applies no layout, so "does it overflow" cannot be measured here and
// asserting it would be theatre. What CAN be held is the two structural
// properties that decide the answer, and both of them are things a future edit
// could quietly remove:
//
//   * the new metric spans are children of the WRAPPING meta container, so a
//     long value reflows instead of widening the row;
//   * the stylesheet uses logical properties only, so the row reads correctly
//     in an RTL locale rather than putting the threshold on the wrong side.

describe("Operations — the metric and the resolution note are layout-safe", () => {
  it("the metric spans sit inside the wrapping condition meta line", async () => {
    incidentsReply = () =>
      list([
        incident({
          id: "i-wrap",
          title: "Report generation backlog",
          category: "REPORT",
          lifecycle: {
            sourceId: "pipeline.report_backlog",
            resolutionAuthority: "SOURCE_TRUTH",
            manualResolution: false,
          },
          metric: {
            currentValue: 41338,
            thresholdValue: 20,
            unit: "records",
            stale: true,
          },
        }),
      ]);
    await mount(envelope(TEAM_ADMIN));
    const row = q('[data-ops-row="i-wrap"]') as HTMLElement;
    const meta = row.querySelector(".opsw-condition__meta") as HTMLElement;
    expect(meta).not.toBeNull();
    // Every added element is INSIDE the wrapping container. A metric rendered
    // as a sibling of the title would be a fixed-width row on a phone.
    for (const cls of [
      ".opsw-condition__metric",
      ".opsw-condition__threshold",
      ".opsw-condition__metric-stale",
    ]) {
      const el = row.querySelector(cls);
      expect(el, `${cls} is missing`).not.toBeNull();
      expect(meta.contains(el), `${cls} escaped the wrapping meta line`).toBe(
        true,
      );
    }
  });

  it("the Operations stylesheet declares no physical left/right properties", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // Resolved from the runner's root rather than from `import.meta.url`: this
    // suite runs under jsdom, where the module URL is not a file: URL.
    const css = readFileSync(
      resolve(process.cwd(), "app/(app)/operations/operations.css"),
      "utf8",
    );
    // `margin-left`, `padding-right`, `border-left`, `text-align: left` and
    // friends all pin a layout to one reading direction. The route already
    // used logical properties throughout; this keeps it that way.
    const physical =
      /(^|[\s;{])(margin|padding|border)-(left|right)\s*:|(^|[\s;{])(left|right)\s*:\s*(?!auto)|text-align\s*:\s*(left|right)/gm;
    const hits = css.match(physical) ?? [];
    expect(hits, `physical direction properties: ${hits.join(", ")}`).toEqual([]);
  });
});

// ===========================================================================
// THE GROUPED QUEUE, RENDERED
// ===========================================================================
//
// The server computed groups for a release and nothing rendered them, so a
// workspace with five thousand identical rows had five thousand rows. These
// cases hold the correction and its two honesty properties: the counts are
// two DIFFERENT numbers said differently, and every individual condition is
// still reachable through the drill-down.

function group(over: Partial<IncidentGroup> & { groupKey: string }): IncidentGroup {
  return {
    sourceId: over.sourceId ?? "evidence_integrity.tsa_failed",
    category: "EVIDENCE_INTEGRITY",
    // COUNT-FREE. The server sends the source contract's own label now; a
    // fixture carrying "…for 5000 records" would be pinning the defect.
    title: "Trusted timestamping failed",
    conditionCount: 5000,
    affectedRecordCount: 5000,
    affectedUnit: "records",
    observations: 5000,
    durationSeconds: null,
    lastObservedAtUtc: null,
    severity: "CRITICAL",
    statusPosture: "OPEN",
    firstSeenAtUtc: HOURS_AGO(30),
    lastSeenAtUtc: HOURS_AGO(1),
    latestActivityAtUtc: HOURS_AGO(1),
    assignedCount: 0,
    failureGroups: [],
    affectedSample: [],
    hasMoreAffected: true,
    availableActions: ["acknowledge", "assign", "suppress"],
    metric: null,
    ...over,
  };
}

function affectedRecord(id: string, evidenceId: string | null = null) {
  return {
    conditionId: id,
    evidenceId,
    title: "Trusted timestamp failed",
    severity: "HIGH",
    status: "OPEN",
    firstSeenAtUtc: HOURS_AGO(3),
    lastSeenAtUtc: HOURS_AGO(1),
    occurrenceCount: 1,
    assignedOperatorUserId: null,
  };
}

describe("Operations — the grouped queue is the default", () => {
  beforeEach(() => {
    groupsReply = () => ({
      groups: [
        group({ groupKey: "evidence_integrity.tsa_failed" }),
        group({
          groupKey: "pipeline.report_backlog",
          sourceId: "pipeline.report_backlog",
          category: "REPORT",
          title: "Report generation backlog",
          conditionCount: 1,
          affectedRecordCount: 26,
          affectedUnit: "records",
          observations: 4,
          severity: "HIGH",
          metric: {
            currentValue: 26,
            unit: "records",
            thresholdValue: 20,
            criticalThresholdValue: 60,
            observedAtUtc: HOURS_AGO(1),
            stale: false,
            contract: "AGGREGATE_THRESHOLD",
          },
        }),
      ],
      totals: { groups: 2, conditions: 5001 },
      conservation: { conditions: 5001, grouped: 5001 },
      completeness: { complete: true, mayAssertAllClear: true },
    });
    affectedReply = () => ({
      records: [affectedRecord("c-1", "99999999-9999-4999-8999-999999999999")],
      pagination: { nextCursor: "c-1", returned: 1 },
      completeness: { complete: false },
    });
  });

  it("renders one row per SOURCE, not one per condition", async () => {
    await mount(envelope(TEAM_ADMIN), "grouped");
    const groups = qa("[data-ops-group]");
    // TWO rows for 5,001 conditions. The flood is the defect; this is the fix.
    expect(groups).toHaveLength(2);
    expect(
      groups.map((g) => g.getAttribute("data-ops-group-source")),
    ).toEqual(["evidence_integrity.tsa_failed", "pipeline.report_backlog"]);
  });

  it("LEADS WITH THE QUANTITY AN OPERATOR ACTS ON, and its threshold", async () => {
    await mount(envelope(TEAM_ADMIN), "grouped");
    const backlog = q('[data-ops-group="pipeline.report_backlog"]') as HTMLElement;
    // ONE condition, TWENTY-SIX records. Both are true and only one of them is
    // what an operator does something about, so the row shows that one and the
    // exact condition count lives in the Inspector.
    expect(
      backlog.querySelector("[data-ops-group-affected]")!.textContent,
    ).toContain("26 affected records");
    // The THRESHOLD, separately — "26" is not actionable without it, and it
    // used to be visible only inside the condition's own summary paragraph.
    expect(backlog.textContent).toContain("threshold 20");
    // The row does NOT also print "1 condition" beside it: two counts said
    // side by side under near-identical labels read as a contradiction.
    expect(backlog.querySelector("[data-ops-group-conditions]")).toBeNull();
  });

  it("A GROUP WHOSE COUNTS AGREE SAYS THE NUMBER ONCE", async () => {
    // The exact shape production rendered: "34 conditions - 34 affected
    // records", one fact printed twice under two labels, on the row where the
    // two numbers are always equal because each condition IS one record.
    await mount(envelope(TEAM_ADMIN), "grouped");
    const tsa = q(
      '[data-ops-group="evidence_integrity.tsa_failed"]',
    ) as HTMLElement;
    expect(tsa.querySelector("[data-ops-group-affected]")).not.toBeNull();
    expect(tsa.querySelector("[data-ops-group-conditions]")).toBeNull();
  });

  it("THE HEADER SAYS HOW MANY GROUPS AND HOW MANY CONDITIONS", async () => {
    // It used to read "38 conditions" over a list of five rows — the FLAT
    // list's length, rendered regardless of which surface was on screen, with
    // nothing to say how the two numbers were related.
    await mount(envelope(TEAM_ADMIN), "grouped");
    expect(document.body.textContent).toContain("2 groups");
    expect(document.body.textContent).toContain("5,001 conditions");
  });

  it("AN AGE RENDERS AS A SPAN, NEVER AS A RAW MINUTE COUNT", async () => {
    groupsReply = () => ({
      groups: [
        group({
          groupKey: "platform.telemetry_stale",
          sourceId: "platform.telemetry_stale",
          category: "WORKER",
          title: "Queue telemetry sampler delayed",
          conditionCount: 1,
          affectedRecordCount: null,
          affectedUnit: null,
          observations: 3,
          // 902 minutes. It reached operators as "(902m)" inside the title,
          // and as "902 affected records" in the metadata beside it.
          durationSeconds: 902 * 60,
          lastObservedAtUtc: HOURS_AGO(1),
          severity: "WARNING",
          metric: {
            currentValue: 902,
            unit: "minutes",
            thresholdValue: 15,
            criticalThresholdValue: 60,
            observedAtUtc: HOURS_AGO(1),
            stale: false,
            contract: "AGE_THRESHOLD",
          },
        }),
      ],
      totals: { groups: 1, conditions: 1 },
      conservation: { conditions: 1, grouped: 1 },
      completeness: { complete: true, mayAssertAllClear: true },
    });
    await mount(envelope(TEAM_ADMIN), "grouped");
    const row = q('[data-ops-group="platform.telemetry_stale"]') as HTMLElement;
    expect(row.textContent).toContain("Last telemetry sample 15h 2m ago");
    expect(row.textContent).not.toContain("902");
    // An age is NOT a population: nothing on this row claims affected records.
    expect(row.querySelector("[data-ops-group-affected]")).toBeNull();
    // ...and the title carries no number at all.
    expect(row.querySelector(".opsw-group__title")!.textContent).not.toMatch(
      /[0-9]/,
    );
  });

  it("A RETRY STORM COUNTS CONDITIONS, AND SAYS SO", async () => {
    groupsReply = () => ({
      groups: [
        group({
          groupKey: "queue.retry_storm",
          sourceId: "queue.retry_storm",
          category: "WORKER",
          title: "Queue retry storm",
          conditionCount: 1,
          affectedRecordCount: 36,
          // The unit is the SOURCE's. Hard-coding "records" — which both
          // halves of the stack used to do — described thirty-six recurring
          // conditions as thirty-six affected evidence records.
          affectedUnit: "conditions",
          observations: 7,
          severity: "HIGH",
          metric: {
            currentValue: 36,
            unit: "conditions",
            thresholdValue: 1,
            criticalThresholdValue: 3,
            observedAtUtc: HOURS_AGO(1),
            stale: false,
            contract: "AGGREGATE_THRESHOLD",
          },
        }),
      ],
      totals: { groups: 1, conditions: 1 },
      conservation: { conditions: 1, grouped: 1 },
      completeness: { complete: true, mayAssertAllClear: true },
    });
    await mount(envelope(TEAM_ADMIN), "grouped");
    const row = q('[data-ops-group="queue.retry_storm"]') as HTMLElement;
    expect(row.textContent).toContain("36 repeatedly observed conditions");
    expect(row.textContent).not.toContain("36 affected records");
    expect(
      row
        .querySelector("[data-ops-group-affected]")!
        .getAttribute("data-ops-group-affected-unit"),
    ).toBe("conditions");
  });

  it("GROUPED STATUS IS COLOURED TEXT, NOT A SECOND CAPSULE", async () => {
    await mount(envelope(TEAM_ADMIN), "grouped");
    for (const key of [
      "evidence_integrity.tsa_failed",
      "pipeline.report_backlog",
    ]) {
      const row = q('[data-ops-group="' + key + '"]') as HTMLElement;
      const status = row.querySelector("[data-ops-group-status]") as HTMLElement;
      expect(status, key + " lost its status").not.toBeNull();
      // The shared text primitive, whose own rule declares no background, no
      // border and no shadow — and which the flat table already uses, so there
      // is no grouped-only status style to drift from it.
      expect(status.classList.contains("app-status-text")).toBe(true);
      expect(status.classList.contains("app-status-badge")).toBe(false);
      // THE LABEL SURVIVES. Removing the capsule must not remove the word.
      expect(status.textContent!.trim().length).toBeGreaterThan(0);
      // The tone still arrives, so colour still carries the meaning it did.
      expect(status.getAttribute("data-tone")).toBeTruthy();
      // The SEVERITY keeps its filled capsule: one mark to scan a queue by.
      const severity = row.querySelector(
        "[data-ops-group-severity]",
      ) as HTMLElement;
      expect(severity.classList.contains("app-status-badge")).toBe(true);
    }
  });

  it("every status posture renders as text with its own tone", async () => {
    for (const posture of ["OPEN", "ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"]) {
      groupsReply = () => ({
        groups: [
          group({
            groupKey: "evidence_integrity.tsa_failed",
            statusPosture: posture,
          }),
        ],
        totals: { groups: 1, conditions: 5000 },
        conservation: { conditions: 5000, grouped: 5000 },
        completeness: { complete: true, mayAssertAllClear: true },
      });
      await mount(envelope(TEAM_ADMIN), "grouped");
      const status = q("[data-ops-group-status]") as HTMLElement;
      expect(status.getAttribute("data-ops-group-status"), posture).toBe(posture);
      expect(status.classList.contains("app-status-text"), posture).toBe(true);
      expect(status.getAttribute("data-tone"), posture).toBeTruthy();
      expect(status.textContent!.trim().length, posture).toBeGreaterThan(0);
    }
  });

  it("bounds a five-figure count in the row and keeps the exact one in the panel", async () => {
    await mount(envelope(TEAM_ADMIN), "grouped");
    const tsa = q(
      '[data-ops-group="evidence_integrity.tsa_failed"]',
    ) as HTMLElement;
    // A floor, not an exact figure that will be wrong by the time it is read.
    expect(tsa.textContent).toContain("2,000+ affected records");
    expect(tsa.textContent).not.toContain("5,000 affected records");

    await act(async () => {
      fireEvent.click(
        q('[data-ops-group-open-button="evidence_integrity.tsa_failed"]')!,
      );
    });
    await settle();
    const panel = q("[data-ops-group-inspector]") as HTMLElement;
    expect(panel).not.toBeNull();
    expect(
      panel.querySelector("[data-ops-group-exact-conditions]")!.textContent,
    ).toContain("5,000");
  });

  it("opening a group loads its affected records", async () => {
    await mount(envelope(TEAM_ADMIN), "grouped");
    await act(async () => {
      fireEvent.click(
        q('[data-ops-group-open-button="evidence_integrity.tsa_failed"]')!,
      );
    });
    await settle();

    // The drill-down was requested, scoped to the workspace and the group.
    const drill = requestLog.filter((r) =>
      r.path.includes("/incident-groups/") && r.path.includes("/affected"),
    );
    expect(drill.length).toBeGreaterThanOrEqual(1);
    expect(drill[0].path).toContain(
      encodeURIComponent("evidence_integrity.tsa_failed"),
    );
    expect(drill[0].path).toContain(`teamId=${WS}`);

    expect(q("[data-ops-affected-row='c-1']")).not.toBeNull();
    // …and a record an authorized operator may open.
    expect(q("[data-ops-affected-link]")).not.toBeNull();
    // More to come, so the control to fetch it is offered.
    expect(q("[data-ops-affected-more]")).not.toBeNull();
  });

  it("paging the drill-down APPENDS rather than replacing", async () => {
    let page = 0;
    affectedReply = () => {
      page += 1;
      return page === 1
        ? {
            records: [affectedRecord("c-1")],
            pagination: { nextCursor: "c-1", returned: 1 },
          }
        : {
            records: [affectedRecord("c-2")],
            pagination: { nextCursor: null, returned: 1 },
          };
    };
    await mount(envelope(TEAM_ADMIN), "grouped");
    await act(async () => {
      fireEvent.click(
        q('[data-ops-group-open-button="evidence_integrity.tsa_failed"]')!,
      );
    });
    await settle();
    await act(async () => {
      fireEvent.click(q("[data-ops-affected-more]")!);
    });
    await settle();

    // The rows an operator has already read must not vanish under them.
    expect(q("[data-ops-affected-row='c-1']")).not.toBeNull();
    expect(q("[data-ops-affected-row='c-2']")).not.toBeNull();
    // …and the end of the list withdraws the control.
    expect(q("[data-ops-affected-more]")).toBeNull();
  });

  it("a failed drill-down shows a bounded message, never the raw error", async () => {
    affectedReply = () => apiFailure(500);
    await mount(envelope(TEAM_ADMIN), "grouped");
    await act(async () => {
      fireEvent.click(
        q('[data-ops-group-open-button="evidence_integrity.tsa_failed"]')!,
      );
    });
    await settle();
    const err = q("[data-ops-affected-error]") as HTMLElement;
    expect(err).not.toBeNull();
    expect(err.textContent).not.toMatch(/500|prisma|postgres|select /i);
  });

  it("the flat list is one toggle away, and reaches the same conditions", async () => {
    await mount(envelope(TEAM_ADMIN), "grouped");
    expect(qa("[data-ops-group]").length).toBe(2);
    await act(async () => {
      fireEvent.click(q('[data-ops-view="flat"]')!);
    });
    await settle();
    // A grouped view that could not be left would have HIDDEN the individual
    // conditions, which is the defect per-record fingerprints exist to
    // prevent.
    expect(qa("[data-ops-group]").length).toBe(0);
    expect(qa("[data-ops-row]").length).toBeGreaterThan(0);
  });

  it("Personal and Enterprise render the SAME grouped surface", async () => {
    for (const caps of [PERSONAL_PRO, TEAM_ADMIN]) {
      cleanup();
      await mount(envelope(caps), "grouped");
      expect(qa("[data-ops-group]").length).toBe(2);
      // No plan fork: the same component, the same two rows, the same counts.
      expect(
        q('[data-ops-group="pipeline.report_backlog"]')!.textContent,
      ).toContain("26 affected records");
    }
  });

  it("no group offers a bulk Resolve", async () => {
    await mount(envelope(TEAM_ADMIN), "grouped");
    await act(async () => {
      fireEvent.click(
        q('[data-ops-group-open-button="evidence_integrity.tsa_failed"]')!,
      );
    });
    await settle();
    const panel = q("[data-ops-group-inspector]") as HTMLElement;
    // Source-truth conditions close themselves when the source recovers, so a
    // control that closed five thousand of them by hand would be both unsafe
    // and unnecessary.
    expect(panel.textContent).not.toMatch(/\bResolve\b/);
  });
});

// ===========================================================================
// AN UNREGISTERED CONDITION OFFERS NOTHING IT CANNOT HONOUR
// ===========================================================================

describe("Operations — an unregistered condition has no Resolve", () => {
  it("hides Resolve for a condition whose source nothing claims", async () => {
    incidentsReply = () =>
      list([
        incident({
          id: "i-unknown",
          title: "A condition nobody registered",
          lifecycle: {
            sourceId: "unregistered.condition",
            sourceMatch: "UNREGISTERED",
            resolutionAuthority: "NO_DIRECT_RESOLUTION",
            audience: "TENANT_ADVISORY",
            recoveryPolicy: "NO_RECOVERY_SIGNAL",
            manualResolution: false,
          },
        }),
      ]);
    await mount(envelope(TEAM_ADMIN), "grouped");
    await act(async () => {
      fireEvent.click(q('[data-ops-view="flat"]')!);
    });
    await settle();
    const trigger = within(
      q('[data-ops-row="i-unknown"]') as HTMLElement,
    ).getByRole("button", { name: /Actions for/ });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await settle();
    const actions = new Set(
      qa("[data-ops-row-action]").map((el) =>
        el.getAttribute("data-ops-row-action"),
      ),
    );
    // Nothing knows what "over" would mean for this condition…
    expect(actions.has("resolve")).toBe(false);
    // …and everything an operator CAN honestly do survives.
    expect(actions.has("acknowledge")).toBe(true);
    expect(actions.has("suppress")).toBe(true);
  });
});

describe("Operations — grouped is the PRODUCT default", () => {
  it("a fresh mount renders groups with no toggle pressed", async () => {
    // The `mount` helper above defaults to the FLAT surface because that is
    // what sixty pre-existing cases are about — the table, the row menus, the
    // condition inspector — and teaching every one of them to press a toggle
    // would be churn that proves nothing.
    //
    // The PRODUCT's default is the opposite, and it is asserted here, once,
    // without the helper: a workspace with five thousand identical rows and no
    // grouping is the defect, so grouping cannot be something an operator has
    // to find.
    groupsReply = () => ({
      groups: [group({ groupKey: "evidence_integrity.tsa_failed" })],
      conservation: { conditions: 5000, grouped: 5000 },
      completeness: { complete: true, mayAssertAllClear: true },
    });
    cleanup();
    render(
      <PlatformContextProvider testEnvelope={envelope(TEAM_ADMIN) as never}>
        <ToastProvider>
          <ConfirmActionProvider>
            <OperationsPage />
          </ConfirmActionProvider>
        </ToastProvider>
      </PlatformContextProvider>,
    );
    await settle();

    expect(qa("[data-ops-group]").length).toBe(1);
    expect(qa("[data-ops-row]").length).toBe(0);
    // …and the toggle says so, so a screen reader is told which view is live.
    expect(
      q('[data-ops-view="grouped"]')!.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("the grouped queue never renders an all-clear over real groups", async () => {
    // The flat list is a BOUNDED read and the grouped read is its own. A
    // grouped surface that decided emptiness from the flat rows would show
    // "Workspace operations are clear" whenever the two disagreed — a false
    // all-clear produced by asking the wrong list.
    incidentsReply = () => list([]);
    groupsReply = () => ({
      groups: [group({ groupKey: "evidence_integrity.tsa_failed" })],
      conservation: { conditions: 5000, grouped: 5000 },
      completeness: { complete: true, mayAssertAllClear: true },
    });
    await mount(envelope(TEAM_ADMIN), "grouped");
    expect(q('[data-ops-empty="clear"]')).toBeNull();
    expect(qa("[data-ops-group]").length).toBe(1);
  });
});

describe("Operations — the grouped surface is layout- and direction-safe", () => {
  it("every count and label sits inside a WRAPPING container", async () => {
    groupsReply = () => ({
      groups: [
        // The WIDEST row the surface can produce: an aggregate group carries a
        // count, a unit, a threshold, a staleness caveat, an owner tally, a
        // status and a relative time on one line. If anything reflows badly on
        // a phone, it is this one.
        group({
          groupKey: "pipeline.report_backlog",
          sourceId: "pipeline.report_backlog",
          category: "REPORT",
          title: "Report generation backlog",
          conditionCount: 1,
          affectedRecordCount: 26,
          affectedUnit: "records",
          observations: 4,
          assignedCount: 1,
          severity: "HIGH",
          metric: {
            currentValue: 26,
            unit: "records",
            thresholdValue: 20,
            criticalThresholdValue: 60,
            observedAtUtc: HOURS_AGO(2),
            stale: true,
            contract: "AGGREGATE_THRESHOLD",
          },
          failureGroups: [
            { failureClass: "PROVIDER_TIMEOUT", label: "Provider timeout", count: 30 },
            { failureClass: "IMPRINT_MISMATCH", label: "Imprint mismatch", count: 4 },
          ],
        }),
      ],
      totals: { groups: 1, conditions: 1 },
      conservation: { conditions: 1, grouped: 1 },
      completeness: { complete: true, mayAssertAllClear: true },
    });
    await mount(envelope(TEAM_ADMIN), "grouped");
    const row = q('[data-ops-group="pipeline.report_backlog"]') as HTMLElement;
    const meta = row.querySelector(".opsw-group__meta") as HTMLElement;
    expect(meta).not.toBeNull();
    // jsdom applies no layout, so overflow cannot be MEASURED here and
    // asserting it would be theatre. What can be held is the structural
    // property that decides the answer: every count is inside the wrapping
    // meta line, so a long label reflows on a phone instead of widening the
    // row.
    for (const sel of [
      "[data-ops-group-affected]",
      "[data-ops-group-threshold]",
      "[data-ops-group-metric-stale]",
      ".opsw-group__owned",
      ".opsw-group__activity",
    ]) {
      const el = row.querySelector(sel);
      expect(el, `${sel} is missing`).not.toBeNull();
      expect(meta.contains(el), `${sel} escaped the wrapping meta line`).toBe(true);
    }

    /*
     * STATUS LIVES IN THE HEAD NOW, AND THE HEAD WRAPS TOO.
     *
     * It was moved out of the metadata sentence to the row's trailing edge on
     * purpose, so the same word sits in the same place on every row and can be
     * scanned down the list. That makes "inside .opsw-group__meta" the wrong
     * container to name — but NOT the wrong property to hold: what protects a
     * phone from a widened row is that the container wraps, so that is what is
     * asserted, for both containers, from the stylesheet that decides it.
     */
    const head = row.querySelector(".opsw-group__head") as HTMLElement;
    const status = row.querySelector("[data-ops-group-status]");
    expect(status, "[data-ops-group-status] is missing").not.toBeNull();
    expect(
      head.contains(status),
      "[data-ops-group-status] escaped the wrapping head line",
    ).toBe(true);

    const { readFileSync: readCss } = await import("node:fs");
    const { resolve: resolveCss } = await import("node:path");
    const css = readCss(
      resolveCss(process.cwd(), "app/(app)/operations/operations.css"),
      "utf8",
    );
    for (const container of [".opsw-group__head", ".opsw-group__meta"]) {
      const rule = css.slice(css.indexOf(`${container} {`));
      expect(
        rule.slice(0, rule.indexOf("}")),
        `${container} must wrap, or a long label widens the row`,
      ).toContain("flex-wrap: wrap");
    }
  });

  it("the grouped stylesheet declares no physical left/right properties", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // Resolved from the runner's root: this suite runs under jsdom, where the
    // module URL is not a file: URL.
    const css = readFileSync(
      resolve(process.cwd(), "app/(app)/operations/operations.css"),
      "utf8",
    );
    // `margin-left`, `padding-right`, `text-align: left` and friends pin a
    // layout to one reading direction. The route used logical properties
    // throughout before this change and still does after it.
    const physical =
      /(^|[\s;{])(margin|padding|border)-(left|right)\s*:|(^|[\s;{])(left|right)\s*:\s*(?!auto)|text-align\s*:\s*(left|right)/gm;
    const hits = css.match(physical) ?? [];
    expect(hits, `physical direction properties: ${hits.join(", ")}`).toEqual([]);
    // …and the new rules are actually present, so this is not a vacuous pass
    // over a stylesheet that never gained them.
    expect(css).toContain(".opsw-group__meta");
    expect(css).toContain(".opsw-affected__meta");
  });
});

// ===========================================================================
// 12. THE WARNING CARD, THE GRID, AND THE ONE TONE TABLE
//
// Three changes with one property between them: a semantic value has exactly
// one count and exactly one colour, wherever it is rendered. The tests below
// read the CANONICAL tables and then check the DOM the page actually produced,
// because either half alone proves nothing — a table nobody renders is a
// wish, and a rendered colour nobody derived is a coincidence.
// ===========================================================================

describe("Operations — the Warning card", () => {
  it("1. the third severity is on the strip", async () => {
    await mount(envelope(TEAM_ADMIN));
    expect(metric("warning")).not.toBeNull();
    expect(
      metric("warning")?.querySelector(".app-metric-card__label")?.textContent,
    ).toBe("Warning");
  });

  it("2. its count is the SERVER's field, never counted in the browser", async () => {
    // Seven Warning conditions in the projection and NONE in the loaded page:
    // a card that counted the rows it can see would render 0 here. The
    // projection is a workspace-wide scan; the table is one page of a keyset
    // collection and would disagree with itself on page two.
    summaryReply = () => summary({ warning: 7 });
    incidentsReply = () => list([]);
    await mount(envelope(TEAM_ADMIN));
    expect(
      metric("warning")?.querySelector(".app-metric-card__value")?.textContent,
    ).toBe("7");
    expect(metric("warning")?.getAttribute("data-ops-metric-value")).toBe("7");
  });

  it("3. IT STAYS VISIBLE AT ZERO", async () => {
    // A zero is a fact — "nothing at this severity" — and the strip must not
    // develop holes where the good news is. A card that disappears at zero
    // also moves every card after it, which is how a strip becomes unreadable
    // at exactly the moment it is reporting calm.
    summaryReply = () => summary({ warning: 0 });
    await mount(envelope(TEAM_ADMIN));
    expect(metric("warning")).not.toBeNull();
    expect(
      metric("warning")?.querySelector(".app-metric-card__value")?.textContent,
    ).toBe("0");
  });

  it("4. a missing field is an em dash, never a fabricated zero", async () => {
    summaryReply = () => {
      const s = summary() as { summary: Record<string, unknown> };
      delete s.summary.warning;
      return s;
    };
    await mount(envelope(TEAM_ADMIN));
    expect(
      metric("warning")?.querySelector(".app-metric-card__value")?.textContent,
    ).toBe("—");
  });

  it("5. it is a real accessible filter button", async () => {
    await mount(envelope(TEAM_ADMIN));
    const card = metric("warning") as HTMLButtonElement;
    expect(card.tagName).toBe("BUTTON");
    expect(card.getAttribute("type")).toBe("button");
    expect(card.getAttribute("aria-pressed")).toBe("false");
    expect(card.getAttribute("aria-describedby")).toBeTruthy();
    // The accessible name carries the label and the count, not a colour.
    expect(card.textContent).toContain("Warning");
  });

  it("6. pressing it sets the canonical severity filter and re-reads", async () => {
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(metric("warning") as HTMLButtonElement);
    });
    await settle();
    expect(lastListQuery()).toMatch(/severity=WARNING/);
    // …and it clears what it does not imply.
    expect(lastListQuery()).not.toMatch(/sla=/);
    expect(lastListQuery()).not.toMatch(/owner=/);
  });

  it("7. THE SELECTION IS IN THE URL, so the view is shareable", async () => {
    await mount(envelope(TEAM_ADMIN));
    await act(async () => {
      fireEvent.click(metric("warning") as HTMLButtonElement);
    });
    await settle();
    expect(replaced.at(-1)).toContain("severity=WARNING");
  });

  it("8. AND A RELOAD OF THAT URL RESTORES IT", async () => {
    // The other half of the contract: a pasted link has to come back to the
    // same view, with the same card showing as the one driving the queue.
    currentSearch = "severity=WARNING";
    await mount(envelope(TEAM_ADMIN));
    expect(lastListQuery()).toMatch(/severity=WARNING/);
    expect(metric("warning")?.getAttribute("aria-pressed")).toBe("true");
    expect(metric("critical")?.getAttribute("aria-pressed")).toBe("false");
    expect(metric("high")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("9. the severities read Critical, High, Warning in that order", async () => {
    await mount(envelope(TEAM_ADMIN));
    const keys = qa("[data-ops-metric]").map((el) =>
      el.getAttribute("data-ops-metric"),
    );
    const at = (k: string) => keys.indexOf(k);
    expect(at("critical")).toBeGreaterThan(-1);
    expect(at("critical")).toBeLessThan(at("high"));
    expect(at("high")).toBeLessThan(at("warning"));
    // The rendered order IS the canonical order, filtered — not a second one.
    expect(keys).toEqual(
      QUEUE_METRIC_ORDER.filter((k) => keys.includes(k)),
    );
  });

  it("10. THERE IS EXACTLY ONE WARNING METRIC", async () => {
    // A second card, a second counter or a browser-side tally would each show
    // up as another node claiming the same fact.
    summaryReply = () => summary({ warning: 4, operatorCount: 3 });
    await mount(envelope(TEAM_ADMIN));
    expect(qa('[data-ops-metric="warning"]').length).toBe(1);
    expect(
      QUEUE_METRIC_ORDER.filter((k) => k === "warning").length,
    ).toBe(1);
  });

  it("11. the card count comes from the vocabulary, and ownership still governs", async () => {
    // Capability and workspace composition are untouched by this change: the
    // sole-operator strip still drops the ownership pair, and the shared one
    // still keeps it.
    summaryReply = () => summary({ operatorCount: 1 });
    await mount(envelope(TEAM_ADMIN));
    const sole = qa("[data-ops-metric]").map((el) =>
      el.getAttribute("data-ops-metric"),
    );
    expect(sole).toContain("warning");
    expect(sole).not.toContain("assignedToMe");
    expect(sole.length).toBe(
      QUEUE_METRIC_ORDER.filter(
        (k) => !QUEUE_METRIC_VOCABULARY[k].collaborative,
      ).length,
    );

    summaryReply = () => summary({ operatorCount: 3 });
    await mount(envelope(TEAM_ADMIN));
    const shared = qa("[data-ops-metric]").map((el) =>
      el.getAttribute("data-ops-metric"),
    );
    expect(shared).toContain("assignedToMe");
    expect(shared.length).toBe(QUEUE_METRIC_ORDER.length);
  });
});

describe("Operations — one tone table, every surface", () => {
  it("12. THE CARDS PAINT THE CANONICAL SEVERITY TONES", async () => {
    // The defect this replaces: the cards said Critical=orange, High=red
    // while the queue below said Critical=red, High=orange. Same two words,
    // opposite colours, one scroll apart.
    await mount(envelope(TEAM_ADMIN));
    expect(metric("critical")?.getAttribute("data-opsw-tone")).toBe(
      OPERATIONS_TONE.CRITICAL,
    );
    expect(metric("high")?.getAttribute("data-opsw-tone")).toBe(
      OPERATIONS_TONE.HIGH,
    );
    expect(metric("warning")?.getAttribute("data-opsw-tone")).toBe(
      OPERATIONS_TONE.WARNING,
    );
    // …and those are the exact colours the brief names.
    expect(OPERATIONS_TONE.CRITICAL).toBe("red");
    expect(OPERATIONS_TONE.HIGH).toBe("orange");
    expect(OPERATIONS_TONE.WARNING).toBe("purple");
  });

  it("13. the aggregate and the commitments wear their own tones", async () => {
    summaryReply = () => summary({ operatorCount: 3 });
    await mount(envelope(TEAM_ADMIN));
    expect(metric("open")?.getAttribute("data-opsw-tone")).toBe("black");
    expect(metric("slaAtRisk")?.getAttribute("data-opsw-tone")).toBe("silver");
    expect(metric("slaBreached")?.getAttribute("data-opsw-tone")).toBe(
      OPERATIONS_TONE.OVERDUE,
    );
    expect(metric("resolved")?.getAttribute("data-opsw-tone")).toBe("green");
  });

  it("14. BLACK IS SPENT ONLY ON THE UNRESOLVED TOTAL", async () => {
    // OPEN and ACKNOWLEDGED are lifecycle STATES, not the aggregate. Painting
    // a status column black because a card above it counts a superset of it
    // would be a third meaning for one colour.
    expect(OPERATIONS_TONE.OPEN).not.toBe("black");
    expect(OPERATIONS_TONE.ACKNOWLEDGED).not.toBe("black");
    expect(STATUS_VOCABULARY.OPEN.label).toBe("Open");
    expect(STATUS_VOCABULARY.ACKNOWLEDGED.label).toBe("Acknowledged");
    const black = Object.entries(OPERATIONS_TONE).filter(
      ([, tone]) => tone === "black",
    );
    expect(black.map(([k]) => k)).toEqual(["UNRESOLVED"]);
  });

  it("15. A SEVERITY IS THE SAME COLOUR IN THE QUEUE AS ON THE CARDS", async () => {
    await mount(envelope(TEAM_ADMIN));
    const badge = table().querySelector("[data-ops-severity]");
    expect(badge).not.toBeNull();
    const value = badge!.getAttribute("data-ops-severity") as
      | "CRITICAL"
      | "HIGH"
      | "WARNING"
      | "INFO";
    expect(badge!.getAttribute("data-tone")).toBe(
      SEVERITY_VOCABULARY[value].tone,
    );
    expect(SEVERITY_VOCABULARY[value].tone).toBe(OPERATIONS_TONE[value]);
  });

  it("16. AND THE SAME COLOUR IN GROUPED AS IN ALL CONDITIONS", async () => {
    // The property the brief names directly: switching views must not change
    // a semantic value's colour. Read from the two rendered surfaces rather
    // than from the table both of them import.
    groupsReply = () => ({
      groups: [group({ groupKey: "search.indexing_failure", severity: "WARNING" })],
      conservation: { conditions: 1, grouped: 1 },
      completeness: { complete: true, mayAssertAllClear: true },
    });
    await mount(envelope(TEAM_ADMIN), "grouped");
    const grouped = q("[data-ops-group-severity]");
    expect(grouped, "no grouped severity rendered").not.toBeNull();
    const value = grouped!.getAttribute("data-ops-group-severity") as
      | "CRITICAL"
      | "HIGH"
      | "WARNING"
      | "INFO";
    expect(grouped!.getAttribute("data-tone")).toBe(OPERATIONS_TONE[value]);
  });

  it("17. every vocabulary reads the ONE table", () => {
    // Stated over the whole vocabulary rather than sampled: any entry that
    // still decided its own colour would appear here as a tone no semantic
    // value claims.
    const canonical = new Set(Object.values(OPERATIONS_TONE));
    for (const [k, v] of Object.entries(SEVERITY_VOCABULARY)) {
      expect(v.tone, k).toBe(OPERATIONS_TONE[k as "CRITICAL"]);
    }
    for (const [k, v] of Object.entries(STATUS_VOCABULARY)) {
      expect(v.tone, k).toBe(OPERATIONS_TONE[k as "OPEN"]);
    }
    for (const [k, v] of Object.entries(QUEUE_METRIC_VOCABULARY)) {
      expect(canonical.has(v.tone), `card ${k} uses ${v.tone}`).toBe(true);
    }
    for (const posture of [
      "BREACHED",
      "AT_RISK",
      "ON_TRACK",
      "ACKNOWLEDGED",
      "RESOLVED",
      "UNTRACKED_LEGACY",
      "NOT_APPLICABLE",
    ] as const) {
      expect(canonical.has(slaTone(posture)), posture).toBe(true);
    }
    // The commitment axis agrees with itself: the badge and the card that
    // report the same posture cannot be different colours.
    expect(slaTone("BREACHED")).toBe(QUEUE_METRIC_VOCABULARY.slaBreached.tone);
    expect(slaTone("AT_RISK")).toBe(QUEUE_METRIC_VOCABULARY.slaAtRisk.tone);
  });

  it("18. severity descends in strength: Critical, then High, then Warning", () => {
    expect(SEVERITY_TONE_STRENGTH.slice(0, 3)).toEqual([
      "CRITICAL",
      "HIGH",
      "WARNING",
    ]);
    // The rank the queue sorts by agrees with the strength the eye reads.
    expect(SEVERITY_VOCABULARY.CRITICAL.rank).toBeGreaterThan(
      SEVERITY_VOCABULARY.HIGH.rank,
    );
    expect(SEVERITY_VOCABULARY.HIGH.rank).toBeGreaterThan(
      SEVERITY_VOCABULARY.WARNING.rank,
    );
  });

  it("19. COLOUR IS NEVER THE CARRIER — every value keeps its word", async () => {
    summaryReply = () => summary({ operatorCount: 3 });
    await mount(envelope(TEAM_ADMIN));
    for (const card of qa("[data-ops-metric]")) {
      const label = card.querySelector(".app-metric-card__label");
      const key = card.getAttribute("data-ops-metric") ?? "(no key)";
      expect(label?.textContent?.trim() ?? "", key).not.toBe("");
    }
    for (const v of Object.values(SEVERITY_VOCABULARY)) expect(v.label).toBeTruthy();
    for (const v of Object.values(STATUS_VOCABULARY)) expect(v.label).toBeTruthy();
  });

  it("20. NO COLOUR IS DECIDED IN JSX", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    const root = resolve(process.cwd(), "app/(app)/operations");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        // The WORKBENCH only. batch-analysis and quotas are separate routes
        // with their own presentation and are out of scope here.
        if (entry.isDirectory()) {
          if (["batch-analysis", "quotas"].includes(entry.name)) continue;
          walk(full);
        }
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
      // A hex literal anywhere in this route is a colour decision taken away
      // from the table above.
      const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hex, `${file}: ${hex.join(", ")}`).toEqual([]);
    }
  });
});

describe("Operations — the cards' interactive states are real", () => {
  it("KEYBOARD FOCUS IS VISIBLE, because the route no longer breaks it", async () => {
    // WHAT WAS BROKEN, AND HOW IT HID.
    //
    // The route carried `.opsw-metric:focus-visible { outline: 2px solid
    // var(--focus-ring) }`. `--focus-ring` holds a BOX-SHADOW value —
    // `0 0 0 3px rgba(...)` — so that expands to an invalid declaration, and
    // CSS discards an invalid declaration WHOLE. The rule looked like a focus
    // style in the stylesheet and painted nothing in a browser: a focused
    // summary card computed `outline-style: none`.
    //
    // It hid because it also SUPPRESSED the shared primitive's working ring,
    // which it beat on cascade order at equal specificity. Deleting it is the
    // fix; `.app-metric-card:focus-visible` is the authority.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // Comments stripped: the block above the deleted rule QUOTES it, and a
    // prose account of what was removed must not fail the check for it.
    const route = readFileSync(
      resolve(process.cwd(), "app/(app)/operations/operations.css"),
      "utf8",
    ).replace(new RegExp("/\\*[\\s\\S]*?\\*/", "g"), " ");
    const primitive = readFileSync(
      resolve(process.cwd(), "components/app-primitives/app-primitives.css"),
      "utf8",
    );
    // Nothing in this route may spend a shadow token as an outline COLOUR.
    expect(route).not.toMatch(/outline:[^;]*var\(--focus-ring\)/);
    // The card takes its focus style from the primitive, which really paints.
    expect(primitive).toMatch(
      /\.app-metric-card:focus-visible \{[^}]*box-shadow:[^}]*rgba\(124, 58, 237/,
    );
    // …and the card is reachable by keyboard in the first place.
    await mount(envelope(TEAM_ADMIN));
    for (const card of qa("[data-ops-metric]")) {
      expect(card.getAttribute("disabled")).toBeNull();
      expect(card.getAttribute("tabindex")).not.toBe("-1");
    }
  });

  it("the SELECTED card carries its own tone, not a generic highlight", async () => {
    currentSearch = "severity=WARNING";
    await mount(envelope(TEAM_ADMIN));
    const card = metric("warning") as HTMLButtonElement;
    expect(card.getAttribute("aria-pressed")).toBe("true");
    // The pressed border reads the same custom property the rail does, so a
    // selected card cannot be a different colour from the one it just was.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const route = readFileSync(
      resolve(process.cwd(), "app/(app)/operations/operations.css"),
      "utf8",
    );
    expect(route).toMatch(
      /\.opsw-metric\[aria-pressed="true"\] \{[^}]*border-color: var\(--opsw-tone/,
    );
  });
});

describe("Operations — the summary grid adapts to its container", () => {
  const css = async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    return readFileSync(
      resolve(process.cwd(), "app/(app)/operations/operations.css"),
      "utf8",
    );
  };

  it("21. FOUR, THREE, TWO, ONE — by container width, with no fixed card widths", async () => {
    const src = await css();
    // The strip is the query subject, not the viewport: the same strip inside
    // a narrower column has to make the same decision.
    expect(src).toMatch(/\.opsw-summary\s*\{[^}]*container-type:\s*inline-size/);
    expect(src).toMatch(/container-name:\s*opsw-summary/);
    // One column is the BASE, so the narrow layout is right before any query
    // has matched.
    expect(src).toMatch(
      /\.opsw-summary__grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    const steps = [...src.matchAll(
      /@container opsw-summary \(min-width: (\d+)px\)\s*\{[^}]*\{[^}]*repeat\((\d)/g,
    )].map((m) => [Number(m[1]), Number(m[2])] as const);
    expect(steps).toEqual([
      [340, 2],
      [800, 3],
      [1100, 4],
    ]);
    // FOUR IS THE CEILING. Past four a summary strip stops being scannable.
    expect(Math.max(...steps.map(([, n]) => n))).toBe(4);
    // Every step keeps the narrowest possible card at or above the legibility
    // floor, computed rather than asserted by eye.
    // THE FLOOR IS 165px, AND IT WAS MEASURED, NOT GUESSED. At a 390px
    // viewport the page column gives the strip 342px, which is two 166px
    // cards. Rendered in a browser at that width, every card's content —
    // including "Assigned to me" and the two-line notes — wraps inside its
    // box with no element overflowing (scrollWidth never exceeds clientWidth)
    // and no horizontal page scroll. A stricter floor would have made a
    // 390px phone a nine-card single stack for no legibility gain.
    for (const [width, columns] of steps) {
      const cardWidth = (width - 10 * (columns - 1)) / columns;
      expect(cardWidth, `${columns} columns at ${width}px`).toBeGreaterThanOrEqual(
        165,
      );
    }
    // No card is pinned to a pixel width, and nothing scrolls sideways.
    const grid = src.slice(src.indexOf(".opsw-summary__grid"));
    expect(grid.slice(0, grid.indexOf("}"))).not.toMatch(/(?:^|[\s;])width:\s*\d/);
    expect(src).not.toMatch(/\.opsw-summary__grid[^}]*overflow-x/);
  });

  it("22. cards may shrink, wrap their text, and share a row height", async () => {
    const src = await css();
    const card = src.slice(src.indexOf(".opsw-metric {"));
    const body = card.slice(0, card.indexOf("}"));
    // Without this a long label makes the card refuse to shrink and the row
    // scrolls sideways — the automatic minimum size of a grid item is its
    // CONTENT.
    expect(body).toMatch(/min-inline-size:\s*0/);
    // Equal heights per row, so a one-line note and a two-line note do not
    // produce cards the eye reads as different in importance.
    expect(src).toMatch(/grid-auto-rows:\s*1fr/);
    expect(body).toMatch(/block-size:\s*100%/);
    // Text wraps; it is never clipped or ellipsised.
    expect(src).toMatch(
      /\.opsw-metric__value,[\s\S]{0,120}overflow-wrap:\s*anywhere/,
    );
    expect(src).not.toMatch(/\.opsw-metric__(value|label|meta)[^}]*text-overflow/);
    // And there is exactly ONE strip — no duplicated mobile component.
    // The class is DECLARED once at the top level; every other appearance is
    // a widening nested inside a query, which is the same strip changing its
    // column count rather than a second strip being defined.
    expect((src.match(/^\.opsw-summary__grid\s*\{/gm) ?? []).length).toBe(1);
    expect(src).not.toMatch(/opsw-summary--(mobile|narrow|compact)/);
  });
});
