/**
 * Phase 32.7 — Runtime canonicalization + graceful degradation
 * regression tests (source-contract + runtime semantics).
 *
 * Stabilization invariants this phase enforces:
 *
 *   1. CANONICAL EVENT CONTRACT. The worker heartbeat wire string
 *      ("reviewer_reconcile_run") is resolved through ONE typed
 *      constant in packages/shared-runtime/src/ops/canonical-events.ts.
 *      Writers (reviewer-operations-engine.service.ts) and readers
 *      (runtime-readiness.ts::checkWorkers) both import the same
 *      constant — they cannot drift without a single coordinated
 *      change to the contract module.
 *
 *   2. TELEMETRY QUERY FAILURE != WORKER FAILURE. When the
 *      readiness check's SecurityEvent query fails, the workers
 *      subsystem MUST return UNKNOWN with reasonCode
 *      `telemetry_query_failed`. It MUST NOT escalate to DEGRADED
 *      or CRITICAL — a telemetry query failure is a platform
 *      telemetry condition, not a worker condition. The worker
 *      itself may be perfectly healthy.
 *
 *   3. DEGRADATION BOUNDARY. Every subsystem result carries a
 *      typed `affectedDomain` field. The frontend
 *      RuntimeStatusBanner accepts a `forDomains` prop and only
 *      renders when at least one failing subsystem maps to a
 *      relevant domain. A degraded `workers` subsystem (domain:
 *      `reviewer_ops`) MUST NOT poison the governance page (domain:
 *      `governance_lifecycle`) or the evidence detail page (domain:
 *      `core_evidence`).
 *
 *   4. SUBSYSTEM→DOMAIN MIRROR. Every `SubsystemId` has exactly
 *      one entry in `SUBSYSTEM_AFFECTED_DOMAIN`. New subsystems
 *      added without a domain assignment will fail this test.
 *
 *   5. NO REGRESSION on the existing fail-closed contracts. The
 *      rollup still escalates: any CRITICAL → CRITICAL; any
 *      DEGRADED → DEGRADED; UNKNOWN is reserved for genuine
 *      uncertainty, not for telemetry failures (which now have
 *      their own bounded reasonCode).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readShared(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../packages/shared-runtime/${rel}`, import.meta.url)),
    "utf8",
  );
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

// =============================================================================
// Part 1 — Canonical operational event contract module exists and is bounded
// =============================================================================

describe("Phase 32.7 — canonical operational event contract", () => {
  const SRC = readShared("src/ops/canonical-events.ts");

  it("exposes the bounded CANONICAL_OPERATIONAL_EVENTS catalog with WORKER_HEARTBEAT", () => {
    expect(SRC).toMatch(/export const CANONICAL_OPERATIONAL_EVENTS = \[/);
    expect(SRC).toMatch(/"WORKER_HEARTBEAT"/);
    expect(SRC).toMatch(/as const;/);
  });

  it("declares the typed CanonicalOperationalEvent union from the catalog", () => {
    expect(SRC).toMatch(
      /export type CanonicalOperationalEvent\s*=\s*\(typeof CANONICAL_OPERATIONAL_EVENTS\)\[number\]/,
    );
  });

  it("maps WORKER_HEARTBEAT to the preserved wire string `reviewer_reconcile_run`", () => {
    // Wire string is part of the persisted contract; downstream
    // dashboards and audit-chain consumers depend on it.
    expect(SRC).toMatch(
      /OPERATIONAL_EVENT_WIRE_STRINGS\s*:\s*Record<\s*CanonicalOperationalEvent\s*,\s*string\s*>/,
    );
    expect(SRC).toMatch(/WORKER_HEARTBEAT:\s*"reviewer_reconcile_run"/);
  });

  it("exposes `wireStringFor()` for cross-subsystem resolution", () => {
    expect(SRC).toMatch(
      /export function wireStringFor\(\s*name:\s*CanonicalOperationalEvent\s*\):\s*string/,
    );
  });

  it("exposes bounded OPERATIONAL_DOMAINS catalog for degradation boundaries", () => {
    expect(SRC).toMatch(/export const OPERATIONAL_DOMAINS = \[/);
    // Every domain referenced by the api-side map must exist here.
    for (const domain of [
      "core_evidence",
      "reviewer_ops",
      "governance_lifecycle",
      "workflow_engine",
      "integrations",
      "identity",
      "operational_incidents",
      "search_discovery",
      "media_intelligence",
      "platform_telemetry",
    ]) {
      expect(SRC).toContain(`"${domain}"`);
    }
  });

  it("re-exported from packages/shared-runtime/src/ops/index.ts", () => {
    const INDEX = readShared("src/ops/index.ts");
    expect(INDEX).toContain('export * from "./canonical-events.js"');
  });
});

// =============================================================================
// Part 2 — Writer (reviewer-operations-engine) uses the canonical constant
// =============================================================================

describe("Phase 32.7 — worker heartbeat writer uses the canonical constant", () => {
  const SRC = readApi(
    "src/services/reviewer-ops/reviewer-operations-engine.service.ts",
  );

  it("imports `wireStringFor` from @proovra/shared-runtime/ops", () => {
    expect(SRC).toMatch(
      /import\s*\{[\s\S]*?wireStringFor[\s\S]*?\}\s*from\s*"@proovra\/shared-runtime\/ops"/,
    );
  });

  it("emits the SecurityEvent with the canonical wire string (not a literal)", () => {
    // The eventType in the worker heartbeat write site MUST resolve
    // through the canonical constant. The file contains many
    // safeEmitSecurityEvent call sites; we only require that the
    // canonical resolver invocation exists with WORKER_HEARTBEAT.
    // Allow optional trailing comma inside the function call
    // (Prettier emits `canonicalOperationalWireStringFor(\n  "WORKER_HEARTBEAT",\n)`).
    expect(SRC).toMatch(
      /eventType:\s*canonicalOperationalWireStringFor\([\s\S]{0,100}"WORKER_HEARTBEAT"[\s\S]{0,20}\)/,
    );
    // And the legacy inline literal "reviewer_reconcile_run" must
    // NOT appear bound to an eventType key anywhere in this file.
    expect(SRC).not.toMatch(/eventType:\s*"reviewer_reconcile_run"/);
  });
});

// =============================================================================
// Part 3 — Reader (runtime-readiness.checkWorkers) uses the same constant
// =============================================================================

describe("Phase 32.7 — workers readiness check uses the canonical constant", () => {
  const SRC = readApi("src/runtime/runtime-readiness.ts");
  const fnIdx = SRC.indexOf("async function checkWorkers");
  expect(fnIdx).toBeGreaterThan(-1);
  const fnEnd = SRC.indexOf("\n}\n", fnIdx);
  const fn = SRC.slice(fnIdx, fnEnd);

  it("resolves the heartbeat wire string through the canonical contract", () => {
    expect(fn).toMatch(
      /wireStringFor\s*\}\s*=\s*await import\(\s*"@proovra\/shared-runtime\/ops"\s*\)/,
    );
    expect(fn).toMatch(/wireStringFor\(\s*"WORKER_HEARTBEAT"\s*\)/);
  });

  it("queries SecurityEvent with the canonical wire string variable (no inline literal)", () => {
    expect(fn).toMatch(
      /prisma\.securityEvent\.findFirst\(\s*\{\s*where:\s*\{\s*eventType:\s*heartbeatWireString\s*\}/,
    );
    // The legacy inline literal "reviewer_reconcile_run" must not
    // appear in the where-clause of this function any more — it can
    // only enter via the canonical resolver.
    expect(fn).not.toMatch(
      /where:\s*\{\s*eventType:\s*"reviewer_reconcile_run"\s*\}/,
    );
  });
});

// =============================================================================
// Part 4 — Telemetry-query failure is UNKNOWN, never DEGRADED or CRITICAL
// =============================================================================

describe("Phase 32.7 — workers readiness query failure is bounded", () => {
  const SRC = readApi("src/runtime/runtime-readiness.ts");
  const fnIdx = SRC.indexOf("async function checkWorkers");
  const fnEnd = SRC.indexOf("\n}\n", fnIdx);
  const fn = SRC.slice(fnIdx, fnEnd);

  it("catch arm returns UNKNOWN (not DEGRADED, not CRITICAL)", () => {
    const catchIdx = fn.lastIndexOf("} catch");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchSlice = fn.slice(catchIdx);
    expect(catchSlice).toMatch(/status:\s*"UNKNOWN"/);
    expect(catchSlice).not.toMatch(/status:\s*"DEGRADED"/);
    expect(catchSlice).not.toMatch(/status:\s*"CRITICAL"/);
  });

  it("catch arm uses the bounded `telemetry_query_failed` reasonCode", () => {
    const catchIdx = fn.lastIndexOf("} catch");
    const catchSlice = fn.slice(catchIdx);
    expect(catchSlice).toMatch(/reasonCode:\s*"telemetry_query_failed"/);
  });

  it("catch arm detail clarifies that the SIGNAL is unknown, the worker is not necessarily broken", () => {
    const catchIdx = fn.lastIndexOf("} catch");
    const catchSlice = fn.slice(catchIdx);
    // The detail message must explicitly state that this is a
    // query-side condition, not a worker-process condition.
    expect(catchSlice).toMatch(/unknown\s*\(not\s*degraded\)/);
  });
});

// =============================================================================
// Part 5 — Subsystem → domain map mirrors the canonical catalog
// =============================================================================

describe("Phase 32.7 — subsystem→domain map", () => {
  const SRC = readApi("src/runtime/runtime-readiness.ts");

  it("declares the SubsystemAffectedDomain type union", () => {
    expect(SRC).toMatch(/export type SubsystemAffectedDomain\s*=/);
    for (const domain of [
      "core_evidence",
      "reviewer_ops",
      "governance_lifecycle",
      "workflow_engine",
      "integrations",
      "identity",
      "operational_incidents",
      "search_discovery",
      "media_intelligence",
      "platform_telemetry",
    ]) {
      expect(SRC).toContain(`"${domain}"`);
    }
  });

  it("typed Record<SubsystemId, SubsystemAffectedDomain> assigns a domain to every subsystem", () => {
    expect(SRC).toMatch(
      /SUBSYSTEM_AFFECTED_DOMAIN:\s*Record<SubsystemId,\s*SubsystemAffectedDomain>/,
    );
    // Every member of SubsystemId must appear as a key. The TS type
    // already enforces this at compile time; we cross-check the
    // literal entries to catch refactors that widen the type but
    // forget to update the map.
    for (const subsystemId of [
      "schema",
      "migrations",
      "database",
      "redis",
      "s3_object_lock",
      "queues",
      "workers",
      "metrics",
      "sentry",
      "cron_secrets",
      "search_indexing",
      "multipart_storage",
      "media_intelligence",
      "investigation_graph",
    ]) {
      const re = new RegExp(`${subsystemId}:\\s*"`);
      expect(SRC).toMatch(re);
    }
  });

  it("workers subsystem affects only reviewer_ops domain (not platform-wide)", () => {
    expect(SRC).toMatch(/workers:\s*"reviewer_ops"/);
  });

  it("redis subsystem affects only platform_telemetry (a readiness probe condition, not a feature failure)", () => {
    expect(SRC).toMatch(/redis:\s*"platform_telemetry"/);
  });

  it("migrations subsystem affects only platform_telemetry (signal source, not a feature)", () => {
    expect(SRC).toMatch(/migrations:\s*"platform_telemetry"/);
  });

  it("`runReadinessCheck` injects affectedDomain into every subsystem result", () => {
    expect(SRC).toMatch(
      /subsystems:\s*SubsystemReadiness\[\]\s*=\s*rawSubsystems\.map\(\s*\(s\)\s*=>\s*\(\{\s*\.\.\.s,\s*affectedDomain:\s*SUBSYSTEM_AFFECTED_DOMAIN\[s\.id\]/,
    );
  });
});

// =============================================================================
// Part 6 — Frontend RuntimeStatusBanner accepts `forDomains` and filters
// =============================================================================

/*
 * =============================================================================
 * PART 6/7 — SUPERSEDED BY ADM-P1-003 / OWN-1, AND REPLACED WITH THE INVERSE.
 * =============================================================================
 * Phase 32.7 gave `RuntimeStatusBanner` a `forDomains` prop so a tenant page
 * could show the banner only when a failing platform subsystem affected that
 * page's domain. It worked, and the cases below asserted it thoroughly.
 *
 * The scoping was built on data the banner should never have had. To decide
 * "does this failure affect reviewer_ops?", the component had to READ the
 * failing subsystems — and it got them from `GET /admin/runtime/readiness`,
 * the full platform aggregator, authorised by workspace membership plus
 * `audit.read`. Ordinary tenant users on `/evidence/:id`, `/governance/policy`
 * and `/reviewer-ops/*` were being shown platform subsystem ids, reason codes,
 * operator detail and remediation hints: instructions for repairing PROOVRA's
 * deployment, on pages that belong to customers.
 *
 * OWN-1 settles it — runtime, migrations, schema drift, worker and queue
 * detail are platform-admin only — so the banner now reads
 * `GET /v1/runtime/status`, whose entire body is
 * `{ status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE" }`.
 *
 * `forDomains` could not survive that. Domain scoping needs the subsystem
 * list, the tenant projection withholds it, and a prop that silently stopped
 * filtering would be a permanently-true condition dressed as a control. So it
 * was removed rather than left inert, and every call site lost it.
 *
 * THE COST IS REAL AND IS STATED RATHER THAN HIDDEN: a degraded platform now
 * shows this banner on every page that mounts it, not only on the pages whose
 * domain was affected. That is a worse banner and a correct boundary, and the
 * cases below now assert the boundary — that the component cannot reach the
 * platform payload at all — because that is the property whose loss would
 * matter.
 */
describe("RuntimeStatusBanner reads only the tenant-safe projection", () => {
  const SRC = readWeb("components/operational/RuntimeStatusBanner.tsx");

  it("reads GET /v1/runtime/status and nothing else", () => {
    expect(SRC).toContain('"/v1/runtime/status"');
    // The platform aggregator, in either spelling. Absence is asserted against
    // CODE: the file deliberately NAMES the route it stopped reading, in the
    // docblock that explains why, and a check that failed on the explanation
    // would be closed by deleting the explanation.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("/admin/runtime/readiness");
    expect(code).not.toContain("/v1/admin/runtime/readiness");
  });

  it("cannot render a platform subsystem, a reason code or a remediation hint", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const forbidden of [
      "reasonCode",
      "remediationHint",
      "subsystems",
      "affectedDomain",
    ]) {
      expect(
        code.includes(forbidden),
        `the tenant banner reaches for ${forbidden}, which the tenant-safe projection does not carry`,
      ).toBe(false);
    }
  });

  it("declares only the three values the projection can answer", () => {
    expect(SRC).toMatch(
      /TenantRuntimeStatus\s*=\s*"HEALTHY"\s*\|\s*"DEGRADED"\s*\|\s*"UNAVAILABLE"/,
    );
  });

  it("the `forDomains` prop is GONE, not inert", () => {
    // An accepted-but-ignored prop is worse than none: every call site would
    // still read as scoped while nothing filtered.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/forDomains/);
    expect(code).not.toMatch(/RuntimeOperationalDomain/);
  });

  it("fails CLOSED — a failed status read renders a banner, never silence", () => {
    // Rendering nothing on a failed read is visually identical to HEALTHY,
    // which is the one thing this component must never assert without proof.
    expect(SRC).toMatch(/UNKNOWN|setError\(/);
  });
});

// =============================================================================
// Part 7 — no page scopes the banner any more, and none may reintroduce it
// =============================================================================

describe("no page passes the removed scoping prop", () => {
  const CONSUMERS = [
    "apps/web/components/governance-experience/GovernanceControlPlane.tsx",
    "apps/web/app/(app)/evidence/[id]/page.tsx",
    "apps/web/app/(app)/reviewer-ops/escalations/page.tsx",
    "apps/web/components/reviewer-experience/ReviewerConsole.tsx",
    "apps/web/app/(app)/governance/policy/page.tsx",
    "apps/web/app/(app)/reviewer-ops/sla/page.tsx",
  ] as const;

  for (const file of CONSUMERS) {
    it(`${file} still mounts the banner, unscoped`, () => {
      const src = readFileSync(
        fileURLToPath(new URL(`../../../${file}`, import.meta.url)),
        "utf8",
      );
      // Still mounted: the boundary fix must not have quietly removed the
      // banner from the pages that need it.
      expect(src, "the runtime banner is no longer mounted here").toContain(
        "<RuntimeStatusBanner",
      );
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(
        code.includes("forDomains"),
        "forDomains is passed to a component that no longer accepts it — the page reads as scoped while nothing filters",
      ).toBe(false);
    });
  }

  it("the platform observability page mounts NO workspace banner at all", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/admin/platform/observability/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // ADM-013 PHASE 1 — this asserted the page kept an UNSCOPED banner because it "IS
    // the runtime visibility surface". The banner was never unscoped: it took
    // a teamId and reported one workspace. Being the runtime surface is the
    // reason it must not carry a tenant widget, not a licence to.
    expect(src).not.toMatch(/<RuntimeStatusBanner/);
  });
});

// =============================================================================
// Part 8 — No regression on the existing readiness contract
// =============================================================================

describe("Phase 32.7 — no regression on the existing readiness contract", () => {
  const SRC = readApi("src/runtime/runtime-readiness.ts");

  it("rollUpStatus still escalates CRITICAL > DEGRADED > UNKNOWN > HEALTHY", () => {
    expect(SRC).toMatch(
      /if\s*\(\s*subsystems\.some\(\(s\)\s*=>\s*s\.status === "CRITICAL"\)\)\s*return\s*"CRITICAL"/,
    );
    expect(SRC).toMatch(
      /if\s*\(\s*subsystems\.some\(\(s\)\s*=>\s*s\.status === "DEGRADED"\)\)\s*return\s*"DEGRADED"/,
    );
    expect(SRC).toMatch(
      /if\s*\(\s*subsystems\.every\(\(s\)\s*=>\s*s\.status === "HEALTHY"\)\)\s*return\s*"HEALTHY"/,
    );
    expect(SRC).toMatch(/return\s*"UNKNOWN"/);
  });

  it("Phase 32.6.5 stale-rolled-back migration dedup still in place", () => {
    expect(SRC).toMatch(/latestPerMigration\s*=\s*new\s+Map/);
    expect(SRC).toMatch(/totalRowsScanned/);
  });

  it("Phase 32.6.1 live Redis ping with bounded timeouts still in place", () => {
    expect(SRC).toMatch(/connectTimeout:\s*500/);
    expect(SRC).toMatch(/maxRetriesPerRequest:\s*0/);
    expect(SRC).toMatch(/enableOfflineQueue:\s*false/);
  });
});
