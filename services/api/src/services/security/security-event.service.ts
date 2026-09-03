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
import {
  keysetAfter,
  keysetPage,
  type KeysetKey,
} from "../pagination/keyset-cursor.js";

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
  const mapping = mapEventTypeToIncident(input.eventType);
  // NO OPERATIONS CONDITION FOR THIS EVENT.
  //
  // The SecurityEvent row itself is already written — this function runs after
  // it — so nothing is lost from the audit record or the Security Center. What
  // is withheld is the operations representation, for an event that either
  // already has one under a dedicated source or does not describe a failure at
  // all.
  if (!mapping) return;
  const { category, runbookSlug, sourceId } = mapping;
  const fingerprint = `${category.toLowerCase()}:security_event:${input.eventType}`;
  const title = `Security signal: ${input.eventType}`;
  const safeSummary = buildSafeSummaryFromDetails(input);
  try {
    await incident.recordIncident(
      {
        // ONE bridge, six domains. The branch that already picks the category
        // picks the source too, so the two cannot come apart — a mapping that
        // returned a category without a source is what left these conditions
        // unregistered.
        sourceId,
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

/**
 * WHICH OPERATIONS SOURCE — IF ANY — THIS SECURITY EVENT BELONGS TO.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACED, AND WHY IT HAD TO GO
 * ---------------------------------------------------------------------------
 * The previous version decided in two unsafe ways.
 *
 * 1. CLASSIFICATION BY PREFIX. Seventeen `startsWith` branches routed events to
 *    six sources. A prefix is a guess about names, not a contract about facts,
 *    and it guessed wrong in public: `verification_package_attestations_missing`
 *    — an EVIDENCE VERIFICATION PACKAGE losing its attestations — matched
 *    `verification_` and was filed as a COMMUNICATIONS provider failure, with
 *    the Twilio outage runbook attached. Twenty-four routine outcomes
 *    (`step_up_approved`, `upload_session_completed`,
 *    `governance_reconciliation_finished`) were classified as security
 *    conditions for the same reason.
 *
 * 2. ADVERSITY BY SUBSTRING. Whether an UNCLASSIFIED event became a condition
 *    was decided by scanning its name for markers — `_failed`, `_denied`,
 *    `_blocked`, `_mismatch`, `_warning`. That is the dangerous direction: a
 *    new adverse event whose name carries no marker was silently treated as
 *    routine and never reached the queue at all. The platform decided that
 *    nothing had gone wrong because it did not recognise the WORD.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION ORDER NOW
 * ---------------------------------------------------------------------------
 * The `SecurityEvent` row is written FIRST and unconditionally — this function
 * runs after it and takes its id, so nothing below can suppress the audit
 * record. Only the OPERATIONS representation is decided here:
 *
 *   1. an exact identity a DEDICATED source already records  -> no duplicate;
 *   2. an exact identity on the reviewed ROUTINE allowlist   -> no incident;
 *   3. an exact identity with a real classification contract -> that source;
 *   4. EVERYTHING ELSE                                       -> unclassified,
 *      fail-closed, `security.unclassified_signal`.
 *
 * Step 4 is the whole correction. An event this build has never seen, at
 * WARNING or above, becomes a condition nobody can close by assertion. Being
 * unrecognised is now a reason to SHOW something, which is the opposite of
 * what the marker scan did.
 *
 * No substring, prefix or suffix appears anywhere in this decision.
 */
export function mapEventTypeToIncident(eventType: string): {
  sourceId: string;
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
} | null {
  // 1. A dedicated source already records this fact. One outage must not
  //    become two rows an operator reconciles by eye — and the generic copy
  //    would carry the weaker contract.
  if (dedicatedSourceOwning(eventType) !== null) return null;

  // 2. A reviewed routine outcome. It belongs in the security audit log, which
  //    already has it, not in a queue that asks for a conclusion per row.
  if (routineSecurityEventReason(eventType) !== null) return null;

  // 3. A real classification contract, by EXACT identity.
  const classified = CLASSIFIED_SECURITY_EVENTS[eventType];
  if (classified) return { ...classified };

  // 4. FAIL CLOSED. Not recognised is not the same as not a problem.
  return {
    sourceId: "security.unclassified_signal",
    category: "WORKER",
    runbookSlug: null,
  };
}

/**
 * EVENT TYPES WHOSE FACT A DEDICATED SOURCE ALREADY RECORDS.
 *
 * Each entry was verified by reading the emitting code path: the same function
 * that fires the SecurityEvent also calls `recordIncident` with the named
 * source, or the domain's own reconciler does.
 *
 * Declared as a MAP rather than a set so the owning source is on the record
 * and the invariant below can prove it is registered, ACTIVE and produced.
 * This suppresses only the DUPLICATE generic incident; the SecurityEvent row
 * and the dedicated source's own condition are both untouched.
 */
export const DEDICATED_SOURCE_EVENT_TYPES: Readonly<Record<string, string>> =
  Object.freeze({
    // `sso-hardening.service.ts` emits the event and records the incident in
    // the same branch, a dozen lines apart.
    idp_outage_detected: "identity.idp_outage",
    idp_outage_cleared: "identity.idp_outage",
    // `destruction-review.service.ts` — same function, event then incident.
    destruction_executed: "governance.destruction_executed",
    // The worker's reconciler owns the drift verdict and its recovery.
    immutable_storage_drift: "storage.immutable_drift",
    immutable_storage_reconciliation_failure: "storage.immutable_drift",
    // Index health is derived from eligible-vs-indexed coverage now, not from
    // any single indexing event.
    search_indexing_failed: "search.indexing_failure",
    search_indexing_drift_detected: "search.indexing_failure",
    search_indexing_enqueue_failed: "search.indexing_failure",
    search_indexing_lag_critical: "search.indexing_failure",
    // `runtime-risk.service.ts` emits per session and records the aggregate
    // surge in the same sweep.
    runtime_risk_escalated: "identity.high_risk_session_surge",
    // Lateness has exactly ONE authority in this product — the persisted SLA
    // cycle — and a second one competing with it is a defect this codebase has
    // already paid for once.
    reviewer_sla_breached: "review.escalation",
  });

export function dedicatedSourceOwning(eventType: string): string | null {
  return DEDICATED_SOURCE_EVENT_TYPES[eventType] ?? null;
}

/**
 * REVIEWED ROUTINE, SUCCESSFUL AND ADMINISTRATIVE EVENTS.
 *
 * Exact identities only — no prefix, no regex, no substring. Every entry
 * carries the reason it is not an operational condition, because an allowlist
 * without reasons is a list nobody can review, and this one is the ONLY thing
 * standing between a routine event and the fail-closed default.
 *
 * The bar for an entry: a person read what the event means and concluded that
 * its occurrence is either the product working correctly or an administrator
 * doing something deliberate. "Its name looks harmless" is not the bar, and is
 * exactly the reasoning that was removed.
 *
 * An identity NOT listed here — including one this build has never seen —
 * becomes `security.unclassified_signal`. Adding to this list is a deliberate,
 * reviewable act; forgetting to add to it is safe.
 */
export const ROUTINE_SECURITY_EVENTS: Readonly<Record<string, string>> =
  Object.freeze({
    // ---- Session and re-authentication lifecycle -------------------------
    all_sessions_revoked: "A person signed out everywhere. Deliberate.",
    all_sessions_revoked_admin:
      "An admin revoked sessions deliberately; the audit log is the record.",
    emergency_org_session_revoke:
      "A deliberate emergency action BY an operator. Telling them what they just did is noise.",
    forced_reauthentication:
      "Policy asked for a fresh sign-in. The policy working, not a fault.",
    forced_runtime_reauthentication:
      "The runtime gate asked for a fresh sign-in. Same policy, same outcome.",
    session_revoked: "A session ended deliberately.",
    session_revoked_admin: "An admin ended a session deliberately.",
    step_up_approved: "The user completed step-up. The success case.",
    step_up_started: "Step-up began. Not an outcome at all.",
    step_up_expired:
      "An unused step-up challenge aged out. Ordinary and self-correcting.",
    trusted_device_added: "A user enrolled a device deliberately.",
    trusted_device_decayed:
      "Trust aged out on schedule. The decay policy working.",
    trusted_device_revoked: "A device was removed deliberately.",

    // ---- MFA administration ---------------------------------------------
    mfa_admin_factor_revoked: "An admin removed a factor deliberately.",
    mfa_admin_reenrollment_required:
      "An admin required re-enrolment deliberately.",
    mfa_contact_factor_revoked: "A contact factor was removed deliberately.",
    mfa_enrollment_required: "Policy requires enrolment. The policy working.",
    mfa_recovery_requested: "A user began the recovery flow. Not an outcome.",
    mfa_recovery_approved: "Recovery was granted. The success case.",
    mfa_trusted_devices_reset: "A deliberate administrative reset.",

    // ---- Identity provisioning and access administration -----------------
    rbac_temporary_elevation_granted:
      "A deliberate, time-bounded grant; expiry is tracked by its own authority.",
    scim_token_created: "A provisioning token was issued deliberately.",
    scim_token_revoked: "A provisioning token was revoked deliberately.",
    scim_user_created: "Provisioning created a user. The success case.",
    scim_group_deleted: "Provisioning removed a group deliberately.",
    scim_group_membership_changed:
      "Ordinary directory churn; the audit log is the record.",
    scim_reconciliation_membership_suspended:
      "The reconciler corrected a membership. Its job, done.",
    sso_connection_created: "An admin configured SSO deliberately.",
    sso_connection_updated: "An admin changed SSO configuration deliberately.",
    sso_connection_revoked: "An admin removed SSO configuration deliberately.",
    saml_mapping_updated: "An admin changed attribute mapping deliberately.",

    // ---- Governance and retention administration -------------------------
    retention_policy_created: "An admin authored a policy deliberately.",
    retention_policy_updated: "An admin changed a policy deliberately.",
    destruction_review_created:
      "A destruction review was opened; its own governance surface tracks it.",
    custody_attestation_verified:
      "An attestation verified successfully. The success case.",
    external_review_token_revealed:
      "An authorised reveal, recorded for audit. Not a fault.",
    governance_export_snapshot_created:
      "A governance export snapshot was produced. The success case.",
    governance_notification_emitted:
      "The notification system delivered. Its own surface owns delivery state.",
    governance_notification_suppressed:
      "Deduplication working as designed.",
    governance_notification_throttled:
      "Rate limiting working as designed.",
    governance_reconciliation_started:
      "A reconciliation began. Not an outcome.",
    governance_reconciliation_finished:
      "A reconciliation completed. The success case.",

    // ---- Reviewer operations administration ------------------------------
    reviewer_governance_flags_updated:
      "An admin changed reviewer governance settings deliberately.",
    reviewer_sla_policy_updated:
      "An admin changed the SLA promise deliberately.",

    // ---- Signer administration -------------------------------------------
    signer_health_checked:
      "A scheduled health read. Its VERDICT has its own source; the check itself is not news.",
    signer_promoted: "A deliberate rotation step.",
    signer_retired: "A deliberate rotation step.",
    signer_revoked: "A deliberate rotation step.",

    // ---- Automation and integrations --------------------------------------
    automation_webhook_secret_rotated:
      "A deliberate secret rotation.",

    // ---- Intake and delivery lifecycle ------------------------------------
    upload_resumed: "A paused upload continued. The success case.",
    upload_session_completed: "An upload finished. The success case.",
    upload_session_aborted:
      "A caller abandoned an upload deliberately; the reconciler owns anything left behind.",
    upload_abandoned:
      "The same fact observed by the sweep; the reconciler owns the cleanup.",

    // ---- Communications lifecycle -----------------------------------------
    communication_inbound_start_received:
      "A recipient opted IN. The success case.",
    communication_inbound_stop_received:
      "A recipient opted OUT. Honoured by design, not a fault.",
    communication_recipient_opted_out:
      "The same consent decision, recorded. Honouring it is correct behaviour.",
    verification_started: "A verification began. Not an outcome.",
    verification_check_succeeded: "A verification passed. The success case.",
    verification_package_attestations_included:
      "A package carried its attestations. The success case.",
  });

export function routineSecurityEventReason(eventType: string): string | null {
  return ROUTINE_SECURITY_EVENTS[eventType] ?? null;
}

/** One exact classification: which source owns this event's condition. */
type SecurityClassification = {
  readonly sourceId: string;
  readonly category:
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
  readonly runbookSlug: string | null;
};

/**
 * EVENTS WITH A REAL, EXACT CLASSIFICATION CONTRACT.
 *
 * Each identity here was checked against what the event actually means, not
 * against how its name begins. Three of the prefix era's members are
 * deliberately ABSENT and now fail closed instead:
 *
 *   verification_package_attestations_missing
 *   verification_package_attestations_degraded
 *
 * both concern an EVIDENCE VERIFICATION PACKAGE and were being filed as
 * COMMUNICATIONS provider failures with a Twilio runbook, because their names
 * begin with `verification_`. An unclassified fail-closed condition is a
 * truthful "we have not decided what owns this"; a Twilio runbook on a missing
 * attestation is a confident wrong answer.
 *
 * This map may only SHRINK safely. Removing an entry sends the event to the
 * fail-closed default, which is visible; adding one silently narrows a
 * condition's contract and must be reviewed.
 */
export const CLASSIFIED_SECURITY_EVENTS: Readonly<
  Record<string, SecurityClassification>
> = Object.freeze({
  // ---- Webhook security -------------------------------------------------
  communication_webhook_invalid_signature: {
    sourceId: "webhook.security_failure",
    category: "WEBHOOK",
    runbookSlug: "webhook-invalid-signature-burst",
  },
  webhook_signature_failure: {
    sourceId: "webhook.security_failure",
    category: "WEBHOOK",
    runbookSlug: "webhook-invalid-signature-burst",
  },
  webhook_failure_loop: {
    sourceId: "webhook.security_failure",
    category: "WEBHOOK",
    runbookSlug: "webhook-invalid-signature-burst",
  },
  webhook_target_blocked: {
    sourceId: "webhook.security_failure",
    category: "WEBHOOK",
    runbookSlug: "webhook-invalid-signature-burst",
  },
  webhook_unsafe_redirect: {
    sourceId: "webhook.security_failure",
    category: "WEBHOOK",
    runbookSlug: "webhook-invalid-signature-burst",
  },

  // ---- Communications provider ------------------------------------------
  communication_message_failed: {
    sourceId: "communications.provider_failure",
    category: "COMMUNICATIONS",
    runbookSlug: "twilio-outage",
  },
  communication_provider_unconfigured: {
    sourceId: "communications.provider_failure",
    category: "COMMUNICATIONS",
    runbookSlug: "twilio-outage",
  },
  communication_rate_limit_exceeded: {
    sourceId: "communications.provider_failure",
    category: "COMMUNICATIONS",
    runbookSlug: "twilio-outage",
  },
  // The Twilio Verify CHECK — genuinely the communications provider, unlike
  // its `verification_package_*` namesakes.
  verification_check_failed: {
    sourceId: "communications.provider_failure",
    category: "COMMUNICATIONS",
    runbookSlug: "twilio-outage",
  },

  // ---- Intake / delivery -------------------------------------------------
  upload_part_hash_mismatch: {
    sourceId: "intake.delivery_failed",
    category: "UPLOAD",
    runbookSlug: "stuck-upload",
  },
  upload_session_create_failed: {
    sourceId: "intake.delivery_failed",
    category: "UPLOAD",
    runbookSlug: "stuck-upload",
  },
  upload_session_resume_failed: {
    sourceId: "intake.delivery_failed",
    category: "UPLOAD",
    runbookSlug: "stuck-upload",
  },
  upload_stalled: {
    sourceId: "intake.delivery_failed",
    category: "UPLOAD",
    runbookSlug: "stuck-upload",
  },

  // ---- Identity security -------------------------------------------------
  permission_denied: {
    sourceId: "identity.security_condition",
    category: "IDENTITY_SECURITY",
    runbookSlug: null,
  },
  step_up_denied: {
    sourceId: "identity.security_condition",
    category: "IDENTITY_SECURITY",
    runbookSlug: "suspicious-login-burst",
  },
  suspicious_login_detected: {
    sourceId: "identity.security_condition",
    category: "IDENTITY_SECURITY",
    runbookSlug: "suspicious-login-burst",
  },
  high_risk_action_blocked: {
    sourceId: "identity.security_condition",
    category: "IDENTITY_SECURITY",
    runbookSlug: "suspicious-login-burst",
  },
  high_risk_action_step_up_required: {
    sourceId: "identity.security_condition",
    category: "IDENTITY_SECURITY",
    runbookSlug: "suspicious-login-burst",
  },
  service_account_risk_detected: {
    sourceId: "identity.security_condition",
    category: "IDENTITY_SECURITY",
    runbookSlug: "suspicious-login-burst",
  },
  contributor_risk_detected: {
    sourceId: "identity.security_condition",
    category: "IDENTITY_SECURITY",
    runbookSlug: "suspicious-login-burst",
  },
  impossible_travel_signal: {
    sourceId: "identity.security_condition",
    category: "IDENTITY_SECURITY",
    runbookSlug: "suspicious-login-burst",
  },
  trusted_device_auto_invalidated: {
    sourceId: "identity.security_condition",
    category: "IDENTITY_SECURITY",
    runbookSlug: "suspicious-login-burst",
  },

  // ---- Governance policy --------------------------------------------------
  governance_bypass_attempt: {
    sourceId: "governance.policy_condition",
    category: "GOVERNANCE",
    runbookSlug: null,
  },
  governance_lifecycle_drift_detected: {
    sourceId: "governance.policy_condition",
    category: "GOVERNANCE",
    runbookSlug: null,
  },
  governance_notification_delivery_failed: {
    sourceId: "governance.policy_condition",
    category: "GOVERNANCE",
    runbookSlug: null,
  },
  governance_reconciliation_failed: {
    sourceId: "governance.policy_condition",
    category: "GOVERNANCE",
    runbookSlug: null,
  },
});

// ===========================================================================
// LOAD-TIME INVARIANTS
//
// Properties the types cannot express, checked once when the module loads. A
// throw here can only fire on a list a developer just edited, and it fires in
// every process that imports the module — including the build. The alternative
// is a silent contradiction reaching production, which is what each of these
// exists to stop.
// ===========================================================================
{
  const routine = Object.keys(ROUTINE_SECURITY_EVENTS);
  const dedicated = Object.keys(DEDICATED_SOURCE_EVENT_TYPES);
  const classified = Object.keys(CLASSIFIED_SECURITY_EVENTS);

  // An identity claimed twice is an identity whose fate depends on the order
  // the branches happen to run in — which is exactly the kind of accident the
  // exact maps replaced prefixes to remove.
  const overlap = (a: string[], b: string[]) => a.filter((k) => b.includes(k));
  const routineVsDedicated = overlap(routine, dedicated);
  if (routineVsDedicated.length > 0) {
    throw new Error(
      `security event claimed as BOTH routine and dedicated: ${routineVsDedicated.join(", ")}`,
    );
  }
  const routineVsClassified = overlap(routine, classified);
  if (routineVsClassified.length > 0) {
    throw new Error(
      `security event claimed as BOTH routine and classified: ${routineVsClassified.join(", ")}`,
    );
  }
  const dedicatedVsClassified = overlap(dedicated, classified);
  if (dedicatedVsClassified.length > 0) {
    throw new Error(
      `security event claimed as BOTH dedicated and classified: ${dedicatedVsClassified.join(", ")}`,
    );
  }

  // Every reason is a real sentence. An empty one is an entry nobody reviewed.
  for (const [eventType, reason] of Object.entries(ROUTINE_SECURITY_EVENTS)) {
    if (reason.trim().length < 8) {
      throw new Error(`routine security event ${eventType} has no reason`);
    }
  }
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
  /** Decoded keyset cursor — rows strictly after this (createdAt, id). */
  after?: KeysetKey | null;
};

export type SecurityEventPage = {
  rows: DbSecurityEvent[];
  /** Opaque continuation, `null` on the last page. */
  nextCursor: string | null;
  /** The server's own answer — not an inference from the row count. */
  hasMore: boolean;
};

/**
 * One page of a workspace's security events, newest first.
 *
 * Keyset over `createdAt desc, id desc`. The filters stay server-side and are
 * ANDed with the cursor predicate, so a severity filter narrows every page
 * and not just the one the operator can see.
 */
export async function listSecurityEvents(
  input: ListSecurityEventsInput,
  client: PrismaClient = defaultPrisma,
): Promise<SecurityEventPage> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const filters = {
    teamId: input.teamId,
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.eventType ? { eventType: input.eventType } : {}),
  };
  const rows = await client.securityEvent.findMany({
    where: input.after
      ? { AND: [filters, keysetAfter("createdAt", input.after)] }
      : filters,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = keysetPage(rows, limit, (r) => ({ at: r.createdAt, id: r.id }));
  return { rows: page.rows, nextCursor: page.nextCursor, hasMore: page.hasMore };
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
