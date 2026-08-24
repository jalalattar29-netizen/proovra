/**
 * TSA / OTS CORRELATION — THE PRODUCER (Attention Architecture closure pass).
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PIPELINES ACTUALLY LOOK LIKE
 * ---------------------------------------------------------------------------
 * Before writing a producer, the pipelines were read rather than assumed:
 *
 *   OTS   `processOtsUpgrade(job)` decodes exactly ONE `commandId` — one
 *         BullMQ job per Evidence. There is no batch, no fan-out, and no
 *         shared execution across records.
 *   TSA   the same shape: per-record work, with `tsaSerialNumber` recorded
 *         per record. A serial number identifies THAT timestamp, not a group.
 *
 * So for ordinary production traffic there is genuinely NO shared identifier,
 * and `deriveParentCorrelation` returning null is not a missing feature — it
 * is the accurate answer. Manufacturing a parent to make the feature look
 * active would be the retracted finding, reinstated.
 *
 * ---------------------------------------------------------------------------
 * THE ONE REAL PRODUCER
 * ---------------------------------------------------------------------------
 * A DELIBERATE MULTI-RECORD EXECUTION. When an operator runs the TSA repair
 * across a set of records, that run is one decision with one identity, and
 * failures inside it really do share a cause: the run. `Evidence.
 * integrityCorrelationId` persists it, and the condition writer propagates it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  deriveParentCorrelation,
  childStatusAfterParentTransition,
  childStatusAfterSiblingTransition,
  parentMayResolve,
  FORBIDDEN_CORRELATION_SIGNALS,
} from "../src/services/operations/evidence-integrity-correlation.js";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");
}

const WRITER = read(
  "services/api/src/services/operations/evidence-integrity-conditions.service.ts",
);
const REPAIR = read("services/api/src/scripts/repair-tsa-failed-with-token.ts");
const SCHEMA = read("services/api/prisma/schema.prisma");
const MIGRATION = read(
  "services/api/prisma/migrations/20271217000000_evidence_integrity_correlation/migration.sql",
);

// ============================================================================
// §27 — the required correlation matrix
// ============================================================================

describe("Closure §27 — resemblance never correlates", () => {
  it("same failure reason only -> NO correlation", () => {
    // The reason is not a parameter, so there is no call that could group on
    // it. This asserts the shape rather than a behaviour, because the
    // behaviour is "impossible to express".
    expect(deriveParentCorrelation({} as never)).toBeNull();
    const shape = WRITER.slice(
      WRITER.indexOf("const correlationEvidence"),
      WRITER.indexOf("const parent = deriveParentCorrelation"),
    );
    expect(shape).not.toMatch(/FailureReason|failureReason/);
  });

  it("same provider only -> NO correlation", () => {
    const shape = WRITER.slice(
      WRITER.indexOf("const correlationEvidence"),
      WRITER.indexOf("const parent = deriveParentCorrelation"),
    );
    expect(shape).not.toMatch(/tsaProvider|relatedProvider/);
  });

  it("same time window only -> NO correlation", () => {
    const shape = WRITER.slice(
      WRITER.indexOf("const correlationEvidence"),
      WRITER.indexOf("const parent = deriveParentCorrelation"),
    );
    expect(shape).not.toMatch(/updatedAt|otsUpgradedAtUtc|now/);
  });

  it("same filename -> NO correlation", () => {
    const shape = WRITER.slice(
      WRITER.indexOf("const correlationEvidence"),
      WRITER.indexOf("const parent = deriveParentCorrelation"),
    );
    expect(shape).not.toMatch(/title|originalFileName/);
  });

  it("same workspace -> NO correlation", () => {
    const shape = WRITER.slice(
      WRITER.indexOf("const correlationEvidence"),
      WRITER.indexOf("const parent = deriveParentCorrelation"),
    );
    expect(shape).not.toMatch(/teamId|workspaceId/);
  });

  it("every forbidden signal is absent from the correlator's shape", () => {
    const CORRELATION = read(
      "services/api/src/services/operations/evidence-integrity-correlation.ts",
    );
    const start = CORRELATION.indexOf("export type CorrelationEvidence = {");
    const fields = [
      ...CORRELATION.slice(start, CORRELATION.indexOf("};", start)).matchAll(
        /^\s{2}(\w+)\??:/gm,
      ),
    ].map((m) => m[1]);
    for (const banned of FORBIDDEN_CORRELATION_SIGNALS) {
      expect(fields, `forbidden correlator: ${banned}`).not.toContain(banned);
    }
  });
});

describe("Closure §27 — a positive correlator DOES correlate", () => {
  it("a shared persisted execution id forms a parent", () => {
    const parent = deriveParentCorrelation({
      persistedCorrelationId: "tsa-repair:7f3c1a2b",
    });
    expect(parent).not.toBeNull();
    expect(parent!.basis).toBe("persisted_correlation");
    expect(parent!.parentFingerprint).toBe(
      "integrity_parent:correlation:tsa-repair:7f3c1a2b",
    );
  });

  it("two records from the SAME execution share one parent fingerprint", () => {
    const a = deriveParentCorrelation({ persistedCorrelationId: "run-1" });
    const b = deriveParentCorrelation({ persistedCorrelationId: "run-1" });
    expect(a!.parentFingerprint).toBe(b!.parentFingerprint);
  });

  it("records from DIFFERENT executions do not", () => {
    const a = deriveParentCorrelation({ persistedCorrelationId: "run-1" });
    const b = deriveParentCorrelation({ persistedCorrelationId: "run-2" });
    expect(a!.parentFingerprint).not.toBe(b!.parentFingerprint);
  });

  it("a shared batch or retry execution also correlates", () => {
    expect(deriveParentCorrelation({ batchRunId: "b-1" })!.basis).toBe(
      "batch_run",
    );
    expect(
      deriveParentCorrelation({ retryExecutionId: "r-1" })!.basis,
    ).toBe("retry_execution");
  });

  it("a provider incident id is the STRONGEST correlator and wins", () => {
    expect(
      deriveParentCorrelation({
        providerIncidentId: "INC-9",
        persistedCorrelationId: "run-1",
        batchRunId: "b-1",
      })!.basis,
    ).toBe("provider_incident");
  });

  it("different workspaces can never share a tenant parent", () => {
    // Parents are formed per workspace by the writer, which only ever passes
    // one workspace's rows. The correlator itself carries no workspace, so
    // there is nothing to leak — and the fingerprint is used against a
    // teamId-scoped incident table.
    const CORRELATION = read(
      "services/api/src/services/operations/evidence-integrity-correlation.ts",
    );
    expect(CORRELATION).not.toMatch(/parentFingerprint.*teamId/);
    expect(WRITER).toMatch(/teamId_fingerprint/);
  });
});

// ============================================================================
// §26 — child lifecycle independence
// ============================================================================

describe("Closure §26 — children survive their parent", () => {
  it("a parent transition NEVER moves a child", () => {
    for (const parentStatus of [
      "OPEN",
      "ACKNOWLEDGED",
      "RESOLVED",
      "SUPPRESSED",
      "REOPENED",
    ]) {
      expect(childStatusAfterParentTransition("OPEN", parentStatus)).toBe(
        "OPEN",
      );
    }
  });

  it("one child recovering NEVER moves a sibling", () => {
    expect(childStatusAfterSiblingTransition("OPEN", "RESOLVED")).toBe("OPEN");
    expect(childStatusAfterSiblingTransition("ACKNOWLEDGED", "RESOLVED")).toBe(
      "ACKNOWLEDGED",
    );
  });

  it("the parent may resolve only when EVERY child has", () => {
    expect(parentMayResolve(["RESOLVED", "RESOLVED", "RESOLVED"])).toBe(true);
    expect(parentMayResolve(["RESOLVED", "OPEN", "RESOLVED"])).toBe(false);
    expect(parentMayResolve(["ACKNOWLEDGED"])).toBe(false);
    // A suppressed child is adjudicated, so it does not hold the parent open.
    expect(parentMayResolve(["RESOLVED", "SUPPRESSED"])).toBe(true);
  });

  it("a parent with no children is not a resolved parent", () => {
    expect(parentMayResolve([])).toBe(false);
  });
});

// ============================================================================
// The producer, end to end
// ============================================================================

describe("Closure — the producer persists and propagates", () => {
  it("Evidence carries a nullable correlation column", () => {
    expect(SCHEMA).toMatch(
      /integrityCorrelationId String\? @map\("integrity_correlation_id"\)/,
    );
  });

  it("the migration is additive and backfills NOTHING", () => {
    expect(MIGRATION).toMatch(
      /ADD COLUMN IF NOT EXISTS "integrity_correlation_id"/,
    );
    // No historical correlation may be invented from reasons, providers or
    // clocks — that is the retracted finding wearing a migration.
    expect(MIGRATION).not.toMatch(/\bUPDATE\b/);
    expect(MIGRATION).not.toMatch(/\bDROP\b/);
    // No NOT NULL CONSTRAINT — a nullable column is preferable to fake
    // certainty, and almost every row legitimately has no correlator.
    //
    // Matched as a constraint rather than as a string: the file contains
    // `WHERE "integrity_correlation_id" IS NOT NULL`, which is the partial
    // index's predicate and the opposite of a constraint — it exists
    // precisely BECAUSE the column is null nearly everywhere.
    expect(MIGRATION).not.toMatch(/SET NOT NULL/i);
    expect(MIGRATION).not.toMatch(/ADD COLUMN[^;]*\bNOT NULL\b/i);
  });

  it("the deliberate multi-record execution stamps its identity", () => {
    expect(REPAIR).toMatch(
      /const repairExecutionId = `tsa-repair:\$\{randomUUID\(\)\}`/,
    );
    expect(REPAIR).toMatch(/integrityCorrelationId: repairExecutionId/);
  });

  it("the writer READS it and propagates it as a persisted correlation", () => {
    expect(WRITER).toContain("integrityCorrelationId: true");
    expect(WRITER).toMatch(
      /persistedCorrelationId: evidence\.integrityCorrelationId/,
    );
  });

  it("the parent lands on the condition's metadata, not on its identity", () => {
    // The FINGERPRINT stays `<class>:<evidenceId>`. A parent changes what an
    // operator can see about a group; it never changes what a condition IS.
    expect(WRITER).toMatch(/parentFingerprint: parent\?\.parentFingerprint \?\? null/);
    expect(WRITER).toMatch(
      /return `\$\{integrityClass\}:\$\{evidenceId\}`;/,
    );
  });

  it("ordinary per-record work still produces NO parent", async () => {
    // The common case, exercised through the real writer: two independent
    // failures with no execution behind them stay two independent conditions.
    const mod = await import(
      "../src/services/operations/evidence-integrity-conditions.service.js"
    );
    const incidents: Array<Record<string, unknown>> = [];
    const evidence = [
      {
        id: "evidence-aaaaaaaa",
        teamId: "t",
        title: "A",
        tsaStatus: "FAILED",
        tsaFailureReason: "TSA_HTTP_504_GATEWAY_TIMEOUT",
        tsaProvider: "freetsa",
        otsStatus: null,
        otsFailureReason: null,
        otsUpgradedAtUtc: null,
        updatedAt: new Date(),
        deletedAt: null,
        integrityCorrelationId: null,
      },
      {
        id: "evidence-bbbbbbbb",
        teamId: "t",
        title: "B",
        tsaStatus: "FAILED",
        tsaFailureReason: "TSA_HTTP_504_GATEWAY_TIMEOUT",
        tsaProvider: "freetsa",
        otsStatus: null,
        otsFailureReason: null,
        otsUpgradedAtUtc: null,
        updatedAt: new Date(),
        deletedAt: null,
        integrityCorrelationId: null,
      },
    ];
    let seq = 0;
    const client = {
      // The reconciler resolves the workspace scope via `resolvePersonalScope`,
      // which reads this row. A SHARED team (isPersonal:false) collapses the
      // canonical scope to the strict filter this fixture already assumes.
      team: {
        findUnique: vi.fn(async () => ({
          isPersonal: false,
          ownerUserId: null,
        })),
      },
      evidence: { findMany: vi.fn(async () => evidence) },
      evidenceLegalHold: { findMany: vi.fn(async () => []) },
      operationalIncident: {
        findUnique: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          seq += 1;
          const row = { id: `inc-${seq}`, ...data, firstSeenAtUtc: new Date() };
          incidents.push(row);
          return row;
        }),
        update: vi.fn(async () => ({})),
        count: vi.fn(async () => incidents.length),
        groupBy: vi.fn(async () => []),
      },
      operationalIncidentEvent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      },
    };
    await mod.syncEvidenceIntegrityConditions(
      { teamId: "t", now: new Date() },
      client as never,
    );
    expect(incidents).toHaveLength(2);
    // Same reason, same provider, same workspace, same minute — and still two
    // independent conditions with no parent between them.
    const metadataCalls = client.operationalIncidentEvent.create.mock.calls;
    for (const [{ data }] of metadataCalls as Array<[{ data: Record<string, unknown> }]>) {
      const meta = data.metadataJson as Record<string, unknown> | undefined;
      if (meta && "parentFingerprint" in meta) {
        expect(meta.parentFingerprint).toBeNull();
      }
    }
  });
});
