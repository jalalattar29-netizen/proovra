/**
 * MACRO-WAVE A1 — redaction derivative product journey (render-level).
 *
 * Behavioral coverage for the redacted-copy journey surfaces:
 *
 *   * ApprovalPanel derivative section — honest QUEUED/RENDERING state,
 *     FAILED + failureReason + "Retry redacted copy", READY download via
 *     the short-lived signed-URL endpoint (never a raw storage key),
 *     inline IMAGE preview, and the VIDEO/AUDIO unsupported gating (the
 *     server denies UNSUPPORTED_REDACTION_MEDIA; the client must never
 *     solicit it).
 *   * useDerivativePolling — bounded interval that stops on unmount,
 *     when nothing is in flight, and permanently on a workspace
 *     (tenant-generation) change mid-poll.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Transport mocks
// ---------------------------------------------------------------------------

const harness = vi.hoisted(() => ({
  apiCalls: [] as Array<{ path: string; method?: string }>,
  downloadUrl: "https://signed.example/redacted.png?X-Amz-Signature=test" as
    | string
    | null,
  generation: 0,
}));

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string }) => {
    harness.apiCalls.push({ path, method: init?.method });
    if (path.endsWith("/download-url")) {
      if (!harness.downloadUrl) throw new Error("boom");
      return { downloadUrl: harness.downloadUrl };
    }
    return {};
  },
  readApiToken: () => null,
}));

// The polling hook consumes ONLY useTenantGuard from platform-context.
vi.mock("../../lib/platform-context", () => ({
  useTenantGuard: () => ({
    stamp: () => harness.generation,
    isStale: (captured: number) => captured !== harness.generation,
    generation: harness.generation,
  }),
}));

import { ApprovalPanel } from "../../components/redaction/ApprovalPanel";
import {
  isDerivativeInFlight,
  useDerivativePolling,
} from "../../components/redaction/useDerivativePolling";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type PanelVersion = React.ComponentProps<typeof ApprovalPanel>["version"];

function makeVersion(
  derivative: PanelVersion["derivative"],
  state = "APPROVED",
): PanelVersion {
  return {
    id: "v-1",
    versionOrdinal: 1,
    state,
    approvals: [],
    derivative,
  };
}

function renderPanel(
  version: PanelVersion,
  artifactKind: "IMAGE" | "PDF" | "VIDEO" | "AUDIO" = "IMAGE",
  onTransition = vi.fn(async () => undefined),
) {
  const utils = render(
    <ApprovalPanel
      version={version}
      artifactKind={artifactKind}
      onTransition={onTransition}
    />,
  );
  return { ...utils, onTransition };
}

function q(sel: string): HTMLElement | null {
  return document.querySelector(sel);
}

beforeEach(() => {
  harness.apiCalls = [];
  harness.downloadUrl =
    "https://signed.example/redacted.png?X-Amz-Signature=test";
  harness.generation = 0;
});

// ---------------------------------------------------------------------------
// ApprovalPanel derivative states
// ---------------------------------------------------------------------------

describe("A1 — ApprovalPanel derivative journey states", () => {
  it("no derivative yet (APPROVED, IMAGE): offers 'Request redacted copy' wired to onTransition('derivative')", () => {
    const { onTransition } = renderPanel(makeVersion(null));
    const btn = q("[data-redaction-derivative-request]") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain("Request redacted copy");
    fireEvent.click(btn);
    expect(onTransition).toHaveBeenCalledWith("v-1", "derivative");
    // No download/preview affordance before READY.
    expect(q("[data-redaction-derivative-download]")).toBeNull();
    expect(q("[data-redaction-derivative-preview]")).toBeNull();
  });

  it("DRAFT version: the request affordance is disabled (server would refuse INVALID_TRANSITION)", () => {
    renderPanel(makeVersion(null, "DRAFT"));
    const btn = q("[data-redaction-derivative-request]") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // ONE table for the honest state renderings.
  const STATE_TABLE: ReadonlyArray<{
    state: "QUEUED" | "RENDERING" | "FAILED" | "READY";
    inFlight: boolean;
    requestDisabled: boolean;
    download: boolean;
  }> = [
    { state: "QUEUED", inFlight: true, requestDisabled: true, download: false },
    { state: "RENDERING", inFlight: true, requestDisabled: true, download: false },
    { state: "FAILED", inFlight: false, requestDisabled: false, download: false },
    { state: "READY", inFlight: false, requestDisabled: true, download: true },
  ];

  for (const row of STATE_TABLE) {
    it(`${row.state}: honest state, request ${row.requestDisabled ? "disabled" : "enabled"}, download ${row.download ? "shown" : "hidden"}`, () => {
      renderPanel(
        makeVersion({
          id: "d-1",
          state: row.state,
          failureReason: row.state === "FAILED" ? "RENDER_TIMEOUT" : null,
        }),
      );
      expect(
        q("[data-redaction-derivative-panel]")?.getAttribute(
          "data-redaction-derivative-state",
        ),
      ).toBe(row.state);
      expect(isDerivativeInFlight(row.state)).toBe(row.inFlight);
      if (row.inFlight) {
        // Status copy AND the disabled affordance both say "Rendering…".
        expect(
          screen.getAllByText(/Rendering…/, { exact: false }).length,
        ).toBeGreaterThan(0);
      }
      const btn = q("[data-redaction-derivative-request]") as HTMLButtonElement;
      expect(btn.disabled).toBe(row.requestDisabled);
      expect(Boolean(q("[data-redaction-derivative-download]"))).toBe(
        row.download,
      );
    });
  }

  it("FAILED: shows the failureReason and offers 'Retry redacted copy' via the SAME request action", () => {
    const { onTransition } = renderPanel(
      makeVersion({ id: "d-1", state: "FAILED", failureReason: "RENDER_TIMEOUT" }),
    );
    expect(
      q("[data-redaction-derivative-failure-reason]")?.textContent,
    ).toContain("RENDER_TIMEOUT");
    const btn = q("[data-redaction-derivative-request]") as HTMLButtonElement;
    expect(btn.textContent).toContain("Retry redacted copy");
    fireEvent.click(btn);
    expect(onTransition).toHaveBeenCalledWith("v-1", "derivative");
  });

  it("READY: Download fetches the short-lived signed URL and opens it (never a storage key)", async () => {
    const opened: string[] = [];
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(((url: string | URL | undefined) => {
        opened.push(String(url));
        return null;
      }) as typeof window.open);
    renderPanel(makeVersion({ id: "d-1", state: "READY" }));
    fireEvent.click(q("[data-redaction-derivative-download]")!);
    await waitFor(() =>
      expect(harness.apiCalls.map((c) => c.path)).toContain(
        "/v1/redaction/derivatives/d-1/download-url",
      ),
    );
    await waitFor(() => expect(opened).toEqual([harness.downloadUrl]));
    openSpy.mockRestore();
  });

  it("READY (IMAGE): Preview renders a bounded inline <img> from the signed URL", async () => {
    renderPanel(makeVersion({ id: "d-1", state: "READY" }), "IMAGE");
    fireEvent.click(q("[data-redaction-derivative-preview]")!);
    await waitFor(() => {
      const img = q(
        "[data-redaction-derivative-preview-image]",
      ) as HTMLImageElement | null;
      expect(img).toBeTruthy();
      expect(img!.src).toBe(harness.downloadUrl);
    });
  });

  it("READY (PDF): Preview opens the signed URL in a new tab — no in-app PDF viewer", async () => {
    const opened: string[] = [];
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(((url: string | URL | undefined) => {
        opened.push(String(url));
        return null;
      }) as typeof window.open);
    renderPanel(makeVersion({ id: "d-1", state: "READY" }), "PDF");
    fireEvent.click(q("[data-redaction-derivative-preview]")!);
    await waitFor(() => expect(opened).toEqual([harness.downloadUrl]));
    expect(q("[data-redaction-derivative-preview-image]")).toBeNull();
    openSpy.mockRestore();
  });

  it("download-url failure surfaces the SANCTIONED safe error copy (no raw error text)", async () => {
    harness.downloadUrl = null; // transport throws
    renderPanel(makeVersion({ id: "d-1", state: "READY" }));
    fireEvent.click(q("[data-redaction-derivative-download]")!);
    await waitFor(() => {
      const err = q("[data-redaction-derivative-error]");
      expect(err).toBeTruthy();
      expect(err!.textContent).not.toContain("boom"); // toSafeUserError path
    });
  });

  it("VIDEO/AUDIO: the request affordance is NEVER offered (server denies UNSUPPORTED_REDACTION_MEDIA)", () => {
    for (const kind of ["VIDEO", "AUDIO"] as const) {
      const { unmount } = renderPanel(makeVersion(null), kind);
      expect(q("[data-redaction-derivative-unsupported]")).toBeTruthy();
      expect(q("[data-redaction-derivative-request]")).toBeNull();
      expect(q("[data-redaction-derivative-download]")).toBeNull();
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// useDerivativePolling — bounded, tenant-generation-keyed
// ---------------------------------------------------------------------------

function PollHarness({
  active,
  onPoll,
  bump,
}: {
  active: boolean;
  onPoll: () => void;
  bump?: number; // dummy prop to force re-render after generation changes
}) {
  void bump;
  useDerivativePolling({ active, refresh: onPoll, intervalMs: 1000 });
  return <span data-testid="poll-harness" />;
}

describe("A1 — useDerivativePolling lifecycle", () => {
  it("polls while active, stops when no derivative is in flight, stops on unmount", async () => {
    vi.useFakeTimers();
    const onPoll = vi.fn();
    const { rerender, unmount } = render(
      <PollHarness active={true} onPoll={onPoll} />,
    );
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(onPoll).toHaveBeenCalledTimes(3);

    // Derivative reached READY → active flips false → interval disposed.
    rerender(<PollHarness active={false} onPoll={onPoll} />);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(onPoll).toHaveBeenCalledTimes(3);

    // Re-activated then unmounted → nothing fires after unmount.
    rerender(<PollHarness active={true} onPoll={onPoll} />);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(onPoll).toHaveBeenCalledTimes(4);
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(onPoll).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("a workspace (tenant-generation) change mid-poll cancels polling PERMANENTLY", async () => {
    vi.useFakeTimers();
    const onPoll = vi.fn();
    const { rerender } = render(
      <PollHarness active={true} onPoll={onPoll} bump={0} />,
    );
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(onPoll).toHaveBeenCalledTimes(2);

    // Workspace switch: the tenant generation bumps. The surface is bound
    // to the ORIGINAL tenant's project, so polling must not resume under
    // the new tenant.
    harness.generation = 1;
    rerender(<PollHarness active={true} onPoll={onPoll} bump={1} />);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onPoll).toHaveBeenCalledTimes(2); // not a single post-switch tick
    vi.useRealTimers();
  });
});
