"use client";

/**
 * Capture — what a resumed draft actually restored, and what it could not.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `GET /v1/capture/sessions/:id` returns the draft's `itemsSnapshot`: for every
 * material the operator had staged, its file name, MIME type, size, role, the
 * requirement it was mapped to, its source label and its private note. The
 * resume path fetched all of that and then threw it away — it applied three
 * scalar fields and never read `items` at all. Nothing on screen changed, the
 * "you have unfinished sessions" banner stayed up because `sessionItems` was
 * still empty, and a success toast said the draft had been restored.
 *
 * The binaries genuinely cannot come back: `SessionItem.file` is a browser
 * `File`, and a `File` does not survive navigation. That is a real constraint,
 * not a bug. What was a bug is answering it with silence.
 *
 * So this renders the metadata the draft really holds. The operator sees the
 * exact files to re-attach and the requirement each one was mapped to, which
 * is the information that makes re-attaching a two-minute job instead of a
 * guess.
 *
 * It decides nothing. Every value is read from the draft detail the server
 * returned; readiness, mapping and finalization are untouched — a listed file
 * is not a staged material and is not counted as one anywhere.
 */

import { Paperclip } from "lucide-react";

import type { CaptureDraftDetail } from "../_hooks/useCaptureDraftList";
import type { CollectionPlanTemplate } from "./types";

export function CaptureDraftReattachNotice({
  detail,
  plan,
  onDismiss,
}: {
  detail: CaptureDraftDetail;
  /** Used only to name the requirement a file had been mapped to. */
  plan: CollectionPlanTemplate | undefined;
  onDismiss: () => void;
}) {
  const items = detail.items ?? [];
  if (items.length === 0) return null;

  const stepTitle = (stepId: string | null | undefined) => {
    if (!stepId) return null;
    return plan?.steps?.find((step) => step.id === stepId)?.title ?? null;
  };

  return (
    <section
      className="capture-reattach"
      data-capture-reattach
      data-capture-reattach-count={items.length}
      aria-label="Materials to re-attach from the resumed draft"
    >
      <header className="capture-reattach__head">
        <span className="capture-reattach__icon" aria-hidden="true">
          <Paperclip size={16} strokeWidth={2.1} />
        </span>
        <div>
          <strong>
            {items.length} material{items.length === 1 ? "" : "s"} to re-attach
          </strong>
          <p>
            This draft kept each file&apos;s name, type and requirement mapping.
            File contents are never stored before Review &amp; Sign, so the
            files themselves have to be added again — mappings below are for
            reference.
          </p>
        </div>
        <button
          type="button"
          className="capture-reattach__dismiss"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </header>

      <ul className="capture-reattach__list">
        {items.map((item, index) => {
          const mapped = stepTitle(item.checklistStepId);
          return (
            <li key={item.clientItemId ?? `${item.fileName}-${index}`}>
              <span className="capture-reattach__name">
                {item.fileName ?? "Untitled material"}
              </span>
              <span className="capture-reattach__meta">
                {mapped ? mapped : "Not mapped to a requirement"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default CaptureDraftReattachNotice;
