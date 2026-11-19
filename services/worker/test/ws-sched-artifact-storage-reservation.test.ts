/**
 * WS-SCHED / PRO-W1-06 + PRO-W1-07 (DEC-04) — the worker's artifact storage
 * gate RESERVES before bytes are written, and the exchange builder asks the
 * workspace again when it claims a build.
 *
 * Unit level: the gate's own logic (the lock it takes, what it counts, what it
 * writes on the request row, what it leaves behind when refused). The race
 * itself — two real runs against live PostgreSQL — is
 * services/api/test/forward/forward-output-pipeline.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const MIB = 1024n * 1024n;
const OWNER = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";

const issuance = vi.fn();
const reportCount = vi.fn();
const reservedAggregate = vi.fn();
const exchangeAggregate = vi.fn();
const requestUpdateMany = vi.fn();
const executeRaw = vi.fn();
const transaction = vi.fn();
const teamFindFirst = vi.fn();
const teamFindUnique = vi.fn();
const organizationFindUnique = vi.fn();
const contractFindUnique = vi.fn();
const grantFindUnique = vi.fn();

vi.mock("../src/db.js", () => {
  const client = {
    entitlement: { findFirst: vi.fn(async () => ({ plan: "FREE", credits: 0, teamSeats: 0 })) },
    planGrant: { findFirst: vi.fn(async () => null) },
    workspaceStorageAddon: { aggregate: vi.fn(async () => ({ _sum: { extraStorageBytes: null } })) },
    team: {
      findUnique: (...a: unknown[]) => teamFindUnique(...a),
      findFirst: (...a: unknown[]) => teamFindFirst(...a),
    },
    organization: { findUnique: (...a: unknown[]) => organizationFindUnique(...a) },
    enterpriseContract: { findUnique: (...a: unknown[]) => contractFindUnique(...a) },
    entitlementGrant: { findUnique: (...a: unknown[]) => grantFindUnique(...a) },
    teamMember: { count: vi.fn(async () => 0) },
    evidence: {
      // 200 MiB of originals of the Free 250 MiB allowance.
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 200n * MIB } })),
      count: vi.fn(async () => 2),
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    report: {
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 0n } })),
      count: (...a: unknown[]) => reportCount(...a),
      findMany: vi.fn(async () => []),
    },
    verificationPackage: {
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 0n } })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    evidencePartDerivedAsset: { aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 0 } })) },
    evidenceExchangePackage: { aggregate: (...a: unknown[]) => exchangeAggregate(...a) },
    reportGenerationRequest: {
      findMany: vi.fn(async () => []),
      aggregate: (...a: unknown[]) => reservedAggregate(...a),
      updateMany: (...a: unknown[]) => requestUpdateMany(...a),
    },
    evidenceCreditLedgerEntry: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    $executeRaw: (...a: unknown[]) => executeRaw(...a),
    $transaction: (...a: unknown[]) => transaction(...a),
  };
  return { prisma: client };
});
vi.mock("../src/output-issuance.js", () => ({
  resolveEvidenceOutputIssuance: (...args: unknown[]) => issuance(...args),
}));

const {
  assertWorkspaceAllowsReportArtifact,
  assertWorkspaceAllowsVerificationPackageArtifact,
  getWorkspaceUsage,
  releaseArtifactStorageReservation,
  resolveExchangeBuildAdmission,
  resolveWorkspaceScopeForEvidence,
} = await import("../src/workspace-billing.js");
const { prisma } = await import("../src/db.js");

const PAID = {
  decision: "ENTITLED",
  basis: "PAID_SUBSCRIPTION",
  reportsIncluded: true,
  verificationPackageIncluded: true,
  mayIssueHistoricalFirstOutputs: true,
};
const HOLDER = { requestId: "req-1", claimedAtUtc: new Date("2026-11-19T10:00:00Z") };

beforeEach(() => {
  issuance.mockReset().mockResolvedValue(PAID);
  reportCount.mockReset().mockResolvedValue(1);
  reservedAggregate.mockReset().mockResolvedValue({ _sum: { storageReservedBytes: null } });
  exchangeAggregate.mockReset().mockResolvedValue({ _sum: { packageSizeBytes: null } });
  requestUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  executeRaw.mockReset().mockResolvedValue(1);
  transaction.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  teamFindFirst.mockReset().mockResolvedValue({ id: "personal-team-1" });
  teamFindUnique.mockReset().mockResolvedValue(null);
  organizationFindUnique.mockReset().mockResolvedValue({ status: "ACTIVE" });
  contractFindUnique.mockReset().mockResolvedValue(null);
  grantFindUnique.mockReset().mockResolvedValue(null);
});

const lockKeys = () =>
  executeRaw.mock.calls.map((call) => (call as unknown[]).slice(1).join("|"));

describe("PRO-W1-07 — exchange package ZIPs are in the worker's usage figure", () => {
  it("stored exchange ZIP bytes count as stored and as used; the sum is scoped to the usage Team and to rows with a pointer", async () => {
    exchangeAggregate.mockResolvedValue({ _sum: { packageSizeBytes: 12n * MIB } });
    const usage = await getWorkspaceUsage(await resolveWorkspaceScopeForEvidence({ ownerUserId: OWNER, teamId: null }));
    expect(usage.exchangePackageStorageBytes).toBe(12n * MIB);
    expect(usage.actualStorageBytes).toBe(212n * MIB);
    expect(usage.storageBytesUsed).toBe(212n * MIB);
    expect(exchangeAggregate).toHaveBeenCalledWith({
      where: { teamId: "personal-team-1", storageKey: { not: null } },
      _sum: { packageSizeBytes: true },
    });
  });
});

describe("PRO-W1-06 — the artifact gate reserves before bytes are written", () => {
  it("live reservations of other runs are in the figure the gate reads, not in the stored bytes", async () => {
    reservedAggregate.mockResolvedValue({ _sum: { storageReservedBytes: 30n * MIB } });
    const usage = await getWorkspaceUsage(await resolveWorkspaceScopeForEvidence({ ownerUserId: OWNER, teamId: null }));
    expect(usage.reservedStorageBytes).toBe(30n * MIB);
    expect(usage.storageBytesUsed).toBe(230n * MIB);
    expect(usage.actualStorageBytes).toBe(200n * MIB);
    const where = JSON.stringify(reservedAggregate.mock.calls[0]![0]);
    // Live = this Team, a figure on the row, and a PROCESSING claim inside its lease.
    expect(where).toContain('"teamId":"personal-team-1"');
    expect(where).toContain('"storageReservedBytes":{"not":null}');
    expect(where).toContain('"state":"PROCESSING"');
  });

  it("package gate: admitted under the workspace capacity lock, and the exact bytes are recorded on the claimed request", async () => {
    await assertWorkspaceAllowsVerificationPackageArtifact({
      ownerUserId: OWNER,
      teamId: null,
      evidenceId: "ev-1",
      incomingBytes: 20n * MIB,
      issuanceVersion: 2,
      reservation: HOLDER,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    // The API's capacity lock key for the same payer (lockEvidenceCapacitySubject).
    expect(lockKeys()).toEqual([`evidence-capacity:PERSONAL:${OWNER}`]);
    expect(requestUpdateMany).toHaveBeenCalledWith({
      where: { id: "req-1", state: "PROCESSING", claimedAtUtc: HOLDER.claimedAtUtc },
      data: { storageReservedBytes: 20n * MIB },
    });
    // Its own earlier reservation is left out of the read.
    expect(JSON.stringify(reservedAggregate.mock.calls[0]![0])).toContain('"id":{"not":"req-1"}');
  });

  it("report gate: reserves the PDF plus the paired package estimate and reports what stays reserved after the report commits", async () => {
    const res = await assertWorkspaceAllowsReportArtifact({
      ownerUserId: OWNER,
      teamId: null,
      evidenceId: "ev-1",
      incomingBytes: 1n * MIB,
      issuanceVersion: 2,
      packagePairFollows: true,
      reservation: HOLDER,
    });
    // No earlier package and no original size in this fixture: the estimate is 0.
    expect(res.reservedFollowingBytes).toBe(0n);
    expect(requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { storageReservedBytes: 1n * MIB } }),
    );
  });

  it("another run's reservation refuses this one BEFORE anything is written, and leaves no reservation of its own", async () => {
    // 200 stored + 40 reserved by a concurrent run + 20 incoming > 250.
    reservedAggregate.mockResolvedValue({ _sum: { storageReservedBytes: 40n * MIB } });
    await expect(
      assertWorkspaceAllowsVerificationPackageArtifact({
        ownerUserId: OWNER,
        teamId: null,
        evidenceId: "ev-1",
        incomingBytes: 20n * MIB,
        issuanceVersion: 2,
        reservation: HOLDER,
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_LIMIT_REACHED",
      details: expect.objectContaining({ reservedStorageBytes: (40n * MIB).toString() }),
    });
    // Never recorded; the estimate held since the report gate is released.
    expect(requestUpdateMany).toHaveBeenCalledTimes(1);
    expect(requestUpdateMany).toHaveBeenCalledWith({
      where: { id: "req-1", state: "PROCESSING", claimedAtUtc: HOLDER.claimedAtUtc, storageReservedBytes: { not: null } },
      data: { storageReservedBytes: null },
    });
  });

  it("the same bytes fit when no other run holds a reservation (a single run is unchanged)", async () => {
    await expect(
      assertWorkspaceAllowsVerificationPackageArtifact({
        ownerUserId: OWNER,
        teamId: null,
        evidenceId: "ev-1",
        incomingBytes: 20n * MIB,
        issuanceVersion: 2,
        reservation: HOLDER,
      }),
    ).resolves.toBeTruthy();
  });

  it("a run whose claim was taken over reserves nothing and may not publish (retryable REPORT_CLAIM_LOST)", async () => {
    requestUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      assertWorkspaceAllowsVerificationPackageArtifact({
        ownerUserId: OWNER,
        teamId: null,
        evidenceId: "ev-1",
        incomingBytes: 20n * MIB,
        issuanceVersion: 2,
        reservation: HOLDER,
      }),
    ).rejects.toMatchObject({ code: "REPORT_CLAIM_LOST", retriable: true });
  });

  it("an exempt first issuance is never refused and reserves nothing (no lock, no transaction)", async () => {
    issuance.mockResolvedValue({ ...PAID, basis: "EARNED_AT_FINALIZATION" });
    reportCount.mockResolvedValue(0);
    const res = await assertWorkspaceAllowsReportArtifact({
      ownerUserId: OWNER,
      teamId: null,
      evidenceId: "ev-1",
      incomingBytes: 400n * MIB,
      issuanceVersion: 1,
      reservation: HOLDER,
    });
    expect(res.reservedFollowingBytes).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(requestUpdateMany).not.toHaveBeenCalled();
  });

  it("a gate without a holder (legacy caller) checks as before and writes nothing", async () => {
    await assertWorkspaceAllowsVerificationPackageArtifact({
      ownerUserId: OWNER,
      teamId: null,
      evidenceId: "ev-1",
      incomingBytes: 20n * MIB,
      issuanceVersion: 2,
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(requestUpdateMany).not.toHaveBeenCalled();
  });

  it("release is fenced by the claim", async () => {
    await releaseArtifactStorageReservation(HOLDER);
    expect(requestUpdateMany).toHaveBeenCalledWith({
      where: { id: "req-1", state: "PROCESSING", claimedAtUtc: HOLDER.claimedAtUtc, storageReservedBytes: { not: null } },
      data: { storageReservedBytes: null },
    });
  });
});

describe("PRO-W1-07 — the exchange builder asks the workspace again at claim", () => {
  const liveTeam = () => {
    teamFindFirst.mockResolvedValue({ organizationId: ORG });
    teamFindUnique.mockResolvedValue({
      id: TEAM,
      ownerUserId: OWNER,
      organizationId: ORG,
      billingPlan: "TEAM",
      billingStatus: "ACTIVE",
      includedSeats: 5,
      storageBytesOverride: null,
      workspaceKind: "ORGANIZATION",
      isPersonal: false,
    });
  };

  it("a closed (or missing) workspace builds nothing — the canonical liveness predicate", async () => {
    teamFindFirst.mockResolvedValue(null);
    expect(await resolveExchangeBuildAdmission(TEAM)).toEqual({ admitted: false, reason: "workspace_closed" });
    expect(teamFindFirst).toHaveBeenCalledWith({
      where: { AND: [{ id: TEAM }, { closedAtUtc: null }] },
      select: { organizationId: true },
    });
  });

  it("an organization that is not ACTIVE builds nothing", async () => {
    liveTeam();
    organizationFindUnique.mockResolvedValue({ status: "SUSPENDED" });
    expect(await resolveExchangeBuildAdmission(TEAM)).toEqual({ admitted: false, reason: "organization_not_active" });
  });

  it("no grant, not Enterprise: not entitled (the conservative default)", async () => {
    liveTeam();
    expect(await resolveExchangeBuildAdmission(TEAM)).toEqual({ admitted: false, reason: "exchange_not_entitled" });
  });

  it("an unexpired stored grant entitles; an expired one and a false one do not", async () => {
    liveTeam();
    grantFindUnique.mockResolvedValue({ kind: "FEATURE", valueBool: true, expiresAtUtc: null });
    expect(await resolveExchangeBuildAdmission(TEAM)).toEqual({ admitted: true });
    expect(grantFindUnique).toHaveBeenCalledWith({
      where: { teamId_key: { teamId: TEAM, key: "FEATURE_EVIDENCE_EXCHANGE" } },
      select: { kind: true, valueBool: true, expiresAtUtc: true },
    });
    grantFindUnique.mockResolvedValue({ kind: "FEATURE", valueBool: true, expiresAtUtc: new Date(Date.now() - 1000) });
    expect(await resolveExchangeBuildAdmission(TEAM)).toEqual({ admitted: false, reason: "exchange_not_entitled" });
    grantFindUnique.mockResolvedValue({ kind: "FEATURE", valueBool: false, expiresAtUtc: null });
    expect(await resolveExchangeBuildAdmission(TEAM)).toEqual({ admitted: false, reason: "exchange_not_entitled" });
  });

  it("Enterprise: an ACTIVE contract sells it with nothing stored; a lapsed contract grants nothing even through a stored row", async () => {
    liveTeam();
    teamFindUnique.mockResolvedValue({
      id: TEAM,
      ownerUserId: OWNER,
      organizationId: ORG,
      billingPlan: "ENTERPRISE",
      billingStatus: "ACTIVE",
      includedSeats: 50,
      storageBytesOverride: null,
      workspaceKind: "ORGANIZATION",
      isPersonal: false,
    });
    contractFindUnique.mockResolvedValue({ status: "ACTIVE", storageGb: 100 });
    expect(await resolveExchangeBuildAdmission(TEAM)).toEqual({ admitted: true });
    contractFindUnique.mockResolvedValue({ status: "SUSPENDED", storageGb: 100 });
    grantFindUnique.mockResolvedValue({ kind: "FEATURE", valueBool: true, expiresAtUtc: null });
    expect(await resolveExchangeBuildAdmission(TEAM)).toEqual({ admitted: false, reason: "exchange_not_entitled" });
  });
});
