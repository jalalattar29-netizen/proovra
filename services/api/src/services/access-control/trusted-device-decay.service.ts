/**
 * Phase 26.75 — Trusted device decay sweep.
 *
 * Periodic sweep that walks the team's ACTIVE TrustedDevice rows and:
 *   1. Raises `trustScoreDecay` based on the shared `computeTrustDecay`
 *      heuristic (stale + recent risky signals).
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
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump, setGauge } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

// -----------------------------------------------------------------------------
// Sweep
// -----------------------------------------------------------------------------

export type TrustDecaySweepResult = {
  scanned: number;
  decayed: number;
  autoInvalidated: number;
  quarantined: number;
};

export async function sweepTrustedDeviceDecay(
  input: {
    teamId: string;
    staleDays?: number;
    batchSize?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<TrustDecaySweepResult> {
  const stale = input.staleDays ?? TRUST_DECAY_STALE_DAYS;
  const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 1000);
  const now = new Date();
  const devices = await client.trustedDevice.findMany({
    where: {
      teamId: input.teamId,
      status: "ACTIVE",
    },
    take: batchSize,
    select: {
      id: true,
      userId: true,
      lastSeenAtUtc: true,
      trustScoreDecay: true,
    },
  });
  let decayed = 0;
  let autoInvalidated = 0;
  let quarantined = 0;
  for (const d of devices) {
    const next = computeTrustDecay({
      lastSeenAtUtc: d.lastSeenAtUtc,
      currentDecay: d.trustScoreDecay,
      nowUtc: now,
      staleDays: stale,
    });
    if (next === d.trustScoreDecay) continue;
    if (next >= TRUST_DECAY_DEFAULT_MAX) {
      // Auto-invalidate.
      await client.trustedDevice.update({
        where: { id: d.id },
        data: {
          status: "REVOKED",
          revokedAtUtc: now,
          revokedReason: "TRUST_DECAY_AUTO_INVALIDATED",
          trustScoreDecay: TRUST_DECAY_DEFAULT_MAX,
          decayReason: "Stale device auto-invalidated by decay sweep.",
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
    if (next >= 70 && d.trustScoreDecay < 70) {
      // Quarantine the device on the way up — it stays ACTIVE for read
      // purposes but the adaptive auth engine treats it as untrusted.
      await client.trustedDevice.update({
        where: { id: d.id },
        data: {
          trustScoreDecay: next,
          quarantinedAtUtc: now,
          decayReason: "High decay — quarantined pending review.",
        },
      });
      quarantined += 1;
      bump("trusted_device_decay_total");
    } else {
      await client.trustedDevice.update({
        where: { id: d.id },
        data: {
          trustScoreDecay: next,
          decayReason: "Trust decayed by stale-device sweep.",
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
  };
}
