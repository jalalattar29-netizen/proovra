/**
 * THIRD RE-AUDIT T-3 — the policy-authoring form gates on the permission the
 * route asks for.
 *
 * POST /v1/governance/policies requires `governance.policy.author` (the N-1
 * delegated-administration floor: no workspace role but the OWNER holds it; a
 * member reaches it through a capability grant). The form mirrored the old
 * `governance.policy.manage`, which every workspace ADMIN holds by role: an
 * ADMIN saw an enabled form the server refused with 403 PERMISSION_REQUIRED,
 * and a grant holder without the role permission saw it disabled.
 *
 * Renders the REAL GovernancePolicyForm with the REAL permission mirror
 * (useWorkspacePermissionAccess); only the HTTP layer and the platform context
 * are faked.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const ME = "99999999-9999-4999-8999-999999999999";

const mocks = vi.hoisted(() => ({
  guard: { stamp: () => 0, isStale: (_g: number) => false, generation: 0 },
  fetch: vi.fn(),
  roleLabel: "ADMIN" as string | null,
}));

vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/platform-context", () => ({
  usePlatformContext: () => ({
    envelope: {
      user: { id: "99999999-9999-4999-8999-999999999999" },
      activeSpace: { type: "ORGANIZATION", id: "team-1", roleLabel: mocks.roleLabel },
    },
  }),
  useTenantGuard: () => mocks.guard,
}));

import { GovernancePolicyForm } from "../../components/governance/GovernancePolicyForm";

function roster(capabilityGrants: Array<{ permission: string }>) {
  return {
    members: [
      {
        userId: ME,
        status: "ACTIVE",
        capabilityGrants: capabilityGrants.map((g) => ({ ...g, expiresAtUtc: null, revokedAtUtc: null })),
        delegatedAdminScopes: [],
      },
    ],
  };
}

async function renderForm(): Promise<{ submit: HTMLButtonElement; container: HTMLElement }> {
  const { container } = render(<GovernancePolicyForm onCreated={() => {}} />);
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith("/v1/identity/members", { method: "GET" }));
  // The mirror has resolved once the "Checking your permissions…" note is gone.
  await waitFor(() => expect(container.textContent).not.toContain("Checking your permissions"));
  const submit = container.querySelector("[data-governance-policy-submit]") as HTMLButtonElement;
  expect(submit).not.toBeNull();
  return { submit, container };
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.roleLabel = "ADMIN";
});
afterEach(cleanup);

describe("T-3 — GovernancePolicyForm gates on governance.policy.author", () => {
  it("a workspace ADMIN without the delegated permission sees the form disabled, with the reason", async () => {
    mocks.fetch.mockResolvedValue(roster([]));
    const { submit, container } = await renderForm();
    expect(submit.disabled).toBe(true);
    const blocked = container.querySelector("[data-governance-policy-blocked='permission']");
    expect(blocked).not.toBeNull();
    expect(blocked!.textContent).toContain("Author governance policies");
  });

  it("an ADMIN holding only the retired governance.policy.manage as a grant is still disabled", async () => {
    mocks.fetch.mockResolvedValue(roster([{ permission: "governance.policy.manage" }]));
    const { submit } = await renderForm();
    expect(submit.disabled).toBe(true);
  });

  it("a MEMBER holding a governance.policy.author grant sees it enabled", async () => {
    mocks.roleLabel = "MEMBER";
    mocks.fetch.mockResolvedValue(roster([{ permission: "governance.policy.author" }]));
    const { submit, container } = await renderForm();
    expect(submit.disabled).toBe(false);
    expect(container.querySelector("[data-governance-policy-blocked='permission']")).toBeNull();
  });

  it("the OWNER (who holds every non-service permission) sees it enabled", async () => {
    mocks.roleLabel = "OWNER";
    mocks.fetch.mockResolvedValue(roster([]));
    const { submit } = await renderForm();
    expect(submit.disabled).toBe(false);
  });
});
