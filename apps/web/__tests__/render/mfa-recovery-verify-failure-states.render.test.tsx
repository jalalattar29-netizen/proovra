import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

/**
 * The MFA recovery link's failure states.
 *
 * The verify route answers a flat `{ error: "<reason>" }`. `apiFetch` raises
 * that as a plain Error, not ApiError, and with no `message` in the body it
 * puts the raw response text on the error. So the page has to read the reason
 * back out of that text, and every failure used to land in "unknown".
 *
 * The real `apiFetch` runs against a stubbed network, because a mocked
 * `apiFetch` would prove a branch the page never reaches. The bodies are the
 * route's own (services/api/src/routes/mfa-admin.routes.ts).
 */

const REQUEST_ID = "6f1c2b9e-3a44-4c6d-9a53-0a1f7c2e8d10";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(`id=${REQUEST_ID}&token=${"a".repeat(64)}`),
}));

import MfaRecoveryVerifyPage from "../../app/auth/mfa-recovery/verify/page";

const VERIFY = `/v1/identity/mfa/recovery-requests/${REQUEST_ID}/verify-email`;

let verifyReply: () => Promise<Response>;
const fetchMock = vi.fn();

function json(status: number, body: unknown) {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function failureReason() {
  const alert = await screen.findByRole("alert");
  return alert.getAttribute("data-cc-mfa-recovery-verify-reason");
}

beforeEach(() => {
  verifyReply = json(200, { ok: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith(VERIFY) ? verifyReply() : json(200, { authenticated: false })(),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MFA recovery link failure states", () => {
  it("still reports success", async () => {
    render(<MfaRecoveryVerifyPage />);
    await screen.findByRole("heading", { name: "Email verified" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the link expired for token_expired", async () => {
    verifyReply = json(400, { error: "token_expired" });
    render(<MfaRecoveryVerifyPage />);
    expect(await failureReason()).toBe("expired");
    expect(screen.getByRole("heading", { name: "Recovery link expired" })).toBeTruthy();
  });

  it("says the request was handled for request_not_in_email_pending", async () => {
    verifyReply = json(400, { error: "request_not_in_email_pending" });
    render(<MfaRecoveryVerifyPage />);
    expect(await failureReason()).toBe("already_handled");
    expect(screen.getByRole("heading", { name: "Recovery request already handled" })).toBeTruthy();
  });

  it("says the link is invalid for the concealed 404", async () => {
    verifyReply = json(404, { error: "request_not_found" });
    render(<MfaRecoveryVerifyPage />);
    expect(await failureReason()).toBe("invalid");
    expect(screen.getByRole("heading", { name: "Recovery link invalid" })).toBeTruthy();
  });

  it.each([
    ["a 500 envelope", json(500, { error: { code: "INTERNAL_SERVER_ERROR", message: "Session expired upstream." } })],
    ["a gateway page", async () => new Response("<html>Bad Gateway</html>", { status: 502 })],
    ["a lost connection", async () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("does not name a link problem for %s", async (_name, reply) => {
    verifyReply = reply;
    render(<MfaRecoveryVerifyPage />);
    expect(await failureReason()).toBe("unknown");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Could not verify recovery link" })).toBeTruthy());
  });
});
