/**
 * AUD-0037 — the break-glass HOLDER's surface. Real `apiFetch` over a stubbed
 * network, so the refusal branch reads the envelope the use route really sends
 * (`{ error: { code: "break_glass_denied", reason } }`). The step-up hook is
 * replaced by a spy that records the workspace the challenge is bound to and
 * retries the action with a challenge header, as the real primitive does after
 * a successful challenge.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const CURRENT_TEAM = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const GRANT = "33333333-3333-4333-8333-333333333333";
const WS_A = "44444444-4444-4444-8444-444444444444";
const WS_B = "55555555-5555-4555-8555-555555555555";
const CHALLENGE = "66666666-6666-4666-8666-666666666666";

const stepUpCalls: Array<{ teamId: string | null | undefined }> = [];
vi.mock("../../components/identity-security/StepUpModal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/identity-security/StepUpModal")>()),
  useStepUpAction: () => ({
    runStepUpAction: async (
      action: (h?: Record<string, string>) => Promise<unknown>,
      options?: { teamId?: string | null },
    ) => {
      stepUpCalls.push({ teamId: options?.teamId });
      return action({ "x-proovra-step-up-challenge-id": CHALLENGE });
    },
  }),
  StepUpModal: () => null,
}));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform-context")>()),
  useTeamId: () => CURRENT_TEAM,
}));

import { HeldEmergencyGrantsPanel } from "../../components/identity-security/HeldEmergencyGrantsPanel";

function grant(over: Record<string, unknown> = {}) {
  return {
    id: GRANT,
    organizationId: ORG,
    organizationName: "Northwind Legal",
    emergencyUserId: "77777777-7777-4777-8777-777777777777",
    grantedRole: "EMERGENCY_OPERATOR",
    reason: "Incident 93 containment",
    status: "ACTIVE",
    effectiveStatus: "ACTIVE",
    expiresAtUtc: "2026-11-10T18:00:00.000Z",
    workspaces: [{ id: WS_A, name: "Northwind HQ" }],
    stepUpTeamId: WS_A,
    ...over,
  };
}

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let grants: unknown[] = [];
let onRevoke: () => Response = () => json({ viaEmergency: true, capability: "session.revoke", usersRevoked: 3, sessionsAffected: 5 });

const requests = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit | undefined)?.method ?? "GET",
    headers: new Headers((init as RequestInit | undefined)?.headers),
    body: (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined,
  }));
const revokes = () => requests().filter((r) => r.url.includes("/v1/break-glass/emergency/sessions/revoke"));

beforeEach(() => {
  stepUpCalls.length = 0;
  grants = [];
  onRevoke = () => json({ viaEmergency: true, capability: "session.revoke", usersRevoked: 3, sessionsAffected: 5 });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("/v1/break-glass/my-grants")) return json({ grants });
    if (path.includes("/v1/break-glass/emergency/sessions/revoke") && init?.method === "POST") return onRevoke();
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openAndGiveReason(reason = "Compromised admin session") {
  fireEvent.click(await screen.findByRole("button", { name: /end all sessions/i }));
  fireEvent.change(document.querySelector("[data-held-emergency-reason]") as HTMLTextAreaElement, {
    target: { value: reason },
  });
}

describe("HeldEmergencyGrantsPanel", () => {
  it("renders nothing when the caller holds no live grant", async () => {
    const { container } = render(<HeldEmergencyGrantsPanel />);
    await waitFor(() => expect(requests().some((r) => r.url.includes("/v1/break-glass/my-grants"))).toBe(true));
    // Give the resolved read a tick to land, then assert the page gained nothing.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button", { name: /end all sessions/i })).toBeNull();
  });

  it("asks the read about one organization when mounted inside it", async () => {
    render(<HeldEmergencyGrantsPanel organizationId={ORG} />);
    await waitFor(() =>
      expect(requests().some((r) => r.url.includes(`/v1/break-glass/my-grants?organizationId=${ORG}`))).toBe(true),
    );
  });

  it("shows the grant, and ends the organization's sessions through the step-up primitive with the use route's body", async () => {
    grants = [grant()];
    render(<HeldEmergencyGrantsPanel />);
    expect(await screen.findByText("Emergency access to Northwind Legal")).toBeTruthy();
    expect(screen.getByText(/Emergency operator · until/)).toBeTruthy();
    expect(screen.getByText(/Incident 93 containment/)).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "End all sessions in this organization" }));
    const submit = () => document.querySelector(`[data-held-emergency-submit="${GRANT}"]`) as HTMLButtonElement;
    // A reason too short to be one keeps the action closed, and says why.
    fireEvent.change(document.querySelector("[data-held-emergency-reason]") as HTMLTextAreaElement, {
      target: { value: "n/a" },
    });
    expect(submit().disabled).toBe(true);
    expect(submit().getAttribute("data-disabled-reason")).toMatch(/at least 8 characters/);
    expect(revokes()).toHaveLength(0);

    fireEvent.change(document.querySelector("[data-held-emergency-reason]") as HTMLTextAreaElement, {
      target: { value: "  Compromised admin session  " },
    });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());

    await waitFor(() => expect(revokes()).toHaveLength(1));
    // The challenge is taken in the Organization's workspace the holder belongs to.
    expect(stepUpCalls).toEqual([{ teamId: WS_A }]);
    const [sent] = revokes();
    expect(sent.method).toBe("POST");
    expect(sent.body).toEqual({
      teamId: WS_A,
      organizationId: ORG,
      grantId: GRANT,
      stepUpTeamId: WS_A,
      reason: "Compromised admin session",
    });
    expect(sent.headers.get("x-proovra-step-up-challenge-id")).toBe(CHALLENGE);
    expect((await screen.findByText(/Signed out 3 people \(5 sessions\) in Northwind HQ\./)).textContent).toBeTruthy();
  });

  it("a responder who belongs to no workspace of the organization steps up in their own, and picks the workspace", async () => {
    grants = [
      grant({
        stepUpTeamId: null,
        workspaces: [
          { id: WS_A, name: "Northwind HQ" },
          { id: WS_B, name: "Northwind Claims" },
        ],
      }),
    ];
    render(<HeldEmergencyGrantsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "End all sessions in this workspace" }));
    fireEvent.click(document.querySelector("[data-held-emergency-workspace]") as HTMLButtonElement);
    fireEvent.click(await screen.findByRole("option", { name: /Northwind Claims/ }));
    fireEvent.change(document.querySelector("[data-held-emergency-reason]") as HTMLTextAreaElement, {
      target: { value: "Claims desk credential leak" },
    });
    fireEvent.click(document.querySelector(`[data-held-emergency-submit="${GRANT}"]`) as HTMLButtonElement);
    await waitFor(() => expect(revokes()).toHaveLength(1));
    expect(stepUpCalls).toEqual([{ teamId: CURRENT_TEAM }]);
    expect(revokes()[0].body).toMatchObject({ teamId: WS_B, stepUpTeamId: CURRENT_TEAM, grantId: GRANT });
  });

  it("answers a bounded refusal in words and re-reads the grants it made stale", async () => {
    grants = [grant()];
    onRevoke = () => json({ error: { code: "break_glass_denied", reason: "grant_expired" } }, 403);
    render(<HeldEmergencyGrantsPanel />);
    await openAndGiveReason();
    const reads = () => requests().filter((r) => r.url.includes("/v1/break-glass/my-grants")).length;
    const before = reads();
    fireEvent.click(document.querySelector(`[data-held-emergency-submit="${GRANT}"]`) as HTMLButtonElement);
    expect(await screen.findByText("This emergency access has expired. Nothing was changed.")).toBeTruthy();
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it("offers no session action on a read-only grant", async () => {
    grants = [grant({ grantedRole: "EMERGENCY_READ_ONLY" })];
    render(<HeldEmergencyGrantsPanel />);
    expect(await screen.findByText(/This access is read-only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /end all sessions/i })).toBeNull();
  });
});
