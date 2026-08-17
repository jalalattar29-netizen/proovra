/**
 * PHASE 13 — the continuation checkpoint may not contradict the measurement.
 *
 * The POSITIVE half evaluates the REAL `CONTINUATION-CHECKPOINT.md` against the
 * REAL `architecture-facts.json` and requires:
 *
 *     CheckpointContradictions      = 0
 *     StaleNextCommands             = 0
 *     DuplicateActiveStateSections  = 0
 *
 * The NEGATIVE half proves the evaluator is CAPABLE of refusing. A gate that
 * has only ever been observed passing is indistinguishable from `expect(true)`,
 * so each failure mode the mandate names is executed here by perturbing a COPY
 * of the real inputs: a second active-state section, a scalar edited away from
 * the facts, a scalar printed with two different values in two sections, a
 * NEXT COMMANDS block naming a script that no longer exists, and a scalar with
 * no derivation at all.
 *
 * The last of those is the one that matters most. It is what stops the
 * checkpoint from growing a hand-maintained counter again: a name that
 * `derivedScalars()` cannot produce is REJECTED rather than ignored, so the
 * only way to add a number to the checkpoint is to add the derivation that
 * makes it re-derivable.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The evaluator is imported from the ENGINE, not reimplemented here.
 *
 * The canonical closure evaluator reads the same function, so the engine and
 * this gate cannot disagree about whether the checkpoint is honest. It is
 * untyped `.mjs` for the reason every engine module is — see the ambient
 * declarations in `capability-authority-modules.d.ts`.
 */
import {
  derivedScalars,
  evaluateCheckpoint,
} from "../scripts/audit/engine/checkpoint-truth.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../../..");

/** The generated facts document, read as-is. */
type ArchitectureFacts = Record<string, unknown>;

const CHECKPOINT = "audit-output/current/CONTINUATION-CHECKPOINT.md";
const FACTS = "audit-output/current/architecture-facts.json";

function readCheckpoint(): string {
  return readFileSync(resolve(ROOT, CHECKPOINT), "utf8");
}

function readFacts(): ArchitectureFacts {
  return JSON.parse(readFileSync(resolve(ROOT, FACTS), "utf8")) as ArchitectureFacts;
}

/** Resolve a NEXT COMMANDS path token against the repository root. */
function targetExists(relPath: string): boolean {
  return existsSync(resolve(ROOT, relPath));
}

describe("PHASE 13 — checkpoint truth gate (positive)", () => {
  it("both canonical inputs exist", () => {
    expect(existsSync(resolve(ROOT, CHECKPOINT)), CHECKPOINT).toBe(true);
    expect(existsSync(resolve(ROOT, FACTS)), FACTS).toBe(true);
  });

  it("the checkpoint agrees with the generated facts in every printed scalar", () => {
    const evaluation = evaluateCheckpoint({
      markdown: readCheckpoint(),
      facts: readFacts(),
      commandTargetExists: targetExists,
    });
    expect(
      evaluation.violations.map((v) => `${v.kind}: ${v.detail}`),
      "the continuation checkpoint must derive or cite canonical facts",
    ).toEqual([]);
    expect(evaluation.pass).toBe(true);
  });

  it("reports the three mandated closure counters at zero", () => {
    const evaluation = evaluateCheckpoint({
      markdown: readCheckpoint(),
      facts: readFacts(),
      commandTargetExists: targetExists,
    });
    expect(evaluation.checkpointContradictions, "CheckpointContradictions").toBe(0);
    expect(evaluation.staleNextCommands, "StaleNextCommands").toBe(0);
    expect(
      evaluation.duplicateActiveStateSections,
      "DuplicateActiveStateSections",
    ).toBe(0);
  });

  it("actually compared scalars — an empty comparison is not a pass", () => {
    const evaluation = evaluateCheckpoint({
      markdown: readCheckpoint(),
      facts: readFacts(),
      commandTargetExists: targetExists,
    });
    // A checkpoint that printed no scalars at all would satisfy every counter
    // above while telling a reader nothing. The active-state section must carry
    // real measured values.
    expect(evaluation.scalarsChecked).toBeGreaterThanOrEqual(20);
  });

  it("every derivation resolves — no scalar derives to undefined", () => {
    const derived = derivedScalars(readFacts());
    const undefinedNames = Object.entries(derived)
      .filter(([, v]) => v === undefined || (typeof v === "number" && Number.isNaN(v)))
      .map(([k]) => k);
    expect(undefinedNames).toEqual([]);
  });
});

describe("PHASE 13 — checkpoint truth gate (negative: it can refuse)", () => {
  const facts = readFacts();
  const good = readCheckpoint();

  it("refuses a second active-state section", () => {
    const perturbed = `${good}\n\n## CURRENT STATE — stale copy\n\n\`\`\`\nUndisposedRoutes  0\n\`\`\`\n`;
    const evaluation = evaluateCheckpoint({
      markdown: perturbed,
      facts,
      commandTargetExists: targetExists,
    });
    expect(evaluation.pass).toBe(false);
    expect(evaluation.duplicateActiveStateSections).toBe(1);
    expect(
      evaluation.violations.some((v) => v.kind === "DUPLICATE_ACTIVE_STATE_SECTION"),
    ).toBe(true);
  });

  it("refuses a scalar that disagrees with the facts", () => {
    const perturbed = good.replace(
      /^(TerminalWriters\s{2,})(\d+)$/m,
      (_m, head: string, n: string) => `${head}${Number(n) + 1}`,
    );
    expect(perturbed, "the perturbation must actually change the file").not.toBe(good);
    const evaluation = evaluateCheckpoint({
      markdown: perturbed,
      facts,
      commandTargetExists: targetExists,
    });
    expect(evaluation.pass).toBe(false);
    expect(
      evaluation.violations.some((v) => v.kind === "SCALAR_DISAGREES_WITH_FACTS"),
    ).toBe(true);
  });

  it("refuses the same scalar printed with two different values", () => {
    const perturbed = `${good}\n\n## HISTORY\n\n\`\`\`\nUndisposedRoutes  7\n\`\`\`\n`;
    const evaluation = evaluateCheckpoint({
      markdown: perturbed,
      facts,
      commandTargetExists: targetExists,
    });
    expect(evaluation.pass).toBe(false);
    expect(evaluation.checkpointContradictions).toBeGreaterThan(0);
  });

  it("refuses a NEXT COMMANDS block naming a script that does not exist", () => {
    const perturbed = `${good}\n\n## NEXT COMMANDS\n\n\`\`\`\nnode services/api/scripts/audit/there-is-no-such-script.mjs\n\`\`\`\n`;
    const evaluation = evaluateCheckpoint({
      markdown: perturbed,
      facts,
      commandTargetExists: targetExists,
    });
    expect(evaluation.pass).toBe(false);
    expect(evaluation.staleNextCommands).toBeGreaterThan(0);
  });

  it("refuses a hand-maintained scalar that nothing derives", () => {
    const perturbed = good.replace(
      /^## CURRENT STATE([^\n]*)\n/m,
      (m) => `${m}\n\`\`\`\nHandMaintainedCounter  42\n\`\`\`\n`,
    );
    const evaluation = evaluateCheckpoint({
      markdown: perturbed,
      facts,
      commandTargetExists: targetExists,
    });
    expect(evaluation.pass).toBe(false);
    expect(evaluation.violations.some((v) => v.kind === "UNKNOWN_SCALAR")).toBe(true);
  });

  it("refuses a checkpoint with no active-state section at all", () => {
    const perturbed = good.replace(/^## CURRENT STATE.*$/m, "## SOMETHING ELSE");
    const evaluation = evaluateCheckpoint({
      markdown: perturbed,
      facts,
      commandTargetExists: targetExists,
    });
    expect(evaluation.pass).toBe(false);
    expect(
      evaluation.violations.some((v) => v.kind === "NO_ACTIVE_STATE_SECTION"),
    ).toBe(true);
  });

  it("restoring the real inputs restores the pass", () => {
    const evaluation = evaluateCheckpoint({
      markdown: good,
      facts,
      commandTargetExists: targetExists,
    });
    expect(evaluation.pass).toBe(true);
  });
});
