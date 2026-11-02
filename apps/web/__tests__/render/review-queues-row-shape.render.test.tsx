/**
 * RT-019 — /review/queues with a populated queue, as the API really answers.
 *
 * The body below is the shape `buildWorkflowProjection` returns, field for
 * field. It has no `id`, `status` or `dueAt`; the page crashed on the first row
 * of a populated queue. The real `apiFetch` runs over a stubbed fetch.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKFLOW = "11111111-2222-4333-8444-555555555555";
const EVIDENCE = "99999999-8888-4777-8666-555555555555";

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

describe("/review/queues row shape", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes("/v1/reviewer-ops/queue-intelligence")
          ? { projections: [], degradations: [] }
          : url.includes("/v1/reviewer-ops/queue")
            ? { rows: [projection], nextCursor: null }
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
    expect(screen.getByText(`${WORKFLOW.slice(0, 8)}…`)).toBeTruthy();
    expect(screen.getByText(`${EVIDENCE.slice(0, 8)}…`)).toBeTruthy();
    const open = document.querySelector(`[data-reviewer-queue-open="${WORKFLOW}"]`) as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(`/reviewer-ops/${WORKFLOW}`);
  });
});
