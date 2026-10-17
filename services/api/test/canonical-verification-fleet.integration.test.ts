/**
 * CANONICAL VERIFICATION FOR THE PRE-CANONICAL FLEET (Postgres + Redis + MinIO).
 *
 * Production (2026-10-17): 166 eligible records, ZERO canonical `pvr_`
 * references — every record finalized before the canonical identity existed
 * kept none, because references were only minted when a NEW report rendered
 * and the owner-run backfill never ran (and would have issued to deleted and
 * archived records). Historical reports printed record-id links (407) and five
 * `pvs_` links whose token rows were never stored.
 *
 * Every case here STARTS from that shape — signed, historically PUBLISHED,
 * inside the record-id grace, no reference — never from a fresh record:
 *   - the shared eligibility rule and its refusals, on every plan;
 *   - the corrected backfill: dry run, apply, re-run, two concurrent runs;
 *   - record-id links resolving THROUGH the canonical identity;
 *   - the public route's security matrix (uniform failures, no private data);
 *   - bounded recovery of an orphaned `pvs_` printed in a real stored PDF.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const REF_SHAPE = /^pvr_[A-Za-z0-9_-]{27}$/;
const PLANS = ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"] as const;

describe("canonical verification for the pre-canonical fleet", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");
  let backfill: typeof import("../src/scripts/three-decisions-backfill.js");
  let recovery: typeof import("../../worker/src/verification-link-recovery.js");
  let workerStorage: typeof import("../../worker/src/storage.js");
  let clearRates: () => Promise<unknown>;
  const keyId = `fleet-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const teamByPlan = new Map<string, string>();

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    backfill = await import("../src/scripts/three-decisions-backfill.js");
    recovery = await import("../../worker/src/verification-link-recovery.js");
    workerStorage = await import("../../worker/src/storage.js");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true, ownerUserId: true } });
    for (const plan of PLANS) {
      const t = await prisma.team.create({
        data: {
          name: `fleet-${plan.toLowerCase()}-${randomUUID().slice(0, 6)}`,
          ownerUserId: team.ownerUserId,
          organizationId: team.organizationId!,
          workspaceKind: "ORGANIZATION",
          isPersonal: false,
          billingPlan: plan,
          billingStatus: plan === "FREE" ? "INACTIVE" : "ACTIVE",
        } as never,
      });
      teamByPlan.set(plan, t.id);
    }
  }, 600_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 120_000);

  const publicVerify = (segment: string) =>
    h.app.inject({
      method: "GET",
      url: `/public/verify/${encodeURIComponent(segment)}`,
      remoteAddress: `198.51.100.${1 + Math.floor(Math.random() * 250)}`,
    });

  /** A record exactly as Production holds it: signed, historically PUBLISHED, record-id grace, no reference. */
  async function legacyRecord(plan: (typeof PLANS)[number], data: Record<string, unknown> = {}): Promise<string> {
    const teamId = teamByPlan.get(plan)!;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: `Pre-canonical ${plan}`,
        type: "DOCUMENT",
        status: "REPORTED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
        publicVerifyState: "PUBLISHED",
        legacyVerifyUuidUntilUtc: new Date(Date.now() + 90 * 86_400_000),
        ...data,
      } as never,
      select: { id: true },
    });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
    const fingerprintHash = createHash("sha256").update(canonical).digest("hex");
    await prisma.evidence.update({
      where: { id: row.id },
      data: {
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
        signingKeyId: keyId,
        signingKeyVersion: 1,
        signedAtUtc: new Date(Date.now() - 40 * 86_400_000),
      } as never,
    });
    return row.id;
  }

  const refOf = async (id: string) =>
    (await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { verificationRef: true } })).verificationRef;

  it("ELIGIBILITY: one shared rule — finalized, active, intact; publication never decides it", () => {
    const e = runtime.resolveCanonicalVerificationEligibility;
    const base = { status: "REPORTED", lifecycleState: "ACTIVE", deletedAt: null, destroyedAtUtc: null, integrityCheckOutcome: "VERIFIED" };
    expect(e(base)).toEqual({ eligible: true });
    expect(e({ ...base, status: "SIGNED" })).toEqual({ eligible: true });
    expect(e({ ...base, integrityCheckOutcome: "UNAVAILABLE" })).toEqual({ eligible: true });
    expect(e({ ...base, status: "UPLOADED" })).toEqual({ eligible: false, reason: "NOT_FINALIZED" });
    expect(e({ ...base, deletedAt: new Date() })).toEqual({ eligible: false, reason: "DELETED" });
    expect(e({ ...base, lifecycleState: "DESTROYED" })).toEqual({ eligible: false, reason: "DESTROYED" });
    expect(e({ ...base, destroyedAtUtc: new Date() })).toEqual({ eligible: false, reason: "DESTROYED" });
    for (const l of ["ARCHIVED", "TRASHED", "RETENTION_ARCHIVED", "PENDING_DESTRUCTION"]) {
      expect(e({ ...base, lifecycleState: l })).toEqual({ eligible: false, reason: "ARCHIVED" });
    }
    expect(e({ ...base, status: "FAILED_HASH_MISMATCH" })).toEqual({ eligible: false, reason: "INTEGRITY_FAILED" });
    expect(e({ ...base, integrityCheckOutcome: "FAILED" })).toEqual({ eligible: false, reason: "INTEGRITY_FAILED" });
    expect(e(null)).toEqual({ eligible: false, reason: "NOT_FOUND" });
  });

  it("BACKFILL: dry run counts exactly, writes nothing; apply issues ONE reference per eligible record on every plan; re-run issues nothing", async () => {
    // Refusal counts are asserted EXACTLY, as the delta over the database
    // this file starts from (the harness seeds records of its own).
    const base = await backfill.backfillVerificationReferences({});
    const eligible: string[] = [];
    for (const plan of PLANS) eligible.push(await legacyRecord(plan));
    const refused = {
      notFinalized: await legacyRecord("FREE", { status: "UPLOADED" }),
      deleted: await legacyRecord("PRO", { deletedAt: new Date() }),
      destroyed: await legacyRecord("TEAM", { lifecycleState: "DESTROYED", destroyedAtUtc: new Date() }),
      archived: await legacyRecord("ENTERPRISE", { lifecycleState: "ARCHIVED" }),
      retained: await legacyRecord("PAYG", { lifecycleState: "RETENTION_ARCHIVED" }),
      integrity: await legacyRecord("FREE", { integrityCheckOutcome: "FAILED" }),
    };

    // The expected counts, computed independently of the tool.
    const all = await prisma.evidence.findMany({ select: { verificationRef: true, ...runtime.CANONICAL_VERIFICATION_ELIGIBILITY_SELECT } });
    const missingEligible = all.filter((r) => !r.verificationRef && runtime.resolveCanonicalVerificationEligibility(r).eligible).length;

    const dry = await backfill.backfillVerificationReferences({ batchSize: 3 });
    expect(dry.mode).toBe("DRY-RUN");
    expect(dry.scanned).toBe(all.length);
    expect(dry.eligible).toBe(missingEligible);
    expect(dry.issued).toBe(missingEligible);
    expect(dry.failed).toBe(0);
    expect(dry.scanned - base.scanned).toBe(PLANS.length + Object.keys(refused).length);
    expect(dry.refusedNotFinalized - base.refusedNotFinalized).toBe(1);
    expect(dry.refusedDeleted - base.refusedDeleted).toBe(1);
    expect(dry.refusedDestroyed - base.refusedDestroyed).toBe(1);
    expect(dry.refusedArchived - base.refusedArchived).toBe(2);
    expect(dry.refusedIntegrity - base.refusedIntegrity).toBe(1);
    expect(dry.skippedRowMoved).toBe(0);
    expect(dry.nextCursor).toBeNull();
    for (const id of eligible) expect(await refOf(id)).toBeNull();

    const applied = await backfill.backfillVerificationReferences({ apply: true, batchSize: 3 });
    expect(applied).toMatchObject({ mode: "APPLY", eligible: missingEligible, issued: missingEligible, failed: 0, skippedRowMoved: 0 });
    for (const id of eligible) {
      const ref = await refOf(id);
      expect(ref).toMatch(REF_SHAPE);
      const events = await prisma.custodyEvent.findMany({ where: { evidenceId: id, eventType: "VERIFICATION_REFERENCE_ISSUED" } });
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ verificationRef: ref, source: "BACKFILL" });
    }
    // Nothing was issued to an ineligible record.
    for (const id of Object.values(refused)) expect(await refOf(id)).toBeNull();

    const before = new Map(await Promise.all(eligible.map(async (id) => [id, await refOf(id)] as const)));
    const rerun = await backfill.backfillVerificationReferences({ apply: true });
    expect(rerun).toMatchObject({ eligible: 0, issued: 0, failed: 0 });
    for (const id of eligible) expect(await refOf(id)).toBe(before.get(id)); // never rotated
    const after = await backfill.backfillVerificationReferences({});
    expect(after).toMatchObject({ eligible: 0, issued: 0 });
  }, 300_000);

  it("BACKFILL CONCURRENCY: two simultaneous apply runs converge on ONE reference and ONE custody event per record", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await legacyRecord(PLANS[i % PLANS.length]!));
    const [a, b] = await Promise.all([
      backfill.backfillVerificationReferences({ apply: true, batchSize: 2 }),
      backfill.backfillVerificationReferences({ apply: true, batchSize: 3 }),
    ]);
    expect(a.failed + b.failed).toBe(0);
    expect(a.issued + b.issued).toBe(ids.length);
    for (const id of ids) {
      expect(await refOf(id)).toMatch(REF_SHAPE);
      expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "VERIFICATION_REFERENCE_ISSUED" } })).toBe(1);
    }
    const refs = await Promise.all(ids.map(refOf));
    expect(new Set(refs).size).toBe(ids.length);
  }, 300_000);

  it("BACKFILL RESUME + FAIL CLOSED: bounded batches resume from the cursor; a failing record stops the run with failed=1, a resumable cursor and exit code 4", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await legacyRecord(PLANS[i]!));
    const total = await prisma.evidence.count();

    // Bounded: one batch of 2, then resume from its cursor until done.
    let cursor: string | null = null;
    let scanned = 0;
    let issued = 0;
    let runs = 0;
    do {
      const part = await backfill.backfillVerificationReferences({ apply: true, batchSize: 2, maxBatches: 1, after: cursor });
      expect(part.failed).toBe(0);
      expect(part.scanned).toBeLessThanOrEqual(2);
      scanned += part.scanned;
      issued += part.issued;
      cursor = part.nextCursor;
      runs += 1;
    } while (cursor && runs < total + 2);
    expect(cursor).toBeNull();
    expect(scanned).toBe(total); // every row exactly once across the resumed runs
    expect(issued).toBe(ids.length);
    for (const id of ids) expect(await refOf(id)).toMatch(REF_SHAPE);

    // Fail closed: a record whose write fails stops the run at that record.
    // Pinned ids: one pending record before the failing one and one after it.
    const first = await legacyRecord("FREE", { id: "00000000-0000-4000-8000-000000000001" });
    const failing = await legacyRecord("PRO", { id: "80000000-0000-4000-8000-000000000000" });
    const last = await legacyRecord("TEAM", { id: "ffffffff-ffff-4fff-bfff-ffffffffffff" });
    const upToFailing = await prisma.evidence.count({ where: { id: { lte: failing } } });
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fleet_fail_ref() RETURNS trigger AS $f$
      BEGIN IF NEW.id = '${failing}'::uuid AND NEW.verification_ref IS NOT NULL THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fleet_fail_ref BEFORE UPDATE ON evidence FOR EACH ROW EXECUTE FUNCTION fleet_fail_ref()`);
    try {
      const failed = await backfill.backfillVerificationReferences({ apply: true });
      expect(failed).toMatchObject({ failed: 1, issued: 1 });
      // It stopped AT the failing record: nothing after it was touched…
      expect(failed.scanned).toBe(upToFailing);
      expect(await refOf(first)).toMatch(REF_SHAPE);
      expect(await refOf(failing)).toBeNull();
      expect(await refOf(last)).toBeNull();
      // …and the cursor is the record before it, so a resume retries it.
      expect(failed.nextCursor).not.toBeNull();
      expect(failed.nextCursor! < failing).toBe(true);
      // The CLI turns any failure into a nonzero exit.
      const argv = process.argv;
      process.argv = [argv[0]!, "three-decisions-backfill.ts", "verification-references", "--apply"];
      try {
        expect(await backfill.main()).toBe(4);
      } finally {
        process.argv = argv;
      }
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fleet_fail_ref ON evidence`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS fleet_fail_ref()`);
    }
    const resumed = await backfill.backfillVerificationReferences({ apply: true });
    expect(resumed).toMatchObject({ failed: 0, issued: 2 });
    expect(await refOf(failing)).toMatch(REF_SHAPE);
    expect(await refOf(last)).toMatch(REF_SHAPE);
  }, 300_000);

  it("RECORD-ID LINKS: inside the grace a record with its reference opens the CANONICAL page; before reconciliation the legacy page still works; outside the grace → uniform 404", async () => {
    // Before reconciliation: the historical behaviour keeps the printed link working.
    const pending = await legacyRecord("FREE");
    const beforeRef = await publicVerify(pending);
    expect(beforeRef.statusCode, beforeRef.body).toBe(200);

    // After reconciliation the record-id link resolves THROUGH the canonical identity.
    await prisma.$transaction((tx) => runtime.ensureVerificationRefTx(tx as never, pending, { source: "TEST" }));
    const ref = (await refOf(pending))!;
    // Publication never decides the canonical page.
    await prisma.evidence.update({ where: { id: pending }, data: { publicVerifyState: "NOT_PUBLISHED" } });
    const viaId = await publicVerify(pending);
    expect(viaId.statusCode, viaId.body).toBe(200);
    expect(viaId.json().tier).toBe("BASIC");
    expect(viaId.json().canonicalVerification).toMatchObject({ reference: ref, status: "AVAILABLE" });
    const viaRef = await publicVerify(ref);
    expect(viaRef.statusCode).toBe(200);
    expect(viaRef.json().canonicalVerification).toEqual(viaId.json().canonicalVerification);

    // Outside the grace the id is not a capability: byte-identical to an id that never existed.
    const expired = await legacyRecord("PRO", { legacyVerifyUuidUntilUtc: null });
    await prisma.$transaction((tx) => runtime.ensureVerificationRefTx(tx as never, expired, { source: "TEST" }));
    const noGrace = await publicVerify(expired);
    const unknown = await publicVerify(randomUUID());
    expect(noGrace.statusCode).toBe(404);
    expect(noGrace.body).toBe(unknown.body);
  }, 300_000);

  it("SECURITY MATRIX: canonical, tokens and lifecycle answer truthfully; failures are uniform; nothing private is served", async () => {
    const id = await legacyRecord("TEAM");
    await prisma.$transaction((tx) => runtime.ensureVerificationRefTx(tx as never, id, { source: "TEST" }));
    const ref = (await refOf(id))!;
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { teamId: true, ownerUserId: true, fileSha256: true } });

    const ok = await publicVerify(ref);
    expect(ok.statusCode).toBe(200);
    for (const forbidden of [id, row.ownerUserId, row.teamId!, "storageKey", "storageBucket", "X-Amz-Signature", "ownerUserId"]) {
      expect(ok.body, `the canonical page leaks ${forbidden}`).not.toContain(forbidden);
    }

    const mint = async (extra: Record<string, unknown>) => {
      const token = runtime.generateVerificationShareToken();
      await prisma.$transaction((tx) =>
        runtime.mintVerificationShareTokenTx(tx as never, { evidenceId: id, teamId: row.teamId, purpose: "REPORT", reportVersion: 1, token, now: new Date(), ...extra } as never),
      );
      return token;
    };
    const valid = await mint({});
    expect((await publicVerify(valid)).json().canonicalVerification).toMatchObject({ reference: ref });
    const revoked = await mint({});
    await prisma.verificationShareToken.updateMany({ where: { tokenHash: runtime.hashVerificationShareToken(revoked) }, data: { revokedAtUtc: new Date() } });
    expect((await publicVerify(revoked)).statusCode).toBe(410);
    const expiredToken = await mint({ expiresAtUtc: new Date(Date.now() - 1000) });
    expect((await publicVerify(expiredToken)).statusCode).toBe(410);

    const unknownRef = await publicVerify(`pvr_${"A".repeat(27)}`);
    const unknownToken = await publicVerify(`pvs_${"A".repeat(43)}`);
    const malformed = await publicVerify("not-a-valid-segment");
    expect([unknownRef.statusCode, unknownToken.statusCode, malformed.statusCode]).toEqual([404, 404, 404]);
    expect(new Set([unknownRef.body, unknownToken.body, malformed.body]).size).toBe(1);

    await prisma.evidence.update({ where: { id }, data: { verificationAccessState: "SUSPENDED" } });
    expect((await publicVerify(ref)).statusCode).toBe(503);
    await prisma.evidence.update({ where: { id }, data: { verificationAccessState: "WITHDRAWN" } });
    expect((await publicVerify(ref)).statusCode).toBe(410);
    await prisma.evidence.update({ where: { id }, data: { verificationAccessState: "AVAILABLE", lifecycleState: "RETENTION_ARCHIVED" } });
    const retained = await publicVerify(ref);
    expect(retained.statusCode).toBe(200);
    expect(retained.json().canonicalVerification).toMatchObject({ status: "RETAINED" });
    await prisma.evidence.update({ where: { id }, data: { lifecycleState: "ACTIVE", deletedAt: new Date() } });
    expect((await publicVerify(ref)).statusCode).toBe(404);
    await prisma.evidence.update({ where: { id }, data: { deletedAt: null, lifecycleState: "DESTROYED", destroyedAtUtc: new Date() } });
    const purged = await publicVerify(ref);
    expect(purged.statusCode).toBe(410);
    expect(purged.body).not.toContain(row.fileSha256!);
  }, 300_000);

  it("ORPHANED pvs_ RECOVERY: only from PROOVRA's own digest-matched stored PDF, exactly one token on the canonical host; idempotent; audited; never a guess", async () => {
    const workerRequire = createRequire(resolve(import.meta.dirname, "../../worker/package.json"));
    const PDFDocument = workerRequire("pdfkit") as new (opts?: unknown) => NodeJS.ReadableStream & {
      fontSize(n: number): unknown;
      text(t: string, opts?: unknown): unknown;
      end(): void;
    };
    /** A real PDF laid out like an October report: the URL wraps, and a link annotation carries it whole. */
    const pdfWith = async (urls: string[]): Promise<Buffer> => {
      const doc = new PDFDocument({ size: "A4", margin: 48 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      const done = new Promise<void>((r) => doc.on("end", () => r()));
      doc.fontSize(9);
      doc.text("PROOVRA Verification Report");
      for (const u of urls) doc.text(u, { link: u, width: 180 });
      doc.end();
      await done;
      return Buffer.concat(chunks);
    };
    const bucket = process.env.S3_BUCKET!;
    const store = async (evidenceId: string, version: number, bytes: Buffer, digest: string | null) => {
      const key = `reports/${evidenceId}/v${version}.pdf`;
      await workerStorage.putObjectBuffer({ bucket, key, body: bytes, contentType: "application/pdf" });
      await prisma.report.create({ data: { evidenceId, version, storageBucket: bucket, storageKey: key, generatedAtUtc: new Date(), pdfSha256: digest } as never });
    };
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const readObject = async (b: string, k: string) => {
      const body = (await workerStorage.getObjectStream({ bucket: b, key: k })) as AsyncIterable<Uint8Array>;
      const c: Buffer[] = [];
      for await (const x of body) c.push(Buffer.from(x));
      return Buffer.concat(c);
    };
    const base = "https://app.proovra.com/verify";
    const tok = () => runtime.generateVerificationShareToken();
    // The recovery scans EVERY report; a shared integration database holds
    // other suites' reports, so read failures are asserted as a delta.
    const baseline = await recovery.recoverOrphanedReportLinks({ prisma: prisma as never, readObject, verifyBaseUrl: base });

    // The orphan: three report versions printing the SAME unstored token (Reem's shape).
    const orphanId = await legacyRecord("FREE", { publicVerifyState: "NOT_PUBLISHED", legacyVerifyUuidUntilUtc: null });
    const orphanToken = tok();
    for (const v of [1, 2, 3]) {
      const pdf = await pdfWith([`${base}/${orphanToken}`]);
      await store(orphanId, v, pdf, sha(pdf));
    }
    // Refusals.
    const mismatchId = await legacyRecord("PRO");
    const mismatchPdf = await pdfWith([`${base}/${tok()}`]);
    await store(mismatchId, 1, mismatchPdf, "0".repeat(64));
    const wrongHostId = await legacyRecord("PRO");
    const wrongHostPdf = await pdfWith([`https://evil.example/verify/${tok()}`]);
    await store(wrongHostId, 1, wrongHostPdf, sha(wrongHostPdf));
    const ambiguousId = await legacyRecord("TEAM");
    const ambiguousPdf = await pdfWith([`${base}/${tok()}`, `${base}/${tok()}`]);
    await store(ambiguousId, 1, ambiguousPdf, sha(ambiguousPdf));
    const conflictId = await legacyRecord("TEAM");
    const conflictToken = tok();
    const otherId = await legacyRecord("ENTERPRISE");
    await prisma.$transaction((tx) =>
      runtime.mintVerificationShareTokenTx(tx as never, { evidenceId: otherId, teamId: null, purpose: "REPORT", reportVersion: 1, token: conflictToken, now: new Date() } as never),
    );
    const conflictPdf = await pdfWith([`${base}/${conflictToken}`]);
    await store(conflictId, 1, conflictPdf, sha(conflictPdf));
    // The same unstored token printed in two DIFFERENT records' reports: no
    // attribution is provable, so neither is recovered.
    const sharedToken = tok();
    for (const plan of ["FREE", "PRO"] as const) {
      const id = await legacyRecord(plan);
      const pdf = await pdfWith([`${base}/${sharedToken}`]);
      await store(id, 1, pdf, sha(pdf));
    }
    const ineligibleId = await legacyRecord("PAYG", { deletedAt: new Date() });
    const ineligiblePdf = await pdfWith([`${base}/${tok()}`]);
    await store(ineligibleId, 1, ineligiblePdf, sha(ineligiblePdf));
    const missingId = await legacyRecord("FREE");
    await prisma.report.create({ data: { evidenceId: missingId, version: 1, storageBucket: bucket, storageKey: `reports/${missingId}/absent.pdf`, generatedAtUtc: new Date(), pdfSha256: "1".repeat(64) } as never });

    expect((await publicVerify(orphanToken)).statusCode).toBe(404);

    const dry = await recovery.recoverOrphanedReportLinks({ prisma: prisma as never, readObject, verifyBaseUrl: base });
    expect(dry).toMatchObject({
      mode: "DRY-RUN",
      recoverable: 3, // three versions printing the one token: recovered once, the rest are then present
      recovered: 0,
      shaMismatch: 1,
      wrongHost: 1,
      ambiguous: 3, // one report with two tokens + two records sharing one token
      refusedConflict: 1,
      refusedIneligible: 1,
      failed: 0,
    });
    expect(dry.readFailed.MISSING_OBJECT - baseline.readFailed.MISSING_OBJECT).toBe(1);
    expect(JSON.stringify(dry)).not.toContain(orphanToken);
    expect(JSON.stringify(dry)).not.toContain(sharedToken);
    expect(recovery.redactVerificationTokens(`failed for ${orphanToken} at /verify/${sharedToken}`)).toBe(
      "failed for pvs_[redacted] at /verify/pvs_[redacted]",
    );
    expect(await prisma.verificationShareToken.count({ where: { evidenceId: orphanId } })).toBe(0);

    const applied = await recovery.recoverOrphanedReportLinks({ prisma: prisma as never, readObject, apply: true, verifyBaseUrl: base });
    expect(applied).toMatchObject({ mode: "APPLY", recovered: 1, alreadyPresent: 2, failed: 0 });
    expect(await prisma.verificationShareToken.count({ where: { tokenHash: runtime.hashVerificationShareToken(sharedToken) } })).toBe(0);
    const rows = await prisma.verificationShareToken.findMany({ where: { evidenceId: orphanId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "REPORT", reportVersion: 1, tokenHash: runtime.hashVerificationShareToken(orphanToken) });
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: "verification.report_link_recovered", resourceId: orphanId } });
    expect(JSON.stringify(audit)).not.toContain(orphanToken);
    expect(JSON.stringify(audit)).not.toContain(rows[0]!.tokenHash);

    // The link printed in the immutable report opens again — the record's canonical page.
    await prisma.$transaction((tx) => runtime.ensureVerificationRefTx(tx as never, orphanId, { source: "TEST" }));
    const reopened = await publicVerify(orphanToken);
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(reopened.json().canonicalVerification).toMatchObject({ reference: await refOf(orphanId), status: "AVAILABLE" });

    // Idempotent.
    const again = await recovery.recoverOrphanedReportLinks({ prisma: prisma as never, readObject, apply: true, verifyBaseUrl: base });
    expect(again).toMatchObject({ recovered: 0, recoverable: 0, alreadyPresent: 3, failed: 0 });
    // Nothing stored was rewritten.
    for (const v of [1, 2, 3]) {
      const r = await prisma.report.findFirstOrThrow({ where: { evidenceId: orphanId, version: v } });
      expect(sha(await readObject(r.storageBucket, r.storageKey))).toBe(r.pdfSha256);
    }
  }, 300_000);
});
