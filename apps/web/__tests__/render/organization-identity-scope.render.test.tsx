/**
 * Members audit DOM-13 — SSO and SCIM are ORGANIZATION-scoped, driven for real.
 *
 * Mounts the real SCIM console and the real SSO connections section against
 * contract-shaped fixtures (the apiFetch seam) and proves:
 *
 *   Directory groups (app/(app)/security-center/identity/scim, "Directory
 *   groups" tab):
 *     - every group of the Organization renders with its workspace
 *       projections: workspace name, role, status;
 *     - "Apply to a workspace" sends the EXACT POST body, and the retried call
 *       carries the step-up challenge header;
 *     - "End" confirms, then sends DELETE with { teamId } under step-up;
 *     - a 409 SCIM_GROUP_PROJECTION_EXISTS reads in its registered copy;
 *     - a viewer without an Organization identity role sees the controls
 *       disabled, with the reason.
 *
 *   SSO connections (IdentityProvidersSection):
 *     - a 403 ORGANIZATION_IDENTITY_ADMIN_REQUIRED on a provider action reads
 *       in its registered copy, not as a read denial;
 *     - SSO_CONNECTION_EXISTS on activation says what to do;
 *     - a SUSPENDED connection is labelled and offers Revoke only.
 *
 * Copy is asserted against USER_FACING_ERRORS, the one registered source, so
 * this file holds no second copy of it.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act, cleanup, fireEvent } from "@testing-library/react";
import { USER_FACING_ERRORS } from "@proovra/shared/user-facing-errors";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type Reply = unknown;
type Logged = {
  path: string;
  method: string;
  body?: unknown;
  headers: Record<string, string>;
};

const STEP_UP_HEADER = "x-proovra-step-up-challenge-id";
const CHALLENGE = "challenge-1";

let requestLog: Logged[] = [];
let getReply: (path: string) => Reply = () => {
  throw new Error("no GET fixture installed");
};
let writeReply: (path: string, method: string, body: unknown) => Reply = () => ({});

function apiFailure(statusCode: number, code?: string): Error {
  const err = new Error("request failed") as Error & { statusCode: number; code?: string };
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (
    path: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ) => {
    const method = init?.method ?? "GET";
    const headers = { ...(init?.headers ?? {}) };
    const body = init?.body ? JSON.parse(init.body) : undefined;
    requestLog.push({ path, method, body, headers });
    if (method !== "GET" && !headers[STEP_UP_HEADER]) {
      // Every write under test is step-up gated: the first, unelevated call
      // is refused exactly as the middleware refuses it.
      const err = apiFailure(401, "STEP_UP_REQUIRED") as Error & { details?: unknown };
      err.details = { purpose: "EXTERNAL_IDENTITY_LINK", resourceKind: "scim_provisioning_token" };
      throw err;
    }
    const reply = method === "GET" ? getReply(path) : writeReply(path, method, body);
    if (reply instanceof Error) throw reply;
    return reply;
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  setApiToken: () => {},
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/security-center/identity/scim",
  useParams: () => ({}),
}));

const WS = "11111111-1111-4111-8111-111111111111";
const ORG = "99999999-9999-4999-8999-999999999999";
let activeOrganizationId: string | null = ORG;

vi.mock("../../lib/platform-context", () => {
  const tenantGuard = { stamp: () => 1, isStale: () => false };
  return {
    useTeamId: () => WS,
    useActiveWorkspaceId: () => WS,
    useTenantGuard: () => tenantGuard,
    useActiveCustomerOrganizationId: () => activeOrganizationId,
  };
});

// Step-up, reduced to its contract: run the action; on STEP_UP_REQUIRED, run
// it ONCE more with the challenge header — what the real hook does after the
// operator verifies. The ceremony itself has its own suite.
vi.mock("../../components/identity-security/StepUpModal", () => {
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => {
      try {
        return await fn();
      } catch (err) {
        if ((err as { code?: string }).code !== "STEP_UP_REQUIRED") throw err;
        return fn({ [STEP_UP_HEADER]: CHALLENGE });
      }
    },
    cancel: () => {},
    closeIdle: () => {},
    startChallenge: async () => {},
  };
  return {
    useStepUpAction: () => control,
    StepUpModal: () => null,
  };
});

import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import ScimPage from "../../app/(app)/security-center/identity/scim/page";
import { IdentityProvidersSection } from "../../app/(app)/security-center/sso/_sections/IdentityProvidersSection";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(node: React.ReactElement) {
  cleanup();
  const utils = render(
    <ToastProvider>
      <ConfirmActionProvider>{node}</ConfirmActionProvider>
    </ToastProvider>,
  );
  await settle();
  return utils;
}

const writes = (method: string, prefix: string) =>
  requestLog.filter((r) => r.method === method && r.path.startsWith(prefix));
const gets = (prefix: string) =>
  requestLog.filter((r) => r.method === "GET" && r.path.startsWith(prefix));

beforeEach(() => {
  requestLog = [];
  activeOrganizationId = ORG;
  writeReply = () => ({});
});

// ===========================================================================
// SCIM — Directory groups
// ===========================================================================

const GROUPS = {
  groups: [
    {
      id: "g1",
      displayName: "Legal Ops",
      externalId: "okta-legal",
      mappedRole: "MEMBER",
      status: "ACTIVE",
      projections: [
        { id: "p1", workspaceId: WS, workspaceName: "Field Investigations", mappedRole: "ADMIN", status: "ACTIVE" },
        { id: "p0", workspaceId: "ws-old", workspaceName: "Closed Matter", mappedRole: "VIEWER", status: "ARCHIVED" },
      ],
    },
    {
      id: "g2",
      displayName: "Contractors",
      externalId: null,
      mappedRole: "VIEWER",
      status: "ACTIVE",
      projections: [],
    },
  ],
};

let callerRole = "ORG_SECURITY_ADMIN";

function scimGets(path: string): Reply {
  if (path.startsWith("/v1/admin/identity/scim/tokens")) return { tokens: [] };
  if (path.startsWith("/v1/admin/identity/scim/groups?")) return GROUPS;
  if (path === `/v1/orgs/${ORG}`) return { organizationId: ORG, callerRole };
  if (path === `/v1/orgs/${ORG}/workspaces`) {
    return {
      organizationId: ORG,
      workspaces: [
        { workspaceId: WS, name: "Field Investigations", isPersonal: false },
        { workspaceId: "22222222-2222-4222-8222-222222222222", name: "Legal Review", isPersonal: false },
        { workspaceId: "33333333-3333-4333-8333-333333333333", name: "Someone's space", isPersonal: true },
      ],
    };
  }
  throw new Error(`unexpected GET ${path}`);
}

async function mountGroupsTab() {
  getReply = scimGets;
  await mount(<ScimPage />);
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: "Directory groups" }));
  });
  await settle();
}

const groupCard = (id: string) =>
  document.querySelector(`[data-testid="scim-group"][data-group-id="${id}"]`) as HTMLElement;

async function openAddFor(id: string) {
  await act(async () => {
    fireEvent.click(within(groupCard(id)).getByRole("button", { name: "Apply to a workspace" }));
  });
  await settle();
}

async function chooseAndApply(id: string, workspaceId: string, role: string) {
  const card = groupCard(id);
  fireEvent.change(within(card).getByLabelText("Workspace"), { target: { value: workspaceId } });
  fireEvent.change(within(card).getByLabelText("Role it grants there"), { target: { value: role } });
  await act(async () => {
    fireEvent.click(within(card).getByRole("button", { name: "Apply group" }));
  });
  await settle();
}

describe("SCIM Directory groups — the Organization's groups and their workspace projections", () => {
  beforeEach(() => {
    callerRole = "ORG_SECURITY_ADMIN";
  });

  it("says the configuration is the organization's", async () => {
    await mountGroupsTab();
    expect(screen.getByTestId("organization-identity-scope").textContent).toContain(
      "Managed for the whole organization",
    );
  });

  it("lists every group with each projection's workspace, role and status", async () => {
    await mountGroupsTab();
    expect(gets("/v1/admin/identity/scim/groups?")).toHaveLength(1);
    expect(gets("/v1/admin/identity/scim/groups?")[0].path).toBe(
      `/v1/admin/identity/scim/groups?teamId=${WS}`,
    );

    const table = within(groupCard("g1")).getByRole("table", { name: "Workspaces for Legal Ops" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Field Investigations");
    expect(rows[0].textContent).toContain("Admin");
    expect(rows[0].textContent).toContain("Applied");
    expect(within(rows[0]).getByRole("button", { name: "End" })).toBeTruthy();
    expect(rows[1].textContent).toContain("Closed Matter");
    expect(rows[1].textContent).toContain("Viewer");
    expect(rows[1].textContent).toContain("Ended");
    // An ended projection has nothing left to end.
    expect(within(rows[1]).queryByRole("button")).toBeNull();

    expect(groupCard("g2").textContent).toContain("does not apply to any workspace yet");
  });

  it("offers only the organization's open, not-yet-projected workspaces", async () => {
    await mountGroupsTab();
    await openAddFor("g1");
    const select = within(groupCard("g1")).getByLabelText("Workspace") as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(["Choose a workspace", "Legal Review"]);
    const roles = within(groupCard("g1")).getByLabelText("Role it grants there") as HTMLSelectElement;
    expect(Array.from(roles.options).map((o) => o.value)).toEqual(["ADMIN", "MEMBER", "VIEWER"]);
    // Plain words, never the stored enum.
    for (const o of Array.from(roles.options)) expect(o.textContent).not.toMatch(/^[A-Z_]+$/);
  });

  it("adds a projection with the exact POST body, retried under step-up", async () => {
    await mountGroupsTab();
    writeReply = (path, method) => {
      if (method === "POST" && path === "/v1/admin/identity/scim/groups/g1/projections") {
        return { projectionId: "p9", applied: 3 };
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const readsBefore = gets("/v1/admin/identity/scim/groups?").length;
    await openAddFor("g1");
    await chooseAndApply("g1", "22222222-2222-4222-8222-222222222222", "VIEWER");

    const posts = writes("POST", "/v1/admin/identity/scim/groups/");
    expect(posts).toHaveLength(2);
    // First unelevated, then once more carrying the challenge.
    expect(posts[0].headers[STEP_UP_HEADER]).toBeUndefined();
    const sent = posts[1];
    expect(sent.path).toBe("/v1/admin/identity/scim/groups/g1/projections");
    expect(sent.headers[STEP_UP_HEADER]).toBe(CHALLENGE);
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(sent.body).toStrictEqual({
      teamId: WS,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      mappedRole: "VIEWER",
    });
    // The list is re-read after the write.
    expect(gets("/v1/admin/identity/scim/groups?").length).toBeGreaterThan(readsBefore);
    expect(screen.getByText(/Legal Ops now applies to the chosen workspace/)).toBeTruthy();
  });

  it("shows SCIM_GROUP_PROJECTION_EXISTS in its registered copy", async () => {
    await mountGroupsTab();
    writeReply = () => apiFailure(409, "SCIM_GROUP_PROJECTION_EXISTS");
    await openAddFor("g2");
    await chooseAndApply("g2", WS, "MEMBER");
    expect(screen.getByText(USER_FACING_ERRORS.SCIM_GROUP_PROJECTION_EXISTS.message)).toBeTruthy();
    expect(screen.queryByText(/now applies/)).toBeNull();
  });

  it("ends a projection: confirm first, then DELETE { teamId } under step-up", async () => {
    await mountGroupsTab();
    writeReply = (path, method) => {
      if (method === "DELETE" && path === "/v1/admin/identity/scim/groups/projections/p1") {
        return { demoted: 2 };
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const table = within(groupCard("g1")).getByRole("table", { name: "Workspaces for Legal Ops" });
    await act(async () => {
      fireEvent.click(within(table).getByRole("button", { name: "End" }));
    });
    await settle();
    const dialog = document.querySelector(
      '[data-confirm-action-modal="scim-group-projection-end"]',
    ) as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(writes("DELETE", "/v1/admin/identity/scim/groups/")).toHaveLength(0);
    await act(async () => {
      fireEvent.click(dialog!.querySelector("[data-confirm-action-submit]") as HTMLElement);
    });
    await settle();

    const deletes = writes("DELETE", "/v1/admin/identity/scim/groups/");
    expect(deletes).toHaveLength(2);
    expect(deletes[1].path).toBe("/v1/admin/identity/scim/groups/projections/p1");
    expect(deletes[1].headers[STEP_UP_HEADER]).toBe(CHALLENGE);
    expect(deletes[1].body).toStrictEqual({ teamId: WS });
    expect(screen.getByText(/Projection ended\. 2 members lost the role it granted\./)).toBeTruthy();
  });

  it("disables the controls, with the reason, for a viewer without an organization identity role", async () => {
    callerRole = "ORG_MEMBER";
    await mountGroupsTab();
    const reason = screen.getByTestId("scim-groups-manage-reason").textContent ?? "";
    expect(reason).toMatch(/organization owner, admin or security admin/);
    const apply = within(groupCard("g1")).getByRole("button", { name: "Apply to a workspace" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(apply.getAttribute("title")).toBe(reason);
    const end = within(groupCard("g1")).getByRole("button", { name: "End" }) as HTMLButtonElement;
    expect(end.disabled).toBe(true);
    // Reading is still allowed: the groups are listed.
    expect(groupCard("g2")).toBeTruthy();
  });

  it("refuses to manage outside a customer organization", async () => {
    activeOrganizationId = null;
    await mountGroupsTab();
    expect(screen.getByTestId("scim-groups-manage-reason").textContent).toMatch(/customer organization/);
    expect(gets("/v1/orgs/")).toHaveLength(0);
  });
});

describe("SCIM tokens — an Organization identity refusal is not a read denial", () => {
  it("a token revoke refused with ORGANIZATION_IDENTITY_ADMIN_REQUIRED keeps the list and shows the registered copy", async () => {
    getReply = (path) => {
      if (path.startsWith("/v1/admin/identity/scim/tokens")) {
        return {
          tokens: [
            {
              id: "t1",
              name: "Okta",
              tokenPrefix: "scim_ab",
              scopes: ["users.read"],
              status: "ACTIVE",
              ipAllowlist: [],
              createdByUserId: "u1",
              createdAt: "2026-10-01T00:00:00.000Z",
              lastUsedAtUtc: null,
              expiresAtUtc: null,
              revokedAtUtc: null,
            },
          ],
          entitlement: { ssoScim: true },
        };
      }
      throw new Error(`unexpected GET ${path}`);
    };
    writeReply = () => apiFailure(403, "ORGANIZATION_IDENTITY_ADMIN_REQUIRED");
    await mount(<ScimPage />);
    const table = screen.getByRole("table", { name: "SCIM provisioning tokens" });
    await act(async () => {
      fireEvent.click(within(table).getByRole("button", { name: "Revoke" }));
    });
    await settle();
    const dialog = document.querySelector('[data-confirm-action-modal="scim-token-revoke"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(dialog.querySelector("[data-confirm-action-submit]") as HTMLElement);
    });
    await settle();
    expect(screen.getByText(USER_FACING_ERRORS.ORGANIZATION_IDENTITY_ADMIN_REQUIRED.message)).toBeTruthy();
    expect(screen.queryByTestId("scim-denied")).toBeNull();
    expect(screen.getByRole("table", { name: "SCIM provisioning tokens" })).toBeTruthy();
  });
});

// ===========================================================================
// SSO connections
// ===========================================================================

function provider(id: string, status: string) {
  return {
    id,
    provider: "OKTA",
    displayName: `Okta ${id}`,
    status,
    issuerUrl: null,
    clientId: null,
    clientSecretPreview: null,
    allowedEmailDomains: [],
    jitDefaultRole: null,
    notes: null,
    createdByUserId: "u1",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastUsedAtUtc: null,
    samlSignRequests: false,
    restrictToVerifiedDomains: false,
    samlSpKeyConfigured: false,
    samlSpKeyFingerprint: null,
    samlSpEnvKeyAvailable: false,
    samlSpSigningKeySource: "none",
    samlSpCertificateConfigured: false,
  };
}

function ssoGets(providers: unknown[]) {
  return (path: string): Reply => {
    if (path.startsWith("/v1/admin/identity/providers?")) {
      return { providers, verifiedDomainCount: 0, providersCap: 50 };
    }
    // Federation readiness is not under test here.
    if (path.startsWith("/v1/auth/sso/readiness")) return apiFailure(500);
    throw new Error(`unexpected GET ${path}`);
  };
}

const rowOf = (name: string) =>
  screen.getByText(name).closest("tr") as HTMLElement;

describe("SSO connections — organization-scoped", () => {
  it("a provider action refused with ORGANIZATION_IDENTITY_ADMIN_REQUIRED reads in its registered copy", async () => {
    getReply = ssoGets([provider("c1", "PENDING")]);
    writeReply = () => apiFailure(403, "ORGANIZATION_IDENTITY_ADMIN_REQUIRED");
    await mount(<IdentityProvidersSection refreshKey={0} onChanged={() => {}} />);
    expect(screen.getByTestId("organization-identity-scope")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(rowOf("Okta c1")).getByRole("button", { name: "Activate" }));
    });
    await settle();
    const transitions = writes("POST", "/v1/admin/identity/providers/c1/transition");
    expect(transitions.at(-1)?.body).toStrictEqual({ teamId: WS, nextStatus: "ACTIVE" });
    expect(screen.getByText(USER_FACING_ERRORS.ORGANIZATION_IDENTITY_ADMIN_REQUIRED.message)).toBeTruthy();
    // Not repainted as "you don't have access to identity providers".
    expect(screen.queryByTestId("providers-denied")).toBeNull();
  });

  it("SSO_CONNECTION_EXISTS on activation says the organization already has a live connection", async () => {
    getReply = ssoGets([provider("c1", "DISABLED")]);
    writeReply = () => apiFailure(409, "SSO_CONNECTION_EXISTS");
    await mount(<IdentityProvidersSection refreshKey={0} onChanged={() => {}} />);
    await act(async () => {
      fireEvent.click(within(rowOf("Okta c1")).getByRole("button", { name: "Re-activate" }));
    });
    await settle();
    expect(
      screen.getByText(/already has a live connection for this provider/),
    ).toBeTruthy();
    expect(screen.queryByText(/review your input/i)).toBeNull();
  });

  it("labels a SUSPENDED connection and offers Revoke only", async () => {
    getReply = ssoGets([provider("c1", "SUSPENDED")]);
    await mount(<IdentityProvidersSection refreshKey={0} onChanged={() => {}} />);
    const row = rowOf("Okta c1");
    expect(row.querySelector('[data-connection-status="SUSPENDED"]')?.textContent).toBe(
      "Suspended with the organization",
    );
    const lifecycle = within(row)
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter((t) => t !== "Signing & policy");
    expect(lifecycle).toEqual(["Revoke"]);
  });
});
