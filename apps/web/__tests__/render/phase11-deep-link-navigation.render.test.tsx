/**
 * PHASE 11 §4 — render-level behavioral proof of the ONE web deep-link
 * chokepoint (`useDeepLinkNavigation`) and its real product consumer
 * (NotificationBell destination rows).
 *
 * The four tenant denial CAUSES (wrong workspace / inactive membership /
 * suspended organization / missing capability) are, BY DESIGN, one
 * indistinguishable anti-enumeration 404 at the server (proven per-cause in
 * services/api phase-11 deep-link tests). Here we prove the client handles
 * that single denial shape correctly: no navigation, no context mutation,
 * one generic affordance, no existence leak.
 */
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";

const pushes: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (p: string) => pushes.push(p), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/inbox",
  useSearchParams: () => new URLSearchParams(),
}));

// The API transport — resolveDeepLinkPath drives POST /v1/deep-link/resolve
// through this. Behavior is scripted per-test.
const apiCalls: Array<{ path: string; init?: RequestInit }> = [];
let apiImpl: (path: string) => Promise<unknown> = async () => null;
vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    apiCalls.push({ path, init });
    return apiImpl(path);
  },
  ApiError: class ApiError extends Error {},
}));

import { useDeepLinkNavigation, type DeepLinkOpenResult } from "../../lib/navigation/useDeepLinkNavigation";
import { registerDirtyWork, clearAllDirtyWork } from "../../lib/platform-context/dirtyWorkRegistry";

function Harness({ href, release, onResult }: { href: string; release?: boolean; onResult: (r: DeepLinkOpenResult) => void }) {
  const { open } = useDeepLinkNavigation();
  return (
    <button onClick={() => void open(href, { releaseDirtyWork: release }).then(onResult)}>
      go
    </button>
  );
}

async function openVia(href: string, release?: boolean): Promise<DeepLinkOpenResult> {
  let result: DeepLinkOpenResult | null = null;
  render(<Harness href={href} release={release} onResult={(r) => (result = r)} />);
  fireEvent.click(screen.getByText("go"));
  await waitFor(() => expect(result).not.toBeNull());
  return result!;
}

beforeEach(() => {
  pushes.length = 0;
  apiCalls.length = 0;
  clearAllDirtyWork();
  apiImpl = async () => null;
});

describe("§4 chokepoint — server approval precedes every navigation", () => {
  it("a valid resource link opens: server resolves, THEN router.push with the canonical path", async () => {
    apiImpl = async () => ({ ok: true, workspaceId: "team-1", resourceType: "evidence", resourceId: "ev-1" });
    const r = await openVia("/evidence/ev-1");
    expect(r).toMatchObject({ status: "navigated", path: "/evidence/ev-1" });
    expect(apiCalls.some((c) => c.path === "/v1/deep-link/resolve")).toBe(true);
    expect(pushes).toEqual(["/evidence/ev-1"]);
  });

  it("a server denial (anti-enum 404 — covers mismatch/membership/suspension/capability) navigates NOTHING", async () => {
    apiImpl = async () => { throw new Error("404"); };
    const r = await openVia("/evidence/ev-hidden");
    expect(r).toEqual({ status: "denied" });
    expect(pushes).toEqual([]); // no navigation, no context mutation
  });

  it("no navigation happens BEFORE the server approves (ordering proof)", async () => {
    let resolveApi!: (v: unknown) => void;
    apiImpl = () => new Promise((res) => { resolveApi = res; });
    let result: DeepLinkOpenResult | null = null;
    render(<Harness href="/evidence/ev-1" onResult={(r) => (result = r)} />);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(apiCalls.length).toBe(1));
    expect(pushes).toEqual([]); // resolver in flight → nothing navigated yet
    await act(async () => {
      resolveApi({ ok: true, workspaceId: "t", resourceType: "evidence", resourceId: "ev-1" });
    });
    await waitFor(() => expect(result).not.toBeNull());
    expect(pushes).toEqual(["/evidence/ev-1"]);
  });

  it("dirty work BLOCKS the open (no fetch, no navigation)", async () => {
    registerDirtyWork("evidence annotation draft");
    const r = await openVia("/evidence/ev-1");
    expect(r).toMatchObject({ status: "blocked_dirty", labels: ["evidence annotation draft"] });
    expect(apiCalls).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("explicit release proceeds through the SAME server authority", async () => {
    registerDirtyWork("evidence annotation draft");
    apiImpl = async () => ({ ok: true, workspaceId: "t", resourceType: "evidence", resourceId: "ev-1" });
    const r = await openVia("/evidence/ev-1", true);
    expect(r).toMatchObject({ status: "navigated" });
    expect(apiCalls.some((c) => c.path === "/v1/deep-link/resolve")).toBe(true);
  });

  it("a STALE resolver response (superseded by a newer open) is discarded", async () => {
    const gates: Array<(v: unknown) => void> = [];
    apiImpl = () => new Promise((res) => gates.push(res));
    const results: DeepLinkOpenResult[] = [];
    function TwoOpens() {
      const { open } = useDeepLinkNavigation();
      return (
        <button
          onClick={() => {
            void open("/evidence/ev-OLD").then((r) => results.push(r));
            void open("/evidence/ev-NEW").then((r) => results.push(r));
          }}
        >
          both
        </button>
      );
    }
    render(<TwoOpens />);
    fireEvent.click(screen.getByText("both"));
    await waitFor(() => expect(gates.length).toBe(2));
    // Resolve the OLD (superseded) request first — it must be DISCARDED.
    await act(async () => {
      gates[0]({ ok: true, workspaceId: "t", resourceType: "evidence", resourceId: "ev-OLD" });
    });
    await act(async () => {
      gates[1]({ ok: true, workspaceId: "t", resourceType: "evidence", resourceId: "ev-NEW" });
    });
    await waitFor(() => expect(results.length).toBe(2));
    expect(results).toContainEqual({ status: "stale" });
    expect(pushes).toEqual(["/evidence/ev-NEW"]); // ONLY the newest navigates
  });

  it("external / protocol-relative / scheme destinations are REFUSED (no open redirect)", async () => {
    for (const evil of ["https://evil.example/x", "//evil.example/x", "javascript:alert(1)"]) {
      const r = await openVia(evil);
      expect(r).toEqual({ status: "rejected_external" });
      cleanup(); // one harness at a time
    }
    expect(apiCalls).toEqual([]);
    expect(pushes).toEqual([]);
  });
});

describe("§4 real consumer — NotificationBell destination rows", () => {
  async function renderBellWithItem() {
    const { NotificationBell } = await import("../../components/app-shell-v2/NotificationBell");
    render(<NotificationBell />);
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    await waitFor(() => expect(screen.getByText("Suspicious upload flagged")).toBeTruthy());
  }
  const bellItem = {
    items: [{
      id: "n1", itemKey: "k1", category: "security_event_high", tone: "high", priority: "P2",
      title: "Suspicious upload flagged", body: "Review the flagged evidence.",
      href: "/evidence/ev-77", occurredAt: new Date().toISOString(), canDismiss: false, context: {},
    }],
    pagination: { totalEstimate: 1, totalIsExact: true },
  };

  it("clicking a notification destination goes through the server resolver, not the raw href", async () => {
    apiImpl = async (path) => {
      if (path.startsWith("/v1/me/inbox/summary")) return { unread: 1, critical: 0, high: 1, assignedToMe: 0, overdue: 0, hasTruncatedSources: false, degraded: false, generatedAtUtc: "" };
      if (path.startsWith("/v1/me/inbox?")) return bellItem;
      if (path === "/v1/deep-link/resolve") return { ok: true, workspaceId: "team-9", resourceType: "evidence", resourceId: "ev-77" };
      return {};
    };
    await renderBellWithItem();
    fireEvent.click(screen.getByText("Suspicious upload flagged"));
    await waitFor(() => expect(pushes).toEqual(["/evidence/ev-77"]));
    expect(apiCalls.some((c) => c.path === "/v1/deep-link/resolve")).toBe(true);
  });

  it("a denied destination shows ONE generic affordance (anti-enumeration; no existence leak)", async () => {
    apiImpl = async (path) => {
      if (path.startsWith("/v1/me/inbox/summary")) return { unread: 1, critical: 0, high: 1, assignedToMe: 0, overdue: 0, hasTruncatedSources: false, degraded: false, generatedAtUtc: "" };
      if (path.startsWith("/v1/me/inbox?")) return bellItem;
      if (path === "/v1/deep-link/resolve") throw new Error("404");
      return {};
    };
    await renderBellWithItem();
    fireEvent.click(screen.getByText("Suspicious upload flagged"));
    await waitFor(() => expect(screen.getByText("This item is not available.")).toBeTruthy());
    expect(pushes).toEqual([]); // denial navigated nothing
    // The generic message reveals neither existence nor reason.
    expect(screen.queryByText(/not found|forbidden|denied|suspended|membership/i)).toBeNull();
  });
});
