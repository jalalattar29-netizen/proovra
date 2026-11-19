/**
 * PROOVRA API client for the capture session flow. Every call is authorized by
 * the server; the extension holds no policy. The server sets the acquisition
 * mode on the session — the client cannot grant itself DIRECT_WEB_CAPTURE.
 *
 * Every request is BOUNDED (a per-call timeout), so a hung network can never
 * leave a capture "running" forever; a timeout surfaces as a `NetworkError`,
 * which the orchestrator treats as an UNKNOWN outcome when it hits the seal.
 */
import { classifyStoragePutStatus, parseRetryAfterMs } from "@proovra/shared";

import { CONFIG } from "./config.js";
import {
  CLIENT_UPDATE_STORAGE_KEY,
  clientContractReportHeaders,
  clientUpdateVerdict,
  escalateClientUpdate,
  noteClientReportAccepted,
  type ClientUpdateNotice,
} from "./client-contract.js";

/**
 * B8-F-402 — the strongest "update" verdict any API answer has given this
 * worker. Recorded for the popup (chrome.storage.local, best effort); a
 * response is NEVER blocked on it, and absent headers record nothing.
 */
let clientUpdateNotice: ClientUpdateNotice | null = null;

export function lastClientUpdateNotice(): ClientUpdateNotice | null {
  return clientUpdateNotice;
}

/** Tests only. */
export function resetClientUpdateNoticeForTests(): void {
  clientUpdateNotice = null;
}

export function observeClientContract(headers: { get(name: string): string | null } | null | undefined): void {
  let next: ClientUpdateNotice | null;
  try {
    next = escalateClientUpdate(clientUpdateNotice, clientUpdateVerdict(headers));
  } catch {
    return;
  }
  if (next === clientUpdateNotice) return;
  clientUpdateNotice = next;
  try {
    const storage = (globalThis as { chrome?: { storage?: { local?: { set(v: Record<string, unknown>): Promise<void> } } } }).chrome?.storage?.local;
    void storage?.set({ [CLIENT_UPDATE_STORAGE_KEY]: next })?.catch?.(() => undefined);
  } catch {
    /* no extension storage (tests) */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly denial: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The request never produced an HTTP answer (offline, DNS, timeout, CORS). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * F-P1-08 — storage refused the presigned PUT (an object-store answer, not an
 * API one). Read by THE shared storage-PUT rule: 408/425/429/5xx retried, 403
 * (the URL itself refused — expired) presigned again, anything else final.
 */
export class StoragePutError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`PUT object -> ${status}`);
    this.name = "StoragePutError";
  }
}

export const API_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

async function boundedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new NetworkError(`${init.method ?? "GET"} ${new URL(url).pathname} failed: ${err instanceof Error ? err.name : "error"}`);
  }
}

/**
 * A1-06 — the server's terms gate answers every authenticated write with the
 * shared nested shape (428 `{ error: { code: "LEGAL_REACCEPT_REQUIRED" } }`),
 * not a capture `denial`. It is carried as the denial so the popup can say what
 * to do (accept the current terms in PROOVRA) instead of a generic failure.
 * Only this code is lifted: every other nested code keeps its existing path.
 */
function legalGateCodeOf(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const error = (json as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  return (error as { code?: unknown }).code === "LEGAL_REACCEPT_REQUIRED" ? "LEGAL_REACCEPT_REQUIRED" : null;
}

/**
 * B4-F-100 — the refusal code an answer carries. The capture routes answer
 * `{ denial }`; the canonical part presign (POST /v1/evidence/:id/parts:
 * 409 `{ code: "STORAGE_LIMIT_REACHED", … }`) and the personal-space guard
 * answer a flat `{ code, message }` without `denial`. Reading only
 * `denial` turned those into a generic "Nothing was saved. Please try again"
 * with a Retry that repeats the same refusal. The nested A1-06 gate code is
 * lifted as before; no other nested code is.
 */
export function denialOf(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if ("denial" in o && o.denial != null) return String(o.denial);
  if (typeof o.code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(o.code)) return o.code;
  return legalGateCodeOf(json);
}

/** PURE — a response's Date header as epoch ms, or null (B4-F-103). */
export function serverDateMsOf(headers: { get(name: string): string | null } | null | undefined): number | null {
  const raw = headers?.get("date");
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export async function apiFetch<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return (await apiRequest<T>(token, method, path, body)).body;
}

async function apiRequest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ body: T; serverDateMs: number | null }> {
  const res = await boundedFetch(
    `${CONFIG.apiOrigin}${path}`,
    {
      method,
      headers: {
        // PRO-PSZ-05 — only once this API has said it accepts them (CORS).
        ...clientContractReportHeaders(),
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: "omit",
    },
    API_TIMEOUT_MS,
  );
  observeClientContract(res.headers);
  noteClientReportAccepted(res.headers);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    throw new ApiError(res.status, denialOf(json), `${method} ${path} -> ${res.status}`);
  }
  return { body: json as T, serverDateMs: serverDateMsOf(res.headers) };
}

export type OpenSessionResult = {
  session: {
    captureSessionId: string;
    expiresAtUtc: string;
    /** AUD-026 — true when the attempt's existing session was returned. */
    reused?: boolean;
    /** AUD-026 — the record the session already reserved, if any. */
    reservedEvidenceId?: string | null;
  };
  /**
   * B4-F-103 — the server's clock when it answered the open (its Date
   * header), so the capture window can be stated on the clock the server
   * checks it against. Null when the header is absent.
   */
  serverDateMs?: number | null;
};

/**
 * AUD-026 — a failure worth retrying: no HTTP answer at all, or an answer that
 * says "not now" (timeout, rate limit, server fault). A definite 4xx refusal
 * is never retried.
 */
export function isTransientFailure(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  // F-P1-08 — a storage PUT refusal is transient unless it refused the bytes.
  if (err instanceof StoragePutError) return classifyStoragePutStatus(err.status) !== "TERMINAL";
  if (err instanceof ApiError) return err.status === 408 || err.status === 425 || err.status === 429 || err.status >= 500;
  return false;
}
export type ReserveResult = { evidence: { evidenceId: string } };
export type PartUpload = { upload: { bucket: string; key: string; putUrl: string } };

export const apiClient = {
  /**
   * UC-EXT-010 — `caseId` is sent ONLY when the user chose a case. The server
   * validates it through the canonical case-link authority (a case the caller
   * may not file into is refused), so the extension never decides case access.
   *
   * AUD-026 — `clientAttemptId` is the capture attempt's id. The server keys the
   * session on it, so a retried open returns the SAME session (and the record
   * it already reserved) instead of opening a second capture.
   */
  async openWebSession(
    token: string,
    teamId: string,
    caseId: string | null,
    clientAttemptId: string,
  ): Promise<OpenSessionResult> {
    const r = await apiRequest<OpenSessionResult>(token, "POST", "/v1/capture/direct-sessions", {
      mode: "DIRECT_WEB_CAPTURE_EXTENSION",
      teamId,
      deviceId: null,
      clientAttemptId,
      ...(caseId ? { caseId } : {}),
    });
    return { ...r.body, serverDateMs: r.serverDateMs };
  },

  async reserveEvidence(
    token: string,
    sessionId: string,
    input: { type: string; mimeType: string; originalFileName?: string | null },
  ): Promise<ReserveResult> {
    return apiFetch(token, "POST", `/v1/capture/direct-sessions/${sessionId}/evidence`, input);
  },

  async createPart(
    token: string,
    evidenceId: string,
    input: { partIndex: number; mimeType: string; originalFileName: string; sizeBytes: number },
  ): Promise<PartUpload> {
    return apiFetch(token, "POST", `/v1/evidence/${evidenceId}/parts`, input);
  },

  async putBytes(putUrl: string, bytes: Blob, contentType: string): Promise<void> {
    const res = await boundedFetch(
      putUrl,
      { method: "PUT", body: bytes, headers: { "content-type": contentType }, credentials: "omit" },
      UPLOAD_TIMEOUT_MS,
    );
    if (!res.ok) throw new StoragePutError(res.status, parseRetryAfterMs(res.headers.get("Retry-After")));
  },

  async declarePart(
    token: string,
    sessionId: string,
    partIndex: number,
    input: { sha256: string; clientReportedSource: string },
  ): Promise<void> {
    await apiFetch(token, "POST", `/v1/capture/direct-sessions/${sessionId}/parts/${partIndex}/declaration`, {
      sha256: input.sha256,
      clientReportedSource: input.clientReportedSource,
      signed: null,
    });
  },

  async webComplete(
    token: string,
    sessionId: string,
    manifestJson: string,
  ): Promise<{ result: { evidenceId: string; bound: boolean; manifestPartIndex: number } }> {
    return apiFetch(token, "POST", `/v1/capture/direct-sessions/${sessionId}/web-complete`, {
      manifestJson,
    });
  },

  /**
   * UC-ARCH-009 — the seal-or-discard rule (same as mobile's sealDirectCapture).
   * Idempotent server-side, and it refuses a BOUND session, so it can never
   * remove sealed evidence.
   */
  async discardSession(token: string, sessionId: string): Promise<{ result: { discarded: boolean; status?: string } }> {
    return apiFetch(token, "POST", `/v1/capture/direct-sessions/${sessionId}/discard`, {});
  },

  /** UC-EXT-009 — revoke THIS extension token's server session (sign-out). */
  async revokeExtensionToken(token: string): Promise<void> {
    await apiFetch(token, "POST", "/v1/oauth/extension/revoke", {});
  },
};

export type ApiClient = typeof apiClient;
