"use client";

/**
 * REVIEW & SIGN — the last look before the session is sealed.
 *
 * Review & Sign used to start finalization on the first click. The operator
 * had no single place that showed what was about to be sealed, under which
 * setup, with which warnings still open, or what finalizing actually does.
 * This dialog is that place. It decides nothing:
 *
 *   * it opens only from the Review & Sign button, which is still disabled by
 *     \`finishDisabled = busy || !sessionReadiness.canFinalize\`;
 *   * "Sign and finalize" calls the page's existing \`finalizeSession\`, whose
 *     own guards (offline, unknown workspace, location measurement, server
 *     validation) all still apply;
 *   * every line is read from state the page already holds.
 *
 * What finalizing does is stated from the implementation (orchestration hook):
 * create the evidence record in the active workspace, upload each file, have
 * the server recompute its SHA-256, seal the record, and start report and
 * package generation. It makes no claim about truth, authorship or presence.
 */

import { useEffect, useId, useRef } from "react";
import { AlertTriangle, FileCheck2, X } from "lucide-react";

import { getRoleFromChecklistStep } from "./captureReadiness";
import { formatFileSize, getChecklistStepById } from "./file-utils";
import type { CapturePlanMode, ReadinessIssue } from "./session-readiness";
import type { CollectionPlanTemplate, SessionItem } from "./types";

type Props = {
  open: boolean;
  busy: boolean;
  items: SessionItem[];
  plan: CollectionPlanTemplate | undefined;
  planMode: CapturePlanMode;
  workspaceName: string | null;
  locationLabel: string;
  hasPrivateNote: boolean;
  warnings: ReadonlyArray<ReadinessIssue>;
  totalBytes: number;
  onCancel: () => void;
  onConfirm: () => void;
};

export function CaptureReviewDialog({
  open,
  busy,
  items,
  plan,
  planMode,
  workspaceName,
  locationLabel,
  hasPrivateNote,
  warnings,
  totalBytes,
  onCancel,
  onConfirm,
}: Props) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      // Keep focus inside the dialog while it is open.
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex='0']"),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;

  // The authority reports an unassigned file twice (unmapped + item quality);
  // show each file's issue once, named, as the summary rail does.
  const seen = new Set<string>();
  const shownWarnings = warnings.filter((w) => {
    if (!w.itemId) return true;
    const key = `${w.itemId}|${w.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const nameOf = (itemId?: string) => (itemId ? items.find((i) => i.id === itemId)?.file.name : undefined);

  return (
    <div className="capture-confirm-backdrop capture-review-backdrop" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="capture-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-capture-review-dialog
        onClick={(event) => event.stopPropagation()}
      >
        <header className="capture-review__head">
          <span className="capture-review__icon" aria-hidden="true">
            <FileCheck2 size={20} />
          </span>
          <div>
            <h2 id={titleId}>Review before signing</h2>
            <p>
              {items.length} item{items.length === 1 ? "" : "s"} · {formatFileSize(totalBytes)} ·{" "}
              {workspaceName ?? "Active workspace"}
            </p>
          </div>
          <button type="button" className="capture-icon-button" onClick={onCancel} aria-label="Close review">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="capture-review__body">
          <section aria-label="Evidence to seal">
            <h3>Evidence</h3>
            <ul className="capture-review__items">
              {items.map((item) => {
                const step = getChecklistStepById(plan, item.checklistStepId);
                return (
                  <li key={item.id}>
                    <span className="capture-review__name" title={item.file.name}>
                      {item.file.name}
                    </span>
                    <span className="capture-review__assign">
                      {step ? `${getRoleFromChecklistStep(step)} · ${step.title}` : "Not assigned"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-label="Context">
            <h3>Context</h3>
            <dl className="capture-review__facts">
              <div>
                <dt>Template</dt>
                <dd>{plan?.name ?? "General evidence"}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{planMode === "CHECKLIST_REQUIRED" ? "Guided" : "Flexible"}</dd>
              </div>
              <div>
                <dt>Location</dt>
                <dd>{locationLabel}</dd>
              </div>
              <div>
                <dt>Private note</dt>
                <dd>{hasPrivateNote ? "Added (stays private)" : "None"}</dd>
              </div>
            </dl>
          </section>

          {shownWarnings.length > 0 ? (
            <section aria-label="Remaining warnings" className="capture-review__warnings">
              <h3>
                <AlertTriangle size={15} aria-hidden="true" /> {shownWarnings.length} warning
                {shownWarnings.length === 1 ? "" : "s"} to consider
              </h3>
              <ul>
                {shownWarnings.slice(0, 5).map((warning, index) => (
                  <li key={`${warning.code}-${warning.itemId ?? index}`}>
                    {nameOf(warning.itemId) ? `${nameOf(warning.itemId)}: ` : ""}
                    {warning.label}
                  </li>
                ))}
              </ul>
              {shownWarnings.length > 5 ? <p>+{shownWarnings.length - 5} more</p> : null}
              <p>Warnings do not stop signing. You can go back and resolve them first.</p>
            </section>
          ) : null}

          <section aria-label="What signing does" className="capture-review__what">
            <h3>What happens when you sign</h3>
            <ul>
              <li>An evidence record is created in {workspaceName ?? "the active workspace"}.</li>
              <li>Each file is uploaded and its SHA-256 fingerprint is recomputed by the server.</li>
              <li>The record is sealed: its files and their fingerprints are fixed, so a later altered copy is detectable.</li>
              <li>The report and verification package are generated afterwards.</li>
            </ul>
            <p className="capture-review__boundary">
              Sealing records how and when the material was received. It does not establish that the content is
              true, who authored it, or where it was captured.
            </p>
          </section>
        </div>

        <footer className="capture-review__actions">
          <button type="button" className="app-secondary-action" onClick={onCancel}>
            Back to capture
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="app-primary-action"
            onClick={onConfirm}
            disabled={busy}
            data-capture-review-confirm
          >
            Sign and finalize
          </button>
        </footer>
      </div>
    </div>
  );
}

export default CaptureReviewDialog;
