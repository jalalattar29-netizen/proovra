// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * `billing.manage`, END TO END (live PostgreSQL 16): the envelope a member
 * reads and the billing mutation route they would call agree, per role.
 *
 *   OWNER   the payer: envelope BILLING_MANAGE, and the route accepts the
 *           request (it passes authorization and reaches the payment lookup);
 *   ADMIN / MEMBER / VIEWER
 *           no BILLING_MANAGE in the envelope, and the same route on the
 *           payer's account answers 404 BILLING_ACCOUNT_NOT_FOUND — the
 *           account is not theirs, indistinguishable from one that does not
 *           exist. Nothing is written.
 *   Personal Space owner
 *           is the payer of their own account: BILLING_MANAGE in the envelope.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, bootOps, envelopeFor, makeUser, makeWorkspace, personalSpace, type Ctx } from "./operations-truth-fixtures.js";

describe("billing.manage — envelope and mutation route agree, per role (live PostgreSQL 16)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  it("OWNER manages; ADMIN, MEMBER and VIEWER are offered nothing and refused at the route", async () => {
    const owner = await makeUser(c, "bm-owner", { plan: "PRO" });
    const admin = await makeUser(c, "bm-admin");
    const member = await makeUser(c, "bm-member");
    const viewer = await makeUser(c, "bm-viewer");
    const w = await makeWorkspace(c, owner.id, { name: "bm-team", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    await addMember(c, w.teamId, admin.id, "ADMIN");
    await addMember(c, w.teamId, member.id, "MEMBER");
    await addMember(c, w.teamId, viewer.id, "VIEWER");

    const expected = [
      { who: owner, manage: true, view: true },
      { who: admin, manage: false, view: true },
      { who: member, manage: false, view: true },
      { who: viewer, manage: false, view: false },
    ];

    for (const { who, manage, view } of expected) {
      // The envelope, read in the team workspace.
      const env = await envelopeFor(c, who.token, w.teamId);
      expect(env.status).toBe(200);
      expect(env.caps.BILLING_MANAGE, `${who.id} envelope BILLING_MANAGE`).toBe(manage);
      expect(env.caps.BILLING_VIEW, `${who.id} envelope BILLING_VIEW`).toBe(view);

      // A representative financial mutation on the PAYER's account.
      const before = await c.prisma.payment.count({ where: { userId: owner.id } });
      const r = await c.inj(
        "POST",
        `/v1/billing/accounts/PERSONAL/${owner.id}/payments/${randomUUID()}/cancel`,
        who.token,
        {},
      );
      const text = r.body;
      if (manage) {
        // Authorized: it reached the payment lookup (no such payment).
        expect(text, "the payer passes authorization").not.toContain("BILLING_ACCOUNT_NOT_FOUND");
        expect([200, 404, 409]).toContain(r.statusCode);
      } else {
        expect(r.statusCode, `${who.id} route`).toBe(404);
        expect(text).toContain("BILLING_ACCOUNT_NOT_FOUND");
      }
      expect(await c.prisma.payment.count({ where: { userId: owner.id } })).toBe(before);
    }
  });

  it("the Personal Space owner is the payer of their own account", async () => {
    const solo = await makeUser(c, "bm-solo", { plan: "PRO" });
    const space = await personalSpace(c, solo.id);
    const env = await envelopeFor(c, solo.token, space);
    expect(env.status).toBe(200);
    expect(env.caps.BILLING_MANAGE).toBe(true);
    expect(env.caps.BILLING_VIEW).toBe(true);
  });
});
