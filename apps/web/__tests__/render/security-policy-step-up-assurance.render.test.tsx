/**
 * 2026-10-28 — the Organization security policy editor's STEP-UP ASSURANCE
 * fields, through the rendered component: the server projection is shown, an
 * edit of each field reaches the step-up-gated PATCH with the right shape, and
 * the accepted-contexts list is one value per line (blank lines dropped).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
let patchResponse: unknown = null;
vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    if (path.includes("/high-security/readiness")) return { missing: [] };
    if (path === "/v1/security-policy" && init?.method === "PATCH") return patchResponse;
    if (path.startsWith("/v1/security-policy")) {
      return { applicability: "ORGANIZATION", organizationId: "org-1", policy: POLICY };
    }
    return {};
  },
  ApiError: class ApiError extends Error {
    requestId?: string | null;
  },
}));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  useStepUpAction: () => ({
    runStepUpAction: (action: (h: Record<string, string> | null) => Promise<unknown>) => action(null),
  }),
  StepUpModal: () => null,
}));
vi.mock("../../lib/platform-context", () => ({
  useTeamId: () => "team-1",
  useTenantGuard: () => ({ stamp: () => 0, isStale: () => false, generation: 0 }),
  useDirtyWork: () => {},
}));

import { OrganizationSecurityPolicyEditor } from "../../components/organizations/OrganizationSecurityPolicyEditor";

const POLICY = {
  ssoRequired: false,
  allowedAuthMethods: [],
  policyVersion: 7,
  stepUpAssurance: "STANDARD",
  stepUpSmsAllowed: true,
  idpStepUpAcceptedContexts: ["urn:oasis:names:tc:SAML:2.0:ac:classes:X509"],
  idpStepUpMaxAgeSeconds: 300,
};

beforeEach(() => {
  calls.length = 0;
  patchResponse = { policy: { ...POLICY, policyVersion: 8 } };
});
afterEach(() => cleanup());

const patchBody = () =>
  calls.find((c) => c.path === "/v1/security-policy" && c.method === "PATCH")?.body as
    | Record<string, unknown>
    | undefined;

describe("Organization security policy — step-up assurance", () => {
  it("shows the four fields with their labels and the server's values", async () => {
    render(<OrganizationSecurityPolicyEditor orgId="org-1" />);
    await waitFor(() => screen.getByTestId("sec-save"));
    expect(screen.getByText("Step-up assurance")).toBeTruthy();
    expect(screen.getByText("Allow SMS codes for step-up")).toBeTruthy();
    expect(screen.getByText("Accepted IdP authentication contexts")).toBeTruthy();
    expect(screen.getByText(/Maximum IdP sign-in age/)).toBeTruthy();
    expect(screen.getByTestId("sec-stepUpAssurance-STANDARD").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("sec-stepUpSmsAllowed-on").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByTestId("sec-idpStepUpAcceptedContexts") as HTMLTextAreaElement).value).toBe(
      "urn:oasis:names:tc:SAML:2.0:ac:classes:X509",
    );
    expect((screen.getByTestId("sec-idpStepUpMaxAgeSeconds") as HTMLInputElement).value).toBe("300");
  });

  it("sends the edited assurance, SMS rule, contexts and max age through the step-up PATCH", async () => {
    render(<OrganizationSecurityPolicyEditor orgId="org-1" />);
    await waitFor(() => screen.getByTestId("sec-save"));
    fireEvent.click(screen.getByTestId("sec-stepUpAssurance-PHISHING_RESISTANT"));
    fireEvent.click(screen.getByTestId("sec-stepUpSmsAllowed-off"));
    fireEvent.change(screen.getByTestId("sec-idpStepUpAcceptedContexts"), {
      target: { value: "  urn:x:mfa  \n\nphr\n" },
    });
    fireEvent.change(screen.getByTestId("sec-idpStepUpMaxAgeSeconds"), { target: { value: "120" } });
    fireEvent.click(screen.getByTestId("sec-save"));
    await waitFor(() => expect(patchBody()).toBeTruthy());
    const body = patchBody()!;
    expect(body.organizationId).toBe("org-1");
    expect(body.expectedPolicyVersion).toBe(7);
    expect(body.stepUpAssurance).toBe("PHISHING_RESISTANT");
    expect(body.stepUpSmsAllowed).toBe(false);
    expect(body.idpStepUpAcceptedContexts).toEqual(["urn:x:mfa", "phr"]);
    expect(body.idpStepUpMaxAgeSeconds).toBe(120);
    await waitFor(() => expect(screen.getByText("Security policy updated.")).toBeTruthy());
  });
});
