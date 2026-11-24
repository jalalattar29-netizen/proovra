/**
 * Team remediation stage F — /search failure states and request ordering
 * (T-148, T-149, T-150; audit JRN-08 l, m, n). The REAL page and the REAL
 * apiFetch over a stubbed `fetch`.
 *
 * Each case failed on the audited console:
 *   - a failed saved-views, related-evidence or suggestion read rendered as
 *     "No saved searches yet" / "No related evidence" / "no matches";
 *   - a trashed result linked to `/evidence/:id?context=trash`, a parameter
 *     the Evidence page never reads;
 *   - a stale "load more" cleared the spinner of the newer search.
 */
import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "@proovra/shared/i18n";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../app/providers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useT: () => (key: keyof (typeof dict)["en"]) => dict.en[key],
}));
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

const WS = "11111111-1111-4111-8111-111111111111";
const ENVELOPE = {
  authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
  capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
  navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
  capabilities: { SEARCH_VIEW: true },
  diagnostics: { requestId: "test-search" },
  workspace: { id: WS, name: "Personal Space", status: "active", scope: "PERSONAL" },
  activeSpace: { type: "PERSONAL", id: WS, displayName: "Personal Space", roleLabel: "Owner" },
  contextOptions: {
    personalSpace: null,
    ownedWorkspaces: [],
    organizations: [],
    activeContext: { workspaceId: WS, kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
  },
  account: { accountPlan: "TEAM", accountStatus: "active" },
  flags: { isEnterpriseWorkspace: false },
  platform: { isPlatformAdmin: false },
  planFeatures: {},
};

function row(over: Record<string, unknown> = {}) {
  return {
    documentId: "doc-1", documentType: "EVIDENCE", title: "incident-bundle.zip", subtitle: "Active",
    summary: "A recorded incident bundle.", evidenceId: "ev-1", workflowInstanceId: null, workflowStepInstanceId: null,
    caseId: null, reviewState: null, workflowState: null, exportState: null, retentionState: null, legalHoldState: null,
    contributorScoped: false, reviewerRestricted: false, badges: [], updatedAtUtc: "2026-08-01T00:00:00.000Z", ...over,
  };
}

type Handler = (path: string) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown };
let handlers: Array<{ match: (path: string) => boolean; handle: Handler }>;

beforeEach(() => {
  handlers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const h = handlers.find((x) => x.match(path));
      const a = h ? await h.handle(path) : { status: 200, body: defaultBody(path) };
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function defaultBody(path: string): unknown {
  if (path.startsWith("/v1/search/saved-views")) return { views: [] };
  if (path.startsWith("/v1/search/semantic/status")) return { enabled: false, providerName: "disabled", semanticAvailable: false, fallbackReason: null, usage: null };
  if (path.startsWith("/v1/search/relationships")) return { relationships: [] };
  if (path.startsWith("/v1/search/suggest")) return { suggestions: [] };
  if (path.startsWith("/v1/search?")) return { rows: [row()], totalReturned: 1, nextCursor: null, withheld: 0 };
  return null;
}
const fail = { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "boom" } } };

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

async function mount() {
  const view = render(
    <PlatformContextProvider testEnvelope={ENVELOPE as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <SearchPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await flush();
  return view;
}

async function selectFirstRow() {
  const r = document.querySelector("[data-search-result-row]") as HTMLElement;
  expect(r).not.toBeNull();
  await act(async () => {
    fireEvent.click(r);
  });
  await flush();
}

describe("/search — failures are not empties (T-148)", () => {
  it("a failed saved-views read says so instead of 'No saved searches yet'", async () => {
    handlers.push({ match: (p) => p.startsWith("/v1/search/saved-views"), handle: () => fail });
    // No result, so nothing is auto-selected and the guidance column shows.
    handlers.push({ match: (p) => p.startsWith("/v1/search?"), handle: () => ({ status: 200, body: { rows: [], totalReturned: 0, nextCursor: null, withheld: 0 } }) });
    await mount();
    expect(document.querySelector("[data-search-guidance-saved-error]")).not.toBeNull();
    expect(document.querySelector("[data-search-guidance-saved-empty]")).toBeNull();
  });

  it("a failed related-evidence read says so instead of 'No related evidence'", async () => {
    handlers.push({ match: (p) => p.startsWith("/v1/search/relationships"), handle: () => fail });
    await mount();
    await selectFirstRow();
    expect(document.querySelector("[data-search-relationships-error]")).not.toBeNull();
    expect(document.body.textContent).not.toContain(dict.en.searchNoRelatedEvidence);
  });

  it("a failed suggestion read says suggestions are unavailable, not 'no matches'", async () => {
    handlers.push({ match: (p) => p.startsWith("/v1/search/suggest"), handle: () => fail });
    await mount();
    const input = document.querySelector("[data-search-input]") as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "incident" } });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await flush();
    expect(document.querySelector("[data-search-typeahead-failed]")).not.toBeNull();
    expect(document.querySelector("[data-search-typeahead-empty]")).toBeNull();
  });
});

describe("/search — trashed results (T-149)", () => {
  it("a trashed result opens the record URL with no unread context parameter", async () => {
    handlers.push({
      match: (p) => p.startsWith("/v1/search?"),
      handle: () => ({ status: 200, body: { rows: [row({ badges: ["in_trash"] })], totalReturned: 1, nextCursor: null, withheld: 0 } }),
    });
    await mount();
    await selectFirstRow();
    const open = document.querySelector("[data-search-open-href]") as HTMLElement;
    expect(open).not.toBeNull();
    expect(open.getAttribute("data-search-open-href")).toBe("/evidence/ev-1");
  });
});

describe("/search — a stale page cannot clear a newer search's spinner (T-150)", () => {
  it("load more resolving after a new search leaves the new search loading until its own answer", async () => {
    let releaseMore: () => void = () => {};
    let releaseNew: () => void = () => {};
    handlers.push({
      match: (p) => p.startsWith("/v1/search?"),
      handle: async (p) => {
        if (p.includes("cursor=")) {
          await new Promise<void>((r) => (releaseMore = r));
          return { status: 200, body: { rows: [row({ documentId: "doc-2" })], totalReturned: 1, nextCursor: null, withheld: 0 } };
        }
        if (p.includes("q=second")) {
          await new Promise<void>((r) => (releaseNew = r));
          return { status: 200, body: { rows: [row({ documentId: "doc-3", title: "second.zip" })], totalReturned: 1, nextCursor: "c2", withheld: 0 } };
        }
        return { status: 200, body: { rows: [row()], totalReturned: 1, nextCursor: "c1", withheld: 0 } };
      },
    });
    await mount();
    const more = document.querySelector("[data-search-load-more]") as HTMLButtonElement;
    expect(more).not.toBeNull();
    await act(async () => {
      fireEvent.click(more);
    });
    // A new search while the page is still loading.
    const input = document.querySelector("[data-search-input]") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "second" } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
    });
    await flush();
    // The stale page answers first.
    await act(async () => {
      releaseMore();
    });
    await flush();
    const busy = document.querySelector("[data-search-load-more]")?.getAttribute("aria-busy")
      ?? document.querySelector('[data-search-empty-state-kind="loading"]')?.getAttribute("data-search-empty-state-kind");
    expect(busy === "true" || busy === "loading").toBe(true);
    // Its own answer ends it.
    await act(async () => {
      releaseNew();
    });
    await flush();
    await waitFor(() => expect(document.body.textContent).toContain("second.zip"));
    expect(document.querySelector("[data-search-load-more]")?.getAttribute("aria-busy")).not.toBe("true");
  });
});
