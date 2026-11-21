/**
 * Phase 26.75 — Trusted device decay sweep.
 *
 * Periodic sweep that walks the team's ACTIVE TrustedDevice rows and:
 *   1. Sets `trustScoreDecay` to the shared `computeTrustDecay` value — an
 *      ABSOLUTE function of last-seen and the clock (closure 2, "sem" 3c),
 *      never the stored value plus a per-run increment.
 *   2. Auto-invalidates devices whose decay >= 100 by flipping status
 *      to REVOKED with `revokedReason = 'TRUST_DECAY_AUTO_INVALIDATED'`.
 *   3. Bumps metrics + emits SecurityEvents per transition.
 *
 * Hard rules:
 *   - Sweep is bounded by batch size.
 *   - Auto-invalidate writes via the existing Phase 19 device path
 *     (status flip + revokedAt) — no parallel cleanup.
 *   - Never raises decay above 100; the cap is applied in the shared
 *     `computeTrustDecay` helper.
 */

import type { PrismaClient } from "@prisma/client";
import {
  TRUST_DECAY_DEFAULT_MAX,
  TRUST_DECAY_STALE_DAYS,
  computeTrustDecay,
  trustDecayReachesAtUtc,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump, setGauge } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

// -----------------------------------------------------------------------------
// The ONE decision (closure 2, "sem" item 3c)
// -----------------------------------------------------------------------------

/** Devices one decay run reads per workspace (ordered by id). */
export const TRUST_DECAY_SWEEP_BATCH_DEFAULT = 200;

/** The decay level at which a device is quarantined on the way up. */
export const TRUST_DECAY_QUARANTINE_AT = 70;

export type TrustDecayAction = "NONE" | "REVOKE" | "QUARANTINE" | "RELEASE_QUARANTINE" | "DECAY";

/** Review L-4 — reasons written by the sweep (bounded, operator-readable). */
export const TRUST_DECAY_REASON = {
  RAISED: "Trust decayed by stale-device sweep.",
  RECOMPUTED: "Trust decay recomputed from last-seen time.",
  QUARANTINED: "High decay — quarantined pending review.",
  QUARANTINE_RELEASED: "Quarantine released: decay recomputed from last-seen time is below 70.",
  REVOKED: "Stale device auto-invalidated by decay sweep.",
} as const;

export type TrustDecayDecision = {
  action: TrustDecayAction;
  fromDecay: number;
  toDecay: number;
  /** When the absolute rule reaches the revoke level for this device. */
  revokesAtUtc: Date;
};

/**
 * What a decay run at `now` does to one ACTIVE trusted device. Used by the sweep
 * (which then writes it) AND by the read-only activation preview (which only
 * reports it), so the preview can never describe a different computation from
 * the one that executes. The value is `computeTrustDecay` of the device's
 * `lastSeenAtUtc` and `now` — absolute, so it does not depend on how often or
 * how many times the sweep has already run.
 */
export function decideTrustDecay(
  device: { lastSeenAtUtc: Date; trustScoreDecay: number; quarantinedAtUtc?: Date | null },
  now: Date,
  staleDays: number = TRUST_DECAY_STALE_DAYS,
): TrustDecayDecision {
  const toDecay = computeTrustDecay({ lastSeenAtUtc: device.lastSeenAtUtc, nowUtc: now, staleDays });
  const fromDecay = device.trustScoreDecay;
  const revokesAtUtc = trustDecayReachesAtUtc({ lastSeenAtUtc: device.lastSeenAtUtc, staleDays });
  let action: TrustDecayAction;
  // At the revoke level the device is revoked even if a stored value already
  // says 100 (an ACTIVE row never should; a stale row must not escape).
  //
  // Review L-4 — quarantine is a STATE the same rule decides, not an event on
  // the way up: a device whose recomputed decay is below 70 is released from a
  // decay quarantine (including one the old per-run formula produced — the
  // decay sweep is the only writer of a trusted device's quarantinedAtUtc), and
  // one at 70 or more that is not quarantined is quarantined.
  const quarantinedNow = device.quarantinedAtUtc != null;
  if (toDecay >= TRUST_DECAY_DEFAULT_MAX) action = "REVOKE";
  else if (quarantinedNow && toDecay < TRUST_DECAY_QUARANTINE_AT) action = "RELEASE_QUARANTINE";
  else if (!quarantinedNow && toDecay >= TRUST_DECAY_QUARANTINE_AT) action = "QUARANTINE";
  else if (toDecay === fromDecay) action = "NONE";
  else action = "DECAY";
  return { action, fromDecay, toDecay, revokesAtUtc };
}

// -----------------------------------------------------------------------------
// Sweep
// -----------------------------------------------------------------------------

export type TrustDecaySweepResult = {
  scanned: number;
  decayed: number;
  autoInvalidated: number;
  quarantined: number;
  /** Review L-4 — decay quarantines released because the recomputed decay is below 70. */
  quarantineReleased: number;
};

export async function sweepTrustedDeviceDecay(
  input: {
    teamId: string;
    staleDays?: number;
    batchSize?: number;
    /** The run's clock (tests and the scheduled sweep pass theirs). */
    now?: Date;
  },
  client: PrismaClient = defaultPrisma,
): Promise<TrustDecaySweepResult> {
  const stale = input.staleDays ?? TRUST_DECAY_STALE_DAYS;
  const batchSize = Math.min(Math.max(input.batchSize ?? TRUST_DECAY_SWEEP_BATCH_DEFAULT, 1), 1000);
  const now = input.now ?? new Date();
  const devices = await client.trustedDevice.findMany({
    where: {
      teamId: input.teamId,
      status: "ACTIVE",
    },
    take: batchSize,
    orderBy: { id: "asc" },
    select: {
      id: true,
      userId: true,
      lastSeenAtUtc: true,
      trustScoreDecay: true,
      quarantinedAtUtc: true,
    },
  });
  let decayed = 0;
  let quarantineReleased = 0;
  let autoInvalidated = 0;
  let quarantined = 0;
  for (const d of devices) {
    const decision = decideTrustDecay(d, now, stale);
    const next = decision.toDecay;
    if (decision.action === "NONE") continue;
    if (decision.action === "REVOKE") {
      // Auto-invalidate.
      await client.trustedDevice.update({
        where: { id: d.id },
        data: {
          status: "REVOKED",
          revokedAtUtc: now,
          revokedReason: "TRUST_DECAY_AUTO_INVALIDATED",
          trustScoreDecay: TRUST_DECAY_DEFAULT_MAX,
          decayReason: TRUST_DECAY_REASON.REVOKED,
        },
      });
      autoInvalidated += 1;
      bump("trusted_device_auto_invalidated_total");
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "trusted_device_auto_invalidated",
        severity: "WARNING",
        details: { trustedDeviceId: d.id, userId: d.userId, decay: next },
      });
      continue;
    }
    if (decision.action === "QUARANTINE") {
      // Quarantine the device on the way up — it stays ACTIVE for read
      // purposes but the adaptive auth engine treats it as untrusted.
      await client.trustedDevice.update({
        where: { id: d.id },
        data: {
          trustScoreDecay: next,
          quarantinedAtUtc: now,
          decayReason: TRUST_DECAY_REASON.QUARANTINED,
        },
      });
      quarantined += 1;
      bump("trusted_device_decay_total");
    } else if (decision.action === "RELEASE_QUARANTINE") {
      await client.trustedDevice.update({
        where: { id: d.id },
        data: {
          trustScoreDecay: next,
          quarantinedAtUtc: null,
          decayReason: TRUST_DECAY_REASON.QUARANTINE_RELEASED,
        },
      });
      quarantineReleased += 1;
      bump("trusted_device_decay_total");
    } else {
      await client.trustedDevice.update({
        where: { id: d.id },
        data: {
          trustScoreDecay: next,
          // Review L-4 — a lowered value is a RECOMPUTATION from last-seen time
          // (it may be a residue of the old per-run formula, not a device seen
          // again); the sweep cannot tell, so it says only what it did.
          decayReason: next < d.trustScoreDecay ? TRUST_DECAY_REASON.RECOMPUTED : TRUST_DECAY_REASON.RAISED,
        },
      });
      bump("trusted_device_decay_total");
    }
    decayed += 1;
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "trusted_device_decayed",
      severity: "INFO",
      details: {
        trustedDeviceId: d.id,
        userId: d.userId,
        fromDecay: d.trustScoreDecay,
        toDecay: next,
      },
    });
  }
  // Refresh the dashboard gauge.
  const decayedNow = await client.trustedDevice.count({
    where: { teamId: input.teamId, trustScoreDecay: { gt: 0 } },
  });
  setGauge("trusted_devices_decayed", decayedNow);
  return {
    scanned: devices.length,
    decayed,
    autoInvalidated,
    quarantined,
    quarantineReleased,
  };
}
