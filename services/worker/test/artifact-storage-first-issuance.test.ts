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
    },
    report: {
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 2n * MIB } })),
      count: (...args: unknown[]) => reportCount(...args),
    },
    verificationPackage: {
      aggregate: (...args: unknown[]) => packageAggregate(...args),
      findFirst: (...args: unknown[]) => previousPackage(...args),
    },
    evidencePartDerivedAsset: { aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 0 } })) },
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
