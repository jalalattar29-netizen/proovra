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
  useEnterpriseSurfaceAccess: () => false,
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
