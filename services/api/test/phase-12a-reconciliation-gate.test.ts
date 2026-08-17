/**
 * PHASE 12A — SYSTEM-TRUTH RECONCILIATION GATE.
 *
 * Proves the reconciliation ARTIFACTS accurately describe the real tree (exact
 * set equality between registered routes and the capability map), and REPORTS
 * the classification/vertical counts. Per the Phase-12A mandate it does NOT
 * force any classification count to zero — it fails only if the artifacts drift
 * from the actual code (phantom or missing entries), which would make the
 * baseline dishonest.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const ARCH = resolve(REPO, "docs/architecture");

// Live registered routes (method+path), from the CANONICAL analyzer.
//
// FINAL-001 (2026-08-15). This set used to be built by a regex over the route
// files, which made it a third independent opinion about what is registered —
// and it was wrong in both directions. It could not see a path held in a
// constant (`app.get(AI_POLICY_PATH, …)`), so those routes were simply absent;
// and it recorded a loop-generated `app.post(`/v1/admin/orgs/:id/${leg}`)` as one
// route at a path containing a literal `${leg}`, rather than the two real ones.
// A gate that asserts "the map equals the truth" is worth nothing when its idea
// of the truth is a fourth parser. It now reads the same AST inventory the map
// is generated from, so the assertion below means what it says: the artifact on
// disk is a current measurement, not a stale one.
const registered = new Set<string>();
{
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { indexApiFunctions, extractRoutes } = require("../scripts/capability-authority/routes.mjs");
  const { routes } = extractRoutes(indexApiFunctions()) as {
    routes: Array<{ route: string; methods: string[] }>;
  };
  for (const r of routes) for (const m of r.methods) registered.add(`${m.toUpperCase()} ${r.route}`);
}

type Cap = { method: string; route: string; classification: string; vertical: string };
const map = JSON.parse(read(join(ARCH, "current-runtime-capability-map.json"))) as {
  capabilities: Cap[]; classificationCounts: Record<string, number>; verticalCounts: Record<string, number>;
};

describe("Phase 12A — system-truth reconciliation gate", () => {
  it("all required artifacts exist", () => {
    const required = [
      "target-platform-constitution.md",
      "current-runtime-capability-map.json",
      "target-replacement-matrix.json",
      "plan-page-visibility-matrix.json",
      "user-journey-coverage.json",
      "schema-migration-classification.json",
      "repository-provenance.json",
    ];
    const missing = required.filter((f) => !existsSync(join(ARCH, f)));
    expect(missing, `missing reconciliation artifacts:\n${missing.join("\n")}`).toEqual([]);
  });

  it("capability map == registered routes (no phantom, no missing) — the map is honest", () => {
    const mapKeys = new Set(map.capabilities.map((c) => `${c.method} ${c.route}`));
    const phantom = [...mapKeys].filter((k) => !registered.has(k));
    const missing = [...registered].filter((k) => !mapKeys.has(k));
    expect(phantom, `capability-map entries not registered (${phantom.length}):\n${phantom.slice(0, 20).join("\n")}`).toEqual([]);
    expect(missing, `registered routes absent from the capability map (${missing.length}):\n${missing.slice(0, 20).join("\n")}`).toEqual([]);
  });

  it("every capability is classified into exactly one known class", () => {
    const KNOWN = new Set([
      "TARGET_COMPLETE", "TARGET_PARTIAL", "LEGACY_ACTIVE", "PARALLEL_SYSTEM", "BACKEND_ONLY_UNWIRED",
      "FRONTEND_ONLY_BROKEN", "INTERNAL_REQUIRED", "FUTURE_NOT_SHIPPING", "HISTORICAL_PRESERVE",
      "COMPATIBILITY_TEMPORARY", "UNCLASSIFIED",
    ]);
    const bad = map.capabilities.filter((c) => !KNOWN.has(c.classification)).map((c) => `${c.method} ${c.route}:${c.classification}`);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("PHASE 12B WAVE 0.1 — journey overall counts equal the actual per-journey entries", () => {
    const jc = JSON.parse(read(join(ARCH, "user-journey-coverage.json"))) as {
      journeys: Array<{ id: number; overall: string; layers?: Array<{ status: string }> }>;
    };
    expect(jc.journeys.length).toBe(15);
    const counts: Record<string, number> = {};
    for (const j of jc.journeys) counts[j.overall] = (counts[j.overall] ?? 0) + 1;
    // Conservation: every journey is counted exactly once.
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(15);
    // Consistency: a journey containing a PARALLEL_AUTHORITY layer cannot be COMPLETE.
    const dishonest = jc.journeys.filter(
      (j) => j.overall === "COMPLETE" && (j.layers ?? []).some((l) => l.status === "PARALLEL_AUTHORITY"),
    );
    expect(
      dishonest.map((j) => j.id),
      "journeys marked COMPLETE despite a PARALLEL_AUTHORITY layer",
    ).toEqual([]);
    // eslint-disable-next-line no-console
    console.log("PHASE 12B journeys:", JSON.stringify(counts));
  });

  it("PHASE 12B — corrected evidence accounting: 4 buckets over every operation", () => {
    // BEHAVIORALLY_PROVEN: a suite EXERCISES the route (inject/render firing
    // requests) — structural/source-contract tests can never land here.
    // BEHAVIORAL_SERVICE_ONLY: curated canonical-service matrices (executable
    // attribution: suite exists + contains the service symbol).
    const KNOWN = new Set(["BEHAVIORALLY_PROVEN", "BEHAVIORAL_SERVICE_ONLY", "STRUCTURALLY_CONNECTED_ONLY", "UNPROVEN"]);
    const ev: Record<string, number> = {};
    for (const c of map.capabilities) {
      const lvl = (c as { evidenceLevel?: string }).evidenceLevel;
      expect(lvl && KNOWN.has(lvl), `missing/unknown evidenceLevel on ${c.method} ${c.route}`).toBe(true);
      ev[lvl as string] = (ev[lvl as string] ?? 0) + 1;
    }
    expect(Object.values(ev).reduce((a, b) => a + b, 0)).toBe(map.capabilities.length);
    // eslint-disable-next-line no-console
    console.log("PHASE 12B evidence buckets:", JSON.stringify(ev));
  });

  it("PHASE 12B — MISSING vs BACKEND_ONLY_UNWIRED are DIFFERENT executable sets (MISSING ⊆ UNWIRED)", () => {
    // MISSING (wiring-registry): operations of the FIXED 139-op STEP-3 baseline
    //   (routes that had no product consumer at the STEP-3 audit) still awaiting
    //   a terminal disposition (WIRED / EXTERNAL_MACHINE / INTERNAL / REMOVED).
    // BACKEND_ONLY_UNWIRED (capability map): EVERY currently-registered operation
    //   with no product or machine consumer — a live superset recomputed from the
    //   tree, so it also contains unconsumed operations that were OUTSIDE the
    //   STEP-3 baseline (e.g. sibling METHODS of consumed paths, or ops
    //   classified in slices a–d whose consumers are machine-implicit).
    const wiring = JSON.parse(read(join(ARCH, "route-classification/wiring-registry.json"))) as Array<{
      method: string; route: string; finalState: string;
    }>;
    const missing = new Set(
      wiring.filter((e) => e.finalState === "MISSING").map((e) => `${e.method} ${e.route}`),
    );
    const unwired = new Set(
      map.capabilities.filter((c) => c.classification === "BACKEND_ONLY_UNWIRED").map((c) => `${c.method} ${c.route}`),
    );
    const missingNotUnwired = [...missing].filter((k) => !unwired.has(k));
    // Every still-MISSING baseline op must still be unconsumed in the live map.
    expect(missingNotUnwired, `MISSING ops no longer unwired (should be resolved in the registry):\n${missingNotUnwired.join("\n")}`).toEqual([]);
    const delta = [...unwired].filter((k) => !missing.has(k));
    // eslint-disable-next-line no-console
    console.log(`PHASE 12B MISSING=${missing.size} ⊆ BACKEND_ONLY_UNWIRED=${unwired.size}; outside-baseline unconsumed delta=${delta.length}:`, JSON.stringify(delta.slice(0, 12)));
  });

  it("REPORTS the system-truth counts (NOT forced to zero during 12A)", () => {
    // eslint-disable-next-line no-console
    console.log("PHASE 12A classification:", JSON.stringify(map.classificationCounts));
    // eslint-disable-next-line no-console
    console.log("PHASE 12A vertical:", JSON.stringify(map.verticalCounts));
    const replacement = JSON.parse(read(join(ARCH, "target-replacement-matrix.json"))) as { targetActionCounts: Record<string, number>; totalReplacementItems: number };
    // eslint-disable-next-line no-console
    console.log("PHASE 12A replacement actions:", JSON.stringify(replacement.targetActionCounts));
    // The baseline conserves: every capability is counted once.
    const total = Object.values(map.classificationCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(map.capabilities.length);
    // UNCLASSIFIED is reported, not asserted zero — it blocks Phase-12 completion, not 12A.
    expect(map.classificationCounts.UNCLASSIFIED ?? 0).toBeGreaterThanOrEqual(0);
  });
});
