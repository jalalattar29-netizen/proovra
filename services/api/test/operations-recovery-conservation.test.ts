/**
 * OPS-018 / OPS-031 — CONSERVATION GATES OVER THE LIFECYCLE REGISTRY.
 *
 * A source that declares PROBE_AUTO_RESOLVE is making a promise: "when my
 * source recovers, this condition closes on its own." Six sources made that
 * promise with nothing behind it (OPS-003, OPS-009, OPS-018). This gate makes
 * the promise and its keeper the same fact: every such source is either in the
 * registry-derived set the workspace sweep runs, an aggregate the aggregate
 * loop runs, or one of the named writers that close their own conditions — and
 * each of those writers is checked to actually call a resolver.
 *
 * The second gate holds remediation to the SOURCE (OPS-031): every
 * tenant-visible, produced source either has its own entry or is named here as
 * deliberately served by its category's entry, with the reason.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { OPERATIONS_SOURCE_LIFECYCLES } from "@proovra/shared-runtime";
import { describe, expect, it } from "vitest";

import { aggregateSpecs } from "../src/services/operations/operations-source-probes.js";
import { sourceKeyedRemediationIds } from "../src/services/operations/remediation-registry.js";
import { probeRecoverablePerRecordSourceIds } from "../src/services/operations/source-truth-recovery.service.js";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

/** Writers that close their OWN conditions from the source authority. */
const SELF_RESOLVING_WRITERS: Record<string, { file: string; resolver: RegExp }> = {
  "platform.worker_heartbeat_stale": {
    file: "src/services/operations/platform-conditions.service.ts",
    resolver: /resolveConditionFromSourceRecovery\(/,
  },
  "job.background_failure": {
    file: "src/services/operations/platform-conditions.service.ts",
    resolver: /resolveConditionFromSourceRecovery\(/,
  },
  "search.indexing_failure": {
    file: "src/services/operations/search-index-conditions.service.ts",
    resolver: /sweepSourceTruthRecoveries\(/,
  },
};

describe("OPS-018 — every PROBE_AUTO_RESOLVE promise has a keeper", () => {
  const promised = OPERATIONS_SOURCE_LIFECYCLES.filter(
    (s) =>
      s.resolutionAuthority === "SOURCE_TRUTH" &&
      s.recoveryPolicy === "PROBE_AUTO_RESOLVE" &&
      s.discoveryState === "ACTIVE",
  );

  it("the set is not empty, so the gate cannot pass vacuously", () => {
    expect(promised.length).toBeGreaterThanOrEqual(15);
  });

  it.each(promised.map((s) => [s.sourceId, s] as const))("%s is kept", (_id, s) => {
    expect(s.activityProbeKey, "a promise to recover needs a probe").not.toBe("NONE");
    const perRecord = probeRecoverablePerRecordSourceIds().includes(s.sourceId);
    const aggregate = aggregateSpecs().some((spec) => spec.sourceId === s.sourceId);
    const writer = SELF_RESOLVING_WRITERS[s.sourceId];
    const kept = perRecord || aggregate || Boolean(writer);
    expect(kept, `${s.sourceId} declares PROBE_AUTO_RESOLVE and nothing closes it`).toBe(true);
    if (writer) expect(readApi(writer.file)).toMatch(writer.resolver);
  });

  it("the derived set includes the five sources that were stuck", () => {
    expect(probeRecoverablePerRecordSourceIds()).toEqual(
      expect.arrayContaining([
        "billing.dependent_cancellation_failed",
        "evidence_integrity.ots_budget_exhausted",
        "pipeline.package_generation_denied",
        "review.escalation",
        "identity.idp_outage",
      ]),
    );
  });

  it("the workspace sweep runs the derived set, not a hand-written list", () => {
    const generator = readApi("src/services/dashboard/incident-generator.service.ts");
    expect(generator).toMatch(/for \(const sourceId of probeRecoverablePerRecordSourceIds\(\)\)/);
    expect(generator).not.toMatch(/"storage\.immutable_drift",?\s*\n\s*attempted\.push/);
  });
});

/**
 * Sources deliberately served by their CATEGORY's entry, and why. Anything
 * tenant-visible and produced that is neither here nor source-keyed fails.
 */
const CATEGORY_FALLBACK_OK: Record<string, string> = {
  "evidence_integrity.tsa_failed": "integrity class entries (fingerprint-keyed)",
  "evidence_integrity.ots_failed": "integrity class entries (fingerprint-keyed)",
  "evidence_integrity.ots_pending_aged": "integrity class entries (fingerprint-keyed)",
  "evidence_integrity.ots_initialization_stalled": "integrity class entries (fingerprint-keyed)",
  "evidence_integrity.ots_budget_exhausted": "OTS budget fingerprint maps to the ots_failure entry",
  "communications.provider_failure": "COMMUNICATIONS entry links to the message's delivery history",
  "webhook.security_failure": "WEBHOOK entry links to integrations, which owns delivery and retry",
  "identity.security_condition": "IDENTITY_SECURITY entry links to Security Center",
  "identity.runtime_block": "IDENTITY_SECURITY entry links to Security Center",
  "identity.high_risk_session_surge": "IDENTITY_SECURITY entry links to Security Center",
  "governance.policy_condition": "GOVERNANCE entry links to the governance surface that owns it",
  "governance.destruction_executed": "GOVERNANCE entry links to the governance surface that owns it",
  "governance.notification_escalated": "GOVERNANCE entry links to the governance surface that owns it",
  "review.escalation_storm": "GOVERNANCE entry; Review owns the escalations it summarises",
  "platform.operational_seed": "demonstration seed rows only",
};

describe("OPS-031 — remediation is keyed by source", () => {
  it("every tenant-visible, produced source has its own entry or a stated category fallback", () => {
    const keyed = new Set(sourceKeyedRemediationIds());
    const missing = OPERATIONS_SOURCE_LIFECYCLES.filter(
      (s) =>
        s.audience !== "PLATFORM_INTERNAL" &&
        s.discoveryState === "ACTIVE" &&
        !keyed.has(s.sourceId) &&
        !(s.sourceId in CATEGORY_FALLBACK_OK),
    ).map((s) => s.sourceId);
    expect(missing).toEqual([]);
  });

  it("no source-keyed entry tells a tenant its condition is platform infrastructure", () => {
    const registry = readApi("src/services/operations/remediation-registry.ts");
    const table = registry.slice(registry.indexOf("const SOURCE_ENTRIES"), registry.indexOf("export function sourceKeyedRemediationIds"));
    expect(table).not.toMatch(/platform infrastructure/);
  });
});
