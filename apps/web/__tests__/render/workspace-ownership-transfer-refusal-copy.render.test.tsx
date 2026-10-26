/**
 * MEMBERS AUDIT LIFE-14 — each ownership-transfer refusal reaches the owner in
 * its own words.
 *
 * The server answers every refused transfer with its own code (proven in
 * members-reaudit-membership-concurrency "LIFE-14 — each transfer refusal
 * reaches the client with its own code"). The card used to collapse every 409
 * into one sentence listing all three reasons. It now maps each code to its
 * own copy (`TRANSFER_REFUSAL_COPY` / `denialCopy` in
 * WorkspaceOwnershipTransferCard.tsx). This drives the REAL card through a
 * real transfer attempt for each code, exactly as the API sends it (lowercase
 * codes included), and checks an unknown code falls back safely.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  refusal: null as null | { code: string; statusCode: number },
}));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../app/(app)/security-center/components/PersonalSecuritySections", () => ({
  StepUpVerify: () => null,
  extractStepUp: () => null,
}));

import { WorkspaceOwnershipTransferCard } from "../../app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";

/** The refusal exactly as the client receives it: an error carrying the server's code and status. */
function refusalError(code: string, statusCode: number) {
  return Object.assign(new Error(`refused: ${code}`), { code, statusCode });
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST" && path === `/v1/teams/${TEAM}/transfer-ownership`) {
      const r = mocks.refusal!;
      throw refusalError(r.code, r.statusCode);
    }
    if (path.startsWith(`/v1/teams/${TEAM}/members?`)) {
      return {
        members: [{ userId: "user-heir", user: { displayName: "Heir One", email: "heir@example.org" } }],
        nextCursor: null,
        total: 1,
      };
    }
    return {};
  });
});
afterEach(cleanup);

async function attempt(code: string, statusCode = 409): Promise<HTMLElement> {
  mocks.refusal = { code, statusCode };
  const { container } = render(
    <WorkspaceOwnershipTransferCard teamId={TEAM} teamName="Casework" currentUserId="user-owner" onTransferred={() => {}} />,
  );
  const card = container.querySelector("[data-workspace-ownership-transfer-card]") as HTMLElement;
  const select = (await within(card).findByLabelText("New owner")) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "user-heir" } });
  fireEvent.click(card.querySelector('[data-action="open-workspace-transfer-ownership"]') as HTMLElement);
  fireEvent.click(card.querySelector('[data-action="transfer-workspace-ownership"]') as HTMLElement);
  await waitFor(() =>
    expect(mocks.fetch).toHaveBeenCalledWith(`/v1/teams/${TEAM}/transfer-ownership`, expect.objectContaining({ method: "POST" })),
  );
  await waitFor(() => expect(card.getAttribute("aria-busy")).toBe("false"));
  return card;
}

const COPY: Record<string, string> = {
  TRANSFER_TARGET_NOT_ACTIVE_MEMBER:
    "That person isn't an active member of this workspace any more. Choose someone who is.",
  TRANSFER_TARGET_IS_OWNER: "That person already owns this workspace.",
  PERSONAL_WORKSPACE_NOT_TRANSFERABLE: "A Personal Workspace belongs to its account and can't change owners.",
  ORG_WORKSPACE_OWNERSHIP_IS_ORG_GOVERNED:
    "This workspace belongs to an organization; its ownership is managed by the organization.",
  NOT_WORKSPACE_OWNER: "Only the workspace owner can transfer ownership.",
  WORKSPACE_KIND_UNKNOWN:
    "This workspace's type couldn't be confirmed, so ownership wasn't transferred. Nothing was changed.",
};
const GENERIC_409 =
  "Ownership couldn't be transferred: a personal space can't change owners, an organization workspace is governed at the organization level, and the new owner must already be an active member of this workspace.";

describe("ownership transfer — each refusal code shows its own copy (LIFE-14)", () => {
  for (const [code, copy] of Object.entries(COPY)) {
    // The API sends the transfer codes in lowercase; the card must match either.
    for (const sent of [code.toLowerCase(), code]) {
      it(`${sent} → its own sentence, and never the collapsed 409 sentence`, async () => {
        const card = await attempt(sent, code === "NOT_WORKSPACE_OWNER" ? 403 : 409);
        expect(within(card).getByText(copy)).toBeTruthy();
        expect(within(card).queryByText(GENERIC_409)).toBeNull();
        for (const [other, otherCopy] of Object.entries(COPY)) {
          if (other !== code) expect(within(card).queryByText(otherCopy)).toBeNull();
        }
      });
    }
  }

  it("an unknown 409 code falls back to the safe generic sentence, not to any specific reason", async () => {
    const card = await attempt("SOMETHING_THE_CARD_HAS_NEVER_SEEN", 409);
    expect(within(card).getByText(GENERIC_409)).toBeTruthy();
    for (const copy of Object.values(COPY)) expect(within(card).queryByText(copy)).toBeNull();
  });

  it("an unknown code on an unexpected status falls back to the safe generic error without inventing a reason", async () => {
    const card = await attempt("SOMETHING_ELSE", 500);
    expect(card.textContent).toMatch(/try again|has not been changed|Nothing was changed/i);
    for (const copy of Object.values(COPY)) expect(within(card).queryByText(copy)).toBeNull();
    expect(within(card).queryByText(GENERIC_409)).toBeNull();
  });
});
