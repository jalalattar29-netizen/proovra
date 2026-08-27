/**
 * EVERY INCIDENT STATUS WRITER GOES THROUGH THE CANONICAL AUTHORITY.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A GATE AND NOT A REVIEW
 * ---------------------------------------------------------------------------
 * An operational condition has two kinds of writer — operators transitioning
 * it deliberately, and reconcilers observing its source on a schedule — and the
 * decision tree used to exist TWICE, once in the API and once in the Worker.
 * That is how the two drifted, and how a rule fixed in one kept failing in the
 * other for months.
 *
 * `decideObservationTransition` and `decideManualResolution` are now that
 * decision, once, in `@proovra/shared-runtime`. This file holds the property
 * that makes them worth having: NOTHING ELSE writes `status`.
 *
 * It is computed from the tree on every run rather than recorded in a document
 * beside it. A governance artifact that states a conclusion without computing
 * it is the failure mode this repository has already paid for once.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/**
 * Source with comments removed.
 *
 * Every "this code must not contain X" check has to read CODE. A doc comment
 * that quotes the banned pattern in order to explain what was removed would
 * otherwise fail the very check it documents.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * THE INVENTORY.
 *
 * Every production module that writes `operational_incidents`, with what it
 * writes and which authority governs it. A module that starts writing status
 * and is absent from here fails the totality check below.
 */
type Writer = {
  module: string;
  host: "API" | "WORKER";
  /** Does it write the `status` column? */
  writesStatus: boolean;
  /** The shared authority it consults, or why it needs none. */
  authority: string;
};

const WRITERS: readonly Writer[] = [
  {
    module: "../src/services/observability/incident.service.ts",
    host: "API",
    writesStatus: true,
    authority:
      "decideObservationTransition (observations) + decideManualResolution (operators)",
  },
  {
    module: "../src/services/operations/evidence-integrity-conditions.service.ts",
    host: "API",
    writesStatus: true,
    authority: "decideObservationTransition — recovery from Evidence truth",
  },
  {
    module: "../../worker/src/governance/incident-emitter.ts",
    host: "WORKER",
    writesStatus: true,
    authority: "decideObservationTransition — the SAME pure function",
  },
  {
    module: "../src/services/operations/source-truth-recovery.service.ts",
    host: "API",
    writesStatus: true,
    authority:
      "decideObservationTransition — recovery proven by the source's own probe",
  },
  {
    module: "../src/services/ops/operational-seed.service.ts",
    host: "API",
    // A bounded `deleteMany` over ids the seed itself created. It removes
    // rows rather than transitioning them, so no lifecycle decision applies —
    // and it is listed HERE rather than omitted, so the absence of an
    // authority is on the record instead of looking like an oversight.
    writesStatus: false,
    authority: "N/A — deletes its own seeded rows by id; writes no status",
  },
];

/** Any Prisma call that could write the incident table. */
const WRITE_CALL = /operationalIncident\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g;

describe("§12 — the incident writer inventory is complete", () => {
  it("prints the inventory", () => {
    // eslint-disable-next-line no-console -- the inventory IS the deliverable
    console.table(
      WRITERS.map((w) => ({
        module: w.module.replace(/^\.\.\/(\.\.\/)?/, ""),
        host: w.host,
        writesStatus: w.writesStatus,
        authority: w.authority,
      })),
    );
    expect(WRITERS.length).toBeGreaterThan(0);
  });

  it("every production module that writes the table is inventoried", async () => {
    // The search space: the two services' source trees and the shared package.
    // Tests are excluded — a fixture writing a row directly is how a test
    // reproduces a legacy state the product now refuses to create, and that is
    // the point of it.
    const roots = [
      "../src",
      "../../worker/src",
      "../../../packages/shared-runtime/src",
    ];
    const found = new Set<string>();
    const { execFileSync } = await import("node:child_process");
    const repo = fileURLToPath(new URL("../../..", import.meta.url));
    for (const root of roots) {
      const abs = fileURLToPath(new URL(root, import.meta.url));
      let listing: string;
      try {
        listing = execFileSync("git", ["ls-files", abs], {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch {
        continue;
      }
      for (const rel of listing.split("\n").map((l) => l.trim()).filter(Boolean)) {
        if (!rel.endsWith(".ts")) continue;
        const src = code(`../../../${rel}`);
        WRITE_CALL.lastIndex = 0;
        if (WRITE_CALL.test(src)) found.add(rel);
      }
    }

    const inventoried = new Set(
      WRITERS.map((w) =>
        fileURLToPath(new URL(w.module, import.meta.url))
          .replace(/\\/g, "/")
          .replace(repo.replace(/\\/g, "/"), "")
          .replace(/^\/+/, ""),
      ),
    );
    const unlisted = [...found].filter((f) => !inventoried.has(f));
    expect(
      unlisted,
      `modules writing operational_incidents but absent from the inventory:\n${unlisted.join("\n")}`,
    ).toEqual([]);
  });

  it("every status writer consults the shared transition authority", () => {
    for (const w of WRITERS) {
      if (!w.writesStatus) continue;
      const src = code(w.module);
      expect(
        /decideObservationTransition|decideManualResolution/.test(src),
        `${w.module} writes status without the shared authority`,
      ).toBe(true);
      // …and imports it from the shared package rather than declaring a local
      // one with the same name.
      expect(
        /from "@proovra\/shared-runtime"/.test(src),
        `${w.module} does not import the shared authority`,
      ).toBe(true);
    }
  });

  it("the resolution-provenance table exists ONCE, in the shared package", () => {
    // It used to be a frozen literal in the API's incident service AND in the
    // Worker's emitter — two copies describing the same rows of the same
    // table, the second annotated "duplicated as data rather than imported".
    const shared = code("../../../packages/shared-runtime/src/incident-transition-authority.ts");
    expect(shared).toContain("resolved_by_domain_truth");
    expect(shared).toContain("RESOLUTION_EVENT_ORIGINS");

    for (const rel of [
      "../src/services/observability/incident.service.ts",
      "../../worker/src/governance/incident-emitter.ts",
    ]) {
      const src = code(rel);
      // No second literal. The API re-exports the shared constant under its
      // long-standing local name, which is an assignment and not a table.
      expect(
        /RESOLUTION_EVENT_ORIGINS[^=]*=\s*\n?\s*Object\.freeze\(\{/.test(src),
        `${rel} declares a second provenance table`,
      ).toBe(false);
      expect(src).toContain("@proovra/shared-runtime");
    }
  });

  it("the reopen and suppressed event names are shared constants, not literals", () => {
    // A rename in one host would otherwise silently stop the other's history
    // from being readable by `readResolutionOrigin`.
    for (const rel of [
      "../src/services/observability/incident.service.ts",
      "../../worker/src/governance/incident-emitter.ts",
    ]) {
      const src = code(rel);
      expect(src).toContain("REOPENED_EVENT");
      expect(src).toContain("OCCURRENCE_WHILE_SUPPRESSED_EVENT");
      expect(
        /eventType:\s*"reopened"/.test(src),
        `${rel} writes the reopen event as a bare literal`,
      ).toBe(false);
    }
  });

  it("both hosts resolve a condition's source from the SAME contract", () => {
    for (const rel of [
      "../src/services/observability/incident.service.ts",
      "../../worker/src/governance/incident-emitter.ts",
    ]) {
      expect(code(rel), rel).toContain("resolveConditionSource");
    }
  });

  it("no module outside the shared package declares a resolution-authority policy", () => {
    // The defect: a `Record<IncidentCategory, ...>` deciding whether an
    // operator could declare a condition over. Four sources write category
    // WORKER, so it was a rule about a set nobody had enumerated.
    for (const rel of [
      "../src/services/operations/remediation-registry.ts",
      "../src/services/operations/operations-source-registry.ts",
      "../src/services/observability/incident.service.ts",
      "../src/routes/ops.routes.ts",
    ]) {
      const src = code(rel);
      expect(src, rel).not.toContain("OPERATOR_RESOLUTION_AUTHORITY");
      expect(
        /Record<\s*IncidentCategory\s*,\s*(Operator)?ResolutionAuthority\s*>/.test(src),
        `${rel} declares resolution authority per category`,
      ).toBe(false);
    }
  });
});
