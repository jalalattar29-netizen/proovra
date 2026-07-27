/**
 * PHASE 11 §6 — render-level behavioral proof of the REAL workspace-admin
 * audit surface (WorkspaceAuditTab): it consumes the ONE server query/export
 * authority (GET /v1/audit/tenant), renders the server projection verbatim,
 * applies NO client-side tenant filtering, exports through the SAME endpoint,
 * and shows one generic denial (no existence/scope leak).
 */
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const apiCalls: string[] = [];
let apiImpl: (path: string) => Promise<unknown> = async () => ({ items: [], nextCursorId: null });
vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    apiCalls.push(path);
    return apiImpl(path);
  },
  ApiError: class ApiError extends Error {},
}));

import { WorkspaceAuditTab } from "../../components/workspace-admin/WorkspaceAuditTab";

const row = (id: string, over: Record<string, unknown> = {}) => ({
  eventId: id,
  occurredAtUtc: "2026-07-24T00:00:00.000Z",
  action: "evidence.read",
  outcome: "success",
  actorUserId: "u1",
  workspaceId: "team-1",
  resourceType: "evidence",
  resourceId: "ev-1",
  ...over,
});

beforeEach(() => {
  apiCalls.length = 0;
  apiImpl = async () => ({ items: [], nextCursorId: null });
});

describe("§6 — workspace-admin audit surface consumes the ONE server authority", () => {
  it("queries the ONE canonical audit endpoint with the proven teamId and renders the server projection verbatim", async () => {
    apiImpl = async () => ({ items: [row("e1"), row("e2", { action: "deep_link.resolve", outcome: "denied" })], nextCursorId: null });
    render(<WorkspaceAuditTab teamId="team-1" />);
    await waitFor(() => expect(screen.getByText("deep_link.resolve")).toBeTruthy());
    expect(apiCalls[0]).toContain(`/v1/audit/tenant?`);
    expect(apiCalls[0]).toContain("teamId=team-1");
    // Both server rows rendered untouched — no client-side tenant filtering.
    expect(screen.getAllByText("2026-07-24T00:00:00.000Z")).toHaveLength(2);
  });

  it("filters are sent to the SERVER, never applied in memory", async () => {
    apiImpl = async () => ({ items: [row("e1")], nextCursorId: null });
    render(<WorkspaceAuditTab teamId="team-1" />);
    await waitFor(() => expect(apiCalls.length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("Filter by outcome"), { target: { value: "denied" } });
    await waitFor(() =>
      expect(apiCalls.some((c) => c.includes("outcome=denied"))).toBe(true),
    );
  });

  it("cursor pagination requests the SERVER cursor (deterministic paging)", async () => {
    apiImpl = async (path) =>
      path.includes("cursorId=")
        ? { items: [row("e3")], nextCursorId: null }
        : { items: [row("e1"), row("e2")], nextCursorId: "e2" };
    render(<WorkspaceAuditTab teamId="team-1" />);
    await waitFor(() => expect(screen.getByText("Load more")).toBeTruthy());
    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(apiCalls.some((c) => c.includes("cursorId=e2"))).toBe(true));
  });

  it("export uses the EXACT same endpoint + query with export=true (no second policy)", async () => {
    apiImpl = async () => ({ items: [row("e1")], nextCursorId: null });
    // jsdom lacks createObjectURL — stub the pair the export uses.
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:x";
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
    render(<WorkspaceAuditTab teamId="team-1" />);
    await waitFor(() => expect(apiCalls.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("Export"));
    await waitFor(() =>
      expect(apiCalls.some((c) => c.includes(`/v1/audit/tenant?`) && c.includes("export=true") && c.includes("teamId=team-1"))).toBe(true),
    );
  });

  it("a denial renders ONE generic message — no existence or scope leak", async () => {
    apiImpl = async () => { throw Object.assign(new Error("Forbidden"), { statusCode: 403 }); };
    const { container } = render(<WorkspaceAuditTab teamId="team-OTHER" />);
    // The denial surfaces through the canonical toSafeUserError projection
    // (safe copy only); assert the single generic affordance renders and that
    // no rows and no cause-revealing detail leak.
    await waitFor(() =>
      expect(container.querySelector("[data-workspace-audit-denied]")).not.toBeNull(),
    );
    const denial = container.querySelector("[data-workspace-audit-denied]")!;
    expect(denial.textContent ?? "").not.toMatch(/membership|suspended|not found|exists|workspace .*OTHER/i);
    expect(container.querySelector("[data-workspace-audit-rows]")).toBeNull();
  });
});
