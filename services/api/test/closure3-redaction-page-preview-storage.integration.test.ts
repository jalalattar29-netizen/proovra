/**
 * closure3/store (FV2-RESIDUAL-4 / NEW-RG-33-1, DEC-04 / DEC-16) — A REDACTION
 * PAGE PREVIEW'S BYTES ARE ADMITTED, DECLARED BEFORE THE UPLOAD AND RESOLVED
 * ONLY BY PROOF. Live PostgreSQL 16 (all migrations) and a real S3
 * implementation (local MinIO, a bucket this suite creates with Object Lock,
 * hence versioning), the REAL worker processor, admission and reconciler.
 *
 * Before: the preview was admitted check-then-write and counted from READY
 * only, so concurrent renders overshot, and an upload whose READY write failed
 * (or whose answer was lost, or whose process died) left a locked object that
 * nothing counted; a retry added a second version of the same key.
 *
 * After every step: the bytes BOTH hosts' meters count above the baseline
 * equal the bytes the store holds under the tenant's preview prefix (or
 * exceed them only while a declared upload may still land), never less.
 */
import { createHash, randomUUID } from "node:crypto";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_NAMES, getWorkEntryOrThrow } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";

type PutParams = { bucket: string; key: string; body: Buffer; contentType: string; lock?: unknown; abortSignal?: AbortSignal };

const HOOK = vi.hoisted(() => ({
  /** Wraps the worker's REAL PutObject (fault injection); null = the real call. */
  put: null as null | ((p: PutParams, real: (p: PutParams) => Promise<unknown>) => Promise<unknown>),
  puts: 0,
  /** The record's artifact lock the processor applies (a GOVERNANCE horizon here). */
  lock: null as null | { mode: "GOVERNANCE" | "COMPLIANCE"; retainUntil: Date },
}));

vi.mock("../../worker/src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../worker/src/storage.js")>();
  return {
    ...actual,
    putObjectBuffer: async (p: PutParams) => {
      HOOK.puts += 1;
      const real = actual.putObjectBuffer as unknown as (p: PutParams) => Promise<unknown>;
      return HOOK.put ? HOOK.put(p, real) : real(p);
    },
  };
});
vi.mock("../../worker/src/object-retention.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../worker/src/object-retention.js")>();
  return { ...actual, artifactLockFor: async () => HOOK.lock };
});

const TAG = randomUUID().slice(0, 8);
const BUCKET = `c3-preview-${TAG}`;
const ENTRY = getWorkEntryOrThrow(JOB_NAMES.RENDER_REDACTION_PAGE_PREVIEW);

/** A well-formed PDF of `fills.length` A4 pages, each painted in one colour. */
function pdfOf(fills: ReadonlyArray<readonly [number, number, number]>): Buffer {
  const objects: string[] = [];
  const kids = fills.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${fills.length} >>`);
  fills.forEach(([r, g, b], i) => {
    const stream = `${r} ${g} ${b} rg 0 0 595 842 re f`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("closure3/store — redaction page-preview storage is admitted, declared and reconciled (live PostgreSQL 16 + MinIO Object Lock)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let s3: S3Client;
  let apiUsage: (typeof import("../src/services/workspace-usage.service.js"))["getWorkspaceUsage"];
  let apiScope: (typeof import("../src/services/billing-enforcement.service.js"))["resolveEnforcementScopeForRequester"];
  let workerBilling: typeof import("../../worker/src/workspace-billing.js");
  let processor: typeof import("../../worker/src/redaction/redaction-page-preview.processor.js");
  let storage: typeof import("../../worker/src/redaction/redaction-page-preview-storage.js");
  let intentStore: typeof import("../../worker/src/derived-storage-intent.js");
  let workerPrisma: (typeof import("../../worker/src/db.js"))["prisma"];
  let workerStorage: typeof import("../../worker/src/storage.js");
  let writer: typeof import("../../worker/src/redaction/redaction-page-preview-writer.js");
  let lease: number;
  let grace: number;
  // Identical pages: every page renders to a PNG of the same size.
  const PDF = pdfOf([
    [1, 0, 0],
    [1, 0, 0],
    [1, 0, 0],
  ]);
  let pngBytes: number;
  let pngWidth: number;
  let pngHeight: number;
  const savedLockEnv = process.env.S3_OBJECT_LOCK_ENABLED;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    const { signJwt } = await import("../src/services/jwt.js");
    ({ getWorkspaceUsage: apiUsage } = await import("../src/services/workspace-usage.service.js"));
    ({ resolveEnforcementScopeForRequester: apiScope } = await import("../src/services/billing-enforcement.service.js"));
    workerBilling = await import("../../worker/src/workspace-billing.js");
    processor = await import("../../worker/src/redaction/redaction-page-preview.processor.js");
    storage = await import("../../worker/src/redaction/redaction-page-preview-storage.js");
    intentStore = await import("../../worker/src/derived-storage-intent.js");
    ({ prisma: workerPrisma } = await import("../../worker/src/db.js"));
    ({ s3 } = await import("../../worker/src/storage.js"));
    writer = await import("../../worker/src/redaction/redaction-page-preview-writer.js");
    workerStorage = await import("../../worker/src/storage.js");
    lease = writer.REDACTION_PAGE_PREVIEW_LEASE_MS;
    grace = storage.PAGE_PREVIEW_POINTER_RECONCILE_GRACE_MS;
    deps = {
      prisma: prisma as never,
      tag: `c3pv-${TAG}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    // An Object-Lock bucket (versioned), and the worker applies the record's lock.
    process.env.S3_OBJECT_LOCK_ENABLED = "true";
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET, ObjectLockEnabledForBucket: true }));
    const rendered = await processor.renderPdfPagePreview(PDF, 0);
    if (!rendered.ok) throw new Error("render failed");
    pngBytes = rendered.png.length;
    pngWidth = rendered.width;
    pngHeight = rendered.height;
  }, 600_000);

  // The shared setup re-asserts the safe test environment (Object Lock off)
  // before every test: this suite runs with the worker applying locks.
  beforeEach(() => {
    process.env.S3_OBJECT_LOCK_ENABLED = "true";
  });

  afterAll(async () => {
    if (savedLockEnv === undefined) delete process.env.S3_OBJECT_LOCK_ENABLED;
    else process.env.S3_OBJECT_LOCK_ENABLED = savedLockEnv;
    // Test bucket only (never customer evidence): every version, governance bypassed.
    const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET })).catch(() => null);
    for (const v of [...(listed?.Versions ?? []), ...(listed?.DeleteMarkers ?? [])]) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: BUCKET, Key: v.Key!, VersionId: v.VersionId, BypassGovernanceRetention: true }))
        .catch(() => undefined);
    }
    await s3.send(new DeleteBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
    await h?.cleanup();
  });

  // -------------------------------------------------------------------------
  async function bothHosts(t: PersonalTenant) {
    const api = await apiUsage(await apiScope({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }));
    const wk = await workerBilling.getWorkspaceUsage(
      await workerBilling.resolveWorkspaceScopeForEvidence({ ownerUserId: t.owner.userId, teamId: t.personalTeamId }),
    );
    expect(wk.storageBytesUsed, "worker = API (storageBytesUsed)").toBe(api.storageBytesUsed);
    expect(wk.reservedStorageBytes, "worker = API (reservedStorageBytes)").toBe(api.reservedStorageBytes);
    return api;
  }

  /** A tenant whose workspace has exactly `room` bytes left, and a PDF record. */
  async function tenantWithRoom(room: bigint) {
    const t = await seedPersonalTenant(deps, "FREE");
    const sourceKey = `c3pv/${TAG}/${randomUUID()}.pdf`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: sourceKey, Body: PDF, ContentType: "application/pdf" }));
    const ev = await prisma.evidence.create({
      data: {
        title: "closure3 preview",
        type: "DOCUMENT",
        status: "SIGNED",
        mimeType: "application/pdf",
        teamId: t.personalTeamId,
        organizationId: t.personalOrganizationId,
        ownerUserId: t.owner.userId,
        storageBucket: BUCKET,
        storageKey: sourceKey,
        fileSha256: createHash("sha256").update(PDF).digest("hex"),
        sizeBytes: BigInt(PDF.length),
      } as never,
      select: { id: true },
    });
    const u = await bothHosts(t);
    const filler = u.storageBytesLimit - u.storageBytesUsed - room;
    await prisma.evidence.create({
      data: {
        title: "closure3 filler",
        type: "PHOTO",
        status: "SIGNED",
        teamId: t.personalTeamId,
        organizationId: t.personalOrganizationId,
        ownerUserId: t.owner.userId,
        storageBucket: BUCKET,
        storageKey: `c3pv/${TAG}/${randomUUID()}.filler`,
        sizeBytes: filler,
      } as never,
    });
    const baseline = (await bothHosts(t)).storageBytesUsed;
    expect(u.storageBytesLimit - baseline).toBe(room);
    return { t, evidenceId: ev.id, baseline };
  }

  const projects = new Map<string, string>();
  async function previewOf(t: PersonalTenant, evidenceId: string, pageIndex = 0) {
    let projectId = projects.get(evidenceId);
    if (!projectId) {
      projectId = (
        await prisma.redactionProject.create({
          data: { teamId: t.personalTeamId, evidenceId, artifactKind: "PDF", createdByUserId: t.owner.userId } as never,
          select: { id: true },
        })
      ).id;
      projects.set(evidenceId, projectId);
    }
    const project = { id: projectId };
    return prisma.redactionPagePreview.create({
      data: { teamId: t.personalTeamId, projectId: project.id, evidenceId, pageIndex, state: "QUEUED" },
      select: { id: true, projectId: true },
    });
  }

  const job = (previewId: string) =>
    ({
      id: `c3pv-${previewId}`,
      name: ENTRY.workName,
      attemptsMade: 0,
      data: { commandId: previewId, traceId: "t", schemaVersion: ENTRY.schemaVersion },
    }) as never;
  const run = (previewId: string) => processor.processRedactionPagePreviewJob(job(previewId));
  const row = (id: string) => prisma.redactionPagePreview.findUniqueOrThrow({ where: { id } });

  /** Every data version the store holds under this tenant's preview prefix. */
  async function storedVersions(t: PersonalTenant) {
    const res = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: `redactions/${t.personalTeamId}/` }));
    return res.Versions ?? [];
  }
  async function storedBytes(t: PersonalTenant): Promise<bigint> {
    return (await storedVersions(t)).reduce((n, v) => n + BigInt(v.Size ?? 0), 0n);
  }

  /** THE INVARIANT at rest: accounting above the baseline equals the bytes stored. */
  async function accountingEqualsStored(t: PersonalTenant, baseline: bigint) {
    const u = await bothHosts(t);
    expect(u.reservedStorageBytes, "previews hold no separate reservation").toBe(0n);
    expect(u.storageBytesUsed - baseline, "accounting = bytes actually stored").toBe(await storedBytes(t));
  }

  /** The holder's window is over: lease + grace since the row last changed / was stamped. */
  async function closeWindow(id: string) {
    const secs = (lease + grace + 1_000) / 1000;
    await prisma.$executeRaw`
      UPDATE "redaction_page_previews"
         SET "updated_at" = NOW() - make_interval(secs => ${secs}::double precision),
             "render_started_at" = CASE WHEN "render_started_at" IS NULL THEN NULL
                                        ELSE NOW() - make_interval(secs => ${secs}::double precision) END
       WHERE "id" = ${id}::uuid`;
  }
  /**
   * The reconciler is database-wide (other suites may share the database): a
   * tick is judged by what it did to THIS test's rows only. A row it judged
   * and KEPT has its size rewritten, which moves `updatedAt` to now.
   */
  const judgedRecently = async (id: string) => Date.now() - (await row(id)).updatedAt.getTime() < 60_000;
  const sweep = async () =>
    storage.reconcilePagePreviewStoragePointers({ store: intentStore.s3DerivedObjectStore(s3 as never), client: workerPrisma as never });

  const reset = () => {
    HOOK.put = null;
    HOOK.puts = 0;
    HOOK.lock = null;
  };

  // -------------------------------------------------------------------------
  it("the bytes are declared on the row BEFORE the upload and counted exactly once when READY (no double charge)", async () => {
    reset();
    const { t, evidenceId, baseline } = await tenantWithRoom(BigInt(pngBytes * 4));
    const p = await previewOf(t, evidenceId);
    let atPut: { used: bigint; state: string; key: string | null } | null = null;
    HOOK.put = async (put, real) => {
      const r = await row(p.id);
      atPut = { used: (await bothHosts(t)).storageBytesUsed - baseline, state: r.state, key: r.storageKey };
      return real(put);
    };
    await run(p.id);
    expect(atPut, "counted before any byte is sent").toMatchObject({ used: BigInt(pngBytes), state: "RENDERING" });
    const done = await row(p.id);
    expect(done).toMatchObject({ state: "READY", byteSize: BigInt(pngBytes), width: pngWidth, height: pngHeight });
    expect(atPut!.key).toBe(done.storageKey);
    expect((await storedVersions(t)).length).toBe(1);
    // Counted only by the preview row: no derived row, no intent, no reservation.
    expect(await prisma.derivedAssetStorageIntent.count({ where: { teamId: t.personalTeamId } })).toBe(0);
    expect(await prisma.evidencePartDerivedAsset.count({ where: { teamId: t.personalTeamId } })).toBe(0);
    await accountingEqualsStored(t, baseline);
    expect((await bothHosts(t)).storageBytesUsed - baseline).toBe(BigInt(pngBytes));
  }, 300_000);

  it("quota refusal: a workspace without room gains nothing — no object, no pointer, FAILED storage_limit", async () => {
    reset();
    const { t, evidenceId, baseline } = await tenantWithRoom(BigInt(pngBytes - 1));
    const p = await previewOf(t, evidenceId);
    await run(p.id);
    expect(await row(p.id)).toMatchObject({ state: "FAILED", failureReason: "storage_limit", storageKey: null, byteSize: null });
    expect(HOOK.puts).toBe(0);
    expect(await storedBytes(t)).toBe(0n);
    await accountingEqualsStored(t, baseline);
  }, 300_000);

  it("concurrent renders against quota: exactly the room is admitted (capacity lock), the other is refused having written nothing", async () => {
    reset();
    const { t, evidenceId, baseline } = await tenantWithRoom(BigInt(pngBytes + Math.floor(pngBytes / 2)));
    const ps = [await previewOf(t, evidenceId, 0), await previewOf(t, evidenceId, 1), await previewOf(t, evidenceId, 2)];
    // Every render that gets past its storage decision waits (up to 3 s) for
    // the others at the PUT, so no READY can land before another render's
    // decision: an unreserved check would admit all three here.
    let atPut = 0;
    HOOK.put = async (put, real) => {
      atPut += 1;
      const until = Date.now() + 3_000;
      while (atPut < ps.length && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      return real(put);
    };
    await Promise.all(ps.map((p) => run(p.id)));
    const rows = await Promise.all(ps.map((p) => row(p.id)));
    expect(rows.filter((r) => r.state === "READY")).toHaveLength(1);
    expect(rows.filter((r) => r.state === "FAILED" && r.failureReason === "storage_limit")).toHaveLength(2);
    expect(HOOK.puts, "a refused render sends no byte").toBe(1);
    await accountingEqualsStored(t, baseline);
  }, 300_000);

  it("a failed upload (nothing landed) keeps its declaration counted; the retry re-admits without double counting; a never-retried declaration is cleared only once the key is proven empty", async () => {
    reset();
    const { t, evidenceId, baseline } = await tenantWithRoom(BigInt(pngBytes * 4));
    const p = await previewOf(t, evidenceId);
    HOOK.put = async () => {
      throw new Error("503 Service Unavailable");
    };
    await expect(run(p.id)).rejects.toThrow(/503/);
    let r = await row(p.id);
    expect(r).toMatchObject({ state: "QUEUED", renderStartedAt: null, byteSize: BigInt(pngBytes) });
    expect(r.storageKey, "the PUT may have landed: still declared").toMatch(new RegExp(`^redactions/${t.personalTeamId}/previews/`));
    expect((await bothHosts(t)).storageBytesUsed - baseline, "counted while it may be stored").toBe(BigInt(pngBytes));
    expect(await storedBytes(t)).toBe(0n);
    // Inside the holder's window the reconciler does not judge it.
    await sweep();
    expect((await row(p.id)).storageKey, "not judged inside the window").not.toBeNull();

    // The retry AFTER the earlier holder's window closed: the key is listed
    // empty, which now proves it, so the bytes are admitted again (the row's
    // own declaration is not counted against them), stored, READY.
    await closeWindow(p.id);
    HOOK.put = null;
    await run(p.id);
    r = await row(p.id);
    expect(r).toMatchObject({ state: "READY", byteSize: BigInt(pngBytes) });
    expect((await storedVersions(t)).length).toBe(1);
    await accountingEqualsStored(t, baseline);

    // A second render whose PUT fails and is never retried: after the window
    // its key is listed, proven empty, and the declaration stops counting.
    const q = await previewOf(t, evidenceId, 1);
    HOOK.put = async () => {
      throw new Error("503 Service Unavailable");
    };
    await expect(run(q.id)).rejects.toThrow(/503/);
    await prisma.redactionPagePreview.update({ where: { id: q.id }, data: { state: "FAILED", failureReason: "renderer_failed" } });
    await closeWindow(q.id);
    await sweep();
    expect(await row(q.id), "no false READY: cleared, still FAILED").toMatchObject({ state: "FAILED", storageKey: null, byteSize: null });
    await accountingEqualsStored(t, baseline);
  }, 300_000);

  it("closure3 review L1: an immediate retry admits its bytes IN ADDITION to the unproven earlier declaration; a late version of the earlier PUT is counted, and the reconciler sizes the row after the window", async () => {
    reset();
    HOOK.lock = { mode: "GOVERNANCE", retainUntil: new Date(Date.now() + 86_400_000) };
    const { t, evidenceId, baseline } = await tenantWithRoom(BigInt(pngBytes * 4));
    const p = await previewOf(t, evidenceId);
    let lateKey: string | null = null;
    let lateBody: Buffer | null = null;
    HOOK.put = async (put) => {
      lateKey = put.key;
      lateBody = put.body;
      throw new Error("aborted at the write deadline ETIMEDOUT"); // the body may still land
    };
    await expect(run(p.id)).rejects.toThrow(/ETIMEDOUT/);
    expect(await row(p.id)).toMatchObject({ state: "QUEUED", byteSize: BigInt(pngBytes) });
    // The retry runs at once (inside the earlier holder's window). While it
    // uploads, the earlier PUT lands late on the same key.
    HOOK.put = async (put, real) => {
      expect(put.key, "written under the row's declared key").toBe(lateKey);
      expect((await bothHosts(t)).storageBytesUsed - baseline, "both counted while either may land").toBe(BigInt(pngBytes * 2));
      await real({ ...put, body: lateBody! });
      return real(put);
    };
    await run(p.id);
    const r = await row(p.id);
    expect(r).toMatchObject({ state: "READY", byteSize: BigInt(pngBytes * 2), failureReason: "declaration_unproven" });
    expect(await storedVersions(t)).toHaveLength(2);
    await accountingEqualsStored(t, baseline);
    // After the window the reconciler sizes the READY row to what is stored and clears its marker.
    await closeWindow(p.id);
    await sweep();
    expect(await row(p.id)).toMatchObject({ state: "READY", byteSize: BigInt(pngBytes * 2), failureReason: null });
    await accountingEqualsStored(t, baseline);
  }, 300_000);

  it("closure3 review L1: an immediate retry REFUSED for room keeps the unproven earlier declaration counted; its late version stays counted and is sized by the reconciler", async () => {
    reset();
    HOOK.lock = { mode: "GOVERNANCE", retainUntil: new Date(Date.now() + 86_400_000) };
    // Room for exactly one PNG: the earlier declaration uses it.
    const { t, evidenceId, baseline } = await tenantWithRoom(BigInt(pngBytes));
    const p = await previewOf(t, evidenceId);
    let late: { key: string; body: Buffer; real: (q: PutParams) => Promise<unknown>; put: PutParams } | null = null;
    HOOK.put = async (put, real) => {
      late = { key: put.key, body: put.body, real, put };
      throw new Error("503 Service Unavailable after the body was sent");
    };
    await expect(run(p.id)).rejects.toThrow(/503/);
    HOOK.put = null;
    await run(p.id);
    const r = await row(p.id);
    expect(r).toMatchObject({ state: "FAILED", failureReason: "storage_limit", byteSize: BigInt(pngBytes) });
    expect(r.storageKey, "the unproven declaration is kept").toBe(late!.key);
    // The earlier PUT lands late.
    await late!.real(late!.put);
    expect(await storedVersions(t)).toHaveLength(1);
    await accountingEqualsStored(t, baseline);
    await closeWindow(p.id);
    await sweep();
    expect(await row(p.id)).toMatchObject({ storageKey: late!.key, byteSize: BigInt(pngBytes) });
    await accountingEqualsStored(t, baseline);
  }, 300_000);

  it("a lost answer under Object Lock: the object stays counted, the reconciler never deletes it, and the retry REUSES it (no second version)", async () => {
    reset();
    HOOK.lock = { mode: "GOVERNANCE", retainUntil: new Date(Date.now() + 86_400_000) };
    const { t, evidenceId, baseline } = await tenantWithRoom(BigInt(pngBytes * 4));
    const p = await previewOf(t, evidenceId);
    HOOK.put = async (put, real) => {
      await real(put); // the object lands ...
      throw new Error("socket hang up ETIMEDOUT"); // ... and the answer is lost
    };
    await expect(run(p.id)).rejects.toThrow(/ETIMEDOUT/);
    expect(await row(p.id)).toMatchObject({ state: "QUEUED", byteSize: BigInt(pngBytes) });
    const versions = await storedVersions(t);
    expect(versions).toHaveLength(1);
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: versions[0]!.Key!, VersionId: versions[0]!.VersionId }));
    expect(head.ObjectLockMode, "the stored preview is under the record's Object Lock").toBe("GOVERNANCE");
    expect(await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: versions[0]!.Key!, VersionId: versions[0]!.VersionId })).then(() => "deleted", () => "refused"), "the store refuses its deletion").toBe("refused");
    await accountingEqualsStored(t, baseline);

    // The reconciler judges the key after the window: the object exists, so the
    // pointer is KEPT (sized to it) and nothing is deleted.
    await closeWindow(p.id);
    await sweep();
    expect(await row(p.id), "kept, sized to what is stored").toMatchObject({ byteSize: BigInt(pngBytes) });
    expect((await row(p.id)).storageKey).not.toBeNull();
    expect(await judgedRecently(p.id), "judged this tick").toBe(true);
    expect((await storedVersions(t)).map((v) => v.VersionId)).toEqual(versions.map((v) => v.VersionId));
    expect((await row(p.id)).state, "the reconciler never stamps READY").toBe("QUEUED");
    await accountingEqualsStored(t, baseline);

    // The retry lists the key, finds the object and writes nothing.
    HOOK.put = null;
    HOOK.puts = 0;
    await run(p.id);
    expect(HOOK.puts, "no second upload").toBe(0);
    expect(await row(p.id)).toMatchObject({ state: "READY", byteSize: BigInt(pngBytes), width: pngWidth, height: pngHeight });
    expect(await storedVersions(t)).toHaveLength(1);
    await accountingEqualsStored(t, baseline);
  }, 300_000);

  it("the database refuses the READY write after the upload: the row fails with its declaration kept (counted); the retry reuses the stored object", async () => {
    reset();
    HOOK.lock = { mode: "GOVERNANCE", retainUntil: new Date(Date.now() + 86_400_000) };
    const { t, evidenceId, baseline } = await tenantWithRoom(BigInt(pngBytes * 4));
    const p = await previewOf(t, evidenceId);
    const ck = `c3pv_no_ready_${TAG.replace(/-/g, "")}`;
    HOOK.put = async (put, real) => {
      const r = await real(put);
      // After the object landed, the database refuses the READY transition.
      await prisma.$executeRawUnsafe(`ALTER TABLE "redaction_page_previews" ADD CONSTRAINT "${ck}" CHECK ("state" <> 'READY') NOT VALID`);
      return r;
    };
    try {
      await run(p.id);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "redaction_page_previews" DROP CONSTRAINT IF EXISTS "${ck}"`);
    }
    const failed = await row(p.id);
    expect(failed).toMatchObject({ state: "FAILED", failureReason: "renderer_failed", byteSize: BigInt(pngBytes) });
    expect(failed.storageKey, "the stored object stays declared").not.toBeNull();
    expect(await storedVersions(t)).toHaveLength(1);
    await accountingEqualsStored(t, baseline);
    // The API retries a renderer_failed page (FAILED -> QUEUED); the retry reuses it.
    await prisma.redactionPagePreview.update({ where: { id: p.id }, data: { state: "QUEUED", failureReason: null } });
    HOOK.put = null;
    HOOK.puts = 0;
    await run(p.id);
    expect(HOOK.puts).toBe(0);
    expect((await row(p.id)).state).toBe("READY");
    expect(await storedVersions(t)).toHaveLength(1);
    await accountingEqualsStored(t, baseline);
  }, 300_000);

  it("the process dies after the upload (no READY, claim never released): counted throughout; after the lease the next claim reuses the object", async () => {
    reset();
    HOOK.lock = { mode: "GOVERNANCE", retainUntil: new Date(Date.now() + 86_400_000) };
    const { t, evidenceId, baseline } = await tenantWithRoom(BigInt(pngBytes * 4));
    const p = await previewOf(t, evidenceId);
    // The holder's own steps up to the upload, then nothing: the process is gone.
    const claim = await writer.claimPagePreviewForRender(p.id);
    if (!claim.claimed) throw new Error("not claimed");
    const rendered = await processor.renderPdfPagePreview(PDF, 0);
    if (!rendered.ok) throw new Error("render failed");
    const step = await storage.preparePagePreviewWrite({
      previewId: p.id,
      teamId: t.personalTeamId,
      evidenceId,
      claimedAt: claim.claimedAt,
      bucket: BUCKET,
      contentKey: `redactions/${t.personalTeamId}/previews/${p.projectId}/page-0-${createHash("sha256").update(rendered.png).digest("hex").slice(0, 16)}.png`,
      bytes: rendered.png.length,
      store: intentStore.s3DerivedObjectStore(s3 as never),
      client: workerPrisma as never,
    });
    if (step.kind !== "write") throw new Error(`unexpected ${step.kind}`);
    await workerStorage.putObjectBuffer({ bucket: step.bucket, key: step.key, body: rendered.png, contentType: "image/png", lock: HOOK.lock });
    expect(await row(p.id)).toMatchObject({ state: "RENDERING", byteSize: BigInt(pngBytes) });
    await accountingEqualsStored(t, baseline);

    // Past the lease and the grace: the reconciler keeps the pointer (the object exists) ...
    await closeWindow(p.id);
    await sweep();
    expect(await row(p.id)).toMatchObject({ state: "RENDERING", byteSize: BigInt(pngBytes) });
    expect((await row(p.id)).storageKey).not.toBeNull();
    expect(await judgedRecently(p.id), "judged this tick").toBe(true);
    await accountingEqualsStored(t, baseline);
    // ... and the stranded-row recovery's next claim reuses it.
    HOOK.puts = 0;
    await run(p.id);
    expect(HOOK.puts).toBe(0);
    expect((await row(p.id)).state).toBe("READY");
    expect(await storedVersions(t)).toHaveLength(1);
    await accountingEqualsStored(t, baseline);
  }, 300_000);

  it("a declaration whose holder died BEFORE uploading is cleared after its window; a key holding extra versions is sized to all of them and none is deleted", async () => {
    reset();
    HOOK.lock = { mode: "GOVERNANCE", retainUntil: new Date(Date.now() + 86_400_000) };
    const { t, evidenceId, baseline } = await tenantWithRoom(BigInt(pngBytes * 8));
    // Died before the PUT: admitted and declared, nothing stored.
    const p = await previewOf(t, evidenceId);
    const claimedAt = new Date();
    await prisma.redactionPagePreview.update({ where: { id: p.id }, data: { state: "RENDERING", renderStartedAt: claimedAt } });
    const step = await storage.preparePagePreviewWrite({
      previewId: p.id,
      teamId: t.personalTeamId,
      evidenceId,
      claimedAt,
      bucket: BUCKET,
      contentKey: `redactions/${t.personalTeamId}/previews/${p.projectId}/page-0-${"a".repeat(16)}.png`,
      bytes: pngBytes,
      store: intentStore.s3DerivedObjectStore(s3 as never),
      client: workerPrisma as never,
    });
    expect(step.kind).toBe("write");
    expect((await bothHosts(t)).storageBytesUsed - baseline).toBe(BigInt(pngBytes));
    await closeWindow(p.id);
    // Through the scheduled entry point (the cron-locked stranded-preview
    // sweep, with the worker's own S3 client): the wiring, not only the step.
    await processor.reconcileStrandedRedactionPagePreviews({ enqueue: async () => ({ enqueued: false }) });
    expect(await row(p.id)).toMatchObject({ storageKey: null, byteSize: null, state: "RENDERING" });
    await accountingEqualsStored(t, baseline);

    // A declared key that holds TWO locked versions (a late PUT of an earlier
    // holder): the row counts both; neither is deleted.
    const q = await previewOf(t, evidenceId, 1);
    const key = `redactions/${t.personalTeamId}/previews/${q.projectId}/page-1-${"b".repeat(16)}.png`;
    const lock = { ObjectLockMode: "GOVERNANCE" as const, ObjectLockRetainUntilDate: new Date(Date.now() + 86_400_000) };
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.alloc(1000, 1), ...lock }));
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.alloc(3000, 2), ...lock }));
    await prisma.redactionPagePreview.update({
      where: { id: q.id },
      data: { state: "FAILED", failureReason: "renderer_failed", storageBucket: BUCKET, storageKey: key, byteSize: 1000n },
    });
    expect((await bothHosts(t)).storageBytesUsed - baseline, "under-counted before the reconciler").toBeLessThan(await storedBytes(t));
    await closeWindow(q.id);
    await sweep();
    expect((await row(q.id)).byteSize).toBe(4000n);
    expect(await storedVersions(t)).toHaveLength(2);
    await accountingEqualsStored(t, baseline);
  }, 300_000);
});
