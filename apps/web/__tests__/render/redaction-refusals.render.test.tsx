/**
 * Redaction surfaces state the server's refusals.
 *
 * B5B-F-200  A MEMBER/VIEWER of an Enterprise workspace saw "Loading workspace
 *            summary…" forever, "No redaction projects yet", and
 *            "Refused: POLICY_REJECTED" for every refusal — the components read
 *            `err.denial`, which apiFetch never sets (it carries the flat
 *            { denial } on error.details). A region refused with VERSION_LOCKED
 *            vanished silently.
 * B5B-F-202  The policy console's "Assign to…" sent a null target for
 *            WORKSPACE/CASE/PROJECT, so every non-GLOBAL assignment was refused.
 *
 * Driven with the REAL apiFetch over a stubbed fetch.
 */
import React from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: vi.fn() }) }));
vi.mock("../../components/redaction/PolicyScopePanel", () => ({ PolicyScopePanel: () => null }));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePlatformContext: () => ({ activeWorkspaceId: "ws-ent", state: { name: "READY" }, envelope: null }),
  useOptionalPlatformContext: () => ({ activeWorkspaceId: "ws-ent", state: { name: "READY" }, envelope: null }),
  WorkspaceContextBanner: () => null,
  useWorkspaceContextSafety: () => ({
    runGuarded: async (fn: () => Promise<unknown>, after: (v: unknown) => unknown) => after(await fn()),
  }),
}));

import RedactionProjectsPage from "../../app/(app)/redaction/page";
import PolicyManagementConsolePage from "../../app/(app)/redaction/policy/page";
import { ImageRedactionViewer } from "../../components/redaction/ImageRedactionViewer";

type Reply = { status: number; body: unknown };
let handler: (method: string, path: string, body: unknown) => Reply;
const calls: Array<{ method: string; path: string; body: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path, body });
      const out = handler(method, path, body);
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOT_PERMITTED: Reply = { status: 403, body: { denial: "NOT_PERMITTED" } };

describe("B5B-F-200 — projects page", () => {
  it("a refused read is a permission state, not endless loading or an empty list", async () => {
    handler = (_m, path) => (path.startsWith("/v1/redaction/providers") ? { status: 200, body: { providers: [] } } : NOT_PERMITTED);
    render(<RedactionProjectsPage />);
    await screen.findByText("Redaction is not available to your role");
    expect(screen.queryByText(/Loading workspace summary/)).toBeNull();
    expect(screen.queryByText(/No redaction projects yet/)).toBeNull();
  });

  it("an Open project refusal names the server's denial, not POLICY_REJECTED", async () => {
    handler = (method, path) => {
      if (method === "POST" && path === "/v1/redaction/projects") return NOT_PERMITTED;
      if (path === "/v1/redaction/projects") return { status: 200, body: { projects: [] } };
      if (path === "/v1/redaction/workspace/summary") {
        return { status: 200, body: { summary: { pendingDecisionCount: 0, awaitingApprovalCount: 0, approvedPendingDerivativeCount: 0, publishedCount: 0, rejectedCount: 0 } } };
      }
      return { status: 200, body: { providers: [] } };
    };
    render(<RedactionProjectsPage />);
    const input = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>("[data-redaction-open-evidence]");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.change(input, { target: { value: "00000000-0000-4000-8000-000000000001" } });
    const open = screen.getByRole("button", { name: /open project/i });
    await act(async () => {
      open.click();
    });
    const banner = await waitFor(() => {
      const el = document.querySelector("[data-redaction-banner]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(banner.textContent).not.toContain("POLICY_REJECTED");
    expect(banner.textContent).toMatch(/not permitted/i);
  });

  it("closure 2026-11-21 — choosing Video or Audio says regions and a redacted copy are image/PDF only; Image/PDF show no such note", async () => {
    handler = (_m, path) => {
      if (path === "/v1/redaction/projects") return { status: 200, body: { projects: [] } };
      if (path === "/v1/redaction/workspace/summary") {
        return { status: 200, body: { summary: { pendingDecisionCount: 0, awaitingApprovalCount: 0, approvedPendingDerivativeCount: 0, publishedCount: 0, rejectedCount: 0 } } };
      }
      return { status: 200, body: { providers: [] } };
    };
    render(<RedactionProjectsPage />);
    const note = () => document.querySelector<HTMLElement>("[data-redaction-open-media-unsupported]");
    const trigger = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-redaction-open-artifact]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(note()).toBeNull();
    const choose = async (label: string) => {
      fireEvent.click(trigger);
      const option = await waitFor(() => {
        const o = Array.from(document.querySelectorAll("[role='option']")).find((el) => el.textContent?.trim() === label);
        expect(o, `option "${label}"`).toBeTruthy();
        return o as HTMLElement;
      });
      await act(async () => {
        fireEvent.click(option);
      });
    };
    await choose("Video");
    expect(note()?.textContent).toMatch(/image and PDF records only/);
    expect(note()?.textContent).toMatch(/video project holds review decisions, but no region can be drawn and no redacted copy is produced/);
    await choose("Audio");
    expect(note()?.textContent).toMatch(/audio project/);
    await choose("PDF");
    expect(note()).toBeNull();
  });
});

describe("B5B-F-200 — a refused region is said", () => {
  it("VERSION_LOCKED on region POST shows a notice", async () => {
    // WEB-OLD-API-COMPAT — the record image must be shown before a region can be drawn.
    handler = (method, path) =>
      method === "GET" && path === "/v1/evidence/e1"
        ? { status: 200, body: { evidence: { id: "e1", contentItems: [{ id: "p1", mimeType: "image/png", viewUrl: "https://files.test/photo.png", isPrimary: true }] } } }
        : { status: 409, body: { denial: "VERSION_LOCKED" } };
    render(<ImageRedactionViewer evidenceId="e1" versionId="v1" regions={[]} versionLocked={false} onChanged={() => {}} />);
    const target = document.querySelector("[data-redaction-image-canvas]") as HTMLElement;
    target.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const img = await waitFor(() => {
      const el = document.querySelector<HTMLImageElement>("[data-redaction-image-preview]");
      expect(el).not.toBeNull();
      return el!;
    });
    await act(async () => {
      fireEvent.load(img);
    });
    await act(async () => {
      fireEvent.mouseDown(target, { clientX: 10, clientY: 10 });
    });
    await act(async () => {
      fireEvent.mouseMove(target, { clientX: 50, clientY: 50 });
    });
    await act(async () => {
      fireEvent.mouseUp(target, { clientX: 50, clientY: 50 });
    });
    await waitFor(() => expect(document.querySelector("[data-redaction-region-add-error]")).not.toBeNull());
    expect(document.querySelector("[data-redaction-region-add-error]")!.textContent).toMatch(/no longer a draft/);
  });
});

describe("B5B-F-202 — Assign to… binds every scope it offers", () => {
  it("WORKSPACE sends the active workspace id; CASE/PROJECT are not offered with a null target", async () => {
    const policyId = "11111111-1111-4111-8111-111111111111";
    handler = (method, path) => {
      if (path === "/v1/redaction/policies") return { status: 200, body: { policies: [{ id: policyId, name: "Faces", description: null, createdByUserId: "u", createdAt: "2026-01-01T00:00:00.000Z", archivedAt: null }] } };
      if (path === `/v1/redaction/policies/${policyId}/versions`) {
        return { status: 200, body: { versions: [{ id: "pv-1", versionOrdinal: 1, state: "PUBLISHED", authoredByUserId: "u0000000-0000", approvedByUserId: null, createdAt: "2026-01-01T00:00:00.000Z", submittedAtUtc: null, approvedAtUtc: null, publishedAtUtc: "2026-01-02T00:00:00.000Z", supersededAtUtc: null, rationale: null, document: { schemaVersion: "1", providers: {}, kinds: {}, ruleActions: {}, customRules: [] } }] } };
      }
      if (path === `/v1/redaction/policies/${policyId}/audit`) return { status: 200, body: { audit: [] } };
      if (method === "POST" && path.endsWith("/assignments")) return { status: 200, body: { assignment: { id: "as-1" } } };
      return { status: 200, body: {} };
    };
    render(<PolicyManagementConsolePage />);
    const trigger = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-redaction-policy-assign-scope='pv-1']");
      expect(el).not.toBeNull();
      return el!;
    });
    await act(async () => {
      trigger.click();
    });
    const options = Array.from(document.querySelectorAll("[role='option']")).map((o) => o.textContent?.trim());
    expect(options.join(" ")).not.toMatch(/case|project/i);
    const ws = Array.from(document.querySelectorAll<HTMLElement>("[role='option']")).find((o) => /workspace/i.test(o.textContent ?? ""))!;
    await act(async () => {
      ws.click();
    });
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/assignments"))).toBe(true));
    const post = calls.find((c) => c.method === "POST" && c.path.endsWith("/assignments"))!;
    expect(post.body).toMatchObject({ policyVersionId: "pv-1", scope: "WORKSPACE", scopeTargetId: "ws-ent" });
  });
});

describe("B5B-F-200 — static: no redaction surface reads a property apiFetch never sets", () => {
  it("no `(err as any)?.denial` / `{ denial?: string })?.denial` remains", () => {
    const root = resolve(__dirname, "../..");
    const files = [
      ...readdirSync(join(root, "components/redaction")).map((f) => join(root, "components/redaction", f)),
      join(root, "app/(app)/redaction/page.tsx"),
      join(root, "app/(app)/redaction/policy/page.tsx"),
    ].filter((f) => /\.tsx?$/.test(f));
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/\(err as any\)\?\.denial|\{ denial\?: string \}\)\?\.denial/);
    }
  });
});
