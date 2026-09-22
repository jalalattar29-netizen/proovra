/**
 * UC-0 — the mobile app's client for the server-issued direct-capture session.
 *
 * Replaces the Phase 1B trust runtime, which uploaded every photo/video TWICE —
 * once as base64 JSON to `/v1/capture/mobile/ingest` (a receipt-only route that
 * created no Evidence and returned `evidenceId: ""`) and once through
 * `POST /v1/evidence` (which recorded the app as the web app) — with nothing
 * joining the two.
 *
 * Now ONE path:
 *
 *   openSession        POST /v1/capture/direct-sessions            (server nonce)
 *   reserveEvidence    POST /v1/capture/direct-sessions/:id/evidence
 *   for each item:
 *     declarePart      POST …/parts/:n/declaration   (the file's SHA-256)
 *     presign + PUT    POST /v1/evidence/:id/parts → storage          (bytes)
 *   complete           POST …/complete   (server re-hashes, compares, seals, binds)
 *
 * Bytes never travel in a JSON body. The declared digest is a CLAIM: the
 * server hashes what storage holds and refuses the record before signing when
 * the two differ.
 *
 * Sessions open unbound (no device key). The device registry lives in
 * Organization workspaces, which this app does not target; an unsigned
 * declaration is recorded honestly as such. The app says which items came from
 * the camera and which from the file picker, and the server records that as
 * client-reported — never as proof of capture.
 */

import { apiFetch } from "./api";
import { computeFileIntegrityBase64, uploadWithPut } from "./upload-utils";
import {
  buildScreenCompletePath,
  buildContinuousCompletePath,
  type ScreenAcquisitionMode,
} from "./capture/screen-acquisition";

export type DirectCaptureSession = {
  captureSessionId: string;
  expiresAtUtc: string;
};

export type DirectCaptureItemSource =
  | "CAMERA"
  | "FILE_PICKER"
  | "UNKNOWN"
  | "SCREEN_FRAME"
  | "SCREEN_MANIFEST"
  | "SCREEN_SEGMENT"
  | "CONTINUOUS_MANIFEST";

/** Acquisition modes the mobile app may open a direct-capture session for. */
export type DirectCaptureSessionMode =
  | "PROOVRA_MOBILE_APP"
  | "DIRECT_SCREEN_CAPTURE_ANDROID"
  | "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS"
  | "DIRECT_SCREEN_CAPTURE_IOS";

export async function openDirectCaptureSession(
  mode: DirectCaptureSessionMode = "PROOVRA_MOBILE_APP",
): Promise<DirectCaptureSession> {
  const res = await apiFetch("/v1/capture/direct-sessions", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
  const session = res?.session as
    | { captureSessionId?: string; expiresAtUtc?: string }
    | undefined;
  if (!session?.captureSessionId) {
    throw new Error("Could not open a capture session.");
  }
  return {
    captureSessionId: session.captureSessionId,
    expiresAtUtc: session.expiresAtUtc ?? "",
  };
}

export async function reserveDirectCaptureEvidence(
  session: DirectCaptureSession,
  input: {
    type: "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";
    mimeType: string;
    deviceTimeIso: string;
    gps?: { lat: number; lng: number; accuracyMeters?: number };
  },
): Promise<string> {
  const res = await apiFetch(
    `/v1/capture/direct-sessions/${session.captureSessionId}/evidence`,
    { method: "POST", body: JSON.stringify(input) },
  );
  const evidenceId = res?.evidence?.evidenceId as string | undefined;
  if (!evidenceId) throw new Error("Could not reserve the evidence record.");
  return evidenceId;
}

/**
 * Declare one item's digest to the session, then upload its bytes through the
 * canonical part presign. The same digest is sent to storage as the
 * checksum header, so storage also rejects a corrupted transfer.
 */
export async function uploadDirectCaptureItem(
  session: DirectCaptureSession,
  evidenceId: string,
  item: {
    partIndex: number;
    uri: string;
    mimeType: string;
    durationMs?: number;
    originalFilename?: string;
    source: DirectCaptureItemSource;
  },
): Promise<{ partIndex: number; sha256Hex: string }> {
  // The integrity layer returns the hex digest directly — it no longer round-
  // trips through `globalThis.atob`, which is not guaranteed on Hermes.
  const integrity = await computeFileIntegrityBase64(item.uri);
  const sha256Hex = integrity.sha256Hex;

  await apiFetch(
    `/v1/capture/direct-sessions/${session.captureSessionId}/parts/${item.partIndex}/declaration`,
    {
      method: "POST",
      body: JSON.stringify({
        sha256: sha256Hex,
        clientReportedSource: item.source,
        signed: null,
      }),
    },
  );

  const part = await apiFetch(`/v1/evidence/${evidenceId}/parts`, {
    method: "POST",
    body: JSON.stringify({
      partIndex: item.partIndex,
      mimeType: item.mimeType,
      durationMs: item.durationMs ?? undefined,
      originalFileName: item.originalFilename ?? undefined,
      checksumSha256Base64: integrity.checksumSha256Base64,
      contentMd5Base64: integrity.contentMd5Base64,
    }),
  });

  await uploadWithPut({
    putUrl: part.upload.putUrl,
    uri: integrity.fileUri,
    mimeType: item.mimeType,
    checksumSha256Base64: integrity.checksumSha256Base64,
    contentMd5Base64: integrity.contentMd5Base64,
  });

  return { partIndex: item.partIndex, sha256Hex };
}

export async function completeDirectCapture(
  session: DirectCaptureSession,
): Promise<{ evidenceId: string }> {
  const res = await apiFetch(
    `/v1/capture/direct-sessions/${session.captureSessionId}/complete`,
    { method: "POST", body: JSON.stringify({}) },
  );
  const evidenceId = res?.result?.evidenceId as string | undefined;
  if (!evidenceId) throw new Error("Could not complete the capture session.");
  return { evidenceId };
}

/**
 * Complete a session by the acquisition that produced it.
 *
 * THE ONE FINALIZATION. An ordinary phone capture completes through
 * `/complete`; a screen acquisition completes through the route its manifest
 * belongs to — `screen-complete` for frame capture, `continuous-complete` for
 * a continuous recording or an Apple system broadcast. The routes differ
 * because they record different things, not because there are two products:
 * `continuous-complete` carries the completeness that says whether the
 * recording was interrupted, and sealing it as a frame capture would throw
 * that away.
 *
 * The caller passes what the draft says the session is. Nothing here guesses.
 */
export async function completeAcquisition(
  session: DirectCaptureSession,
  acquisition: { mode: ScreenAcquisitionMode; manifestJson: string } | null,
): Promise<{ evidenceId: string }> {
  if (!acquisition) return completeDirectCapture(session);
  // Each branch NAMES the route it calls. Assembling one path from a runtime
  // suffix is the shape evidence-detail.ts already records a lesson about —
  // "neither a reader nor the capability analyzer could tell which endpoint a
  // given button called" — and it showed up here immediately: the
  // architecture map attributed screen-complete and lost continuous-complete,
  // reporting a route the product calls on every finished recording as having
  // no consumer at all.
  return acquisition.mode === "DIRECT_SCREEN_CAPTURE_ANDROID"
    ? sealScreenFrames(session, acquisition.manifestJson)
    : sealContinuousRecording(session, acquisition.manifestJson);
}

/** `screen-complete` — the frame-capture manifest. */
async function sealScreenFrames(
  session: DirectCaptureSession,
  manifestJson: string,
): Promise<{ evidenceId: string }> {
  const res = await apiFetch(buildScreenCompletePath(session.captureSessionId), {
    method: "POST",
    body: JSON.stringify({ manifestJson }),
  });
  return readSealedEvidence(res);
}

/**
 * `continuous-complete` — the continuity manifest, which carries the
 * completeness that says whether the recording was interrupted.
 */
async function sealContinuousRecording(
  session: DirectCaptureSession,
  manifestJson: string,
): Promise<{ evidenceId: string }> {
  const res = await apiFetch(buildContinuousCompletePath(session.captureSessionId), {
    method: "POST",
    body: JSON.stringify({ manifestJson }),
  });
  return readSealedEvidence(res);
}

function readSealedEvidence(res: { result?: { evidenceId?: string } }): { evidenceId: string } {
  const evidenceId = res?.result?.evidenceId;
  if (!evidenceId) throw new Error("Could not complete the capture session.");
  return { evidenceId };
}

/**
 * Seal a direct-capture session, or release its reservation.
 *
 * THE RULE EVERY DIRECT CAPTURE OBEYS. Sealing reserves an Evidence record
 * before the first part is uploaded and completes it last, so a failure
 * anywhere between the two leaves a reserved, custody-logged record with
 * nothing in it. `discardDirectCaptureSession` exists precisely to release
 * that, and `/capture` has always called it on failure — the two
 * screen-capture surfaces did not, so every failed screen capture left an
 * empty record in the owner's library and nothing ever removed it.
 *
 * The release is best-effort and never masks the original error: the caller
 * needs to know that the capture failed, not that the cleanup did. A session
 * that is already terminal answers 200, so a double release is harmless.
 */
export async function sealDirectCapture<T>(
  session: DirectCaptureSession,
  seal: () => Promise<T>,
): Promise<T> {
  try {
    return await seal();
  } catch (err) {
    await discardDirectCaptureSession(session).catch(() => undefined);
    throw err;
  }
}

/**
 * Abort an unsealed session and release the Evidence it reserved.
 *
 * The record is created by `reserveDirectCaptureEvidence` on the FIRST staged
 * item, so abandoning a capture without telling the server left a permanent,
 * custody-logged, empty record in the owner's library. Discard is a server
 * lifecycle transition, not a client state reset.
 *
 * Idempotent server-side; a session that is already terminal answers 200.
 */
export async function discardDirectCaptureSession(
  session: DirectCaptureSession,
): Promise<{ releasedEvidenceId: string | null; discarded: boolean }> {
  const res = await apiFetch(
    `/v1/capture/direct-sessions/${session.captureSessionId}/discard`,
    { method: "POST", body: JSON.stringify({}) },
  );
  const result = res?.result as
    | { releasedEvidenceId?: string | null; discarded?: boolean }
    | undefined;
  return {
    releasedEvidenceId: result?.releasedEvidenceId ?? null,
    discarded: Boolean(result?.discarded),
  };
}
