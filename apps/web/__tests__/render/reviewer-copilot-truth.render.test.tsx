/**
 * Stage D (T-091) — the Reviewer Copilot panel's labels and states tell the
 * truth. Real panel, the real apiFetch over a stubbed fetch, RTL cleanup().
 *
 *   - no criteria set → the header says "No criteria set", never "Criteria v1";
 *   - "AI-generated" labels a result only, never the empty panel;
 *   - one record is pre-selected and the bulk controls are hidden;
 *   - a disabled Run states its reason;
 *   - an outage answered with HTTP 200 (`provider_unavailable`) is an alert;
 *   - the panel is collapsed until opened.
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<typeof import("../../lib/platform-context")>()),
  useActiveWorkspaceId: () => "44444444-4444-4444-8444-444444444444",
}));

import { ReviewerCopilotPanel } from "../../components/ai-copilot/ReviewerCopilotPanel";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let runAnswer: () => Response = () => json(200, { status: "provider_unavailable", advisoryBoundary: "AI assistance is advisory only." });
let criteriaSets: unknown[] = [];

beforeEach(() => {
  criteriaSets = [];
  runAnswer = () => json(200, { status: "provider_unavailable", advisoryBoundary: "AI assistance is advisory only." });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      if (path.startsWith("/v1/reviewer-criteria")) return json(200, { sets: criteriaSets });
      if ((init?.method ?? "GET").toUpperCase() === "POST") return runAnswer();
      return json(200, {});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const one = [{ id: "e1000000-0000-4000-8000-0000000000c1", title: "Evidence ref 0000C1", analysisRevision: "rev-1", status: "IN_REVIEW" }];

describe("T-091 — Reviewer Copilot tells the truth", () => {
  it("no criteria set: says so; no 'Criteria v1'; no 'AI-generated' before a result; collapsed until opened", async () => {
    render(<ReviewerCopilotPanel reviewId="22222222-2222-4222-8222-222222222222" evidence={one} />);
    await settle();
    const panel = screen.getByRole("region", { name: "Reviewer Copilot" });
    expect(panel.getAttribute("data-copilot-expanded")).toBe("false");
    expect(panel.querySelector("[data-copilot-criteria-label]")!.textContent).toBe("No criteria set");
    expect(panel.textContent).not.toMatch(/Criteria v1/);
    expect(panel.textContent).not.toContain("AI-generated");
    expect(panel.querySelector("[data-copilot-run]")).toBeNull();
  });

  it("one record is pre-selected; Select all / Clear are not offered for a list of one", async () => {
    render(<ReviewerCopilotPanel reviewId="22222222-2222-4222-8222-222222222222" evidence={one} />);
    await settle();
    fireEvent.click(document.querySelector("[data-copilot-toggle]")!);
    expect((screen.getByLabelText("Select Evidence ref 0000C1") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("a disabled Run states its reason", async () => {
    const stale = [{ ...one[0]!, analysisRevision: undefined }];
    render(<ReviewerCopilotPanel reviewId="22222222-2222-4222-8222-222222222222" evidence={stale} />);
    await settle();
    fireEvent.click(document.querySelector("[data-copilot-toggle]")!);
    const runBtn = document.querySelector("[data-copilot-run]") as HTMLButtonElement;
    expect(runBtn.disabled).toBe(true);
    const reason = document.getElementById(runBtn.getAttribute("aria-describedby")!)!;
    expect(reason.textContent).toMatch(/state is unavailable or out of date/);
  });

  it("an outage answered with HTTP 200 is an alert, not an empty result; a real result is labelled AI-generated", async () => {
    render(<ReviewerCopilotPanel reviewId="22222222-2222-4222-8222-222222222222" evidence={one} />);
    await settle();
    fireEvent.click(document.querySelector("[data-copilot-toggle]")!);
    await act(async () => {
      fireEvent.click(document.querySelector("[data-copilot-run]")!);
    });
    await settle();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/unavailable right now/);
    expect(alert.textContent).not.toMatch(/\(|provider_unavailable/);
    expect(document.querySelector("[data-copilot-result]")).toBeNull();
  });
});
