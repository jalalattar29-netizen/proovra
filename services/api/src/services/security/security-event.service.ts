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
 * WARNING-or-higher SecurityEvent fires — ONLY when the event's type has an
 * explicit classification that names a registered source.
 *
 * OPS-13 Phase 3 — THERE IS NO DEFAULT ROW ANY MORE.
 *
 * The bridge used to send every event type no mapping claimed to
 * `security.unclassified_signal`, a tenant condition nobody could ever close.
 * Measured: an outsider's DENIED workspace switch opened one inside the
 * TARGET workspace, and that owner's Resolve answered 409. An unrecognised
 * event is now persisted (the SecurityEvent row is written before this runs),
 * counted (`security_event_unclassified_total`) and logged by bounded event
 * type — and never written into a workspace.
 */
async function maybeAutoCreateIncident(
  input: EmitSecurityEventInput,
  securityEventId: string,
  client: PrismaClient,
): Promise<void> {
  const disposition = classifySecurityEvent(input.eventType);
  if (disposition.kind === "UNCLASSIFIED") {
    reportUnclassifiedSecurityEvent(input.eventType, input.severity);
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
  // A TENANT CONDITION NEEDS A TENANT.
  //
  // Account-tier events (`step_up_denied` from the account step-up prompt, a
  // retired auth endpoint's `high_risk_action_blocked`) carry no workspace. A
  // NULL team without the explicit platform declaration is written
  // LEGACY_UNSCOPED — a row no workspace can see and no operator is asked to
  // own. It is counted instead; the SecurityEvent row keeps the fact.
  if (!input.teamId) {
    void bumpSecurityMetric("security_event_condition_without_workspace_total");
    return;
  }
  // Lazy import to avoid a circular dep with the observability tree
  // (which itself imports `safeEmitSecurityEvent` indirectly).
  let incident: typeof import("../observability/incident.service.js");
  try {
    incident = await import("../observability/incident.service.js");
  } catch {
    return;
  }
  const { category, runbookSlug, sourceId } = mapping;
  const fingerprint = `${category.toLowerCase()}:security_event:${input.eventType}`;
  const title = `Security signal: ${input.eventType}`;
  const safeSummary = buildSafeSummaryFromDetails(input);
  try {
    await incident.recordIncident(
      {
        // ONE bridge, several domains. The branch that already picks the
        // category picks the source too, so the two cannot come apart — a
        // mapping that returned a category without a source is what left these
        // conditions unregistered.
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

async function bumpSecurityMetric(
  name:
    | "security_event_unclassified_total"
    | "security_event_condition_without_workspace_total",
): Promise<void> {
  try {
    const m = await import("../ops/metrics.service.js");
    m.bump(name);
  } catch {
    /* metrics module unavailable in test context */
  }
}

/**
 * THE PLATFORM SIGNAL FOR AN UNRECOGNISED EVENT.
 *
 * Bounded on purpose: the event TYPE (clipped, and already a catalogue member
 * — `emitSecurityEvent` refuses anything else) and the severity. Never the
 * workspace, never the details: an unclassified event is precisely the one
 * nobody has reviewed for what its payload may carry.
 */
function reportUnclassifiedSecurityEvent(eventType: string, severity: string): void {
  void bumpSecurityMetric("security_event_unclassified_total");
  void (async () => {
    try {
      const { warn } = await import("../../utils/logger.js");
      warn("security.unclassified_event_type", {
        eventType: String(eventType).slice(0, 80),
        severity: String(severity).slice(0, 16),
      });
    } catch {
      /* a diagnostic must never break the path it describes */
    }
  })();
}

/** The four answers the bridge can give, by exact identity. */
export type SecurityEventDisposition =
  | { readonly kind: "DEDICATED"; readonly sourceId: string }
  | { readonly kind: "ROUTINE"; readonly reason: string }
  | { readonly kind: "CLASSIFIED"; readonly classification: SecurityClassification }
  | { readonly kind: "UNCLASSIFIED" };

/**
 * WHAT THE BRIDGE DOES WITH ONE EVENT TYPE.
 *
 *   1. an exact identity a DEDICATED source already records  -> no duplicate;
 *   2. an exact identity on the reviewed ROUTINE allowlist   -> no incident;
 *   3. an exact identity with a real classification contract -> that source;
 *   4. EVERYTHING ELSE -> UNCLASSIFIED: counted and logged, never a tenant row.
 *
 * No substring, prefix or suffix appears anywhere in this decision.
 */
export function classifySecurityEvent(eventType: string): SecurityEventDisposition {
  const dedicated = dedicatedSourceOwning(eventType);
  if (dedicated !== null) return { kind: "DEDICATED", sourceId: dedicated };
  const reason = routineSecurityEventReason(eventType);
  if (reason !== null) return { kind: "ROUTINE", reason };
  const classified = Object.prototype.hasOwnProperty.call(
    CLASSIFIED_SECURITY_EVENTS,
    eventType,
  )
    ? CLASSIFIED_SECURITY_EVENTS[eventType]
    : undefined;
  if (classified) return { kind: "CLASSIFIED", classification: classified };
  return { kind: "UNCLASSIFIED" };
}

/**
 * WHICH OPERATIONS SOURCE — IF ANY — THIS SECURITY EVENT BELONGS TO.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACED, AND WHY IT HAD TO GO
 * ---------------------------------------------------------------------------
 * The first version decided by PREFIX (seventeen `startsWith` branches) and
 * by SUBSTRING (`_failed`, `_denied`, …) — a guess about names, wrong in both
 * directions. The second version decided over exact identities and sent every
 * unknown identity to a fail-closed `security.unclassified_signal` row. That
 * row could never close, and it was written into whatever workspace the event
 * named — including a workspace an outsider had merely ASKED to switch into.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION NOW
 * ---------------------------------------------------------------------------
 * The `SecurityEvent` row is written FIRST and unconditionally. This answers
 * only the OPERATIONS question, from `classifySecurityEvent`: a mapping for a
 * CLASSIFIED identity, and null for everything else — dedicated, routine, and
 * unclassified alike. The unclassified case is not silent: the bridge counts
 * and logs it (`maybeAutoCreateIncident`), so an unreviewed event type is
 * visible to the platform without becoming a tenant's unclosable condition.
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
  const disposition = classifySecurityEvent(eventType);
  if (disposition.kind !== "CLASSIFIED") return null;
  return { ...disposition.classification };
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
 *
 * `immutable_storage_drift` / `immutable_storage_reconciliation_failure` were
 * here, owned by `storage.immutable_drift`. That source is DISABLED (OPS-13)
 * and neither event type has an emitter in the API, so naming a dedicated
 * owner for them would claim coverage nothing provides.
 */
export const DEDICATED_SOURCE_EVENT_TYPES: Readonly<Record<string, string>> =
  Object.freeze({
    // `sso-hardening.service.ts` emits the event and records the incident in
    // the same branch, a dozen lines apart.
    idp_outage_detected: "identity.idp_outage",
    idp_outage_cleared: "identity.idp_outage",
    // `destruction-review.service.ts` — same function, event then incident.
    destruction_executed: "governance.destruction_executed",
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
    // `escalation-engine.service.ts` — the same function records
    // `review.escalation` for HIGH/CRITICAL escalations; a WARNING escalation
    // lives in the reviewer escalation queue, which is its owner.
    reviewer_escalation_created: "review.escalation",
    // `adaptive-auth.service.ts` emits it inside `decideAdaptiveAuth`, whose
    // only caller — `runtimeAdaptiveGate` — records `identity.runtime_block`
    // for the same BLOCK decision.
    adaptive_block_triggered: "identity.runtime_block",
    // `automation-delivery-runtime.service.ts` — the same branch that stamps
    // `autoDisabledAt` records the per-destination condition.
    automation_webhook_destination_auto_disabled:
      "integration.webhook_destination_disabled",
  });

function ownEntry<T>(map: Readonly<Record<string, T>>, key: string): T | null {
  return Object.prototype.hasOwnProperty.call(map, key) ? (map[key] ?? null) : null;
}

export function dedicatedSourceOwning(eventType: string): string | null {
  return ownEntry(DEDICATED_SOURCE_EVENT_TYPES, eventType);
}

/**
 * REVIEWED EVENTS THAT ARE NOT AN OPERATIONS CONDITION.
 *
 * Exact identities only — no prefix, no regex, no substring. Every entry
 * carries the reason it is not an operational condition, because an allowlist
 * without reasons is a list nobody can review.
 *
 * The bar for an entry: a person read what the event means and concluded that
 * its occurrence is the product working correctly (a success, a policy
 * refusal, a rate limit), an administrator doing something deliberate, an
 * outcome reported INLINE to the person who caused it, or a fact another
 * surface already owns (Security Center, upload recovery, the automation
 * delivery log, a platform metric). "Its name looks harmless" is not the bar.
 *
 * OPS-13 Phase 3 added every WARNING-or-higher producer that used to fall into
 * the unclosable `security.unclassified_signal` default. Each was read at its
 * call site; the reason says what owns it instead.
 */
export const ROUTINE_SECURITY_EVENTS: Readonly<Record<string, string>> =
  Object.freeze({
    // ---- Authorization ------------------------------------------------------
    // OPS-014 — a 403 is the permission model WORKING: a viewer opened a
    // control their role does not hold, a member followed a link to a surface
    // outside their plan. It was classified as an "Identity security
    // condition", so every expected refusal opened a customer-visible
    // incident nobody could act on. It stays in the security audit log;
    // genuinely suspicious denial PATTERNS have their own detectors
    // (high_risk_action_blocked, runtime blocks, session-risk surges).
    permission_denied:
      "An expected authorization refusal. The audit log records it; an incident would describe the permission model working.",
    // OPS-13 — the membership and organisation-policy gates refusing a switch.
    // A refusal is bound to the ACTOR's own context (never the workspace that
    // was asked for), and stays in the security log.
    workspace_context_switched:
      "A workspace switch, allowed or refused. A refusal is the membership and policy gates working; it is a security-log entry for the actor, never a condition in the workspace that was asked for.",
    privileged_session_blocked:
      "A quarantined session was refused a privileged action — the quarantine enforcing. The quarantine itself (session_quarantined) is the condition.",

    // ---- Sign-in attempts ---------------------------------------------------
    // One row per ATTEMPT. Security Center keeps every one; the patterns that
    // matter have their own detectors (failed-auth bursts via risk signals,
    // `identity.idp_outage` for a provider that keeps failing).
    auth_login_failed:
      "One failed sign-in attempt, with no workspace. Security Center and the failed-auth burst detector own it; it is not a workspace condition.",
    mfa_verification_failed:
      "One wrong second-factor code. The failed-OTP burst detector owns the pattern; a single attempt is not a workspace condition.",
    mfa_challenge_replayed:
      "A spent MFA challenge was presented again and refused — the one-use rule working. Security Center keeps it.",
    mfa_recovery_throttled:
      "The MFA recovery rate limit refused a request — the limit working.",
    sso_login_failed:
      "One failed SSO sign-in. Security Center keeps it; a provider that keeps failing opens identity.idp_outage through its own threshold.",
    sso_jit_denied:
      "Just-in-time provisioning refused a user by policy — the policy working, reported to that user at sign-in.",
    sso_callback_replay_detected:
      "A replayed SSO callback was refused — replay protection working. Security Center keeps the attempt.",
    saml_login_failed:
      "One failed SAML sign-in. Security Center keeps it; a provider that keeps failing opens identity.idp_outage through its own threshold.",
    saml_assertion_rejected:
      "One SAML assertion failed validation and was refused. Security Center keeps it; an IdP-side fault that persists opens identity.idp_outage.",
    saml_attribute_mapping_failed:
      "One SAML sign-in whose attributes did not map. Reported to the user at sign-in and kept in Security Center.",
    saml_jit_denied:
      "Just-in-time provisioning refused a SAML user by policy — the policy working.",
    saml_jit_policy_denied:
      "The SAML JIT policy refused a user — the policy working.",
    saml_mapping_quarantined:
      "One SAML sign-in was held by the mapping quarantine rule — the rule working; Security Center keeps it.",

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
    mfa_recovery_digest_test_failed:
      "An admin's test send of the recovery digest failed; the result is shown to that admin inline.",

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
    scim_drift_scan_completed:
      "An admin ran a directory drift scan; the drift it found is the preview that admin is looking at, and applying it is their next deliberate step.",
    scim_reconciliation_executed:
      "An admin applied a reviewed directory reconciliation deliberately.",
    sso_connection_created: "An admin configured SSO deliberately.",
    sso_connection_updated: "An admin changed SSO configuration deliberately.",
    sso_connection_revoked: "An admin removed SSO configuration deliberately.",
    sso_health_checked:
      "An admin read SSO health. A DEGRADED answer is shown to that admin; a provider that is actually failing sign-ins opens identity.idp_outage.",
    saml_connection_test_failed:
      "An admin's SAML connection test failed; the result is shown to that admin inline.",
    saml_mapping_updated: "An admin changed attribute mapping deliberately.",
    saml_mapping_previewed:
      "An admin previewed a privilege-affecting mapping; the warning is shown to that admin in the preview.",
    saml_mapping_privilege_warning:
      "An admin saved a privilege-affecting mapping after being warned; deliberate, and the audit log is the record.",

    // ---- Governance and retention administration -------------------------
    retention_policy_created: "An admin authored a policy deliberately.",
    retention_policy_updated: "An admin changed a policy deliberately.",
    retention_policy_superseded: "An admin superseded a policy deliberately.",
    retention_policy_archived: "An admin archived a policy deliberately.",
    retention_policy_paused: "An admin paused a policy deliberately.",
    destruction_review_created:
      "A destruction review was opened; its own governance surface tracks it.",
    destruction_review_approved:
      "A reviewer decided a destruction review deliberately; the governance surface is the record.",
    destruction_review_denied:
      "A reviewer decided a destruction review deliberately; the governance surface is the record.",
    destruction_review_deferred:
      "A reviewer deferred a destruction review deliberately; the governance surface tracks it.",
    destruction_review_restored:
      "A reviewer restored a record from destruction review deliberately.",
    custody_attestation_verified:
      "An attestation verified successfully. The success case.",
    external_review_token_revealed:
      "An authorised reveal, recorded for audit. Not a fault.",
    workflow_intake_recipient_contact_revealed:
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
    export_reproducibility_verified:
      "An operator-run reproducibility check; its match or mismatch is the result shown to that operator.",

    // ---- Governance policy enforcement -------------------------------------
    // Legal hold, immutability and lifecycle rules REFUSING an action is the
    // policy working as designed; the refusal is returned to whoever asked.
    export_blocked_by_lifecycle:
      "An export (or the read-only export-eligibility preflight) was refused by the record's lifecycle — the policy working; the refusal is returned inline.",
    destruction_blocked_by_hold:
      "A legal hold refused destruction — exactly what a hold is for.",
    destruction_blocked_by_immutable:
      "Immutability refused destruction — exactly what immutability is for.",
    lifecycle_transition_blocked:
      "The lifecycle state machine refused a transition it does not allow; the refusal is returned inline.",

    // ---- Reviewer operations administration ------------------------------
    reviewer_governance_flags_updated:
      "An admin changed reviewer governance settings deliberately.",
    reviewer_sla_policy_updated:
      "An admin changed the SLA promise deliberately.",
    reviewer_bulk_triage_executed:
      "A reviewer ran a bulk triage; per-item failures are reported to that reviewer inline.",

    // ---- Signer administration -------------------------------------------
    signer_health_checked:
      "A scheduled health read. Its VERDICT has its own source; the check itself is not news.",
    signer_promoted: "A deliberate rotation step.",
    signer_retired: "A deliberate rotation step.",
    signer_revoked: "A deliberate rotation step.",
    signer_health_degraded:
      "A platform signer health verdict, read by a platform operator and counted by signer_health_degraded_total; the signer console owns it, not a workspace queue.",
    signer_signature_failure:
      "A platform signing failure, counted by signer_signature_failure_total and owned by the signer console; it is not a condition a workspace can act on.",

    // ---- Platform operator actions ---------------------------------------
    queue_job_replay_failed:
      "A platform operator's queue replay failed; the result is shown to that operator inline in the queue console.",
    queue_job_replay_forbidden:
      "A queue replay was refused by its guard; the refusal is returned to the operator inline.",
    media_intelligence_dlq_replayed:
      "A platform operator replayed dead-lettered media jobs deliberately.",
    backup_validation_completed:
      "An operator-run backup validation; its outcome is the report that operator reads.",
    restore_validation_failed:
      "An operator-run restore validation failed; its outcome is the report that operator reads.",

    // ---- Platform faults owned by a metric, not a workspace ---------------
    search_audit_log_write_failed:
      "A platform write to the search audit log failed; counted by search_audit_log_write_failed_total. Nothing a workspace can act on.",
    search_audit_log_read_failed:
      "A platform read of the search audit log failed; counted by search_audit_log_read_failed_total and returned as an empty page.",
    mfa_enforcement_degraded:
      "The MFA enforcement read failed and an explicit fail-open mode applied; a platform resilience fact with no workspace.",
    mfa_enforcement_failed_closed:
      "The MFA enforcement read failed and the sign-in was refused (fail-closed); a platform resilience fact with no workspace.",
    scanner_unavailable:
      "The file scanner could not run on one upload; the upload's own scan status records it.",
    ai_chat_abuse_signal:
      "The AI cost guard refused a request — the guard working.",

    // ---- Automation and integrations --------------------------------------
    automation_webhook_secret_rotated:
      "A deliberate secret rotation.",
    automation_run_failed:
      "One automation run failed; the automation run log owns it.",
    automation_run_dead_lettered_unknown:
      "One automation run ended with an unknown outcome; the automation run log records it as such.",
    automation_webhook_delivery_failed:
      "One delivery attempt failed; the delivery log owns retries. A destination that keeps failing is auto-disabled, which IS a condition (integration.webhook_destination_disabled).",
    automation_webhook_delivery_retry_exhausted:
      "One delivery exhausted its retries; the delivery log owns it, and repeated failure auto-disables the destination (integration.webhook_destination_disabled).",
    automation_webhook_delivery_dead_lettered_unknown:
      "One delivery ended with an unknown outcome; the delivery log records it as unknown.",
    automation_webhook_delivery_ambiguous:
      "One delivery's outcome could not be determined; the delivery log records the ambiguity and its resolution.",

    // ---- External review --------------------------------------------------
    external_review_grant_issue_failed:
      "Issuing an external-review grant failed; the error is returned inline to the person issuing it.",
    external_review_grant_lookup_failed:
      "An external-review grant lookup failed; the error is returned inline.",
    external_review_grant_transition_failed:
      "An external-review grant transition failed; the error is returned inline.",

    // ---- Intake and delivery lifecycle ------------------------------------
    upload_resumed: "A paused upload continued. The success case.",
    upload_session_completed: "An upload finished. The success case.",
    upload_session_aborted:
      "A caller abandoned an upload deliberately; the reconciler owns anything left behind.",
    upload_abandoned:
      "The same fact observed by the sweep; the reconciler owns the cleanup.",
    // Multipart and finalize refusals are returned to the uploader inline,
    // and anything left behind is the upload reconciler's to recover.
    multipart_initiate_failed:
      "Starting a multipart upload failed; the error is returned to the uploader inline.",
    multipart_complete_failed:
      "Completing a multipart upload failed; the uploader is told inline and upload recovery owns the session.",
    multipart_head_failed:
      "The post-upload size check could not read the object; the uploader is told inline and upload recovery owns the session.",
    multipart_hash_mismatch:
      "The uploaded bytes did not match their declared hash and finalize refused them — integrity checking working; the uploader is told inline.",
    multipart_abort_failed:
      "Aborting a multipart upload failed; the upload reconciler owns the leftover parts.",
    upload_part_hash_mismatch:
      "One part's hash did not match and the part was refused — integrity checking working; the uploader re-sends it.",
    finalize_blocked_by_upload_session:
      "Finalize was refused because the upload session is not complete — the gate working; returned inline.",
    finalize_blocked_by_checklist:
      "Finalize was refused by the capture checklist — the policy working; returned inline.",
    finalize_duplicate_detected:
      "Finalize detected a duplicate and refused it — deduplication working; returned inline.",
    // The session is now REVIEW_REQUIRED, which the admin reliability /
    // evidence-ops recovery queue lists and resolves (mark abandoned, retry,
    // request review). That queue is the owner; `intake.delivery_failed` names
    // an event class with no recovery path and would be the weaker contract.
    recovery_review_required:
      "An upload session moved to REVIEW_REQUIRED; the reliability recovery queue lists it and its operator actions resolve it.",
    // File validation refusing a dangerous or malformed file is the defence
    // working, and the uploader is told why.
    executable_upload_blocked:
      "An executable upload was refused — file validation working; returned inline.",
    double_extension_detected:
      "A double-extension file was refused — file validation working; returned inline.",
    mime_mismatch:
      "A file whose content did not match its declared type was refused — file validation working; returned inline.",
    archive_limit_exceeded:
      "An archive over the configured limits was refused — file validation working; returned inline.",
    compression_ratio_exceeded:
      "An archive with an unsafe compression ratio was refused — file validation working; returned inline.",
    suspicious_archive:
      "A suspicious archive was refused — file validation working; returned inline.",
    suspicious_file_type:
      "A file of a refused type was blocked by the scanner — the defence working; the upload's scan status records it.",

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
  return ownEntry(ROUTINE_SECURITY_EVENTS, eventType);
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
 * against how its name begins. `verification_package_attestations_missing` /
 * `_degraded` are deliberately ABSENT: they concern an evidence verification
 * package, and the prefix era filed them as Twilio failures.
 *
 * The four governance identities that used to name `governance.policy_condition`
 * are ABSENT too (OPS-13): none of them has an emitter anywhere in the product
 * and that source is NOT_YET_DISCOVERED, so classifying them would report
 * coverage nothing provides.
 *
 * Every source named here is TENANT-facing, so the bridge writes it only for an
 * event that carries a workspace (see `maybeAutoCreateIncident`).
 */
const IDENTITY_SECURITY: SecurityClassification = Object.freeze({
  sourceId: "identity.security_condition",
  category: "IDENTITY_SECURITY",
  runbookSlug: "suspicious-login-burst",
});

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
  // (upload_part_hash_mismatch is ROUTINE — OPS-13: the part is refused and
  // re-sent; the integrity check working is not an operations condition.)
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
  // (permission_denied is ROUTINE — OPS-014; see ROUTINE_SECURITY_EVENTS.)
  // `step_up_denied` is a WRONG PROOF inside a workspace's step-up flow. The
  // account step-up prompt's routine "no proof yet" answer is INFO, and an
  // account-tier denial carries no workspace and writes no condition.
  step_up_denied: IDENTITY_SECURITY,
  suspicious_login_detected: IDENTITY_SECURITY,
  high_risk_action_blocked: IDENTITY_SECURITY,
  high_risk_action_step_up_required: IDENTITY_SECURITY,
  service_account_risk_detected: IDENTITY_SECURITY,
  contributor_risk_detected: IDENTITY_SECURITY,
  impossible_travel_signal: IDENTITY_SECURITY,
  trusted_device_auto_invalidated: IDENTITY_SECURITY,
  // OPS-13 — risk detectors that used to fall into the unclassified default.
  // Each is a workspace's own risk finding that Security Center adjudicates;
  // the condition closes on the workspace's recorded conclusion.
  geo_anomaly_detected: IDENTITY_SECURITY,
  suspicious_session_detected: IDENTITY_SECURITY,
  session_quarantined: IDENTITY_SECURITY,
  // A SAML signing certificate is expiring or expired: sign-ins will stop. The
  // workspace's admin rotates it and records that they did.
  saml_certificate_expiring: IDENTITY_SECURITY,
  // The directory asked to provision or link an identity the platform refused
  // to bind (an unsafe account link, a managed identity owned by another
  // organisation). Nobody signs in until an admin fixes the directory.
  scim_account_link_denied: IDENTITY_SECURITY,
  scim_user_provisioning_conflict: IDENTITY_SECURITY,
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
// WHO ACTED — read from what the event recorded, never from who is reading.
// -----------------------------------------------------------------------------

/**
 * PV-AUD-001 — THE ONE AUTHORITY FOR A SECURITY EVENT'S ACTOR.
 *
 * The identity timeline used to project `actorUserId: q.subjectUserId ?? null`
 * — the READER'S FILTER, not the event. Unfiltered, every row read "System";
 * filtered by a user, every row claimed that user had acted, whoever really
 * did. On an audit surface that is the one answer that must never be derived
 * from the question.
 *
 * Emitters record the acting user in `details.actorUserId` (the convention
 * every identity writer already follows; `SecurityEvent.userId` is the event's
 * SUBJECT, e.g. the admin a digest was addressed to). This function reads only
 * that recorded data, in this order:
 *
 *   1. an explicit `details.actorType` the writer stated — including
 *      SUPPORT_CONTEXT when it acted under a support or break-glass grant;
 *   2. a recorded `details.actorUserId` — a person;
 *   3. an event type whose ONLY writers are machine processes, verified by
 *      reading them — the writer is fixed by code, so the actor is known even
 *      for rows written before they stated it;
 *   4. otherwise NOT_RECORDED. Never "System" by default: saying System for an
 *      event that simply did not record its actor is a guess dressed as a fact.
 */
export type SecurityEventActorType =
  | "HUMAN"
  | "SERVICE"
  | "WORKER"
  | "SYSTEM"
  | "SUPPORT_CONTEXT";

export type SecurityEventActor = {
  /** Null only when the event recorded no actor at all. */
  type: SecurityEventActorType | null;
  /** The acting user, when a person (or a support operator) acted. */
  userId: string | null;
  /** The grant a support operator acted under, when there was one. */
  supportGrantId: string | null;
  /** Where the answer came from — so a reader can tell recorded from derived. */
  source: "RECORDED" | "EVENT_AUTHORITY" | "NOT_RECORDED";
};

const ACTOR_TYPES = new Set<SecurityEventActorType>([
  "HUMAN",
  "SERVICE",
  "WORKER",
  "SYSTEM",
  "SUPPORT_CONTEXT",
]);

const ACTOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Event types written ONLY by a machine process. Each entry was verified by
 * reading its writer; a type written anywhere on a request path does not
 * belong here, however system-like its name.
 */
export const MACHINE_AUTHORED_SECURITY_EVENTS: Readonly<
  Record<string, "WORKER" | "SYSTEM">
> = Object.freeze({
  // services/worker/src/integrity-rejection.service.ts — the report worker's
  // hash re-check, inside its own transaction.
  evidence_integrity_rejected: "WORKER",
  // services/worker/src/mfa-challenge-gc.ts — the scheduled challenge sweep.
  mfa_challenge_gc_completed: "WORKER",
  // services/worker/src/mfa-recovery-digest.ts — the scheduled digest sender.
  mfa_recovery_digest_failed: "WORKER",
});

function detailString(details: Record<string, unknown> | null, key: string): string | null {
  if (!details) return null;
  const v = details[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function resolveSecurityEventActor(row: {
  eventType: string;
  details: unknown;
}): SecurityEventActor {
  const details =
    row.details && typeof row.details === "object" && !Array.isArray(row.details)
      ? (row.details as Record<string, unknown>)
      : null;
  const recordedUser = detailString(details, "actorUserId");
  const userId = recordedUser && ACTOR_UUID.test(recordedUser) ? recordedUser : null;
  const supportGrantId =
    detailString(details, "supportGrantId") ?? detailString(details, "breakGlassGrantId");
  const statedType = detailString(details, "actorType") as SecurityEventActorType | null;

  if (statedType && ACTOR_TYPES.has(statedType)) {
    return { type: statedType, userId, supportGrantId, source: "RECORDED" };
  }
  // A grant id with no stated type still says who was acting and how: a
  // support operator inside the customer's workspace, not the customer.
  if (supportGrantId && userId) {
    return { type: "SUPPORT_CONTEXT", userId, supportGrantId, source: "RECORDED" };
  }
  if (userId) {
    return { type: "HUMAN", userId, supportGrantId: null, source: "RECORDED" };
  }
  const machine = MACHINE_AUTHORED_SECURITY_EVENTS[row.eventType];
  if (machine) {
    return { type: machine, userId: null, supportGrantId: null, source: "EVENT_AUTHORITY" };
  }
  return { type: null, userId: null, supportGrantId: null, source: "NOT_RECORDED" };
}

/**
 * The `details` fields an emitter writes to record who acted. Emitters spread
 * this into their details so the writer, not a later reader, states the actor.
 */
export function recordedActorDetails(actor: {
  userId: string;
  supportGrantId?: string | null;
}): { actorUserId: string; actorType: SecurityEventActorType; supportGrantId?: string } {
  return actor.supportGrantId
    ? { actorUserId: actor.userId, actorType: "SUPPORT_CONTEXT", supportGrantId: actor.supportGrantId }
    : { actorUserId: actor.userId, actorType: "HUMAN" };
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
  actor: SecurityEventActor;
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
    actor: resolveSecurityEventActor(row),
  };
}
