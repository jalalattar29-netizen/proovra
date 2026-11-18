/**
 * F-02 (2026-11-13) — THE FIRST ISSUANCE A RECORD EARNED IS NOT REFUSED FOR
 * STORAGE, AND THE WORKER MEASURES THE SAME POPULATION AS THE API.
 *
 * Defect: a FREE record admitted inside the 250 MiB allowance earned report v1
 * and its verification package (FREE THREE-RECORD CONTRACT), but the worker
 * gated both on storage after the fact — the FULL_FORENSIC package embeds the
 * originals, so any record over ~half the remaining allowance was settled
 * NOT_APPLICABLE_STORAGE_LIMIT and left without its package. Separately, the
 * worker's usage counted only `team_id = <personal team>` while the API's
 * counted the owner's legacy NULL-team rows too.
 *
 * Executed through the real gates over a mocked database: the allowance is
 * full; only the earned first issuance passes, and its bytes are still counted.
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { evidenceScopeFor } from "@proovra/shared-runtime";

const MIB = 1024n * 1024n;
const issuance = vi.fn();
const reportCount = vi.fn();
const evidenceAggregate = vi.fn();
// AUDIT D-01 — the published package of the previous version, and the original bytes.
const packageAggregate = vi.fn();
const previousPackage = vi.fn();
const originalEvidence = vi.fn();
// AUDIT D-03 — the shared first-issuance exclusion measure's reads.
const freeAllowanceRecords = vi.fn();
const firstReports = vi.fn();
const packageRows = vi.fn();
const recoveryRequests = vi.fn();

vi.mock("../src/db.js", () => ({
  prisma: {
    entitlement: { findFirst: vi.fn(async () => ({ plan: "FREE", credits: 0, teamSeats: 0 })) },
    planGrant: { findFirst: vi.fn(async () => null) },
    workspaceStorageAddon: { aggregate: vi.fn(async () => ({ _sum: { extraStorageBytes: null } })) },
    team: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => ({ id: "personal-team-1" })),
    },
    enterpriseContract: { findUnique: vi.fn(async () => null) },
    evidence: {
      aggregate: (...args: unknown[]) => evidenceAggregate(...args),
      count: vi.fn(async () => 2),
      findUnique: (...args: unknown[]) => originalEvidence(...args),
      findMany: (...args: unknown[]) => freeAllowanceRecords(...args),
    },
    report: {
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 2n * MIB } })),
      count: (...args: unknown[]) => reportCount(...args),
      findMany: (...args: unknown[]) => firstReports(...args),
    },
    verificationPackage: {
      aggregate: (...args: unknown[]) => packageAggregate(...args),
      findFirst: (...args: unknown[]) => previousPackage(...args),
      findMany: (...args: unknown[]) => packageRows(...args),
    },
    evidencePartDerivedAsset: { aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 0 } })) },
    reportGenerationRequest: { findMany: (...args: unknown[]) => recoveryRequests(...args) },
    // Free audit 0ea0 (B5B-F-403) — the measure and the gate also read the
    // credit ledger (a credit-funded record's first issuance is excluded too).
    evidenceCreditLedgerEntry: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
  },
}));
vi.mock("../src/output-issuance.js", () => ({
  resolveEvidenceOutputIssuance: (...args: unknown[]) => issuance(...args),
}));

const { assertWorkspaceAllowsReportArtifact, assertWorkspaceAllowsVerificationPackageArtifact } = await import(
  "../src/workspace-billing.js"
);

const OWNER = "11111111-1111-4111-8111-111111111111";
const EARNED = {
  decision: "ENTITLED",
  basis: "EARNED_AT_FINALIZATION",
  reportsIncluded: true,
  verificationPackageIncluded: true,
  mayIssueHistoricalFirstOutputs: true,
};

beforeEach(() => {
  issuance.mockReset();
  reportCount.mockReset();
  // 140 MiB of evidence + 2 MiB of reports + 100 MiB of packages = 242 MiB of 250.
  evidenceAggregate.mockReset().mockResolvedValue({ _sum: { sizeBytes: 140n * MIB } });
  packageAggregate.mockReset().mockResolvedValue({ _sum: { sizeBytes: 100n * MIB } });
  // No entitled FREE record in the population unless a case says so.
  freeAllowanceRecords.mockReset().mockResolvedValue([]);
  firstReports.mockReset().mockResolvedValue([]);
  packageRows.mockReset().mockResolvedValue([]);
  recoveryRequests.mockReset().mockResolvedValue([]);
  previousPackage.mockReset().mockResolvedValue(null);
  originalEvidence.mockReset().mockResolvedValue(null);
});

const gates = [
  ["report", assertWorkspaceAllowsReportArtifact],
  ["verification package", assertWorkspaceAllowsVerificationPackageArtifact],
] as const;

describe("the owed first issuance passes a full allowance; nothing else does", () => {
  for (const [name, gate] of gates) {
    it(`${name}: earned record, first report version → not refused, bytes still counted`, async () => {
      issuance.mockResolvedValue(EARNED);
      reportCount.mockResolvedValue(0);
      const res = await gate({
        ownerUserId: OWNER,
        teamId: null,
        evidenceId: "ev-1",
        incomingBytes: 141n * MIB,
        issuanceVersion: 1,
      });
      expect(res.usage.storageBytesUsed).toBe(242n * MIB);
      expect(res.usage.storageBytesLimit).toBe(250n * MIB);
      expect(reportCount).toHaveBeenCalledWith({ where: { evidenceId: "ev-1", version: { lt: 1 } } });
    });

    it(`${name}: a credit-funded record's first issuance is owed too`, async () => {
      issuance.mockResolvedValue({ ...EARNED, basis: "EVIDENCE_CREDIT" });
      reportCount.mockResolvedValue(0);
      await expect(
        gate({ ownerUserId: OWNER, teamId: null, evidenceId: "ev-1", incomingBytes: 141n * MIB, issuanceVersion: 1 }),
      ).resolves.toBeTruthy();
    });

    it(`${name}: a LATER version (an earlier report exists) is gated as before`, async () => {
      issuance.mockResolvedValue(EARNED);
      reportCount.mockResolvedValue(1);
      await expect(
        gate({ ownerUserId: OWNER, teamId: null, evidenceId: "ev-1", incomingBytes: 141n * MIB, issuanceVersion: 2 }),
      ).rejects.toMatchObject({ code: "STORAGE_LIMIT_REACHED", statusCode: 409 });
    });

    it(`${name}: outputs not earned at finalization (lifecycle basis) are gated as before`, async () => {
      issuance.mockResolvedValue({ ...EARNED, basis: "PAID_SUBSCRIPTION" });
      reportCount.mockResolvedValue(0);
      await expect(
        gate({ ownerUserId: OWNER, teamId: null, evidenceId: "ev-1", incomingBytes: 141n * MIB, issuanceVersion: 1 }),
      ).rejects.toMatchObject({ code: "STORAGE_LIMIT_REACHED" });
    });

    it(`${name}: no issuance version → gated as before`, async () => {
      issuance.mockResolvedValue(EARNED);
      await expect(
        gate({ ownerUserId: OWNER, teamId: null, evidenceId: "ev-1", incomingBytes: 141n * MIB }),
      ).rejects.toMatchObject({ code: "STORAGE_LIMIT_REACHED" });
      expect(reportCount).not.toHaveBeenCalled();
    });

    it(`${name}: an artifact that fits is never refused (unchanged)`, async () => {
      issuance.mockResolvedValue({ ...EARNED, basis: "PAID_SUBSCRIPTION" });
      await expect(
        gate({ ownerUserId: OWNER, teamId: null, evidenceId: "ev-1", incomingBytes: 8n * MIB, issuanceVersion: 3 }),
      ).resolves.toBeTruthy();
    });
  }
});

describe("the worker's usage population is the API's (evidenceScopeFor)", () => {
  it("a personal scope is measured over the owner's personal workspace, widened to legacy NULL-team rows", async () => {
    issuance.mockResolvedValue(EARNED);
    reportCount.mockResolvedValue(0);
    await assertWorkspaceAllowsReportArtifact({
      ownerUserId: OWNER,
      teamId: null,
      evidenceId: "ev-1",
      incomingBytes: 1n,
      issuanceVersion: 1,
    });
    const where = (evidenceAggregate.mock.calls[0]?.[0] as { where: { AND: unknown[] } }).where;
    expect(where.AND[0]).toEqual(
      evidenceScopeFor({ physicalWorkspaceId: "personal-team-1", workspaceKind: "PERSONAL", personalOwnerUserId: OWNER }),
    );
    expect(where.AND[1]).toEqual({ lifecycleState: { notIn: ["DESTROYED", "RETENTION_ARCHIVED"] } });
  });
});

// AUDIT D-01 — a later report version is admitted against the PAIR it will
// form, so it is refused before commit instead of being left without its
// package when the package gate refuses afterwards.
describe("a later report version is admitted against its package pair", () => {
  // 242 MiB used of 250: a 4 MiB report fits alone.
  const laterReport = (packagePairFollows: boolean) =>
    assertWorkspaceAllowsReportArtifact({
      ownerUserId: OWNER,
      teamId: null,
      evidenceId: "ev-1",
      incomingBytes: 4n * MIB,
      issuanceVersion: 2,
      packagePairFollows,
    });

  it("refuses the report when the previous version's package would not fit beside it", async () => {
    issuance.mockResolvedValue(EARNED);
    reportCount.mockResolvedValue(1);
    previousPackage.mockResolvedValue({ version: 1 });
    // The previous pair's packages (FULL_FORENSIC + EXTERNAL_DISCLOSURE).
    packageAggregate.mockImplementation(async (args: { where: { version?: number } }) =>
      args.where.version === 1 ? { _sum: { sizeBytes: 30n * MIB } } : { _sum: { sizeBytes: 100n * MIB } },
    );
    await expect(laterReport(true)).rejects.toMatchObject({ code: "STORAGE_LIMIT_REACHED", statusCode: 409 });
    expect(previousPackage).toHaveBeenCalledWith({
      where: { evidenceId: "ev-1", state: "PUBLISHED", version: { lt: 2 } },
      orderBy: { version: "desc" },
      select: { version: true },
    });
  });

  it("with no earlier package, estimates from the original evidence bytes", async () => {
    issuance.mockResolvedValue(EARNED);
    reportCount.mockResolvedValue(1);
    originalEvidence.mockResolvedValue({ sizeBytes: 20n * MIB });
    await expect(laterReport(true)).rejects.toMatchObject({ code: "STORAGE_LIMIT_REACHED" });
    originalEvidence.mockResolvedValue({ sizeBytes: 1n * MIB });
    await expect(laterReport(true)).resolves.toBeTruthy();
  });

  it("a report with no package following (or no package owed) is gated on its own bytes, as before", async () => {
    issuance.mockResolvedValue(EARNED);
    reportCount.mockResolvedValue(1);
    previousPackage.mockResolvedValue({ version: 1 });
    await expect(laterReport(false)).resolves.toBeTruthy();
    issuance.mockResolvedValue({ ...EARNED, verificationPackageIncluded: false });
    await expect(laterReport(true)).resolves.toBeTruthy();
    expect(previousPackage).not.toHaveBeenCalled();
  });

  it("the owed first issuance stays exempt: no estimate is read", async () => {
    issuance.mockResolvedValue(EARNED);
    reportCount.mockResolvedValue(0);
    await expect(
      assertWorkspaceAllowsReportArtifact({
        ownerUserId: OWNER,
        teamId: null,
        evidenceId: "ev-1",
        incomingBytes: 141n * MIB,
        issuanceVersion: 1,
        packagePairFollows: true,
      }),
    ).resolves.toBeTruthy();
    expect(previousPackage).not.toHaveBeenCalled();
  });
});

describe("the report run states that its package follows (processor.ts)", () => {
  it("passes packagePairFollows from the run's own package decision", () => {
    const src = readFileSync(new URL("../src/processor.ts", import.meta.url), "utf8");
    const call = src.slice(src.indexOf("await assertWorkspaceAllowsReportArtifact({"));
    expect(call.slice(0, call.indexOf("});"))).toMatch(
      /packagePairFollows: prepared\.verificationPackageIncluded === true,/,
    );
  });
});

// AUDIT D-03 (product decision 2026-11-15) — the first issuance of an entitled
// FREE record is not customer storage. The worker's usage subtracts it through
// the SAME shared-runtime measure the API uses; later versions still count.
describe("D-03: an entitled Free record's first issuance is left out of the customer-facing usage", () => {
  // Stored: 140 MiB evidence + 2 MiB reports + 100 MiB packages = 242 MiB.
  // Of it, the FREE record's v1 report (2 MiB) and v1 packages (98 + 2 MiB).
  const freeFirstIssuance = () => {
    freeAllowanceRecords.mockResolvedValue([{ id: "ev-free" }]);
    firstReports.mockResolvedValue([{ evidenceId: "ev-free", version: 1, sizeBytes: 2n * MIB }]);
    packageRows.mockResolvedValue([
      { evidenceId: "ev-free", version: 1, sizeBytes: 98n * MIB },
      { evidenceId: "ev-free", version: 1, sizeBytes: 2n * MIB },
    ]);
  };

  it("a later version of another record fits once the Free first issuance is not counted; actual bytes stay visible", async () => {
    freeFirstIssuance();
    issuance.mockResolvedValue({ ...EARNED, basis: "PAID_SUBSCRIPTION" });
    reportCount.mockResolvedValue(1);
    // 50 MiB would not fit beside 242 MiB, and fits beside 140 MiB.
    const res = await assertWorkspaceAllowsReportArtifact({
      ownerUserId: OWNER,
      teamId: null,
      evidenceId: "ev-other",
      incomingBytes: 50n * MIB,
      issuanceVersion: 2,
    });
    expect(res.usage.storageBytesUsed).toBe(140n * MIB);
    expect(res.usage.actualStorageBytes).toBe(242n * MIB);
    expect(res.usage.firstIssuanceExcludedBytes).toBe(102n * MIB);
    // The measure reads the entitled Free records of the SAME population.
    const where = (freeAllowanceRecords.mock.calls[0]?.[0] as { where: { AND: unknown[] } }).where;
    expect(where.AND[1]).toEqual({ outputEarnedPlan: "FREE", outputEarnedBasis: "FREE_ALLOWANCE" });
    expect((where.AND[0] as { AND: unknown[] }).AND[1]).toEqual({
      lifecycleState: { notIn: ["DESTROYED", "RETENTION_ARCHIVED"] },
    });
  });

  it("only the FIRST version's packages are excluded: a later version of the Free record still counts", async () => {
    freeFirstIssuance();
    packageRows.mockResolvedValue([
      { evidenceId: "ev-free", version: 1, sizeBytes: 98n * MIB },
      { evidenceId: "ev-free", version: 2, sizeBytes: 60n * MIB },
    ]);
    issuance.mockResolvedValue({ ...EARNED, basis: "PAID_SUBSCRIPTION" });
    reportCount.mockResolvedValue(1);
    const res = await assertWorkspaceAllowsVerificationPackageArtifact({
      ownerUserId: OWNER,
      teamId: null,
      evidenceId: "ev-other",
      incomingBytes: 1n,
      issuanceVersion: 2,
    });
    expect(res.usage.firstIssuanceExcludedBytes).toBe(100n * MIB);
    expect(res.usage.storageBytesUsed).toBe(142n * MIB);
  });

  it("a refusal still happens beyond the allowance, and its telemetry carries the actual stored bytes", async () => {
    freeFirstIssuance();
    issuance.mockResolvedValue({ ...EARNED, basis: "PAID_SUBSCRIPTION" });
    reportCount.mockResolvedValue(1);
    const err = (await assertWorkspaceAllowsReportArtifact({
      ownerUserId: OWNER,
      teamId: null,
      evidenceId: "ev-other",
      incomingBytes: 111n * MIB,
      issuanceVersion: 2,
    }).catch((e: unknown) => e)) as { code?: string; details?: Record<string, string> };
    expect(err.code).toBe("STORAGE_LIMIT_REACHED");
    expect(err.details).toMatchObject({
      storageBytesUsed: String(140n * MIB),
      actualStorageBytes: String(242n * MIB),
      firstIssuanceExcludedBytes: String(102n * MIB),
    });
  });

  it("no entitled Free record in the population: nothing is excluded (credit-funded and paid records count)", async () => {
    issuance.mockResolvedValue({ ...EARNED, basis: "PAID_SUBSCRIPTION" });
    reportCount.mockResolvedValue(1);
    await expect(
      assertWorkspaceAllowsReportArtifact({
        ownerUserId: OWNER,
        teamId: null,
        evidenceId: "ev-other",
        incomingBytes: 50n * MIB,
        issuanceVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_LIMIT_REACHED" });
    // No first-issuance read. (B7A-F-006: the only report read is the population's
    // LATER versions, for committed key-compromise replacements — none here.)
    expect(firstReports.mock.calls.every(([a]) => (a as { where?: { version?: unknown } })?.where?.version !== undefined)).toBe(true);
    expect(JSON.stringify(firstReports.mock.calls)).toContain('"version":{"gt":1}');
  });
});

// AUDIT D-03 — the server-verified recovery of a proven-missing first-issued
// file (request purpose `missing_output_recovery`) of an entitled FREE record
// IS that first issuance: the allowance never refuses it. A customer's
// updated report, and any non-Free record, are gated as before.
describe("D-03: a Free first-issuance file recovery is admitted on a full allowance", () => {
  const FREE_FACT = { outputEarnedPlan: "FREE", outputEarnedBasis: "FREE_ALLOWANCE" };
  const recoveryV2 = (fact: unknown, requests: unknown[]) => {
    issuance.mockResolvedValue(EARNED);
    reportCount.mockResolvedValue(1);
    originalEvidence.mockResolvedValue(fact);
    firstReports.mockResolvedValue([{ version: 1, previousReportVersion: null }]);
    recoveryRequests.mockResolvedValue(requests);
    return assertWorkspaceAllowsReportArtifact({
      ownerUserId: OWNER,
      teamId: null,
      evidenceId: "ev-free",
      incomingBytes: 141n * MIB,
      issuanceVersion: 2,
      packagePairFollows: true,
    });
  };

  it("the live recovery request reserving v2 of a FREE_ALLOWANCE record: admitted, no pair estimate", async () => {
    await expect(recoveryV2(FREE_FACT, [{ reportVersion: 2 }])).resolves.toBeTruthy();
    expect(previousPackage).not.toHaveBeenCalled();
    const where = (recoveryRequests.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    // Free audit 0ea0 (B5B-F-400) — the system re-issues: the missing-file
    // recovery, and the automatic chain-verified version of a machine principal.
    expect(where).toMatchObject({ evidenceId: "ev-free" });
    expect(JSON.stringify(where)).toContain('"purpose":"missing_output_recovery"');
    expect(JSON.stringify(where)).toContain('"purpose":"ots_upgrade_completed"');
  });

  it("no recovery request (a customer's updated report): refused as before", async () => {
    await expect(recoveryV2(FREE_FACT, [])).rejects.toMatchObject({ code: "STORAGE_LIMIT_REACHED" });
  });

  it("a recovery of a record that is not a Free allowance slot (paid or credit-funded): refused as before", async () => {
    await expect(recoveryV2({ outputEarnedPlan: "PRO", outputEarnedBasis: "PAID_SUBSCRIPTION" }, [{ reportVersion: 2 }])).rejects.toMatchObject({
      code: "STORAGE_LIMIT_REACHED",
    });
    // No system re-issue read for a record that is not covered. (B7A-F-006: the
    // only request read is the key-compromise replacement check, which a
    // recovery row does not satisfy.)
    for (const [a] of recoveryRequests.mock.calls) {
      expect((a as { where: { purpose?: unknown } }).where.purpose).toBe("signing_key_compromise_replacement");
    }
  });
});
