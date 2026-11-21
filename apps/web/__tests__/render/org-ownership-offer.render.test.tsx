/**
 * NEW-RG-26-4 / owner decision E — the organization ownership offer panel.
 *
 * The recipient sees who offered, that billing ownership stays where it is,
 * and accepts with their own step-up (the 401 STEP_UP_REQUIRED challenge opens
 * the verification prompt; the proof is sent on the retry). A refusal says
 * what happened. The offerer sees the pending offer and can withdraw it;
 * anyone else sees nothing.
 *
 * Mounted with the real apiFetch over a stubbed fetch, answering with the
 * bodies the routes really send.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { OrgOwnershipOffer } from "../../app/(app)/organizations/[id]/_components/OrgOwnershipOffer";

const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OFFER = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  organizationId: ORG,
  fromUserId: "owner-1",
  toUserId: "member-2",
  status: "PENDING",
  createdAt: "2026-11-20T00:00:00.000Z",
  expiresAtUtc: "2026-11-27T00:00:00.000Z",
  decidedAtUtc: null,
};
const PEOPLE = [
  { userId: "owner-1", displayName: "Olive Owner", email: "olive@acme.test" },
  { userId: "member-2", displayName: "Max Member", email: "max@acme.test" },
];

let offerReply: unknown = { offer: OFFER, billingOwnerStays: true, billingOwnerUserId: "owner-1" };
let actReplies: Array<{ status: number; body: unknown }> = [];
const requests: Array<{ url: string; method: string; body: string | null }> = [];

beforeEach(() => {
  requests.length = 0;
  actReplies = [];
  offerReply = { offer: OFFER, billingOwnerStays: true, billingOwnerUserId: "owner-1" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
      const respond = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (method === "GET" && url.includes(`/v1/orgs/${ORG}/ownership-offer`)) return respond(200, offerReply);
      if (method === "POST" && url.includes(`/v1/orgs/${ORG}/ownership-offer/${OFFER.id}/`)) {
        const next = actReplies.shift() ?? { status: 500, body: {} };
        return respond(next.status, next.body);
      }
      return respond(404, {});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(viewerUserId: string) {
  await act(async () => {
    render(<OrgOwnershipOffer orgId={ORG} orgName="Acme Legal" viewerUserId={viewerUserId} people={PEOPLE} />);
  });
  await settle();
}

const posts = () => requests.filter((r) => r.method === "POST");

describe("NEW-RG-26-4 — the recipient's view", () => {
  it("says who offered and that billing ownership does not move", async () => {
    await mount("member-2");
    expect(screen.getByText(/Olive Owner has offered you ownership of/)).toBeTruthy();
    const billing = document.querySelector("[data-org-ownership-offer-billing]");
    expect(billing?.textContent).toMatch(/Billing does not move with ownership/);
    expect(billing?.textContent).toMatch(/stays\s+Olive Owner/);
  });

  it("accepting asks for step-up first, then sends the proof and reports that billing did not change", async () => {
    actReplies = [
      {
        status: 401,
        body: { error: { code: "STEP_UP_REQUIRED", methods: ["password"], message: "Confirm it is you." } },
      },
      {
        status: 200,
        body: { transferred: true, newOwnerUserId: "member-2", billingOwnerTransferred: false, billingOwnerUserId: "owner-1" },
      },
    ];
    await mount("member-2");
    fireEvent.click(screen.getByRole("button", { name: "Accept ownership" }));
    await settle();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toContain(`/ownership-offer/${OFFER.id}/accept`);
    expect(JSON.parse(posts()[0]!.body ?? "{}")).toEqual({});
    // The step-up prompt is open; answer it with a password.
    const pw = document.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(pw).toBeTruthy();
    fireEvent.change(pw!, { target: { value: "Owner-Password-1234" } });
    const form = pw!.closest("form");
    if (form) fireEvent.submit(form);
    await settle();
    expect(posts()).toHaveLength(2);
    expect(JSON.parse(posts()[1]!.body ?? "{}")).toMatchObject({ stepUp: { currentPassword: "Owner-Password-1234" } });
    expect(document.querySelector("[data-org-ownership-offer-status]")?.textContent).toMatch(
      /You now own Acme Legal\. Billing ownership did not change/,
    );
  });

  it("a refusal at acceptance says what happened", async () => {
    actReplies = [
      {
        status: 409,
        body: { error: { code: "ownership_offer_offerer_not_owner", message: "The person who offered ownership no longer owns this organization" } },
      },
    ];
    await mount("member-2");
    fireEvent.click(screen.getByRole("button", { name: "Accept ownership" }));
    await settle();
    expect(document.querySelector("[data-org-ownership-offer-status]")?.textContent).toMatch(
      /no longer owns the organization, so it was withdrawn\. Nothing changed\./,
    );
  });
});

describe("NEW-RG-26-4 — the offerer and everyone else", () => {
  it("the offerer sees the pending offer and can withdraw it", async () => {
    actReplies = [{ status: 200, body: { offer: { ...OFFER, status: "CANCELLED" } } }];
    await mount("owner-1");
    expect(screen.getByText(/You offered ownership to Max Member/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept ownership" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw offer" }));
    await settle();
    expect(posts()[0]!.url).toContain(`/ownership-offer/${OFFER.id}/cancel`);
  });

  it("someone who is not a party sees nothing", async () => {
    offerReply = { offer: null };
    await mount("someone-else");
    expect(document.querySelector("[data-org-ownership-offer]")).toBeNull();
  });
});
