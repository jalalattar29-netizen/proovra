import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));

import { MfaRecoveryRequestPanel } from "../../components/mfa-recovery/MfaRecoveryRequestPanel";

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestId = "77777777-7777-4777-8777-777777777771";
const createUrl = "/v1/identity/mfa-admin/recovery-requests";
const detailUrl = `/v1/identity/mfa-admin/recovery-requests/detail/${requestId}`;
const resendUrl = `/v1/identity/mfa/recovery-requests/${requestId}/resend-email`;
const cancelUrl = `/v1/identity/mfa/recovery-requests/${requestId}/cancel`;
const LATER = "2099-01-01T12:00:00.000Z";

let row: { status: string; emailVerified: boolean; emailResendCount: number };
function detail() {
  return { detail: { id: requestId, userId: "u", teamId, reason: "r", requiredApprovals: 1, approvalCount: 0, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z", ...row } };
}
function posts(url: string) {
  return mocks.fetch.mock.calls.filter(([path, init]) => path === url && init?.method === "POST");
}
function conflict() {
  return Object.assign(new Error("raw body must never render"), { statusCode: 409, code: "API_ERROR", details: { requestId } });
}

beforeEach(() => {
  row = { status: "EMAIL_VERIFICATION_PENDING", emailVerified: false, emailResendCount: 1 };
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === createUrl) throw conflict();
    if (path === detailUrl) return detail();
    if (path === resendUrl) { row = { ...row, emailResendCount: row.emailResendCount + 1 }; return { ok: true, nextResendAfter: LATER }; }
    if (path === cancelUrl) { row = { ...row, status: "CANCELLED" }; return { ok: true }; }
    return {};
  });
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

async function pending() {
  render(<MfaRecoveryRequestPanel teamId={teamId} />);
  fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: "My phone was replaced last week." } });
  fireEvent.click(screen.getByRole("button", { name: "File recovery request" }));
  await screen.findByRole("heading", { name: "Your recovery request" });
  return {
    resend: screen.getByRole("button", { name: "Resend verification email" }),
    cancel: screen.getByRole("button", { name: "Cancel request" }),
  };
}

describe("MFA recovery self-service resend and cancel", () => {
  it("offers resend for the request that blocked a new one, rereads it, and states when to try again", async () => {
    const { resend } = await pending();
    expect(screen.getByText(/Waiting for you to confirm the link/)).toBeTruthy();
    fireEvent.click(resend);
    await screen.findByText(/A new verification link was sent to your email\. You can request another after/);
    expect(posts(resendUrl)).toHaveLength(1);
    expect(posts(resendUrl)[0][1].body).toBeUndefined();
    const paths = mocks.fetch.mock.calls.map((c) => c[0] as string);
    expect(paths.lastIndexOf(detailUrl)).toBeGreaterThan(paths.indexOf(resendUrl));
    const again = screen.getByRole("button", { name: "Resend verification email" });
    expect(again.hasAttribute("disabled")).toBe(true);
    expect(again.getAttribute("data-disabled-reason")).toMatch(/^You can request another email after /);
    expect(document.body.textContent).not.toMatch(/raw body must never render|token/i);
  });

  it("states the cooldown from a 429 without claiming a send", async () => {
    const base = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === resendUrl) throw Object.assign(new Error("x"), { statusCode: 429, details: { reason: "resend_throttled", nextResendAfter: LATER } });
      return base(path, init);
    });
    const { resend } = await pending();
    fireEvent.click(resend);
    expect((await screen.findByText(/A verification email was sent recently\. You can request another after/)).getAttribute("role")).toBe("alert");
    expect(screen.queryByText(/A new verification link was sent/)).toBeNull();
  });

  it("explains the send limit", async () => {
    const base = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === resendUrl) throw Object.assign(new Error("x"), { statusCode: 429, details: { reason: "resend_limit_reached", nextResendAfter: null } });
      return base(path, init);
    });
    const { resend } = await pending();
    fireEvent.click(resend);
    await screen.findByText("No more verification emails can be sent for this request. Cancel it and file a new one.", { selector: "[role=alert]" });
  });

  it("disables resend with a reason once the email is confirmed", async () => {
    row = { status: "PENDING_ADMIN_REVIEW", emailVerified: true, emailResendCount: 1 };
    const { resend, cancel } = await pending();
    expect(resend.hasAttribute("disabled")).toBe(true);
    expect(resend.getAttribute("data-disabled-reason")).toBe("Your email is already confirmed, so no new link is needed.");
    expect(document.getElementById(resend.getAttribute("aria-describedby")!)?.textContent).toBe("Your email is already confirmed, so no new link is needed.");
    expect(cancel.hasAttribute("disabled")).toBe(false);
  });

  it("disables resend at the send limit", async () => {
    row = { status: "EMAIL_VERIFICATION_PENDING", emailVerified: false, emailResendCount: 3 };
    const { resend } = await pending();
    expect(resend.getAttribute("data-disabled-reason")).toBe("No more verification emails can be sent for this request. Cancel it and file a new one.");
  });

  it("cancels after confirmation, rereads, and returns to a state where a new request can be filed", async () => {
    const { cancel } = await pending();
    fireEvent.click(cancel);
    await screen.findByText("Your recovery request was cancelled. You can file a new one below.");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Cancel this recovery request?", tone: "danger" }));
    expect(posts(cancelUrl)).toHaveLength(1);
    const paths = mocks.fetch.mock.calls.map((c) => c[0] as string);
    expect(paths.lastIndexOf(detailUrl)).toBeGreaterThan(paths.indexOf(cancelUrl));
    expect(screen.queryByRole("heading", { name: "Your recovery request" })).toBeNull();
    expect(screen.getByRole("button", { name: "File recovery request" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(/already have a recovery request in flight/)).toBeNull();
  });

  it("cancellation of the confirmation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    const { cancel } = await pending();
    fireEvent.click(cancel);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel request" }).hasAttribute("disabled")).toBe(false));
    expect(posts(cancelUrl)).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Your recovery request" })).toBeTruthy();
  });

  it("maps an already-approved request to the re-enrolment step", async () => {
    const base = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === cancelUrl) { row = { ...row, status: "APPROVED" }; throw Object.assign(new Error("x"), { statusCode: 409 }); }
      return base(path, init);
    });
    const { cancel } = await pending();
    fireEvent.click(cancel);
    await screen.findByText(/already approved, so it cannot be cancelled\. Sign in and enroll a new second factor/);
    await screen.findByText(/Approved\. Sign in and enroll a new second factor\./);
    const again = screen.getByRole("button", { name: "Cancel request" });
    expect(again.getAttribute("data-disabled-reason")).toBe("Only a request that is still waiting can be cancelled.");
  });

  it("does not claim a cancellation the reread does not show", async () => {
    const base = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === cancelUrl) return { ok: true };
      return base(path, init);
    });
    const { cancel } = await pending();
    fireEvent.click(cancel);
    await screen.findByText(/does not show as cancelled yet/);
    expect(screen.queryByText(/was cancelled/)).toBeNull();
  });

  it("offers the actions right after a request is filed", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path === createUrl) return { ok: true, request: { id: requestId, status: "EMAIL_VERIFICATION_PENDING", expiresAt: "2026-01-02T00:00:00.000Z" } };
      if (path === detailUrl) return detail();
      return {};
    });
    await pending();
    expect(screen.getByRole("button", { name: "Resend verification email" }).hasAttribute("disabled")).toBe(false);
  });

  it("never renders a failed request reread as an absent request", async () => {
    const base = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === detailUrl) throw Object.assign(new Error("x"), { statusCode: 503 });
      return base(path, init);
    });
    render(<MfaRecoveryRequestPanel teamId={teamId} />);
    fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: "My phone was replaced last week." } });
    fireEvent.click(screen.getByRole("button", { name: "File recovery request" }));
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("button", { name: "Resend verification email" })).toBeNull();
  });
});
