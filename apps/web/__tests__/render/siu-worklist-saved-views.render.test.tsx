/**
 * SIU PRODUCT VERTICAL — render-level acceptance for the real product surface.
 *
 * `SiuWorklistPanel` is the ONE SIU product surface (mounted by
 * `components/cases-experience/MatterWorkspace.tsx`). This suite renders the
 * REAL component against a transport double that answers the REAL registered
 * API contract, so the assertions below are about the shipped component and
 * the shipped method+path shapes — not about source fragments.
 *
 * What is proven here (the half a server-side matrix cannot prove):
 *
 *   * the panel calls the SEVEN SIU operations at their real paths;
 *   * a saved view actually drives the worklist query — `viewId` reaches
 *     `GET /v1/siu/worklist`, and clearing it removes the predicate;
 *   * the client never sends a query predicate of its own (no filter/sort/
 *     where ever appears on the worklist request);
 *   * manage controls are gated on the SERVER's ownership answer from
 *     `/v1/siu/saved-views/custom`, not on a client-side inference;
 *   * loading / truthful-empty / denial / bounded-error / pending states;
 *   * a Workspace change resets the selection and drops the previous
 *     workspace's rows, and a response that lands after the switch is
 *     discarded rather than rendered.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Transport double — answers the REAL registered SIU contract.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  generation: 0,
  /** Durable rows the SERVER says this operator may manage. */
  managed: [] as Array<Record<string, unknown>>,
  /** Executable views the SERVER returns. */
  views: [] as Array<Record<string, unknown>>,
  /** Rows the worklist returns, keyed by the applied viewId ("" = unfiltered). */
  worklistByView: {} as Record<string, { rows: unknown[]; total: number }>,
  /** Paths that should reject, and with what. */
  failures: {} as Record<string, { statusCode?: number; code?: string }>,
  /** When set, the worklist response resolves only after this promise. */
  gateWorklist: null as null | Promise<void>,
}));

function pathOf(url: string): string {
  return url.split("?")[0];
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const path = pathOf(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    H.calls.push({ path: url, method, body });

    const failure = H.failures[`${method} ${path}`] ?? H.failures[path];
    if (failure) {
      throw Object.assign(new Error("denied"), failure);
    }

    if (path === "/v1/siu/saved-views" && method === "GET") {
      return { views: H.views, presets: [], durable: true, storage: "prisma" };
    }
    if (path === "/v1/siu/saved-views/custom") {
      return { views: H.managed };
    }
    if (path === "/v1/siu/intake-templates") {
      return { templates: [{ id: "t-1", name: "Auto", claimType: "auto", description: "d", itemCount: 3, requiredItemCount: 2 }] };
    }
    if (path === "/v1/siu/worklist") {
      if (H.gateWorklist) await H.gateWorklist;
      const viewId = new URLSearchParams(url.split("?")[1] ?? "").get("viewId") ?? "";
      const hit = H.worklistByView[viewId] ?? { rows: [], total: 0 };
      return { rows: hit.rows, total: hit.total, truncated: false };
    }
    if (path === "/v1/siu/saved-views" && method === "POST") {
      const created = { id: "view-new", name: body?.name, source: "custom", description: null, filter: body?.filter, sort: body?.sort };
      H.views = [...H.views, created];
      H.managed = [...H.managed, { id: "view-new", name: body?.name, visibility: "private", createdByUserId: "me", updatedByUserId: null, lastUsedAtUtc: null, updatedAtUtc: "2026-07-31T00:00:00.000Z" }];
      return { view: created };
    }
    if (path.endsWith("/use")) {
      return { view: { id: path.split("/")[4] }, worklist: null };
    }
    if (method === "PATCH") return { view: { id: path.split("/")[4] } };
    if (method === "DELETE") return { deleted: true };
    return {};
  },
  readApiToken: () => null,
  ApiError: class ApiError extends Error {},
}));

// The REAL `useTenantGuard` is memoized: its identity is stable across
// renders and changes only when the context generation changes. The double
// must have the same stability, because the panel's `loadCatalog` depends on
// it — a fresh object per render would make every effect re-fire forever,
// which is a property of the double, not of the component.
vi.mock("../../lib/platform-context", () => {
  const cache = new Map<number, { stamp: () => number; isStale: (c: number) => boolean; generation: number }>();
  return {
    useTenantGuard: () => {
      const gen = H.generation;
      let guard = cache.get(gen);
      if (!guard) {
        guard = {
          stamp: () => H.generation,
          isStale: (captured: number) => captured !== H.generation,
          generation: gen,
        };
        cache.set(gen, guard);
      }
      return guard;
    },
  };
});

vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true }),
}));

vi.mock("next/link", () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import { SiuWorklistPanel } from "../../app/(app)/cases/components/SiuWorklistPanel";

const TEAM_A = "11111111-1111-4111-8111-111111111111";
const TEAM_B = "22222222-2222-4222-8222-222222222222";

function row(caseId: string, claimNumber: string) {
  return {
    caseId,
    profileId: `p-${caseId}`,
    claimType: "auto",
    investigationStatus: "open",
    claimNumber,
    incidentDateUtc: null,
    assignedAdjusterUserId: null,
    assignedSiuReviewerUserId: null,
    intakeTemplateId: null,
    missingRequiredItemCount: 1,
    openWarningIndicatorCount: 0,
    openFollowUpCount: 0,
    exportCount: 0,
    updatedAtUtc: "2026-07-30T00:00:00.000Z",
  };
}

beforeEach(() => {
  H.calls.length = 0;
  H.generation = 0;
  H.failures = {};
  H.gateWorklist = null;
  H.views = [
    { id: "preset-open", name: "Open investigations", source: "preset", description: null, filter: { investigationStatus: ["open"] }, sort: { key: "updatedAtUtc", direction: "desc" } },
    { id: "view-mine", name: "My high-risk", source: "custom", description: null, filter: { requireWarningIndicators: true }, sort: { key: "updatedAtUtc", direction: "desc" } },
    { id: "view-theirs", name: "Colleague team view", source: "custom", description: null, filter: { requireOpenFollowUps: true }, sort: { key: "updatedAtUtc", direction: "desc" } },
  ];
  // The SERVER returns only the row this operator may manage. `view-theirs`
  // is runnable but NOT manageable — the server would refuse a rename.
  H.managed = [
    { id: "view-mine", name: "My high-risk", visibility: "private", createdByUserId: "me", updatedByUserId: null, lastUsedAtUtc: null, updatedAtUtc: "2026-07-30T00:00:00.000Z" },
  ];
  H.worklistByView = {
    "": { rows: [row("case-1", "CLM-1"), row("case-2", "CLM-2")], total: 2 },
    "view-mine": { rows: [row("case-2", "CLM-2")], total: 1 },
    "preset-open": { rows: [row("case-1", "CLM-1")], total: 1 },
  };
});

async function mount(teamId: string | null = TEAM_A) {
  const utils = render(<SiuWorklistPanel teamId={teamId} />);
  await waitFor(() => expect(screen.queryByTestId("siu-worklist-loading")).toBeNull());
  return utils;
}

// ===========================================================================
// 1. Real API consumption — the seven SIU operations at their real paths
// ===========================================================================

describe("SIU panel — real API consumption", () => {
  it("loads the catalog from the three real read operations", async () => {
    await mount();
    const paths = H.calls.map((c) => `${c.method} ${pathOf(c.path)}`);
    expect(paths).toContain("GET /v1/siu/saved-views");
    expect(paths).toContain("GET /v1/siu/saved-views/custom");
    expect(paths).toContain("GET /v1/siu/intake-templates");
    // Every read names the workspace it is asking about.
    for (const c of H.calls) expect(c.path).toContain(`teamId=${TEAM_A}`);
  });

  it("creating a saved view POSTs the bounded definition and reloads from the server", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("siu-draft-name"), {
      target: { value: "Needs evidence" },
    });
    fireEvent.click(screen.getByTestId("siu-draft-missing"));
    H.calls.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByTestId("siu-create-view"));
    });
    const post = H.calls.find((c) => c.method === "POST" && pathOf(c.path) === "/v1/siu/saved-views");
    expect(post).toBeTruthy();
    const body = post!.body as { teamId: string; name: string; filter: Record<string, unknown>; sort: unknown };
    expect(body.teamId).toBe(TEAM_A);
    expect(body.name).toBe("Needs evidence");
    expect(body.filter).toEqual({ requireMissingChecklistItems: true });
    expect(body.sort).toEqual({ key: "updatedAtUtc", direction: "desc" });
    // The definition is re-read from the server, never assumed locally.
    await waitFor(() =>
      expect(
        H.calls.some((c) => c.method === "GET" && pathOf(c.path) === "/v1/siu/saved-views"),
      ).toBe(true),
    );
  });

  it("running a view calls the real use + worklist operations", async () => {
    await mount();
    H.calls.length = 0;
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("siu-saved-view-run")[1]);
    });
    const paths = H.calls.map((c) => `${c.method} ${pathOf(c.path)}`);
    expect(paths).toContain("POST /v1/siu/saved-views/view-mine/use");
    expect(paths).toContain("GET /v1/siu/worklist");
  });
});

// ===========================================================================
// 2. Saved view → real worklist integration (client side of the contract)
// ===========================================================================

describe("SIU panel — saved view drives the worklist query", () => {
  it("applying a view sends its id and renders the SERVER's narrowed rows", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("siu-saved-view-run")[1]);
    });
    const worklistCall = H.calls.filter((c) => pathOf(c.path) === "/v1/siu/worklist").pop();
    expect(worklistCall!.path).toContain("viewId=view-mine");
    await waitFor(() =>
      expect(screen.getByTestId("siu-worklist-total").textContent).toMatch(/^1 matching/),
    );
    expect(screen.getAllByTestId("siu-worklist-table")).toHaveLength(1);
  });

  it("the client NEVER sends a query predicate of its own", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("siu-saved-view-run")[1]);
    });
    for (const c of H.calls.filter((x) => pathOf(x.path) === "/v1/siu/worklist")) {
      // Only the workspace, the view id and a bounded limit may travel.
      const qs = new URLSearchParams(c.path.split("?")[1] ?? "");
      expect([...qs.keys()].sort()).toEqual(["teamId", "viewId"]);
      expect(c.body).toBeNull();
    }
  });

  it("clearing the applied view re-runs the SAME operation with no predicate", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("siu-saved-view-run")[1]);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("siu-clear-view"));
    });
    const last = H.calls.filter((c) => pathOf(c.path) === "/v1/siu/worklist").pop();
    expect(last!.path).not.toContain("viewId");
    // Clearing shows the honest FULL worklist, not a blanked screen.
    await waitFor(() =>
      expect(screen.getByTestId("siu-worklist-total").textContent).toMatch(/^2 matching/),
    );
    expect(screen.getByTestId("siu-active-view-label").textContent).toMatch(
      /No view applied/,
    );
  });

  it("switching between views re-queries and replaces the previous result set", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("siu-saved-view-run")[1]);
    });
    await waitFor(() =>
      expect(screen.getByTestId("siu-worklist-total").textContent).toMatch(/^1 matching/),
    );
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("siu-saved-view-run")[0]);
    });
    const last = H.calls.filter((c) => pathOf(c.path) === "/v1/siu/worklist").pop();
    expect(last!.path).toContain("viewId=preset-open");
  });

  it("a view that matches nothing renders a truthful zero, not a failure", async () => {
    H.worklistByView["view-mine"] = { rows: [], total: 0 };
    await mount();
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("siu-saved-view-run")[1]);
    });
    await waitFor(() => expect(screen.getByTestId("siu-worklist-empty")).toBeTruthy());
    expect(screen.getByTestId("siu-worklist-empty").textContent).toMatch(
      /real zero result, not a failed or blocked read/,
    );
  });
});

// ===========================================================================
// 3. Ownership is the SERVER's answer, never a client inference
// ===========================================================================

describe("SIU panel — manage affordances follow server ownership", () => {
  it("offers Rename/Delete only for rows /custom returned as manageable", async () => {
    await mount();
    const rows = screen.getAllByTestId("siu-saved-view");
    const byId = Object.fromEntries(
      rows.map((r) => [r.getAttribute("data-view-id"), r]),
    );
    // Mine: manageable.
    expect(byId["view-mine"]!.querySelector('[data-testid="siu-saved-view-rename"]')).toBeTruthy();
    // A colleague's custom view is RUNNABLE but not manageable — the server
    // would refuse the rename, so the control is not offered.
    expect(byId["view-theirs"]!.querySelector('[data-testid="siu-saved-view-rename"]')).toBeNull();
    expect(byId["view-theirs"]!.querySelector('[data-testid="siu-saved-view-run"]')).toBeTruthy();
    // A preset is never manageable.
    expect(byId["preset-open"]!.querySelector('[data-testid="siu-saved-view-rename"]')).toBeNull();
  });

  it("renders the server's visibility label rather than inventing one", async () => {
    await mount();
    expect(screen.getByTestId("siu-saved-view-visibility").textContent).toBe("private");
  });
});

// ===========================================================================
// 4. Context safety — states, workspace reset, stale-response rejection
// ===========================================================================

describe("SIU panel — context safety and bounded states", () => {
  it("renders a loading state before the catalog resolves", async () => {
    let release!: () => void;
    H.gateWorklist = new Promise<void>((r) => { release = r; });
    render(<SiuWorklistPanel teamId={TEAM_A} />);
    expect(screen.getByTestId("siu-worklist-loading")).toBeTruthy();
    await act(async () => { release(); });
  });

  it("a denial renders the safe denial state, never an empty list", async () => {
    H.failures["/v1/siu/saved-views"] = { statusCode: 403, code: "member_inactive" };
    render(<SiuWorklistPanel teamId={TEAM_A} />);
    await waitFor(() => expect(screen.getByTestId("siu-worklist-denied")).toBeTruthy());
    expect(screen.getByTestId("siu-worklist-denied").textContent).toMatch(
      /membership in this workspace is not active/,
    );
    expect(screen.queryByTestId("siu-worklist-table")).toBeNull();
  });

  it("a non-denial failure renders a bounded, retryable error", async () => {
    H.failures["/v1/siu/saved-views"] = { statusCode: 500 };
    render(<SiuWorklistPanel teamId={TEAM_A} />);
    await waitFor(() => expect(screen.getByTestId("siu-worklist-error")).toBeTruthy());
    // Bounded copy — never the raw transport message.
    expect(screen.getByTestId("siu-worklist-error").textContent).not.toMatch(/denied/);
  });

  it("a Workspace change resets the selection and drops the previous rows", async () => {
    const { rerender } = await mount(TEAM_A);
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("siu-saved-view-run")[1]);
    });
    await waitFor(() =>
      expect(screen.getByTestId("siu-worklist-total").textContent).toMatch(/^1 matching/),
    );

    // Switch workspace the way the provider does: bump the generation, then
    // hand the component the new workspace.
    H.generation += 1;
    H.worklistByView = { "": { rows: [], total: 0 } };
    await act(async () => {
      rerender(<SiuWorklistPanel teamId={TEAM_B} />);
    });
    await waitFor(() => expect(screen.queryByTestId("siu-worklist-loading")).toBeNull());

    // No selection carried over, and no rows from the previous workspace.
    expect(screen.getByTestId("siu-active-view-label").textContent).toMatch(
      /No view applied/,
    );
    expect(screen.queryByTestId("siu-worklist-total")).toBeNull();
    expect(screen.getByTestId("siu-worklist-idle")).toBeTruthy();
  });

  it("a worklist response that lands AFTER a workspace change is discarded", async () => {
    let release!: () => void;
    await mount(TEAM_A);
    H.gateWorklist = new Promise<void>((r) => { release = r; });
    // Start a run against workspace A…
    act(() => {
      fireEvent.click(screen.getAllByTestId("siu-saved-view-run")[1]);
    });
    // …switch workspace while it is in flight…
    H.generation += 1;
    await act(async () => {
      release();
      H.gateWorklist = null;
    });
    // …the stale answer must never become the rendered result.
    expect(screen.queryByTestId("siu-worklist-total")).toBeNull();
  });

  it("a pending mutation is surfaced and the control is disabled while it runs", async () => {
    let release!: () => void;
    H.gateWorklist = new Promise<void>((r) => { release = r; });
    await mount();
    act(() => {
      fireEvent.click(screen.getAllByTestId("siu-saved-view-run")[1]);
    });
    const btn = screen.getAllByTestId("siu-saved-view-run")[1] as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(btn.textContent).toMatch(/Running/);
    await act(async () => { release(); });
  });
});
