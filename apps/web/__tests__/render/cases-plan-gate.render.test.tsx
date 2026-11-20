/**
 * Free audit F-10 — "Create case" was offered to a workspace whose plan does
 * not include cases, and refused only after submit (409 CASES_NOT_INCLUDED).
 *
 * The gate is the ACTIVE workspace's server-projected
 * `planFeatures.casesIncluded` (the field POST /v1/cases enforces). Covered:
 *   - Free Personal (casesIncluded false): no Create case; a View plans route;
 *     the case list stays viewable; the global header hides "New Case".
 *   - eligible paid workspace, or a Free user's invited paid workspace — the
 *     envelope is the active workspace's, so both read casesIncluded true:
 *     Create case is offered.
 *   - unknown (field absent): the affordance stays; the server decides.
 */
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/cases",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

const enterprise = vi.hoisted(() => ({ on: false }));
const planFeatures = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const envelope = vi.hoisted(() => ({
  user: { id: "u-1", firstName: "Jane", lastName: "Doe", email: "jane@example.com", avatarUrl: null },
  platform: { isPlatformAdmin: false },
  activeSpace: { type: "PERSONAL", id: "personal-1", displayName: "Personal Space" },
  personalSpace: { id: "personal-1", status: "active" },
  capabilities: { CASES_VIEW: true, CASES_MANAGE: true, ACCOUNT_SETTINGS_VIEW: true, ACCOUNT_BILLING_VIEW: true },
  organizations: [],
  account: { accountPlan: "FREE" },
  contextOptions: { personalSpace: { workspaceId: "personal-1", name: "Personal Space", role: "OWNER" }, ownedWorkspaces: [], organizations: [] },
  get planFeatures() {
    return planFeatures.current;
  },
}));

vi.mock("../../lib/platform-context", () => ({
  usePlatformContext: () => ({ envelope, state: { name: "READY" }, switchWorkspace: vi.fn() }),
  useActiveWorkspaceId: () => "personal-1",
  usePersonalSpace: () => ({ id: "personal-1", status: "active" }),
  useEnterpriseSurfaceAccess: () => enterprise.on,
  // The real useCan reads the envelope's server-projected capabilities.
  useCan: (key: string) => (envelope.capabilities as Record<string, boolean>)[key] === true,
  usePlanFeature: (key: string) => {
    const v = planFeatures.current[key];
    return typeof v === "boolean" ? v : null;
  },
  CapabilityDegradedPanel: () => null,
  WorkspaceContextBanner: () => null,
  useWorkspaceContextSafety: () => ({ runGuarded: async (fn: () => Promise<unknown>, apply: (v: unknown) => void) => apply(await fn()) }),
}));

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiFetch }));
vi.mock("../../components/ui-legacy", () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: vi.fn() }) }));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  StepUpModal: () => null,
  useStepUpAction: () => ({ run: vi.fn() }),
}));
vi.mock("../../components/contextual-help/ContextualHelp", () => ({ ContextualHelp: () => null }));
// Header neighbours that fetch on mount; not under test here.
vi.mock("../../components/app-shell-v2/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("../../components/language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("../../components/operational", () => ({ GlobalRuntimeIndicator: () => null }));

import { CasesIndex } from "../../components/cases-experience/CasesIndex";
import { AppAccountToolbar } from "../../components/app-shell-v2/AppAccountToolbar";

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  (envelope.capabilities as Record<string, boolean>).CASES_MANAGE = true;
  enterprise.on = false;
});

const QUEUE = (total: number) => ({
  generatedAt: "2026-11-13T09:00:00.000Z",
  workspace: { teamId: "personal-1", role: "OWNER" },
  items: [],
  total,
});

async function renderCases(features: Record<string, unknown>) {
  planFeatures.current = features;
  apiFetch.mockResolvedValue(QUEUE(0));
  render(<CasesIndex />);
  await waitFor(() => expect(document.querySelector("[data-matter-queue-empty]")).not.toBeNull());
}

describe("F-10: case creation follows the active workspace's plan", () => {
  it("Free Personal: no Create case; a View plans route; the list still loads", async () => {
    await renderCases({ casesIncluded: false });
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("/v1/cases/matter-queue"), expect.anything());
    expect(document.querySelector("[data-create-case-trigger]")).toBeNull();
    expect(document.querySelector("[data-empty-state-cta='create-case']")).toBeNull();
    expect(document.querySelector("[data-empty-state='cases-not-included']")).not.toBeNull();
    const plans = screen.getAllByRole("link", { name: "View plans" });
    expect(plans.length).toBeGreaterThan(0);
    for (const link of plans) expect(link.getAttribute("href")).toBe("/billing");
    expect(screen.queryByTestId("create-case-modal")).toBeNull();
  });

  it("an eligible (or invited paid) workspace: Create case is offered", async () => {
    await renderCases({ casesIncluded: true });
    expect(document.querySelector("[data-create-case-trigger]")).not.toBeNull();
    expect(document.querySelector("[data-empty-state-cta='create-case']")).not.toBeNull();
    expect(document.querySelector("[data-create-case-locked]")).toBeNull();
  });

  it("an envelope without the field keeps the affordance (the server decides)", async () => {
    await renderCases({});
    expect(document.querySelector("[data-create-case-trigger]")).not.toBeNull();
  });

  it("the global header hides New Case only where the plan excludes cases", () => {
    planFeatures.current = { casesIncluded: false };
    render(<AppAccountToolbar onLogout={() => {}} />);
    expect(document.querySelector("[data-app-header-primary-action]")).toBeNull();
    cleanup();
    planFeatures.current = { casesIncluded: true };
    render(<AppAccountToolbar onLogout={() => {}} />);
    expect(document.querySelector("[data-app-header-primary-action]")).not.toBeNull();
  });
});

describe("B3C-F-005 / A2-14: the case row menu offers a VIEWER only Open", () => {
  const ROW = {
    id: "c0ffee00-0000-4000-8000-000000000001", name: "Leaking roof", referenceNumber: null, status: "OPEN", priority: "P1",
    ownerUserId: "u-2", owner: null, teamId: "personal-1", linkedEvidenceCount: 0, evidenceGapCount: 0, openIncidentCount: 0,
    overdueWorkflowCount: 0, governanceBlockerCount: 0, activeLegalHoldCount: 0, riskScore: 0, riskLevel: "LOW",
    riskReasonCodes: [], recommendedAction: null, latestActivityAtUtc: "2026-11-13T09:00:00.000Z",
  };
  async function openMenu(role: string) {
    planFeatures.current = { casesIncluded: true };
    // Integration fix-up 2026-11-16 (B3C-F-005): the page now decides from the
    // server-projected CASES_MANAGE capability (granted to every writer role,
    // never to VIEWER) instead of comparing the queue's role string, so the
    // fixture states the capability the server projects for that role.
    (envelope.capabilities as Record<string, boolean>).CASES_MANAGE = role !== "VIEWER";
    apiFetch.mockResolvedValue({ ...QUEUE(1), workspace: { teamId: "personal-1", role }, items: [ROW] });
    render(<CasesIndex />);
    const trigger = await screen.findByRole("button", { name: "Case actions" });
    trigger.click();
    return await screen.findByRole("menu");
  }

  it("VIEWER: Open only", async () => {
    const menu = await openMenu("VIEWER");
    const items = Array.from(menu.querySelectorAll("[role='menuitem']")).map((n) => n.textContent?.trim());
    expect(items).toEqual(["Open"]);
  });

  // PRO-K1-09 — both case pages open their Settings tab from ?tab=settings, so
  // Rename and Change status are offered on the Enterprise branch too, and
  // still never to a VIEWER.
  it.each([false, true])("PRO-K1-09: Rename and Change status are offered on both branches (enterprise=%s)", async (on) => {
    enterprise.on = on;
    const menu = await openMenu("OWNER");
    const items = Array.from(menu.querySelectorAll("[role='menuitem']")).map((n) => n.textContent?.trim());
    expect(items).toEqual(expect.arrayContaining(["Rename", "Change status"]));
  });

  it("PRO-K1-09: a VIEWER on the Enterprise branch sees neither item", async () => {
    enterprise.on = true;
    const menu = await openMenu("VIEWER");
    const items = Array.from(menu.querySelectorAll("[role='menuitem']")).map((n) => n.textContent?.trim());
    expect(items).toEqual(["Open"]);
  });

  it("OWNER: the writes stay", async () => {
    const menu = await openMenu("OWNER");
    const items = Array.from(menu.querySelectorAll("[role='menuitem']")).map((n) => n.textContent?.trim());
    expect(items).toEqual(expect.arrayContaining(["Open", "Rename", "Archive", "Delete"]));
  });
});
