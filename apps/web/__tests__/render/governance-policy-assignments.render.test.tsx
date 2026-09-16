import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  confirm: vi.fn(),
  guard: { stamp: () => 1, isStale: () => false, generation: 1 },
  platform: { envelope: null, contextGeneration: 1 },
}));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({ PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../lib/platform-context", () => ({ useTenantGuard: () => mocks.guard, usePlatformContext: () => mocks.platform }));
vi.mock("next/navigation", () => ({ usePathname: () => "/governance-platform/policies", useRouter: () => ({ push: () => {}, replace: () => {} }) }));

import PoliciesPage from "../../app/(app)/governance-platform/policies/page";

const ORG = "99999999-9999-4999-8999-999999999999";
const WS = "88888888-8888-4888-8888-888888888888";
const DEPT = "77777777-7777-4777-8777-777777777777";
const POLICY = "11111111-1111-4111-8111-111111111111";
const policy = { id: POLICY, kind: "SECURITY", slug: "mfa", name: "Require MFA", summary: "", state: "ACTIVE", enforcementMode: "BLOCK", rule: {}, version: 2, createdByUserId: "u", createdAtUtc: "2026-01-01T00:00:00.000Z" };
const department = { id: DEPT, organizationId: ORG, name: "Forensics", slug: "forensics", state: "ACTIVE", createdAtUtc: "2026-01-01T00:00:00.000Z" };
let assignments: Array<Record<string, unknown>> = [];
const auditRow = { id: "a-1", policyId: POLICY, code: "POLICY_ACTIVATED", actorUserId: "actor-uuid", reason: null, occurredAtUtc: "2026-02-01T00:00:00.000Z" };

function reply(path: string, init?: RequestInit): unknown {
  if (init?.method === "POST" && path.endsWith("/assignments")) {
    const body = JSON.parse(String(init.body));
    assignments = [{ id: "as-1", policyId: POLICY, ...body, assignedByUserId: "actor-uuid", assignedAtUtc: "2026-03-01T00:00:00.000Z" }];
    return { assignmentId: "as-1" };
  }
  if (init?.method === "POST") return { ok: true };
  if (path === "/v1/governance/policies") return { policies: [policy] };
  if (path === "/v1/governance/departments") return { organizationId: ORG, departments: [department] };
  if (path.startsWith("/v1/governance/policies/effective")) return { effective: [], scope: { organizationId: ORG, workspaceId: WS, departmentId: null } };
  if (path === `/v1/governance/policies/${POLICY}/assignments`) return { assignments };
  if (path === `/v1/governance/policies/${POLICY}/audit`) return { audit: [auditRow] };
  return {};
}
const posts = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST");
async function openDetails() {
  render(<PoliciesPage />);
  const toggle = await screen.findByRole("button", { name: "Details for Require MFA" });
  fireEvent.click(toggle);
  return toggle;
}
async function openForm() {
  const opener = await screen.findByRole("button", { name: "Assign policy" });
  await waitFor(() => expect(opener.hasAttribute("disabled")).toBe(false));
  fireEvent.click(opener);
  return opener;
}

beforeEach(() => {
  assignments = [];
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => reply(path, init));
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe("governance policy assignments + audit trail", () => {
  it("shows an unassigned policy truthfully and its audit trail", async () => {
    const toggle = await openDetails();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await screen.findByText("Not assigned. This policy is not enforced anywhere until it is assigned.");
    await screen.findByText("Policy activated");
    expect(screen.getByText("actor-uuid").hasAttribute("data-identifier")).toBe(true);
  });

  it("assigns to a department after confirmation, rereads, then refreshes the effective chain and audit", async () => {
    await openDetails();
    const opener = await openForm();
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    const scope = screen.getByLabelText("Apply to");
    expect(document.activeElement).toBe(scope);
    fireEvent.change(scope, { target: { value: "DEPARTMENT" } });
    const save = screen.getByRole("button", { name: "Save assignment" });
    expect(save.getAttribute("data-disabled-reason")).toBe("Choose the department to assign this policy to.");
    fireEvent.change(screen.getByLabelText("Target department"), { target: { value: DEPT } });
    fireEvent.click(screen.getByLabelText("Narrower scopes inherit this assignment"));
    fireEvent.click(screen.getByLabelText("Override a broader policy of the same kind"));
    const effectiveBefore = mocks.fetch.mock.calls.filter(([p]) => String(p).startsWith("/v1/governance/policies/effective")).length;
    const auditBefore = mocks.fetch.mock.calls.filter(([p]) => p === `/v1/governance/policies/${POLICY}/audit`).length;
    fireEvent.click(save);
    await screen.findByText("Require MFA is assigned to the Forensics department.");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Assign Require MFA?" }));
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([, init]) => init?.method === "POST");
    expect(calls[write][0]).toBe(`/v1/governance/policies/${POLICY}/assignments`);
    expect(JSON.parse(calls[write][1].body)).toEqual({ scope: "DEPARTMENT", scopeTargetId: DEPT, inheritFromParent: false, isOverride: true });
    expect(calls.slice(write + 1)[0][0]).toBe(`/v1/governance/policies/${POLICY}/assignments`);
    await waitFor(() => {
      expect(mocks.fetch.mock.calls.filter(([p]) => String(p).startsWith("/v1/governance/policies/effective")).length).toBeGreaterThan(effectiveBefore);
      expect(mocks.fetch.mock.calls.filter(([p]) => p === `/v1/governance/policies/${POLICY}/audit`).length).toBeGreaterThan(auditBefore);
    });
    const list = screen.getByRole("list", { name: "Policy assignments" });
    expect(within(list).getByText(/Forensics department/)).toBeTruthy();
  });

  it("uses the server-echoed workspace id for a workspace assignment", async () => {
    await openDetails();
    await openForm();
    fireEvent.click(screen.getByRole("button", { name: "Save assignment" }));
    await screen.findByText("Require MFA is assigned to this workspace.");
    const write = posts()[0];
    expect(JSON.parse(write[1].body)).toEqual({ scope: "WORKSPACE", scopeTargetId: WS, inheritFromParent: true, isOverride: false });
  });

  it("cancelling the confirmation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    await openDetails();
    await openForm();
    fireEvent.click(screen.getByRole("button", { name: "Save assignment" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(posts()).toHaveLength(0);
  });

  it("cancelling the form restores focus to its opener", async () => {
    await openDetails();
    const opener = await openForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(opener);
    expect(opener.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not claim success when the reread does not show the assignment", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { assignmentId: "as-1" };
      return reply(path, init);
    });
    await openDetails();
    await openForm();
    fireEvent.click(screen.getByRole("button", { name: "Save assignment" }));
    await screen.findByText(/reloaded assignments do not show it/);
    expect(screen.queryByText("Require MFA is assigned to this workspace.")).toBeNull();
  });

  it("names the required tier when the server refuses the assignment", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw { statusCode: 403, code: "DELEGATED_ADMIN_REQUIRED", details: { denial: "DELEGATED_ADMIN_REQUIRED", requiredTier: "ORG_ADMIN" } };
      return reply(path, init);
    });
    await openDetails();
    await openForm();
    fireEvent.click(screen.getByRole("button", { name: "Save assignment" }));
    await screen.findByText("Permission required. Ask an organization administrator to grant you access.");
  });

  it("disables workspace assignment with a reason when the scope is unresolved", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/v1/governance/policies/effective")) throw { statusCode: 403 };
      return reply(path, init);
    });
    await openDetails();
    await openForm();
    expect(screen.getByRole("button", { name: "Save assignment" }).getAttribute("data-disabled-reason")).toMatch(/have not been resolved/);
  });

  it("never renders refused assignment or audit reads as empty", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/assignments") || path.endsWith("/audit")) throw { statusCode: 500 };
      return reply(path, init);
    });
    await openDetails();
    await screen.findByRole("button", { name: "Retry assignments" });
    await screen.findByRole("button", { name: "Retry audit trail" });
    expect(screen.queryByText(/Not assigned\./)).toBeNull();
    expect(screen.queryByText("No audit events are recorded for this policy.")).toBeNull();
  });

  it("never renders a failed policy list as empty", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/governance/policies") throw { statusCode: 500 };
      return reply(path, init);
    });
    render(<PoliciesPage />);
    await waitFor(() => expect(document.querySelector("[data-governance-policies-failure]")).not.toBeNull());
    expect(screen.queryByText("No governance policies defined")).toBeNull();
  });

  it("rereads the audit trail after the policy is deprecated", async () => {
    await openDetails();
    await screen.findByText("Policy activated");
    const before = mocks.fetch.mock.calls.filter(([p]) => p === `/v1/governance/policies/${POLICY}/audit`).length;
    fireEvent.click(screen.getByRole("button", { name: "Deprecate" }));
    await waitFor(() => expect(mocks.fetch.mock.calls.filter(([p]) => p === `/v1/governance/policies/${POLICY}/audit`).length).toBeGreaterThan(before));
  });
});
