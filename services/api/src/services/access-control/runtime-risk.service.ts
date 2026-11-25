/**
 * Phase 26.75 — Runtime risk recompute service.
 *
 * Periodically re-scores active sessions via the Phase 26.5 detector
 * + applies privileged-session aging penalties. Auto-quarantines
 * sessions that cross the HIGH-risk threshold without a trusted device.
 *
 * Hard rules:
 *   - Bounded batch size. Never re-scores every session in one pass.
 *   - Cooldown: a session that was recomputed within the window is
 *     skipped (uses the shared `isSessionDueForRiskRecompute` helper).
 *   - Auto-actions are explicit + audited. NEVER silently revokes.
 *   - Runtime incident open is gated on a threshold to avoid noise.
 */

import type { PrismaClient } from "@prisma/client";
import {
  HIGH_RISK_INCIDENT_DEDUP_HOURS,
  HIGH_RISK_INCIDENT_DEFAULT_THRESHOLD,
  RUNTIME_RISK_RECOMPUTE_DEFAULT_MINUTES,
  SESSION_RISK_MEDIUM_THRESHOLD,
  SUSPICIOUS_SESSION_SIGNAL_WEIGHTS,
  computeSuspiciousSessionRisk,
  isSessionDueForRiskRecompute,
  sessionRiskLevel,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump, setGauge } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { recordIncident } from "../observability/incident.service.js";
import { collectSessionRiskSignals, detectAndScoreSession } from "./suspicious-session.service.js";
import { quarantineSession } from "./session-quarantine.service.js";

// -----------------------------------------------------------------------------
// Result shape
// -----------------------------------------------------------------------------

export type RuntimeRiskRecomputeResult = {
  scanned: number;
  recomputed: number;
  skippedCooldown: number;
  escalatedToQuarantine: number;
  highRiskCount: number;
};

// -----------------------------------------------------------------------------
// Sweep
// -----------------------------------------------------------------------------

export async function runtimeRiskRecomputeSweep(
  input: {
    teamId: string;
    recomputeWindowMinutes?: number;
    batchSize?: number;
    autoQuarantine?: boolean;
  },
  client: PrismaClient = defaultPrisma,
): Promise<RuntimeRiskRecomputeResult> {
  const window =
    input.recomputeWindowMinutes ?? RUNTIME_RISK_RECOMPUTE_DEFAULT_MINUTES;
  const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 1000);
  const autoQuarantine = input.autoQuarantine !== false;
  const now = new Date();

  const candidates = await client.authenticatedSession.findMany({
    where: {
      teamId: input.teamId,
      revokedAtUtc: null,
      expiresAtUtc: { gt: now },
    },
    take: batchSize,
    orderBy: { lastRiskRecomputedAtUtc: { sort: "asc", nulls: "first" } },
    select: {
      id: true,
      userId: true,
      lastRiskRecomputedAtUtc: true,
      riskScore: true,
      deviceIdHash: true,
      quarantinedAtUtc: true,
    },
  });

  let recomputed = 0;
  let skippedCooldown = 0;
  let escalatedToQuarantine = 0;
  let highRiskCount = 0;

  for (const c of candidates) {
    if (
      !isSessionDueForRiskRecompute({
        lastRiskRecomputedAtUtc: c.lastRiskRecomputedAtUtc,
        recomputeWindowMinutes: window,
        nowUtc: now,
      })
    ) {
      skippedCooldown += 1;
      continue;
    }
    try {
      const result = await detectAndScoreSession(
        { teamId: input.teamId, sessionId: c.id },
        client,
      );
      await client.authenticatedSession.update({
        where: { id: c.id },
        data: { lastRiskRecomputedAtUtc: now },
      });
      recomputed += 1;
      bump("runtime_risk_recompute_total");
      if (!result) continue;
      const level = sessionRiskLevel(result.riskScore);
      if (level === "HIGH" || level === "CRITICAL") {
        highRiskCount += 1;
        bump("high_risk_session_total");
        if (level !== sessionRiskLevel(c.riskScore ?? 0)) {
          safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "runtime_risk_escalated",
            severity: "WARNING",
            details: {
              sessionId: c.id,
              fromScore: c.riskScore ?? 0,
              toScore: result.riskScore,
              level,
            },
          });
        }
        if (autoQuarantine && !c.quarantinedAtUtc && !c.deviceIdHash) {
          const q = await quarantineSession(
            {
              teamId: input.teamId,
              sessionId: c.id,
              reason:
                level === "CRITICAL"
                  ? "SUSPICIOUS_SESSION_AUTO"
                  : "SUSPICIOUS_SESSION_AUTO",
              actorUserId: null,
            },
            client,
          );
          if (q) escalatedToQuarantine += 1;
        }
      } else {
        // level is LOW or MEDIUM here. If the previous score was
        // HIGH/CRITICAL, emit a cool-down event so the operator UI
        // shows the de-escalation.
        const priorLevel = sessionRiskLevel(c.riskScore ?? 0);
        if (priorLevel === "HIGH" || priorLevel === "CRITICAL") {
          safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "runtime_risk_cooled_down",
            severity: "INFO",
            details: {
              sessionId: c.id,
              fromScore: c.riskScore ?? 0,
              toScore: result.riskScore,
              level,
            },
          });
        }
      }
    } catch {
      bump("runtime_risk_recompute_failed_total");
    }
  }

  // High-risk threshold incident.
  if (highRiskCount >= HIGH_RISK_INCIDENT_DEFAULT_THRESHOLD) {
    try {
      await recordIncident({
        sourceId: "identity.high_risk_session_surge",
        teamId: input.teamId,
        category: "IDENTITY_SECURITY",
        severity: "HIGH",
        fingerprint: `runtime-high-risk-sessions:${input.teamId}:${Math.floor(now.getTime() / (HIGH_RISK_INCIDENT_DEDUP_HOURS * 3600_000))}`,
        message: {
          code: "ops.identity.high_risk_session_surge",
          params: { count: highRiskCount },
        },
        runbookSlug: "high-risk-session-surge",
        metadata: { highRiskCount, recomputed },
      });
      bump("runtime_incident_total");
    } catch {
      /* incident creation is best-effort */
    }
  }

  setGauge("high_risk_sessions", highRiskCount);

  return {
    scanned: candidates.length,
    recomputed,
    skippedCooldown,
    escalatedToQuarantine,
    highRiskCount,
  };
}

// -----------------------------------------------------------------------------
// T-026 — one-time recalibration of scores that came from the old concurrency
// rule (compatibility for T-025).
// -----------------------------------------------------------------------------

/**
 * Sessions are scored at issuance and the score is persisted. Sessions scored
 * before T-025 kept CONCURRENT_RISKY_SESSIONS (35, MEDIUM on its own) for a
 * person's own same-device sessions until the next re-score, so routine
 * verdicts kept asking for a second factor after the deploy.
 *
 * This pass re-derives each live MEDIUM/HIGH session's signals with the
 * current scorer and lowers the stored score ONLY by the concurrency weight
 * the new rule no longer applies:
 *   - the new signals no longer include CONCURRENT_RISKY_SESSIONS;
 *   - the stored score is above the new one by at most that weight.
 * Any other cause of the stored score (IP shift, unknown device, geo) is left
 * as it is. Nobody is signed out; nothing is raised.
 *
 * Idempotent and bounded: a session evaluated here is stamped with
 * `lastRiskRecomputedAtUtc`, and only sessions not recomputed since the
 * recalibration epoch are selected, so a second run finds nothing to do. Each
 * lowered score is audited as a `runtime_risk_cooled_down` security event with
 * reason `concurrency_recalibrated`.
 */
export const CONCURRENCY_RECALIBRATION_EPOCH_UTC = new Date("2026-11-24T00:00:00Z");

export type ConcurrencyRecalibrationResult = {
  scanned: number;
  lowered: number;
  unchanged: number;
};

export async function recalibrateConcurrencyOnlySessionScores(
  input: { batchSize?: number; nowUtc?: Date; userId?: string } = {},
  client: PrismaClient = defaultPrisma,
): Promise<ConcurrencyRecalibrationResult> {
  const now = input.nowUtc ?? new Date();
  const batchSize = Math.min(Math.max(input.batchSize ?? 500, 1), 2000);
  const concurrencyWeight = SUSPICIOUS_SESSION_SIGNAL_WEIGHTS.CONCURRENT_RISKY_SESSIONS;
  const candidates = await client.authenticatedSession.findMany({
    where: {
      ...(input.userId ? { userId: input.userId } : {}),
      revokedAtUtc: null,
      expiresAtUtc: { gt: now },
      teamId: { not: null },
      riskScore: { gte: SESSION_RISK_MEDIUM_THRESHOLD },
      OR: [
        { lastRiskRecomputedAtUtc: null },
        { lastRiskRecomputedAtUtc: { lt: CONCURRENCY_RECALIBRATION_EPOCH_UTC } },
      ],
    },
    take: batchSize,
    select: {
      id: true,
      teamId: true,
      userId: true,
      riskScore: true,
      countryCode: true,
      ipPreview: true,
      issuedAtUtc: true,
      ssoConnectionId: true,
      deviceIdHash: true,
    },
  });
  let lowered = 0;
  let unchanged = 0;
  for (const c of candidates) {
    const signals = await collectSessionRiskSignals(
      { teamId: c.teamId as string, session: c, nowMs: now.getTime() },
      client,
    );
    const newScore = computeSuspiciousSessionRisk(signals);
    const stillConcurrent = signals.some((s) => s.kind === "CONCURRENT_RISKY_SESSIONS");
    const drop = c.riskScore - newScore;
    const lower = !stillConcurrent && drop > 0 && drop <= concurrencyWeight;
    await client.authenticatedSession.update({
      where: { id: c.id },
      data: { lastRiskRecomputedAtUtc: now, ...(lower ? { riskScore: newScore } : {}) },
    });
    if (lower) {
      lowered += 1;
      safeEmitSecurityEvent({
        teamId: c.teamId,
        eventType: "runtime_risk_cooled_down",
        severity: "INFO",
        details: {
          sessionId: c.id,
          fromScore: c.riskScore,
          toScore: newScore,
          level: sessionRiskLevel(newScore),
          reason: "concurrency_recalibrated",
        },
      });
    } else {
      unchanged += 1;
    }
  }
  return { scanned: candidates.length, lowered, unchanged };
}
