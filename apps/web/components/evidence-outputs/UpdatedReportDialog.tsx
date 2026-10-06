"use client";

/**
 * GENERATE REPORT vN — the updated-report confirmation (RGA-02 / RGA-03).
 *
 * WHAT IT CONFIRMS IS WHAT THE SERVER SIGNED. On open it re-reads
 * `/artifacts/status` and holds the signed offer revision it was given. Confirm
 * sends THAT revision; the server re-derives every bound fact (versions, TSA,
 * OTS, the decisions, the active request, permission, eligibility, credit and
 * storage effect) immediately before it creates the durable request and refuses
 * a confirmation that no longer describes the record. The dialog then updates in
 * place: it says what changed, keeps the reason, re-reads the current offer and
 * asks for a NEW confirmation. Nothing about staleness is decided here.
 *
 * IDEMPOTENCY. A client key is minted per confirmation and reused only while
 * that request is unanswered, so a lost response is answered with the first
 * request (REPLAYED) instead of a second version. A new confirmation after a
 * stale refusal is a new key.
 *
 * ACCESSIBILITY. role=dialog + aria-modal, labelled and described; initial focus
 * on the required reason field; Tab is trapped; Escape cancels (not while
 * submitting); focus returns to the control that opened it. Errors are inline
 * (aria-invalid + aria-describedby) and announced (role=alert). The submitting
 * state is aria-busy and the control cannot be activated twice.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  NEW_VERSION_ACTION,
  NEW_VERSION_REASON_MAX,
  formatEstimatedBytes,
  makeClientRequestKey,
  newVersionReasonError,
  normalizeNewVersionReason,
  outputOperationError,
  outputOperationErrorForReason,
  reportFreshnessChangeCopy,
  validateNewVersionReason,
  type OutputOfferEnvelope,
  type ReportFreshness,
} from "@proovra/shared";

import type {
  ArtifactOutputsExtras,
  NewVersionDecision,
  NewVersionSubmitResult,
} from "./artifact-status-types";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type Snapshot = {
  newVersion: NewVersionDecision | null;
  offer: OutputOfferEnvelope | null;
  freshness: ReportFreshness | null;
};

export type UpdatedReportDialogProps = {
  open: boolean;
  onClose: () => void;
  /** The page's current view, shown while the authoritative offer is re-read. */
  initial: Snapshot;
  /** Re-read the authoritative status (`/artifacts/status`). */
  loadStatus: () => Promise<{ outputs?: ArtifactOutputsExtras | null } | null>;
  submit: (input: {
    clientRequestKey: string;
    reason: string;
    offerRevision: string | null;
  }) => Promise<NewVersionSubmitResult>;
  onAccepted: (requestId: string | null, message: string) => void;
};

export function UpdatedReportDialog(props: UpdatedReportDialogProps) {
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(<DialogBody {...props} />, document.body);
}

function DialogBody({ onClose, initial, loadStatus, submit, onAccepted }: UpdatedReportDialogProps) {
  const titleId = useId();
  const descId = useId();
  const reasonId = useId();
  const reasonHintId = useId();
  const reasonErrorId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const pendingKey = useRef<string | null>(null);

  const [snap, setSnap] = useState<Snapshot>(initial);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reasonRaw, setReasonRaw] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [changes, setChanges] = useState<string[] | null>(null);
  const [error, setError] = useState<{ title: string; description: string } | null>(null);

  const refresh = useCallback(async (): Promise<Snapshot | null> => {
    setLoading(true);
    try {
      const r = await loadStatus();
      const o = r?.outputs ?? null;
      if (!o) throw new Error("no outputs");
      const next: Snapshot = {
        newVersion: o.newVersion ?? null,
        offer: o.offer ?? null,
        freshness: o.freshness ?? null,
      };
      setSnap(next);
      setLoadFailed(false);
      return next;
    } catch {
      setLoadFailed(true);
      return null;
    } finally {
      setLoading(false);
    }
  }, [loadStatus]);

  // Open: remember the opener, load the CURRENT offer, focus the reason.
  useEffect(() => {
    openerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    void refresh();
    const t = setTimeout(() => reasonRef.current?.focus(), 0);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      clearTimeout(t);
      document.body.style.overflow = prevOverflow;
      const opener = openerRef.current;
      if (opener && document.body.contains(opener)) {
        try {
          opener.focus();
        } catch {
          /* focus restoration is best-effort */
        }
      }
    };
    // Mount-only: the dialog loads once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  // Escape + focus trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [close]);

  const nv = snap.newVersion;
  const offered = nv?.action === NEW_VERSION_ACTION;
  const current = nv?.currentVersion ?? null;
  const target = snap.offer?.operation === "NEW_VERSION" ? snap.offer.targetVersion : (nv?.nextVersion ?? null);
  const check = validateNewVersionReason(reasonRaw);
  const count = normalizeNewVersionReason(reasonRaw).length;
  const showReasonError = touched && !check.ok;
  const confirmDisabled = busy || loading || !offered || !check.ok || !snap.offer;

  const submitConfirmation = async () => {
    setTouched(true);
    if (confirmDisabled || !check.ok) return;
    setBusy(true);
    setError(null);
    pendingKey.current ??= makeClientRequestKey();
    try {
      const result = await submit({
        clientRequestKey: pendingKey.current,
        reason: check.value,
        offerRevision: snap.offer?.revision ?? null,
      });
      if (result.kind === "accepted") {
        pendingKey.current = null;
        onAccepted(result.requestId, result.message);
        onClose();
        return;
      }
      if (result.kind === "stale") {
        // A NEW confirmation follows: new key, re-read offer, reason kept.
        pendingKey.current = null;
        setChanges(result.changeMessages.length ? result.changeMessages : [outputOperationError("OFFER_STALE").description]);
        await refresh();
        return;
      }
      if (result.answered) pendingKey.current = null;
      setError({ title: result.title, description: result.description });
    } finally {
      setBusy(false);
    }
  };

  const withdrawn = !loading && !loadFailed && nv != null && !offered;
  const withdrawnCopy = withdrawn
    ? (outputOperationErrorForReason(nv?.reason) ?? outputOperationError("OFFER_STALE"))
    : null;
  const used = formatEstimatedBytes(snap.offer?.storageEffect.storageBytesUsed ?? nv?.estimate?.storageBytesUsed ?? null);
  const limit = formatEstimatedBytes(snap.offer?.storageEffect.storageBytesLimit ?? nv?.estimate?.storageBytesLimit ?? null);
  const estimate = formatEstimatedBytes(snap.offer?.storageEffect.estimatedBytes ?? nv?.estimate?.estimatedBytes ?? null);
  const freshness = snap.freshness;

  return (
    <div
      className="rga-dialog-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="rga-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        aria-busy={busy || loading || undefined}
        tabIndex={-1}
        data-testid="updated-report-dialog"
      >
        <header className="rga-dialog__head">
          <h2 id={titleId} className="rga-dialog__title">
            {target != null ? `Generate report v${target}` : "Generate an updated report"}
          </h2>
          <button
            type="button"
            className="rga-dialog__close"
            onClick={close}
            disabled={busy}
            aria-label="Close"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="rga-dialog__body">
          <p id={descId} className="rga-dialog__lede">
            An updated report documents this record&apos;s current verification facts as a new,
            separate version. It does not replace or alter any earlier version.
          </p>

          {changes ? (
            <div className="rga-dialog__notice" role="alert" data-testid="updated-report-stale">
              <strong>This record changed while this window was open</strong>
              <ul>
                {changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p>Review the current details below and confirm again. Your reason has been kept.</p>
            </div>
          ) : null}

          {loading ? (
            <p className="rga-dialog__loading" role="status" aria-live="polite">
              Loading the current details…
            </p>
          ) : null}
          {loadFailed ? (
            <div className="rga-dialog__notice rga-dialog__notice--error" role="alert">
              <strong>{outputOperationError("OFFER_LOAD_FAILED").title}</strong>
              <p>{outputOperationError("OFFER_LOAD_FAILED").description}</p>
              <button type="button" className="app-secondary-action" onClick={() => void refresh()}>
                Refresh details
              </button>
            </div>
          ) : null}

          {withdrawnCopy ? (
            <div className="rga-dialog__notice" role="alert" data-testid="updated-report-withdrawn">
              <strong>{withdrawnCopy.title}</strong>
              <p>{withdrawnCopy.description}</p>
            </div>
          ) : null}

          <dl className="rga-dialog__facts">
            <div>
              <dt>Current report</dt>
              <dd data-testid="updated-report-current">{current != null ? `v${current}` : "—"}</dd>
            </div>
            <div>
              <dt>New version</dt>
              <dd data-testid="updated-report-target">{target != null ? `v${target}` : "—"}</dd>
            </div>
          </dl>

          <section className="rga-dialog__section" aria-labelledby={`${titleId}-changes`}>
            <h3 id={`${titleId}-changes`} className="rga-dialog__subtitle">
              What changed since {current != null ? `v${current}` : "the latest report"}
            </h3>
            {freshness?.hasNewerFacts ? (
              <ul className="rga-dialog__list" data-testid="updated-report-changes">
                {freshness.changes.map((c) => (
                  <li key={c.code}>{reportFreshnessChangeCopy(c, freshness.reportVersion)}</li>
                ))}
              </ul>
            ) : (
              <p className="rga-dialog__muted">
                {freshness
                  ? "No newer verification facts were recorded. The new version documents the record as it is now."
                  : "The record's newer facts could not be listed here."}
              </p>
            )}
          </section>

          <div className="rga-dialog__field">
            <label htmlFor={reasonId} className="rga-dialog__label">
              Reason for the updated report <span className="rga-dialog__required">(required)</span>
            </label>
            <textarea
              id={reasonId}
              ref={reasonRef}
              className="rga-dialog__textarea"
              rows={3}
              maxLength={NEW_VERSION_REASON_MAX * 2}
              value={reasonRaw}
              onChange={(e) => setReasonRaw(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-required="true"
              aria-invalid={showReasonError || undefined}
              aria-describedby={`${reasonHintId}${showReasonError ? ` ${reasonErrorId}` : ""}`}
              placeholder="For example: document the timestamp validated after the first report"
              data-testid="updated-report-reason"
            />
            <div className="rga-dialog__field-foot">
              <span id={reasonHintId} className="rga-dialog__hint">
                Recorded on the new report and in its custody history.{" "}
                <span aria-live="polite" data-testid="updated-report-count">
                  {count}/{NEW_VERSION_REASON_MAX}
                </span>
              </span>
            </div>
            {showReasonError && !check.ok ? (
              <p id={reasonErrorId} className="rga-dialog__field-error" role="alert">
                {newVersionReasonError(check.reason)}
              </p>
            ) : null}
          </div>

          <section className="rga-dialog__section" aria-label="What this will do">
            <ul className="rga-dialog__list rga-dialog__list--effects" data-testid="updated-report-effects">
              <li data-testid="updated-report-credit">
                {snap.offer?.creditEffect.kind === "NONE" || !snap.offer
                  ? "No evidence credit is used."
                  : "This uses an evidence credit."}
              </li>
              <li data-testid="updated-report-storage">
                {estimate
                  ? `Adds about ${estimate} to workspace storage (an estimate based on the previous report and package).`
                  : "Adds a new report and verification package to workspace storage."}
                {used && limit ? ` Workspace storage now: ${used} of ${limit} used.` : ""}
              </li>
              <li>
                {current != null
                  ? `Report v${current} and its verification package stay exactly as they are and remain downloadable.`
                  : "Earlier versions stay exactly as they are and remain downloadable."}
              </li>
              <li>
                {target != null
                  ? `A matching verification package v${target} will certify report v${target}.`
                  : "A matching verification package will certify the new report."}
              </li>
              <li>The original evidence and its recorded timestamps are not modified.</li>
            </ul>
          </section>

          {error ? (
            <div className="rga-dialog__notice rga-dialog__notice--error" role="alert" data-testid="updated-report-error">
              <strong>{error.title}</strong>
              <p>{error.description}</p>
            </div>
          ) : null}
        </div>

        <footer className="rga-dialog__foot">
          <button type="button" className="app-secondary-action" onClick={close} disabled={busy}>
            {withdrawn ? "Close" : "Cancel"}
          </button>
          {withdrawn ? null : (
            <button
              type="button"
              className="app-primary-action"
              onClick={() => void submitConfirmation()}
              disabled={confirmDisabled}
              aria-disabled={confirmDisabled || undefined}
              aria-busy={busy || undefined}
              data-testid="updated-report-confirm"
            >
              {busy
                ? "Submitting…"
                : changes
                  ? target != null
                    ? `Confirm report v${target}`
                    : "Confirm again"
                  : target != null
                    ? `Generate report v${target}`
                    : "Generate updated report"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
