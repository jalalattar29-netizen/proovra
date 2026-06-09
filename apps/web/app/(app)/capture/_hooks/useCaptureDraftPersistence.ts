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

/**
 * Phase IA-capture-409 — bounded error shape from `apiFetch`.
 *
 * `apiFetch` throws a plain Error decorated with `statusCode` and
 * `code` (see `apps/web/lib/api.ts`). The autosave loop now reads both
 * to detect the terminal-lock condition.
 */
type CaptureDraftPersistError = Error & {
  statusCode?: number;
  code?: string;
};

function isSessionLockedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as CaptureDraftPersistError;
  // The canonical signal is the backend's bounded error code. The 409
  // status is the fallback in case the code is ever absent on a future
  // route variant — we still want to halt the autosave loop on it.
  return e.code === "CAPTURE_SESSION_NOT_EDITABLE" || e.statusCode === 409;
}

export function useCaptureDraftPersistence({
  enabled,
}: UseCaptureDraftPersistenceOpts) {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [savingState, setSavingState] = useState<
    "idle" | "saving" | "error" | "locked"
  >("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  const draftIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const pendingPayloadRef = useRef<CaptureDraftStateInput | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Phase IA-capture-409 — once we observe a 409 / CAPTURE_SESSION_NOT_EDITABLE
  // for the current draftId, we MUST stop the autosave loop for this
  // draft. Without this flag the debounce kept re-firing on every
  // keystroke and the backend kept responding 409 forever.
  const lockedRef = useRef(false);

  draftIdRef.current = draftId;

  const flush = useCallback(async () => {
    if (!enabled) return;
    if (inFlightRef.current) return;
    if (lockedRef.current) {
      // Drop any queued payload so it doesn't fire after a future
      // scheduleSave that genuinely resets the loop (e.g. after the
      // user starts a new capture session).
      pendingPayloadRef.current = null;
      return;
    }

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
      if (isSessionLockedError(err)) {
        // Phase IA-capture-409 — terminal lock. The session moved out
        // of DRAFT (e.g. FINALIZED after Review & Sign, DISCARDED, or
        // EXPIRED). We MUST:
        //   1. Clear the local draftId so future edits create a fresh
        //      session via POST /v1/capture/sessions.
        //   2. Stop the autosave loop for this draft — pendingPayload
        //      gets dropped, debounce is cleared, and `lockedRef`
        //      prevents any in-flight payload from re-PATCHing.
        //   3. Surface a friendly state to the page (savingState =
        //      "locked") — NOT the generic "error" toast that pre-fix
        //      kept appearing on every keystroke.
        //   4. NOT log this through `logCaptureClientError` — it is a
        //      normal lifecycle event, not a client error.
        lockedRef.current = true;
        pendingPayloadRef.current = null;
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        draftIdRef.current = null;
        setDraftId(null);
        setSavingState("locked");
      } else {
        logCaptureClientError("web_capture_draft_persist", err, {
          hasDraftId: Boolean(draftIdRef.current),
        });
        setSavingState("error");
      }
    } finally {
      inFlightRef.current = false;
      // If a newer payload arrived while we were saving — AND the
      // draft isn't locked — save again. The `lockedRef` check
      // prevents the very bug we just fixed: the prior code would
      // re-fire `flush` even when we'd just observed a 409.
      if (pendingPayloadRef.current && !lockedRef.current) {
        void flush();
      }
    }
  }, [enabled]);

  const scheduleSave = useCallback(
    (next: CaptureDraftStateInput) => {
      if (!enabled) return;
      // Phase IA-capture-409 — the prior draft was locked. Skip
      // autosave until the page tells us a new capture session has
      // started (via discardDraft / acknowledgeFinalized, both of
      // which reset lockedRef). Without this, every keystroke after
      // a finalized session reopened in the same component would
      // re-trigger the loop.
      if (lockedRef.current) return;

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
    // Phase IA-capture-409 — clearing the session is the user-initiated
    // recovery path from a locked draft. Reset lockedRef so the next
    // edit can create a fresh CaptureSession via POST.
    lockedRef.current = false;
    setDraftId(null);
    setSavingState("idle");
    setLastSavedAt(null);

    if (!id) return;

    try {
      await apiFetch(`/v1/capture/sessions/${id}`, { method: "DELETE" });
    } catch (err) {
      // Phase IA-capture-409 — if the session is already locked/expired
      // a DELETE may also 409. That's expected and not a client error.
      if (!isSessionLockedError(err)) {
        logCaptureClientError("web_capture_draft_discard", err, {
          draftId: id,
        });
      }
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
    // Phase IA-capture-409 — finalize is the normal end-of-life for a
    // draft. Reset lockedRef so the operator can immediately begin a
    // new capture session in the same page.
    lockedRef.current = false;
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
