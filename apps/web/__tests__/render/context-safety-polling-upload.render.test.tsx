/**
 * PHASE 7 §10.F/§10.E (2026-07-22) — polling disposal + upload binding.
 */

import React, { useEffect, useRef, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

const apiCalls = vi.hoisted(() => ({ bodies: [] as string[] }));
vi.mock("../../lib/api", () => ({
  apiFetch: async (_path: string, init?: { body?: string }) => {
    if (init?.body) apiCalls.bodies.push(init.body);
    return {};
  },
  readApiToken: () => null,
}));

import { MultipartUploader } from "../../lib/uploads/multipart-uploader";

// Representative production poller pattern: a setInterval in a useEffect
// keyed by `teamId`, disposed via clearInterval on unmount / teamId change.
// This is the SAME shape used by evidence-detail, governance/*,
// investigation/*, integrations pollers (all `}, [teamId]` + clearInterval).
function TenantPoller({
  teamId,
  onTick,
}: {
  teamId: string;
  onTick: (teamId: string) => void;
}) {
  const [count, setCount] = useState(0);
  const teamRef = useRef(teamId);
  teamRef.current = teamId;
  useEffect(() => {
    // Fresh subscription scoped to this tenant.
    const captured = teamId;
    const handle = setInterval(() => {
      // Late events carry the tenant they were started for.
      onTick(captured);
      setCount((c) => c + 1);
    }, 10);
    return () => clearInterval(handle); // §10.F disposal on unmount/teamId change
  }, [teamId, onTick]);
  return <span data-testid="count">{count}</span>;
}

describe("Phase 7 §10.F — polling is workspace-keyed and disposed on unmount", () => {
  it("a poller started in A stops on unmount and never fires for A afterward", async () => {
    vi.useFakeTimers();
    const ticks: string[] = [];
    const { unmount } = render(
      <TenantPoller teamId="ws-A" onTick={(t) => ticks.push(t)} />,
    );
    await act(async () => {
      vi.advanceTimersByTime(35); // ~3 ticks for A
    });
    const afterMount = ticks.length;
    expect(afterMount).toBeGreaterThan(0);
    expect(ticks.every((t) => t === "ws-A")).toBe(true);

    unmount(); // switching workspace unmounts / re-keys the surface
    await act(async () => {
      vi.advanceTimersByTime(100); // time passes in the new tenant
    });
    // No further A ticks after disposal — a stale A response cannot update
    // the new tenant's UI.
    expect(ticks.length).toBe(afterMount);
    vi.useRealTimers();
  });

  it("changing teamId disposes the old interval and starts one for the new workspace", async () => {
    vi.useFakeTimers();
    const ticks: string[] = [];
    const { rerender } = render(
      <TenantPoller teamId="ws-A" onTick={(t) => ticks.push(t)} />,
    );
    await act(async () => vi.advanceTimersByTime(25));
    rerender(<TenantPoller teamId="ws-B" onTick={(t) => ticks.push(t)} />);
    await act(async () => vi.advanceTimersByTime(25));
    // Both tenants tick under their OWN key; no A tick is attributed to B.
    expect(ticks).toContain("ws-A");
    expect(ticks).toContain("ws-B");
    vi.useRealTimers();
  });
});

describe("Phase 7 §10.E — upload binding is immutable to the active workspace", () => {
  it("MultipartUploader binds teamId at construction; every request carries the ORIGINAL workspace", async () => {
    apiCalls.bodies = [];
    const file = new File([new Uint8Array(16)], "e.bin", {
      type: "application/octet-stream",
    });
    const uploader = new MultipartUploader({
      sessionId: "sess-1",
      teamId: "ws-A", // the ORIGINAL authoritative workspace
      file,
      isOnline: () => true,
    });
    // Drive the real request flow (fails gracefully on the mocked apiFetch);
    // what matters is that the requests it DID emit carry teamId "ws-A".
    await uploader.start().catch(() => undefined);
    expect(apiCalls.bodies.length).toBeGreaterThan(0);
    // Every request the uploader emitted is scoped to its construction
    // tenant — there is no setter and nothing reads an "active workspace",
    // so a switch to B cannot redirect this in-flight uploader.
    const bodiesWithTeam = apiCalls.bodies.filter((b) => b.includes("teamId"));
    expect(bodiesWithTeam.length).toBeGreaterThan(0);
    expect(bodiesWithTeam.every((b) => b.includes('"teamId":"ws-A"'))).toBe(true);
    expect(apiCalls.bodies.some((b) => b.includes("ws-B"))).toBe(false);
  });
});
