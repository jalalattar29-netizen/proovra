/**
 * Team remediation stage F — T-155 (audit JRN-08 s): External Review issue
 * refuses an expiry in the past, now, or outside the grant lifetime bounds
 * with ONE 400 for the whole request, before any step-up is asked for and
 * before any invitation row is attempted. Real PostgreSQL, real routes.
 *
 * On the audited code the bulk door answered 201 for a past expiry (each row
 * then failed on its own) and asked for step-up first.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

let h: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let stepUp: ReturnType<typeof createStepUpCeremony>;

const tag = () => randomUUID().slice(0, 8);
const P = () => h.fixtures.personal;

beforeAll(async () => {
  h = await bootIntegrationHarness();
  prisma = (await import("../src/db.js")).prisma;
  stepUp = createStepUpCeremony({ prisma: prisma as never, inject: (o) => h.app.inject(o as never) as never });
  await prisma.entitlement.updateMany({ where: { userId: P().userId }, data: { active: false } });
  await prisma.entitlement.create({ data: { userId: P().userId, plan: "TEAM", active: true, credits: 0 } });
}, 900_000);

afterAll(async () => {
  await h?.cleanup();
}, 300_000);

async function issue(expiresAtUtc: unknown, withStepUp: boolean) {
  const header = withStepUp
    ? await stepUp.approvedHeader({
        token: P().token,
        userId: P().userId,
        teamId: P().teamId,
        purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
        resourceKind: "external_review_grant_bulk",
      })
    : {};
  const email = `xr-exp-${tag()}@test.proovra.local`;
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/external-review/invitations/bulk",
    headers: { authorization: `Bearer ${P().token}`, "x-proovra-workspace-id": P().teamId, "content-type": "application/json", ...header },
    payload: JSON.stringify({ expiresAtUtc, defaultScope: { kind: "EVIDENCE", evidenceId: P().evidenceId }, rows: [{ inviteEmail: email }] }),
  });
  const grants = await prisma.externalReviewGrant.count({ where: { teamId: P().teamId, reviewerEmail: email } });
  return { res, grants };
}

describe("T-155 — External Review invitation expiry is validated by the server", () => {
  it("a past, present, unparseable or over-long expiry is one 400 with nothing issued — with or without step-up", async () => {
    const cases: unknown[] = [
      new Date(Date.now() - 3_600_000).toISOString(),
      new Date(Date.now()).toISOString(),
      new Date(Date.now() + 5 * 60_000).toISOString(),
      new Date(Date.now() + 31 * 86_400_000).toISOString(),
      "not-a-date",
    ];
    for (const expiry of cases) {
      for (const withStepUp of [true, false]) {
        const { res, grants } = await issue(expiry, withStepUp);
        expect(res.statusCode, `${String(expiry)} stepUp=${withStepUp}: ${res.body}`).toBe(400);
        expect(res.json()).toMatchObject({ error: { code: "EXTERNAL_REVIEW_GRANT_LIFETIME_INVALID" } });
        expect(typeof res.json().error.message).toBe("string");
        expect(grants).toBe(0);
      }
    }
  });

  it("a valid expiry still issues (positive control)", async () => {
    const { res, grants } = await issue(new Date(Date.now() + 7 * 86_400_000).toISOString(), true);
    expect(res.statusCode, res.body).toBe(201);
    expect(grants).toBe(1);
  });
});
