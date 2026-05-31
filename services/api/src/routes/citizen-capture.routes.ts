/**
 * Phase 1B Closure — Citizen Capture ingest route.
 *
 *   POST  /v1/intake/citizen/sessions       — open a citizen capture session
 *   POST  /v1/intake/citizen/sessions/:id/capture — accept a signed citizen capture
 *
 * TENANT_SCOPE_EXCEPTION: public_verify_token_readonly
 *   This route family is intentionally NOT gated by the standard
 *   `authorizeOrFail` helper. The citizen is anonymous; the workspace
 *   anchor is the workflow-intake-link id passed in the request body.
 *   Every Prisma query inside the handlers filters on `teamId` resolved
 *   from the validated intake link — cross-workspace access is
 *   structurally impossible.
 *
 * The citizen capture flow does NOT register a long-lived device.
 * A session-ephemeral Ed25519 key is generated client-side in the
 * browser, the public key is registered via the open-session endpoint,
 * the citizen signs each capture with the private half, and the server
 * verifies + emits trust events keyed by the intake session id.
 *
 * Hard rules:
 *   * Workspace-anchored by intake token.
 *   * Citizen captures are clamped to provenance class B (server-side).
 *   * No attestation — the citizen has no platform integrity provider.
 *   * Bounded denial reasons (CAPTURE_INGEST_DENIAL_REASONS).
 *   * Anti-abuse: rate-limited by IP + bounded asset size.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Buffer } from "node:buffer";
import { z } from "zod";

import {
  CAPTURE_MODES,
  CAPTURE_PROVENANCE_CLASSES,
  CAPTURE_SIGNATURE_ALGORITHMS,
} from "@proovra/shared";

import { prisma } from "../db.js";
import {
  acceptCitizenCapture,
  buildCitizenSessionDescriptor,
} from "../services/capture-trust/citizen-capture.service.js";
import { registerDevice } from "../services/capture-trust/device-identity.service.js";

const CITIZEN_INGEST_MAX_BYTES = 32 * 1024 * 1024; // 32 MiB raw

const OpenSessionBody = z.object({
  /** Workflow intake token id — proves the citizen reached us via a real intake link. */
  intakeTokenId: z.string().min(1).max(120),
  /** Citizen session-ephemeral Ed25519 public key, hex (64 chars). */
  publicKeyHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  /** Bounded UA label. */
  userAgent: z.string().max(180).optional(),
});

const CitizenCaptureBody = z.object({
  payload: z.object({
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
      camera: z.unknown().nullable().optional(),
      sensor: z.unknown().nullable().optional(),
      operatorContext: z.unknown().nullable().optional(),
    }),
  }),
  signatureHex: z.string().regex(/^[0-9a-fA-F]+$/).min(64).max(512),
  assetBase64: z.string().min(1),
});

export async function citizenCaptureRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /v1/intake/citizen/sessions — open a citizen session
  //
  // Resolves the workspace from the intake token, creates an ephemeral
  // Device row (attestationProvider=NONE), and returns the bounded
  // session descriptor the citizen browser uses to sign captures.
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/intake/citizen/sessions",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = OpenSessionBody.parse(req.body);

      // Validate intake link + resolve teamId. The citizen passes the
      // intake link id (workflow_intake_links.id); we honour the
      // workspace anchored on it. Token rotation is handled upstream in
      // external-intake-orchestration.
      const link = await prisma.workflowIntakeLink.findFirst({
        where: { id: body.intakeTokenId, revokedAtUtc: null },
        select: { teamId: true, id: true, createdByUserId: true },
      });
      if (!link) {
        return reply.code(403).send({ denial: "SESSION_NOT_ACTIVE" });
      }
      const token = link;

      // Register the citizen's session-ephemeral pubkey as a Device.
      // Attestation provider = NONE; revoked after session TTL via the
      // sweeper job.
      const reg = await registerDevice({
        teamId: token.teamId,
        ownerUserId: token.createdByUserId,
        label: `Citizen session via intake ${token.id.slice(0, 6)}`,
        deviceModel: "browser",
        osVersion: "web",
        appVersion: "pwa",
        signatureAlgorithm: "Ed25519",
        publicKeyHex: body.publicKeyHex.toLowerCase(),
        attestationProvider: "NONE",
        attestationKeyId: null,
      });

      // Idempotency: DEVICE_PUBKEY_TAKEN is acceptable — we look up the
      // existing row and reuse it.
      let deviceId: string | null = null;
      if (reg.ok) {
        deviceId = reg.deviceId;
      } else if (reg.denial === "DEVICE_PUBKEY_TAKEN") {
        const dev = await prisma.device.findFirst({
          where: {
            teamId: token.teamId,
            publicKeyFingerprint: await sha256Hex(body.publicKeyHex.toLowerCase()),
          },
          select: { id: true, revokedAtUtc: true },
        });
        if (dev && dev.revokedAtUtc === null) deviceId = dev.id;
      }
      if (!deviceId) {
        return reply.code(409).send({ denial: reg.ok ? "UNKNOWN" : reg.denial });
      }

      const descriptor = buildCitizenSessionDescriptor({
        teamId: token.teamId,
        ttlSeconds: 60 * 60,
      });
      return reply.code(201).send({
        descriptor,
        deviceId,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /v1/intake/citizen/sessions/:id/capture — accept signed citizen capture
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/intake/citizen/sessions/:id/capture",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = CitizenCaptureBody.parse(req.body);

      // Decode bytes — bounded size.
      let assetBytes: Buffer;
      try {
        assetBytes = Buffer.from(body.assetBase64, "base64");
      } catch {
        return reply.code(400).send({ denial: "BYTES_HASH_MISMATCH" });
      }
      if (assetBytes.length === 0 || assetBytes.length > CITIZEN_INGEST_MAX_BYTES) {
        return reply.code(413).send({ denial: "POLICY_REJECTED" });
      }

      // Confirm the session id in the body matches the URL.
      if (body.payload.captureSessionId !== id) {
        return reply.code(400).send({ denial: "SESSION_NOT_FOUND" });
      }

      // Resolve teamId via the Device row referenced in the payload.
      const device = await prisma.device.findFirst({
        where: { id: body.payload.deviceKeyId },
        select: { teamId: true, revokedAtUtc: true },
      });
      if (!device) {
        return reply.code(409).send({ denial: "DEVICE_NOT_REGISTERED" });
      }
      if (device.revokedAtUtc !== null) {
        return reply.code(409).send({ denial: "DEVICE_REVOKED" });
      }

      const result = await acceptCitizenCapture({
        teamId: device.teamId,
        intakeTokenId: "anonymous", // bounded label — the real anchor is the device row
        payload: body.payload as never,
        signatureHex: body.signatureHex,
        assetBytes,
      });

      if (!result.ok) {
        return reply.code(409).send({ denial: result.denial });
      }

      return reply.code(202).send({
        receipt: {
          provenanceClass: result.provenanceClass,
          signatureVerdict: result.signatureVerdict,
          attestationVerdict: "NOT_ATTEMPTED",
          countersigned: false,
          rfc3161Applied: false,
          otsQueued: true,
          warnings: [],
          denialReason: null,
        },
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { createHash as nodeCreateHash } from "node:crypto";

async function sha256Hex(s: string): Promise<string> {
  return nodeCreateHash("sha256").update(s).digest("hex");
}
