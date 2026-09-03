/**
 * /admin/audit — the paged log, driven for real.
 *
 * A browser review measured this page at nine desktop screens: 35 audit
 * entries rendered as full cards with no way past them, although the API has
 * accepted a cursor since it was written. The page now renders ONE page of 25
 * compact rows and walks the log through the server's cursor. Source text
 * cannot prove the walking, so this file mounts the REAL page against
 * contract-shaped fixtures (the apiFetch seam, same pattern as
 * operations-workbench.render.test.tsx) and asserts:
 *
 *   - page 1 requests limit=25 with NO cursor and renders 25 rows;
 *   - the count is worded from the server's hasMore — "more available",
 *     never a bare total;
 *   - Next sends the SERVER's nextCursor and renders the next page;
 *   - Previous returns to page 1 (no cursor again) and is truthfully
 *     disabled there, as Next is when the server says there is no more;
 *   - a row's details (metadata, identifiers) appear only after its
 *     Details toggle is pressed.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, cleanup, fireEvent, within } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

let requestLog: string[] = [];
let auditReply: (path: string) => Record<string, unknown> = () => ({
  items: [],
  nextCursor: null,
  hasMore: false,
});

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    requestLog.push(path);
    if (path.startsWith("/v1/admin/audit-log/verify")) {
      return { valid: true, partial: true, verifiedCount: 100 };
    }
    if (path.startsWith("/v1/admin/audit-log")) {
      return auditReply(path);
    }
    return {};
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

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
  usePathname: () => "/admin/audit",
  useParams: () => ({}),
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import AdminAuditPage from "../../app/(app)/admin/audit/page";

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

const T0 = Date.parse("2026-09-01T12:00:00.000Z");

function auditRow(n: number) {
  return {
    id: `aa-${String(n).padStart(3, "0")}`,
    userId: ME,
    isPublic: false,
    action: `admin.action_${String(n).padStart(3, "0")}`,
    category: "identity",
    severity: "info",
    source: "admin_console",
    outcome: "success",
    resourceType: "user",
    resourceId: `user-${n}`,
    requestId: `req-${n}`,
    metadata: { detail: `metadata-payload-${n}` },
    ipAddress: null,
    createdAt: new Date(T0 - n * 60_000).toISOString(),
    anchoredAt: null,
  };
}

/** 60 rows: pages of 25, 25, 10. The server issues the cursors. */
const ALL = Array.from({ length: 60 }, (_, i) => auditRow(i));

function pagedReply(path: string): Record<string, unknown> {
  const qs = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  const limit = Number(qs.get("limit"));
  const cursor = qs.get("cursor");
  const start = cursor ? ALL.findIndex((r) => r.id === cursor) + 1 : 0;
  if (cursor && start === 0) throw new Error(`unknown cursor ${cursor}`);
  const items = ALL.slice(start, start + limit);
  const hasMore = start + limit < ALL.length;
  return {
    items,
    hasMore,
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
}

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
        <AdminAuditPage />
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
  return utils;
}

const listRequests = () =>
  requestLog.filter((p) => p.startsWith("/v1/admin/audit-log?"));

const dataRows = () =>
  document.querySelectorAll('[data-ui-datatable-row]');

beforeEach(() => {
  requestLog = [];
  auditReply = pagedReply;
});

// ---------------------------------------------------------------------------

describe("/admin/audit — server-paged log", () => {
  it("page 1 asks for limit=25 with no cursor and renders exactly 25 rows", async () => {
    await mount();
    const first = listRequests()[0];
    expect(first).toContain("limit=25");
    expect(first).not.toContain("cursor=");
    expect(dataRows()).toHaveLength(25);
    expect(screen.getByText("admin.action_000")).toBeTruthy();
    expect(screen.getByText("admin.action_024")).toBeTruthy();
    expect(screen.queryByText("admin.action_025")).toBeNull();
  });

  it("the count is worded from the server's hasMore, and the pager states the page", async () => {
    await mount();
    const count = screen.getByTestId("admin-audit-count");
    // `resultCountSentence` with shown=25, hasMore=true — completeness is the
    // server's statement, no total is claimed.
    expect(count.textContent).toContain("25 audit entries loaded — more available");
    expect(count.textContent).toContain("Page 1");
  });

  it("Next sends the SERVER's cursor; Previous returns to page 1; both disable truthfully", async () => {
    await mount();
    const next = screen.getByTestId("admin-audit-next") as HTMLButtonElement;
    const prev = screen.getByTestId("admin-audit-previous") as HTMLButtonElement;

    // Page 1: nothing to go back to.
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    fireEvent.click(next);
    await settle();
    const second = listRequests()[1];
    expect(second).toContain(`cursor=${ALL[24].id}`);
    expect(screen.getByText("admin.action_025")).toBeTruthy();
    expect(screen.queryByText("admin.action_000")).toBeNull();
    expect(screen.getByTestId("admin-audit-count").textContent).toContain("Page 2");
    expect((screen.getByTestId("admin-audit-previous") as HTMLButtonElement).disabled).toBe(false);

    // On to the LAST page: the server says no more, so Next disables.
    fireEvent.click(screen.getByTestId("admin-audit-next"));
    await settle();
    expect(listRequests()[2]).toContain(`cursor=${ALL[49].id}`);
    expect(dataRows()).toHaveLength(10);
    expect((screen.getByTestId("admin-audit-next") as HTMLButtonElement).disabled).toBe(true);
    const count = screen.getByTestId("admin-audit-count");
    expect(count.textContent).toContain("10 audit entries");
    expect(count.textContent).not.toContain("more available");

    // Previous walks back: page 2 (cursor of page 1's last row), then page 1
    // with NO cursor at all.
    fireEvent.click(screen.getByTestId("admin-audit-previous"));
    await settle();
    expect(listRequests()[3]).toContain(`cursor=${ALL[24].id}`);
    fireEvent.click(screen.getByTestId("admin-audit-previous"));
    await settle();
    const back = listRequests()[4];
    expect(back).not.toContain("cursor=");
    expect(screen.getByText("admin.action_000")).toBeTruthy();
    expect(screen.getByTestId("admin-audit-count").textContent).toContain("Page 1");
    expect((screen.getByTestId("admin-audit-previous") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a row's long tail is disclosed per row, not printed on every entry", async () => {
    await mount();
    // Collapsed: the metadata payload is not in the document.
    expect(screen.queryByText(/metadata-payload-3/)).toBeNull();

    const toggle = document.querySelector('[data-admin-audit-details-toggle="aa-003"]') as HTMLElement;
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle);
    await settle();

    const details = document.querySelector('[data-admin-audit-details="aa-003"]') as HTMLElement;
    expect(details).toBeTruthy();
    expect(details.textContent).toContain("metadata-payload-3");
    expect(within(details).getByText("req-3")).toBeTruthy();

    // Only the opened row disclosed anything.
    expect(document.querySelectorAll("[data-admin-audit-details]")).toHaveLength(1);

    fireEvent.click(toggle);
    await settle();
    expect(screen.queryByText(/metadata-payload-3/)).toBeNull();
  });

  it("keeps the export and verify actions", async () => {
    await mount();
    expect(document.querySelector("[data-admin-audit-export]")).toBeTruthy();
    expect(screen.getByText("Verify Chain")).toBeTruthy();
    // The verify read ran on mount.
    expect(requestLog.some((p) => p.startsWith("/v1/admin/audit-log/verify"))).toBe(true);
  });
});
