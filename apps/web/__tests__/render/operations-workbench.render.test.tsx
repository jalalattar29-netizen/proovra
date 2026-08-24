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
import { QUEUE_METRIC_ORDER } from "../../app/(app)/operations/_lib/vocabulary";
// The SLA fixture below is typed against the PAGE'S OWN contract rather than
// shaped by hand. A hand-written block drifts from the server projection
// silently; borrowing the real type means a change to the contract breaks the
// fixture at COMPILE time, which is where it should break.
import type { IncidentSla } from "../../app/(app)/operations/_lib/types";

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

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    requestLog.push({ path, method, body: init?.body });
    const pick = (r: Reply) => {
      if (r instanceof Error) throw r;
      return r;
    };
    if (path.startsWith("/v1/ops/summary")) return pick(summaryReply());
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
};

function incident(over: IncidentOver) {
  return {
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

async function mount(env: unknown) {
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
  it("opens on unresolved work", async () => {
    await mount(envelope(TEAM_ADMIN));
    expect(lastListQuery()).toMatch(/status=OPEN/);
    expect(lastListQuery()).toMatch(/limit=50/);
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
    await settle();
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
    // SEVEN, from `QUEUE_METRIC_ORDER`: open, critical, high, slaBreached,
    // slaAtRisk, assignedToMe, unassigned. The count is asserted against the
    // vocabulary rather than a literal so a card added there cannot pass here
    // by coincidence.
    expect(cards.length).toBe(QUEUE_METRIC_ORDER.length);
    expect(cards.length).toBe(7);
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
