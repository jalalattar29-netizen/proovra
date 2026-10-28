/**
 * MEMBERS LEDGER M6 — growth follows the subscription lifecycle.
 *
 * The entitlement projection already says a restricted workspace cannot
 * invite; the invitation service minted, resent and accepted invitations
 * regardless. Each of the three now asks the canonical lifecycle adapter
 * (`assertSubscriptionActiveOrGraceAllowed`) first and, when it refuses,
 * refuses with the lifecycle's own typed code — and writes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const refusal = vi.hoisted(() => ({ on: true }));

vi.mock("../src/services/collaboration-team/billing-guards.js", async (orig) => {
  const real = await orig<typeof import("../src/services/collaboration-team/billing-guards.js")>();
  return {
    ...real,
    assertSubscriptionActiveOrGraceAllowed: async () => {
      if (refusal.on) {
        throw new real.BillingLimitError({
          code: "SUBSCRIPTION_INACTIVE",
          message: "Your subscription is PAST_DUE and cannot be used for collaboration team mutations.",
        });
      }
      return { plan: "TEAM", status: "ACTIVE", inGracePeriod: false };
    },
  };
});

import {
  createWorkspaceInvitation,
  resendWorkspaceInvitation,
  WorkspaceInvitationError,
} from "../src/services/identity/workspace-invitation.service.js";

/** A client that fails the test the moment anything is read or written. */
function untouchable() {
  const writes: string[] = [];
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      writes.push(String(prop));
      throw new Error(`database touched: ${String(prop)}`);
    },
  };
  return { client: new Proxy({}, handler) as never, writes };
}

describe("M6 — invitations are refused while the subscription lifecycle restricts growth", () => {
  beforeEach(() => {
    refusal.on = true;
  });

  it("create is refused with the lifecycle code before any write", async () => {
    const { client, writes } = untouchable();
    const err = await createWorkspaceInvitation(
      { workspaceId: "ws-1", email: "a@example.test", role: "MEMBER", invitedByUserId: "u-1" },
      client,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceInvitationError);
    expect(err).toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
    expect(writes).toEqual([]);
  });

  it("resend is refused with the lifecycle code before any write", async () => {
    const { client, writes } = untouchable();
    const err = await resendWorkspaceInvitation({ workspaceId: "ws-1", inviteId: "i-1" }, client).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
    expect(writes).toEqual([]);
  });

  it("positive control: with an active lifecycle the gate lets the request through to the database", async () => {
    refusal.on = false;
    const { client, writes } = untouchable();
    await createWorkspaceInvitation(
      { workspaceId: "ws-1", email: "a@example.test", role: "MEMBER", invitedByUserId: "u-1" },
      client,
    ).catch(() => undefined);
    expect(writes.length).toBeGreaterThan(0);
  });
});
