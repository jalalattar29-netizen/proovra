/**
 * Free-user audit 0ea0 — WEB-C1B-BILLING-AI-UI, AI and operations surfaces on
 * the web, over the REAL apiFetch (fetch mocked).
 *
 *   B6-F-42  batch console: one POST on a double submit; a failed start is retried as /process only;
 *            export goes through apiFetch with the workspace header; a refused list is not "No Batch Jobs"
 *   B6-F-45  (cross-lane) the quick run sends no free-typed text and words the 409 refusals
 *   B6-F-48  /intelligence: catalog loaded (disclaimer), refused jobs read is said, quick run defaults to a text
 *            operation, has an in-flight guard, and is withheld from a role without intelligence.run
 *   B6-F-47  a refused evidence-intelligence read is "unavailable", never empty data
 *   B6-F-30  the copilot's reviewer-assignment link only where /review opens
 *   B6-F-27  web parity: a member who cannot manage a shared personal workspace's AI policy is read-only
 *   R2-F-001 Settings → Billing in an organization never shows the viewer's own personal figures
 *   R2-F-005 the storage-drift panel's permission sentence is reachable
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const addToast = vi.fn();
vi.mock("../../components/ui", () => ({
  useToast: () => ({ addToast }),
  Skeleton: () => null,
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true }),
}));
vi.mock("../../app/providers", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/surface/SurfaceGate", () => ({
  SurfaceGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/dashboard/DashboardShell", () => ({
  default: ({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) => (
    <div>
      {action}
      {children}
    </div>
  ),
}));

type Ctx = { envelope: Record<string, unknown> | null; activeWorkspaceId: string | null };
let ctx: Ctx = { envelope: null, activeWorkspaceId: "team-1" };
vi.mock("../../lib/platform-context", () => ({
  useTeamId: () => "team-1",
  useActiveWorkspaceId: () => ctx.activeWorkspaceId,
  usePlatformContext: () => ({ can: () => false, activeWorkspaceId: ctx.activeWorkspaceId, contextGeneration: 0, envelope: ctx.envelope }),
  WorkspaceContextBanner: () => null,
}));
vi.mock("../../lib/platform-context/PlatformContextProvider", () => ({
  useOptionalPlatformContext: () => ctx,
}));

import BatchAnalysisPage from "../../app/(app)/operations/batch-analysis/page";
import IntelligencePage from "../../app/(app)/intelligence/page";
import { BillingSection } from "../../app/(app)/settings/_sections/BillingSection";
import { ImmutableStorageDriftSection } from "../../components/hidden-feature-panels/HiddenFeaturePanels";
import { reviewerAssignmentReachable } from "../../components/ai-copilot/EvidenceCopilotPanel";
import { readEvidenceIntelligence } from "../../lib/api/intelligence";
import { deriveAiSettingsMode } from "../../lib/ai/aiAssistanceView";
import { deriveSettingsUiContext } from "../../lib/settings/settingsUiContext";
import { setActiveWorkspaceId } from "../../lib/api";

type Reply = { status?: number; body?: unknown; text?: string };
type Call = { path: string; method: string; headers: Headers; body: unknown };
let calls: Call[] = [];
let routes: Record<string, (call: Call) => Reply> = {};

beforeEach(() => {
  cleanup();
  calls = [];
  routes = {};
  addToast.mockReset();
  ctx = { envelope: null, activeWorkspaceId: "team-1" };
  setActiveWorkspaceId("team-1");
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const call: Call = {
      path,
      method: (init.method ?? "GET").toUpperCase(),
      headers: new Headers(init.headers),
      body: typeof init.body === "string" && init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const key = Object.keys(routes)
      .filter((k) => `${call.method} ${path}`.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const reply = key ? routes[key](call) : { status: 404, body: { error: { code: "not_found" } } };
    if (reply.text !== undefined) {
      return new Response(reply.text, { status: reply.status ?? 200, headers: { "content-type": "text/csv" } });
    }
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);

describe("B6-F-42: batch console", () => {
  async function openForm() {
    render(<BatchAnalysisPage />);
    await flush();
    fireEvent.click(screen.getByText("+ New Batch Job"));
    fireEvent.change(screen.getByPlaceholderText("e.g., Q1 2026 Review"), { target: { value: "Q4" } });
    fireEvent.change(screen.getByPlaceholderText(/abc-123/), { target: { value: "ev-1\nev-2" } });
  }

  it("a double submit creates ONE job, and a retry after a failed start only starts it", async () => {
    let processFails = true;
    routes["GET /v1/batch-analysis"] = () => ({ body: { data: [] } });
    routes["POST /v1/batch-analysis/job-1/process"] = () =>
      processFails ? { status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: "busy" } } } : { body: { ok: true } };
    routes["POST /v1/batch-analysis"] = () => ({ body: { data: { id: "job-1" } } });
    await openForm();
    const form = q<HTMLFormElement>("form")!;
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/batch-analysis/job-1/process")).toBe(true));
    await flush();
    expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/batch-analysis").length).toBe(1);
    expect(addToast.mock.calls.some(([m]) => /created but did not start/.test(String(m)))).toBe(true);

    processFails = false;
    await act(async () => {
      fireEvent.submit(q<HTMLFormElement>("form")!);
    });
    await waitFor(() => expect(addToast.mock.calls.some(([m]) => m === "Batch job created and processing started")).toBe(true));
    expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/batch-analysis").length).toBe(1);
    expect(calls.filter((c) => c.path === "/v1/batch-analysis/job-1/process").length).toBe(2);
  });

  it("export carries the workspace on screen", async () => {
    routes["GET /v1/batch-analysis/job-9/export"] = () => ({ text: "id,status\n1,ok\n" });
    routes["GET /v1/batch-analysis"] = () => ({
      body: { data: [{ id: "job-9", name: "Done", status: "completed", totalItems: 1, processedItems: 1, failedItems: 0, createdAt: "2026-11-01T00:00:00Z", progress: 100 }] },
    });
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(window.URL, { createObjectURL, revokeObjectURL: vi.fn() });
    render(<BatchAnalysisPage />);
    await waitFor(() => expect(screen.getByText("Export CSV")).toBeTruthy());
    fireEvent.click(screen.getByText("Export CSV"));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/batch-analysis/job-9/export")).toBe(true));
    const exportCall = calls.find((c) => c.path === "/v1/batch-analysis/job-9/export")!;
    expect(exportCall.headers.get("x-proovra-workspace-id")).toBe("team-1");
  });

  it("a refused list says the surface is not included, never 'No Batch Jobs'", async () => {
    routes["GET /v1/batch-analysis"] = () => ({
      status: 403,
      body: { error: { code: "ENTITLEMENT_REQUIRED", message: "Not included", details: { entitlement: "PROFESSIONAL_SURFACES" } } },
    });
    render(<BatchAnalysisPage />);
    await waitFor(() => expect(q("[data-batch-list-state]")).not.toBeNull());
    expect(q("[data-batch-list-state]")!.getAttribute("data-batch-list-state")).toBe("not_included");
    expect(screen.queryByText("No Batch Jobs")).toBeNull();
  });

  it("a failed list read offers a retry and is not an empty list", async () => {
    routes["GET /v1/batch-analysis"] = () => ({ status: 500, body: { error: { code: "INTERNAL", message: "x" } } });
    render(<BatchAnalysisPage />);
    await waitFor(() => expect(q("[data-batch-list-state='failed']")).not.toBeNull());
    expect(screen.queryByText("No Batch Jobs")).toBeNull();
  });
});

describe("B6-F-48 / B6-F-45: /intelligence", () => {
  function common() {
    routes["GET /v1/intelligence/catalogs"] = () => ({ body: { jobKinds: ["OCR"], jobStatuses: ["QUEUED", "COMPLETED"], disclaimer: "Advisory only: no claim of authenticity." } });
    routes["GET /v1/intelligence/providers/health"] = () => ({ body: { providers: [] } });
    routes["GET /v1/intelligence/providers/usage"] = () => ({ body: { summary: [] } });
    routes["GET /v1/intelligence/providers/budgets"] = () => ({ body: { budgets: [] } });
  }

  it("loads the catalog disclaimer and says a refused jobs read instead of Loading… / No jobs", async () => {
    common();
    routes["GET /v1/intelligence/jobs"] = () => ({ status: 403, body: { error: { code: "permission_denied" } } });
    render(<IntelligencePage />);
    await waitFor(() => expect(screen.getByText("Advisory only: no claim of authenticity.")).toBeTruthy());
    await waitFor(() => expect(q("[data-intelligence-providers-error='denied']")).not.toBeNull());
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByText("No extraction jobs yet")).toBeNull();
  });

  it("the quick run sends no free text, defaults to a text operation, runs once, and words EVIDENCE_TEXT_UNVERIFIED", async () => {
    common();
    ctx = { envelope: { workspace: { id: "team-1", membership: { role: "MEMBER" } } }, activeWorkspaceId: "team-1" };
    routes["GET /v1/intelligence/jobs"] = () => ({ body: { jobs: [], providers: { ocr: "noop", transcript: "noop", semanticEnabled: false } } });
    routes["POST /v1/intelligence/evidence/"] = () => ({ status: 409, body: { error: { code: "EVIDENCE_TEXT_UNVERIFIED", message: "x" } } });
    render(<IntelligencePage />);
    await flush();
    expect(q("[data-intelligence-run-text]")).toBeNull();
    fireEvent.change(q<HTMLInputElement>("[data-intelligence-run-evidence-id]")!, { target: { value: "11111111-1111-1111-1111-111111111111" } });
    const submit = q<HTMLButtonElement>("[data-intelligence-run-submit]")!;
    await act(async () => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    await waitFor(() => expect(q("[data-intelligence-banner]")).not.toBeNull());
    const runs = calls.filter((c) => c.method === "POST" && c.path.endsWith("/run/text"));
    expect(runs.length).toBe(1);
    expect(runs[0].body).toEqual({ provider: "AZURE_DOCUMENT_INTELLIGENCE", operation: "EXTRACT_ENTITIES" });
    expect(q("[data-intelligence-banner]")!.textContent).toMatch(/no extracted text yet/);
  });

  it("a VIEWER is not offered a run the server refuses", async () => {
    common();
    ctx = { envelope: { workspace: { id: "team-1", membership: { role: "VIEWER" } } }, activeWorkspaceId: "team-1" };
    routes["GET /v1/intelligence/jobs"] = () => ({ body: { jobs: [], providers: { ocr: "noop", transcript: "noop", semanticEnabled: false } } });
    render(<IntelligencePage />);
    await flush();
    expect(q("[data-intelligence-run-unavailable]")).not.toBeNull();
    expect(q<HTMLButtonElement>("[data-intelligence-run-submit]")!.disabled).toBe(true);
  });
});

describe("B6-F-47: a refused intelligence read is not empty data", () => {
  it("403 → unavailable; 200 → the data", async () => {
    routes["GET /v1/intelligence/evidence/ev-1"] = () => ({ status: 403, body: { error: { code: "permission_denied" } } });
    expect(await readEvidenceIntelligence("ev-1", "team-1")).toEqual({ kind: "unavailable" });
    routes["GET /v1/intelligence/evidence/ev-1"] = () => ({ body: { entities: [{ id: "e" }], extractedTexts: [], similarities: [], disclaimer: "d" } });
    const ok = await readEvidenceIntelligence("ev-1", "team-1");
    expect(ok.kind).toBe("ok");
    routes["GET /v1/intelligence/evidence/ev-1"] = () => ({ status: 503, body: { error: { code: "down" } } });
    expect(await readEvidenceIntelligence("ev-1", "team-1")).toEqual({ kind: "failed" });
  });
});

describe("B6-F-30: the copilot reviewer link", () => {
  it("only where reviewer operations are included AND the actor may open /review", () => {
    expect(reviewerAssignmentReachable({ capabilities: { REVIEWER_OPS_VIEW: false }, planFeatures: { reviewerOperationsIncluded: false } })).toBe(false);
    expect(reviewerAssignmentReachable({ capabilities: { REVIEWER_OPS_VIEW: true }, planFeatures: { reviewerOperationsIncluded: false } })).toBe(false);
    expect(reviewerAssignmentReachable(null)).toBe(false);
    expect(reviewerAssignmentReachable({ capabilities: { REVIEWER_OPS_VIEW: true }, planFeatures: { reviewerOperationsIncluded: true } })).toBe(true);
  });
});

describe("B6-F-27: web parity", () => {
  it("a member of a shared personal workspace who cannot manage it is read-only", () => {
    expect(deriveAiSettingsMode({ workspaceKind: "PERSONAL", monthlyAllowance: 500, canManageWorkspaceAiPolicy: false })).toBe("personal-readonly");
    expect(deriveAiSettingsMode({ workspaceKind: "PERSONAL", monthlyAllowance: 500, canManageWorkspaceAiPolicy: true })).toBe("personal-assistance");
  });
});

describe("R2-F-001: Settings → Billing", () => {
  const baseInput = {
    accountPlan: "FREE",
    canManageBilling: false,
    canManageWorkspaceSettings: false,
    isEnterpriseWorkspace: false,
    organizations: [],
    planFeatures: null,
  };

  it("a shared personal workspace is named and planned as the server says, with no billing action", () => {
    const ui = deriveSettingsUiContext({
      ...baseInput,
      activeSpace: { type: "PERSONAL", id: "s1", displayName: "Dana's workspace", shared: true },
      workspacePlan: "PRO",
    });
    expect(ui.activeWorkspaceName).toBe("Dana's workspace");
    expect(ui.billing.displayPlan).toBe("PRO");
    expect(ui.billing.billingHref).toBeNull();
  });

  it("a Free member of a paid organization sees no personal storage, renewal or seats", async () => {
    ctx = {
      envelope: {
        activeSpace: { type: "ORGANIZATION", id: "org-ws", displayName: "Acme", roleLabel: "MEMBER", plan: "TEAM" },
        contextOptions: { activeContext: { kind: "ORGANIZATION", organizationId: "org-1", workspaceId: "org-ws" } },
      },
      activeWorkspaceId: "org-ws",
    };
    routes["GET /v1/billing/accounts/PERSONAL/user-1"] = () => ({
      body: {
        plan: { currentPeriodEndUtc: "2026-12-01T00:00:00Z" },
        usage: { storage: { state: "MEASURED", usedLabel: "200 MB", limitLabel: "250 MB" } },
        collaboration: { seats: { used: 1, limit: 1 } },
      },
    });
    routes["GET /v1/billing/accounts"] = () => ({ body: { accounts: [{ type: "PERSONAL", id: "user-1", displayName: "Me", capabilities: [] }] } });
    const ui = deriveSettingsUiContext({
      ...baseInput,
      activeSpace: { type: "ORGANIZATION", id: "org-ws", displayName: "Acme" },
      workspacePlan: "TEAM",
    });
    render(<BillingSection ui={ui} />);
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/billing/accounts")).toBe(true));
    await flush();
    await flush();
    expect(calls.some((c) => c.path.startsWith("/v1/billing/accounts/PERSONAL/"))).toBe(false);
    const text = q("[data-cc-billing-section]")!.textContent ?? "";
    expect(text).not.toMatch(/250 MB/);
    expect(text).not.toMatch(/Renews/);
    expect(text).toMatch(/TEAM/);
    expect(text).not.toMatch(/FREE/);
  });
});

describe("R2-F-005: storage drift permission copy", () => {
  it("a 403 from the real apiFetch shows the permission sentence", async () => {
    routes["GET /v1/governance/immutable-storage-checks"] = () => ({ status: 403, body: { error: { code: "permission_denied", message: "no" } } });
    render(<ImmutableStorageDriftSection teamId="team-1" />);
    await waitFor(() => expect(screen.getByText("You do not have permission to view storage drift.")).toBeTruthy());
  });
});
