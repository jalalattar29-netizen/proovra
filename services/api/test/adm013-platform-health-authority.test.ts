/**
 * ADM-013 PHASE 3 — the platform health authority, proven.
 *
 * ===========================================================================
 * WHAT THESE TESTS PIN, AND WHY EACH ONE IS HERE
 * ===========================================================================
 * Five surfaces answered "is the platform healthy?" independently and printed
 * five different answers for the same instant. Consolidating them onto one
 * builder only helps if the builder's rules hold under the conditions that
 * produced the disagreement — a failed collector, a restarted process, a stale
 * evaluation, and two overlapping populations counted as one sum. So each rule
 * is exercised by driving a source into the state that breaks it.
 *
 * Every dependency is mocked at the MODULE boundary rather than the database,
 * because the properties under test are about how the builder COMPOSES source
 * outcomes, and a live database can only ever demonstrate one of them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module doubles. Declared before the import so the builder binds to them.
// ---------------------------------------------------------------------------

const incidentGroupBy = vi.fn();
const incidentCount = vi.fn();
const buildPlatformAlertsMock = vi.fn();
const getQueueInventoryMock = vi.fn();
const getWorkerHealthMock = vi.fn();
const runReadinessCheckMock = vi.fn();
const buildEvidenceHealthSnapshotMock = vi.fn();

vi.mock("../src/db.js", () => ({
  prisma: {
    operationalIncident: {
      groupBy: (...a: unknown[]) => incidentGroupBy(...a),
      count: (...a: unknown[]) => incidentCount(...a),
    },
  },
}));

vi.mock("../src/services/admin/alerts.service.js", () => ({
  buildPlatformAlerts: (...a: unknown[]) => buildPlatformAlertsMock(...a),
}));

vi.mock("../src/services/operations/queue-inventory.service.js", () => ({
  getQueueInventory: (...a: unknown[]) => getQueueInventoryMock(...a),
  getWorkerHealth: (...a: unknown[]) => getWorkerHealthMock(...a),
}));

vi.mock("../src/runtime/runtime-readiness.js", () => ({
  runReadinessCheck: (...a: unknown[]) => runReadinessCheckMock(...a),
}));

vi.mock("../src/services/operations/evidence-health.service.js", () => ({
  buildEvidenceHealthSnapshot: (...a: unknown[]) =>
    buildEvidenceHealthSnapshotMock(...a),
}));

const {
  buildPlatformHealthSnapshot,
  __resetPlatformHealthSnapshotFreshness,
  PLATFORM_HEALTH_SNAPSHOT_VERSION,
} = await import("../src/services/operations/platform-health-snapshot.service.js");

// ---------------------------------------------------------------------------
// A platform where every source answers and nothing is wrong.
// ---------------------------------------------------------------------------
function healthyWorld(): void {
  incidentGroupBy.mockResolvedValue([]);
  incidentCount.mockResolvedValue(0);
  buildPlatformAlertsMock.mockResolvedValue({
    items: [],
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    total: 0,
    reconciliation: { incidentBacked: 0, additional: 0 },
    readOnly: true,
  });
  getQueueInventoryMock.mockResolvedValue([
    {
      queueName: "report",
      label: "Report",
      counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 9 },
      stalledCount: 0,
      health: "healthy",
      oldestWaitingAgeMs: null,
      disabledReason: null,
    },
  ]);
  getWorkerHealthMock.mockResolvedValue([
    {
      queueName: "report",
      status: "healthy",
      lastActivityAtUtc: new Date().toISOString(),
      stalledCount: 0,
      recommendedAction: null,
    },
  ]);
  runReadinessCheckMock.mockResolvedValue({
    status: "HEALTHY",
    ranAtUtc: new Date().toISOString(),
    subsystems: [
      {
        id: "search_indexing",
        status: "HEALTHY",
        reasonCode: "ok",
        detail: "Discovery indexing is current.",
        remediationHint: null,
      },
      {
        id: "database",
        status: "HEALTHY",
        reasonCode: "ok",
        detail: "Primary reachable.",
        remediationHint: null,
      },
    ],
  });
  buildEvidenceHealthSnapshotMock.mockResolvedValue({
    generatedAtUtc: new Date().toISOString(),
    windowHours: 24,
    evidence: { withoutReport: 0 },
    preservation: { tsaFailures: 0 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPlatformHealthSnapshotFreshness();
  healthyWorld();
});

// ===========================================================================
// Shape
// ===========================================================================
describe("ADM-013 Phase 3 — the snapshot declares itself", () => {
  it("carries a version and an explicit PLATFORM scope", async () => {
    const s = await buildPlatformHealthSnapshot();
    expect(s.snapshotVersion).toBe(PLATFORM_HEALTH_SNAPSHOT_VERSION);
    expect(s.scope).toBe("PLATFORM");
  });

  it("never returns a state word without a reason", async () => {
    const s = await buildPlatformHealthSnapshot();
    expect(s.overall.reason.length).toBeGreaterThan(0);
    for (const sub of [s.queues, s.workers, s.search, s.evidencePipeline]) {
      expect(sub.reason.length, `${sub.id} has an empty reason`).toBeGreaterThan(0);
    }
  });

  it("a non-healthy subsystem always carries an operator action", async () => {
    getQueueInventoryMock.mockResolvedValue([
      {
        queueName: "report",
        label: "Report",
        counts: { waiting: 0, active: 0, delayed: 0, failed: 3, completed: 0 },
        stalledCount: 0,
        health: "degraded",
        oldestWaitingAgeMs: null,
        disabledReason: null,
      },
    ]);
    const s = await buildPlatformHealthSnapshot();
    expect(s.queues.state).toBe("DEGRADED");
    // An amber pill nobody can act on teaches operators to stop reading amber.
    expect(s.queues.operatorAction).toBeTruthy();
    expect(s.queues.affectedResource).toBe("Report");
  });
});

// ===========================================================================
// Rule 1 — a failed collector is UNKNOWN, never zero and never healthy
// ===========================================================================
describe("ADM-013 Phase 3 — rule 1: a failed collector is never a zero", () => {
  it("a failed incident read leaves the counts null, not 0", async () => {
    incidentGroupBy.mockRejectedValue(new Error("connection reset"));
    const s = await buildPlatformHealthSnapshot();
    expect(s.incidents.openDurable).toBeNull();
    expect(s.incidents.bySeverity.critical).toBeNull();
    expect(s.evaluation.unavailableSources).toContain("incidents");
  });

  it("a failed queue read is UNKNOWN, and the page is told which source failed", async () => {
    getQueueInventoryMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const s = await buildPlatformHealthSnapshot();
    expect(s.queues.state).toBe("UNKNOWN");
    expect(s.evaluation.unavailableSources).toContain("queues");
    expect(s.overall.state).not.toBe("HEALTHY");
  });

  it("the failure detail names the source and never the error", async () => {
    getQueueInventoryMock.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.3.14:6379"),
    );
    const s = await buildPlatformHealthSnapshot();
    const report = s.evaluation.sources.find((x) => x.id === "queues");
    expect(report?.outcome).toBe("UNAVAILABLE");
    expect(report?.detail).toContain("Queue inventory");
    // An operator-facing detail must not carry a host, a port or a stack.
    expect(report?.detail).not.toContain("ECONNREFUSED");
    expect(report?.detail).not.toContain("10.0.3.14");
  });

  it("an UNKNOWN source never masks a fault another source observed", async () => {
    // Search unreadable AND queues genuinely out. The answer is the observed
    // outage, not the unknown that happens to sort next to it.
    runReadinessCheckMock.mockRejectedValue(new Error("probe failed"));
    getQueueInventoryMock.mockResolvedValue([
      {
        queueName: "report",
        label: "Report",
        counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        stalledCount: 0,
        health: "outage",
        oldestWaitingAgeMs: null,
        disabledReason: null,
      },
    ]);
    const s = await buildPlatformHealthSnapshot();
    expect(s.search.state).toBe("UNKNOWN");
    expect(s.overall.state).toBe("CRITICAL");
  });

  it("an evidence metric that could not be measured is not voted healthy by its siblings", async () => {
    buildEvidenceHealthSnapshotMock.mockResolvedValue({
      generatedAtUtc: new Date().toISOString(),
      windowHours: 24,
      evidence: { withoutReport: 0 },
      // null is NOT zero.
      preservation: { tsaFailures: null },
    });
    const s = await buildPlatformHealthSnapshot();
    expect(s.evidencePipeline.state).toBe("UNKNOWN");
  });
});

// ===========================================================================
// Rule 2 — stale data cannot claim healthy
// ===========================================================================
describe("ADM-013 Phase 3 — rule 2: stale cannot claim healthy", () => {
  it("the first evaluation with all sources OK is fresh and may be HEALTHY", async () => {
    const s = await buildPlatformHealthSnapshot();
    expect(s.evaluation.stale).toBe(false);
    expect(s.evaluation.lastSuccessUtc).not.toBeNull();
    expect(s.overall.state).toBe("HEALTHY");
  });

  it("with no fully-successful evaluation on record, an otherwise-clean read is UNKNOWN", async () => {
    // One source down means no full success is recorded. Every OTHER source
    // reports healthy, and the answer is still not green.
    incidentGroupBy.mockRejectedValue(new Error("down"));
    const s = await buildPlatformHealthSnapshot();
    expect(s.evaluation.lastSuccessUtc).toBeNull();
    expect(s.evaluation.stale).toBe(true);
    expect(s.overall.state).toBe("UNKNOWN");
    // The sentence must NAME the source that failed and must not claim a
    // state. It legitimately contains the word "healthy" — in the clause that
    // denies it — so the assertion is about the naming, not the vocabulary.
    expect(s.overall.reason).toContain("incidents");
    expect(s.overall.reason).toMatch(
      /not a statement that the platform is healthy/i,
    );
  });

  it("staleness downgrades a green — it never upgrades an observed fault", async () => {
    getQueueInventoryMock.mockResolvedValue([
      {
        queueName: "report",
        label: "Report",
        counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
        stalledCount: 0,
        health: "outage",
        oldestWaitingAgeMs: null,
        disabledReason: null,
      },
    ]);
    const s = await buildPlatformHealthSnapshot();
    // No full success recorded (nothing failed, so it IS recorded) — the point
    // is that CRITICAL survives whatever freshness says.
    expect(s.overall.state).toBe("CRITICAL");
  });
});

// ===========================================================================
// Rule 4 — a restart cannot erase durable incidents
// ===========================================================================
describe("ADM-013 Phase 3 — rule 4: incidents come from rows", () => {
  it("counts come from the table even when the process has just started", async () => {
    incidentGroupBy.mockResolvedValue([
      { severity: "CRITICAL", _count: { _all: 2 } },
      { severity: "WARNING", _count: { _all: 70 } },
    ]);
    incidentCount.mockResolvedValue(72);
    __resetPlatformHealthSnapshotFreshness();
    const s = await buildPlatformHealthSnapshot();
    expect(s.incidents.openDurable).toBe(72);
    expect(s.incidents.bySeverity.critical).toBe(2);
    expect(s.overall.state).toBe("CRITICAL");
  });

  it("the process metric registry is not imported at all", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      "src/services/operations/platform-health-snapshot.service.ts",
      "utf8",
    );
    // Reading the gauge is how "0 incidents, healthy" appeared on a platform
    // with 72 rows. The boundary is that this module cannot reach it.
    for (const forbidden of ["snapshotMetrics", "setGauge", "evaluateAlerts("]) {
      expect(src.includes(forbidden), `imports ${forbidden}`).toBe(false);
    }
  });
});

// ===========================================================================
// The reconciliation — 72 + 78 is not 150
// ===========================================================================
describe("ADM-013 Phase 3 — incidents and signals are reconciled, not added", () => {
  beforeEach(() => {
    incidentGroupBy.mockResolvedValue([
      { severity: "WARNING", _count: { _all: 72 } },
    ]);
    incidentCount.mockResolvedValue(72);
    buildPlatformAlertsMock.mockResolvedValue({
      items: [
        ...Array.from({ length: 72 }, (_, i) => ({
          severity: "medium" as const,
          source: "incident" as const,
          title: `Open incident: ${i}`,
          organizationId: null,
          createdAt: new Date().toISOString(),
          href: `/admin/operations?incident=${i}`,
          incidentId: String(i),
          incidentBacked: true,
        })),
        ...Array.from({ length: 6 }, (_, i) => ({
          severity: "high" as const,
          source: "security" as const,
          title: `Security event ${i}`,
          organizationId: null,
          createdAt: new Date().toISOString(),
          href: "/admin/security",
          incidentId: null,
          incidentBacked: false,
        })),
      ],
      counts: { critical: 0, high: 6, medium: 72, low: 0 },
      total: 78,
      reconciliation: { incidentBacked: 72, additional: 6 },
      readOnly: true,
    });
  });

  it("reproduces the production shape exactly: 72 / 78 / 72 / 6 / 78", async () => {
    const s = await buildPlatformHealthSnapshot();
    expect(s.incidents.openDurable).toBe(72);
    expect(s.signals.activeUnresolved).toBe(78);
    expect(s.signals.incidentBacked).toBe(72);
    expect(s.signals.additional).toBe(6);
    // The number a human should act on. NOT 150, and NOT 72.
    expect(s.distinctAttentionItems).toBe(78);
  });

  it("distinct attention items is incidents + additional, never incidents + total", async () => {
    const s = await buildPlatformHealthSnapshot();
    expect(s.distinctAttentionItems).toBe(
      (s.incidents.openDurable ?? 0) + (s.signals.additional ?? 0),
    );
    expect(s.distinctAttentionItems).not.toBe(
      (s.incidents.openDurable ?? 0) + (s.signals.activeUnresolved ?? 0),
    );
  });

  it("the signal breakdown says WHICH six the six are", async () => {
    const s = await buildPlatformHealthSnapshot();
    expect(s.signals.byCategory.incident).toBe(72);
    expect(s.signals.byCategory.security).toBe(6);
  });

  it("a partial sum is never presented as a total", async () => {
    // Incidents readable, signals not. The sum is unknowable, so it is null —
    // not the half that happened to answer.
    buildPlatformAlertsMock.mockRejectedValue(new Error("alert rollup down"));
    const s = await buildPlatformHealthSnapshot();
    expect(s.incidents.openDurable).toBe(72);
    expect(s.signals.activeUnresolved).toBeNull();
    expect(s.distinctAttentionItems).toBeNull();
    expect(s.evaluation.unavailableSources).toContain("signals");
  });
});

// ===========================================================================
// Dependencies are enumerated by exclusion
// ===========================================================================
describe("ADM-013 Phase 3 — a new readiness probe cannot go unreported", () => {
  it("a probe the snapshot has no axis for still appears under dependencies", async () => {
    runReadinessCheckMock.mockResolvedValue({
      status: "DEGRADED",
      ranAtUtc: new Date().toISOString(),
      subsystems: [
        {
          id: "search_indexing",
          status: "HEALTHY",
          reasonCode: "ok",
          detail: "ok",
          remediationHint: null,
        },
        {
          id: "a_probe_nobody_wired_here",
          status: "DEGRADED",
          reasonCode: "whatever",
          detail: "Something specific is wrong.",
          remediationHint: "Do the specific thing.",
        },
      ],
    });
    const s = await buildPlatformHealthSnapshot();
    const found = s.dependencies.find(
      (d) => d.id === "a_probe_nobody_wired_here",
    );
    expect(found, "an unenumerated probe vanished from platform health").toBeTruthy();
    expect(found!.state).toBe("DEGRADED");
    expect(found!.operatorAction).toBe("Do the specific thing.");
    // And it must move the headline, not merely appear in a list.
    expect(s.overall.state).toBe("DEGRADED");
  });

  it("a probe with no remediation hint still gets an action rather than a blank", async () => {
    runReadinessCheckMock.mockResolvedValue({
      status: "DEGRADED",
      ranAtUtc: new Date().toISOString(),
      subsystems: [
        {
          id: "search_indexing",
          status: "DEGRADED",
          reasonCode: "x",
          detail: "Search is behind.",
          remediationHint: null,
        },
      ],
    });
    const s = await buildPlatformHealthSnapshot();
    expect(s.search.operatorAction).toBeTruthy();
    expect(s.search.operatorAction).toMatch(/escalate/i);
  });

  it("readiness returning no probe for an axis is UNKNOWN, not healthy", async () => {
    runReadinessCheckMock.mockResolvedValue({
      status: "HEALTHY",
      ranAtUtc: new Date().toISOString(),
      subsystems: [],
    });
    const s = await buildPlatformHealthSnapshot();
    // An absent probe is not a passing probe.
    expect(s.search.state).toBe("UNKNOWN");
    expect(s.overall.state).not.toBe("HEALTHY");
  });
});
