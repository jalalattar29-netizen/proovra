/**
 * Phase 26.5 — Suspicious session detector.
 *
 * Computes the risk score on an `authenticated_sessions` row using the
 * shared signal catalog. Reads:
 *   - the current session row
 *   - the user's other active sessions (concurrent-risky check)
 *   - the user's recent SSO callback failures (failed-callback burst)
 *
 * Writes:
 *   - `authenticated_sessions.risk_score`
 *   - SecurityEvent `suspicious_session_detected` when level >= MEDIUM
 *   - Phase 19 RiskSignal rows where the existing signal-kind maps
 *
 * Hard rules:
 *   - NEVER persists raw IP / geo coordinates. Country code comparison
 *     is the strongest signal we use.
 *   - Signals are deterministic and explainable; the operator UI can
 *     render `signals[]` as a list.
 */

import type {
  PrismaClient,
  AuthenticatedSession as DbSession,
} from "@prisma/client";
import {
  SUSPICIOUS_SESSION_SIGNAL_KINDS,
  SUSPICIOUS_SESSION_SIGNAL_WEIGHTS,
  computeSuspiciousSessionRisk,
  sessionRiskLevel,
  type SuspiciousSessionSignal,
  type SuspiciousSessionSignalKind,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

// -----------------------------------------------------------------------------
// Result shape
// -----------------------------------------------------------------------------

export type DetectionResult = {
  sessionId: string;
  riskScore: number;
  level: ReturnType<typeof sessionRiskLevel>;
  signals: ReadonlyArray<SuspiciousSessionSignal>;
  /**
   * WHAT THE SCORE WAS BEFORE THIS EVALUATION.
   *
   * Re-score returned a number and nothing to compare it against, so the
   * operator pressing "Re-score" learned only what the score is now — not
   * whether pressing it had changed anything, and not whether the session had
   * got better or worse. A control whose whole purpose is to re-evaluate has
   * to say what the re-evaluation found.
   *
   * `null` means the session carried no score yet, which is different from a
   * previous score of zero.
   */
  previousRiskScore: number | null;
  previousLevel: ReturnType<typeof sessionRiskLevel> | null;
  /** When this evaluation ran. Without it, "now" is the reader's guess. */
  evaluatedAtUtc: string;
  /** Whether the score or the band actually moved. */
  changed: boolean;
};

const SIGNAL_SET = new Set<string>(SUSPICIOUS_SESSION_SIGNAL_KINDS);

function signal(
  kind: SuspiciousSessionSignalKind,
  reason: string,
): SuspiciousSessionSignal {
  return {
    kind,
    weight: SUSPICIOUS_SESSION_SIGNAL_WEIGHTS[kind],
    reason,
  };
}

// -----------------------------------------------------------------------------
// detectAndScoreSession
// -----------------------------------------------------------------------------

export async function detectAndScoreSession(
  input: {
    teamId: string;
    sessionId: string;
    /** Override "now" for tests. */
    nowUtc?: Date;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DetectionResult | null> {
  const session = await client.authenticatedSession.findFirst({
    where: { id: input.sessionId, teamId: input.teamId },
  });
  if (!session) return null;

  // Captured BEFORE the update below overwrites it. A null here means the
  // session had never been scored, which is a different fact from a score of
  // zero and must not be flattened into one.
  const previousRiskScore =
    typeof session.riskScore === "number" ? session.riskScore : null;

  const now = (input.nowUtc ?? new Date()).getTime();
  const signals: SuspiciousSessionSignal[] = [];

  // (1) Concurrent risky sessions: count of other active sessions for
  // the same user with a different IP preview.
  const concurrent = await client.authenticatedSession.findMany({
    where: {
      teamId: input.teamId,
      userId: session.userId,
      revokedAtUtc: null,
      expiresAtUtc: { gt: new Date(now) },
      NOT: { id: session.id },
    },
    select: {
      id: true,
      ipPreview: true,
      countryCode: true,
      issuedAtUtc: true,
    },
  });

  if (concurrent.length >= 3) {
    signals.push(
      signal(
        "CONCURRENT_RISKY_SESSIONS",
        `${concurrent.length} other active sessions`,
      ),
    );
  }

  // (2) Rapid geo change: any other session opened in a different
  // country within the last hour.
  if (session.countryCode) {
    const recentDifferentCountry = concurrent.find(
      (s) =>
        s.countryCode &&
        s.countryCode !== session.countryCode &&
        now - s.issuedAtUtc.getTime() < 3600_000,
    );
    if (recentDifferentCountry) {
      signals.push(
        signal(
          "RAPID_GEO_CHANGE",
          `recent session from ${recentDifferentCountry.countryCode} within 1h`,
        ),
      );
      // Stronger signal: impossible travel within a window <= 1h.
      const minutesApart =
        Math.abs(
          session.issuedAtUtc.getTime() -
            recentDifferentCountry.issuedAtUtc.getTime(),
        ) / 60_000;
      if (minutesApart < 60) {
        signals.push(
          signal(
            "IMPOSSIBLE_TRAVEL",
            `same user authenticated from two countries ${Math.round(minutesApart)}m apart`,
          ),
        );
      }
    }
  }

  // (3) High-risk IP shift: the session's IP preview differs from the
  // user's most-recent prior session AND the prior session is recent.
  const prior = concurrent
    .filter((s) => s.ipPreview && s.ipPreview !== session.ipPreview)
    .sort((a, b) => b.issuedAtUtc.getTime() - a.issuedAtUtc.getTime())[0];
  if (prior && now - prior.issuedAtUtc.getTime() < 6 * 3600_000) {
    signals.push(
      signal(
        "HIGH_RISK_IP_SHIFT",
        `ip preview ${session.ipPreview} differs from recent ${prior.ipPreview}`,
      ),
    );
  }

  // (4) Repeated failed SSO callbacks for this connection in the
  // last 15 minutes.
  if (session.ssoConnectionId) {
    const failed = await client.ssoCallbackAttempt.count({
      where: {
        teamId: input.teamId,
        ssoConnectionId: session.ssoConnectionId,
        status: { in: ["FAILED", "REPLAYED"] },
        createdAt: { gte: new Date(now - 15 * 60_000) },
      },
    });
    if (failed >= 3) {
      signals.push(
        signal(
          "REPEATED_FAILED_SSO_CALLBACKS",
          `${failed} failed callbacks in 15m`,
        ),
      );
    }
  }

  // (5) Token replay indicator: any SSO callback attempt for this
  // connection that was REPLAYED recently.
  if (session.ssoConnectionId) {
    const replayed = await client.ssoCallbackAttempt.count({
      where: {
        teamId: input.teamId,
        ssoConnectionId: session.ssoConnectionId,
        status: "REPLAYED",
        replayDetectedAtUtc: { gte: new Date(now - 60 * 60_000) },
      },
    });
    if (replayed > 0) {
      signals.push(
        signal(
          "TOKEN_REPLAY_INDICATOR",
          `${replayed} replayed callback(s) in 1h`,
        ),
      );
    }
  }

  // (6) Unknown device: no deviceIdHash AND not the user's first
  // session (we expect known devices for repeat logins).
  if (!session.deviceIdHash) {
    const userPriorCount = await client.authenticatedSession.count({
      where: { userId: session.userId },
    });
    if (userPriorCount > 1) {
      signals.push(
        signal("UNKNOWN_DEVICE_ANOMALY", "session has no trusted-device hash"),
      );
    }
  }

  const riskScore = computeSuspiciousSessionRisk(signals);
  const level = sessionRiskLevel(riskScore);

  // Persist the score on the session row.
  await client.authenticatedSession.update({
    where: { id: session.id },
    data: { riskScore },
  });

  if (level === "MEDIUM" || level === "HIGH" || level === "CRITICAL") {
    bump("suspicious_session_total");
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "suspicious_session_detected",
      severity: level === "CRITICAL" ? "HIGH" : level === "HIGH" ? "HIGH" : "WARNING",
      details: {
        sessionId: session.id,
        userId: session.userId,
        riskScore,
        level,
        signalKinds: signals.map((s) => s.kind),
      },
    });
  }

  /*
   * The previous score was read off the session row BEFORE the update above
   * overwrote it. Reading it afterwards would report the new value as the old
   * one, which is the failure mode a before/after display exists to prevent.
   */
  const previousLevel =
    previousRiskScore === null ? null : sessionRiskLevel(previousRiskScore);
  return {
    sessionId: session.id,
    riskScore,
    level,
    signals: signals.filter((s) => SIGNAL_SET.has(s.kind)),
    previousRiskScore,
    previousLevel,
    evaluatedAtUtc: new Date(now).toISOString(),
    changed: previousRiskScore !== riskScore || previousLevel !== level,
  };
}

// -----------------------------------------------------------------------------
// Convenience: read the current risk score for a session without
// recomputing.
// -----------------------------------------------------------------------------

export async function readSessionRiskScore(
  input: { teamId: string; sessionId: string },
  client: PrismaClient = defaultPrisma,
): Promise<number | null> {
  const row = await client.authenticatedSession.findFirst({
    where: { id: input.sessionId, teamId: input.teamId },
    select: { riskScore: true },
  });
  return row?.riskScore ?? null;
}

// -----------------------------------------------------------------------------
// Re-export for tests / route layer.
// -----------------------------------------------------------------------------

export {
  computeSuspiciousSessionRisk,
  sessionRiskLevel,
};
export type { SuspiciousSessionSignal, DbSession };
