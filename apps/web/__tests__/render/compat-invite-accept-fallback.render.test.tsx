/**
 * COMPAT (round 3, 2026-11-15) — this web build reaches production before the
 * API it was written for (Vercel deploys on every push; the API is deployed by
 * hand later). Until then it talks to an API that has only the PATH form of the
 * invitation accept (`POST /v1/org-invites/:token/accept`,
 * `POST /v1/teams/invites/:token/accept`) and answers the new BODY form
 * (B-15) with its canonical 404 `ROUTE_NOT_FOUND`.
 *
 *   - against the older API the pages fall back to the path form once, and the
 *     invitation is accepted;
 *   - against the current API nothing changes: one body-form call, and a
 *     refusal (404 `INVITE_NOT_FOUND` included) is never retried;
 *   - A1-06's acceptance prompt opens for a refused WRITE only: the older API
 *     also refuses some READS with 428, and a polled read must not keep
 *     re-opening the prompt.
 *
 * Real apiFetch over a stubbed fetch, with the bodies each API really sends.
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG_TOKEN = "tok-0123456789abcdef";
const WS_TOKEN = `wsit_v1_${"a".repeat(43)}`;
const params = vi.hoisted(() => ({ token: "" }));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useParams: () => ({ token: params.token }),
  usePathname: () => "/",
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", () => ({
  usePlatformContext: () => ({ refresh: async () => {}, envelope: null, switchWorkspace: async () => {} }),
  requestWorkspaceSwitch: async () => ({ ok: true }),
}));
vi.mock("../../app/providers", () => ({
  useAuth: () => ({ authReady: true, user: { email: "invitee@example.test" } }),
}));
vi.mock("../../components/marketing/MarketingHeader", () => ({ MarketingHeader: () => null }));

import OrgInviteAcceptPage from "../../app/(app)/org-invites/[token]/accept/page";
import InviteAcceptPage from "../../app/invite/[token]/page";
import { apiFetch } from "../../lib/api";
import { LEGAL_REACCEPT_REQUIRED_EVENT } from "../../lib/session-events";

type Reply = { status: number; body: unknown };
const ROUTE_NOT_FOUND: Reply = {
  status: 404,
  body: { error: { code: "ROUTE_NOT_FOUND", message: "Resource not found.", requestId: "req-1" } },
};

/** Which API answers: "old" has only the path forms; "new" has both. */
let api: "old" | "new" = "new";
let bodyFormReply: Reply | null = null;
let pathFormReply: Reply = { status: 200, body: {} };
const requests: Array<{ path: string; url: string; method: string; body: string | null }> = [];

const ORG_LOOKUP = {
  state: "PENDING",
  context: {
    organizationName: "Acme Claims",
    role: "ORG_MEMBER",
    invitedEmailMasked: "j•••@acme.test",
    expiresAtUtc: "2026-12-01T00:00:00.000Z",
    workspaces: [],
  },
};
const WS_LOOKUP = {
  state: "PENDING",
  context: {
    workspaceName: "Northgate Investigations",
    organizationName: null,
    role: "MEMBER",
    invitedEmailMasked: "i••••@example.test",
    expiresAtUtc: "2026-11-20T10:00:00.000Z",
  },
};

beforeEach(() => {
  requests.length = 0;
  api = "new";
  bodyFormReply = null;
  pathFormReply = { status: 200, body: {} };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url, "https://x.invalid").pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push({ path, url, method, body: typeof init?.body === "string" ? init.body : null });
      const respond = (r: Reply) =>
        new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
      if (path === "/v1/org-invites/lookup") return respond({ status: 200, body: ORG_LOOKUP });
      if (path === "/v1/teams/invites/lookup") return respond({ status: 200, body: WS_LOOKUP });
      if (path === "/v1/org-invites/accept" || path === "/v1/teams/invites/accept") {
        return respond(api === "old" ? ROUTE_NOT_FOUND : (bodyFormReply ?? { status: 200, body: {} }));
      }
      if (/^\/v1\/(org-invites|teams\/invites)\/[^/]+\/accept$/.test(path)) return respond(pathFormReply);
      return respond({ status: 404, body: { message: "unexpected" } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const acceptCalls = () => requests.filter((r) => r.method === "POST" && r.path.endsWith("/accept"));

async function acceptOrgInvite() {
  params.token = ORG_TOKEN;
  await act(async () => {
    render(<OrgInviteAcceptPage />);
  });
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));
  await settle();
}

describe("organization invitation accept against both APIs", () => {
  it("older API: the body form is unknown there, so the path form is sent once and the invitation is accepted", async () => {
    api = "old";
    pathFormReply = {
      status: 200,
      body: { invitationAccepted: true, organizationId: "org-1", role: "ORG_MEMBER", assignedWorkspaceIds: [] },
    };
    await acceptOrgInvite();
    const calls = acceptCalls();
    expect(calls.map((c) => c.path)).toEqual(["/v1/org-invites/accept", `/v1/org-invites/${ORG_TOKEN}/accept`]);
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ token: ORG_TOKEN });
    expect(calls[1]!.body, "the older route takes no body").toBeNull();
    expect(screen.getByText(/You are now a member of the organization/)).toBeTruthy();
  });

  it("older API: its own refusal after the fallback (flat body, by status) keeps the status wording", async () => {
    api = "old";
    pathFormReply = { status: 410, body: { message: "Invite expired" } };
    await acceptOrgInvite();
    expect(acceptCalls()).toHaveLength(2);
    expect(screen.getByText(/expired, revoked, or already accepted/)).toBeTruthy();
  });

  it("current API: one body-form call; INVITE_NOT_FOUND is its answer, never a reason to try the path form", async () => {
    bodyFormReply = { status: 404, body: { error: { code: "INVITE_NOT_FOUND" }, message: "Invite not found." } };
    await acceptOrgInvite();
    const calls = acceptCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/v1/org-invites/accept");
    expect(calls[0]!.url).not.toContain(ORG_TOKEN);
    expect(screen.getByText("This invitation link isn't available")).toBeTruthy();
  });
});

describe("workspace invitation accept against both APIs", () => {
  async function acceptWorkspaceInvite() {
    params.token = WS_TOKEN;
    render(<InviteAcceptPage />);
    fireEvent.click(await screen.findByTestId("invite-accept"));
    await settle();
  }

  it("older API: falls back to the path form (with the empty body it always took) and accepts", async () => {
    api = "old";
    pathFormReply = { status: 200, body: { workspaceId: "ws-1", role: "MEMBER", alreadyMember: false } };
    await acceptWorkspaceInvite();
    const calls = acceptCalls();
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/teams/invites/accept",
      `/v1/teams/invites/${WS_TOKEN}/accept`,
    ]);
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ token: WS_TOKEN });
    expect(JSON.parse(calls[1]!.body ?? "null")).toEqual({});
    expect(await screen.findByTestId("invite-open-workspace")).toBeTruthy();
  });

  it("current API: a settled refusal is shown as itself and the path form is never called", async () => {
    bodyFormReply = {
      status: 404,
      body: { error: { code: "INVITE_NOT_FOUND" }, code: "INVITE_NOT_FOUND", message: "This invitation link is not available." },
    };
    await acceptWorkspaceInvite();
    expect(acceptCalls().map((c) => c.path)).toEqual(["/v1/teams/invites/accept"]);
  });
});

describe("A1-06 acceptance prompt: refused writes only", () => {
  const LEGAL_428: Reply = {
    status: 428,
    body: { error: { code: "LEGAL_REACCEPT_REQUIRED", message: "Accept the current terms.", details: {} } },
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(LEGAL_428.body), { status: 428, headers: { "content-type": "application/json" } }),
      ),
    );
  });

  it("a write refused with 428 opens the prompt; a read refused with 428 (older API) does not", async () => {
    const events: number[] = [];
    const onEvent = () => events.push(1);
    window.addEventListener(LEGAL_REACCEPT_REQUIRED_EVENT, onEvent);
    try {
      const readErr = await apiFetch("/v1/billing/overview").catch((e: unknown) => e);
      expect((readErr as { code?: string }).code).toBe("LEGAL_REACCEPT_REQUIRED");
      expect(events, "a refused read is an error for its caller, not a prompt").toHaveLength(0);
      await apiFetch("/v1/shares", { method: "POST", body: "{}" }).catch(() => undefined);
      expect(events).toHaveLength(1);
    } finally {
      window.removeEventListener(LEGAL_REACCEPT_REQUIRED_EVENT, onEvent);
    }
  });
});
