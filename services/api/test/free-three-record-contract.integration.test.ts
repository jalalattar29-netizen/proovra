/**
 * FREE THREE-RECORD CONTRACT (owner decision 2026-10-14) — executed proof.
 *
 * WHAT IS REAL: PostgreSQL 16 (testcontainers), the API over HTTP (create,
 * part, presigned PUT, complete, trash, restore, regenerate), MinIO object
 * storage (the bytes are PUT to the presigned URL and hashed from storage at
 * finalization), the record signer, the capacity lock and settlement, the
 * stored earned fact, and BOTH hosts' issuance resolvers (API eligibility and
 * the worker's own adapter). WHAT IS DOUBLED: the RFC 3161 authority (an
 * external network service).
 *
 *   - FREE records 1–3 finalize, each settled into a FREE slot, each earning
 *     report + package (FREE_ALLOWANCE), each with a generation request;
 *   - the fourth is refused; concurrent third/fourth cannot exceed three;
 *   - a draft, an abandoned upload and a retried finalize consume nothing;
 *   - trash / restore consume nothing and restore no slot;
 *   - recovery of an output consumes nothing; a FREE new version with no
 *     material fact change is refused;
 *   - Team-workspace evidence never touches the personal FREE allowance;
 *   - upgrade and downgrade keep the outputs a record earned;
 *   - the bounded backfill covers exactly the first three historical records.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOwnedWorkspace,
  seedPersonalTenant,
  setAccountPlan,
  type FixtureDeps,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

describe("FREE three complete records (Postgres + MinIO, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let clearRates: () => Promise<unknown>;
  let countHeld: (typeof import("../src/services/billing-enforcement.service.js"))["countPersonalEvidenceRecords"];
  let apiEligibility: (typeof import("../src/services/billing/evidence-output-eligibility.service.js"))["resolveEvidenceOutputEligibility"];
  let workerIssuance: (typeof import("../../worker/src/output-issuance.js"))["resolveEvidenceOutputIssuance"];
  let backfill: typeof import("../src/scripts/three-decisions-backfill.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    ({ countPersonalEvidenceRecords: countHeld } = await import("../src/services/billing-enforcement.service.js"));
    ({ resolveEvidenceOutputEligibility: apiEligibility } = await import(
      "../src/services/billing/evidence-output-eligibility.service.js"
    ));
    ({ resolveEvidenceOutputIssuance: workerIssuance } = await import("../../worker/src/output-issuance.js"));
    backfill = await import("../src/scripts/three-decisions-backfill.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `free3-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
  }, 600_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 120_000);

  const call = (method: "GET" | "POST" | "DELETE", url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  /** Create a record, upload real bytes to MinIO through the presigned URL. */
  async function draftWithBytes(token: string, teamHeader?: string): Promise<{ id: string; sha256: string }> {
    const created = await call("POST", "/v1/evidence", token, { type: "DOCUMENT", mimeType: "text/plain" }, teamHeader ? { "x-proovra-workspace-id": teamHeader } : {});
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const part = await call("POST", `/v1/evidence/${id}/parts`, token, {
      partIndex: 0,
      mimeType: "text/plain",
      originalFileName: "free-contract.txt",
    });
    expect(part.statusCode, part.body).toBe(201);
    const bytes = Buffer.from(`free-three-${id}-${randomBytes(8).toString("hex")}`);
    const put = await fetch(part.json().upload.putUrl as string, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "text/plain" },
    });
    expect(put.status, await put.text()).toBe(200);
    return { id, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async function finalize(token: string, id: string) {
    return call("POST", `/v1/evidence/${id}/complete`, token, {});
  }

  async function captureFinalized(t: PersonalTenant): Promise<string> {
    const { id } = await draftWithBytes(t.owner.token);
    const done = await finalize(t.owner.token, id);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().status).toBe("SIGNED");
    return id;
  }

  const factOf = (id: string) =>
    prisma.evidence.findUniqueOrThrow({ where: { id }, select: { outputEarnedPlan: true, outputEarnedBasis: true } });
  const ledgerRows = (userId: string) => prisma.evidenceCreditLedgerEntry.count({ where: { userId } });

  async function bothHostsSay(id: string, ownerUserId: string, teamId: string | null) {
    const api = await apiEligibility({ evidenceId: id, ownerUserId, teamId });
    const worker = await workerIssuance({ id, ownerUserId, teamId });
    expect(worker.decision, "API and worker reach the same decision").toBe(api.issuance.decision);
    expect(worker.basis).toBe(api.issuance.basis);
    expect(worker.reportsIncluded).toBe(api.reportsIncluded);
    expect(worker.verificationPackageIncluded).toBe(api.verificationPackageIncluded);
    return api;
  }

  it("records 1–3 finalize into FREE slots, each earning report + package + a generation request; the fourth is refused", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await captureFinalized(t));

    for (const id of ids) {
      expect(await factOf(id)).toEqual({ outputEarnedPlan: "FREE", outputEarnedBasis: "FREE_ALLOWANCE" });
      const decision = await bothHostsSay(id, t.owner.userId, t.personalTeamId);
      expect(decision).toMatchObject({ reportsIncluded: true, verificationPackageIncluded: true, reportEligibility: "ELIGIBLE", packageEligibility: "ELIGIBLE" });
      expect(decision.issuance.basis).toBe("EARNED_AT_FINALIZATION");
      // Finalization enqueued Report v1 (+ its package) through the canonical writer.
      expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: id } })).toBeGreaterThanOrEqual(1);
    }
    expect(await countHeld(t.owner.userId)).toBe(3);
    expect(await ledgerRows(t.owner.userId)).toBe(0);

    const fourth = await call("POST", "/v1/evidence", t.owner.token, { type: "DOCUMENT", mimeType: "text/plain" });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().code).toBe("FREE_LIMIT_REACHED");
    expect(String(fourth.json().message ?? fourth.json().error?.message ?? "")).toMatch(/Deleting a record does not restore a slot/);
  }, 240_000);

  it("a retried finalize does not consume a second slot; a draft and an abandoned upload consume nothing", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const first = await captureFinalized(t);
    const retry = await finalize(t.owner.token, first);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().alreadyFinalized).toBe(true);
    expect(await countHeld(t.owner.userId)).toBe(1);

    // A draft holds a LIVE reservation only; once abandoned it holds nothing
    // and nothing was consumed.
    const { id: abandoned } = await draftWithBytes(t.owner.token);
    expect(await countHeld(t.owner.userId)).toBe(2);
    const past = new Date(Date.now() - 26 * 60 * 60 * 1000);
    await prisma.evidence.update({ where: { id: abandoned }, data: { createdAt: past, updatedAt: past } });
    await prisma.uploadSession.updateMany({ where: { evidenceId: abandoned }, data: { lastActivityAtUtc: past } });
    expect(await countHeld(t.owner.userId)).toBe(1);
    // ...and its finalize is refused, consuming nothing.
    const late = await finalize(t.owner.token, abandoned);
    expect(late.statusCode).not.toBe(200);
    expect(await countHeld(t.owner.userId)).toBe(1);
    expect((await factOf(abandoned)).outputEarnedBasis).toBeNull();
    expect(await ledgerRows(t.owner.userId)).toBe(0);
  }, 240_000);

  it("concurrent third and fourth: never more than three FREE slots, at admission and at settlement", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    await captureFinalized(t);
    await captureFinalized(t);
    // Admission: two concurrent creates at 2/3 — exactly one is admitted.
    const races = await Promise.all([
      call("POST", "/v1/evidence", t.owner.token, { type: "DOCUMENT", mimeType: "text/plain" }),
      call("POST", "/v1/evidence", t.owner.token, { type: "DOCUMENT", mimeType: "text/plain" }),
    ]);
    expect(races.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const admitted = races.find((r) => r.statusCode === 201)!.json().id as string;
    // Settlement: a second unsealed record that slipped past admission (a raw
    // row, as a racing path would leave it) cannot ALSO seal into a FREE slot.
    const sneaked = await prisma.evidence.create({
      data: {
        type: "DOCUMENT",
        status: "UPLOADING",
        ownerUserId: t.owner.userId,
        teamId: t.personalTeamId,
        organizationId: t.personalOrganizationId,
        mimeType: "text/plain",
      } as never,
      select: { id: true },
    });
    // Upload bytes for both, then finalize concurrently.
    const upload = async (id: string) => {
      const part = await call("POST", `/v1/evidence/${id}/parts`, t.owner.token, { partIndex: 0, mimeType: "text/plain", originalFileName: "race.txt" });
      if (part.statusCode !== 201) return;
      await fetch(part.json().upload.putUrl as string, { method: "PUT", body: Buffer.from(`race-${id}`), headers: { "content-type": "text/plain" } });
    };
    await upload(admitted);
    await upload(sneaked.id);
    const finals = await Promise.all([finalize(t.owner.token, admitted), finalize(t.owner.token, sneaked.id)]);
    const sealed = finals.filter((f) => f.statusCode === 200).length;
    expect(sealed).toBeLessThanOrEqual(1);
    const facts = await prisma.evidence.count({ where: { ownerUserId: t.owner.userId, outputEarnedBasis: "FREE_ALLOWANCE" } });
    expect(facts).toBe(2 + sealed);
    expect(facts).toBeLessThanOrEqual(3);
  }, 240_000);

  it("trash, restore and recovery consume nothing; a FREE new version with no material change is refused", async () => {
    const t = await seedPersonalTenant(deps, "FREE", { credits: 2 });
    const id = await captureFinalized(t);
    expect((await call("DELETE", `/v1/evidence/${id}`, t.owner.token)).statusCode).toBe(200);
    expect(await countHeld(t.owner.userId)).toBe(1);
    expect((await call("POST", `/v1/evidence/${id}/restore`, t.owner.token, { restore: true })).statusCode).toBe(200);
    expect(await countHeld(t.owner.userId)).toBe(1);
    expect(await ledgerRows(t.owner.userId)).toBe(0);
    expect((await prisma.entitlement.findFirstOrThrow({ where: { userId: t.owner.userId, active: true } })).credits).toBe(2);

    // Output recovery (the system re-driving what finalization requested)
    // spends nothing: no ledger row, the same slot count.
    const recover = await call("POST", `/v1/evidence/${id}/reports/regenerate`, t.owner.token, {});
    expect([200, 202, 409]).toContain(recover.statusCode);
    expect(await ledgerRows(t.owner.userId)).toBe(0);
    expect(await countHeld(t.owner.userId)).toBe(1);

    // A complete pair with no newer verification fact: no free re-render.
    await prisma.report.create({
      data: {
        evidenceId: id,
        version: 1,
        storageBucket: process.env.S3_BUCKET!,
        storageKey: `reports/${id}/v1.pdf`,
        generatedAtUtc: new Date(),
      } as never,
    });
    await prisma.verificationPackage.create({
      data: {
        evidenceId: id,
        version: 1,
        reportVersion: 1,
        storageBucket: process.env.S3_BUCKET!,
        storageKey: `verification/${id}/v1.zip`,
        generatedAtUtc: new Date(),
      } as never,
    });
    await prisma.evidence.update({ where: { id }, data: { status: "REPORTED", latestReportVersion: 1, verificationPackageVersion: 1 } });
    const newVersion = await call("POST", `/v1/evidence/${id}/reports/regenerate`, t.owner.token, {
      intent: "NEW_VERSION",
      reason: "Re-render the same facts",
      clientRequestKey: `nv-${randomBytes(6).toString("hex")}`,
    });
    expect(newVersion.statusCode, newVersion.body).toBe(409);
    expect(newVersion.json().code).toBe("NEW_VERSION_NO_MATERIAL_CHANGE");
    expect(await prisma.report.count({ where: { evidenceId: id } })).toBe(1);
  }, 240_000);

  it("Team-workspace evidence uses the workspace's entitlement, never the personal FREE allowance", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const ws = await seedOwnedWorkspace(deps, { ownerUserId: t.owner.userId, billingPlan: "TEAM", billingStatus: "ACTIVE" });
    await captureFinalized(t);
    expect(await countHeld(t.owner.userId)).toBe(1);
    const row = await prisma.evidence.create({
      data: {
        type: "DOCUMENT",
        status: "SIGNED",
        ownerUserId: t.owner.userId,
        teamId: ws.teamId,
        organizationId: ws.organizationId,
        signedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    expect(await countHeld(t.owner.userId), "a Team record is not a personal FREE slot").toBe(1);
    const decision = await bothHostsSay(row.id, t.owner.userId, ws.teamId);
    expect(decision.issuance.basis).not.toBe("FREE_ALLOWANCE");
  }, 240_000);

  it("upgrade and downgrade keep what each record earned", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const freeRecord = await captureFinalized(t);
    await setAccountPlan(deps, t.owner.userId, "PRO");
    for (const plan of ["PRO", "FREE"] as const) {
      await setAccountPlan(deps, t.owner.userId, plan);
      const d = await bothHostsSay(freeRecord, t.owner.userId, t.personalTeamId);
      expect(d.issuance, plan).toMatchObject({ decision: "ENTITLED", basis: "EARNED_AT_FINALIZATION", reportsIncluded: true });
    }
  }, 240_000);

  it("the backfill covers exactly the first three historical FREE records — dry run, apply, idempotent replay", async () => {
    const t = await seedPersonalTenant(deps, "FREE", { legacyRecordCapOverride: 10 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const row = await prisma.evidence.create({
        data: {
          type: "DOCUMENT",
          status: "SIGNED",
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          signedAtUtc: new Date(Date.UTC(2026, 0, 1 + i)),
          lifecycleState: i === 1 ? "TRASHED" : "ACTIVE",
          deletedAt: i === 1 ? new Date() : null,
        } as never,
        select: { id: true },
      });
      ids.push(row.id);
    }
    const after = (await prisma.user.findMany({ where: { id: { lt: t.owner.userId } }, orderBy: { id: "desc" }, take: 1, select: { id: true } }))[0]?.id ?? null;
    const dry = await backfill.backfillFreeOutputs({ apply: false, after, maxBatches: 1, batchSize: 1, log: () => undefined });
    expect(dry.mode).toBe("DRY-RUN");
    expect(dry.factsWritten).toBe(3);
    expect(dry.beyondAllowance).toBe(2);
    expect(await prisma.evidence.count({ where: { id: { in: ids }, outputEarnedBasis: { not: null } } })).toBe(0);

    const applied = await backfill.backfillFreeOutputs({ apply: true, after, maxBatches: 1, batchSize: 1, log: () => undefined });
    expect(applied.factsWritten).toBe(3);
    expect(applied.deferredNotActive).toBe(1); // the trashed one waits for restoration
    const covered = await prisma.evidence.findMany({
      where: { id: { in: ids }, outputEarnedBasis: "FREE_ALLOWANCE" },
      select: { id: true },
    });
    expect(covered.map((r) => r.id).sort()).toEqual(ids.slice(0, 3).sort());

    const replay = await backfill.backfillFreeOutputs({ apply: true, after, maxBatches: 1, batchSize: 1, log: () => undefined });
    expect(replay.factsWritten).toBe(0);
    expect(replay.alreadyCovered).toBe(3);
  }, 240_000);
});
