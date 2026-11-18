/**
 * B7A-F-006 (free-audit 0ea0, final pass) — THE WORKER'S HALF OF A
 * KEY-COMPROMISE REPLACEMENT.
 *
 *   1. The worker re-checks, at execution time, that the key it would sign
 *      with is not compromised material — the API's offer read the API's
 *      signing env, not the worker's. A compromised key fails TERMINALLY
 *      (`SIGNING_KEY_COMPROMISED`, retriable false), so nothing is issued
 *      sealed by it and the job is not retried into one.
 *   2. A committed replacement version is never customer storage: the
 *      worker's `getWorkspaceUsage` leaves its report and package bytes out,
 *      and its artifact gate never refuses it for storage — whatever the plan
 *      or the version it replaced.
 *
 * Executed through the real guard and gates over a mocked database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MIB = 1024n * 1024n;
const signerRow = vi.fn();
const keyRows = vi.fn();
const issuance = vi.fn();
const reportCount = vi.fn();
const reportRows = vi.fn();
const requestRows = vi.fn();
const packageRows = vi.fn();

vi.mock("../src/db.js", () => ({
  prisma: {
    signerControlState: { findUnique: (...a: unknown[]) => signerRow(...a) },
    signingKey: { findMany: (...a: unknown[]) => keyRows(...a) },
    entitlement: { findFirst: vi.fn(async () => ({ plan: "PRO", credits: 0, teamSeats: 0 })) },
    planGrant: { findFirst: vi.fn(async () => null) },
    workspaceStorageAddon: { aggregate: vi.fn(async () => ({ _sum: { extraStorageBytes: null } })) },
    team: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => ({ id: "personal-team-1" })),
    },
    enterpriseContract: { findUnique: vi.fn(async () => null) },
    evidence: {
      // 240 MiB of originals, no entitled Free / credit records in the population.
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 240n * MIB } })),
      count: vi.fn(async () => 1),
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    report: {
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 4n * MIB } })),
      count: (...a: unknown[]) => reportCount(...a),
      findMany: (...a: unknown[]) => reportRows(...a),
    },
    verificationPackage: {
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 100n * MIB } })),
      findFirst: vi.fn(async () => null),
      findMany: (...a: unknown[]) => packageRows(...a),
    },
    evidencePartDerivedAsset: { aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 0 } })) },
    reportGenerationRequest: { findMany: (...a: unknown[]) => requestRows(...a) },
    evidenceCreditLedgerEntry: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("../src/output-issuance.js", () => ({
  resolveEvidenceOutputIssuance: (...a: unknown[]) => issuance(...a),
}));

const { assertWorkerSignerUsable, SigningKeyCompromisedError } = await import("../src/signing/signer-control-guard.js");
const { getWorkspaceUsage, assertWorkspaceAllowsReportArtifact, assertWorkspaceAllowsVerificationPackageArtifact } =
  await import("../src/workspace-billing.js");

const ENV = ["SIGNING_KEY_ID", "SIGNING_KEY_VERSION", "PACKAGE_SIGNING_KEY_ID", "PACKAGE_SIGNING_KEY_VERSION", "SIGNER_PROVIDER"];
const saved: Record<string, string | undefined> = {};
const OWNER = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT = "signing_key_compromise_replacement";
const SCOPE = {
  billingShape: "SINGLE_OCCUPANT" as const,
  ownerUserId: OWNER,
  teamId: null,
  plan: "PRO" as never,
  credits: 0,
  teamSeats: 0,
  storageBytesOverride: null,
  activeStorageAddonBytes: 0n,
  contractStorageBytes: null,
};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SIGNING_KEY_ID = "kc-evidence";
  process.env.SIGNING_KEY_VERSION = "1";
  process.env.PACKAGE_SIGNING_KEY_ID = "kc-seal";
  process.env.PACKAGE_SIGNING_KEY_VERSION = "1";
  signerRow.mockReset().mockResolvedValue(null); // no row = ACTIVE
  keyRows.mockReset().mockResolvedValue([]);
  issuance.mockReset().mockResolvedValue({
    decision: "ENTITLED",
    basis: "PLAN_INCLUDED",
    reportsIncluded: true,
    verificationPackageIncluded: true,
    mayIssueHistoricalFirstOutputs: true,
  });
  reportCount.mockReset().mockResolvedValue(1);
  reportRows.mockReset().mockResolvedValue([]);
  requestRows.mockReset().mockResolvedValue([]);
  packageRows.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("B7A-F-006 — the worker re-checks the signer it will use", () => {
  it("an ACTIVE signer whose key is compromised material fails terminally with a bounded reason", async () => {
    // The registry row of the seal identity is revoked (a declared compromise).
    keyRows.mockImplementation(async (args: { where?: { keyId?: string } }) =>
      args?.where?.keyId === "kc-seal"
        ? [{ publicKeyPem: "-", fingerprintSha256: "a".repeat(64), revokedAt: new Date("2026-11-18T00:00:00Z") }]
        : [],
    );
    const err = await assertWorkerSignerUsable("verification_package").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SigningKeyCompromisedError);
    expect(err).toMatchObject({ code: "SIGNING_KEY_COMPROMISED", retriable: false });
    expect(String((err as Error).message)).toMatch(/^SIGNING_KEY_COMPROMISED/);
    // The report PDF signer (a different, unaffected identity) still signs.
    await expect(assertWorkerSignerUsable("report_pdf")).resolves.toBeUndefined();
  });

  it("material compromised under ANOTHER identity is compromised for this one too", async () => {
    const fp = "b".repeat(64);
    keyRows.mockImplementation(async (args: { where?: { keyId?: string; fingerprintSha256?: unknown } }) => {
      if (args?.where?.keyId === "kc-seal") return [{ publicKeyPem: "-", fingerprintSha256: fp, revokedAt: null }];
      if (args?.where?.fingerprintSha256 === fp) {
        return [{ keyId: "old-id", version: 3, purpose: "EVIDENCE_SIGNATURE", publicKeyPem: "-", fingerprintSha256: fp, revokedAt: new Date() }];
      }
      return [];
    });
    await expect(assertWorkerSignerUsable("verification_package")).rejects.toMatchObject({ code: "SIGNING_KEY_COMPROMISED" });
  });

  it("an unaffected, ACTIVE signer passes; a revoked signer keeps its existing refusal", async () => {
    await expect(assertWorkerSignerUsable("verification_package")).resolves.toBeUndefined();
    signerRow.mockResolvedValue({ status: "REVOKED" });
    await expect(assertWorkerSignerUsable("verification_package")).rejects.toMatchObject({ code: "signer_not_usable" });
  });
});

describe("B7A-F-006 — a key-compromise replacement is never customer storage (worker host)", () => {
  function replacementCommitted() {
    reportRows.mockResolvedValue([{ evidenceId: "ev-1", version: 2, sizeBytes: 3n * MIB, previousReportVersion: 1 }]);
    requestRows.mockResolvedValue([{ evidenceId: "ev-1", reportVersion: 2, purpose: REPLACEMENT }]);
    packageRows.mockResolvedValue([{ evidenceId: "ev-1", version: 2, reportVersion: 2, sizeBytes: 50n * MIB }]);
  }

  it("getWorkspaceUsage leaves a committed replacement version's report and package out (a paid-plan record, a later version)", async () => {
    const before = await getWorkspaceUsage(SCOPE);
    replacementCommitted();
    const after = await getWorkspaceUsage(SCOPE);
    expect(before.actualStorageBytes).toBe(after.actualStorageBytes);
    expect(before.storageBytesUsed - after.storageBytesUsed).toBe(53n * MIB);
    expect(after.firstIssuanceExcludedBytes).toBe(53n * MIB);
  });

  it("a request row that is NOT a replacement (another purpose) excludes nothing", async () => {
    replacementCommitted();
    requestRows.mockResolvedValue([{ evidenceId: "ev-1", reportVersion: 2, purpose: "updated_report" }]);
    const usage = await getWorkspaceUsage(SCOPE);
    expect(usage.firstIssuanceExcludedBytes).toBe(0n);
  });

  for (const [name, gate] of [
    ["report", assertWorkspaceAllowsReportArtifact],
    ["verification package", assertWorkspaceAllowsVerificationPackageArtifact],
  ] as const) {
    it(`${name} gate: the replacement version is not refused for storage; an ordinary later version still is`, async () => {
      // The allowance is far exceeded by this artifact.
      const input = { ownerUserId: OWNER, teamId: null, evidenceId: "ev-1", incomingBytes: 1_000_000n * MIB, issuanceVersion: 2 };
      await expect(gate(input)).rejects.toMatchObject({ code: "STORAGE_LIMIT_REACHED" });
      requestRows.mockResolvedValue([{ evidenceId: "ev-1", reportVersion: 2, purpose: REPLACEMENT }]);
      await expect(gate(input)).resolves.toBeTruthy();
    });
  }
});
