/**
 * B5B-F-302 — Settings → Security: the owner approves an organization link.
 *
 * A refused enterprise sign-in left a 15-minute pending-link ticket. Signed in
 * to their own account, the owner sees the Organization and what approving
 * does, and approves through the shared "Verify it's you" step-up. With no
 * pending link the panel is absent.
 *
 * The REAL `apiFetch` runs over a stubbed `fetch`; the bodies are the ones
 * identity-links.routes.ts sends. The step-up prompt is the real shared one.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { OrganizationLinkConsentPanel } from "../../components/identity-security/OrganizationLinkConsentPanel";
import { StepUpVerify } from "../../app/(app)/security-center/components/PersonalSecuritySections";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PENDING = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  organizationName: "Acme Legal",
  protocol: "OIDC",
  email: "owner@acme.test",
  grantsMembership: true,
  convertsToManagedIdentity: false,
  organizationRestrictsPersonalSpace: false,
};

const fetchMock = vi.fn();

const posts = () =>
  fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url).endsWith("/v1/identity/links/organization") &&
        (init as RequestInit | undefined)?.method === "POST",
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

function serve(pending: unknown, postReplies: Response[]) {
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/identity/links/organization")) {
      if ((init?.method ?? "GET") === "GET") return json({ pending });
      return postReplies.shift() ?? json({ error: { code: "unexpected" } }, 500);
    }
    return json({});
  });
}

const stepUpRequired = () =>
  json(
    { error: { code: "STEP_UP_REQUIRED", methods: ["password"], message: "Confirm it's you." } },
    401,
  );

function mount() {
  return render(<OrganizationLinkConsentPanel StepUpPrompt={StepUpVerify} />);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OrganizationLinkConsentPanel", () => {
  it("is absent when there is no pending link", async () => {
    serve(null, []);
    const { container } = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector("[data-cc-organization-link-consent]")).toBeNull();
    expect(container.textContent).toBe("");
    expect(posts()).toHaveLength(0);
  });

  it("names the organization, says what approval does, and approves with the step-up proof", async () => {
    serve(PENDING, [stepUpRequired(), json({ linked: true, organizationId: PENDING.organizationId, managedIdentity: false })]);
    mount();

    const panel = await screen.findByText(/Organization link waiting for you/);
    const card = panel.closest("[data-cc-organization-link-consent]") as HTMLElement;
    expect(card.textContent).toContain("Acme Legal");
    expect(card.textContent).toContain("owner@acme.test");
    expect(card.textContent).toMatch(/You become a member of Acme Legal/);
    expect(card.textContent).toMatch(/Personal Space and your personal data export stay yours/);
    expect(card.textContent).toMatch(/cannot convert your account/);
    expect(card.textContent).not.toMatch(/turns off Personal Space/);

    fireEvent.click(screen.getByRole("button", { name: "Approve link" }));
    // The server asks for step-up; the shared prompt collects it.
    const input = await screen.findByLabelText("Current password");
    expect(posts()).toEqual([{}]);
    fireEvent.change(input, { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: /Verify & continue/ }));

    expect((await screen.findByRole("status")).textContent).toMatch(/You are now a member of Acme Legal/);
    expect(posts()).toEqual([{}, { stepUp: { method: "password", currentPassword: "correct horse" } }]);
    expect(screen.queryByRole("button", { name: "Approve link" })).toBeNull();
  });

  it("an expired or missing ticket says nothing was linked and how to start again", async () => {
    serve(PENDING, [
      json(
        {
          error: {
            code: "organization_link_not_found",
            message: "There is no pending organization link. Sign in with your organization again.",
          },
        },
        404,
      ),
    ]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Approve link" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/expired or was already used, so nothing was linked/);
    expect(alert.textContent).toMatch(/within 15 minutes/);
    expect(screen.queryByRole("button", { name: "Approve link" })).toBeNull();
  });

  it("an email that no longer matches says so", async () => {
    serve(PENDING, [stepUpRequired(), json({ error: { code: "organization_link_email_mismatch" } }, 403)]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Approve link" }));
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: /Verify & continue/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /verified email no longer matches the address your organization signed in with, so nothing was linked/,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a refused step-up keeps the prompt open with the server's reason and links nothing", async () => {
    serve(PENDING, [
      stepUpRequired(),
      json({ error: { code: "STEP_UP_INVALID", methods: ["password"], message: "The current password is incorrect." } }, 401),
    ]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Approve link" }));
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /Verify & continue/ }));
    expect(await screen.findByText("The current password is incorrect.")).toBeTruthy();
    expect(screen.getByLabelText("Current password")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("states an Organization policy that withholds Personal Space before approval", async () => {
    serve({ ...PENDING, organizationRestrictsPersonalSpace: true }, []);
    mount();
    expect(await screen.findByText(/turns off Personal Space for its members/)).toBeTruthy();
  });
});
