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
import * as prismaPkg from "@prisma/client";
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
// Canonical reuse: the same evidence-creation + finalize pipeline that
// authenticated capture and external intake use. Citizen capture MUST NOT
// have its own forensic write path — it would diverge the custody chain
// and bypass the integrity gates. See evidence.service.ts (createEvidence)
// and evidence-complete.service.ts (completeEvidence) for the canonical
// flow. The fanout (search index, media-intelligence signals, graph
// reconcile) is triggered by completeEvidence itself.
import { classifyReportability } from "../../errors.js";
import { createEvidence } from "../evidence.service.js";
import { completeEvidence } from "../evidence-complete.service.js";
import { putObjectBuffer } from "../../storage.js";

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
  /**
   * MIME type of the captured asset. Drives evidence type classification
   * (image/* → PHOTO, video/* → VIDEO, audio/* → AUDIO, else DOCUMENT)
   * and the S3 Content-Type when bytes are persisted.
   */
  mimeType?: string | null;
  /**
   * Original file name from the citizen browser (optional). Bounded to a
   * safe length / charset by the canonical createEvidence helper.
   */
  originalFileName?: string | null;
  /**
   * Owner-of-record User id for the new Evidence row. The route handler
   * resolves this from the intake-link creator (the workspace admin who
   * opened the intake link). createEvidence requires a real User with
   * membership in the target team.
   */
  ownerUserId: string;
};

export type AcceptCitizenCaptureResult =
  | {
      ok: true;
      provenanceClass: CaptureProvenanceClass;
      signatureVerdict: string;
      /**
       * Id of the Evidence row materialised for this citizen capture.
       * The row is finalised (status SIGNED) by the canonical
       * completeEvidence pipeline before this method returns.
       */
      evidenceId: string;
    }
  | {
      ok: false;
      denial:
        | "SESSION_NOT_ACTIVE"
        | "SIGNATURE_INVALID"
        | "BYTES_HASH_MISMATCH"
        | "PROVENANCE_CLASS_DECLINED"
        /*
         * The workspace refused to record another evidence item — its plan's
         * record allowance, its storage, or its subscription state. A
         * deliberate commercial decision, and a DIFFERENT outcome from
         * "persisting failed": the route maps every denial except
         * EVIDENCE_PERSIST_FAILED to a 409, so separating them is what stops
         * a workspace reaching its published limit from being served, and
         * counted, as a server fault. Same defect as the one proven on the
         * public intake path; same fix, one entry point along.
         */
        | "WORKSPACE_CAPACITY_REACHED"
        | "EVIDENCE_PERSIST_FAILED";
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

  // ---------------------------------------------------------------------------
  // Materialise the citizen capture as an Evidence row.
  //
  // Up to this point we have ONLY emitted trust events. Without an
  // Evidence row the capture is structurally invisible to every
  // investigation surface (graph, timeline, search, dashboards). To
  // close that gap we reuse the SAME canonical pipeline that
  // authenticated capture and external-intake use:
  //
  //   1. createEvidence — allocates the row, the storage bucket/key
  //      reservation, the EVIDENCE_CREATED / IDENTITY_SNAPSHOT_RECORDED
  //      / UPLOAD_AUTHORIZED custody events. Returns a presigned PUT
  //      URL (we do not use it; the bytes are already in our hand).
  //   2. putObjectBuffer — server-side PUT of the citizen's bytes to
  //      the bucket/key the canonical creator chose, so completeEvidence
  //      can stream them back for hash + sign.
  //   3. completeEvidence — drives integrity verification, signing,
  //      UPLOAD_COMPLETED + SIGNATURE_APPLIED custody events, and the
  //      post-finalize fanout (search index, media-intelligence
  //      signals, graph reconcile).
  //
  // Failures here are NOT silently swallowed: a denial returns a
  // bounded EVIDENCE_PERSIST_FAILED so the route surfaces a 5xx rather
  // than a 202 receipt with no Evidence behind it. The trust-event
  // chain is already durable, so post-mortem audit remains possible.
  // ---------------------------------------------------------------------------

  const mimeType =
    typeof input.mimeType === "string" && input.mimeType.trim()
      ? input.mimeType.trim()
      : "application/octet-stream";
  const evidenceType: prismaPkg.EvidenceType = (() => {
    const m = mimeType.toLowerCase();
    if (m.startsWith("image/")) return prismaPkg.EvidenceType.PHOTO;
    if (m.startsWith("video/")) return prismaPkg.EvidenceType.VIDEO;
    if (m.startsWith("audio/")) return prismaPkg.EvidenceType.AUDIO;
    return prismaPkg.EvidenceType.DOCUMENT;
  })();

  let createdEvidenceId: string;
  try {
    const created = await createEvidence({
      ownerUserId: input.ownerUserId,
      teamId: input.teamId,
      type: evidenceType,
      mimeType,
      originalFileName: input.originalFileName ?? null,
      captureFileName: null,
    });
    createdEvidenceId = created.id;

    // The createEvidence helper reserves `created.upload.bucket` /
    // `created.upload.key` and writes them on the Evidence row in the
    // same transaction. We now PUT the citizen's already-received
    // bytes to that location so completeEvidence can stream + hash.
    await putObjectBuffer({
      bucket: created.upload.bucket,
      key: created.upload.key,
      body: input.assetBytes,
      contentType: mimeType,
    });
  } catch (err) {
    /*
     * An expected denial is not a persistence failure. `createEvidence` raises
     * the canonical commercial gates (record allowance, credits, storage,
     * subscription lifecycle) as errors that declare themselves EXPECTED
     * denials; everything else here — S3, the database, signing — does not.
     * Asking the platform's own classifier keeps this boundary from carrying
     * a list of commercial codes that would drift from the authority.
     */
    const denial =
      classifyReportability(err) === "UNEXPECTED"
        ? ("EVIDENCE_PERSIST_FAILED" as const)
        : ("WORKSPACE_CAPACITY_REACHED" as const);
    await emitCaptureTrustEvent({
      prisma,
      teamId: input.teamId,
      deviceId: result.deviceId,
      captureSessionId: input.payload.captureSessionId,
      evidenceId: null,
      code: "CAPTURE_ARTIFACT_VERIFICATION_FAILED",
      payload: {
        stage: "evidence_persist",
        denial,
        error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
    });
    return { ok: false, denial };
  }

  try {
    await completeEvidence({
      evidenceId: createdEvidenceId,
      ownerUserId: input.ownerUserId,
    });
  } catch (err) {
    await emitCaptureTrustEvent({
      prisma,
      teamId: input.teamId,
      deviceId: result.deviceId,
      captureSessionId: input.payload.captureSessionId,
      evidenceId: createdEvidenceId,
      code: "CAPTURE_ARTIFACT_VERIFICATION_FAILED",
      payload: {
        stage: "evidence_complete",
        error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
    });
    // Completion spends an evidence credit and re-checks storage, so the same
    // commercial gates can refuse here too.
    return {
      ok: false,
      denial:
        classifyReportability(err) === "UNEXPECTED"
          ? "EVIDENCE_PERSIST_FAILED"
          : "WORKSPACE_CAPACITY_REACHED",
    };
  }

  // Link the trust chain to the new Evidence id so downstream operators
  // can pivot from the capture session to the evidence record. The chain
  // is append-only; this is the canonical join row.
  await emitCaptureTrustEvent({
    prisma,
    teamId: input.teamId,
    deviceId: result.deviceId,
    captureSessionId: input.payload.captureSessionId,
    evidenceId: createdEvidenceId,
    code: "CAPTURE_ARTIFACT_RECEIVED",
    payload: {
      stage: "evidence_materialised",
      captureMode: "CITIZEN_PWA",
      provenanceClass: clamped,
      citizen: true,
    },
  });

  return {
    ok: true,
    provenanceClass: clamped,
    signatureVerdict: result.verdict,
    evidenceId: createdEvidenceId,
  };
}
