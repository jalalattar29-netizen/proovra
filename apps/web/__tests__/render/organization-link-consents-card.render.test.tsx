/**
 * PRO-A2-02 (owner decision A) — Settings → Security: the owner withdraws an
 * Organization's sign-in link consent.
 *
 * The REAL `apiFetch` runs over a stubbed `fetch`; the bodies are the ones
 * identity-links.routes.ts sends. The step-up prompt is the real shared one.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { OrganizationLinkConsentsCard } from "../../components/identity-security/OrganizationLinkConsentsCard";
import { StepUpVerify } from "../../app/(app)/security-center/components/PersonalSecuritySections";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ORG = "11111111-1111-4111-8111-111111111111";
const LIVE = [
  {
    id: "c1",
    organizationId: ORG,
    organizationName: "Acme Legal",
    provider: "GENERIC_OIDC",
    connectionId: "22222222-2222-4222-8222-222222222222",
    approvedAtUtc: "2026-11-21T10:00:00.000Z",
    endedAtUtc: null,
    endReason: null,
  },
  {
    id: "c2",
    organizationId: ORG,
    organizationName: "Acme Legal",
    provider: "GENERIC_SAML",
    connectionId: "33333333-3333-4333-8333-333333333333",
    approvedAtUtc: "2026-11-21T09:00:00.000Z",
    endedAtUtc: null,
    endReason: null,
  },
];
const ENDED = LIVE.map((c) => ({ ...c, endedAtUtc: "2026-11-21T11:00:00.000Z", endReason: "WITHDRAWN" }));

const fetchMock = vi.fn();
const WITHDRAW_URL = `/v1/identity/links/organization-consents/${ORG}/withdraw`;

const posts = () =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith(WITHDRAW_URL) && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

function serve(lists: unknown[][], postReplies: Response[]) {
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/identity/links/organization-consents") && (init?.method ?? "GET") === "GET") {
      return json({ consents: lists.length > 1 ? lists.shift() : lists[0] });
    }
    if (url.endsWith(WITHDRAW_URL)) {
      return postReplies.shift() ?? json({ error: { code: "unexpected" } }, 500);
    }
    return json({});
  });
}

const stepUpRequired = () =>
  json({ error: { code: "STEP_UP_REQUIRED", methods: ["password"], message: "Confirm it's you." } }, 401);

function mount() {
  return render(<OrganizationLinkConsentsCard StepUpPrompt={StepUpVerify} />);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OrganizationLinkConsentsCard", () => {
  it("is absent when no organization holds a live consent", async () => {
    serve([ENDED], []);
    const { container } = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector("[data-cc-organization-link-consents]")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("lists the organization once and withdraws its consent with the step-up proof", async () => {
    serve([LIVE, ENDED], [stepUpRequired(), json({ withdrawn: true, organizationId: ORG, count: 2 })]);
    const { container } = mount();
    await screen.findByText("Acme Legal");
    expect(container.querySelectorAll("[data-cc-organization-link-consent-row]")).toHaveLength(1);
    expect(container.textContent).toMatch(/membership stays, and nobody is signed out/);

    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    const input = await screen.findByLabelText("Current password");
    expect(posts()).toEqual([{}]);
    fireEvent.change(input, { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: /Verify & continue/ }));

    expect((await screen.findByRole("status")).textContent).toMatch(/Acme Legal's sign-in no longer opens this account/);
    expect(posts()).toEqual([{}, { stepUp: { method: "password", currentPassword: "correct horse" } }]);
    await waitFor(() => expect(container.querySelectorAll("[data-cc-organization-link-consent-row]")).toHaveLength(0));
  });

  it("a refused step-up keeps the prompt open with the server's reason and withdraws nothing", async () => {
    serve(
      [LIVE],
      [
        stepUpRequired(),
        json({ error: { code: "STEP_UP_INVALID", methods: ["password"], message: "The current password is incorrect." } }, 401),
      ],
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /Verify & continue/ }));
    expect(await screen.findByText("The current password is incorrect.")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Acme Legal")).toBeTruthy();
  });

  it("says so when there was nothing left to withdraw", async () => {
    serve([LIVE], [json({ error: { code: "organization_link_consent_not_found", message: "x" } }, 404)]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no active organization sign-in link to withdraw/);
  });
});
