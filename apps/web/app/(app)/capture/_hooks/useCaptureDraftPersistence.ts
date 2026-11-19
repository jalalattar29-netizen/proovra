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
  /**
   * B4-F-307 — the workspace the draft is started in (the active space's id;
   * omitted for a Personal space the server has not resolved, the same rule
   * as the record create). The draft list is scoped by it.
   */
  teamId?: string | null;
  /**
   * PRO-C1-01 (review gap 4) / DEC-27 — the active workspace BY IDENTITY: its
   * id, or a constant for a Personal Space the server has not resolved; null
   * while the context is unknown. A draft keeps the workspace it was started
   * in: when this changes to another workspace the hook lets go of that draft
   * (it stays on the server, listed and resumable in its own workspace, with
   * the record it reserved) and the new workspace starts a fresh one.
   */
  workspaceKey?: string | null;
};

const DEBOUNCE_MS = 750;

/**
 * DEC-27 — the active workspace as a draft's identity. The caller's own
 * Personal Space is one identity whether or not the server has resolved its
 * id yet; every other workspace is its id. Null while the context is unknown.
 */
export function draftWorkspaceKey(
  space: { type: string; id?: string | null; shared?: boolean } | null | undefined,
): string | null {
  if (!space) return null;
  if (space.type === "PERSONAL" && !space.shared) return "personal:own";
  return space.id || null;
}


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

/**
 * Free acceptance J6 (FAIL-2) — the caller may not write drafts in this
 * workspace (e.g. demoted to Viewer while the page was open). Terminal for the
 * draft, like the 409 lock: retrying cannot succeed and only floods the API.
 */
function isDraftForbiddenError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as CaptureDraftPersistError).statusCode === 403;
}

/**
 * Free acceptance J6 (FAIL-1) — the same state handed in again. The page
 * re-runs its autosave effect on renders that change nothing it saves; a save
 * itself causes such renders, so without this the draft re-saved forever.
 * Items compare by identity: staged items are immutable state objects.
 */
function sameDraftPayload(a: CaptureDraftStateInput | null, b: CaptureDraftStateInput): boolean {
  if (!a) return false;
  if (a.templateId !== b.templateId || a.planMode !== b.planMode) return false;
  if (a.internalNotes !== b.internalNotes || a.useLocation !== b.useLocation) return false;
  if (a.items === b.items) return true;
  return a.items.length === b.items.length && a.items.every((item, i) => item === b.items[i]);
}

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
  teamId = null,
  workspaceKey = null,
}: UseCaptureDraftPersistenceOpts) {
  const teamIdRef = useRef<string | null>(teamId);
  teamIdRef.current = teamId;
  const workspaceKeyRef = useRef<string | null>(workspaceKey);
  workspaceKeyRef.current = workspaceKey;
  /** The workspace the held draft row belongs to (null: no draft, or unknown). */
  const draftWorkspaceRef = useRef<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [savingState, setSavingState] = useState<
    "idle" | "saving" | "error" | "locked" | "forbidden"
  >("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  const draftIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const pendingPayloadRef = useRef<CaptureDraftStateInput | null>(null);
  // C-10 — the latest meaningful state, and the save in flight (ensureDraft waits on it).
  const lastPayloadRef = useRef<CaptureDraftStateInput | null>(null);
  const inFlightDoneRef = useRef<Promise<void> | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Phase IA-capture-409 — once we observe a 409 / CAPTURE_SESSION_NOT_EDITABLE
  // for the current draftId, we MUST stop the autosave loop for this
  // draft. Without this flag the debounce kept re-firing on every
  // keystroke and the backend kept responding 409 forever.
  const lockedRef = useRef(false);
  // FAIL-1 — the payload last queued, in flight or saved; an identical one is not re-saved.
  const acceptedPayloadRef = useRef<CaptureDraftStateInput | null>(null);
  // F-04 — a resumed draft keeps its saved file details until files are
  // re-attached: autosave omits `items` while none are staged, instead of
  // overwriting the server snapshot with an empty list.
  const keepSavedItemsRef = useRef(false);

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
    let settle: () => void = () => {};
    inFlightDoneRef.current = new Promise<void>((resolve) => (settle = resolve));
    setSavingState("saving");

    try {
      const items = payload.items.map(snapshotItem);
      if (items.length > 0) keepSavedItemsRef.current = false;
      const omitItems = keepSavedItemsRef.current && items.length === 0;

      if (!draftIdRef.current) {
        const startedIn = workspaceKeyRef.current;
        const created = await apiFetch("/v1/capture/sessions", {
          method: "POST",
          body: JSON.stringify({
            ...(teamIdRef.current ? { teamId: teamIdRef.current } : {}),
            templateId: payload.templateId ?? undefined,
            planMode: payload.planMode,
            internalNotes: payload.internalNotes || undefined,
            useLocation: payload.useLocation,
            items,
          }),
        });

        const newId = created?.session?.id ?? null;
        // DEC-27 — a draft created in a workspace the person left while the
        // request was in flight stays there; this page does not hold it.
        if (newId && workspaceKeyRef.current === startedIn) {
          draftIdRef.current = newId;
          draftWorkspaceRef.current = startedIn;
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
            ...(omitItems ? {} : { items }),
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
      } else if (isDraftForbiddenError(err)) {
        // FAIL-2 — stop for this draft; the page refreshes the workspace
        // context so the route gate reflects the role the server applied.
        lockedRef.current = true;
        pendingPayloadRef.current = null;
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        setSavingState("forbidden");
      } else {
        logCaptureClientError("web_capture_draft_persist", err, {
          hasDraftId: Boolean(draftIdRef.current),
        });
        setSavingState("error");
      }
    } finally {
      inFlightRef.current = false;
      settle();
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

      if (sameDraftPayload(acceptedPayloadRef.current, next)) return;
      acceptedPayloadRef.current = next;
      pendingPayloadRef.current = next;
      lastPayloadRef.current = next;

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

  /**
   * C-10 (Free-user audit of 4d9b78963) — Finish needs the draft id NOW. With
   * none yet (the 750 ms debounce still pending, or a save that failed), the
   * record Finish reserved was bound to no draft: a later changed selection, a
   * removed file or a discard could not release it, and it held a slot ~24 h.
   * This saves the latest state immediately (or waits for the save in flight)
   * and returns the draft id, or null when no draft can be had.
   */
  const ensureDraft = useCallback(async (): Promise<string | null> => {
    if (!enabled) return null;
    for (let attempt = 0; attempt < 3 && !draftIdRef.current && !lockedRef.current; attempt += 1) {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (inFlightRef.current) {
        await inFlightDoneRef.current;
        continue;
      }
      pendingPayloadRef.current = pendingPayloadRef.current ?? lastPayloadRef.current;
      if (!pendingPayloadRef.current) break;
      await flush();
      break; // one immediate save; a failure leaves Finish without a draft, as before
    }
    return draftIdRef.current;
  }, [enabled, flush]);

  const discardDraft = useCallback(async () => {
    const id = draftIdRef.current;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingPayloadRef.current = null;
    acceptedPayloadRef.current = null;
    draftIdRef.current = null;
    // Phase IA-capture-409 — clearing the session is the user-initiated
    // recovery path from a locked draft. Reset lockedRef so the next
    // edit can create a fresh CaptureSession via POST.
    lockedRef.current = false;
    keepSavedItemsRef.current = false;
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

  /**
   * F-04 (Free-user audit 2026-11-13) — RESUME ADOPTS THE DRAFT. The draft id
   * lived only in this hook's state, so after a reload "Resume" restored the
   * draft's metadata while autosave created a NEW draft and Finish reserved a
   * NEW record, and the record the old draft reserved kept holding a slot for
   * ~24 h. Adopting the id makes autosave patch that draft and Finish send it
   * as captureSessionId: the server resumes its reserved record when the
   * re-attached files are the ones it holds, or releases it and reserves
   * afresh when they are not.
   */
  const adoptDraft = useCallback((id: string) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingPayloadRef.current = null;
    acceptedPayloadRef.current = null;
    lockedRef.current = false;
    keepSavedItemsRef.current = true;
    draftIdRef.current = id;
    // The page lists (and so adopts) only the active workspace's drafts.
    draftWorkspaceRef.current = workspaceKeyRef.current;
    setDraftId(id);
    setSavingState("idle");
  }, []);

  // PRO-C1-01 (review gap 4) / DEC-27 — THE DRAFT KEEPS ITS WORKSPACE. After a
  // confirmed switch the page used to keep the old workspace's draft id: the
  // retried Finish then bound that draft to the NEW workspace's record and
  // released the record it had reserved in the old one. Now the hook lets go
  // of the draft — nothing is deleted or patched: it stays on the server in
  // its own workspace, listed there and resumable with its reservation — and
  // the next save (or Finish, through ensureDraft) starts a fresh draft in the
  // workspace now active. The staged files stay on the page; they are sent
  // only into a record newly reserved here, under the Review dialog that names
  // this workspace. An unknown context (null) is not a switch.
  useEffect(() => {
    if (!workspaceKey) return;
    if (!draftIdRef.current || !draftWorkspaceRef.current) return;
    if (draftWorkspaceRef.current === workspaceKey) return;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    // The latest state is kept (lastPayloadRef) so the fresh draft starts from it.
    pendingPayloadRef.current = null;
    acceptedPayloadRef.current = null;
    draftIdRef.current = null;
    draftWorkspaceRef.current = null;
    lockedRef.current = false;
    keepSavedItemsRef.current = false;
    setDraftId(null);
    setSavingState("idle");
    setLastSavedAt(null);
  }, [workspaceKey]);


  // The draft id is "consumed" by finalization on the server when the
  // /v1/evidence create call passes captureSessionId. After a successful
  // finalize, drop the local id so the next session is fresh.
  const acknowledgeFinalized = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingPayloadRef.current = null;
    acceptedPayloadRef.current = null;
    draftIdRef.current = null;
    // Phase IA-capture-409 — finalize is the normal end-of-life for a
    // draft. Reset lockedRef so the operator can immediately begin a
    // new capture session in the same page.
    lockedRef.current = false;
    keepSavedItemsRef.current = false;
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
    adoptDraft,
    ensureDraft,
  };
}
