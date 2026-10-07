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
    ).slice(0, 1400);
    expect(guard).toContain("recordPackageGenerationIncident");
    expect(guard).toMatch(
      /throw createWorkerError\(\s*"VERIFICATION_PACKAGE_INCOMPLETE_"[\s\S]{0,120}true,?\s*\)/,
    );
    // 2026-09-29: a DETERMINISTIC storage refusal (e.g. S3 InvalidRequest) is
    // the one exception — retrying the same bytes the same way cannot succeed,
    // so it is terminal, after the CRITICAL incident naming the storage code.
    // 2026-10-07: the terminal throw keeps the failure's own cause — a storage
    // refusal names VERIFICATION_PACKAGE_STORAGE_REJECTED, an output that
    // contradicts the record names its own code — and both follow the incident.
    const terminal = guard.indexOf("if (packageTechnicalFailure.retriable === false)");
    expect(terminal).toBeGreaterThan(-1);
    expect(guard.indexOf("recordPackageGenerationIncident")).toBeLessThan(terminal);
    expect(guard.slice(terminal, terminal + 700)).toMatch(
      /throw createWorkerError\(\s*packageTechnicalFailure\.phase === "store"\s*\?\s*"VERIFICATION_PACKAGE_STORAGE_REJECTED"\s*:\s*packageTechnicalFailure\.message,\s*false,?\s*\)/,
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
    const guard = PROCESSOR.slice(PROCESSOR.indexOf("const pairComplete ="))
      .slice(0, 600);
    expect(guard).toContain("!verificationPackageEntitled");
    // Complete means EVERY package profile the version owes is PUBLISHED, AT
    // THE REPORT'S VERSION — not "some row exists" (a RESERVED or FAILED row is
    // not a package), and not any version: report v2 beside package v1 is not
    // a pair. versionPackagesComplete is the one definition (shared-runtime).
    expect(guard).toContain("versionPackagesComplete(prisma");
    expect(guard).toContain("version: packageTargetVersion");
    // The return is conditional on completeness, never on the report alone.
    // (ET-RPT-07: the no-op returns what it found — pair_complete at that
    // version — so the request records it rather than "the newest report".)
    expect(guard).toMatch(/if \(pairComplete\) \{[\s\S]{0,300}return \{ outcome: "pair_complete", reportVersion: packageTargetVersion \};/);
  });

  it("the package row and its version pointer commit together", () => {
    /*
     * Invariant B: `verificationPackageVersion` must never be readable as proof
     * that a package exists. Both writes are inside ONE transaction, so the
     * pointer cannot outlive a rolled-back row.
     */
    // 2026-10-07: the commit moved to package-issuance.ts (commitIssuance). In
    // ONE transaction: every reserved row is published, the pointer advances,
    // and the request records PACKAGE_PUBLISHED.
    const ISSUANCE = readFileSync(
      fileURLToPath(new URL("../../worker/src/package-issuance.ts", import.meta.url)),
      "utf8",
    );
    const start = ISSUANCE.indexOf("export async function commitIssuance(");
    expect(start).toBeGreaterThan(-1);
    const fn = ISSUANCE.slice(start, ISSUANCE.indexOf("\nexport ", start + 10));
    const tx = fn.slice(fn.indexOf("await prisma.$transaction(async (tx) => {"));
    expect(tx).toContain("await commitPublishedPackage(tx,");
    expect(tx).toContain("verificationPackageVersion: input.version");
    expect(tx).toContain('stage: "PACKAGE_PUBLISHED"');
    // The processor commits through it — no second package-row writer.
    expect(PROCESSOR).toContain("await commitIssuance({");
    expect(PROCESSOR).not.toMatch(/verificationPackage\.(create|update|upsert)\(/);
  });
});
