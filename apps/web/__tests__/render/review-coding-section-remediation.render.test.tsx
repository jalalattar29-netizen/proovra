/**
 * Review remediation §6 (2026-11-27) — ReviewCodingSection: writable,
 * other-schema values (F-26), re-read after bind (F-19), visible load failure
 * with Retry, explicit clear through POST {clear:true} (F-13).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  onBound: null as null | (() => void),
}));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../app/(app)/reviewer-ops/components/CodingSchemaBindingPanel", () => ({
  CodingSchemaBindingPanel: ({ onBound }: { onBound?: () => void }) => {
    mocks.onBound = onBound ?? null;
    return null;
  },
}));

import { ReviewCodingSection } from "../../components/reviewer-experience/ReviewCodingSection";

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workflowId = "22222222-2222-4222-8222-222222222222";
const schemaId = "11111111-1111-4111-8111-111111111111";
const codingUrl = `/v1/reviewer/work/${workflowId}/coding?teamId=${teamId}`;
const codeUrl = `/v1/reviewer/work/${workflowId}/code?teamId=${teamId}`;

let coding: Record<string, unknown> | Error = {};
const schema = {
  id: schemaId,
  fields: [{ id: "f-notes", slug: "notes", label: "Notes", fieldType: "TEXT", required: false, orderIndex: 0, helpText: null, options: null }],
};

beforeEach(() => {
  mocks.onBound = null;
  coding = { schemaBinding: null, values: [], otherSchemaValues: [], coverage: { unfulfilledFieldIds: [] }, writable: { allowed: false, reason: "no_schema" } };
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === codingUrl) {
      if (coding instanceof Error) throw coding;
      return coding;
    }
    if (path.startsWith(`/v1/coding/schemas/${schemaId}`)) return { schema };
    if (path === codeUrl) return { cleared: true, codingValueId: "v1" };
    return {};
  });
});
afterEach(cleanup);

function bound(extra: Record<string, unknown> = {}) {
  return {
    schemaBinding: { id: schemaId, label: "General Evidence Review", version: 1, status: "PUBLISHED" },
    values: [{ id: "v1", fieldId: "f-notes", value: { text: "Dent" }, rationale: null, authorUserId: "u", updatedAt: "2026-11-27T00:00:00Z" }],
    otherSchemaValues: [],
    coverage: { unfulfilledFieldIds: [] },
    writable: { allowed: true, reason: null },
    ...extra,
  };
}

describe("ReviewCodingSection — remediation", () => {
  it("re-reads the coding as soon as a schema is bound (no reload)", async () => {
    render(<ReviewCodingSection teamId={teamId} workflowId={workflowId} />);
    await waitFor(() => expect(document.querySelector('[data-review-coding-state="unbound"]')).not.toBeNull());
    expect(document.querySelector("[data-coding-panel]")).toBeNull();
    coding = bound();
    expect(mocks.onBound).toBeTypeOf("function");
    mocks.onBound!();
    await waitFor(() => expect(document.querySelector("[data-coding-panel]")).not.toBeNull());
    expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).value).toBe("Dent");
  });

  it("states a load failure with Retry instead of staying silent", async () => {
    coding = Object.assign(new Error("boom"), { statusCode: 500 });
    render(<ReviewCodingSection teamId={teamId} workflowId={workflowId} />);
    const alert = await screen.findByText("The coding for this review could not be loaded.");
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    coding = bound();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(document.querySelector("[data-coding-panel]")).not.toBeNull());
  });

  it("passes writable through: a closed review is read-only with the reason", async () => {
    coding = bound({ writable: { allowed: false, reason: "workflow_closed" } });
    render(<ReviewCodingSection teamId={teamId} workflowId={workflowId} />);
    await screen.findByText("This review is closed. Coding is read-only.");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("lists values of a previously bound schema collapsed and not as current", async () => {
    coding = bound({
      otherSchemaValues: [
        {
          id: "old-1",
          fieldId: "f-old",
          value: { text: "Old note" },
          updatedAt: "2026-11-01T00:00:00Z",
          schemaId: "33333333-3333-4333-8333-333333333333",
          schemaLabel: "Legal Matter Review",
          schemaVersion: 1,
          fieldLabel: "Reviewer notes",
          fieldType: "TEXT",
        },
      ],
    });
    render(<ReviewCodingSection teamId={teamId} workflowId={workflowId} />);
    const details = await waitFor(() => {
      const el = document.querySelector("[data-review-coding-other-schema]");
      expect(el).not.toBeNull();
      return el as HTMLDetailsElement;
    });
    expect(details.tagName).toBe("DETAILS");
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toContain("Values from a previously bound schema (not current)");
    expect(details.textContent).toContain("Old note");
    // Not inside the current coding panel.
    expect(document.querySelector("[data-coding-panel]")!.textContent).not.toContain("Old note");
  });

  it("an emptied field is cleared through POST { fieldId, clear: true }", async () => {
    coding = bound();
    render(<ReviewCodingSection teamId={teamId} workflowId={workflowId} />);
    const box = (await screen.findByLabelText("Notes")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.blur(box);
    await waitFor(() => {
      const posts = mocks.fetch.mock.calls.filter(([p, init]) => p === codeUrl && init?.method === "POST");
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String(posts[0]![1].body))).toEqual({ fieldId: "f-notes", clear: true });
    });
  });
});
