/**
 * Phase 11 — SecurityEvent service.
 *
 * Records workspace-scoped abuse / anomaly / suspicious-activity
 * signals for operator visibility. INTERNAL ONLY: never surfaced on
 * public verify, external intake, or report-v2.
 *
 * The audit chain (`appendCustodyEvent`, `appendPlatformAuditLog`) is
 * reserved for actor decisions and chain-relevant actions. Routine
 * operational signals (rate-limit hits, failure loops) live here so
 * the chain stays focused.
 *
 * All emissions are best-effort: a failure to record must never
 * break the calling flow.
 */

import type {
  PrismaClient,
  Prisma,
  SecurityEvent as DbSecurityEvent,
} from "@prisma/client";
import {
  SECURITY_EVENT_SEVERITIES,
  SECURITY_EVENT_TYPES,
  type SecurityEventSeverity,
  type SecurityEventType,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

const DETAILS_MAX_BYTES = 4 * 1024;
const STRING_MAX = 1000;

function clip(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > STRING_MAX ? `${value.slice(0, STRING_MAX)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(clip);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const [k, v] of Object.entries(value)) {
      if (i >= 50) break;
      out[String(k).slice(0, 64)] = clip(v);
      i += 1;
    }
    return out;
  }
  return value;
}

function safeDetails(input: unknown): Prisma.InputJsonValue | null {
  if (input === null || input === undefined) return null;
  const clipped = clip(input);
  try {
    const s = JSON.stringify(clipped);
    if (s.length > DETAILS_MAX_BYTES) {
      return JSON.parse(
        JSON.stringify({ truncated: true, preview: s.slice(0, 1500) }),
      ) as Prisma.InputJsonValue;
    }
    return clipped as Prisma.InputJsonValue;
  } catch {
    return { truncated: true } as Prisma.InputJsonValue;
  }
}

export type EmitSecurityEventInput = {
  teamId?: string | null;
  eventType: SecurityEventType;
  severity: SecurityEventSeverity;
  evidenceId?: string | null;
  apiCredentialId?: string | null;
  webhookEndpointId?: string | null;
  details?: unknown;
};

const VALID_TYPES = new Set<string>(SECURITY_EVENT_TYPES);
const VALID_SEVERITIES = new Set<string>(SECURITY_EVENT_SEVERITIES);

/**
 * Fire-and-forget. Caller MUST NOT await for side effects of failures.
 * Returns the row on success, or `null` if anything went wrong.
 */
export async function emitSecurityEvent(
  input: EmitSecurityEventInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbSecurityEvent | null> {
  if (!VALID_TYPES.has(input.eventType)) {
    // Phase 20 — make ad-hoc / typo'd event types visible. A dropped
    // event is still dropped, but at least the operator sees the count.
    // Lazy require avoids a circular dep with the ops module.
    void (async () => {
      try {
        const m = await import("../ops/metrics.service.js");
        m.bump("security_event_emit_dropped_unknown_type");
      } catch {
        /* metrics module unavailable in test context */
      }
    })();
    return null;
  }
  if (!VALID_SEVERITIES.has(input.severity)) return null;
  try {
    // Phase 32.7.2 — production `security_events` schema does NOT
    // have `evidenceId / apiCredentialId / webhookEndpointId`
    // columns. The previous Prisma model declared them via
    // `@map("evidence_id")` etc., which produced P2022 INSERT
    // failures and prevented ANY security event from being
    // persisted. The Prisma model is now aligned to the
    // production camelCase schema (see schema.prisma).
    //
    // Caller compatibility: the `EmitSecurityEventInput` interface
    // still accepts these three relation IDs because many call
    // sites already pass them. To preserve the information without
    // requiring a DB migration, the writer FOLDS those IDs into
    // the bounded `metadataJson` blob. Downstream consumers that
    // need to cross-reference can read the JSON.
    const baseDetails = safeDetails(input.details ?? null);
    const baseAsObject =
      baseDetails && typeof baseDetails === "object" && !Array.isArray(baseDetails)
        ? (baseDetails as Record<string, unknown>)
        : null;
    const relationContext: Record<string, unknown> = {};
    if (input.evidenceId) relationContext.evidenceId = input.evidenceId;
    if (input.apiCredentialId) relationContext.apiCredentialId = input.apiCredentialId;
    if (input.webhookEndpointId) relationContext.webhookEndpointId = input.webhookEndpointId;
    const consolidatedDetails: Prisma.InputJsonValue | undefined =
      Object.keys(relationContext).length > 0
        ? ((baseAsObject !== null
            ? { ...baseAsObject, ...relationContext }
            : relationContext) as Prisma.InputJsonValue)
        : (baseDetails as Prisma.InputJsonValue | null) ?? undefined;

    return await client.securityEvent.create({
      data: {
        teamId: input.teamId ?? null,
        eventType: input.eventType,
        severity: input.severity,
        details: consolidatedDetails ?? undefined,
      },
    });
  } catch {
    return null;
  }
}

export function safeEmitSecurityEvent(
  input: EmitSecurityEventInput,
  client: PrismaClient = defaultPrisma,
): void {
  // Phase 20 — fire-and-forget is still required (the calling flow
  // must not break on a SecurityEvent write failure), but failures
  // are no longer SILENT. We bump a global metric so operators can
  // see the failed-emit count rise during a DB outage and we log the
  // first occurrence in each process for diagnosis.
  //
  // Phase 21 — additionally, HIGH-severity events trigger the
  // operational-incident auto-create path. The Phase 21 service
  // deduplicates by fingerprint so a burst of identical events
  // collapses to one incident with a high occurrence count. The hook
  // is best-effort — incident creation failures never break the
  // SecurityEvent path.
  emitSecurityEvent(input, client).then(
    (row) => {
      if (row === null) {
        void (async () => {
          try {
            const m = await import("../ops/metrics.service.js");
            m.bump("security_event_emit_failed");
          } catch {
            /* metrics module unavailable in test context */
          }
        })();
        return;
      }
      if (input.severity === "HIGH" || input.severity === "WARNING") {
        // Only WARNING+ events bubble up to incidents. INFO events
        // are routine operator signals and should not pollute the
        // /ops incident list.
        void maybeAutoCreateIncident(input, row.id, client).catch(() => null);
      }
    },
    () => {
      void (async () => {
        try {
          const m = await import("../ops/metrics.service.js");
          m.bump("security_event_emit_failed");
        } catch {
          /* metrics module unavailable in test context */
        }
      })();
    },
  );
}

/**
 * Phase 21 — auto-create an operational incident when a
 * WARNING-or-higher SecurityEvent fires. The fingerprint is derived
 * from `(eventType, teamId?)` so a burst of identical events on the
 * same team collapses to a single incident.
 *
 * The mapping from SecurityEvent type → IncidentCategory is the
 * source of truth for "which surface owns this signal". Unmapped
 * event types fall back to category=WORKER (operator-debuggable
 * default).
 */
async function maybeAutoCreateIncident(
  input: EmitSecurityEventInput,
  securityEventId: string,
  client: PrismaClient,
): Promise<void> {
  // Lazy import to avoid a circular dep with the observability tree
  // (which itself imports `safeEmitSecurityEvent` indirectly).
  let incident: typeof import("../observability/incident.service.js");
  try {
    incident = await import("../observability/incident.service.js");
  } catch {
    return;
  }
  const { category, runbookSlug } = mapEventTypeToIncident(input.eventType);
  const fingerprint = `${category.toLowerCase()}:security_event:${input.eventType}`;
  const title = `Security signal: ${input.eventType}`;
  const safeSummary = buildSafeSummaryFromDetails(input);
  try {
    await incident.recordIncident(
      {
        teamId: input.teamId ?? null,
        category,
        severity: input.severity === "HIGH" ? "HIGH" : "WARNING",
        fingerprint,
        title,
        safeSummary,
        runbookSlug,
        relatedJobId: securityEventId,
        metadata: { eventType: input.eventType },
      },
      client,
    );
  } catch {
    /* best-effort — never break the SecurityEvent path */
  }
}

function mapEventTypeToIncident(eventType: string): {
  category:
    | "UPLOAD"
    | "REPORT"
    | "PACKAGE"
    | "WEBHOOK"
    | "COMMUNICATIONS"
    | "IDENTITY_SECURITY"
    | "GOVERNANCE"
    | "STORAGE"
    | "AI"
    | "INTEGRATION"
    | "DATABASE"
    | "WORKER"
    | "RECONCILIATION";
  runbookSlug: string | null;
} {
  if (eventType.startsWith("communication_webhook_invalid_signature")) {
    return { category: "WEBHOOK", runbookSlug: "webhook-invalid-signature-burst" };
  }
  if (eventType.startsWith("communication_")) {
    return { category: "COMMUNICATIONS", runbookSlug: "twilio-outage" };
  }
  if (eventType.startsWith("verification_")) {
    return { category: "COMMUNICATIONS", runbookSlug: "twilio-outage" };
  }
  if (
    eventType.startsWith("step_up_") ||
    eventType.startsWith("trusted_device_") ||
    eventType.startsWith("session_revoked") ||
    eventType.startsWith("suspicious_login") ||
    eventType.startsWith("high_risk_action") ||
    eventType.startsWith("service_account_risk") ||
    eventType.startsWith("contributor_risk") ||
    eventType.startsWith("impossible_travel")
  ) {
    return { category: "IDENTITY_SECURITY", runbookSlug: "suspicious-login-burst" };
  }
  if (eventType.startsWith("upload_")) {
    return { category: "UPLOAD", runbookSlug: "stuck-upload" };
  }
  if (eventType.startsWith("webhook_") || eventType.startsWith("webhook")) {
    return { category: "WEBHOOK", runbookSlug: "webhook-invalid-signature-burst" };
  }
  if (eventType.startsWith("governance_") || eventType.startsWith("publication_")) {
    return { category: "GOVERNANCE", runbookSlug: null };
  }
  if (eventType.startsWith("permission_denied")) {
    return { category: "IDENTITY_SECURITY", runbookSlug: null };
  }
  return { category: "WORKER", runbookSlug: null };
}

function buildSafeSummaryFromDetails(input: EmitSecurityEventInput): string {
  const parts: string[] = [`Severity ${input.severity}`];
  if (input.teamId) parts.push(`team ${input.teamId.slice(0, 8)}…`);
  // The details payload was already clipped/sanitised by safeDetails
  // (4 KiB cap, 1 KB string cap per field, no secrets). We only echo
  // the top-level keys to give operators a glance, never the values.
  if (input.details && typeof input.details === "object") {
    const keys = Object.keys(input.details).slice(0, 6).join(", ");
    if (keys.length > 0) parts.push(`fields: ${keys}`);
  }
  return parts.join(" · ");
}

// -----------------------------------------------------------------------------
// Read helpers — used by the /security operations UI.
// -----------------------------------------------------------------------------

export type ListSecurityEventsInput = {
  teamId: string;
  severity?: SecurityEventSeverity;
  eventType?: SecurityEventType;
  limit?: number;
};

export async function listSecurityEvents(
  input: ListSecurityEventsInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbSecurityEvent[]> {
  return client.securityEvent.findMany({
    where: {
      teamId: input.teamId,
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.eventType ? { eventType: input.eventType } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(input.limit ?? 50, 1), 500),
  });
}

export type SecurityEventCounts = {
  total: number;
  high: number;
  warning: number;
  info: number;
};

export async function countSecurityEventsByTeam(
  input: { teamId: string; sinceDays?: number },
  client: PrismaClient = defaultPrisma,
): Promise<SecurityEventCounts> {
  const days = Math.max(1, Math.min(input.sinceDays ?? 30, 365));
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const rows = await client.securityEvent.groupBy({
    by: ["severity"],
    where: { teamId: input.teamId, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const counts: SecurityEventCounts = {
    total: 0,
    high: 0,
    warning: 0,
    info: 0,
  };
  for (const r of rows) {
    const n = r._count._all;
    counts.total += n;
    if (r.severity === "HIGH") counts.high = n;
    else if (r.severity === "WARNING") counts.warning = n;
    else if (r.severity === "INFO") counts.info = n;
  }
  return counts;
}

/**
 * Phase 5 hardening — bounded allow-list for the `details` projection.
 *
 * Pre-fix `projectSecurityEvent` returned `row.details ?? null` verbatim,
 * so any field an emitter set ended up in the GET /v1/security/events
 * response. The route is OWNER/ADMIN-gated today so the immediate risk
 * is bounded, but the projection is exposed to a workspace admin role
 * that may later be widened. Whitelisting now prevents a future "let me
 * just dump full request headers / cookies / IPs into the details blob"
 * regression from quietly leaking to that surface.
 *
 * **Allowed (operator-meaningful) keys** — kept verbatim:
 *   * Lifecycle: action, source, category, reasonCode, riskLevel,
 *     count, severity, status, outcome
 *   * Geo (coarse): ipCountry, ipRegion (NOT ipAddress / full IP)
 *   * Device (coarse): userAgentFamily, deviceType, platform
 *   * Identity (already partially exposed via top-level columns):
 *     evidenceId, apiCredentialId, webhookEndpointId, organizationId,
 *     workflowId, caseId, projectId, sessionTag, providerName
 *   * Failure context: failureReason, failureCode, statusCode, attempts
 *   * Time context: occurredAtUtc, durationMs
 *
 * **Bounded redacted** — present but truncated/transformed so operators
 * still see *something* useful:
 *   * sessionId       → first 8 chars + "…" (correlation without leak)
 *   * targetId        → first 8 chars + "…"
 *   * emailAddress    → "<redacted>" (presence flag only)
 *
 * **Forbidden** — silently dropped:
 *   * Anything not on the allow-list, including: token, secret, apiKey,
 *     apiSecret, password, cookie, authorizationHeader, headers,
 *     stackTrace, rawPayload, providerResponse, ipAddress (full IP),
 *     deviceFingerprint, biometricSignal, mfaCode, recoveryCode,
 *     resetToken, sessionToken, refreshToken, accessToken.
 *
 * The output ALWAYS carries a `redacted: true` flag when any source key
 * was dropped, so operators can see at a glance whether the row had
 * additional context that wasn't surfaced.
 *
 * Exported so the snapshot writer + future projection callers can reuse
 * the same allow-list without re-implementing it.
 */
const SECURITY_EVENT_DETAIL_ALLOWLIST = new Set<string>([
  // Lifecycle / classification
  "action",
  "source",
  "category",
  "reasonCode",
  "riskLevel",
  "count",
  "severity",
  "status",
  "outcome",
  // Geo (coarse only)
  "ipCountry",
  "ipRegion",
  // Device (coarse only)
  "userAgentFamily",
  "deviceType",
  "platform",
  // Identity relations (already partly exposed via top-level columns)
  "evidenceId",
  "apiCredentialId",
  "webhookEndpointId",
  "organizationId",
  "workflowId",
  "caseId",
  "projectId",
  "sessionTag",
  "providerName",
  "targetType",
  // Failure context
  "failureReason",
  "failureCode",
  "statusCode",
  "attempts",
  // Time context
  "occurredAtUtc",
  "durationMs",
]);

const SECURITY_EVENT_DETAIL_REDACTED_KEYS = new Set<string>([
  "sessionId",
  "targetId",
]);

function truncatePrefix(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0) return null;
  return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
}

export function projectSecurityEventDetails(
  details: unknown,
): { redacted: boolean } & Record<string, unknown> {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return { redacted: false };
  }
  const src = details as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let droppedAny = false;
  for (const [key, value] of Object.entries(src)) {
    if (SECURITY_EVENT_DETAIL_ALLOWLIST.has(key)) {
      out[key] = value;
      continue;
    }
    if (SECURITY_EVENT_DETAIL_REDACTED_KEYS.has(key)) {
      const truncated = truncatePrefix(value);
      if (truncated !== null) out[key] = truncated;
      continue;
    }
    // Anything else is silently dropped. The `redacted: true` flag
    // surfaces the presence of dropped fields.
    droppedAny = true;
  }
  return { ...out, redacted: droppedAny };
}

export function projectSecurityEvent(row: DbSecurityEvent): {
  id: string;
  teamId: string | null;
  eventType: string;
  severity: string;
  evidenceId: string | null;
  apiCredentialId: string | null;
  webhookEndpointId: string | null;
  details: ReturnType<typeof projectSecurityEventDetails>;
  createdAt: string;
} {
  // Phase 32.7.2 — extract the legacy relation IDs from the
  // consolidated `details` blob. `emitSecurityEvent` folds them in
  // at write time (production schema has no dedicated columns for
  // these relations). The projection round-trips the same caller-
  // facing shape so downstream consumers don't observe a breaking
  // change.
  //
  // Phase 5 hardening — `details` is now allow-list-projected via
  // `projectSecurityEventDetails` so emitters can't leak secrets /
  // tokens / raw headers into the response.
  const detailsObj =
    row.details && typeof row.details === "object" && !Array.isArray(row.details)
      ? (row.details as Record<string, unknown>)
      : null;
  const readString = (key: string): string | null => {
    if (!detailsObj) return null;
    const v = detailsObj[key];
    return typeof v === "string" ? v : null;
  };
  return {
    id: row.id,
    teamId: row.teamId,
    eventType: row.eventType,
    severity: row.severity,
    evidenceId: readString("evidenceId"),
    apiCredentialId: readString("apiCredentialId"),
    webhookEndpointId: readString("webhookEndpointId"),
    details: projectSecurityEventDetails(row.details),
    createdAt: row.createdAt.toISOString(),
  };
}
