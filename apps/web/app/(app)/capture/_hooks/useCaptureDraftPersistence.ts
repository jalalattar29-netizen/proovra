"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { logCaptureClientError } from "../_lib/capture-errors";
import type { SessionItem } from "../_lib/types";
import type { CapturePlanMode } from "../_lib/session-readiness";

/*
 * Durable Capture draft persistence.
 *
 * Backed by the server-side CaptureSession model. Lazily creates a draft on
 * first meaningful change, and patches it (debounced) when the local intake
 * state changes. The draft is finalized server-side when the resulting
 * Evidence is created with `captureSessionId` set, or discarded explicitly
 * when the user clears the session.
 *
 * Privacy: only metadata is sent — no file bytes, no precise GPS
 * (precise GPS is only included by the finalize call when the chosen
 * intake plan justifies it). File names + sizes + MIME types are sent.
 */

type DraftItemSnapshot = {
  clientItemId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  relativePath: string | null;
  role: string | null;
  privateNote: string | null;
  checklistStepId: string | null;
  sourceLabel: string | null;
  uploadState: "pending" | "uploading" | "uploaded" | "failed";
};

type CaptureDraftStateInput = {
  templateId: string | null;
  planMode: CapturePlanMode;
  internalNotes: string;
  useLocation: boolean;
  items: SessionItem[];
};

type UseCaptureDraftPersistenceOpts = {
  enabled: boolean;
};

const DEBOUNCE_MS = 750;

function snapshotItem(item: SessionItem): DraftItemSnapshot {
  return {
    clientItemId: item.id,
    fileName: item.file.name,
    mimeType: item.mimeType,
    sizeBytes: item.file.size,
    relativePath: item.relativePath ?? null,
    role: item.role ?? null,
    privateNote: item.privateNote ?? null,
    checklistStepId: item.checklistStepId ?? null,
    sourceLabel: item.sourceLabel ?? null,
    uploadState: item.error
      ? "failed"
      : item.uploadProgress >= 100
        ? "uploaded"
        : item.uploading
          ? "uploading"
          : "pending",
  };
}

export function useCaptureDraftPersistence({
  enabled,
}: UseCaptureDraftPersistenceOpts) {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "error">(
    "idle"
  );
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  const draftIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const pendingPayloadRef = useRef<CaptureDraftStateInput | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  draftIdRef.current = draftId;

  const flush = useCallback(async () => {
    if (!enabled) return;
    if (inFlightRef.current) return;

    const payload = pendingPayloadRef.current;
    if (!payload) return;
    pendingPayloadRef.current = null;

    inFlightRef.current = true;
    setSavingState("saving");

    try {
      const items = payload.items.map(snapshotItem);

      if (!draftIdRef.current) {
        const created = await apiFetch("/v1/capture/sessions", {
          method: "POST",
          body: JSON.stringify({
            templateId: payload.templateId ?? undefined,
            planMode: payload.planMode,
            internalNotes: payload.internalNotes || undefined,
            useLocation: payload.useLocation,
            items,
          }),
        });

        const newId = created?.session?.id ?? null;
        if (newId) {
          draftIdRef.current = newId;
          setDraftId(newId);
        }
      } else {
        await apiFetch(`/v1/capture/sessions/${draftIdRef.current}`, {
          method: "PATCH",
          body: JSON.stringify({
            templateId: payload.templateId,
            planMode: payload.planMode,
            internalNotes: payload.internalNotes || null,
            useLocation: payload.useLocation,
            items,
          }),
        });
      }

      setSavingState("idle");
      setLastSavedAt(new Date());
    } catch (err) {
      logCaptureClientError("web_capture_draft_persist", err, {
        hasDraftId: Boolean(draftIdRef.current),
      });
      setSavingState("error");
    } finally {
      inFlightRef.current = false;
      // If a newer payload arrived while we were saving, save again.
      if (pendingPayloadRef.current) {
        void flush();
      }
    }
  }, [enabled]);

  const scheduleSave = useCallback(
    (next: CaptureDraftStateInput) => {
      if (!enabled) return;

      // Don't create a draft for an empty / untouched session — only persist
      // once the user has done meaningful work.
const isMeaningful =
  next.items.length > 0 ||
  Boolean(next.internalNotes.trim());
  
      if (!draftIdRef.current && !isMeaningful) {
        return;
      }

      pendingPayloadRef.current = next;

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void flush();
      }, DEBOUNCE_MS);
    },
    [enabled, flush]
  );

  const discardDraft = useCallback(async () => {
    const id = draftIdRef.current;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingPayloadRef.current = null;
    draftIdRef.current = null;
    setDraftId(null);
    setSavingState("idle");
    setLastSavedAt(null);

    if (!id) return;

    try {
      await apiFetch(`/v1/capture/sessions/${id}`, { method: "DELETE" });
    } catch (err) {
      logCaptureClientError("web_capture_draft_discard", err, { draftId: id });
    }
  }, []);

  // The draft id is "consumed" by finalization on the server when the
  // /v1/evidence create call passes captureSessionId. After a successful
  // finalize, drop the local id so the next session is fresh.
  const acknowledgeFinalized = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingPayloadRef.current = null;
    draftIdRef.current = null;
    setDraftId(null);
    setSavingState("idle");
    setLastSavedAt(null);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return {
    draftId,
    savingState,
    lastSavedAt,
    scheduleSave,
    discardDraft,
    acknowledgeFinalized,
  };
}
