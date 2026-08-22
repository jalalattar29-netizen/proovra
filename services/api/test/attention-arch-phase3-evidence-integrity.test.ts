/**
 * ATTENTION ARCHITECTURE — PHASE 3 (2026-08-22).
 * TSA / OTS OPERATIONAL CONDITIONS.
 *
 * ---------------------------------------------------------------------------
 * THE RETRACTED FINDING
 * ---------------------------------------------------------------------------
 * An earlier audit reported "duplicate TSA failures" and proposed collapsing
 * them. That finding is RETRACTED and this suite is the enforcement.
 *
 * Ten records that failed to be timestamped are TEN records that cannot be
 * proven. They are not one problem seen ten times. Grouping them on a shared
 * filename, reason, provider, workspace or date makes nine of them invisible,
 * and an invisible unprovable record is the worst outcome an evidence
 * platform has.
 *
 * The matrix below is the audit's required test list, executed against the
 * real writer with a fake Prisma client — a fake, because the property under
 * test is "which rows does this write, keyed how", and that is exactly what a
 * fake client can observe precisely. Nothing here asserts a source string
 * where behaviour was available.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  classifyIntegrityFailure,
  deriveIntegritySeverity,
  AGE_CRITICAL_DAYS,
  AGE_ESCALATION_DAYS,
} from "../src/services/operations/evidence-integrity-severity.js";
import {
  deriveParentCorrelation,
  childStatusAfterParentTransition,
  FORBIDDEN_CORRELATION_SIGNALS,
} from "../src/services/operations/evidence-integrity-correlation.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const TEAM = "11111111-1111-4111-8111-111111111111";

// ---------------------------------------------------------------------------
// A minimal in-memory stand-in for the two tables the writer touches.
// ---------------------------------------------------------------------------

type FakeIncident = {
  id: string;
  teamId: string | null;
  fingerprint: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  safeSummary: string;
  occurrenceCount: number;
  firstSeenAtUtc: Date;
  lastSeenAtUtc: Date;
  relatedEvidenceId: string | null;
  resolvedAtUtc: Date | null;
  resolvedByUserId: string | null;
  resolutionNote: string | null;
};

type FakeEvidence = {
  id: string;
  teamId: string;
  title: string | null;
  originalFileName?: string | null;
  tsaStatus: string | null;
  tsaFailureReason: string | null;
  tsaProvider: string | null;
  otsStatus: string | null;
  otsFailureReason: string | null;
  otsUpgradedAtUtc: Date | null;
  updatedAt: Date;
  deletedAt?: Date | null;
};

function makeClient(evidence: FakeEvidence[]) {
  const incidents: FakeIncident[] = [];
  const events: Array<{ incidentId: string; eventType: string }> = [];
  let seq = 0;

  const matchesWhere = (row: FakeEvidence, where: Record<string, unknown>) => {
    if (where.teamId && row.teamId !== where.teamId) return false;
    if ("deletedAt" in where && where.deletedAt === null && row.deletedAt) {
      return false;
    }
    if (Array.isArray(where.OR)) {
      const ok = (where.OR as Array<Record<string, string>>).some((clause) =>
        Object.entries(clause).every(
          ([k, v]) => (row as unknown as Record<string, unknown>)[k] === v,
        ),
      );
      if (!ok) return false;
    }
    const idIn = (where.id as { in?: string[] } | undefined)?.in;
    if (idIn && !idIn.includes(row.id)) return false;
    return true;
  };

  const client = {
    evidence: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        evidence.filter((row) => matchesWhere(row, where)),
      ),
    },
    evidenceLegalHold: {
      findMany: vi.fn(async () => [] as Array<{ evidenceId: string | null }>),
    },
    operationalIncident: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { teamId_fingerprint: { teamId: string; fingerprint: string } };
        }) =>
          incidents.find(
            (i) =>
              i.teamId === where.teamId_fingerprint.teamId &&
              i.fingerprint === where.teamId_fingerprint.fingerprint,
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, never> }) => {
        const w = where as unknown as {
          teamId?: string;
          category?: string;
          status?: { in: string[] };
        };
        return incidents.filter(
          (i) =>
            (!w.teamId || i.teamId === w.teamId) &&
            (!w.category || i.category === w.category) &&
            (!w.status || w.status.in.includes(i.status)),
        );
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const row: FakeIncident = {
          id: `inc-${seq}`,
          teamId: (data.teamId as string) ?? null,
          fingerprint: data.fingerprint as string,
          category: data.category as string,
          severity: data.severity as string,
          status: (data.status as string) ?? "OPEN",
          title: data.title as string,
          safeSummary: data.safeSummary as string,
          occurrenceCount: 1,
          firstSeenAtUtc: NOW,
          lastSeenAtUtc: NOW,
          relatedEvidenceId: (data.relatedEvidenceId as string) ?? null,
          resolvedAtUtc: null,
          resolvedByUserId: null,
          resolutionNote: null,
        };
        incidents.push(row);
        return row;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = incidents.find((i) => i.id === where.id)!;
          for (const [k, v] of Object.entries(data)) {
            if (
              v &&
              typeof v === "object" &&
              "increment" in (v as Record<string, unknown>)
            ) {
              (row as unknown as Record<string, number>)[k] +=
                (v as { increment: number }).increment;
            } else {
              (row as unknown as Record<string, unknown>)[k] = v;
            }
          }
          return row;
        },
      ),
      count: vi.fn(async () => incidents.length),
      groupBy: vi.fn(async () => []),
    },
    operationalIncidentEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push({
          incidentId: data.incidentId as string,
          eventType: data.eventType as string,
        });
        return data;
      }),
    },
  };
  return { client, incidents, events };
}

async function sync(
  evidence: FakeEvidence[],
  client?: ReturnType<typeof makeClient>,
) {
  const mod = await import(
    "../src/services/operations/evidence-integrity-conditions.service.js"
  );
  const fake = client ?? makeClient(evidence);
  const result = await mod.syncEvidenceIntegrityConditions(
    { teamId: TEAM, now: NOW },
    fake.client as never,
  );
  return { ...fake, result };
}

function failedEvidence(
  id: string,
  overrides: Partial<FakeEvidence> = {},
): FakeEvidence {
  return {
    id,
    teamId: TEAM,
    title: "Recording",
    tsaStatus: "FAILED",
    tsaFailureReason: "TSA_HTTP_504_GATEWAY_TIMEOUT",
    tsaProvider: "freetsa",
    otsStatus: null,
    otsFailureReason: null,
    otsUpgradedAtUtc: null,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

// ============================================================================
// 3.1 / 3.8 — INDEPENDENT IDENTITY. The retracted finding, enforced.
// ============================================================================

describe("Phase 3.1 — every failed record gets its own condition", () => {
  it("SAME reason + DIFFERENT evidence ids -> separate conditions", async () => {
    const { incidents } = await sync([
      failedEvidence("evidence-aaaaaaaa", {
        tsaFailureReason: "TSA_HTTP_504_GATEWAY_TIMEOUT",
      }),
      failedEvidence("evidence-bbbbbbbb", {
        tsaFailureReason: "TSA_HTTP_504_GATEWAY_TIMEOUT",
      }),
      failedEvidence("evidence-cccccccc", {
        tsaFailureReason: "TSA_HTTP_504_GATEWAY_TIMEOUT",
      }),
    ]);
    expect(incidents).toHaveLength(3);
    expect(incidents.map((i) => i.fingerprint).sort()).toEqual([
      "tsa_failure:evidence-aaaaaaaa",
      "tsa_failure:evidence-bbbbbbbb",
      "tsa_failure:evidence-cccccccc",
    ]);
  });

  it("SAME filename + DIFFERENT evidence ids -> separate conditions", async () => {
    const { incidents } = await sync([
      failedEvidence("evidence-aaaaaaaa", {
        title: "IMG_0001.mp4",
        originalFileName: "IMG_0001.mp4",
      }),
      failedEvidence("evidence-bbbbbbbb", {
        title: "IMG_0001.mp4",
        originalFileName: "IMG_0001.mp4",
      }),
    ]);
    expect(incidents).toHaveLength(2);
    expect(new Set(incidents.map((i) => i.fingerprint)).size).toBe(2);
  });

  it("SAME provider + DIFFERENT dates -> separate conditions", async () => {
    const { incidents } = await sync([
      failedEvidence("evidence-aaaaaaaa", {
        tsaProvider: "freetsa",
        updatedAt: new Date("2026-01-05T00:00:00Z"),
      }),
      failedEvidence("evidence-bbbbbbbb", {
        tsaProvider: "freetsa",
        updatedAt: new Date("2026-06-30T00:00:00Z"),
      }),
    ]);
    expect(incidents).toHaveLength(2);
  });

  it("SAME workspace + SAME class -> still separate conditions", async () => {
    const { incidents } = await sync([
      failedEvidence("evidence-aaaaaaaa"),
      failedEvidence("evidence-bbbbbbbb"),
    ]);
    expect(incidents.every((i) => i.teamId === TEAM)).toBe(true);
    expect(incidents).toHaveLength(2);
  });

  it("the two proof classes on ONE record are two conditions", async () => {
    // They fail for different reasons and are fixed by different pipelines.
    const { incidents } = await sync([
      failedEvidence("evidence-aaaaaaaa", {
        tsaStatus: "FAILED",
        otsStatus: "FAILED",
        otsFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED",
      }),
    ]);
    expect(incidents.map((i) => i.fingerprint).sort()).toEqual([
      "ots_failure:evidence-aaaaaaaa",
      "tsa_failure:evidence-aaaaaaaa",
    ]);
  });

  it("the fingerprint contains the evidence id and NOTHING volatile", async () => {
    const { incidents } = await sync([
      failedEvidence("evidence-aaaaaaaa", {
        title: "IMG_0001.mp4",
        tsaProvider: "freetsa",
        tsaFailureReason: "TSA_HTTP_504_GATEWAY_TIMEOUT",
      }),
    ]);
    const fingerprint = incidents[0].fingerprint;
    expect(fingerprint).toBe("tsa_failure:evidence-aaaaaaaa");
    for (const volatile of ["IMG_0001", "freetsa", "504", TEAM, "2026"]) {
      expect(fingerprint).not.toContain(volatile);
    }
  });

  it("each condition names its own record so it stays independently traceable", async () => {
    const { incidents } = await sync([
      failedEvidence("evidence-aaaaaaaa"),
      failedEvidence("evidence-bbbbbbbb"),
    ]);
    expect(incidents.map((i) => i.relatedEvidenceId).sort()).toEqual([
      "evidence-aaaaaaaa",
      "evidence-bbbbbbbb",
    ]);
  });
});

// ============================================================================
// 3.3 — idempotency
// ============================================================================

describe("Phase 3.3 — repeated scans are idempotent", () => {
  it("the same failed record scanned repeatedly opens ONE condition", async () => {
    const evidence = [failedEvidence("evidence-aaaaaaaa")];
    const fake = makeClient(evidence);
    const first = await sync(evidence, fake);
    const second = await sync(evidence, fake);
    const third = await sync(evidence, fake);

    expect(fake.incidents).toHaveLength(1);
    expect(first.result.opened).toBe(1);
    expect(second.result.opened).toBe(0);
    expect(third.result.opened).toBe(0);
    expect(second.result.reobserved).toBe(1);
    // Occurrences are still counted — "how long has this been failing" is
    // real information and must not be lost to idempotency.
    expect(fake.incidents[0].occurrenceCount).toBe(3);
  });

  it("first-seen is preserved across re-observation", async () => {
    const evidence = [failedEvidence("evidence-aaaaaaaa")];
    const fake = makeClient(evidence);
    await sync(evidence, fake);
    const firstSeen = fake.incidents[0].firstSeenAtUtc;
    await sync(evidence, fake);
    expect(fake.incidents[0].firstSeenAtUtc).toEqual(firstSeen);
  });
});

// ============================================================================
// 3.4 / 3.5 — resolution from domain truth, and re-fire
// ============================================================================

describe("Phase 3.4 — resolution comes from Evidence domain truth", () => {
  it("recovery resolves the condition", async () => {
    const evidence = [failedEvidence("evidence-aaaaaaaa")];
    const fake = makeClient(evidence);
    await sync(evidence, fake);
    expect(fake.incidents[0].status).toBe("OPEN");

    evidence[0].tsaStatus = "ANCHORED";
    const after = await sync(evidence, fake);
    expect(after.result.resolved).toBe(1);
    expect(fake.incidents[0].status).toBe("RESOLVED");
    expect(fake.incidents[0].resolutionNote).toMatch(/domain truth/i);
    // No human resolver is fabricated for an automatic resolution.
    expect(fake.incidents[0].resolvedByUserId).toBeNull();
  });

  it("resolution reads the record BY ID, never 'absent from the scan'", async () => {
    const evidence = [failedEvidence("evidence-aaaaaaaa")];
    const fake = makeClient(evidence);
    await sync(evidence, fake);

    // The record vanishes from every read — deleted, or the scan degraded.
    // That is NOT evidence of recovery, and the condition must stay open.
    evidence.length = 0;
    const after = await sync(evidence, fake);
    expect(after.result.resolved).toBe(0);
    expect(fake.incidents[0].status).toBe("OPEN");
  });

  it("a bounded scan reports incompleteness rather than a tidy number", async () => {
    const many = Array.from({ length: 2001 }, (_, i) =>
      failedEvidence(`evidence-${String(i).padStart(8, "0")}`),
    );
    const { result } = await sync(many);
    expect(result.complete).toBe(false);
  });
});

describe("Phase 3.5 — re-fire after recovery", () => {
  it("fails -> resolves -> fails again reopens with occurrence history", async () => {
    const evidence = [failedEvidence("evidence-aaaaaaaa")];
    const fake = makeClient(evidence);

    await sync(evidence, fake);
    expect(fake.incidents[0].status).toBe("OPEN");

    evidence[0].tsaStatus = "ANCHORED";
    await sync(evidence, fake);
    expect(fake.incidents[0].status).toBe("RESOLVED");

    evidence[0].tsaStatus = "FAILED";
    await sync(evidence, fake);
    expect(fake.incidents[0].status).toBe("OPEN");
    expect(fake.incidents[0].resolvedAtUtc).toBeNull();
    // Still ONE condition — the record's problem came back, it is not a
    // different record's problem.
    expect(fake.incidents).toHaveLength(1);
    expect(fake.incidents[0].occurrenceCount).toBeGreaterThanOrEqual(2);
    // And the history records every transition.
    const types = fake.events.map((e) => e.eventType);
    expect(types).toContain("opened");
    expect(types).toContain("resolved_by_domain_truth");
  });

  it("SUPPRESSED survives a continuing failure — the operator decided", async () => {
    const evidence = [failedEvidence("evidence-aaaaaaaa")];
    const fake = makeClient(evidence);
    await sync(evidence, fake);

    // An authorized operator suppresses the condition.
    fake.incidents[0].status = "SUPPRESSED";

    const after = await sync(evidence, fake);
    expect(fake.incidents[0].status).toBe("SUPPRESSED");
    expect(after.result.suppressedUntouched).toBe(1);
    // The continued failure is still recorded, so "this kept failing while
    // suppressed" survives in the history.
    expect(fake.events.map((e) => e.eventType)).toContain(
      "occurrence_while_suppressed",
    );
  });

  it("a SUPPRESSED condition whose record recovers is resolved", async () => {
    const evidence = [failedEvidence("evidence-aaaaaaaa")];
    const fake = makeClient(evidence);
    await sync(evidence, fake);
    fake.incidents[0].status = "SUPPRESSED";

    evidence[0].tsaStatus = "ANCHORED";
    await sync(evidence, fake);
    // Domain truth outranks suppression: the thing is actually fixed, so the
    // next genuine failure reopens cleanly instead of looking like a
    // continuation of the suppressed one.
    expect(fake.incidents[0].status).toBe("RESOLVED");
  });

  it("an archived NOTIFICATION cannot suppress the condition", async () => {
    // The writer takes a workspace and a clock. There is no parameter through
    // which a recipient's personal state could reach it — the separation is
    // structural, and this asserts the signature rather than the behaviour of
    // one fixture.
    const SRC = readFileSync(
      fileURLToPath(
        new URL(
          "../src/services/operations/evidence-integrity-conditions.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(SRC).not.toMatch(/dismissedAt|snoozedUntil|inboxItemState|readAt/i);
    expect(SRC).toMatch(
      /input: \{ teamId: string; now\?: Date \}/,
    );
  });
});

// ============================================================================
// 3.6 — severity policy
// ============================================================================

describe("Phase 3.6 — one documented severity policy", () => {
  it("classifies the reason codes both pipelines actually emit", () => {
    expect(classifyIntegrityFailure("TSA_HTTP_504_GATEWAY_TIMEOUT")).toBe(
      "RETRYABLE_PROVIDER",
    );
    expect(classifyIntegrityFailure("OTS_GLOBAL_BUDGET_EXHAUSTED")).toBe(
      "QUOTA",
    );
    expect(classifyIntegrityFailure("TSA_401_UNAUTHORIZED")).toBe(
      "CONFIGURATION",
    );
    expect(classifyIntegrityFailure("TSA_MESSAGE_IMPRINT_MISMATCH")).toBe(
      "CRYPTOGRAPHIC",
    );
    expect(classifyIntegrityFailure("OTS_RETRY_EXHAUSTED")).toBe(
      "RETRY_EXHAUSTED",
    );
  });

  it("an unrecognised reason is treated as serious, not benign", () => {
    expect(classifyIntegrityFailure("something we have never seen")).toBe(
      "UNKNOWN",
    );
    expect(classifyIntegrityFailure(null)).toBe("UNKNOWN");
    expect(
      deriveIntegritySeverity({
        failureClass: "UNKNOWN",
        firstSeenAtUtc: NOW,
        now: NOW,
        underLegalHold: false,
      }),
    ).toBe("HIGH");
  });

  it("does NOT assign every failure the same severity", () => {
    const severities = new Set(
      (
        [
          "RETRYABLE_PROVIDER",
          "QUOTA",
          "CRYPTOGRAPHIC",
        ] as const
      ).map((failureClass) =>
        deriveIntegritySeverity({
          failureClass,
          firstSeenAtUtc: NOW,
          now: NOW,
          underLegalHold: false,
        }),
      ),
    );
    expect(severities.size).toBeGreaterThanOrEqual(3);
  });

  it("a cryptographic failure is CRITICAL immediately — retrying cannot fix it", () => {
    expect(
      deriveIntegritySeverity({
        failureClass: "CRYPTOGRAPHIC",
        firstSeenAtUtc: NOW,
        now: NOW,
        underLegalHold: false,
      }),
    ).toBe("CRITICAL");
  });

  it("age escalates and never de-escalates", () => {
    const base = {
      failureClass: "RETRYABLE_PROVIDER" as const,
      underLegalHold: false,
    };
    const fresh = deriveIntegritySeverity({
      ...base,
      firstSeenAtUtc: NOW,
      now: NOW,
    });
    const week = deriveIntegritySeverity({
      ...base,
      firstSeenAtUtc: new Date(
        NOW.getTime() - AGE_ESCALATION_DAYS * 86400_000,
      ),
      now: NOW,
    });
    const month = deriveIntegritySeverity({
      ...base,
      firstSeenAtUtc: new Date(NOW.getTime() - AGE_CRITICAL_DAYS * 86400_000),
      now: NOW,
    });
    expect(fresh).toBe("WARNING");
    expect(week).toBe("HIGH");
    expect(month).toBe("CRITICAL");
  });

  it("legal hold escalates to CRITICAL", () => {
    expect(
      deriveIntegritySeverity({
        failureClass: "RETRYABLE_PROVIDER",
        firstSeenAtUtc: NOW,
        now: NOW,
        underLegalHold: true,
      }),
    ).toBe("CRITICAL");
  });

  it("severity is INDEPENDENT of identity — escalating does not re-key", async () => {
    const evidence = [
      failedEvidence("evidence-aaaaaaaa", {
        tsaFailureReason: "TSA_HTTP_504_GATEWAY_TIMEOUT",
      }),
    ];
    const fake = makeClient(evidence);
    await sync(evidence, fake);
    const fingerprintBefore = fake.incidents[0].fingerprint;

    // The retry produced a permanent failure instead. Same record, same
    // condition, higher severity.
    evidence[0].tsaFailureReason = "TSA_MESSAGE_IMPRINT_MISMATCH";
    await sync(evidence, fake);

    expect(fake.incidents).toHaveLength(1);
    expect(fake.incidents[0].fingerprint).toBe(fingerprintBefore);
    expect(fake.incidents[0].severity).toBe("CRITICAL");
  });
});

// ============================================================================
// 3.7 — correlation is evidence-based or absent
// ============================================================================

describe("Phase 3.7 — grouping requires positive correlation evidence", () => {
  it("NO correlator -> NO parent. This is the common case.", () => {
    expect(deriveParentCorrelation(null)).toBeNull();
    expect(deriveParentCorrelation({})).toBeNull();
    expect(
      deriveParentCorrelation({
        providerIncidentId: null,
        persistedCorrelationId: null,
        batchRunId: null,
        retryExecutionId: null,
      }),
    ).toBeNull();
    expect(deriveParentCorrelation({ providerIncidentId: "   " })).toBeNull();
  });

  it("an explicit provider incident id DOES establish a parent", () => {
    const parent = deriveParentCorrelation({
      providerIncidentId: "freetsa-INC-4471",
    });
    expect(parent?.basis).toBe("provider_incident");
    expect(parent?.parentFingerprint).toBe(
      "integrity_parent:provider_incident:freetsa-INC-4471",
    );
  });

  it("prefers the strongest correlator when several are present", () => {
    expect(
      deriveParentCorrelation({
        providerIncidentId: "INC-1",
        batchRunId: "run-2",
      })?.basis,
    ).toBe("provider_incident");
    expect(deriveParentCorrelation({ batchRunId: "run-2" })?.basis).toBe(
      "batch_run",
    );
  });

  it("the forbidden signals are not parameters of the correlator", () => {
    const SRC = readFileSync(
      fileURLToPath(
        new URL(
          "../src/services/operations/evidence-integrity-correlation.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const typeStart = SRC.indexOf("export type CorrelationEvidence = {");
    const typeEnd = SRC.indexOf("};", typeStart);
    const shape = SRC.slice(typeStart, typeEnd);
    // Compare FIELD NAMES exactly. A substring test would flag
    // `providerIncidentId` for containing "provider" — which is the opposite
    // of the rule: naming the provider's own incident id is the strongest
    // allowed correlator, while grouping by "same provider" is banned.
    const declaredFields = [...shape.matchAll(/^\s{2}(\w+)\??:/gm)].map(
      (m) => m[1],
    );
    expect(declaredFields.length).toBeGreaterThanOrEqual(4);
    for (const banned of FORBIDDEN_CORRELATION_SIGNALS) {
      expect(
        declaredFields,
        `forbidden correlator leaked in: ${banned}`,
      ).not.toContain(banned);
    }
    expect(FORBIDDEN_CORRELATION_SIGNALS).toContain("failureReason");
    expect(FORBIDDEN_CORRELATION_SIGNALS).toContain("provider");
    expect(FORBIDDEN_CORRELATION_SIGNALS).toContain("sameDay");
  });

  it("a parent's resolution never cascades to its children", () => {
    for (const parentStatus of [
      "OPEN",
      "ACKNOWLEDGED",
      "RESOLVED",
      "SUPPRESSED",
    ]) {
      expect(childStatusAfterParentTransition("OPEN", parentStatus)).toBe(
        "OPEN",
      );
    }
  });

  it("the writer never groups — every record gets its own row", async () => {
    // Same provider, same reason, same day, same workspace: the four signals
    // the retracted finding proposed grouping on, all present at once.
    const { incidents } = await sync([
      failedEvidence("evidence-aaaaaaaa"),
      failedEvidence("evidence-bbbbbbbb"),
      failedEvidence("evidence-cccccccc"),
      failedEvidence("evidence-dddddddd"),
    ]);
    expect(incidents).toHaveLength(4);
  });
});

// ============================================================================
// 3.2 — extends the existing architecture, does not fork it
// ============================================================================

describe("Phase 3.2 — no parallel operations architecture", () => {
  const SRC = readFileSync(
    fileURLToPath(
      new URL(
        "../src/services/operations/evidence-integrity-conditions.service.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("writes through the existing incident authority", () => {
    expect(SRC).toContain(
      'from "../observability/incident.service.js"',
    );
    expect(SRC).toMatch(/recordIncident\(/);
    expect(SRC).toMatch(/operationalIncidentEvent\s*\n?\s*\.create/);
    expect(SRC).toMatch(/operationalIncident\.(findUnique|findMany|update)/);
  });

  it("introduces no V2 model, table or queue", () => {
    // The names appear once each in the module header, which explains why
    // they were NOT built. Strip the header before searching, so the ban is
    // asserted against the code rather than against the explanation of it.
    const code = SRC.slice(SRC.indexOf("import type"));
    expect(code).not.toMatch(
      /OperationalConditionV2|EvidenceOperationsV2|NewOperationsQueue/,
    );
    const SCHEMA = readFileSync(
      fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
      "utf8",
    );
    expect(SCHEMA).not.toMatch(/model OperationalConditionV2/);
    expect(SCHEMA).not.toMatch(/model EvidenceOperationsV2/);
  });

  it("adds ONE enum value, additively, in a forward migration", () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../prisma/migrations/20271216000000_evidence_integrity_incident_category/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(migration).toMatch(
      /ALTER TYPE "IncidentCategory" ADD VALUE IF NOT EXISTS 'EVIDENCE_INTEGRITY';/,
    );
    // Additive only — nothing destructive, nothing backfilled.
    expect(migration).not.toMatch(/DROP|DELETE|UPDATE |TRUNCATE/);
  });

  it("is reachable from the canonical workspace generator", () => {
    const GENERATOR = readFileSync(
      fileURLToPath(
        new URL(
          "../src/services/dashboard/incident-generator.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(GENERATOR).toContain("syncEvidenceIntegrityConditions");
  });
});
