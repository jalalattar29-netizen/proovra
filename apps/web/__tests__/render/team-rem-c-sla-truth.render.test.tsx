/**
 * TEAM REMEDIATION — STAGE C: what the Review page, focus mode, the queue
 * signals and the metrics page SAY about deadlines, escalations and figures.
 *
 *   T-043  "Met" carries the completion date, never the deadline's relative time.
 *   T-045  no "Escalation Met", no "SLA overdue" because an escalation is open;
 *          an escalated review due in 3 d reads due in 3 d.
 *   T-046  a dimension with no deadline is not listed.
 *   T-048  the governing deadline is the earliest one still open.
 *   T-049  "Escalation: High (2 active)".
 *   T-056  a metric with no data reads "No data", never 0 % or "0s".
 *   T-061/T-063 queue signal labels; a finished review shows no age.
 *
 * Real pages and the real apiFetch over a stubbed network; RTL cleanup().
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import ReviewWorkspacePage from "../../app/(app)/reviewer-ops/[reviewId]/page";
import { MetricsSection as MetricsPage } from "../../app/(app)/review/metrics/_section";
import { formatUserDate } from "../../lib/date";
import {
  escalationSummaryText,
  governingDeadlineText,
  presentDeadlines,
} from "../../lib/reviewer-workspace/sla-presentation";
import { slaSignalLabel } from "../../components/reviewer-experience/queueIntelligence";

const teamId = "44444444-4444-4444-8444-444444444444";
const workflowId = "22222222-2222-4222-8222-222222222222";
const evidenceId = "e1000000-0000-4000-8000-0000000000c1";

vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<typeof import("../../lib/platform-context")>()),
  useActiveSpaceId: () => "44444444-4444-4444-8444-444444444444",
  useOptionalPlatformContext: () => ({ envelope: { capabilities: { REVIEW_ESCALATE: true } } }),
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/presence/PresenceIndicator", () => ({ PresenceIndicator: () => null }));
vi.mock("../../components/presence/CollisionWarning", () => ({ CollisionWarning: () => null }));
vi.mock("../../components/ai-copilot/ReviewerCopilotPanel", () => ({ ReviewerCopilotPanel: () => null }));
vi.mock("../../app/(app)/reviewer-ops/components/CodingSchemaBindingPanel", () => ({ CodingSchemaBindingPanel: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/reviewer-ops/22222222-2222-4222-8222-222222222222",
  useParams: () => ({ reviewId: "22222222-2222-4222-8222-222222222222" }),
}));

const DAY = 86400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

// The production fixture (REVIEW-SUBSYSTEM §9.1) as the stage-C API projects
// it: assigned 26 d ago, the sweep stamped the deadlines 16 d ago, no decision,
// two escalations active (the governing one HIGH).
const ASSIGNED_AT = at(-26 * DAY);
const PRODUCTION_DIMENSIONS = [
  { dimension: "ASSIGNMENT", dueAtUtc: at(-16 * DAY), state: "COMPLETED", timeRemainingMs: null, completedAtUtc: ASSIGNED_AT, metOnTime: true },
  { dimension: "FIRST_REVIEW", dueAtUtc: at(-15 * DAY), state: "BREACHED", timeRemainingMs: -15 * DAY, completedAtUtc: null, metOnTime: null },
  { dimension: "COMPLETION", dueAtUtc: at(-13 * DAY), state: "BREACHED", timeRemainingMs: -13 * DAY, completedAtUtc: null, metOnTime: null },
  // The escalation trigger: computed, never presented.
  { dimension: "ESCALATION", dueAtUtc: at(-14 * DAY), state: "COMPLETED", timeRemainingMs: null, completedAtUtc: at(-14 * DAY), metOnTime: true },
];

let workspace: Record<string, unknown>;
let metrics: Record<string, unknown>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function workspaceBody(dims: unknown[], rollup: string, escalation: { severity: string } | null, activeEscalationCount: number) {
  return {
    projection: {
      workflowId,
      evidenceId,
      lifecycleState: escalation ? "ESCALATED" : "IN_REVIEW",
      assignedToUserId: "u-1",
      assignedAtUtc: ASSIGNED_AT,
      priority: "NORMAL",
      slaPausedAtUtc: null,
      pausedReason: null,
      slaRollupState: rollup,
      slaDimensions: dims,
    },
    openEscalation: escalation
      ? {
          id: "esc-1",
          reason: "REVIEW_OVERDUE",
          severity: escalation.severity,
          status: "ACKNOWLEDGED",
          safeSummary: "Past due",
          createdAt: at(-14 * DAY),
          assignedToUserId: "u-1",
        }
      : null,
    activeEscalationCount,
    allowedLifecycleTransitions: [],
    viewer: { userId: "u-1", isAssignee: true, actions: [] },
  };
}

beforeEach(() => {
  workspace = workspaceBody(PRODUCTION_DIMENSIONS, "BREACHED", { severity: "HIGH" }, 2);
  metrics = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      if (path === `/v1/reviewer-ops/workspace/${workflowId}?teamId=${teamId}`) return json(200, workspace);
      if (path.startsWith(`/v1/reviewer-ops/workspace/${workflowId}/decisions`)) {
        return json(200, {
          workflowId,
          evidenceId,
          state: "first_required",
          secondReviewRequirement: { required: false, reason: null },
          callerContext: { userId: "u-1", teamRole: "OWNER", isAdjudicator: true, callerIsFirstReviewer: false, nextAction: "submit_first" },
          decisions: [],
        });
      }
      if (path.startsWith(`/v1/reviewer-ops/workspace/${workflowId}/notes`)) {
        return json(200, { workflowId, evidenceId, summary: { total: 0 }, items: [] });
      }
      if (path.startsWith("/v1/reviewer/metrics")) return json(200, { metrics });
      return json(200, {});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderInspector() {
  render(<ReviewWorkspacePage />);
  await waitFor(() => expect(document.querySelector("[data-reviewer-sla-clocks]")).not.toBeNull());
}

describe("Review page — SLA rows and header (T-043, T-045, T-046, T-049)", () => {
  it("the production row: Met carries the assignment date, no Escalation row, header names the governing deadline", async () => {
    await renderInspector();
    const rows = Array.from(document.querySelectorAll("[data-reviewer-sla-dimension]"));
    expect(rows.map((r) => r.getAttribute("data-reviewer-sla-dimension"))).toEqual(["ASSIGNMENT", "FIRST_REVIEW", "COMPLETION"]);
    const assignment = rows[0]!;
    expect(assignment.textContent).toContain("Met");
    expect(assignment.textContent).toContain(formatUserDate(ASSIGNED_AT));
    // Never "Met 16d ago" (the deadline's relative time).
    expect(assignment.textContent).not.toMatch(/\d+d ago/);
    const first = rows[1]!;
    expect(first.textContent).toContain("Overdue");
    expect(first.textContent).not.toContain("Met");
    expect(document.body.textContent).not.toMatch(/Overdue \(escalated\)|SLA overdue|Escalation\s*Met/);
    const header = document.querySelector("[data-reviewer-sla-badge]")!;
    expect(header.textContent).toMatch(/^First review due .* · overdue 15 d$/);
    expect(document.querySelector("[data-reviewer-escalation-summary]")!.textContent).toBe("Escalation: High (2 active)");
  });

  it("an escalated review whose deadline is 3 d away reads due in 3 d, not overdue", async () => {
    workspace = workspaceBody(
      [
        { dimension: "COMPLETION", dueAtUtc: at(3 * DAY), state: "HEALTHY", timeRemainingMs: 3 * DAY, completedAtUtc: null, metOnTime: null },
        { dimension: "ASSIGNMENT", dueAtUtc: null, state: "COMPLETED", timeRemainingMs: null, completedAtUtc: ASSIGNED_AT, metOnTime: null },
      ],
      "HEALTHY",
      { severity: "WARNING" },
      1,
    );
    await renderInspector();
    const header = document.querySelector("[data-reviewer-sla-badge]")!;
    expect(header.textContent).toMatch(/^Completion due .* · in 3 d$/);
    expect(header.textContent).not.toMatch(/overdue/i);
    // T-046 — the assignment dimension has no deadline: no row.
    expect(document.querySelector('[data-reviewer-sla-dimension="ASSIGNMENT"]')).toBeNull();
    expect(document.querySelector("[data-reviewer-escalation-summary]")!.textContent).toBe("Escalation: Warning (1 active)");
  });
});

describe("focus mode and queue helpers (T-048, T-049, T-061)", () => {
  it("T-048: the next checkpoint is the earliest open deadline, never a completed one", () => {
    const g = governingDeadlineText([
      { dimension: "ASSIGNMENT", dueAtUtc: at(-16 * DAY), state: "COMPLETED", completedAtUtc: ASSIGNED_AT, metOnTime: true },
      { dimension: "COMPLETION", dueAtUtc: at(2 * DAY), state: "HEALTHY", timeRemainingMs: 2 * DAY },
    ]);
    expect(g.kind).toBe("open");
    expect(g.text).toMatch(/^Completion due /);
    expect(
      governingDeadlineText([
        { dimension: "ASSIGNMENT", dueAtUtc: at(-1 * DAY), state: "COMPLETED", completedAtUtc: at(-2 * DAY), metOnTime: true },
      ]).text,
    ).toBe("All deadlines met");
  });

  it("T-043: a late fact is Missed, with its lateness", () => {
    const [d] = presentDeadlines([
      { dimension: "ASSIGNMENT", dueAtUtc: "2026-11-02T00:00:00.000Z", state: "COMPLETED", completedAtUtc: "2026-11-05T00:00:00.000Z", metOnTime: false },
    ]);
    expect(d!.word).toBe("Missed");
    expect(d!.detail).toMatch(/^by 3 d · completed /);
  });

  it("T-049 / T-061: escalation and SLA signal wording", () => {
    expect(escalationSummaryText("HIGH", 2)).toBe("Escalation: High (2 active)");
    expect(escalationSummaryText(null, 0)).toBeNull();
    expect(slaSignalLabel({ status: "BREACHED", signal: "OVERDUE" })).toBe("Overdue");
    expect(slaSignalLabel({ status: null, signal: "PAUSED" })).toBe("Paused");
    // An older API without the signal: the stored OVERDUE still says Overdue.
    expect(slaSignalLabel({ status: "OVERDUE" })).toBe("Overdue");
    expect(slaSignalLabel({ status: "ON_TRACK", signal: null })).toBeNull();
  });
});

describe("metrics page (T-056)", () => {
  it("a workspace with no decisions reads No data, never 0 % or 0s", async () => {
    metrics = {
      throughput7d: 0,
      approvalRate7dPct: null,
      escalationRate7dPct: null,
      disagreementRate7dPct: null,
      qcFailureRate7dPct: null,
      avgReviewDurationMs7d: null,
    };
    render(<MetricsPage />);
    await waitFor(() => expect(document.querySelector("[data-reviewer-metrics-grid]")).not.toBeNull());
    const grid = document.querySelector("[data-reviewer-metrics-grid]")!;
    expect(grid.textContent).toContain("No data");
    expect(grid.textContent).not.toMatch(/\b0%|\b0s\b/);
  });

  it("real figures still render with their unit", async () => {
    metrics = {
      throughput7d: 4,
      approvalRate7dPct: 50,
      escalationRate7dPct: 25,
      disagreementRate7dPct: 0,
      qcFailureRate7dPct: null,
      avgReviewDurationMs7d: 90_000,
    };
    render(<MetricsPage />);
    await screen.findByText("50%");
    const grid = document.querySelector("[data-reviewer-metrics-grid]")!;
    expect(grid.textContent).toContain("90s");
    expect(grid.textContent).toContain("Escalation rate (of reviews)");
  });
});
