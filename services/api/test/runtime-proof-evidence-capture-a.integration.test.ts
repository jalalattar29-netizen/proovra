/**
 * BATCH K3 — runtime proof, evidence capture cluster (part A).
 *
 * Capture drafts, capture-trust devices + mobile ingest, citizen capture,
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

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as edSign } from "node:crypto";
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
  let canonicalJson: (value: unknown) => string;

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string | null, payload?: unknown) =>
    harness.app.inject({
      method,
      url,
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
    ({ canonicalJson } = (await import("@proovra/shared")) as unknown as {
      canonicalJson: (value: unknown) => string;
    });

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

    function signedEnvelope(deviceId: string, key: ReturnType<typeof ed25519Key>, provenanceClass: "A" | "B") {
      const asset = randomBytes(256);
      const payload = {
        schemaVersion: "PROOVRA_CAPTURE_SIG_V1" as const,
        assetHash: createHash("sha256").update(asset).digest("hex"),
        captureMode: "OPERATOR_NATIVE" as const,
        provenanceClass,
        deviceKeyId: deviceId,
        algorithm: "Ed25519" as const,
        captureSessionId: randomUUID(),
        signedAtUtc: new Date().toISOString(),
        signedAtMonotonicNs: "123456789000",
        nonceHex: randomBytes(32).toString("hex"),
        metadata: {
          deviceModel: "ios-device",
          osVersion: "ios 18.2",
          appVersion: "1.4.0+42",
          networkState: "ONLINE" as const,
          locationPolicy: "OFF" as const,
          location: null,
          camera: { facing: "BACK" as const, flashOn: false, focalLengthMm: null, iso: null },
          sensor: null,
          operatorContext: null,
        },
      };
      // The mobile client signs the shared canonical JSON of the payload.
      const signature = edSign(null, Buffer.from(canonicalJson(payload), "utf8"), key.privateKey);
      return {
        payload,
        signatureHex: signature.toString("hex"),
        assetBase64: asset.toString("base64"),
        attestation: null,
      };
    }

    it("POST /v1/capture/mobile/ingest — a signed capture is verified and recorded on the trust chain", async () => {
      const { teamA } = harness.fixtures;
      expect(device.id).not.toBe("");
      const envelope = signedEnvelope(device.id, device.key!, "A");
      const res = await call("POST", "/v1/capture/mobile/ingest", teamA.memberToken, envelope);
      expect(res.statusCode, res.body).toBe(202);
      const receipt = json(res).receipt;
      expect(receipt).toMatchObject({
        signatureVerdict: "VALID",
        attestationVerdict: "NOT_ATTEMPTED",
        // Class A without strong attestation is demoted to B, and says so.
        provenanceClass: "B",
        denialReason: null,
      });
      expect(receipt.warnings).toContain("CAPTURE_PROVENANCE_DOWNGRADED");

      const events = await prisma.captureTrustEventRecord.findMany({
        where: { teamId: teamA.teamId, captureSessionId: envelope.payload.captureSessionId },
        orderBy: { sequence: "asc" },
      });
      expect(events.map((e) => e.code)).toEqual(["CAPTURE_ARTIFACT_RECEIVED", "CAPTURE_ARTIFACT_SIGNED_AT_SOURCE"]);
      expect(events[0]!.deviceId).toBe(device.id);
      expect(events[0]!.payload).toMatchObject({
        assetHash: envelope.payload.assetHash,
        signatureVerdict: "VALID",
        provenanceClass: "B",
      });
      expect(events[1]!.prevEventHash).toBe(events[0]!.eventHash);
    });

    it("POST /v1/capture/mobile/ingest refuses another tenant's device (409 DEVICE_NOT_REGISTERED), recording no receipt", async () => {
      const { teamB } = harness.fixtures;
      const envelope = signedEnvelope(device.id, device.key!, "B");
      const res = await call("POST", "/v1/capture/mobile/ingest", teamB.ownerToken, envelope);
      expect(res.statusCode).toBe(409);
      expect(json(res).receipt).toMatchObject({ denialReason: "DEVICE_NOT_REGISTERED", signatureVerdict: "MISSING" });
      const events = await prisma.captureTrustEventRecord.findMany({
        where: { captureSessionId: envelope.payload.captureSessionId },
      });
      expect(events.map((e) => e.code)).toEqual(["CAPTURE_ARTIFACT_VERIFICATION_FAILED"]);
      expect(events[0]!.teamId).toBe(teamB.teamId);
    });
  });

  // ===========================================================================
  // Citizen capture (public, intake-link anchored)
  // ===========================================================================
  describe("citizen capture", () => {
    let linkId = "";
    let revokedLinkId = "";
    const session = { deviceId: "", captureSessionId: "", key: null as ReturnType<typeof ed25519Key> | null };

    beforeAll(async () => {
      const { teamA } = harness.fixtures;
      const base = {
        teamId: teamA.teamId,
        workflowTemplateSlug: "general-evidence-record",
        workflowTemplateVersion: 1,
        workflowTemplateSnapshot: {},
        intakeMode: "EXTERNAL_SINGLE_USE",
        expiresAtUtc: new Date(Date.now() + 24 * 3600 * 1000),
        createdByUserId: teamA.ownerUserId,
        allowedAcceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
        ipAllowlistCidrs: [],
      };
      linkId = (await prisma.workflowIntakeLink.create({
        data: { ...base, tokenHash: randomBytes(32).toString("hex") },
        select: { id: true },
      })).id;
      revokedLinkId = (await prisma.workflowIntakeLink.create({
        data: { ...base, tokenHash: randomBytes(32).toString("hex"), revokedAtUtc: new Date(), status: "REVOKED" },
        select: { id: true },
      })).id;
    });

    it("POST /v1/intake/citizen/sessions — an intake link opens a session and binds the ephemeral key", async () => {
      const { teamA } = harness.fixtures;
      const key = ed25519Key();
      const res = await call("POST", "/v1/intake/citizen/sessions", null, {
        intakeTokenId: linkId,
        publicKeyHex: key.publicKeyHex,
        userAgent: "Mozilla/5.0 (fixture)",
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = json(res);
      expect(body.descriptor).toMatchObject({
        teamId: teamA.teamId,
        captureMode: "CITIZEN_PWA",
        provenanceClassCeiling: "B",
      });
      const row = await prisma.device.findUniqueOrThrow({ where: { id: body.deviceId } });
      expect(row).toMatchObject({
        teamId: teamA.teamId,
        ownerUserId: teamA.ownerUserId,
        publicKeyHex: key.publicKeyHex,
        attestationProvider: "NONE",
        revokedAtUtc: null,
      });
      expect(
        await prisma.captureTrustEventRecord.count({ where: { deviceId: body.deviceId, code: "CAPTURE_DEVICE_REGISTERED" } }),
      ).toBe(1);
      session.deviceId = body.deviceId;
      session.captureSessionId = body.descriptor.captureSessionId;
      session.key = key;
    });

    it("POST /v1/intake/citizen/sessions refuses a revoked link (403 SESSION_NOT_ACTIVE) and binds no key", async () => {
      const key = ed25519Key();
      const res = await call("POST", "/v1/intake/citizen/sessions", null, {
        intakeTokenId: revokedLinkId,
        publicKeyHex: key.publicKeyHex,
      });
      expect(res.statusCode).toBe(403);
      expect(json(res)).toEqual({ denial: "SESSION_NOT_ACTIVE" });
      const fingerprint = createHash("sha256").update(key.publicKeyHex).digest("hex");
      expect(await prisma.device.count({ where: { publicKeyFingerprint: fingerprint } })).toBe(0);
    });

    function citizenEnvelope(deviceId: string, captureSessionId: string, key: ReturnType<typeof ed25519Key>) {
      const asset = Buffer.from(`citizen-capture-${randomUUID()}`);
      const payload = {
        schemaVersion: "PROOVRA_CAPTURE_SIG_V1" as const,
        assetHash: createHash("sha256").update(asset).digest("hex"),
        captureMode: "CITIZEN_PWA" as const,
        provenanceClass: "B" as const,
        deviceKeyId: deviceId,
        algorithm: "Ed25519" as const,
        captureSessionId,
        signedAtUtc: new Date().toISOString(),
        signedAtMonotonicNs: "987654321000",
        nonceHex: randomBytes(32).toString("hex"),
        metadata: {
          deviceModel: "browser",
          osVersion: "web",
          appVersion: "pwa-1.0",
          networkState: "ONLINE" as const,
          locationPolicy: "OFF" as const,
          location: null,
          camera: null,
          sensor: null,
          operatorContext: null,
        },
      };
      const signature = edSign(null, Buffer.from(canonicalJson(payload), "utf8"), key.privateKey);
      return { asset, body: { payload, signatureHex: signature.toString("hex"), assetBase64: asset.toString("base64") } };
    }

    it("POST /v1/intake/citizen/sessions/:id/capture — a signed citizen capture materialises signed Evidence", async () => {
      const { teamA } = harness.fixtures;
      expect(session.deviceId).not.toBe("");
      const { asset, body } = citizenEnvelope(session.deviceId, session.captureSessionId, session.key!);
      const res = await call("POST", `/v1/intake/citizen/sessions/${session.captureSessionId}/capture`, null, body);
      expect(res.statusCode, res.body).toBe(202);
      const receipt = json(res).receipt;
      expect(receipt).toMatchObject({ provenanceClass: "B", signatureVerdict: "VALID", denialReason: null });
      expect(receipt.evidenceId).toMatch(/^[0-9a-f-]{36}$/);

      const evidence = await prisma.evidence.findUniqueOrThrow({ where: { id: receipt.evidenceId } });
      expect(evidence.teamId).toBe(teamA.teamId);
      expect(evidence.ownerUserId).toBe(teamA.ownerUserId);
      expect(evidence.status).toBe("SIGNED");
      expect(evidence.fileSha256).toBe(createHash("sha256").update(asset).digest("hex"));
      expect(objectStore.puts).toContain(`${evidence.storageBucket}/${evidence.storageKey}`);

      const joined = await prisma.captureTrustEventRecord.findFirstOrThrow({
        where: { evidenceId: receipt.evidenceId, captureSessionId: session.captureSessionId },
      });
      expect(joined.code).toBe("CAPTURE_ARTIFACT_RECEIVED");
      expect(joined.payload).toMatchObject({ stage: "evidence_materialised", citizen: true });
      expect(
        await prisma.custodyEvent.count({ where: { evidenceId: receipt.evidenceId, eventType: "SIGNATURE_APPLIED" } }),
      ).toBe(1);
    });

    it("POST .../capture refuses a revoked session key (409 DEVICE_REVOKED) and creates no Evidence", async () => {
      const { teamA } = harness.fixtures;
      const key = ed25519Key();
      const opened = json(
        await call("POST", "/v1/intake/citizen/sessions", null, { intakeTokenId: linkId, publicKeyHex: key.publicKeyHex }),
      );
      await prisma.device.update({ where: { id: opened.deviceId }, data: { revokedAtUtc: new Date() } });
      const before = await prisma.evidence.count({ where: { teamId: teamA.teamId } });
      const { body } = citizenEnvelope(opened.deviceId, opened.descriptor.captureSessionId, key);
      const res = await call("POST", `/v1/intake/citizen/sessions/${opened.descriptor.captureSessionId}/capture`, null, body);
      expect(res.statusCode).toBe(409);
      expect(json(res)).toEqual({ denial: "DEVICE_REVOKED" });
      expect(await prisma.evidence.count({ where: { teamId: teamA.teamId } })).toBe(before);
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

    it("POST .../parts/:partIndex/verified — the server hash moves the part to VERIFIED", async () => {
      const { teamA } = harness.fixtures;
      const serverSha256 = createHash("sha256").update("part-0-bytes").digest("hex");
      const res = await call("POST", `/v1/uploads/sessions/${sessionId}/parts/0/verified`, teamA.ownerToken, {
        teamId: teamA.teamId,
        serverSha256,
      });
      expect(res.statusCode, res.body).toBe(200);
      const row = await part(0);
      expect(row.state).toBe("VERIFIED");
      expect(row.server_sha256).toBe(serverSha256);
      expect(row.verified_at_utc).toBeInstanceOf(Date);
    });

    it("the three part routes refuse a viewer (403) and conceal the session from another tenant (404), leaving part 1 untouched", async () => {
      const { teamA, teamB } = harness.fixtures;
      const sha = createHash("sha256").update("x").digest("hex");
      const bodies: Array<[string, Json]> = [
        ["presign", { teamId: teamA.teamId }],
        ["uploaded", { teamId: teamA.teamId, partEtag: '"e"' }],
        ["verified", { teamId: teamA.teamId, serverSha256: sha }],
      ];
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
      const own2 = await call("POST", `/v1/uploads/sessions/${sessionId}/parts/1/verified`, teamB.ownerToken, {
        teamId: teamB.teamId,
        serverSha256: sha,
      });
      expect(own2.statusCode).toBe(400);
      expect(json(own2).error).toMatchObject({ code: "upload_session_denied", reason: "invalid_part_index" });
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
