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

import { execFileSync } from "node:child_process";
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
  classifySecurityEvent,
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

describe("security.unclassified_signal is RETIRED (OPS-13)", () => {
  it("6. THE OLD DEFAULT IS RETIRED: NO PRODUCER, NO RESOLVE, OFF EVERY TENANT SURFACE", () => {
    // It was NO_DIRECT_RESOLUTION + NO_RECOVERY_SIGNAL and TENANT_ADVISORY: a
    // row in a workspace that nobody could ever close. The executed audit
    // showed an outsider's DENIED workspace switch opening one inside the
    // target workspace. It stays registered so historical rows classify, and
    // it is never written again.
    const lifecycle = lifecycleForSourceId(UNCLASSIFIED)!;
    expect(lifecycle.discoveryState).toBe("RETIRED");
    expect(lifecycle.producers).toEqual([]);
    expect(lifecycle.resolutionAuthority).toBe("NO_DIRECT_RESOLUTION");
    expect(lifecycle.requiresResolutionNote).toBe(false);
    expect(offersManualResolution(lifecycle)).toBe(false);
    expect(lifecycle.activityProbeKey).toBe("NONE");
    expect(lifecycle.audience).toBe("PLATFORM_INTERNAL");
    // …and the bridge does not name it anywhere in its code any more.
    expect(readBridgeCode()).not.toContain(`"${UNCLASSIFIED}"`);
  });

  it("OPERATOR_DECISION IS NOT RESTORED FOR UNKNOWN SECURITY EVENTS", () => {
    // Not knowing what something is never confers the right to declare it
    // over — and now it confers no tenant row at all.
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
    // OPS-13 — the dedicated owners the bridge now defers to.
    expect(dedicatedSourceOwning("adaptive_block_triggered")).toBe(
      "identity.runtime_block",
    );
    expect(dedicatedSourceOwning("automation_webhook_destination_auto_disabled")).toBe(
      "integration.webhook_destination_disabled",
    );
    // storage.immutable_drift is DISABLED and its events have no API emitter:
    // naming it as an owner would claim coverage nothing provides.
    expect(dedicatedSourceOwning("immutable_storage_drift")).toBeNull();
  });

  it("3. AN UNKNOWN WARNING EVENT IS UNCLASSIFIED AND NAMES NO SOURCE", () => {
    // No marker in the name, and no map claims it. It is persisted to the
    // security log, counted and logged by the bridge — and maps to NO source,
    // so no tenant row can be written for it (see the bridge behaviour suite).
    for (const t of [
      "credential_exfiltration_suspected",
      "tamper_evidence_broken",
      "quarantine_bypass",
      "synthetic_warning_event_the_build_has_never_seen",
    ]) {
      expect(classifySecurityEvent(t).kind, t).toBe("UNCLASSIFIED");
      expect(mapEventTypeToIncident(t), t).toBeNull();
    }
  });

  it("4. AN UNKNOWN HIGH EVENT GETS THE SAME ANSWER, AND IS COUNTED, NOT WRITTEN", () => {
    // The decision does not read severity: the same unknown identity gets the
    // same answer at WARNING and at HIGH.
    expect(classifySecurityEvent("synthetic_high_severity_unknown").kind).toBe("UNCLASSIFIED");
    const bridge = readBridgeCode();
    // The unclassified branch reports and returns BEFORE any incident write.
    const unclassified = bridge.indexOf('disposition.kind === "UNCLASSIFIED"');
    expect(unclassified).toBeGreaterThan(-1);
    expect(unclassified).toBeLessThan(bridge.indexOf("recordIncident("));
    expect(bridge).toContain("security_event_unclassified_total");
    // A classified event still forwards the severity it was given.
    expect(bridge).toMatch(
      /severity: input\.severity === "HIGH" \? "HIGH" : "WARNING"/,
    );
  });

  it("5. NO SHAPE, SPELLING OR SEVERITY ESCAPES INTO A SOURCE", () => {
    // There is exactly one way to a source: membership in CLASSIFIED (or a
    // dedicated owner). Nothing about an unknown identity provides another.
    const escapes = ["", "  ", "UPPER_CASE_EVENT", "évènement", "a".repeat(300), "constructor", "__proto__", "toString"]
      .map((t) => ({ t, kind: classifySecurityEvent(t).kind, mapped: mapEventTypeToIncident(t) }))
      .filter((m) => m.kind !== "UNCLASSIFIED" || m.mapped !== null);
    expect(escapes).toEqual([]);
  });

  it("8. EVERY WARNING-OR-HIGHER PRODUCER IN THE TREE IS EXPLICITLY CLASSIFIED", () => {
    // OPS-13 — the gate the old default stood in for. Every production call
    // site that can emit a SecurityEvent at WARNING or HIGH names an event
    // type one of the three maps claims. A new WARNING+ emitter that nobody
    // classified fails HERE, in review — instead of opening a row nobody can
    // close in a customer's workspace.
    const unclassified = warningOrHigherEmittedEventTypes().filter(
      ({ eventType }) => classifySecurityEvent(eventType).kind === "UNCLASSIFIED",
    );
    expect(
      unclassified,
      `WARNING+ producers with no classification:\n${unclassified
        .map((u) => `${u.eventType} @ ${u.site}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("8b. THE PRODUCER SCAN IS CONNECTED (it sees the producers the audit named)", () => {
    const seen = new Set(warningOrHigherEmittedEventTypes().map((e) => e.eventType));
    for (const t of [
      "workspace_context_switched",
      "export_blocked_by_lifecycle",
      "destruction_blocked_by_hold",
      "sso_login_failed",
      "auth_login_failed",
      "automation_webhook_destination_auto_disabled",
      "multipart_complete_failed",
      "recovery_review_required",
      "scim_user_provisioning_conflict",
      "adaptive_block_triggered",
    ]) {
      expect(seen.has(t), t).toBe(true);
    }
  });

  it("9. THE CATALOGUE PARTITIONS INTO FOUR ANSWERS, AND ONLY CLASSIFIED MAPS TO A SOURCE", () => {
    const partition = { dedicated: 0, routine: 0, classified: 0, unclassified: 0 };
    for (const t of everyEventType()) {
      const kind = classifySecurityEvent(t).kind;
      partition[kind.toLowerCase() as keyof typeof partition] += 1;
      if (kind === "CLASSIFIED") {
        expect(mapEventTypeToIncident(t)!.sourceId, t).toBe(CLASSIFIED_SECURITY_EVENTS[t]!.sourceId);
      } else {
        expect(mapEventTypeToIncident(t), t).toBeNull();
      }
    }
    // eslint-disable-next-line no-console -- the partition IS the deliverable
    console.table([partition]);
    // The catalogue declares more types than are emitted at WARNING+ (many are
    // INFO-only); those stay unclassified and are counted if they ever fire.
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

// ===========================================================================
// THE PRODUCER SCAN (test 8)
// ===========================================================================

/**
 * Call sites whose event type is computed from something other than a literal
 * in the call itself, with the identities they can emit at WARNING or above —
 * read from the function that computes them.
 */
const DYNAMIC_PRODUCERS: Record<string, readonly string[]> = {
  // `signalKindToSecurityEvent` — the four identities the risk signal maps to.
  "services/api/src/services/identity-security/risk.service.ts": [
    "service_account_risk_detected",
    "contributor_risk_detected",
    "impossible_travel_signal",
    "suspicious_login_detected",
  ],
};

function blankCommentsKeepOffsets(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

/** The text of one top-level property's value inside an object literal. */
function propertyValue(objectText: string, key: string): string | null {
  let depth = 0;
  for (let i = 0; i < objectText.length; i += 1) {
    const ch = objectText[i]!;
    if ("({[".includes(ch)) depth += 1;
    else if (")}]".includes(ch)) depth -= 1;
    if (depth !== 1) continue;
    if (objectText.startsWith(key, i) && !/[A-Za-z0-9_]/.test(objectText[i - 1] ?? "")) {
      let j = i + key.length;
      while (objectText[j] === " ") j += 1;
      if (objectText[j] === ",") return key; // shorthand
      if (objectText[j] !== ":") continue;
      j += 1;
      let d = 0;
      const start = j;
      for (; j < objectText.length; j += 1) {
        const c = objectText[j]!;
        if ("({[".includes(c)) d += 1;
        else if (")}]".includes(c)) {
          if (d === 0) break;
          d -= 1;
        } else if (c === "," && d === 0) break;
      }
      return objectText.slice(start, j).trim();
    }
  }
  return null;
}

function warningOrHigherEmittedEventTypes(): Array<{ eventType: string; site: string }> {
  const files = execFileSync("git", ["ls-files", "services/api/src"], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".ts") && !l.endsWith(BRIDGE));
  const out: Array<{ eventType: string; site: string }> = [];
  for (const rel of files) {
    const src = blankCommentsKeepOffsets(readFileSync(`${REPO}/${rel}`, "utf8"));
    // Only `safeEmitSecurityEvent` reaches the bridge: `emitSecurityEvent`
    // writes the row and returns, and never consults the decision.
    const re = /\bsafeEmitSecurityEvent\s*\(\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let end = open;
      for (; end < src.length; end += 1) {
        if (src[end] === "{") depth += 1;
        else if (src[end] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const obj = src.slice(open, end + 1);
      const severity = propertyValue(obj, "severity") ?? "";
      const literalSeverities = [...severity.matchAll(/"(INFO|WARNING|HIGH)"/g)].map((x) => x[1]);
      // A literal-only INFO severity cannot reach the bridge's incident path.
      const canEscalate =
        literalSeverities.length === 0 || literalSeverities.some((x) => x !== "INFO");
      if (!canEscalate) continue;
      const line = src.slice(0, m.index).split("\n").length;
      const site = `${rel}:${line}`;
      const eventExpr = propertyValue(obj, "eventType") ?? "";
      let types = [...eventExpr.matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]!);
      // `eventType` passed through a parameter: the call's own severity
      // ternary names the identities that escalate.
      if (types.length === 0) types = [...severity.matchAll(/"([a-z][a-z0-9_]+)"/g)].map((x) => x[1]!);
      if (types.length === 0) types = [...(DYNAMIC_PRODUCERS[rel] ?? [])];
      if (types.length === 0) {
        out.push({ eventType: `<unenumerable: ${eventExpr.slice(0, 40)}>`, site });
        continue;
      }
      for (const eventType of types) out.push({ eventType, site });
    }
  }
  return out;
}
