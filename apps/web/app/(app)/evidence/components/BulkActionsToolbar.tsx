import { useMemo, useState } from "react";
import { Modal } from "../../../../components/cases-experience/matter-modals/Modal";
import { AppListbox } from "../../../../components/app-primitives";
import type {
  CaseOption,
  EvidenceBulkAction,
  EvidenceBulkActionResponse,
  EvidenceListItem,
} from "../lib/evidence-library-types";
import { getEvidenceDeletionEligibility } from "../lib/evidence-delete-eligibility";

const ACTION_OPTIONS = [
  { value: "ADD_TO_CASE", label: "Add to Case" },
  { value: "REMOVE_FROM_CASE", label: "Remove from Case" },
  { value: "ARCHIVE", label: "Archive" },
  { value: "RESTORE_ARCHIVED", label: "Restore Archived" },
  { value: "TRASH", label: "Move to Trash" },
  { value: "RESTORE_TRASH", label: "Restore from Trash" },
  { value: "EXPORT_METADATA_CSV", label: "Export Metadata CSV" },
] as const;

export function BulkActionsToolbar({
  selectedCount,
  selectedItems = [],
  availableCases,
  onClear,
  onRun,
}: {
  selectedCount: number;
  /**
   * Phase EVIDENCE-DELETE-ELIGIBILITY — the toolbar uses these to
   * detect retention-protected selections BEFORE the user clicks
   * Move to Trash. Optional for back-compat with any older caller.
   */
  selectedItems?: EvidenceListItem[];
  availableCases: CaseOption[];
  onClear: () => void;
  onRun: (action: EvidenceBulkAction, caseId?: string) => Promise<EvidenceBulkActionResponse>;
}) {
  const [action, setAction] = useState<(typeof ACTION_OPTIONS)[number]["value"]>("ARCHIVE");
  const [caseId, setCaseId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [result, setResult] = useState<EvidenceBulkActionResponse | null>(null);
  const [running, setRunning] = useState(false);

  const needsCase = action === "ADD_TO_CASE";
  const confirmLabel = useMemo(() => {
    const option = ACTION_OPTIONS.find((item) => item.value === action);
    return option?.label ?? action;
  }, [action]);

  // Phase EVIDENCE-DELETE-ELIGIBILITY — count selected records that
  // backend would refuse to trash. Same helper used everywhere else
  // so the categorisation cannot drift across surfaces.
  const protectedSelected = useMemo(() => {
    if (action !== "TRASH") return [];
    return selectedItems
      .map((item) => ({ item, eligibility: getEvidenceDeletionEligibility(item) }))
      .filter(({ eligibility }) => !eligibility.canMoveToTrash);
  }, [action, selectedItems]);
  const protectedCount = protectedSelected.length;
  const eligibleCount = action === "TRASH"
    ? Math.max(0, selectedCount - protectedCount)
    : selectedCount;
  const allSelectedProtected = action === "TRASH" && protectedCount > 0 && eligibleCount === 0;

  const runAction = async () => {
    setRunning(true);
    try {
      const nextResult = await onRun(action, caseId || undefined);
      setResult(nextResult);
      setConfirmOpen(false);
      setResultOpen(true);
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="evidence-library-bulk-toolbar">
        <strong>{selectedCount} selected</strong>
        <AppListbox<(typeof ACTION_OPTIONS)[number]["value"]>
          ariaLabel="Bulk action"
          value={action}
          options={ACTION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          onChange={setAction}
        />
        {needsCase ? (
          <AppListbox
            ariaLabel="Target case"
            value={caseId}
            placeholder="Select case"
            options={availableCases.map((caseOption) => ({ value: caseOption.id, label: caseOption.name }))}
            onChange={setCaseId}
          />
        ) : null}
        {/* SEMANTIC HIERARCHY: the run button is the page primary EXCEPT when
            the chosen action is destructive, where it keeps the canonical
            danger treatment rather than inheriting the accent. */}
        <button
          type="button"
          className={
            action === "TRASH" ? "app-danger-action" : "app-primary-action"
          }
          onClick={() => setConfirmOpen(true)}
          disabled={
            selectedCount === 0 ||
            (needsCase && !caseId) ||
            allSelectedProtected
          }
          title={
            allSelectedProtected
              ? "All selected records are protected by retention or legal hold."
              : undefined
          }
          data-bulk-trash-blocked={allSelectedProtected ? "true" : "false"}
          data-evidence-run-bulk
        >
          Run Bulk Action
        </button>
        <button
          type="button"
          className="app-secondary-action"
          onClick={onClear}
          data-evidence-clear-selection
        >
          Clear Selection
        </button>
      </div>
      {action === "TRASH" && protectedCount > 0 ? (
        <div
          className="app-alert app-alert--warn evidence-library-bulk-helper"
          role="status"
          data-bulk-trash-helper
        >
          <strong>
            {protectedCount} of {selectedCount} selected records cannot be moved to trash
          </strong>
          <p className="app-hint">
            {allSelectedProtected
              ? "All selected records are protected by retention or legal hold. Use Archive instead to remove them from Active evidence without deleting protected records."
              : `${eligibleCount} eligible record${eligibleCount === 1 ? "" : "s"} will be moved to trash; ${protectedCount} protected record${protectedCount === 1 ? "" : "s"} will be skipped.`}
          </p>
        </div>
      ) : null}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm Bulk Action"
        testid="evidence-bulk-confirm"
        footer={
          <>
            <button type="button" className="app-secondary-action" onClick={() => setConfirmOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className={action === "TRASH" ? "app-danger-action" : "app-primary-action"}
              onClick={() => void runAction()}
              disabled={running}
              aria-busy={running}
            >
              {running ? "Running..." : confirmLabel}
            </button>
          </>
        }
      >
        <p>
          {confirmLabel} will run for {selectedCount} currently selected records.
        </p>
        <p className="evidence-library-muted">
          Bulk selection applies only to the records you selected in the currently loaded pages.
        </p>
      </Modal>

      <Modal
        open={resultOpen}
        onClose={() => setResultOpen(false)}
        title="Bulk Action Results"
        testid="evidence-bulk-result"
        footer={
          <button type="button" className="app-secondary-action" onClick={() => setResultOpen(false)}>
            Close
          </button>
        }
      >
        <p>
          {result?.successCount ?? 0} records completed and {result?.failedCount ?? 0} records failed.
        </p>
        {result?.results?.length ? (
          <div className="evidence-library-result-list">
            {result.results.map((item) => (
              <div key={`${item.evidenceId}-${item.ok ? "ok" : "failed"}`} className="evidence-library-result-row">
                <strong className="evidence-library-technical" dir="ltr">{item.evidenceId}</strong>
                <span>{item.ok ? "Completed" : item.reason ?? "Failed"}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
