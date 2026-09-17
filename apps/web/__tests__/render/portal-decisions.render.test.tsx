import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The render harness runs React 18, which has no `use`; the page only reads
// an already-resolved params promise, so read its settled value.
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
const decisionsUrl = `${API}/v1/portal/work/${workflowId}/decisions`;
const decisionUrl = `${API}/v1/portal/work/${workflowId}/decision`;

type Handler = (url: string, init: RequestInit) => { status: number; body: unknown } | undefined;
let capabilities: string[];
let recorded: { verdict: string; rationale: string | null } | null;
let override: Handler | null;
const fetchMock = vi.fn();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function resolved<T>(value: T) {
  const p = Promise.resolve(value) as Promise<T> & { status?: string; value?: T };
  p.status = "fulfilled";
  p.value = value;
  return p;
}
function decisionRow() {
  return recorded
    ? [{ id: "d1", workflowId, verdict: recorded.verdict, rationale: recorded.rationale, submittedAtUtc: "2026-02-03T10:00:00.000Z" }]
    : [];
}
function writes() {
  return fetchMock.mock.calls.filter(([url, init]) => url === decisionUrl && init?.method === "POST");
}

beforeEach(() => {
  capabilities = ["portal.view", "portal.comment", "portal.decide"];
  recorded = null;
  override = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const o = override?.(url, init);
    if (o) return json(o.status, o.body);
    if (url === `${API}/v1/portal/auth`) return json(200, { sessionId: "s1", newLogin: false, reviewerEmail: "r@x.test", role: "EXTERNAL_REVIEWER", expiresAtUtc: "2027-01-01T00:00:00.000Z" });
    if (url === `${API}/v1/portal/dashboard`) {
      return json(200, { portal: { reviewer: { email: "r@x.test", role: "EXTERNAL_REVIEWER", capabilities }, watermark: { signedToken: "w", policy: "STANDARD" }, assigned: [{ workflowId, evidenceId: "ev-1" }] } });
    }
    if (url.endsWith("/comments")) return json(200, { comments: [] });
    if (url.endsWith("/view")) return json(200, { ok: true });
    if (url === decisionsUrl) return json(200, { decisions: decisionRow() });
    if (url === decisionUrl && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      const replaced = recorded !== null;
      recorded = { verdict: body.verdict, rationale: body.rationale ?? null };
      return json(200, { decisionId: "d1", replaced });
    }
    return json(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(<PortalReviewPage params={resolved({ token: "tok", workflowId })} />);
}

describe("external portal recorded decision", () => {
  it("shows the decision the reviewer recorded after a reload, from the API origin", async () => {
    recorded = { verdict: "REJECT", rationale: "Faces are visible in frame 12." };
    renderPage();
    await screen.findByText("Your recorded decision");
    expect(screen.getByText("Reject", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("Faces are visible in frame 12.")).toBeTruthy();
    expect(screen.getByText("Submitting again replaces this decision.")).toBeTruthy();
    // Every portal call addresses the API origin, never the web origin.
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith(API))).toBe(true);
    const headers = fetchMock.mock.calls.find(([url]) => url === decisionsUrl)![1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("submits the verdict and announces it only after the reread shows it", async () => {
    renderPage();
    await screen.findByText("You have not recorded a decision for this review yet.");
    fireEvent.change(document.querySelector("[data-portal-decision-rationale]")!, { target: { value: "Needs another pass." } });
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await screen.findByText("Decision recorded: Request changes.");
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1].body))).toEqual({ verdict: "REQUEST_CHANGES", rationale: "Needs another pass." });
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.lastIndexOf(decisionsUrl)).toBeGreaterThan(urls.indexOf(decisionUrl));
    expect(screen.getByText("Your recorded decision")).toBeTruthy();
    expect(screen.getByText("Needs another pass.")).toBeTruthy();
  });

  it("says when a resubmission replaced the previous decision", async () => {
    recorded = { verdict: "REJECT", rationale: "x" };
    renderPage();
    await screen.findByText("Your recorded decision");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Decision recorded: Approve. It replaces your previous decision.");
  });

  it("does not claim success when the reread does not show the verdict", async () => {
    override = (url) => (url === decisionsUrl ? { status: 200, body: { decisions: [] } } : undefined);
    renderPage();
    await screen.findByText("You have not recorded a decision for this review yet.");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText(/the saved record does not show it yet/);
    expect(screen.queryByText(/^Decision recorded/)).toBeNull();
  });

  it("does not claim success when the submission is refused", async () => {
    override = (url, init) => (url === decisionUrl && init.method === "POST" ? { status: 403, body: { denial: "NOT_PERMITTED" } } : undefined);
    renderPage();
    await screen.findByText("You have not recorded a decision for this review yet.");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Your role cannot record a decision on this review.");
    expect(screen.queryByText(/^Decision recorded/)).toBeNull();
  });

  it("never renders a refused or failed decision read as 'no decision'", async () => {
    override = (url) => (url === decisionsUrl ? { status: 403, body: { denial: "NOT_PERMITTED" } } : undefined);
    const view = renderPage();
    await screen.findByText("Your recorded decision is not available for this review.");
    expect(screen.queryByText(/have not recorded a decision/)).toBeNull();
    view.unmount();

    override = (url) => (url === decisionsUrl ? { status: 503, body: {} } : undefined);
    renderPage();
    const alert = await waitFor(() => {
      const el = document.querySelector("[data-portal-recorded-decision] [role=alert]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(alert.textContent).not.toMatch(/503/);
    expect(screen.queryByText(/have not recorded a decision/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("history-only reviewers see their decision but cannot decide", async () => {
    capabilities = ["portal.view", "portal.history.read"];
    recorded = { verdict: "APPROVE", rationale: null };
    renderPage();
    await screen.findByText("Your recorded decision");
    expect(screen.getByText("Approve")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText(/Your role is read-only for decisions/)).toBeTruthy();
  });

  it("does not read decisions without a decide or history capability", async () => {
    capabilities = ["portal.view", "portal.comment"];
    renderPage();
    await screen.findByText("Your role cannot view recorded decisions for this review.");
    expect(fetchMock.mock.calls.some(([url]) => url === decisionsUrl)).toBe(false);
  });

  it("keeps the portal's own single main landmark", async () => {
    renderPage();
    await screen.findByText("You have not recorded a decision for this review yet.");
    expect(document.querySelectorAll("main")).toHaveLength(1);
  });
});
