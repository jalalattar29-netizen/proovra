"use client";

/**
 * Phase 31.6 — Media intelligence client hook.
 *
 * Wraps the `/v1/evidence/:evidenceId/media-intelligence` endpoint
 * with React state + the standard apiFetch path. Self-contained:
 * no globals, no providers, safe to mount on any evidence detail
 * surface.
 *
 * Hard rules:
 *   * Never throws to the caller — every failure goes into a
 *     bounded `error` state with a stable code.
 *   * Bounded refresh — caller can pass `pollMs` to enable polling
 *     during an active analyzer run. Default off.
 *   * `ack(signalId, action)` action API: idempotent server-side
 *     so a double-click never produces duplicate state.
 *   * `runAsync()` enqueues the worker job (server returns 202 +
 *     runId). Caller can switch to polling to watch progress.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../api";
import type {
  MediaIntelligenceResponse,
  ClientStatus,
} from "./types";

export type UseMediaIntelligenceInput = {
  evidenceId: string;
  teamId: string | null;
  /** Enable polling at the given interval (ms). Bounded to [2000,
   *  60000]. Useful while an async run is in flight. */
  pollMs?: number | null;
};

export type UseMediaIntelligenceState = {
  loading: boolean;
  data: MediaIntelligenceResponse | null;
  error: { code: string } | null;
};

export type UseMediaIntelligenceApi = {
  state: UseMediaIntelligenceState;
  refresh: () => Promise<void>;
  runSync: () => Promise<void>;
  runAsync: () => Promise<
    | { ok: true; runId: string; jobId?: string; queued: boolean }
    | { ok: false; reason: string }
  >;
  ack: (
    signalId: string,
    action: Extract<ClientStatus, "ACKNOWLEDGED" | "DISMISSED">,
  ) => Promise<{ ok: boolean }>;
};

export function useMediaIntelligence(
  input: UseMediaIntelligenceInput,
): UseMediaIntelligenceApi {
  const { evidenceId, teamId } = input;
  const [state, setState] = useState<UseMediaIntelligenceState>({
    loading: false,
    data: null,
    error: null,
  });
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!teamId) return;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = (await apiFetch(
        `/v1/evidence/${encodeURIComponent(evidenceId)}/media-intelligence?teamId=${encodeURIComponent(teamId)}`,
      )) as MediaIntelligenceResponse;
      if (!mountedRef.current) return;
      setState({ loading: false, data: res, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      const code =
        err instanceof Error && "statusCode" in err
          ? `http_${(err as Error & { statusCode?: number }).statusCode ?? "unknown"}`
          : "network_error";
      setState({ loading: false, data: null, error: { code } });
    }
  }, [evidenceId, teamId]);

  const runSync = useCallback(async () => {
    if (!teamId) return;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      await apiFetch(
        `/v1/evidence/${encodeURIComponent(evidenceId)}/media-intelligence/run`,
        {
          method: "POST",
          body: JSON.stringify({ teamId, async: false }),
        },
      );
      await refresh();
    } catch (err) {
      if (!mountedRef.current) return;
      const code =
        err instanceof Error && "statusCode" in err
          ? `http_${(err as Error & { statusCode?: number }).statusCode ?? "unknown"}`
          : "network_error";
      setState((prev) => ({ ...prev, loading: false, error: { code } }));
    }
  }, [evidenceId, teamId, refresh]);

  const runAsync = useCallback(async (): Promise<
    | { ok: true; runId: string; jobId?: string; queued: boolean }
    | { ok: false; reason: string }
  > => {
    if (!teamId) return { ok: false, reason: "missing_team_id" };
    try {
      const res = (await apiFetch(
        `/v1/evidence/${encodeURIComponent(evidenceId)}/media-intelligence/run`,
        {
          method: "POST",
          body: JSON.stringify({ teamId, async: true }),
        },
      )) as {
        evidenceId: string;
        mode: "async";
        queued: boolean;
        runId: string;
        jobId?: string;
      };
      return {
        ok: true,
        runId: res.runId,
        jobId: res.jobId,
        queued: res.queued,
      };
    } catch (err) {
      return {
        ok: false,
        reason:
          err instanceof Error
            ? `request_failed:${err.message.slice(0, 80)}`
            : "request_failed",
      };
    }
  }, [evidenceId, teamId]);

  const ack = useCallback(
    async (
      signalId: string,
      action: Extract<ClientStatus, "ACKNOWLEDGED" | "DISMISSED">,
    ) => {
      if (!teamId) return { ok: false };
      try {
        await apiFetch(
          `/v1/media-intelligence/signals/${encodeURIComponent(signalId)}/action`,
          {
            method: "POST",
            body: JSON.stringify({ teamId, action }),
          },
        );
        // Optimistically reflect the new status in local state.
        setState((prev) => {
          if (!prev.data) return prev;
          return {
            ...prev,
            data: {
              ...prev.data,
              signals: prev.data.signals.map((s) =>
                s.id === signalId
                  ? { ...s, status: action, acknowledgedAtUtc: new Date().toISOString() }
                  : s,
              ),
            },
          };
        });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    [teamId],
  );

  // Initial load.
  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // Optional polling.
  useEffect(() => {
    if (!input.pollMs) return;
    const clamped = Math.max(2_000, Math.min(60_000, input.pollMs));
    const handle = setInterval(() => {
      void refresh();
    }, clamped);
    return () => clearInterval(handle);
  }, [input.pollMs, refresh]);

  return useMemo<UseMediaIntelligenceApi>(
    () => ({ state, refresh, runSync, runAsync, ack }),
    [state, refresh, runSync, runAsync, ack],
  );
}
