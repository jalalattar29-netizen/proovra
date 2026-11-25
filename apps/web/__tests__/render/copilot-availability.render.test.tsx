/**
 * Round 2 (2026-11-25, T-091) — the workspace AI policy decides, up front,
 * whether the Reviewer Copilot is offered. The Review page reads `copilots`
 * from the member-safe AI status and passes `aiEnabled` to the panel. Real
 * hook and panel, the real apiFetch over a stubbed fetch, RTL cleanup().
 */
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<typeof import("../../lib/platform-context")>()),
  useActiveWorkspaceId: () => "44444444-4444-4444-8444-444444444444",
}));

import { ReviewerCopilotPanel } from "../../components/ai-copilot/ReviewerCopilotPanel";
import { useCopilotAvailability } from "../../lib/ai/copilot-availability";

const TEAM = "44444444-4444-4444-8444-444444444444";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubStatus(answer: () => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      calls.push(path);
      if (path.startsWith("/v1/workspaces/ai-assistance-status")) return answer();
      if (path.startsWith("/v1/reviewer-criteria")) return json(200, { sets: [] });
      return json(200, {});
    }),
  );
  return calls;
}

function Page() {
  const copilots = useCopilotAvailability(TEAM);
  return (
    <ReviewerCopilotPanel
      reviewId="22222222-2222-4222-8222-222222222222"
      aiEnabled={copilots?.reviewer !== false}
      evidence={[{ id: "e1000000-0000-4000-8000-0000000000c1", title: "Evidence ref 0000C1", analysisRevision: "rev-1", status: "IN_REVIEW" }]}
    />
  );
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const OFF = /not available to you in this workspace/i;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("T-091 — the Reviewer Copilot follows the workspace AI policy", () => {
  it("policy denies it for this viewer: the panel says so before any run", async () => {
    const calls = stubStatus(() => json(200, { status: "DISABLED", features: [], copilots: { reviewer: false, case: false } }));
    render(<Page />);
    await settle();
    expect(screen.getByText(OFF)).toBeTruthy();
    expect(screen.getByText(/Settings → AI/)).toBeTruthy();
    expect(calls.some((c) => c === `/v1/workspaces/ai-assistance-status?teamId=${TEAM}`)).toBe(true);
  });

  it("policy allows it: the panel is offered", async () => {
    stubStatus(() => json(200, { status: "AVAILABLE", features: [], copilots: { reviewer: true, case: false } }));
    render(<Page />);
    await settle();
    expect(screen.queryByText(OFF)).toBeNull();
  });

  it("the status cannot be read: the panel stays offered and the server answers a run", async () => {
    stubStatus(() => json(500, { error: { code: "INTERNAL" } }));
    render(<Page />);
    await settle();
    expect(screen.queryByText(OFF)).toBeNull();
  });
});
