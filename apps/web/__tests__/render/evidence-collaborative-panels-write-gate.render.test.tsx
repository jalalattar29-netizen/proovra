/**
 * EVID-010 — the review panels offer writing only to a reader the API would
 * accept. The list response carries the answer; the real apiFetch reads it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnnotationPanel } from "../../app/(app)/evidence/components/AnnotationPanel";
import { LegalNotesPanel } from "../../app/(app)/evidence/components/LegalNotesPanel";
import { ReviewerCommentsPanel } from "../../app/(app)/evidence/components/ReviewerCommentsPanel";

const author = { id: "u1", displayName: "Reviewer", email: null };
const row = {
  id: "row-1",
  evidenceId: "ev-1",
  body: "An existing entry",
  visibility: "INTERNAL",
  noteType: "GENERAL",
  annotationType: "POINT",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  edited: false,
  author,
};

function answer(canWrite: boolean | undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ...(canWrite === undefined ? {} : { canWrite }), items: [row] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

async function openPanel(summary: string) {
  fireEvent.click(screen.getByText(summary));
  const details = screen.getByText(summary).closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await waitFor(() => expect(screen.getByText("An existing entry")).toBeTruthy());
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const panels = [
  ["Reviewer comments", <ReviewerCommentsPanel key="c" evidenceId="ev-1" />, "Save Comment"],
  ["Legal notes", <LegalNotesPanel key="n" evidenceId="ev-1" />, "Save Legal Note"],
  ["Annotations", <AnnotationPanel key="a" evidenceId="ev-1" />, "Add Text Annotation"],
] as const;

describe.each(panels)("%s", (summary, panel, saveLabel) => {
  it("a reader the API refuses sees the content and no write control", async () => {
    answer(false);
    render(panel);
    await openPanel(summary);
    expect(screen.queryByRole("button", { name: saveLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("a response that does not say so offers nothing", async () => {
    answer(undefined);
    render(panel);
    await openPanel(summary);
    expect(screen.queryByRole("button", { name: saveLabel })).toBeNull();
  });

  it("a reader the API accepts gets the controls", async () => {
    answer(true);
    render(panel);
    await openPanel(summary);
    expect(screen.getByRole("button", { name: saveLabel })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});
