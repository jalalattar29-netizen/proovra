/**
 * BATCH K3 — runtime proof, evidence capture cluster (part A).
 *
 * Capture drafts, capture-trust devices, the retired mobile ingest and
 * citizen capture (UC-0: proven as bounded 410s that write nothing),
 * the legacy batch-analysis job, reviewer corrections, resumable upload
 * parts, and the three AI routes — each proven through the REAL route against
 * a disposable PostgreSQL:
 *
 *   1. the authorized SUCCESS branch with the payload the product consumer
 *      builds, re-reading the durable row the action exists to change;
 *   2. the audit/event record the route writes;
 *   3. an expected refusal with a bounded status and no durable effect.
 *
 * EXTERNAL BOUNDARIES ARE FAKES, NEVER PROVIDERS.
 *   - `openai` is replaced by an in-process fake that records the request and
 *     answers a schema-valid structured response. No socket is opened; the
 *     outbound guard stays installed. The API key is a non-credential literal.
 *   - Object storage (`src/storage.js`) is an in-memory map for the calls the
 *     citizen-capture pipeline makes (put / head / stream / retention).
 *     Presigning is local signature arithmetic and stays real.
 */

import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

// -----------------------------------------------------------------------------
// Fakes — hoisted above every import of the application graph.
// -----------------------------------------------------------------------------

const openaiFake = vi.hoisted(() => ({
  calls: [] as Array<{ schema: string; store: unknown }>,
}));

vi.mock("openai", () => {
  const disclaimer =
    "AI assistance is advisory and does not determine factual truth, authorship, or legal admissibility.";
  const boundary =
    "AI assistance is advisory only and does not determine truth, authenticity, authorship, identity, intent, liability, fraud, or legal admissibility.";
  class FakeOpenAI {
    responses = {
      create: async (req: { text?: { format?: { name?: string } }; store?: unknown }) => {
        const schema = req.text?.format?.name ?? "unknown";
        openaiFake.calls.push({ schema, store: req.store });
        if (schema === "proovra_case_copilot") {
          return {
            output_text: JSON.stringify({
              caseSummary: "Two metadata records are linked to this case.",
              timelineHighlights: ["Records were captured on the recorded dates."],
              missingEvidenceCategories: [],
              workflowGaps: [],
              conflictingMetadata: [],
              reviewerPreparation: ["Confirm the capture order with the operator."],
              disclosureChecklist: [],
              unresolvedQuestions: [],
              citations: [],
              advisoryBoundary: boundary,
            }),
            usage: { input_tokens: 10, output_tokens: 20 },
          };
        }
        return {
          output_text: JSON.stringify({
            status: "ok",
            summary: "Open the review queue to see records waiting for a decision.",
            warnings: [],
            suggestions: [],
            flags: [],
            legalDisclaimer: disclaimer,
          }),
        };
      },
    };
  }
  return { default: FakeOpenAI, OpenAI: FakeOpenAI };
});

const objectStore = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  puts: [] as string[],
}));

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const keyOf = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      objectStore.objects.set(keyOf(p), Buffer.from(p.body));
      objectStore.puts.push(keyOf(p));
    },
    headObject: async (p: { bucket: string; key: string }) => {
      const body = objectStore.objects.get(keyOf(p));
      if (!body) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: body.length,
        contentType: "application/octet-stream",
        etag: `"${createHash("md5").update(body).digest("hex")}"`,
        metadata: {},
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      const body = objectStore.objects.get(keyOf(p));
      if (!body) throw new Error("NoSuchKey");
      return Readable.from([body]);
    },
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "object_lock_disabled" }),
    deleteObject: async (p: { bucket: string; key: string }) => {
      objectStore.objects.delete(keyOf(p));
    },
  };
});

// Fixture-safe AI configuration. Set before the app graph is imported (the
// chat/capture provider is built at module load) and re-applied before every
// AI test, because the shared safe-environment hook deletes both keys before
// each test. Neither is a credential: the key is a literal the fake never reads.
function enableFixtureAi() {
  process.env.OPENAI_AI_ENABLED = "true";
  process.env.OPENAI_API_KEY = "fixture-openai-not-a-credential";
}
enableFixtureAi();

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("K3 runtime proof — evidence capture (part A)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    token: string | null,
    payload?: unknown,
    remoteAddress?: string,
  ) =>
    harness.app.inject({
      method,
      url,
      ...(remoteAddress ? { remoteAddress } : {}),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });
  const json = (res: { body: string }) => JSON.parse(res.body) as Json;

  async function pointAt(userId: string, workspaceId: string) {
    await prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: workspaceId } });
  }

  function ed25519Key() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ type: "spki", format: "der" });
    return { publicKeyHex: spki.subarray(spki.length - 32).toString("hex"), privateKey };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));

    const { teamA, teamB, personal } = harness.fixtures;
    // Organization A is an Enterprise customer, built as the billing suites build one.
    const orgA = (await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } })).organizationId;
    await prisma.team.update({ where: { id: teamA.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, {
      organizationId: orgA,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
    });
    for (const u of [teamA.ownerUserId, teamA.adminUserId, teamA.memberUserId, teamA.viewerUserId]) {
      await pointAt(u, teamA.teamId);
    }
    for (const u of [teamB.ownerUserId, teamB.adminUserId, teamB.memberUserId, teamB.viewerUserId]) {
      await pointAt(u, teamB.teamId);
    }
    await pointAt(personal.userId, personal.teamId);
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  // ===========================================================================
  // Capture drafts
  // ===========================================================================
  describe("capture drafts (owner-scoped)", () => {
    async function createDraft(token: string) {
      const templates = json(await call("GET", "/v1/capture/intake-templates", token)).templates as Json[];
      expect(templates.length).toBeGreaterThan(0);
      const res = await call("POST", "/v1/capture/sessions", token, {
        templateId: templates[0].templateId,
        planMode: "FLEXIBLE",
        useLocation: false,
        items: [],
      });
      expect(res.statusCode, res.body).toBe(201);
      return { id: json(res).session.id as string, templateId: templates[0].templateId as string };
    }

    it("PATCH /v1/capture/sessions/:id — the owner's autosave persists notes, plan and items", async () => {
      const { teamA } = harness.fixtures;
      const draft = await createDraft(teamA.ownerToken);
      // The payload the web autosave builds (useCaptureDraftPersistence).
      const res = await call("PATCH", `/v1/capture/sessions/${draft.id}`, teamA.ownerToken, {
        templateId: draft.templateId,
        planMode: "CHECKLIST_REQUIRED",
        internalNotes: "Scene photographed from the north entrance.",
        useLocation: true,
        items: [
          {
            clientItemId: "item-1",
            fileName: "IMG_0001.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 2048,
            relativePath: null,
            role: null,
            privateNote: null,
            checklistStepId: null,
            sourceLabel: null,
            uploadState: "pending",
          },
        ],
      });
      expect(res.statusCode, res.body).toBe(200);

      const row = await prisma.captureSession.findUniqueOrThrow({ where: { id: draft.id } });
      expect(row.internalNotes).toBe("Scene photographed from the north entrance.");
      expect(row.planMode).toBe("CHECKLIST_REQUIRED");
      expect(row.useLocation).toBe(true);
      expect((row.itemsSnapshot as Json[]).map((i) => i.clientItemId)).toEqual(["item-1"]);
      // The web autosave always re-sends templateId, so the route classifies
      // the save as TEMPLATE_CHANGED and records the item count alongside.
      const event = await prisma.captureSessionEvent.findFirstOrThrow({
        where: { sessionId: draft.id, eventType: "TEMPLATE_CHANGED" },
      });
      expect(event.actorUserId).toBe(teamA.ownerUserId);
      expect(event.payload).toEqual({ templateChangedTo: draft.templateId, itemCount: 1 });
    });

    it("PATCH refuses another user's draft (403) and leaves it unchanged", async () => {
      const { teamA } = harness.fixtures;
      const draft = await createDraft(teamA.ownerToken);
      const res = await call("PATCH", `/v1/capture/sessions/${draft.id}`, teamA.adminToken, {
        internalNotes: "hijack",
      });
      expect(res.statusCode).toBe(403);
      expect(json(res)).toEqual({ message: "Forbidden" });
      const row = await prisma.captureSession.findUniqueOrThrow({ where: { id: draft.id } });
      expect(row.internalNotes).toBeNull();
      expect(await prisma.captureSessionEvent.count({ where: { sessionId: draft.id, actorUserId: teamA.adminUserId } })).toBe(0);
    });

    it("DELETE /v1/capture/sessions/:id — the owner discards the draft (no request body, as the web client sends)", async () => {
      const { teamA, teamB } = harness.fixtures;
      const draft = await createDraft(teamA.ownerToken);

      const foreign = await call("DELETE", `/v1/capture/sessions/${draft.id}`, teamB.ownerToken);
      expect(foreign.statusCode).toBe(403);
      expect((await prisma.captureSession.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("DRAFT");

      const res = await call("DELETE", `/v1/capture/sessions/${draft.id}`, teamA.ownerToken);
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.captureSession.findUniqueOrThrow({ where: { id: draft.id } });
      expect(row.status).toBe("DISCARDED");
      expect(row.discardedAtUtc).toBeInstanceOf(Date);
      const event = await prisma.captureSessionEvent.findFirstOrThrow({
        where: { sessionId: draft.id, eventType: "DISCARDED" },
      });
      expect(event.actorUserId).toBe(teamA.ownerUserId);

      // Terminal lock: the autosave PATCH is now refused with the bounded code.
      const locked = await call("PATCH", `/v1/capture/sessions/${draft.id}`, teamA.ownerToken, { internalNotes: "late" });
      expect(locked.statusCode).toBe(409);
      expect(json(locked).code).toBe("CAPTURE_SESSION_NOT_EDITABLE");
    });
  });

  // ===========================================================================
  // Capture trust — device registry + mobile ingest
  // ===========================================================================
  describe("capture trust", () => {
    const device = { id: "", key: null as ReturnType<typeof ed25519Key> | null };

    it("POST /v1/capture/devices — an organization member registers a device key (mobile payload)", async () => {
      const { teamA } = harness.fixtures;
      const key = ed25519Key();
      const res = await call("POST", "/v1/capture/devices", teamA.memberToken, {
        label: "Field phone 7",
        deviceModel: "ios-device",
        osVersion: "ios 18.2",
        appVersion: "1.4.0+42",
        signatureAlgorithm: "Ed25519",
        publicKeyHex: key.publicKeyHex,
        attestationProvider: "APPLE_APP_ATTEST",
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = json(res);
      const fingerprint = createHash("sha256").update(key.publicKeyHex).digest("hex");
      expect(body.publicKeyFingerprint).toBe(fingerprint);

      const row = await prisma.device.findUniqueOrThrow({ where: { id: body.deviceId } });
      expect(row).toMatchObject({
        teamId: teamA.teamId,
        ownerUserId: teamA.memberUserId,
        publicKeyHex: key.publicKeyHex,
        publicKeyFingerprint: fingerprint,
        signatureAlgorithm: "Ed25519",
        revokedAtUtc: null,
      });
      const event = await prisma.captureTrustEventRecord.findFirstOrThrow({
        where: { deviceId: body.deviceId, code: "CAPTURE_DEVICE_REGISTERED" },
      });
      expect(event.teamId).toBe(teamA.teamId);
      expect(event.eventHash).toMatch(/^[a-f0-9]{64}$/);
      device.id = body.deviceId;
      device.key = key;
    });

    it("POST /v1/capture/devices refuses a personal-space caller and a foreign workspace pointer, registering nothing", async () => {
      const { personal, teamA, teamB } = harness.fixtures;
      const key = ed25519Key();
      const payload = {
        label: "Personal phone",
        deviceModel: "android-device",
        osVersion: "android 15",
        appVersion: "1.4.0+42",
        signatureAlgorithm: "Ed25519",
        publicKeyHex: key.publicKeyHex,
        attestationProvider: "GOOGLE_PLAY_INTEGRITY",
      };
      const personalRes = await call("POST", "/v1/capture/devices", personal.token, payload);
      expect(personalRes.statusCode).toBe(403);
      expect(json(personalRes)).toEqual({ denial: "WORKSPACE_NOT_FOUND" });

      // A stale pointer naming a workspace the caller does not belong to.
      await pointAt(teamB.memberUserId, teamA.teamId);
      try {
        const foreign = await call("POST", "/v1/capture/devices", teamB.memberToken, payload);
        expect(foreign.statusCode).toBe(403);
        expect(json(foreign)).toEqual({ denial: "WORKSPACE_NOT_FOUND" });
      } finally {
        await pointAt(teamB.memberUserId, teamB.teamId);
      }
      const fingerprint = createHash("sha256").update(key.publicKeyHex).digest("hex");
      expect(await prisma.device.count({ where: { publicKeyFingerprint: fingerprint } })).toBe(0);
    });

    // UC-0 (main e341e5be) retired the receipt-only mobile ingest: it verified
    // an envelope but created no Evidence, so its trust chain could never reach
    // the record it described. The mobile app now opens a direct-capture
    // session. The route answers 410 and writes nothing.
    it("POST /v1/capture/mobile/ingest is retired (410 INGEST_RETIRED) and records nothing", async () => {
      const { teamA } = harness.fixtures;
      expect(device.id).not.toBe("");
      const before = await prisma.captureTrustEventRecord.count({ where: { teamId: teamA.teamId } });
      const res = await call("POST", "/v1/capture/mobile/ingest", teamA.memberToken, {
        payload: { deviceKeyId: device.id, captureSessionId: randomUUID() },
        signatureHex: "00",
        assetBase64: randomBytes(16).toString("base64"),
        attestation: null,
      });
      expect(res.statusCode, res.body).toBe(410);
      expect(json(res)).toEqual({ denial: "INGEST_RETIRED", replacement: "/v1/capture/direct-sessions" });
      expect(await prisma.captureTrustEventRecord.count({ where: { teamId: teamA.teamId } })).toBe(before);
    });

    it("POST /v1/capture/mobile/ingest still requires a session", async () => {
      const res = await call("POST", "/v1/capture/mobile/ingest", null, {});
      expect(res.statusCode).toBe(401);
    });
  });

  // ===========================================================================
  // Citizen capture (public, intake-link anchored)
  // ===========================================================================
  describe("citizen capture", () => {
    // UC-0 (main e341e5be) retired the citizen base64 capture path: bytes in a
    // JSON body never reach storage, createEvidence or completeEvidence any
    // more. Public submissions go through the secure intake link upload. Both
    // routes still apply the citizen rate limiter, then answer 410 and bind or
    // create nothing.
    let linkId = "";

    beforeAll(async () => {
      const { teamA } = harness.fixtures;
      linkId = (await prisma.workflowIntakeLink.create({
        data: {
          teamId: teamA.teamId,
          workflowTemplateSlug: "general-evidence-record",
          workflowTemplateVersion: 1,
          workflowTemplateSnapshot: {},
          intakeMode: "EXTERNAL_SINGLE_USE",
          expiresAtUtc: new Date(Date.now() + 24 * 3600 * 1000),
          createdByUserId: teamA.ownerUserId,
          allowedAcceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
          ipAllowlistCidrs: [],
          tokenHash: randomBytes(32).toString("hex"),
        },
        select: { id: true },
      })).id;
    });

    const RETIRED = { denial: "CITIZEN_CAPTURE_RETIRED", replacement: "/intake/{token}" };
    // The citizen rate limiter runs BEFORE the 410 (by design) and its per-IP
    // bucket is shared by every suite in a run, so each request here comes from
    // its own IPv6 documentation address (RFC 3849), unique per request so no
    // other suite's exhausted IPv4 bucket can be hit — nothing is dialled.
    const freshClient = () => `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`;

    it("POST /v1/intake/citizen/sessions is retired (410) and binds no key, even for a live link", async () => {
      const key = ed25519Key();
      const res = await call("POST", "/v1/intake/citizen/sessions", null, {
        intakeTokenId: linkId,
        publicKeyHex: key.publicKeyHex,
        userAgent: "Mozilla/5.0 (fixture)",
      }, freshClient());
      expect(res.statusCode, res.body).toBe(410);
      expect(json(res)).toEqual(RETIRED);
      const fingerprint = createHash("sha256").update(key.publicKeyHex).digest("hex");
      expect(await prisma.device.count({ where: { publicKeyFingerprint: fingerprint } })).toBe(0);
    });

    it("POST /v1/intake/citizen/sessions/:id/capture is retired (410) and creates no Evidence or stored object", async () => {
      const { teamA } = harness.fixtures;
      const before = await prisma.evidence.count({ where: { teamId: teamA.teamId } });
      const putsBefore = objectStore.puts.length;
      const res = await call("POST", `/v1/intake/citizen/sessions/${randomUUID()}/capture`, null, {
        payload: { captureMode: "CITIZEN_PWA" },
        signatureHex: "00",
        assetBase64: Buffer.from("citizen-capture").toString("base64"),
      }, freshClient());
      expect(res.statusCode, res.body).toBe(410);
      expect(json(res)).toEqual(RETIRED);
      expect(await prisma.evidence.count({ where: { teamId: teamA.teamId } })).toBe(before);
      expect(objectStore.puts.length).toBe(putsBefore);
    });
  });

  // ===========================================================================
  // Legacy batch analysis
  // ===========================================================================
  describe("batch analysis", () => {
    it("POST /v1/batch-analysis — the evidence owner creates a job; the audit row is durable", async () => {
      const { teamA } = harness.fixtures;
      const res = await call("POST", "/v1/batch-analysis", teamA.ownerToken, {
        evidenceIds: [teamA.evidenceId],
        name: "Morning intake review",
        description: "Scene photos",
      });
      expect(res.statusCode, res.body).toBe(200);
      const job = json(res).data;
      expect(job).toMatchObject({ name: "Morning intake review", status: "pending", totalItems: 1 });

      const read = await call("GET", `/v1/batch-analysis/${job.id}`, teamA.ownerToken);
      expect(read.statusCode, read.body).toBe(200);
      expect(JSON.stringify(json(read))).toContain(job.id);

      await vi.waitFor(
        async () => {
          const audit = await prisma.adminAuditLog.findFirst({
            where: { action: "enterprise.batch_create", resourceId: job.id },
          });
          expect(audit).not.toBeNull();
          expect(audit).toMatchObject({ userId: teamA.ownerUserId, outcome: "success", resourceType: "batch_job" });
        },
        { timeout: 5_000, interval: 50 },
      );
    });

    it("POST /v1/batch-analysis refuses evidence the caller does not own (404) and records the denial", async () => {
      const { teamA } = harness.fixtures;
      const res = await call("POST", "/v1/batch-analysis", teamA.memberToken, {
        evidenceIds: [teamA.evidenceId],
        name: "Not mine",
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain("EVIDENCE_NOT_FOUND");
      await vi.waitFor(
        async () => {
          const denied = await prisma.adminAuditLog.findFirst({
            where: { action: "enterprise.batch_create", userId: teamA.memberUserId },
          });
          expect(denied?.outcome).toBe("denied");
        },
        { timeout: 5_000, interval: 50 },
      );
      expect(
        await prisma.adminAuditLog.count({
          where: { action: "enterprise.batch_create", userId: teamA.memberUserId, outcome: "success" },
        }),
      ).toBe(0);
    });
  });

  // ===========================================================================
  // Reviewer corrections
  // ===========================================================================
  describe("intelligence corrections", () => {
    let recordId = "";
    beforeAll(async () => {
      const { teamA } = harness.fixtures;
      recordId = (await prisma.mediaIntelligenceRecord.create({
        data: {
          teamId: teamA.teamId,
          evidenceId: teamA.evidenceId,
          modality: "IMAGE",
          kind: "OCR_TEXT",
          provider: "fixture",
          state: "COMPLETED",
          providerRecordKey: `k3-${randomUUID()}`,
          payload: { text: "INVOCE 1042" },
        },
        select: { id: true },
      })).id;
    });

    it("POST /v1/intelligence/corrections — a reviewer proposes a correction (web payload)", async () => {
      const { teamA } = harness.fixtures;
      const res = await call("POST", "/v1/intelligence/corrections", teamA.memberToken, {
        recordId,
        kind: "OCR_TEXT",
        patch: { text: "INVOICE 1042" },
        rationale: "OCR dropped a letter.",
      });
      expect(res.statusCode, res.body).toBe(201);
      const { correctionId } = json(res);
      const row = await prisma.reviewerCorrection.findUniqueOrThrow({ where: { id: correctionId } });
      expect(row).toMatchObject({
        teamId: teamA.teamId,
        recordId,
        kind: "OCR_TEXT",
        state: "DRAFT",
        authoredByUserId: teamA.memberUserId,
        versionNumber: 1,
        rationale: "OCR dropped a letter.",
      });
      expect(row.patch).toEqual({ text: "INVOICE 1042" });
      const event = await prisma.intelligenceActivityEvent.findFirstOrThrow({
        where: { correctionId, code: "CORRECTION_CREATED" },
      });
      expect(event).toMatchObject({ teamId: teamA.teamId, actorUserId: teamA.memberUserId, recordId });
    });

    it("POST /v1/intelligence/corrections refuses a viewer (403) and another tenant's record (409), writing nothing", async () => {
      const { teamA, teamB } = harness.fixtures;
      const before = await prisma.reviewerCorrection.count({ where: { recordId } });
      const body = { recordId, kind: "OCR_TEXT", patch: { text: "x" } };
      const viewer = await call("POST", "/v1/intelligence/corrections", teamA.viewerToken, body);
      expect(viewer.statusCode).toBe(403);
      expect(json(viewer)).toEqual({ error: { code: "permission_denied", reason: "permission_not_granted" } });
      const foreign = await call("POST", "/v1/intelligence/corrections", teamB.ownerToken, body);
      expect(foreign.statusCode).toBe(409);
      expect(json(foreign)).toEqual({ denial: "RECORD_NOT_FOUND" });
      expect(await prisma.reviewerCorrection.count({ where: { recordId } })).toBe(before);
    });
  });

  // ===========================================================================
  // Resumable upload parts
  // ===========================================================================
  describe("resumable upload parts", () => {
    let sessionId = "";
    type PartRow = { state: string; part_etag: string | null; part_size_bytes: bigint | number | null; server_sha256: string | null; verified_at_utc: Date | null; presigned_at_utc: Date | null };
    const part = async (index: number) =>
      ((await prisma.$queryRawUnsafe(
        `SELECT "state", "part_etag", "part_size_bytes", "server_sha256", "verified_at_utc", "presigned_at_utc"
           FROM "evidence_upload_session_parts" WHERE "session_id" = $1::uuid AND "part_index" = $2`,
        sessionId,
        index,
      )) as PartRow[])[0]!;

    beforeAll(async () => {
      const { teamA } = harness.fixtures;
      // The payload the capture orchestrator sends.
      const res = await call("POST", "/v1/uploads/sessions", teamA.ownerToken, {
        teamId: teamA.teamId,
        evidenceId: teamA.evidenceId,
        expectedPartCount: 3,
        idempotencyKey: `capture:${teamA.evidenceId}:0`,
        targetPartIndex: 0,
        originalFileName: "scene.jpg",
        expectedMimeType: "image/jpeg",
      });
      expect(res.statusCode, res.body).toBe(201);
      sessionId = json(res).session.id;
      // The S3 CreateMultipartUpload outcome `/multipart/initiate` would
      // persist — seeded, because no object store listens in this fixture.
      await prisma.$executeRawUnsafe(
        `UPDATE "evidence_upload_sessions"
            SET "state" = 'UPLOADING', "multipart_upload_id" = $2,
                "storage_bucket" = 'point7-local-bucket', "storage_key" = $3
          WHERE "id" = $1::uuid`,
        sessionId,
        `k3-upload-${randomUUID()}`,
        `evidence/${teamA.evidenceId}/k3-scene.jpg`,
      );
    });

    it("POST .../parts/:partIndex/presign — mints a part URL and records the presign", async () => {
      const { teamA } = harness.fixtures;
      const res = await call("POST", `/v1/uploads/sessions/${sessionId}/parts/0/presign`, teamA.ownerToken, {
        teamId: teamA.teamId,
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = json(res);
      expect(body).toMatchObject({ method: "PUT", partIndex: 0 });
      const url = new URL(body.uploadUrl);
      expect(url.searchParams.get("partNumber")).toBe("1");
      expect(url.searchParams.get("uploadId")).toMatch(/^k3-upload-/);
      expect(JSON.stringify(body)).not.toContain("point7-local-bucket\"");
      expect((await part(0)).presigned_at_utc).toBeInstanceOf(Date);
    });

    it("POST .../parts/:partIndex/uploaded — records the ETag and moves the part to UPLOADED_UNVERIFIED", async () => {
      const { teamA } = harness.fixtures;
      const res = await call("POST", `/v1/uploads/sessions/${sessionId}/parts/0/uploaded`, teamA.ownerToken, {
        teamId: teamA.teamId,
        partEtag: '"9b2cf535f27731c974343645a3985328"',
        partSizeBytes: 5_242_880,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).part).toMatchObject({ partIndex: 0, state: "UPLOADED_UNVERIFIED" });
      const row = await part(0);
      expect(row.state).toBe("UPLOADED_UNVERIFIED");
      expect(row.part_etag).toBe('"9b2cf535f27731c974343645a3985328"');
      expect(Number(row.part_size_bytes)).toBe(5_242_880);
    });

    it("POST .../parts/:partIndex/verified — only the internal service may report the server hash (D3)", async () => {
      const { teamA } = harness.fixtures;
      const serverSha256 = createHash("sha256").update("part-0-bytes").digest("hex");
      const url = `/v1/uploads/sessions/${sessionId}/parts/0/verified`;
      const payload = { teamId: teamA.teamId, serverSha256 };

      // The uploader's own session can no longer vouch for the hash.
      const owner = await call("POST", url, teamA.ownerToken, payload);
      expect(owner.statusCode, owner.body).toBe(401);
      expect((await part(0)).state).toBe("UPLOADED_UNVERIFIED");

      const token = "d3-internal-service-token-for-tests";
      process.env.INTERNAL_SERVICE_TOKEN = token;
      try {
        const wrong = await harness.app.inject({
          method: "POST",
          url,
          headers: { "content-type": "application/json", "x-internal-service-token": "not-the-token-value" },
          payload,
        });
        expect(wrong.statusCode).toBe(401);
        const res = await harness.app.inject({
          method: "POST",
          url,
          headers: { "content-type": "application/json", "x-internal-service-token": token },
          payload,
        });
        expect(res.statusCode, res.body).toBe(200);
      } finally {
        delete process.env.INTERNAL_SERVICE_TOKEN;
      }
      const row = await part(0);
      expect(row.state).toBe("VERIFIED");
      expect(row.server_sha256).toBe(serverSha256);
      expect(row.verified_at_utc).toBeInstanceOf(Date);
    });

    it("the user part routes refuse a viewer (403) and conceal the session from another tenant (404); verified refuses every user session; part 1 is untouched", async () => {
      const { teamA, teamB } = harness.fixtures;
      const sha = createHash("sha256").update("x").digest("hex");
      const bodies: Array<[string, Json]> = [
        ["presign", { teamId: teamA.teamId }],
        ["uploaded", { teamId: teamA.teamId, partEtag: '"e"' }],
      ];
      // D3 — machine-only: any user session, member or not, is 401.
      for (const token of [teamA.viewerToken, teamB.ownerToken]) {
        const verified = await call("POST", `/v1/uploads/sessions/${sessionId}/parts/1/verified`, token, {
          teamId: teamA.teamId,
          serverSha256: sha,
        });
        expect(verified.statusCode, verified.body).toBe(401);
      }
      for (const [action, payload] of bodies) {
        // A viewer is a member without evidence.create.
        const viewer = await call("POST", `/v1/uploads/sessions/${sessionId}/parts/1/${action}`, teamA.viewerToken, payload);
        expect(viewer.statusCode, `${action}: ${viewer.body}`).toBe(403);
        expect(json(viewer)).toEqual({ error: { code: "permission_denied", reason: "permission_not_granted" } });
        // A non-member is concealed.
        const foreign = await call("POST", `/v1/uploads/sessions/${sessionId}/parts/1/${action}`, teamB.ownerToken, payload);
        expect(foreign.statusCode, `${action}: ${foreign.body}`).toBe(404);
        expect(json(foreign)).toEqual({ error: { code: "not_found" } });
      }
      // A foreign owner naming THEIR OWN workspace still cannot reach this session.
      const own = await call("POST", `/v1/uploads/sessions/${sessionId}/parts/1/presign`, teamB.ownerToken, {
        teamId: teamB.teamId,
      });
      expect(own.statusCode).toBe(404);
      const row = await part(1);
      expect(row).toMatchObject({ state: "PENDING", part_etag: null, server_sha256: null, presigned_at_utc: null });
    });
  });

  // ===========================================================================
  // AI — the provider is the in-process fake declared above
  // ===========================================================================
  describe("AI routes (fake provider)", () => {
    beforeEach(() => {
      enableFixtureAi();
    });

    beforeAll(async () => {
      const { teamA, teamB } = harness.fixtures;
      await prisma.workspaceAiPolicy.upsert({
        where: { teamId: teamA.teamId },
        create: { teamId: teamA.teamId, caseCopilotEnabled: true },
        update: { caseCopilotEnabled: true },
      });
      // Organization B's administrators turned the assistant off.
      await prisma.workspaceAiPolicy.upsert({
        where: { teamId: teamB.teamId },
        create: { teamId: teamB.teamId, supportChatEnabled: false, captureAssistanceEnabled: false },
        update: { supportChatEnabled: false, captureAssistanceEnabled: false },
      });
    });

    it("POST /v1/ai/chat — a provider answer is served, metered and audited", async () => {
      const { teamA } = harness.fixtures;
      const callsBefore = openaiFake.calls.length;
      const res = await call("POST", "/v1/ai/chat", teamA.memberToken, {
        messages: [{ role: "user", content: "Where do I see the records waiting for my decision?" }],
        pageContext: { path: "/evidence", routeClass: "evidence" },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).data).toMatchObject({ status: "ok" });
      expect(openaiFake.calls.slice(callsBefore)).toEqual([{ schema: "proovra_ai_result", store: false }]);

      const usage = await prisma.aiUsageEvent.findFirstOrThrow({
        where: { workspaceId: teamA.teamId, userId: teamA.memberUserId, feature: "SUPPORT_CHAT" },
      });
      expect(usage.status).not.toBe("RESERVED");
      const counter = await prisma.entitlementUsage.findFirstOrThrow({
        where: { teamId: teamA.teamId, key: "ai_advisory_operations" },
      });
      expect(Number(counter.consumed)).toBeGreaterThanOrEqual(1);
      await vi.waitFor(
        async () => {
          const audit = await prisma.adminAuditLog.findFirst({
            where: { action: "ai.chat_request", userId: teamA.memberUserId },
          });
          expect(audit).toMatchObject({ outcome: "success", workspaceId: teamA.teamId });
        },
        { timeout: 5_000, interval: 50 },
      );
    });

    it("POST /v1/ai/chat honours a workspace opt-out (403 FEATURE_DISABLED) without a provider call", async () => {
      const { teamB } = harness.fixtures;
      const callsBefore = openaiFake.calls.length;
      const res = await call("POST", "/v1/ai/chat", teamB.memberToken, {
        messages: [{ role: "user", content: "Where do I see the records waiting for my decision?" }],
      });
      expect(res.statusCode).toBe(403);
      expect(json(res)).toMatchObject({ code: "AI_WORKSPACE_POLICY_DENIED", decision: "FEATURE_DISABLED" });
      expect(openaiFake.calls.length).toBe(callsBefore);
      expect(await prisma.aiUsageEvent.count({ where: { userId: teamB.memberUserId } })).toBe(0);
    });

    function capturePayload(planId: string) {
      // The web capture assistant sends the intake-template collection plan.
      return {
        collectionPlan: {
          id: planId,
          name: "Vehicle damage",
          description: "Photos of each damaged panel.",
          locationRequirement: "recommended",
          steps: [
            { id: "overview", title: "Overview", description: "Whole vehicle.", purposeLabel: "Context", required: true, acceptedKinds: ["PHOTO"] },
          ],
        },
        planMode: "CHECKLIST_REQUIRED",
        useLocation: false,
        items: [
          {
            id: "item-1",
            fileName: "IMG_0001.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 4096,
            checklistStepId: "overview",
            clientSignals: { duplicateStatus: "none", screenshotLike: false },
          },
        ],
      };
    }

    it("POST /v1/ai/capture/analyze-session — the capture review is served, metered and audited", async () => {
      const { teamA } = harness.fixtures;
      const planId = `k3-plan-${randomUUID()}`;
      const callsBefore = openaiFake.calls.length;
      const res = await call("POST", "/v1/ai/capture/analyze-session", teamA.memberToken, capturePayload(planId));
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res).data.status).toBe("ok");
      expect(openaiFake.calls.slice(callsBefore)).toEqual([{ schema: "proovra_ai_result", store: false }]);
      const usage = await prisma.aiUsageEvent.findFirstOrThrow({
        where: { workspaceId: teamA.teamId, userId: teamA.memberUserId, feature: "CAPTURE_ASSISTANCE" },
      });
      expect(usage.status).not.toBe("RESERVED");
      await vi.waitFor(
        async () => {
          const audit = await prisma.adminAuditLog.findFirst({
            where: { action: "ai.capture_session_review", resourceId: planId },
          });
          expect(audit).toMatchObject({ outcome: "success", userId: teamA.memberUserId, workspaceId: teamA.teamId });
        },
        { timeout: 5_000, interval: 50 },
      );
    });

    it("POST /v1/ai/capture/analyze-session honours a workspace opt-out (403) without a provider call", async () => {
      const { teamB } = harness.fixtures;
      const callsBefore = openaiFake.calls.length;
      const res = await call("POST", "/v1/ai/capture/analyze-session", teamB.memberToken, capturePayload(`k3-plan-${randomUUID()}`));
      expect(res.statusCode).toBe(403);
      expect(json(res)).toMatchObject({ code: "AI_WORKSPACE_POLICY_DENIED", decision: "FEATURE_DISABLED" });
      expect(openaiFake.calls.length).toBe(callsBefore);
      expect(await prisma.aiUsageEvent.count({ where: { userId: teamB.memberUserId, feature: "CAPTURE_ASSISTANCE" } })).toBe(0);
    });

    describe("case copilot", () => {
      let evidenceIds: string[] = [];
      async function revisions(caseId: string, teamId: string) {
        const { loadEvidenceAnalysisSnapshots } = await import("../src/services/ai/evidence-analysis-snapshot.service.js");
        const snaps = await loadEvidenceAnalysisSnapshots({ ids: evidenceIds, teamId, scope: { scope: "case", scopeId: caseId } });
        return Object.fromEntries(snaps.map((s) => [s.row.id, s.revision]));
      }

      beforeAll(async () => {
        const { teamA } = harness.fixtures;
        const team = await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } });
        evidenceIds = [];
        for (const title of ["Front bumper", "Rear door"]) {
          const ev = await prisma.evidence.create({
            data: {
              title,
              type: "PHOTO",
              status: "SIGNED",
              mimeType: "image/jpeg",
              teamId: teamA.teamId,
              organizationId: team.organizationId,
              ownerUserId: teamA.ownerUserId,
            },
            select: { id: true },
          });
          await prisma.caseEvidenceLink.create({
            data: { teamId: teamA.teamId, caseId: teamA.caseId, evidenceId: ev.id, linkedByUserId: teamA.ownerUserId },
          });
          evidenceIds.push(ev.id);
        }
      });

      it("POST /v1/ai/case/:caseId/copilot — a reviewer's run is grounded, persisted and audited", async () => {
        const { teamA } = harness.fixtures;
        const selectedEvidenceRevisions = await revisions(teamA.caseId, teamA.teamId);
        const callsBefore = openaiFake.calls.length;
        const res = await call("POST", `/v1/ai/case/${teamA.caseId}/copilot`, teamA.memberToken, {
          selectedEvidenceIds: evidenceIds,
          selectedEvidenceRevisions,
          processingMode: "METADATA_ONLY",
        });
        expect(res.statusCode, res.body).toBe(200);
        const body = json(res);
        expect(body.data.status).toBe("ok");
        expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
        expect(openaiFake.calls.slice(callsBefore)).toEqual([{ schema: "proovra_case_copilot", store: false }]);

        const run = await prisma.aiCopilotRun.findUniqueOrThrow({ where: { id: body.runId } });
        expect(run).toMatchObject({
          workspaceId: teamA.teamId,
          userId: teamA.memberUserId,
          feature: "CASE_COPILOT",
          caseId: teamA.caseId,
          status: "ok",
          processingMode: "METADATA_ONLY",
        });
        expect(JSON.stringify(run.selectedObjectVersionsJson)).toContain(evidenceIds[0]);
        const audit = await prisma.adminAuditLog.findFirstOrThrow({
          where: { action: "ai.case_copilot", resourceId: teamA.caseId, userId: teamA.memberUserId },
          orderBy: { createdAt: "desc" },
        });
        expect(audit).toMatchObject({ outcome: "success", workspaceId: teamA.teamId, resourceType: "case" });
      });

      it("POST /v1/ai/case/:caseId/copilot conceals the case from another tenant and refuses a viewer, with no run", async () => {
        const { teamA, teamB } = harness.fixtures;
        const selectedEvidenceRevisions = await revisions(teamA.caseId, teamA.teamId);
        const before = await prisma.aiCopilotRun.count({ where: { caseId: teamA.caseId } });
        const callsBefore = openaiFake.calls.length;
        const body = { selectedEvidenceIds: evidenceIds, selectedEvidenceRevisions, processingMode: "METADATA_ONLY" };
        const foreign = await call("POST", `/v1/ai/case/${teamA.caseId}/copilot`, teamB.ownerToken, body);
        expect(foreign.statusCode).toBe(404);
        expect(foreign.body).not.toContain(teamA.caseId);
        const viewer = await call("POST", `/v1/ai/case/${teamA.caseId}/copilot`, teamA.viewerToken, body);
        expect(viewer.statusCode, viewer.body).toBe(403);
        expect(json(viewer)).toEqual({ error: { code: "permission_denied", reason: "permission_not_granted" } });
        expect(openaiFake.calls.length).toBe(callsBefore);
        expect(await prisma.aiCopilotRun.count({ where: { caseId: teamA.caseId } })).toBe(before);
      });
    });
  });
});
