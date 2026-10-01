/**
 * UC-COM-001 / UC-COM-002 / UC-COM-003 — the record allowance measured as
 * commitments, against live PostgreSQL 16 and the real admission / settlement
 * / reservation authorities.
 *
 *  - COM-001: an unsealed reservation kept alive keeps counting (admission
 *    refuses the 4th FREE record); a truly expired one stops counting AND can
 *    no longer be finalized; settlement counts every plan-funded record
 *    whatever its creation order; concurrent creations on FREE never exceed 3.
 *  - COM-002: admission and completion take the SAME capacity lock key for a
 *    personal record.
 *  - COM-003: one banked credit admits exactly one over-allowance capture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, seedUser, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";

const HOUR = 3_600_000;

describe("allowance commitments (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let billing: typeof import("../src/services/billing-enforcement.service.js");
  let scopes: typeof import("../src/services/workspace-billing.service.js");
  let reservation: typeof import("@proovra/shared-runtime");
  let evidenceSvc: typeof import("../src/services/evidence.service.js");

  beforeAll(async () => {
    process.env.S3_BUCKET = process.env.S3_BUCKET || "allowance-test-bucket";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    billing = await import("../src/services/billing-enforcement.service.js");
    scopes = await import("../src/services/workspace-billing.service.js");
    reservation = await import("@proovra/shared-runtime");
    evidenceSvc = await import("../src/services/evidence.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `com-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function seed(t: PersonalTenant, status: "SIGNED" | "UPLOADING", opts: { createdAt?: Date; updatedAt?: Date } = {}) {
    const row = await prisma.evidence.create({
      data: {
        ownerUserId: t.owner.userId,
        teamId: t.personalTeamId,
        organizationId: t.personalOrganizationId,
        type: "PHOTO",
        status,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
      select: { id: true },
    });
    if (opts.updatedAt) {
      await prisma.$executeRawUnsafe(`UPDATE "evidence" SET "updated_at" = $2 WHERE "id" = $1::uuid`, row.id, opts.updatedAt);
    }
    return row.id;
  }
  const admit = async (t: PersonalTenant) =>
    billing.assertWorkspaceAllowsEvidenceCreation(
      await billing.resolveEnforcementScopeForRequester({ ownerUserId: t.owner.userId, teamId: null }),
    );
  const settle = async (t: PersonalTenant, evidenceId: string) => {
    const scope = await billing.resolveEnforcementScopeForRequester({ ownerUserId: t.owner.userId, teamId: t.personalTeamId });
    return prisma.$transaction((tx) => billing.settleEvidenceCompletionFunding({ scope, evidenceId }, tx as never));
  };

  it("COM-001: a reservation kept alive past 24 h still counts — the 4th FREE record is refused", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const aged = new Date(Date.now() - 30 * HOUR);
    for (let i = 0; i < 3; i++) await seed(t, "UPLOADING", { createdAt: aged, updatedAt: new Date() });
    await expect(admit(t)).rejects.toMatchObject({ publicCode: "FREE_LIMIT_REACHED" });
  });

  it("COM-001: a truly expired reservation stops counting and can no longer be finalized", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const aged = new Date(Date.now() - 30 * HOUR);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seed(t, "UPLOADING", { createdAt: aged, updatedAt: aged }));
    await expect(admit(t)).resolves.toBeUndefined();
    for (const id of ids) {
      expect(await prisma.$transaction((tx) => reservation.isEvidenceReservationExpiredTx(tx as never, id))).toBe(true);
    }
    const fresh = await seed(t, "UPLOADING");
    expect(await prisma.$transaction((tx) => reservation.isEvidenceReservationExpiredTx(tx as never, fresh))).toBe(false);
  });

  it("COM-001: settlement counts every plan-funded record whatever its creation order", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const older = await seed(t, "UPLOADING", { createdAt: new Date(Date.now() - 2 * HOUR) });
    // Three LATER records were sealed on the plan first.
    for (let i = 0; i < 3; i++) await seed(t, "SIGNED");
    await expect(settle(t, older)).rejects.toMatchObject({ publicCode: "INSUFFICIENT_EVIDENCE_CREDITS" });
  });

  it("COM-001: unsealed records admitted earlier still take their plan slots ahead of a later record", async () => {
    const t = await seedPersonalTenant(deps, "FREE", { credits: 1 });
    const a = await seed(t, "UPLOADING", { createdAt: new Date(Date.now() - 4 * HOUR) });
    const b = await seed(t, "UPLOADING", { createdAt: new Date(Date.now() - 3 * HOUR) });
    const c = await seed(t, "UPLOADING", { createdAt: new Date(Date.now() - 2 * HOUR) });
    const d = await seed(t, "UPLOADING");
    expect(await settle(t, d)).toEqual({ funding: "EVIDENCE_CREDIT" });
    await prisma.evidence.update({ where: { id: d }, data: { status: "SIGNED" } });
    for (const id of [a, b, c]) {
      expect(await settle(t, id)).toEqual({ funding: "PLAN" });
      await prisma.evidence.update({ where: { id }, data: { status: "SIGNED" } });
    }
  });

  it("COM-001: concurrent creations on FREE never exceed the allowance", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        evidenceSvc.createEvidence({
          ownerUserId: t.owner.userId,
          teamId: null,
          type: "PHOTO",
          mimeType: "image/jpeg",
          originalFileName: `c-${i}.jpg`,
          acquisitionMode: "PROOVRA_WEB_UPLOAD",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(3);
  });

  it("COM-002: admission and completion lock the SAME capacity subject for a personal record", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const keys: string[] = [];
    const spy = { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => { keys.push(String(values[0])); return Promise.resolve(1); } };
    const admission = await billing.resolveEnforcementScopeForRequester({ ownerUserId: t.owner.userId, teamId: null });
    const completion = await billing.resolveEnforcementScopeForRequester({ ownerUserId: t.owner.userId, teamId: t.personalTeamId });
    await billing.lockEvidenceCapacitySubject(admission, spy as never);
    await billing.lockEvidenceCapacitySubject(completion, spy as never);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toContain(scopes.commercialPrincipalOf(admission));
  });

  it("COM-004: ten concurrent first ensureEntitlement calls create exactly one active entitlement", async () => {
    const seeded = await seedUser(deps, "com004");
    const user = { id: seeded.userId };
    await prisma.entitlement.deleteMany({ where: { userId: user.id } });
    const { ensureEntitlement } = await import("../src/services/billing.service.js");
    const rows = await Promise.all(Array.from({ length: 10 }, () => ensureEntitlement(user.id)));
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(await prisma.entitlement.count({ where: { userId: user.id, active: true } })).toBe(1);
  });

  it("COM-003: one banked credit admits exactly one over-allowance capture", async () => {
    const t = await seedPersonalTenant(deps, "FREE", { credits: 1 });
    for (let i = 0; i < 3; i++) await seed(t, "SIGNED");
    await expect(admit(t)).resolves.toBeUndefined();
    await seed(t, "UPLOADING"); // the admitted over-allowance capture, not yet sealed
    await expect(admit(t)).rejects.toMatchObject({ publicCode: "FREE_LIMIT_REACHED" });
  });
});
