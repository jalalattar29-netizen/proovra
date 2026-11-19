/**
 * PRO-I1-01 (release order) — the web deploys before the API.
 *
 * The API that fixes PRO-I1-01 keeps the needs-more-info reviewer note inside
 * the workspace and emails only `contributorMessage`; it states that with
 * `needsMoreInfoDelivery` on every request projection. The API deployed when
 * this web build ships has no such field: it REQUIRES the note, emails it to
 * the recipient and silently drops `contributorMessage`.
 *
 * Both web surfaces must therefore
 *   - against the OLD answer: say the note is emailed, never "internal",
 *     offer no contributor-message field, require the note, and post the note
 *     alone;
 *   - against the NEW answer: say the note stays internal, offer the separate
 *     contributor message, and post both.
 *
 * Driven with the REAL apiFetch over a stubbed fetch.
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  WorkspaceContextBanner: () => null,
  useWorkspaceContextSafety: () => ({
    runGuarded: async (fn: () => Promise<unknown>, after: () => unknown) => {
      await fn();
      await after();
    },
  }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: vi.fn(), askReason: vi.fn() }),
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/navigation/useRouteDestination", () => ({ useRouteAccess: () => ({ canLoad: true }) }));
vi.mock("../../components/navigation/OperationalBreadcrumb", () => ({ OperationalBreadcrumb: () => null }));
vi.mock("../../components/notifications/ContextualDeliveryStatus", () => ({ ContextualDeliveryStatus: () => null }));
vi.mock("../../components/hidden-feature-panels/HiddenFeaturePanels", () => ({
  EvidenceRequestEventsTab: () => null,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "11111111-1111-4111-8111-111111111111" }),
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import EvidenceRequestPanel from "../../app/(app)/evidence/[id]/components/EvidenceRequestPanel";
import EvidenceRequestInspectorPage from "../../app/(app)/evidence-requests/[id]/page";
import { reviewerNoteStaysInternal } from "../../lib/evidence/needs-more-info-delivery";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const REQ = "11111111-1111-4111-8111-111111111111";

/** What the fixed API adds to every request projection. */
const NEW_API = { needsMoreInfoDelivery: { reviewerNote: "INTERNAL", contributorMessage: true, contributorMessageMax: 1000 } };

type Call = { method: string; path: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let requestRow: Record<string, unknown>;

function row(over: Record<string, unknown> = {}) {
  return {
    id: REQ, teamId: TEAM, evidenceId: EV, caseId: null, workflowTemplateSlug: null, workflowStepId: null,
    requestType: "ADDITIONAL_EVIDENCE", status: "RESPONSE_RECEIVED", priority: "NORMAL", title: "Roof photos",
    instructions: "", dueAtUtc: null, recipientMode: "EXTERNAL_CONTRIBUTOR", recipientLabel: null, recipientEmail: null,
    requestedByUserId: "u-1", assignedReviewerUserId: null, intakeLinkId: "link-1", reviewerNote: null,
    sentAtUtc: null, firstOpenedAtUtc: null, closedAtUtc: null, cancelledAtUtc: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    deliverables: [], responses: [], ...over,
  };
}

beforeEach(() => {
  calls = [];
  requestRow = row();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path, body });
      let out: unknown = {};
      if (method === "GET" && path.startsWith("/v1/evidence-requests?")) out = { requests: [requestRow] };
      else if (method === "GET" && path === `/v1/evidence-requests/${REQ}`) out = { request: requestRow };
      else if (path.includes("/members")) out = { members: [], nextCursor: null };
      else if (method === "POST" && path.endsWith("/needs-more-info")) out = { request: requestRow };
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  vi.stubGlobal("alert", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
const posted = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/needs-more-info"));

describe("PRO-I1-01 — the capability is read from the server's answer, and unknown is never 'internal'", () => {
  it("only the explicit confirmation counts", () => {
    expect(reviewerNoteStaysInternal(NEW_API)).toBe(true);
    expect(reviewerNoteStaysInternal({})).toBe(false);
    expect(reviewerNoteStaysInternal(null)).toBe(false);
    expect(reviewerNoteStaysInternal({ needsMoreInfoDelivery: null })).toBe(false);
    expect(reviewerNoteStaysInternal({ needsMoreInfoDelivery: { reviewerNote: "EMAILED", contributorMessage: true } })).toBe(false);
    expect(reviewerNoteStaysInternal({ needsMoreInfoDelivery: { reviewerNote: "INTERNAL" } })).toBe(false);
  });
});

describe("PRO-I1-01 — request inspector page", () => {
  async function mountPage() {
    const view = render(<EvidenceRequestInspectorPage />);
    await waitFor(() => expect(view.container.querySelector("[data-evidence-request-rerequest]")).not.toBeNull());
    return view.container.querySelector("[data-evidence-request-rerequest]") as HTMLElement;
  }

  it("OLD API (no capability field): says the note is emailed, offers no contributor field, sends the note alone", async () => {
    const section = await mountPage();
    expect(section.textContent).toContain("the note below is emailed to them");
    expect(section.textContent).not.toMatch(/stays inside the workspace/i);
    expect(section.textContent).not.toMatch(/workspace-internal/i);
    expect(section.querySelector("[data-evidence-request-contributor-message]")).toBeNull();
    const note = within(section).getByLabelText("Note (emailed to the contributor, required)");
    expect(within(section).queryByLabelText(/workspace-internal/i)).toBeNull();

    // The older API refuses an empty note: the action waits for one.
    const button = within(section).getByRole("button", { name: /mark as needs more info/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(note, { target: { value: "Please retake photo 2" } });
    expect(button.disabled).toBe(false);
    await act(async () => {
      button.click();
    });
    await settle();
    expect(posted()).toHaveLength(1);
    expect(posted()[0]!.body).toEqual({ reviewerNote: "Please retake photo 2" });
  });

  it("NEW API (capability confirmed): the note stays internal and the contributor message is separate", async () => {
    requestRow = row(NEW_API);
    const section = await mountPage();
    expect(section.textContent).toMatch(/reviewer note stays inside the workspace/i);
    expect(section.textContent).not.toContain("the note below is emailed to them");
    const note = within(section).getByLabelText("Reviewer note (workspace-internal, optional)");
    const message = within(section).getByLabelText("Message to the contributor (sent by email, optional)");
    const button = within(section).getByRole("button", { name: /mark as needs more info/i }) as HTMLButtonElement;
    // The note is optional on the new API.
    expect(button.disabled).toBe(false);
    fireEvent.change(note, { target: { value: "Suspect staged; do not tell them" } });
    fireEvent.change(message, { target: { value: "Please retake photo 2" } });
    await act(async () => {
      button.click();
    });
    await settle();
    expect(posted()).toHaveLength(1);
    expect(posted()[0]!.body).toEqual({
      reviewerNote: "Suspect staged; do not tell them",
      contributorMessage: "Please retake photo 2",
    });
  });
});

describe("PRO-I1-01 — record-detail Linked requests panel", () => {
  async function openDialog() {
    render(<EvidenceRequestPanel evidenceId={EV} teamId={TEAM} />);
    await settle();
    await waitFor(() => expect(document.querySelector(".evd-card")).not.toBeNull());
    const card = document.querySelector(".evd-card") as HTMLElement;
    await act(async () => {
      within(card).getByRole("button", { name: /needs more info/i }).click();
    });
    return screen.getByRole("dialog");
  }

  it("OLD API (no capability field): the dialog says the note is emailed and has one field", async () => {
    const dialog = await openDialog();
    expect(dialog.textContent).toContain("the note below is emailed to them");
    expect(dialog.textContent).not.toMatch(/the note is internal/i);
    expect(dialog.textContent).not.toMatch(/not shared with the contributor/i);
    expect(dialog.querySelector("[data-evidence-request-contributor-message]")).toBeNull();
    expect(within(dialog).getAllByRole("textbox")).toHaveLength(1);
    fireEvent.change(within(dialog).getByLabelText("Note (emailed to the contributor, required)"), {
      target: { value: "Please retake photo 2" },
    });
    await act(async () => {
      within(dialog).getByRole("button", { name: /confirm/i }).click();
    });
    await settle();
    expect(posted()).toHaveLength(1);
    expect(posted()[0]!.body).toEqual({ reviewerNote: "Please retake photo 2" });
  });

  it("NEW API (capability confirmed): internal note plus the separate contributor message", async () => {
    requestRow = row(NEW_API);
    const dialog = await openDialog();
    expect(dialog.textContent).toMatch(/the note\s+is internal/i);
    expect(dialog.textContent).not.toContain("the note below is emailed to them");
    fireEvent.change(within(dialog).getByLabelText("Reviewer note (internal)"), {
      target: { value: "Suspect staged; do not tell them" },
    });
    fireEvent.change(within(dialog).getByLabelText("Message to the contributor (sent by email, optional)"), {
      target: { value: "Please retake photo 2" },
    });
    await act(async () => {
      within(dialog).getByRole("button", { name: /confirm/i }).click();
    });
    await settle();
    expect(posted()).toHaveLength(1);
    expect(posted()[0]!.body).toEqual({
      reviewerNote: "Suspect staged; do not tell them",
      contributorMessage: "Please retake photo 2",
    });
  });

  it("the other note dialogs (close) keep the internal copy on either API", async () => {
    render(<EvidenceRequestPanel evidenceId={EV} teamId={TEAM} />);
    await settle();
    await waitFor(() => expect(document.querySelector(".evd-card")).not.toBeNull());
    await act(async () => {
      within(document.querySelector(".evd-card") as HTMLElement).getByRole("button", { name: /^close$/i }).click();
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/the note\s+is internal/i);
    expect(dialog.querySelector("[data-evidence-request-contributor-message]")).toBeNull();
  });
});
