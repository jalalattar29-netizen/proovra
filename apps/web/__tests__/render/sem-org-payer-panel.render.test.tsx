/**
 * Closure 2 ("sem" item 2) — the organization's Payment agreement panel.
 *
 * Decision E keeps the payer through an ownership transfer. The panel states
 * who pays and what each viewer can do, from GET /v1/orgs/:id/payer:
 *   - the new owner: somebody else pays, they cannot cancel it, closure waits;
 *   - the former owner (still the payer): they remain billed until they
 *     cancel in their own Billing — with a link there;
 *   - after the payer left: the panel says so;
 *   - a viewer the API refuses (403) sees nothing.
 * Real apiFetch over a stubbed fetch, answering with the route's own bodies.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { OrgPayerPanel } from "../../app/(app)/organizations/[id]/_components/OrgPayerPanel";

const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FORMER = "11111111-1111-4111-8111-111111111111";
const NEW_OWNER = "22222222-2222-4222-8222-222222222222";

let reply: { status: number; body: unknown } = { status: 200, body: {} };

function projection(over: Record<string, unknown>) {
  return {
    payer: {
      organizationId: ORG,
      billingOwner: { userId: FORMER, displayName: "Olive Former", membership: "MEMBER" },
      contractOwnerUserId: FORMER,
      viewerIsPayer: false,
      state: "PAYER_IS_MEMBER_NOT_OWNER",
      agreements: [
        {
          kind: "SUBSCRIPTION",
          id: "sub-1",
          state: "RENEWING",
          endsAtUtc: "2026-12-10T00:00:00.000Z",
          payerUserId: FORMER,
          payerDisplayName: "Olive Former",
          payerIsViewer: false,
          payerIsBillingOwner: true,
        },
      ],
      closure: { renewing: 1, stopping: 0, blockedByAgreements: true },
      guidance: [
        "PAYER_UNCHANGED_BY_OWNERSHIP_TRANSFER",
        "HANDOVER_VIA_ACCOUNT_MANAGER",
        "PAYER_CANCELS_IN_OWN_BILLING",
        "VIEWER_CANNOT_CANCEL_PAYER_AGREEMENT",
        "CLOSURE_WAITS_FOR_AGREEMENTS_TO_END",
      ],
      ...over,
    },
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/v1/orgs/${ORG}/payer`)) {
        return new Response(JSON.stringify(reply.body), {
          status: reply.status,
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

async function mount(viewerUserId: string) {
  await act(async () => {
    render(<OrgPayerPanel orgId={ORG} viewerUserId={viewerUserId} />);
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
const q = (sel: string) => document.querySelector(sel);

describe("closure 2 sem item 2 — Payment agreement panel", () => {
  it("the new owner is told someone else pays, that they cannot cancel it, and that closure waits for it", async () => {
    reply = { status: 200, body: projection({}) };
    await mount(NEW_OWNER);
    expect(q("[data-org-payer-panel]")?.getAttribute("data-org-payer-state")).toBe("PAYER_IS_MEMBER_NOT_OWNER");
    expect(q("[data-org-payer-state-copy]")?.textContent).toMatch(/does not move who pays/);
    expect(q("[data-org-payer-billing-owner]")?.textContent).toContain("Olive Former");
    expect(q('[data-org-payer-agreement="sub-1"]')?.textContent).toMatch(/billed to Olive Former/);
    expect(q('[data-org-payer-guidance="VIEWER_CANNOT_CANCEL_PAYER_AGREEMENT"]')).not.toBeNull();
    expect(q('[data-org-payer-guidance="HANDOVER_VIA_ACCOUNT_MANAGER"]')).not.toBeNull();
    expect(q('[data-org-payer-guidance="CLOSURE_WAITS_FOR_AGREEMENTS_TO_END"]')).not.toBeNull();
    expect(q("[data-org-payer-billing-link]")).toBeNull();
  });

  it("the former owner who still pays is told they remain billed, and is linked to their own Billing", async () => {
    reply = {
      status: 200,
      body: projection({
        viewerIsPayer: true,
        agreements: [
          {
            kind: "SUBSCRIPTION",
            id: "sub-1",
            state: "RENEWING",
            endsAtUtc: "2026-12-10T00:00:00.000Z",
            payerUserId: FORMER,
            payerDisplayName: "Olive Former",
            payerIsViewer: true,
            payerIsBillingOwner: true,
          },
        ],
        guidance: [
          "PAYER_UNCHANGED_BY_OWNERSHIP_TRANSFER",
          "HANDOVER_VIA_ACCOUNT_MANAGER",
          "PAYER_CANCELS_IN_OWN_BILLING",
          "VIEWER_REMAINS_LIABLE_UNTIL_CANCELLED",
          "CLOSURE_WAITS_FOR_AGREEMENTS_TO_END",
        ],
      }),
    };
    await mount(FORMER);
    expect(q("[data-org-payer-billing-owner]")?.textContent).toMatch(/Billing owner: You/);
    expect(q('[data-org-payer-agreement="sub-1"]')?.textContent).toMatch(/billed to You/);
    expect(q('[data-org-payer-guidance="VIEWER_REMAINS_LIABLE_UNTIL_CANCELLED"]')).not.toBeNull();
    expect(q('[data-org-payer-guidance="VIEWER_CANNOT_CANCEL_PAYER_AGREEMENT"]')).toBeNull();
    expect(q("[data-org-payer-billing-link]")?.getAttribute("href")).toBe("/billing");
  });

  it("after the payer left, the panel says so", async () => {
    reply = {
      status: 200,
      body: projection({
        state: "PAYER_LEFT_ORGANIZATION",
        billingOwner: { userId: FORMER, displayName: "Olive Former", membership: "LEFT" },
      }),
    };
    await mount(NEW_OWNER);
    expect(q("[data-org-payer-state-copy]")?.textContent).toMatch(/has left it/);
    expect(q("[data-org-payer-billing-owner]")?.textContent).toMatch(/has left the organization/);
  });

  it("review M-1: a paying member outside the billing roles sees only their own agreement and no billing owner", async () => {
    reply = {
      status: 200,
      body: {
        scope: "own",
        ...projection({
          state: "VIEWER_OWN_AGREEMENTS_ONLY",
          billingOwner: null,
          contractOwnerUserId: null,
          viewerIsPayer: true,
          agreements: [
            {
              kind: "STORAGE_ADDON",
              id: "addon-1",
              state: "RENEWING",
              endsAtUtc: "2026-12-01T00:00:00.000Z",
              payerUserId: NEW_OWNER,
              payerDisplayName: "Alice",
              payerIsViewer: true,
              payerIsBillingOwner: false,
            },
          ],
          guidance: ["PAYER_CANCELS_IN_OWN_BILLING", "CLOSURE_WAITS_FOR_AGREEMENTS_TO_END"],
        }),
      },
    };
    await mount(NEW_OWNER);
    expect(q("[data-org-payer-state-copy]")?.textContent).toMatch(/subscriptions in this organization that bill you/);
    expect(q("[data-org-payer-billing-owner]")).toBeNull();
    expect(q('[data-org-payer-agreement="addon-1"]')?.textContent).toMatch(/Storage add-on billed to You/);
    expect(document.body.textContent).not.toContain("Olive Former");
  });

  it("a viewer the API refuses sees nothing", async () => {
    reply = { status: 403, body: { error: { code: "forbidden" } } };
    await mount(NEW_OWNER);
    expect(q("[data-org-payer-panel]")).toBeNull();
  });
});
