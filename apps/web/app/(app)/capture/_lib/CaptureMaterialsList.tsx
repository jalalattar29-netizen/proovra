"use client";

/**
 * STAGED EVIDENCE — the list of what this session will seal.
 *
 * WHY IT IS ITS OWN COMPONENT
 * ---------------------------------------------------------------------------
 * The rows used to be eight fixed grid columns (#, Preview, File, Type, Size,
 * Role & requirement, Status, Actions) declared by a stack of `!important`
 * rules in `capture-v2.css`. Their minimums added up to more than the working
 * column has once the side rail takes its share, so Status and Actions were
 * painted outside the card and "Preview" broke across two lines.
 *
 * This list sizes itself to ITS OWN width (a CSS container, not the viewport):
 *   * wide: Evidence (preview + name + type · size) | Assignment | Status |
 *     Actions, where only the filename shrinks;
 *   * narrow: one card per item — preview, name, status, assignment, actions —
 *     stacked, with no horizontal scrolling.
 * One DOM, one set of handlers, two layouts; nothing is rendered twice.
 *
 * State is not owned here. Items, the plan, and every mutation arrive from the
 * page, which takes them from `useCaptureSessionOrchestration`. Role and
 * requirement stay distinct: the requirement is `checklistStepId`, the role is
 * derived from it (or from `item.role` when unassigned), exactly as before.
 */

import { useId } from "react";
import {
  ChevronDown,
  FileText,
  Folder,
  ImageIcon,
  Mic,
  NotebookPen,
  Trash2,
  Video,
} from "lucide-react";

import { getRoleFromChecklistStep } from "./captureReadiness";
import {
  deriveSessionItemTypeLabel,
  formatEvidenceTypeLabel,
  formatFileSize,
  getChecklistStepById,
  getItemQualityStatus,
} from "./file-utils";
import type { CapturePlanMode } from "./session-readiness";
import type { CollectionPlanTemplate, SessionItem } from "./types";

type ItemPatch = Partial<Pick<SessionItem, "role" | "privateNote" | "checklistStepId" | "sourceLabel">>;

type Props = {
  items: SessionItem[];
  plan: CollectionPlanTemplate | undefined;
  planMode: CapturePlanMode;
  busy: boolean;
  totalBytes: number;
  draftLabel: string;
  draftTitle: string;
  openAssignmentId: string | null;
  setOpenAssignmentId: (id: string | null | ((current: string | null) => string | null)) => void;
  expandedId: string | null;
  setExpandedId: (id: string | null | ((current: string | null) => string | null)) => void;
  onUpdateItem: (id: string, patch: ItemPatch) => void;
  onRemoveItem: (id: string) => void;
  onClearAssignments: () => void;
  onRemovePending: () => void;
};

export const materialRowDomId = (itemId: string) => `capture-item-${itemId}`;

function simpleRoleLabel(role?: string | null): string {
  const normalized = role?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("primary")) return "Primary";
  if (normalized.startsWith("supporting")) return "Supporting";
  return "Context";
}

function iconFor(item: SessionItem) {
  if (item.relativePath) return Folder;
  if (item.mimeType.startsWith("audio/")) return Mic;
  if (item.mimeType.startsWith("video/")) return Video;
  if (item.mimeType.startsWith("image/")) return ImageIcon;
  return FileText;
}

/** Upload / retry state first (it is the live fact), then quality. */
function statusFor(item: SessionItem, plan: CollectionPlanTemplate | undefined) {
  if (item.error) return { tone: "critical" as const, label: "Retry needed", detail: item.error };
  if (item.uploading) {
    return {
      tone: "progress" as const,
      label: `Uploading ${Math.round(item.uploadProgress)}%`,
      detail: "Uploading as part of Review & Sign.",
    };
  }
  if (item.uploadProgress >= 100) {
    return { tone: "success" as const, label: "Uploaded", detail: "Uploaded; it is sealed when Review & Sign completes." };
  }
  const step = getChecklistStepById(plan, item.checklistStepId);
  const quality = getItemQualityStatus({ item, step });
  return {
    tone: quality.tone === "danger" ? ("critical" as const) : quality.tone === "success" ? ("success" as const) : ("warning" as const),
    label: quality.label === "Needs mapping" ? "Not assigned" : quality.label,
    detail: quality.detail,
  };
}

export function CaptureMaterialsList({
  items,
  plan,
  planMode,
  busy,
  totalBytes,
  draftLabel,
  draftTitle,
  openAssignmentId,
  setOpenAssignmentId,
  expandedId,
  setExpandedId,
  onUpdateItem,
  onRemoveItem,
  onClearAssignments,
  onRemovePending,
}: Props) {
  const headingId = useId();
  if (items.length === 0) return null;

  const assignedCount = items.filter((item) => item.checklistStepId).length;
  const pendingCount = items.filter((item) => !item.uploading && item.uploadProgress < 100).length;

  return (
    <section className="capture-staged" data-capture-staged aria-labelledby={headingId}>
      <header className="capture-staged__head">
        <div>
          <h2 id={headingId} className="capture-staged__title">
            Staged evidence
          </h2>
          <p className="capture-staged__meta">
            {items.length} item{items.length === 1 ? "" : "s"} · {formatFileSize(totalBytes)} ·{" "}
            {items.length - assignedCount} not assigned
          </p>
        </div>
        <span className="capture-staged__draft" aria-live="polite" title={draftTitle} data-capture-draft-state>
          {draftLabel}
        </span>
      </header>

      {!busy && (assignedCount > 0 || pendingCount > 0) ? (
        <div className="capture-staged__bulk" role="toolbar" aria-label="Bulk actions">
          <button
            type="button"
            className="capture-staged__bulk-button"
            disabled={assignedCount === 0}
            onClick={onClearAssignments}
          >
            Clear all assignments ({assignedCount})
          </button>
          <button
            type="button"
            className="capture-staged__bulk-button"
            disabled={pendingCount === 0}
            onClick={onRemovePending}
          >
            Remove items not yet uploaded ({pendingCount})
          </button>
        </div>
      ) : null}

      <div className="capture-staged__list" role="list" aria-label="Staged evidence">
        {/* Visual column labels for the wide layout only; each row names its
            own controls, so assistive technology does not need them. */}
        <div className="capture-staged__columns" aria-hidden="true">
          <span>Evidence</span>
          <span>Assignment</span>
          <span>Status</span>
          <span />
        </div>

        {items.map((item) => {
          const step = getChecklistStepById(plan, item.checklistStepId);
          const role = step ? getRoleFromChecklistStep(step) : simpleRoleLabel(item.role);
          const status = statusFor(item, plan);
          const Icon = iconFor(item);
          const isOpen = openAssignmentId === item.id;
          const isExpanded = expandedId === item.id;
          const typeLabel = deriveSessionItemTypeLabel(item.mimeType);
          const helper = step
            ? `${step.title} · ${step.purposeLabel}`
            : planMode === "CHECKLIST_REQUIRED"
              ? "Assign this file to a requirement before Review & Sign."
              : "Optional: link this file to a requirement.";
          const listboxId = `${materialRowDomId(item.id)}-assign`;
          const notesId = `${materialRowDomId(item.id)}-notes`;

          return (
            <div
              key={item.id}
              id={materialRowDomId(item.id)}
              className={`capture-staged__item ${isExpanded ? "is-expanded" : ""} ${isOpen ? "is-assigning" : ""}`}
              data-capture-staged-item
              data-capture-item-status={status.tone}
              role="listitem"
              tabIndex={-1}
            >
              <div className="capture-staged__evidence">
                <span className="capture-staged__thumb" aria-hidden="true">
                  {item.previewUrl && item.mimeType.startsWith("image/") ? (
                    <img src={item.previewUrl} alt="" />
                  ) : item.previewUrl && item.mimeType.startsWith("video/") ? (
                    <video src={item.previewUrl} muted playsInline preload="metadata" />
                  ) : (
                    <Icon size={20} strokeWidth={2} />
                  )}
                </span>
                <span className="capture-staged__name-block">
                  <span className="capture-staged__name" title={item.relativePath ?? item.file.name}>
                    {item.file.name}
                  </span>
                  <span className="capture-staged__facts">
                    {typeLabel} · {formatFileSize(item.file.size)}
                    {item.relativePath ? " · from folder" : ""}
                  </span>
                </span>
              </div>

              <div className="capture-staged__assign">
                <div className={`capture-material-dropdown capture-staged__dropdown ${isOpen ? "is-open" : ""}`}>
                  <button
                    type="button"
                    className="capture-staged__assign-trigger"
                    disabled={busy}
                    aria-haspopup="listbox"
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? listboxId : undefined}
                    aria-label={`Assignment for ${item.file.name}: ${step ? `${role}, ${step.title}` : "not assigned"}`}
                    data-capture-assign-trigger
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenAssignmentId((current) => (current === item.id ? null : item.id));
                    }}
                  >
                    <span className="capture-staged__assign-text">
                      <strong>{step ? step.title : "Not assigned"}</strong>
                      <small>{step ? `${role} evidence` : `${role} · choose a requirement`}</small>
                    </span>
                    <ChevronDown size={15} aria-hidden="true" />
                  </button>

                  {isOpen ? (
                    <div className="capture-material-dropdown-menu capture-staged__menu" role="listbox" id={listboxId}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={!item.checklistStepId}
                        className={!item.checklistStepId ? "active" : ""}
                        onClick={() => {
                          onUpdateItem(item.id, { checklistStepId: null, role: "Context / supplemental" });
                          setOpenAssignmentId(null);
                        }}
                      >
                        <span>Not assigned</span>
                        <small>Keep as supporting context</small>
                      </button>
                      {plan?.steps.map((option) => {
                        const active = item.checklistStepId === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={active ? "active" : ""}
                            onClick={() => {
                              onUpdateItem(item.id, {
                                checklistStepId: option.id,
                                role: `${getRoleFromChecklistStep(option)} evidence`,
                              });
                              setOpenAssignmentId(null);
                            }}
                          >
                            <span>
                              {option.title} · {getRoleFromChecklistStep(option)}
                            </span>
                            <small>
                              {option.required
                                ? planMode === "CHECKLIST_REQUIRED"
                                  ? "Required"
                                  : "Recommended"
                                : "Optional"}{" "}
                              ·{" "}
                              {option.acceptedKinds?.map(formatEvidenceTypeLabel).join(", ") ||
                                "Any supported material"}
                            </small>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="capture-staged__status">
                <span className={`capture-staged__badge is-${status.tone}`} title={status.detail}>
                  {status.label}
                </span>
              </div>

              <div className="capture-staged__actions">
                <button
                  type="button"
                  className="capture-staged__action"
                  aria-expanded={isExpanded}
                  aria-controls={notesId}
                  aria-label={`${isExpanded ? "Hide" : "Show"} notes and details for ${item.file.name}`}
                  onClick={() => setExpandedId((current) => (current === item.id ? null : item.id))}
                >
                  <NotebookPen size={15} aria-hidden="true" />
                  <span>{isExpanded ? "Close" : "Notes"}</span>
                </button>
                {!busy ? (
                  <button
                    type="button"
                    className="capture-staged__action is-danger"
                    aria-label={`Remove ${item.file.name}`}
                    onClick={() => onRemoveItem(item.id)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                    <span>Remove</span>
                  </button>
                ) : null}
              </div>

              {isExpanded ? (
                <div className="capture-staged__details" id={notesId}>
                  <p className="capture-staged__fullname">
                    <span>File</span> {item.relativePath ?? item.file.name}
                  </p>
                  <p className="capture-staged__helper">
                    {helper} {status.tone !== "success" ? `· ${status.detail}` : ""}
                  </p>
                  {/* "Your notes" (was "Reviewer note"); field privateNote. */}
                  <label className="capture-staged__field-label" htmlFor={`${notesId}-note`}>
                    Your notes <span>(private to you)</span>
                  </label>
                  <textarea
                    id={`${notesId}-note`}
                    value={item.privateNote ?? ""}
                    onChange={(event) => onUpdateItem(item.id, { privateNote: event.target.value })}
                    disabled={busy}
                    placeholder="Add a note about this material."
                    maxLength={1000}
                    className="capture-material-note"
                  />
                  {/* Item-level source label: persisted to EvidencePart.sourceLabel
                      (VarChar(120)); distinct from the private note. */}
                  <label className="capture-staged__field-label" htmlFor={`${notesId}-source`}>
                    Source <span>(optional)</span>
                  </label>
                  <input
                    id={`${notesId}-source`}
                    type="text"
                    className="capture-staged__input"
                    data-capture-item-source-label
                    value={item.sourceLabel ?? ""}
                    onChange={(event) => onUpdateItem(item.id, { sourceLabel: event.target.value })}
                    disabled={busy}
                    placeholder="e.g. Phone camera, on-site"
                    maxLength={120}
                  />
                  <p className="capture-staged__hint">
                    Shown on the evidence record as the item&apos;s source context. Not included in the public
                    verification page or report.
                  </p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default CaptureMaterialsList;
