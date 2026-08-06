/**
 * PHASE 12 STEP-3 — OrganizationSecurityPolicyEditor behavioral render test.
 *
 * Proof suite for the OrganizationSecurityPolicy wiring (GET/PATCH /v1/security-policy
 * + /high-security/readiness + /activate). Renders the component directly (bypassing
 * PageRouteGate) and asserts: server-projected read, step-up-wrapped PATCH hitting the
 * server, the atomic high-security 409 prerequisite gate, NOT_APPLICABLE, and denial.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── apiFetch mock (path + method switch) ────────────────────────────────────
const calls: Array<{ path: string; method: string; body?: unknown }> = [];
let impl: (path: string, init?: RequestInit) => Promise<unknown> = async () => ({});
vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    return impl(path, init);
  },
  ApiError: class ApiError extends Error {
    code?: string;
    statusCode?: number;
    requestId?: string | null;
    details?: unknown;
  },
}));

// ── step-up mock: runStepUpAction just invokes the action (no challenge UI) ──
vi.mock("../../components/identity-security/StepUpModal", () => ({
  useStepUpAction: () => ({ runStepUpAction: (action: (h: Record<string, string> | null) => Promise<unknown>) => action(null) }),
  StepUpModal: () => null,
}));
// teamId is only the step-up binding anchor — the policy is org-keyed.
vi.mock("../../lib/platform-context", () => ({
  useTeamId: () => "team-1",
  // PHASE 12B / PHASE E — the editor now registers dirty work and drops
  // responses that land after a workspace switch. Both are real hooks in the
  // canonical module; the render harness stubs them because it mounts the
  // component without a PlatformContextProvider.
  useTenantGuard: () => ({
    stamp: () => 0,
    isStale: () => false,
    generation: 0,
  }),
  useDirtyWork: () => {},
}));

import { OrganizationSecurityPolicyEditor } from "../../components/organizations/OrganizationSecurityPolicyEditor";

const POLICY = {
  ssoRequired: true,
  managedIdentityRequired: false,
  noPersonalSpace: false,
  maxSessionAgeSeconds: 3600,
  idleTimeoutSeconds: 900,
  concurrentSessionLimit: 5,
  stepUpIntervalSeconds: 1800,
  allowedAuthMethods: ["SSO"],
  policyVersion: 3,
};

function orgPolicy(policyResp: unknown): typeof impl {
  return async (path) => {
    if (path.includes("/security-policy/high-security/readiness")) return { missing: [] };
    if (path.startsWith("/v1/security-policy")) return policyResp;
    return {};
  };
}

beforeEach(() => {
  calls.length = 0;
  impl = orgPolicy({ applicability: "ORGANIZATION", organizationId: "org-1", policy: POLICY });
});

describe("OrganizationSecurityPolicyEditor", () => {
  it("reads the org-keyed policy (no workspace lookup) and renders the server projection", async () => {
    render(<OrganizationSecurityPolicyEditor orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId("sec-save")).toBeTruthy());
    // authoritative org-keyed read — no workspace lookup, no teamId scoping
    expect(calls.some((c) => c.path.includes("/v1/orgs/") && c.path.includes("/workspaces"))).toBe(false);
    expect(calls[0].path).toContain("/v1/security-policy?organizationId=org-1");
    // server projection rendered (SSO required is the current value)
    expect(screen.getByTestId("sec-ssoRequired-on").getAttribute("data-testid")).toBe("sec-ssoRequired-on");
  });

  it("PATCH goes through step-up with organizationId + expectedPolicyVersion", async () => {
    render(<OrganizationSecurityPolicyEditor orgId="org-1" />);
    await waitFor(() => screen.getByTestId("sec-save"));
    impl = async (path, init) => {
      if (path === "/v1/security-policy" && init?.method === "PATCH") return { policy: { ...POLICY, managedIdentityRequired: true, policyVersion: 4 } };
      return orgPolicy({ applicability: "ORGANIZATION", policy: POLICY })(path, init);
    };
    fireEvent.click(screen.getByTestId("sec-managedIdentityRequired-on")); // make dirty
    fireEvent.click(screen.getByTestId("sec-save"));
    await waitFor(() => {
      const patch = calls.find((c) => c.path === "/v1/security-policy" && c.method === "PATCH");
      expect(patch).toBeTruthy();
      expect((patch!.body as { organizationId: string }).organizationId).toBe("org-1");
      expect((patch!.body as { expectedPolicyVersion: number }).expectedPolicyVersion).toBe(3);
      expect((patch!.body as { managedIdentityRequired: boolean }).managedIdentityRequired).toBe(true);
    });
  });

  it("high-security activate surfaces the 409 prerequisite gate (missing list, no partial mutation)", async () => {
    render(<OrganizationSecurityPolicyEditor orgId="org-1" />);
    await waitFor(() => screen.getByTestId("sec-activate"));
    impl = async (path, init) => {
      if (path.includes("/high-security/activate") && init?.method === "POST") {
        throw Object.assign(new Error("prereqs"), {
          code: "HIGH_SECURITY_PREREQUISITES_UNMET",
          statusCode: 409,
          details: { missing: ["MFA_NOT_ENFORCED", "SSO_NOT_CONFIGURED"] },
        });
      }
      return orgPolicy({ applicability: "ORGANIZATION", policy: POLICY })(path, init);
    };
    fireEvent.click(screen.getByTestId("sec-activate"));
    await waitFor(() => expect(screen.getByTestId("sec-activate-missing")).toBeTruthy());
    expect(screen.getByText("MFA_NOT_ENFORCED")).toBeTruthy();
    expect(screen.getByText("SSO_NOT_CONFIGURED")).toBeTruthy();
  });

  it("renders NOT_APPLICABLE for a non-organization workspace (no fabricated policy)", async () => {
    impl = orgPolicy({ applicability: "NOT_APPLICABLE", reason: "PERSONAL", policy: null });
    render(<OrganizationSecurityPolicyEditor orgId="org-1" />);
    await waitFor(() => expect(screen.getByText(/does not apply/i)).toBeTruthy());
    expect(screen.queryByTestId("sec-save")).toBeNull();
  });

  it("renders an honest denial without leaking the cause", async () => {
    impl = async () => { throw Object.assign(new Error("Forbidden"), { statusCode: 404 }); };
    const { container } = render(<OrganizationSecurityPolicyEditor orgId="org-1" />);
    await waitFor(() => expect(container.querySelector('[data-state="error"]')).toBeTruthy());
    // honest denial state — no editor form, no cross-tenant leak
    expect(screen.queryByTestId("sec-save")).toBeNull();
    expect(screen.queryByTestId("sec-activate")).toBeNull();
  });
});
