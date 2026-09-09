/**
 * COLLABORATION TEAM — the assignment launcher and its case picker, driven.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * The reported defect was "clicking Talal does not select the case". Every
 * source-text assertion one could write about that picker PASSED: the rows had
 * an `onClick`, the handler called `setTargetId`, the id went into the payload.
 * The state machine was never broken.
 *
 * What was broken was everything the operator could observe. The option rows
 * carried `app-listbox-option` / `app-listbox-option--selected` — class names
 * that match no rule in any stylesheet, the canonical primitive being
 * `.app-listbox__option`. So clicking a case produced no hover, no selected
 * background, no change to the field (still showing the typed query) and no
 * closing of the list. The only visible difference between "selected" and
 * "did nothing" was that the submit button stopped being disabled, three
 * fields further down.
 *
 * A markup test cannot see that, and neither can a test that asserts on state.
 * So this file mounts the REAL team detail page, opens the REAL dialog from
 * BOTH entry points, and operates the picker the way a person does — with a
 * mouse and with a keyboard. Every assertion is about what the operator sees
 * and what the server is asked for.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

const TEAM_ID = "77777777-7777-4777-8777-777777777777";
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const TALAL_ID = "c1000000-0000-4000-8000-0000000000a1";
const BILAL_ID = "c1000000-0000-4000-8000-0000000000b1";

const H = vi.hoisted(() => {
  class FakeApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`http ${status}`);
      this.status = status;
    }
  }
  return {
    FakeApiError,
    /** Every request the page makes, in order. */
    requestLog: [] as Array<{ path: string; method: string; body: unknown }>,
    /** Team lifecycle, so the archived case can be driven from one place. */
    teamStatus: "ACTIVE" as "ACTIVE" | "ARCHIVED",
    /** How many assignments the Work tab is told exist. */
    assignmentCount: 0,
  };
});

/** The two cases the operator can choose between, as the server sends them. */
const CANDIDATES = [
  { id: TALAL_ID, label: "Talal", sublabel: null, status: "OPEN" },
  { id: BILAL_ID, label: "Bilal", sublabel: null, status: "OPEN" },
];

function teamDetail() {
  const iso = "2026-09-01T00:00:00.000Z";
  return {
    id: TEAM_ID,
    workspaceId: WORKSPACE_ID,
    name: "Meridian Incident Response",
    description: null,
    teamType: "INVESTIGATION",
    status: H.teamStatus,
    createdAt: iso,
    updatedAt: iso,
    archivedAtUtc: H.teamStatus === "ARCHIVED" ? iso : null,
    viewerRole: "LEAD",
    activeMemberCount: 1,
    pendingInviteCount: 0,
    memberPreviewLimit: 25,
    members: [
      {
        id: "m-1",
        userId: "u-1",
        role: "LEAD",
        status: "ACTIVE",
        joinedAt: iso,
        suspendedAt: null,
        removedAt: null,
        user: {
          id: "u-1",
          email: "lead@meridian.test",
          displayName: "Case Lead",
          firstName: null,
          lastName: null,
          avatarUrl: null,
        },
      },
    ],
    invites: [],
    assignmentCount: H.assignmentCount,
  };
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    H.requestLog.push({ path, method, body });

    if (path.includes("/assignable-targets")) {
      // The server is what filters. `q` is echoed through the same matcher a
      // real search would apply, so a test that types "Tal" is exercising the
      // picker's request contract and not a local array filter.
      const q = new URL(`https://x.test${path}`).searchParams.get("q");
      const targets = q
        ? CANDIDATES.filter((c) =>
            c.label.toLowerCase().includes(q.toLowerCase()),
          )
        : CANDIDATES;
      return { targets };
    }
    if (path.includes("/assignments") && method === "POST") {
      H.assignmentCount += 1;
      return { assignment: { id: "a-1" } };
    }
    if (path.includes("/assignments")) {
      return { assignments: [], nextCursor: null, total: 0 };
    }
    if (path.endsWith("/entitlement")) {
      return {
        plan: "TEAM",
        collaborationTeams: { limit: 10, used: 1 },
        collaborationTeamMembers: { limit: 10, used: 1 },
      };
    }
    if (path.includes("/disposability")) {
      return { disposition: { disposable: false, blockers: ["ACTIVITY"] } };
    }
    if (path.includes("/activity")) {
      return { items: [], nextCursor: null };
    }
    if (path.includes("/overview")) {
      return { workload: [], health: [] };
    }
    return { team: teamDetail(), viaWorkspaceGovernance: false };
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: H.FakeApiError,
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

const pushed: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => pushed.push(href),
    replace: () => {},
    back: () => {},
  }),
  useSearchParams: () => new URLSearchParams("tab=work"),
  usePathname: () => `/collaboration-teams/${TEAM_ID}`,
  useParams: () => ({ teamId: TEAM_ID }),
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
import TeamDetailPage from "../../app/(app)/collaboration-teams/[teamId]/page";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function envelope(): unknown {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {},
    diagnostics: { requestId: "team-picker" },
    workspace: {
      id: WORKSPACE_ID,
      name: "Meridian Legal",
      status: "active",
      scope: "ORGANIZATION",
    },
    activeSpace: {
      type: "ORGANIZATION",
      id: WORKSPACE_ID,
      displayName: "Meridian Legal",
      roleLabel: "Owner",
    },
    personalSpace: { id: "p-1", displayName: "Personal", available: true },
    plan: { tier: "TEAM", features: {} },
  };
}

async function mountTeamPage() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PlatformContextProvider testEnvelope={envelope() as never}>
        <ToastProvider>
          <ConfirmActionProvider>
            <TeamDetailPage />
          </ConfirmActionProvider>
        </ToastProvider>
      </PlatformContextProvider>,
    );
  });
  // The detail load, the entitlement chip and the Work tab's first query.
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

/** The dialog's POST body, or null if it was never sent. */
function lastCreateBody(): Record<string, unknown> | null {
  const hit = [...H.requestLog]
    .reverse()
    .find((r) => r.method === "POST" && r.path.includes("/assignments"));
  return (hit?.body as Record<string, unknown>) ?? null;
}

beforeEach(() => {
  H.requestLog.length = 0;
  H.teamStatus = "ACTIVE";
  H.assignmentCount = 0;
  pushed.length = 0;
});

// ---------------------------------------------------------------------------
// 1. ONE FLOW, TWO DOORS
// ---------------------------------------------------------------------------

describe("Create assignment — one implementation, two entry points", () => {
  it("the team header offers it beside Add people and Discussion", async () => {
    const view = await mountTeamPage();
    const header = view.getByTestId("team-detail-header");
    const create = view.getByTestId("header-create-assignment-button");
    expect(header.contains(create)).toBe(true);
    // The SAME visual family as Discussion, and not the header's primary —
    // two filled controls side by side say the reader has two first choices.
    expect(create.className).toContain("app-secondary-action");
    expect(create.className).not.toContain("app-primary-action");
    expect(
      view.getByTestId("collaboration-hub-link").className,
    ).toContain("app-secondary-action");
    expect(view.getByTestId("quick-invite-button").className).toContain(
      "app-primary-action",
    );
  });

  it("both buttons open the same dialog, and only ever one of it", async () => {
    const view = await mountTeamPage();

    for (const testid of [
      "header-create-assignment-button",
      "create-assignment-button",
    ]) {
      await act(async () => {
        fireEvent.click(view.getByTestId(testid));
      });
      // `getAllBy` rather than `getBy`: a duplicated dialog is exactly the
      // failure a second header implementation would have introduced, and
      // `getBy` would report it as "found multiple" rather than as the
      // duplication it is.
      expect(view.getAllByTestId("create-assignment-modal")).toHaveLength(1);
      await act(async () => {
        fireEvent.click(view.getByText("Cancel"));
      });
    }
  });

  it("an archived team offers it in neither place", async () => {
    H.teamStatus = "ARCHIVED";
    const view = await mountTeamPage();
    expect(view.queryByTestId("header-create-assignment-button")).toBeNull();
    expect(view.queryByTestId("create-assignment-button")).toBeNull();
    // The lifecycle is stated rather than discovered by a refused action.
    expect(view.getByTestId("team-archived-banner")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. THE CASE PICKER
// ---------------------------------------------------------------------------

describe("Create assignment — the case picker", () => {
  async function openDialog(view: Awaited<ReturnType<typeof mountTeamPage>>) {
    await act(async () => {
      fireEvent.click(view.getByTestId("header-create-assignment-button"));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("does not dump the workspace's cases before it is asked", async () => {
    const view = await mountTeamPage();
    await openDialog(view);
    // The field is there; the list is not, until the operator asks for it.
    expect(view.getByTestId("assignment-target-search")).toBeTruthy();
    expect(view.queryByTestId("assignment-target-search-options")).toBeNull();
    expect(view.queryByText("Talal")).toBeNull();
  });

  it("opens on focus, and closes again on Escape", async () => {
    const view = await mountTeamPage();
    await openDialog(view);
    const field = view.getByTestId("assignment-target-search");

    await act(async () => {
      fireEvent.focus(field);
    });
    expect(field.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByTestId("assignment-target-search-options")).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(field, { key: "Escape" });
    });
    expect(field.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByTestId("assignment-target-search-options")).toBeNull();
  });

  it("searching asks the SERVER, and narrows to the match", async () => {
    const view = await mountTeamPage();
    await openDialog(view);
    const field = view.getByTestId("assignment-target-search");

    await act(async () => {
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: "Tal" } });
    });
    // The query is debounced, so the request has not gone yet.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    const asked = H.requestLog.filter((r) =>
      r.path.includes("/assignable-targets"),
    );
    expect(asked.some((r) => r.path.includes("q=Tal"))).toBe(true);
    expect(view.getByTestId(`assignment-target-search-option-${TALAL_ID}`)).toBeTruthy();
    expect(
      view.queryByTestId(`assignment-target-search-option-${BILAL_ID}`),
    ).toBeNull();
  });

  /**
   * THE REGRESSION.
   *
   * This is the click that "did nothing". Each assertion below is one of the
   * things that did not happen when it was clicked, and every one of them is
   * observable — the field's text, the menu's presence, the selected-state
   * attribute, the id the form will submit.
   */
  it("clicking a case selects it, shows it, and closes the menu", async () => {
    const view = await mountTeamPage();
    await openDialog(view);
    const field = view.getByTestId(
      "assignment-target-search",
    ) as HTMLInputElement;

    await act(async () => {
      fireEvent.focus(field);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const talal = view.getByTestId(`assignment-target-search-option-${TALAL_ID}`);
    // The row is a real option in a real listbox, not a styled div.
    expect(talal.getAttribute("role")).toBe("option");
    expect(talal.getAttribute("aria-selected")).toBe("false");

    await act(async () => {
      fireEvent.click(talal);
    });

    // 1. the field shows the chosen record
    expect(field.value).toBe("Talal");
    expect(field.getAttribute("data-has-selection")).toBe("true");
    // 2. the dialog says which record is being assigned
    expect(view.getByTestId("assignment-target-selected").textContent).toBe(
      "Talal",
    );
    // 3. the menu closed
    expect(view.queryByTestId("assignment-target-search-options")).toBeNull();
    expect(field.getAttribute("aria-expanded")).toBe("false");
    // 4. the chosen id — not the label, not an index — is what the form holds
    expect(
      (view.getByTestId("assignment-target-id") as HTMLInputElement).value,
    ).toBe(TALAL_ID);
    // 5. and the submit is now reachable
    expect(
      (view.getByTestId("assignment-submit") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("re-opening keeps the selection until a different case is chosen", async () => {
    const view = await mountTeamPage();
    await openDialog(view);
    const field = view.getByTestId(
      "assignment-target-search",
    ) as HTMLInputElement;

    await act(async () => {
      fireEvent.focus(field);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(
        view.getByTestId(`assignment-target-search-option-${TALAL_ID}`),
      );
    });
    expect(field.value).toBe("Talal");

    // Opening again offers the unfiltered candidates rather than the stale
    // query that happened to find this one, and the previous choice is still
    // marked so the operator can see what they are replacing.
    await act(async () => {
      fireEvent.click(field);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      view
        .getByTestId(`assignment-target-search-option-${TALAL_ID}`)
        .getAttribute("aria-selected"),
    ).toBe("true");

    await act(async () => {
      fireEvent.click(
        view.getByTestId(`assignment-target-search-option-${BILAL_ID}`),
      );
    });
    expect(field.value).toBe("Bilal");
    expect(
      (view.getByTestId("assignment-target-id") as HTMLInputElement).value,
    ).toBe(BILAL_ID);
  });

  it("selection does not depend on a mouse", async () => {
    const view = await mountTeamPage();
    await openDialog(view);
    const field = view.getByTestId(
      "assignment-target-search",
    ) as HTMLInputElement;

    /*
     * TAB INTO THE FIELD, THEN WAIT FOR THE CANDIDATES.
     *
     * The rows are fetched, and an ArrowDown that arrives before they do has
     * nothing to make active — so driving the arrows from the instant the menu
     * opens made this case pass alone and fail in a full run, which is the
     * shape of a flake, not of a finding. A person sees the rows before they
     * arrow through them; so does this.
     *
     * `focus` is what Tab does. There is no pointer event anywhere below.
     */
    await act(async () => {
      fireEvent.focus(field);
    });
    await waitFor(() =>
      expect(
        view.getByTestId(`assignment-target-search-option-${TALAL_ID}`),
      ).toBeTruthy(),
    );

    // Two ArrowDowns walk to the second candidate; Enter takes it.
    await act(async () => {
      fireEvent.keyDown(field, { key: "ArrowDown" });
    });
    expect(field.getAttribute("aria-activedescendant")).toBe(
      "assignment-target-search-option-0",
    );
    await act(async () => {
      fireEvent.keyDown(field, { key: "ArrowDown" });
    });
    expect(field.getAttribute("aria-activedescendant")).toBe(
      "assignment-target-search-option-1",
    );
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });

    expect(field.value).toBe("Bilal");
    expect(
      (view.getByTestId("assignment-target-id") as HTMLInputElement).value,
    ).toBe(BILAL_ID);
  });

  /**
   * END TO END: the id the operator chose is the id the server is asked to
   * assign. Everything above is worth nothing if the payload carries a label,
   * a stale id, or the first candidate.
   */
  it("the chosen case id reaches the create payload", async () => {
    const view = await mountTeamPage();
    await openDialog(view);
    const field = view.getByTestId("assignment-target-search");

    await act(async () => {
      fireEvent.focus(field);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(
        view.getByTestId(`assignment-target-search-option-${TALAL_ID}`),
      );
    });
    await act(async () => {
      fireEvent.submit(view.getByTestId("create-assignment-modal"));
    });

    await waitFor(() => expect(lastCreateBody()).not.toBeNull());
    const body = lastCreateBody()!;
    expect(body.targetType).toBe("CASE");
    expect(body.targetId).toBe(TALAL_ID);
    // Not the label, and not the other candidate.
    expect(body.targetId).not.toBe("Talal");
    expect(body.targetId).not.toBe(BILAL_ID);
  });

  it("changing the target type clears a choice made for the old one", async () => {
    const view = await mountTeamPage();
    await openDialog(view);
    const field = view.getByTestId(
      "assignment-target-search",
    ) as HTMLInputElement;

    await act(async () => {
      fireEvent.focus(field);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(
        view.getByTestId(`assignment-target-search-option-${TALAL_ID}`),
      );
    });
    expect(
      (view.getByTestId("assignment-target-id") as HTMLInputElement).value,
    ).toBe(TALAL_ID);

    // A case id is meaningless as an evidence id. Carrying it across would be
    // a payload the server refuses, reported to the operator as their mistake.
    const typeTrigger = view.getByTestId("assignment-target-type")
      .querySelector("button[role='combobox']") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(typeTrigger);
    });
    await act(async () => {
      fireEvent.click(view.getByText("Evidence"));
    });
    expect(
      (view.getByTestId("assignment-target-id") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (view.getByTestId("assignment-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
