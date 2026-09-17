import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const guard = { stamp: () => 1, isStale: () => false, generation: 1 };
  const stepUp = { runStepUpAction: (fn: (headers?: Record<string, string>) => unknown) => fn(undefined) };
  return { fetch: vi.fn(), confirm: vi.fn(), guard, stepUp };
});
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({ PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  StepUpModal: () => null,
  useStepUpAction: () => mocks.stepUp,
}));
vi.mock("../../lib/platform-context", () => ({
  useTeamId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  useTenantGuard: () => mocks.guard,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/governance-platform/departments", useRouter: () => ({ push: () => {}, replace: () => {} }) }));

import DepartmentsPage from "../../app/(app)/governance-platform/departments/page";

const deptId = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const dept = (state: string) => ({ id: deptId, organizationId: "org", name: "Forensics", slug: "forensics", state, createdAtUtc: "2026-01-01T00:00:00.000Z" });
const archivedOther = { ...dept("ARCHIVED"), id: other, name: "Legacy unit", slug: "legacy" };
let archived = false;

function reply(path: string, init?: RequestInit): unknown {
  if (init?.method === "POST" && path.endsWith("/archive")) { archived = true; return { ok: true }; }
  if (path === "/v1/governance/departments") return { organizationId: "org", departments: [dept(archived ? "ARCHIVED" : "ACTIVE"), archivedOther] };
  if (path.startsWith("/v1/governance/me/department-scope")) return { scope: { unrestricted: true, allowedDepartmentIds: [] } };
  return {};
}
const archiveButton = () => screen.findByRole("button", { name: "Archive Forensics" });
const posts = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST");

beforeEach(() => {
  archived = false;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => reply(path, init));
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe("department archive workflow", () => {
  it("offers archive only on active departments", async () => {
    render(<DepartmentsPage />);
    await archiveButton();
    expect(screen.queryByRole("button", { name: "Archive Legacy unit" })).toBeNull();
  });

  it("archives after confirmation and announces only after the reread shows ARCHIVED", async () => {
    render(<DepartmentsPage />);
    fireEvent.click(await archiveButton());
    await screen.findByText("Forensics is archived.");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Archive Forensics?", tone: "danger" }));
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([path, init]) => init?.method === "POST" && path === `/v1/governance/departments/${deptId}/archive`);
    expect(write).toBeGreaterThanOrEqual(0);
    expect(calls.slice(write + 1).some(([path]) => path === "/v1/governance/departments")).toBe(true);
    expect(screen.queryByRole("button", { name: "Archive Forensics" })).toBeNull();
    expect(document.querySelector(`[data-department-row="${deptId}"]`)?.getAttribute("data-department-state")).toBe("ARCHIVED");
  });

  it("cancellation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<DepartmentsPage />);
    fireEvent.click(await archiveButton());
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(posts()).toHaveLength(0);
    expect(screen.queryByText("Forensics is archived.")).toBeNull();
  });

  it("does not claim success when the reread still shows the department active", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true };
      return reply(path, init);
    });
    render(<DepartmentsPage />);
    fireEvent.click(await archiveButton());
    await screen.findByText(/does not show the department as archived/);
    expect(screen.queryByText("Forensics is archived.")).toBeNull();
  });

  it("does not claim success when the reread fails", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (archived && path === "/v1/governance/departments") throw { statusCode: 503 };
      return reply(path, init);
    });
    render(<DepartmentsPage />);
    fireEvent.click(await archiveButton());
    await screen.findByText(/could not be reloaded to confirm it/);
    expect(screen.queryByText("Forensics is archived.")).toBeNull();
  });

  it("names the required tier on a delegated-admin refusal", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw { statusCode: 403, code: "DELEGATED_ADMIN_REQUIRED", details: { denial: "DELEGATED_ADMIN_REQUIRED", requiredTier: "ORG_ADMIN" } };
      return reply(path, init);
    });
    render(<DepartmentsPage />);
    fireEvent.click(await archiveButton());
    await screen.findByText("Permission required. Ask an organization administrator to grant you access.");
  });

  it("reloads the list when the department is gone", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw { statusCode: 404, code: "NOT_FOUND" };
      return reply(path, init);
    });
    render(<DepartmentsPage />);
    fireEvent.click(await archiveButton());
    await screen.findByText(/no longer part of your current organization/);
    const lists = mocks.fetch.mock.calls.filter(([path]) => path === "/v1/governance/departments");
    expect(lists.length).toBeGreaterThanOrEqual(2);
  });

  it("never renders a failed department list as empty", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/governance/departments") throw { statusCode: 500 };
      return reply(path, init);
    });
    render(<DepartmentsPage />);
    await waitFor(() => expect(document.querySelector("[data-departments-failure]")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Archive Forensics" })).toBeNull();
  });

  it("disables the other archive controls with a reason while one is in flight", async () => {
    let release!: () => void;
    const second = { ...dept("ACTIVE"), id: other, name: "Intake", slug: "intake" };
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise((resolve) => { release = () => resolve({ ok: true }); });
      if (path === "/v1/governance/departments") return { organizationId: "org", departments: [dept("ACTIVE"), second] };
      return reply(path, init);
    });
    render(<DepartmentsPage />);
    fireEvent.click(await archiveButton());
    const blocked = await screen.findByRole("button", { name: "Archive Intake" });
    await waitFor(() => expect(blocked.hasAttribute("disabled")).toBe(true));
    expect(blocked.getAttribute("data-disabled-reason")).toBe("Another department is being archived. Wait for it to finish.");
    release();
  });
});
