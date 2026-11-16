import {
  classifyStoragePutStatus,
  parseRetryAfterMs,
  STORAGE_PUT_RETRY,
  storagePutDeadlineMs,
  storagePutRetryDelayMs,
} from "@proovra/shared";

import { apiFetch } from "../../../../lib/api";
import { sha256Base64OfBlob } from "../../../../lib/uploads/streaming-sha256";
import { normalizeClientMimeType } from "../_lib/file-utils";
import { computeIntegrityFromBlob } from "../_lib/hash-utils";
import type { SessionItem } from "../_lib/types";

/**
 * The web capture's legacy (single-PUT) part upload: presign through
 * POST /v1/evidence/:id/parts, PUT the bytes to storage, retry by THE shared
 * storage-PUT rule (F-P1-08, @proovra/shared storage-put-retry).
 *
 * Before: three attempts at 500/1000 ms, every 4xx (429 included) terminal,
 * an expired URL never re-presigned, no deadline, and an XHR `status === 0`
 * in onload read as success — a PUT that never reached storage could be
 * reported uploaded and the seal then refused it. Now: 408/425/429/5xx and no
 * answer at all are retried with jitter and a bounded Retry-After; a 403
 * (storage refused the URL — expired) presigns again for the same part (the
 * parts route is idempotent for the same bound file); anything else is final.
 */

/** C-05 — the per-file metadata a part carries (null = none). */
export type PartMetadata = {
  privateRole: string | null;
  privateNote: string | null;
  checklistStepId: string | null;
  sourceLabel: string | null;
};

export function partMetadataOf(item: SessionItem): PartMetadata {
  return {
    privateRole: item.role?.trim() || null,
    privateNote: item.privateNote?.trim() || null,
    checklistStepId: item.checklistStepId || null,
    sourceLabel: item.sourceLabel?.trim() || null,
  };
}

/** True when the item's metadata differs from what was last sent for it. */
export function partMetadataChanged(item: SessionItem, sent: PartMetadata | undefined): boolean {
  if (!sent) return false;
  const now = partMetadataOf(item);
  return (Object.keys(now) as Array<keyof PartMetadata>).some((key) => now[key] !== sent[key]);
}

/**
 * The metadata fields of a presign body: a value is sent as is; an empty one is
 * omitted (the server keeps what it holds) unless it was sent before, when null
 * clears it (C-05).
 */
function metadataFields(item: SessionItem, previous?: PartMetadata): Partial<PartMetadata> {
  const now = partMetadataOf(item);
  const out: Partial<PartMetadata> = {};
  for (const key of Object.keys(now) as Array<keyof PartMetadata>) {
    if (now[key]) out[key] = now[key];
    else if (previous?.[key]) out[key] = null;
  }
  return out;
}

/**
 * B4-F-300 — the file name a part records: the basename only. The server's
 * sanitizeFileName strips a folder upload's relative path on the ordinary
 * door; the resumable door stored what it was sent, so the client never sends
 * the path there (same rule: last segment of `/` or `\`, trimmed).
 */
export function capturedFileBasename(item: Pick<SessionItem, "relativePath" | "file">): string {
  const raw = (item.relativePath || item.file.name || "").trim();
  const last = raw.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  return last && last !== "." && last !== ".." ? last : item.file.name;
}

/**
 * C-05 / F-P1-09 — the per-file client signals a part carries (both doors:
 * the ordinary presign and, B4-F-300, the resumable session), incl. the
 * silent-video marker.
 */
export function partClientSignals(item: SessionItem, locationIncluded: boolean) {
  const s = item.clientSignals;
  return s
    ? {
        captureTimeUtc: s.captureTimeUtc,
        browserMediaCaptureAvailable: s.browserMediaCaptureAvailable,
        folderPathPresent: s.folderPathPresent,
        locationIncluded,
        duplicateStatus: s.duplicateStatus,
        screenshotLike: s.screenshotLike,
        genericMime: s.genericMime,
        oldLastModified: s.oldLastModified,
        clientHintSha256Base64: s.clientHintSha256Base64,
        // F-P1-09 parity — a video recorded without microphone says so, as native does.
        ...(s.audioNotCapturedReason ? { audioTracks: s.audioTracks ?? [], audioNotCapturedReason: s.audioNotCapturedReason } : {}),
      }
    : undefined;
}

/** B4-F-300 — the metadata fields a NEW part carries (empty ones omitted). */
export function newPartMetadataFields(item: SessionItem): Partial<PartMetadata> {
  return metadataFields(item);
}

function partBody(
  item: SessionItem,
  index: number,
  integrity: { checksumSha256Base64: string; contentMd5Base64?: string },
  locationIncluded: boolean,
  previous?: PartMetadata,
) {
  return {
    partIndex: index,
    mimeType: normalizeClientMimeType(item.mimeType),
    originalFileName: item.relativePath || item.file.name,
    checksumSha256Base64: integrity.checksumSha256Base64,
    ...(integrity.contentMd5Base64 ? { contentMd5Base64: integrity.contentMd5Base64 } : {}),
    sizeBytes: item.file.size,
    ...metadataFields(item, previous),
    clientSignals: partClientSignals(item, locationIncluded),
  };
}

const postPart = (evidenceId: string, body: unknown) =>
  apiFetch(`/v1/evidence/${evidenceId}/parts`, { method: "POST", body: JSON.stringify(body) }) as Promise<{
    upload: { putUrl: string };
  }>;

type PutAnswer = { status: number; retryAfterMs: number | null };

function putOnce(
  putUrl: string,
  item: SessionItem,
  integrity: { checksumSha256Base64: string; contentMd5Base64: string },
  onProgress: (fraction: number) => void,
): Promise<PutAnswer> {
  return new Promise<PutAnswer>((resolve) => {
    const xhr = new XMLHttpRequest();
    const noAnswer = () => resolve({ status: 0, retryAfterMs: null });
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onerror = noAnswer;
    xhr.ontimeout = noAnswer;
    xhr.onabort = noAnswer;
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        retryAfterMs:
          typeof xhr.getResponseHeader === "function" ? parseRetryAfterMs(xhr.getResponseHeader("Retry-After")) : null,
      });
    xhr.open("PUT", putUrl);
    xhr.timeout = storagePutDeadlineMs(item.file.size);
    xhr.setRequestHeader("content-type", normalizeClientMimeType(item.mimeType));
    xhr.setRequestHeader("x-amz-checksum-sha256", integrity.checksumSha256Base64);
    xhr.setRequestHeader("Content-MD5", integrity.contentMd5Base64);
    xhr.send(item.file);
  });
}

export type LegacyPartUploadDeps = {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Presign, PUT and retry one staged item as part `index` of the record. */
export async function uploadLegacyPart(input: {
  evidenceId: string;
  index: number;
  item: SessionItem;
  locationIncluded: boolean;
  onProgress: (fraction: number) => void;
  deps?: LegacyPartUploadDeps;
}): Promise<void> {
  const { evidenceId, index, item, locationIncluded, onProgress } = input;
  const sleep = input.deps?.sleep ?? realSleep;
  const integrity = await computeIntegrityFromBlob(item.file);
  const presign = () => postPart(evidenceId, partBody(item, index, integrity, locationIncluded));
  let part = await presign();
  for (let attempt = 1; ; attempt += 1) {
    const answer = await putOnce(part.upload.putUrl, item, integrity, onProgress);
    const kind = classifyStoragePutStatus(answer.status);
    if (kind === "SUCCESS") return;
    const failure = Object.assign(new Error(answer.status ? `Upload failed (${answer.status})` : "Upload failed"), {
      storageStatus: answer.status,
      transient: kind !== "TERMINAL",
    });
    if (kind === "TERMINAL" || attempt >= STORAGE_PUT_RETRY.attempts) throw failure;
    const wait = storagePutRetryDelayMs(attempt, answer.retryAfterMs, input.deps?.random);
    if (wait === null) throw failure;
    await sleep(wait);
    if (kind === "REPRESIGN") part = await presign();
  }
}

/**
 * C-05 — restate an uploaded part's metadata before the seal: an idempotent
 * re-presign of the SAME file (same name, type, size and digest), whose URL is
 * not used. The server changes only the part's note/role/step/label, and only
 * while the record is unsealed and the file is the one bound to that index.
 */
export async function restatePartMetadata(input: {
  evidenceId: string;
  index: number;
  item: SessionItem;
  locationIncluded: boolean;
  previous: PartMetadata;
  /** The file's digest when the caller already computed it (resumable path). */
  checksumSha256Base64?: string;
}): Promise<void> {
  const { evidenceId, index, item, locationIncluded, previous } = input;
  const checksumSha256Base64 =
    input.checksumSha256Base64 ?? item.clientSignals?.clientHintSha256Base64 ?? (await sha256Base64OfBlob(item.file));
  const body = partBody(item, index, { checksumSha256Base64 }, locationIncluded, previous);
  try {
    await postPart(evidenceId, body);
  } catch (err) {
    // COMPAT — an API older than this build refuses `null` (it cannot clear a
    // value: 400 INVALID_INPUT) and returns the part unchanged anyway. Send the
    // restatement without the cleared keys, so the seal is not blocked.
    const cleared = (Object.keys(body) as Array<keyof typeof body>).filter((key) => body[key] === null);
    if (cleared.length === 0 || !refusedAsInvalidInput(err)) throw err;
    const compatible: Record<string, unknown> = { ...body };
    for (const key of cleared) delete compatible[key];
    await postPart(evidenceId, compatible);
  }
}

function refusedAsInvalidInput(err: unknown): boolean {
  const e = err as { statusCode?: unknown; code?: unknown } | null;
  return e?.statusCode === 400 && (e.code === "INVALID_INPUT" || e.code === "VALIDATION_ERROR");
}
