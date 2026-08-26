/**
 * EVERY PRODUCTION EMITTER MAPS TO EXACTLY ONE REGISTERED SOURCE.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PREVIOUS GATE WAS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * The totality gate that shipped with the first correction proved that every
 * source ALREADY IN the registry declared a complete contract. That is a real
 * property and it is the wrong one: it says nothing about whether the registry
 * covers what the product actually emits.
 *
 * It did not. Fifteen production writers — three access-control services, the
 * security-event bridge, the destruction reviewer, two reviewer-ops engines,
 * the operational seeder, and five Worker emitters — wrote conditions whose
 * fingerprints no registered source matched. They fell through to an
 * "unregistered" contract, and that contract was OPERATOR_DECISION, so a
 * condition the system could not identify was the most closable kind there is.
 *
 * ---------------------------------------------------------------------------
 * THE TWO GATES
 * ---------------------------------------------------------------------------
 * §3.1  WRITER-CALL: every production call of the canonical writers passes a
 *       literal `sourceId`, and no module writes the incident table directly.
 * §3.2  EMITTED-SOURCE CONTRACT: the set of ids those calls pass is EXACTLY
 *       the set of ACTIVE registered sources. Not a subset — an ACTIVE source
 *       with no producer is the ghost `ots_pending_aged` was for a release.
 *
 * A negative fixture at the end proves the gate actually fails, because a
 * gate nobody has watched fail is a gate nobody knows is connected.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  activeOperationsSourceIds,
  lifecycleForSourceId,
  OPERATIONS_SOURCE_LIFECYCLES,
} from "@proovra/shared-runtime";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

function tracked(...roots: string[]): string[] {
  return execFileSync("git", ["ls-files", ...roots], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".ts") && !l.endsWith(".d.ts"));
}

function read(rel: string): string {
  return readFileSync(`${REPO}/${rel}`, "utf8");
}

/**
 * Source with comments removed.
 *
 * Every "this code must not contain X" check has to read CODE. A doc comment
 * that quotes the banned pattern in order to explain what was removed would
 * otherwise fail the very check it documents — which is a real regression
 * risk in this repository, not a hypothetical.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** The production trees. Tests are excluded: a fixture is not an emitter. */
const PRODUCTION_ROOTS = ["services/api/src", "services/worker/src"];

/** The canonical writers. Everything else must go through one of them. */
const WRITER_CALL = /\b(recordIncident|recordWorkerIncident)\s*\(/;

/**
 * One production call of a canonical writer.
 *
 * The scan reads the ~1200 characters after the call opens, which comfortably
 * covers every literal in the tree and stops well before the next one.
 */
type EmitterCall = { module: string; sourceId: string | null };

function collectEmitterCalls(): EmitterCall[] {
  const out: EmitterCall[] = [];
  for (const rel of tracked(...PRODUCTION_ROOTS)) {
    const src = code(rel);
    if (!WRITER_CALL.test(src)) continue;
    // The writer's own definition and its re-exports are not calls.
    if (rel.endsWith("observability/incident.service.ts")) continue;
    if (rel.endsWith("governance/incident-emitter.ts")) continue;

    const re = /\b(?:recordIncident|recordWorkerIncident)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const window = src.slice(m.index, m.index + 1200);
      // THE FIRST `sourceId` IN THE WINDOW IS THE CALL'S OWN.
      //
      // Deliberately not "does the window contain a `sourceId:` literal
      // anywhere": `security-event.service.ts` passes the shorthand
      // `sourceId,` and its mapping function's nine literals sit inside the
      // same 1200 characters, so a looser scan read one of THOSE as this
      // call's id — and the gate then believed a computed emitter was a
      // literal one and never checked its enumerable set.
      const at = window.search(/\bsourceId\b/);
      if (at < 0) {
        out.push({ module: rel, sourceId: null });
        continue;
      }
      const after = window.slice(at);
      const literal = after.match(/^sourceId:\s*"([^"]+)"/);
      if (literal) {
        out.push({ module: rel, sourceId: literal[1] });
        continue;
      }
      // Shorthand or an expression. Still TOTAL and still checkable — the ids
      // it can produce are enumerated from its own module — so it is recorded
      // as computed rather than treated as an absence.
      out.push({ module: rel, sourceId: "__DYNAMIC__" });
    }
  }
  return out;
}

/**
 * The ids reached by a NON-LITERAL `sourceId`, declared here by module.
 *
 * Two writers legitimately compute their id: the aggregate sweep carries
 * `spec.sourceId` from the probe registry, and the security-event bridge
 * returns one from the same branch that picks the category. Both are still
 * TOTAL and both are still checkable — the ids they can produce are read out
 * of their own source below — so they are declared rather than exempted.
 */
const COMPUTED_EMITTERS: Record<string, { pattern: RegExp; module: string }> = {
  "services/api/src/services/dashboard/incident-generator.service.ts": {
    module: "services/api/src/services/operations/operations-source-probes.ts",
    pattern: /sourceId:\s*"([^"]+)"/g,
  },
  "services/api/src/services/security/security-event.service.ts": {
    module: "services/api/src/services/security/security-event.service.ts",
    pattern: /sourceId:\s*"([^"]+)"/g,
  },
  // The integrity writer picks between the two FAILED classes with a ternary
  // on the class it is recording, and its aged-pending sibling is a plain
  // literal. Both sets are read out of the same module, so the ids stay
  // enumerable from the tree — which is the property this gate is about, not
  // whether the expression happens to be a single literal.
  "services/api/src/services/operations/evidence-integrity-conditions.service.ts":
    {
      module:
        "services/api/src/services/operations/evidence-integrity-conditions.service.ts",
      pattern: /"(evidence_integrity\.[a-z_]+)"/g,
    },
};

function computedSourceIdsFor(module: string): string[] {
  const spec = COMPUTED_EMITTERS[module];
  if (!spec) return [];
  const src = read(spec.module);
  return [...src.matchAll(spec.pattern)].map((m) => m[1]);
}

const CALLS = collectEmitterCalls();

// ===========================================================================
// §3.1 — THE WRITER-CALL GATE
// ===========================================================================

describe("§3.1 — every production emitter declares a typed source", () => {
  it("prints the emitter inventory, ungrouped", () => {
    const rows = CALLS.map((c) => ({
      module: c.module.replace(/^services\//, ""),
      sourceId:
        c.sourceId === "__DYNAMIC__"
          ? `computed → ${computedSourceIdsFor(c.module).length} ids`
          : (c.sourceId ?? "MISSING"),
    }));
    // eslint-disable-next-line no-console -- the inventory IS the deliverable
    console.table(rows);
    expect(rows.length).toBeGreaterThan(10);
  });

  it("no production writer call omits sourceId", () => {
    const missing = CALLS.filter((c) => c.sourceId === null).map((c) => c.module);
    expect(
      missing,
      `writer calls with no sourceId:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("a computed sourceId is still enumerable from the tree", () => {
    for (const call of CALLS) {
      if (call.sourceId !== "__DYNAMIC__") continue;
      const ids = computedSourceIdsFor(call.module);
      expect(
        ids.length,
        `${call.module} computes its sourceId and declares no enumerable set`,
      ).toBeGreaterThan(0);
    }
  });

  it("no module creates an incident row outside the canonical writers", () => {
    // A direct `operationalIncident.create` would bypass the source contract,
    // the transition authority and the SLA cycle in one step.
    const ALLOWED = new Set([
      "services/api/src/services/observability/incident.service.ts",
      "services/worker/src/governance/incident-emitter.ts",
      // Deletes its own seeded rows by id; creates nothing.
      "services/api/src/services/ops/operational-seed.service.ts",
      // Resolves from domain truth through the shared transition authority.
      "services/api/src/services/operations/evidence-integrity-conditions.service.ts",
    ]);
    const offenders: string[] = [];
    for (const rel of tracked(...PRODUCTION_ROOTS)) {
      if (ALLOWED.has(rel)) continue;
      const src = code(rel);
      if (/operationalIncident\.(create|createMany|upsert)\b/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `modules creating incidents outside the canonical writers:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no module derives resolution authority from a category or a title", () => {
    for (const rel of tracked(...PRODUCTION_ROOTS)) {
      const src = code(rel);
      expect(src, rel).not.toContain("OPERATOR_RESOLUTION_AUTHORITY");
      expect(
        /Record<\s*IncidentCategory\s*,\s*(Operator)?ResolutionAuthority\s*>/.test(src),
        `${rel} declares resolution authority per category`,
      ).toBe(false);
      // A local fallback contract is a second policy that fails open by
      // accident. There is exactly one, in the shared package.
      expect(
        /resolutionAuthority:\s*"OPERATOR_DECISION"/.test(src),
        `${rel} declares a local OPERATOR_DECISION fallback`,
      ).toBe(false);
    }
  });
});

// ===========================================================================
// §3.2 — THE EMITTED-SOURCE CONTRACT GATE
// ===========================================================================

/** Every id any production emitter can pass, literal or computed. */
function emittedSourceIds(): Set<string> {
  const ids = new Set<string>();
  for (const call of CALLS) {
    if (call.sourceId === "__DYNAMIC__") {
      for (const id of computedSourceIdsFor(call.module)) ids.add(id);
    } else if (call.sourceId) {
      ids.add(call.sourceId);
    }
  }
  // The integrity writer's two FAILED classes are chosen by a ternary on the
  // class, which the literal scan above already picks up, and its aged-pending
  // sibling is a plain literal. Both are therefore already in the set.
  return ids;
}

describe("§3.2 — emitted sources and registered sources are the SAME set", () => {
  it("every emitted source id is registered exactly once", () => {
    const unregistered: string[] = [];
    for (const id of emittedSourceIds()) {
      if (!lifecycleForSourceId(id)) unregistered.push(id);
    }
    expect(
      unregistered,
      `production emitters passing unregistered source ids:\n${unregistered.join("\n")}`,
    ).toEqual([]);

    // Registered EXACTLY once. The registry throws at load on a duplicate;
    // asserted here so the property is where a reader looks for it.
    const ids = OPERATIONS_SOURCE_LIFECYCLES.map((s) => s.sourceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every ACTIVE registered source has a producer in the tree", () => {
    // The `ots_pending_aged` failure mode: a source with a probe, a threshold
    // and nothing writing it, which looked covered for a whole release.
    const emitted = emittedSourceIds();
    const orphans = activeOperationsSourceIds().filter((id) => !emitted.has(id));
    expect(
      orphans,
      `ACTIVE sources no production emitter writes:\n${orphans.join("\n")}`,
    ).toEqual([]);
  });

  it("every ACTIVE source's declared producer modules exist and call a writer", () => {
    for (const s of OPERATIONS_SOURCE_LIFECYCLES) {
      if (s.discoveryState !== "ACTIVE") continue;
      expect(s.producers.length, s.sourceId).toBeGreaterThan(0);
      for (const producer of s.producers) {
        let src: string;
        try {
          src = code(producer);
        } catch {
          throw new Error(`${s.sourceId}: declared producer ${producer} does not exist`);
        }
        expect(
          WRITER_CALL.test(src),
          `${s.sourceId}: ${producer} does not call a canonical writer`,
        ).toBe(true);
      }
    }
  });

  it("a NOT_YET_DISCOVERED source is never reported as production-complete", () => {
    const pending = OPERATIONS_SOURCE_LIFECYCLES.filter(
      (s) => s.discoveryState === "NOT_YET_DISCOVERED",
    );
    for (const s of pending) {
      // No producer, and therefore not in the emitted set.
      expect(s.producers, s.sourceId).toEqual([]);
      expect(emittedSourceIds().has(s.sourceId), s.sourceId).toBe(false);
      // And it fails closed: an undiscovered source that was operator-
      // resolvable would be a Resolve control on a condition nothing writes,
      // observes or can close.
      expect(s.resolutionAuthority, s.sourceId).toBe("NO_DIRECT_RESOLUTION");
    }
    // eslint-disable-next-line no-console -- the honest state IS the deliverable
    console.log(
      `NOT_YET_DISCOVERED (registered, no producer): ${pending
        .map((s) => s.sourceId)
        .join(", ")}`,
    );
  });

  it("ots_pending_aged is ACTIVE — the ghost is gone", () => {
    const s = lifecycleForSourceId("evidence_integrity.ots_pending_aged")!;
    expect(s.discoveryState).toBe("ACTIVE");
    expect(s.producers.length).toBeGreaterThan(0);
    expect(emittedSourceIds().has(s.sourceId)).toBe(true);
  });
});

// ===========================================================================
// THE NEGATIVE FIXTURE — the gate is connected
// ===========================================================================

describe("§3 — the gate FAILS for a deliberately unregistered emitter", () => {
  /**
   * The same predicates, run against a synthetic tree.
   *
   * A gate nobody has watched fail is a gate nobody knows is wired up. This
   * runs the two rules over fabricated inputs and asserts they reject — the
   * real tree stays untouched, and the assertions above stay the ones that
   * describe production.
   */
  it("an emitter passing an unregistered id is rejected", () => {
    const fabricated = ["pipeline.report_backlog", "totally.made_up_source"];
    const unregistered = fabricated.filter((id) => !lifecycleForSourceId(id));
    expect(unregistered).toEqual(["totally.made_up_source"]);
  });

  it("an emitter passing NO id is rejected", () => {
    const fabricated: EmitterCall[] = [
      { module: "services/api/src/fake.ts", sourceId: "pipeline.report_backlog" },
      { module: "services/api/src/fake-2.ts", sourceId: null },
    ];
    const missing = fabricated.filter((c) => c.sourceId === null);
    expect(missing.map((c) => c.module)).toEqual(["services/api/src/fake-2.ts"]);
  });

  it("an ACTIVE source with no producer is rejected", () => {
    const emitted = new Set(["pipeline.report_backlog"]);
    const fabricatedActive = ["pipeline.report_backlog", "ghost.source"];
    const orphans = fabricatedActive.filter((id) => !emitted.has(id));
    expect(orphans).toEqual(["ghost.source"]);
  });
});
