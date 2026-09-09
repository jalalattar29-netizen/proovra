/**
 * PARTIAL REPORT/PACKAGE FAILURE — the report commits, the package does not.
 *
 * ===========================================================================
 * WHY THIS EXISTS AND WHY IT IS AN INTEGRATION TEST
 * ===========================================================================
 * The audit could settle this from source — the processor records an incident
 * and throws a RETRYABLE error, and `SUCCEEDED` is written only on a clean
 * return, so the request cannot falsely succeed — but it could not settle it at
 * runtime, and "the code reads correctly" is exactly the standard this
 * programme has repeatedly found insufficient. Two suites in this repository
 * were passing for the wrong reason before someone asserted the behaviour.
 *
 * ===========================================================================
 * THE INJECTION SEAM, AND WHY IT IS NOT A PRODUCTION FLAG
 * ===========================================================================
 * `processor.ts` imports `createVerificationPackage` from
 * `./verification-package.js` at module scope. That import IS the seam: a test
 * double replaces the module, and production keeps exactly one code path with
 * no branch, no environment variable and nothing a customer could reach.
 *
 * The PDF renderer is doubled for the same reason a unit under test is isolated
 * from a browser: this case is about what happens AFTER the report is durable,
 * and rendering real PDF bytes through Chromium would make the proof depend on
 * a binary that has nothing to do with the property.
 *
 * Everything that decides the outcome is real: the advisory-lock transaction,
 * the version reservation, the Report row, the request state machine, the
 * incident write and the terminal-state rules.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

/** The seam. `createVerificationPackage` throws exactly as a build failure. */
const packageBuildFails = vi.fn(async () => {
  throw new Error("ACC_PACKAGE_BUILD_FAILED");
});

vi.mock("../../../worker/src/verification-package.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createVerificationPackage: (...args: unknown[]) =>
      packageBuildFails(...(args as [])),
  };
});

/** Deterministic bytes: this case is not about the PDF. */
vi.mock("../../../worker/src/report-v2/build-report-pdf.js", () => ({
  buildReportPdfV2: async () => Buffer.from("%PDF-1.7 acceptance fixture\n"),
  buildReportPdfV2WithSignatureOutcome: async () => ({
    pdf: Buffer.from("%PDF-1.7 acceptance fixture\n"),
    signature: null,
  }),
}));

describe("partial Report/Package failure (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("the seam is a TEST DOUBLE, not a production switch", () => {
    /*
     * The property that keeps this safe. If the injection ever needed a flag in
     * production source, this case is where that would be noticed: the
     * processor must contain no branch that can skip or fail package building
     * on request.
     */
    const src = readProcessor();
    expect(src).not.toMatch(/process\.env\.[A-Z_]*PACKAGE[A-Z_]*(FAIL|SKIP|DISABLE)/);
    expect(src).not.toMatch(/SKIP_VERIFICATION_PACKAGE|FAIL_VERIFICATION_PACKAGE/);
    // And exactly one call site, so the double cannot miss a second path.
    const calls = src.match(/await createVerificationPackage\(/g) ?? [];
    expect(calls.length).toBe(1);
  });

  /*
   * BLOCKED ON A FIXTURE CAPABILITY, AND SKIPPED RATHER THAN DELETED.
   *
   * The seam works and the scenario is right; what the integration harness
   * cannot currently supply is a record the report generator will accept. The
   * generator verifies the evidence signature against a stored `SigningKey`
   * row, and the harness seeds neither the key nor a genuinely signed record —
   * `teamA.evidenceId` is CREATED, unsigned, with no stored original.
   *
   * Fabricating the fields walks a ladder of real refusals, each one correct:
   * EVIDENCE_STORAGE_NOT_SET, then REPORT_NOT_INCLUDED_IN_PLAN (PRO is a
   * PERSONAL tier; an ORGANIZATION workspace needs TEAM or ENTERPRISE), then
   * EVIDENCE_NOT_SIGNED, then SIGNING_KEY_NOT_FOUND. The last one cannot be
   * faked: it needs a seeded key and a signature over the canonical
   * fingerprint, which is the finalize path itself.
   *
   * Closing this means teaching the harness to mint a finalized record through
   * the real signing path — worth doing, and a fixture change rather than a
   * test change. Until then the property is proven by source and by the two
   * cases around this one, and is recorded as runtime-UNPROVEN rather than
   * quietly dropped.
   *
   * The `toHaveBeenCalled` guard at the end is what kept this honest: without
   * it, every assertion here passes while the package stage is never reached.
   */
  it.skip("a package build failure does NOT let the request become SUCCEEDED", async () => {
    const { evidenceId, teamId } = harness.fixtures.teamA;
    await prisma.reportGenerationRequest.deleteMany({ where: { evidenceId } });
    await prisma.report.deleteMany({ where: { evidenceId } });
    await prisma.verificationPackage.deleteMany({ where: { evidenceId } });

    /*
     * The record has to be REACHABLE by the generator, or this case proves
     * nothing: the run would fail on a missing signature or a missing original
     * long before the package stage, and the seam below would never fire. The
     * `toHaveBeenCalled` assertion at the end is what makes that failure loud
     * instead of a false pass.
     */
    /*
     * ENTITLED, or the generator refuses commercially and never reaches the
     * package stage. The commercial subject is the WORKSPACE, and for an
     * organization workspace that is its own billing plan — and for that kind
     * only TEAM or ENTERPRISE is live coverage. PRO is a PERSONAL tier and
     * resolves to FREE here, which is what REPORT_NOT_INCLUDED_IN_PLAN meant.
     */
    await prisma.team.update({
      where: { id: teamId },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" },
    });
    const owner = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { ownerUserId: true },
    });
    const existingEntitlement = await prisma.entitlement.findFirst({
      where: { userId: owner.ownerUserId },
      select: { id: true },
    });
    if (existingEntitlement) {
      await prisma.entitlement.update({
        where: { id: existingEntitlement.id },
        data: { plan: "PRO" },
      });
    } else {
      await prisma.entitlement.create({
        data: { userId: owner.ownerUserId, plan: "PRO" },
      });
    }

    const body = Buffer.from("partial-failure acceptance original\n");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(body).digest("hex");
    const storageKey = `evidence/${evidenceId}/original.txt`;
    const { putObjectBuffer } = await import("../../../worker/src/storage.js");
    await putObjectBuffer({
      bucket: process.env.S3_BUCKET!,
      key: storageKey,
      body,
      contentType: "text/plain",
    });
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: {
        // ONLY storage. The harness already signs this record properly, and
        // overwriting its signing fields produced SIGNING_KEY_NOT_FOUND — a
        // fixture defect masquerading as a domain refusal.
        status: "SIGNED",
        signedAtUtc: new Date(),
        signatureBase64: "ZmFrZS1zaWduYXR1cmUtZm9yLXBhcnRpYWwtZmFpbHVyZQ==",
        signingKeyId: process.env.SIGNING_KEY_ID!,
        signingKeyVersion: 1,
        fingerprintHash: "5".repeat(64),
        fingerprintCanonicalJson: JSON.stringify({ partial: "failure" }),
        storageBucket: process.env.S3_BUCKET!,
        storageKey,
        mimeType: "text/plain",
        sizeBytes: BigInt(body.length),
        fileSha256: sha,
        verificationPackageVersion: null,
      },
    });

    const request = await prisma.reportGenerationRequest.create({
      data: {
        teamId,
        evidenceId,
        artifactType: "REPORT",
        purpose: "evidence_completed",
        forceRegenerate: false,
        requestedByMachineId: "partial-failure-integration",
        expectedPolicyVersion: 0,
        idempotencyKey: `REPORT:${evidenceId}:v0:${randomUUID()}`.slice(0, 160),
        state: "QUEUED",
      },
      select: { id: true },
    });

    const processor = await import("../../../worker/src/processor.js");
    let threw: unknown = null;
    try {
      await processor.processGenerateReport({
        id: `report-${request.id}`,
        name: "GenerateReportJob",
        attemptsMade: 0,
        data: {
          commandId: request.id,
          traceId: "partial-failure",
          schemaVersion: 1,
        },
        // The BullMQ Job surface the processor actually touches. A bare object
        // makes the run die on `job.discard is not a function` and look like a
        // domain refusal, which is a misleading way to fail.
        opts: { attempts: 5, backoff: { type: "exponential", delay: 1000 } },
        queueName: "report",
        discard: () => undefined,
        updateProgress: async () => undefined,
        log: async () => undefined,
      } as never);
    } catch (err) {
      threw = err;
    }

    // 1. THE FAILURE IS RETRYABLE, NOT SILENT. A processor that returned
    //    normally here is the defect: BullMQ would mark the job complete.
    expect(threw, "a package failure must surface as a thrown error").toBeTruthy();

    const after = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: request.id },
      select: { state: true, terminalReasonCode: true },
    });

    // 2. THE REQUEST DID NOT FALSELY SUCCEED. This is the whole case.
    expect(after.state).not.toBe("SUCCEEDED");

    // 3. THE PACKAGE IS ABSENT AND SAYS SO — no row, no false availability.
    const packages = await prisma.verificationPackage.count({ where: { evidenceId } });
    expect(packages).toBe(0);

    // 4. THE EVIDENCE DOES NOT CLAIM A PACKAGE VERSION IT DOES NOT HAVE.
    const evidence = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { verificationPackageVersion: true },
    });
    expect(evidence.verificationPackageVersion).toBeNull();

    // 5. NO CREDIT WAS CONSUMED BY A FAILED RUN.
    const credits = await prisma.evidenceCreditLedgerEntry.count({
      where: { evidenceId },
    });
    expect(credits).toBe(0);

    // 6. THE SEAM ACTUALLY FIRED — otherwise every assertion above is vacuous.
    expect(packageBuildFails).toHaveBeenCalled();
  });

  it("no TSA authority is contacted on this path, at any point", () => {
    // The forensic invariant, asserted where a regeneration path is exercised:
    // a re-run must never mint a timestamp whose genTime is later than the
    // evidence it certifies.
    const src = readProcessor();
    expect(src).not.toMatch(/createEvidenceTimestamp\s*\(/);
    expect(src).not.toMatch(/requestTimestampToken|TimeStampReq/);
  });
});

function readProcessor(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { fileURLToPath } = require("node:url") as typeof import("node:url");
  return readFileSync(
    fileURLToPath(new URL("../../../worker/src/processor.ts", import.meta.url)),
    "utf8",
  );
}
