import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * B1-F-002 — a recovery request nobody could approve is refused (409
 * `no_eligible_approver`, flat body), and the panel says what the person can
 * still use instead of "a request is already in flight". The real `apiFetch`
 * runs against a stubbed network: the route's body is flat, and only the real
 * client proves which fields it carries.
 *
 * Plus the guidance an account with a second factor but no recovery codes sees.
 */

vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: vi.fn() }) }));

import {
  MfaRecoveryRequestPanel,
  NO_ELIGIBLE_APPROVER_COPY,
} from "../../components/mfa-recovery/MfaRecoveryRequestPanel";
import {
  NO_RECOVERY_CODES_COPY,
  RecoveryCodesNotice,
  SINGLE_FACTOR_COPY,
  recoveryCodesActionLabel,
} from "../../components/identity-security/RecoveryCodesNotice";

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fetchMock = vi.fn();
let createReply: { status: number; body: unknown };

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const reply = String(url).endsWith("/v1/identity/mfa-admin/recovery-requests")
      ? createReply
      : { status: 404, body: { error: "not_found" } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function file() {
  render(<MfaRecoveryRequestPanel teamId={teamId} />);
  fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: "My phone was replaced last week." } });
  fireEvent.click(screen.getByRole("button", { name: "File recovery request" }));
}

describe("recovery request with no eligible approver", () => {
  it("states the limits and the methods still usable, and never claims a request is in flight", async () => {
    createReply = { status: 409, body: { error: "no_eligible_approver", details: { reason: "no_eligible_approver" } } };
    await file();
    expect(await screen.findByText(NO_ELIGIBLE_APPROVER_COPY)).toBeTruthy();
    expect(NO_ELIGIBLE_APPROVER_COPY).toMatch(/no request was filed/);
    expect(NO_ELIGIBLE_APPROVER_COPY).toMatch(/recovery codes/);
    expect(NO_ELIGIBLE_APPROVER_COPY).toMatch(/support cannot remove a second factor/);
    expect(screen.queryByText(/already have a recovery request in flight/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Your recovery request" })).toBeNull();
  });

  it("control: a 409 for a request in flight is still reported as one", async () => {
    createReply = { status: 409, body: { error: "already_pending", details: { requestId: null } } };
    await file();
    expect(await screen.findByText(/already have a recovery request in flight/)).toBeTruthy();
    expect(screen.queryByText(NO_ELIGIBLE_APPROVER_COPY)).toBeNull();
  });

  it("the panel says up front that a personal workspace has no administrator and support cannot remove a factor", () => {
    render(<MfaRecoveryRequestPanel teamId={teamId} />);
    expect(screen.getByText(/a personal workspace has none, and PROOVRA support cannot remove a second factor/)).toBeTruthy();
  });
});

describe("recovery-code guidance for an account with a second factor", () => {
  it("no codes: warns that losing the factor locks the account, and the action generates rather than regenerates", () => {
    render(<RecoveryCodesNotice activeFactorCount={1} recoveryCodesRemaining={0} />);
    expect(screen.getByRole("alert").textContent).toBe(NO_RECOVERY_CODES_COPY);
    expect(screen.getByText(SINGLE_FACTOR_COPY)).toBeTruthy();
    expect(recoveryCodesActionLabel(0)).toBe("Generate recovery codes");
    expect(recoveryCodesActionLabel(4)).toBe("Regenerate recovery codes");
  });

  it("codes and two factors: nothing to say; no factor: nothing to say", () => {
    const { container, rerender } = render(<RecoveryCodesNotice activeFactorCount={2} recoveryCodesRemaining={8} />);
    expect(container.textContent).toBe("");
    rerender(<RecoveryCodesNotice activeFactorCount={0} recoveryCodesRemaining={0} />);
    expect(container.textContent).toBe("");
  });
});
