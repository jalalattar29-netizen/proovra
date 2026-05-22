/**
 * Phase 32.8C++++ — AccessAnomaly classifier writer + reader.
 *
 * Persists output of the security/access anomaly classifier. The
 * classifier reads SecurityEvent rows in a bounded window and groups
 * them by (category, actorUserId, eventType). Anomalies above a
 * threshold are upserted into the `access_anomalies` table. The
 * dashboard's deep security watch reads from this table directly —
 * fast lookups, no expensive groupBy at read time.
 *
 * Hard rules:
 *   - ADVISORY operational data. The canonical security event log is
 *     `SecurityEvent` itself — this table is a classified rollup.
 *   - Classifier failures NEVER block evidence/report/package flows.
 *   - Callers (cron / on-demand operator) wrap invocations in
 *     try/catch.
 *   - No raw event payloads are projected (sourceEventIds only —
 *     bounded array of UUID strings).
 *   - Bounded operator-safe summary string (≤ 400 chars).
 *   - Rule-based classifier on eventType strings — no ML.
 */

import { prisma } from "../../db.js";

export type AccessAnomalyCategory =
  | "REPEATED_FAILED_ACCESS"
  | "BLOCKED_EXPORT_ATTEMPT"
  | "API_CREDENTIAL_CHANGE"
  | "WEBHOOK_FAILURE_SPIKE"
  | "ADMIN_ROLE_CHANGE"
  | "STEP_UP_FAILED"
  | "PERMISSION_DENIED_BURST"
  | "UNCATEGORIZED";

export type AccessAnomalySeverity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";
export type AccessAnomalyStatus =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "RESOLVED"
  | "SUPPRESSED";

const CLASSIFIER_WINDOW_HOURS = 24;
const CLASSIFIER_MIN_BURST = 3;

/**
 * Bounded rule-based mapping from SecurityEvent.eventType → bounded
 * anomaly category. Adding a new category requires a code change so
 * that operator-facing labels remain bounded.
 */
export function classifyEventType(
  eventType: string,
): AccessAnomalyCategory {
  const t = eventType.toLowerCase();
  if (
    t.includes("login_failed") ||
    t.includes("auth_failed") ||
    t.includes("failed_login")
  )
    return "REPEATED_FAILED_ACCESS";
  if (t.includes("permission_denied")) return "PERMISSION_DENIED_BURST";
  if (t.includes("step_up_failed") || t.includes("stepup_failed"))
    return "STEP_UP_FAILED";
  if (t.includes("export") && (t.includes("block") || t.includes("denied")))
    return "BLOCKED_EXPORT_ATTEMPT";
  if (t.includes("api_credential") || t.includes("api_key"))
    return "API_CREDENTIAL_CHANGE";
  if (t.includes("webhook") && (t.includes("fail") || t.includes("error")))
    return "WEBHOOK_FAILURE_SPIKE";
  if (t.includes("admin_role") || t.includes("role_change"))
    return "ADMIN_ROLE_CHANGE";
  return "UNCATEGORIZED";
}

/**
 * Map an enum severity to the bounded human-grade tone the dashboard
 * uses. The classifier escalates by event count too.
 */
function classifySeverity(
  category: AccessAnomalyCategory,
  count: number,
  worstSecurityEventSeverity: "INFO" | "WARNING" | "HIGH",
): AccessAnomalySeverity {
  if (
    category === "ADMIN_ROLE_CHANGE" ||
    category === "BLOCKED_EXPORT_ATTEMPT" ||
    category === "STEP_UP_FAILED"
  ) {
    // Critical-leaning categories — escalate faster.
    if (worstSecurityEventSeverity === "HIGH" || count >= 5) return "HIGH";
    if (count >= 3) return "WARNING";
    return "INFO";
  }
  // Default scaling.
  if (count >= 10 || worstSecurityEventSeverity === "HIGH") return "HIGH";
  if (count >= CLASSIFIER_MIN_BURST) return "WARNING";
  return "INFO";
}

function describeAnomaly(c: AccessAnomalyCategory, count: number): string {
  switch (c) {
    case "REPEATED_FAILED_ACCESS":
      return `${count} failed access events recorded in ${CLASSIFIER_WINDOW_HOURS}h.`;
    case "BLOCKED_EXPORT_ATTEMPT":
      return `${count} blocked export attempts in ${CLASSIFIER_WINDOW_HOURS}h.`;
    case "API_CREDENTIAL_CHANGE":
      return `${count} API credential change event(s) in ${CLASSIFIER_WINDOW_HOURS}h.`;
    case "WEBHOOK_FAILURE_SPIKE":
      return `${count} webhook failure event(s) in ${CLASSIFIER_WINDOW_HOURS}h.`;
    case "ADMIN_ROLE_CHANGE":
      return `${count} admin role-change event(s) in ${CLASSIFIER_WINDOW_HOURS}h.`;
    case "STEP_UP_FAILED":
      return `${count} step-up authentication failure(s) in ${CLASSIFIER_WINDOW_HOURS}h.`;
    case "PERMISSION_DENIED_BURST":
      return `${count} permission-denied event(s) in ${CLASSIFIER_WINDOW_HOURS}h.`;
    case "UNCATEGORIZED":
      return `${count} security event(s) outside the classified catalog in ${CLASSIFIER_WINDOW_HOURS}h.`;
  }
}

/**
 * Run the classifier for one workspace. Reads SecurityEvent rows in
 * the bounded window, groups them, and upserts AccessAnomaly rows.
 * Returns the count of rows persisted.
 *
 * IMPORTANT: this function is read-only with respect to
 * SecurityEvent — it only WRITES to AccessAnomaly.
 */
export async function runClassifierForWorkspace(input: {
  teamId: string;
}): Promise<{ persisted: number; failed: number }> {
  let persisted = 0;
  let failed = 0;
  const windowStart = new Date(
    Date.now() - CLASSIFIER_WINDOW_HOURS * 60 * 60 * 1000,
  );
  const windowEnd = new Date();
  try {
    const events = await prisma.securityEvent.findMany({
      where: {
        teamId: input.teamId,
        severity: { in: ["WARNING", "HIGH"] },
        createdAt: { gte: windowStart },
      },
      orderBy: { createdAt: "asc" },
      take: 1000,
      select: {
        id: true,
        eventType: true,
        severity: true,
        userId: true,
        createdAt: true,
      },
    });

    type GroupKey = string;
    const groups = new Map<
      GroupKey,
      {
        category: AccessAnomalyCategory;
        actorUserId: string | null;
        eventType: string;
        eventIds: string[];
        count: number;
        worstSeverity: "INFO" | "WARNING" | "HIGH";
        firstSeen: Date;
        lastSeen: Date;
      }
    >();

    for (const e of events) {
      const category = classifyEventType(e.eventType);
      const key = `${category}|${e.userId ?? "anon"}|${e.eventType}`;
      const entry = groups.get(key);
      if (entry) {
        entry.count += 1;
        entry.eventIds.push(e.id);
        if (
          e.severity === "HIGH" ||
          (entry.worstSeverity !== "HIGH" && e.severity === "WARNING")
        ) {
          entry.worstSeverity = e.severity as "INFO" | "WARNING" | "HIGH";
        }
        if (e.createdAt > entry.lastSeen) entry.lastSeen = e.createdAt;
      } else {
        groups.set(key, {
          category,
          actorUserId: e.userId,
          eventType: e.eventType,
          eventIds: [e.id],
          count: 1,
          worstSeverity: e.severity as "INFO" | "WARNING" | "HIGH",
          firstSeen: e.createdAt,
          lastSeen: e.createdAt,
        });
      }
    }

    for (const g of groups.values()) {
      // Skip noisy uncategorized rows below the burst threshold.
      if (g.category === "UNCATEGORIZED" && g.count < CLASSIFIER_MIN_BURST)
        continue;
      try {
        // Idempotent upsert: same window + category + actor + eventType
        // collapses into a single row. We key on createdAt-window so
        // re-classification of the same window updates the same row.
        const existing = await prisma.accessAnomaly.findFirst({
          where: {
            teamId: input.teamId,
            category: g.category,
            actorUserId: g.actorUserId,
            sampleEventType: g.eventType,
            windowStartUtc: { gte: windowStart },
          },
          select: { id: true },
        });
        const severity = classifySeverity(g.category, g.count, g.worstSeverity);
        const summary = describeAnomaly(g.category, g.count);
        if (existing) {
          await prisma.accessAnomaly.update({
            where: { id: existing.id },
            data: {
              count: g.count,
              severity,
              summary,
              windowEndUtc: g.lastSeen,
              sourceEventIds: g.eventIds.slice(0, 50),
            },
          });
        } else {
          await prisma.accessAnomaly.create({
            data: {
              teamId: input.teamId,
              actorUserId: g.actorUserId,
              category: g.category,
              severity,
              status: "OPEN",
              sampleEventType: g.eventType.slice(0, 80),
              count: g.count,
              windowStartUtc: g.firstSeen,
              windowEndUtc: g.lastSeen,
              sourceEventIds: g.eventIds.slice(0, 50),
              summary,
            },
          });
        }
        persisted += 1;
      } catch {
        failed += 1;
      }
    }
  } catch {
    /* outer read failure — return partial counts */
  }
  return { persisted, failed };
}

/**
 * Dashboard reader. Returns recent OPEN/ACKNOWLEDGED anomalies for a
 * workspace, ordered by severity then most-recent.
 */
export async function listWorkspaceAccessAnomalies(input: {
  teamId: string;
  limit: number;
}): Promise<
  Array<{
    id: string;
    category: AccessAnomalyCategory;
    severity: AccessAnomalySeverity;
    status: AccessAnomalyStatus;
    sampleEventType: string;
    count: number;
    actorUserId: string | null;
    windowStartUtc: string;
    windowEndUtc: string;
    summary: string | null;
  }>
> {
  const rows = await prisma.accessAnomaly.findMany({
    where: {
      teamId: input.teamId,
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
    },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    take: Math.min(Math.max(input.limit, 1), 50),
    select: {
      id: true,
      category: true,
      severity: true,
      status: true,
      sampleEventType: true,
      count: true,
      actorUserId: true,
      windowStartUtc: true,
      windowEndUtc: true,
      summary: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    category: r.category as AccessAnomalyCategory,
    severity: r.severity as AccessAnomalySeverity,
    status: r.status as AccessAnomalyStatus,
    sampleEventType: r.sampleEventType,
    count: r.count,
    actorUserId: r.actorUserId,
    windowStartUtc: r.windowStartUtc.toISOString(),
    windowEndUtc: r.windowEndUtc.toISOString(),
    summary: r.summary,
  }));
}
