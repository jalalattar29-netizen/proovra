/**
 * ONE delegated-administration authority — the client permission mirror.
 *
 * components/governance/governance-action-state.ts `useWorkspacePermissionAccess`
 * replaced the tier mirror (which read the now-410 GET
 * /v1/governance/delegated-admin). It mirrors the permission engine from
 * sources the console already reads: the active space's role (platform
 * context) through the shared role matrix, plus the caller's own live
 * capability grants and delegated scopes from GET /v1/identity/members.
 * It disables a control only on a CONFIRMED gap; an unreadable roster leaves
 * the decision to the server.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const ME = "99999999-9999-4999-8999-999999999999";
const DAY = 24 * 60 * 60 * 1000;

const mocks = vi.hoisted(() => ({
  // Stable like the real hook (useCallback): a fresh pair per render would
  // re-run every effect keyed on it.
  guard: { stamp: () => 0, isStale: (_g: number) => false, generation: 0 },
  fetch: vi.fn(),
  roleLabel: "MEMBER" as string | null,
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

import {
  useWorkspacePermissionAccess,
  type PermissionVerdict,
} from "../../components/governance/governance-action-state";

const PROBES = [
  "governance.policy.manage",
  "governance.exchange.manage",
  "identity.access_review.action",
  "billing.manage",
] as const;

let seen: { ready: boolean; verdicts: Record<string, PermissionVerdict> } | null = null;

function Probe() {
  const access = useWorkspacePermissionAccess();
  seen = {
    ready: access.ready,
    verdicts: Object.fromEntries(PROBES.map((p) => [p, access.verdict(p)])),
  };
  return null;
}

function me(extra: Record<string, unknown>) {
  return {
    members: [
      { userId: "someone-else", status: "ACTIVE", capabilityGrants: [], delegatedAdminScopes: [{ scopeKind: "IDENTITY_ADMIN", expiresAtUtc: null, revokedAtUtc: null }] },
      { userId: ME, status: "ACTIVE", capabilityGrants: [], delegatedAdminScopes: [], ...extra },
    ],
  };
}

async function verdicts() {
  render(<Probe />);
  await waitFor(() => expect(seen?.ready).toBe(true));
  return seen!.verdicts;
}

beforeEach(() => {
  seen = null;
  mocks.roleLabel = "MEMBER";
  mocks.fetch.mockReset();
});
afterEach(cleanup);

describe("useWorkspacePermissionAccess", () => {
  it("never reads the retired tier endpoint", async () => {
    mocks.fetch.mockResolvedValue(me({}));
    await verdicts();
    expect(mocks.fetch.mock.calls.map(([p]) => p)).toEqual(["/v1/identity/members"]);
  });

  it("grants what the caller's role grants, through the shared role matrix", async () => {
    mocks.roleLabel = "OWNER";
    mocks.fetch.mockResolvedValue(me({}));
    const v = await verdicts();
    expect(v["governance.policy.manage"]).toBe("granted");
    expect(v["billing.manage"]).toBe("granted");
  });

  it("grants a delegated scope's permissions to its holder only, and reports the rest missing", async () => {
    mocks.fetch.mockResolvedValue(
      me({ delegatedAdminScopes: [{ scopeKind: "GOVERNANCE_ADMIN", expiresAtUtc: null, revokedAtUtc: null }] }),
    );
    const v = await verdicts();
    expect(v["governance.policy.manage"]).toBe("granted");
    // Another member's IDENTITY_ADMIN scope is not the caller's.
    expect(v["identity.access_review.action"]).toBe("missing");
    expect(v["billing.manage"]).toBe("missing");
  });

  it("ignores revoked and expired scopes and grants", async () => {
    mocks.fetch.mockResolvedValue(
      me({
        delegatedAdminScopes: [
          { scopeKind: "GOVERNANCE_ADMIN", expiresAtUtc: new Date(Date.now() - DAY).toISOString(), revokedAtUtc: null },
          { scopeKind: "IDENTITY_ADMIN", expiresAtUtc: null, revokedAtUtc: new Date(Date.now() - DAY).toISOString() },
        ],
        capabilityGrants: [
          { permission: "governance.exchange.manage", expiresAtUtc: new Date(Date.now() + DAY).toISOString(), revokedAtUtc: null },
        ],
      }),
    );
    const v = await verdicts();
    expect(v["governance.policy.manage"]).toBe("missing");
    expect(v["identity.access_review.action"]).toBe("missing");
    // A live capability grant counts.
    expect(v["governance.exchange.manage"]).toBe("granted");
  });

  it("leaves the decision to the server when the caller's own grants cannot be read", async () => {
    mocks.fetch.mockRejectedValue(Object.assign(new Error("denied"), { statusCode: 403 }));
    const v = await verdicts();
    expect(v["governance.policy.manage"]).toBe("unknown");
  });
});
