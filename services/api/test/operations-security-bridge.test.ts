/**
 * THE SECURITY BRIDGE — WHICH SIGNALS BECOME OPERATIONS CONDITIONS.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACED
 * ---------------------------------------------------------------------------
 * `emitSecurityEvent` opens an operational condition for every
 * WARNING-or-higher SecurityEvent. Deciding WHICH ones used to be done by
 * reading the event's NAME: seventeen `startsWith` branches picked the domain,
 * and a scan for thirty-two substrings — `_failed`, `_denied`, `_blocked`,
 * `_mismatch`, `_warning` and friends — decided whether an unrecognised event
 * was adverse at all.
 *
 * Both halves were unsafe, and in opposite directions.
 *
 * THE MARKER SCAN COULD MISS. An adverse event whose name happens not to
 * contain one of the thirty-two strings — `credential_exfiltration_suspected`,
 * `tamper_evidence_broken`, `quarantine_bypass` — was read as routine and
 * dropped from Operations entirely. Fail-OPEN, decided by spelling.
 *
 * THE PREFIX BRANCHES COULD BE CONFIDENTLY WRONG.
 * `verification_package_attestations_missing` matched `verification_` and was
 * therefore filed as a COMMUNICATIONS provider failure carrying a Twilio
 * runbook. It is an evidence-verification fact. Nothing about the event
 * disagreed with the code; the code was reading the wrong thing.
 *
 * The decision is now over EXACT IDENTITIES, in a fixed order, with the
 * unrecognised case failing CLOSED. No substring, prefix or suffix appears
 * anywhere in it. This file pins that.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  lifecycleForSourceId,
  offersManualResolution,
} from "@proovra/shared-runtime";

import {
  CLASSIFIED_SECURITY_EVENTS,
  DEDICATED_SOURCE_EVENT_TYPES,
  ROUTINE_SECURITY_EVENTS,
  dedicatedSourceOwning,
  emitSecurityEvent,
  mapEventTypeToIncident,
  routineSecurityEventReason,
  type EmitSecurityEventInput,
} from "../src/services/security/security-event.service.js";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/** The declared catalogue, read from the shared package. */
function everyEventType(): string[] {
  const src = readFileSync(`${REPO}/packages/shared/src/security.ts`, "utf8");
  const start = src.indexOf("export const SECURITY_EVENT_TYPES = [");
  const end = src.indexOf("] as const", start);
  return [...src.slice(start, end).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

const UNCLASSIFIED = "security.unclassified_signal";

// ===========================================================================
// THE CONTRACT  (required test 6)
// ===========================================================================

describe("security.unclassified_signal fails closed", () => {
  it("6. AN UNKNOWN SECURITY CONDITION CANNOT BE MANUALLY RESOLVED", () => {
    const lifecycle = lifecycleForSourceId(UNCLASSIFIED)!;
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

  it("OPERATOR_DECISION IS NOT RESTORED FOR UNKNOWN SECURITY EVENTS", () => {
    // The regression this guards: registering the default branch closed the
    // unregistered-row hole and then reproduced it, by making the source that
    // MEANS "the platform cannot classify this" closable by assertion. Not
    // knowing what something is never confers the right to declare it over.
    const lifecycle = lifecycleForSourceId(UNCLASSIFIED)!;
    expect(lifecycle.resolutionAuthority).not.toBe("OPERATOR_DECISION");
    expect(lifecycle.resolutionAuthority).not.toBe("SOURCE_TRUTH");
  });
});

// ===========================================================================
// THE DECISION ORDER
// ===========================================================================

describe("the decision is over exact identities, in order", () => {
  it("1. EXPLICIT ROUTINE / ADMINISTRATIVE EVENTS ARE SUPPRESSED", () => {
    // The measured offenders: each had a live WARNING-or-higher call site and
    // put a note-requiring row in a tenant's queue for a successful admin
    // action. That is how a queue becomes something nobody works.
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
      "signer_health_checked",
      "custody_attestation_verified",
      "mfa_recovery_requested",
      "mfa_recovery_approved",
      "rbac_temporary_elevation_granted",
      "automation_webhook_secret_rotated",
      "all_sessions_revoked",
    ]) {
      expect(routineSecurityEventReason(t), t).not.toBeNull();
      expect(mapEventTypeToIncident(t), t).toBeNull();
    }
  });

  it("2. A DEDICATED SOURCE'S EVENT CREATES NO GENERIC INCIDENT", () => {
    // Each of these fires the SecurityEvent and records its dedicated
    // condition in the same function. The generic copy sat beside it and was
    // the manually-closable one.
    for (const t of Object.keys(DEDICATED_SOURCE_EVENT_TYPES)) {
      expect(mapEventTypeToIncident(t), t).toBeNull();
    }
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

  it("3. AN UNKNOWN WARNING EVENT STILL OPENS security.unclassified_signal", () => {
    // No marker in the name. Under the old scan these were routine.
    for (const t of [
      "credential_exfiltration_suspected",
      "tamper_evidence_broken",
      "quarantine_bypass",
      "synthetic_warning_event_the_build_has_never_seen",
    ]) {
      const mapping = mapEventTypeToIncident(t);
      expect(mapping, t).not.toBeNull();
      expect(mapping!.sourceId, t).toBe(UNCLASSIFIED);
    }
  });

  it("4. AN UNKNOWN HIGH EVENT STILL OPENS security.unclassified_signal", () => {
    // The decision does not read severity — it cannot, since severity is not
    // part of the identity. That is the point: the same unknown identity gets
    // the same fail-closed answer at WARNING and at HIGH, and the bridge
    // forwards the severity it was given.
    const mapping = mapEventTypeToIncident("synthetic_high_severity_unknown");
    expect(mapping).not.toBeNull();
    expect(mapping!.sourceId).toBe(UNCLASSIFIED);

    const bridge = readBridgeCode();
    expect(bridge).toMatch(
      /severity: input\.severity === "HIGH" \? "HIGH" : "WARNING"/,
    );
  });

  it("5. A MORE SEVERE UNKNOWN EVENT CANNOT BYPASS THE FAIL-CLOSED DEFAULT", () => {
    // There is exactly one way out of the default, and it is membership in one
    // of the three exact maps. Nothing about an event's shape, spelling or
    // severity provides another.
    const escapes = ["", "  ", "UPPER_CASE_EVENT", "évènement", "a".repeat(300)]
      .map((t) => mapEventTypeToIncident(t))
      .filter((m) => m === null || m.sourceId !== UNCLASSIFIED);
    expect(escapes).toEqual([]);
  });

  it("8. EVERY SUPPRESSED EVENT IS IN ONE OF THE TWO EXPLICIT MAPS", () => {
    // Stated as a property over the WHOLE declared catalogue, so a future
    // event cannot be suppressed by a rule that is not one of these two.
    for (const t of everyEventType()) {
      if (mapEventTypeToIncident(t) !== null) continue;
      const suppressedBy =
        dedicatedSourceOwning(t) !== null || routineSecurityEventReason(t) !== null;
      expect(suppressedBy, `${t} is suppressed by no explicit map`).toBe(true);
    }
  });

  it("9. AN EVENT IN NEITHER MAP CREATES THE FAIL-CLOSED SOURCE", () => {
    const partition = { owned: 0, routine: 0, classified: 0, unclassified: 0 };
    for (const t of everyEventType()) {
      if (dedicatedSourceOwning(t) !== null) partition.owned += 1;
      else if (routineSecurityEventReason(t) !== null) partition.routine += 1;
      else if (CLASSIFIED_SECURITY_EVENTS[t]) partition.classified += 1;
      else {
        partition.unclassified += 1;
        expect(mapEventTypeToIncident(t)!.sourceId, t).toBe(UNCLASSIFIED);
      }
    }
    // eslint-disable-next-line no-console -- the partition IS the deliverable
    console.table([partition]);
    // The catalogue is large and the fail-closed bucket is the DEFAULT, so it
    // is expected to be the biggest. Asserting it is non-empty pins that the
    // default is reachable at all — a build where every event had been swept
    // into an allowlist would be the old fail-open behaviour by another route.
    expect(partition.unclassified).toBeGreaterThan(0);
  });

  it("11. NO GENERIC INCIDENT IS CREATED BESIDE A DEDICATED SOURCE", () => {
    // The suppression is exactly one thing: the duplicate generic row. The
    // dedicated source keeps its own producer, and the SecurityEvent row is
    // written either way (see the persistence describe below).
    for (const [t, sourceId] of Object.entries(DEDICATED_SOURCE_EVENT_TYPES)) {
      expect(mapEventTypeToIncident(t), t).toBeNull();
      const lifecycle = lifecycleForSourceId(sourceId)!;
      expect(lifecycle.producers.length, sourceId).toBeGreaterThan(0);
    }
  });

  it("12. NO ROUTINE SUCCESS EVENT CREATES OPERATIONS NOISE", () => {
    for (const t of Object.keys(ROUTINE_SECURITY_EVENTS)) {
      expect(mapEventTypeToIncident(t), t).toBeNull();
    }
  });
});

// ===========================================================================
// THE INVARIANTS BEHIND THE DECISION
// ===========================================================================

describe("the allowlists are explicit, disjoint and honest", () => {
  it("EVERY DEDICATED OWNER IS REGISTERED, ACTIVE, AND HAS A PRODUCER", () => {
    // An entry naming a source that does not exist — or one that is retired,
    // or one nothing writes — would suppress a signal in favour of a condition
    // that never appears. That is a silent loss, not a deduplication.
    for (const [eventType, sourceId] of Object.entries(
      DEDICATED_SOURCE_EVENT_TYPES,
    )) {
      const lifecycle = lifecycleForSourceId(sourceId);
      expect(
        lifecycle,
        `${eventType} names an unregistered ${sourceId}`,
      ).not.toBeNull();
      expect(lifecycle!.discoveryState, sourceId).toBe("ACTIVE");
      expect(lifecycle!.producers.length, sourceId).toBeGreaterThan(0);
    }
  });

  it("EVERY CLASSIFIED SOURCE IS REGISTERED AND ACTIVE", () => {
    for (const [eventType, entry] of Object.entries(CLASSIFIED_SECURITY_EVENTS)) {
      const lifecycle = lifecycleForSourceId(entry.sourceId);
      expect(
        lifecycle,
        `${eventType} names an unregistered ${entry.sourceId}`,
      ).not.toBeNull();
      expect(lifecycle!.discoveryState, entry.sourceId).toBe("ACTIVE");
    }
  });

  it("THE THREE MAPS DO NOT OVERLAP", () => {
    // Overlap is not a tie the order silently breaks; it is two reviewers
    // having recorded contradictory intentions about the same identity.
    const dedicated = new Set(Object.keys(DEDICATED_SOURCE_EVENT_TYPES));
    const routine = new Set(Object.keys(ROUTINE_SECURITY_EVENTS));
    const classified = new Set(Object.keys(CLASSIFIED_SECURITY_EVENTS));
    const overlaps: string[] = [];
    for (const t of routine) {
      if (dedicated.has(t)) overlaps.push(`routine+dedicated: ${t}`);
      if (classified.has(t)) overlaps.push(`routine+classified: ${t}`);
    }
    for (const t of classified) {
      if (dedicated.has(t)) overlaps.push(`classified+dedicated: ${t}`);
    }
    expect(overlaps).toEqual([]);
  });

  it("EVERY ROUTINE ENTRY CARRIES A REASON A REVIEWER CAN CHECK", () => {
    for (const [t, reason] of Object.entries(ROUTINE_SECURITY_EVENTS)) {
      expect(typeof reason, t).toBe("string");
      expect(reason.trim().length, `${t}: "${reason}"`).toBeGreaterThan(7);
    }
  });

  it("NO SUBSTRING, PREFIX OR SUFFIX DECIDES ANYTHING", () => {
    // The property that made both old defects possible, removed. Read from
    // the decision function's own body, with comments and strings stripped so
    // a prose mention of the old behaviour cannot fail this.
    const decision = decisionFunctionBody();
    for (const forbidden of [
      "startsWith",
      "endsWith",
      "includes",
      "indexOf",
      "match(",
      "RegExp",
    ]) {
      expect(decision, `decision uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("THE LOAD-TIME INVARIANT REFUSES A CONTRADICTORY BUILD", () => {
    // Importing the module at the top of this file already ran it. Pin that it
    // is there, so it cannot be dropped in a refactor and leave the three maps
    // checked only by this test file.
    const code = readBridgeCode({ stripComments: false });
    expect(code).toMatch(/throw new Error\(/);
    expect(code).toContain("ROUTINE_SECURITY_EVENTS");
  });
});

// ===========================================================================
// PERSISTENCE AND TENANCY  (required tests 7 and 10)
// ===========================================================================

/** The two calls `emitSecurityEvent` makes on its client, and nothing else. */
function fakeClient(): {
  client: unknown;
  rows: Array<Record<string, unknown>>;
} {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    client: {
      securityEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `row-${rows.length + 1}`, ...data };
          rows.push(row);
          return row;
        },
      },
    },
  };
}

describe("the SecurityEvent row is written regardless of the decision", () => {
  it("7. A SUPPRESSED EVENT IS STILL PERSISTED", async () => {
    // The audit record is not what is being withheld. Only the Operations
    // representation is.
    const { client, rows } = fakeClient();
    const suppressed = Object.keys(ROUTINE_SECURITY_EVENTS)[0]!;
    expect(mapEventTypeToIncident(suppressed)).toBeNull();

    const row = await emitSecurityEvent(
      {
        teamId: "team-a",
        eventType: suppressed as EmitSecurityEventInput["eventType"],
        severity: "WARNING",
      },
      client as never,
    );
    expect(row).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe(suppressed);
  });

  it("7b. THE WRITE HAPPENS BEFORE THE DECISION IS EVEN CONSULTED", () => {
    // Structural, because ordering is the actual guarantee:
    // `maybeAutoCreateIncident` runs AFTER the row exists and takes its id, so
    // a suppressed mapping cannot reach back and skip the write.
    const code = readBridgeCode();
    expect(code).toMatch(/maybeAutoCreateIncident\(input, row\.id, client\)/);
    expect(code).toMatch(/securityEventId: string/);
    expect(code.indexOf("if (!mapping) return;")).toBeLessThan(
      code.indexOf("recordIncident("),
    );
  });

  it("10. THE TEAM ON THE EVENT IS THE TEAM ON THE ROW AND THE CONDITION", async () => {
    const { client, rows } = fakeClient();
    await emitSecurityEvent(
      { teamId: "team-a", eventType: "auth_login_failed", severity: "HIGH" },
      client as never,
    );
    await emitSecurityEvent(
      { eventType: "auth_login_failed", severity: "HIGH" },
      client as never,
    );
    expect(rows.map((r) => r.teamId)).toEqual(["team-a", null]);

    // …and the bridge hands the same value to the incident writer rather than
    // widening it. Nothing in the decision reads or rewrites the tenant.
    const code = readBridgeCode();
    expect(code).toMatch(/teamId: input\.teamId \?\? null/);
    expect(decisionFunctionBody()).not.toContain("teamId");
  });

  it("AN UNDECLARED EVENT TYPE IS NEVER WRITTEN AT ALL", () => {
    // Capability/validation behaviour, unchanged by this work: the catalogue
    // is the gate on what may be emitted, and the decision runs strictly
    // downstream of it.
    const code = readBridgeCode();
    expect(code).toMatch(/if \(!VALID_TYPES\.has\(input\.eventType\)\) \{/);
    expect(code).toMatch(/if \(!VALID_SEVERITIES\.has\(input\.severity\)\) return null;/);
  });
});

// ===========================================================================

const BRIDGE = "services/api/src/services/security/security-event.service.ts";

function readBridgeCode(opts?: { stripComments?: boolean }): string {
  const raw = readFileSync(`${REPO}/${BRIDGE}`, "utf8");
  if (opts?.stripComments === false) return raw;
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** The body of `mapEventTypeToIncident`, comments and strings removed. */
function decisionFunctionBody(): string {
  const code = readBridgeCode();
  const start = code.indexOf("export function mapEventTypeToIncident(");
  expect(start, "mapEventTypeToIncident not found").toBeGreaterThan(-1);
  const end = code.indexOf("\n}", start);
  return code.slice(start, end).replace(/"[^"]*"/g, '""');
}
