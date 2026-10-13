/**
 * A REGISTERED SOURCE THAT NOTHING PRODUCES IS NOT AN OPERATIONS CAPABILITY.
 *
 * Every source whose discovery state is NOT_YET_DISCOVERED (no emitter) must
 * be advertised nowhere: not active, not required for freshness, not on any
 * registry surface, no Resolve, no remediation action or deep link, and no
 * Home row. `governance.policy_condition` and
 * `integration.configuration_failure` are named explicitly because they were
 * once presented as actionable while nothing wrote them.
 */
import { describe, expect, it } from "vitest";

import {
  OPERATIONS_SOURCE_LIFECYCLES,
  activeOperationsSourceIds,
  offersManualResolution,
} from "@proovra/shared-runtime";

import {
  OPERATIONS_SOURCES,
  requiredSourceIds,
} from "../src/services/operations/operations-source-registry.js";
import { entryForIncident } from "../src/services/operations/remediation-registry.js";
import { HOME_CONDITION_REPRESENTATION } from "../../../apps/web/components/home-experience/operations-condition-map.js";

const unproduced = OPERATIONS_SOURCE_LIFECYCLES.filter((s) => s.discoveryState === "NOT_YET_DISCOVERED");

describe("unproduced condition sources are not advertised as operationally supported", () => {
  it("names the sources this applies to, including the two once shown as actionable", () => {
    const ids = unproduced.map((s) => s.sourceId);
    expect(ids).toContain("governance.policy_condition");
    expect(ids).toContain("integration.configuration_failure");
    for (const s of unproduced) expect(s.producers, s.sourceId).toEqual([]);
  });

  it("none is active, required for freshness, or closable by hand", () => {
    const active = new Set(activeOperationsSourceIds());
    const required = new Set(requiredSourceIds());
    for (const s of unproduced) {
      expect(active.has(s.sourceId), s.sourceId).toBe(false);
      expect(required.has(s.sourceId), s.sourceId).toBe(false);
      expect(s.resolutionAuthority, s.sourceId).toBe("NO_DIRECT_RESOLUTION");
      expect(s.activityProbeKey, s.sourceId).toBe("NONE");
      expect(s.recoveryPolicy, s.sourceId).toBe("NO_RECOVERY_SIGNAL");
      expect(offersManualResolution(s), s.sourceId).toBe(false);
    }
  });

  it("no registry surface advertises it", () => {
    for (const s of unproduced) {
      const row = OPERATIONS_SOURCES.find((r) => r.id === s.sourceId);
      expect(row, s.sourceId).toBeTruthy();
      expect(row!.surfaces, s.sourceId).toEqual({ home: false, notifications: false, operations: false });
      expect(row!.discovery, s.sourceId).toMatch(/^not produced/);
    }
  });

  it("no remediation action or deep link is offered for it", () => {
    for (const s of unproduced) {
      const entry = entryForIncident({ sourceId: s.sourceId, category: s.category, fingerprint: `${s.sourceId}:probe` });
      expect(entry?.action ?? null, s.sourceId).toBeNull();
      expect(entry?.secondaryAction ?? null, s.sourceId).toBeNull();
      expect(entry?.deepLink ?? null, s.sourceId).toBeNull();
    }
  });

  it("Home never renders it as a row with an action", () => {
    for (const s of unproduced) {
      const rep = (HOME_CONDITION_REPRESENTATION as Record<string, { kind: string }>)[s.sourceId];
      expect(rep, s.sourceId).toBeTruthy();
      expect(["NOT_PRODUCED", "PLATFORM"], s.sourceId).toContain(rep!.kind);
    }
  });
});
