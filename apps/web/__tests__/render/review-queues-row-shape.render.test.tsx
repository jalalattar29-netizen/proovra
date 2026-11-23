/**
 * RT-019 — /review/queues with a populated queue, as the API really answers.
 *
 * The body below is the shape `buildWorkflowProjection` returns, field for
 * field. It has no `id`, `status` or `dueAt`; the page crashed on the first row
 * of a populated queue. The real `apiFetch` runs over a stubbed fetch.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKFLOW = "11111111-2222-4333-8444-555555555555";
const EVIDENCE = "99999999-8888-4777-8666-555555555555";
const WORKFLOW_2 = "22222222-3333-4444-8555-666666666666";
const EVIDENCE_2 = "77777777-6666-4555-8444-3333333abcde";
const OTHER_REVIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/review/queues",
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", () => ({
  useActiveSpaceId: () => TEAM,
  useTeamId: () => TEAM,
  useCan: () => true,
  useActiveSpace: () => ({ type: "ORGANIZATION", roleLabel: "ADMIN" }),
  // TEAM-SPEC R1 / §3 — the page now asks the plan feature for bulk and
  // resolves hub / QC destinations from the envelope (none here: no tabs, no
  // QC row, which this row-shape test does not exercise).
  usePlanFeatureGate: () => true,
  usePlatformContext: () => ({ envelope: null, switchWorkspace: async () => true }),
  useWorkspaceFragment: () => null,
  usePersonalSpaceFragment: () => null,
}));
vi.mock("../../app/(app)/review/queues/_evidence-request-queue", () => ({
  EvidenceRequestReviewQueue: () => null,
}));

import QueuesPage from "../../app/(app)/review/queues/page";

const projection = {
  workflowId: WORKFLOW,
  evidenceId: EVIDENCE,
  teamId: TEAM,
  lifecycleState: "IN_REVIEW",
  assignedToUserId: null,
  assignedAtUtc: null,
  priority: "HIGH",
  slaRollupState: "ON_TRACK",
  slaDimensions: [],
  legacy: { id: WORKFLOW, stage: "IN_REVIEW", dueAt: "2026-12-01T10:00:00.000Z" },
};

const assignedProjection = {
  ...projection,
  workflowId: WORKFLOW_2,
  evidenceId: EVIDENCE_2,
  assignedToUserId: OTHER_REVIEWER,
  priority: "NORMAL",
  legacy: { id: WORKFLOW_2, stage: "IN_REVIEW", dueAt: "2026-12-02T10:00:00.000Z" },
};

describe("/review/queues row shape", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes("/v1/reviewer-ops/queue-intelligence")
          ? { projections: [], degradations: [] }
          : url.includes("/v1/reviewer-ops/queue")
            ? { rows: [projection, assignedProjection], nextCursor: null }
            : url.includes("qc/pending-count")
              ? { pendingCount: 0 }
              : { reviewers: [] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a populated queue from the projection the API sends", async () => {
    render(<QueuesPage />);
    await waitFor(() => {
      expect(document.querySelector(`[data-reviewer-queue-row="${WORKFLOW}"]`)).not.toBeNull();
    });
    // TEAM-UI-SPEC (queues round) — human references, never raw truncated ids.
    expect(screen.getByText("Review ref 555555")).toBeTruthy();
    expect(screen.getByText("Evidence ref 555555")).toBeTruthy();
    expect(document.body.textContent).not.toContain(`${WORKFLOW.slice(0, 8)}…`);
    expect(document.body.textContent).not.toContain(`${EVIDENCE.slice(0, 8)}…`);
    const open = document.querySelector(`[data-reviewer-queue-open="${WORKFLOW}"]`) as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(`/reviewer-ops/${WORKFLOW}`);
  });

  // TEAM-UI-SPEC §1 / §4 (round 3) — canonical controls and compact rows.
  it("rows show Open (ghost) + at most one secondary, every button is canonical, mobile card markup is present", async () => {
    render(<QueuesPage />);
    await waitFor(() => {
      expect(document.querySelector(`[data-reviewer-queue-row="${WORKFLOW}"]`)).not.toBeNull();
    });
    expect(document.querySelector(".ui-button")).toBeNull();
    const tr = document.querySelector(`[data-reviewer-queue-row="${WORKFLOW}"]`) as HTMLElement;
    const actions = tr.querySelector('[data-review-cell="actions"]') as HTMLElement;
    const open = actions.querySelector(`[data-reviewer-queue-open="${WORKFLOW}"]`) as HTMLElement;
    expect(open.className).toContain("app-ghost-action");
    const secondaries = actions.querySelectorAll(".app-secondary-action");
    expect(secondaries.length).toBeLessThanOrEqual(1);
    // Unassigned + REVIEW_ASSIGN → the one secondary is Assign.
    expect(secondaries[0]?.textContent).toBe("Assign");
    expect(actions.querySelectorAll(".app-primary-action").length).toBe(0);
    // Compact row: the shared responsive cutover + the review cell map.
    const table = document.querySelector("[data-reviewer-queue-table]") as HTMLElement;
    expect(table.hasAttribute("data-responsive")).toBe(true);
    expect(table.classList.contains("review-rows")).toBe(true);
    for (const cell of ["check", "ref", "priority", "status", "due", "actions"]) {
      expect(tr.querySelector(`[data-review-cell="${cell}"]`), cell).not.toBeNull();
    }
    // TEAM-UI-SPEC (queues round) — line 3 is the assignee as a person, never
    // a raw id; the workflow column is context (hidden on the compact row);
    // signals show on the compact row only when the row was scored.
    expect(tr.querySelector('[data-review-cell="assignee"]')?.textContent).toBe("Unassigned");
    const tr2 = document.querySelector(`[data-reviewer-queue-row="${WORKFLOW_2}"]`) as HTMLElement;
    expect(tr2.querySelector('[data-review-cell="assignee"]')?.textContent).toBe("Reviewer ref BBBBBB");
    expect(tr2.querySelector('[data-review-cell="ref"]')?.textContent).toBe("Evidence ref 3ABCDE");
    expect(tr2.textContent).not.toContain("bbbbbbbb");
    expect(tr.querySelector('[data-label="Workflow"]')?.getAttribute("data-review-cell")).toBe("extra");
    expect(tr.querySelector('[data-review-cell="signals"]')?.getAttribute("data-review-signals-scored")).toBe("false");
    // Every button on the page carries a canonical class.
    const canonical = /\b(app-primary-action|app-secondary-action|app-ghost-action|app-danger-action|app-tab|app-listbox__trigger)\b/;
    for (const b of Array.from(document.querySelectorAll("button"))) {
      expect(b.className, b.outerHTML.slice(0, 120)).toMatch(canonical);
    }
  });

  // TEAM-UI-SPEC (queues round) — ONE "Code verdict" AppListbox + ONE Apply
  // replace the four "Code verdict: …" buttons; the confirm stays the
  // canonical Modal, naming the chosen verdict.
  it("bulk bar: Bulk assign secondary, one Code verdict listbox + Apply, Clear ghost; Apply opens the confirm with the chosen verdict", async () => {
    render(<QueuesPage />);
    const checkbox = await waitFor(() => {
      const el = document.querySelector(`[data-reviewer-queue-checkbox="${WORKFLOW}"]`);
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    fireEvent.click(checkbox.closest("tr")!);
    const bar = await waitFor(() => {
      const el = document.querySelector('[data-bulk-bar-state="active"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(bar.querySelector('[data-bulk-action="ASSIGN"]')?.className).toBe("app-secondary-action");
    expect(bar.querySelector("[data-bulk-clear]")?.className).toBe("app-ghost-action");
    expect(bar.textContent).not.toMatch(/Code verdict: Approve/);
    const apply = bar.querySelector('[data-bulk-action="CODE_VERDICT"]') as HTMLButtonElement;
    expect(apply.className).toBe("app-secondary-action");
    expect(apply.textContent).toBe("Apply");
    expect(apply.disabled).toBe(true);
    expect(bar.querySelectorAll("button.app-secondary-action")).toHaveLength(2);

    fireEvent.click(bar.querySelector("[data-bulk-code-verdict-select]")!);
    const option = await waitFor(() => {
      const el = document.querySelector('[role="option"][data-value="REJECT"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(option);
    await waitFor(() => expect(apply.disabled).toBe(false));
    expect(apply.getAttribute("data-bulk-code-verdict")).toBe("REJECT");
    fireEvent.click(apply);
    const confirm = await waitFor(() => {
      const el = document.querySelector('[data-bulk-confirm-kind="DECIDE"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(confirm).toBeTruthy();
    expect(screen.getByText('Set the coded verdict "Reject"')).toBeTruthy();
    expect(document.querySelector("[data-bulk-confirm-go]")?.className).toBe("app-primary-action");
  });
});
