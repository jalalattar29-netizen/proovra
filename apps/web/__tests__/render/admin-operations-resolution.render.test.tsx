/**
 * PV-OPS-001 — /admin/operations renders the resolution decision it is given.
 *
 *   * a NO_DIRECT_RESOLUTION condition offers no working Resolve: the control
 *     is disabled and states why (disabledReason -> aria-describedby + title);
 *   * an operator decision that requires a written conclusion collects it
 *     BEFORE posting, and posts it as the `note` the route accepts;
 *   * a SOURCE_TRUTH condition keeps a working Resolve (the server re-checks).
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";

type Posted = { path: string; body: unknown };
let posted: Posted[] = [];

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NOW = "2026-09-10T12:00:00.000Z";

function incident(id: string, title: string, lifecycle: Record<string, unknown>) {
  return {
    id,
    teamId: WS,
    scope: "WORKSPACE",
    category: "REPORT",
    severity: "HIGH",
    status: "OPEN",
    title,
    safeSummary: `${title} summary`,
    occurrenceCount: 1,
    firstSeenAtUtc: NOW,
    lastSeenAtUtc: NOW,
    acknowledgedAtUtc: null,
    resolvedAtUtc: null,
    assignedOperatorUserId: null,
    runbookSlug: null,
    relatedEvidenceId: null,
    relatedJobId: null,
    relatedProvider: null,
    affected: null,
    lifecycle,
  };
}

const ROWS = [
  incident("inc-nodirect", "Worker heartbeat stale", {
    resolutionAuthority: "NO_DIRECT_RESOLUTION",
    resolvableByOperator: false,
    refusalCode: "CONDITION_NOT_DIRECTLY_RESOLVABLE",
    requiresResolutionNote: false,
  }),
  incident("inc-decision", "Review escalation storm", {
    resolutionAuthority: "OPERATOR_DECISION",
    resolvableByOperator: true,
    refusalCode: "RESOLUTION_NOTE_REQUIRED",
    requiresResolutionNote: true,
  }),
  incident("inc-source", "Trusted timestamping failed", {
    resolutionAuthority: "SOURCE_TRUTH",
    resolvableByOperator: true,
    refusalCode: "CONDITION_STILL_ACTIVE",
    requiresResolutionNote: false,
  }),
];

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      posted.push({ path, body: init.body ? JSON.parse(init.body) : null });
      return { incident: {} };
    }
    if (path.startsWith("/v1/admin/incidents")) {
      // The response shape the page reads (IncidentsResponse).
      return {
        items: ROWS,
        severityBreakdown: { CRITICAL: 0, HIGH: ROWS.length, WARNING: 0, INFO: 0 },
        statusBreakdown: { OPEN: ROWS.length },
        unresolvedCount: ROWS.length,
        totalIncidents: ROWS.length,
      };
    }
    if (path.startsWith("/v1/admin/security-events")) {
      return { items: [], nextCursor: null, hasMore: false };
    }
    return {};
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/admin/operations",
  useParams: () => ({}),
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import AdminOperationsPage from "../../app/(app)/admin/operations/page";

const envelope = {
  authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
  capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
  navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
  capabilities: {},
  diagnostics: { requestId: "test" },
  workspace: { id: WS, name: "Platform", status: "active", scope: "TEAM" },
  activeSpace: { type: "TEAM", id: WS, displayName: "Platform", roleLabel: "Admin" },
  contextOptions: {
    personalSpace: null,
    ownedWorkspaces: [],
    organizations: [],
    activeContext: { workspaceId: WS, kind: "ORGANIZATION", organizationId: null, displayName: "Platform" },
  },
  account: { userId: ME, accountPlan: "PRO", accountStatus: "active" },
  user: { id: ME },
  flags: { isEnterpriseWorkspace: false },
  platform: { isPlatformAdmin: true },
};

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function mount() {
  cleanup();
  render(
    <PlatformContextProvider testEnvelope={envelope as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <AdminOperationsPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
}

const resolveButton = (id: string) =>
  document.querySelector<HTMLButtonElement>(`[data-incident-resolve="${id}"]`);

describe("PV-OPS-001 — the queue renders the resolution decision", () => {
  beforeEach(() => {
    posted = [];
  });

  it("a condition nobody may close by hand has a disabled Resolve that says why", async () => {
    await mount();
    const btn = resolveButton("inc-nodirect");
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(true);
    expect(btn!.getAttribute("data-disabled-reason")).toMatch(/cannot be resolved by hand/i);
    const describedBy = btn!.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/cannot be resolved by hand/i);
  });

  it("an operator decision that needs a conclusion collects it first and posts it as the note", async () => {
    await mount();
    const btn = resolveButton("inc-decision");
    expect(btn!.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(btn!);
    });
    await settle();
    const panel = document.querySelector('[data-incident-resolution-note="inc-decision"]');
    expect(panel).toBeTruthy();
    // Nothing is posted until there is a conclusion — and the submit says so.
    const submit = screen.getByText("Resolve with this conclusion").closest("button")!;
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute("data-disabled-reason")).toMatch(/conclusion/i);
    expect(posted).toEqual([]);

    fireEvent.change(screen.getByLabelText(/Why is/), {
      target: { value: "Escalations drained after the reviewer rota change." },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Resolve with this conclusion").closest("button")!);
    });
    await settle();
    expect(posted).toEqual([
      {
        path: "/v1/admin/incidents/inc-decision/resolve",
        body: { note: "Escalations drained after the reviewer rota change." },
      },
    ]);
  });

  it("a source-truth condition keeps a working Resolve (the server re-checks its source)", async () => {
    await mount();
    const btn = resolveButton("inc-source");
    expect(btn!.disabled).toBe(false);
    expect(btn!.getAttribute("data-disabled-reason")).toBeNull();
  });
});
