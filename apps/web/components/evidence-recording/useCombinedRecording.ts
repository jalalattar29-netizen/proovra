"use client";

/**
 * 2026-10-29 — client hook for the DERIVED combined screen recording.
 *
 * Reads readiness from `GET /v1/evidence/:id/combined-recording`, polls only
 * while the worker is preparing it (bounded), asks for a short-lived presigned
 * playback / download URL only when the person actually plays or downloads
 * (each issue is a custody fact on the server), and starts preparation for a
 * historical record on request. Never throws — failures land in `error`.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ScreenRecordingCombineState, ScreenRecordingGap } from "@proovra/shared";

import { apiFetch } from "../../lib/api";

export type CombinedRecordingView = {
  evidenceId: string;
  applicable: boolean;
  state: ScreenRecordingCombineState;
  segmentCount: number;
  run: { id: string; status: string; generation: number; lastError: string | null } | null;
  combined: {
    assetId: string;
    generation: number;
    artifactClass: "DERIVED";
    derivedSha256: string | null;
    sizeBytes: number | null;
    widthPx: number | null;
    heightPx: number | null;
    filename: string;
    mode: "REMUX" | "TRANSCODE" | null;
    completeness: "COMPLETE" | "PARTIAL" | null;
    durationMs: number | null;
    gaps: ScreenRecordingGap[];
    limitations: string[];
    sources: Array<{ partIndex: number; sequence: number; combinedStartMs: number; durationMs: number }>;
    statement: string | null;
  } | null;
  release: { allowed: boolean; code?: string };
};

type IssuedUrl = { url: string; filename: string; expiresInSeconds: number };

const POLL_MS = 4000;
const MAX_POLLS = 150; // ~10 minutes, then the person can refresh

export function useCombinedRecording(evidenceId: string, teamId: string | null) {
  const [view, setView] = useState<CombinedRecordingView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const polls = useRef(0);
  const live = useRef(true);

  const load = useCallback(async () => {
    if (!teamId) return;
    try {
      const v = (await apiFetch(
        `/v1/evidence/${encodeURIComponent(evidenceId)}/combined-recording?teamId=${encodeURIComponent(teamId)}`,
      )) as CombinedRecordingView;
      if (live.current) {
        setView(v);
        setError(null);
      }
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : "combined_recording_unavailable");
    }
  }, [evidenceId, teamId]);

  useEffect(() => {
    live.current = true;
    polls.current = 0;
    setLoading(true);
    void load().finally(() => live.current && setLoading(false));
    return () => {
      live.current = false;
    };
  }, [load]);

  // Poll only while the worker is preparing it.
  useEffect(() => {
    if (!view || (view.state !== "PENDING" && view.state !== "PROCESSING")) return;
    if (polls.current >= MAX_POLLS) return;
    const t = setTimeout(() => {
      polls.current += 1;
      void load();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [view, load]);

  const prepare = useCallback(async () => {
    if (!teamId) return;
    setPreparing(true);
    try {
      await apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/combined-recording/prepare`, {
        method: "POST",
        body: JSON.stringify({ teamId }),
        headers: { "content-type": "application/json" },
      });
      polls.current = 0;
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "prepare_failed");
    } finally {
      if (live.current) setPreparing(false);
    }
  }, [evidenceId, teamId, load]);

  const issue = useCallback(
    async (purpose: "playback" | "download"): Promise<IssuedUrl | null> => {
      if (!teamId) return null;
      try {
        const id = encodeURIComponent(evidenceId);
        const team = encodeURIComponent(teamId);
        // One literal path per purpose (each issue is a distinct custody fact).
        return (
          purpose === "download"
            ? await apiFetch(`/v1/evidence/${id}/combined-recording/download?teamId=${team}`)
            : await apiFetch(`/v1/evidence/${id}/combined-recording/playback?teamId=${team}`)
        ) as IssuedUrl;
      } catch (e) {
        setError(e instanceof Error ? e.message : `${purpose}_unavailable`);
        return null;
      }
    },
    [evidenceId, teamId],
  );

  return { view, loading, error, preparing, reload: load, prepare, issue };
}
