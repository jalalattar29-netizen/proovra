/**
 * T-115 / T-116 / T-110 — a Team workspace is a PERSONAL workspace with
 * members (Team is a personal-workspace tier). The header switcher, the
 * context banner (review breadcrumb) and Settings used to print the structural
 * kind instead: "Personal Space · Personal Space", "Personal • Owner",
 * "PERSONAL PLAN · TEAM", "SCOPE · Personal plan", and Settings hid "Roles &
 * permissions". Each surface now reads the ONE Team-aware label rule.
 *
 * Every case renders the REAL components against three envelopes: a TEAM
 * owner's Personal Workspace with members (the fix), a FREE solo Personal
 * Space (unchanged) and an Enterprise ORGANIZATION (unchanged).
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PLAN_CAPABILITIES } from "@proovra/shared-billing";

const H = vi.hoisted(() => ({ envelope: null as unknown }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/review",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../../components/app-shell-v2/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("../../components/language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("../../components/operational", () => ({ GlobalRuntimeIndicator: () => null }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/security/useAccountSecuritySummary", () => ({
  useAccountSecuritySummary: () => ({ mfaConfigured: true, passkeyCount: 0, recentSignIns: [], loaded: true }),
}));
vi.mock("../../app/providers", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAuth: () => ({ user: { id: "u-1" }, hasSession: true }),
  useLocale: () => ({
    locale: "en",
    mode: "auto",
    setLocale: () => {},
    setLocaleMode: () => {},
    t: (k: string) => k,
    isRTL: false,
  }),
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
const ctx = () => ({
  envelope: H.envelope,
  state: { name: "READY" },
  activeWorkspaceId: (H.envelope as { activeSpace?: { id?: string } } | null)?.activeSpace?.id ?? null,
  switchWorkspace: vi.fn(),
});
vi.mock("../../lib/platform-context/PlatformContextProvider", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  usePlatformContext: () => ctx(),
}));
vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  usePlatformContext: () => ctx(),
  useEnterpriseSurfaceAccess: () =>
    (H.envelope as { flags?: { isEnterpriseWorkspace?: boolean } }).flags?.isEnterpriseWorkspace === true,
}));

import { AppAccountToolbar } from "../../components/app-shell-v2/AppAccountToolbar";
import { WorkspaceContextBanner } from "../../lib/platform-context/WorkspaceContextBanner";
import SettingsPage from "../../app/(app)/settings/page";
import { ToastProvider } from "../../components/ui";

afterEach(() => cleanup());

type Plan = "FREE" | "TEAM" | "ENTERPRISE";
function planFeatures(plan: Plan) {
  const c = PLAN_CAPABILITIES[plan];
  return {
    teamCollaborationIncluded: c.maxCollaborationTeamsPerWorkspace > 0,
    reviewerOperationsIncluded: c.reviewerOperationsIncluded,
    reviewQueuesIncluded: c.reviewQueuesIncluded,
    casesIncluded: c.casesIncluded,
    aiAssistanceMonthlyOperations: c.aiAdvisoryMonthlyOperations,
  };
}

const WS = "11111111-1111-4111-8111-111111111111";
const ORG_WS = "22222222-2222-4222-8222-222222222222";
const CAPS = { SETTINGS_VIEW: true, ACCOUNT_SETTINGS_VIEW: true, BILLING_MANAGE: true, SETTINGS_MANAGE: true };

function personal(plan: "FREE" | "TEAM", members: number) {
  return {
    user: { id: "u-1", firstName: "Dana", lastName: "Reyes", email: "dana@example.test", avatarUrl: null },
    platform: { isPlatformAdmin: false },
    workspace: {
      status: "active",
      id: WS,
      name: "Dana Reyes's personal workspace",
      scope: "PERSONAL",
      workspaceKind: "PERSONAL",
      plan,
      membership: { role: "OWNER", isOwner: true, isAdmin: true, memberCount: members },
    },
    activeSpace: { type: "PERSONAL", id: WS, displayName: "Personal Space", roleLabel: "Owner", plan },
    personalSpace: { status: "active", id: WS, label: "Personal Space", ownerUserId: "u-1", plan },
    organizations: [],
    account: { accountPlan: plan },
    capabilities: CAPS,
    flags: { isEnterpriseWorkspace: false },
    planFeatures: planFeatures(plan),
    contextOptions: {
      personalSpace: { workspaceId: WS, name: "Personal Space", kind: "PERSONAL", role: "OWNER", lifecycleStatus: "active" },
      ownedWorkspaces: [],
      sharedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
    },
  };
}

function enterprise() {
  return {
    user: { id: "u-1", firstName: "Ola", lastName: "Admin", email: "ola@example.test", avatarUrl: null },
    platform: { isPlatformAdmin: false },
    workspace: {
      status: "active",
      id: ORG_WS,
      name: "Northwind Legal",
      scope: "ORGANIZATION",
      workspaceKind: "ORGANIZATION",
      organizationKind: "CUSTOMER",
      organizationId: "org-1",
      plan: "ENTERPRISE",
      membership: { role: "OWNER", isOwner: true, isAdmin: true, memberCount: 40 },
    },
    activeSpace: { type: "ORGANIZATION", id: ORG_WS, displayName: "Northwind Legal", roleLabel: "OWNER", plan: "ENTERPRISE" },
    personalSpace: { status: "active", id: WS, label: "Personal Space", ownerUserId: "u-1", plan: null },
    organizations: [
      { id: ORG_WS, name: "Northwind Legal", displayName: "Northwind Legal", role: "OWNER", membershipStatus: "ACTIVE", plan: "ENTERPRISE", memberCount: 40 },
    ],
    account: { accountPlan: "FREE" },
    capabilities: CAPS,
    flags: { isEnterpriseWorkspace: true },
    planFeatures: planFeatures("ENTERPRISE"),
    contextOptions: {
      personalSpace: { workspaceId: WS, name: "Personal Space", kind: "PERSONAL", role: "OWNER", lifecycleStatus: "active" },
      ownedWorkspaces: [],
      sharedWorkspaces: [],
      organizations: [
        {
          organizationId: "org-1",
          organizationName: "Northwind",
          workspaces: [{ workspaceId: ORG_WS, workspaceName: "Northwind Legal", kind: "ORGANIZATION", workspaceRole: "OWNER", lifecycleStatus: "active" }],
        },
      ],
      activeContext: { workspaceId: ORG_WS, kind: "ORGANIZATION", organizationId: "org-1", displayName: "Northwind Legal" },
    },
  };
}

const chip = () => ({
  name: document.querySelector("[data-context-chip-name]")?.textContent ?? "",
  scope: document.querySelector("[data-context-chip-scope-line]")?.textContent ?? "",
});
/** The banner as read aloud: its parts joined by a space (the layout gap). */
const banner = () =>
  Array.from(document.querySelector("[data-workspace-context-banner]")?.children ?? [])
    .map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim())
    .join(" ");

describe("T-115 — header switcher and review breadcrumb", () => {
  it("a TEAM owner's workspace with members is named once, as a Team workspace", () => {
    H.envelope = personal("TEAM", 3);
    render(<AppAccountToolbar onLogout={() => {}} />);
    expect(chip()).toEqual({ name: "Dana Reyes's personal workspace", scope: "Team workspace • Owner" });
    cleanup();
    render(<WorkspaceContextBanner action="Reviewing evidence in" />);
    expect(banner()).not.toContain("Personal Space · Personal Space");
    expect(banner()).not.toContain("Personal Space");
    expect(banner()).toBe("Reviewing evidence in Dana Reyes's personal workspace · Team workspace");
  });

  it("a FREE solo Personal Space keeps its label, without saying it twice", () => {
    H.envelope = personal("FREE", 1);
    render(<AppAccountToolbar onLogout={() => {}} />);
    expect(chip()).toEqual({ name: "Personal Space", scope: "Personal • Owner" });
    cleanup();
    render(<WorkspaceContextBanner action="Reviewing evidence in" />);
    expect(banner()).toBe("Reviewing evidence in Personal Space");
  });

  it("an Enterprise organization keeps its organization label", () => {
    H.envelope = enterprise();
    render(<AppAccountToolbar onLogout={() => {}} />);
    expect(chip().name).toBe("Northwind Legal");
    expect(chip().scope).toMatch(/^Organization • /);
    cleanup();
    render(<WorkspaceContextBanner action="Reviewing evidence in" />);
    expect(banner()).toBe("Reviewing evidence in Northwind Legal · Organization workspace · Northwind");
  });
});

const rail = () => Array.from(document.querySelectorAll("button, a")).map((e) => e.textContent?.trim() ?? "");

describe("T-116 / T-110 — Settings for a Team owner", () => {
  it("TEAM owner: no 'Personal plan' scope; the workspace is named; Roles & permissions is offered", () => {
    H.envelope = personal("TEAM", 3);
    render(<ToastProvider><SettingsPage /></ToastProvider>);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Personal plan/);
    expect(text).toContain("Team plan on your workspace");
    expect(text).toContain("Dana Reyes's personal workspace");
    // Team is a plan on a Personal Workspace, never a workspace kind.
    expect(text).toContain("Personal Workspace with members");
    expect(text).not.toContain("Team Workspace");
    expect(rail()).toContain("Roles & permissions");
  });

  it("FREE: 'Personal plan' and Personal Space as before; no Roles & permissions", () => {
    H.envelope = personal("FREE", 1);
    render(<ToastProvider><SettingsPage /></ToastProvider>);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Personal plan");
    expect(text).toContain("Personal Space");
    expect(text).not.toContain("Team plan on your workspace");
    expect(rail()).not.toContain("Roles & permissions");
  });

  it("Enterprise organization: its agreement and Roles & permissions, unchanged", () => {
    H.envelope = enterprise();
    render(<ToastProvider><SettingsPage /></ToastProvider>);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Organization agreement");
    expect(text).not.toMatch(/Personal plan/);
    expect(rail()).toContain("Roles & permissions");
  });
});
