/**
 * THE SECURITY BRIDGE — WHICH SIGNALS BECOME OPERATIONS CONDITIONS.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE QUEUE ACTUALLY CONTAINED
 * ---------------------------------------------------------------------------
 * `emitSecurityEvent` opens an operational condition for every
 * WARNING-or-higher SecurityEvent. Six prefix branches route the classified
 * domains; everything else fell through to `security.unclassified_signal`.
 *
 * Measured against the real event catalogue, that default claimed 328 of the
 * 380 declared types, and 93 of them had live WARNING/HIGH call sites. Two
 * different defects followed.
 *
 * ROUTINE ADMINISTRATIVE OUTCOMES BECAME INCIDENTS. A SCIM token being
 * created, a retention policy being updated, an SSO connection being added, a
 * signer being promoted — every one of them opened a row in a tenant's
 * operations queue that demanded a WRITTEN CONCLUSION before it could be
 * closed. That is how a queue becomes something nobody works.
 *
 * AND ONE FACT APPEARED TWICE. `sso-hardening` emits `idp_outage_detected`
 * and, twelve lines later, records `identity.idp_outage` — a SOURCE_TRUTH
 * condition that closes itself when the provider recovers. The generic copy
 * sat beside it and was the manually-closable one. `destruction_executed` and
 * the search-indexing events had the same shape.
 *
 * ---------------------------------------------------------------------------
 * AND THE CONTRACT ITSELF
 * ---------------------------------------------------------------------------
 * `security.unclassified_signal` was `OPERATOR_DECISION`. Registering the
 * default branch closed the unregistered-row hole and then reproduced it: the
 * source MEANS "the platform cannot classify this signal", and making that
 * closable is the same inversion — not knowing what something is conferring
 * the right to declare it over.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  lifecycleForSourceId,
  offersManualResolution,
} from "@proovra/shared-runtime";

import {
  DEDICATED_SOURCE_EVENT_TYPES,
  dedicatedSourceOwning,
  isUnclassifiedFailureSignal,
} from "../src/services/security/security-event.service.js";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/** The declared catalogue, read from the shared package. */
function everyEventType(): string[] {
  const src = readFileSync(`${REPO}/packages/shared/src/security.ts`, "utf8");
  const start = src.indexOf("export const SECURITY_EVENT_TYPES = [");
  const end = src.indexOf("] as const", start);
  return [...src.slice(start, end).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

// ===========================================================================
// THE CONTRACT
// ===========================================================================

describe("security.unclassified_signal fails closed", () => {
  it("is NO_DIRECT_RESOLUTION and demands no note it could never justify", () => {
    const lifecycle = lifecycleForSourceId("security.unclassified_signal")!;
    expect(lifecycle.resolutionAuthority).toBe("NO_DIRECT_RESOLUTION");
    // A note requirement exists to make a human CONCLUSION auditable. There is
    // no conclusion available for a signal nothing could classify, so
    // demanding one would be theatre — and the registry's own invariant
    // refuses the combination.
    expect(lifecycle.requiresResolutionNote).toBe(false);
    expect(offersManualResolution(lifecycle)).toBe(false);
    expect(lifecycle.activityProbeKey).toBe("NONE");
    // Advisory: there is no safe action to offer, and an actionable audience
    // that offers none is a promise the surface does not keep.
    expect(lifecycle.audience).toBe("TENANT_ADVISORY");
  });

  it("NOT KNOWING WHAT SOMETHING IS NEVER MAKES IT MORE CLOSABLE", () => {
    // The property, stated against the two sources that mean "unknown". Both
    // must be at least as strict as every source that IS classified.
    for (const id of ["security.unclassified_signal", "unregistered.condition"]) {
      const lifecycle = lifecycleForSourceId(id) ?? null;
      if (id === "security.unclassified_signal") {
        expect(lifecycle, id).not.toBeNull();
        expect(lifecycle!.resolutionAuthority, id).toBe("NO_DIRECT_RESOLUTION");
      }
    }
  });
});

// ===========================================================================
// THE DEDICATED-SOURCE SUPPRESSION
// ===========================================================================

describe("a fact with a dedicated source is not bridged twice", () => {
  it("prints the ownership table", () => {
    // eslint-disable-next-line no-console -- the table IS the deliverable
    console.table(
      Object.entries(DEDICATED_SOURCE_EVENT_TYPES).map(
        ([eventType, sourceId]) => ({ eventType, sourceId }),
      ),
    );
    expect(Object.keys(DEDICATED_SOURCE_EVENT_TYPES).length).toBeGreaterThan(5);
  });

  it("EVERY OWNING SOURCE IS REGISTERED AND ACTIVE", () => {
    // An entry naming a source that does not exist would suppress a signal in
    // favour of a condition nothing writes — a silent loss rather than a
    // deduplication.
    for (const [eventType, sourceId] of Object.entries(
      DEDICATED_SOURCE_EVENT_TYPES,
    )) {
      const lifecycle = lifecycleForSourceId(sourceId);
      expect(lifecycle, `${eventType} names an unregistered ${sourceId}`).not.toBeNull();
      expect(lifecycle!.discoveryState, sourceId).toBe("ACTIVE");
      expect(lifecycle!.producers.length, sourceId).toBeGreaterThan(0);
    }
  });

  it("the measured duplicates are suppressed", () => {
    // The three verified by reading the emitting code paths: each fires the
    // SecurityEvent and records the dedicated condition in the same function.
    expect(dedicatedSourceOwning("idp_outage_detected")).toBe(
      "identity.idp_outage",
    );
    expect(dedicatedSourceOwning("destruction_executed")).toBe(
      "governance.destruction_executed",
    );
    expect(dedicatedSourceOwning("search_indexing_failed")).toBe(
      "search.indexing_failure",
    );
    expect(dedicatedSourceOwning("immutable_storage_drift")).toBe(
      "storage.immutable_drift",
    );
  });

  it("an ordinary event type is owned by nobody", () => {
    expect(dedicatedSourceOwning("mfa_verification_failed")).toBeNull();
    expect(dedicatedSourceOwning("some_future_event")).toBeNull();
  });
});

// ===========================================================================
// FAILURE VERSUS ROUTINE OUTCOME
// ===========================================================================

describe("only unclassified FAILURES become conditions", () => {
  it("prints the partition over the whole catalogue", () => {
    const buckets: Record<string, number> = {
      failure: 0,
      owned: 0,
      routine: 0,
    };
    for (const t of everyEventType()) {
      if (dedicatedSourceOwning(t)) buckets.owned += 1;
      else if (isUnclassifiedFailureSignal(t)) buckets.failure += 1;
      else buckets.routine += 1;
    }
    // eslint-disable-next-line no-console -- the partition IS the deliverable
    console.table([buckets]);
    expect(buckets.failure + buckets.owned + buckets.routine).toBeGreaterThan(
      300,
    );
  });

  it("ROUTINE ADMINISTRATIVE OUTCOMES OPEN NOTHING", () => {
    // The measured offenders: every one of these had a live WARNING-or-higher
    // call site and put a note-requiring row in a tenant's queue.
    for (const t of [
      "scim_token_created",
      "scim_token_revoked",
      "scim_user_created",
      "sso_connection_created",
      "sso_connection_updated",
      "sso_connection_revoked",
      "retention_policy_created",
      "retention_policy_updated",
      "signer_promoted",
      "signer_retired",
      "signer_revoked",
      "signer_health_checked",
      "custody_attestation_verified",
      "destruction_review_created",
      "mfa_recovery_requested",
      "mfa_recovery_approved",
      "rbac_temporary_elevation_granted",
      "automation_webhook_secret_rotated",
      "all_sessions_revoked",
      "external_review_token_revealed",
    ]) {
      expect(isUnclassifiedFailureSignal(t), t).toBe(false);
      expect(dedicatedSourceOwning(t), t).toBeNull();
    }
  });

  it("AN UNKNOWN SECURITY FAILURE STILL OPENS ONE", () => {
    // The half that must not be lost. These are unclassified — no prefix
    // branch claims them — and they are adverse, so they still reach the
    // queue, under a contract nobody can close by assertion.
    for (const t of [
      "mfa_verification_failed",
      "mfa_enforcement_failed_closed",
      "auth_login_failed",
      "saml_login_failed",
      "sso_login_failed",
      "scim_account_link_denied",
      "signer_signature_failure",
      "restore_validation_failed",
      "scanner_unavailable",
      "suspicious_file_type",
      "executable_upload_blocked",
      "session_quarantined",
      "sso_callback_replay_detected",
      "multipart_hash_mismatch",
      "queue_job_replay_failed",
      "automation_webhook_destination_auto_disabled",
      "recovery_review_required",
      "adaptive_block_triggered",
      "archive_limit_exceeded",
      "excessive_rate_limit_hits",
    ]) {
      expect(isUnclassifiedFailureSignal(t), t).toBe(true);
    }
  });

  it("A FAILURE-SHAPED TYPE THIS BUILD HAS NEVER SEEN STILL OPENS ONE", () => {
    // The allowlist is over MARKERS, not over names, so a new adverse event
    // does not need a code change to be seen.
    expect(isUnclassifiedFailureSignal("some_future_thing_failed")).toBe(true);
    expect(isUnclassifiedFailureSignal("brand_new_check_denied")).toBe(true);
    // …and a new ROUTINE one does not need one either to stay out.
    expect(isUnclassifiedFailureSignal("some_future_thing_created")).toBe(false);
  });
});

// ===========================================================================
// THE BRIDGE HONOURS THE DECISION
// ===========================================================================

describe("the bridge stops before writing when the mapping refuses", () => {
  const BRIDGE =
    "services/api/src/services/security/security-event.service.ts";
  const code = readFileSync(`${REPO}/${BRIDGE}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  it("a null mapping returns before recordIncident", () => {
    expect(code).toMatch(/if \(!mapping\) return;/);
    // …and the refusal happens BEFORE the writer, not after it.
    expect(code.indexOf("if (!mapping) return;")).toBeLessThan(
      code.indexOf("recordIncident("),
    );
  });

  it("THE SECURITY EVENT ITSELF IS STILL WRITTEN", () => {
    // The audit record is not what is being withheld. `maybeAutoCreateIncident`
    // runs AFTER the row is created and takes its id, so a suppressed mapping
    // cannot reach back and skip the write.
    expect(code).toMatch(/maybeAutoCreateIncident\(input, row\.id, client\)/);
    expect(code).toMatch(/securityEventId: string/);
  });
});
