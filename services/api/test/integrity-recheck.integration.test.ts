/**
 * ET-SM-07 — integrity rechecking is a commitment for EVERY signed record.
 * Live PostgreSQL 16; the worker's real recheck authority; a versioned object
 * store stood in by an in-memory one (the rule under test is what is read and
 * what is recorded — not the S3 client).
 *
 * On a40ca76f the stored bytes were re-hashed only inside report generation.
 * A record that never received a report — every FREE record — was never
 * re-verified: `rejectEvidenceIntegrity` had exactly two callers, both inside
 * prepareReportArtifacts, and the "worker.reconciler" source had none.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
// ET-PKG-07 — a record's id is not a public link: requests go through a share
// link (the record is published and the link minted on first use).
import { shareLinkFor } from "./helpers/verify-share.js";
import { seedPersonalTenant, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";

type Recheck = typeof import("../../worker/src/integrity-recheck.js");
type Reader = import("../../worker/src/integrity-recheck.js").IntegrityObjectReader;

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const DAY = 24 * 3600_000;

/** A versioned bucket: key -> versionId -> bytes, plus the "latest" pointer. */
class VersionedStore {
  objects = new Map<string, Map<string, Buffer>>();
  latest = new Map<string, string>();
  down = false;
  reads: Array<{ key: string; versionId: string | null }> = [];
  put(key: string, bytes: Buffer): string {
    const versionId = `v-${randomUUID().slice(0, 12)}`;
    if (!this.objects.has(key)) this.objects.set(key, new Map());
    this.objects.get(key)!.set(versionId, bytes);
    this.latest.set(key, versionId);
    return versionId;
  }
  private resolve(o: { key: string; versionId: string | null }): Buffer {
    this.reads.push({ key: o.key, versionId: o.versionId });
    if (this.down) throw Object.assign(new Error("SlowDown"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
    const versions = this.objects.get(o.key);
    const id = o.versionId ?? this.latest.get(o.key) ?? null;
    const bytes = id ? versions?.get(id) : undefined;
    if (!bytes) throw Object.assign(new Error("NoSuchVersion"), { name: "NoSuchVersion", $metadata: { httpStatusCode: 404 } });
    return bytes;
  }
  reader: Reader = {
    head: async (o) => ({ sizeBytes: this.resolve(o).length }),
    stream: async (o) => Readable.from([this.resolve(o)]),
  };
}

describe("integrity recheck — every signed record, recorded and honest (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let recheck: Recheck;
  let store: VersionedStore;
  let readState: (typeof import("@proovra/shared-runtime"))["readStoredBytesIntegrity"];
  let sweepHealth: (typeof import("@proovra/shared-runtime"))["readScheduledSweepHealth"];
  const keyId = `sm07-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    recheck = await import("../../worker/src/integrity-recheck.js");
    ({ readStoredBytesIntegrity: readState, readScheduledSweepHealth: sweepHealth } = await import("@proovra/shared-runtime"));
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `sm07-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
  }, 180_000);

  beforeEach(() => {
    store = new VersionedStore();
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  /** A signed single-object record whose bytes are in the store at a recorded version. */
  async function signedRecord(t: PersonalTenant, over: Record<string, unknown> = {}) {
    const bytes = Buffer.from(`original-${randomUUID()}`);
    const key = `evidence/${randomUUID()}/original.bin`;
    const versionId = store.put(key, bytes);
    const fileSha256 = sha(bytes);
    const row = await prisma.evidence.create({
      data: {
        title: "SM-07 fixture",
        type: "PHOTO",
        status: "SIGNED",
        teamId: t.personalTeamId,
        organizationId: t.personalOrganizationId,
        ownerUserId: t.owner.userId,
        storageBucket: "sm07-bucket",
        storageKey: key,
        storageVersionId: versionId,
        fileSha256,
        signedAtUtc: new Date(),
        ...over,
      } as never,
      select: { id: true },
    });
    return { id: row.id, key, versionId, bytes, fileSha256 };
  }
  const row = (id: string) => prisma.evidence.findUniqueOrThrow({ where: { id } });
  const checks = (id: string) =>
    prisma.evidenceIntegrityCheck.findMany({ where: { evidenceId: id }, orderBy: { checkedAtUtc: "asc" } });
  const sweep = (t: PersonalTenant, over: Partial<Parameters<Recheck["runIntegrityRecheckSweep"]>[0]> = {}) =>
    recheck.runIntegrityRecheckSweep({ teamId: t.personalTeamId, reader: store.reader, trigger: "test", ...over });

  it("a signed FREE record with no report is rechecked by the sweep and recorded in full", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const ev = await signedRecord(t);
    expect(await prisma.report.count({ where: { evidenceId: ev.id } })).toBe(0);
    expect(readState(await row(ev.id)).state).toBe("unknown");

    const run = await sweep(t);
    expect(run).toMatchObject({ status: "SUCCEEDED", scanned: 1, verified: 1, failed: 0 });

    const [check] = await checks(ev.id);
    expect(check).toMatchObject({
      evidenceId: ev.id,
      teamId: t.personalTeamId,
      storageVersionId: ev.versionId,
      expectedDigest: ev.fileSha256,
      checkedDigest: ev.fileSha256,
      outcome: "VERIFIED",
      failureCode: null,
      trigger: "SCHEDULED",
      checkerVersion: "proovra-integrity-recheck/1",
      correlationId: `integrity-recheck:${run.runId}`,
    });
    expect(check!.checkedObjects).toEqual([{ partIndex: null, versionId: ev.versionId, sha256: ev.fileSha256 }]);
    expect(check!.checkedAtUtc).toBeInstanceOf(Date);
    const after = await row(ev.id);
    expect(readState(after).state).toBe("verified_current");
    expect(after.integrityRecheckClaimedAtUtc).toBeNull();
    // Not due again until the cadence passes: the next sweep finds nothing.
    expect(await sweep(t)).toMatchObject({ scanned: 0 });
  });

  it("changed bytes at the signed version: FAILED_HASH_MISMATCH, one custody event, state failed", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const ev = await signedRecord(t);
    store.objects.get(ev.key)!.set(ev.versionId, Buffer.from("tampered"));

    expect(await sweep(t)).toMatchObject({ scanned: 1, verified: 0, failed: 1 });
    const after = await row(ev.id);
    expect(after.status).toBe("FAILED_HASH_MISMATCH");
    expect(readState(after)).toMatchObject({ state: "failed", failureCode: "DIGEST_MISMATCH" });
    const [check] = await checks(ev.id);
    expect(check).toMatchObject({ outcome: "FAILED", failureCode: "DIGEST_MISMATCH", checkedDigest: sha("tampered") });
    expect(
      await prisma.custodyEvent.count({ where: { evidenceId: ev.id, eventType: "INTEGRITY_REJECTED_HASH_MISMATCH" } }),
    ).toBe(1);
    // Terminal: it leaves the recheck population.
    expect(await sweep(t)).toMatchObject({ scanned: 0 });
  });

  it("a NEWER version at the same key does not matter: the signed VersionId is what is read, and it verifies", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const ev = await signedRecord(t);
    store.put(ev.key, Buffer.from("someone overwrote the key")); // latest now differs

    expect(await sweep(t)).toMatchObject({ verified: 1, failed: 0 });
    expect(store.reads.every((r) => r.versionId === ev.versionId)).toBe(true);
    expect((await row(ev.id)).status).toBe("SIGNED");
    expect(readState(await row(ev.id)).state).toBe("verified_current");
  });

  it("a missing object version: failed (OBJECT_VERSION_MISSING), NOT a hash mismatch, and rechecked again later", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const ev = await signedRecord(t);
    store.objects.get(ev.key)!.delete(ev.versionId);

    expect(await sweep(t)).toMatchObject({ failed: 1 });
    const after = await row(ev.id);
    expect(after.status).toBe("SIGNED");
    expect(readState(after)).toMatchObject({ state: "failed", failureCode: "OBJECT_VERSION_MISSING" });
    expect(await prisma.custodyEvent.count({ where: { evidenceId: ev.id, eventType: "INTEGRITY_REJECTED_HASH_MISMATCH" } })).toBe(0);

    // The version is restored; an on-demand request brings it back to verified.
    store.objects.get(ev.key)!.set(ev.versionId, ev.bytes);
    const { requestIntegrityRecheck } = await import("@proovra/shared-runtime");
    expect(await requestIntegrityRecheck(prisma, ev.id)).toBe(true);
    expect(await sweep(t)).toMatchObject({ verified: 1 });
    expect(readState(await row(ev.id)).state).toBe("verified_current");
  });

  it("a temporary storage failure is UNAVAILABLE: nothing is claimed about the bytes, and it is retried after the lease", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const ev = await signedRecord(t);
    store.down = true;
    const t0 = new Date();
    expect(await sweep(t, { now: t0 })).toMatchObject({ status: "PARTIAL", unavailable: 1, verified: 0, failed: 0 });
    const held = await row(ev.id);
    expect(held.status).toBe("SIGNED");
    expect(held.integrityCheckedAtUtc).toBeNull();
    expect(held.integrityCheckOutcome).toBe("UNAVAILABLE");
    expect(readState(held).state).toBe("unknown");
    // The lease is the backoff: the very next tick does not re-read it.
    store.down = false;
    expect(await sweep(t, { now: new Date(t0.getTime() + 60_000) })).toMatchObject({ scanned: 0 });
    // After the lease it is retried, and verifies.
    expect(await sweep(t, { now: new Date(t0.getTime() + 31 * 60_000) })).toMatchObject({ verified: 1 });
    expect((await checks(ev.id)).map((c) => c.outcome)).toEqual(["UNAVAILABLE", "VERIFIED"]);
  });

  it("duplicate jobs for one record: exactly one reads it, one history row", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const ev = await signedRecord(t);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        recheck.recheckEvidenceIntegrity({ evidenceId: ev.id, trigger: "SCHEDULED", correlationId: `dup-${i}`, reader: store.reader }),
      ),
    );
    expect(results.filter((r) => r.checked)).toHaveLength(1);
    expect(results.filter((r) => !r.checked)).toHaveLength(5);
    expect(await checks(ev.id)).toHaveLength(1);
  });

  it("destroyed and pending-destruction records are never read; a trashed record is rechecked where it is", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const destroyed = await signedRecord(t, { lifecycleState: "DESTROYED", deletedAt: new Date() });
    const pending = await signedRecord(t, { lifecycleState: "PENDING_DESTRUCTION", deletedAt: new Date() });
    const trashed = await signedRecord(t, { lifecycleState: "TRASHED", deletedAt: new Date() });

    expect(await sweep(t)).toMatchObject({ scanned: 1, verified: 1 });
    for (const out of [destroyed, pending]) {
      expect(await checks(out.id)).toHaveLength(0);
      expect(
        await recheck.recheckEvidenceIntegrity({ evidenceId: out.id, trigger: "RECOVERY", force: true, reader: store.reader }),
      ).toEqual({ checked: false, reason: "NOT_ELIGIBLE_OR_HELD" });
    }
    expect(store.reads.map((r) => r.key)).toEqual([trashed.key, trashed.key]);
    const t1 = await row(trashed.id);
    expect(t1.lifecycleState).toBe("TRASHED");
    expect(t1.deletedAt).not.toBeNull();
    expect(readState(t1).state).toBe("verified_current");

    // …and a trashed record whose bytes drifted is rejected WHERE IT IS.
    const drifted = await signedRecord(t, { lifecycleState: "TRASHED", deletedAt: new Date() });
    store.objects.get(drifted.key)!.set(drifted.versionId, Buffer.from("drift"));
    expect(await sweep(t)).toMatchObject({ failed: 1 });
    expect(await row(drifted.id)).toMatchObject({ status: "FAILED_HASH_MISMATCH", lifecycleState: "TRASHED" });
  });

  it("a report-time observation and a concurrent recheck both record; a double mismatch rejects once", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const ok = await signedRecord(t);
    const verified = {
      outcome: "VERIFIED" as const,
      failureCode: null,
      checkedDigest: ok.fileSha256,
      storageVersionId: ok.versionId,
      checkedObjects: [{ partIndex: null, versionId: ok.versionId, sha256: ok.fileSha256 }],
    };
    const [fromReport, fromRecheck] = await Promise.all([
      recheck.recordIntegrityObservation({
        evidenceId: ok.id,
        teamId: t.personalTeamId,
        expectedDigest: ok.fileSha256,
        observation: verified,
        trigger: "REPORT_ISSUANCE",
        correlationId: "job-1",
      }),
      recheck.recheckEvidenceIntegrity({ evidenceId: ok.id, trigger: "SCHEDULED", reader: store.reader }),
    ]);
    expect(fromReport.rejected).toBe(false);
    expect(fromRecheck).toMatchObject({ checked: true, outcome: "VERIFIED" });
    expect((await checks(ok.id)).map((c) => c.trigger).sort()).toEqual(["REPORT_ISSUANCE", "SCHEDULED"]);
    expect(await row(ok.id)).toMatchObject({ status: "SIGNED", integrityRecheckClaimedAtUtc: null });
    expect(readState(await row(ok.id)).state).toBe("verified_current");

    const bad = await signedRecord(t);
    store.objects.get(bad.key)!.set(bad.versionId, Buffer.from("drift"));
    const mismatch = {
      outcome: "FAILED" as const,
      failureCode: "DIGEST_MISMATCH" as const,
      checkedDigest: sha("drift"),
      storageVersionId: bad.versionId,
      checkedObjects: [{ partIndex: null, versionId: bad.versionId, sha256: sha("drift") }],
    };
    await Promise.all([
      recheck.recordIntegrityObservation({
        evidenceId: bad.id,
        teamId: t.personalTeamId,
        expectedDigest: bad.fileSha256,
        observation: mismatch,
        trigger: "REPORT_ISSUANCE",
        rejectionSource: "worker.report.single_file",
      }),
      recheck.recheckEvidenceIntegrity({ evidenceId: bad.id, trigger: "SCHEDULED", reader: store.reader }),
    ]);
    expect((await row(bad.id)).status).toBe("FAILED_HASH_MISMATCH");
    expect(
      await prisma.custodyEvent.count({ where: { evidenceId: bad.id, eventType: "INTEGRITY_REJECTED_HASH_MISMATCH" } }),
    ).toBe(1);
  });

  it("the sweep pages a large population in bounded slices: requests first, then never-checked, then oldest", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const now = new Date();
    const stale = await signedRecord(t, {
      integrityCheckedAtUtc: new Date(now.getTime() - 40 * DAY),
      integrityVerifiedAtUtc: new Date(now.getTime() - 40 * DAY),
      integrityCheckOutcome: "VERIFIED",
    });
    const fresh = await signedRecord(t, {
      integrityCheckedAtUtc: new Date(now.getTime() - 2 * DAY),
      integrityVerifiedAtUtc: new Date(now.getTime() - 2 * DAY),
      integrityCheckOutcome: "VERIFIED",
    });
    const never = [] as string[];
    for (let i = 0; i < 7; i++) never.push((await signedRecord(t)).id);
    const requested = await signedRecord(t, {
      integrityCheckedAtUtc: new Date(now.getTime() - 1 * DAY),
      integrityVerifiedAtUtc: new Date(now.getTime() - 1 * DAY),
      integrityCheckOutcome: "VERIFIED",
      integrityRecheckRequestedAtUtc: now,
    });

    const first = await sweep(t, { limit: 4 });
    expect(first).toMatchObject({ scanned: 4, verified: 4 });
    // The on-demand request was served in the first slice.
    expect((await row(requested.id)).integrityRecheckRequestedAtUtc).toBeNull();
    expect((await checks(requested.id)).length).toBe(1);
    expect(await sweep(t, { limit: 4 })).toMatchObject({ scanned: 4 });
    expect(await sweep(t, { limit: 4 })).toMatchObject({ scanned: 1 });
    expect(await sweep(t, { limit: 4 })).toMatchObject({ scanned: 0 });

    for (const id of [...never, stale.id, requested.id]) expect(await checks(id)).toHaveLength(1);
    // Inside the cadence and not requested: never read.
    expect(await checks(fresh.id)).toHaveLength(0);
    // Every history row carries its own record's workspace.
    const rows = await prisma.evidenceIntegrityCheck.findMany({ where: { teamId: t.personalTeamId } });
    expect(rows.length).toBeGreaterThanOrEqual(9);
  });

  it("the global sweep leaves a run row, and its health is read from outside the worker", async () => {
    const run = await recheck.runIntegrityRecheckSweep({ reader: store.reader, trigger: "test", limit: 1 });
    expect(["SUCCEEDED", "PARTIAL", "RUNNING"]).toContain(run.status);
    const health = await sweepHealth(prisma, "INTEGRITY_RECHECK");
    expect(health.lastRunAtUtc).toBeInstanceOf(Date);
    expect(health.lastSuccessAtUtc).toBeInstanceOf(Date);
    expect(["OK", "FAILING"]).toContain(health.state);
  });

  describe("Public Verify never presents a stale or unknown recheck as current", () => {
    /** A signed, publicly verifiable record with the given recheck facts. */
    async function verifiable(t: PersonalTenant, over: Record<string, unknown>) {
      const ev = await signedRecord(t, over);
      const canonical = JSON.stringify({ v: 1, evidenceId: ev.id, sha256: ev.fileSha256 });
      const fingerprintHash = sha(canonical);
      await prisma.evidence.update({
        where: { id: ev.id },
        data: {
          fingerprintCanonicalJson: canonical,
          fingerprintHash,
          signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
          signingKeyId: keyId,
          signingKeyVersion: 1,
        } as never,
      });
      return ev;
    }
    const verify = async (id: string, ip: string) => {
      const res = await h.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, id)}`, remoteAddress: ip });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().basicVerification.storedBytes as { state: string; lastVerifiedAtUtc: string | null };
    };

    it("stale: says so with the date, and asks for a recheck", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const at = new Date(Date.now() - 45 * DAY);
      const ev = await verifiable(t, {
        integrityCheckedAtUtc: at,
        integrityVerifiedAtUtc: at,
        integrityCheckOutcome: "VERIFIED",
      });
      const shown = await verify(ev.id, "81.2.69.171");
      expect(shown.state).toBe("verified_stale");
      expect(shown.lastVerifiedAtUtc).toBe(at.toISOString());
      expect((await row(ev.id)).integrityRecheckRequestedAtUtc).not.toBeNull();
      // The requested recheck runs, and the page may then say current.
      expect(await sweep(t)).toMatchObject({ verified: 1 });
      expect((await verify(ev.id, "81.2.69.172")).state).toBe("verified_current");
    });

    it("never checked: pending once requested — never verified", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const ev = await verifiable(t, {});
      expect((await verify(ev.id, "81.2.69.173")).state).toBe("pending");
      expect((await row(ev.id)).integrityRecheckRequestedAtUtc).not.toBeNull();
    });

    it("a failed recheck is shown as failed", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const ev = await verifiable(t, {});
      store.objects.get(ev.key)!.delete(ev.versionId);
      await sweep(t);
      expect((await verify(ev.id, "81.2.69.174")).state).toBe("failed");
    });
  });
});
