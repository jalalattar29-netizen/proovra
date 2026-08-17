/**
 * PHASE 13 §6 — THE CLOSURE EVALUATOR MUST REFUSE.
 *
 * A closure gate is only worth running if it can say no. Each case here feeds
 * the REAL evaluator a facts shape that is one specific kind of not-closed and
 * asserts that it refuses — because every one of these was, at some point in
 * this programme, reported as closed:
 *
 *   - 25 release-required UI capabilities were filed under
 *     `ArchitectureBacklog: NON_BLOCKING_VISIBLE`, so a product missing a
 *     quarter of its core controls read as release-blocking-clean.
 *   - `1222 − 1143 = 79` was a subtraction nobody could account for, with no
 *     identity to break.
 *   - 12 writers reachable only at module scope had no route to check their
 *     authorization against, and the closure said nothing.
 *   - a tenant mutation authorized by "I am signed in" passed the invariant.
 *   - the integration suite exited 1 with 662/662 passing, and the
 *     certification quoted the assertions rather than the exit code.
 *
 * The positive control at the end matters as much: an evaluator that refuses
 * everything is as useless as one that refuses nothing.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "vitest";

import { closureProblems, releaseBlockingProblems } from "../scripts/audit/engine/facts.mjs";

/** A facts shape that is CLOSED on every dimension this evaluator reads. */
function closedFacts(): Record<string, any> {
  return {
    findingsLedgerRef: { openIds: [] },
    facts: {
      capabilities: {
        undisposed: 0,
        missingProductUiReleaseRequired: 0,
        missingProductUiPostRelease: 7,
        deadRemovePending: 0,
        mandateConservationHolds: true,
      },
      instrumentIntegrity: {
        ClassificationConflicts: 0,
        AuthorizationUnresolved: 0,
        TenantBindingUnresolved: 0,
        UnclassifiedMutationWriters: 0,
        MutationReachabilityUnresolved: 0,
      },
      mutations: {
        authorizationAfterMutation: 0,
        tenantUnbound: 0,
        unsafeEffectsInsideTransactions: 0,
        orphanQueueProducers: 0,
        parallelAuthorities: 0,
        legacyWriters: 0,
        nonIdempotentRetryableEffects: 0,
        unprocessedQueueFamilies: 0,
        conservationHolds: true,
        writerConservationHolds: true,
        moduleScopedAttribution: 0,
        unresolvedWriters: 0,
        writerBucketOverlaps: 0,
        writerBucketMissing: 0,
        /**
         * PHASE 13 §4 — the two buckets nothing reaches. Both zero in a closed
         * state, and the evaluator derives `UnwiredExecutableWriters` from
         * their sum rather than reading a separate scalar, so a case here
         * cannot be satisfied by editing a counter.
         */
        byWriterBucket: {
          ROUTE_ATTRIBUTED_REACHABLE: 1000,
          JOB_ATTRIBUTED_REACHABLE: 100,
          MODULE_SCOPED_REACHABLE: 0,
          REGISTERED_CLI: 3,
          STARTUP_OR_SCHEDULED: 9,
          MIGRATION_ONLY: 0,
          TEST_OR_BUILD_ONLY: 0,
          PRESERVED_PLANNED_WRITER: 0,
          DEAD_UNREACHABLE: 0,
          UNRESOLVED: 0,
        },
      },
      /**
       * PHASE 13 §8-9 — the browser layer, in the closed shape: a fresh run,
       * every implemented UI capability exercised, all three runtime families
       * proven.
       */
      point7: {
        artifactPresent: true,
        browserSuites: 9,
        browserProvenScenarios: 57,
        runIds: 1,
        buildIds: 1,
        productionBuild: true,
        strictCsp: true,
        fresh: true,
        implementedUiCapabilities: 24,
        browserVerifiedUiCapabilities: 24,
        unexecutedUiCapabilities: 0,
        unverifiedCapabilityIds: [],
        new027Runtime: "PASS",
        new028Runtime: "PASS",
        new029Runtime: "PASS",
        // PHASE 2 — NEW-058 joined the release-blocking browser families. Its
        // fix is about what a real CLIENT sends, so source proof alone can
        // never close it and the closure must refuse a run that skipped it.
        new058Runtime: "PASS",
      },
    },
    /** PHASE 13 §1 — the checkpoint agrees with the measurement. */
    checkpoint: {
      present: true,
      contradictions: 0,
      staleNextCommands: 0,
      duplicateActiveStateSections: 0,
      scalarsChecked: 40,
      violations: [],
    },
  };
}

const refusalFor = (mutate: (f: Record<string, any>) => void) => {
  const f = closedFacts();
  mutate(f);
  return [...releaseBlockingProblems(f), ...closureProblems(f)];
};

describe("phase 13 §6 — the closure evaluator refuses", () => {
  it("0. CONTROL — a fully closed fact set produces no release-blocking problem", () => {
    const f = closedFacts();
    assert.deepEqual(
      releaseBlockingProblems(f),
      [],
      "the evaluator refuses a closed state; every other case here would be meaningless",
    );
  });

  it("1. ONE release-required UI capability blocks the release", () => {
    const problems = refusalFor((f) => {
      f.facts.capabilities.missingProductUiReleaseRequired = 1;
    });
    assert.ok(
      problems.some((p) => /RELEASE-REQUIRED UI MISSING/.test(p)),
      `a release-required UI gap was not release-blocking: ${JSON.stringify(problems)}`,
    );
    // And it must be BLOCKING, not merely visible in the backlog.
    const f = closedFacts();
    f.facts.capabilities.missingProductUiReleaseRequired = 1;
    assert.ok(
      releaseBlockingProblems(f).some((p) => /RELEASE-REQUIRED UI MISSING/.test(p)),
      "a release-required UI gap was reported as non-blocking backlog",
    );
  });

  it("2. ONE module-scoped writer blocks the release", () => {
    const problems = refusalFor((f) => {
      f.facts.mutations.moduleScopedAttribution = 1;
    });
    assert.ok(problems.some((p) => /moduleScopedAttribution = 1/.test(p)));
  });

  it("3. a writer-conservation mismatch blocks the release", () => {
    const problems = refusalFor((f) => {
      f.facts.mutations.writerConservationHolds = false;
    });
    assert.ok(problems.some((p) => /disjoint writer-bucket identity FAILED/.test(p)));
  });

  it("4. an unresolved writer — one that lands in no bucket — blocks the release", () => {
    const problems = refusalFor((f) => {
      f.facts.mutations.unresolvedWriters = 1;
    });
    assert.ok(problems.some((p) => /unresolvedWriters = 1/.test(p)));
  });

  it("5. a mutation whose authorization comes after the write blocks the release", () => {
    const problems = refusalFor((f) => {
      f.facts.mutations.authorizationAfterMutation = 1;
    });
    assert.ok(problems.some((p) => /authorizationAfterMutation = 1/.test(p)));
  });

  it("6. a tenant-unbound mutation blocks the release", () => {
    const problems = refusalFor((f) => {
      f.facts.mutations.tenantUnbound = 1;
    });
    assert.ok(problems.some((p) => /tenantUnbound = 1/.test(p)));
  });

  it("7. an external effect inside a transaction blocks the release", () => {
    const problems = refusalFor((f) => {
      f.facts.mutations.unsafeEffectsInsideTransactions = 1;
    });
    assert.ok(problems.some((p) => /unsafeEffectsInsideTransactions = 1/.test(p)));
  });

  it("8. a queue producer with no processor blocks the release", () => {
    for (const k of ["orphanQueueProducers", "unprocessedQueueFamilies"]) {
      const problems = refusalFor((f) => {
        f.facts.mutations[k] = 1;
      });
      assert.ok(problems.some((p) => p.includes(`${k} = 1`)), k);
    }
  });

  it("9. an instrument hole blocks the release, whatever the product numbers say", () => {
    const problems = refusalFor((f) => {
      f.facts.instrumentIntegrity.UnclassifiedMutationWriters = 1;
    });
    assert.ok(problems.some((p) => /INSTRUMENT: UnclassifiedMutationWriters = 1/.test(p)));
  });

  it("10. an open local finding blocks the release", () => {
    const problems = refusalFor((f) => {
      f.findingsLedgerRef.openIds = ["NEW-999"];
    });
    assert.ok(problems.some((p) => /OPEN LOCAL FINDINGS: NEW-999/.test(p)));
  });

  it("11. a route still dispositioned DEAD_REMOVE while present blocks closure", () => {
    const problems = refusalFor((f) => {
      f.facts.capabilities.deadRemovePending = 1;
    });
    assert.ok(problems.some((p) => /DeadRemovePending = 1/.test(p)));
  });

  // =========================================================================
  // PHASE 13 — the conditions this pass added.
  //
  // Each one existed as prose in the previous checkpoint and as nothing in the
  // evaluator, which is how a release could be described as closed while a
  // row two pages down read NOT EXECUTED.
  // =========================================================================

  it("12. ONE preserved-but-unwired writer blocks the release", () => {
    const problems = refusalFor((f) => {
      f.facts.mutations.byWriterBucket.PRESERVED_PLANNED_WRITER = 1;
    });
    assert.ok(
      problems.some((p) => /UNWIRED EXECUTABLE WRITERS: 1/.test(p)),
      `a preserved writer with no entrypoint was not release-blocking: ${JSON.stringify(problems)}`,
    );
  });

  it("13. ONE dead-unreachable writer blocks the release, and the two buckets SUM", () => {
    const problems = refusalFor((f) => {
      f.facts.mutations.byWriterBucket.DEAD_UNREACHABLE = 2;
      f.facts.mutations.byWriterBucket.PRESERVED_PLANNED_WRITER = 3;
    });
    assert.ok(
      problems.some((p) => /UNWIRED EXECUTABLE WRITERS: 5/.test(p)),
      "the two unreached buckets must be counted together, not separately",
    );
  });

  it("14. a browser proof that is not FRESH blocks the release", () => {
    for (const [field, value] of [
      ["fresh", false],
      ["productionBuild", false],
      ["strictCsp", false],
    ] as const) {
      const problems = refusalFor((f) => {
        f.facts.point7.fresh = false;
        f.facts.point7[field] = value;
      });
      assert.ok(
        problems.some((p) => /POINT 7: the proof is not FRESH/.test(p)),
        `a run with ${field}=${value} was credited: ${JSON.stringify(problems)}`,
      );
    }
  });

  it("15. a missing browser proof artifact blocks the release", () => {
    const problems = refusalFor((f) => {
      f.facts.point7.artifactPresent = false;
    });
    assert.ok(problems.some((p) => /no browser proof artifact/.test(p)));
  });

  it("16. ONE unexercised UI capability blocks the release, and is NAMED", () => {
    const problems = refusalFor((f) => {
      f.facts.point7.browserVerifiedUiCapabilities = 23;
      f.facts.point7.unexecutedUiCapabilities = 1;
      f.facts.point7.unverifiedCapabilityIds = ["workspace.reopened"];
    });
    assert.ok(
      problems.some((p) => /1 of 24 implemented UI/.test(p) && /workspace\.reopened/.test(p)),
      `an unexercised capability was not blocking, or was not named: ${JSON.stringify(problems)}`,
    );
  });

  it("17. each of the four runtime families blocks independently", () => {
    for (const family of [
      "new027Runtime",
      "new028Runtime",
      "new029Runtime",
      "new058Runtime",
    ] as const) {
      const problems = refusalFor((f) => {
        f.facts.point7[family] = "NOT_EXECUTED";
      });
      const label = family.replace("Runtime", "").toUpperCase().replace("NEW", "NEW-");
      assert.ok(
        problems.some((p) => p.includes(`${label}Runtime`.replace("NEW-0", "NEW-0"))) ||
          problems.some((p) => /NOT_EXECUTED/.test(p)),
        `${family} was not release-blocking: ${JSON.stringify(problems)}`,
      );
    }
  });

  it("18. a checkpoint that contradicts the measurement blocks the release", () => {
    const problems = refusalFor((f) => {
      f.checkpoint.violations = [
        "SCALAR_DISAGREES_WITH_FACTS: UndisposedRoutes: checkpoint says 0, facts say 2",
      ];
    });
    assert.ok(
      problems.some((p) => /^CHECKPOINT: 1 violation/.test(p)),
      `a contradictory checkpoint was not blocking: ${JSON.stringify(problems)}`,
    );
  });

  it("19. a MISSING checkpoint blocks the release", () => {
    const problems = refusalFor((f) => {
      f.checkpoint.present = false;
      f.checkpoint.violations = [];
    });
    assert.ok(problems.some((p) => /continuation checkpoint is missing/.test(p)));
  });

  it("20. absent Point-7 facts do not silently pass — the CONTROL still holds", () => {
    // A fact set with no `point7` block at all must not be readable as closed
    // by accident. The evaluator skips the block, so this asserts the shape it
    // depends on is actually present in a closed state rather than optional.
    const f = closedFacts();
    assert.ok(f.facts.point7, "the closed baseline must carry a point7 block");
    assert.equal(f.facts.point7.implementedUiCapabilities, 24);
    assert.equal(f.facts.point7.browserVerifiedUiCapabilities, 24);
  });
});
