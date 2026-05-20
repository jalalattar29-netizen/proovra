"use client";

/**
 * Phase 31.13 — Derived assets client hook.
 *
 * Reads the bounded list of derived assets for one evidence record.
 * The server projects the safe shape (no storage internals); this
 * hook just plumbs state into React.
 *
 * Hard rules:
 *   * Never throws — failures land in `error`.
 *   * Bounded result shape (mirrors `DerivedAssetRow` server-side).
 *   * `trigger(evidencePartId, assetKind)` enqueues a generation
 *     job; idempotent on the server.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../api";

export type DerivedAssetKind =
  | "image_thumbnail"
  | "video_frame"
  | "audio_waveform"
  | "low_res_proxy"
  | "compact_review_preview";

export type DerivedAssetStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "UNSUPPORTED";

export type DerivedAssetRow = {
  id: string;
  evidenceId: string;
  evidencePartId: string;
  assetKind: DerivedAssetKind;
  status: DerivedAssetStatus;
  derivedSha256: string | null;
  sizeBytes: number | null;
  contentType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  sourceSha256AtGeneration: string | null;
  lastError: string | null;
  engineVersion: string;
  generatedAtUtc: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
  // Phase 31.14 — bounded server-side bytes proxy URL. Null when
  // the asset isn't ready (PENDING/PROCESSING/FAILED/UNSUPPORTED).
  // The URL targets a workspace-internal proxy route that streams
  // the bytes from S3 server-side; the client NEVER sees a
  // storage_key, signed URL, or bucket name.
  bytesUrl: string | null;
};

export type UseDerivedAssetsInput = {
  evidenceId: string;
  teamId: string | null;
  pollMs?: number | null;
};

export type UseDerivedAssetsState = {
  loading: boolean;
  assets: ReadonlyArray<DerivedAssetRow>;
  error: { code: string } | null;
};

export type UseDerivedAssetsApi = {
  state: UseDerivedAssetsState;
  refresh: () => Promise<void>;
  trigger: (
    evidencePartId: string,
    assetKind: DerivedAssetKind,
  ) => Promise<{ ok: true; queued: boolean } | { ok: false; reason: string }>;
};

export function useDerivedAssets(
  input: UseDerivedAssetsInput,
): UseDerivedAssetsApi {
  const { evidenceId, teamId } = input;
  const [state, setState] = useState<UseDerivedAssetsState>({
    loading: false,
    assets: [],
    error: null,
  });
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!teamId) return;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = (await apiFetch(
        `/v1/evidence/${encodeURIComponent(evidenceId)}/derived-assets?teamId=${encodeURIComponent(teamId)}`,
      )) as { evidenceId: string; assets: DerivedAssetRow[] };
      if (!mountedRef.current) return;
      setState({ loading: false, assets: res.assets ?? [], error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      const code =
        err instanceof Error && "statusCode" in err
          ? `http_${(err as Error & { statusCode?: number }).statusCode ?? "unknown"}`
          : "network_error";
      setState({ loading: false, assets: [], error: { code } });
    }
  }, [evidenceId, teamId]);

  const trigger = useCallback(
    async (evidencePartId: string, assetKind: DerivedAssetKind) => {
      if (!teamId) return { ok: false, reason: "missing_team_id" } as const;
      try {
        const res = (await apiFetch(
          `/v1/evidence/${encodeURIComponent(evidenceId)}/derived-assets/run`,
          {
            method: "POST",
            body: JSON.stringify({ teamId, evidencePartId, assetKind }),
          },
        )) as { queued: boolean; reason: string | null };
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
    [evidenceId, teamId],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!input.pollMs) return;
    const clamped = Math.max(2_000, Math.min(60_000, input.pollMs));
    const handle = setInterval(() => {
      void refresh();
    }, clamped);
    return () => clearInterval(handle);
  }, [input.pollMs, refresh]);

  return { state, refresh, trigger };
}
