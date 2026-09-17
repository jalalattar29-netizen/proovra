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

export type DirectCaptureSession = {
  captureSessionId: string;
  expiresAtUtc: string;
};

export type DirectCaptureItemSource = "CAMERA" | "FILE_PICKER" | "SCREEN_FRAME" | "SCREEN_MANIFEST";

/** Acquisition modes the mobile app may open a direct-capture session for. */
export type DirectCaptureSessionMode = "PROOVRA_MOBILE_APP" | "DIRECT_SCREEN_CAPTURE_ANDROID";

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
    type: "PHOTO" | "VIDEO" | "DOCUMENT";
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

function base64ToHex(b64: string): string {
  const bin = globalThis.atob(b64);
  let out = "";
  for (let i = 0; i < bin.length; i += 1) {
    out += bin.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return out;
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
  const integrity = await computeFileIntegrityBase64(item.uri);
  const sha256Hex = base64ToHex(integrity.checksumSha256Base64);

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
