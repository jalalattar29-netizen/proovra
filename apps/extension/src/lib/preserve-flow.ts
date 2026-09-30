/**
 * THE capture orchestration — one function, dependencies injected, NEVER throws.
 *
 * It used to live inline in background.ts with no try/catch around the server
 * steps, so:
 *   - a failure after the session opened left the reserved Evidence until the
 *     capture-reaper expired it (UC-ARCH-009) — mobile already discarded;
 *   - a 401 (expired/revoked token) was indistinguishable from a capture fault
 *     (UC-EXT-008);
 *   - a lost seal response was reported as "Nothing was saved" although a
 *     record may have sealed (UC-EXT-005).
 *
 * The outcome it returns is FACTUAL about what happened to the user's work:
 *   SUCCEEDED                 the server sealed the record;
 *   FAILED / NOTHING_SAVED    the server provably holds no sealed record (the
 *                             failure preceded the seal, the seal was refused
 *                             with a definite answer, or the session was
 *                             discarded);
 *   FAILED / UNKNOWN          the seal request got no definite answer and the
 *                             discard could not settle it — the user is told to
 *                             check the Evidence library, never "nothing saved".
 */
import type { WebCaptureArtifactDescriptor, WebCaptureLimitationCode } from "@proovra/shared";

import { ApiError, NetworkError, type ApiClient } from "./api-client.js";
import { CaptureCancelledError, type CaptureResult, type CapturedArtifact } from "./capture.js";
import { buildWebCaptureManifest } from "./manifest-builder.js";

export type PreserveRequest = {
  mode: "VIEWPORT" | "FULL_PAGE";
  teamId: string;
  /** UC-EXT-010 — optional case to file the capture into (server-validated). */
  caseId?: string | null;
  tabId: number;
  windowId: number;
  evidenceType: "PHOTO" | "DOCUMENT";
};

export type PreserveFailureReason = "SIGNED_OUT" | "DENIED" | "CANCELLED" | "ERROR";

export type PreserveOutcome =
  | { status: "SUCCEEDED"; evidenceId: string; limitations: WebCaptureLimitationCode[]; completeness: string }
  | {
      status: "FAILED";
      /** What is true about the user's work. */
      outcome: "NOTHING_SAVED" | "UNKNOWN";
      reason: PreserveFailureReason;
      denial: string | null;
      /** The reserved record id, when one was reserved (for "check the library"). */
      evidenceId: string | null;
      /** Debug-only detail. NEVER user copy. */
      detail: string;
    };

export type PreserveDeps = {
  api: Pick<
    ApiClient,
    "openWebSession" | "reserveEvidence" | "createPart" | "putBytes" | "declarePart" | "webComplete" | "discardSession"
  >;
  getToken: () => Promise<string | null>;
  clearToken: () => Promise<void>;
  prepare: (tabId: number) => Promise<void>;
  capture: (req: PreserveRequest, signal: AbortSignal) => Promise<CaptureResult>;
  sha256Hex: (input: string) => Promise<string>;
  progress: (step: string, detail?: string) => void;
  browser: { name: string; versionBucket: string; os: string };
  extensionVersion: string;
  now?: () => Date;
};

const SOURCE_BY_ROLE: Record<CapturedArtifact["role"], string> = {
  viewport_screenshot: "WEB_VIEWPORT",
  page_tile: "WEB_FULL_PAGE",
  dom_snapshot: "WEB_DOM",
};

/** Denials that mean the discard found the session already SEALED. */
const SEALED_DENIALS = new Set(["SESSION_NOT_ACTIVE", "EVIDENCE_ALREADY_FINALIZED"]);

function describe(err: unknown): string {
  if (err instanceof ApiError) return `${err.message}${err.denial ? ` (${err.denial})` : ""}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function isAuthFailure(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** A definite HTTP refusal (not a timeout, not a 5xx) — the server did NOT act. */
function isDefiniteRefusal(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500;
}

export async function runPreserveFlow(
  deps: PreserveDeps,
  req: PreserveRequest,
  signal: AbortSignal,
): Promise<PreserveOutcome> {
  const now = deps.now ?? (() => new Date());
  const token = await deps.getToken();
  if (!token) {
    return {
      status: "FAILED",
      outcome: "NOTHING_SAVED",
      reason: "SIGNED_OUT",
      denial: null,
      evidenceId: null,
      detail: "no stored token",
    };
  }

  let sessionId: string | null = null;
  let evidenceId: string | null = null;
  let sealAttempted = false;

  const cancelled = () => {
    if (signal.aborted) throw new CaptureCancelledError();
  };

  try {
    deps.progress("preparing");
    await deps.prepare(req.tabId);
    cancelled();

    const startedAtUtc = now().toISOString();
    deps.progress("capturing", req.mode === "FULL_PAGE" ? "full page" : "visible area");
    const capture = await deps.capture(req, signal);
    const endedAtUtc = now().toISOString();
    cancelled();
    if (capture.artifacts.length === 0) throw new Error("capture produced no artifacts");

    deps.progress("opening_session");
    const opened = await deps.api.openWebSession(token, req.teamId, req.caseId ?? null);
    sessionId = opened.session.captureSessionId;
    cancelled();

    deps.progress("reserving");
    const reserve = await deps.api.reserveEvidence(token, sessionId, {
      type: req.evidenceType,
      mimeType: capture.artifacts[0]?.mediaType ?? "image/png",
      originalFileName: `web-capture-${capture.pageInfo.title ?? "page"}`.slice(0, 120),
    });
    evidenceId = reserve.evidence.evidenceId;

    const descriptors: WebCaptureArtifactDescriptor[] = [];
    for (let i = 0; i < capture.artifacts.length; i += 1) {
      cancelled();
      const a = capture.artifacts[i]!;
      deps.progress("uploading", `artifact ${i + 1}/${capture.artifacts.length + 1}`);
      const part = await deps.api.createPart(token, evidenceId, {
        partIndex: i,
        mimeType: a.mediaType,
        originalFileName: `${a.role}-${i}`,
      });
      await deps.api.putBytes(part.upload.putUrl, a.blob, a.mediaType);
      await deps.api.declarePart(token, sessionId, i, {
        sha256: a.sha256,
        clientReportedSource: SOURCE_BY_ROLE[a.role],
      });
      descriptors.push({
        role: a.role,
        partIndex: i,
        expectedSha256: a.sha256,
        sizeBytes: a.blob.size,
        mediaType: a.mediaType,
        completeness: "CAPTURED",
        ...(a.tileIndex !== undefined ? { tileIndex: a.tileIndex, scrollOffsetY: a.scrollOffsetY ?? null } : {}),
      });
    }

    const manifestPartIndex = capture.artifacts.length;
    const { manifest, manifestJson } = buildWebCaptureManifest({
      captureMode: req.mode,
      captureSessionId: sessionId,
      captureStartedAtUtc: startedAtUtc,
      captureEndedAtUtc: endedAtUtc,
      sourceUrl: capture.pageInfo.url,
      title: capture.pageInfo.title,
      browser: {
        ...deps.browser,
        viewportW: capture.pageInfo.viewportW,
        viewportH: capture.pageInfo.viewportH,
        devicePixelRatio: capture.pageInfo.devicePixelRatio,
      },
      extensionVersion: deps.extensionVersion,
      artifacts: descriptors,
      pageMutatedDuringCapture: capture.pageMutatedDuringCapture,
      limitations: capture.limitations,
      domSnapshotMissing: capture.domSnapshotMissing,
      notes: capture.notes,
    });

    cancelled();
    deps.progress("uploading", "capture manifest");
    const manifestBytes = new Blob([manifestJson], { type: "application/json" });
    const manifestPart = await deps.api.createPart(token, evidenceId, {
      partIndex: manifestPartIndex,
      mimeType: "application/json",
      originalFileName: "capture-manifest.json",
    });
    await deps.api.putBytes(manifestPart.upload.putUrl, manifestBytes, "application/json");
    await deps.api.declarePart(token, sessionId, manifestPartIndex, {
      sha256: await deps.sha256Hex(manifestJson),
      clientReportedSource: "WEB_MANIFEST",
    });

    cancelled();
    deps.progress("sealing");
    // From here the user can no longer cancel: the seal is one request.
    sealAttempted = true;
    await deps.api.webComplete(token, sessionId, manifestJson);
    deps.progress("done");
    return {
      status: "SUCCEEDED",
      evidenceId,
      limitations: [...manifest.limitations],
      completeness: manifest.completeness,
    };
  } catch (err) {
    const reason: PreserveFailureReason =
      err instanceof CaptureCancelledError
        ? "CANCELLED"
        : isAuthFailure(err)
          ? "SIGNED_OUT"
          : err instanceof ApiError && err.denial
            ? "DENIED"
            : "ERROR";
    if (reason === "SIGNED_OUT") await deps.clearToken().catch(() => undefined);
    const denial = err instanceof ApiError ? err.denial : null;
    const detail = describe(err);

    // Nothing was opened server-side: provably nothing saved.
    if (!sessionId) {
      return { status: "FAILED", outcome: "NOTHING_SAVED", reason, denial, evidenceId: null, detail };
    }

    // The seal may have happened only if the seal request itself failed without
    // a definite refusal (timeout / network / 5xx).
    const sealMayHaveHappened = sealAttempted && !isDefiniteRefusal(err);

    // UC-ARCH-009 — seal-or-discard. Discard is idempotent and refuses a sealed
    // session, so it is safe to send whether or not the seal happened, and its
    // answer SETTLES the unknown case. With a revoked token it cannot run; the
    // capture-reaper releases the reservation.
    if (reason !== "SIGNED_OUT") {
      try {
        deps.progress("discarding");
        await deps.api.discardSession(token, sessionId);
        return { status: "FAILED", outcome: "NOTHING_SAVED", reason, denial, evidenceId, detail };
      } catch (discardErr) {
        if (discardErr instanceof ApiError && discardErr.denial && SEALED_DENIALS.has(discardErr.denial) && evidenceId) {
          // The server says the session is already SEALED: the record exists.
          return { status: "SUCCEEDED", evidenceId, limitations: [], completeness: "UNREPORTED" };
        }
        if (!sealMayHaveHappened) {
          return { status: "FAILED", outcome: "NOTHING_SAVED", reason, denial, evidenceId, detail };
        }
        return {
          status: "FAILED",
          outcome: "UNKNOWN",
          reason,
          denial,
          evidenceId,
          detail: `${detail}; discard: ${describe(discardErr)}`,
        };
      }
    }
    return {
      status: "FAILED",
      outcome: sealMayHaveHappened ? "UNKNOWN" : "NOTHING_SAVED",
      reason,
      denial,
      evidenceId,
      detail,
    };
  }
}

export { NetworkError };
