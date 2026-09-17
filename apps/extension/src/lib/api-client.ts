/**
 * PROOVRA API client for the capture session flow. Every call is authorized by
 * the server; the extension holds no policy. The server sets the acquisition
 * mode on the session — the client cannot grant itself DIRECT_WEB_CAPTURE.
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

async function apiFetch<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${CONFIG.apiOrigin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    credentials: "omit",
  });
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
  async openWebSession(token: string, teamId: string): Promise<OpenSessionResult> {
    return apiFetch(token, "POST", "/v1/capture/direct-sessions", {
      mode: "DIRECT_WEB_CAPTURE_EXTENSION",
      teamId,
      deviceId: null,
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
    const res = await fetch(putUrl, { method: "PUT", body: bytes, headers: { "content-type": contentType } });
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
};
