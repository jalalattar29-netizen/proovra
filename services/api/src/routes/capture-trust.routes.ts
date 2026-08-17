/**
 * Phase 1B — Capture Trust routes.
 *
 *   POST   /v1/capture/devices                       — register a device
 *   GET    /v1/capture/devices                       — list workspace devices
 *   GET    /v1/capture/devices/:id                   — read single device
 *   POST   /v1/capture/devices/:id/revoke            — revoke a device
 *
 *   POST   /v1/capture/mobile/ingest                 — mobile ingest with signature + attestation
 *
 *   GET    /v1/capture/sessions/:id/trust-timeline   — trust event timeline for a session
 *
 *   GET    /v1/provenance/:evidenceId                — bounded ProvenanceChain projection
 *
 * Hard rules:
 *   * Every authenticated route requires a workspace context (teamId);
 *     personal-space callers receive a bounded 403.
 *   * Bounded denial reasons via shared CAPTURE_INGEST_DENIAL_REASONS.
 *   * NEVER returns raw assertion bytes or device public keys in
 *     plaintext — only fingerprints and bounded labels.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  CAPTURE_INGEST_DENIAL_REASONS,
  CAPTURE_INGEST_WARNINGS,
  CAPTURE_MODES,
  CAPTURE_PROVENANCE_CLASSES,
  CAPTURE_SIGNATURE_ALGORITHMS,
  DEVICE_ATTESTATION_PROVIDERS,
  attestationVerdictKeepsClassA,
  clampProvenanceClass,
  demoteToClassC,
  type CaptureIngestDenialReason,
  type CaptureIngestReceipt,
  type CaptureIngestWarning,
  type CaptureProvenanceClass,
  type CaptureSignaturePayload,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateCurrentWorkspace } from "../middleware/authorize.js";

import { verifyDeviceAttestation } from "../services/capture-trust/attestation-verifier.service.js";
import {
  listDevicesForTeam,
  getDevice as getDeviceById,
  registerDevice,
  revokeDevice,
} from "../services/capture-trust/device-identity.service.js";
import { projectProvenanceChain } from "../services/capture-trust/provenance-projection.service.js";
import { verifyCaptureSignature } from "../services/capture-trust/signature-verifier.service.js";
import {
  emitCaptureTrustEvent,
  readCaptureTrustTimeline,
} from "../services/capture-trust/trust-event.service.js";

// =============================================================================
// Zod input schemas
// =============================================================================

const RegisterDeviceBody = z.object({
  label: z.string().min(1).max(120),
  deviceModel: z.string().min(1).max(120),
  osVersion: z.string().min(1).max(80),
  appVersion: z.string().min(1).max(80),
  signatureAlgorithm: z.enum(CAPTURE_SIGNATURE_ALGORITHMS),
  publicKeyHex: z.string().regex(/^[0-9a-fA-F]+$/).min(64).max(160),
  attestationProvider: z.enum(DEVICE_ATTESTATION_PROVIDERS),
  attestationKeyId: z.string().min(1).max(160).nullable().optional(),
});

const RevokeDeviceBody = z.object({
  reason: z.enum([
    "OPERATOR_REQUESTED",
    "LOST",
    "STOLEN",
    "COMPROMISED",
    "DECOMMISSIONED",
    "ATTESTATION_FAILED",
    "POLICY",
  ]),
});

const CaptureSignaturePayloadSchema = z.object({
  schemaVersion: z.literal("PROOVRA_CAPTURE_SIG_V1"),
  assetHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  captureMode: z.enum(CAPTURE_MODES),
  provenanceClass: z.enum(CAPTURE_PROVENANCE_CLASSES),
  deviceKeyId: z.string().uuid(),
  algorithm: z.enum(CAPTURE_SIGNATURE_ALGORITHMS),
  captureSessionId: z.string().uuid(),
  signedAtUtc: z.string().datetime(),
  signedAtMonotonicNs: z.string().min(1).max(40),
  nonceHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  metadata: z.object({
    deviceModel: z.string().min(1).max(120),
    osVersion: z.string().min(1).max(80),
    appVersion: z.string().min(1).max(80),
    networkState: z.enum(["ONLINE", "OFFLINE", "UNKNOWN"]),
    locationPolicy: z.enum(["OFF", "COARSE", "PRECISE"]),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        accuracyMeters: z.number().nonnegative(),
        method: z.enum(["GPS", "NETWORK", "MANUAL"]),
      })
      .nullable(),
    camera: z
      .object({
        facing: z.enum(["FRONT", "BACK", "EXTERNAL", "UNKNOWN"]),
        flashOn: z.boolean(),
        focalLengthMm: z.number().nullable(),
        iso: z.number().nullable(),
      })
      .nullable(),
    sensor: z
      .object({
        batteryPct: z.number().nullable(),
        orientationDegrees: z.number().nullable(),
        gravityVector: z.array(z.number()).max(3).nullable(),
      })
      .nullable(),
    operatorContext: z
      .object({
        caseId: z.string().nullable(),
        tag: z.string().nullable(),
      })
      .nullable(),
  }),
});

const MobileIngestBody = z.object({
  payload: CaptureSignaturePayloadSchema,
  signatureHex: z.string().regex(/^[0-9a-fA-F]+$/).min(64).max(512),
  assetBase64: z.string().min(1).max(64 * 1024 * 1024 * 2), // base64 of bytes; bounded to ~96MB raw
  attestation: z
    .object({
      provider: z.enum(DEVICE_ATTESTATION_PROVIDERS),
      rawAssertionBase64: z.string().min(1).max(64 * 1024),
      assertedAtUtc: z.string().datetime(),
      nonceHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
      expiresAtUtc: z.string().datetime().nullable().optional(),
      providerMetadata: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable(),
});

// =============================================================================
// Route handlers
// =============================================================================

export async function captureTrustRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /v1/capture/devices — register a workspace-bound device
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/devices",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const teamId = await resolveTeamIdOrDeny(req, reply);
      if (!teamId) return reply;
      const body = RegisterDeviceBody.parse(req.body);
      const result = await registerDevice({
        teamId,
        ownerUserId: userId,
        label: body.label,
        deviceModel: body.deviceModel,
        osVersion: body.osVersion,
        appVersion: body.appVersion,
        signatureAlgorithm: body.signatureAlgorithm,
        publicKeyHex: body.publicKeyHex,
        attestationProvider: body.attestationProvider,
        attestationKeyId: body.attestationKeyId ?? null,
      });
      if (!result.ok) {
        return reply.code(409).send({ denial: result.denial });
      }
      return reply.code(201).send({
        deviceId: result.deviceId,
        publicKeyFingerprint: result.publicKeyFingerprint,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/capture/devices — list workspace devices
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/capture/devices",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const teamId = await resolveTeamIdOrDeny(req, reply);
      if (!teamId) return reply;
      const includeRevoked = z
        .object({ includeRevoked: z.enum(["true", "false"]).optional() })
        .parse(req.query ?? {});
      const devices = await listDevicesForTeam(teamId, {
        includeRevoked: includeRevoked.includeRevoked === "true",
      });
      return reply.code(200).send({ devices });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/capture/devices/:id — single device
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/capture/devices/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const teamId = await resolveTeamIdOrDeny(req, reply);
      if (!teamId) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const device = await getDeviceById(teamId, id);
      if (!device) return reply.code(404).send({ message: "Device not found" });
      return reply.code(200).send({ device });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/capture/devices/:id/revoke — revoke a device
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/devices/:id/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // NEW-050: revocation is destructive and irreversible — it is not a read.
      const teamId = await resolveTeamIdOrDeny(req, reply, "evidence.archive");
      if (!teamId) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = RevokeDeviceBody.parse(req.body);
      const result = await revokeDevice({
        teamId,
        deviceId: id,
        reason: body.reason,
      });
      if (!result.ok) {
        return reply.code(409).send({ denial: result.denial });
      }
      return reply.code(200).send({ revokedAtUtc: result.revokedAtUtc });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/capture/mobile/ingest — mobile capture ingest (operator native + SDK embed)
  //
  // This route is the trust-bearing ingest endpoint. It:
  //
  //   1. Validates the body shape.
  //   2. Re-hashes the raw bytes; refuses on mismatch.
  //   3. Verifies the at-source capture signature.
  //   4. (Optional) Verifies device attestation.
  //   5. Clamps provenance class to the mode's ceiling AND further
  //      demotes per verdict.
  //   6. Hands off the raw bytes to the existing evidence ingest
  //      pipeline (out of scope for this handler — see capture.routes
  //      sibling flow). For Phase 1B we accept the bytes, write the
  //      trust events, and return the bounded receipt; the actual
  //      `Evidence` row creation happens in the existing pipeline.
  //   7. Emits bounded trust events the whole way.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/capture/mobile/ingest",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const teamId = await resolveTeamIdOrDeny(req, reply);
      if (!teamId) return reply;

      const body = MobileIngestBody.parse(req.body);
      const payload: CaptureSignaturePayload = body.payload;

      // Step 1 — decode bytes.
      let assetBytes: Buffer;
      try {
        assetBytes = Buffer.from(body.assetBase64, "base64");
      } catch {
        return denyIngest(reply, "BYTES_HASH_MISMATCH", payload.provenanceClass);
      }
      if (assetBytes.length === 0) {
        return denyIngest(reply, "BYTES_HASH_MISMATCH", payload.provenanceClass);
      }

      // Step 2 — verify capture signature.
      const sigResult = await verifyCaptureSignature({
        teamId,
        payload,
        signatureHex: body.signatureHex,
        assetBytes,
      });

      const warnings: CaptureIngestWarning[] = [];
      let provenanceClass: CaptureProvenanceClass = clampProvenanceClass(
        payload.provenanceClass,
        payload.captureMode,
      );
      if (provenanceClass !== payload.provenanceClass) {
        warnings.push("CAPTURE_PROVENANCE_DOWNGRADED");
      }

      // Fatal signature failure → fail-closed denial.
      if (sigResult.fatal) {
        const denial: CaptureIngestDenialReason =
          sigResult.verdict === "UNKNOWN_DEVICE"
            ? "DEVICE_NOT_REGISTERED"
            : sigResult.verdict === "INVALID_HASH"
            ? "BYTES_HASH_MISMATCH"
            : "SIGNATURE_INVALID";

        await emitCaptureTrustEvent({
          teamId,
          deviceId: sigResult.deviceId,
          captureSessionId: payload.captureSessionId,
          evidenceId: null,
          code: "CAPTURE_ARTIFACT_VERIFICATION_FAILED",
          payload: {
            verdict: sigResult.verdict,
            denial,
            captureMode: payload.captureMode,
          },
        });
        return denyIngest(reply, denial, "C");
      }

      // Step 3 — verify attestation when present.
      type AttestVerdict =
        | "VERIFIED_STRONG"
        | "VERIFIED_BASIC"
        | "TEE_ONLY"
        | "UNVERIFIED"
        | "FAILED"
        | "REVOKED"
        | "NOT_ATTEMPTED";
      let attestationVerdict: AttestVerdict =
        "NOT_ATTEMPTED" as AttestVerdict;
      if (body.attestation && sigResult.deviceId) {
        const att = await verifyDeviceAttestation({
          teamId,
          deviceId: sigResult.deviceId,
          captureSessionId: payload.captureSessionId,
          provider: body.attestation.provider,
          rawAssertionBase64: body.attestation.rawAssertionBase64,
          assertedAtUtc: body.attestation.assertedAtUtc,
          nonceHex: body.attestation.nonceHex,
          expiresAtUtc: body.attestation.expiresAtUtc ?? null,
          providerMetadata: body.attestation.providerMetadata ?? {},
        });
        attestationVerdict = att.verdict as AttestVerdict;

        await emitCaptureTrustEvent({
          teamId,
          deviceId: sigResult.deviceId,
          captureSessionId: payload.captureSessionId,
          evidenceId: null,
          code:
            att.verdict === "FAILED" || att.verdict === "REVOKED"
              ? "ATTESTATION_FAILED"
              : "ATTESTATION_VERIFIED",
          payload: {
            verdict: att.verdict,
            provider: body.attestation.provider,
            failureReason: att.failureReason,
            attestationRecordId: att.attestationRecordId,
          },
        });

        if (att.verdict === "REVOKED") {
          return denyIngest(reply, "DEVICE_REVOKED", "C");
        }
      }

      // Step 4 — provenance class final demotion.
      if (
        payload.provenanceClass === "A" &&
        !attestationVerdictKeepsClassA(attestationVerdict)
      ) {
        // Strong attestation required for class A. Without it, class
        // drops to B (or C when attestation failed hard).
        const demoted: CaptureProvenanceClass =
          attestationVerdict === "FAILED" || attestationVerdict === "REVOKED"
            ? demoteToClassC(provenanceClass)
            : "B";
        if (demoted !== provenanceClass) {
          provenanceClass = demoted;
          warnings.push("CAPTURE_PROVENANCE_DOWNGRADED");
        }
      }

      // Step 5 — emit trust events recording the verified capture.
      await emitCaptureTrustEvent({
        teamId,
        deviceId: sigResult.deviceId,
        captureSessionId: payload.captureSessionId,
        evidenceId: null,
        code: "CAPTURE_ARTIFACT_RECEIVED",
        payload: {
          captureMode: payload.captureMode,
          provenanceClass,
          signatureVerdict: sigResult.verdict,
          attestationVerdict,
          assetHash: sigResult.computedAssetHash,
          sizeBytes: assetBytes.length,
        },
      });
      await emitCaptureTrustEvent({
        teamId,
        deviceId: sigResult.deviceId,
        captureSessionId: payload.captureSessionId,
        evidenceId: null,
        code: "CAPTURE_ARTIFACT_SIGNED_AT_SOURCE",
        payload: {
          algorithm: payload.algorithm,
          signedAtUtc: payload.signedAtUtc,
          captureMode: payload.captureMode,
          provenanceClass,
          signatureVerdict: sigResult.verdict,
        },
      });

      // Step 6 — return receipt. The actual Evidence row creation is
      // performed by the existing evidence ingest pipeline (the
      // caller uploads bytes via the existing presign flow and the
      // worker finalises). The receipt carries the trust verdicts
      // the caller needs to surface.
      const receipt: CaptureIngestReceipt = {
        evidenceId: "", // populated by the evidence pipeline downstream
        provenanceClass,
        signatureVerdict: sigResult.verdict,
        attestationVerdict,
        countersigned: false,
        rfc3161Applied: false,
        otsQueued: true,
        warnings: warnings as ReadonlyArray<CaptureIngestWarning>,
        denialReason: null,
      };
      return reply.code(202).send({ receipt });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/capture/sessions/:id/trust-timeline
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/capture/sessions/:id/trust-timeline",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const teamId = await resolveTeamIdOrDeny(req, reply);
      if (!teamId) return reply;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const limit = z
        .object({ limit: z.coerce.number().int().min(1).max(500).optional() })
        .parse(req.query ?? {}).limit ?? 200;
      const events = await readCaptureTrustTimeline({
        teamId,
        captureSessionId: id,
        limit,
      });
      return reply.code(200).send({ events });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /v1/provenance/:evidenceId — public-readable provenance chain
  //
  // Note: this route is callable by any authenticated user with access
  // to the evidence. The public verify page calls a parallel
  // token-anchored read implemented in `routes/external-review.routes`.
  // ---------------------------------------------------------------------------
  app.get(
    "/v1/provenance/:evidenceId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const teamId = await resolveTeamIdOrDeny(req, reply);
      if (!teamId) return reply;
      const { evidenceId } = z
        .object({ evidenceId: z.string().uuid() })
        .parse(req.params);

      // Workspace anchoring: confirm the evidence belongs to the team.
      const ev = await prisma.evidence.findFirst({
        where: { id: evidenceId, teamId },
        select: { id: true },
      });
      if (!ev) {
        return reply.code(404).send({ message: "Evidence not found" });
      }

      const chain = await projectProvenanceChain({ evidenceId });
      return reply.code(200).send({ chain });
    },
  );
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Resolve the workspace id for the authenticated request. Personal-space
 * callers are denied — device + ingest are organization concepts.
 */
async function resolveTeamIdOrDeny(
  req: FastifyRequest,
  reply: FastifyReply,
  /**
   * PHASE 13 (NEW-050) — the permission the CALLER needs, not one permission
   * for every operation on the surface.
   *
   * `evidence.read` is the right answer for reading the device registry and
   * the wrong answer for REVOKING a device: revocation burns an evidence
   * signing key, it cannot be undone, and every future capture from that
   * device is refused. Any ordinary member could do it, because the resolver
   * asked the same question for a list and for a destruction.
   *
   * The default stays `evidence.read` so the read surfaces are unchanged; the
   * destructive leg names what it actually needs. This RAISES the bar on one
   * route and lowers it on none.
   */
  permission: "evidence.read" | "evidence.archive" = "evidence.read",
): Promise<string | null> {
  // PHASE 12 CORRECTIVE PASS §1.3 (2026-08-06) — ONE AUTHORITY, NOT A
  // PARALLEL ONE.
  //
  // The P0 remediation of 2026-07-21 was right about the defect (a stale
  // pointer must not authorize) and built its own four-step check to fix it:
  // pointer -> team row -> isPersonal -> ACTIVE membership. That closed the
  // status hole but left this surface as a SECOND authorization authority,
  // and a second authority is a second place to forget something. It did
  // forget three things the canonical chain enforces:
  //
  //   * member ACCESS EXPIRY   — an ACTIVE row past `accessExpiresAtUtc`
  //                              still passed;
  //   * WORKSPACE KIND         — an unprovable kind was treated as fine;
  //   * ORGANIZATION LIFECYCLE — capture ingest continued to work inside a
  //                              SUSPENDED or ARCHIVED customer Organization.
  //
  // All three are now enforced because this resolver no longer decides
  // anything itself: it hands the pointer to the canonical primitive as a
  // CANDIDATE and reads the proven context back.
  //
  // The ONE surface-specific rule is retained verbatim: capture ingest is not
  // a Personal-Space surface. It is now expressed against the PROVEN canonical
  // kind rather than against a re-read `isPersonal` column.
  const outcome = await evaluateCurrentWorkspace(req, { permission });
  if (!outcome.allowed) {
    reply.code(403).send({ denial: "WORKSPACE_NOT_FOUND" });
    return null;
  }
  if (outcome.context.workspaceKind === "PERSONAL") {
    reply.code(403).send({ denial: "WORKSPACE_NOT_FOUND" });
    return null;
  }
  return outcome.context.workspaceId;
}

function denyIngest(
  reply: FastifyReply,
  denial: CaptureIngestDenialReason,
  provenanceClass: CaptureProvenanceClass,
): FastifyReply {
  if (!(CAPTURE_INGEST_DENIAL_REASONS as ReadonlyArray<string>).includes(denial)) {
    throw new Error(`capture-trust: unknown denial reason "${denial}"`);
  }
  // Mark the warning list as a no-op placeholder; downstream surfaces
  // expect the field even on denial.
  void CAPTURE_INGEST_WARNINGS;
  const receipt: CaptureIngestReceipt = {
    evidenceId: "",
    provenanceClass,
    signatureVerdict: "MISSING",
    attestationVerdict: "NOT_ATTEMPTED",
    countersigned: false,
    rfc3161Applied: false,
    otsQueued: false,
    warnings: [],
    denialReason: denial,
  };
  return reply.code(409).send({ receipt });
}
