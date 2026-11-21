/**
 * NEW-RG-19-1 (owner decision G) / closure phase 2 — the masked recipient
 * contact on the evidence-request page and its audited, stepped-up reveal.
 *
 * The control follows the API's projection only (`recipientContactRevealAuthorized`,
 * `intakeLinkId`, the masked values) and says each refusal the reveal route
 * gives. The revealed value is transient: hidden on "Hide" and after
 * REVEAL_VISIBLE_MS. Real apiFetch over a stubbed fetch; the step-up hook is
 * stubbed to answer the challenge (or to be cancelled).
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
const stepUpMode = { cancel: false };
vi.mock("../../components/identity-security/StepUpModal", () => ({
  StepUpModal: () => null,
  isStepUpCancelled: (err: unknown) => (err as { code?: string } | null)?.code === "STEP_UP_CANCEL",
  useStepUpAction: () => ({
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => {
      if (stepUpMode.cancel) throw Object.assign(new Error("cancelled"), { code: "STEP_UP_CANCEL" });
      return fn({ "x-proovra-step-up-challenge-id": "challenge-1" });
    },
  }),
}));

import {
  EvidenceRequestRecipientContact,
  REVEAL_VISIBLE_MS,
} from "../../app/(app)/evidence-requests/[id]/_components/EvidenceRequestRecipientContact";

type Call = { method: string; path: string; headers: Record<string, string> };
let calls: Call[] = [];
let reply: { status: number; body: unknown };

const base = {
  id: "rq-1",
  teamId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  intakeLinkId: null as string | null,
  recipientEmailMasked: "c***@example.test",
  recipientPhoneMasked: "+44 ••• 89",
  hasRecipientEmail: true,
  hasRecipientPhone: true,
  recipientContactRevealAuthorized: true,
};

beforeEach(() => {
  calls = [];
  stepUpMode.cancel = false;
  reply = { status: 200, body: { recipientContact: { recipientEmail: "contributor@example.test", recipientPhone: "+447700900089" } } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers as HeadersInit | undefined).forEach((v, k) => {
        headers[k] = v;
      });
      calls.push({ method: init?.method ?? "GET", path: String(input).replace(/^https?:\/\/[^/]+/, ""), headers });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("NEW-RG-19-1 — reveal a link-less request's recipient contact", () => {
  it("an authorized reader reveals through the stepped-up route, and Hide masks it again", async () => {
    render(<EvidenceRequestRecipientContact request={base} />);
    expect(screen.getByText("c***@example.test")).toBeTruthy();
    expect(screen.queryByText("contributor@example.test")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal contact" }));
    await waitFor(() => expect(screen.getByText("contributor@example.test")).toBeTruthy());
    expect(screen.getByText("+447700900089")).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/v1/evidence-requests/rq-1/recipient-contact");
    expect(calls[0]!.headers["x-proovra-step-up-challenge-id"]).toBe("challenge-1");
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("contributor@example.test")).toBeNull();
    expect(screen.getByText("c***@example.test")).toBeTruthy();
  });

  it("the revealed value is transient: it is masked again after the visible window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    render(<EvidenceRequestRecipientContact request={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal contact" }));
    await waitFor(() => expect(screen.getByText("contributor@example.test")).toBeTruthy());
    act(() => {
      vi.advanceTimersByTime(REVEAL_VISIBLE_MS + 1);
    });
    expect(screen.queryByText("contributor@example.test")).toBeNull();
    expect(screen.getByText("c***@example.test")).toBeTruthy();
  });

  it("a reader the projection does not authorize, and a request with an intake link, are offered no reveal", () => {
    render(<EvidenceRequestRecipientContact request={{ ...base, recipientContactRevealAuthorized: false }} />);
    expect(screen.getByText("c***@example.test")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reveal contact" })).toBeNull();
    cleanup();
    render(<EvidenceRequestRecipientContact request={{ ...base, intakeLinkId: "link-1" }} />);
    expect(screen.queryByRole("button", { name: "Reveal contact" })).toBeNull();
    expect(screen.getByText(/revealed on that intake link/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("a request with no contact renders nothing", () => {
    const { container } = render(
      <EvidenceRequestRecipientContact request={{ ...base, hasRecipientEmail: false, hasRecipientPhone: false }} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("each refusal is said truthfully and nothing is revealed", async () => {
    reply = { status: 403, body: { error: { code: "FORBIDDEN", message: "You do not have permission." } } };
    render(<EvidenceRequestRecipientContact request={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal contact" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/role does not include revealing/));
    expect(screen.queryByText("contributor@example.test")).toBeNull();

    cleanup();
    reply = {
      status: 409,
      body: { error: { code: "REVEAL_VIA_INTAKE_LINK", message: "x", details: { intakeLinkId: "link-9" } } },
    };
    render(<EvidenceRequestRecipientContact request={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal contact" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Reveal the recipient's contact on that intake link/));

    cleanup();
    reply = { status: 404, body: { error: { code: "request_not_found" } } };
    render(<EvidenceRequestRecipientContact request={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal contact" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/no longer available/));
  });

  it("a cancelled step-up reveals nothing and reports no error", async () => {
    stepUpMode.cancel = true;
    render(<EvidenceRequestRecipientContact request={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal contact" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Reveal contact" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
