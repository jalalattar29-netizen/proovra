/**
 * PROOVRA API client for the capture session flow. Every call is authorized by
 * the server; the extension holds no policy. The server sets the acquisition
 * mode on the session — the client cannot grant itself DIRECT_WEB_CAPTURE.
 *
 * Every request is BOUNDED (a per-call timeout), so a hung network can never
 * leave a capture "running" forever; a timeout surfaces as a `NetworkError`,
 * which the orchestrator treats as an UNKNOWN outcome when it hits the seal.
 */
import { CONFIG } from "./config.js";

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

export const API_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

async function boundedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new NetworkError(`${init.method ?? "GET"} ${new URL(url).pathname} failed: ${err instanceof Error ? err.name : "error"}`);
  }
}

export async function apiFetch<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await boundedFetch(
    `${CONFIG.apiOrigin}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: "omit",
    },
    API_TIMEOUT_MS,
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const denial =
      json && typeof json === "object" && "denial" in json
        ? String((json as Record<string, unknown>).denial)
        : null;
    throw new ApiError(res.status, denial, `${method} ${path} -> ${res.status}`);
  }
  return json as T;
}

export type OpenSessionResult = { session: { captureSessionId: string; expiresAtUtc: string } };
export type ReserveResult = { evidence: { evidenceId: string } };
export type PartUpload = { upload: { bucket: string; key: string; putUrl: string } };

export const apiClient = {
  /**
   * UC-EXT-010 — `caseId` is sent ONLY when the user chose a case. The server
   * validates it through the canonical case-link authority (a case the caller
   * may not file into is refused), so the extension never decides case access.
   */
  async openWebSession(token: string, teamId: string, caseId?: string | null): Promise<OpenSessionResult> {
    return apiFetch(token, "POST", "/v1/capture/direct-sessions", {
      mode: "DIRECT_WEB_CAPTURE_EXTENSION",
      teamId,
      deviceId: null,
      ...(caseId ? { caseId } : {}),
    });
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
    input: { partIndex: number; mimeType: string; originalFileName: string },
  ): Promise<PartUpload> {
    return apiFetch(token, "POST", `/v1/evidence/${evidenceId}/parts`, input);
  },

  async putBytes(putUrl: string, bytes: Blob, contentType: string): Promise<void> {
    const res = await boundedFetch(
      putUrl,
      { method: "PUT", body: bytes, headers: { "content-type": contentType }, credentials: "omit" },
      UPLOAD_TIMEOUT_MS,
    );
    if (!res.ok) throw new ApiError(res.status, null, `PUT object -> ${res.status}`);
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
  async discardSession(token: string, sessionId: string): Promise<{ result: { discarded: boolean } }> {
    return apiFetch(token, "POST", `/v1/capture/direct-sessions/${sessionId}/discard`, {});
  },

  /** UC-EXT-009 — revoke THIS extension token's server session (sign-out). */
  async revokeExtensionToken(token: string): Promise<void> {
    await apiFetch(token, "POST", "/v1/oauth/extension/revoke", {});
  },
};

export type ApiClient = typeof apiClient;
