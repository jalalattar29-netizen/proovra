/**
 * THE CANONICAL EVIDENCE LOCATION STATE (2026-10-16) — executed proof on the
 * real harness.
 *
 * WHAT IS REAL: PostgreSQL 16 (testcontainers), Redis, MinIO, the API over
 * HTTP (web create, direct-capture reserve, review workspace, public Verify),
 * the custody chain and the REAL report/package processor. WHAT IS DOUBLED:
 * the Chromium PDF renderer (its INPUT is captured and asserted), the rendered
 * PDF text check and the external RFC 3161 authority.
 *
 * Proves: location is derived only from persisted facts (stored coordinates,
 * a request outcome recorded in custody, the plan's requirement); a legacy or
 * not-requested record is "Location not recorded" and never "Blocked"; a
 * declined request is not an invalid one; invalid stored coordinates are never
 * shown; optional absence never blocks completion, the report or the package;
 * and a regenerated report leaves the earlier immutable version untouched.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { shareLinkFor } from "./helpers/verify-share.js";
import { readZipEntries } from "./point5/_zip-entries.js";

const seam = vi.hoisted(() => ({ inputs: [] as unknown[] }));

vi.mock("../../worker/src/report-v2/build-report-pdf.js", () => {
  const render = (params: unknown) => {
    seam.inputs.push(params);
    return Buffer.from(`%PDF-1.7 location-state fixture ${randomUUID()}\n`);
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

type LocationState = { state: string; label: string; tone: string; detail: string | null; requirement?: unknown };

describe("canonical evidence location state (Postgres + Redis + MinIO, real worker)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let processor: typeof import("../../worker/src/processor.js");
  let workerStorage: typeof import("../../worker/src/storage.js");
  let reportQueue: import("bullmq").Queue;
  let clearRates: () => Promise<unknown>;
  const keyId = `loc-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

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
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    const A = h.fixtures.teamA;
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
    const orgId = (await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } })).organizationId!;
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, { organizationId: orgId, status: "ACTIVE", activationState: "ACTIVATED", seatCount: 25 });
    if (!(await prisma.organizationSecurityPolicy.findUnique({ where: { organizationId: orgId } }))) {
      await prisma.organizationSecurityPolicy.create({ data: { organizationId: orgId } });
    }
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
  const call = (method: "GET" | "POST", url: string, token: string | null, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  async function workspaceLocation(id: string) {
    const res = await call("GET", `/v1/evidence/${id}/review-workspace`, A().ownerToken);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      locationState: LocationState;
      sourceCaptureLocation: unknown;
      sourceContext: { locationIncluded: boolean };
    };
    expect(res.body).not.toMatch(/"Blocked"/);
    return { body, raw: res.body };
  }

  async function verifyLocation(id: string) {
    const res = await h.app.inject({
      method: "GET",
      url: `/public/verify/${await shareLinkFor(prisma, id)}`,
      remoteAddress: `198.51.100.${1 + Math.floor(Math.random() * 250)}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().tier).toBe("RICH");
    return res.json() as { locationState: LocationState; captureContext: unknown };
  }

  async function custodyOf(id: string) {
    return prisma.custodyEvent.findMany({ where: { evidenceId: id }, orderBy: { sequence: "asc" }, select: { eventType: true, payload: true } });
  }

  /** A signed record written directly — the shape of a legacy row. */
  async function signedRecord(data: Record<string, unknown>) {
    const { teamId } = A();
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const row = await prisma.evidence.create({
      data: { title: "Location fixture", type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId, ...(data.acquisitionMode ? { acquisitionModeSource: "RECORDED_AT_CREATION" } : {}), ...data } as never,
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
        signedAtUtc: new Date(),
      } as never,
    });
    return row.id;
  }

  describe("owner web (review workspace) and Public Verify state the same canonical location", () => {
    it("legacy record with no location facts → Location not recorded, neutral, never Blocked (both surfaces)", async () => {
      const id = await signedRecord({ acquisitionMode: null });
      const { body } = await workspaceLocation(id);
      expect(body.locationState).toMatchObject({ state: "NOT_RECORDED", label: "Location not recorded", tone: "neutral", detail: null });
      expect(body.sourceCaptureLocation).toBeNull();
      const pub = await verifyLocation(id);
      expect(pub.locationState).toEqual({ state: "NOT_RECORDED", label: "Location not recorded", tone: "neutral", detail: null });
      expect(pub.captureContext).toBeNull();
    });

    it("valid recorded coordinates → Location recorded, the map's coordinates, on both surfaces", async () => {
      const id = await signedRecord({ acquisitionMode: "PROOVRA_MOBILE_APP", lat: 52.52, lng: 13.405, accuracyMeters: 9, locationSource: "CLIENT_APP_DEVICE_LOCATION" });
      const { body } = await workspaceLocation(id);
      expect(body.locationState).toMatchObject({ state: "RECORDED", label: "Location recorded", tone: "info" });
      expect(body.sourceCaptureLocation).toMatchObject({ statusLabel: "Location recorded", lat: 52.52, lng: 13.405 });
      expect(body.sourceContext.locationIncluded).toBe(true);
      const pub = await verifyLocation(id);
      expect(pub.locationState.label).toBe("Location recorded");
      expect(pub.captureContext).toMatchObject({ statusLabel: "Location recorded", lat: 52.52 });
    });

    it("intake capture with a recorded DENIED consent → Location not shared (not invalid, not blocked)", async () => {
      const id = await signedRecord({ acquisitionMode: "SECURE_INTAKE_LINK" });
      const { appendCustodyEvent } = await import("../src/services/custody-events.service.js");
      // The fact submitExternalIntake records for an OPTIONAL link the contributor skipped.
      await appendCustodyEvent({
        evidenceId: id,
        eventType: "EXTERNAL_INTAKE_SUBMITTED" as never,
        payload: { intakeLinkId: randomUUID(), intakeSessionId: randomUUID(), partCount: 1, locationProvided: false, locationConsentState: "DENIED" },
      });
      const { body } = await workspaceLocation(id);
      expect(body.locationState).toMatchObject({ state: "NOT_SHARED", label: "Location not shared", tone: "neutral" });
      expect((await verifyLocation(id)).locationState.state).toBe("NOT_SHARED");
    });

    it("invalid stored coordinates → Location metadata invalid; the coordinates are never shown", async () => {
      const id = await signedRecord({ acquisitionMode: "PROOVRA_WEB_UPLOAD", lat: 123.5, lng: 13.4, locationSource: "CAPTURE_BROWSER_GEOLOCATION" });
      const { body, raw } = await workspaceLocation(id);
      expect(body.locationState).toMatchObject({ state: "INVALID", label: "Location metadata invalid", tone: "warning" });
      expect(body.sourceCaptureLocation).toBeNull();
      expect(body.sourceContext.locationIncluded).toBe(false);
      // The raw record DTO (`evidence`) carries the stored columns as preserved
      // facts; no PRESENTATION field (location state, map block, context) does.
      const presentation = JSON.parse(raw) as Record<string, unknown>;
      delete presentation.evidence;
      const leaks: string[] = [];
      JSON.parse(JSON.stringify(presentation), (k, v) => { if (v === 123.5) leaks.push(k); return v; });
      expect(leaks, "invalid coordinate leaked under").toEqual([]);
      const pub = await verifyLocation(id);
      expect(pub.locationState.state).toBe("INVALID");
      expect(pub.captureContext).toBeNull();
    });

    it("a plan that required location is stated apart from the recorded truth (owner only)", async () => {
      const id = await signedRecord({ acquisitionMode: "PROOVRA_WEB_UPLOAD", intakePlanJson: { templateName: "Site visit", locationRequirement: "required" } });
      const { body } = await workspaceLocation(id);
      expect(body.locationState).toMatchObject({
        state: "NOT_RECORDED",
        requirement: { level: "required", label: "Required by the collection plan", unmet: true },
      });
      const pub = await verifyLocation(id);
      expect(pub.locationState).not.toHaveProperty("requirement");
    });
  });

  describe("capture paths record the request outcome they observe", () => {
    it("web capture: a denied browser request is recorded in EVIDENCE_CREATED and read as Location not shared", async () => {
      const created = await call("POST", "/v1/evidence", A().ownerToken, { type: "DOCUMENT", mimeType: "text/plain", teamId: A().teamId, locationRequestOutcome: "DENIED" });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().id as string;
      const createdEvent = (await custodyOf(id)).find((e) => e.eventType === "EVIDENCE_CREATED")!;
      expect((createdEvent.payload as Record<string, unknown>).locationRequest).toEqual({ outcome: "DENIED", reportedBy: "CAPTURE_CLIENT" });
      expect((await workspaceLocation(id)).body.locationState.state).toBe("NOT_SHARED");
    });

    it("web capture: coordinates win; a stray outcome beside them is not recorded", async () => {
      const created = await call("POST", "/v1/evidence", A().ownerToken, {
        type: "DOCUMENT",
        mimeType: "text/plain",
        teamId: A().teamId,
        gps: { lat: 48.1, lng: 11.5, accuracyMeters: 20 },
        locationRequestOutcome: "UNAVAILABLE",
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().id as string;
      const createdEvent = (await custodyOf(id)).find((e) => e.eventType === "EVIDENCE_CREATED")!;
      expect((createdEvent.payload as Record<string, unknown>).locationRequest).toBeUndefined();
      const { body } = await workspaceLocation(id);
      expect(body.locationState).toMatchObject({ state: "RECORDED", label: "Location recorded" });
    });

    it("web upload without a request records nothing → Location not recorded", async () => {
      const created = await call("POST", "/v1/evidence", A().ownerToken, { type: "DOCUMENT", mimeType: "text/plain", teamId: A().teamId });
      const id = created.json().id as string;
      const createdEvent = (await custodyOf(id)).find((e) => e.eventType === "EVIDENCE_CREATED")!;
      expect((createdEvent.payload as Record<string, unknown>).locationRequest).toBeUndefined();
      expect((await workspaceLocation(id)).body.locationState.state).toBe("NOT_RECORDED");
    });

    it("mobile/direct capture: an unavailable device location is recorded and read as Location unavailable", async () => {
      const open = await call("POST", "/v1/capture/direct-sessions", A().ownerToken, { mode: "PROOVRA_MOBILE_APP", teamId: A().teamId, deviceId: null });
      expect(open.statusCode, open.body).toBe(201);
      const sessionId = (open.json() as { session: { captureSessionId: string } }).session.captureSessionId;
      const reserve = await call("POST", `/v1/capture/direct-sessions/${sessionId}/evidence`, A().ownerToken, {
        type: "PHOTO",
        mimeType: "image/jpeg",
        locationRequestOutcome: "UNAVAILABLE",
      });
      expect(reserve.statusCode, reserve.body).toBe(201);
      const id = (reserve.json() as { evidence: { evidenceId: string } }).evidence.evidenceId;
      expect((await workspaceLocation(id)).body.locationState).toMatchObject({ state: "UNAVAILABLE", label: "Location unavailable" });
    });

    it("an unknown outcome value is refused at the boundary (never stored)", async () => {
      const created = await call("POST", "/v1/evidence", A().ownerToken, { type: "DOCUMENT", mimeType: "text/plain", teamId: A().teamId, locationRequestOutcome: "BLOCKED" });
      expect(created.statusCode).toBe(400);
    });
  });

  describe("lifecycle: optional absent location never blocks completion, the report or the package", () => {
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

    async function packageEntries(evidenceId: string, version: number) {
      const pkg = await prisma.verificationPackage.findFirstOrThrow({ where: { evidenceId, version } as never });
      const zip = (await workerStorage.getObjectStream({ bucket: pkg.storageBucket!, key: pkg.storageKey! })) as AsyncIterable<Buffer>;
      const chunks: Buffer[] = [];
      for await (const c of zip) chunks.push(Buffer.from(c));
      return readZipEntries(Buffer.concat(chunks));
    }

    it("declined location → finalized, REPORTED, report + package carry the canonical state; a regenerated version leaves v1 untouched", async () => {
      seam.inputs.length = 0;
      const created = await call("POST", "/v1/evidence", A().ownerToken, { type: "DOCUMENT", mimeType: "text/plain", teamId: A().teamId, locationRequestOutcome: "DENIED" });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().id as string;
      const part = await call("POST", `/v1/evidence/${id}/parts`, A().ownerToken, { partIndex: 0, mimeType: "text/plain", originalFileName: "location.txt" });
      expect(part.statusCode, part.body).toBe(201);
      const put = await fetch(part.json().upload.putUrl as string, {
        method: "PUT",
        body: Buffer.from(`location-state ${id} ${randomBytes(8).toString("hex")}`),
        headers: { "content-type": "text/plain" },
      });
      expect(put.status).toBe(200);
      const done = await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {});
      expect(done.statusCode, done.body).toBe(200);

      await runReportJobs(id);
      expect((await prisma.evidence.findUniqueOrThrow({ where: { id } })).status).toBe("REPORTED");

      // The report generated from the record's facts states the canonical state.
      const { buildReportViewModel } = await import("../../worker/src/report-v2/build-view-model.js");
      const input1 = seam.inputs.at(-1) as { evidence: { gps: Record<string, unknown> } };
      expect(input1.evidence.gps).toMatchObject({ lat: null, lng: null, requestOutcome: "DENIED" });
      const vm1 = await buildReportViewModel(input1 as never);
      expect(vm1.meta.locationState).toMatchObject({ state: "NOT_SHARED", label: "Location not shared" });
      expect(vm1.meta.captureContext).toBeNull();

      // The package states it in case metadata; no capture-context.json, no map.
      const pkgRow = await prisma.verificationPackage.findFirstOrThrow({ where: { evidenceId: id, state: "PUBLISHED" } as never, orderBy: { version: "asc" } });
      const entries = await packageEntries(id, pkgRow.version);
      const caseMeta = JSON.parse(entries.get("case-metadata.json")!.toString("utf8"));
      expect(caseMeta.locationState).toMatchObject({ state: "NOT_SHARED", label: "Location not shared" });
      expect(caseMeta.captureLocation).toBeNull();
      expect(entries.has("capture-context.json")).toBe(false);
      expect(entries.has("map-preview.png")).toBe(false);

      // Immutable generation-time versions: a regeneration adds v2, v1 is byte-for-byte the same row.
      const v1 = await prisma.report.findFirstOrThrow({ where: { evidenceId: id }, orderBy: { version: "asc" } });
      const writer = await import("../src/services/reports/report-generation-authority.service.js");
      const made = (await writer.requestReportGeneration({
        evidenceId: id,
        purpose: "operator_regenerate",
        artifactType: "REPORT",
        forceRegenerate: true,
        requestedByMachineId: "location-state-test",
      } as never)) as { requestId?: string };
      expect(made.requestId).toBeTruthy();
      await runReportJobs(id);
      expect(await prisma.report.count({ where: { evidenceId: id } })).toBe(2);
      expect(await prisma.report.findUniqueOrThrow({ where: { id: v1.id } })).toEqual(v1);
      const vm2 = await buildReportViewModel(seam.inputs.at(-1) as never);
      expect(vm2.meta.locationState?.state).toBe("NOT_SHARED");
    }, 300_000);
  });
});
