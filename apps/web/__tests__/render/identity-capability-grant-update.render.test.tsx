/**
 * Members re-audit DOM-09 — a capability grant (carried forward from a retired
 * delegated-admin tier, or issued here) is UPDATED in Security Center, not only
 * granted and revoked.
 *
 *   PATCH /v1/identity/capabilities/:id
 *     app/(app)/security-center/identity/_sections/MembersSection.tsx — Edit
 *     on a live capability row opens an inline form whose Save sends ONLY the
 *     changed fields, through the same step-up runner grant and revoke use.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  guard: { stamp: () => 0, isStale: (_g: number) => false, generation: 0 },
  fetch: vi.fn(),
  stepUpHeaders: { "x-step-up-challenge": "challenge-1" } as Record<string, string>,
}));

vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/platform-context", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  useTenantGuard: () => mocks.guard,
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true }),
}));

import { MembersSection } from "../../app/(app)/security-center/identity/_sections/MembersSection";

const MEMBER = "tm-0001";
const GRANT = "grant-0001";
const DAY = 24 * 60 * 60 * 1000;

function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const liveGrant = {
  id: GRANT,
  permission: "billing.manage",
  grantedAtUtc: "2026-09-01T09:00:00.000Z",
  expiresAtUtc: null,
  revokedAtUtc: null,
};

function roster(grant: Record<string, unknown>) {
  return {
    teamId: "team-1",
    members: [
      {
        teamMemberId: MEMBER,
        userId: "11111111-1111-4111-8111-111111111111",
        role: "MEMBER",
        status: "ACTIVE",
        accessGrantedAtUtc: null,
        accessExpiresAtUtc: null,
        suspendedAtUtc: null,
        revokedAtUtc: null,
        lastSeenAtUtc: null,
        capabilityGrants: [grant],
        delegatedAdminScopes: [],
      },
    ],
  };
}

let patched: Record<string, unknown> | null = null;

beforeEach(() => {
  patched = null;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/v1/identity/members" && method === "GET") {
      return roster(patched ? { ...liveGrant, ...patched } : liveGrant);
    }
    if (path === `/v1/identity/capabilities/${GRANT}` && method === "PATCH") {
      patched = JSON.parse(String(init?.body));
      return { grant: { ...liveGrant, reason: null, ...patched } };
    }
    throw Object.assign(new Error(`unexpected ${method} ${path}`), { statusCode: 500 });
  });
});
afterEach(cleanup);

const runStepUpAction = vi.fn(
  (action: (headers?: Record<string, string>) => Promise<unknown>) => action(mocks.stepUpHeaders),
);
const stepUp = {
  runStepUpAction: runStepUpAction as unknown as <T>(
    action: (headers?: Record<string, string>) => Promise<T>,
  ) => Promise<T>,
};

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const patches = () =>
  mocks.fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");

async function openMember() {
  render(<MembersSection stepUp={stepUp} />);
  const manage = await waitFor(() => {
    const el = q(`[data-identity-member-manage-access="${MEMBER}"]`);
    expect(el).not.toBeNull();
    return el!;
  });
  fireEvent.click(manage);
  await waitFor(() => expect(q(`[data-identity-capability-row="${GRANT}"]`)).not.toBeNull());
}

describe("Security Center — capability grant update (DOM-09)", () => {
  it("sends only the changed expiry and reason to PATCH, under step-up, and closes the form", async () => {
    await openMember();
    fireEvent.click(q(`[data-identity-capability-edit="${GRANT}"]`)!);
    const expiry = q(`[data-identity-capability-edit-expiry="${GRANT}"]`) as HTMLInputElement;
    const noExpiry = q(`[data-identity-capability-edit-no-expiry="${GRANT}"]`) as HTMLInputElement;
    expect(noExpiry.checked).toBe(true);
    fireEvent.click(noExpiry);
    const next = Date.now() + 45 * DAY;
    fireEvent.change(expiry, { target: { value: localInput(next) } });
    fireEvent.change(q(`[data-identity-capability-edit-reason="${GRANT}"]`)!, {
      target: { value: "Renewal season" },
    });
    fireEvent.click(q(`[data-identity-capability-edit-save="${GRANT}"]`)!);

    await waitFor(() => expect(patches()).toHaveLength(1));
    const [path, init] = patches()[0]!;
    expect(path).toBe(`/v1/identity/capabilities/${GRANT}`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      expiresAtUtc: new Date(localInput(next)).toISOString(),
      reason: "Renewal season",
    });
    expect((init as { headers: Record<string, string> }).headers).toMatchObject({
      "x-step-up-challenge": "challenge-1",
    });
    await waitFor(() => expect(q(`[data-identity-capability-edit-form="${GRANT}"]`)).toBeNull());
  });

  it("refuses a past expiry before any request is sent", async () => {
    await openMember();
    fireEvent.click(q(`[data-identity-capability-edit="${GRANT}"]`)!);
    fireEvent.click(q(`[data-identity-capability-edit-no-expiry="${GRANT}"]`)!);
    fireEvent.change(q(`[data-identity-capability-edit-expiry="${GRANT}"]`)!, {
      target: { value: localInput(Date.now() - DAY) },
    });
    fireEvent.click(q(`[data-identity-capability-edit-save="${GRANT}"]`)!);
    await waitFor(() => expect(q(`[data-identity-capability-edit-error="${GRANT}"]`)).not.toBeNull());
    expect(patches()).toHaveLength(0);
  });
});
