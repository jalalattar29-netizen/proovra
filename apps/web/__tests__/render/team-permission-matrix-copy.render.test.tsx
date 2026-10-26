/**
 * Re-audit defect 17 — the Members & Access role dialog, rendered with the
 * REAL matrix the API serves (`buildRbacMatrix`, services/api rbac-matrix.ts),
 * says "workspace" where it means workspace, prints no role enums, cites no
 * workspace seat limit and states the rank rule the engine enforces.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { buildRbacMatrix } from "../../../../services/api/src/services/platform-context/rbac-matrix";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { TeamPermissionMatrix } from "../../app/(app)/teams/[id]/components/TeamPermissionMatrix";

const served = buildRbacMatrix();

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === "/v1/platform/rbac/matrix") return JSON.parse(JSON.stringify(served));
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(cleanup);

/**
 * Mount the dialog and open each row's details in turn (one is open at a
 * time), collecting what a reader sees: the always-visible text plus every
 * description as rendered.
 */
async function mountAndRead() {
  const { container } = render(<TeamPermissionMatrix currentRole="ADMIN" />);
  await screen.findByText("Members & access");
  const details: Record<string, string> = {};
  for (const row of served.categories.flatMap((c) => c.capabilities)) {
    const toggle = container.querySelector(`[data-permission-matrix-expand="${row.id}"]`) as HTMLElement;
    fireEvent.click(toggle);
    const detail = container.querySelector(`[data-permission-matrix-detail="${row.id}"]`);
    expect(detail, row.id).toBeTruthy();
    details[row.id] = detail!.textContent ?? "";
  }
  const text = [container.textContent ?? "", ...Object.values(details)].join("\n");
  return { container, details, text };
}

describe("defect 17 — the rendered role dialog", () => {
  it("never says 'team' meaning Workspace (only 'Collaboration Team')", async () => {
    const { text } = await mountAndRead();
    expect(text).toMatch(/Members & access/);
    expect(text.replace(/Collaboration Teams?/g, "")).not.toMatch(/\bteams?\b/i);
  });

  it("prints no raw role enum and names the viewer's role in words", async () => {
    const { container, text } = await mountAndRead();
    expect(text).not.toMatch(/\b(OWNER|ADMIN|MEMBER|VIEWER|PLATFORM_ADMIN)\b/);
    expect(container.querySelector("[data-permission-matrix-current-role]")!.textContent).toBe("Admin");
  });

  it("cites no workspace seat limit for invitations", async () => {
    const { details } = await mountAndRead();
    expect(details["team.invite"]).not.toMatch(/Subject to the workspace seat limit/i);
    expect(details["team.invite"]).toMatch(/capacity is counted per Collaboration Team, not as a workspace seat limit/);
  });

  it("states the rank rule the engine enforces for role changes and removal", async () => {
    const { details } = await mountAndRead();
    expect(details["team.role_change"]).toMatch(
      /An Admin can move only Members and Viewers between Member and Viewer, and cannot change another Admin or the Owner\./,
    );
    expect(details["team.remove"]).toMatch(
      /The Owner cannot be removed, and an Admin can remove only Members and Viewers, not another Admin\./,
    );
  });
});
