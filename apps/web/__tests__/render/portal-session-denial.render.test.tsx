/**
 * D58 — an open portal page whose session an operator ended (or whose
 * session store is unreachable) shows product copy and the way back, never
 * the raw denial code. The accept page's non-MFA denials get the same copy.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, use: (p: { value: unknown }) => p.value };
});
vi.mock("../../lib/api", () => ({ apiBaseUrl: () => "https://api.example.test" }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
const nav = vi.hoisted(() => ({ search: "", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("../../components/external-portal/WatermarkOverlay", () => ({ WatermarkOverlay: () => null }));

import PortalDashboardPage from "../../app/portal/[token]/page";
import PortalReviewPage from "../../app/portal/[token]/work/[workflowId]/page";
import PortalAcceptPage from "../../app/portal/accept/[grantId]/page";

const API = "https://api.example.test";
const SS_KEY = "proovra.portal.session.v1";
const workflowId = "22222222-2222-4222-8222-222222222222";
const grantId = "33333333-3333-4333-8333-333333333333";
const ENDED = "a".repeat(32);
const FRESH = "b".repeat(32);

type Reply = { status: number; body: unknown };
let queue: Record<string, Reply[]>;
let authBodies: Array<Record<string, unknown>>;
const fetchMock = vi.fn();

function json(r: Reply) {
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
}
function resolved<T>(value: T) {
  const p = Promise.resolve(value) as Promise<T> & { status?: string; value?: T };
  p.status = "fulfilled";
  p.value = value;
  return p;
}
const authOk = (sessionId: string): Reply => ({
  status: 200,
  body: { sessionId, newLogin: sessionId === FRESH, reviewerEmail: "r@x.test", role: "EXTERNAL_REVIEWER", expiresAtUtc: "2027-01-01T00:00:00.000Z" },
});
const dashboardOk: Reply = {
  status: 200,
  body: {
    portal: {
      reviewer: { email: "r@x.test", role: "EXTERNAL_REVIEWER", organization: null, capabilities: ["portal.view", "portal.comment", "portal.decide"] },
      pendingCount: 1,
      completedCount: 0,
      scope: { kind: "WORKFLOW", expiresAtUtc: "2027-01-01T00:00:00.000Z" },
      session: { authMethod: "TOKEN", mfaRequired: false, mfaSatisfied: false, ssoConnectionId: null },
      watermark: { signedToken: "w", policy: "STANDARD" },
      assigned: [{ workflowId, evidenceId: "ev-1", dueAt: null, submittedDecisionAtUtc: null }],
      limitations: [],
    },
  },
};

function next(key: string, fallback: Reply): Reply {
  const q = queue[key];
  return q && q.length > 0 ? q.shift()! : fallback;
}

beforeEach(() => {
  queue = {};
  authBodies = [];
  nav.search = "";
  nav.push.mockReset();
  window.sessionStorage.setItem(SS_KEY, ENDED);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === `${API}/v1/portal/auth`) {
      const body = JSON.parse(String(init.body));
      authBodies.push(body);
      return json(next("auth", authOk(body.existingSessionId ?? FRESH)));
    }
    if (url === `${API}/v1/portal/dashboard`) return json(next("dashboard", dashboardOk));
    if (url.endsWith("/comments")) return json({ status: 200, body: { comments: [] } });
    if (url.endsWith("/view")) return json({ status: 200, body: { ok: true } });
    if (url.endsWith("/decisions")) return json({ status: 200, body: { decisions: [] } });
    if (url.endsWith("/decision")) return json(next("decision", { status: 200, body: { decisionId: "d1", replaced: false } }));
    return json({ status: 404, body: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

function expectNoRawCode(code: string) {
  expect(document.body.textContent ?? "").not.toContain(code);
}

describe("D58 portal session denials", () => {
  it("D58 dashboard: an operator-ended session shows copy and signs in again with a fresh session", async () => {
    queue.dashboard = [{ status: 401, body: { denial: "SESSION_ENDED" } }];
    render(<PortalDashboardPage params={resolved({ token: "tok" })} />);
    await screen.findByText("Your portal session has ended");
    expectNoRawCode("SESSION_ENDED");
    expect(document.querySelector('[data-portal-denial-code="SESSION_ENDED"]')).toBeTruthy();
    expect(document.querySelector("code")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(document.querySelector("[data-portal-dashboard]")).toBeTruthy());
    // The re-exchange carried NO ended session id; the server opened a fresh one.
    const last = authBodies[authBodies.length - 1];
    expect(last.existingSessionId).toBeUndefined();
    expect(window.sessionStorage.getItem(SS_KEY)).toBe(FRESH);
  });

  it("D58 dashboard: an MFA grant signing in again lands on the emailed-code step", async () => {
    queue.dashboard = [{ status: 401, body: { denial: "SESSION_ENDED" } }];
    render(<PortalDashboardPage params={resolved({ token: "tok" })} />);
    await screen.findByText("Your portal session has ended");
    queue.auth = [{ status: 401, body: { denial: "MFA_REQUIRED", codeSent: true, destination: "r***@x.test", resendAvailableInSeconds: 60, attemptsRemaining: null } }];
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await screen.findByText("Confirm it is you");
    expect(document.querySelector("[data-portal-mfa-gate]")).toBeTruthy();
    expect(authBodies[authBodies.length - 1].existingSessionId).toBeUndefined();
  });

  it("D58 dashboard: a session-store outage shows copy and a retry", async () => {
    queue.auth = [{ status: 503, body: { denial: "SESSION_UNAVAILABLE" } }];
    render(<PortalDashboardPage params={resolved({ token: "tok" })} />);
    await screen.findByText("The portal is temporarily unavailable");
    expectNoRawCode("SESSION_UNAVAILABLE");
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(document.querySelector("[data-portal-dashboard]")).toBeTruthy());
  });

  it("D58 dashboard: a revoked invitation reads as copy, not a code", async () => {
    queue.auth = [{ status: 401, body: { denial: "TOKEN_REVOKED" } }];
    render(<PortalDashboardPage params={resolved({ token: "tok" })} />);
    await screen.findByText("This invitation was withdrawn");
    expectNoRawCode("TOKEN_REVOKED");
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
  });

  it("D58 review page: a decision refused with SESSION_ENDED offers sign-in and keeps the draft", async () => {
    render(<PortalReviewPage params={resolved({ token: "tok", workflowId })} />);
    await screen.findByText("You have not recorded a decision for this review yet.");
    fireEvent.change(document.querySelector("[data-portal-decision-rationale]")!, { target: { value: "Needs another pass." } });
    queue.decision = [{ status: 401, body: { denial: "SESSION_ENDED" } }];
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await screen.findByText("Your portal session has ended");
    expectNoRawCode("SESSION_ENDED");
    expect(screen.queryByText("Session Ended")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(document.querySelector("[data-portal-review-surface]")).toBeTruthy());
    expect(authBodies[authBodies.length - 1].existingSessionId).toBeUndefined();
    expect((document.querySelector("[data-portal-decision-rationale]") as HTMLTextAreaElement).value).toBe("Needs another pass.");
  });

  it("D58 review page: a session-store outage on load shows copy, not the code", async () => {
    queue.dashboard = [{ status: 503, body: { denial: "SESSION_UNAVAILABLE" } }];
    render(<PortalReviewPage params={resolved({ token: "tok", workflowId })} />);
    await screen.findByText("The portal is temporarily unavailable");
    expectNoRawCode("SESSION_UNAVAILABLE");
    expect(screen.queryByText("Session Unavailable")).toBeNull();
  });

  it("D58 accept page: a non-MFA denial and an SSO refusal render copy, codes only as attributes", async () => {
    nav.search = "token=tok-accept&sso=denied&reason=SUBJECT_MISMATCH";
    queue.auth = [{ status: 401, body: { denial: "TOKEN_EXPIRED" } }];
    render(<PortalAcceptPage params={resolved({ grantId })} />);
    expect(screen.getByText(/Single sign-on did not accept this sign-in/)).toBeTruthy();
    expectNoRawCode("SUBJECT_MISMATCH");
    expect(document.querySelector('[data-portal-denial-code="SUBJECT_MISMATCH"]')).toBeTruthy();
    // sso=denied does not auto-open; the reviewer chooses the link.
    fireEvent.click(screen.getByRole("button", { name: "Open with invitation link" }));
    await screen.findByText("This invitation has expired");
    expectNoRawCode("TOKEN_EXPIRED");
    expect(document.querySelector('[data-portal-accept-error] [data-portal-denial-code="TOKEN_EXPIRED"]')).toBeTruthy();
    expect(document.querySelector("[data-portal-accept-error] code")).toBeNull();
  });
});
