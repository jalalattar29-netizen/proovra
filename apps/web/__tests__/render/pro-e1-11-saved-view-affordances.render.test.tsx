/**
 * Closure 2 ("sem" item 4, PRO-E1-11) — saved-view affordances follow the
 * server's rule. The audience is NOT widened: the search console's
 * saved-view management block stays a platform-administrator surface
 * (PRO-E1-11 ACCEPTED_POLICY), and a non-administrator still sees none of it.
 *
 * What changed is which controls that block, and the reviewer console's saved
 * queue views, OFFER:
 *   - search: Rename only on the viewer's own view (a TEAM one only with the
 *     shared-view write); Delete on their own view, or on a colleague's TEAM
 *     view only for `operations.saved_views.manage` (OWNER / ADMIN);
 *   - reviewer console: Delete on the viewer's own view, or a colleague's TEAM
 *     view for the workspace OWNER / ADMIN.
 * Both used to offer the control on every row, and the server answered 404.
 *
 * Real page components, real apiFetch over a stubbed fetch, RTL cleanup().
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/search",
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
import SearchPage from "../../app/(app)/search/page";
import { SavedViewsPanel } from "../../components/reviewer-experience/ReviewerConsole";
import { setActiveWorkspaceId } from "../../lib/api";

const WS = "55555555-5555-4555-8555-555555555555";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COLLEAGUE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Call = { path: string; method: string };
let calls: Call[] = [];
let savedViews: Array<Record<string, unknown>> = [];

function respond(path: string): unknown {
  if (path.startsWith("/v1/search/saved-views")) return { views: savedViews };
  if (path.startsWith("/v1/search/semantic/status")) {
    return { enabled: false, providerName: "disabled", semanticAvailable: false, fallbackReason: null, usage: null };
  }
  if (path.startsWith("/v1/search/audit")) return { rows: [], nextCursor: null };
  if (path.startsWith("/v1/search?")) return { rows: [], totalReturned: 0, nextCursor: null, withheld: 0 };
  return null;
}

beforeEach(() => {
  calls = [];
  setActiveWorkspaceId(WS);
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.push({ path, method: (init.method ?? "GET").toUpperCase() });
    return new Response(JSON.stringify(respond(path)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

function envelope(role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER", isPlatformAdmin: boolean) {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { SEARCH_VIEW: true },
    diagnostics: { requestId: `pro-e1-11-${role}` },
    user: { id: ME, email: null, displayName: null, firstName: null, lastName: null, avatarUrl: null, locale: null, timezone: null },
    workspace: { id: WS, name: "Meridian Legal", status: "active", scope: "ORGANIZATION", membership: { role } },
    activeSpace: { type: "ORGANIZATION", id: WS, displayName: "Meridian Legal", roleLabel: role },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "ORGANIZATION", organizationId: null, displayName: "Meridian Legal" },
    },
    account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: true },
    platform: { isPlatformAdmin },
    planFeatures: {},
  };
}

const view = (id: string, createdByUserId: string, visibility: "PRIVATE" | "TEAM") => ({
  id,
  name: `view ${id}`,
  description: null,
  visibility,
  pinned: false,
  createdByUserId,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  lastUsedAtUtc: null,
  query: { teamId: WS, q: "x" },
});
const MINE_PRIVATE = "11111111-0000-4000-8000-000000000001";
const MINE_TEAM = "11111111-0000-4000-8000-000000000002";
const THEIRS_TEAM = "11111111-0000-4000-8000-000000000003";

async function settle() {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function mountSearch(role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER", isPlatformAdmin = true) {
  savedViews = [view(MINE_PRIVATE, ME, "PRIVATE"), view(MINE_TEAM, ME, "TEAM"), view(THEIRS_TEAM, COLLEAGUE, "TEAM")];
  render(
    <PlatformContextProvider testEnvelope={envelope(role, isPlatformAdmin) as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <SearchPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
}

const renameOffered = (id: string) => document.querySelector(`[data-search-saved-view-rename="${id}"]`) !== null;
const deleteOffered = (id: string) => document.querySelector(`[data-search-saved-view-delete="${id}"]`) !== null;

describe("PRO-E1-11 — search console saved-view controls match the server rule", () => {
  it("a platform administrator who is the workspace ADMIN: rename only their own views; delete their own and a colleague's shared view", async () => {
    await mountSearch("ADMIN");
    await waitFor(() => expect(document.body.textContent).toContain(`view ${THEIRS_TEAM}`));
    expect([renameOffered(MINE_PRIVATE), renameOffered(MINE_TEAM), renameOffered(THEIRS_TEAM)]).toEqual([true, true, false]);
    expect([deleteOffered(MINE_PRIVATE), deleteOffered(MINE_TEAM), deleteOffered(THEIRS_TEAM)]).toEqual([true, true, true]);
  });

  it("as a workspace MEMBER: no rename or delete on a colleague's shared view (the server answers 404); their own stay offered", async () => {
    await mountSearch("MEMBER");
    await waitFor(() => expect(document.body.textContent).toContain(`view ${THEIRS_TEAM}`));
    expect([renameOffered(MINE_PRIVATE), renameOffered(MINE_TEAM), renameOffered(THEIRS_TEAM)]).toEqual([true, true, false]);
    expect([deleteOffered(MINE_PRIVATE), deleteOffered(MINE_TEAM), deleteOffered(THEIRS_TEAM)]).toEqual([true, true, false]);
  });

  it("as a workspace VIEWER: only their own PRIVATE view can be renamed or deleted (a shared view needs the shared-view write)", async () => {
    await mountSearch("VIEWER");
    await waitFor(() => expect(document.body.textContent).toContain(`view ${THEIRS_TEAM}`));
    expect([renameOffered(MINE_PRIVATE), renameOffered(MINE_TEAM), renameOffered(THEIRS_TEAM)]).toEqual([true, false, false]);
    expect([deleteOffered(MINE_PRIVATE), deleteOffered(MINE_TEAM), deleteOffered(THEIRS_TEAM)]).toEqual([true, false, false]);
  });

  it("the audience is unchanged: a non-administrator sees no saved-view management at all", async () => {
    await mountSearch("OWNER", false);
    await waitFor(() => expect(calls.some((c) => c.path.startsWith("/v1/search/saved-views"))).toBe(true));
    expect(document.body.textContent).not.toContain("Save current view");
    for (const id of [MINE_PRIVATE, MINE_TEAM, THEIRS_TEAM]) {
      expect(renameOffered(id)).toBe(false);
      expect(deleteOffered(id)).toBe(false);
    }
  });
});

describe("closure 2 sem item 4 — reviewer console saved queue views offer Delete on the server rule", () => {
  const rows = [
    { id: MINE_TEAM, name: "mine", createdByUserId: ME, visibility: "TEAM" as const },
    { id: THEIRS_TEAM, name: "theirs", createdByUserId: COLLEAGUE, visibility: "TEAM" as const },
  ];
  function mountPanel(role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") {
    render(
      <PlatformContextProvider testEnvelope={envelope(role, false) as never}>
        <ToastProvider>
          <ConfirmActionProvider>
            <SavedViewsPanel teamId={WS} activeTab="queue" views={rows} onChanged={() => {}} />
          </ConfirmActionProvider>
        </ToastProvider>
      </PlatformContextProvider>,
    );
  }
  const del = (id: string) => document.querySelector(`[data-reviewer-saved-view-delete="${id}"]`);

  it("a reviewer (MEMBER) deletes only their own view; a colleague's shared view offers no Delete", async () => {
    mountPanel("MEMBER");
    await settle();
    expect(del(MINE_TEAM)).not.toBeNull();
    expect(del(THEIRS_TEAM)).toBeNull();
  });

  it("the workspace ADMIN may delete a colleague's shared view, and the request is the server's DELETE", async () => {
    mountPanel("ADMIN");
    await settle();
    expect(del(MINE_TEAM)).not.toBeNull();
    const theirs = del(THEIRS_TEAM) as HTMLButtonElement | null;
    expect(theirs).not.toBeNull();
    fireEvent.click(theirs!);
    await settle();
    const confirm = await waitFor(() => {
      const el = document.querySelector('[data-confirm-action-submit="true"]') as HTMLButtonElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path.includes(`/v1/reviewer-ops/saved-views/${THEIRS_TEAM}`))).toBe(true),
    );
  });
});
