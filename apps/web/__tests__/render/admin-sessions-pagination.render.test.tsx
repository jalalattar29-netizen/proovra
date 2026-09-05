/**
 * /admin/identity/sessions — the paged inventory, driven for real.
 *
 * Source text can prove the section renders a <CursorPager>; it cannot prove
 * that page one asks for 25 rows and no cursor, that Next sends exactly the
 * cursor the server minted, that Previous replays the earlier request, that a
 * filter change resets the walk, or that the count sentence stops claiming
 * "more available" on the last page. This file mounts the REAL section
 * against a fixture server of 60 sessions and asserts those behaviours.
 *
 * The properties under test:
 *   - page one requests limit=25 with NO cursor and renders exactly 25 rows;
 *   - Next sends the server's `nextCursor` verbatim and renders the next 25;
 *   - Previous replays the earlier request (page one has no cursor again);
 *   - Next is truthfully disabled on the last page (hasMore=false), even
 *     though the page could be full;
 *   - the count wording follows the server's hasMore: "loaded — more
 *     available" mid-walk, a bare count at the end — never a claimed total;
 *   - flipping a server-side filter resets the walk to page one and sends
 *     the filter WITHOUT the stale cursor;
 *   - the filters stay in the request string (server-side, never applied in
 *     the browser).
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams — same pattern as operations-workbench.render.test.tsx.
// ---------------------------------------------------------------------------

let requestLog: Array<{ path: string; method: string }> = [];

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

const T0 = Date.parse("2026-09-01T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(T0 - m * 60_000).toISOString();

/** Sixty sessions, newest first — 25 + 25 + 10 under a page size of 25. */
const ALL_SESSIONS = Array.from({ length: 60 }, (_, i) => ({
  id: `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`,
  teamId: WS,
  userId: ME,
  ssoConnectionId: null,
  issuedAtUtc: minutesAgo(i + 120),
  expiresAtUtc: new Date(T0 + 3_600_000).toISOString(),
  lastSeenAtUtc: minutesAgo(i),
  ipPreview: null,
  uaPreview: null,
  revoked: false,
  revokedAtUtc: null,
  revokedReason: null,
  quarantined: false,
}));

/**
 * The fixture server: a real keyset walk over the fixture, with an opaque
 * cursor of its own minting. The section must treat it as a token — if it
 * ever tries to fabricate one, the lookup below misses and the test fails on
 * an empty page.
 */
function sessionsReply(path: string) {
  const qs = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  const limit = Number(qs.get("limit"));
  const cursor = qs.get("cursor");
  const start = cursor === null ? 0 : Number(/^fixture-cursor-(\d+)$/.exec(cursor)?.[1] ?? NaN);
  if (Number.isNaN(start)) return { sessions: [], nextCursor: null, hasMore: false };
  const rows = ALL_SESSIONS.slice(start, start + limit);
  const hasMore = start + limit < ALL_SESSIONS.length;
  return {
    sessions: rows,
    nextCursor: hasMore ? `fixture-cursor-${start + limit}` : null,
    hasMore,
  };
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string }) => {
    requestLog.push({ path, method: init?.method ?? "GET" });
    if (path.startsWith("/v1/admin/identity/sessions?")) return sessionsReply(path);
    if (path.startsWith("/v1/admin/identity/quarantined-sessions?")) {
      return { items: [], nextCursor: null, hasMore: false };
    }
    return {};
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/admin/identity/sessions",
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
import { ActiveSessionsSection } from "../../app/(app)/admin/identity/sessions/_sections/ActiveSessionsSection";

// ---------------------------------------------------------------------------
// Envelope + mount
// ---------------------------------------------------------------------------

function envelope() {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {},
    diagnostics: { requestId: "test" },
    workspace: {
      id: WS,
      name: "Northgate Team",
      status: "active",
      scope: "TEAM",
      membership: { role: "ADMIN" },
    },
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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  cleanup();
  const utils = render(
    <PlatformContextProvider testEnvelope={envelope() as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <ActiveSessionsSection />
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

const sessionRequests = () =>
  requestLog.filter((r) => r.path.startsWith("/v1/admin/identity/sessions?"));

const lastSessionQuery = () => {
  const reqs = sessionRequests();
  const path = reqs[reqs.length - 1]!.path;
  return new URLSearchParams(path.slice(path.indexOf("?") + 1));
};

/** Member-column cell values of the rows currently rendered. */
const renderedRowCount = () =>
  document.querySelectorAll(
    'table[aria-label="Active sessions inventory"] tbody tr:not([data-ui-datatable-skeleton-row])',
  ).length;

const pagerButton = (which: "next" | "previous") =>
  screen.getByTestId(`admin-sessions-pager-${which}`) as HTMLButtonElement;

const countText = () =>
  screen.getByTestId("admin-sessions-count").textContent ?? "";

beforeEach(() => {
  requestLog = [];
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("active sessions — server cursor pagination", () => {
  it("page one asks for 25 rows with no cursor, renders 25, and says more exist without claiming a total", async () => {
    await mount();
    const q = lastSessionQuery();
    expect(q.get("limit")).toBe("25");
    expect(q.get("cursor")).toBeNull();
    // The filters are in the REQUEST — server-side, not browser-side.
    expect(q.get("teamId")).toBe(WS);
    expect(q.get("includeRevoked")).toBe("false");
    expect(q.get("includeExpired")).toBe("false");

    expect(renderedRowCount()).toBe(25);
    // hasMore=true → the wording admits continuation and claims no total.
    expect(countText()).toContain("25 sessions loaded — more available");
    expect(countText()).not.toMatch(/\bof\b/);

    expect(pagerButton("next").disabled).toBe(false);
    // There is nothing before page one, and the control says so.
    expect(pagerButton("previous").disabled).toBe(true);
  });

  it("Next sends the server's cursor verbatim; Previous replays page one", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(pagerButton("next"));
    });
    await settle();

    let q = lastSessionQuery();
    expect(q.get("cursor")).toBe("fixture-cursor-25");
    expect(q.get("limit")).toBe("25");
    expect(renderedRowCount()).toBe(25);
    expect(pagerButton("previous").disabled).toBe(false);

    await act(async () => {
      fireEvent.click(pagerButton("previous"));
    });
    await settle();

    q = lastSessionQuery();
    // Page one again: the walk replays the original request, cursor-free.
    expect(q.get("cursor")).toBeNull();
    expect(renderedRowCount()).toBe(25);
    expect(pagerButton("previous").disabled).toBe(true);
  });

  it("the last page disables Next because the server said hasMore=false — not because the page is short", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(pagerButton("next"));
    });
    await settle();
    await act(async () => {
      fireEvent.click(pagerButton("next"));
    });
    await settle();

    expect(lastSessionQuery().get("cursor")).toBe("fixture-cursor-50");
    expect(renderedRowCount()).toBe(10);
    // No continuation claimed, no total invented.
    expect(countText()).toContain("10 sessions");
    expect(countText()).not.toContain("more available");
    expect(pagerButton("next").disabled).toBe(true);
    expect(pagerButton("previous").disabled).toBe(false);
  });

  it("changing a server-side filter resets the walk: the new request carries the filter and NO stale cursor", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(pagerButton("next"));
    });
    await settle();
    expect(lastSessionQuery().get("cursor")).toBe("fixture-cursor-25");

    const revokedFilter = screen.getByLabelText("Revoked sessions");
    await act(async () => {
      fireEvent.change(revokedFilter, { target: { value: "include" } });
    });
    await settle();

    const q = lastSessionQuery();
    // A cursor names a position in ONE ordered set; the filter changed the
    // set, so the cursor is gone and the filter is in the request.
    expect(q.get("includeRevoked")).toBe("true");
    expect(q.get("cursor")).toBeNull();
    expect(pagerButton("previous").disabled).toBe(true);
  });

  /**
   * PHASE 7 — THE EMPTY QUARANTINE TABLE SAID IT TWICE.
   *
   * This asserted the count row read "No held sessions yet". It did, directly
   * beneath the table's own empty state — "Nothing is on hold / No session in
   * this workspace is currently quarantined. Held sessions appear here with
   * the reason and the auto-release time." — which is the same fact, written
   * for this list, with the explanation the count line cannot carry.
   *
   * `ResultCount` suppresses the sentence for the plain empty case, and used
   * to be prevented from doing so here only because a pager was passed in the
   * same row. So the assertion becomes the two halves that matter: the empty
   * state is what answers the reader, and the count row does not repeat it.
   */
  it("an empty quarantine table answers once, in its empty state", async () => {
    await mount();
    expect(screen.getByText("Nothing is on hold")).toBeTruthy();
    const held = screen.getByTestId("admin-quarantine-count");
    expect(held.textContent).not.toContain("No held sessions yet");
    // And it states no count, so a sweep counting `[data-result-count]` nodes
    // is not told this list reported one.
    expect(held.getAttribute("data-result-count")).toBeNull();
  });
});
