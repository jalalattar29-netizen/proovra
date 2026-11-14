/**
 * Free audit F-27a — /share/[id] was a dead stub that echoed the URL segment
 * as "Evidence ID" and named a "Share Evidence" action that does not exist.
 * No journey links there (publicShareUrl has no caller; no email, notification
 * or deep link builds /share/), so it is a retired link shape: it says so,
 * points to /verify, and never reflects the segment.
 */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const SEGMENT = "pvr_secret-looking-token-123";
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: SEGMENT }),
  usePathname: () => `/share/${SEGMENT}`,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("../../components/marketing/MarketingHeader", () => ({ MarketingHeader: () => null }));
vi.mock("../../components/marketing/EnterpriseFooter", () => ({ EnterpriseFooter: () => null }));

import SharePage from "../../app/share/[id]/page";

afterEach(() => cleanup());

describe("F-27a: /share/[id] is a retired link shape", () => {
  it("says the format is retired and routes to /verify", () => {
    render(<SharePage />);
    expect(screen.getByText("This link format is no longer used")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the Verify page" }).getAttribute("href")).toBe("/verify");
  });

  it("never reflects the URL segment or names a non-existent action", () => {
    render(<SharePage />);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(SEGMENT);
    expect(text).not.toContain("Evidence ID");
    expect(text).not.toContain("Share Evidence");
  });
});
