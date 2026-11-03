/**
 * Three surfaces asked the API for an action it gates on a fresh step-up and had
 * no way to answer: every API key and webhook action on Integrations, Save on the
 * SLA policy, and the SIU export and PII reveal. An owner met an alert or a generic
 * refusal and could never finish. The refusals below are the body the API sends,
 * through the real `apiFetch` over a stubbed network, except the SIU export, which
 * is a plain `fetch` because a success is a binary file.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const TEAM = "11111111-1111-4111-8111-111111111111";
const CASE = "22222222-2222-4222-8222-222222222222";

vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform-context")>()),
  useTeamId: () => "11111111-1111-4111-8111-111111111111",
  useActiveSpaceId: () => "11111111-1111-4111-8111-111111111111",
  useActiveSpace: () => ({ type: "ORGANIZATION", roleLabel: "OWNER" }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true }),
}));
vi.mock("../../app/(app)/integrations/_sections/EvidenceDeliveryHistorySection", () => ({
  EvidenceDeliveryHistorySection: () => null,
}));
vi.mock("../../app/(app)/governance/policy/_sections/WorkspaceGovernancePolicySection", () => ({
  WorkspaceGovernancePolicySection: () => null,
}));

import IntegrationsPage from "../../app/(app)/integrations/page";
import GovernancePolicyPage from "../../app/(app)/governance/policy/page";
import { SiuPanel } from "../../app/(app)/cases/components/SiuPanel";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stepUpRefusal = (purpose: string, resourceKind: string | null, resourceId: string | null) =>
  json(
    {
      error: {
        code: "STEP_UP_REQUIRED",
        message: "Step-up verification required.",
        details: { purpose, resourceKind, resourceId },
        purpose,
        resourceKind,
        resourceId,
      },
    },
    401,
  );

const fetchMock = vi.fn();
const alertMock = vi.fn();

const started = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).includes("/step-up/start"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

const calls = (fragment: string, method = "POST") =>
  fetchMock.mock.calls.filter(
    ([url, init]) => String(url).includes(fragment) && (init as RequestInit | undefined)?.method === method,
  );

function serve(routes: (url: string, init: RequestInit | undefined) => Response | undefined) {
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/step-up/start")) {
      return json({ challenge: { id: "33333333-3333-4333-8333-333333333333" }, method: "TOTP", availableMethods: ["TOTP"] });
    }
    return routes(url, init) ?? json({});
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  alertMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("alert", alertMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Integrations answers the step-up its API keys and webhooks ask for", () => {
  const integrationsReads = (url: string): Response | undefined => {
    if (url.includes("/v1/integrations/health")) return json({ error: { code: "unavailable", message: "unavailable" } }, 503);
    if (url.includes("/v1/integrations/diagnostics")) return json({ diagnostics: { enabled: true } });
    if (url.includes("/v1/integrations/api-keys")) return json({ apiKeys: [] });
    if (url.includes("/v1/integrations/webhooks")) return json({ webhooks: [] });
    return undefined;
  };

  it("creating a key opens the one step-up dialog, not an alert", async () => {
    serve((url, init) => {
      if (url.endsWith("/v1/integrations/api-keys") && init?.method === "POST") {
        return stepUpRefusal("INTEGRATION_API_KEY_CREATE", "api_credential", null);
      }
      return integrationsReads(url);
    });
    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "New API key" }));
    fireEvent.change(await screen.findByPlaceholderText("e.g. Production data sync"), { target: { value: "sync" } });
    const dialogButtons = screen.getAllByRole("button");
    fireEvent.click(dialogButtons[dialogButtons.length - 1]!);

    await screen.findByRole("dialog", { name: "Step-up confirmation" });
    await waitFor(() => expect(started()).toHaveLength(1));
    expect(started()[0]).toMatchObject({ teamId: TEAM, purpose: "INTEGRATION_API_KEY_CREATE" });
    expect(alertMock).not.toHaveBeenCalled();
    expect(calls("/v1/integrations/api-keys")).toHaveLength(1);
  });
});

describe("the SLA policy page answers the step-up its Save asks for", () => {
  it("saving opens the step-up dialog, bound to the policy resource", async () => {
    serve((url, init) => {
      if (url.includes("/v1/reviewer-ops/sla-policy") && init?.method === "POST") {
        return stepUpRefusal("GOVERNANCE_POLICY_UPDATE", "workspace_reviewer_ops_policy", TEAM);
      }
      if (url.includes("/v1/reviewer-ops/sla-policy")) {
        const hours = { assignmentHours: 1, firstReviewHours: 1, completionHours: 1, escalationHours: 1, dueSoonHours: 1 };
        return json({
          policy: { policy: hours, sources: { template: {}, workspace: {}, env: {} } },
          flags: {
            requireStepUpForApprove: false,
            requireStepUpForReject: false,
            requireStepUpForEscalationResolve: false,
            requireStepUpForBulk: false,
          },
        });
      }
      return undefined;
    });
    render(<GovernancePolicyPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Save policy" }));
    await screen.findByRole("dialog", { name: "Step-up confirmation" });
    await waitFor(() => expect(started()).toHaveLength(1));
    expect(started()[0]).toMatchObject({
      teamId: TEAM,
      purpose: "GOVERNANCE_POLICY_UPDATE",
      resourceKind: "workspace_reviewer_ops_policy",
      resourceId: TEAM,
    });
  });
});

describe("the SIU panel answers the step-up its export and reveal ask for", () => {
  const profile = {
    id: "p",
    claimType: "auto",
    claimantName: "â€¢â€¢â€¢â€¢",
    claimantContact: null,
    privacyGatedFieldsExposed: false,
    checklist: [],
    reviewIndicators: [],
    followUps: [],
  };
  const reads = (url: string): Response | undefined => {
    if (url.includes("/siu-exports")) return json({ exports: [] });
    if (url.includes("/siu-export/preflight")) {
      return json({ preflight: { readiness: "ready", totals: { blockers: 0, warnings: 0 }, findings: [] } });
    }
    if (url.includes("/siu-profile/reveal-pii")) {
      return stepUpRefusal("SIU_PII_REVEAL", "case", CASE);
    }
    if (url.includes("/siu-profile")) return json({ profile });
    return undefined;
  };

  it("a reveal opens the step-up dialog on the workspace of the case", async () => {
    serve(reads);
    render(<SiuPanel caseId={CASE} teamId={TEAM} />);
    fireEvent.click(await screen.findByTestId("siu-reveal-pii-button"));
    await screen.findByRole("dialog", { name: "Step-up confirmation" });
    await waitFor(() => expect(started()).toHaveLength(1));
    expect(started()[0]).toMatchObject({ teamId: TEAM, purpose: "SIU_PII_REVEAL", resourceKind: "case", resourceId: CASE });
    expect(screen.queryByTestId("siu-error")).toBeNull();
  });

  it("an export refused for step-up opens the dialog rather than saying refused", async () => {
    serve((url, init) => {
      if (url.endsWith("/siu-export") && init?.method === "POST") {
        return stepUpRefusal("SIU_EXPORT_GENERATE", "case", CASE);
      }
      return reads(url);
    });
    render(<SiuPanel caseId={CASE} teamId={TEAM} />);
    fireEvent.click(await screen.findByTestId("siu-preflight-button"));
    await waitFor(() => expect((screen.getByTestId("siu-export-button") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("siu-export-button"));
    await screen.findByRole("dialog", { name: "Step-up confirmation" });
    await waitFor(() => expect(started()).toHaveLength(1));
    expect(started()[0]).toMatchObject({ teamId: TEAM, purpose: "SIU_EXPORT_GENERATE", resourceId: CASE });
    expect(screen.queryByTestId("siu-error")).toBeNull();
  });
});
