/**
 * SOURCES 12–17 — CLASSIFIED FROM THE WRITER, NOT FROM THE NAME.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * Six sources were classified `OPERATOR_DECISION` with no probe, and the
 * reason given was, in effect, "these look event-shaped". That is a guess from
 * a name. Two of them were wrong:
 *
 *   * `integration.configuration_failure` — an invalid configuration is an
 *     ACTIVE STATE, not an event. Nothing in the product can safely re-check
 *     it, so it is NO_DIRECT_RESOLUTION. A Settings deep link is not a reason
 *     to let somebody declare the configuration fixed.
 *   * `identity.idp_outage` did not exist as a source at all. Its writer's
 *     conditions were falling through to the unregistered contract — and
 *     `SsoConnection.outageDetectedAtUtc` is a genuine canonical recovery
 *     signal, cleared to NULL by the first successful callback.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE HOLDS
 * ---------------------------------------------------------------------------
 * For each of the six, the PRODUCTION WRITER is read and the claim the
 * classification rests on is checked against it: the fingerprint shape it
 * actually emits, and — for the one that is SOURCE_TRUTH — that the recovery
 * signal it names is really written and really cleared.
 *
 * A classification whose evidence is a sentence in a comment is a
 * classification nobody has checked.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  lifecycleForSourceId,
  resolveConditionSource,
} from "@proovra/shared-runtime";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

function read(rel: string): string {
  return readFileSync(`${REPO}/${rel}`, "utf8");
}

const SECURITY_BRIDGE = read(
  "services/api/src/services/security/security-event.service.ts",
);
const SSO = read(
  "services/api/src/services/access-control/sso-hardening.service.ts",
);
const SCHEMA = read("services/api/prisma/schema.prisma");

/**
 * The six the brief names, with the CLAIM each classification rests on.
 *
 * `evidence` is checked against the tree below — it is not prose.
 */
const CLASSIFIED = [
  {
    sourceId: "intake.delivery_failed",
    authority: "OPERATOR_DECISION",
    writer: "security-event.service.ts (UPLOAD branch)",
    fingerprint: "upload:security_event:<eventType>",
    claim:
      "the fingerprint names an EVENT CLASS and no delivery, so there is no live subject a probe could be bound to",
  },
  {
    sourceId: "communications.provider_failure",
    authority: "OPERATOR_DECISION",
    writer: "security-event.service.ts (COMMUNICATIONS branch)",
    fingerprint: "communications:security_event:<eventType>",
    claim:
      "keyed by event class, not by provider or destination, so no bounded provider-health probe can answer for THIS condition",
  },
  {
    sourceId: "webhook.security_failure",
    authority: "OPERATOR_DECISION",
    writer: "security-event.service.ts (WEBHOOK branch)",
    fingerprint: "webhook:security_event:<eventType>",
    claim:
      "this writer emits the IMMUTABLE half — a signature burst was observed; the ACTIVE half (a destination whose autoDisabledAt is set) is a different subject the integrations surface owns",
  },
  {
    sourceId: "integration.configuration_failure",
    authority: "NO_DIRECT_RESOLUTION",
    writer: "none — NOT_YET_DISCOVERED",
    fingerprint: "n/a",
    claim:
      "an invalid configuration is an ACTIVE state and no validation authority can re-check it from a resolve path, so nobody may declare it corrected",
  },
  {
    sourceId: "identity.security_condition",
    authority: "OPERATOR_DECISION",
    writer: "security-event.service.ts (IDENTITY_SECURITY branch)",
    fingerprint: "identity_security:security_event:<eventType>",
    claim:
      "the SecurityEvent row is immutable and Security Center adjudicates it; Operations records the workspace's written conclusion",
  },
  {
    sourceId: "governance.policy_condition",
    authority: "OPERATOR_DECISION",
    writer: "security-event.service.ts (GOVERNANCE branch)",
    fingerprint: "governance:security_event:<eventType>",
    claim:
      "names an event class rather than a policy row, so no governance authority can re-check this condition",
  },
] as const;

describe("§6 — sources 12–17 carry a code-backed classification", () => {
  it("prints the classification table", () => {
    // eslint-disable-next-line no-console -- the table IS the deliverable
    console.table(
      CLASSIFIED.map((c) => {
        const s = lifecycleForSourceId(c.sourceId)!;
        return {
          source: c.sourceId,
          authority: s.resolutionAuthority,
          probe: s.activityProbeKey,
          note: s.requiresResolutionNote ? "REQUIRED" : "-",
          discovery: s.discoveryState,
          writer: c.writer,
        };
      }),
    );
    expect(CLASSIFIED).toHaveLength(6);
  });

  it.each(CLASSIFIED.map((c) => [c.sourceId, c] as const))(
    "%s is classified as its writer's shape requires",
    (_id, c) => {
      const s = lifecycleForSourceId(c.sourceId)!;
      expect(s.resolutionAuthority, c.claim).toBe(c.authority);
      // OPERATOR_DECISION always demands the written conclusion; the other two
      // authorities can never collect one.
      expect(s.requiresResolutionNote).toBe(c.authority === "OPERATOR_DECISION");
      // And absence of a probe is never the REASON — it is a consequence of
      // the shape, which is why every one of these carries a stated rationale.
      expect(s.rationale.length).toBeGreaterThan(40);
    },
  );

  it("the five bridge-written sources really are written by that bridge", () => {
    // Not "the registry says so": the mapping function returns the id, and
    // the emitter passes what it returns.
    for (const c of CLASSIFIED) {
      if (c.writer === "none — NOT_YET_DISCOVERED") continue;
      expect(
        SECURITY_BRIDGE.includes(`sourceId: "${c.sourceId}"`),
        `${c.sourceId} is not returned by mapEventTypeToIncident`,
      ).toBe(true);
    }
    // …and the bridge builds the fingerprint shape the classification rests
    // on: `<category>:security_event:<eventType>` — an event CLASS.
    expect(SECURITY_BRIDGE).toMatch(
      /category\.toLowerCase\(\)\}:security_event:\$\{input\.eventType\}/,
    );
  });

  it("each bridge fingerprint resolves back to its own source", () => {
    for (const c of CLASSIFIED) {
      if (c.fingerprint === "n/a") continue;
      const concrete = c.fingerprint.replace("<eventType>", "some_event_type");
      expect(
        resolveConditionSource({ fingerprint: concrete }).lifecycle.sourceId,
        concrete,
      ).toBe(c.sourceId);
    }
  });

  it("integration.configuration_failure is NOT operator-resolvable", () => {
    // The one the brief calls out by name: a Settings deep link is not a
    // reason to let somebody declare a configuration fixed.
    const s = lifecycleForSourceId("integration.configuration_failure")!;
    expect(s.resolutionAuthority).toBe("NO_DIRECT_RESOLUTION");
    expect(s.activityProbeKey).toBe("NONE");
    // It still deep-links: the fix lives on the integrations surface, and
    // withholding the LINK would be hiding the remediation rather than
    // withholding a false claim.
    expect(s.remediationDisposition).toBe("SAFE_DEEP_LINK");
    // …and it says, by name, that nothing writes it today.
    expect(s.discoveryState).toBe("NOT_YET_DISCOVERED");
  });
});

describe("§6.5 — identity.idp_outage is SOURCE_TRUTH, and the signal is real", () => {
  it("the writer emits a per-connection fingerprint", () => {
    // `idp-outage:<connectionId>` — a SUBJECT, not an event class, which is
    // what makes a bound probe possible at all.
    expect(SSO).toMatch(/fingerprint: `idp-outage:\$\{row\.id\}`/);
    expect(SSO).toContain('sourceId: "identity.idp_outage"');
  });

  it("outageDetectedAtUtc is stamped on outage and CLEARED on recovery", () => {
    // The claim the SOURCE_TRUTH classification rests on, checked in both
    // directions. A signal that is only ever set is not a recovery signal.
    expect(SCHEMA).toMatch(/outageDetectedAtUtc\s+DateTime\?/);
    // SET when the consecutive-failure threshold is crossed — and only then,
    // which is what keeps the column meaning "an outage is open" rather than
    // "a callback failed once".
    expect(SSO).toMatch(
      /outageDetectedAtUtc:\s*crossed\s*\?\s*new Date\(\)\s*:\s*row\.outageDetectedAtUtc/,
    );
    expect(SSO).toMatch(/newCount\s*>=\s*IDP_OUTAGE_FAILURE_THRESHOLD/);
    // …and CLEARED to NULL by the success path, beside the counter reset.
    // A signal that is only ever set is not a recovery signal, and the
    // SOURCE_TRUTH classification rests entirely on this half.
    expect(SSO).toMatch(/outageDetectedAtUtc:\s*null/);
    expect(SSO).toMatch(/consecutiveFailureCount:\s*0/);
  });

  it("the source declares the probe that reads exactly that column", () => {
    const s = lifecycleForSourceId("identity.idp_outage")!;
    expect(s.resolutionAuthority).toBe("SOURCE_TRUTH");
    expect(s.activityProbeKey).toBe("identity.idp_outage_state");
    expect(s.recoveryPolicy).toBe("PROBE_AUTO_RESOLVE");
    // Not a judgement, so no note is collected — the connection says whether
    // the outage is over.
    expect(s.requiresResolutionNote).toBe(false);

    const probes = read(
      "services/api/src/services/operations/operations-source-probes.ts",
    );
    expect(probes).toContain("outageDetectedAtUtc");
    // Workspace-bound: a fingerprint is not an authorization.
    expect(probes).toMatch(/id: connectionId, teamId: ctx\.teamId/);
  });
});

describe("§6 — the other reclassified writers", () => {
  it("review.escalation is SOURCE_TRUTH on the workflow's own status", () => {
    // It names ONE workflow, and that workflow's status says whether the
    // review it escalated is still outstanding.
    const s = lifecycleForSourceId("review.escalation")!;
    expect(s.resolutionAuthority).toBe("SOURCE_TRUTH");
    expect(s.activityProbeKey).toBe("review.workflow_open");
    const engine = read(
      "services/api/src/services/reviewer-ops/escalation-engine.service.ts",
    );
    expect(engine).toMatch(
      /fingerprint: `review-escalation:\$\{input\.reason\}:\$\{input\.workflowId\}`/,
    );
  });

  it("the two pipeline bridges are SOURCE_TRUTH on the artifact's presence", () => {
    for (const [id, probe] of [
      ["pipeline.report_generation_failed", "evidence.report_present"],
      ["pipeline.package_generation_denied", "evidence.package_present"],
    ] as const) {
      const s = lifecycleForSourceId(id)!;
      // The condition is "this record has no report/package". The record
      // either has one now or it does not, and that is a column read — not a
      // judgement, and not an event.
      expect(s.resolutionAuthority, id).toBe("SOURCE_TRUTH");
      expect(s.activityProbeKey, id).toBe(probe);
    }
  });

  it("review.escalation_storm stays OPERATOR_DECISION, and says why", () => {
    // Keyed by DATE: it records what one sweep did, and no later state can
    // contradict it. This is what event-shaped actually looks like.
    const s = lifecycleForSourceId("review.escalation_storm")!;
    expect(s.resolutionAuthority).toBe("OPERATOR_DECISION");
    expect(s.requiresResolutionNote).toBe(true);
    expect(s.rationale).toMatch(/DATE/i);
    const engine = read(
      "services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts",
    );
    expect(engine).toMatch(/reviewer:escalation_storm:\$\{input\.teamId\}:\$\{today\}/);
  });

  it("governance.destruction_executed is irreversible, and is classified as such", () => {
    const s = lifecycleForSourceId("governance.destruction_executed")!;
    expect(s.resolutionAuthority).toBe("OPERATOR_DECISION");
    expect(s.requiresResolutionNote).toBe(true);
    // Nothing to press: the bytes are gone, and a remediation control here
    // would be the most misleading one in the product.
    expect(s.remediationDisposition).toBe("GUIDANCE_ONLY");
  });
});
