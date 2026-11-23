/**
 * TEAM-SPEC §3 — the /review console ("My reviews") over the REAL API shape.
 *
 * The console read `id / stage / status / dueAtUtc`; the API sends
 * `workflowId / lifecycleState / legacy.stage / legacy.dueAt`. Stage, Status
 * and Due showed "—", the row checkbox was disabled and a/e/m were dead. Rows
 * now go through the shared `toQueueRow`.
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

function consoleEnvelope() {
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

beforeEach(() => {
  setActiveWorkspaceId(WS);
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
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

  it("a/e/m shortcuts are live: 'a' on the focused row opens the canonical Modal", async () => {
    await mount("OWNER");
    await act(async () => {
      fireEvent.keyDown(window, { key: "a" });
    });
    expect(document.querySelector('[data-matter-modal="reviewer-modal-assign"]')).not.toBeNull();
    expect(document.querySelector('[data-reviewer-modal="assign"]')).not.toBeNull();
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
