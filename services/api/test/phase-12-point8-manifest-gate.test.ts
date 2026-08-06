/**
 * PHASE 12 — POINT 8, STEP 5: the manifest gate's fifteen refusals.
 *
 * A gate whose only evidence is that it passed once has not been shown to be
 * capable of failing. Point 7 shipped a closure evaluator with eleven negative
 * cases for exactly that reason, and two of them caught real defects (a ledger
 * matcher looking for `DENIED` where the guard writes `BLOCKED`; a journey
 * passing off a database read as a delivered email).
 *
 * So each of the fifteen conditions the Point-8 mandate requires the gate to
 * reject is proved here by CORRUPTING a valid manifest in exactly that one way
 * and asserting the specific rejection fires. R0 proves the baseline is
 * genuinely clean, without which every other case would be vacuous.
 *
 * Nothing here connects to anything. The gate is a pure function.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  evaluatePoint8Manifest,
  POINT8_GATE_IDS,
  REQUIRED_SCENARIOS,
  type EvidenceArtifact,
  type GateRecord,
  type Point8GateId,
  type Point8Manifest,
} from "./point8/manifest-gate.js";

const RC = "rc-" + createHash("sha256").update("point8-test-release-candidate").digest("hex");
const RUN = "p8run-0000-1111-2222";
const BUILDS = { api: "api-digest", worker: "worker-digest", web: "web-digest", releaseCandidate: RC };

/** The full evidence chain a real gate produces. */
function chain(gateId: string): EvidenceArtifact[] {
  return [
    {
      artifactId: `${gateId}:request`,
      kind: "live-provider-request",
      scenarioId: REQUIRED_SCENARIOS[gateId as Point8GateId][0]!,
      destinationCategory: "provider-sandbox-endpoint",
    },
    {
      artifactId: `${gateId}:callback`,
      kind: "live-provider-callback",
      scenarioId: REQUIRED_SCENARIOS[gateId as Point8GateId][1]!,
      providerAcknowledgementAlias: "ack-alias-01",
      destinationCategory: "provider-sandbox-endpoint",
    },
    {
      artifactId: `${gateId}:durable`,
      kind: "live-durable-state",
      scenarioId: REQUIRED_SCENARIOS[gateId as Point8GateId][2]!,
      durableStateCheck: "workspace commercial state row transitioned",
    },
    {
      artifactId: `${gateId}:browser`,
      kind: "live-browser-projection",
      scenarioId: REQUIRED_SCENARIOS[gateId as Point8GateId][3]!,
      destinationCategory: "staging-named-host",
    },
    {
      artifactId: `${gateId}:audit`,
      kind: "live-audit-record",
      scenarioId: REQUIRED_SCENARIOS[gateId as Point8GateId][4]!,
      durableStateCheck: "custody entry appended",
    },
  ];
}

function gateRecord(gateId: Point8GateId): GateRecord {
  return {
    gateId,
    status: "PASS",
    runId: RUN,
    buildIds: { ...BUILDS },
    stagingEnvironmentAlias: "staging-alpha",
    providerMode: "sandbox",
    scenarioIds: [...REQUIRED_SCENARIOS[gateId]],
    evidenceArtifacts: chain(gateId),
    durableStateChecks: ["durable state observed"],
    browserResult: "server projection matched",
    cleanupDisposition: "run-owned objects deleted; none retained",
  };
}

/** A manifest that SHOULD pass. Every negative case starts from a clone of it. */
function validManifest(): Point8Manifest {
  return {
    point8RunId: RUN,
    releaseCandidateId: RC,
    stagingEnvironmentAlias: "staging-alpha",
    strictCspEnabled: true,
    databaseMigrationBoundary: "release-A+B (18 SAFE_TO_APPLY_NOW)",
    gates: POINT8_GATE_IDS.map(gateRecord),
  };
}

const clone = (m: Point8Manifest): Point8Manifest => JSON.parse(JSON.stringify(m)) as Point8Manifest;

function evaluate(manifest: Point8Manifest, extra: Partial<Parameters<typeof evaluatePoint8Manifest>[0]> = {}) {
  return evaluatePoint8Manifest({
    manifest,
    releaseCandidateId: RC,
    censusUnknownSelections: 0,
    ...extra,
  });
}

/** Assert the gate refused, and refused for the stated reason. */
function expectRejection(result: ReturnType<typeof evaluate>, rejection: number) {
  expect(result.ok).toBe(false);
  expect(result.failures.map((f) => f.rejection)).toContain(rejection);
}

describe("PHASE 12 — POINT 8: the manifest gate refuses each of the fifteen conditions", () => {
  it("R0 — the baseline manifest is genuinely clean (without this every case below is vacuous)", () => {
    const r = evaluate(validManifest());
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.metrics.gatesPassed).toBe(POINT8_GATE_IDS.length);
    expect(r.metrics.requiredLiveGateSkips).toBe(0);
  });

  it("R1 — a unit/mock artifact credited as live", () => {
    const m = clone(validManifest());
    m.gates[0]!.evidenceArtifacts = [
      { artifactId: "unit", kind: "unit-test", scenarioId: REQUIRED_SCENARIOS["postgres-live"][0]! },
    ];
    expectRejection(evaluate(m), 1);
  });

  it("R2 — production provider mode", () => {
    const m = clone(validManifest());
    m.gates[3]!.providerMode = "production";
    expectRejection(evaluate(m), 2);
  });

  it("R3 — mixed build IDs across gates", () => {
    const m = clone(validManifest());
    m.gates[5]!.buildIds.api = "a-different-api-digest";
    expectRejection(evaluate(m), 3);
  });

  it("R4 — a gate carrying an old run id", () => {
    const m = clone(validManifest());
    m.gates[2]!.runId = "p8run-from-a-previous-attempt";
    expectRejection(evaluate(m), 4);
  });

  it("R5 — missing provider callback/acknowledgement", () => {
    const m = clone(validManifest());
    m.gates[4]!.evidenceArtifacts = m.gates[4]!.evidenceArtifacts.filter(
      (a) => a.kind !== "live-provider-callback",
    );
    expectRejection(evaluate(m), 5);
  });

  it("R6 — missing durable state evidence", () => {
    const m = clone(validManifest());
    m.gates[6]!.evidenceArtifacts = m.gates[6]!.evidenceArtifacts.filter(
      (a) => a.kind !== "live-durable-state",
    );
    m.gates[6]!.durableStateChecks = [];
    expectRejection(evaluate(m), 6);
  });

  it("R7 — browser-only proof", () => {
    const m = clone(validManifest());
    m.gates[7]!.evidenceArtifacts = m.gates[7]!.evidenceArtifacts.filter(
      (a) => a.kind === "live-browser-projection",
    );
    m.gates[7]!.durableStateChecks = [];
    expectRejection(evaluate(m), 7);
  });

  it("R8 — database-only proof", () => {
    const m = clone(validManifest());
    m.gates[8]!.evidenceArtifacts = m.gates[8]!.evidenceArtifacts.filter(
      (a) => a.kind === "live-durable-state" || a.kind === "live-audit-record",
    );
    expectRejection(evaluate(m), 8);
  });

  it("R9 — a skipped required provider", () => {
    const m = clone(validManifest());
    m.gates = m.gates.filter((g) => g.gateId !== "scim-live-client");
    const r = evaluate(m);
    expectRejection(r, 9);
    expect(r.failures.some((f) => f.gateId === "scim-live-client")).toBe(true);
  });

  it("R10 — an unknown credential classification anywhere in the census", () => {
    expectRejection(evaluate(validManifest(), { censusUnknownSelections: 23 }), 10);
  });

  it("R11 — a missing cleanup disposition", () => {
    const m = clone(validManifest());
    m.gates[10]!.cleanupDisposition = null;
    expectRejection(evaluate(m), 11);
  });

  it("R12 — an external request to a Production destination", () => {
    expectRejection(
      evaluate(validManifest(), { connectedDestinationCategories: ["provider-sandbox-endpoint", "production"] }),
      12,
    );
  });

  it("R13 — a gate declared pass without its required scenario ids", () => {
    const m = clone(validManifest());
    m.gates[11]!.scenarioIds = m.gates[11]!.scenarioIds.slice(0, 2);
    expectRejection(evaluate(m), 13);
  });

  it("R14 — a provider fake credited as Sandbox", () => {
    const m = clone(validManifest());
    // The tell: it claims a live PROVIDER request, but the request never left
    // the machine. This is the shape a stub server produces.
    m.gates[9]!.evidenceArtifacts[0]!.destinationCategory = "loopback";
    expectRejection(evaluate(m), 14);
  });

  it("R15 — a run that never executed against a Staging environment", () => {
    const m = clone(validManifest());
    m.stagingEnvironmentAlias = null;
    expectRejection(evaluate(m), 15);

    const noCsp = clone(validManifest());
    noCsp.strictCspEnabled = false;
    expectRejection(evaluate(noCsp), 15);

    const wrongRc = clone(validManifest());
    wrongRc.releaseCandidateId = "rc-from-another-tree";
    expectRejection(evaluate(wrongRc), 15);
  });

  it("the fifteen rejections are each reachable — no condition is dead code", () => {
    const reached = new Set<number>();
    const cases: Array<() => ReturnType<typeof evaluate>> = [
      () => {
        const m = clone(validManifest());
        m.gates[0]!.evidenceArtifacts = [{ artifactId: "u", kind: "unit-test", scenarioId: "x" }];
        return evaluate(m);
      },
      () => {
        const m = clone(validManifest());
        m.gates[0]!.providerMode = "production";
        return evaluate(m);
      },
      () => {
        const m = clone(validManifest());
        m.gates[1]!.buildIds.web = "other";
        return evaluate(m);
      },
      () => {
        const m = clone(validManifest());
        m.gates[1]!.runId = "old";
        return evaluate(m);
      },
      () => {
        const m = clone(validManifest());
        m.gates[1]!.evidenceArtifacts = m.gates[1]!.evidenceArtifacts.filter((a) => a.kind !== "live-provider-callback");
        return evaluate(m);
      },
      () => {
        const m = clone(validManifest());
        m.gates[1]!.durableStateChecks = [];
        m.gates[1]!.evidenceArtifacts = m.gates[1]!.evidenceArtifacts.filter((a) => a.kind !== "live-durable-state");
        return evaluate(m);
      },
      () => {
        const m = clone(validManifest());
        m.gates[1]!.evidenceArtifacts = m.gates[1]!.evidenceArtifacts.filter((a) => a.kind === "live-browser-projection");
        m.gates[1]!.durableStateChecks = [];
        return evaluate(m);
      },
      () => {
        const m = clone(validManifest());
        m.gates[1]!.evidenceArtifacts = m.gates[1]!.evidenceArtifacts.filter(
          (a) => a.kind === "live-durable-state" || a.kind === "live-audit-record",
        );
        return evaluate(m);
      },
      () => {
        const m = clone(validManifest());
        m.gates.pop();
        return evaluate(m);
      },
      () => evaluate(validManifest(), { censusUnknownSelections: 1 }),
      () => {
        const m = clone(validManifest());
        m.gates[2]!.cleanupDisposition = null;
        return evaluate(m);
      },
      () => evaluate(validManifest(), { connectedDestinationCategories: ["production"] }),
      () => {
        const m = clone(validManifest());
        m.gates[2]!.scenarioIds = [];
        return evaluate(m);
      },
      () => {
        const m = clone(validManifest());
        m.gates[2]!.evidenceArtifacts[0]!.destinationCategory = "loopback";
        return evaluate(m);
      },
      () => {
        const m = clone(validManifest());
        m.stagingEnvironmentAlias = null;
        return evaluate(m);
      },
    ];
    for (const c of cases) for (const f of c().failures) reached.add(f.rejection);
    expect([...reached].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

describe("PHASE 12 — POINT 8: the gate's verdict on the CURRENT repository state", () => {
  it("an empty manifest — the honest state when no Staging environment exists — is refused, and names every skipped gate", () => {
    const empty: Point8Manifest = {
      point8RunId: RUN,
      releaseCandidateId: RC,
      stagingEnvironmentAlias: null,
      strictCspEnabled: false,
      databaseMigrationBoundary: null,
      gates: [],
    };
    const r = evaluate(empty, { censusUnknownSelections: 23 });
    expect(r.ok).toBe(false);
    expect(r.metrics.gatesPassed).toBe(0);
    expect(r.metrics.requiredLiveGateSkips).toBe(POINT8_GATE_IDS.length);
    // Every one of the fourteen canonical gates is reported absent by name.
    for (const id of POINT8_GATE_IDS) {
      expect(r.failures.some((f) => f.gateId === id && f.rejection === 9)).toBe(true);
    }
  });

  it("declaring the fourteen gates BLOCKED does not manufacture a pass", () => {
    const m = clone(validManifest());
    for (const g of m.gates) {
      g.status = "BLOCKED_OWNER_PREREQUISITE";
      g.blockedBy = ["no Staging environment; no Sandbox provider credentials"];
    }
    const r = evaluate(m, { censusUnknownSelections: 23 });
    expect(r.metrics.gatesPassed).toBe(0);
    expect(r.metrics.gatesBlocked).toBe(POINT8_GATE_IDS.length);
    expect(r.metrics.requiredLiveGateSkips).toBe(POINT8_GATE_IDS.length);
  });
});
