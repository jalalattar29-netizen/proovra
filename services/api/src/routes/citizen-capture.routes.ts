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
// PHASE1-002 — the one trusted-client-IP binding; see `clientIp` below.
import { trustedClientIpKey } from "../middleware/client-ip.js";
import { enforceRateLimit } from "../services/rate-limit.js";

const CITIZEN_INGEST_MAX_BYTES = 32 * 1024 * 1024; // 32 MiB raw

// ---------------------------------------------------------------------------
// FINAL-004 (2026-08-15) — the anti-abuse control this file's own header
// promised ("rate-limited by IP + bounded asset size") existed only as prose.
// The size bound was real; the rate limit was never written. Both routes are
// unauthenticated and both WRITE: opening a session inserts a Device row, and
// capture ingests up to 32 MiB and creates evidence. Anyone holding an intake
// link id could therefore drive unbounded row and object creation into the
// workspace anchored on it, at whatever rate they could issue requests.
//
// The shape is deliberately the same two-layer bound the sibling public intake
// surface uses in `external-intake.routes.ts` — per-IP and per-capability —
// because "the other public intake surface does it differently" is how one of
// the two ends up forgotten again.
// ---------------------------------------------------------------------------
const CITIZEN_INTAKE_RATE_LIMIT_PER_IP_PER_MIN = 30;
const CITIZEN_INTAKE_RATE_LIMIT_PER_TOKEN_PER_MIN = 20;

/**
 * PHASE1-002 (2026-08-16) — the per-IP bound MUST NOT trust a header the
 * caller controls.
 *
 * The first version of this read `x-forwarded-for` unconditionally and keyed
 * the limiter on its first value. On a deployment where `API_TRUST_PROXY` is
 * unset — which is this service's documented safe default — that header is
 * attacker-supplied, so sending a different `X-Forwarded-For` on every request
 * yielded a fresh bucket every time. The per-IP limit was defeated by one
 * header, on the exact surface the limit was added to protect, while reading in
 * review as though the surface were bounded.
 *
 * `getTrustedClientIp` is the authority that already answers this question for
 * capture-environment recording: it returns the socket IP unless the deployment
 * has explicitly declared itself to be behind a proxy, and only then consults
 * CF-Connecting-IP / the first PUBLIC forwarded hop. Using it here means the
 * limiter and the evidence metadata agree about who the caller is, and the
 * trust decision lives in one place instead of two.
 *
 * The per-token layer below is deliberately kept as well: a distributed
 * attacker with many real source addresses defeats any per-IP bound, and the
 * intake-link id is the thing that identifies which surface is being driven.
 */
function clientIp(req: FastifyRequest): string {
  return trustedClientIpKey(req);
}

/**
 * Two-layer public-intake bound. `capabilityKey` is the intake-link id for the
 * open-session call and the capture-session id for ingest — the value that
 * identifies WHICH citizen surface is being driven, never a secret worth
 * storing whole, so only a bounded prefix reaches the limiter key.
 */
async function applyCitizenRateLimits(
  req: FastifyRequest,
  reply: FastifyReply,
  capabilityKey: string,
): Promise<boolean> {
  const ipResult = await enforceRateLimit({
    key: `citizen-intake:ip:${clientIp(req)}`,
    max: CITIZEN_INTAKE_RATE_LIMIT_PER_IP_PER_MIN,
    windowSec: 60,
  });
  if (!ipResult.allowed) {
    reply.code(429).send({ error: { code: "RATE_LIMITED", scope: "ip" } });
    return false;
  }

  const tokenResult = await enforceRateLimit({
    key: `citizen-intake:token:${capabilityKey.slice(0, 32)}`,
    max: CITIZEN_INTAKE_RATE_LIMIT_PER_TOKEN_PER_MIN,
    windowSec: 60,
  });
  if (!tokenResult.allowed) {
    reply.code(429).send({ error: { code: "RATE_LIMITED", scope: "token" } });
    return false;
  }
  return true;
}

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
      if (!(await applyCitizenRateLimits(req, reply, body.intakeTokenId))) {
        return;
      }

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
      if (!(await applyCitizenRateLimits(req, reply, id))) return;
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
      // The Device row also carries the owner-of-record user id — for
      // citizen sessions this is the intake-link creator (workspace admin
      // who opened the link). Pulling it from the Device row is the same
      // authority chain the open-session handler set up, so no client-
      // controlled identity ever lands in the Evidence row.
      const device = await prisma.device.findFirst({
        where: { id: body.payload.deviceKeyId },
        select: { teamId: true, revokedAtUtc: true, ownerUserId: true },
      });
      if (!device) {
        return reply.code(409).send({ denial: "DEVICE_NOT_REGISTERED" });
      }
      if (device.revokedAtUtc !== null) {
        return reply.code(409).send({ denial: "DEVICE_REVOKED" });
      }

      // Infer an asset MIME type from the camera/sensor metadata if the
      // citizen browser provided one; otherwise default to octet-stream
      // and let the canonical evidence-type classifier fall through to
      // DOCUMENT. This is bounded and never throws — we never trust raw
      // client strings; the canonical createEvidence helper normalises.
      const cameraMeta = body.payload.metadata.camera as
        | { mimeType?: unknown }
        | null
        | undefined;
      const sensorMeta = body.payload.metadata.sensor as
        | { mimeType?: unknown }
        | null
        | undefined;
      const claimedMime =
        typeof cameraMeta?.mimeType === "string"
          ? cameraMeta.mimeType
          : typeof sensorMeta?.mimeType === "string"
            ? sensorMeta.mimeType
            : null;

      const result = await acceptCitizenCapture({
        teamId: device.teamId,
        intakeTokenId: "anonymous", // bounded label — the real anchor is the device row
        payload: body.payload as never,
        signatureHex: body.signatureHex,
        assetBytes,
        mimeType: claimedMime,
        ownerUserId: device.ownerUserId,
      });

      if (!result.ok) {
        const code = result.denial === "EVIDENCE_PERSIST_FAILED" ? 500 : 409;
        return reply.code(code).send({ denial: result.denial });
      }

      // Enterprise Capture Environment layer — record the privacy-safe
      // PROOVRA capture environment for the citizen/mobile ingest path.
      // Reuses the shared writer (UA hash + masked IP only; never raw).
      // Best-effort + non-blocking — never fails the capture. The signed
      // citizen payload is NOT modified; locale is derived from
      // Accept-Language, timezone left null (no client signal here).
      {
        const { recordCaptureEnvironment, resolveCaptureClientIp } = await import(
          "../services/technical-metadata/capture-environment-writer.js"
        );
        await recordCaptureEnvironment({
          evidenceId: result.evidenceId,
          rawUserAgent: req.headers["user-agent"] ?? null,
          rawIp: resolveCaptureClientIp(req),
          timezone: null,
          acceptLanguage:
            typeof req.headers["accept-language"] === "string"
              ? req.headers["accept-language"]
              : null,
          captureMethod: "MOBILE",
          uploadSource: "MOBILE_APP",
        });
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
          evidenceId: result.evidenceId,
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
