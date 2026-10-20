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

import { ApiError, NetworkError, isTransientFailure, type ApiClient } from "./api-client.js";
import {
  CaptureCancelledError,
  CaptureInterruptedError,
  type CaptureResult,
  type CapturedArtifact,
} from "./capture.js";
import { buildWebCaptureManifest } from "./manifest-builder.js";
import { isRestrictedScriptingError, pageRestriction } from "./page-eligibility.js";

export type PreserveRequest = {
  mode: "VIEWPORT" | "FULL_PAGE";
  teamId: string;
  /** UC-EXT-010 — optional case to file the capture into (server-validated). */
  caseId?: string | null;
  tabId: number;
  windowId: number;
  evidenceType: "PHOTO" | "DOCUMENT";
};

export type PreserveFailureReason =
  | "SIGNED_OUT"
  | "DENIED"
  | "CANCELLED"
  | "ERROR"
  /** AUD-026 — the browser does not let extensions capture this page. */
  | "RESTRICTED_PAGE"
  /** AUD-026 — the user switched tab mid-capture; nothing mixed was sealed. */
  | "TAB_CHANGED"
  /** AUD-026 — the page navigated mid-capture; nothing mixed was sealed. */
  | "PAGE_NAVIGATED";

/**
 * AUD-026 — bounded retry of each server step. Every step is idempotent on the
 * server (the open is keyed by the attempt id, a part re-presign returns the
 * existing part, a declaration with the same digest is accepted again, a
 * re-seal of a sealed session answers "already"), so a step that got no
 * definite answer is simply sent again — and the upload resumes from the step
 * that failed rather than starting over.
 */
export const RETRY_POLICY = Object.freeze({
  attempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
  /** How long to wait for the browser to come back online before a retry. */
  offlineWaitMs: 60_000,
});

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
  /** AUD-026 — this capture attempt's id; the server's idempotency key for the open. */
  attemptId: string;
  /** The tab's URL as the browser reports it (null when not visible). */
  tabUrl?: string | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Resolves when the browser reports it is online, or after `timeoutMs`. */
  waitForOnline?: (timeoutMs: number) => Promise<void>;
};

const SOURCE_BY_ROLE: Record<CapturedArtifact["role"], string> = {
  viewport_screenshot: "WEB_VIEWPORT",
  page_tile: "WEB_FULL_PAGE",
  dom_snapshot: "WEB_DOM",
};

/** Denials that mean the discard found the session already SEALED. */
const SEALED_DENIALS = new Set(["SESSION_NOT_ACTIVE", "EVIDENCE_ALREADY_FINALIZED"]);

/** AUD-52 — a page's host, or "page" when the address has none. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname || "page";
  } catch {
    return "page";
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return `${err.message}${err.denial ? ` (${err.denial})` : ""}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function isAuthFailure(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * AUD-23 (2026-10-20) — SESSION_BUSY is not an answer. The server says it while
 * ANOTHER seal of this session holds the claim (a slow seal, a retried one):
 * that seal may well complete. It is never a definite refusal, and a discard
 * that meets it settles nothing.
 */
const BUSY_DENIAL = "SESSION_BUSY";

/** A definite HTTP refusal (not a timeout, not a 5xx, not busy) — the server did NOT act. */
function isDefiniteRefusal(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && err.denial !== BUSY_DENIAL;
}

export async function runPreserveFlow(
  deps: PreserveDeps,
  req: PreserveRequest,
  signal: AbortSignal,
): Promise<PreserveOutcome> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitForOnline = deps.waitForOnline ?? (async () => undefined);
  const restriction = pageRestriction(deps.tabUrl ?? null);
  if (restriction) {
    return {
      status: "FAILED",
      outcome: "NOTHING_SAVED",
      reason: "RESTRICTED_PAGE",
      denial: restriction,
      evidenceId: null,
      detail: `restricted page: ${restriction}`,
    };
  }
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

  async function withRetry<T>(step: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!isTransientFailure(err) || attempt >= RETRY_POLICY.attempts) throw err;
        deps.progress("retrying", `${step} (attempt ${attempt + 1} of ${RETRY_POLICY.attempts})`);
        await waitForOnline(RETRY_POLICY.offlineWaitMs);
        await sleep(Math.min(RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1), RETRY_POLICY.maxDelayMs));
        cancelled();
      }
    }
  }

  try {
    deps.progress("preparing");
    try {
      await deps.prepare(req.tabId);
    } catch (err) {
      if (isRestrictedScriptingError(err)) {
        return {
          status: "FAILED",
          outcome: "NOTHING_SAVED",
          reason: "RESTRICTED_PAGE",
          denial: "BROWSER_INTERNAL_PAGE",
          evidenceId: null,
          detail: describe(err),
        };
      }
      throw err;
    }
    cancelled();

    const startedAtUtc = now().toISOString();
    deps.progress("capturing", req.mode === "FULL_PAGE" ? "full page" : "visible area");
    const capture = await deps.capture(req, signal);
    const endedAtUtc = now().toISOString();
    cancelled();
    if (capture.artifacts.length === 0) throw new Error("capture produced no artifacts");

    const open = () =>
      withRetry("opening_session", () =>
        deps.api.openWebSession(token, req.teamId, req.caseId ?? null, deps.attemptId),
      );
    deps.progress("opening_session");
    const opened = await open();
    const openSessionId = opened.session.captureSessionId;
    sessionId = openSessionId;
    cancelled();

    deps.progress("reserving");
    evidenceId = opened.session.reservedEvidenceId ?? null;
    if (!evidenceId) {
      try {
        const reserve = await withRetry("reserving", () =>
          deps.api.reserveEvidence(token, openSessionId, {
            type: req.evidenceType,
            mimeType: capture.artifacts[0]?.mediaType ?? "image/png",
            // AUD-52 (2026-10-20): never the page title — it can name a person,
            // an inbox or a document — and it was shown as the record's file
            // name. The host alone, which the manifest records anyway.
            originalFileName: `web-capture-${hostOf(capture.pageInfo.url)}`.slice(0, 120),
          }),
        );
        evidenceId = reserve.evidence.evidenceId;
      } catch (err) {
        // A reserve whose answer was lost DID reserve: its retry is refused with
        // SESSION_ALREADY_RESERVED, and the attempt's open names the record.
        if (!(err instanceof ApiError && err.denial === "SESSION_ALREADY_RESERVED")) throw err;
        const again = await open();
        if (again.session.captureSessionId !== openSessionId || !again.session.reservedEvidenceId) throw err;
        evidenceId = again.session.reservedEvidenceId;
      }
    }
    const recordId = evidenceId;

    const descriptors: WebCaptureArtifactDescriptor[] = [];
    for (let i = 0; i < capture.artifacts.length; i += 1) {
      cancelled();
      const a = capture.artifacts[i]!;
      deps.progress("uploading", `artifact ${i + 1}/${capture.artifacts.length + 1}`);
      const part = await withRetry("uploading", () =>
        deps.api.createPart(token, recordId, {
          partIndex: i,
          mimeType: a.mediaType,
          originalFileName: `${a.role}-${i}`,
        }),
      );
      await withRetry("uploading", () => deps.api.putBytes(part.upload.putUrl, a.blob, a.mediaType));
      await withRetry("uploading", () =>
        deps.api.declarePart(token, openSessionId, i, {
          sha256: a.sha256,
          clientReportedSource: SOURCE_BY_ROLE[a.role],
        }),
      );
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
    const manifestSha256 = await deps.sha256Hex(manifestJson);
    const manifestPart = await withRetry("uploading", () =>
      deps.api.createPart(token, recordId, {
        partIndex: manifestPartIndex,
        mimeType: "application/json",
        originalFileName: "capture-manifest.json",
      }),
    );
    await withRetry("uploading", () =>
      deps.api.putBytes(manifestPart.upload.putUrl, manifestBytes, "application/json"),
    );
    await withRetry("uploading", () =>
      deps.api.declarePart(token, openSessionId, manifestPartIndex, {
        sha256: manifestSha256,
        clientReportedSource: "WEB_MANIFEST",
      }),
    );

    cancelled();
    deps.progress("sealing");
    // From here the user can no longer cancel: the seal is one request.
    sealAttempted = true;
    // A re-seal of a sealed session answers "already", so the seal retries too.
    await withRetry("sealing", () => deps.api.webComplete(token, openSessionId, manifestJson));
    deps.progress("done");
    return {
      status: "SUCCEEDED",
      evidenceId: recordId,
      limitations: [...manifest.limitations],
      completeness: manifest.completeness,
    };
  } catch (err) {
    const reason: PreserveFailureReason =
      err instanceof CaptureCancelledError
        ? "CANCELLED"
        : err instanceof CaptureInterruptedError
          ? err.code
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
        const discard = await deps.api.discardSession(token, sessionId);
        // AUD-52 (2026-10-20) — the answer is read, not assumed: "nothing was
        // saved" only when the server released the session now, or reports it
        // already DISCARDED / EXPIRED. Anything else settles nothing.
        const r = (discard as { result?: { discarded?: boolean; status?: string } } | null)?.result;
        if (r?.discarded === true || r?.status === "DISCARDED" || r?.status === "EXPIRED") {
          return { status: "FAILED", outcome: "NOTHING_SAVED", reason, denial, evidenceId, detail };
        }
        return {
          status: "FAILED",
          outcome: "UNKNOWN",
          reason,
          denial,
          evidenceId,
          detail: `${detail}; discard did not settle the session (${r?.status ?? "no answer"})`,
        };
      } catch (discardErr) {
        if (discardErr instanceof ApiError && discardErr.denial && SEALED_DENIALS.has(discardErr.denial) && evidenceId) {
          // The server says the session is already SEALED: the record exists.
          return { status: "SUCCEEDED", evidenceId, limitations: [], completeness: "UNREPORTED" };
        }
        const discardBusy = discardErr instanceof ApiError && discardErr.denial === BUSY_DENIAL;
        if (!sealMayHaveHappened && !discardBusy) {
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
