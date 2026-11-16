/**
 * EVIDENCE LIBRARY — what is on screen belongs to the workspace on screen.
 *
 * B5A-F-01  A workspace switch left the previous workspace's list, KPIs,
 *           inspector, cursor and bulk selection mounted, so "Run Bulk Action"
 *           after the switch acted on the workspace that was left.
 * B5A-F-02  Bulk selection survived pagination while eligibility and counts
 *           covered only the visible page.
 * B5A-F-05  Opening the Library selected the first row for you and read its
 *           detail, which issues original URLs and writes a custody event.
 * B5A-F-07  Saved-view writes failed silently; Delete had no confirmation.
 *
 * The REAL page and the REAL platform-context provider run against a
 * transport double; the workspace switch goes through the provider's own
 * `switchWorkspace`, exactly as the account toolbar does.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor, cleanup, screen, within } from "@testing-library/react";

const H = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; query: string }>,
  activeWs: "ws-A",
  rowsByWs: {} as Record<string, Array<Record<string, unknown>>>,
  /** When set, the list answers page 1 with a next cursor. */
  paged: false,
  savedViews: [] as Array<Record<string, unknown>>,
  failures: {} as Record<string, { statusCode?: number; code?: string; message?: string }>,
  envelopeFor: null as null | ((ws: string) => unknown),
}));

vi.mock("../../lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const [path, query = ""] = url.split("?");
    H.calls.push({ path, method, query });
    const failure = H.failures[`${method} ${path}`];
    if (failure) throw Object.assign(new Error(failure.message ?? "refused"), failure);

    if (path === "/v1/platform/context/switch-workspace") {
      const body = JSON.parse(init?.body ?? "{}");
      H.activeWs = body.workspaceId;
      return H.envelopeFor!(body.workspaceId);
    }
    const rows = H.rowsByWs[H.activeWs] ?? [];
    if (path === "/v1/evidence") {
      if (H.paged) {
        const page2 = query.includes("cursor=c2");
        return {
          items: page2 ? rows.slice(1) : rows.slice(0, 1),
          pageInfo: page2 ? { hasMore: false, nextCursor: null } : { hasMore: true, nextCursor: "c2" },
          totalCount: rows.length,
        };
      }
      return { items: rows, pageInfo: { hasMore: false, nextCursor: null }, totalCount: rows.length };
    }
    if (path === "/v1/evidence/library-summary") return null;
    if (path === "/v1/evidence/saved-views" && method === "GET") return { items: H.savedViews };
    if (path.startsWith("/v1/evidence/saved-views")) return { savedView: null };
    if (path === "/v1/cases") return { items: [] };
    return {};
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  setActiveWorkspaceId: () => {},
  setApiToken: () => {},
  ApiError: class ApiError extends Error {
    statusCode = 500;
    code = "ERR";
  },
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/evidence",
}));

import EvidenceLibraryPage from "../../app/(app)/evidence/page";
import { PlatformContextProvider, usePlatformContext } from "../../lib/platform-context";
import { ToastProvider } from "../../components/ui";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";

function envelope(ws: string) {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    workspace: { id: ws, name: `Fictional ${ws}`, status: "active", scope: "OWNED" },
    activeSpace: { type: "ORGANIZATION", id: ws, displayName: `Fictional ${ws}`, roleLabel: "Owner" },
    capabilities: { EVIDENCE_VIEW: true, EVIDENCE_ARCHIVE: true, EVIDENCE_DELETE: true },
    account: { accountPlan: "PRO", accountStatus: "active" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: ws, kind: "OWNED", organizationId: null, displayName: ws },
    },
    diagnostics: { requestId: "t" },
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function record(n: number, title: string) {
  return {
    id: uuid(n),
    title,
    displayFileName: `record-${n}.jpg`,
    originalFileName: `record-${n}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: "184320",
    status: "SIGNED",
    createdAt: "2026-08-01T09:00:00.000Z",
    capturedAtUtc: "2026-08-01T08:59:00.000Z",
    archivedAt: null,
    deletedAt: null,
    retentionUntilUtc: null,
    legalHold: false,
    caseIds: [],
    teamId: null,
  };
}

function Switcher() {
  const { switchWorkspace } = usePlatformContext();
  return (
    <button type="button" data-test-switch onClick={() => void switchWorkspace("ws-B")}>
      switch
    </button>
  );
}

async function mount() {
  render(
    <PlatformContextProvider testEnvelope={envelope("ws-A") as never}>
      <ToastProvider>
        <Switcher />
        <EvidenceLibraryPage />
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await waitFor(() => expect(document.querySelectorAll("[data-evidence-row]").length).toBeGreaterThan(0));
}

const rowTitles = () =>
  Array.from(document.querySelectorAll("[data-evidence-row]")).map((r) => r.textContent ?? "");
const checkedBoxes = () =>
  Array.from(
    document.querySelectorAll<HTMLInputElement>("[data-evidence-row] input[type='checkbox']"),
  ).filter((b) => b.checked);
const count = (path: string, method = "GET") =>
  H.calls.filter((c) => c.path === path && c.method === method).length;

beforeEach(() => {
  H.calls = [];
  H.activeWs = "ws-A";
  H.paged = false;
  H.savedViews = [];
  H.failures = {};
  H.envelopeFor = envelope;
  H.rowsByWs = {
    "ws-A": [record(1, "Alpha one"), record(2, "Alpha two")],
    "ws-B": [record(11, "Bravo one")],
  };
});

afterEach(() => {
  cleanup();
});

describe("B5A-F-01 — a workspace switch resets the library", () => {
  it("reloads the list and saved views for the new workspace and clears the bulk selection", async () => {
    await mount();
    expect(rowTitles().join(" ")).toContain("Alpha one");
    const viewsBefore = count("/v1/evidence/saved-views");

    await act(async () => {
      document.querySelector<HTMLInputElement>("[data-evidence-row] input[type='checkbox']")!.click();
    });
    expect(document.querySelector("[data-evidence-run-bulk]")).not.toBeNull();

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-test-switch]")!.click();
    });

    await waitFor(() => expect(rowTitles().join(" ")).toContain("Bravo one"));
    expect(rowTitles().join(" ")).not.toContain("Alpha");
    expect(checkedBoxes()).toHaveLength(0);
    expect(document.querySelector("[data-evidence-run-bulk]")).toBeNull();
    await waitFor(() => expect(count("/v1/evidence/saved-views")).toBeGreaterThan(viewsBefore));
  });
});

describe("B5A-F-02 — the bulk selection does not survive a page change", () => {
  it("clears the selection on Next", async () => {
    H.paged = true;
    await mount();
    await act(async () => {
      document.querySelector<HTMLInputElement>("[data-evidence-row] input[type='checkbox']")!.click();
    });
    expect(document.querySelector("[data-evidence-run-bulk]")).not.toBeNull();
    await act(async () => {
      screen.getByRole("button", { name: /^next$/i }).click();
    });
    await waitFor(() => expect(rowTitles().join(" ")).toContain("Alpha two"));
    expect(document.querySelector("[data-evidence-run-bulk]")).toBeNull();
    expect(screen.getByText(/select all on this page/i)).toBeTruthy();
  });
});

describe("B5A-F-05 — opening the Library reads no record detail", () => {
  it("issues no GET /v1/evidence/:id until a row is chosen", async () => {
    await mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const detailReads = H.calls.filter((c) => /^\/v1\/evidence\/[0-9a-f-]{36}$/.test(c.path));
    expect(detailReads).toHaveLength(0);
  });
});

describe("B5A-F-07 — saved-view refusals are stated and Delete asks first", () => {
  it("states a refused Save View", async () => {
    H.failures["POST /v1/evidence/saved-views"] = {
      statusCode: 403,
      code: "FORBIDDEN",
      message: "Forbidden",
    };
    await mount();
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-evidence-save-view-trigger]")!.click();
    });
    const dialog = await waitFor(() => {
      const d = document.querySelector<HTMLElement>("[data-matter-modal='evidence-save-view']");
      expect(d).not.toBeNull();
      return d!;
    });
    const input = dialog.querySelector<HTMLInputElement>("#saved-view-name")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "My view");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      within(dialog).getByRole("button", { name: /save view/i }).click();
    });
    await waitFor(() => {
      const toasts = document.querySelector(".toast-container")?.textContent ?? "";
      expect(toasts.trim().length).toBeGreaterThan(0);
      expect(toasts).not.toMatch(/created/i);
    });
    // The dialog stays open so the input is not lost.
    expect(document.querySelector("[data-matter-modal='evidence-save-view']")).not.toBeNull();
  });

  it("asks before deleting a saved view", async () => {
    H.savedViews = [
      {
        id: "view-1",
        name: "Fictional view",
        description: null,
        scope: "active",
        filters: { sort: "newest" },
        isDefault: false,
        teamId: null,
      },
    ];
    await mount();
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-evidence-saved-views-trigger]")!.click();
    });
    const dialog = await waitFor(() => {
      const d = document.querySelector<HTMLElement>("[data-matter-modal='evidence-saved-views']");
      expect(d).not.toBeNull();
      return d!;
    });
    await act(async () => {
      within(dialog).getByRole("button", { name: /^delete$/i }).click();
    });
    expect(count("/v1/evidence/saved-views/view-1", "DELETE")).toBe(0);
    await act(async () => {
      within(dialog).getByRole("button", { name: /confirm delete/i }).click();
    });
    await waitFor(() => expect(count("/v1/evidence/saved-views/view-1", "DELETE")).toBe(1));
  });
});
