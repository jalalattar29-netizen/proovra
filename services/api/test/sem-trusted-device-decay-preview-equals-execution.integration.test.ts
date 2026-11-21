/**
 * Closure 2 ("sem" item 3c) — trusted-device decay is computed from ABSOLUTE
 * time, and the read-only activation preview describes exactly what the decay
 * run then does, across many simulated ticks of the 5-minute schedule.
 *
 * Before: each run ADDED `2 × (days unseen − 14)` to the stored decay, so on
 * the 5-minute schedule a device unseen 30 days was revoked on the 4th run (15
 * minutes after activation) instead of at 64 days unseen.
 *
 * Live PostgreSQL; the real sweep (`sweepTrustedDeviceDecay`, with an injected
 * clock) and the real preview (`previewScheduledIdentityRuntimeEnforcement`,
 * inside a READ ONLY transaction). Enforcement switch untouched (off).
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { computeTrustDecay } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

const DAY = 86_400_000;
const TICK = 5 * 60_000;

describe("sem item 3c — trust decay: absolute time, preview == execution", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let decay: typeof import("../src/services/access-control/trusted-device-decay.service.js");
  let scheduled: typeof import("../src/services/access-control/identity-runtime-scheduled.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    decay = await import("../src/services/access-control/trusted-device-decay.service.js");
    scheduled = await import("../src/services/access-control/identity-runtime-scheduled.service.js");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const orgOfTeamA = async () =>
    (await prisma.team.findUniqueOrThrow({ where: { id: h.fixtures.teamA.teamId }, select: { organizationId: true } }))
      .organizationId;

  type Row = { id: string; lastSeenAtUtc: Date; status: string; trustScoreDecay: number; quarantinedAtUtc: Date | null };
  const rows = async (teamId: string): Promise<Map<string, Row>> =>
    new Map(
      (
        await prisma.trustedDevice.findMany({
          where: { teamId },
          select: { id: true, lastSeenAtUtc: true, status: true, trustScoreDecay: true, quarantinedAtUtc: true },
        })
      ).map((r) => [r.id, r as Row]),
    );

  type DeviceItem = {
    action: "REVOKE_DEVICE" | "QUARANTINE_DEVICE" | "RELEASE_DEVICE_QUARANTINE" | "DECAY_DEVICE";
    deviceId: string;
    teamId: string;
    toDecay: number;
    sweepsUntilRevoked: number;
    revokesAtUtc: string;
  };
  const previewAt = async (now: Date, teamId: string): Promise<Map<string, DeviceItem>> => {
    const p = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return scheduled.previewScheduledIdentityRuntimeEnforcement({ now }, tx as never);
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    expect(p.enforcementCurrentlyOn).toBe(false);
    return new Map(
      (p.items as unknown as DeviceItem[])
        .filter((i) => i.teamId === teamId && "deviceId" in i)
        .map((i) => [i.deviceId, i]),
    );
  };

  it("across 24 h of 5-minute ticks and 70 days of 12-hour ticks, every run does exactly what the preview at that instant said, and each device is revoked at its absolute instant", async () => {
    const team = await prisma.team.create({
      data: { name: `sem-decay-${randomUUID().slice(0, 6)}`, ownerUserId: h.fixtures.teamA.ownerUserId, workspaceKind: "OWNED", organizationId: await orgOfTeamA() },
      select: { id: true },
    });
    const t0 = new Date();
    // Days unseen at t0. 14 = stale threshold; quarantine at 49 (70), revoke at 64 (100).
    const ages = [1, 14.5, 15.2, 30, 48.9, 49.05, 63.99, 64.2, 90];
    const seeded: Array<{ id: string; age: number }> = [];
    for (const age of ages) {
      const d = await prisma.trustedDevice.create({
        data: {
          teamId: team.id,
          userId: h.fixtures.teamA.memberUserId,
          deviceIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
          trustedUntilUtc: new Date(t0.getTime() + 365 * DAY),
          lastSeenAtUtc: new Date(t0.getTime() - age * DAY),
        },
        select: { id: true },
      });
      seeded.push({ id: d.id, age });
    }
    // A row an earlier compounding run left at 96 although it was seen 20 days
    // ago: the absolute rule puts it at 12 (and does not revoke it).
    const residue = await prisma.trustedDevice.create({
      data: {
        teamId: team.id,
        userId: h.fixtures.teamA.memberUserId,
        deviceIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
        trustedUntilUtc: new Date(t0.getTime() + 365 * DAY),
        lastSeenAtUtc: new Date(t0.getTime() - 20 * DAY),
        trustScoreDecay: 96,
      },
      select: { id: true },
    });

    // Review L-4 — a row the old formula pushed to 84 AND quarantined, though it
    // was seen 25 days ago: the recompute (22) releases the quarantine.
    const quarantinedResidue = await prisma.trustedDevice.create({
      data: {
        teamId: team.id,
        userId: h.fixtures.teamA.memberUserId,
        deviceIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
        trustedUntilUtc: new Date(t0.getTime() + 365 * DAY),
        lastSeenAtUtc: new Date(t0.getTime() - 25 * DAY),
        trustScoreDecay: 84,
        quarantinedAtUtc: new Date(t0.getTime() - 2 * DAY),
      },
      select: { id: true },
    });

    const first = await previewAt(t0, team.id);
    const ticks: Date[] = [];
    for (let k = 0; k < 288; k += 1) ticks.push(new Date(t0.getTime() + k * TICK));
    for (let k = 1; k <= 140; k += 1) ticks.push(new Date(t0.getTime() + DAY + k * (DAY / 2)));

    const revokedAt = new Map<string, Date>();
    let previewed = 0;
    for (const [k, now] of ticks.entries()) {
      // The preview is asked at every hourly tick of the first day and every
      // 12-hour tick after it (each one is a full read-only fleet scan).
      const ask = k >= 288 || k % 12 === 0 || k < 6;
      const predicted = ask ? (k === 0 ? first : await previewAt(now, team.id)) : null;
      if (ask) previewed += 1;
      const before = await rows(team.id);
      await decay.sweepTrustedDeviceDecay({ teamId: team.id, now }, prisma as never);
      const after = await rows(team.id);
      for (const [id, b] of before) {
        if (b.status !== "ACTIVE") continue;
        const a = after.get(id)!;
        const absolute = computeTrustDecay({ lastSeenAtUtc: b.lastSeenAtUtc, nowUtc: now });
        // Absolute: the stored value IS the formula at this instant, however
        // many runs came before.
        expect(a.trustScoreDecay, `device ${id} at tick ${k}`).toBe(absolute);
        if (a.status === "REVOKED") revokedAt.set(id, now);
        // Review L-4 — quarantine is the same rule's STATE after every run.
        if (a.status === "ACTIVE") {
          expect(a.quarantinedAtUtc !== null, `quarantine state ${id} tick ${k}`).toBe(absolute >= 70);
        }
        if (!predicted) continue;
        const item = predicted.get(id);
        if (!item) {
          expect({ status: a.status, decay: a.trustScoreDecay }, `unpredicted change ${id} tick ${k}`).toEqual({
            status: b.status,
            decay: b.trustScoreDecay,
          });
          continue;
        }
        expect(a.trustScoreDecay, `preview toDecay ${id} tick ${k}`).toBe(item.toDecay);
        if (item.action === "REVOKE_DEVICE") expect(a.status).toBe("REVOKED");
        else expect(a.status).toBe("ACTIVE");
        if (item.action === "QUARANTINE_DEVICE") {
          expect(b.quarantinedAtUtc).toBeNull();
          expect(a.quarantinedAtUtc).toBeInstanceOf(Date);
        }
        if (item.action === "RELEASE_DEVICE_QUARANTINE") {
          expect(b.quarantinedAtUtc).toBeInstanceOf(Date);
          expect(a.quarantinedAtUtc).toBeNull();
        }
      }
    }
    expect(previewed).toBeGreaterThan(150);

    // Each device is revoked at the first tick at or after the instant the
    // t0 preview stated — exactly that tick within the 5-minute day.
    for (const { id, age } of seeded) {
      const revokesAt = new Date(t0.getTime() + (64 - age) * DAY);
      const expectedTick = ticks.find((t) => t.getTime() >= revokesAt.getTime());
      if (!expectedTick) {
        expect(revokedAt.has(id), `age ${age}`).toBe(false);
        continue;
      }
      expect(revokedAt.get(id)?.toISOString(), `age ${age}`).toBe(expectedTick.toISOString());
      const item = first.get(id);
      if (item) {
        // The t0 preview's run count names the same tick on the 5-minute grid.
        const k = ticks.indexOf(expectedTick);
        if (k < 288) expect(item.sweepsUntilRevoked, `age ${age}`).toBe(k + 1);
        expect(new Date(item.revokesAtUtc).getTime()).toBeLessThanOrEqual(expectedTick.getTime());
      }
    }
    // The compounding regression: a device unseen 30 days is NOT revoked in the
    // first day (it used to go on the 4th run), and the residue was lowered.
    const thirty = seeded.find((s) => s.age === 30)!;
    expect(revokedAt.get(thirty.id)!.getTime() - t0.getTime()).toBeGreaterThanOrEqual(34 * DAY - TICK);
    expect(first.get(residue.id)).toMatchObject({ action: "DECAY_DEVICE", toDecay: 12 });
    expect(first.get(quarantinedResidue.id)).toMatchObject({ action: "RELEASE_DEVICE_QUARANTINE", toDecay: 22 });
    expect(first.get(thirty.id)).toMatchObject({ action: "DECAY_DEVICE", toDecay: 32 });
  }, 600_000);

  it("review L-4: a lowered value says it was recomputed from last-seen time (never 'seen again'); an old-formula quarantine below 70 is released; one at 70+ stays", async () => {
    const team = await prisma.team.create({
      data: { name: `sem-decay-l4-${randomUUID().slice(0, 6)}`, ownerUserId: h.fixtures.teamA.ownerUserId, workspaceKind: "OWNED", organizationId: await orgOfTeamA() },
      select: { id: true },
    });
    const now = new Date();
    const mk = (daysUnseen: number, decay: number, quarantined: boolean) =>
      prisma.trustedDevice.create({
        data: {
          teamId: team.id,
          userId: h.fixtures.teamA.memberUserId,
          deviceIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
          trustedUntilUtc: new Date(now.getTime() + 365 * DAY),
          lastSeenAtUtc: new Date(now.getTime() - daysUnseen * DAY),
          trustScoreDecay: decay,
          ...(quarantined ? { quarantinedAtUtc: new Date(now.getTime() - DAY) } : {}),
        },
        select: { id: true },
      });
    const lowered = await mk(30, 96, false); // -> 32, not quarantined
    const released = await mk(30, 90, true); // -> 32, quarantine released
    const kept = await mk(55, 99, true); // -> 82, stays quarantined
    const preview = await previewAt(now, team.id);
    expect(preview.get(lowered.id)).toMatchObject({ action: "DECAY_DEVICE", toDecay: 32 });
    expect(preview.get(released.id)).toMatchObject({ action: "RELEASE_DEVICE_QUARANTINE", toDecay: 32 });
    expect(preview.get(kept.id)).toMatchObject({ action: "DECAY_DEVICE", toDecay: 82 });
    const res = await decay.sweepTrustedDeviceDecay({ teamId: team.id, now }, prisma as never);
    expect(res.quarantineReleased).toBe(1);
    const read = (id: string) =>
      prisma.trustedDevice.findUniqueOrThrow({ where: { id }, select: { trustScoreDecay: true, quarantinedAtUtc: true, decayReason: true } });
    const l = await read(lowered.id);
    expect(l).toMatchObject({ trustScoreDecay: 32, quarantinedAtUtc: null, decayReason: "Trust decay recomputed from last-seen time." });
    expect(l.decayReason).not.toMatch(/seen again/);
    expect(await read(released.id)).toMatchObject({
      trustScoreDecay: 32,
      quarantinedAtUtc: null,
      decayReason: "Quarantine released: decay recomputed from last-seen time is below 70.",
    });
    const k = await read(kept.id);
    expect(k.trustScoreDecay).toBe(82);
    expect(k.quarantinedAtUtc).toBeInstanceOf(Date);
  });

  it("running the decay many times at the same instant changes nothing after the first run (idempotent)", async () => {
    const team = await prisma.team.create({
      data: { name: `sem-decay-idem-${randomUUID().slice(0, 6)}`, ownerUserId: h.fixtures.teamA.ownerUserId, workspaceKind: "OWNED", organizationId: await orgOfTeamA() },
      select: { id: true },
    });
    const now = new Date();
    const d = await prisma.trustedDevice.create({
      data: {
        teamId: team.id,
        userId: h.fixtures.teamA.memberUserId,
        deviceIdHash: createHash("sha256").update(randomUUID()).digest("hex"),
        trustedUntilUtc: new Date(now.getTime() + 365 * DAY),
        lastSeenAtUtc: new Date(now.getTime() - 40 * DAY),
      },
      select: { id: true },
    });
    for (let i = 0; i < 50; i += 1) await decay.sweepTrustedDeviceDecay({ teamId: team.id, now }, prisma as never);
    expect(
      await prisma.trustedDevice.findUniqueOrThrow({ where: { id: d.id }, select: { status: true, trustScoreDecay: true } }),
    ).toEqual({ status: "ACTIVE", trustScoreDecay: 52 });
  });
});
