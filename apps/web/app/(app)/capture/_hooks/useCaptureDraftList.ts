"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { logCaptureClientError } from "../_lib/capture-errors";

/**
 * Phase C #16 — minimal surface for the user-facing "you have unfinished
 * capture sessions" experience. The hook lists DRAFT sessions, lets the
 * user discard, and exposes a server-fetched session detail for resume.
 *
 * Honesty boundary: browser File objects cannot survive a refresh. We
 * restore the metadata (template, plan mode, internal notes, mappings,
 * roles, source labels), but the user must re-attach the actual file
 * binaries before finalization. This is documented in the resume modal
 * copy.
 */

export interface CaptureDraftSummary {
  id: string;
  templateId: string | null;
  templateName: string | null;
  planMode: string | null;
  internalNotes: string | null;
  itemCount: number;
  updatedAt: string;
  createdAt: string;
  expiresAtUtc: string | null;
}

export interface CaptureDraftDetail extends CaptureDraftSummary {
  templateSnapshot: unknown;
  useLocation: boolean;
  items: Array<{
    clientItemId?: string;
    fileName?: string;
    mimeType?: string;
    sizeBytes?: number;
    relativePath?: string | null;
    role?: string | null;
    privateNote?: string | null;
    checklistStepId?: string | null;
    sourceLabel?: string | null;
    uploadState?: string;
  }>;
}

type RawSession = {
  id: string;
  templateId?: string | null;
  templateName?: string | null;
  planMode?: string | null;
  internalNotes?: string | null;
  items?: unknown[];
  itemsSnapshot?: unknown[];
  updatedAt?: string;
  createdAt?: string;
  expiresAtUtc?: string | null;
  templateSnapshot?: unknown;
  useLocation?: boolean;
};

function summarize(raw: RawSession): CaptureDraftSummary {
  const itemsSource: unknown[] = Array.isArray(raw.items)
    ? raw.items
    : Array.isArray(raw.itemsSnapshot)
      ? raw.itemsSnapshot
      : [];
  return {
    id: raw.id,
    templateId: raw.templateId ?? null,
    templateName: raw.templateName ?? null,
    planMode: raw.planMode ?? null,
    internalNotes: raw.internalNotes ?? null,
    itemCount: itemsSource.length,
    updatedAt: raw.updatedAt ?? "",
    createdAt: raw.createdAt ?? "",
    expiresAtUtc: raw.expiresAtUtc ?? null,
  };
}

export function useCaptureDraftList() {
  const [drafts, setDrafts] = useState<CaptureDraftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/v1/capture/sessions?status=DRAFT", {
        method: "GET",
      });
      const list: RawSession[] = Array.isArray(res?.sessions)
        ? res.sessions
        : [];
      setDrafts(list.map(summarize));
    } catch (err) {
      logCaptureClientError("web_capture_drafts_list", err, {});
      setError(err instanceof Error ? err.message : "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }, []);

  const discard = useCallback(
    async (id: string) => {
      try {
        await apiFetch(`/v1/capture/sessions/${id}`, { method: "DELETE" });
        setDrafts((prev) => prev.filter((d) => d.id !== id));
      } catch (err) {
        logCaptureClientError("web_capture_drafts_discard", err, { draftId: id });
        throw err;
      }
    },
    []
  );

  const fetchDetail = useCallback(
    async (id: string): Promise<CaptureDraftDetail | null> => {
      try {
        const res = await apiFetch(`/v1/capture/sessions/${id}`, {
          method: "GET",
        });
        const raw = res?.session as RawSession | undefined;
        if (!raw) return null;
        const summary = summarize(raw);
        return {
          ...summary,
          templateSnapshot: raw.templateSnapshot ?? null,
          useLocation: Boolean(raw.useLocation),
          items: Array.isArray(raw.items)
            ? (raw.items as CaptureDraftDetail["items"])
            : Array.isArray(raw.itemsSnapshot)
              ? (raw.itemsSnapshot as CaptureDraftDetail["items"])
              : [],
        };
      } catch (err) {
        logCaptureClientError("web_capture_drafts_detail", err, { draftId: id });
        return null;
      }
    },
    []
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { drafts, loading, error, refresh, discard, fetchDetail };
}
