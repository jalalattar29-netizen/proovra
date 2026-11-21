/**
 * EP-0343 / PRO-CENZ-01 (closure phase 2) — the DRAFT edit control.
 *
 * PATCH /v1/evidence-requests/:id is DRAFT-only and had no caller. The record
 * panel now offers "Edit draft" on a DRAFT row (and on no other), the dialog
 * reads the request fresh, saves through the PATCH, and says the API's own
 * refusals (409 request_not_editable, 403, 404). Driven with the REAL apiFetch
 * over a stubbed fetch, so nested codes reach the dialog as in production.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  WorkspaceContextBanner: () => null,
  useWorkspaceContextSafety: () => ({ runGuarded: async (fn: () => Promise<unknown>) => fn() }),
}));

import EvidenceRequestPanel from "../../app/(app)/evidence/[id]/components/EvidenceRequestPanel";
import { EditDraftRequestDialog } from "../../components/evidence-requests/EditDraftRequestDialog";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
let onPatch: (body: unknown) => { status: number; body: unknown };

const deliverable = {
  id: "d-1", title: "Roof close-up", description: "", required: true, acceptedKinds: ["PHOTO"], minCount: 2,
  maxCount: 5, locationRequirement: "required", captureAfterRequest: true, workflowStepId: null, sortOrder: 0,
  status: "PENDING", waivedReason: null, fulfilledCount: 0,
};
function req(over: Record<string, unknown> = {}) {
  return {
    id: "rq-1", teamId: TEAM, status: "DRAFT", priority: "NORMAL", requestType: "ADDITIONAL_EVIDENCE", title: "Roof photos",
    instructions: "Two angles", dueAtUtc: null, recipientMode: "EXTERNAL_CONTRIBUTOR", recipientLabel: null,
    recipientEmail: null, recipientEmailMasked: "c***@example.test", hasRecipientEmail: true,
    intakeLinkId: null, reviewerNote: null, sentAtUtc: null, firstOpenedAtUtc: null, closedAtUtc: null, cancelledAtUtc: null,
    createdAt: "2026-09-01T00:00:00.000Z", deliverables: [deliverable], responses: [], ...over,
  };
}
let rows: Array<Record<string, unknown>> = [];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  rows = [req()];
  onPatch = (body) => ({ status: 200, body: { request: { ...req(), ...(body as object) } } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path, body });
      if (method === "GET" && path.startsWith("/v1/evidence-requests?")) return json(200, { requests: rows });
      if (method === "GET" && path === "/v1/evidence-requests/rq-1") return json(200, { request: rows[0] });
      if (method === "PATCH") {
        const out = onPatch(body);
        return json(out.status, out.body);
      }
      return json(200, {});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const patches = () => calls.filter((c) => c.method === "PATCH");

describe("EP-0343 — Edit a DRAFT evidence request", () => {
  it("the record panel offers Edit draft on a DRAFT row only", async () => {
    rows = [req(), req({ id: "rq-2", status: "SENT", title: "Already sent" })];
    render(<EvidenceRequestPanel evidenceId={EV} teamId={TEAM} />);
    await waitFor(() => expect(screen.getByText("Already sent")).toBeTruthy());
    const draftCard = screen.getByText("Roof photos").closest("article") as HTMLElement;
    const sentCard = screen.getByText("Already sent").closest("article") as HTMLElement;
    expect(within(draftCard).getByRole("button", { name: "Edit draft" })).toBeTruthy();
    expect(within(sentCard).queryByRole("button", { name: "Edit draft" })).toBeNull();
  });

  it("saves the draft through PATCH, keeps deliverables and contact untouched, and rereads the list", async () => {
    render(<EvidenceRequestPanel evidenceId={EV} teamId={TEAM} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit draft" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(title.value).toBe("Roof photos");
    // The masked address is shown, never a raw one.
    expect(screen.getByText(/c\*\*\*@example\.test/)).toBeTruthy();
    fireEvent.change(title, { target: { value: "Roof photos (north side)" } });
    const listReadsBefore = calls.filter((c) => c.path.startsWith("/v1/evidence-requests?")).length;
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    const body = patches()[0]!.body as Record<string, unknown>;
    expect(patches()[0]!.path).toBe("/v1/evidence-requests/rq-1");
    expect(body.title).toBe("Roof photos (north side)");
    // Unchanged deliverables are not resent (the API replaces them whole),
    // and a blank email field changes no contact.
    expect("deliverables" in body).toBe(false);
    expect("recipientEmail" in body).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.path.startsWith("/v1/evidence-requests?")).length).toBe(listReadsBefore + 1);
  });

  it("a changed deliverable list is sent whole, carrying over the fields the dialog does not edit", async () => {
    render(<EditDraftRequestDialog requestId="rq-1" onClose={() => {}} onSaved={() => {}} />);
    const d1 = (await screen.findByLabelText("Deliverable 1 title")) as HTMLInputElement;
    fireEvent.change(d1, { target: { value: "Roof close-up, both slopes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    const sent = (patches()[0]!.body as { deliverables: Array<Record<string, unknown>> }).deliverables;
    expect(sent).toEqual([
      {
        title: "Roof close-up, both slopes", description: "", required: true, acceptedKinds: ["PHOTO"], minCount: 2,
        maxCount: 5, locationRequirement: "required", captureAfterRequest: true, workflowStepId: null, sortOrder: 0,
      },
    ]);
  });

  it("a request that already left Draft is said, and nothing is saved", async () => {
    onPatch = () => ({ status: 409, body: { error: { code: "request_not_editable", currentStatus: "SENT" } } });
    const onSaved = vi.fn();
    render(<EditDraftRequestDialog requestId="rq-1" onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Late edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/already left Draft/));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("a role the API refuses is told so (403), and a fresh read of a non-draft offers no Save", async () => {
    onPatch = () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "Forbidden" } } });
    render(<EditDraftRequestDialog requestId="rq-1" onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/role does not include editing/));
    cleanup();
    rows = [req({ status: "OPEN" })];
    render(<EditDraftRequestDialog requestId="rq-1" onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/already left Draft/));
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });
});
