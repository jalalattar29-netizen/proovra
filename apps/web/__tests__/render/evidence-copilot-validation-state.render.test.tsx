/**
 * EVIDENCE COPILOT (UI) — a discarded response is an actionable state, not a
 * dead panel, and the discarded text is never shown.
 *
 * The server rejects a response that breaks the output contract and returns
 * `status: "schema_error"` with a bounded category. The panel must:
 *   - render an alert that says what happened and offers Retry,
 *   - never display anything from the rejected model output,
 *   - re-issue the request when Retry is pressed,
 *   - render the accepted answer normally when the contract is met.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

let responder: () => unknown = () => ({});
let calls: string[] = [];

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    calls.push(path);
    return responder();
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {
    statusCode = 500;
    code = "ERR";
  },
}));

import { EvidenceCopilotPanel } from "../../components/ai-copilot/EvidenceCopilotPanel";

const EVIDENCE_ID = "ev-copilot-1";
// A well-formed opaque revision, shaped like a real one: this product's
// prefix plus a full-length base64url digest. The panel refuses to run
// without one, which is the point — it was `evidenceVersion={2}`, built by
// the caller with `?? 0`.
const REVISION = "ear1_" + "e".repeat(43);
const BOUNDARY =
  "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.";

const runButton = () => screen.getByRole("button", { name: /run evidence copilot|re-run/i });

beforeEach(() => {
  calls = [];
});

describe("Evidence Copilot — validated result", () => {
  it("renders the accepted answer", async () => {
    responder = () => ({
      status: "ok",
      data: {
        status: "ok",
        data: {
          operationalSummary: "The record has a recorded hash and a pending anchor confirmation.",
          missingContext: ["No reviewer has been assigned."],
          integritySignalExplanations: [],
          custodyObservations: [],
          timestampingObservations: [],
          reportReadiness: [],
          packageReadiness: [],
          reviewerPreparation: [],
          workflowGaps: [],
          suggestedNavigation: [],
          suggestedActions: [],
          citations: [],
          advisoryBoundary: BOUNDARY,
        },
      },
      serverActions: [],
    });

    render(<EvidenceCopilotPanel evidenceId={EVIDENCE_ID} analysisRevision={REVISION} />);
    await act(async () => {
      runButton().click();
    });

    await waitFor(() =>
      expect(document.body.textContent).toMatch(/pending anchor confirmation/),
    );
    expect(document.querySelector("[data-copilot-schema-error]")).toBeNull();
  });
});

describe("Evidence Copilot — a response that failed validation", () => {
  it("shows an actionable error, hides the discarded output, and retries on demand", async () => {
    responder = () => ({
      status: "ok",
      // The server's own envelope: the response was discarded, and only the
      // bounded category travels with it.
      data: {
        status: "schema_error",
        validationCategory: "TOO_LONG",
        advisoryBoundary: BOUNDARY,
      },
      serverActions: [],
    });

    render(<EvidenceCopilotPanel evidenceId={EVIDENCE_ID} analysisRevision={REVISION} />);
    await act(async () => {
      runButton().click();
    });

    const alert = await waitFor(() => {
      const node = document.querySelector("[data-copilot-schema-error]");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });

    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toMatch(/did not meet/i);
    expect(alert.textContent).toMatch(/Nothing from it was saved or shown/i);
    // The internal category is for server-side telemetry, not for the reader.
    expect(alert.textContent).not.toMatch(/TOO_LONG|schema_error/);

    const retry = alert.querySelector("[data-copilot-retry]") as HTMLButtonElement;
    expect(retry).not.toBeNull();

    const before = calls.length;
    await act(async () => {
      retry.click();
    });
    await waitFor(() => expect(calls.length).toBe(before + 1));
    expect(calls[calls.length - 1]).toBe(`/v1/ai/evidence/${EVIDENCE_ID}/copilot`);
  });

  it("does not render an operational summary that was never accepted", async () => {
    responder = () => ({
      status: "ok",
      data: { status: "schema_error", validationCategory: "WRONG_TYPE", advisoryBoundary: BOUNDARY },
      serverActions: [],
    });
    render(<EvidenceCopilotPanel evidenceId={EVIDENCE_ID} analysisRevision={REVISION} />);
    await act(async () => {
      runButton().click();
    });
    await waitFor(() =>
      expect(document.querySelector("[data-copilot-schema-error]")).not.toBeNull(),
    );
    expect(document.body.textContent).not.toMatch(/Operational summary/);
  });
});

describe("Evidence Copilot — no analysis revision", () => {
  it("FAILS CLOSED: without a revision nothing is sent at all", async () => {
    // The panel used to be mounted with `evidenceVersion={...verificationPackageVersion ?? 0}`,
    // so a record whose version the projection had not carried was analyzed
    // against a fabricated zero. Now a record nobody can say is current is not
    // sent: the request never leaves, so no budget is reserved and no provider
    // is called, rather than the server refusing after the fact.
    const before = calls.length;
    render(<EvidenceCopilotPanel evidenceId={EVIDENCE_ID} />);
    await act(async () => {
      runButton().click();
    });
    expect(calls.length).toBe(before);
    expect(document.querySelector("[data-copilot-schema-error]")).toBeNull();
  });
});
