/**
 * Members audit DOM-03 — Organization surfaces point at the real workspace
 * administration and no longer offer self-serve workspace creation.
 *
 *   - The organization admin header's "Workspace admin" link goes to
 *     /workspaces (it used to land on Collaboration Teams).
 *   - The "About Enterprise organizations" dialog on /organizations no longer
 *     tells people to "create a workspace from the Teams page" (the server
 *     refuses that); it points at plans for the Personal Workspace instead.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/navigation/PageRouteGate", () => ({ PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../lib/platform-context", async (orig) => ({ ...((await orig()) as object), usePlatformContext: () => ({ refresh: async () => {}, envelope: null }) }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/organizations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/admin",
  useSearchParams: () => new URLSearchParams(),
}));

import OrganizationAdminLayout from "../../app/(app)/organizations/[id]/admin/layout";
import OrganizationsPage from "../../app/(app)/organizations/page";

const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === `/v1/orgs/${ORG}`) {
      return {
        id: ORG,
        name: "Acme Legal",
        callerRole: "ORG_OWNER",
        adminSurfaces: ["overview"],
        organizationKind: "CUSTOMER",
        summary: { memberCount: 3, workspaceCount: 1, pendingInviteCount: 0 },
      };
    }
    if (path === "/v1/me/orgs") return { organizations: [], items: [] };
    return {};
  });
});
afterEach(cleanup);

describe("DOM-03 — organization surfaces and workspace administration", () => {
  it("the org admin 'Workspace admin' link goes to /workspaces", async () => {
    const { container } = render(
      <OrganizationAdminLayout>
        <div>child</div>
      </OrganizationAdminLayout>,
    );
    await screen.findByText("Acme Legal");
    const link = container.querySelector('[data-action="workspace-admin-link"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe("Workspace admin");
    expect(link.getAttribute("href")).toBe("/workspaces");
    // Nothing in the header sends workspace administration to Collaboration Teams.
    const header = link.closest("header")!;
    for (const a of Array.from(header.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/collaboration|\/teams\b/i);
    }
  });

  it("the Enterprise info dialog offers no self-serve workspace creation", async () => {
    const { container } = render(<OrganizationsPage />);
    fireEvent.click(container.querySelector('[data-action="open-enterprise-info"]') as HTMLElement);
    const panel = container.querySelector('[data-panel="enterprise-info"]') as HTMLElement;
    expect(panel).toBeTruthy();
    const text = panel.textContent ?? "";
    expect(text).not.toMatch(/Teams page/i);
    expect(text).not.toMatch(/create (a|your own) workspace/i);
    expect(text).toMatch(/Personal\s*Workspace/);
    const plans = panel.querySelector('[data-action="go-collaboration-plans"]') as HTMLAnchorElement;
    expect(plans.getAttribute("href")).toBe("/billing");
  });
});
