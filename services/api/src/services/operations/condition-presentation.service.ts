/**
 * HOW A CONDITION PRESENTS ITSELF — one server-side authority.
 *
 * Every Operations surface reads a condition through this module: the message
 * it was written from (or, for a row written before message codes existed, the
 * message its identity proves), the English sentence the shared catalogue
 * renders for it, WHAT it is about (an authorized, tenant-bound subject), and
 * the technical references support needs. No client infers any of this from a
 * signal code, and no raw code is ever a title, a summary or a subject.
 */
import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import {
  type ConditionSubject,
  type ConditionSubjectKind,
  type ConditionTechnicalReferenceKey,
  identityProviderDisplayName,
  isConditionMessageCode,
  paymentProviderDisplayName,
  renderConditionMessage,
  sanitizeConditionText,
  securitySignalSubjectKind,
  validateConditionParams,
} from "@proovra/shared";
import { OPERATIONS_SOURCE_LIFECYCLES, resolveConditionSource, workspaceEvidenceWhere } from "@proovra/shared-runtime";

export type ConditionMessageRef = { code: string; params: Record<string, string | number> };

type RowLike = Pick<
  prismaPkg.OperationalIncident,
  "sourceId" | "fingerprint" | "messageCode" | "messageParams" | "relatedEvidenceId" | "relatedJobId" | "requestId" | "traceId" | "category"
>;

/** `<category>:security_event:<eventType>` — the bridge's identity for one event class. */
const SECURITY_EVENT_FINGERPRINT = /^[a-z_]+:security_event:([a-z0-9_]{1,64})$/;

function paramsObject(v: unknown): Record<string, string | number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string | number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" || typeof val === "number") out[k] = val;
  }
  return out;
}

/**
 * The message a row presents: its stored code and params when valid, else the
 * message its identity PROVES. Only one identity proves a message today — the
 * security-event bridge's per-event-class fingerprint — so a legacy bridge row
 * written before codes existed reads as its reviewed sentence instead of
 * "Security signal: <code>". Anything else stays null (stored text is shown).
 */
/**
 * THE OLD PER-WORKSPACE UPLOAD-SESSION BRIDGE ROW — one identity, owned by the
 * retired `capture.legacy_upload_session_signal` source (its EXACT legacy
 * fingerprint, in the lifecycle table) and read through the canonical source
 * resolution by presentation, remediation and the truth reconciliation alike.
 *
 * `upload_stalled` is a DEDICATED event now (per-upload `capture.upload_stalled`),
 * and the write boundary refuses this identity, so nothing writes it again: a
 * row carrying it is history from the old bridge, which filed it under
 * `intake.delivery_failed`, named no upload and confirmed no stall.
 */
export const LEGACY_UPLOAD_SESSION_SOURCE_ID = "capture.legacy_upload_session_signal";
export const LEGACY_UPLOAD_SESSION_FINGERPRINTS: readonly string[] = Object.freeze(
  (OPERATIONS_SOURCE_LIFECYCLES.find((l) => l.sourceId === LEGACY_UPLOAD_SESSION_SOURCE_ID)?.legacyFingerprints ?? [])
    .filter((p): p is { kind: "EXACT"; fingerprint: string } => p.kind === "EXACT")
    .map((p) => p.fingerprint),
);
export function isLegacyUploadSessionRow(row: { sourceId?: string | null; fingerprint: string; category?: string }): boolean {
  return (
    resolveConditionSource({ sourceId: row.sourceId ?? null, category: row.category, fingerprint: row.fingerprint }).lifecycle.sourceId ===
    LEGACY_UPLOAD_SESSION_SOURCE_ID
  );
}

export function conditionMessageFor(row: RowLike): ConditionMessageRef | null {
  // History is described as history — never as the security signal or the
  // source the old bridge filed it under.
  if (isLegacyUploadSessionRow(row)) return { code: "ops.legacy.upload_session_signal", params: {} };
  const stored = paramsObject(row.messageParams);
  if (row.messageCode && isConditionMessageCode(row.messageCode)) {
    const valid = validateConditionParams(row.messageCode, stored ?? {});
    if (valid) return { code: row.messageCode, params: valid };
  }
  const m = SECURITY_EVENT_FINGERPRINT.exec(row.fingerprint);
  if (m) return { code: "ops.security.signal", params: { eventType: m[1]!, severity: "WARNING" } };
  return null;
}

/** The English sentence for a message (the catalogue's current text), or null. */
export function conditionTextFor(message: ConditionMessageRef | null): { title: string; summary: string } | null {
  if (!message) return null;
  return renderConditionMessage("en", message.code, message.params);
}

const RECORD_KINDS: ReadonlySet<ConditionSubjectKind> = new Set([
  "EVIDENCE",
  "UPLOAD",
  "REPORT",
  "VERIFICATION_PACKAGE",
  "REVIEW_WORKFLOW",
  "GOVERNANCE_NOTIFICATION",
]);

const BRIDGED_SOURCES = new Set([
  "intake.delivery_failed",
  "communications.provider_failure",
  "webhook.security_failure",
  "identity.security_condition",
  "security.unclassified_signal",
]);

function subject(
  kind: ConditionSubjectKind,
  over: Partial<Omit<ConditionSubject, "kind">> = {},
): ConditionSubject {
  return { kind, name: null, reference: null, version: null, state: "AVAILABLE", ...over };
}

function shortRef(v: unknown): string | null {
  return typeof v === "string" && /^[0-9a-f-]{8,}$/i.test(v) ? v.slice(0, 8) : null;
}

/**
 * WHAT the condition is about, from its declared source and its message — no
 * database read. `resolveConditionSubjectAvailability` then confirms a
 * record-backed subject still exists for this workspace (and names it).
 */
export function conditionSubjectFor(row: RowLike, sourceId: string, message: ConditionMessageRef | null): ConditionSubject {
  const p = message?.params ?? {};
  const recordTitle = typeof p.recordTitle === "string" ? sanitizeConditionText(p.recordTitle) || null : null;
  const recordRef = (typeof p.recordRef === "string" ? p.recordRef : null) ?? shortRef(row.relatedEvidenceId);
  const version = typeof p.version === "number" ? p.version : null;
  switch (sourceId) {
    case "evidence_integrity.tsa_failed":
    case "evidence_integrity.ots_failed":
    case "evidence_integrity.ots_pending_aged":
    case "evidence_integrity.ots_initialization_stalled":
    case "evidence_integrity.ots_budget_exhausted":
      return subject("EVIDENCE", { name: recordTitle, reference: recordRef });
    case LEGACY_UPLOAD_SESSION_SOURCE_ID:
      return subject("UPLOADS");
    case "capture.upload_stalled":
      return subject("UPLOAD", { name: recordTitle, reference: recordRef });
    case "pipeline.report_generation_failed":
      return subject("REPORT", { reference: recordRef, version });
    case "pipeline.package_generation_failed":
    case "pipeline.package_generation_denied":
      return subject("VERIFICATION_PACKAGE", { reference: recordRef, version });
    case "storage.immutable_drift":
      return subject("EVIDENCE", { reference: typeof p.evidenceRef === "string" ? p.evidenceRef : recordRef });
    case "governance.retention_unverified":
    case "governance.archive_restore_failed":
      // The record is kept (archived or retained) and named by reference.
      return subject("EVIDENCE", { reference: recordRef });
    case "governance.destruction_executed":
      // The record was destroyed: truthfully gone, and never linked.
      return subject("EVIDENCE", { reference: recordRef, state: "UNAVAILABLE" });
    case "governance.notification_escalated":
      return subject("GOVERNANCE_NOTIFICATION", { reference: recordRef });
    case "review.escalation":
      return subject("REVIEW_WORKFLOW", { reference: recordRef });
    case "pipeline.report_backlog":
      return subject("REPORT_QUEUE");
    case "pipeline.package_backlog":
      return subject("PACKAGE_QUEUE");
    case "review.stale_workflows":
    case "review.escalation_storm":
      return subject("REVIEW_QUEUE");
    case "coordination.backlog_stale":
      return subject("COORDINATION_QUEUE");
    case "search.indexing_failure":
      return subject("SEARCH_INDEX");
    case "platform.worker_heartbeat_stale":
      return subject("WORKER_FLEET");
    case "job.background_failure":
      return subject("JOB_QUEUE", { name: typeof p.queue === "string" ? sanitizeConditionText(p.queue) || null : null });
    case "billing.dependent_cancellation_failed":
      return subject("STORAGE_ADDON");
    case "billing.provider_authorization":
      return subject("PAYMENT_PROVIDER", {
        name: typeof p.provider === "string" ? paymentProviderDisplayName("en", p.provider) : null,
      });
    case "integration.webhook_destination_disabled":
      return subject("WEBHOOK_DESTINATION", { reference: shortRef(row.fingerprint.split(":").pop() ?? null) });
    case "identity.idp_outage":
      return subject("IDENTITY_PROVIDER", {
        name: typeof p.provider === "string" ? identityProviderDisplayName("en", p.provider) : null,
      });
    case "identity.runtime_block":
    case "identity.high_risk_session_surge":
      return subject("SIGN_IN_SECURITY");
    case "platform.operational_seed":
      return subject("DEMONSTRATION");
    default:
      if (BRIDGED_SOURCES.has(sourceId) && typeof p.eventType === "string") {
        return subject(securitySignalSubjectKind(p.eventType));
      }
      return subject("WORKSPACE", { state: "NOT_APPLICABLE" });
  }
}

/** Sources whose condition IS one internal signal: named among the references. */
const SOURCE_SIGNAL_CODE: Readonly<Record<string, string>> = {
  "capture.upload_stalled": "upload_stalled",
  // Platform diagnostics only: the signal the old bridge filed this row from.
  [LEGACY_UPLOAD_SESSION_SOURCE_ID]: "upload_stalled",
};

/** Params that are user content or already part of the sentence — never repeated as references. */
const NOT_A_REFERENCE = new Set(["recordTitle", "note", "queue", "fields", "teamRef", "recordRef", "payer", "minutes", "count", "failures", "high", "critical", "hours", "days", "riskScore", "version", "warningHours", "highHours", "failureClass", "stuck", "cause", "evidenceRef", "certificateRef", "severity"]);
const PARAM_REFERENCE_KEY: Readonly<Record<string, ConditionTechnicalReferenceKey>> = {
  eventType: "signalCode",
  errorClass: "errorClass",
  outcome: "outcome",
  reason: "reason",
  action: "action",
  provider: "provider",
  operation: "operation",
  scenario: "scenario",
  seedRunId: "seedRunId",
  reviewId: "reviewId",
  detail: "detail",
};

/**
 * The technical references for support: the signal code, the bounded codes in
 * the message, and the ids. The ONLY place any of these reaches a reader.
 */
export function conditionTechnicalReferencesFor(
  row: RowLike & { id?: string },
  sourceId: string,
  message: ConditionMessageRef | null,
): Array<{ key: ConditionTechnicalReferenceKey; value: string }> {
  const out: Array<{ key: ConditionTechnicalReferenceKey; value: string }> = [];
  const push = (key: ConditionTechnicalReferenceKey, value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") return;
    const v = String(value).slice(0, 200);
    if (v && !out.some((r) => r.key === key && r.value === v)) out.push({ key, value: v });
  };
  const own = SOURCE_SIGNAL_CODE[sourceId];
  if (own) push("signalCode", own);
  for (const [k, v] of Object.entries(message?.params ?? {})) {
    if (NOT_A_REFERENCE.has(k)) continue;
    const key = PARAM_REFERENCE_KEY[k];
    if (key) push(key, v);
  }
  if (message && message.code !== "ops.security.signal") push("messageCode", message.code);
  push("sourceId", sourceId);
  push("evidenceId", row.relatedEvidenceId);
  push("jobId", row.relatedJobId);
  push("requestId", row.requestId);
  push("traceId", row.traceId);
  return out;
}

/**
 * Confirm record-backed subjects still exist FOR THIS WORKSPACE, and name them.
 *
 * Tenant-bound by the canonical evidence scope (a Personal record lives in its
 * owner's Personal workspace with team_id NULL): an id from another workspace
 * reads as unavailable, never as its title. A deleted or missing record makes
 * the subject UNAVAILABLE — truthful text, and no record link.
 */
export async function resolveConditionSubjectAvailability(
  items: ReadonlyArray<{ teamId: string | null; relatedEvidenceId: string | null; subject: ConditionSubject }>,
  client: PrismaClient,
): Promise<void> {
  const byTeam = new Map<string, Set<string>>();
  for (const it of items) {
    if (!it.teamId || !it.relatedEvidenceId || !RECORD_KINDS.has(it.subject.kind)) continue;
    if (it.subject.state === "UNAVAILABLE") continue;
    if (!/^[0-9a-f-]{36}$/i.test(it.relatedEvidenceId)) continue;
    const set = byTeam.get(it.teamId) ?? new Set<string>();
    set.add(it.relatedEvidenceId);
    byTeam.set(it.teamId, set);
  }
  const found = new Map<string, { title: string | null }>();
  for (const [teamId, ids] of byTeam) {
    try {
      const scope = await workspaceEvidenceWhere(teamId, client as never);
      const rows = await client.evidence.findMany({
        where: { AND: [{ id: { in: [...ids] } }, scope as never, { deletedAt: null }] },
        select: { id: true, title: true },
      });
      for (const r of rows) found.set(`${teamId}:${r.id}`, { title: r.title });
    } catch {
      // Unreadable: leave the subjects as derived (AVAILABLE by default) rather
      // than claiming a record is gone.
      for (const id of ids) found.set(`${teamId}:${id}`, { title: null });
    }
  }
  for (const it of items) {
    if (!it.teamId || !it.relatedEvidenceId || !RECORD_KINDS.has(it.subject.kind)) continue;
    if (it.subject.state === "UNAVAILABLE") continue;
    const hit = found.get(`${it.teamId}:${it.relatedEvidenceId}`);
    if (!hit) {
      it.subject.state = "UNAVAILABLE";
      it.subject.name = null;
      continue;
    }
    if (!it.subject.name && hit.title) it.subject.name = sanitizeConditionText(hit.title).slice(0, 80) || null;
  }
}

/**
 * A timeline entry's text. History is immutable and shown as written — except
 * the security bridge's old machine summary ("Severity WARNING · team … ·
 * fields: …"), which named internal field names and a truncated workspace id.
 * Those entries keep their event (what happened, when) and drop the text.
 */
export function presentTimelineMessage(message: string | null): string | null {
  if (!message) return null;
  if (/^Severity (INFO|WARNING|HIGH|CRITICAL)(\s·\s|$)/.test(message)) return null;
  return message;
}

// ---------------------------------------------------------------------------
// WHO IS READING — the platform audience never sees tenant content
// ---------------------------------------------------------------------------

/**
 * The reader of a projected condition. WORKSPACE: a member of the condition's
 * own workspace (the canonical member authority already admitted them).
 * PLATFORM: a platform administrator reading across tenants through the admin
 * routes — who, by the platform's own rule, is never shown evidence CONTENT
 * (titles, notes); identifiers and operational facts only.
 */
export type ConditionAudience = "WORKSPACE" | "PLATFORM";

/** Message params that are a tenant's own words, never shown to the platform. */
export const USER_CONTENT_PARAMS: ReadonlySet<string> = new Set(["recordTitle", "note"]);

/** The message a platform reader may see: the same code, without tenant words. */
export function messageForAudience(
  message: ConditionMessageRef | null,
  audience: ConditionAudience,
): ConditionMessageRef | null {
  if (!message || audience === "WORKSPACE" || !message.params) return message;
  const params = Object.fromEntries(Object.entries(message.params).filter(([k]) => !USER_CONTENT_PARAMS.has(k)));
  return { code: message.code, params };
}

/** What a platform reader is told when only stored (possibly tenant-worded) text exists. */
export const PLATFORM_WITHHELD_SUMMARY =
  "The details of this condition are shown to its workspace. Its identifiers are listed under Technical references.";

/**
 * Timeline entries a platform reader may read verbatim: operator and system
 * actions, whose words are the platform's or an operator's conclusion. An
 * OBSERVATION entry carried the writer's stored summary — which could name a
 * record — and is withheld from the platform.
 */
const PLATFORM_READABLE_EVENTS: ReadonlySet<string> = new Set([
  "acknowledged",
  "resolved",
  "suppressed",
  "unsuppressed",
  "assigned",
  "unassigned",
  "reopened",
  "resolved_by_reconciliation",
  "resolved_by_domain_truth",
  "rescoped_by_reconciliation",
  "summary_sanitized_by_reconciliation",
  "remediation_queued",
  "requires_owner_review",
]);

/** The fixed sentences the transition writer stores when no person wrote anything. */
const OPERATOR_TEMPLATE_MESSAGE = /^Incident [a-z_]+ by operator\.$/;
const SUPPRESSION_REASON_PREFIX = "Notifications stopped by an operator: ";

/**
 * A history entry's text, for the reader (2026-10-14).
 *
 *   WORKSPACE — only what a PERSON wrote: a resolution's conclusion and a
 *   silencing reason, exactly as written. Everything the system wrote
 *   (observation summaries, reconciliation notes, template sentences) is
 *   omitted: it is English-only and can carry internal identifiers, and the
 *   event's localized label already says what happened.
 *
 *   PLATFORM — operator and system actions verbatim; observation entries,
 *   which carried a writer's stored summary, withheld.
 */
export function presentTimelineMessageForAudience(
  eventType: string,
  message: string | null,
  audience: ConditionAudience,
): string | null {
  const shown = presentTimelineMessage(message);
  if (audience === "PLATFORM") return PLATFORM_READABLE_EVENTS.has(eventType) ? shown : null;
  if (!shown) return null;
  if (eventType === "resolved") return OPERATOR_TEMPLATE_MESSAGE.test(shown) ? null : shown;
  if (eventType === "suppressed") {
    return shown.startsWith(SUPPRESSION_REASON_PREFIX) ? shown.slice(SUPPRESSION_REASON_PREFIX.length) || null : null;
  }
  return null;
}
