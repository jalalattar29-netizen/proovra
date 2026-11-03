/**
 * GOV-008 and RT-012 — the destruction request page speaks the API's contract.
 *
 * It posted `{ evidenceId, reason: null }` to a route requiring `evidenceIds`, a
 * reason and approvers, so every submit was a 400; it offered Approve for a PENDING
 * state the API never returns; and it asked for a pasted UUID. The bodies below are
 * the shape the API sends, through the real `apiFetch` over a stubbed network.
 */
import { chooseListbox } from "./_listbox";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform-context")>()),
  useTeamId: () => "11111111-1111-4111-8111-111111111111",
}));

import DestructionPage from "../../app/(app)/evidence-lifecycle/destruction/page";

const REQUEST = "22222222-2222-4222-8222-222222222222";
const EVIDENCE = "33333333-3333-4333-8333-333333333333";
const APPROVER = "44444444-4444-4444-8444-444444444444";
const ISO = "2026-10-01T10:00:00.000Z";

function requestRow(state: string, certificate: unknown = null) {
  return {
    id: REQUEST,
    teamId: "11111111-1111-4111-8111-111111111111",
    state,
    evidenceIds: [EVIDENCE],
    reason: "retention over",
    policyRef: null,
    requestedByUserId: "u",
    approverUserIds: [APPROVER],
    executedAtUtc: null,
    certifiedAtUtc: null,
    createdAt: ISO,
    certificate,
  };
}

let rows: unknown[] = [];
let approvers: unknown[] = [{ userId: APPROVER, label: "Second Person" }];
const fetchMock = vi.fn();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const posts = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body ?? "{}")) }));

beforeEach(() => {
  rows = [];
  approvers = [{ userId: APPROVER, label: "Second Person" }];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "POST") return json({ requestId: REQUEST }, 201);
    if (path.includes("/v1/lifecycle/destruction/eligible-approvers")) return json({ approvers });
    if (path.includes("/v1/lifecycle/destruction/requests")) return json({ requests: rows });
    if (path.includes("/v1/evidence?")) {
      expect(path).toContain("scope=trash");
      return json({ items: [{ id: EVIDENCE, title: "Accident photo" }] });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("destruction request page", () => {
  it("creates with what the API requires, picking the record by name and a second person as approver", async () => {
    render(<DestructionPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Accident photo" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "retention over" } });
    chooseListbox(await screen.findByLabelText("Approver"), APPROVER);
    await waitFor(() =>
      expect(within(screen.getByLabelText("Approver")).getByText("Second Person")).toBeTruthy(),
    );
    chooseListbox(screen.getByLabelText("Approver"), APPROVER);
    fireEvent.click(screen.getByRole("button", { name: "Create Request" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toEqual({
      evidenceIds: [EVIDENCE],
      reason: "retention over",
      requiredApproverUserIds: [APPROVER],
    });
  });

  it("says nobody can approve when nobody else can, and does not submit", async () => {
    approvers = [];
    render(<DestructionPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Accident photo" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "retention over" } });
    const create = await screen.findByRole("button", { name: "Create Request" });
    fireEvent.click(create);
    expect(posts()).toHaveLength(0);
  });

  it("offers Approve and Reject on the state the API actually returns", async () => {
    rows = [requestRow("REQUESTED")];
    render(<DestructionPage />);
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.getByText("1 record")).toBeTruthy();
  });

  it("offers Execute on APPROVED and shows what a certificate actually verified", async () => {
    rows = [
      requestRow("APPROVED"),
      {
        ...requestRow("CERTIFIED", {
          id: "c",
          requestId: "r",
          evidenceCount: 1,
          executedAtUtc: ISO,
          certifiedAtUtc: ISO,
          approvalChainUserIds: [],
          certificateHash: "a".repeat(64),
          certificateUri: null,
        }),
        id: "55555555-5555-4555-8555-555555555555",
      },
    ];
    render(<DestructionPage />);
    expect(await screen.findByRole("button", { name: "Execute" })).toBeTruthy();
    expect(screen.getByText(/1 record verified destroyed/)).toBeTruthy();
  });
});
