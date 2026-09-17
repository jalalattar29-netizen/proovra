/**
 * D17 — a cross-org review invitation names the record under review.
 *
 *   POST /v1/governance/cross-org-review
 *     components/governance/CrossOrgReviewForms.tsx — acceptance issues the
 *     reviewer-portal invitation for exactly one evidence record, matter or
 *     package of the inviting workspace. The form used to send free text only,
 *     so every review created in the product could never be accepted. The
 *     operator now chooses the record from this workspace; submit stays
 *     disabled, with the reason shown, until one is chosen; the body carries
 *     the subject.
 */
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), created: vi.fn() }));

vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/platform-context/useTeamWorkspaceGate", () => ({
  useActiveWorkspaceId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
}));
vi.mock("../../components/governance/governance-action-state", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    useGovernanceOrganization: () => ({
      organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      departments: [],
      loading: false,
      failed: false,
    }),
    useDelegatedTierAccess: () => ({ ready: true, hasTier: () => true, hasAnyTier: () => true }),
    // The runner's tenant guard needs the platform provider; the form only
    // needs "run the write, then report".
    useGovernanceAction: () => {
      const [busy, setBusy] = useState(false);
      const [outcome, setOutcome] = useState<{ kind: string; message: string } | null>(null);
      return {
        busy,
        outcome,
        reset: () => setOutcome(null),
        run: async (fn: () => Promise<void>, copy: { success: string }) => {
          setBusy(true);
          await fn();
          setBusy(false);
          setOutcome({ kind: "success", message: copy.success });
        },
      };
    },
  };
});

import { CrossOrgInviteForm } from "../../components/governance/CrossOrgReviewForms";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVIDENCE = "11111111-1111-4111-8111-111111111111";
const INVITE = "/v1/governance/cross-org-review";
const REASON = "Choose the record the invited organization will review.";

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === INVITE && init?.method === "POST") return { grantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
    if (path.startsWith("/v1/evidence?")) {
      return { items: [{ id: EVIDENCE, title: "Dock camera footage", createdAt: "2026-01-01T00:00:00.000Z" }] };
    }
    throw Object.assign(new Error("unexpected path " + path), { statusCode: 500 });
  });
  mocks.created.mockReset();
});
afterEach(cleanup);

const submit = () => document.querySelector("[data-cross-org-invite-submit]") as HTMLButtonElement;
const posts = () => mocks.fetch.mock.calls.filter(([p, init]) => p === INVITE && init?.method === "POST");

function fillText() {
  fireEvent.change(document.querySelector("[data-cross-org-invite-slug]") as HTMLElement, {
    target: { value: "partner-legal" },
  });
  fireEvent.change(document.querySelector("[data-cross-org-invite-scope]") as HTMLElement, {
    target: { value: "Review the dock camera footage for the harbor claim." },
  });
}

describe("cross-org invite subject (D17)", () => {
  it("keeps the invite disabled, with the reason visible, until a record is chosen", async () => {
    render(<CrossOrgInviteForm onCreated={mocks.created} />);
    fillText();
    expect(submit().disabled).toBe(true);
    await waitFor(() =>
      expect(document.querySelector('[data-cross-org-invite-blocked="subject"]')?.textContent).toBe(REASON),
    );
    expect(screen.getByText("What will the invited organization review?")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /^Evidence record/ }));
    const record = await screen.findByRole("radio", { name: /Dock camera footage/ });
    expect(submit().disabled).toBe(true);
    fireEvent.click(record);
    await waitFor(() => expect(submit().disabled).toBe(false));
    expect(document.querySelector('[data-cross-org-invite-blocked="subject"]')).toBeNull();
    expect(document.querySelector("[data-bulk-scope-summary]")?.textContent).toMatch(
      /^The invited organization will review: Dock camera footage/,
    );
    // Only this workspace's records are offered.
    const listCall = mocks.fetch.mock.calls.find(([p]) => String(p).startsWith("/v1/evidence?"));
    expect(new URL(String(listCall![0]), "http://localhost").searchParams.get("teamId")).toBe(TEAM);
    expect(posts()).toHaveLength(0);
  });

  it("sends the chosen record as the subject and resets the choice after the list is refreshed", async () => {
    render(<CrossOrgInviteForm onCreated={mocks.created} />);
    fillText();
    fireEvent.click(screen.getByRole("radio", { name: /^Evidence record/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /Dock camera footage/ }));
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({
      invitingOrganizationId: ORG,
      invitedOrgSlug: "partner-legal",
      scope: "Review the dock camera footage for the harbor claim.",
      subject: { kind: "EVIDENCE", id: EVIDENCE },
      expiresAtUtc: null,
    });
    await waitFor(() => expect(mocks.created).toHaveBeenCalledTimes(1));
    // A new invitation starts with no record chosen.
    await waitFor(() => expect(submit().disabled).toBe(true));
    expect(screen.queryByRole("radio", { name: /Dock camera footage/ })).toBeNull();
  });
});
