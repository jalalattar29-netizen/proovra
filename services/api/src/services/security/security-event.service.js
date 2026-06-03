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
import { SECURITY_EVENT_SEVERITIES, SECURITY_EVENT_TYPES, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
const DETAILS_MAX_BYTES = 4 * 1024;
const STRING_MAX = 1000;
function clip(value) {
    if (typeof value === "string") {
        return value.length > STRING_MAX ? `${value.slice(0, STRING_MAX)}…` : value;
    }
    if (Array.isArray(value))
        return value.slice(0, 50).map(clip);
    if (value && typeof value === "object") {
        const out = {};
        let i = 0;
        for (const [k, v] of Object.entries(value)) {
            if (i >= 50)
                break;
            out[String(k).slice(0, 64)] = clip(v);
            i += 1;
        }
        return out;
    }
    return value;
}
function safeDetails(input) {
    if (input === null || input === undefined)
        return null;
    const clipped = clip(input);
    try {
        const s = JSON.stringify(clipped);
        if (s.length > DETAILS_MAX_BYTES) {
            return JSON.parse(JSON.stringify({ truncated: true, preview: s.slice(0, 1500) }));
        }
        return clipped;
    }
    catch {
        return { truncated: true };
    }
}
const VALID_TYPES = new Set(SECURITY_EVENT_TYPES);
const VALID_SEVERITIES = new Set(SECURITY_EVENT_SEVERITIES);
/**
 * Fire-and-forget. Caller MUST NOT await for side effects of failures.
 * Returns the row on success, or `null` if anything went wrong.
 */
export async function emitSecurityEvent(input, client = defaultPrisma) {
    if (!VALID_TYPES.has(input.eventType)) {
        // Phase 20 — make ad-hoc / typo'd event types visible. A dropped
        // event is still dropped, but at least the operator sees the count.
        // Lazy require avoids a circular dep with the ops module.
        void (async () => {
            try {
                const m = await import("../ops/metrics.service.js");
                m.bump("security_event_emit_dropped_unknown_type");
            }
            catch {
                /* metrics module unavailable in test context */
            }
        })();
        return null;
    }
    if (!VALID_SEVERITIES.has(input.severity))
        return null;
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
        const baseAsObject = baseDetails && typeof baseDetails === "object" && !Array.isArray(baseDetails)
            ? baseDetails
            : null;
        const relationContext = {};
        if (input.evidenceId)
            relationContext.evidenceId = input.evidenceId;
        if (input.apiCredentialId)
            relationContext.apiCredentialId = input.apiCredentialId;
        if (input.webhookEndpointId)
            relationContext.webhookEndpointId = input.webhookEndpointId;
        const consolidatedDetails = Object.keys(relationContext).length > 0
            ? (baseAsObject !== null
                ? { ...baseAsObject, ...relationContext }
                : relationContext)
            : baseDetails ?? undefined;
        return await client.securityEvent.create({
            data: {
                teamId: input.teamId ?? null,
                eventType: input.eventType,
                severity: input.severity,
                details: consolidatedDetails ?? undefined,
            },
        });
    }
    catch {
        return null;
    }
}
export function safeEmitSecurityEvent(input, client = defaultPrisma) {
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
    emitSecurityEvent(input, client).then((row) => {
        if (row === null) {
            void (async () => {
                try {
                    const m = await import("../ops/metrics.service.js");
                    m.bump("security_event_emit_failed");
                }
                catch {
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
    }, () => {
        void (async () => {
            try {
                const m = await import("../ops/metrics.service.js");
                m.bump("security_event_emit_failed");
            }
            catch {
                /* metrics module unavailable in test context */
            }
        })();
    });
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
async function maybeAutoCreateIncident(input, securityEventId, client) {
    // Lazy import to avoid a circular dep with the observability tree
    // (which itself imports `safeEmitSecurityEvent` indirectly).
    let incident;
    try {
        incident = await import("../observability/incident.service.js");
    }
    catch {
        return;
    }
    const { category, runbookSlug } = mapEventTypeToIncident(input.eventType);
    const fingerprint = `${category.toLowerCase()}:security_event:${input.eventType}`;
    const title = `Security signal: ${input.eventType}`;
    const safeSummary = buildSafeSummaryFromDetails(input);
    try {
        await incident.recordIncident({
            teamId: input.teamId ?? null,
            category,
            severity: input.severity === "HIGH" ? "HIGH" : "WARNING",
            fingerprint,
            title,
            safeSummary,
            runbookSlug,
            relatedJobId: securityEventId,
            metadata: { eventType: input.eventType },
        }, client);
    }
    catch {
        /* best-effort — never break the SecurityEvent path */
    }
}
function mapEventTypeToIncident(eventType) {
    if (eventType.startsWith("communication_webhook_invalid_signature")) {
        return { category: "WEBHOOK", runbookSlug: "webhook-invalid-signature-burst" };
    }
    if (eventType.startsWith("communication_")) {
        return { category: "COMMUNICATIONS", runbookSlug: "twilio-outage" };
    }
    if (eventType.startsWith("verification_")) {
        return { category: "COMMUNICATIONS", runbookSlug: "twilio-outage" };
    }
    if (eventType.startsWith("step_up_") ||
        eventType.startsWith("trusted_device_") ||
        eventType.startsWith("session_revoked") ||
        eventType.startsWith("suspicious_login") ||
        eventType.startsWith("high_risk_action") ||
        eventType.startsWith("service_account_risk") ||
        eventType.startsWith("contributor_risk") ||
        eventType.startsWith("impossible_travel")) {
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
function buildSafeSummaryFromDetails(input) {
    const parts = [`Severity ${input.severity}`];
    if (input.teamId)
        parts.push(`team ${input.teamId.slice(0, 8)}…`);
    // The details payload was already clipped/sanitised by safeDetails
    // (4 KiB cap, 1 KB string cap per field, no secrets). We only echo
    // the top-level keys to give operators a glance, never the values.
    if (input.details && typeof input.details === "object") {
        const keys = Object.keys(input.details).slice(0, 6).join(", ");
        if (keys.length > 0)
            parts.push(`fields: ${keys}`);
    }
    return parts.join(" · ");
}
export async function listSecurityEvents(input, client = defaultPrisma) {
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
export async function countSecurityEventsByTeam(input, client = defaultPrisma) {
    const days = Math.max(1, Math.min(input.sinceDays ?? 30, 365));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const rows = await client.securityEvent.groupBy({
        by: ["severity"],
        where: { teamId: input.teamId, createdAt: { gte: since } },
        _count: { _all: true },
    });
    const counts = {
        total: 0,
        high: 0,
        warning: 0,
        info: 0,
    };
    for (const r of rows) {
        const n = r._count._all;
        counts.total += n;
        if (r.severity === "HIGH")
            counts.high = n;
        else if (r.severity === "WARNING")
            counts.warning = n;
        else if (r.severity === "INFO")
            counts.info = n;
    }
    return counts;
}
export function projectSecurityEvent(row) {
    // Phase 32.7.2 — extract the legacy relation IDs from the
    // consolidated `details` blob. `emitSecurityEvent` folds them in
    // at write time (production schema has no dedicated columns for
    // these relations). The projection round-trips the same caller-
    // facing shape so downstream consumers don't observe a breaking
    // change.
    const detailsObj = row.details && typeof row.details === "object" && !Array.isArray(row.details)
        ? row.details
        : null;
    const readString = (key) => {
        if (!detailsObj)
            return null;
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
        details: row.details ?? null,
        createdAt: row.createdAt.toISOString(),
    };
}
