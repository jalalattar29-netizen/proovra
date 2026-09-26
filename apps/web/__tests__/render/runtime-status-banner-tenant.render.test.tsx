/**
 * RUNTIME STATUS BANNER — the tenant form.
 *
 * On a DEGRADED answer the banner rendered "0 subsystem(s) reported a
 * non-healthy state", an empty "Failing subsystems: ." line and a "Review
 * runbooks" link to the platform-admin console, which every tenant is refused
 * at. The tenant-safe projection carries no list, so none of that was ever
 * true. Operator affordances now depend on operator capabilities.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

let runtimeStatus: string | Error = "DEGRADED";
let caps = new Set<string>();

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    if (path === "/v1/runtime/status") {
      if (runtimeStatus instanceof Error) throw runtimeStatus;
      return { status: runtimeStatus };
    }
    return {};
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCan: (key: string) => caps.has(key),
}));

import { RuntimeStatusBanner } from "../../components/operational/RuntimeStatusBanner";

beforeEach(() => {
  runtimeStatus = "DEGRADED";
  caps = new Set();
});
afterEach(() => cleanup());

async function mount() {
  const view = render(<RuntimeStatusBanner pollMs={0} />);
  return view;
}

describe("RuntimeStatusBanner — tenant form", () => {
  it("DEGRADED for an ordinary member: a plain explanation, no count, no empty list, no admin links", async () => {
    const { container } = await mount();
    await waitFor(() => expect(container.textContent).toMatch(/degraded mode/));
    const text = container.textContent ?? "";
    expect(text).toMatch(/may be partial or stale/);
    expect(text).not.toMatch(/subsystem\(s\)/);
    expect(text).not.toMatch(/Failing subsystems/);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.startsWith("/admin"))).toBe(false);
  });

  it("a workspace-health holder gets the workspace destination, still no runbooks", async () => {
    caps = new Set(["WORKSPACE_HEALTH_VIEW"]);
    const { container } = await mount();
    await waitFor(() => expect(container.textContent).toMatch(/degraded mode/));
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/operations/health");
    expect(hrefs).not.toContain("/admin/platform/runbooks");
  });

  it("a platform operator keeps the operator diagnostics", async () => {
    caps = new Set(["PLATFORM_TELEMETRY_VIEW", "RUNBOOKS_VIEW"]);
    const { container } = await mount();
    await waitFor(() => expect(container.textContent).toMatch(/degraded mode/));
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/admin/platform/observability");
    expect(hrefs).toContain("/admin/platform/runbooks");
  });

  it("HEALTHY renders nothing; an unreadable status is UNKNOWN, never healthy", async () => {
    runtimeStatus = "HEALTHY";
    const healthy = await mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(healthy.container.textContent).toBe("");
    cleanup();

    runtimeStatus = new Error("network");
    const failed = await mount();
    await waitFor(() =>
      expect(failed.container.querySelector("[data-runtime-status='UNKNOWN']")).toBeTruthy(),
    );
  });
});
