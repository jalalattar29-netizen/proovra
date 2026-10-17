/**
 * CANONICAL VERIFICATION IDENTITY (owner decision 2026-10-14) — executed proof.
 *
 * WHAT IS REAL: PostgreSQL 16 (testcontainers), Redis (the finalize writer
 * enqueues Report v1; the BullMQ job is read back and run by the REAL report
 * processor), MinIO (the original, the report object and the verification
 * package ZIP), the API over HTTP for capture, finalize, owner controls and
 * the anonymous public route, the custody chain. WHAT IS DOUBLED: the Chromium
 * PDF renderer (deterministic bytes; the render INPUT — the verify URL the QR
 * encodes — is captured and asserted), the rendered-PDF text check, and the
 * external RFC 3161 authority.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { readZipEntries } from "./point5/_zip-entries.js";

const seam = vi.hoisted(() => ({ renders: [] as Array<{ verifyUrl: string | null; version: number | null }> }));

vi.mock("../../worker/src/report-v2/build-report-pdf.js", () => {
  const render = (params: unknown) => {
    const p = params as { verifyUrl?: string; version?: number };
    seam.renders.push({ verifyUrl: p?.verifyUrl ?? null, version: p?.version ?? null });
    return Buffer.from(`%PDF-1.7 canonical-verification fixture ${randomUUID()}\n`);
  };
  return {
    buildReportPdfV2: async (params: unknown) => render(params),
    buildReportPdfV2WithSignatureOutcome: async (params: unknown) => ({
      status: "UNSIGNED_OPT_OUT" as const,
      pdf: render(params),
      warning: "PDF signing is not exercised by this case.",
    }),
  };
});

vi.mock("../../worker/src/output-verification.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../worker/src/output-verification.js")>();
  return { ...actual, assertRenderedReport: async () => undefined };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

const REF_SHAPE = /^pvr_[A-Za-z0-9_-]{27}$/;

describe("canonical verification identity (Postgres + Redis + MinIO, real worker)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let processor: typeof import("../../worker/src/processor.js");
  let workerStorage: typeof import("../../worker/src/storage.js");
  let reportQueue: import("bullmq").Queue;
  let clearRates: () => Promise<unknown>;
  let pipeline: {
    evidenceId: string;
    ref: string;
    ownerUserId: string;
    teamId: string;
  };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    processor = await import("../../worker/src/processor.js");
    workerStorage = await import("../../worker/src/storage.js");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    const { Queue } = await import("bullmq");
    const { default: IORedis } = await import("ioredis");
    reportQueue = new Queue("report", { connection: new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }) });
    await reportQueue.obliterate({ force: true });
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });
  }, 600_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await reportQueue?.obliterate({ force: true }).catch(() => undefined);
    await reportQueue?.close();
    await h?.cleanup();
  }, 120_000);

  const A = () => h.fixtures.teamA;
  const call = (method: "GET" | "POST" | "DELETE", url: string, token: string | null, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const publicVerify = (segment: string) => call("GET", `/public/verify/${encodeURIComponent(segment)}`, null);

  async function runReportJobs(evidenceId: string): Promise<void> {
    for (let i = 0; i < 6; i++) {
      const requests = await prisma.reportGenerationRequest.findMany({
        where: { evidenceId, state: { in: ["QUEUED", "FAILED_RETRYABLE"] } },
        select: { id: true },
      });
      if (requests.length === 0) return;
      for (const r of requests) {
        const job = await reportQueue.getJob(`report-${r.id}`);
        if (!job) continue;
        (job as { attemptsMade: number }).attemptsMade = 0;
        await processor.processGenerateReport(job as never);
      }
    }
  }

  async function captureAndFinalize(): Promise<string> {
    const created = await call("POST", "/v1/evidence", A().ownerToken, { type: "DOCUMENT", mimeType: "text/plain", teamId: A().teamId });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const part = await call("POST", `/v1/evidence/${id}/parts`, A().ownerToken, { partIndex: 0, mimeType: "text/plain", originalFileName: "canonical.txt" });
    expect(part.statusCode, part.body).toBe(201);
    const put = await fetch(part.json().upload.putUrl as string, {
      method: "PUT",
      body: Buffer.from(`canonical-verification ${id} ${randomBytes(8).toString("hex")}`),
      headers: { "content-type": "text/plain" },
    });
    expect(put.status).toBe(200);
    const done = await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {});
    expect(done.statusCode, done.body).toBe(200);
    return id;
  }

  it("PIPELINE: FINALIZATION issues the reference (signing transaction) → the worker reuses it for Report v1 → report + package in MinIO → anonymous page", async () => {
    seam.renders.length = 0;
    const evidenceId = await captureAndFinalize();
    // The record is eligible from signing on, so it holds its permanent
    // reference from signing on — before and whether or not a report renders.
    const atSigning = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { verificationRef: true } });
    expect(atSigning.verificationRef).toMatch(REF_SHAPE);
    const issued = await prisma.custodyEvent.findFirstOrThrow({ where: { evidenceId, eventType: "VERIFICATION_REFERENCE_ISSUED" } });
    expect(issued.payload).toMatchObject({ verificationRef: atSigning.verificationRef, source: "FINALIZATION" });

    await runReportJobs(evidenceId);

    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { verificationRef: true, verificationRefIssuedAtUtc: true, status: true, ownerUserId: true, teamId: true, storageBucket: true, storageKey: true },
    });
    expect(ev.status).toBe("REPORTED");
    expect(ev.verificationRef).toMatch(REF_SHAPE);
    expect(ev.verificationRef).not.toContain(evidenceId);
    // The worker reused the identity issued at signing; it never minted a second.
    expect(ev.verificationRef).toBe(atSigning.verificationRef);
    const ref = ev.verificationRef!;

    // The render INPUT (what the QR code and the printed link encode) is the canonical URL.
    expect(seam.renders.length).toBeGreaterThanOrEqual(1);
    expect(seam.renders[0]!.verifyUrl).toMatch(new RegExp(`/verify/${ref}$`));
    const report = await prisma.report.findFirstOrThrow({ where: { evidenceId }, orderBy: { version: "asc" } });
    expect(ev.verificationRefIssuedAtUtc!.getTime()).toBeLessThanOrEqual(report.generatedAtUtc.getTime());
    // Recorded in the custody chain; no per-version REPORT token minted.
    expect(await prisma.custodyEvent.count({ where: { evidenceId, eventType: "VERIFICATION_REFERENCE_ISSUED" } })).toBe(1);
    expect(await prisma.verificationShareToken.count({ where: { evidenceId } })).toBe(0);

    // The package in MinIO carries the SAME canonical URL.
    const pkg = await prisma.verificationPackage.findFirstOrThrow({ where: { evidenceId, state: "PUBLISHED" } as never, orderBy: { version: "asc" } });
    const zip = (await workerStorage.getObjectStream({ bucket: pkg.storageBucket!, key: pkg.storageKey! })) as AsyncIterable<Buffer>;
    const chunks: Buffer[] = [];
    for await (const c of zip) chunks.push(Buffer.from(c));
    const entries = readZipEntries(Buffer.concat(chunks));
    const manifest = JSON.parse(entries.get("package-manifest.json")!.toString("utf8"));
    expect(manifest.recordVerificationUrl).toMatch(new RegExp(`/verify/${ref}$`));
    expect(entries.get("README.txt")?.toString("utf8") ?? "").toContain(ref);

    // The anonymous page opens without login: the ESTABLISHED Public Verify
    // page (never a stripped replacement). The owner has not published this
    // record, so it is shown verification-only.
    const page = await publicVerify(ref);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    const body = page.json();
    expect(body.tier).toBe("RICH");
    expect(body.disclosure).toBe("VERIFICATION_ONLY");
    expect(body.link).toEqual({ kind: "CANONICAL", expiresAtUtc: null });
    expect(body.canonicalVerification).toMatchObject({ reference: ref, status: "AVAILABLE", disclosure: "VERIFICATION_ONLY" });
    expect(body.basicVerification.report.issued).toBe(true);
    expect(body.evidenceId).toBeNull();
    expect(body.contentAccessPolicy).toMatchObject({ allowContentView: false, allowDownload: false });
    const raw = page.body;
    // Values, never keys: the full page carries withheld fields as null.
    for (const forbidden of [evidenceId, ev.ownerUserId, ev.teamId!, ev.storageKey!, ev.storageBucket!, "@example", "ipAddress", "userAgent"]) {
      expect(raw, `the canonical page leaks ${forbidden}`).not.toContain(forbidden);
    }
    // No original, report or package download is offered.
    expect(raw).not.toMatch(/\/report\/latest|verification-package\/download|getObject|X-Amz-Signature/);

    // The owner's Evidence page button reads the same path; so can a viewer.
    for (const token of [A().ownerToken, A().viewerToken]) {
      const access = await call("GET", `/v1/evidence/${evidenceId}/verification-access`, token);
      expect(access.statusCode).toBe(200);
      expect(access.json()).toMatchObject({ status: "AVAILABLE", reference: ref, verifyPath: `/verify/${ref}`, refusalReason: null });
      // The Evidence page reads the SAME canonical contract from the review workspace.
      const ws = await call("GET", `/v1/evidence/${evidenceId}/review-workspace`, token);
      expect(ws.statusCode).toBe(200);
      expect(ws.json().canonicalVerification).toEqual({
        status: "AVAILABLE",
        reference: ref,
        verifyPath: `/verify/${ref}`,
        issuedAtUtc: access.json().issuedAtUtc,
        refusalReason: null,
      });
    }
    pipeline = { evidenceId, ref, ownerUserId: ev.ownerUserId, teamId: ev.teamId! };
  }, 300_000);

  it("a later report version reuses the SAME identity", async () => {
    const { evidenceId, ref } = pipeline;
    seam.renders.length = 0;
    const writer = await import("../src/services/reports/report-generation-authority.service.js");
    const made = (await writer.requestReportGeneration({
      evidenceId,
      purpose: "operator_regenerate",
      artifactType: "REPORT",
      forceRegenerate: true,
      requestedByMachineId: "canonical-verification-test",
    } as never)) as { requestId?: string };
    expect(made.requestId).toBeTruthy();
    await runReportJobs(evidenceId);
    expect(await prisma.report.count({ where: { evidenceId } })).toBe(2);
    expect(seam.renders.at(-1)!.verifyUrl).toMatch(new RegExp(`/verify/${ref}$`));
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId } })).verificationRef).toBe(ref);
    expect(await prisma.custodyEvent.count({ where: { evidenceId, eventType: "VERIFICATION_REFERENCE_ISSUED" } })).toBe(1);
  }, 300_000);

  it("the reference is permanent: the database refuses to change or clear it", async () => {
    const { evidenceId } = pipeline;
    await expect(
      prisma.evidence.update({ where: { id: evidenceId }, data: { verificationRef: `pvr_${"A".repeat(27)}` } }),
    ).rejects.toThrow();
    await expect(prisma.evidence.update({ where: { id: evidenceId }, data: { verificationRef: null } })).rejects.toThrow();
    // ...and it can never be shared by a second record.
    const team = await prisma.team.findUniqueOrThrow({ where: { id: pipeline.teamId }, select: { organizationId: true } });
    const other = await prisma.evidence.create({
      data: { type: "DOCUMENT", status: "SIGNED", ownerUserId: pipeline.ownerUserId, teamId: pipeline.teamId, organizationId: team.organizationId } as never,
      select: { id: true },
    });
    await expect(prisma.evidence.update({ where: { id: other.id }, data: { verificationRef: pipeline.ref } })).rejects.toThrow();
  });

  it("anti-enumeration: unknown references, the internal id and malformed segments reveal nothing; rate limits apply", async () => {
    const unknown = await Promise.all(
      Array.from({ length: 10 }, () => publicVerify(`pvr_${randomBytes(20).toString("base64url")}`)),
    );
    expect(new Set(unknown.map((r) => `${r.statusCode}:${r.body}`)).size).toBe(1);
    expect(unknown[0]!.statusCode).toBe(404);
    // The internal Evidence ID is not the page: the same constant answer a random UUID gets.
    const byId = await publicVerify(pipeline.evidenceId);
    const randomId = await publicVerify(randomUUID());
    expect(byId.statusCode).toBe(404);
    expect(byId.body).toBe(randomId.body);
    expect(byId.body).toBe(unknown[0]!.body);
    expect(byId.body).not.toContain(pipeline.ref);
    const malformed = await publicVerify("pvr_short");
    expect(malformed.statusCode).toBe(404);
    // No user-controlled redirect: the route never answers 3xx.
    for (const r of [...unknown, byId, randomId, malformed]) expect(r.statusCode < 300 || r.statusCode >= 400).toBe(true);

    await clearRates();
    const burst: number[] = [];
    for (let i = 0; i < 40; i++) burst.push((await publicVerify(pipeline.ref)).statusCode);
    expect(burst).toContain(429);
    await clearRates();
  }, 120_000);

  it("withdrawal is OWNER/ADMIN only, keeps the identity, answers truthfully, and is recorded in custody", async () => {
    const { evidenceId, ref } = pipeline;
    const forbiddenFor = [A().memberToken, A().viewerToken];
    for (const token of forbiddenFor) {
      const denied = await call("POST", `/v1/evidence/${evidenceId}/verification-access/withdraw`, token, { reason: "LEGAL_REQUEST" });
      expect(denied.statusCode).toBe(403);
    }
    const outsider = await call("POST", `/v1/evidence/${evidenceId}/verification-access/withdraw`, h.fixtures.teamB.ownerToken, { reason: "LEGAL_REQUEST" });
    expect(outsider.statusCode, "no IDOR across workspaces").toBe(404);

    const ok = await call("POST", `/v1/evidence/${evidenceId}/verification-access/withdraw`, A().adminToken, { reason: "PRIVACY_REQUEST" });
    expect(ok.statusCode).toBe(200);
    const withdrawn = await publicVerify(ref);
    expect(withdrawn.statusCode).toBe(410);
    expect(withdrawn.json()).toMatchObject({ code: "VERIFICATION_RECORD_WITHDRAWN", canonicalVerification: { reference: ref, status: "WITHDRAWN" } });
    expect(await prisma.custodyEvent.count({ where: { evidenceId, eventType: "VERIFICATION_ACCESS_WITHDRAWN" } })).toBe(1);

    expect((await call("POST", `/v1/evidence/${evidenceId}/verification-access/reinstate`, A().ownerToken, {})).statusCode).toBe(200);
    expect((await publicVerify(ref)).statusCode).toBe(200);
    expect(await prisma.custodyEvent.count({ where: { evidenceId, eventType: "VERIFICATION_ACCESS_REINSTATED" } })).toBe(1);
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId } })).verificationRef).toBe(ref);
  }, 120_000);

  it("Trash answers RETAINED (not 'not found'); restore brings the page back", async () => {
    const { evidenceId, ref } = pipeline;
    expect((await call("DELETE", `/v1/evidence/${evidenceId}`, A().ownerToken)).statusCode).toBe(200);
    const retained = await publicVerify(ref);
    expect(retained.statusCode).toBe(200);
    expect(retained.json()).toMatchObject({ code: "VERIFICATION_RECORD_RETAINED", canonicalVerification: { status: "RETAINED", reference: ref } });
    expect(retained.json().basicVerification).toBeUndefined();
    expect((await call("POST", `/v1/evidence/${evidenceId}/restore`, A().ownerToken, { restore: true })).statusCode).toBe(200);
    expect((await publicVerify(ref)).json().canonicalVerification.status).toBe("AVAILABLE");
  }, 120_000);

  it("legacy compatibility: a REPORT token printed by an earlier report opens the canonical page — never another record", async () => {
    const { evidenceId, ref } = pipeline;
    const { mintVerificationShareTokenTx, generateVerificationShareToken } = await import("@proovra/shared-runtime");
    const token = generateVerificationShareToken();
    await prisma.$transaction((tx) =>
      mintVerificationShareTokenTx(tx as never, {
        evidenceId,
        teamId: pipeline.teamId,
        purpose: "REPORT",
        reportVersion: 1,
        audience: "Report version 1",
        token,
        now: new Date(),
      } as never),
    );
    await prisma.evidence.update({ where: { id: evidenceId }, data: { publicVerifyState: "NOT_PUBLISHED" } });
    const legacy = await publicVerify(token);
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().canonicalVerification).toMatchObject({ reference: ref, status: "AVAILABLE" });
    expect(legacy.body).not.toContain(evidenceId);
  }, 120_000);

  it("a purged record keeps a truthful tombstone page with only its reference", async () => {
    const { evidenceId, ref } = pipeline;
    await prisma.evidence.update({ where: { id: evidenceId }, data: { lifecycleState: "DESTROYED", destroyedAtUtc: new Date() } });
    const purged = await publicVerify(ref);
    expect(purged.statusCode).toBe(410);
    expect(purged.json()).toMatchObject({ code: "VERIFICATION_RECORD_PURGED", canonicalVerification: { reference: ref, status: "PURGED" } });
    expect(Object.keys(purged.json().canonicalVerification).sort()).toEqual(["issuedAtUtc", "reference", "status"]);
    const sha = createHash("sha256").update(purged.body).digest("hex");
    expect(sha).toHaveLength(64);
  }, 120_000);
});
