/**
 * CLOSURE2 — the legal-notes and reviewer-comments panels offer Edit only
 * when the server projects viewerCanEdit === true, matching the annotation
 * panel (EP-0379). Edits are author-only on the server (DEC-15 / PRO-E2-03);
 * a row without the projection previously showed Edit (`!== false`), an
 * affordance the server then refused. Behavioural, with the real apiFetch over
 * a stubbed fetch.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LegalNotesPanel } from "../../app/(app)/evidence/components/LegalNotesPanel";
import { ReviewerCommentsPanel } from "../../app/(app)/evidence/components/ReviewerCommentsPanel";

const author = { id: "u1", displayName: "Reviewer", email: null };
const row = (id: string, body: string, extra: Record<string, unknown>) => ({
  id,
  body,
  noteType: "GENERAL",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  edited: false,
  author,
  canManage: true,
  ...extra,
});

function serve(items: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ canWrite: true, items }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

async function open(summary: string, firstBody: string) {
  const details = screen.getByText(summary).closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await waitFor(() => expect(screen.getByText(firstBody)).toBeTruthy());
}

const items = [
  row("mine", "Mine", { viewerCanEdit: true }),
  row("theirs", "Theirs", { viewerCanEdit: false }),
  row("unprojected", "Unprojected", {}),
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Edit is offered only on an explicit viewerCanEdit", () => {
  it("legal notes: Edit on the author's row only; a manager still deletes; no Edit on an unprojected row", async () => {
    serve(items);
    render(<LegalNotesPanel evidenceId="ev-1" />);
    await open("Legal notes", "Mine");
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(3);
  });

  it("reviewer comments: Edit on the author's row only; no Edit on an unprojected row", async () => {
    serve(items);
    render(<ReviewerCommentsPanel evidenceId="ev-1" />);
    await open("Reviewer comments", "Mine");
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
  });
});
