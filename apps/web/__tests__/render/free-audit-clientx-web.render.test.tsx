/**
 * Free-user audit 0ea0 — CLIENT-X: web halves of the API-lane cross-lane
 * requests, over the REAL apiFetch (fetch mocked) wherever a server answer is
 * read.
 *
 *   B6-F-22 / B6-F-46  AI policy: paid switches plan-locked for Free/PAYG; the PUT 403 ENTITLEMENT_REQUIRED is a plan answer
 *   B6-F-49            usage-stats cost is an illustrative list-rate estimate, never a charge
 *   B6-F-41            batch results: metadata-only mode stated, type/verification breakdowns rendered
 *   B5A-F-11           lock 409 EVIDENCE_NOT_LOCKABLE (flat body) is named
 *   B6-F-02            PREVIOUS_PURCHASE_CONFIRMING names the confirming purchase
 *   B5B-F-101          NO_MATERIAL_CHANGE: no "Generate updated report"; the dialog says the report is current
 *   B4-F-001           integrity-rejected record: it does not use an included record
 */
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  useWorkspaceContextSafety: () => ({
    runGuarded: async <T,>(fn: () => Promise<T>, onOk: (r: T) => void) => {
      onOk(await fn());
    },
  }),
}));
vi.mock("../../lib/platform-context/PlatformContextProvider", () => ({
  useOptionalPlatformContext: () => ctx,
}));

import { AiSection } from "../../app/(app)/settings/_sections/AiSection";
import QuotasPage from "../../app/(app)/operations/quotas/page";
import BatchAnalysisPage from "../../app/(app)/operations/batch-analysis/page";
import { describeBillingError } from "../../app/(app)/billing/_sections/billingMessages";
import { UpdatedReportDialog } from "../../components/evidence-outputs/UpdatedReportDialog";
import { apiFetch, setActiveWorkspaceId } from "../../lib/api";
import { EVIDENCE_NOT_LOCKABLE_COPY, lockRefusalMessage } from "../../lib/evidence/lock-refusal";
import { INTEGRITY_REJECTED_SLOT_COPY, integrityRejectedSlotNote } from "../../lib/evidence/integrity-rejected-slot";
import { NO_MATERIAL_CHANGE_COPY, isNoMaterialChange } from "../../lib/evidence/new-version-reason";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

type Reply = { status?: number; body?: unknown };
type Call = { path: string; method: string; body: unknown };
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
      body: typeof init.body === "string" && init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const key = Object.keys(routes)
      .filter((k) => `${call.method} ${path}`.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const reply = key ? routes[key](call) : { status: 404, body: { error: { code: "not_found" } } };
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);

// ---------------------------------------------------------------------------
// B6-F-22 / B6-F-46
// ---------------------------------------------------------------------------
const POLICY = {
  aiEnabled: true,
  supportChatEnabled: true,
  captureAssistanceEnabled: true,
  evidenceCategorizationEnabled: true,
  semanticSearchEnabled: false,
  contentIntelligenceEnabled: false,
  reviewerCopilotEnabled: false,
  caseCopilotEnabled: false,
  rawContentProcessingAllowed: false,
  ocrAllowed: false,
  transcriptionAllowed: false,
  embeddingsAllowed: false,
};
const orgEnvelope = {
  contextOptions: { activeContext: { workspaceId: "team-1", kind: "ORGANIZATION" } },
  capabilities: { SETTINGS_MANAGE: true },
  planFeatures: { aiAssistanceMonthlyOperations: 10 },
};
function aiRoutes(plan: string | null, policy = POLICY) {
  routes["GET /v1/workspaces/ai-policy"] = () => ({
    body: { policy, version: 3, hasExplicitPolicy: true, lastModifiedByUserId: null, lastModifiedAtUtc: null, capabilities: [] },
  });
  routes["GET /v1/workspaces/ai-usage"] = () => ({
    body: {
      dayUtc: "2026-11-16",
      monthUtc: "2026-11",
      allowance: plan ? { plan, monthlyOperations: 10, consumed: 0, remaining: 10 } : null,
      daily: { operations: 0, costUsdMicros: "0" },
      monthly: { operations: 0, costUsdMicros: "0" },
      copilotRuns: 0,
      blockedProhibitedClaims: 0,
    },
  });
}
const toggle = (label: string) =>
  screen.getByText(label).closest("label")!.querySelector("input[type=checkbox]") as HTMLInputElement;

describe("B6-F-22 / B6-F-46: paid AI switches", () => {
  it("a Free workspace shows every paid switch as 'Not included in your plan' and disabled; free switches stay usable", async () => {
    ctx.envelope = orgEnvelope;
    aiRoutes("FREE");
    render(<AiSection />);
    await waitFor(() => expect(q("[data-cc-ai-plan-locked]")).not.toBeNull());
    for (const label of ["Semantic search", "Content intelligence", "Case Copilot", "Reviewer Copilot", "Raw content processing", "OCR", "Transcription", "Embeddings"]) {
      expect(toggle(label).disabled).toBe(true);
      expect(toggle(label).closest("label")!.textContent).toContain("Not included in your plan");
    }
    expect(toggle("Support assistant").disabled).toBe(false);
    expect(toggle("Capture assistance").disabled).toBe(false);
  });

  it("a paid plan (or an unknown plan) locks nothing", async () => {
    ctx.envelope = orgEnvelope;
    aiRoutes("PRO");
    render(<AiSection />);
    await waitFor(() => expect(screen.getByText("Semantic search")).toBeTruthy());
    await flush();
    expect(toggle("Semantic search").disabled).toBe(false);
    expect(q("[data-cc-ai-plan-locked]")).toBeNull();
  });

  it("a switch the row already holds stays operable on Free, so it can be turned off", async () => {
    ctx.envelope = orgEnvelope;
    aiRoutes("FREE", { ...POLICY, ocrAllowed: true });
    render(<AiSection />);
    await waitFor(() => expect(q("[data-cc-ai-plan-locked]")).not.toBeNull());
    expect(toggle("OCR").disabled).toBe(false);
    expect(toggle("OCR").checked).toBe(true);
  });

  it("the PUT 403 ENTITLEMENT_REQUIRED is said as a plan answer, never 'Only workspace owners or admins'", async () => {
    ctx.envelope = orgEnvelope;
    aiRoutes(null);
    routes["PUT /v1/workspaces/ai-policy"] = () => ({
      status: 403,
      body: {
        error: {
          code: "ENTITLEMENT_REQUIRED",
          message: "This AI capability is not included in this workspace's plan.",
          details: { entitlement: "AI_CAPABILITY", capabilities: ["SEMANTIC_SEARCH"], fields: ["semanticSearchEnabled"] },
        },
      },
    });
    render(<AiSection />);
    await waitFor(() => expect(screen.getByText("Semantic search")).toBeTruthy());
    await flush();
    fireEvent.click(toggle("Semantic search"));
    await act(async () => {
      fireEvent.click(q("[data-cc-ai-org-save]")!);
    });
    await waitFor(() => expect(screen.getByText(/Not included in your plan: /)).toBeTruthy());
    expect(screen.queryByText(/Only workspace owners or admins/)).toBeNull();
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ semanticSearchEnabled: true });
    // The refused switch is put back and now reads as plan-locked.
    expect(toggle("Semantic search").checked).toBe(false);
    expect(toggle("Semantic search").disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M029 — the ORGANIZATION admin status row carries the allowance reason
// ---------------------------------------------------------------------------
describe("M029: organization admin AI status row", () => {
  function policyWithAssistance(assistance: Record<string, unknown>) {
    routes["GET /v1/workspaces/ai-policy"] = () => ({
      body: { policy: POLICY, version: 3, hasExplicitPolicy: true, lastModifiedByUserId: null, lastModifiedAtUtc: null, capabilities: [], assistance },
    });
  }

  it("a spent allowance reads 'Allowance used' with the reset date, never outage copy", async () => {
    ctx.envelope = orgEnvelope;
    aiRoutes("PRO");
    policyWithAssistance({
      status: "TEMPORARILY_UNAVAILABLE",
      enabled: true,
      reason: "ALLOWANCE_EXHAUSTED",
      allowanceResetsAtUtc: "2026-12-01T00:00:00.000Z",
    });
    render(<AiSection />);
    await waitFor(() => expect(q("[data-cc-ai-status]")).not.toBeNull());
    const row = q("[data-cc-ai-status]")!;
    expect(row.textContent).toContain("Allowance used");
    expect(row.textContent).toMatch(/resets on/);
    expect(row.textContent).not.toContain("the platform is not serving AI requests");
  });

  it("an older API answer without reason keeps the outage copy (safe fallback)", async () => {
    ctx.envelope = orgEnvelope;
    aiRoutes("PRO");
    policyWithAssistance({ status: "TEMPORARILY_UNAVAILABLE", enabled: true });
    render(<AiSection />);
    await waitFor(() => expect(q("[data-cc-ai-status]")).not.toBeNull());
    const row = q("[data-cc-ai-status]")!;
    expect(row.textContent).not.toContain("Allowance used");
    expect(row.textContent).toContain("the platform is not serving AI requests");
  });
});

// ---------------------------------------------------------------------------
// B6-F-49
// ---------------------------------------------------------------------------
describe("B6-F-49: usage-stats cost is an estimate", () => {
  const quotas = {
    analyses: { limit: null, used: 1, remaining: null, resetDate: "2026-12-01" },
    batchJobs: { limit: null, used: 0, remaining: null },
    apiKeys: { limit: null, used: 0, remaining: null },
    teamMembers: { limit: null, used: 1, remaining: null },
  };
  const stats = {
    dailyAnalyses: { today: 1, thisWeek: 2, thisMonth: 3 },
    costBreakdown: { totalCost: 12.5, thisMonth: 0.3, averagePerAnalysis: 0.1 },
    topEvidenceTypes: {},
    activeApiKeys: 0,
    activeBatches: 0,
  };

  it("labels the figures an illustrative list-rate estimate and never 'Total Cost'", async () => {
    routes["GET /v1/quotas"] = () => ({ body: { data: quotas } });
    routes["GET /v1/usage-stats"] = () => ({
      body: { data: { ...stats, costBasis: "ILLUSTRATIVE_LIST_RATE_ESTIMATE", costIsCharged: false, workspaceId: "team-1" } },
    });
    render(<QuotasPage />);
    await waitFor(() => expect(q("[data-quotas-cost-estimate]")).not.toBeNull());
    expect(q("[data-quotas-cost-estimate]")!.textContent).toMatch(/not a charge: nothing is billed per analysis/);
    expect(screen.queryByText("Total Cost")).toBeNull();
    expect(screen.queryByText("Cost Overview")).toBeNull();
    expect(screen.getByText("Estimated total (list rate)")).toBeTruthy();
  });

  it("an older API (no costBasis) gets the same label; a body without costBreakdown renders no currency", async () => {
    routes["GET /v1/quotas"] = () => ({ body: { data: quotas } });
    routes["GET /v1/usage-stats"] = () => ({ body: { data: stats } });
    render(<QuotasPage />);
    await waitFor(() => expect(q("[data-quotas-cost-estimate]")).not.toBeNull());
    expect(screen.queryByText("Total Cost")).toBeNull();
    cleanup();
    const { costBreakdown: _drop, ...noCost } = stats;
    routes["GET /v1/usage-stats"] = () => ({ body: { data: noCost } });
    render(<QuotasPage />);
    await waitFor(() => expect(screen.getByText("Today")).toBeTruthy());
    expect(q("[data-quotas-cost-estimate]")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });
});

// ---------------------------------------------------------------------------
// B6-F-41
// ---------------------------------------------------------------------------
describe("B6-F-41: batch results are metadata-only", () => {
  const job = { id: "job-9", name: "Done", status: "completed", totalItems: 2, processedItems: 2, failedItems: 0, createdAt: "2026-11-01T00:00:00Z", progress: 100 };

  it("states the mode and renders the type / verification breakdowns from GET /results", async () => {
    routes["GET /v1/batch-analysis/job-9/results"] = () => ({
      body: {
        data: {
          classifications: {},
          averageConfidence: 0,
          safetyBreakdown: {},
          mostCommonTags: [],
          successRate: 100,
          mode: "METADATA_ONLY",
          typeBreakdown: { PHOTO: 2 },
          verificationBreakdown: { VERIFIED: 1, PENDING: 1 },
        },
      },
    });
    routes["GET /v1/batch-analysis"] = () => ({ body: { data: [job] } });
    render(<BatchAnalysisPage />);
    await waitFor(() => expect(q("[data-batch-mode-note='METADATA_ONLY']")).not.toBeNull());
    expect(q("[data-batch-mode-note]")!.textContent).toMatch(/metadata only/);
    await waitFor(() => expect(q("[data-batch-view-summary='job-9']")).not.toBeNull());
    fireEvent.click(q("[data-batch-view-summary='job-9']")!);
    await waitFor(() => expect(q("[data-batch-breakdown='type']")).not.toBeNull());
    expect(q("[data-batch-breakdown='type']")!.textContent).toMatch(/Photo: 2/);
    expect(q("[data-batch-breakdown='verification']")!.textContent).toMatch(/Verified: 1/);
    expect(document.body.textContent).not.toMatch(/classification|confidence|safety/i);
  });

  it("an older API's results (no mode, no breakdowns) say no breakdown was recorded, not empty charts", async () => {
    routes["GET /v1/batch-analysis/job-9/results"] = () => ({
      body: { data: { classifications: {}, averageConfidence: 0, safetyBreakdown: {}, mostCommonTags: [], successRate: 100 } },
    });
    routes["GET /v1/batch-analysis"] = () => ({ body: { data: [job] } });
    render(<BatchAnalysisPage />);
    await waitFor(() => expect(q("[data-batch-view-summary='job-9']")).not.toBeNull());
    fireEvent.click(q("[data-batch-view-summary='job-9']")!);
    await waitFor(() => expect(screen.getByText("This run recorded no metadata breakdown.")).toBeTruthy());
  });
});

// ---------------------------------------------------------------------------
// B5A-F-11
// ---------------------------------------------------------------------------
describe("B5A-F-11: lock on a trashed record", () => {
  it("the flat 409 EVIDENCE_NOT_LOCKABLE from the real apiFetch is named, not 'review your input'", async () => {
    routes["POST /v1/evidence/ev-1/lock"] = () => ({
      status: 409,
      body: { code: "EVIDENCE_NOT_LOCKABLE", message: "Only a record in the working set can be locked. Restore it from the trash first." },
    });
    const err = await apiFetch("/v1/evidence/ev-1/lock", { method: "POST", body: "{}" }).catch((e: unknown) => e);
    expect(lockRefusalMessage(err)).toBe(EVIDENCE_NOT_LOCKABLE_COPY);
    expect(toSafeUserError(err, { message: "Action failed" }).message).toMatch(/review your input/i);
    expect(lockRefusalMessage(Object.assign(new Error("x"), { code: "EVIDENCE_LOCKED", statusCode: 409 }))).toBeNull();
  });

  it("the record page's lock action uses it", () => {
    const page = readFileSync(resolve(__dirname, "../../app/(app)/evidence/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/\/lock`,[\s\S]{0,200}refusalMessage: lockRefusalMessage/);
    expect(page).toMatch(/options\?\.refusalMessage\?\.\(runError\) \?\?/);
  });
});

// ---------------------------------------------------------------------------
// B6-F-02
// ---------------------------------------------------------------------------
describe("B6-F-02: a previous credit purchase still confirming", () => {
  it("the 409 PREVIOUS_PURCHASE_CONFIRMING body from the real apiFetch names the confirming purchase", async () => {
    routes["POST /v1/billing/credits/checkout/stripe"] = () => ({
      status: 409,
      body: {
        message: "Your previous card purchase of evidence credits is being confirmed.",
        code: "PREVIOUS_PURCHASE_CONFIRMING",
        details: { provider: "STRIPE", attemptId: "att-1", retry: "AFTER_CONFIRMATION" },
      },
    });
    const err = await apiFetch("/v1/billing/credits/checkout/stripe", { method: "POST", body: "{}" }).catch((e: unknown) => e);
    const notice = describeBillingError(err, { message: "We could not start checkout." });
    expect(notice.message).toBe(
      "Your previous purchase is being confirmed — it will appear under Billing activity in a moment. You can buy another once it is confirmed.",
    );
    expect(notice.message).not.toMatch(/already starting|review your input/i);
    expect(notice.tone).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// B5B-F-101
// ---------------------------------------------------------------------------
describe("B5B-F-101: a current report on Free", () => {
  const nv = (action: string, reason: string | null) => ({ action, reason, currentVersion: 1, nextVersion: 2, estimate: null });

  it("the dialog says the report is already current when the offer becomes NONE / NO_MATERIAL_CHANGE", async () => {
    render(
      <UpdatedReportDialog
        open
        onClose={() => {}}
        initial={{ newVersion: nv("CREATE_NEW_VERSION", null), offer: null, freshness: null } as never}
        loadStatus={async () => ({ outputs: { newVersion: nv("NONE", "NO_MATERIAL_CHANGE"), offer: null, freshness: null } }) as never}
        submit={async () => ({ kind: "accepted", requestId: null, message: "" }) as never}
        onAccepted={() => {}}
      />,
    );
    const w = await waitFor(() => {
      const el = q("[data-testid='updated-report-withdrawn']");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(w.textContent).toContain(NO_MATERIAL_CHANGE_COPY);
    expect(q("[data-testid='updated-report-confirm']")).toBeNull();
  });

  it("'Generate updated report' is offered only on CREATE_NEW_VERSION (the tab's gate)", () => {
    expect(isNoMaterialChange(nv("NONE", "NO_MATERIAL_CHANGE"))).toBe(true);
    expect(isNoMaterialChange(nv("CREATE_NEW_VERSION", null))).toBe(false);
    const tab = readFileSync(resolve(__dirname, "../../app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx"), "utf8");
    expect(tab).toMatch(/const newVersionOffered = outputs\.newVersion\?\.action === NEW_VERSION_ACTION;/);
  });
});

// ---------------------------------------------------------------------------
// B4-F-001
// ---------------------------------------------------------------------------
describe("B4-F-001: an integrity-rejected record", () => {
  it("a plan-funded rejected record without a report is said not to use an included record", () => {
    expect(integrityRejectedSlotNote({ status: "FAILED_HASH_MISMATCH", recordFunding: "PLAN", reportAvailable: false })).toBe(
      INTEGRITY_REJECTED_SLOT_COPY,
    );
    expect(integrityRejectedSlotNote({ status: "FAILED_HASH_MISMATCH", recordFunding: "EVIDENCE_CREDIT", reportAvailable: false })).toBeNull();
    expect(integrityRejectedSlotNote({ status: "FAILED_HASH_MISMATCH", recordFunding: "PLAN", reportAvailable: true })).toBeNull();
    expect(integrityRejectedSlotNote({ status: "FAILED_HASH_MISMATCH", recordFunding: undefined, reportAvailable: false })).toBeNull();
    expect(integrityRejectedSlotNote({ status: "REPORTED", recordFunding: "PLAN", reportAvailable: false })).toBeNull();
  });

  it("the record page's integrity banner renders it", () => {
    const page = readFileSync(resolve(__dirname, "../../app/(app)/evidence/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/integrityRejectedSlotNote\(\{[\s\S]{0,200}recordFunding: workspace\.artifactStatus\.recordFunding/);
    expect(page).toContain("data-evidence-integrity-slot-note");
  });
});
