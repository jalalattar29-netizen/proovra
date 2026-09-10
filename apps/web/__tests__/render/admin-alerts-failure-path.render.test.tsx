/**
 * ADM-P1-001 — THE ALERTS PAGE'S FAILURE PATH, PINNED.
 *
 * The page once turned a failed read into its empty state: `data` stayed null,
 * `total` fell to `?? 0`, and the one surface whose job is to say what is wrong
 * printed "…right now there are none." The source was fixed
 * (admin/alerts/page.tsx keeps a separate `failure` state and drops the list)
 * but nothing held it there. This does, from the rendered DOM:
 *
 *   * a failed read renders a failure the reader is told about (role=alert),
 *     and NEVER the empty-state claim;
 *   * a successful read with no alerts renders the empty state — so the test
 *     cannot pass by rendering nothing at all.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

let alertsReply: () => Promise<unknown> = async () => ({ items: [], total: 0 });

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    statusCode: number;
    code: string;
    constructor(statusCode: number, code: string) {
      super(code);
      this.statusCode = statusCode;
      this.code = code;
    }
  }
  return {
    apiFetch: async (path: string) => {
      if (path.startsWith("/v1/admin/alerts")) return alertsReply();
      return {};
    },
    readApiToken: () => null,
    apiBaseUrl: () => "https://api.test.invalid",
    ApiError,
  };
});

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/admin/alerts",
  useParams: () => ({}),
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ADMIN_EMPTY_COPY } from "../../lib/admin/read-state";
import AdminAlertsPage from "../../app/(app)/admin/alerts/page";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

const envelope = {
  authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
  capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
  navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
  capabilities: {},
  diagnostics: { requestId: "test" },
  workspace: { id: WS, name: "Platform", status: "active", scope: "TEAM" },
  activeSpace: { type: "TEAM", id: WS, displayName: "Platform", roleLabel: "Admin" },
  contextOptions: {
    personalSpace: null,
    ownedWorkspaces: [],
    organizations: [],
    activeContext: {
      workspaceId: WS,
      kind: "ORGANIZATION",
      organizationId: null,
      displayName: "Platform",
    },
  },
  account: { userId: ME, accountPlan: "PRO", accountStatus: "active" },
  flags: { isEnterpriseWorkspace: false },
  platform: { isPlatformAdmin: true },
};

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  cleanup();
  const utils = render(
    <PlatformContextProvider testEnvelope={envelope as never}>
      <ToastProvider>
        <AdminAlertsPage />
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
  return utils;
}

const EMPTY_BODY = ADMIN_EMPTY_COPY["/admin/alerts"].body;

describe("ADM-P1-001 — /admin/alerts failure path", () => {
  beforeEach(() => {
    alertsReply = async () => ({ items: [], total: 0 });
  });

  it("a successful read with nothing firing renders the empty state (the control case)", async () => {
    await mount();
    expect(screen.getByTestId("admin-alerts-empty")).toBeTruthy();
    expect(document.body.textContent).toContain(EMPTY_BODY);
  });

  for (const [label, failure] of [
    ["an unreachable source (503)", { statusCode: 503, code: "SERVICE_UNAVAILABLE" }],
    ["a server fault (500)", { statusCode: 500, code: "INTERNAL_ERROR" }],
    ["a network failure", null],
  ] as const) {
    it(`${label} is reported as a failure and NEVER as "no active alerts"`, async () => {
      alertsReply = async () => {
        if (failure === null) throw new TypeError("Failed to fetch");
        const { ApiError } = (await import("../../lib/api")) as unknown as {
          ApiError: new (s: number, c: string) => Error;
        };
        throw new ApiError(failure.statusCode, failure.code);
      };
      await mount();
      expect(screen.queryByTestId("admin-alerts-empty")).toBeNull();
      expect(document.body.textContent).not.toContain(EMPTY_BODY);
      expect(document.body.textContent).not.toMatch(/right now there are none/i);
      // The failure is announced, not merely absent.
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    });
  }
});
