/**
 * TEAM-SPEC §3 — the /review console ("My reviews") over the REAL API shape.
 *
 * The console read `id / stage / status / dueAtUtc`; the API sends
 * `workflowId / lifecycleState / legacy.stage / legacy.dueAt`. Stage, Status
 * and Due showed "—", the row checkbox was disabled and a/e/m were dead. Rows
 * now go through the shared `toQueueRow`.
 *
 * TEAM-UI-SPEC round 3: rows are Open (ghost) + at most one secondary
 * (Assign, via the shared reviewer picker); Escalate / Request info and the
 * e / m shortcuts are gone; canonical classes only; compact mobile row.
 *
 * Also pinned here: the reviewer command palette is gone (Ctrl/Cmd+K opens
 * only the app-wide palette, which this console does not mount), the inline
 * dialogs are the canonical Modal, and the bulk bar follows plan + role (R1),
 * never the workspace kind — a Team-entitled PERSONAL workspace gets it.
 *
 * Real component, real apiFetch over a stubbed fetch, RTL cleanup().
 */
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/review",
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
import { ReviewerConsole } from "../../components/reviewer-experience/ReviewerConsole";
import { toQueueRow } from "../../components/reviewer-experience/queueRow";
import { setActiveWorkspaceId } from "../../lib/api";

const WS = "77777777-7777-4777-8777-777777777777";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKFLOW = "11111111-2222-4333-8444-555555555555";
const EVIDENCE = "99999999-8888-4777-8666-555555555555";

/** `buildWorkflowProjection`, field for field. */
const projection = {
  workflowId: WORKFLOW,
  evidenceId: EVIDENCE,
  teamId: WS,
  lifecycleState: "IN_REVIEW",
  assignedToUserId: null,
  assignedAtUtc: null,
  priority: "HIGH",
  slaPausedAtUtc: null,
  pausedReason: null,
  slaRollupState: "ON_TRACK",
  slaDimensions: [],
  legacy: { id: WORKFLOW, stage: "SECOND_REVIEW", dueAt: "2026-12-01T10:00:00.000Z" },
};

/** Stage C (T-055) — per-test overrides of the console envelope sections. */
let envelopeOverride: Record<string, unknown> = {};

function consoleEnvelope() {
  return {
    ...baseConsoleEnvelope(),
    ...envelopeOverride,
  };
}

function baseConsoleEnvelope() {
  return {
    generatedAt: "2026-11-23T00:00:00.000Z",
    teamId: WS,
    reviewer: { userId: ME, isReviewerCapable: true },
    queue: { rows: [projection], status: "ok", count: 1 },
    mine: { rows: [], status: "ok", count: 0 },
    escalations: { rows: [], status: "ok", count: 0 },
    sla: { snapshot: null, status: "ok" },
    workload: { rows: [], status: "ok", count: 0 },
    savedViews: { rows: [], status: "ok", count: 0 },
    diagnostics: { sectionStatus: { queue: "ok", mine: "ok" }, sectionLimit: 25 },
  };
}

const REVIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let routingRecs: unknown[] = [];
let assignBodies: Array<Record<string, unknown>> = [];
beforeEach(() => {
  envelopeOverride = {};
  routingRecs = [];
  assignBodies = [];
  setActiveWorkspaceId(WS);
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/v1/reviewer/routing-recommendations")) {
      return new Response(JSON.stringify({ recommendations: routingRecs }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path.startsWith("/v1/reviewer-ops/assignable-reviewers")) {
      return new Response(
        JSON.stringify({ reviewers: [{ userId: REVIEWER, displayName: "Rae Viewer", role: "MEMBER", status: "ACTIVE" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (path.startsWith(`/v1/reviewer-ops/reviews/${WORKFLOW}/assign`)) {
      assignBodies.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path.startsWith("/v1/reviewer-ops/console")) {
      return new Response(JSON.stringify(consoleEnvelope()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: { code: "not_found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

type Role = "OWNER" | "VIEWER";
function envelope(role: Role) {
  const owner = role === "OWNER";
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {
      EVIDENCE_VIEW: true,
      REVIEWER_OPS_VIEW: true,
      SLA_VIEW: true,
      ESCALATIONS_VIEW: true,
      ...(owner
        ? { REVIEWER_OPS_ACT: true, REVIEW_ASSIGN: true, BULK_ACTIONS: true, EVIDENCE_MANAGE: true }
        : {}),
    },
    diagnostics: { requestId: `team-review-console-${role}` },
    user: { id: ME, email: null, displayName: null, firstName: null, lastName: null, avatarUrl: null, locale: null, timezone: null },
    // A PERSONAL workspace on the Team plan (TEAM-SPEC R1).
    workspace: { id: WS, name: "Personal Space", status: "active", scope: "PERSONAL", membership: { role } },
    activeSpace: { type: "PERSONAL", id: WS, displayName: "Personal Space", roleLabel: owner ? "Owner" : "VIEWER" },
    personalSpace: { id: WS, status: "active" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
    },
    account: { accountPlan: "TEAM", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: { reviewerOperationsIncluded: true, reviewQueuesIncluded: true, externalReviewIncluded: true },
  };
}

async function settle() {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function mount(role: Role) {
  const view = render(
    <PlatformContextProvider testEnvelope={envelope(role) as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <ReviewerConsole teamId={WS} />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
  return view;
}

const row = () => document.querySelector(`tr[data-reviewer-workflow-id="${WORKFLOW}"]`) as HTMLElement | null;

describe("shared toQueueRow — the real projection", () => {
  it("maps workflowId / lifecycleState / legacy.stage / legacy.dueAt", () => {
    expect(toQueueRow(projection)).toEqual({
      id: WORKFLOW,
      evidenceId: EVIDENCE,
      status: "IN_REVIEW",
      stage: "SECOND_REVIEW",
      priority: "HIGH",
      assignedToUserId: null,
      dueAt: "2026-12-01T10:00:00.000Z",
      slaState: "ON_TRACK",
    });
  });
});

describe("/review console — rows from the API shape", () => {
  it("shows stage, status and due, and the row is actionable with an enabled checkbox (Team personal owner)", async () => {
    await mount("OWNER");
    const tr = row();
    expect(tr, "the populated row renders").not.toBeNull();
    expect(tr!.getAttribute("data-reviewer-row-actionable")).toBe("true");
    expect(tr!.querySelector("[data-reviewer-row-stage]")!.textContent).not.toBe("—");
    expect(tr!.querySelector("[data-reviewer-row-stage]")!.textContent).toMatch(/second/i);
    expect(tr!.textContent).toMatch(/in review/i);
    expect(tr!.querySelector("[data-reviewer-row-due]")!.textContent).not.toBe("—");
    const checkbox = tr!.querySelector(`[data-reviewer-bulk-row-checkbox="${WORKFLOW}"]`) as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(false);
    // R1 — the bulk bar is live in a Team PERSONAL workspace for an owner.
    expect(document.querySelector("[data-reviewer-bulk-unavailable-banner]")).toBeNull();
  });

  // TEAM-UI-SPEC §4 (round 3) — 'a' mirrors the row's Assign and opens the
  // shared reviewer picker (canonical Modal); 'e' / 'm' left with the row's
  // Escalate / Request info.
  it("'a' on the focused unassigned row opens the reviewer picker; 'e' and 'm' open nothing", async () => {
    await mount("OWNER");
    for (const key of ["e", "m"]) {
      await act(async () => {
        fireEvent.keyDown(window, { key });
      });
      expect(document.querySelector("[data-matter-modal]"), key).toBeNull();
    }
    await act(async () => {
      fireEvent.keyDown(window, { key: "a" });
    });
    await settle();
    expect(document.querySelector('[data-matter-modal="reviewer-picker-modal"]')).not.toBeNull();
    expect(document.querySelector("[data-reviewer-picker-modal]")).not.toBeNull();
    // No free-text user-id field any more.
    expect(document.querySelector("[data-reviewer-assign-user-id]")).toBeNull();
  });

  it("rows show Open (ghost link) + at most one secondary (Assign), no Escalate / Request info", async () => {
    await mount("OWNER");
    const tr = row()!;
    const actions = tr.querySelector('[data-review-cell="actions"]') as HTMLElement;
    const open = actions.querySelector('[data-reviewer-action="open-inspector"]') as HTMLAnchorElement;
    expect(open.tagName).toBe("A");
    expect(open.className).toBe("app-ghost-action");
    expect(open.getAttribute("href")).toBe(`/reviewer-ops/${WORKFLOW}`);
    const secondaries = Array.from(actions.querySelectorAll(".app-secondary-action"));
    expect(secondaries.map((b) => b.textContent)).toEqual(["Assign"]);
    expect(actions.querySelectorAll(".app-primary-action").length).toBe(0);
    expect(document.querySelector('[data-reviewer-action="escalate"]')).toBeNull();
    expect(document.querySelector('[data-reviewer-action="request-info"]')).toBeNull();
    // The help text no longer advertises the removed shortcuts.
    expect(document.body.textContent).not.toMatch(/escalate · /);
    expect(document.body.textContent).not.toMatch(/request info · /);
  });

  it("row Assign → picker → Select assigns through the audited single-assign endpoint", async () => {
    await mount("OWNER");
    const assign = row()!.querySelector('[data-reviewer-action="assign"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(assign);
    });
    await settle();
    const pick = document.querySelector(`[data-reviewer-picker-select="${REVIEWER}"]`) as HTMLButtonElement;
    expect(pick.className).toBe("app-secondary-action");
    expect(document.querySelector("[data-reviewer-picker-cancel]")!.className).toBe("app-secondary-action");
    await act(async () => {
      fireEvent.click(pick);
    });
    await settle();
    expect(assignBodies).toEqual([{ teamId: WS, assignedToUserId: REVIEWER, note: null }]);
    expect(document.querySelector("[data-reviewer-action-flash]")!.textContent).toBe("Reviewer assigned.");
  });

  it("a Viewer (no REVIEW_ASSIGN) gets Open only", async () => {
    await mount("VIEWER");
    const actions = row()!.querySelector('[data-review-cell="actions"]') as HTMLElement;
    expect(actions.querySelector('[data-reviewer-action="open-inspector"]')).not.toBeNull();
    expect(actions.querySelectorAll("button").length).toBe(0);
  });

  it("no legacy ui-button; every button carries a canonical class; compact mobile row markup", async () => {
    await mount("OWNER");
    expect(document.querySelector(".ui-button")).toBeNull();
    const canonical = /\b(app-primary-action|app-secondary-action|app-ghost-action|app-danger-action|app-tab|app-listbox__trigger)\b/;
    // The shared ContextualHelp disclosure is not a console control.
    for (const b of Array.from(document.querySelectorAll("button"))) {
      if (b.closest("[data-contextual-help]")) continue;
      expect(b.className, b.outerHTML.slice(0, 120)).toMatch(canonical);
    }
    const table = document.querySelector("[data-reviewer-console-table]") as HTMLElement;
    expect(table.classList.contains("app-table")).toBe(true);
    expect(table.hasAttribute("data-responsive")).toBe(true);
    const tr = row()!;
    for (const cell of ["check", "ref", "priority", "status", "due", "actions"]) {
      expect(tr.querySelector(`[data-review-cell="${cell}"]`), cell).not.toBeNull();
    }
    // The keyboard-selected row carries the canonical selected state.
    expect(tr.getAttribute("data-selected")).toBe("true");
  });

  it("queue switch is app-tabs with counts; no workspace-health link; no empty routing panel", async () => {
    await mount("OWNER");
    const tabs = Array.from(document.querySelectorAll("[data-tab-id]")) as HTMLElement[];
    for (const t of tabs) {
      expect(t.classList.contains("app-tab")).toBe(true);
      expect(t.querySelector(".app-tab__count")).not.toBeNull();
    }
    expect(document.querySelector("[data-reviewer-console-ia]")).toBeNull();
    expect(document.body.textContent).not.toMatch(/workspace health/i);
    expect(document.querySelector('[data-cc-panel="reviewer-routing-recommendations"]')).toBeNull();
  });

  it("routing recommendations render when there are some", async () => {
    routingRecs = [
      {
        id: "r1",
        severity: "WARNING",
        recommendationType: "REBALANCE",
        reasonCode: "OVERLOADED",
        explanation: "One reviewer holds most of the queue.",
        createdAt: "2026-11-22T10:00:00.000Z",
      },
    ];
    await mount("OWNER");
    await settle();
    expect(document.querySelector('[data-cc-panel="reviewer-routing-recommendations"]')).not.toBeNull();
  });

  it("a Viewer gets no bulk checkboxes and the plan + role explanation instead", async () => {
    await mount("VIEWER");
    expect(row()).not.toBeNull();
    expect(document.querySelector("[data-reviewer-bulk-row-checkbox]")).toBeNull();
    expect(document.querySelector("[data-reviewer-bulk-unavailable-banner]")?.textContent).toMatch(
      /owners and admins on the Team plan/,
    );
  });
});

describe("/review console — the reviewer command palette is removed", () => {
  it("renders no palette trigger and Ctrl/Cmd+K opens no reviewer palette", async () => {
    const view = await mount("OWNER");
    expect(view.queryByText("Command palette")).toBeNull();
    expect(document.querySelector("[data-reviewer-command-palette-open]")).toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    expect(document.querySelector('[aria-label="Reviewer command palette"]')).toBeNull();
    expect(document.querySelector(".reviewer-console__palette")).toBeNull();
    // Ctrl+K is a chord: the console's own 'k' (move up) did not fire either,
    // and no action dialog opened.
    expect(document.querySelector("[data-matter-modal]")).toBeNull();
  });

  it("offers only the two review slices — no Escalations / SLA / Workload tabs", async () => {
    await mount("OWNER");
    const tabs = Array.from(document.querySelectorAll("[data-tab-id]")).map((t) => t.getAttribute("data-tab-id"));
    expect(tabs).toEqual(["queue", "mine"]);
  });
});

describe("T-055 (stage C) — console tab counts", () => {
  it("a tab shows the slice's total (not the first page) and a degraded section shows no number", async () => {
    envelopeOverride = {
      queue: { rows: [projection], status: "ok", count: 40, unit: "reviews" },
      mine: { rows: [], status: "degraded", count: null, unit: "reviews" },
      diagnostics: { sectionStatus: { queue: "ok", mine: "degraded" }, sectionLimit: 25 },
    };
    await mount("OWNER");
    const tab = (id: string) => document.querySelector(`[data-tab-id="${id}"]`) as HTMLElement;
    expect(tab("queue").querySelector("[data-tab-count]")?.textContent).toBe("40");
    const mine = tab("mine");
    expect(mine.querySelector("[data-tab-count]")).toBeNull();
    expect(mine.querySelector("[data-tab-count-unknown]")?.textContent).toBe("—");
    expect(mine.textContent).not.toMatch(/0/);
  });
});
