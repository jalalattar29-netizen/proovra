/**
 * PARTIAL REPORT/PACKAGE FAILURE — the boundary, proven where it is decided.
 *
 * ===========================================================================
 * WHY THIS IS THE RIGHT SIZE FOR THIS PROOF
 * ===========================================================================
 * The full-stack version of this test was attempted and is skipped in
 * `test/point5/report-package-partial-failure.integration.test.ts` with its
 * blocker written down: driving the real generator needs a record the harness
 * cannot mint, because the last refusal on the ladder — SIGNING_KEY_NOT_FOUND —
 * requires a seeded key and a signature over the canonical fingerprint, which
 * is the finalize path itself.
 *
 * But the property does not live in the generator. It lives in three places
 * that are small, pure and reachable:
 *
 *   1. the package-failure guard throws a RETRYABLE worker error;
 *   2. `isRetriableError` is the predicate the catch uses to choose between
 *      FAILED_RETRYABLE and FAILED_TERMINAL;
 *   3. `SUCCEEDED` is written only AFTER the guarded body returns.
 *
 * (1) and (2) are asserted behaviourally below by constructing the exact error
 * the guard throws and running the exact predicate the catch runs. (3) is a
 * structural fact about one function and is asserted as one.
 *
 * That is the whole decision. A signed fixture would exercise more code without
 * testing more of this property.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createWorkerError,
  isRetriableError,
} from "../../worker/src/processor.js";

const PROCESSOR = readFileSync(
  fileURLToPath(new URL("../../worker/src/processor.ts", import.meta.url)),
  "utf8",
);

describe("partial Report/Package failure — the state transition", () => {
  it("the error the package guard throws is classified RETRYABLE", () => {
    // The literal shape the guard constructs:
    //   throw createWorkerError("VERIFICATION_PACKAGE_INCOMPLETE_" + PHASE, true)
    for (const phase of ["PREPARE", "STORE"]) {
      const err = createWorkerError(
        `VERIFICATION_PACKAGE_INCOMPLETE_${phase}`,
        true,
      );
      expect(
        isRetriableError(err),
        `a ${phase}-phase package failure must be retryable, or the catch retires the request to FAILED_TERMINAL and the pair can never converge`,
      ).toBe(true);
    }
  });

  it("an EXPLICITLY non-retryable worker error is classified terminal", () => {
    // The negative control. If everything read as retryable, the assertion
    // above would prove nothing about the classifier.
    expect(isRetriableError(createWorkerError("EVIDENCE_NOT_FOUND", false))).toBe(
      false,
    );
  });

  it("an UNCLASSIFIED error defaults to retryable, and that is the safe direction", () => {
    /*
     * A plain Error carries no `retriable` flag and the predicate answers TRUE.
     *
     * Worth stating rather than leaving to be rediscovered: the default decides
     * what happens to an error nobody anticipated, and the two ways to be wrong
     * are not symmetric. Retrying something permanently broken costs attempts
     * and ends at the ceiling, where the reconciler retires the request to a
     * truthful terminal state. Retiring something transient strands a request
     * that would have succeeded on the next attempt, with no path back.
     *
     * So the bias is deliberate. It is also bounded — this is not "retry
     * forever", it is "retry until the attempt ceiling decides".
     */
    expect(isRetriableError(new Error("something nobody classified"))).toBe(true);
    expect(isRetriableError(undefined)).toBe(true);
  });

  it("the guard really does throw retryable, with an incident first", () => {
    // The call site, so the two halves cannot drift: the classifier proved
    // above is only meaningful if this is the error actually thrown.
    const guard = PROCESSOR.slice(
      PROCESSOR.indexOf("if (packageTechnicalFailure && verificationPackageEntitled)"),
    ).slice(0, 700);
    expect(guard).toContain("recordPackageGenerationIncident");
    expect(guard).toMatch(
      /throw createWorkerError\(\s*"VERIFICATION_PACKAGE_INCOMPLETE_"[\s\S]{0,120}true,?\s*\)/,
    );
  });

  it("SUCCEEDED is written only after the generation body returns", () => {
    /*
     * The structural half. `processGenerateReport` is:
     *
     *   try { await runReportGeneration(...) }
     *   catch { markRequestRetryable | markRequestTerminal; throw }
     *   ...
     *   markRequestTerminal({ state: "SUCCEEDED" })
     *
     * so a throw anywhere inside the body — including the package guard —
     * cannot reach the success write. Asserted by ORDER rather than by prose:
     * the only SUCCEEDED write in this function must come after the catch.
     */
    const fn = PROCESSOR.slice(
      PROCESSOR.indexOf("export async function processGenerateReport("),
    );
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);

    const catchAt = body.indexOf("} catch (error) {");
    const succeededAt = body.indexOf('state: "SUCCEEDED"');
    expect(catchAt, "the guarded body must exist").toBeGreaterThan(-1);
    expect(succeededAt, "the success write must exist").toBeGreaterThan(-1);
    expect(
      succeededAt,
      "SUCCEEDED must be written AFTER the catch — a success write reachable from inside the try could fire on a partial failure",
    ).toBeGreaterThan(catchAt);

    // And exactly one of them, so a second success path cannot bypass the order.
    expect((body.match(/state: "SUCCEEDED"/g) ?? []).length).toBe(1);
  });

  it("the early return only fires when the output pair is COMPLETE", () => {
    /*
     * The convergence half. A run that finds a report already present must not
     * return early while the package is missing — that is exactly the
     * "report exists, package absent" state, and returning would let the caller
     * write SUCCEEDED for an incomplete pair.
     */
    const guard = PROCESSOR.slice(PROCESSOR.indexOf("const outputPairComplete ="))
      .slice(0, 600);
    expect(guard).toContain("existingReport !== null");
    expect(guard).toContain("!verificationPackageEntitled");
    expect(guard).toContain("prisma.verificationPackage.findFirst");
    // The return is conditional on completeness, never on the report alone.
    expect(guard).toMatch(/if \(outputPairComplete\) \{[\s\S]{0,200}return;/);
  });

  it("the package row and its version pointer commit together", () => {
    /*
     * Invariant B: `verificationPackageVersion` must never be readable as proof
     * that a package exists. Both writes are inside ONE transaction, so the
     * pointer cannot outlive a rolled-back row.
     */
    const tx = PROCESSOR.slice(
      PROCESSOR.indexOf("await prisma.$transaction(async (tx) => {", PROCESSOR.indexOf("finalizedVerificationZip")),
    ).slice(0, 3000);
    expect(tx).toContain("tx.verificationPackage.create");
    expect(tx).toContain("verificationPackageVersion: prepared.version");
  });
});
