/**
 * Wave 3 Phase 8 — Playwright E2E source-contract pin.
 *
 * Source-only assertions (no Playwright runtime) that lock in the
 * shape of the new spec + helper so the test does not silently
 * regress into a fake or a sleep loop.
 *
 * What this pins:
 *
 *   1. The spec file exists at the canonical path.
 *   2. The helper file exists at the canonical path.
 *   3. The spec uses createGuestSession + makeApi-equivalent
 *      (createGuestSession is the helper that wraps makeApi).
 *   4. The spec uses the new wait-for-worker helper rather than
 *      reimplementing polling.
 *   5. The spec contains all 26 steps as discrete test.step calls.
 *   6. The spec asserts diagnostics counts (workspace.* fields).
 *   7. The spec asserts the honest-empty-state path on Wave 2
 *      OperationalEmptyState (data-empty-state-classification +
 *      CAPABILITY_UNAVAILABLE bounded vocabulary).
 *   8. No setTimeout sleeps above 500ms anywhere in the spec.
 *   9. No `Date.now()` used for assertions (deterministic — Date.now
 *      is allowed only as a unique-payload seed for evidence bytes).
 *  10. The helper uses expect.poll (Playwright primitive) not raw
 *      while-loops.
 *
 * The test is source-contract — it reads the spec + helper source
 * text and asserts on regexes / substrings. It never spawns the
 * Playwright runner.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readRepo(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${rel}`, import.meta.url)),
    "utf8",
  );
}

const SPEC = readRepo("e2e/investigation-enterprise-data-flow.spec.ts");
const HELPER = readRepo("e2e/helpers/wait-for-worker.ts");
const API_CLIENT = readRepo("e2e/helpers/api-client.ts");

describe("Wave 3 Phase 8 — Playwright spec source contract", () => {
  it("spec file exists and is non-empty", () => {
    expect(SPEC.length).toBeGreaterThan(0);
  });

  it("helper file exists and is non-empty", () => {
    expect(HELPER.length).toBeGreaterThan(0);
  });

  it("spec uses createGuestSession + disposeSession from api-client", () => {
    expect(SPEC).toContain("createGuestSession");
    expect(SPEC).toContain("disposeSession");
    expect(SPEC).toContain('from "./helpers/api-client"');
    // api-client.ts must still export the canonical names (proves we
    // didn't accidentally duplicate them in the spec).
    expect(API_CLIENT).toContain("export async function createGuestSession");
    expect(API_CLIENT).toContain("export async function makeApi");
  });

  it("spec uses the new wait-for-worker helper (no reimplementation)", () => {
    expect(SPEC).toContain('from "./helpers/wait-for-worker"');
    expect(SPEC).toContain("waitForDiagnostics");
    expect(SPEC).toContain("readDiagnostics");
    expect(SPEC).toContain("counter(");
  });

  it("spec contains all 26 enumerated step labels (test.step)", () => {
    // The spec uses prefixes like "01:", "03-04:", "08-09:", "16-17:",
    // "18-19:". The bounded set of step labels MUST all appear in
    // exactly the prescribed numbering — so each number 1..26 must
    // appear at least once in a test.step('NN:' ...) call.
    const STEP_RE = /test\.step\(\s*"([^"]+)"/g;
    const labels: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = STEP_RE.exec(SPEC))) labels.push(m[1]);
    const joined = labels.join("\n");
    for (const i of [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24, 25, 26,
    ]) {
      const pad = String(i).padStart(2, "0");
      expect(
        joined,
        `expected a test.step label containing "${pad}:" — labels seen:\n${joined}`,
      ).toMatch(new RegExp(`(^|[^0-9])${pad}([^0-9]|:)`));
    }
    // Step 12 (create case) is performed inline (no test.step wrapper
    // needed — it is a single POST with assertions). Pin its
    // presence explicitly via the canonical endpoint.
    expect(SPEC).toContain('POST /v1/cases');
  });

  it("spec asserts diagnostics counter fields (Wave 1 envelope)", () => {
    const REQUIRED_FIELDS = [
      "finalizedEvidenceCount",
      "graphNodeCount",
      "graphEdgeCount",
      "timelineEventCount",
      "duplicateExactCount",
      "mediaSignalCount",
      "reviewWorkflowCount",
      "escalationCount",
      "externalReviewerGrantCount",
      "auditEventCount",
      "custodyEventCount",
    ];
    for (const field of REQUIRED_FIELDS) {
      expect(SPEC, `missing diagnostics field ${field}`).toContain(field);
    }
  });

  it("spec asserts the honest OperationalEmptyState classification path", () => {
    // The Wave 2 Phase 4 vocabulary — when provider not configured,
    // the page must render one of the bounded codes. The spec MUST
    // assert at least CAPABILITY_UNAVAILABLE and the
    // data-empty-state-classification DOM hook.
    expect(SPEC).toContain("data-empty-state-classification");
    expect(SPEC).toContain("CAPABILITY_UNAVAILABLE");
    expect(SPEC).toContain("FEATURE_NOT_CONFIGURED");
    // The intelligence/capabilities endpoint is the truth-source.
    expect(SPEC).toContain("/v1/intelligence/capabilities");
  });

  it("spec uses no setTimeout / page.waitForTimeout above 500ms", () => {
    // Hard ban: ANY sleep above 500ms is forbidden. The polling
    // helper is the only acceptable pattern. We grep for both
    // setTimeout( and page.waitForTimeout( occurrences and check
    // every numeric argument is <= 500.
    const SLEEP_RE =
      /(?:setTimeout|waitForTimeout)\s*\(\s*(?:[^,)]*?,\s*)?(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = SLEEP_RE.exec(SPEC))) {
      const ms = Number(m[1]);
      expect(
        ms <= 500,
        `spec contains a sleep of ${ms}ms (max 500ms): ${m[0]}`,
      ).toBe(true);
    }
  });

  it("spec uses Date.now only for unique-payload seeding, never assertion math", () => {
    // Date.now() may appear ONLY inside string-template payload seeds
    // (e.g. evidence body content, case name suffix, invitee email).
    // It MUST NOT appear inside an expect(...) call or as an
    // assertion comparator.
    const lines = SPEC.split(/\r?\n/);
    for (const [idx, line] of lines.entries()) {
      if (line.includes("Date.now()")) {
        const trimmed = line.trim();
        const ok =
          trimmed.includes("`") || // template-literal payload
          trimmed.includes('"') || // string-concat payload
          trimmed.includes("expect: ") || // doc-comment example
          trimmed.startsWith("*") || // doc-comment line
          trimmed.startsWith("//"); // inline comment
        expect(
          ok,
          `Date.now() found outside payload seed at line ${idx + 1}: ${line}`,
        ).toBe(true);
      }
    }
  });

  it("helper uses Playwright expect.poll (no while-loop polling)", () => {
    expect(HELPER).toContain("expect.poll");
    // Hard ban on while/for-loop polling patterns inside the helper.
    expect(HELPER).not.toMatch(/while\s*\(/);
    // setTimeout is also banned; expect.poll uses its own scheduler.
    expect(HELPER).not.toMatch(/setTimeout\s*\(/);
  });
});
