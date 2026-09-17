/**
 * UC-3 — Android CONTINUOUS Screen Capture completion.
 *
 * A continuous session reuses the UC-0 direct-capture session end to end (open →
 * reserve → declare segment digests → canonical presign/PUT), exactly like the
 * UC-1 web and UC-2 frame captures. Segments are uploaded WHILE recording
 * continues (bounded streaming on the client); this service adds only the
 * SERVER-SIDE manifest step at completion:
 *
 *   1. Validate the continuity manifest against the ONE shared schema + bounds and
 *      the session it claims to bind to (contiguous segment sequence enforced —
 *      a missing segment cannot pass as a continuous whole).
 *   2. Tie the manifest to the bytes actually uploaded: the SHA-256 of the exact
 *      manifest string must equal a declared part digest — that part IS the
 *      CAPTURE_MANIFEST part.
 *   3. Cross-check that every OTHER declared part is described by the manifest and
 *      every manifest segment maps to a declared part (neither may omit or invent
 *      a segment).
 *   4. Delegate to `completeDirectCapture`, which recomputes every part digest
 *      against the declarations, seals through the canonical `completeEvidence`,
 *      and emits exactly one CAPTURE_SESSION_BOUND — ONE Evidence for the whole
 *      session, whatever the segment count.
 *   5. ONLY after the seal succeeds, class the manifest part CAPTURE_MANIFEST.
 *
 * The app cannot grant itself DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS: the mode
 * lives on the server-issued session, and this path refuses any other mode.
 */

import type { PrismaClient } from "@prisma/client";
import {
  validateScreenContinuousManifest,
  type ScreenContinuousManifest,
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

export type CompleteContinuousCaptureInput = {
  prisma?: PrismaClient;
  sessionId: string;
  ownerUserId: string;
  /** The EXACT continuity manifest bytes the app uploaded, as a string. */
  manifestJson: string;
  now?: Date;
};

const MAX_MANIFEST_JSON_LEN = 512 * 1024;

export async function completeContinuousCaptureSession(
  input: CompleteContinuousCaptureInput,
): Promise<CompleteDirectCaptureResult & { manifestPartIndex: number }> {
  const db = input.prisma ?? defaultPrisma;

  const session = await loadOwnedDirectCaptureSession(db, input.sessionId, input.ownerUserId);
  if (session.acquisitionMode !== "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS") {
    throw new DirectCaptureError("UNSUPPORTED_MODE");
  }

  if (typeof input.manifestJson !== "string" || input.manifestJson.length === 0) {
    throw new DirectCaptureError("CONTINUOUS_MANIFEST_REQUIRED");
  }
  if (input.manifestJson.length > MAX_MANIFEST_JSON_LEN) {
    throw new DirectCaptureError("CONTINUOUS_MANIFEST_INVALID");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.manifestJson);
  } catch {
    throw new DirectCaptureError("CONTINUOUS_MANIFEST_INVALID");
  }
  const validation = validateScreenContinuousManifest(parsed, { expectedSessionId: session.id });
  if (!validation.ok) {
    throw new DirectCaptureError("CONTINUOUS_MANIFEST_INVALID");
  }
  const manifest: ScreenContinuousManifest = validation.manifest;

  // 2. The manifest bytes must have been uploaded and declared.
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
    throw new DirectCaptureError("CONTINUOUS_MANIFEST_DIGEST_UNDECLARED");
  }

  // 3. Cross-check: manifest segments <-> declared parts (excluding the manifest
  //    part), 1:1 on partIndex + digest. Neither may omit or invent a segment.
  const declaredByIndex = new Map<number, string>();
  for (const d of declarations.values()) {
    if (d.partIndex === manifestPartIndex) continue;
    declaredByIndex.set(d.partIndex, d.sha256);
  }
  const manifestByIndex = new Map<number, string>();
  for (const s of manifest.segments) {
    if (s.partIndex === manifestPartIndex) {
      throw new DirectCaptureError("CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH");
    }
    manifestByIndex.set(s.partIndex, s.expectedSha256.toLowerCase());
  }
  if (manifestByIndex.size !== declaredByIndex.size) {
    throw new DirectCaptureError("CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH");
  }
  for (const [idx, digest] of declaredByIndex) {
    if (manifestByIndex.get(idx) !== digest) {
      throw new DirectCaptureError("CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH");
    }
  }

  // 4. Seal through the canonical direct-capture completion FIRST — ONE Evidence
  //    for the whole continuous session.
  const result = await completeDirectCapture({
    prisma: db,
    sessionId: input.sessionId,
    ownerUserId: input.ownerUserId,
    now: input.now,
  });

  // 5. Class the manifest part now that the record is sealed.
  await db.evidencePart.updateMany({
    where: { evidenceId: result.evidenceId, partIndex: manifestPartIndex },
    data: { artifactClass: "CAPTURE_MANIFEST" },
  });

  return { ...result, manifestPartIndex };
}
