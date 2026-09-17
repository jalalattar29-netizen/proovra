/**
 * UC-2 — Android Direct Screen Capture completion.
 *
 * A screen capture reuses the UC-0 direct-capture session end to end (open →
 * reserve → declare frame digests → canonical presign/PUT), exactly like the
 * UC-1 web capture. The only thing this service adds is the SERVER-SIDE manifest
 * step at completion:
 *
 *   1. Validate the screen-capture manifest against the ONE shared schema +
 *      bounds and the session it claims to bind to.
 *   2. Tie the manifest to the bytes actually uploaded: the SHA-256 of the exact
 *      manifest string must equal a declared part digest — that part IS the
 *      CAPTURE_MANIFEST part.
 *   3. Cross-check that every OTHER declared part is described by the manifest
 *      and every manifest artifact maps to a declared part (the manifest cannot
 *      omit or invent a frame).
 *   4. Delegate to `completeDirectCapture`, which recomputes every part digest
 *      (including the manifest part) against the declarations, seals through the
 *      canonical `completeEvidence`, and emits exactly one CAPTURE_SESSION_BOUND.
 *   5. ONLY after the seal succeeds, class the manifest part CAPTURE_MANIFEST —
 *      so the label can never sit on an unsealed/failed record (UC-1 §4.6).
 *
 * The app cannot grant itself DIRECT_SCREEN_CAPTURE_ANDROID: the mode lives on
 * the server-issued session, and this path refuses a session of any other mode.
 */

import type { PrismaClient } from "@prisma/client";
import {
  validateScreenCaptureManifest,
  type ScreenCaptureManifest,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  completeDirectCapture,
  DirectCaptureError,
  loadOwnedDirectCaptureSession,
  readPartDeclarations,
  sha256HexOf,
  type CompleteDirectCaptureResult,
} from "./direct-capture-ingest.service.js";

export type CompleteScreenCaptureInput = {
  prisma?: PrismaClient;
  sessionId: string;
  ownerUserId: string;
  /** The EXACT manifest bytes the app uploaded, as a string. */
  manifestJson: string;
  now?: Date;
};

const MAX_MANIFEST_JSON_LEN = 128 * 1024;

export async function completeScreenCaptureSession(
  input: CompleteScreenCaptureInput,
): Promise<CompleteDirectCaptureResult & { manifestPartIndex: number }> {
  const db = input.prisma ?? defaultPrisma;

  const session = await loadOwnedDirectCaptureSession(db, input.sessionId, input.ownerUserId);
  if (session.acquisitionMode !== "DIRECT_SCREEN_CAPTURE_ANDROID") {
    // A web or mobile (or any non-screen) session must not complete through here.
    throw new DirectCaptureError("UNSUPPORTED_MODE");
  }

  if (typeof input.manifestJson !== "string" || input.manifestJson.length === 0) {
    throw new DirectCaptureError("SCREEN_MANIFEST_REQUIRED");
  }
  if (input.manifestJson.length > MAX_MANIFEST_JSON_LEN) {
    throw new DirectCaptureError("SCREEN_MANIFEST_INVALID");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.manifestJson);
  } catch {
    throw new DirectCaptureError("SCREEN_MANIFEST_INVALID");
  }
  const validation = validateScreenCaptureManifest(parsed, { expectedSessionId: session.id });
  if (!validation.ok) {
    throw new DirectCaptureError("SCREEN_MANIFEST_INVALID");
  }
  const manifest: ScreenCaptureManifest = validation.manifest;

  // 2. The manifest bytes must have been uploaded and declared: its own digest
  //    must equal a declared part. That part is the CAPTURE_MANIFEST part.
  const manifestDigest = sha256HexOf(input.manifestJson);
  const declarations = await readPartDeclarations(db, session);
  let manifestPartIndex = -1;
  for (const d of declarations.values()) {
    if (d.sha256 === manifestDigest) {
      manifestPartIndex = d.partIndex;
      break;
    }
  }
  if (manifestPartIndex < 0) {
    throw new DirectCaptureError("SCREEN_MANIFEST_DIGEST_UNDECLARED");
  }

  // 3. Cross-check: manifest artifacts <-> declared parts (excluding the manifest
  //    part), 1:1 on partIndex + digest. Neither may omit or invent a frame.
  const declaredByIndex = new Map<number, string>();
  for (const d of declarations.values()) {
    if (d.partIndex === manifestPartIndex) continue;
    declaredByIndex.set(d.partIndex, d.sha256);
  }
  const manifestByIndex = new Map<number, string>();
  for (const a of manifest.artifacts) {
    if (a.partIndex === manifestPartIndex) {
      // The manifest must not list itself as one of its own frames.
      throw new DirectCaptureError("SCREEN_MANIFEST_ARTIFACT_MISMATCH");
    }
    manifestByIndex.set(a.partIndex, a.expectedSha256.toLowerCase());
  }
  if (manifestByIndex.size !== declaredByIndex.size) {
    throw new DirectCaptureError("SCREEN_MANIFEST_ARTIFACT_MISMATCH");
  }
  for (const [idx, digest] of declaredByIndex) {
    if (manifestByIndex.get(idx) !== digest) {
      throw new DirectCaptureError("SCREEN_MANIFEST_ARTIFACT_MISMATCH");
    }
  }

  // 4. Seal through the canonical direct-capture completion FIRST. Only a sealed
  //    record may carry the CAPTURE_MANIFEST label (UC-1 §4.6 hardening).
  const result = await completeDirectCapture({
    prisma: db,
    sessionId: input.sessionId,
    ownerUserId: input.ownerUserId,
    now: input.now,
  });

  // 5. Class the manifest part now that the record is sealed. Its bytes were
  //    already verified against the declared digest by completeEvidence, so this
  //    is a label on a sealed record, not a trust grant on an unsealed one.
  await db.evidencePart.updateMany({
    where: { evidenceId: result.evidenceId, partIndex: manifestPartIndex },
    data: { artifactClass: "CAPTURE_MANIFEST" },
  });

  return { ...result, manifestPartIndex };
}
