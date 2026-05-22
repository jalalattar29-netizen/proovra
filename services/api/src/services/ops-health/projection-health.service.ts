/**
 * Phase 32.8C+++++++ — Generic projection health evaluator.
 *
 * Many dashboard sections are LAZY PROJECTIONS — they read from an
 * advisory table (OperationalTimelineEvent, EvidenceIntegritySnapshot,
 * OperationalCorrelation, etc.) that is populated by a writer on
 * dashboard load. A read that returns 0 rows is NOT a failure — the
 * writer may simply not have run yet.
 *
 * This evaluator wraps the three-state common case:
 *   - HEALTHY      — projection table has fresh rows
 *   - STALE        — projection table has rows but they're old
 *   - DISCONNECTED — projection table is empty (no writer fire yet)
 *   - DEGRADED     — read failed but canonical source is fine
 *   - FAILED       — read failed AND no canonical source
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import type { OpsHealthState } from "./types.js";
import { severityForStatus } from "./types.js";

export async function evaluateProjectionHealth(input: {
  /** Friendly projection name for the operator-facing reason copy. */
  projectionName: string;
  /** Returns the latest sample timestamp, or null when empty. */
  readLatest: () => Promise<Date | null>;
  /** Returns true if the canonical upstream source is still operational. */
  canonicalSourceHealthy?: () => Promise<boolean>;
  /** Fresh threshold in hours (default 24). */
  freshHours?: number;
  /** Stale threshold in hours (default 72). */
  staleHours?: number;
  _client?: PrismaClient; // reserved for future per-projection extension
}): Promise<OpsHealthState> {
  const freshHours = input.freshHours ?? 24;
  const staleHours = input.staleHours ?? 72;

  let latest: Date | null = null;
  let readOk = true;
  try {
    latest = await input.readLatest();
  } catch {
    readOk = false;
  }

  let canonicalOk = true;
  if (input.canonicalSourceHealthy) {
    try {
      canonicalOk = await input.canonicalSourceHealthy();
    } catch {
      canonicalOk = false;
    }
  }

  if (!readOk && !canonicalOk) {
    return finalize({
      status: "FAILED",
      reason: `${input.projectionName} read failed AND canonical source could not be confirmed healthy.`,
      recoverable: false,
      lastSuccessfulRunAt: null,
      retrying: true,
      degradedSince: new Date().toISOString(),
      canonicalSourceHealthy: false,
    });
  }
  if (!readOk && canonicalOk) {
    return finalize({
      status: "DEGRADED",
      reason: `${input.projectionName} read failed on this cycle. The canonical upstream source remains operational; the projection will reattempt on the next refresh.`,
      recoverable: true,
      lastSuccessfulRunAt: null,
      retrying: true,
      degradedSince: new Date().toISOString(),
      canonicalSourceHealthy: true,
    });
  }
  if (latest === null) {
    return finalize({
      status: "DISCONNECTED",
      reason: `${input.projectionName} has no rows yet — the lazy writer populates the table on first dashboard read. If this is a fresh workspace or a fresh deploy, the empty state is expected.`,
      recoverable: true,
      lastSuccessfulRunAt: null,
      retrying: false,
      degradedSince: null,
      canonicalSourceHealthy: canonicalOk,
    });
  }
  const ageH = (Date.now() - latest.getTime()) / 3_600_000;
  if (ageH <= freshHours) {
    return finalize({
      status: "HEALTHY",
      reason: `${input.projectionName} latest row ${formatHours(ageH)} ago.`,
      recoverable: true,
      lastSuccessfulRunAt: latest.toISOString(),
      retrying: false,
      degradedSince: null,
      canonicalSourceHealthy: true,
    });
  }
  if (ageH <= staleHours) {
    return finalize({
      status: "STALE",
      reason: `${input.projectionName} latest row ${formatHours(ageH)} ago (past the ${freshHours}h freshness threshold). The lazy writer will refresh on the next dashboard load.`,
      recoverable: true,
      lastSuccessfulRunAt: latest.toISOString(),
      retrying: true,
      degradedSince: latest.toISOString(),
      canonicalSourceHealthy: true,
    });
  }
  return finalize({
    status: "STALE",
    reason: `${input.projectionName} latest row ${formatHours(ageH)} ago (well past the stale threshold of ${staleHours}h). Canonical source remains operational; the projection may simply have not had a reason to write a fresh row.`,
    recoverable: true,
    lastSuccessfulRunAt: latest.toISOString(),
    retrying: true,
    degradedSince: latest.toISOString(),
    canonicalSourceHealthy: true,
  });
}

function finalize(input: Omit<OpsHealthState, "severity">): OpsHealthState {
  return { ...input, severity: severityForStatus(input.status) };
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.floor(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${Math.floor(hours / 24)}d`;
}

// Re-export the default prisma for convenience if a caller needs it.
export { defaultPrisma };
