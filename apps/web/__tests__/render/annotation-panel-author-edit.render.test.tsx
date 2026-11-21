/**
 * PRO-CENZ-01 (closure, owner decision K) — the annotation author's Edit
 * control. PATCH /v1/evidence/:id/annotations/:annotationId existed and was
 * author-only (DEC-15 / PRO-E2-03), the list projects viewerCanEdit, and the
 * error registry told users "the record panels offer Edit only to the author",
 * but the Annotations panel offered no Edit. Behavioural, with the real
 * apiFetch over a stubbed fetch.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnnotationPanel } from "../../app/(app)/evidence/components/AnnotationPanel";

const author = { id: "u1", displayName: "Reviewer", email: null };
const base = {
  evidenceId: "ev-1",
  evidencePartId: null,
  annotationType: "TEXT",
  pageNumber: null,
  mediaTimestampMs: null,
  x: null,
  y: null,
  width: null,
  height: null,
  coordinateSpace: "NORMALIZED",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  edited: false,
  author,
};
const mine = { ...base, id: "a-mine", body: "My annotation", viewerCanEdit: true };
const theirs = { ...base, id: "a-theirs", body: "A colleague's annotation", viewerCanEdit: false };

type Call = { url: string; method: string; body: unknown };

function serve(patch: (body: unknown) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (method === "PATCH") return patch(body);
      return new Response(JSON.stringify({ canWrite: true, items: [mine, theirs] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

async function openPanel() {
  const details = screen.getByText("Annotations").closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await waitFor(() => expect(screen.getByText("My annotation")).toBeTruthy());
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Annotations — the author edits their own annotation", () => {
  it("offers Edit only on the viewer's own annotation", async () => {
    serve(() => new Response("{}", { status: 500 }));
    render(<AnnotationPanel evidenceId="ev-1" />);
    await openPanel();
    // Both rows can be deleted by a writer; only the author's row offers Edit.
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
    const theirsCard = screen.getByText("A colleague's annotation").closest(".evidence-library-note-card") as HTMLElement;
    expect(theirsCard.querySelector("button")?.textContent).toBe("Delete");
  });

  it("a row without the server's viewerCanEdit projection is not offered Edit (fail closed)", async () => {
    const unprojected = { ...base, id: "a-old", body: "An unprojected annotation" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ canWrite: true, items: [unprojected] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(<AnnotationPanel evidenceId="ev-1" />);
    const details = screen.getByText("Annotations").closest("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.getByText("An unprojected annotation")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("saves the edit through PATCH and shows the server's version", async () => {
    const calls = serve(
      (body) =>
        new Response(
          JSON.stringify({
            annotation: { ...mine, body: (body as { body: string }).body, edited: true, updatedAt: "2026-11-02T00:00:00.000Z" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    render(<AnnotationPanel evidenceId="ev-1" />);
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByLabelText("Edit annotation") as HTMLTextAreaElement;
    expect(box.value).toBe("My annotation");
    fireEvent.change(box, { target: { value: "My corrected annotation" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("My corrected annotation")).toBeTruthy());
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/v1/evidence/ev-1/annotations/a-mine");
    expect(patch?.body).toEqual({ body: "My corrected annotation" });
    await waitFor(() => expect(screen.getByText(/Edited/)).toBeTruthy());
    expect(screen.getByText("My corrected annotation")).toBeTruthy();
  });

  it("a refused edit is said and the original text stays", async () => {
    serve(
      () =>
        new Response(JSON.stringify({ error: { code: "AUTHOR_ONLY_EDIT", message: "Only the author can edit this." } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    render(<AnnotationPanel evidenceId="ev-1" />);
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit annotation"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByLabelText("Edit annotation")).toBeTruthy();
    expect(screen.queryByText("Changed", { selector: "p" })).toBeNull();
  });
});
