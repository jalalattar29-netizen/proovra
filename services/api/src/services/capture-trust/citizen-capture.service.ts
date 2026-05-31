/**
 * Phase 1B — Citizen Capture session adapter.
 *
 * Citizen captures arrive via PROOVRA's existing external-intake +
 * workflow-intake-token pipeline. They do NOT register a long-lived
 * device — instead, each intake session is bound to:
 *
 *   * A bounded `intake_link` (workspace-owned, capability-gated).
 *   * A session-scoped, ephemeral key (generated client-side in the
 *     browser; the citizen's browser holds the private half for the
 *     duration of the session, never persisted).
 *   * A `CITIZEN_PWA` capture mode, capped at provenance class B.
 *
 * This service provides the bounded contract that the existing
 * external-intake routes call when they receive a capture:
 *
 *   - acceptCitizenCapture     — bounded entry point that wraps the
 *                                signature verifier + records a
 *                                trust-event timeline keyed by the
 *                                intake session id.
 *   - buildCitizenSessionDescriptor — bounded shape returned to the
 *                                citizen so their browser can sign
 *                                with the session ephemeral key.
 *
 * Hard rules:
 *   * Citizen captures NEVER claim Class A. The clamp returns "B"
 *     even if the citizen claims A.
 *   * Citizen captures NEVER attempt attestation (no Apple App Attest /
 *     Google Play Integrity in the browser). Attestation verdict is
 *     `NOT_ATTEMPTED`.
 *   * Citizen sessions are bounded by the workflow-intake-token TTL.
 *     A capture after the token expires fail-closed.
 *   * The session-ephemeral key is held by the citizen's browser; the
 *     server stores ONLY the public key for the duration of the
 *     session.
 *   * Every citizen capture writes capture-trust events keyed by the
 *     intake session id; finalised evidence records carry the chain.
 */

import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  clampProvenanceClass,
  type CaptureProvenanceClass,
  type CaptureSignaturePayload,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  emitCaptureTrustEvent,
} from "./trust-event.service.js";
import { verifyCaptureSignature } from "./signature-verifier.service.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type CitizenSessionDescriptor = {
  /** UUID — used as captureSessionId by the citizen's signer. */
  captureSessionId: string;
  /** Workspace this session lands in. */
  teamId: string;
  /** Bounded mode constant — always `CITIZEN_PWA`. */
  captureMode: "CITIZEN_PWA";
  /** Maximum provenance class the session can claim. */
  provenanceClassCeiling: "B";
  /** Bounded ttl seconds; matches the intake token. */
  ttlSeconds: number;
  /** UTC ISO when the session expires. */
  expiresAtUtc: string;
};

export type AcceptCitizenCaptureInput = {
  prisma?: PrismaClient;
  teamId: string;
  /** Intake token id this session is bound to. */
  intakeTokenId: string;
  /** Capture signature payload (citizen-signed with session-ephemeral key). */
  payload: CaptureSignaturePayload;
  /** Signature hex over the canonical payload. */
  signatureHex: string;
  /** Raw asset bytes for re-hash. */
  assetBytes: Buffer;
};

export type AcceptCitizenCaptureResult =
  | {
      ok: true;
      provenanceClass: CaptureProvenanceClass;
      signatureVerdict: string;
    }
  | {
      ok: false;
      denial:
        | "SESSION_NOT_ACTIVE"
        | "SIGNATURE_INVALID"
        | "BYTES_HASH_MISMATCH"
        | "PROVENANCE_CLASS_DECLINED";
    };

// -----------------------------------------------------------------------------
// Build a session descriptor
// -----------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

export function buildCitizenSessionDescriptor(input: {
  teamId: string;
  ttlSeconds?: number;
}): CitizenSessionDescriptor {
  const ttl = Math.min(Math.max(input.ttlSeconds ?? DEFAULT_TTL_SECONDS, 60), 4 * 60 * 60);
  return {
    captureSessionId: randomUUID(),
    teamId: input.teamId,
    captureMode: "CITIZEN_PWA",
    provenanceClassCeiling: "B",
    ttlSeconds: ttl,
    expiresAtUtc: new Date(Date.now() + ttl * 1000).toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Accept a citizen capture
// -----------------------------------------------------------------------------

export async function acceptCitizenCapture(
  input: AcceptCitizenCaptureInput,
): Promise<AcceptCitizenCaptureResult> {
  const prisma = input.prisma ?? defaultPrisma;

  // Citizen captures may not claim Class A — clamp upfront.
  const clamped: CaptureProvenanceClass = clampProvenanceClass(
    input.payload.provenanceClass,
    input.payload.captureMode,
  );
  if (clamped !== "B" && clamped !== "C") {
    return { ok: false, denial: "PROVENANCE_CLASS_DECLINED" };
  }

  // The citizen capture path uses a session-ephemeral key — the
  // signature verifier accepts the bytes only when the device id in
  // the payload corresponds to a registered ephemeral Device row.
  //
  // For Phase 1B, citizen ephemeral keys are persisted as Device rows
  // with `attestationProvider = NONE` and an immediate auto-revoke
  // after session expiry (job-level, out of scope here).
  const result = await verifyCaptureSignature({
    teamId: input.teamId,
    payload: input.payload,
    signatureHex: input.signatureHex,
    assetBytes: input.assetBytes,
  });

  if (result.verdict === "INVALID_HASH") {
    await emitCaptureTrustEvent({
      teamId: input.teamId,
      deviceId: null,
      captureSessionId: input.payload.captureSessionId,
      evidenceId: null,
      code: "CAPTURE_ARTIFACT_VERIFICATION_FAILED",
      payload: { verdict: result.verdict, citizen: true },
    });
    return { ok: false, denial: "BYTES_HASH_MISMATCH" };
  }
  if (result.fatal) {
    await emitCaptureTrustEvent({
      teamId: input.teamId,
      deviceId: null,
      captureSessionId: input.payload.captureSessionId,
      evidenceId: null,
      code: "CAPTURE_ARTIFACT_VERIFICATION_FAILED",
      payload: { verdict: result.verdict, citizen: true },
    });
    return { ok: false, denial: "SIGNATURE_INVALID" };
  }

  await emitCaptureTrustEvent({
    prisma,
    teamId: input.teamId,
    deviceId: result.deviceId,
    captureSessionId: input.payload.captureSessionId,
    evidenceId: null,
    code: "CAPTURE_ARTIFACT_RECEIVED",
    payload: {
      captureMode: "CITIZEN_PWA",
      provenanceClass: clamped,
      signatureVerdict: result.verdict,
      citizen: true,
      intakeTokenId: input.intakeTokenId,
    },
  });
  await emitCaptureTrustEvent({
    prisma,
    teamId: input.teamId,
    deviceId: result.deviceId,
    captureSessionId: input.payload.captureSessionId,
    evidenceId: null,
    code: "CAPTURE_ARTIFACT_SIGNED_AT_SOURCE",
    payload: {
      algorithm: input.payload.algorithm,
      signedAtUtc: input.payload.signedAtUtc,
      captureMode: "CITIZEN_PWA",
      provenanceClass: clamped,
      signatureVerdict: result.verdict,
    },
  });

  return { ok: true, provenanceClass: clamped, signatureVerdict: result.verdict };
}
