import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const m = { fetch: vi.fn(), generation: 0, guard: null as unknown };
  m.guard = {
    stamp: () => m.generation,
    isStale: (captured: number) => captured !== m.generation,
    generation: 0,
  };
  return m;
});
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../lib/platform-context", () => ({ useTenantGuard: () => mocks.guard }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: vi.fn() }) }));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  useStepUpAction: () => ({ runStepUpAction: async (fn: () => Promise<unknown>) => fn() }),
  StepUpModal: () => null,
}));

import { WorkflowOperationsSection } from "../../components/command-center/_sections/WorkflowOperationsSection";

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const chainId = "33333333-3333-4333-8333-333333333333";
const wfA = "44444444-4444-4444-8444-444444444441";
const wfB = "44444444-4444-4444-8444-444444444442";
const hidden = "44444444-4444-4444-8444-444444444449";
const detailUrl = `/v1/ops/causality/chains/${chainId}?teamId=${teamId}`;

function workflow(id: string, title: string) {
  return {
    id, teamId, workflowKey: id, workflowType: "RETRY_STORM", status: "OPEN", severity: "HIGH", priority: "P2", title,
    safeSummary: "Retries are piling up.", assignedOwnerUserId: null, escalationLevel: 0, retryCount: 0, nextRetryAtUtc: null,
    mitigationSummary: null, resolutionSummary: null, dueAtUtc: null, resolvedAtUtc: null, caseId: null, evidenceId: null,
    queueName: null, updatedAtUtc: "2026-02-01T00:00:00.000Z", projection: { version: "v", canAct: true, actions: [] },
  };
}
const list = { workflows: [workflow(wfA, "Report backlog"), workflow(wfB, "Package retries")], canAct: true, denialReason: null };
const chains = { chains: [{ id: chainId, title: "Worker outage", summary: "The export worker stopped", rootCauseType: "WORKER_HEARTBEAT_STALE", severity: "HIGH", linkedWorkflowIds: [wfA], lastSeenAtUtc: "2026-02-01T00:00:00.000Z" }] };
const detail = {
  chain: {
    id: chainId, title: "Worker outage", summary: "The export worker stopped", rootCauseType: "WORKER_HEARTBEAT_STALE",
    severity: "HIGH", status: "ACTIVE", linkedIncidentIds: ["i1", "i2"], linkedWorkflowIds: [wfA, wfB, hidden],
    linkedCaseIds: [], linkedEvidenceIds: ["e1"], startAtUtc: "2026-01-31T00:00:00.000Z",
    lastSeenAtUtc: "2026-02-01T00:00:00.000Z", resolvedAtUtc: null,
  },
  linkedWorkflows: [
    { id: wfA, title: "Report backlog", status: "OPEN", severity: "HIGH" },
    { id: wfB, title: "Package retries", status: "IN_PROGRESS", severity: "LOW" },
    { id: hidden, title: "Archive sweep", status: "RESOLVED", severity: "LOW" },
  ],
};

beforeEach(() => {
  mocks.generation = 0;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/v1/ops/workflows?")) return list;
    if (path.startsWith("/v1/ops/causality/chains?")) return chains;
    if (path === detailUrl) return detail;
    return {};
  });
});
afterEach(cleanup);

async function toggle() {
  render(<WorkflowOperationsSection teamId={teamId} />);
  const button = await screen.findByRole("button", { name: "Why: The export worker stopped" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  return button;
}
function detailCalls() {
  return mocks.fetch.mock.calls.filter(([p]) => p === detailUrl).length;
}

describe("ops causality chain drill-down", () => {
  it("reads the chain only when expanded and renders it in operator language", async () => {
    const button = await toggle();
    expect(detailCalls()).toBe(0);
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-expanded")).toBe("true"));
    const panel = document.getElementById(button.getAttribute("aria-controls")!)!;
    await screen.findByRole("heading", { name: "Worker outage" });
    expect(panel.contains(screen.getByRole("heading", { name: "Worker outage" }))).toBe(true);
    expect(detailCalls()).toBe(1);
    const text = panel.textContent ?? "";
    expect(text).toContain("Not resolved");
    expect(text).not.toContain("WORKER_HEARTBEAT_STALE");
    expect(text).not.toContain("IN_PROGRESS");
    expect(panel.querySelector("dl")!.textContent).toMatch(/Linked incidents2/);
    expect(panel.querySelector("dl")!.textContent).toMatch(/Linked cases0/);
    expect(panel.querySelector("dl")!.textContent).toMatch(/Linked evidence1/);
    expect(panel.querySelector("code[data-identifier]")?.textContent).toBe(chainId);
    expect(text).toContain("Archive sweep (not in the current list)");
  });

  it("links a linked workflow to its row", async () => {
    fireEvent.click(await toggle());
    fireEvent.click(await screen.findByRole("button", { name: "Go to Package retries" }));
    expect(document.activeElement).toBe(document.querySelector(`[data-cc-workflow-id="${wfB}"]`));
  });

  it("collapses without another read", async () => {
    const button = await toggle();
    fireEvent.click(button);
    await screen.findByRole("heading", { name: "Worker outage" });
    fireEvent.click(button);
    expect(screen.queryByRole("heading", { name: "Worker outage" })).toBeNull();
    expect(detailCalls()).toBe(1);
  });

  it.each([
    [{ statusCode: 404, code: "chain_not_found" }, "This cause is no longer recorded in this workspace. Refresh the workflows."],
    [{ statusCode: 403, code: "permission_denied" }, "You do not have access to this cause in this workspace."],
  ])("states a refused or missing chain (%o)", async (error, text) => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path === detailUrl) throw error;
      if (path.startsWith("/v1/ops/workflows?")) return list;
      return chains;
    });
    fireEvent.click(await toggle());
    expect((await screen.findByText(text)).getAttribute("role")).toBe("alert");
  });

  it("states a failed read and retries it", async () => {
    let fail = true;
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path === detailUrl) { if (fail) throw { statusCode: 503 }; return detail; }
      if (path.startsWith("/v1/ops/workflows?")) return list;
      return chains;
    });
    fireEvent.click(await toggle());
    const retry = await screen.findByRole("button", { name: "Try again" });
    fail = false;
    fireEvent.click(retry);
    await screen.findByRole("heading", { name: "Worker outage" });
  });

  it("drops a chain response that lands after a workspace switch", async () => {
    let resolveOld!: (v: unknown) => void;
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path === detailUrl) return new Promise((r) => { resolveOld = r; });
      if (path.startsWith("/v1/ops/workflows?")) return list;
      return chains;
    });
    fireEvent.click(await toggle());
    await screen.findByText("Loading the cause…");
    mocks.generation = 1;
    await act(async () => { resolveOld(detail); });
    expect(screen.queryByRole("heading", { name: "Worker outage" })).toBeNull();
  });

  it("states a failed chain list instead of silently showing no causes", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/ops/causality/chains?")) throw { statusCode: 503 };
      return list;
    });
    render(<WorkflowOperationsSection teamId={teamId} />);
    await waitFor(() => expect(document.querySelector("[data-cc-causality-list-error]")).not.toBeNull());
    expect(screen.queryByRole("button", { name: /^Why:/ })).toBeNull();
  });

  it("labels workflow status and severity instead of printing stored values", async () => {
    await toggle();
    const row = document.querySelector(`[data-cc-workflow-id="${wfA}"]`)!;
    expect(row.textContent).not.toMatch(/\bOPEN\b|\bHIGH\b/);
  });
});
