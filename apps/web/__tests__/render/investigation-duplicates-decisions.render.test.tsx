/**
 * PRO-K1C-05 — the duplicate-review decision controls follow the route's
 * authority. POST /v1/graph/duplicates/:edgeId/decision authorises
 * `evidence.update_metadata` (every role but VIEWER), which the envelope
 * projects as EVIDENCE_MANAGE. Real `apiFetch` over a stubbed network.
 *
 * Acceptance: a confirmed pair reads back "Confirmed duplicate by you" after a
 * reload; a VIEWER sees no decision buttons; a forced POST that the server
 * refuses shows the refusal on the row; the derivative decision has a control.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ctx = vi.hoisted(() => ({ canManage: true, userId: "u-me" }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/navigation/healthDestination", () => ({ useHealthDestination: () => null }));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform-context")>()),
  useTeamId: () => "11111111-1111-4111-8111-111111111111",
  useCan: (key: string) => (key === "EVIDENCE_MANAGE" ? ctx.canManage : false),
  useAccount: () => ({ userId: ctx.userId }),
}));

import DuplicatesReviewPage from "../../app/(app)/investigation/duplicates/page";

const exactId = "22222222-2222-4222-8222-222222222222";
const similarId = "33333333-3333-4333-8333-333333333333";
const evA = "44444444-4444-4444-8444-444444444441";
const evB = "44444444-4444-4444-8444-444444444442";

type Reply = { status: number; body: unknown };
let listBody: { edges: unknown[]; truncated: boolean };
let decisionReply: Reply;
const fetchMock = vi.fn();

function edge(edgeId: string, edgeType: string, decision: unknown = null) {
  return {
    edgeId,
    edgeType,
    confidence: "HIGH",
    safeSummary: null,
    sourceEvidenceId: evA,
    targetEvidenceId: evB,
    observedAtUtc: "2026-11-01T10:00:00.000Z",
    decision,
  };
}

function json(reply: Reply): Response {
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  ctx.canManage = true;
  ctx.userId = "u-me";
  listBody = { edges: [edge(exactId, "SAME_HASH_AS"), edge(similarId, "SIMILAR_TO")], truncated: false };
  decisionReply = { status: 200, body: { id: "d1", decision: "CONFIRMED", decidedAt: "2026-11-02T10:00:00.000Z" } };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("/v1/graph/duplicates?") && method === "GET") return json({ status: 200, body: listBody });
    if (/\/v1\/graph\/duplicates\/[^/]+\/decision$/.test(u) && method === "POST") return json(decisionReply);
    if (u.includes("/v1/intelligence/capabilities")) return json({ status: 200, body: { producerModes: [] } });
    return json({ status: 200, body: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const decisionPosts = () =>
  fetchMock.mock.calls.filter(([u, init]) => /\/decision$/.test(String(u)) && (init as RequestInit)?.method === "POST");

describe("PRO-K1C-05 duplicate decisions follow the route's authority", () => {
  it("a VIEWER sees the recorded decision but no decision controls", async () => {
    ctx.canManage = false;
    listBody = {
      edges: [edge(exactId, "SAME_HASH_AS", { decision: "CONFIRMED", decidedByUserId: "u-other", decidedAt: "2026-11-02T10:00:00.000Z" })],
      truncated: false,
    };
    render(<DuplicatesReviewPage />);
    await screen.findByText(/Confirmed duplicate by another member/);
    expect(screen.queryByRole("button", { name: "Confirm duplicate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark as derivative" })).toBeNull();
    // The read surfaces stay.
    expect(screen.getAllByRole("link", { name: "Open A" }).length).toBeGreaterThan(0);
  });

  it("an authorised member confirms a pair and the row reads back the decision by them after reload", async () => {
    const view = render(<DuplicatesReviewPage />);
    const confirms = await screen.findAllByRole("button", { name: "Confirm duplicate" });
    fireEvent.click(confirms[0]);
    await screen.findByText("Decision recorded.");
    expect(decisionPosts()).toHaveLength(1);
    expect(JSON.parse(String((decisionPosts()[0][1] as RequestInit).body))).toMatchObject({ decision: "CONFIRMED" });
    expect(screen.getByText(/Confirmed duplicate by you/)).toBeTruthy();

    // Reload: the decision comes back from the list read.
    view.unmount();
    listBody = {
      edges: [edge(exactId, "SAME_HASH_AS", { decision: "CONFIRMED", decidedByUserId: "u-me", decidedAt: "2026-11-02T10:00:00.000Z" })],
      truncated: false,
    };
    render(<DuplicatesReviewPage />);
    await screen.findByText(/Confirmed duplicate by you/);
  });

  it("offers the derivative decision on a similarity relationship, not on an exact byte copy", async () => {
    decisionReply = { status: 200, body: { id: "d2", decision: "MARKED_DERIVATIVE", decidedAt: "2026-11-02T10:00:00.000Z" } };
    render(<DuplicatesReviewPage />);
    const marks = await screen.findAllByRole("button", { name: "Mark as derivative" });
    expect(marks).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Confirm duplicate" })).toHaveLength(2);
    fireEvent.click(marks[0]);
    await screen.findByText(/Marked as derivative by you/);
    const [url, init] = decisionPosts()[0];
    expect(String(url)).toContain(`/v1/graph/duplicates/${similarId}/decision`);
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ decision: "MARKED_DERIVATIVE" });
  });

  it("a refused decision shows the refusal on the row and records nothing", async () => {
    decisionReply = { status: 403, body: { error: { code: "permission_denied", message: "Not permitted.", requestId: "r1" } } };
    render(<DuplicatesReviewPage />);
    const confirms = await screen.findAllByRole("button", { name: "Confirm duplicate" });
    fireEvent.click(confirms[0]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").not.toBe("");
    expect(alert.textContent).not.toContain("Decision recorded");
    await waitFor(() => expect(screen.queryByText(/Confirmed duplicate by/)).toBeNull());
  });
});
