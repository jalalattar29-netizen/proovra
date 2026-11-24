/**
 * TEAM-SPEC §2 items 7–8 / §3 — the Monitoring pages read honestly.
 *
 * Escalations: the default filter is Active (`status=ACTIVE`), the empty copy
 * names the filter, the API `total` is shown ("Showing N of total"), and the
 * links go through reviewDestination (no `/reviewer-ops/policy`).
 *
 * SLA: a null compliance rate reads "No completed reviews in range" (never
 * 100%), a null mean / capacity reads "No data" (never 0 h), the by-stage
 * escalated row is "Escalated status (conflict or escalation)" (stage C T-057)
 * with open and finished reviews apart, and a failed dashboard
 * read shows an error with Retry instead of "Loading…" forever.
 *
 * Real pages, real apiFetch over a stubbed fetch, RTL cleanup().
 */
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let searchParams = new URLSearchParams("");
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => searchParams,
  usePathname: () => "/reviewer-ops/escalations",
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
import { NoEscalationsEmptyState } from "../../components/operational";
import EscalationsPage from "../../app/(app)/reviewer-ops/escalations/page";
import SlaPage from "../../app/(app)/reviewer-ops/sla/page";
import { setActiveWorkspaceId } from "../../lib/api";

const WS = "88888888-8888-4888-8888-888888888888";
const ESC = "e0000000-0000-4000-8000-000000000001";

type Responder = (path: string) => { status: number; body: unknown } | null;
let responder: Responder = () => null;
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  searchParams = new URLSearchParams("");
  setActiveWorkspaceId(WS);
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.push(path);
    const r = responder(path) ?? { status: 404, body: { error: { code: "not_found" } } };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

function envelope() {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {
      EVIDENCE_VIEW: true,
      EVIDENCE_MANAGE: true,
      REVIEWER_OPS_VIEW: true,
      REVIEWER_OPS_ACT: true,
      SLA_VIEW: true,
      ESCALATIONS_VIEW: true,
      REVIEW_ASSIGN: true,
      BULK_ACTIONS: true,
    },
    diagnostics: { requestId: "team-review-monitoring" },
    user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: null, displayName: null, firstName: null, lastName: null, avatarUrl: null, locale: null, timezone: null },
    workspace: { id: WS, name: "Personal Space", status: "active", scope: "PERSONAL", membership: { role: "OWNER" } },
    activeSpace: { type: "PERSONAL", id: WS, displayName: "Personal Space", roleLabel: "Owner" },
    personalSpace: { id: WS, status: "active" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
    },
    account: { accountPlan: "TEAM", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: { reviewerOperationsIncluded: true, reviewQueuesIncluded: true, externalReviewIncluded: true },
  };
}

async function settle() {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

function mount(node: React.ReactNode) {
  return render(
    <PlatformContextProvider testEnvelope={envelope() as never}>
      <ToastProvider>
        <ConfirmActionProvider>{node}</ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
}

function escalation(id: string, status: string) {
  return {
    id,
    teamId: WS,
    workflowId: "11111111-2222-4333-8444-555555555555",
    evidenceId: null,
    reason: "SLA_BREACH",
    severity: "HIGH",
    status,
    safeSummary: "Review passed its deadline",
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    acknowledgedAtUtc: null,
    resolvedAtUtc: null,
    resolutionNote: null,
    suppressedAtUtc: null,
    suppressionReason: null,
    assignedToUserId: null,
    incidentId: null,
  };
}

describe("Escalations page", () => {
  it("asks for status=ACTIVE by default and names the filter when empty", async () => {
    responder = (p) =>
      p.startsWith("/v1/reviewer-ops/escalations") ? { status: 200, body: { escalations: [], total: 0 } } : null;
    const view = mount(<EscalationsPage />);
    await settle();
    const list = calls.find((c) => c.startsWith("/v1/reviewer-ops/escalations?"));
    expect(list).toBeTruthy();
    expect(new URLSearchParams(list!.split("?")[1]).get("status")).toBe("ACTIVE");
    expect(view.getByText("No active escalations.")).toBeTruthy();
    // No worker jargon, no stale links.
    expect(document.body.textContent).not.toMatch(/reconciliation worker|BREACHED|Runtime dependency/i);
    expect(document.querySelector('a[href="/reviewer-ops/policy"]')).toBeNull();
    expect(document.querySelector('a[href="/reviewer-ops"]')).toBeNull();
  });

  it("shows the API total: Showing N of total", async () => {
    responder = (p) =>
      p.startsWith("/v1/reviewer-ops/escalations")
        ? {
            status: 200,
            body: {
              escalations: [escalation(ESC, "ACKNOWLEDGED"), escalation("e0000000-0000-4000-8000-000000000002", "OPEN")],
              total: 7,
            },
          }
        : null;
    mount(<EscalationsPage />);
    await settle();
    expect(document.querySelector("[data-escalations-count]")!.textContent).toBe(
      "Showing 2 of 7 escalations. Active means open, acknowledged or reassigned.",
    );
    // Human status labels, never raw enums.
    expect(document.body.textContent).toContain("Acknowledged");
    expect(document.body.textContent).not.toContain("ACKNOWLEDGED");
  });

  it("honours ?escalationId=: opens on All and highlights the linked row", async () => {
    searchParams = new URLSearchParams(`escalationId=${ESC}`);
    responder = (p) =>
      p.startsWith("/v1/reviewer-ops/escalations")
        ? { status: 200, body: { escalations: [escalation(ESC, "RESOLVED")], total: 1 } }
        : null;
    mount(<EscalationsPage />);
    await settle();
    const list = calls.find((c) => c.startsWith("/v1/reviewer-ops/escalations?"));
    expect(new URLSearchParams(list!.split("?")[1]).get("status")).toBe("ALL");
    expect(document.querySelector(`[data-escalation-row="${ESC}"]`)!.getAttribute("data-escalation-highlighted")).toBe("true");
  });

  // TEAM-UI-SPEC §1 / §4 (round 3).
  it("rows: canonical controls (secondary actions, Suppress as the danger entry point), compact mobile markup, no ui-button", async () => {
    responder = (p) =>
      p.startsWith("/v1/reviewer-ops/escalations")
        ? { status: 200, body: { escalations: [escalation(ESC, "OPEN")], total: 1 } }
        : null;
    mount(<EscalationsPage />);
    await settle();
    expect(document.querySelector(".ui-button")).toBeNull();
    const tr = document.querySelector(`[data-escalation-row="${ESC}"]`) as HTMLElement;
    expect(tr.tagName).toBe("TR");
    const table = tr.closest("table")!;
    expect(table.classList.contains("app-table")).toBe(true);
    expect(table.hasAttribute("data-responsive")).toBe(true);
    for (const cell of ["ref", "priority", "status", "due", "actions"]) {
      expect(tr.querySelector(`[data-review-cell="${cell}"]`), cell).not.toBeNull();
    }
    expect(tr.querySelector("[data-escalation-action-acknowledge]")!.className).toBe("app-secondary-action");
    expect(tr.querySelector("[data-escalation-action-reassign]")!.className).toBe("app-secondary-action");
    expect(tr.querySelector("[data-escalation-action-resolve]")!.className).toBe("app-secondary-action");
    expect(tr.querySelector("[data-escalation-action-suppress]")!.className).toBe(
      "app-secondary-action app-secondary-action--danger",
    );
    expect(tr.querySelectorAll(".app-primary-action").length).toBe(0);
    expect(tr.querySelector("[data-escalation-action-open]")!.className).toBe("app-ghost-action");
  });

  it("filter-aware empty copy for every filter", () => {
    const cases: Array<[Parameters<typeof NoEscalationsEmptyState>[0], string]> = [
      [{ filter: "OPEN" }, "No open escalations."],
      [{ filter: "ACKNOWLEDGED" }, "No acknowledged escalations."],
      [{ filter: "REASSIGNED" }, "No reassigned escalations."],
      [{ filter: "RESOLVED" }, "No resolved escalations."],
      [{ filter: "SUPPRESSED" }, "No suppressed escalations."],
      [{ filter: "ALL" }, "No escalations yet."],
      [{ filter: "ACTIVE", severityFiltered: true }, "No active escalations at this severity."],
    ];
    for (const [props, title] of cases) {
      const view = mount(<NoEscalationsEmptyState {...props} />);
      expect(view.getByText(title)).toBeTruthy();
      cleanup();
    }
  });
});

const DASHBOARD = {
  counts: { byStage: { QUEUED: 3, ESCALATED: 1, CLOSED: 1 }, overdue: 0, dueSoon: 1, unassigned: 3, assignedToMe: 0 },
  openEscalations: 1,
  criticalEscalationsOpen: 0,
  workloadTop: [],
  suggestions: [],
};

describe("SLA page", () => {
  it("renders nulls as 'No completed reviews in range' / 'No data', never 100% or 0 h", async () => {
    responder = (p) => {
      if (p.startsWith("/v1/reviewer-ops/dashboard")) return { status: 200, body: DASHBOARD };
      if (p.startsWith("/v1/reviewer-ops/analytics/escalations")) {
        return {
          status: 200,
          body: {
            range: { startUtc: "2026-11-09T00:00:00.000Z", endUtc: "2026-11-23T00:00:00.000Z" },
            totalOpen: 1,
            totalOpenedInRange: 1,
            totalResolvedInRange: 0,
            meanResolutionMs: null,
            byDay: [],
            hotspots: [],
          },
        };
      }
      if (p.startsWith("/v1/reviewer-ops/analytics/reviewers")) {
        return {
          status: 200,
          body: {
            range: { startUtc: "2026-11-09T00:00:00.000Z", endUtc: "2026-11-23T00:00:00.000Z" },
            rows: [
              {
                reviewerUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                active: 2,
                completedInRange: 0,
                approvedInRange: 0,
                rejectedInRange: 0,
                overdue: 0,
                escalated: 0,
                meanResolutionMs: null,
                slaComplianceRate: null,
                capacityScore: null,
              },
            ],
          },
        };
      }
      if (p.startsWith("/v1/reviewer-ops/reminders")) return { status: 200, body: { reminders: [] } };
      return null;
    };
    mount(<SlaPage />);
    await settle();
    const compliance = document.querySelector("[data-sla-compliance]")!;
    expect(compliance.getAttribute("data-sla-compliance")).toBe("none");
    expect(compliance.textContent).toBe("No completed reviews in range");
    expect(document.body.textContent).not.toMatch(/100%/);
    expect(document.body.textContent).toContain("No data");
    // The stored escalated stage, relabelled, with the definition of "open escalation".
    const stage = document.querySelector('[data-sla-stage="ESCALATED"]')!;
    // T-057 (stage C, COR-B) — the status also comes from a conflict or an
    // unresolved adjudication: never "manual decision".
    expect(stage.textContent).toBe("Escalated status (conflict or escalation)");
    expect(document.body.textContent).not.toMatch(/manual decision/i);
    // Open work and finished reviews are reported apart.
    expect(stage.closest("[data-sla-stage-section]")!.getAttribute("data-sla-stage-section")).toBe("open");
    const closed = document.querySelector('[data-sla-stage="CLOSED"]')!;
    expect(closed.closest("[data-sla-stage-section]")!.getAttribute("data-sla-stage-section")).toBe("closed");
    expect(stage.getAttribute("title")).toMatch(/open, acknowledged or reassigned/);
    expect(document.body.textContent).not.toMatch(/\bSla\b/);
    // TEAM-UI-SPEC §1 — panels and metric cards, no legacy button.
    expect(document.querySelector(".ui-button")).toBeNull();
    expect(document.querySelectorAll("section.app-panel").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".app-metric-card").length).toBeGreaterThan(0);
  });

  it("a failed dashboard read shows an error with Retry — not Loading… forever", async () => {
    let failures = 0;
    responder = (p) => {
      if (p.startsWith("/v1/reviewer-ops/dashboard")) {
        failures += 1;
        return failures === 1
          ? { status: 500, body: { error: { code: "INTERNAL_ERROR" } } }
          : { status: 200, body: DASHBOARD };
      }
      return null;
    };
    mount(<SlaPage />);
    await settle();
    expect(document.querySelector("[data-sla-dashboard-error]")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Loading SLA dashboard");
    await act(async () => {
      fireEvent.click(document.querySelector("[data-sla-dashboard-retry]")!);
    });
    await settle();
    expect(failures).toBe(2);
    expect(document.querySelector("[data-sla-dashboard-error]")).toBeNull();
    expect(document.body.textContent).toContain("Workspace pressure");
  });
});
