"use client";

/**
 * PROOVRA Phase 2A — Coding panel renderer.
 *
 * Schema-driven coding panel. Renders each `CodingField` per its bounded type
 * with the right widget and saves each change through `onWrite` / `onClear`.
 *
 * Review remediation §6 (2026-11-27, F-13..F-17, F-24, F-25):
 *   * Inputs are CONTROLLED and show the server value; a new server value is
 *     shown as soon as it arrives, unless the reviewer is editing that field
 *     or a save for it is in flight / failed (their text is never replaced).
 *   * Each field has a save state — idle | saving | saved | failed — shown
 *     next to it ("Saving…", "Saved", "Not saved — Retry"), and ONE polite
 *     live region announces saves and failures. A lost connection reads
 *     "Not saved — no connection."; a refusal reads the server's message.
 *   * Retry re-sends exactly what the reviewer entered.
 *   * A per-field request sequence: a response older than the latest request
 *     sent for that field is ignored. Inputs are never disabled while a save
 *     is pending.
 *   * Values can be cleared explicitly: an emptied text/number field, "Not
 *     set" in a choice, or the Clear control sends a clear (never "nothing").
 *   * Booleans are Not set / Yes / No; confidence shows "Not set" until
 *     chosen (no fake 50), is debounced (~400 ms) and always sends the final
 *     value.
 *   * REVIEWER_VERDICT fields are the reviewer's ASSESSMENT (a
 *     recommendation), never the decision.
 *   * When writes would be refused (`writable.allowed === false`) the values
 *     are shown read-only with the reason.
 *   * While a save is pending, failed or a field is being edited, leaving the
 *     page asks for confirmation (`beforeunload`), and the panel reports it
 *     through `onUnsavedChange`, the `CODING_UNSAVED_EVENT` window event and
 *     `hasUnsavedCoding()` so an in-app navigation can warn too.
 *
 * Hard rules:
 *   * Bounded vocabulary — every option list comes from the field's
 *     `options` blob or from the canonical shared enum.
 *   * NEVER asserts authenticity — labels and help text describe
 *     what the operator is recording, never the truth of content.
 */

import { AppListbox } from "../app-primitives/AppListbox";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  CONFIDENCE_SCORE_RANGE,
  ESCALATION_LEVELS,
  REVIEWER_RISK_LEVELS,
  REVIEWER_VERDICTS,
} from "@proovra/shared";

import type {
  CodingFieldRow,
  CodingValueRow,
} from "../../lib/reviewer-workspace/reviewer-api";

// =============================================================================
// Public contract
// =============================================================================

/**
 * What a save attempt came to. `void` (older callers) reads as saved.
 *
 * Review remediation A (2026-11-27): a success may carry the field's new
 * `revision`; a `conflict` means the server refused the change because the
 * field changed since the revision it was based on (another tab or another
 * reviewer) — nothing was written, and `current` is what is stored now.
 */
export type CodingWriteOutcome =
  | { ok: true; revision?: number }
  | { ok: false; kind: "network" | "refused"; message: string }
  | {
      ok: false;
      kind: "conflict";
      message: string;
      current?: { revision: number; value: Record<string, unknown> | null };
    };

/** The plain-words conflict message (review remediation A). */
export const CODING_CONFLICT_MESSAGE =
  "Changed in another tab or by another reviewer — reload to see the current value.";

/** GET /v1/reviewer/work/:id/coding → `writable`. */
export type CodingWritable = {
  allowed: boolean;
  reason: "workflow_closed" | "no_permission" | "no_schema" | (string & {}) | null;
};

export type CodingPanelProps = {
  fields: ReadonlyArray<CodingFieldRow>;
  values: ReadonlyArray<CodingValueRow>;
  unfulfilledFieldIds: ReadonlySet<string>;
  /**
   * `expectedRevision` (review remediation A) is the field revision this
   * change is based on; present only when the panel knows it (from
   * `revisions` / `values[].revision` or an earlier save's answer).
   */
  onWrite: (input: {
    fieldId: string;
    value: Record<string, unknown>;
    rationale?: string;
    expectedRevision?: number;
  }) => Promise<CodingWriteOutcome | void>;
  /** Explicit clear. Without it, the "Not set" / Clear controls are not offered. */
  onClear?: (input: { fieldId: string; expectedRevision?: number }) => Promise<CodingWriteOutcome | void>;
  /** Default: writable. */
  writable?: CodingWritable;
  /** Called whenever "something is pending, failed or being edited" changes. */
  onUnsavedChange?: (hasUnsaved: boolean) => void;
  /**
   * Review remediation A — every field's server revision (`fieldId → n`,
   * absent = 0) from the same read as `values`. Without it (older API) the
   * panel sends no expected revision and the server keeps last-writer-wins.
   */
  revisions?: Readonly<Record<string, number>>;
  /** Re-read the coding (offered on a conflict as "Reload"). */
  onReload?: () => void;
  /**
   * Which review / workspace / schema these fields belong to. When it
   * changes, queued edits of the previous context are never sent through the
   * new context's callbacks (each queued edit keeps the callback it was made
   * with) and the save states start fresh. Callers should also key the panel.
   */
  contextKey?: string;
};

/** Window event dispatched with `detail: { hasUnsaved: boolean }`. */
export const CODING_UNSAVED_EVENT = "proovra:coding-unsaved";

const unsavedPanels = new Set<string>();

/** True while any mounted coding panel has a pending, failed or edited field. */
export function hasUnsavedCoding(): boolean {
  return unsavedPanels.size > 0;
}

/** The reviewer-facing reason a read-only panel shows. */
export function codingReadOnlyMessage(reason: string | null | undefined): string {
  switch (reason) {
    case "workflow_closed":
      return "This review is closed. Coding is read-only.";
    case "no_permission":
      return "Your role does not allow coding this review. Coding is read-only.";
    case "no_schema":
      return "No coding schema is bound to this review.";
    default:
      return "Coding is read-only.";
  }
}

export const VERDICT_FIELD_QUALIFIER = " — assessment (recommendation), not the decision";

/** The label a field is shown with (REVIEWER_VERDICT gets the qualifier). */
export function codingFieldDisplayLabel(field: Pick<CodingFieldRow, "label" | "fieldType">): string {
  return field.fieldType === "REVIEWER_VERDICT" ? `${field.label}${VERDICT_FIELD_QUALIFIER}` : field.label;
}

// =============================================================================
// Save state
// =============================================================================

type SaveOp = { kind: "write"; value: Record<string, unknown> } | { kind: "clear" };

type FailKind = "network" | "refused" | "conflict";

type FieldStatus =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "saving"; op: SaveOp }
  | { kind: "saved"; op: SaveOp }
  | {
      kind: "failed";
      failKind: FailKind;
      message: string;
      op: SaveOp | null;
      /** conflict only: the revision stored now ("Keep mine" bases on it). */
      currentRevision?: number;
    };

const IDLE: FieldStatus = { kind: "idle" };

function outcomeFromError(err: unknown): CodingWriteOutcome {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "NETWORK_ERROR" || err instanceof TypeError) {
    return { ok: false, kind: "network", message: "" };
  }
  const message = (err as { message?: unknown } | null)?.message;
  return {
    ok: false,
    kind: "refused",
    message: typeof message === "string" && message ? message : "The value was not saved.",
  };
}

function opKey(op: SaveOp | null | undefined): string {
  if (!op) return "";
  return op.kind === "clear" ? "clear" : `write:${JSON.stringify(op.value)}`;
}

/** Whether a stored value is exactly what `op` would store. */
function storedMatches(op: SaveOp, value: Record<string, unknown> | null | undefined): boolean {
  if (op.kind === "clear") return value === null || value === undefined;
  return value !== null && value !== undefined && JSON.stringify(value) === JSON.stringify(op.value);
}

/*
 * Review remediation A (2026-11-27) — PERSISTED-WRITE ORDERING, NOT JUST
 * RESPONSE ORDERING.
 *
 * Each field has ONE save lane: at most one request in flight. An edit made
 * while a request is in flight does not start a second request; it replaces
 * the lane's single pending "latest intent" (so five rapid choices send at
 * most two requests: the one in flight and the last choice). When the
 * in-flight request settles, the pending intent is sent if it differs from
 * what was just stored. The server therefore receives this session's writes
 * and clears for a field strictly in order, and the last one it receives is
 * the user's latest intent.
 *
 * Every request carries the field revision it is based on (`expectedRevision`,
 * from the coding read, then from each save's answer). The server refuses a
 * change based on a superseded revision (another tab, another reviewer) with
 * a conflict instead of overwriting silently; the panel then keeps the draft,
 * says so in plain words and offers Reload / Keep mine.
 *
 * "Saved" is shown only when the lane is empty (nothing pending behind the
 * request that succeeded), so it never stands for a value an older request
 * could still overwrite. Retry sends the field's CURRENT intended value (the
 * widget's draft), never a superseded operation.
 *
 * Each queued operation keeps the callbacks it was made with, so a review /
 * workspace / schema switch (`contextKey`, and the caller's `key`) can never
 * send an edit through the next context's callbacks.
 */
type QueuedOp = {
  op: SaveOp;
  /** The callbacks of the context the edit was made in. */
  write: CodingPanelProps["onWrite"];
  clear: CodingPanelProps["onClear"];
};

type Lane = {
  inFlight: QueuedOp | null;
  pending: QueuedOp | null;
  /** The revision what the reviewer sees is based on (undefined = unknown). */
  revision: number | undefined;
};

/** The server revision of a field in a read (undefined when the API sends none). */
function serverRevisionOf(
  fieldId: string,
  revisions: Readonly<Record<string, number>> | undefined,
  row: CodingValueRow | undefined,
): number | undefined {
  if (revisions && typeof revisions[fieldId] === "number") return revisions[fieldId];
  if (row && typeof row.revision === "number") return row.revision;
  return revisions ? 0 : undefined;
}

// =============================================================================
// Panel
// =============================================================================

export function CodingPanel({
  fields,
  values,
  unfulfilledFieldIds,
  onWrite,
  onClear,
  writable,
  onUnsavedChange,
  revisions,
  onReload,
  contextKey = "",
}: CodingPanelProps) {
  const panelKey = useId();
  const valueMap = useMemo(() => new Map(values.map((v) => [v.fieldId, v])), [values]);
  const [statuses, setStatuses] = useState<Record<string, FieldStatus>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [resync, setResync] = useState<Record<string, number>>({});
  const [announcement, setAnnouncement] = useState("");
  const lanesRef = useRef(new Map<string, Lane>());
  /** Each widget's current intended operation (for Retry). */
  const intentRef = useRef(new Map<string, () => SaveOp | null>());
  const alive = useRef(true);
  const contextRef = useRef(contextKey);
  const onWriteRef = useRef(onWrite);
  const onClearRef = useRef(onClear);
  const onUnsavedRef = useRef(onUnsavedChange);
  onWriteRef.current = onWrite;
  onClearRef.current = onClear;
  onUnsavedRef.current = onUnsavedChange;
  const serverRevRef = useRef<(fieldId: string) => number | undefined>(() => undefined);
  serverRevRef.current = (fieldId) => serverRevisionOf(fieldId, revisions, valueMap.get(fieldId));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A new context: fresh lanes and states. In-flight requests of the old
  // context finish against the old context and never start its pending edit
  // through the new one (their lane is detached below).
  if (contextRef.current !== contextKey) {
    contextRef.current = contextKey;
    lanesRef.current = new Map();
  }
  useEffect(() => {
    setStatuses({});
    setEditing({});
  }, [contextKey]);

  const setStatus = useCallback((fieldId: string, status: FieldStatus) => {
    if (!alive.current) return;
    setStatuses((prev) => ({ ...prev, [fieldId]: status }));
  }, []);

  const setFieldEditing = useCallback((fieldId: string, on: boolean) => {
    setEditing((prev) => (Boolean(prev[fieldId]) === on ? prev : { ...prev, [fieldId]: on }));
  }, []);

  const laneOf = useCallback((fieldId: string): Lane => {
    let lane = lanesRef.current.get(fieldId);
    if (!lane) {
      lane = { inFlight: null, pending: null, revision: serverRevRef.current(fieldId) };
      lanesRef.current.set(fieldId, lane);
    }
    return lane;
  }, []);

  /** Send the lane's in-flight op; on settle, send the latest pending intent. */
  const run = useCallback(
    async (field: CodingFieldRow, lane: Lane, lanes: Map<string, Lane>, q: QueuedOp) => {
      lane.inFlight = q;
      lane.pending = null;
      if (lanes === lanesRef.current) setStatus(field.id, { kind: "saving", op: q.op });
      const rev = lane.revision;
      const revArg = rev === undefined ? {} : { expectedRevision: rev };
      let outcome: CodingWriteOutcome;
      try {
        const res =
          q.op.kind === "clear"
            ? await (q.clear
                ? q.clear({ fieldId: field.id, ...revArg })
                : Promise.resolve<CodingWriteOutcome>({
                    ok: false,
                    kind: "refused",
                    message: "Clearing is not available here.",
                  }))
            : await q.write({ fieldId: field.id, value: q.op.value, ...revArg });
        outcome = res ?? { ok: true };
      } catch (err) {
        outcome = outcomeFromError(err);
      }
      // A lost answer that DID commit (retried) comes back as a conflict whose
      // stored value is exactly this op: that is a success, not a conflict.
      if (!outcome.ok && outcome.kind === "conflict" && outcome.current && storedMatches(q.op, outcome.current.value)) {
        outcome = { ok: true, revision: outcome.current.revision };
      }
      lane.inFlight = null;
      // The context changed while this was in flight: its lane is detached;
      // nothing more is sent from it and no state of the new context changes.
      const detached = lanes !== lanesRef.current;
      // Read after the await: edits made meanwhile replaced the pending intent.
      const next = lane.pending as QueuedOp | null;
      const label = field.label;
      if (outcome.ok) {
        if (typeof outcome.revision === "number") lane.revision = outcome.revision;
        if (next && opKey(next.op) !== opKey(q.op)) {
          // Saved, but a newer intent is waiting: never show "Saved" for a
          // value the next request is about to replace.
          void run(field, lane, lanes, next);
          return;
        }
        lane.pending = null;
        if (detached) return;
        setStatus(field.id, { kind: "saved", op: q.op });
        setAnnouncement(`${label}: ${q.op.kind === "clear" ? "cleared" : "saved"}.`);
        return;
      }
      if (outcome.kind === "conflict") {
        // Never send the pending intent on a stale base; keep the draft.
        lane.pending = null;
        if (detached) return;
        setStatus(field.id, {
          kind: "failed",
          failKind: "conflict",
          message: CODING_CONFLICT_MESSAGE,
          op: next?.op ?? q.op,
          currentRevision: outcome.current?.revision,
        });
        setAnnouncement(`${label}: not saved — ${CODING_CONFLICT_MESSAGE}`);
        return;
      }
      if (next && opKey(next.op) !== opKey(q.op)) {
        // A newer intent supersedes the one that failed: send that instead.
        void run(field, lane, lanes, next);
        return;
      }
      lane.pending = null;
      if (detached) return;
      setStatus(field.id, { kind: "failed", failKind: outcome.kind, message: outcome.message, op: q.op });
      setAnnouncement(
        outcome.kind === "network"
          ? `${label}: not saved — no connection. Retry when you are back online.`
          : `${label}: not saved — ${outcome.message}`,
      );
    },
    [setStatus],
  );

  /** Record the reviewer's latest intent for a field and save it in order. */
  const send = useCallback(
    async (field: CodingFieldRow, op: SaveOp) => {
      const lanes = lanesRef.current;
      const lane = laneOf(field.id);
      const q: QueuedOp = { op, write: onWriteRef.current, clear: onClearRef.current };
      if (lane.inFlight) {
        // One request per field: the newest intent replaces any pending one.
        lane.pending = opKey(op) === opKey(lane.inFlight.op) ? null : q;
        setStatus(field.id, { kind: "saving", op });
        return;
      }
      await run(field, lane, lanes, q);
    },
    [laneOf, run, setStatus],
  );

  /** Retry: send the field's CURRENT intended value, never a superseded op. */
  const retry = useCallback(
    (field: CodingFieldRow, fallback: SaveOp | null, baseRevision?: number) => {
      const op = intentRef.current.get(field.id)?.() ?? fallback;
      if (!op) return;
      // "Keep mine" after a conflict bases the change on what is stored now.
      if (baseRevision !== undefined) laneOf(field.id).revision = baseRevision;
      void send(field, op);
    },
    [laneOf, send],
  );

  /** Conflict → Reload: show the stored value again (the draft is replaced). */
  const reload = useCallback(
    (field: CodingFieldRow) => {
      const lane = laneOf(field.id);
      lane.revision = undefined;
      setStatus(field.id, IDLE);
      setResync((prev) => ({ ...prev, [field.id]: (prev[field.id] ?? 0) + 1 }));
      onReload?.();
    },
    [laneOf, onReload, setStatus],
  );

  const registerIntent = useCallback((fieldId: string, get: (() => SaveOp | null) | null) => {
    if (get) intentRef.current.set(fieldId, get);
    else intentRef.current.delete(fieldId);
  }, []);

  /** A debounced field announces that a save is about to be sent. */
  const queue = useCallback(
    (fieldId: string) => {
      setStatus(fieldId, { kind: "queued" });
    },
    [setStatus],
  );

  const failLocally = useCallback(
    (field: CodingFieldRow, message: string) => {
      setStatus(field.id, { kind: "failed", failKind: "refused", message, op: null });
      setAnnouncement(`${field.label}: not saved — ${message}`);
    },
    [setStatus],
  );

  // A field the reviewer is not editing, with nothing pending or failed, adopts
  // a NEWER server revision (its draft re-syncs to that value at the same
  // time). An OLDER server revision never replaces what this session saved.
  useEffect(() => {
    for (const f of fields) {
      const lane = lanesRef.current.get(f.id);
      if (!lane || lane.inFlight || lane.pending) continue;
      const s = statuses[f.id];
      if (editing[f.id] || s?.kind === "failed" || s?.kind === "queued") continue;
      const rev = serverRevRef.current(f.id);
      if (rev !== undefined && (lane.revision === undefined || rev > lane.revision)) lane.revision = rev;
    }
  }, [fields, values, revisions, statuses, editing]);

  /** True when the server's value for a field is older than what this session saved. */
  const isStale = useCallback((fieldId: string): boolean => {
    const lane = lanesRef.current.get(fieldId);
    const rev = serverRevRef.current(fieldId);
    return lane?.revision !== undefined && rev !== undefined && rev < lane.revision;
  }, []);

  const hasUnsaved =
    Object.values(statuses).some((s) => s.kind === "saving" || s.kind === "queued" || s.kind === "failed") ||
    Object.values(editing).some(Boolean);

  useEffect(() => {
    if (hasUnsaved) unsavedPanels.add(panelKey);
    else unsavedPanels.delete(panelKey);
    onUnsavedRef.current?.(hasUnsaved);
    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(new CustomEvent(CODING_UNSAVED_EVENT, { detail: { hasUnsaved: hasUnsavedCoding() } }));
      } catch {
        // CustomEvent unavailable — the callback and the registry still work.
      }
    }
    if (!hasUnsaved || typeof window === "undefined") return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers need a returnValue to show the prompt.
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [hasUnsaved, panelKey]);

  useEffect(
    () => () => {
      unsavedPanels.delete(panelKey);
    },
    [panelKey],
  );

  const readOnly = writable ? !writable.allowed : false;

  return (
    <section
      data-coding-panel
      data-coding-read-only={readOnly ? "true" : "false"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "14px 16px",
        background: "rgba(15, 23, 42, 0.03)",
        borderRadius: 12,
        border: "1px solid rgba(15, 23, 42, 0.08)",
        minWidth: 0,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: 13, letterSpacing: 0.4 }}>Coding</strong>
        <small style={{ color: "#475569" }}>
          {fields.length} field{fields.length === 1 ? "" : "s"}
        </small>
      </header>
      {readOnly ? (
        <p data-coding-read-only-reason style={{ margin: 0, fontSize: 12, color: "#334155" }}>
          {codingReadOnlyMessage(writable?.reason ?? null)}
        </p>
      ) : null}
      {fields.map((f) => {
        const current = valueMap.get(f.id);
        const isMissing = f.required && unfulfilledFieldIds.has(f.id);
        return (
          <FieldRow
            key={f.id}
            field={f}
            current={current}
            isMissing={isMissing}
            readOnly={readOnly}
            canClear={Boolean(onClear)}
            status={statuses[f.id] ?? IDLE}
            stale={isStale(f.id)}
            resyncToken={resync[f.id] ?? 0}
            canReload={Boolean(onReload)}
            send={send}
            queue={queue}
            failLocally={failLocally}
            setEditing={setFieldEditing}
            retry={retry}
            reload={reload}
            registerIntent={registerIntent}
          />
        );
      })}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-coding-live
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {announcement}
      </p>
    </section>
  );
}

// =============================================================================
// Field row
// =============================================================================

type RowApi = {
  send: (field: CodingFieldRow, op: SaveOp) => Promise<void>;
  queue: (fieldId: string) => void;
  failLocally: (field: CodingFieldRow, message: string) => void;
  setEditing: (fieldId: string, on: boolean) => void;
  /** Register the widget's CURRENT intended op (Retry sends it). */
  registerIntent: (fieldId: string, get: (() => SaveOp | null) | null) => void;
};

type StatusApi = {
  retry: (field: CodingFieldRow, fallback: SaveOp | null, baseRevision?: number) => void;
  reload: (field: CodingFieldRow) => void;
};

function FieldRow({
  field,
  current,
  isMissing,
  readOnly,
  canClear,
  status,
  stale,
  resyncToken,
  canReload,
  send,
  queue,
  failLocally,
  setEditing,
  retry,
  reload,
  registerIntent,
}: {
  field: CodingFieldRow;
  current: CodingValueRow | undefined;
  isMissing: boolean;
  readOnly: boolean;
  canClear: boolean;
  status: FieldStatus;
  /** The server value is older than what this session saved: not shown. */
  stale: boolean;
  resyncToken: number;
  canReload: boolean;
} & RowApi &
  StatusApi) {
  const labelId = codingLabelId(field.id);
  const displayLabel = codingFieldDisplayLabel(field);
  return (
    <div
      data-coding-field-row
      data-coding-field-id={field.id}
      data-coding-field-required={field.required ? "true" : "false"}
      data-coding-field-missing={isMissing ? "true" : "false"}
      style={{ display: "grid", gap: 4, minWidth: 0 }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8 }}>
        {/* PRO-076: the label names the widget below it (aria-labelledby). */}
        <label id={labelId} style={{ fontSize: 12, color: "#0f172a", fontWeight: 600 }}>
          {displayLabel}
          {field.required ? (
            <span aria-hidden="true" style={{ color: "#b91c1c", marginLeft: 4 }}>
              *
            </span>
          ) : null}
        </label>
        {readOnly ? null : (
          <FieldStatusLine field={field} status={status} retry={retry} reload={reload} canReload={canReload} />
        )}
      </div>
      {field.helpText ? <small style={{ color: "#64748b", fontSize: 11 }}>{field.helpText}</small> : null}
      {readOnly ? (
        <p data-coding-read-only-value style={{ margin: 0, fontSize: 13, color: "#0f172a", overflowWrap: "anywhere" }}>
          {formatCodingValue(field, current?.value)}
        </p>
      ) : (
        <FieldWidget
          field={field}
          current={current}
          status={status}
          stale={stale}
          resyncToken={resyncToken}
          canClear={canClear}
          send={send}
          queue={queue}
          failLocally={failLocally}
          setEditing={setEditing}
          registerIntent={registerIntent}
        />
      )}
      {isMissing ? (
        <small data-coding-required-warning style={{ color: "#b45309", fontSize: 11 }}>
          Required — the assessment is incomplete without it.
        </small>
      ) : null}
    </div>
  );
}

const statusButtonStyle = {
  fontSize: 11,
  padding: "2px 8px",
  minHeight: 24,
  borderRadius: 6,
  border: "1px solid #b91c1c",
  background: "#fff",
  color: "#b91c1c",
  cursor: "pointer",
};

function FieldStatusLine({
  field,
  status,
  retry,
  reload,
  canReload,
}: {
  field: CodingFieldRow;
  status: FieldStatus;
  canReload: boolean;
} & StatusApi) {
  if (status.kind === "idle") return null;
  if (status.kind === "saving" || status.kind === "queued") {
    return (
      <small data-coding-field-status="saving" style={{ fontSize: 11, color: "#475569" }}>
        Saving…
      </small>
    );
  }
  if (status.kind === "saved") {
    return (
      <small data-coding-field-status="saved" style={{ fontSize: 11, color: "#15803d" }}>
        Saved
      </small>
    );
  }
  const op = status.op;
  if (status.failKind === "conflict") {
    // Review remediation A — the server refused a stale change; the draft is
    // kept. Reload shows the stored value; Keep mine re-sends the reviewer's
    // current value based on what is stored now (an explicit overwrite).
    const base = status.currentRevision;
    return (
      <small
        data-coding-field-status="failed"
        data-coding-field-failure="conflict"
        style={{ fontSize: 11, color: "#b91c1c", display: "inline-flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}
      >
        <span>Not saved — {status.message}</span>
        {canReload ? (
          <button
            type="button"
            data-coding-field-reload
            onClick={() => reload(field)}
            aria-label={`Reload ${field.label}`}
            style={statusButtonStyle}
          >
            Reload
          </button>
        ) : null}
        {base !== undefined ? (
          <button
            type="button"
            data-coding-field-keep-mine
            onClick={() => retry(field, op, base)}
            aria-label={`Save my value for ${field.label} anyway`}
            style={statusButtonStyle}
          >
            Keep mine
          </button>
        ) : null}
      </small>
    );
  }
  return (
    <small
      data-coding-field-status="failed"
      data-coding-field-failure={status.failKind}
      style={{ fontSize: 11, color: "#b91c1c", display: "inline-flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}
    >
      <span>
        {status.failKind === "network" ? "Not saved — no connection." : `Not saved — ${status.message}`}
      </span>
      {op ? (
        <button
          type="button"
          data-coding-field-retry
          // Retry sends the field's CURRENT intended value (the draft), not
          // the operation that failed.
          onClick={() => retry(field, op)}
          aria-label={`Retry saving ${field.label}`}
          style={statusButtonStyle}
        >
          Retry
        </button>
      ) : null}
    </small>
  );
}

function codingLabelId(fieldId: string): string {
  return `coding-field-label-${fieldId}`;
}

// =============================================================================
// Draft handling
// =============================================================================

/**
 * The value an input shows. Follows the server value whenever it changes,
 * except while the reviewer is editing the field or its save is in flight /
 * failed — then the reviewer's own entry stays.
 */
function useDraft<T>(server: T, serverKey: string, status: FieldStatus, sync: DraftSync) {
  const [draft, setDraftState] = useState<T>(server);
  const dirty = useRef(false);
  const lockedRef = useRef(false);
  const staleRef = useRef(false);
  const tokenRef = useRef(sync.resyncToken);
  lockedRef.current = status.kind === "saving" || status.kind === "queued" || status.kind === "failed";
  // Review remediation A — a server value OLDER than what this session saved
  // (a read that started before the save) never replaces the newer input.
  staleRef.current = sync.stale;
  useEffect(() => {
    if (tokenRef.current !== sync.resyncToken) {
      // Reload after a conflict: show the stored value again.
      tokenRef.current = sync.resyncToken;
      dirty.current = false;
      setDraftState(server);
      return;
    }
    if (dirty.current || lockedRef.current || staleRef.current) return;
    setDraftState(server);
    // Only a NEW server value re-syncs (serverKey), never a status change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey, sync.resyncToken]);
  const setDraft = useCallback((v: T) => {
    dirty.current = true;
    setDraftState(v);
  }, []);
  const settle = useCallback(() => {
    dirty.current = false;
  }, []);
  return { draft, setDraft, settle, dirty };
}

/**
 * Review remediation A — register what the widget would save NOW, so Retry
 * sends the current intended value (an edit made after a failure included).
 */
function useIntent(fieldId: string, register: RowApi["registerIntent"], get: () => SaveOp | null) {
  const getRef = useRef(get);
  getRef.current = get;
  useEffect(() => {
    register(fieldId, () => getRef.current());
    return () => register(fieldId, null);
  }, [fieldId, register]);
}

// =============================================================================
// Widgets
// =============================================================================

function FieldWidget({
  field,
  current,
  status,
  stale,
  resyncToken,
  canClear,
  send,
  queue,
  failLocally,
  setEditing,
  registerIntent,
}: {
  field: CodingFieldRow;
  current: CodingValueRow | undefined;
  status: FieldStatus;
  stale: boolean;
  resyncToken: number;
  canClear: boolean;
} & RowApi) {
  const v = (current?.value ?? {}) as Record<string, unknown>;
  const labelId = codingLabelId(field.id);
  const sync: DraftSync = { stale, resyncToken };
  const props = { field, v, labelId, status, sync, canClear, send, queue, failLocally, setEditing, registerIntent };
  switch (field.fieldType) {
    case "TEXT":
      return <TextWidget {...props} />;
    case "NUMERIC":
      return <NumericWidget {...props} />;
    case "BOOLEAN":
      return <BooleanWidget {...props} />;
    case "CONFIDENCE_SCORE":
      return <ConfidenceWidget {...props} />;
    case "REVIEWER_VERDICT":
      return (
        <ChoiceWidget
          {...props}
          payloadKey="verdict"
          options={REVIEWER_VERDICTS.map((x) => ({ value: x, label: x }))}
          serverValue={typeof v["verdict"] === "string" ? (v["verdict"] as string) : ""}
          toPayload={(val) => val}
        />
      );
    case "RISK_LEVEL":
      return (
        <ChoiceWidget
          {...props}
          payloadKey="risk"
          options={REVIEWER_RISK_LEVELS.map((x) => ({ value: x, label: x }))}
          serverValue={typeof v["risk"] === "string" ? (v["risk"] as string) : ""}
          toPayload={(val) => val}
        />
      );
    case "ESCALATION_LEVEL":
      return (
        <ChoiceWidget
          {...props}
          payloadKey="escalation"
          options={ESCALATION_LEVELS.map((x) => ({ value: String(x), label: `Level ${x}` }))}
          serverValue={typeof v["escalation"] === "number" ? String(v["escalation"]) : ""}
          toPayload={(val) => Number(val)}
        />
      );
    case "SINGLE_SELECT":
      return (
        <ChoiceWidget
          {...props}
          payloadKey="single"
          options={selectOptions(field)}
          serverValue={typeof v["single"] === "string" ? (v["single"] as string) : ""}
          toPayload={(val) => val}
        />
      );
    case "MULTI_SELECT":
      return <MultiWidget {...props} />;
  }
  return null;
}

/** How a widget's draft follows the server value (review remediation A). */
type DraftSync = { stale: boolean; resyncToken: number };

type WidgetProps = {
  field: CodingFieldRow;
  v: Record<string, unknown>;
  labelId: string;
  status: FieldStatus;
  sync: DraftSync;
  canClear: boolean;
} & RowApi;

function selectOptions(field: CodingFieldRow): Array<{ value: string; label: string }> {
  const raw = (field.options ?? {})["options"];
  return Array.isArray(raw) ? (raw as Array<{ value: string; label: string }>) : [];
}

/**
 * The value the field is known to hold (or about to): the latest intent being
 * saved, or what the last successful save sent (the parent may not have
 * re-read yet), otherwise the server value. Review remediation A: emptying a
 * field whose first value is still saving must send a clear, not nothing.
 */
function knownValue(status: FieldStatus, key: string, server: string, format: (v: unknown) => string): string {
  if (status.kind !== "saved" && status.kind !== "saving") return server;
  return status.op.kind === "clear" ? "" : format(status.op.value[key]);
}

/** Skip a send identical to the one already saving / saved for this field. */
function alreadySent(status: FieldStatus, op: SaveOp): boolean {
  return (status.kind === "saving" || status.kind === "saved") && opKey(status.op) === opKey(op);
}

function TextWidget({ field, v, labelId, status, sync, canClear, send, setEditing, registerIntent }: WidgetProps) {
  const serverText = typeof v["text"] === "string" ? (v["text"] as string) : "";
  const { draft, setDraft, settle } = useDraft(serverText, serverText, status, sync);
  useIntent(field.id, registerIntent, () =>
    draft.trim().length === 0 ? (canClear ? { kind: "clear" } : null) : { kind: "write", value: { text: draft } },
  );
  function commit() {
    settle();
    setEditing(field.id, false);
    const known = knownValue(status, "text", serverText, (x) => (typeof x === "string" ? x : ""));
    if (draft.trim().length === 0) {
      // An emptied field is an explicit clear (when something was stored).
      if (known.length === 0 && status.kind !== "failed") return;
      if (!canClear) return;
      const op: SaveOp = { kind: "clear" };
      if (!alreadySent(status, op)) void send(field, op);
      return;
    }
    const op: SaveOp = { kind: "write", value: { text: draft } };
    if (draft === known && status.kind !== "failed") return;
    if (alreadySent(status, op)) return;
    void send(field, op);
  }
  return (
    <textarea
      aria-labelledby={labelId}
      rows={3}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        setEditing(field.id, true);
      }}
      onBlur={commit}
      style={widgetStyle}
    />
  );
}

function NumericWidget({ field, v, labelId, status, sync, canClear, send, failLocally, setEditing, registerIntent }: WidgetProps) {
  const serverNum = typeof v["number"] === "number" ? String(v["number"] as number) : "";
  const { draft, setDraft, settle } = useDraft(serverNum, serverNum, status, sync);
  useIntent(field.id, registerIntent, () => {
    const raw = draft.trim();
    if (raw.length === 0) return canClear ? { kind: "clear" } : null;
    const n = Number(raw);
    return Number.isFinite(n) ? { kind: "write", value: { number: n } } : null;
  });
  function commit() {
    settle();
    setEditing(field.id, false);
    const raw = draft.trim();
    const known = knownValue(status, "number", serverNum, (x) => (typeof x === "number" ? String(x) : ""));
    if (raw.length === 0) {
      if (known.length === 0 && status.kind !== "failed") return;
      if (!canClear) return;
      const op: SaveOp = { kind: "clear" };
      if (!alreadySent(status, op)) void send(field, op);
      return;
    }
    const next = Number(raw);
    if (!Number.isFinite(next)) {
      failLocally(field, "Enter a number.");
      return;
    }
    const op: SaveOp = { kind: "write", value: { number: next } };
    if (known !== "" && Number(known) === next && status.kind !== "failed") return;
    if (alreadySent(status, op)) return;
    void send(field, op);
  }
  return (
    <input
      aria-labelledby={labelId}
      type="number"
      inputMode="decimal"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        setEditing(field.id, true);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      style={widgetStyle}
    />
  );
}

function BooleanWidget({ field, v, labelId, status, sync, canClear, send }: WidgetProps) {
  const serverChoice = v["boolean"] === true ? "yes" : v["boolean"] === false ? "no" : "unset";
  const { draft, setDraft, settle } = useDraft(serverChoice, serverChoice, status, sync);
  const name = `coding-boolean-${field.id}`;
  function choose(next: "unset" | "yes" | "no") {
    setDraft(next);
    settle();
    const op: SaveOp = next === "unset" ? { kind: "clear" } : { kind: "write", value: { boolean: next === "yes" } };
    void send(field, op);
  }
  const choices: Array<{ value: "unset" | "yes" | "no"; label: string }> = [
    ...(canClear || serverChoice === "unset" ? [{ value: "unset" as const, label: "Not set" }] : []),
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
  ];
  return (
    <div role="radiogroup" aria-labelledby={labelId} data-coding-boolean style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {choices.map((c) => (
        <label key={c.value} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, minHeight: 32 }}>
          <input
            type="radio"
            name={name}
            value={c.value}
            checked={draft === c.value}
            disabled={c.value === "unset" && !canClear}
            onChange={() => choose(c.value)}
          />
          {c.label}
        </label>
      ))}
    </div>
  );
}

const CONFIDENCE_DEBOUNCE_MS = 400;

function ConfidenceWidget({ field, v, labelId, status, sync, canClear, send, queue, setEditing, registerIntent }: WidgetProps) {
  const serverConf = typeof v["confidence"] === "number" ? (v["confidence"] as number) : null;
  const { draft, setDraft, settle } = useDraft<number | null>(serverConf, String(serverConf), status, sync);
  useIntent(field.id, registerIntent, () =>
    draft === null ? (canClear ? { kind: "clear" } : null) : { kind: "write", value: { confidence: draft } },
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<number | null>(draft);
  latest.current = draft;

  const flush = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    settle();
    setEditing(field.id, false);
    const value = latest.current;
    if (value === null) return;
    void send(field, { kind: "write", value: { confidence: value } });
  }, [field, send, settle, setEditing]);

  useEffect(
    () => () => {
      // Unmount: the final value is still sent.
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
        const value = latest.current;
        if (value !== null) void send(field, { kind: "write", value: { confidence: value } });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function change(raw: string) {
    if (raw.trim() === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(CONFIDENCE_SCORE_RANGE.max, Math.max(CONFIDENCE_SCORE_RANGE.min, Math.round(n)));
    setDraft(clamped);
    latest.current = clamped;
    setEditing(field.id, true);
    queue(field.id);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, CONFIDENCE_DEBOUNCE_MS);
  }

  function clear() {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setDraft(null);
    latest.current = null;
    settle();
    setEditing(field.id, false);
    void send(field, { kind: "clear" });
  }

  const unset = draft === null;
  const numberId = `${labelId}-number`;
  return (
    <div data-coding-confidence data-coding-confidence-unset={unset ? "true" : "false"} style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input
          aria-labelledby={labelId}
          type="range"
          min={CONFIDENCE_SCORE_RANGE.min}
          max={CONFIDENCE_SCORE_RANGE.max}
          step={1}
          // The thumb needs a position; "Not set" is stated in text and in
          // aria-valuetext, and nothing is sent until the reviewer moves it.
          value={draft ?? Math.round((CONFIDENCE_SCORE_RANGE.min + CONFIDENCE_SCORE_RANGE.max) / 2)}
          aria-valuetext={unset ? "Not set" : String(draft)}
          onChange={(e) => change(e.target.value)}
          onPointerUp={(e) => {
            // A click on the thumb's resting spot sets that value too.
            if (unset) change((e.target as HTMLInputElement).value);
            flush();
          }}
          onBlur={flush}
          style={{ flex: "1 1 160px", opacity: unset ? 0.55 : 1 }}
        />
        <input
          id={numberId}
          aria-label={`${field.label} (0–100)`}
          type="number"
          min={CONFIDENCE_SCORE_RANGE.min}
          max={CONFIDENCE_SCORE_RANGE.max}
          step={1}
          value={draft ?? ""}
          placeholder="—"
          onChange={(e) => change(e.target.value)}
          onBlur={flush}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              flush();
            }
          }}
          style={{ ...widgetStyle, width: 72 }}
        />
        <span data-coding-confidence-display style={{ fontSize: 12, color: "#334155" }}>
          {unset ? "Not set" : `${draft}`}
        </span>
        {canClear && !unset ? (
          <button type="button" data-coding-field-clear onClick={clear} style={clearButtonStyle}>
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ChoiceWidget({
  field,
  labelId,
  status,
  sync,
  canClear,
  send,
  options,
  serverValue,
  payloadKey,
  toPayload,
}: WidgetProps & {
  options: ReadonlyArray<{ value: string; label: string }>;
  serverValue: string;
  payloadKey: string;
  toPayload: (val: string) => unknown;
}) {
  const { draft, setDraft, settle } = useDraft(serverValue, serverValue, status, sync);
  return (
    <AppListbox
      ariaLabelledby={labelId}
      value={draft}
      options={[
        // "Not set" clears; offered whenever clearing is possible.
        ...(canClear || draft === "" ? [{ value: "", label: "Not set" }] : []),
        ...options.map((o) => ({ value: o.value, label: o.label })),
      ]}
      onChange={(next) => {
        if (next === draft) return;
        setDraft(next);
        settle();
        if (next === "") {
          if (canClear) void send(field, { kind: "clear" });
          return;
        }
        void send(field, { kind: "write", value: { [payloadKey]: toPayload(next) } });
      }}
    />
  );
}

function MultiWidget({ field, v, labelId, status, sync, canClear, send }: WidgetProps) {
  const serverSel = (Array.isArray(v["multi"]) ? (v["multi"] as unknown[]) : []).filter(
    (x): x is string => typeof x === "string",
  );
  const { draft, setDraft, settle } = useDraft<string[]>(serverSel, JSON.stringify(serverSel), status, sync);
  const opts = selectOptions(field);
  function commit(next: string[]) {
    setDraft(next);
    settle();
    if (next.length === 0) {
      if (canClear) void send(field, { kind: "clear" });
      else void send(field, { kind: "write", value: { multi: [] } });
      return;
    }
    void send(field, { kind: "write", value: { multi: next } });
  }
  return (
    <div role="group" aria-labelledby={labelId} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {opts.map((o) => {
        const isOn = draft.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={isOn}
            onClick={() => commit(isOn ? draft.filter((x) => x !== o.value) : [...draft, o.value])}
            style={{
              padding: "4px 10px",
              minHeight: 32,
              borderRadius: 999,
              border: `1px solid ${isOn ? "#0f172a" : "#cbd5e1"}`,
              background: isOn ? "#0f172a" : "#fff",
              color: isOn ? "#fafafa" : "#0f172a",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        );
      })}
      {canClear && draft.length > 0 ? (
        <button type="button" data-coding-field-clear onClick={() => commit([])} style={clearButtonStyle}>
          Clear
        </button>
      ) : null}
    </div>
  );
}

// =============================================================================
// Read-only formatting
// =============================================================================

/** A stored coding payload as plain text ("Not set" when absent). */
export function formatCodingValue(
  field: Pick<CodingFieldRow, "fieldType" | "options">,
  value: unknown,
): string {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const optLabel = (val: string) =>
    selectOptions(field as CodingFieldRow).find((o) => o.value === val)?.label ?? val;
  switch (field.fieldType) {
    case "TEXT":
      return typeof v["text"] === "string" && v["text"] ? (v["text"] as string) : "Not set";
    case "NUMERIC":
      return typeof v["number"] === "number" ? String(v["number"]) : "Not set";
    case "BOOLEAN":
      return v["boolean"] === true ? "Yes" : v["boolean"] === false ? "No" : "Not set";
    case "CONFIDENCE_SCORE":
      return typeof v["confidence"] === "number" ? `${v["confidence"]} / 100` : "Not set";
    case "REVIEWER_VERDICT":
      return typeof v["verdict"] === "string" ? (v["verdict"] as string) : "Not set";
    case "RISK_LEVEL":
      return typeof v["risk"] === "string" ? (v["risk"] as string) : "Not set";
    case "ESCALATION_LEVEL":
      return typeof v["escalation"] === "number" ? `Level ${v["escalation"]}` : "Not set";
    case "SINGLE_SELECT":
      return typeof v["single"] === "string" ? optLabel(v["single"] as string) : "Not set";
    case "MULTI_SELECT": {
      const sel = Array.isArray(v["multi"]) ? (v["multi"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
      return sel.length ? sel.map(optLabel).join(", ") : "Not set";
    }
  }
  return "Not set";
}

const widgetStyle = {
  padding: "6px 8px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#fff",
  width: "100%",
  boxSizing: "border-box" as const,
};

const clearButtonStyle = {
  fontSize: 11,
  padding: "4px 10px",
  minHeight: 32,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  cursor: "pointer",
};
