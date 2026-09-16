import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn(), archived: false }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/redaction/PolicyScopePanel", () => ({ PolicyScopePanel: () => null }));

import PolicyManagementConsolePage from "../../app/(app)/redaction/policy/page";

const policyId = "11111111-1111-4111-8111-111111111111";
const policyUrl = `/v1/redaction/policies/${policyId}`;
const SUCCESS = 'Policy "Faces and plates" archived. The saved list shows it as archived.';

function policy(archivedAt: string | null) {
  return { id: policyId, name: "Faces and plates", description: null, createdByUserId: "u", createdAt: "2026-01-01T00:00:00.000Z", archivedAt };
}
function archiveWrites() {
  return mocks.fetch.mock.calls.filter(([path, init]) => path === policyUrl && init?.method === "DELETE");
}

beforeEach(() => {
  mocks.archived = false;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === policyUrl && init?.method === "DELETE") { mocks.archived = true; return { ok: true }; }
    if (path === "/v1/redaction/policies") return { policies: [policy(mocks.archived ? "2026-03-01T00:00:00.000Z" : null)] };
    if (path === `${policyUrl}/versions`) return { versions: [] };
    if (path === `${policyUrl}/audit`) {
      return { audit: mocks.archived ? [{ id: "au1", code: "POLICY_ARCHIVED", policyVersionId: null, actorUserId: "u", payload: null, occurredAtUtc: "2026-03-01T00:00:00.000Z" }] : [] };
    }
    return {};
  });
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

async function ready() {
  render(<PolicyManagementConsolePage />);
  return screen.findByRole("button", { name: "Archive policy" });
}

describe("redaction policy archive", () => {
  it("confirms, archives, rereads the list and audit, and only then announces success", async () => {
    const button = await ready();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await screen.findByText(SUCCESS);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Archive the policy "Faces and plates"?', tone: "danger" }));
    expect(archiveWrites()).toHaveLength(1);
    expect(archiveWrites()[0][1].body).toBeUndefined();
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([path, init]) => path === policyUrl && init?.method === "DELETE");
    const after = calls.slice(write + 1).map(([path]) => path);
    expect(after).toContain("/v1/redaction/policies");
    expect(after).toContain(`${policyUrl}/audit`);
    // The reread record drives the archived state.
    expect(screen.getByText(/^Archived /)).toBeTruthy();
    const archive = screen.getByRole("button", { name: "Archive policy" });
    expect(archive.hasAttribute("disabled")).toBe(true);
    expect(archive.getAttribute("data-disabled-reason")).toBe("This policy is already archived.");
    const draft = screen.getByRole("button", { name: "+ Draft new version" });
    expect(draft.hasAttribute("disabled")).toBe(true);
    expect(draft.getAttribute("data-disabled-reason")).toBe("This policy is archived, so no new versions can be drafted.");
    expect(await screen.findByText("Policy archived")).toBeTruthy();
  });

  it("cancellation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    const button = await ready();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Archive policy" }).hasAttribute("disabled")).toBe(false));
    expect(archiveWrites()).toHaveLength(0);
    expect(screen.queryByText(SUCCESS)).toBeNull();
  });

  it.each([
    [403, "Only redaction administrators can archive a policy."],
    [409, "This policy is already archived or no longer exists. The list has been refreshed."],
  ])("renders a %s refusal without claiming success", async (statusCode, text) => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === policyUrl && init?.method === "DELETE") throw { statusCode };
      if (path === "/v1/redaction/policies") return { policies: [policy(null)] };
      return path.endsWith("/versions") ? { versions: [] } : { audit: [] };
    });
    const button = await ready();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    const alert = await screen.findByText(text);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(screen.queryByText(SUCCESS)).toBeNull();
  });

  it("does not announce success when the reread list still shows the policy active", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path === "/v1/redaction/policies") return { policies: [policy(null)] };
      return path.endsWith("/versions") ? { versions: [] } : path.endsWith("/audit") ? { audit: [] } : { ok: true };
    });
    const button = await ready();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/does not show the policy as archived yet/);
    expect(screen.queryByText(SUCCESS)).toBeNull();
  });

  it("never renders a failed policy list or audit read as empty", async () => {
    mocks.fetch.mockRejectedValue({ statusCode: 503 });
    render(<PolicyManagementConsolePage />);
    await waitFor(() => expect(document.querySelector("[data-redaction-policy-list-error]")?.getAttribute("role")).toBe("alert"));
    expect(screen.queryByText("No policies yet.")).toBeNull();
  });

  it("states a failed audit read instead of 'No activity yet'", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path === "/v1/redaction/policies") return { policies: [policy(null)] };
      if (path.endsWith("/versions")) return { versions: [] };
      throw { statusCode: 403 };
    });
    render(<PolicyManagementConsolePage />);
    await waitFor(() => expect(document.querySelector("[data-redaction-policy-audit-error]")?.getAttribute("role")).toBe("alert"));
    expect(document.querySelector("[data-redaction-policy-audit-error]")?.textContent).not.toMatch(/403/);
    expect(screen.queryByText("No activity yet.")).toBeNull();
  });
});
