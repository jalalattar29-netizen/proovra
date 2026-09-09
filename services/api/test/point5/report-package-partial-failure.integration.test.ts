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

/**
 * Deterministic bytes: this case is not about the PDF, and rendering one would
 * make the proof depend on a Chromium binary that has nothing to do with the
 * property under test.
 *
 * The signature outcome returns the REAL `PdfSigningOutcome` shape. An earlier
 * draft returned `{ pdf, signature: null }` and the run died much later, in
 * `canonicalJsonValue: unsupported value type "undefined"` — a mock with the
 * wrong shape does not fail where it is wrong, it fails somewhere that reads
 * like a product defect.
 */
vi.mock("../../../worker/src/report-v2/build-report-pdf.js", () => ({
  buildReportPdfV2: async () => Buffer.from("%PDF-1.7 partial-failure fixture\n"),
  buildReportPdfV2WithSignatureOutcome: async () => ({
    status: "UNSIGNED_OPT_OUT" as const,
    pdf: Buffer.from("%PDF-1.7 partial-failure fixture\n"),
    warning: "PDF signing is not exercised by this case.",
  }),
}));

/** The key the fixture evidence is signed with, and the row seeded for it. */
const FIXTURE_SIGNING_KEY_ID = "partial-failure-fixture-key";

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
   * THE FIXTURE PREREQUISITE IS PROVIDED HERE, SO THIS ALWAYS RUNS.
   *
   * This was `it.skip` for one reason: the generator refuses a record whose
   * signing key it cannot find, and the harness seeds no `SigningKey` row. That
   * read as "the harness cannot mint a finalized record", which was wrong — the
   * check at processor.ts is a ROW LOOKUP, not a signature verification:
   *
   *     prisma.signingKey.findUnique({ where: { keyId_version: {...} } })
   *
   * So the prerequisite is a row, and a test may create its own. The earlier
   * ladder of refusals — EVIDENCE_STORAGE_NOT_SET, REPORT_NOT_INCLUDED_IN_PLAN,
   * EVIDENCE_NOT_SIGNED — are satisfied the same way: with real rows, not with
   * a conditional gate around the assertion.
   *
   * A runtime skip is not a smaller test, it is an absent one, and the suite
   * forbids them precisely so a gap cannot hide behind a green run.
   */
  it("a package build failure does NOT let the request become SUCCEEDED", async () => {
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

    /*
     * THE SIGNING KEY ROW. The generator looks the evidence key up by
     * (keyId, version) and refuses SIGNING_KEY_NOT_FOUND when it is absent. It
     * does not verify a signature at that point, so the prerequisite this test
     * was skipped for is a ROW — and a test may create its own. The PEM below
     * is inert fixture text; it signs nothing and verifies nothing.
     */
    await prisma.signingKey.upsert({
      where: { keyId_version: { keyId: FIXTURE_SIGNING_KEY_ID, version: 1 } },
      create: {
        keyId: FIXTURE_SIGNING_KEY_ID,
        version: 1,
        publicKeyPem:
          "-----BEGIN PUBLIC KEY-----\nfixture-local-only-not-a-real-key\n-----END PUBLIC KEY-----\n",
      },
      update: {},
    });

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
        signingKeyId: FIXTURE_SIGNING_KEY_ID,
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

    // Captured BEFORE the run so "TSA was not touched" is a comparison
    // rather than an assumption about what the fixture happened to hold.
    const tsaBefore = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { tsaStatus: true, tsaGenTimeUtc: true, tsaMessageImprint: true },
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

    // 6. THE FAILURE IS RECOVERABLE, and the reason names the phase it failed
    //    in. FAILED_RETRYABLE is what keeps the pair convergent: the record is
    //    still owed a package and the reconciler will drive it again.
    expect(after.state).toBe("FAILED_RETRYABLE");
    expect(after.terminalReasonCode).toMatch(/^VERIFICATION_PACKAGE_INCOMPLETE_/);

    // 7. THE REPORT IS DURABLE AND UNTOUCHED. A package failure is a statement
    //    about the PACKAGE; the artifact that did commit stays committed, at
    //    exactly one version, with no second row racing it.
    const reports = await prisma.report.findMany({
      where: { evidenceId },
      select: { version: true, storageKey: true },
      orderBy: { version: "asc" },
    });
    expect(reports.length).toBe(1);
    expect(reports[0]!.version).toBe(1);
    expect(reports[0]!.storageKey).toContain("/v1.");

    // 8. OPERATIONS CAN SEE IT. A partial failure the operator cannot find is
    //    a silent one, which is the state this whole guard exists to prevent.
    const incidents = await prisma.operationalIncident.count({
      where: { teamId, category: "PACKAGE" },
    });
    expect(incidents).toBeGreaterThan(0);

    // 9. NO TSA AUTHORITY WAS CONTACTED. A retry must never mint a timestamp
    //    whose genTime is later than the evidence it certifies, and a package
    //    failure is a retry path.
    const evidenceAfter = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { tsaStatus: true, tsaGenTimeUtc: true, tsaMessageImprint: true },
    });
    expect(evidenceAfter.tsaStatus).toBe(tsaBefore.tsaStatus);
    expect(evidenceAfter.tsaGenTimeUtc).toEqual(tsaBefore.tsaGenTimeUtc);
    expect(evidenceAfter.tsaMessageImprint).toBe(tsaBefore.tsaMessageImprint);

    // 10. THE SEAM ACTUALLY FIRED — otherwise every assertion above is vacuous.
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
