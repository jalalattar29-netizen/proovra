/**
 * EP-0389 / PRO-CENZ-01 (closure phase 2) — edit a relationship's type and
 * note. PATCH /v1/evidence/:id/relationships/:relationshipId existed and the
 * web only removed links. Edit is offered on the same answer as Remove
 * (`canManageRelationships`), saves through the PATCH, rereads the record,
 * and says the API's refusals. Real apiFetch over a stubbed fetch.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true }),
}));

import { EvidenceRelationshipsSection } from "../../app/(app)/evidence/[id]/components/EvidenceRelationshipsSection";

type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
let reply: { status: number; body: unknown };

const item = {
  id: "rel-1",
  relationshipType: "RELATED",
  note: "Same scene",
  direction: "outbound" as const,
  linkedEvidence: { id: "ev-2", title: "Second angle", status: "SIGNED" },
};

function renderSection(over: Partial<React.ComponentProps<typeof EvidenceRelationshipsSection>> = {}) {
  const onRelationshipEdited = vi.fn();
  render(
    <EvidenceRelationshipsSection
      caseName={null}
      relatedEvidenceCount={null}
      multipart={false}
      itemCount={1}
      note={null}
      items={[item]}
      actionBusy={false}
      onAssignCase={() => {}}
      onRemoveCase={null}
      onOpenRelationshipEditor={() => {}}
      onOpenLinkedEvidence={() => {}}
      onRemoveRelationship={() => {}}
      evidenceId="ev-1"
      onRelationshipEdited={onRelationshipEdited}
      {...over}
    />,
  );
  return { onRelationshipEdited };
}

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: { items: [] } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        path: String(input).replace(/^https?:\/\/[^/]+/, ""),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EP-0389 — edit a relationship", () => {
  it("saves the type and note through PATCH and rereads the record", async () => {
    const { onRelationshipEdited } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit relationship" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Relationship type" }));
    fireEvent.click(screen.getByRole("option", { name: "CONTRADICTS" }));
    fireEvent.change(screen.getByLabelText("Relationship note"), { target: { value: "  Timestamps disagree  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save relationship" }));
    await waitFor(() => expect(onRelationshipEdited).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/v1/evidence/ev-1/relationships/rel-1",
        body: { relationshipType: "CONTRADICTS", note: "Timestamps disagree" },
      },
    ]);
    expect(screen.queryByRole("button", { name: "Save relationship" })).toBeNull();
  });

  it("a viewer who may not manage relationships, or a parent that wires no reread, is offered no Edit", () => {
    renderSection({ canManageRelationships: false });
    expect(screen.queryByRole("button", { name: "Edit relationship" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove relationship" })).toBeNull();
    cleanup();
    renderSection({ onRelationshipEdited: undefined });
    expect(screen.queryByRole("button", { name: "Edit relationship" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove relationship" })).toBeTruthy();
  });

  it("a refused edit is said, nothing is reread, and the form stays open", async () => {
    reply = { status: 404, body: { message: "Relationship not found" } };
    const { onRelationshipEdited } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit relationship" }));
    fireEvent.click(screen.getByRole("button", { name: "Save relationship" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/no longer available to you/));
    expect(onRelationshipEdited).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save relationship" })).toBeTruthy();

    cleanup();
    reply = { status: 409, body: { error: { code: "EVIDENCE_NOT_WRITABLE", message: "This record is in trash." } } };
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit relationship" }));
    fireEvent.click(screen.getByRole("button", { name: "Save relationship" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });
});
