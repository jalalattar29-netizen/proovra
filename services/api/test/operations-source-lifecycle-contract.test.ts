/**
 * THE SOURCE LIFECYCLE CONTRACT, HELD TO THE TREE.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 * Resolution authority used to be declared per `IncidentCategory`. That map was
 * TOTAL over the enum, which made it look complete, and it was wrong in a way
 * totality could not catch: there are fourteen categories and twenty-two
 * SOURCES, four of which write category WORKER and three of which write REPORT.
 * A rule stated per category was a rule about a set nobody had enumerated.
 *
 * The measured cost: `pipeline.report_backlog` inherited
 * `REPORT -> OPERATOR_MAY_RESOLVE`, so an operator could declare
 * "Report backlog above threshold (26)" resolved while all twenty-six records
 * were still above the threshold, and the workspace displayed a false all-clear
 * until the next sweep reopened it.
 *
 * So the table below is UNGROUPED — one row per source, printed. A source that
 * quietly inherits a neighbour's answer has nowhere to hide in a list where
 * every source states its own.
 */

import { describe, expect, it } from "vitest";

import {
  ACTIVITY_PROBE_KEYS,
  lifecycleForSourceId,
  offersManualResolution,
  OPERATIONS_SOURCE_LIFECYCLES,
  operationsSourceIds,
  resolveConditionSource,
  sourceCarriesMetric,
  UNREGISTERED_CONDITION_LIFECYCLE,
  decideManualResolution,
  manualResolutionErrorCode,
  type OperationsSourceLifecycle,
} from "@proovra/shared-runtime";

import { OPERATIONS_SOURCES } from "../src/services/operations/operations-source-registry.js";
import {
  aggregateFingerprint,
  aggregateSpecs,
  implementedProbeKeys,
  severityForAggregate,
} from "../src/services/operations/operations-source-probes.js";

const TEAM = "11111111-1111-4111-8111-111111111111";

// ===========================================================================
// 1. TOTALITY — every source answers every lifecycle question
// ===========================================================================

describe("§13.1 — the contract is total, and there is no default", () => {
  it("prints the full source classification table, ungrouped", () => {
    const rows = OPERATIONS_SOURCE_LIFECYCLES.map((s) => ({
      source: s.sourceId,
      authority: s.resolutionAuthority,
      probe: s.activityProbeKey,
      audience: s.audience,
      cardinality: s.cardinality,
      discovery: s.discoveryState,
      manualResolve: offersManualResolution(s) ? "OFFERED" : "NOT OFFERED",
      note: s.requiresResolutionNote ? "REQUIRED" : "-",
      recovery: s.recoveryPolicy,
      remediation: s.remediationDisposition,
      metric: s.metricContract,
      drillDown: s.drillDownContract,
    }));
    // eslint-disable-next-line no-console -- the table IS the deliverable
    console.table(rows);
    // NOT a fixed count. It grew from 22 to 35 because thirteen real
    // production emitters were writing conditions no registered source
    // claimed, and forcing semantically different conditions into an existing
    // row to preserve a number would have been the category defect again, one
    // level down. What is pinned is the PROPERTY: every emitter is registered,
    // which `operations-emitter-totality.test.ts` holds.
    expect(rows.length).toBeGreaterThanOrEqual(35);
  });

  it.each(OPERATIONS_SOURCE_LIFECYCLES.map((s) => [s.sourceId, s] as const))(
    "%s declares every lifecycle field explicitly",
    (_id, s: OperationsSourceLifecycle) => {
      // Each of these is required by the TYPE, so this cannot fail while the
      // tree compiles. Asserted anyway, per source, because the failure mode
      // being guarded against is a field made optional to unblock a new source
      // — which compiles fine and quietly reintroduces a default.
      expect(s.category, "category").toBeTruthy();
      expect(s.discoveryState, "discoveryState").toBeTruthy();
      expect(Array.isArray(s.legacyFingerprints), "legacyFingerprints").toBe(true);
      expect(Array.isArray(s.producers), "producers").toBe(true);
      expect(s.resolutionAuthority, "resolutionAuthority").toBeTruthy();
      expect(ACTIVITY_PROBE_KEYS, "activityProbeKey").toContain(
        s.activityProbeKey,
      );
      expect(s.recoveryPolicy, "recoveryPolicy").toBeTruthy();
      expect(s.recurrencePolicy, "recurrencePolicy").toBeTruthy();
      expect(s.suppressionPolicy, "suppressionPolicy").toBeTruthy();
      expect(s.remediationDisposition, "remediationDisposition").toBeTruthy();
      expect(s.requiredCapability, "requiredCapability").toBeTruthy();
      expect(s.audience, "audience").toBeTruthy();
      expect(s.cardinality, "cardinality").toBeTruthy();
      expect(s.workspaceApplicability, "workspaceApplicability").toBeTruthy();
      expect(s.metricContract, "metricContract").toBeTruthy();
      expect(s.drillDownContract, "drillDownContract").toBeTruthy();
      expect(s.notApplicableDisposition, "notApplicableDisposition").toBeTruthy();
      // The one field that cannot be enforced by a type: a stated reason.
      expect(s.rationale.length, "rationale").toBeGreaterThan(30);
    },
  );

  it("source ids are unique and match the discovery registry exactly", () => {
    const ids = operationsSourceIds();
    expect(new Set(ids).size).toBe(ids.length);
    // The two lists describe the same twenty-two sources from two angles. The
    // registry itself throws at module load if they disagree; this states the
    // property where a reader will find it.
    expect([...ids].sort()).toEqual(
      [...OPERATIONS_SOURCES.map((s) => s.id)].sort(),
    );
  });

  it("SOURCE_TRUTH always names a real probe; nothing else claims one", () => {
    for (const s of OPERATIONS_SOURCE_LIFECYCLES) {
      if (s.resolutionAuthority === "SOURCE_TRUTH") {
        // A source cannot claim its truth is observable without naming the
        // observation. This is what stops SOURCE_TRUTH becoming a way to
        // refuse operators on a basis nothing can check.
        expect(s.activityProbeKey, s.sourceId).not.toBe("NONE");
      } else {
        expect(s.activityProbeKey, s.sourceId).toBe("NONE");
      }
    }
  });

  it("every declared probe key has an implementation, and vice versa", () => {
    const implemented = new Set(implementedProbeKeys());
    for (const key of ACTIVITY_PROBE_KEYS) {
      expect(implemented.has(key), `no handler for ${key}`).toBe(true);
    }
    // No handler for a key the contract does not declare: an orphan handler is
    // dead code that looks like coverage.
    for (const key of implemented) {
      expect(ACTIVITY_PROBE_KEYS, `orphan handler ${key}`).toContain(key);
    }
  });

  it("SAFE_REMEDIATION never implies OPERATOR_DECISION", () => {
    // The conflation the closure removed, stated as a property. Remediation
    // says what an operator may DO; resolution says whether they may declare it
    // OVER. `pipeline.report_backlog` is the proof they come apart: a real
    // regenerate action AND source-truth resolution.
    const backlog = lifecycleForSourceId("pipeline.report_backlog")!;
    expect(backlog.remediationDisposition).toBe("SAFE_REMEDIATION");
    expect(backlog.resolutionAuthority).toBe("SOURCE_TRUTH");
    expect(offersManualResolution(backlog)).toBe(false);
    // …and the other direction: no safe remediation, still source-truth.
    const tsa = lifecycleForSourceId("evidence_integrity.tsa_failed")!;
    expect(tsa.remediationDisposition).toBe("NO_SAFE_REMEDIATION_AUTHORITY");
    expect(tsa.resolutionAuthority).toBe("SOURCE_TRUTH");
  });

  it("the sources the brief names as deterministic are all SOURCE_TRUTH", () => {
    for (const id of [
      "evidence_integrity.tsa_failed",
      "evidence_integrity.ots_failed",
      "evidence_integrity.ots_pending_aged",
      "pipeline.report_backlog",
      "pipeline.package_backlog",
      "pipeline.signed_without_report_aged",
      "review.stale_workflows",
      "coordination.backlog_stale",
      "queue.retry_storm",
      "platform.telemetry_stale",
      "platform.worker_heartbeat_stale",
    ]) {
      expect(lifecycleForSourceId(id)!.resolutionAuthority, id).toBe(
        "SOURCE_TRUTH",
      );
    }
  });

  it("no tenant-advisory or platform source offers a Resolve control", () => {
    for (const s of OPERATIONS_SOURCE_LIFECYCLES) {
      if (s.audience === "TENANT_ACTIONABLE") continue;
      expect(offersManualResolution(s), s.sourceId).toBe(false);
    }
  });

  it("only AGGREGATE sources carry a metric", () => {
    for (const s of OPERATIONS_SOURCE_LIFECYCLES) {
      if (!sourceCarriesMetric(s)) continue;
      expect(s.cardinality, s.sourceId).toBe("AGGREGATE");
      // A number with no threshold cannot be rendered honestly, and every
      // metric-bearing source has a probe to refresh it.
      expect(s.activityProbeKey, s.sourceId).not.toBe("NONE");
    }
  });
});

// ===========================================================================
// 2. IDENTITY — fingerprint first, category never alone
// ===========================================================================

describe("§2 — a condition resolves to its source by DECLARED id", () => {
  it("a declared sourceId wins, and the fingerprint is not consulted", () => {
    // The correction: identity is DECLARED, not inferred. A row carrying a
    // source id resolves to that source even when its fingerprint looks like
    // another's — which is what stops a writer's chosen string from being
    // load-bearing policy.
    const r = resolveConditionSource({
      sourceId: "pipeline.report_backlog",
      category: "EVIDENCE_INTEGRITY",
      fingerprint: "tsa_failure:abc12345",
    });
    expect(r.match).toBe("DECLARED");
    expect(r.lifecycle.sourceId).toBe("pipeline.report_backlog");
  });

  it.each(
    aggregateSpecs().map((s) => [s.sourceId, aggregateFingerprint(s, TEAM)] as const),
  )("%s is matched by its own fingerprint, not by its category", (id, fp) => {
    const spec = aggregateSpecs().find((s) => s.sourceId === id)!;
    const resolved = resolveConditionSource({
      category: spec.category,
      fingerprint: fp,
    });
    // A row written BEFORE `source_id` existed. One pattern, one source.
    expect(resolved.match).toBe("LEGACY_FINGERPRINT");
    expect(resolved.lifecycle.sourceId).toBe(id);
  });

  it("four sources write category WORKER and the fingerprint tells them apart", () => {
    // The precise reason a category-keyed rule could not work. All four are
    // WORKER; all four resolve to different sources.
    const workerSources = aggregateSpecs().filter((s) => s.category === "WORKER");
    expect(workerSources.length).toBeGreaterThanOrEqual(4);
    const resolved = workerSources.map(
      (s) =>
        resolveConditionSource({
          category: "WORKER",
          fingerprint: aggregateFingerprint(s, TEAM),
        }).lifecycle.sourceId,
    );
    expect(new Set(resolved).size).toBe(workerSources.length);
  });

  it("per-record integrity fingerprints resolve to their own class", () => {
    expect(
      resolveConditionSource({
        category: "EVIDENCE_INTEGRITY",
        fingerprint: "tsa_failure:abc",
      }).lifecycle.sourceId,
    ).toBe("evidence_integrity.tsa_failed");
    expect(
      resolveConditionSource({
        category: "EVIDENCE_INTEGRITY",
        fingerprint: "ots_failure:abc",
      }).lifecycle.sourceId,
    ).toBe("evidence_integrity.ots_failed");
    // …and the third class, which used to have no producer at all.
    expect(
      resolveConditionSource({
        category: "EVIDENCE_INTEGRITY",
        fingerprint: "ots_pending_aged:abc",
      }).lifecycle.sourceId,
    ).toBe("evidence_integrity.ots_pending_aged");
  });

  it("a prefix cannot be matched by a longer neighbour", () => {
    // `dashboard:pipeline:report_backlog_v2:<team>` is NOT the report backlog.
    // The separator is part of the match, so a future source cannot silently
    // inherit this one's probe.
    const r = resolveConditionSource({
      category: "REPORT",
      fingerprint: `dashboard:pipeline:report_backlog_v2:${TEAM}`,
    });
    expect(r.lifecycle.sourceId).not.toBe("pipeline.report_backlog");
  });

  it("an unidentifiable condition FAILS CLOSED — never OPERATOR_DECISION", () => {
    // THE DEFECT THIS REPLACES. The unregistered contract used to be
    // OPERATOR_DECISION, so a condition the system could not identify was the
    // most closable kind there is: not knowing what something was made it
    // MORE resolvable.
    const r = resolveConditionSource({
      category: "REPORT",
      fingerprint: "something:nobody:registered",
    });
    expect(r.match).toBe("UNREGISTERED");
    expect(r.lifecycle).toBe(UNREGISTERED_CONDITION_LIFECYCLE);
    expect(r.lifecycle.resolutionAuthority).toBe("NO_DIRECT_RESOLUTION");
    expect(offersManualResolution(r.lifecycle)).toBe(false);
    // …and it names itself, so the gap reaches the people who can register it.
    expect(r.diagnostic).toBe("UNREGISTERED_CONDITION_SOURCE");
  });

  it("an UNKNOWN sourceId fails closed exactly like an absent one", () => {
    for (const sourceId of [undefined, null, "", "totally.made_up"]) {
      const r = resolveConditionSource({
        sourceId,
        category: "WORKER",
        fingerprint: "nothing:matches:this",
      });
      expect(r.lifecycle.resolutionAuthority, String(sourceId)).toBe(
        "NO_DIRECT_RESOLUTION",
      );
      expect(r.match, String(sourceId)).toBe("UNREGISTERED");
    }
  });

  it("CATEGORY IS NEVER CONSULTED — not even as a last resort", () => {
    // Every category, with a fingerprint nothing claims. If category were
    // still a fallback, at least one of these would resolve to a real source.
    for (const category of [
      "UPLOAD",
      "REPORT",
      "PACKAGE",
      "WEBHOOK",
      "COMMUNICATIONS",
      "IDENTITY_SECURITY",
      "GOVERNANCE",
      "STORAGE",
      "AI",
      "INTEGRATION",
      "DATABASE",
      "WORKER",
      "RECONCILIATION",
      "EVIDENCE_INTEGRITY",
    ]) {
      const r = resolveConditionSource({
        category,
        fingerprint: "unclaimed_prefix_xyz:subject",
      });
      expect(r.match, category).toBe("UNREGISTERED");
    }
  });

  it("no source anywhere in the registry falls back to OPERATOR_DECISION", () => {
    // OPERATOR_DECISION is only ever reached by an explicit, per-source
    // declaration with a required written conclusion — never as a default.
    for (const s of OPERATIONS_SOURCE_LIFECYCLES) {
      if (s.resolutionAuthority !== "OPERATOR_DECISION") continue;
      expect(s.requiresResolutionNote, s.sourceId).toBe(true);
      expect(s.audience, s.sourceId).toBe("TENANT_ACTIONABLE");
      expect(s.rationale.length, s.sourceId).toBeGreaterThan(30);
    }
    expect(UNREGISTERED_CONDITION_LIFECYCLE.resolutionAuthority).not.toBe(
      "OPERATOR_DECISION",
    );
  });

  it("no two sources claim the same legacy fingerprint pattern", () => {
    // The registry throws at load if they do — a backfill that had to GUESS
    // which of two sources a fingerprint meant would be guessing a lifecycle.
    // Stated here so the property is where a reader looks for it.
    const claimed = OPERATIONS_SOURCE_LIFECYCLES.flatMap((s) =>
      s.legacyFingerprints.map((p) =>
        p.kind === "PREFIX" ? `P:${p.prefix}` : `E:${p.fingerprint}`,
      ),
    );
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});

// ===========================================================================
// 3. THE MANUAL-RESOLUTION CONTRACT, PER SOURCE
// ===========================================================================

describe("§13.2 — every source's manual-resolution contract, one row each", () => {
  const ACTIVITIES = ["ACTIVE", "RECOVERED", "UNKNOWN", "NOT_APPLICABLE"] as const;

  it.each(OPERATIONS_SOURCE_LIFECYCLES.map((s) => [s.sourceId, s] as const))(
    "%s answers every probe result exactly as its contract states",
    (_id, s: OperationsSourceLifecycle) => {
      for (const activity of ACTIVITIES) {
        const decision = decideManualResolution({
          currentStatus: "OPEN",
          authority: s.resolutionAuthority,
          activity,
          notApplicableDisposition: s.notApplicableDisposition,
        });
        const code = manualResolutionErrorCode(decision);

        if (s.resolutionAuthority === "NO_DIRECT_RESOLUTION") {
          // Refused on the CONTRACT, before any probe is consulted — so the
          // answer is the same for all four activities.
          expect(code, `${s.sourceId}/${activity}`).toBe(
            "CONDITION_NOT_DIRECTLY_RESOLVABLE",
          );
          continue;
        }
        if (s.resolutionAuthority === "OPERATOR_DECISION") {
          // Never probed, never refused on a technical fact.
          expect(code, `${s.sourceId}/${activity}`).toBeNull();
          continue;
        }
        // SOURCE_TRUTH — four different answers, none of them collapsed.
        if (activity === "RECOVERED") {
          expect(code, `${s.sourceId}/RECOVERED`).toBeNull();
        } else if (activity === "ACTIVE") {
          expect(code, `${s.sourceId}/ACTIVE`).toBe("CONDITION_STILL_ACTIVE");
        } else if (activity === "UNKNOWN") {
          expect(code, `${s.sourceId}/UNKNOWN`).toBe(
            "CONDITION_ACTIVITY_UNKNOWN",
          );
        } else {
          expect(
            code,
            `${s.sourceId}/NOT_APPLICABLE must follow its declared disposition`,
          ).toBe(
            s.notApplicableDisposition === "ALLOW_OPERATOR_CLOSE"
              ? null
              : "CONDITION_ACTIVITY_UNKNOWN",
          );
        }
      }
    },
  );

  it("a SOURCE_TRUTH condition with NO observation fails closed", () => {
    // The branch that turns a database fault into a refusal rather than a
    // false all-clear. `null` and `undefined` are both "nothing was observed".
    for (const activity of [null, undefined]) {
      expect(
        manualResolutionErrorCode(
          decideManualResolution({
            currentStatus: "OPEN",
            authority: "SOURCE_TRUTH",
            activity,
            notApplicableDisposition: "REFUSE",
          }),
        ),
      ).toBe("CONDITION_ACTIVITY_UNKNOWN");
    }
  });

  it("an aggregate source's NOT_APPLICABLE never resolves anything", () => {
    // A workspace-level count cannot become unidentifiable, so NOT_APPLICABLE
    // there means the probe is wrong — and a wrong probe must not close a
    // condition.
    for (const s of OPERATIONS_SOURCE_LIFECYCLES) {
      if (s.cardinality !== "AGGREGATE") continue;
      expect(s.notApplicableDisposition, s.sourceId).toBe("REFUSE");
    }
  });

  it("a per-record source's deleted subject stays closable", () => {
    // The opposite case, and the reason the disposition is declared per source
    // rather than assumed: a condition whose record is gone can never be
    // observed active again, so refusing it would leave it unclosable forever.
    for (const s of OPERATIONS_SOURCE_LIFECYCLES) {
      if (s.cardinality !== "PER_RECORD") continue;
      expect(s.notApplicableDisposition, s.sourceId).toBe(
        "ALLOW_OPERATOR_CLOSE",
      );
    }
  });
});

// ===========================================================================
// 4. THRESHOLDS AND SEVERITY, RECOMPUTED
// ===========================================================================

describe("§6/§7 — thresholds and posture are recomputed, never remembered", () => {
  it("the report backlog is active at 20 and critical at 100", () => {
    const spec = aggregateSpecs().find(
      (s) => s.sourceId === "pipeline.report_backlog",
    )!;
    expect(spec.thresholdValue).toBe(20);
    expect(spec.criticalThresholdValue).toBe(100);
    expect(severityForAggregate(spec, 19)).toBe("HIGH");
    expect(severityForAggregate(spec, 26)).toBe("HIGH");
    expect(severityForAggregate(spec, 99)).toBe("HIGH");
    expect(severityForAggregate(spec, 100)).toBe("CRITICAL");
    // …and DOWN again. A backlog that falls from 140 to 40 is HIGH now, not
    // CRITICAL-because-it-once-was.
    expect(severityForAggregate(spec, 40)).toBe("HIGH");
  });

  it("every aggregate spec has a distinct fingerprint prefix and a count-free title", () => {
    const specs = aggregateSpecs();
    expect(new Set(specs.map((s) => s.fingerprintPrefix)).size).toBe(
      specs.length,
    );
    for (const s of specs) {
      expect(s.stableTitle, s.sourceId).not.toMatch(/\d/);
      // The fingerprint is built from the prefix and the workspace, and holds
      // no count — so a changing value can never mint a second condition.
      expect(aggregateFingerprint(s, TEAM)).toBe(`${s.fingerprintPrefix}:${TEAM}`);
      expect(aggregateFingerprint(s, TEAM)).not.toMatch(/\(\d+\)/);
    }
  });

  it("every aggregate spec's source declares AGGREGATE_THRESHOLD or AGE_THRESHOLD", () => {
    for (const s of aggregateSpecs()) {
      const lifecycle = lifecycleForSourceId(s.sourceId)!;
      expect(lifecycle.metricContract, s.sourceId).not.toBe("NONE");
      expect(lifecycle.activityProbeKey, s.sourceId).toBe(s.probeKey);
    }
  });
});
