/**
 * `/portal/[token]/work/[workflowId]`: what a reviewer sees when the grant does not
 * reach the workflow, when it is revoked under an open page, and on a comment by
 * another reviewer. Real portal client over a stubbed network, with the bodies
 * cov-external-reviewer.integration.test.ts proves against real rows.
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
vi.mock("../../components/external-portal/WatermarkOverlay", () => ({ WatermarkOverlay: () => null }));

import PortalReviewPage from "../../app/portal/[token]/work/[workflowId]/page";

const API = "https://api.example.test";
const workflowId = "22222222-2222-4222-8222-222222222222";
const SESSION = "a".repeat(32);

type Reply = { status: number; body: unknown };
let comments: Reply;
let posted: Reply;
const fetchMock = vi.fn();

const json = (r: Reply) =>
  new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });

function settled<T>(value: T) {
  const p = Promise.resolve(value) as Promise<T> & { status?: string; value?: T };
  p.status = "fulfilled";
  p.value = value;
  return p;
}

const dashboard: Reply = {
  status: 200,
  body: {
    portal: {
      reviewer: {
        email: "r@x.test",
        role: "EXTERNAL_REVIEWER",
        organization: null,
        capabilities: ["portal.view", "portal.comment", "portal.decide"],
      },
      pendingCount: 1,
      completedCount: 0,
      scope: { kind: "EVIDENCE", expiresAtUtc: "2027-01-01T00:00:00.000Z" },
      session: { authMethod: "TOKEN", mfaRequired: false, mfaSatisfied: false, ssoConnectionId: null },
      watermark: { signedToken: "w", policy: "ALWAYS" },
      assigned: [{ workflowId, evidenceId: "ev-1", dueAt: null, submittedDecisionAtUtc: null }],
      limitations: [],
    },
  },
};

beforeEach(() => {
  comments = { status: 200, body: { comments: [] } };
  posted = { status: 201, body: { commentId: "c1" } };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === `${API}/v1/portal/auth`) {
      return json({
        status: 200,
        body: { sessionId: SESSION, newLogin: true, reviewerEmail: "r@x.test", role: "EXTERNAL_REVIEWER", expiresAtUtc: "2027-01-01T00:00:00.000Z" },
      });
    }
    if (url === `${API}/v1/portal/dashboard`) return json(dashboard);
    if (url.endsWith("/comments") && init.method === "POST") return json(posted);
    if (url.endsWith("/comments")) return json(comments);
    if (url.endsWith("/decisions")) return json({ status: 200, body: { decisions: [] } });
    if (url.endsWith("/view")) return json({ status: 200, body: { ok: true } });
    return json({ status: 404, body: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

const open = () => render(<PortalReviewPage params={settled({ token: "tok", workflowId })} />);

describe("portal work page", () => {
  it("a workflow outside the grant shows the notice, not an empty review", async () => {
    comments = { status: 403, body: { denial: "OUT_OF_SCOPE" } };
    open();
    await waitFor(() => expect(document.querySelector('[data-portal-denial-code="OUT_OF_SCOPE"]')).toBeTruthy());
    expect(document.querySelector("[data-portal-review-surface]")).toBeNull();
    expect(document.body.textContent).not.toContain("OUT_OF_SCOPE");
  });

  it.each(["TOKEN_REVOKED", "TOKEN_EXPIRED"])("a grant ending under an open page (%s) replaces the page", async (denial) => {
    open();
    await waitFor(() => expect(document.querySelector("[data-portal-review-surface]")).toBeTruthy());
    posted = { status: 401, body: { denial } };
    fireEvent.change(document.querySelector("[data-portal-root-comment-input]") as HTMLInputElement, {
      target: { value: "Still here?" },
    });
    fireEvent.click(document.querySelector("[data-portal-root-comment-submit]") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector(`[data-portal-denial-code="${denial}"]`)).toBeTruthy());
    expect(document.querySelector("[data-portal-review-surface]")).toBeNull();
  });

  it("another reviewer's comment, which comes with no address, still reads as a person", async () => {
    comments = {
      status: 200,
      body: {
        comments: [
          { id: "1", parentCommentId: null, body: "Named.", authorEmail: null, authorDisplay: "Dana Reviewer", createdAt: "2026-10-01T10:00:00.000Z", resolvedAtUtc: null },
          { id: "2", parentCommentId: null, body: "Unnamed.", authorEmail: null, authorDisplay: null, createdAt: "2026-10-01T10:00:00.000Z", resolvedAtUtc: null },
        ],
      },
    };
    open();
    await screen.findByText("Unnamed.");
    expect(document.body.textContent).toContain("Dana Reviewer");
    expect(document.body.textContent).toContain("Another reviewer");
    expect(document.body.textContent).not.toContain("null");
  });

  it("offers the disclosure package, not a frame the app refuses to load", async () => {
    open();
    await waitFor(() => expect(document.querySelector("[data-portal-package-panel]")).toBeTruthy());
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("says why when the grant does not carry the file", async () => {
    const served = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) =>
      url.endsWith("/verification-package")
        ? json({ status: 403, body: { error: { code: "package_download_not_granted" } } })
        : served(url, init),
    );
    open();
    await waitFor(() => expect(document.querySelector("[data-portal-package-download]")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-portal-package-download]") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector("[data-portal-package-message]")).toBeTruthy());
    expect(document.querySelector("[data-portal-package-message]")!.textContent).toContain("does not include the file");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/v1/portal/work/${workflowId}/verification-package`))).toBe(true);
  });
});
