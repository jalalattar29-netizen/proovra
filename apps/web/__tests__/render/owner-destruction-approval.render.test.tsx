/**
 * MATRIX-M626 (owner decision I) / closure phase 2 — the record owner's
 * approval of permanent deletion for a record in no workspace.
 *
 * The panel follows the API only: GET says whether an owner approval applies
 * (offered) and what stands for this trash cycle; approve runs through the
 * step-up flow; withdraw is not offered while destruction is claimed; every
 * refusal is said. Lifecycle verdicts (legal hold, earliest deletion) come
 * from the record projection. Real apiFetch over a stubbed fetch.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
const gates = { confirm: true, cancelStepUp: false };
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => gates.confirm }),
}));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  StepUpModal: () => null,
  isStepUpCancelled: (err: unknown) => (err as { code?: string } | null)?.code === "STEP_UP_CANCEL",
  useStepUpAction: () => ({
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => {
      if (gates.cancelStepUp) throw Object.assign(new Error("cancelled"), { code: "STEP_UP_CANCEL" });
      return fn({ "x-proovra-step-up-challenge-id": "challenge-1" });
    },
  }),
}));

import { OwnerDestructionApprovalPanel } from "../../app/(app)/evidence/[id]/components/OwnerDestructionApprovalPanel";

const PATH = "/v1/evidence/ev-1/owner-destruction-approval";
type Call = { method: string; path: string; body: unknown; headers: Record<string, string> };
let calls: Call[] = [];
let state: { status: number; body: unknown };
let writeReply: { status: number; body: unknown };

const offered = (approval: unknown = null, destructionInProgress = false) => ({
  status: 200,
  body: { offered: true, trashedAtUtc: "2026-11-01T00:00:00.000Z", approval, destructionInProgress },
});
const APPROVAL = { id: "ap-1", approvedAtUtc: "2026-11-02T00:00:00.000Z" };

beforeEach(() => {
  calls = [];
  gates.confirm = true;
  gates.cancelStepUp = false;
  state = offered();
  writeReply = { status: 201, body: { approval: { id: "ap-1", trashedAtUtc: "2026-11-01T00:00:00.000Z" }, deduplicated: false } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      new Headers(init?.headers as HeadersInit | undefined).forEach((v, k) => {
        headers[k] = v;
      });
      calls.push({
        method,
        path: String(input).replace(/^https?:\/\/[^/]+/, ""),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers,
      });
      const out = method === "GET" ? state : writeReply;
      if (method !== "GET" && writeReply.status < 300) {
        state = method === "POST" ? offered(APPROVAL) : offered(null);
      }
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const writes = (method: string) => calls.filter((c) => c.method === method && c.path === PATH);

describe("MATRIX-M626 — the owner approves or withdraws permanent deletion", () => {
  it("approves through the step-up flow for this record and rereads the standing approval", async () => {
    render(<OwnerDestructionApprovalPanel evidenceId="ev-1" lifecycle={{ legalHold: false, destructionEligibleAtUtc: null }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve permanent deletion" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Withdraw approval" })).toBeTruthy());
    expect(writes("POST")).toHaveLength(1);
    expect(writes("POST")[0]!.body).toEqual({ confirm: true });
    expect(writes("POST")[0]!.headers["x-proovra-step-up-challenge-id"]).toBe("challenge-1");
    expect(screen.getByRole("status").textContent).toMatch(/Permanent deletion approved/);
  });

  it("withdraws a standing approval; while destruction is claimed no withdrawal is offered", async () => {
    state = offered(APPROVAL);
    render(<OwnerDestructionApprovalPanel evidenceId="ev-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw approval" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve permanent deletion" })).toBeTruthy());
    expect(writes("DELETE")).toHaveLength(1);

    cleanup();
    state = offered(APPROVAL, true);
    render(<OwnerDestructionApprovalPanel evidenceId="ev-1" />);
    await waitFor(() => expect(screen.getByText(/deletion has started/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Withdraw approval" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve permanent deletion" })).toBeNull();
  });

  it("renders nothing where the API offers no owner approval (workspace record, not the owner)", async () => {
    state = { status: 200, body: { offered: false, reason: "WORKSPACE_RECORD_USES_REVIEW" } };
    const a = render(<OwnerDestructionApprovalPanel evidenceId="ev-1" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(a.container.innerHTML).toBe("");
    cleanup();
    state = { status: 404, body: { code: "NOT_FOUND", message: "Not found" } };
    const b = render(<OwnerDestructionApprovalPanel evidenceId="ev-1" />);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(b.container.innerHTML).toBe("");
  });

  it("shows the record's own hold and retention verdicts beside the control", async () => {
    render(
      <OwnerDestructionApprovalPanel
        evidenceId="ev-1"
        lifecycle={{ legalHold: true, destructionEligibleAtUtc: "2034-11-01T00:00:00.000Z" }}
      />,
    );
    await screen.findByRole("button", { name: "Approve permanent deletion" });
    expect(screen.getByText(/legal hold is on this record/)).toBeTruthy();
    expect(screen.getByText(/Earliest permanent deletion under retention/)).toBeTruthy();
  });

  it("says each refusal the API gives, and a cancelled step-up writes nothing", async () => {
    state = offered(APPROVAL);
    writeReply = {
      status: 409,
      body: { code: "DESTRUCTION_IN_PROGRESS", message: "Permanent deletion of this record has already started." },
    };
    render(<OwnerDestructionApprovalPanel evidenceId="ev-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw approval" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/can no longer be withdrawn/));

    cleanup();
    state = offered();
    writeReply = { status: 409, body: { code: "EVIDENCE_NOT_IN_TRASH", message: "Move this record to the trash first." } };
    render(<OwnerDestructionApprovalPanel evidenceId="ev-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve permanent deletion" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/no longer in the trash/));

    cleanup();
    writeReply = { status: 409, body: { code: "DESTRUCTION_REVIEW_REQUIRED", message: "x" } };
    render(<OwnerDestructionApprovalPanel evidenceId="ev-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve permanent deletion" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/workspace's destruction review/));

    cleanup();
    const before = writes("POST").length;
    gates.cancelStepUp = true;
    render(<OwnerDestructionApprovalPanel evidenceId="ev-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve permanent deletion" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Approve permanent deletion" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(writes("POST").length).toBe(before);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a declined confirmation approves nothing", async () => {
    gates.confirm = false;
    render(<OwnerDestructionApprovalPanel evidenceId="ev-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve permanent deletion" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(writes("POST")).toHaveLength(0);
  });
});
