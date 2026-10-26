/**
 * Members re-audit N-3 — the retired delegated-admin page tells the truth.
 *
 *   app/(app)/governance-platform/delegated-admin/page.tsx
 *
 * Retiring the tier model was forward-only: every live tier grant was carried
 * as member capability grants on the same member, and those grants STILL
 * admit their holder. The page used to say the tiered grants "no longer give
 * anyone access", which led an admin to believe a former grantee held
 * nothing. It must say the grants were carried and still apply, point to
 * Security Center where they are reviewed and revoked, and make no request.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const fetchSpy = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiFetch: fetchSpy, ApiError: class ApiError extends Error {} }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import DelegatedAdminPage from "../../app/(app)/governance-platform/delegated-admin/page";

afterEach(() => cleanup());

describe("delegated-admin page — carried grants (N-3)", () => {
  it("says carried tier grants still give their holder access, and points to Security Center", () => {
    const { container } = render(<DelegatedAdminPage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/no longer give anyone access/i);
    const carried = container.querySelector("[data-delegated-admin-carried-copy]");
    expect(carried?.textContent).toMatch(/carried forward/i);
    expect(carried?.textContent).toMatch(/still give that member access/i);
    expect(carried?.textContent).toMatch(/Security Center/);
    const officer = container.querySelector("[data-delegated-admin-officer-copy]");
    expect(officer?.textContent).toMatch(/not part of the admin role or of any scope/i);
    const link = screen.getByRole("link", { name: /Manage delegated administration in Security Center/i });
    expect(link.getAttribute("href")).toBe("/security-center/identity");
    // "Team" is never used to mean the workspace.
    expect(text).not.toMatch(/\bteam\b/i);
  });

  it("makes no request to the retired tier endpoints", () => {
    render(<DelegatedAdminPage />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
