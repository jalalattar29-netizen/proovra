"use client";

/**
 * UC-4 — Derived Review client hook.
 *
 * Reads the bounded, source-linked DERIVED review projection for one evidence
 * and drives generation/regeneration. The server projects the safe shape
 * (reconstructed blocks + per-block source links + keyframe bytes-proxy URLs —
 * never storage keys); this hook plumbs it into React and normalizes the
 * cross-origin proxy URLs.
 *
 * Hard rules:
 *   * Never throws — failures land in `error`.
 *   * Polls only while a run is PENDING/PROCESSING (clamped), then stops.
 *   * Everything shown is DERIVED — the UI labels it as such.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl, apiFetch } from "../api";

export type DerivedReviewStatus = {
  requested: boolean;
  status: "NOT_REQUESTED" | "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "DISMISSED";
  lastError: string | null;
  updatedAtUtc: string | null;
  hasDescriptor: boolean;
};

export type DerivedReviewBlock = {
  blockId: string;
  sequence: number;
  kind: "TEXT" | "MEDIA" | "VISIBLE_LABEL" | "VISIBLE_TIMESTAMP" | "SYSTEM" | "UNKNOWN";
  text: string;
  confidence: "HIGH_OVERLAP" | "PARTIAL_OVERLAP" | "AMBIGUOUS" | "UNRESOLVED";
  observedInFrames: number;
  sources: Array<{
    evidencePartId: string;
    keyframeIds: string[];
    offsetMsRange: [number, number];
  }>;
};

export type DerivedReviewProjection = {
  schemaVersion: string;
  descriptorVersion: number;
  provenance: { reconstructed: string; machineExtracted: string };
  ocrEnabled: boolean;
  coverage: "COMPLETE" | "PARTIAL";
  acquisitionComplete: boolean;
  limitations: string[];
  transformationVersions: { keyframe: string; ocr: string; reconstruction: string };
  generatedAtUtc: string;
  stats: {
    sourcePartCount: number;
    keyframeCount: number;
    ocrRegionCount: number;
    ocrFailedKeyframes: number;
    observationCount: number;
    blockCount: number;
    derivedBytes: number;
  };
  blockTotal: number;
  page: { offset: number; limit: number };
  blocks: DerivedReviewBlock[];
};

export type DerivedReviewResponse = {
  evidenceId: string;
  status: DerivedReviewStatus;
  projection: DerivedReviewProjection | null;
  keyframeBytesUrls: Record<string, string | null>;
};

function normalizeKeyframeUrls(
  urls: Record<string, string | null>,
): Record<string, string | null> {
  const base = apiBaseUrl().replace(/\/+$/, "");
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(urls)) {
    out[k] = v && v.startsWith("/") ? `${base}${v}` : v;
  }
  return out;
}

export type UseDerivedReviewInput = {
  evidenceId: string;
  teamId: string | null;
  enabled?: boolean;
  /** Block pagination (bounded server-side). */
  offset?: number;
  limit?: number;
};

export type UseDerivedReviewState = {
  loading: boolean;
  data: DerivedReviewResponse | null;
  error: { code: string } | null;
};

export type UseDerivedReviewApi = {
  state: UseDerivedReviewState;
  refresh: () => Promise<void>;
  generate: (
    regenerate?: boolean,
  ) => Promise<{ ok: true; queued: boolean } | { ok: false; reason: string }>;
};

export function useDerivedReview(input: UseDerivedReviewInput): UseDerivedReviewApi {
  const { evidenceId, teamId, enabled = true, offset = 0, limit = 100 } = input;
  const [state, setState] = useState<UseDerivedReviewState>({
    loading: false,
    data: null,
    error: null,
  });
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!teamId || !enabled) return;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = (await apiFetch(
        `/v1/evidence/${encodeURIComponent(evidenceId)}/derived-review?teamId=${encodeURIComponent(teamId)}&offset=${offset}&limit=${limit}`,
      )) as DerivedReviewResponse;
      if (!mountedRef.current) return;
      setState({
        loading: false,
        data: {
          ...res,
          keyframeBytesUrls: normalizeKeyframeUrls(res.keyframeBytesUrls ?? {}),
        },
        error: null,
      });
    } catch (err) {
      if (!mountedRef.current) return;
      const code =
        err instanceof Error && "statusCode" in err
          ? `http_${(err as Error & { statusCode?: number }).statusCode ?? "unknown"}`
          : "network_error";
      setState({ loading: false, data: null, error: { code } });
    }
  }, [evidenceId, teamId, enabled, offset, limit]);

  const generate = useCallback(
    async (regenerate = false) => {
      if (!teamId) return { ok: false, reason: "missing_team_id" } as const;
      try {
        const res = (await apiFetch(
          `/v1/evidence/${encodeURIComponent(evidenceId)}/derived-review/generate`,
          { method: "POST", body: JSON.stringify({ teamId, regenerate }) },
        )) as { queued: boolean; reason: string | null };
        void refresh();
        return { ok: true as const, queued: Boolean(res.queued) };
      } catch (err) {
        return {
          ok: false as const,
          reason:
            err instanceof Error
              ? `request_failed:${err.message.slice(0, 80)}`
              : "request_failed",
        };
      }
    },
    [evidenceId, teamId, refresh],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // Poll only while a run is in flight; stop once it settles.
  const runStatus = state.data?.status.status;
  useEffect(() => {
    if (runStatus !== "PENDING" && runStatus !== "PROCESSING") return;
    const handle = setInterval(() => void refresh(), 4000);
    return () => clearInterval(handle);
  }, [runStatus, refresh]);

  return { state, refresh, generate };
}
