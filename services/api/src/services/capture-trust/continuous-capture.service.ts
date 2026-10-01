/**
 * UC-3 / UC-5 — CONTINUOUS Screen Capture completion.
 *
 * A continuous session reuses the UC-0 direct-capture session end to end (open →
 * reserve → declare segment digests → canonical presign/PUT), exactly like the
 * UC-1 web and UC-2 frame captures. Segments are uploaded WHILE recording
 * continues (bounded streaming on the client); this service adds only the
 * SERVER-SIDE manifest step at completion, run by `completeDirectCapture` UNDER
 * the session lock against the exact declaration snapshot the seal hashes:
 *
 *   1. Validate the continuity manifest against the ONE shared schema + bounds,
 *      the session it claims to bind to, the platform the session's mode implies
 *      and the session's window. A COMPLETE_SESSION must list every recorded
 *      segment contiguously from 0 and cover the stated duration; a loss is only
 *      honest as INTERRUPTED_SESSION + SEGMENT_UPLOAD_LOST (UC-STR-002).
 *   2. Tie the manifest to the bytes actually uploaded: the SHA-256 of the exact
 *      manifest string must equal a declared part digest — that part IS the
 *      CAPTURE_MANIFEST part, and it sits after every segment.
 *   3. THE SERVER'S DECLARATIONS ARE AUTHORITATIVE: every declared SCREEN_SEGMENT
 *      part is described by the manifest and every manifest segment maps to a
 *      declared part (1:1 on partIndex + digest). A segment declared but left
 *      out — a lost or late tail — can never be sealed over, and a declaration
 *      racing the seal is serialised by the lock (it lands before the check or
 *      finds the session sealed).
 *   4. Each segment's stated size is the size of what was stored.
 *   5. `completeDirectCapture` classes the manifest part CAPTURE_MANIFEST,
 *      records the validated manifest facts, recomputes every part digest,
 *      seals through the canonical `completeEvidence`, and binds the session
 *      with its completeness as the end reason IN THE SAME UPDATE (UC-STR-006).
 *      ONE Evidence for the whole session, whatever the segment count.
 *
 * The mode lives on the server-issued session and this path refuses any
 * non-continuous mode. Both DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS (UC-3) and
 * DIRECT_SCREEN_CAPTURE_IOS (UC-5) are ordered-segment continuous sessions with
 * an identical continuity manifest, so they share this ONE pipeline. How the
 * mode was established (an ordinary token: CLIENT_DECLARED) is recorded when
 * the session opens — see `resolveDirectCaptureModeAuthority` (UC-ARCH-001).
 */

import type { PrismaClient } from "@prisma/client";
import {
  continuousCaptureManifestFacts,
  continuousEndReasonFor,
  validateScreenContinuousManifest,
  type ScreenContinuousManifest,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { headObject } from "../../storage.js";
import {
  completeDirectCapture,
  DirectCaptureError,
  loadOwnedDirectCaptureSession,
  sha256HexOf,
  type CompleteDirectCaptureResult,
  type DirectCaptureSealPlanner,
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
  if (
    session.acquisitionMode !== "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS" &&
    session.acquisitionMode !== "DIRECT_SCREEN_CAPTURE_IOS"
  ) {
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
  const manifestDigest = sha256HexOf(input.manifestJson);

  const plan: DirectCaptureSealPlanner = async ({ db: client, session: locked, declarations, now }) => {
    // 1. ET-DC-09 — the manifest is checked against the server's facts too.
    const validation = validateScreenContinuousManifest(parsed, {
      expectedSessionId: locked.id,
      expectedPlatform: locked.acquisitionMode === "DIRECT_SCREEN_CAPTURE_IOS" ? "ios" : "android",
      ...(locked.startedAtUtc
        ? { sessionWindow: { openedAtMs: locked.startedAtUtc.getTime(), nowMs: now.getTime() } }
        : {}),
    });
    if (!validation.ok) throw new DirectCaptureError("CONTINUOUS_MANIFEST_INVALID");
    const manifest: ScreenContinuousManifest = validation.manifest;

    // 2. The manifest bytes must have been uploaded and declared.
    let manifestPartIndex = -1;
    for (const d of declarations.values()) {
      if (d.sha256 === manifestDigest) {
        manifestPartIndex = d.partIndex;
        break;
      }
    }
    if (manifestPartIndex < 0) throw new DirectCaptureError("CONTINUOUS_MANIFEST_DIGEST_UNDECLARED");
    const manifestDecl = declarations.get(manifestPartIndex)!;
    if (manifestDecl.clientReportedSource !== null && manifestDecl.clientReportedSource !== "CONTINUOUS_MANIFEST") {
      throw new DirectCaptureError("CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH");
    }

    // 3. The server's declarations are the expected segment set: 1:1 with the
    //    manifest on partIndex + digest, every one a SCREEN_SEGMENT, and the
    //    manifest part after all of them.
    const declaredByIndex = new Map<number, string>();
    for (const d of declarations.values()) {
      if (d.partIndex === manifestPartIndex) continue;
      if (d.clientReportedSource !== null && d.clientReportedSource !== "SCREEN_SEGMENT") {
        throw new DirectCaptureError("CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH");
      }
      declaredByIndex.set(d.partIndex, d.sha256);
    }
    const manifestByIndex = new Map<number, string>();
    for (const s of manifest.segments) {
      if (s.partIndex >= manifestPartIndex) {
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

    // 4. ET-DC-09 — each segment's stated size is the size of what was stored.
    //    Storage reads run after the claim, outside the session lock.
    const evidenceId = locked.finalizedEvidenceId;
    const verifyStorage = async () => {
      if (!evidenceId) return;
      const parts = await client.evidencePart.findMany({
        where: { evidenceId, partIndex: { in: [...manifestByIndex.keys()] } },
        select: { partIndex: true, storageBucket: true, storageKey: true },
      });
      const sizeByIndex = new Map(manifest.segments.map((s) => [s.partIndex, s.sizeBytes]));
      for (const p of parts) {
        if (!p.storageBucket || !p.storageKey) continue;
        let stored: number | null = null;
        try {
          stored = (await headObject({ bucket: p.storageBucket, key: p.storageKey })).sizeBytes ?? null;
        } catch {
          stored = null; // an absent object is refused by the seal itself
        }
        if (stored !== null && stored !== sizeByIndex.get(p.partIndex)) {
          throw new DirectCaptureError("CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH");
        }
      }
    };

    return {
      manifestPartIndex,
      // UC-STR-006 — written by the bind itself.
      endReason: continuousEndReasonFor(manifest.sessionCompleteness),
      // UC-PROV-003 — the validated facts, recorded before the bind.
      manifestFacts: continuousCaptureManifestFacts(manifest, { manifestSha256: manifestDigest, manifestPartIndex }),
      verifyStorage,
    };
  };

  const result = await completeDirectCapture({
    prisma: db,
    sessionId: input.sessionId,
    ownerUserId: input.ownerUserId,
    now: input.now,
    plan,
  });
  return { ...result, manifestPartIndex: result.manifestPartIndex ?? -1 };
}
