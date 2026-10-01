/**
 * UC-1 — Direct Web Capture completion.
 *
 * A web capture reuses the UC-0 direct-capture session end to end (open →
 * reserve → declare part digests → canonical presign/PUT). The only thing this
 * service adds is the SERVER-SIDE manifest step at completion:
 *
 *   1. Validate the capture manifest against the ONE shared schema + bounds and
 *      the session it claims to bind to.
 *   2. Tie the manifest to the bytes actually uploaded: the SHA-256 of the exact
 *      manifest string must equal a declared part digest — that part IS the
 *      CAPTURE_MANIFEST part, and it is classed as such BEFORE the seal
 *      (ET-DC-11 / UC-AND-008). Its validated facts — source URL, title,
 *      browser, extension version, capture window, completeness, page-mutated
 *      flag, limitations — are recorded on the session's trust chain before the
 *      bind (UC-PROV-003).
 *   3. Cross-check that every OTHER declared part is described by the manifest
 *      and every manifest artifact maps to a declared part (the manifest cannot
 *      omit or invent an artifact).
 *   4. Delegate to `completeDirectCapture`, which recomputes every part digest
 *      (including the manifest part) against the declarations, seals through the
 *      canonical `completeEvidence`, and emits exactly one CAPTURE_SESSION_BOUND.
 *
 * The extension cannot grant itself DIRECT_WEB_CAPTURE_EXTENSION: the mode lives
 * on the server-issued session, and this path refuses a session of any other
 * mode.
 */

import type { PrismaClient } from "@prisma/client";
import {
  validateWebCaptureManifest,
  webCaptureManifestFacts,
  type WebCaptureManifest,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  completeDirectCapture,
  DirectCaptureError,
  loadOwnedDirectCaptureSession,
  sha256HexOf,
  type CompleteDirectCaptureResult,
  type DirectCaptureSealPlanner,
} from "./direct-capture-ingest.service.js";

export type CompleteWebCaptureInput = {
  prisma?: PrismaClient;
  sessionId: string;
  ownerUserId: string;
  /** The EXACT manifest bytes the extension uploaded, as a string. */
  manifestJson: string;
  now?: Date;
};

const MAX_MANIFEST_JSON_LEN = 256 * 1024;

export async function completeWebCaptureSession(
  input: CompleteWebCaptureInput,
): Promise<CompleteDirectCaptureResult & { manifestPartIndex: number }> {
  const db = input.prisma ?? defaultPrisma;

  const session = await loadOwnedDirectCaptureSession(db, input.sessionId, input.ownerUserId);
  if (session.acquisitionMode !== "DIRECT_WEB_CAPTURE_EXTENSION") {
    // A mobile (or any non-web) session must not complete through this path.
    throw new DirectCaptureError("UNSUPPORTED_MODE");
  }

  if (typeof input.manifestJson !== "string" || input.manifestJson.length === 0) {
    throw new DirectCaptureError("WEB_MANIFEST_REQUIRED");
  }
  if (input.manifestJson.length > MAX_MANIFEST_JSON_LEN) {
    throw new DirectCaptureError("WEB_MANIFEST_INVALID");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.manifestJson);
  } catch {
    throw new DirectCaptureError("WEB_MANIFEST_INVALID");
  }
  const validation = validateWebCaptureManifest(parsed, { expectedSessionId: session.id });
  if (!validation.ok) {
    throw new DirectCaptureError("WEB_MANIFEST_INVALID");
  }
  const manifest: WebCaptureManifest = validation.manifest;

  const manifestDigest = sha256HexOf(input.manifestJson);

  // Run by completeDirectCapture UNDER the session lock, against the exact
  // declaration snapshot the seal hashes (a declaration cannot land between
  // this cross-check and the bind).
  const plan: DirectCaptureSealPlanner = async ({ declarations }) => {
    // 2. The manifest bytes must have been uploaded and declared: its own digest
    //    must equal a declared part. That part is the CAPTURE_MANIFEST part.
    let manifestPartIndex = -1;
    for (const d of declarations.values()) {
      if (d.sha256 === manifestDigest) {
        manifestPartIndex = d.partIndex;
        break;
      }
    }
    if (manifestPartIndex < 0) {
      throw new DirectCaptureError("WEB_MANIFEST_DIGEST_UNDECLARED");
    }

    // 3. Cross-check: manifest artifacts <-> declared parts (excluding the
    //    manifest part), 1:1 on partIndex + digest. Neither may omit or invent.
    const declaredByIndex = new Map<number, string>();
    for (const d of declarations.values()) {
      if (d.partIndex === manifestPartIndex) continue;
      declaredByIndex.set(d.partIndex, d.sha256);
    }
    const manifestByIndex = new Map<number, string>();
    for (const a of manifest.artifacts) {
      if (a.partIndex === manifestPartIndex) {
        // The manifest must not list itself as one of its own artifacts.
        throw new DirectCaptureError("WEB_MANIFEST_ARTIFACT_MISMATCH");
      }
      manifestByIndex.set(a.partIndex, a.expectedSha256.toLowerCase());
    }
    if (manifestByIndex.size !== declaredByIndex.size) {
      throw new DirectCaptureError("WEB_MANIFEST_ARTIFACT_MISMATCH");
    }
    for (const [idx, digest] of declaredByIndex) {
      if (manifestByIndex.get(idx) !== digest) {
        throw new DirectCaptureError("WEB_MANIFEST_ARTIFACT_MISMATCH");
      }
    }
    // 4. UC-AND-008 — the manifest part is classed CAPTURE_MANIFEST BEFORE the
    //    seal (completeDirectCapture does it for every manifest-sealed mode):
    //    relabelling a part of a sealed record changed it after its fingerprint
    //    was signed, and a failure between the seal and the relabel left the
    //    manifest classed as an original artifact. UC-PROV-003 — the validated
    //    manifest facts are recorded with it.
    return {
      manifestPartIndex,
      manifestFacts: webCaptureManifestFacts(manifest, { manifestSha256: manifestDigest, manifestPartIndex }),
    };
  };

  // 5. Seal through the canonical direct-capture completion.
  const result = await completeDirectCapture({
    prisma: db,
    sessionId: input.sessionId,
    ownerUserId: input.ownerUserId,
    now: input.now,
    plan,
  });
  return { ...result, manifestPartIndex: result.manifestPartIndex ?? -1 };
}
