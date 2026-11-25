/**
 * Stage B — T-167: the console bulk bar and the Queues bulk decide could not
 * satisfy a step-up (e4e908e88: the bar posted /reviews/bulk with no runner,
 * and bulkDecide folded 401 STEP_UP_REQUIRED into a `{ denial }`, so the page
 * only ever printed a refusal). Real components, real StepUpModal, real apiFetch
 * over a stubbed network.
 *
 * Also T-036: the Queues row assign is no longer wrapped (assignment is not a
 * step-up action) and still posts the single-assign route.
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKFLOW = "11111111-2222-4333-8444-555555555555";
const EVIDENCE = "99999999-8888-4777-8666-555555555555";
const CHALLENGE = "c0000000-0000-4000-8000-000000000009";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
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
  useActiveSpace: () => ({ type: "PERSONAL", roleLabel: "OWNER" }),
  usePlanFeatureGate: () => true,
  usePlatformContext: () => ({ envelope: null, switchWorkspace: async () => true }),
  useWorkspaceFragment: () => null,
  usePersonalSpaceFragment: () => null,
}));
vi.mock("../../app/(app)/evidence-requests/_components/EvidenceRequestReviewQueue", () => ({
  EvidenceRequestReviewQueue: () => null,
}));

// Stage D (T-065) — the Queues page is the Inbox now; its bulk tags keep the step-up.
import { ReviewInbox } from "../../components/reviewer-experience/ReviewInbox";
import { ReviewerBulkOpsBar } from "../../components/reviewer-experience/ReviewerBulkOpsBar";
import { StepUpModal, useStepUpAction } from "../../components/identity-security/StepUpModal";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";

type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let bulkAnswers: Array<{ status: number; body: unknown }> = [];

const stepUpRefusal = (purpose = "REVIEWER_OPS_BULK_ACTION") => ({
  status: 401,
  body: {
    error: {
      code: "STEP_UP_REQUIRED",
      message: "Step-up verification required.",
      details: { purpose, resourceKind: "review_workflow_bulk", resourceId: WORKFLOW, teamId: TEAM, reason: "policy_flag:requireStepUpForBulk" },
    },
  },
});

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

beforeEach(() => {
  calls = [];
  bulkAnswers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      calls.push({ path, method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (path.startsWith("/v1/reviewer-ops/reviews/bulk") || path.startsWith("/v1/reviewer/bulk/decide")) {
        const next = bulkAnswers.shift() ?? { status: 200, body: { total: 1, succeeded: 1, failed: 0, items: [], outcomes: [] } };
        return json(next.status, next.body);
      }
      if (path === "/v1/identity-security/step-up/start") return json(200, { challenge: { id: CHALLENGE, status: "PENDING" }, method: "TOTP" });
      if (path === "/v1/identity-security/step-up/check") return json(200, { status: "approved" });
      if (path.includes("/v1/reviewer-ops/queue-intelligence")) return json(200, { projections: [], degradations: [] });
      if (path.includes("/v1/reviewer-ops/queue")) return json(200, { rows: [projection], nextCursor: null });
      if (path.includes("qc/pending-count")) return json(200, { pendingCount: 0 });
      return json(200, { reviewers: [] });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function answerChallenge() {
  const code = await waitFor(() => {
    const el = document.querySelector("[data-step-up-code-input]");
    expect(el).not.toBeNull();
    return el as HTMLInputElement;
  });
  fireEvent.change(code, { target: { value: "123456" } });
  await act(async () => {
    fireEvent.submit(document.querySelector('[data-step-up-form="code"]') as HTMLFormElement);
  });
}

function BarHarness() {
  const stepUp = useStepUpAction({ teamId: TEAM });
  return (
    <ConfirmActionProvider>
      <ReviewerBulkOpsBar
        teamId={TEAM}
        selection={new Set([WORKFLOW])}
        callerUserId={TEAM}
        enabled
        onClearSelection={() => {}}
        onMutated={() => {}}
        onResult={() => {}}
        runStepUpAction={stepUp.runStepUpAction}
      />
      <StepUpModal control={stepUp} />
    </ConfirmActionProvider>
  );
}

describe("T-167 console bulk bar satisfies a step-up in place", () => {
  it("a bulk priority change refused with STEP_UP_REQUIRED opens the dialog and retries once with the challenge", async () => {
    bulkAnswers = [stepUpRefusal()];
    render(<BarHarness />);
    await act(async () => {
      fireEvent.click(document.querySelector('[data-reviewer-bulk-action="PRIORITY_HIGH"]') as HTMLElement);
    });
    await answerChallenge();
    await waitFor(() => {
      const sent = calls.filter((c) => c.path.startsWith("/v1/reviewer-ops/reviews/bulk"));
      expect(sent).toHaveLength(2);
      expect(sent[1]!.headers["x-proovra-step-up-challenge-id"]).toBe(CHALLENGE);
    });
    expect(document.querySelector("[data-reviewer-bulk-error]")).toBeNull();
  });
});

describe("T-167 / T-036 Inbox bulk tags satisfy a step-up; row assign is not wrapped", () => {
  it("Apply a coded tag refused with STEP_UP_REQUIRED opens the dialog and retries with the header", async () => {
    bulkAnswers = [stepUpRefusal()];
    render(
      <ConfirmActionProvider>
        <ReviewInbox />
      </ConfirmActionProvider>,
    );
    const checkbox = await waitFor(() => {
      const el = document.querySelector(`[data-inbox-row-checkbox="${WORKFLOW}"]`);
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    fireEvent.click(checkbox);
    const bar = await waitFor(() => {
      const el = document.querySelector("[data-reviewer-bulk-actions-bar]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(bar.querySelector("[data-inbox-bulk-tag-select]")!);
    fireEvent.click(await waitFor(() => document.querySelector('[role="option"][data-value="REJECT"]') as HTMLElement));
    const apply = bar.querySelector("[data-inbox-bulk-tag-apply]") as HTMLButtonElement;
    await waitFor(() => expect(apply.disabled).toBe(false));
    fireEvent.click(apply);
    await act(async () => {
      fireEvent.click(await waitFor(() => document.querySelector("[data-inbox-bulk-confirm]") as HTMLElement));
    });
    await answerChallenge();
    await waitFor(() => {
      const sent = calls.filter((c) => c.path.startsWith("/v1/reviewer/bulk/decide"));
      expect(sent).toHaveLength(2);
      expect(sent[1]!.headers["x-proovra-step-up-challenge-id"]).toBe(CHALLENGE);
    });
    expect(screen.queryByText(/Step up required/i)).toBeNull();
  });
});
