/**
 * ONE delegated-administration authority — a member's delegated scope is
 * inspected and UPDATED in Security Center.
 *
 *   PATCH /v1/identity/delegated-admin/:id
 *     app/(app)/security-center/identity/_sections/MembersSection.tsx — a live
 *     scope row shows its kind, when it was granted, its expiry and its
 *     reason; Edit opens an inline form whose Save sends ONLY the changed
 *     fields (the route refuses an empty body and a past expiry) through the
 *     same step-up runner grant and revoke use. The route's `{ scope }` answer
 *     keeps the reason visible after the roster reload.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  // Stable like the real hook (useCallback): a fresh pair per render would
  // re-run every effect keyed on it.
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
const SCOPE = "scope-0001";
const DAY = 24 * 60 * 60 * 1000;

/** The `<input type="datetime-local">` value for an instant, in local time. */
function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const currentExpiry = new Date(Date.now() + 30 * DAY);
currentExpiry.setSeconds(0, 0);

function roster(scope: Record<string, unknown>) {
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
        capabilityGrants: [],
        delegatedAdminScopes: [scope],
      },
    ],
  };
}

const liveScope = {
  id: SCOPE,
  scopeKind: "GOVERNANCE_ADMIN",
  grantedAtUtc: "2026-09-01T09:00:00.000Z",
  expiresAtUtc: currentExpiry.toISOString(),
  revokedAtUtc: null,
  reason: "Quarterly retention audit",
};

let patched: Record<string, unknown> | null = null;

beforeEach(() => {
  patched = null;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/v1/identity/members" && method === "GET") {
      // After an update the roster reflects the new expiry but — like the
      // real projection — carries no reason.
      if (patched) {
        const { reason: _omit, ...rest } = liveScope;
        return roster({
          ...rest,
          expiresAtUtc:
            "expiresAtUtc" in patched ? patched.expiresAtUtc : liveScope.expiresAtUtc,
        });
      }
      return roster(liveScope);
    }
    if (path === `/v1/identity/delegated-admin/${SCOPE}` && method === "PATCH") {
      patched = JSON.parse(String(init?.body));
      return { scope: { ...liveScope, ...patched } };
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

async function openScope() {
  render(<MembersSection stepUp={stepUp} />);
  const manage = await waitFor(() => {
    const el = q(`[data-identity-member-manage-access="${MEMBER}"]`);
    expect(el).not.toBeNull();
    return el!;
  });
  fireEvent.click(manage);
  await waitFor(() => expect(q(`[data-identity-delegated-row="${SCOPE}"]`)).not.toBeNull());
}

describe("Security Center — delegated scope inspect + update", () => {
  it("shows a live scope's kind, grant time, expiry and reason", async () => {
    await openScope();
    const row = q(`[data-identity-delegated-row="${SCOPE}"]`)!;
    expect(row.textContent).toContain("Governance admin");
    expect(row.textContent).toContain("GOVERNANCE_ADMIN");
    expect(q(`[data-identity-delegated-granted="${SCOPE}"]`)!.textContent).toMatch(/^granted /);
    expect(q(`[data-identity-delegated-expiry="${SCOPE}"]`)!.textContent).toMatch(/^expires /);
    expect(q(`[data-identity-delegated-reason="${SCOPE}"]`)!.textContent).toBe(
      "reason: Quarterly retention audit",
    );
  });

  it("sends only the changed expiry and reason to PATCH, under step-up, and keeps the new reason visible", async () => {
    await openScope();
    fireEvent.click(q(`[data-identity-delegated-edit="${SCOPE}"]`)!);
    const expiry = q(`[data-identity-delegated-edit-expiry="${SCOPE}"]`) as HTMLInputElement;
    const reason = q(`[data-identity-delegated-edit-reason="${SCOPE}"]`) as HTMLInputElement;
    // The form opens on the scope's current values.
    expect(expiry.value).toBe(localInput(currentExpiry.getTime()));
    expect(reason.value).toBe("Quarterly retention audit");

    const nextExpiry = currentExpiry.getTime() + 60 * DAY;
    fireEvent.change(expiry, { target: { value: localInput(nextExpiry) } });
    fireEvent.change(reason, { target: { value: "Audit extended to year end" } });
    fireEvent.click(q(`[data-identity-delegated-edit-save="${SCOPE}"]`)!);

    await waitFor(() => expect(patches()).toHaveLength(1));
    const [path, init] = patches()[0]!;
    expect(path).toBe(`/v1/identity/delegated-admin/${SCOPE}`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      expiresAtUtc: new Date(localInput(nextExpiry)).toISOString(),
      reason: "Audit extended to year end",
    });
    // The step-up runner wrapped the request and its headers reached it.
    expect(runStepUpAction).toHaveBeenCalled();
    expect((init as { headers: Record<string, string> }).headers).toMatchObject({
      "content-type": "application/json",
      "x-step-up-challenge": "challenge-1",
    });

    // Success re-reads the roster; the reason comes from the route's answer.
    await waitFor(() =>
      expect(q(`[data-identity-delegated-reason="${SCOPE}"]`)!.textContent).toBe(
        "reason: Audit extended to year end",
      ),
    );
    expect(q(`[data-identity-delegated-edit-form="${SCOPE}"]`)).toBeNull();
    expect(q(`[data-identity-member-result="ok"]`)?.textContent).toBe(
      "Delegated scope Governance admin updated.",
    );
  });

  it("clears the expiry with an explicit null and leaves the reason out when it did not change", async () => {
    await openScope();
    fireEvent.click(q(`[data-identity-delegated-edit="${SCOPE}"]`)!);
    fireEvent.click(q(`[data-identity-delegated-edit-no-expiry="${SCOPE}"]`)!);
    fireEvent.click(q(`[data-identity-delegated-edit-save="${SCOPE}"]`)!);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(String((patches()[0]![1] as RequestInit).body))).toEqual({ expiresAtUtc: null });
    await waitFor(() =>
      expect(q(`[data-identity-delegated-expiry="${SCOPE}"]`)!.textContent).toBe("no expiry"),
    );
  });

  it("refuses an unchanged or past-dated edit locally, without calling the route", async () => {
    await openScope();
    fireEvent.click(q(`[data-identity-delegated-edit="${SCOPE}"]`)!);
    fireEvent.click(q(`[data-identity-delegated-edit-save="${SCOPE}"]`)!);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Change the expiry or the reason first.",
    );

    fireEvent.change(q(`[data-identity-delegated-edit-expiry="${SCOPE}"]`)!, {
      target: { value: localInput(Date.now() - DAY) },
    });
    fireEvent.click(q(`[data-identity-delegated-edit-save="${SCOPE}"]`)!);
    await waitFor(() =>
      expect(q(`[data-identity-delegated-edit-error="${SCOPE}"]`)!.textContent).toBe(
        "The expiry must be in the future.",
      ),
    );
    expect(patches()).toHaveLength(0);
  });
});
