/**
 * The operator retirement CLI — exercised ONLY against the disposable
 * integration database (live PostgreSQL 16). It is never run against any
 * real database by this program.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

describe("retire-user-evidence CLI (live PostgreSQL 16, disposable)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let cli: typeof import("../../src/scripts/retire-user-evidence.js");
  let email = "";
  const ids: Record<string, string> = {};

  async function record(createdByUserId: string | null, ownerUserId: string, teamId: string, extra: Record<string, unknown> = {}) {
    const id = randomUUID();
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    await prisma.evidence.create({
      data: { id, teamId, organizationId: team.organizationId, ownerUserId, createdByUserId, uploadedByUserId: ownerUserId, type: "PHOTO", status: "SIGNED", title: "retire", ...extra } as never,
    });
    return id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    cli = await import("../../src/scripts/retire-user-evidence.js");
    const P = h.fixtures.personal;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: P.userId }, select: { email: true } });
    email = user.email!;
    ids.a = await record(P.userId, P.userId, P.teamId);
    ids.b = await record(P.userId, P.userId, P.teamId);
    ids.trashed = await record(P.userId, P.userId, P.teamId, { lifecycleState: "TRASHED", deletedAt: new Date(), deletedAtUtc: new Date(), deleteScheduledForUtc: new Date(Date.now() + 90 * 86400000) });
    // Owned by the user but CREATED by someone else: never touched.
    ids.notCreated = await record(h.fixtures.teamA.ownerUserId, P.userId, P.teamId);
    // Another user's record: never touched.
    ids.other = await record(h.fixtures.teamA.ownerUserId, h.fixtures.teamA.ownerUserId, h.fixtures.teamA.teamId);
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  const state = async (id: string) =>
    (await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true } })).lifecycleState;

  it("the dry run plans only the records the user CREATED, and writes nothing", async () => {
    const before = await prisma.evidence.findMany({ where: { id: { in: Object.values(ids) } }, orderBy: { id: "asc" } });
    const custodyBefore = await prisma.custodyEvent.count();
    const plan = await cli.planRetirement({ email, client: prisma as never });
    const planned = Object.fromEntries(plan.records.map((r) => [r.id, r.planned]));
    expect(planned[ids.a!]).toBe("TRASH");
    expect(planned[ids.b!]).toBe("TRASH");
    expect(planned[ids.trashed!]).toBe("ALREADY_TRASHED");
    expect(planned[ids.notCreated!]).toBeUndefined();
    expect(planned[ids.other!]).toBeUndefined();
    expect(await prisma.evidence.findMany({ where: { id: { in: Object.values(ids) } }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.custodyEvent.count()).toBe(custodyBefore);
  });

  it("apply without the exact confirmation is refused before anything is written", async () => {
    await expect(cli.applyRetirement({ email, confirmEmail: email.toUpperCase(), client: prisma as never })).rejects.toThrow(/confirm-email/);
    expect(await state(ids.a!)).toBe("ACTIVE");
  });

  it("apply moves only the created records to Trash through the lifecycle authority, and a re-run changes nothing", async () => {
    const out = await cli.applyRetirement({ email, confirmEmail: email, client: prisma as never });
    const by = Object.fromEntries(out.map((o) => [o.evidenceId, o.outcome]));
    expect(by[ids.a!]).toBe("TRASHED");
    expect(by[ids.b!]).toBe("TRASHED");
    expect(by[ids.trashed!]).toBe("ALREADY_TRASHED");
    expect(await state(ids.a!)).toBe("TRASHED");
    expect(await state(ids.notCreated!)).toBe("ACTIVE");
    expect(await state(ids.other!)).toBe("ACTIVE");
    // Recoverable trash: the row and its bytes' pointers remain.
    expect(await prisma.evidence.count({ where: { id: { in: Object.values(ids) } } })).toBe(5);
    // Custody records the move, through the authority.
    expect(await prisma.custodyEvent.count({ where: { evidenceId: ids.a! } })).toBeGreaterThan(0);
    const again = await cli.applyRetirement({ email, confirmEmail: email, client: prisma as never });
    expect(again.every((o) => o.outcome === "ALREADY_TRASHED" || o.outcome === "SKIP_DESTROYED")).toBe(true);
  });
});
