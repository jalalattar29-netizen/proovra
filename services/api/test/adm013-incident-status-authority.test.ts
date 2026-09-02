/**
 * ONE DEFINITION OF "UNRESOLVED INCIDENT".
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * Six services answered "how many incidents are open?" and they disagreed:
 *
 *   admin/overview.service.ts                 status: "OPEN"
 *   admin/platform-health.service.ts          ["OPEN", "ACKNOWLEDGED"]
 *   operations/evidence-health.service.ts     ["OPEN", "ACKNOWLEDGED"]
 *   dashboard/incident-correlation.service.ts ["OPEN", "ACKNOWLEDGED"]
 *
 * So Admin Overview and System Health printed different incident counts for
 * the same platform at the same instant. Neither was wrong about its own
 * predicate, which is worse than one of them being broken: an operator
 * reconciling two consoles cannot tell a real change from a definitional one,
 * and the natural conclusion — "one of these pages is buggy" — is false.
 *
 * The Overview file already carried a comment about a 72-versus-76
 * discrepancy that a previous phase had reconciled. This is the same defect,
 * surviving in a different pair, which is why it is now a shared module with a
 * test rather than a fixed pair of call sites.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  UNRESOLVED_INCIDENT_STATUSES,
  UNTRIAGED_INCIDENT_STATUSES,
  unresolvedIncidentWhere,
  untriagedIncidentWhere,
} from "../src/services/operations/incident-open-statuses.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
/** Comments stripped: these files DISCUSS the predicates they must not inline. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the unresolved-incident predicate", () => {
  it("counts ACKNOWLEDGED as unresolved", () => {
    // An acknowledged incident is one a human has LOOKED at and not fixed.
    // Excluding it would make acknowledging an incident remove it from the
    // headline count — an interface that rewards clicking "acknowledge",
    // which is the wrong incentive to build into an operations surface.
    expect([...UNRESOLVED_INCIDENT_STATUSES].sort()).toEqual([
      "ACKNOWLEDGED",
      "OPEN",
    ]);
  });

  it("keeps 'untriaged' as a separate, narrower question", () => {
    // The narrow predicate is legitimate — "what has nobody looked at?" — and
    // naming it is what stops it being reached for when the headline was
    // wanted.
    expect([...UNTRIAGED_INCIDENT_STATUSES]).toEqual(["OPEN"]);
  });

  it("produces where-fragments that differ", () => {
    expect(unresolvedIncidentWhere()).not.toEqual(untriagedIncidentWhere());
    expect(unresolvedIncidentWhere()).toEqual({
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
    });
  });
});

describe("nobody redefines it locally", () => {
  const CONSUMERS = [
    "services/admin/overview.service.ts",
    "services/admin/platform-health.service.ts",
    "services/operations/evidence-health.service.ts",
  ];

  it("every consumer imports the shared authority", () => {
    for (const rel of CONSUMERS) {
      expect(
        code(rel),
        `${rel} must read the shared predicate, not its own copy`,
      ).toMatch(/incident-open-statuses\.js/);
    }
  });

  it("no consumer inlines an incident status list", () => {
    for (const rel of CONSUMERS) {
      const src = code(rel);
      // The literal pair, anywhere in code, is a second definition.
      expect(
        src,
        `${rel} inlines ["OPEN", "ACKNOWLEDGED"] instead of importing it`,
      ).not.toMatch(/\[\s*"OPEN"\s*,\s*"ACKNOWLEDGED"\s*\]/);
    }
  });

  it("the Overview security figure uses the NAMED untriaged predicate", () => {
    const src = code("services/admin/overview.service.ts");

    // The INLINED literal is the defect. The narrow predicate itself is
    // correct here, and getting that wrong cost a round trip: changing this
    // figure to the unresolved predicate put 12 beside the headline's 11 on
    // one page — a third number, which is worse than the inconsistency it was
    // meant to remove.
    //
    // The field is named `openIncidents` and drills into
    // `/admin/operations?status=OPEN`. Snapshot rule 5 requires a summary count
    // to use the same predicate as the list behind it, so it counts OPEN.
    expect(src).not.toMatch(
      /operationalIncident\.count\(\{\s*where:\s*\{\s*status:\s*"OPEN"\s*\}\s*\}\)/,
    );
    expect(src).toMatch(/untriagedIncidentWhere\(\)/);
  });
});

describe("the deliberate exceptions stay deliberate", () => {
  it("the snapshot still reports BOTH populations", () => {
    // platform-health-snapshot computes `openBySeverity` over OPEN only (a
    // severity breakdown of the untriaged queue) AND `unresolved` over both.
    // That is two questions answered separately, not a contradiction, and it
    // must not be "simplified" into one.
    const src = code("services/operations/platform-health-snapshot.service.ts");
    expect(src).toMatch(/openBySeverity/);
    expect(src).toMatch(/unresolved/);
  });

  it("the workspace detail still separates open from acknowledged", () => {
    // `/admin/workspaces/:id` shows both figures side by side, which is a
    // presentation choice and the reason it counts them separately.
    const src = code("services/admin/workspaces.service.ts");
    expect(src).toMatch(/status:\s*"ACKNOWLEDGED"/);
  });
});
