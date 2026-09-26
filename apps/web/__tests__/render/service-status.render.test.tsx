/**
 * SERVICE STATUS (web) — the contextual notice, the header indicator and the
 * operator dropdown, each over the real `/v1/runtime/status` envelope.
 *
 * Replaces the banner tests: the property is no longer "the panel says less",
 * it is that each surface shows only what its reader can act on —
 *
 *   * RuntimeStatusBanner: one line beside an action, only for a capability
 *     that action depends on, only when CONFIRMED impaired;
 *   * ServiceStatusIndicator (header, non-operators): silent while healthy,
 *     user-impact sentences when not, "Status unavailable" (never all-clear)
 *     when unreadable; links only to the actor's own permitted destination;
 *   * GlobalRuntimeIndicator (operators): the same impact, instead of an
 *     always-empty subsystem list that read "All subsystems healthy";
 *   * every consumer shares ONE poll.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent, act } from "@testing-library/react";

let runtimeBody: unknown = null;
let statusReads = 0;
let caps = new Set<string>();

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    if (path === "/v1/runtime/status") {
      statusReads += 1;
      if (runtimeBody instanceof Error) throw runtimeBody;
      return runtimeBody;
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

let operatorState: Record<string, unknown> = {};
vi.mock("../../lib/useGlobalRuntimeState", () => ({
  useGlobalRuntimeState: () => operatorState,
}));

import { GlobalRuntimeIndicator } from "../../components/operational/GlobalRuntimeIndicator";
import { RuntimeStatusBanner } from "../../components/operational/RuntimeStatusBanner";
import { parseTenantServiceStatus } from "@proovra/shared";
import { ServiceStatusIndicator } from "../../components/operational/ServiceStatusIndicator";
import { resetServiceStatusForTests } from "../../lib/useServiceStatus";

const capabilities = (over: Record<string, string> = {}) => ({
  uploads: "HEALTHY",
  artifactGeneration: "HEALTHY",
  downloads: "HEALTHY",
  search: "HEALTHY",
  reviewAutomation: "HEALTHY",
  ...over,
});
const body = (over: Record<string, string> = {}, status = "DEGRADED") => ({
  status,
  capabilities: capabilities(over),
  checkedAt: "2026-09-26T10:00:00.000Z",
});

beforeEach(() => {
  resetServiceStatusForTests();
  runtimeBody = body({}, "HEALTHY");
  statusReads = 0;
  caps = new Set();
});
afterEach(() => cleanup());

/** The store's first read is scheduled on idle; let it land. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 900));
  });
}

describe("RuntimeStatusBanner — contextual, capability-scoped", () => {
  it("renders nothing while the capability it depends on is healthy", async () => {
    const { container } = render(<RuntimeStatusBanner requires={["artifactGeneration"]} />);
    await settle();
    expect(container.textContent).toBe("");
  });

  it("says a generation incident beside generation — and nothing beside downloads", async () => {
    runtimeBody = body({ artifactGeneration: "DEGRADED" });
    const { container } = render(
      <>
        <div data-slot="gen"><RuntimeStatusBanner requires={["artifactGeneration"]} /></div>
        <div data-slot="dl"><RuntimeStatusBanner requires={["downloads"]} /></div>
      </>,
    );
    await settle();
    expect(container.querySelector("[data-slot='gen']")!.textContent).toMatch(/generation is delayed/);
    expect(container.querySelector("[data-slot='dl']")!.textContent).toBe("");
    expect(container.querySelector("[role='status']")).not.toBeNull();
  });

  it("an unmeasured capability or a failed read is not placed beside an action", async () => {
    runtimeBody = body({ artifactGeneration: "UNKNOWN" }, "UNAVAILABLE");
    const a = render(<RuntimeStatusBanner requires={["artifactGeneration"]} />);
    await settle();
    expect(a.container.textContent).toBe("");
    cleanup();
    resetServiceStatusForTests();
    runtimeBody = new Error("network");
    const b = render(<RuntimeStatusBanner requires={["artifactGeneration"]} />);
    await settle();
    expect(b.container.textContent).toBe("");
  });

  it("never names a subsystem, a runbook or an admin destination", async () => {
    runtimeBody = body({ artifactGeneration: "UNAVAILABLE", downloads: "UNAVAILABLE" });
    const { container } = render(<RuntimeStatusBanner requires={["artifactGeneration", "downloads"]} />);
    await settle();
    expect(container.textContent).toMatch(/temporarily unavailable/);
    expect(container.textContent).not.toMatch(/redis|s3|worker|queue|subsystem|runbook|partial or stale/i);
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("ServiceStatusIndicator — the header, for non-operators", () => {
  it("is absent while every core capability is healthy (no clutter on a normal day)", async () => {
    const { container } = render(<ServiceStatusIndicator />);
    await settle();
    expect(container.querySelector("[data-service-status-indicator]")).toBeNull();
  });

  it("reviewer automation alone does not raise it", async () => {
    runtimeBody = body({ reviewAutomation: "DEGRADED" }, "HEALTHY");
    const { container } = render(<ServiceStatusIndicator />);
    await settle();
    expect(container.querySelector("[data-service-status-indicator]")).toBeNull();
  });

  it("a Personal user sees the impact in words, with no link they could not open", async () => {
    runtimeBody = body({ artifactGeneration: "DEGRADED" });
    const { container, getByRole } = render(<ServiceStatusIndicator />);
    await settle();
    fireEvent.click(getByRole("button", { name: "Service status: Service issue" }));
    const dropdown = container.querySelector("[data-service-status-dropdown]")!;
    expect(dropdown.textContent).toMatch(/Report and package generation is delayed/);
    expect(dropdown.querySelector("a")).toBeNull();
  });

  it("a workspace-health holder is linked to workspace health, never to the admin console", async () => {
    caps = new Set(["WORKSPACE_HEALTH_VIEW"]);
    runtimeBody = body({ downloads: "UNAVAILABLE" });
    const { container, getByRole } = render(<ServiceStatusIndicator />);
    await settle();
    fireEvent.click(getByRole("button", { name: "Service status: Service issue" }));
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/operations/health"]);
  });

  it("an unreadable status is 'Status unavailable' — never an all-clear", async () => {
    runtimeBody = new Error("network");
    const { container } = render(<ServiceStatusIndicator />);
    await settle();
    expect(container.querySelector("[data-service-status-indicator='UNKNOWN']")).not.toBeNull();
  });

  it("every mounted consumer shares one poll", async () => {
    runtimeBody = body({ artifactGeneration: "DEGRADED" });
    render(
      <>
        <ServiceStatusIndicator />
        <RuntimeStatusBanner requires={["artifactGeneration"]} />
        <RuntimeStatusBanner requires={["downloads"]} />
      </>,
    );
    await settle();
    await waitFor(() => expect(statusReads).toBe(1));
  });
});

describe("GlobalRuntimeIndicator — operators see service impact, not an empty subsystem list", () => {
  function state(service: unknown, readinessError = false) {
    return {
      loading: false,
      severity: "DEGRADED",
      readiness: { status: "DEGRADED", ranAtUtc: null, subsystems: [] },
      service,
      incidents: [],
      escalations: [],
      counts: { incidents: 0, incidentsCritical: 0, incidentsHigh: 0, escalations: 0, degradedSubsystems: 0 },
      errors: { readiness: readinessError, incidents: false, escalations: false },
      refreshedAtUtc: "2026-09-26T10:00:00.000Z",
      refresh: () => undefined,
    };
  }

  it("lists what users cannot do — never 'All subsystems healthy' under a Degraded pill", async () => {
    operatorState = state(parseTenantServiceStatus(body({ artifactGeneration: "DEGRADED" })));
    const { container, getByRole } = render(<GlobalRuntimeIndicator teamId="team-1" />);
    fireEvent.click(getByRole("button", { name: /Runtime status: Degraded/ }));
    const impact = container.querySelector("[data-service-impact='artifactGeneration']");
    expect(impact?.textContent).toMatch(/generation is delayed/);
    expect(container.textContent).not.toMatch(/All subsystems healthy|Degraded subsystems/);
  });

  it("an unreadable status is said as unknown in the dropdown", async () => {
    operatorState = state(null, true);
    const { container, getByRole } = render(<GlobalRuntimeIndicator teamId="team-1" />);
    fireEvent.click(getByRole("button", { name: /Runtime status/ }));
    expect(container.textContent).toMatch(/Service status unavailable — treat as unknown/);
  });
});
