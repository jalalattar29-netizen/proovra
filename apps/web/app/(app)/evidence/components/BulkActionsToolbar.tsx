import { useMemo, useState } from "react";
import { Button, Modal } from "../../../../components/ui";
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
        <select value={action} onChange={(event) => setAction(event.target.value as typeof action)}>
          {ACTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {needsCase ? (
          <select value={caseId} onChange={(event) => setCaseId(event.target.value)}>
            <option value="">Select case</option>
            {availableCases.map((caseOption) => (
              <option key={caseOption.id} value={caseOption.id}>
                {caseOption.name}
              </option>
            ))}
          </select>
        ) : null}
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={
            selectedCount === 0 ||
            (needsCase && !caseId) ||
            allSelectedProtected
          }
          data-bulk-trash-blocked={allSelectedProtected ? "true" : "false"}
        >
          Run Bulk Action
        </Button>
        <Button variant="secondary" onClick={onClear}>
          Clear Selection
        </Button>
      </div>
      {action === "TRASH" && protectedCount > 0 ? (
        <div
          className="evidence-library-bulk-helper"
          data-bulk-trash-helper
          style={{
            marginTop: 8,
            padding: "8px 12px",
            border: "1px solid rgba(15, 23, 42, 0.12)",
            borderRadius: 6,
            background: "#fff7ed",
          }}
        >
          <strong>
            {protectedCount} of {selectedCount} selected records cannot be moved to trash
          </strong>
          <p style={{ margin: "4px 0 0 0" }}>
            {allSelectedProtected
              ? "All selected records are protected by retention or legal hold. Use Archive instead to remove them from Active evidence without deleting protected records."
              : `${eligibleCount} eligible record${eligibleCount === 1 ? "" : "s"} will be moved to trash; ${protectedCount} protected record${protectedCount === 1 ? "" : "s"} will be skipped.`}
          </p>
        </div>
      ) : null}

      <Modal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm Bulk Action"
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void runAction()} disabled={running}>
              {running ? "Running..." : confirmLabel}
            </Button>
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
        isOpen={resultOpen}
        onClose={() => setResultOpen(false)}
        title="Bulk Action Results"
        actions={
          <Button variant="secondary" onClick={() => setResultOpen(false)}>
            Close
          </Button>
        }
      >
        <p>
          {result?.successCount ?? 0} records completed and {result?.failedCount ?? 0} records failed.
        </p>
        {result?.results?.length ? (
          <div className="evidence-library-result-list">
            {result.results.map((item) => (
              <div key={`${item.evidenceId}-${item.ok ? "ok" : "failed"}`} className="evidence-library-result-row">
                <strong>{item.evidenceId}</strong>
                <span>{item.ok ? "Completed" : item.reason ?? "Failed"}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
