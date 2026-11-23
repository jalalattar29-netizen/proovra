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
import { ReviewHubNav } from "../../components/reviewer-experience/ReviewHubNav";
import { reviewDestinationFromEnvelope } from "../../components/reviewer-experience/reviewDestination";
import { CommandPalette } from "../../components/navigation/CommandPalette";
import ReviewSettingsPage from "../../app/(app)/review/settings/page";
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
  "/review/queues": "workspace.review_queues",
  "/reviewer-ops/sla": "review.sla",
  "/reviewer-ops/escalations": "review.escalations",
  "/review/settings": "review.settings",
};

describe("ReviewHubNav — tabs per context", () => {
  it("a Team personal Owner sees all four tabs, and ?queue= is carried into Queues", async () => {
    mount("TEAM_OWNER", <ReviewHubNav active="my-reviews" />);
    await settle();
    expect(tabIds()).toEqual(["my-reviews", "queues", "monitoring", "settings"]);
    const queues = document.querySelector('[data-review-hub-tab="queues"]') as HTMLAnchorElement;
    expect(queues.getAttribute("href")).toBe("/review/queues?queue=ESCALATED");
    expect(document.querySelector('[data-review-hub-tab="my-reviews"]')!.getAttribute("aria-current")).toBe("page");
  });

  it("every rendered tab resolves ALLOWED — no tab opens a refusal", async () => {
    for (const p of ["TEAM_OWNER", "TEAM_VIEWER"] as const) {
      mount(p, <ReviewHubNav active="monitoring" monitoringView="escalations" />);
      await settle();
      const links = Array.from(
        document.querySelectorAll("[data-review-hub-tab], [data-review-hub-subtab]"),
      ) as HTMLAnchorElement[];
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

  it("the Monitoring tab offers SLA and Escalations sub-views", async () => {
    mount("TEAM_OWNER", <ReviewHubNav active="monitoring" monitoringView="escalations" />);
    await settle();
    const sub = Array.from(document.querySelectorAll("[data-review-hub-subtab]")).map((t) =>
      t.getAttribute("data-review-hub-subtab"),
    );
    expect(sub).toEqual(["sla", "escalations"]);
    expect(document.querySelector('[data-review-hub-subtab="escalations"]')!.getAttribute("aria-current")).toBe("page");
  });

  it("My reviews offers the Team advanced tools, each resolving ALLOWED (TEAM-SPEC R2)", async () => {
    mount("TEAM_OWNER", <ReviewHubNav active="my-reviews" />);
    await settle();
    const tools = Array.from(document.querySelectorAll("[data-review-hub-more-tool]")).map((a) =>
      a.getAttribute("href"),
    );
    expect(tools).toEqual(
      expect.arrayContaining(["/review/workspace", "/review/qc", "/review/disagreements", "/review/schemas"]),
    );
    const ids: Record<string, string> = {
      "/review/workspace": "workspace.review_workspace",
      "/review/qc": "workspace.review_qc",
      "/review/disagreements": "workspace.review_disagreements",
      "/review/metrics": "workspace.review_metrics",
      "/review/schemas": "workspace.coding_schemas",
      "/review/external": "workspace.review_external",
    };
    for (const href of tools) {
      const d = reviewDestinationFromEnvelope(ids[href!]!, envelope("TEAM_OWNER") as never, {
        workspace: { id: WS, status: "active" },
        personalSpace: { id: WS, status: "active" },
      });
      expect(d?.kind, href!).toBe("link");
    }
    cleanup();
    mount("TEAM_OWNER", <ReviewHubNav active="queues" />);
    await settle();
    expect(document.querySelector("[data-review-hub-more-tools]")).toBeNull();
  });

  it("a Pro personal owner sees no hub at all (no tab would open)", async () => {
    mount("PRO_OWNER", <ReviewHubNav active="my-reviews" />);
    await settle();
    expect(document.querySelector("[data-review-hub-nav]")).toBeNull();
  });

  it("a Team Viewer sees the four tabs (Review settings is readable)", async () => {
    mount("TEAM_VIEWER", <ReviewHubNav active="settings" />);
    await settle();
    expect(tabIds()).toEqual(["my-reviews", "queues", "monitoring", "settings"]);
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
