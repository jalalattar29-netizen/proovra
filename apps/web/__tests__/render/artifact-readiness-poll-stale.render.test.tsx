/**
 * F-08 (2026-11-13) — "TAKING LONGER THAN USUAL" IS SAID, NOT ABANDONED.
 *
 * Defect: after 60 s of fast polling with no visible change the hook set the
 * stale state and STOPPED polling. The report worker runs two jobs at a time,
 * so a request merely queued behind others reached that state, then finished
 * unseen: the page kept saying "taking longer than expected" until the person
 * clicked Re-check.
 *
 * The shipped hook, over a stubbed status endpoint and fake timers: past the
 * window it says so, keeps following the request at a slow cadence, and clears
 * the state when the outputs change; the server's null interval still ends it.
 */
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { useArtifactReadinessPoll } from "../../app/(app)/evidence/[id]/_hooks/useArtifactReadinessPoll";
import type { ReviewWorkspaceResponse } from "../../app/(app)/evidence/[id]/review-workspace-types";

const QUEUED = {
  outputs: {
    report: { state: "QUEUED", generation: "QUEUED", version: null, action: "NONE" },
    verificationPackage: { state: "QUEUED", generation: "QUEUED", version: null, action: "NONE" },
    pollIntervalMs: 3000,
    activeRequest: { requestId: "r1", state: "QUEUED", progress: { currentStep: "" } },
  },
};
const READY = {
  outputs: {
    report: { state: "READY", generation: "SUCCEEDED", version: 1, action: "NONE" },
    verificationPackage: { state: "READY", generation: "SUCCEEDED", version: 1, action: "NONE" },
    pollIntervalMs: null,
    activeRequest: null,
  },
};

function mount() {
  const setStalePending = vi.fn();
  const reloadWorkspace = vi.fn(async () => undefined);
  const workspace = { artifactStatus: QUEUED } as unknown as ReviewWorkspaceResponse;
  // The page keeps pollStartedAt in React state; so does this harness (a stable
  // setter, so the poll effect is never torn down by a re-render).
  const hook = renderHook(() => {
    const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
    useArtifactReadinessPoll({
      evidenceId: "ev-1",
      shouldPoll: true,
      workspace,
      pollStartedAt,
      setPollStartedAt,
      setStalePending,
      reloadWorkspace,
    });
  });
  return { hook, setStalePending, reloadWorkspace };
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetch.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useArtifactReadinessPoll past its stale window", () => {
  it("says it is taking longer, keeps following the queued request slowly, and clears when it completes", async () => {
    apiFetch.mockResolvedValue(QUEUED);
    const { setStalePending, reloadWorkspace } = mount();

    // 60 s of fast polling with nothing changing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(63_000);
    });
    expect(setStalePending).toHaveBeenCalledWith(true);
    const callsAtStale = apiFetch.mock.calls.length;

    // Still followed — at the slow cadence (one read per 30 s, not per 3 s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(apiFetch.mock.calls.length).toBe(callsAtStale + 1);

    // The request completes: the page reloads and leaves the stale state.
    apiFetch.mockResolvedValue(READY);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(reloadWorkspace).toHaveBeenCalled();
    expect(setStalePending).toHaveBeenLastCalledWith(false);

    // The server's null interval ends polling.
    const callsAtEnd = apiFetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(apiFetch.mock.calls.length).toBe(callsAtEnd);
  });
});
