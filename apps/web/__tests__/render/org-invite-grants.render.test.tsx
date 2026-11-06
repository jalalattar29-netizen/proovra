/**
 * PRO-072 (UI-01) — the org-invite page states what accepting grants.
 *
 * It said "This does NOT grant you access to workspace evidence, cases, or
 * reviewer queues" before every acceptance, while accepting wrote the
 * invitation's workspace assignments (the audit's invitation granted
 * workspace ADMIN). The page now reads POST /v1/org-invites/lookup. Mounted
 * with the real apiFetch over a stubbed fetch.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useParams: () => ({ token: "tok-0123456789abcdef" }),
  usePathname: () => "/org-invites/tok-0123456789abcdef/accept",
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", () => ({
  usePlatformContext: () => ({ refresh: async () => {}, envelope: null, switchWorkspace: async () => {} }),
}));

import OrgInviteAcceptPage from "../../app/(app)/org-invites/[token]/accept/page";

let lookupReply: { status: number; body: unknown } = { status: 200, body: {} };
const requests: Array<{ url: string; body: string | null }> = [];

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: typeof init?.body === "string" ? init.body : null });
      if (url.includes("/v1/org-invites/lookup")) {
        return new Response(JSON.stringify(lookupReply.body), {
          status: lookupReply.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    render(<OrgInviteAcceptPage />);
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const pending = (workspaces: Array<{ workspaceName: string; role: string }>) => ({
  status: 200,
  body: {
    state: "PENDING",
    context: {
      organizationName: "Acme Claims",
      role: "ORG_MEMBER",
      invitedEmailMasked: "j•••@acme.test",
      expiresAtUtc: "2026-12-01T00:00:00.000Z",
      workspaces,
    },
  },
});

describe("PRO-072: the invite page says what accepting grants", () => {
  it("an invitation carrying workspace ADMIN says so, and never claims no workspace access", async () => {
    lookupReply = pending([{ workspaceName: "Claims Review", role: "ADMIN" }]);
    await mount();
    // The token travels in the body, never the URL.
    const call = requests.find((r) => r.url.includes("/v1/org-invites/lookup"));
    expect(call?.url).not.toContain("tok-0123456789abcdef");
    expect(call?.body).toContain("tok-0123456789abcdef");

    expect(document.body.textContent).not.toMatch(/does NOT grant/i);
    expect(screen.getByText("Acme Claims")).toBeTruthy();
    const grant = document.querySelector('[data-invite-workspace-role="ADMIN"]');
    expect(grant?.textContent).toContain("Claims Review");
    expect(grant?.textContent).toMatch(/Admin: can manage the workspace/);
    expect(screen.getByRole("button", { name: "Accept invite" })).toBeTruthy();
  });

  it("control: a governance-only invitation says it gives no workspace access", async () => {
    lookupReply = pending([]);
    await mount();
    expect(document.querySelector('[data-invite-workspace-grants="none"]')?.textContent).toMatch(
      /gives you no workspace access/,
    );
    expect(document.querySelector("[data-invite-workspace-role]")).toBeNull();
  });

  it("a revoked invitation offers no Accept button", async () => {
    lookupReply = { status: 200, body: { state: "REVOKED", context: null } };
    await mount();
    expect(screen.getByText("This invitation was revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept invite" })).toBeNull();
  });

  it("an unknown link is unavailable, with no Accept button", async () => {
    lookupReply = { status: 404, body: { error: { code: "INVITE_NOT_FOUND", message: "This invitation link is not available." } } };
    await mount();
    expect(screen.getByText("This invitation link isn't available")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept invite" })).toBeNull();
  });

  it("a failed lookup does not invent a claim either way and still lets the person accept", async () => {
    lookupReply = { status: 500, body: { message: "boom" } };
    await mount();
    const text = document.querySelector('[data-invite-grants="unknown"]')?.textContent ?? "";
    expect(text).toMatch(/any workspaces the invitation names/);
    expect(document.body.textContent).not.toMatch(/does NOT grant|no workspace access/i);
    expect(screen.getByRole("button", { name: "Accept invite" })).toBeTruthy();
  });
});
