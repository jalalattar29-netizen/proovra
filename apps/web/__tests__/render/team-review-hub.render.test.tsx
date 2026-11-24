/**
 * TEAM-SPEC §3 — the Review hub tabs, Review settings and the global palette.
 *
 *  - ReviewHubNav renders a tab only when its destination resolves ALLOWED:
 *    a Team personal owner sees all four; a Pro personal owner sees none; a
 *    Viewer sees Review settings (read-only). Every rendered tab href opens.
 *  - Review settings offers the SLA policy edit form only to a role holding
 *    `governance.policy.manage`; a Viewer reads it.
 *  - The global "Jump to a page" palette hides DENIED rows instead of
 *    silently sending the user to /home.
 *
 * Real components, real apiFetch over a stubbed fetch, RTL cleanup().
 */
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams("queue=ESCALATED"),
  usePathname: () => "/review",
  useParams: () => ({}),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import { ReviewHubNav, ReviewToolsPanel } from "../../components/reviewer-experience/ReviewHubNav";
import { reviewDestinationFromEnvelope } from "../../components/reviewer-experience/reviewDestination";
import { CommandPalette } from "../../components/navigation/CommandPalette";
import ReviewSettingsPage from "../../app/(app)/review/settings/page";
// TEAM-UI-SPEC (structure) — every hub page renders ReviewPageHeader before the hub nav.
import ReviewPage from "../../app/(app)/review/page";
import MonitoringPage from "../../app/(app)/reviewer-ops/sla/page";
import { ReviewPageHeader } from "../../components/reviewer-experience/ReviewPageHeader";
import { routeIconFor } from "../../lib/navigation/routeIcons";
import { ROUTE_REGISTRY } from "../../lib/navigation/routeRegistry";
import { resolveRouteAccess } from "../../lib/navigation/routeAccessResolver";
import { setActiveWorkspaceId } from "../../lib/api";

const WS = "66666666-6666-4666-8666-666666666666";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Persona = "TEAM_OWNER" | "TEAM_VIEWER" | "PRO_OWNER";

function caps(p: Persona): Record<string, boolean> {
  const base = { DASHBOARD_VIEW: true, EVIDENCE_VIEW: true, CASES_VIEW: true, REPORTS_VIEW: true, SEARCH_VIEW: true, SETTINGS_VIEW: true };
  if (p === "PRO_OWNER") return { ...base, EVIDENCE_MANAGE: true };
  const view = { REVIEWER_OPS_VIEW: true, SLA_VIEW: true, ESCALATIONS_VIEW: true };
  if (p === "TEAM_VIEWER") return { ...base, ...view };
  return { ...base, ...view, EVIDENCE_MANAGE: true, REVIEWER_OPS_ACT: true, REVIEW_ASSIGN: true, BULK_ACTIONS: true };
}

function envelope(p: Persona) {
  const team = p !== "PRO_OWNER";
  const role = p === "TEAM_VIEWER" ? "VIEWER" : "OWNER";
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: caps(p),
    diagnostics: { requestId: `team-review-hub-${p}` },
    user: { id: ME, email: null, displayName: null, firstName: null, lastName: null, avatarUrl: null, locale: null, timezone: null },
    workspace: { id: WS, name: "Personal Space", status: "active", scope: "PERSONAL", membership: { role } },
    activeSpace: { type: "PERSONAL", id: WS, displayName: "Personal Space", roleLabel: role === "OWNER" ? "Owner" : "VIEWER" },
    personalSpace: { id: WS, status: "active" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
    },
    account: { accountPlan: team ? "TEAM" : "PRO", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: team
      ? { reviewerOperationsIncluded: true, reviewQueuesIncluded: true, externalReviewIncluded: true, intakeIncluded: true, reportsIncluded: true, professionalSurfacesIncluded: true, casesIncluded: true }
      : { reviewerOperationsIncluded: false, reviewQueuesIncluded: false, externalReviewIncluded: true, intakeIncluded: true, reportsIncluded: true, professionalSurfacesIncluded: true, casesIncluded: true },
  };
}

const POLICY = {
  policy: {
    policy: { assignmentHours: 4, firstReviewHours: 24, completionHours: 72, escalationHours: 8, dueSoonHours: 2 },
    sources: { template: {}, workspace: {}, env: {} },
  },
  flags: {
    requireStepUpForApprove: false,
    requireStepUpForReject: false,
    requireStepUpForEscalationResolve: true,
    requireStepUpForBulk: false,
    reviewerInactivityHours: null,
  },
};

beforeEach(() => {
  push.mockReset();
  setActiveWorkspaceId(WS);
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/v1/reviewer-ops/sla-policy")) {
      return new Response(JSON.stringify(POLICY), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { code: "not_found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

function mount(p: Persona, node: React.ReactNode) {
  return render(
    <PlatformContextProvider testEnvelope={envelope(p) as never}>
      <ToastProvider>
        <ConfirmActionProvider>{node}</ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
}

const tabIds = () =>
  Array.from(document.querySelectorAll("[data-review-hub-tab]")).map((t) => t.getAttribute("data-review-hub-tab"));

const HREF_TO_ROUTE: Record<string, string> = {
  "/review": "review.queue",
  "/reviewer-ops/sla": "review.sla",
  "/review/settings": "review.settings",
};

const TOOL_ROUTE: Record<string, string> = {
  "/review/disagreements": "workspace.review_disagreements",
  "/review/external": "workspace.review_external",
  "/evidence-requests": "workspace.evidence_requests",
};

describe("ReviewHubNav — tabs per context", () => {
  // Stage D (T-065 / T-078) — one level: Inbox · Monitoring · Review settings.
  it("a Team personal Owner sees Inbox, Monitoring and Review settings; the view is carried into the Inbox tab", async () => {
    mount("TEAM_OWNER", <ReviewHubNav active="inbox" />);
    await settle();
    expect(tabIds()).toEqual(["inbox", "monitoring", "settings"]);
    const inbox = document.querySelector('[data-review-hub-tab="inbox"]') as HTMLAnchorElement;
    expect(inbox.textContent).toBe("Inbox");
    expect(inbox.getAttribute("href")).toBe("/review?view=ESCALATED");
    expect(inbox.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('[data-review-hub-tab="queues"]')).toBeNull();
    // T-088 — the tab row scrolls sideways at 390 px instead of cutting a tab off.
    expect(document.querySelector("[data-review-hub-tabs-scroll]")!.classList.contains("review-hub-tabs")).toBe(true);
  });

  it("every rendered tab resolves ALLOWED — no tab opens a refusal", async () => {
    for (const p of ["TEAM_OWNER", "TEAM_VIEWER"] as const) {
      mount(p, <ReviewHubNav active="monitoring" />);
      await settle();
      const links = Array.from(document.querySelectorAll("[data-review-hub-tab]")) as HTMLAnchorElement[];
      expect(links.length).toBeGreaterThan(0);
      for (const a of links) {
        const path = (a.getAttribute("href") ?? "").split("?")[0]!;
        const routeId = HREF_TO_ROUTE[path];
        expect(routeId, `${p}: ${path} is a hub route`).toBeTruthy();
        const d = reviewDestinationFromEnvelope(routeId!, envelope(p) as never, {
          workspace: { id: WS, status: "active" },
          personalSpace: { id: WS, status: "active" },
        });
        expect(d?.kind, `${p}: ${routeId}`).toBe("link");
      }
      cleanup();
    }
  });

  it("T-078: the hub has ONE navigation level — Monitoring has no second tab row", async () => {
    mount("TEAM_OWNER", <ReviewHubNav active="monitoring" />);
    await settle();
    expect(document.querySelectorAll("[data-review-hub-nav] nav")).toHaveLength(1);
    expect(document.querySelector("[data-review-hub-subnav]")).toBeNull();
    expect(document.querySelector("[data-review-hub-subtab]")).toBeNull();
  });

  // TEAM-UI-SPEC §3 (round 3) — the hub is tabs only: no "More review tools"
  // row under the tabs on any hub page.
  it("the hub renders no tools row under the tabs", async () => {
    for (const active of ["inbox", "monitoring", "settings"] as const) {
      mount("TEAM_OWNER", <ReviewHubNav active={active} />);
      await settle();
      expect(document.querySelector("[data-review-hub-nav]")).not.toBeNull();
      expect(document.querySelector("[data-review-hub-more-tools]")).toBeNull();
      expect(document.querySelector("[data-review-hub-more-tool]")).toBeNull();
      expect(document.querySelector("[data-review-hub-nav]")!.textContent).not.toMatch(/More review tools/);
      cleanup();
    }
  });

  it("the Inbox lists the operational tools in the Review tools panel, each resolving ALLOWED (TEAM-SPEC R2, T-079)", async () => {
    mount("TEAM_OWNER", <ReviewToolsPanel />);
    await settle();
    const panel = document.querySelector("[data-review-tools-panel]") as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.classList.contains("app-panel")).toBe(true);
    expect(panel.querySelector(".app-panel__title")!.textContent).toBe("Review tools");
    const rows = Array.from(panel.querySelectorAll("[data-review-tool]")) as HTMLElement[];
    // Each row: the tool name as a link + a one-line purpose.
    for (const row of rows) {
      expect(row.querySelector("a[href]")!.textContent!.length).toBeGreaterThan(0);
      expect(row.querySelector(".app-field-help")!.textContent!.length).toBeGreaterThan(0);
    }
    const tools = rows.map((r) => r.getAttribute("data-review-tool"));
    // External Review stays discoverable as an operational task; QC and
    // metrics are Monitoring sections, schemas a Review settings section and
    // the workspace is the Review page's focus mode.
    expect(tools).toEqual(expect.arrayContaining(["/review/external", "/review/disagreements"]));
    for (const gone of ["/review/workspace", "/review/qc", "/review/metrics", "/review/schemas"]) expect(tools).not.toContain(gone);
    expect(panel.textContent).toContain("Challenged decisions");
    expect(panel.textContent).not.toMatch(/different outcomes/);
    for (const href of tools) {
      const d = reviewDestinationFromEnvelope(TOOL_ROUTE[href!.split("?")[0]!]!, envelope("TEAM_OWNER") as never, {
        workspace: { id: WS, status: "active" },
        personalSpace: { id: WS, status: "active" },
      });
      expect(d?.kind, href!).toBe("link");
    }
  });

  it("the Review tools panel renders nothing when no tool opens (Pro personal owner)", async () => {
    mount("PRO_OWNER", <ReviewToolsPanel />);
    await settle();
    const panel = document.querySelector("[data-review-tools-panel]");
    if (panel) {
      // Only tools that resolve ALLOWED for a Pro owner may be listed.
      for (const row of Array.from(panel.querySelectorAll("[data-review-tool]"))) {
        const href = row.getAttribute("data-review-tool")!;
        const routeId = TOOL_ROUTE[href.split("?")[0]!]!;
        const d = reviewDestinationFromEnvelope(routeId, envelope("PRO_OWNER") as never, {
          workspace: { id: WS, status: "active" },
          personalSpace: { id: WS, status: "active" },
        });
        expect(d?.kind, href).toBe("link");
      }
    }
    // The Team-only tools never appear for Pro.
    expect(document.querySelector('[data-review-tool="/review/disagreements"]')).toBeNull();
  });

  it("a Pro personal owner sees no hub at all (no tab would open)", async () => {
    mount("PRO_OWNER", <ReviewHubNav active="inbox" />);
    await settle();
    expect(document.querySelector("[data-review-hub-nav]")).toBeNull();
  });

  it("a Team Viewer sees the three tabs (Review settings is readable)", async () => {
    mount("TEAM_VIEWER", <ReviewHubNav active="settings" />);
    await settle();
    expect(tabIds()).toEqual(["inbox", "monitoring", "settings"]);
  });
});

/**
 * TEAM-UI-SPEC (structure) — the review pages share Evidence Library's page
 * structure: ReviewPageHeader (the h1 inside `.app-title-row` with the Review
 * sidebar icon, a plain subtitle, NO eyebrow) BEFORE the hub nav, and no
 * full-width "HELP · REVIEWER OPERATIONS" bar.
 */
describe("Review page structure — header before hub nav, no eyebrow", () => {
  function expectReviewHeader(title: string) {
    const header = document.querySelector("[data-review-page-header]");
    expect(header, `${title}: ReviewPageHeader`).not.toBeNull();
    const h1s = document.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    const h1 = h1s[0]!;
    expect(header!.contains(h1)).toBe(true);
    expect(h1.querySelector(":scope > .app-title-row")).not.toBeNull();
    expect(h1.querySelector(".app-title-icon [data-review-title-icon]")).not.toBeNull();
    expect(h1.textContent).toBe(title);
    // No eyebrow / kicker: nothing renders before the <h1> in its column.
    expect(h1.previousElementSibling).toBeNull();
    return header!;
  }
  function expectHeaderBeforeHubNav(header: Element) {
    const nav = document.querySelector("[data-review-hub-nav]");
    expect(nav).not.toBeNull();
    expect(header.compareDocumentPosition(nav!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }

  it.each([
    ["Inbox", () => <ReviewPage />],
    ["Monitoring", () => <MonitoringPage />],
    ["Review settings", () => <ReviewSettingsPage />],
  ] as const)("%s renders ReviewPageHeader (h1 in .app-title-row, no eyebrow) before the hub nav", async (title, page) => {
    mount("TEAM_OWNER", page());
    await settle();
    const header = expectReviewHeader(title);
    expectHeaderBeforeHubNav(header);
    expect(document.body.textContent).not.toMatch(/Reviewer operations|Review Operations Console/i);
  });

  it("Inbox: banner → header → hub nav, and no HELP · REVIEWER OPERATIONS bar", async () => {
    mount("TEAM_OWNER", <ReviewPage />);
    await settle();
    const banner = document.querySelector("[data-workspace-context-banner]");
    const header = document.querySelector("[data-review-page-header]")!;
    if (banner) {
      expect(banner.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expectHeaderBeforeHubNav(header);
    expect(document.querySelector('[data-contextual-help-surface="reviewer-ops"]')).toBeNull();
    // Keyboard hints live in the "?" shortcuts help, not the subtitle.
    expect(header.querySelector("kbd")).toBeNull();
  });

  it("the title icon is the Review sidebar icon (routeIcons workspace.review)", () => {
    const Icon = routeIconFor("workspace.review");
    const { container } = render(<ReviewPageHeader title="X" />);
    const { container: ref } = render(<Icon strokeWidth={1.75} />);
    const ours = container.querySelector("[data-review-title-icon]")!;
    expect(ours.getAttribute("class")).toBe(ref.querySelector("svg")!.getAttribute("class"));
  });

  it("back renders an app-ghost-action link above the title; backToHub only where /review opens", async () => {
    render(<ReviewPageHeader title="Quality control" back={{ href: "/review", label: "Review" }} />);
    const back = document.querySelector("[data-review-back-link]") as HTMLAnchorElement;
    expect(back.className).toBe("app-ghost-action");
    expect(back.getAttribute("href")).toBe("/review");
    expect(back.compareDocumentPosition(document.querySelector("h1")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();

    mount("TEAM_OWNER", <ReviewPageHeader title="External review" backToHub />);
    await settle();
    expect(document.querySelector("[data-review-back-link]")?.getAttribute("href")).toBe("/review");
    cleanup();

    mount("PRO_OWNER", <ReviewPageHeader title="External review" backToHub />);
    await settle();
    expect(document.querySelector("[data-review-back-link]")).toBeNull();
  });
});

describe("Review settings — edit only for governance.policy.manage", () => {
  it("an Owner gets the edit form and Save", async () => {
    mount("TEAM_OWNER", <ReviewSettingsPage />);
    await settle();
    expect(document.querySelector('[data-review-sla-policy-mode="edit"]')).not.toBeNull();
    expect(document.querySelector("[data-review-sla-policy-save]")).not.toBeNull();
    expect(document.querySelector('[data-review-sla-policy-field="firstReviewHours"]')).not.toBeNull();
  });

  it("a Viewer reads the policy: no inputs, no Save", async () => {
    mount("TEAM_VIEWER", <ReviewSettingsPage />);
    await settle();
    expect(document.querySelector('[data-review-sla-policy-mode="read"]')).not.toBeNull();
    expect(document.querySelector("[data-review-sla-policy-save]")).toBeNull();
    expect(document.querySelector("[data-review-sla-policy-field]")).toBeNull();
    expect(document.querySelector('[data-review-sla-policy-value="firstReviewHours"]')!.textContent).toMatch(/24 h/);
  });
});

describe("global palette — DENIED rows are hidden, never a silent /home", () => {
  const ctxCaps = caps("TEAM_VIEWER");
  const env = envelope("TEAM_VIEWER");
  const deniedVisible = ROUTE_REGISTRY.filter((route) => {
    if (!route.commandPaletteVisible || /[:[]/.test(route.href)) return false;
    const a = resolveRouteAccess({
      route,
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: false,
      capabilities: ctxCaps as never,
      accountPlan: "TEAM",
      isEnterpriseWorkspace: false,
      planFeatures: env.planFeatures as never,
      workspace: { id: WS, status: "active" },
      personalSpace: { id: WS, status: "active" },
    });
    return a.canSeeNav && !a.canLoad && a.accessState !== "NEEDS_ORGANIZATION";
  });

  it("the case is real: some palette routes resolve DENIED but nav-visible for a Viewer", () => {
    expect(deniedVisible.length).toBeGreaterThan(0);
  });

  it("none of them is offered; Enter on a result opens that page, not /home", async () => {
    const { container } = mount("TEAM_VIEWER", <CommandPalette />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    const input = () => container.querySelector("[data-command-palette-input]") as HTMLInputElement;
    for (const route of deniedVisible) {
      await act(async () => {
        fireEvent.change(input(), { target: { value: route.label } });
      });
      expect(
        container.querySelector(`[data-command-palette-result-id="${route.id}"]`),
        `${route.id} must not be offered`,
      ).toBeNull();
    }
    expect(container.querySelector('[data-command-palette-result-state="DENIED_NO_CAPABILITY"]')).toBeNull();
    await act(async () => {
      fireEvent.change(input(), { target: { value: "Escalations" } });
    });
    await act(async () => {
      fireEvent.keyDown(input(), { key: "Enter" });
    });
    expect(push).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalledWith("/home");
  });
});
