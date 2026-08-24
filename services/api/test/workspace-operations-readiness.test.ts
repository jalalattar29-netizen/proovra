/**
 * §8 / §10 — THE FALSE-CLEAR CONTRACT, AND THE TSA INTEGRITY BOUNDARY.
 *
 * These are the two properties of this phase that are worth proving by
 * ENUMERATION rather than by fixture.
 *
 * The first: "workspace operations are clear" is the single most dangerous
 * sentence this product renders. Every other wrong number is a number an
 * operator can argue with; this one tells them to stop looking. It was
 * previously licensed by `complete` — "did the incident-table read finish?" —
 * which is satisfied by an empty table, and an incident table is empty when
 * nothing has ever scanned the workspace. So the sentence was rendered over
 * workspaces that had never been examined.
 *
 * The second: a failed trusted timestamp cannot be retried. Not "should not" —
 * cannot, because re-contacting the authority mints a token whose genTime is
 * LATER than the evidence it certifies, which is a different and weaker claim
 * wearing the original's name. The test that matters is not that a button is
 * missing; it is that no code path from Operations reaches a provider.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  OPERATIONS_FRESHNESS_WINDOW_MS,
  classifyOperationsReadiness,
  emptySourceAccounting,
  mayAssertOperationsClear,
  safeOperationsFailureCategory,
  type OperationsReadiness,
  type WorkspaceOperationsRunSnapshot,
} from "@proovra/shared-runtime";

import {
  OPERATIONS_SOURCES,
  allSourceIds,
  requiredSourceIds,
  SOURCE_DISPOSITIONS,
} from "../src/services/operations/operations-source-registry.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");

function runAt(
  overrides: Partial<{
    status: "RUNNING" | "SUCCEEDED" | "FAILED" | "PARTIAL";
    startedMinutesAgo: number;
    finishedMinutesAgo: number | null;
    required: string[];
    successful: string[];
    failed: string[];
    truncated: string[];
  }> = {},
) {
  const startedMinutesAgo = overrides.startedMinutesAgo ?? 1;
  const finishedMinutesAgo =
    overrides.finishedMinutesAgo === undefined ? 1 : overrides.finishedMinutesAgo;
  return {
    status: (overrides.status ?? "SUCCEEDED") as never,
    startedAtUtc: new Date(NOW.getTime() - startedMinutesAgo * 60_000),
    finishedAtUtc:
      finishedMinutesAgo === null
        ? null
        : new Date(NOW.getTime() - finishedMinutesAgo * 60_000),
    sources: {
      ...emptySourceAccounting(),
      requiredSources: overrides.required ?? [],
      successfulSources: overrides.successful ?? [],
      failedSources: overrides.failed ?? [],
      truncatedSources: overrides.truncated ?? [],
    },
  };
}

function snapshot(
  readiness: OperationsReadiness,
  sources = emptySourceAccounting(),
): WorkspaceOperationsRunSnapshot {
  return {
    readiness,
    startedAtUtc: NOW.toISOString(),
    completedAtUtc: NOW.toISOString(),
    leaseExpiresAtUtc: null,
    sourceSnapshotAtUtc: NOW.toISOString(),
    sources,
    safeFailureCategory: null,
    recorded: 0,
  };
}

// ---------------------------------------------------------------------------
// §8 — readiness classification.
// ---------------------------------------------------------------------------

describe("§8 — readiness is classified from the durable run, not from silence", () => {
  it("a fresh SUCCEEDED run with every required source successful is READY", () => {
    expect(
      classifyOperationsReadiness(
        runAt({ required: ["a", "b"], successful: ["a", "b"] }),
        NOW,
      ),
    ).toBe("READY");
  });

  it("a RUNNING row inside its lease is RUNNING", () => {
    expect(
      classifyOperationsReadiness(
        runAt({ status: "RUNNING", startedMinutesAgo: 5, finishedMinutesAgo: null }),
        NOW,
      ),
    ).toBe("RUNNING");
  });

  it("a RUNNING row PAST its lease is STALLED, not RUNNING", () => {
    // The distinction is the whole point of the lease. Reporting the wreckage
    // of a process that died holding the lock as "in progress" makes a
    // permanently stuck workspace look permanently busy — and nobody
    // investigates busy.
    expect(
      classifyOperationsReadiness(
        runAt({
          status: "RUNNING",
          startedMinutesAgo: 61 * 24,
          finishedMinutesAgo: null,
        }),
        NOW,
      ),
    ).toBe("STALLED");
  });

  it("a terminal run older than the freshness window is STALE", () => {
    const beyond = OPERATIONS_FRESHNESS_WINDOW_MS / 60_000 + 5;
    expect(
      classifyOperationsReadiness(
        runAt({
          startedMinutesAgo: beyond,
          finishedMinutesAgo: beyond,
          required: ["a"],
          successful: ["a"],
        }),
        NOW,
      ),
    ).toBe("STALE");
  });

  it("a FAILED run is FAILED regardless of how fresh it is", () => {
    expect(classifyOperationsReadiness(runAt({ status: "FAILED" }), NOW)).toBe(
      "FAILED",
    );
  });

  it("a failed source makes an otherwise-successful run PARTIAL", () => {
    expect(
      classifyOperationsReadiness(
        runAt({ required: ["a", "b"], successful: ["a"], failed: ["b"] }),
        NOW,
      ),
    ).toBe("PARTIAL");
  });

  it("a TRUNCATED source makes a run PARTIAL even with nothing failed", () => {
    // A bounded read is not a complete one. This is the case that would
    // otherwise slip through: nothing threw, nothing failed, and the answer is
    // still a floor rather than a total.
    expect(
      classifyOperationsReadiness(
        runAt({ required: ["a"], successful: ["a"], truncated: ["a"] }),
        NOW,
      ),
    ).toBe("PARTIAL");
  });

  it("a required source that was never attempted makes the run PARTIAL", () => {
    // Catches a body that silently stops scanning something. The required set
    // comes from the registry, not from what the run happened to attempt, so
    // "forgot to look" cannot present as "looked and found nothing".
    expect(
      classifyOperationsReadiness(
        runAt({ required: ["a", "b"], successful: ["a"] }),
        NOW,
      ),
    ).toBe("PARTIAL");
  });
});

// ---------------------------------------------------------------------------
// §8 — the false-clear gate, by enumeration.
// ---------------------------------------------------------------------------

describe("§8 — clear may be asserted ONLY under a fresh, complete, READY run", () => {
  const REFUSING_STATES: OperationsReadiness[] = [
    "NEVER_RUN",
    "RUNNING",
    "STALE",
    "FAILED",
    "STALLED",
    "PARTIAL",
  ];

  for (const readiness of REFUSING_STATES) {
    it(`refuses clear under ${readiness}, even with zero unresolved conditions`, () => {
      const verdict = mayAssertOperationsClear({
        run: snapshot(readiness),
        incidentReadComplete: true,
        unresolvedCount: 0,
      });
      expect(verdict.clear).toBe(false);
    });
  }

  it("refuses clear when NO run has ever been recorded", () => {
    // The defect in one line: an empty incident table over a workspace nothing
    // has ever scanned is not an all-clear, it is an unknown.
    const verdict = mayAssertOperationsClear({
      run: null,
      incidentReadComplete: true,
      unresolvedCount: 0,
    });
    expect(verdict).toEqual({ clear: false, reason: "NEVER_RUN" });
  });

  it("refuses clear when the incident read itself was incomplete", () => {
    const verdict = mayAssertOperationsClear({
      run: snapshot("READY"),
      incidentReadComplete: false,
      unresolvedCount: 0,
    });
    expect(verdict).toEqual({
      clear: false,
      reason: "INCIDENT_READ_INCOMPLETE",
    });
  });

  it("refuses clear when unresolved conditions exist", () => {
    const verdict = mayAssertOperationsClear({
      run: snapshot("READY"),
      incidentReadComplete: true,
      unresolvedCount: 3,
    });
    expect(verdict).toEqual({ clear: false, reason: "UNRESOLVED_CONDITIONS" });
  });

  it("refuses clear on a READY run that nonetheless truncated a source", () => {
    // Belt and braces: READY already excludes this, and the gate re-checks so
    // a future change to the classifier cannot quietly widen what clear means.
    const verdict = mayAssertOperationsClear({
      run: snapshot("READY", {
        ...emptySourceAccounting(),
        truncatedSources: ["evidence_integrity.tsa_failed"],
      }),
      incidentReadComplete: true,
      unresolvedCount: 0,
    });
    expect(verdict).toEqual({ clear: false, reason: "TRUNCATED_SOURCE" });
  });

  it("permits clear ONLY on the fully-satisfied combination", () => {
    const verdict = mayAssertOperationsClear({
      run: snapshot("READY"),
      incidentReadComplete: true,
      unresolvedCount: 0,
    });
    expect(verdict).toEqual({ clear: true });
  });
});

describe("§8 — failure categories never leak provider or SQL detail", () => {
  it("reduces an exception to a bounded category", () => {
    expect(safeOperationsFailureCategory(new Error("ETIMEDOUT contacting host"))).toBe(
      "timeout",
    );
    expect(
      safeOperationsFailureCategory(
        new Error('invalid input value for enum "GovernanceReconciliationKind"'),
      ),
    ).toBe("schema_mismatch");
    expect(safeOperationsFailureCategory(new Error("ECONNREFUSED"))).toBe(
      "database_unavailable",
    );
  });

  it("never returns the original message", () => {
    const secret = "password=hunter2 at 10.0.0.5/proovra";
    const category = safeOperationsFailureCategory(new Error(secret));
    expect(category).not.toContain("hunter2");
    expect(category).not.toContain("10.0.0.5");
  });
});

// ---------------------------------------------------------------------------
// §9 — source registry totality.
// ---------------------------------------------------------------------------

describe("§9 — no source may disappear silently", () => {
  it("every source has a stated disposition from the bounded vocabulary", () => {
    for (const source of OPERATIONS_SOURCES) {
      expect(
        SOURCE_DISPOSITIONS.includes(source.disposition),
        `${source.id} has an unrecognised disposition`,
      ).toBe(true);
    }
  });

  it("source ids are unique — accounting keys on them", () => {
    const ids = allSourceIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every source declares its scope authority and its surfaces", () => {
    for (const source of OPERATIONS_SOURCES) {
      expect(source.scopeAuthority, `${source.id}`).toBeTruthy();
      expect(source.discovery.length, `${source.id}`).toBeGreaterThan(0);
      expect(source.fingerprint.length, `${source.id}`).toBeGreaterThan(0);
      expect(source.resolution.length, `${source.id}`).toBeGreaterThan(0);
      expect(typeof source.surfaces.home).toBe("boolean");
      expect(typeof source.surfaces.notifications).toBe("boolean");
      expect(typeof source.surfaces.operations).toBe("boolean");
    }
  });

  it("the required set is non-empty and is a subset of all sources", () => {
    const required = requiredSourceIds();
    expect(required.length).toBeGreaterThan(0);
    const all = new Set(allSourceIds());
    for (const id of required) expect(all.has(id)).toBe(true);
  });

  it("platform-wide sources do NOT gate a tenant's readiness", () => {
    // A telemetry outage is a statement about the platform, not about whether
    // this tenant has unresolved work. Letting it mark every workspace PARTIAL
    // would make every tenant permanently un-clearable for a reason that has
    // nothing to do with their records.
    for (const source of OPERATIONS_SOURCES) {
      if (source.scopeAuthority === "PLATFORM_TELEMETRY") {
        expect(source.freshnessParticipating, source.id).toBe(false);
      }
    }
  });

  it("the review-workflow source is scoped through Evidence, not its own column", () => {
    // PROVEN, not stylistic: `EvidenceReviewWorkflow.team_id` is nullable and
    // its writer stores `params.teamId ?? null`.
    const source = OPERATIONS_SOURCES.find((s) => s.id === "review.stale_workflows");
    expect(source?.scopeAuthority).toBe("EVIDENCE_RELATION_SCOPE");
  });
});

// ---------------------------------------------------------------------------
// §10 — the TSA integrity boundary.
// ---------------------------------------------------------------------------

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

describe("§10 — Operations can never retry, restamp or replace a timestamp", () => {
  it("declares TSA failure as having NO safe remediation authority", () => {
    const tsa = OPERATIONS_SOURCES.find(
      (s) => s.id === "evidence_integrity.tsa_failed",
    );
    expect(tsa?.disposition).toBe("NO_SAFE_REMEDIATION_AUTHORITY");
  });

  it("still surfaces TSA failures — refusing a remedy is not hiding the problem", () => {
    const tsa = OPERATIONS_SOURCES.find(
      (s) => s.id === "evidence_integrity.tsa_failed",
    );
    expect(tsa?.surfaces.operations).toBe(true);
    expect(tsa?.surfaces.home).toBe(true);
    expect(tsa?.freshnessParticipating).toBe(true);
  });

  it("OTS, unlike TSA, may be re-attempted", () => {
    // The asymmetry is the point, and it is not arbitrary: an OTS anchor is a
    // calendar commitment that can be re-made without restating WHEN the
    // record existed. A timestamp token cannot.
    const ots = OPERATIONS_SOURCES.find(
      (s) => s.id === "evidence_integrity.ots_failed",
    );
    expect(ots?.disposition).toBe("SAFE_REMEDIATION");
  });

  it("no Operations reconciliation module reaches a timestamp provider", () => {
    // The assertion that matters. A missing button proves nothing; what has to
    // be true is that no path from this subsystem can contact an authority or
    // write a token.
    const modules = [
      "src/services/operations/operations-reconciliation.service.ts",
      "src/services/operations/operations-source-registry.ts",
      "src/services/operations/operations-grouping.service.ts",
      "src/jobs/workspace-operations-reconciliation.job.ts",
    ];
    const FORBIDDEN = [
      /requestTimestamp/i,
      /tsaClient/i,
      /rfc3161/i,
      /\.tsaToken\s*=/,
      /tsaStatus:\s*["']?(PENDING|REQUESTED)/i,
      /restamp/i,
    ];
    for (const rel of modules) {
      const src = readApi(rel);
      for (const pattern of FORBIDDEN) {
        expect(
          pattern.test(src),
          `${rel} must not reference ${pattern}`,
        ).toBe(false);
      }
    }
  });

  it("the discovery sweep writes no Evidence integrity column", () => {
    // Discovery OBSERVES integrity state; it must never author it. A sweep
    // that could write `tsaStatus` would be able to make a failure disappear
    // by relabelling it, which is the one repair that must be impossible.
    const generator = readApi("src/services/dashboard/incident-generator.service.ts");
    expect(generator).not.toMatch(/evidence\.update\b/);
    expect(generator).not.toMatch(/evidence\.updateMany\b/);
    expect(generator).not.toMatch(/tsaStatus:\s*[^}]*['"]/);
  });
});
