/**
 * PRO-R1-01 / DEC-01 — the record/case External Review panel: issue, list,
 * inspect and revoke over the EXISTING routes, driven with the real apiFetch
 * over a stubbed fetch.
 *
 *   - an entitled workspace sees the issue form, sends ONE row to the bulk
 *     invitation route for this subject, and rereads the list;
 *   - a listed live invitation can be inspected (reviewer feedback) and
 *     revoked after a confirmation; a cancelled confirmation sends nothing;
 *   - a workspace whose plan does not include External Review is offered no
 *     issue form, is told why, and can still revoke what it already issued;
 *   - a viewer the server refuses, on a plan without the feature, sees no panel.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

const gates = { included: true as boolean | null, confirm: true };
vi.mock("../../lib/platform-context/useServerProjectionGates", () => ({
  usePlanFeature: () => gates.included,
}));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  StepUpModal: () => null,
  useStepUpAction: () => ({
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) =>
      fn({ "x-step-up-challenge": "test-challenge" }),
  }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => gates.confirm }),
}));

import { ExternalReviewSubjectPanel } from "../../components/external-review/ExternalReviewSubjectPanel";

type Reply = { status: number; body: unknown };
let handler: (method: string, path: string, body: unknown, headers: Record<string, string>) => Reply;
const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];

beforeEach(() => {
  calls.length = 0;
  gates.included = true;
  gates.confirm = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const headers: Record<string, string> = {};
      new Headers(init?.headers as HeadersInit | undefined).forEach((v, k) => {
        headers[k] = v;
      });
      calls.push({ method, path, body, headers });
      const out = handler(method, path, body, headers);
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const grant = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  reviewerEmail: "reviewer@outside.test",
  reviewerDisplayName: null,
  state: "ACTIVE",
  expiresAtUtc: "2030-01-01T00:00:00.000Z",
  acceptedAtUtc: null,
  lastAccessedAtUtc: null,
  ...over,
});
const LIST = "/v1/external-review/grants?teamId=team-1&evidenceId=ev-1";
const posts = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

describe("PRO-R1-01 — External Review on the record", () => {
  it("an entitled workspace issues one invitation for this record and rereads the list", async () => {
    let issued = false;
    handler = (method, path) => {
      if (method === "GET" && path === LIST) return { status: 200, body: { grants: issued ? [grant({ state: "INVITED" })] : [] } };
      if (method === "POST" && path === "/v1/external-review/invitations/bulk") {
        issued = true;
        return { status: 201, body: { bulkBatchId: "b1", rows: [{ inviteEmail: "reviewer@outside.test", outcome: "ISSUED", grantId: grant().id }], summary: {} } };
      }
      return { status: 404, body: { error: { code: "NOT_FOUND" } } };
    };
    render(<ExternalReviewSubjectPanel teamId="team-1" subject={{ kind: "EVIDENCE", evidenceId: "ev-1" }} />);
    await waitFor(() => expect(document.querySelector("[data-external-review-empty]")).not.toBeNull());
    fireEvent.change(document.querySelector("[data-external-review-email]") as HTMLInputElement, { target: { value: "reviewer@outside.test" } });
    await act(async () => {
      screen.getByRole("button", { name: "Send invitation" }).click();
    });
    await waitFor(() => expect(posts("/v1/external-review/invitations/bulk")).toHaveLength(1));
    const sent = posts("/v1/external-review/invitations/bulk")[0]!;
    expect(sent.body).toMatchObject({
      defaultScope: { kind: "EVIDENCE", evidenceId: "ev-1" },
      rows: [{ inviteEmail: "reviewer@outside.test" }],
    });
    // The step-up challenge the ceremony produced travels with the request.
    expect(sent.headers["x-step-up-challenge"]).toBe("test-challenge");
    await waitFor(() => expect(document.querySelector(`[data-external-review-grant="${grant().id}"]`)).not.toBeNull());
    expect(document.querySelector('[data-external-review-notice="ok"]')!.textContent).toMatch(/Invitation sent/);
  });

  it("a live invitation is inspected and revoked only after confirmation", async () => {
    let state = "ACTIVE";
    handler = (method, path) => {
      if (method === "GET" && path === LIST) return { status: 200, body: { grants: [grant({ state })] } };
      if (method === "GET" && path === `/v1/external-review/invitations/${grant().id}/feedback`) {
        return { status: 200, body: { decisions: [{ id: "d1", verdict: "REJECT", rationale: "Hash chain gap", submittedAtUtc: "2029-06-01T10:00:00.000Z" }], comments: [] } };
      }
      if (method === "POST" && path === `/v1/external-review/invitations/${grant().id}/revoke`) {
        state = "REVOKED";
        return { status: 200, body: { ok: true } };
      }
      return { status: 404, body: { error: { code: "NOT_FOUND" } } };
    };
    render(<ExternalReviewSubjectPanel teamId="team-1" subject={{ kind: "EVIDENCE", evidenceId: "ev-1" }} />);
    const inspect = await screen.findByRole("button", { name: "Reviewer feedback" });
    await act(async () => {
      inspect.click();
    });
    await screen.findByText("Hash chain gap");

    gates.confirm = false;
    await act(async () => {
      screen.getByRole("button", { name: "Revoke" }).click();
    });
    expect(posts(`/v1/external-review/invitations/${grant().id}/revoke`)).toHaveLength(0);

    gates.confirm = true;
    await act(async () => {
      screen.getByRole("button", { name: "Revoke" }).click();
    });
    await waitFor(() => expect(posts(`/v1/external-review/invitations/${grant().id}/revoke`)).toHaveLength(1));
    await waitFor(() =>
      expect(document.querySelector("[data-external-review-grant-state]")!.getAttribute("data-external-review-grant-state")).toBe("REVOKED"),
    );
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("a plan without External Review offers no issue form, says why, and keeps revoke", async () => {
    gates.included = false;
    handler = (method, path) =>
      method === "GET" && path === LIST ? { status: 200, body: { grants: [grant()] } } : { status: 404, body: { error: { code: "NOT_FOUND" } } };
    render(<ExternalReviewSubjectPanel teamId="team-1" subject={{ kind: "EVIDENCE", evidenceId: "ev-1" }} />);
    await screen.findByRole("button", { name: "Revoke" });
    expect(document.querySelector("[data-external-review-issue]")).toBeNull();
    expect(document.querySelector("[data-external-review-not-included]")).not.toBeNull();
  });

  it("a refused viewer on a plan without the feature sees no panel", async () => {
    gates.included = false;
    handler = () => ({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    render(<ExternalReviewSubjectPanel teamId="team-1" subject={{ kind: "EVIDENCE", evidenceId: "ev-1" }} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(document.querySelector("[data-external-review-panel]")).toBeNull());
  });
});
