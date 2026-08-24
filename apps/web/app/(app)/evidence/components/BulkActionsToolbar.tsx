"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  EVIDENCE_BULK_ACTIONS,
  EVIDENCE_BULK_MAX_IDS,
  evidenceBulkActionRequiresCase,
  type EvidenceBulkActionName,
} from "@proovra/shared";
import { Modal } from "../../../../components/cases-experience/matter-modals/Modal";
import { AppListbox } from "../../../../components/app-primitives";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import type {
  CaseOption,
  EvidenceBulkAction,
  EvidenceBulkActionResponse,
  EvidenceListItem,
} from "../lib/evidence-library-types";
import {
  getEvidenceDeletionEligibility,
  getEvidenceLifecycle,
} from "../lib/evidence-delete-eligibility";

/**
 * The toolbar's options are DERIVED from the shared action vocabulary, so a
 * label can never carry an action name the API does not know and the casing
 * cannot drift. Only the operator-facing wording lives here.
 */
const ACTION_LABELS: Record<EvidenceBulkActionName, string> = {
  ADD_TO_CASE: "Add to Case",
  REMOVE_FROM_CASE: "Remove from Case",
  ARCHIVE: "Archive",
  RESTORE_ARCHIVED: "Restore Archived",
  TRASH: "Move to Trash",
  RESTORE_TRASH: "Restore from Trash",
  EXPORT_METADATA_CSV: "Export Metadata CSV",
};

const ACTION_OPTIONS = EVIDENCE_BULK_ACTIONS.map((value) => ({
  value,
  label: ACTION_LABELS[value],
}));

type ActionValue = EvidenceBulkActionName;

/**
 * How each action reads while it is COMMITTING, and what it says AFTERWARDS.
 *
 * The confirm control used to read "Running..." for every action, which told
 * the operator that something generic was happening but not what. The three
 * forms below are the same verb in the three tenses the dialog needs.
 */
const ACTION_VERB: Record<ActionValue, { pending: string; past: string; gerund: string }> = {
  ADD_TO_CASE: { pending: "Adding…", past: "added to the case", gerund: "added" },
  REMOVE_FROM_CASE: { pending: "Removing…", past: "removed from their cases", gerund: "removed" },
  ARCHIVE: { pending: "Archiving…", past: "archived", gerund: "archived" },
  RESTORE_ARCHIVED: { pending: "Restoring…", past: "restored", gerund: "restored" },
  TRASH: { pending: "Moving to trash…", past: "moved to trash", gerund: "moved to trash" },
  RESTORE_TRASH: { pending: "Restoring…", past: "restored", gerund: "restored" },
  EXPORT_METADATA_CSV: { pending: "Exporting…", past: "exported", gerund: "exported" },
};

/**
 * The failure categories this surface may name, and the SERVER codes that map
 * to them.
 *
 * Every category is a projection of what the server actually answered per
 * record (`results[].reason`) — the destructive-action gate's decision code,
 * the lock assertion, or the record-access denial. Nothing is inferred from
 * client state, and an unrecognised reason is reported as an unknown server
 * failure rather than being guessed into one of the known buckets.
 *
 * A record the actor may not reach answers "Evidence not found" by design;
 * it is shown as insufficient permission, which neither confirms nor denies
 * that a record exists in another workspace.
 */
const FAILURE_CATEGORIES: Array<{ key: string; label: string; match: RegExp }> = [
  { key: "retention", label: "Protected by retention", match: /RETENTION/i },
  { key: "legal_hold", label: "Legal hold", match: /LEGAL_HOLD/i },
  { key: "already_archived", label: "Already archived", match: /ALREADY_ARCHIVED/i },
  {
    key: "permission",
    label: "Insufficient permission",
    match: /FORBIDDEN|NOT_PERMITTED|PERMISSION|not found|ADMIN_ONLY/i,
  },
  {
    key: "conflict",
    label: "Record changed since selection",
    match: /LOCKED|CONFLICT|STALE|VERSION|not assigned|deleted evidence/i,
  },
];

export function categoriseBulkFailure(reason: string | undefined | null): {
  key: string;
  label: string;
} {
  const text = reason ?? "";
  const hit = FAILURE_CATEGORIES.find((category) => category.match.test(text));
  return hit ? { key: hit.key, label: hit.label } : { key: "unknown", label: "Unknown server failure" };
}

/**
 * A request the server rejected before executing anything.
 *
 * Bounded to the status/code the API answers with; anything else keeps the
 * canonical mapping in `toSafeUserError`.
 */
function isRequestValidationFailure(error: unknown): boolean {
  const e = (error && typeof error === "object" ? error : {}) as {
    statusCode?: unknown;
    code?: unknown;
  };
  const code = typeof e.code === "string" ? e.code.toUpperCase() : "";
  return e.statusCode === 400 || code === "INVALID_INPUT" || code === "VALIDATION_ERROR";
}

/** `queued`/`accepted` means the work was ACCEPTED, not that it completed. */
function isQueued(result: EvidenceBulkActionResponse): boolean {
  return Boolean(result.queued || result.accepted) && result.successCount === 0 && result.failedCount === 0;
}

export function BulkActionsToolbar({
  selectedCount,
  selectedItems = [],
  availableCases,
  onClear,
  onRun,
  onSelectionResolved,
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
  /**
   * Reports the ids that are still outstanding after a terminal result: empty
   * on total success, the failed ids on a partial one. The selection is only
   * ever narrowed by an ACCEPTED result — a rejected request leaves it alone
   * so the operator can retry exactly what they chose.
   */
  onSelectionResolved?: (remainingIds: string[]) => void;
}) {
  const [action, setAction] = useState<ActionValue>("ARCHIVE");
  const [caseId, setCaseId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<EvidenceBulkActionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const errorRef = useRef<HTMLDivElement | null>(null);

  const needsCase = evidenceBulkActionRequiresCase(action);
  const confirmLabel = ACTION_LABELS[action];
  // The id bound belongs to the contract, so the operator meets it HERE —
  // before submitting — instead of as an opaque 400 from the server.
  const overSelectionLimit = selectedCount > EVIDENCE_BULK_MAX_IDS;
  const verb = ACTION_VERB[action];

  // A failure must be announced, not merely rendered: the operator pressed a
  // control and needs to land on the reason it did not commit.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — availability for EVERY
  // lifecycle bulk action, from the SAME canonical projection the single-record
  // page and the route guard read.
  //
  // Previously only TRASH was checked, so selecting archived records and
  // pressing Archive, or selecting active records and pressing Restore from
  // trash, produced a request that was refused per record and surfaced as a
  // list of failures after the fact. The four actions are one question now, and
  // the toolbar asks the projection rather than guessing from timestamps.
  const protectedSelected = useMemo(() => {
    const capabilityFor = (
      item: (typeof selectedItems)[number],
    ): boolean | null => {
      const lifecycle = getEvidenceLifecycle(item);
      if (!lifecycle) return null;
      switch (action) {
        case "ARCHIVE":
          return lifecycle.canArchive;
        case "RESTORE_ARCHIVED":
          return lifecycle.canUnarchive;
        case "TRASH":
          return lifecycle.canTrash;
        case "RESTORE_TRASH":
          return lifecycle.canRestoreFromTrash;
        default:
          return null;
      }
    };
    return selectedItems
      .map((item) => ({ item, capable: capabilityFor(item) }))
      .filter(({ capable }) => capable === false)
      .map(({ item }) => ({
        item,
        eligibility: getEvidenceDeletionEligibility(item),
      }));
  }, [action, selectedItems]);
  const isLifecycleAction =
    action === "ARCHIVE" ||
    action === "RESTORE_ARCHIVED" ||
    action === "TRASH" ||
    action === "RESTORE_TRASH";
  const protectedCount = protectedSelected.length;
  const eligibleCount = isLifecycleAction
    ? Math.max(0, selectedCount - protectedCount)
    : selectedCount;
  const allSelectedProtected =
    isLifecycleAction && protectedCount > 0 && eligibleCount === 0;

  const failureGroups = useMemo(() => {
    const failed = (result?.results ?? []).filter((item) => !item.ok);
    const groups = new Map<string, { label: string; count: number }>();
    for (const item of failed) {
      const category = categoriseBulkFailure(item.reason);
      const existing = groups.get(category.key);
      if (existing) existing.count += 1;
      else groups.set(category.key, { label: category.label, count: 1 });
    }
    return [...groups.entries()].map(([key, value]) => ({ key, ...value }));
  }, [result]);

  const closeDialog = () => {
    if (running) return;
    setConfirmOpen(false);
    setResult(null);
    setError(null);
  };

  const runAction = async () => {
    // Double-submission protection at the source, not only on the disabled
    // attribute: a second activation while the first is in flight is dropped.
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const nextResult = await onRun(action, caseId || undefined);
      setResult(nextResult);

      const failedIds = (nextResult.results ?? [])
        .filter((item) => !item.ok)
        .map((item) => item.evidenceId);

      if (isQueued(nextResult)) {
        // Accepted, not finished: the dialog stays on the accepted state and
        // the selection is untouched until a terminal outcome exists.
        return;
      }
      if (failedIds.length === 0) {
        // Total success: the summary is the toast the page already raises.
        setConfirmOpen(false);
        setResult(null);
        onSelectionResolved?.([]);
        return;
      }
      // Partial: keep the failed rows selected so they can be retried.
      onSelectionResolved?.(failedIds);
    } catch (runError) {
      // THE PATH THAT WAS MISSING. A rejected request used to escape a
      // `void runAction()` as an unhandled rejection: the dialog sat there
      // unchanged and the operator was told nothing at all.
      //
      // A request the server REFUSED AS INVALID gets its own sentence: the
      // generic "review your input" is meaningless for an action whose only
      // input is a selection the operator cannot edit. Nothing from the
      // server's validation detail is shown — the field is named in the
      // server's own log, not here.
      setError(
        isRequestValidationFailure(runError)
          ? // Named after the action the operator actually chose — "Archive",
            // "Add to Case", "Export Metadata CSV" — never after one action for
            // all of them. The label is used as written rather than
            // lower-cased, which turned multi-word labels into "the add to
            // case request"; when a label is somehow missing, the neutral
            // phrase stands in.
            `The ${confirmLabel || "bulk action"} request was invalid and was not applied. Please retry, or refresh the selected records.`
          : toSafeUserError(runError, {
              message: `${confirmLabel} could not be completed. No records were changed.`,
            }).message,
      );
    } finally {
      setRunning(false);
    }
  };

  const showResult = result !== null;
  const queued = result !== null && isQueued(result);

  return (
    <>
      <div className="evidence-library-bulk-toolbar">
        <strong>{selectedCount} selected</strong>
        <AppListbox<ActionValue>
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
          onClick={() => {
            // An empty selection — or one the contract cannot carry — never
            // opens the dialog.
            if (selectedCount === 0 || overSelectionLimit) return;
            setResult(null);
            setError(null);
            setConfirmOpen(true);
          }}
          disabled={
            selectedCount === 0 ||
            (needsCase && !caseId) ||
            allSelectedProtected ||
            overSelectionLimit
          }
          title={
            allSelectedProtected
              ? "All selected records are protected by retention or legal hold."
              : overSelectionLimit
                ? `A bulk action can carry at most ${EVIDENCE_BULK_MAX_IDS} records.`
                : undefined
          }
          data-bulk-over-limit={overSelectionLimit ? "true" : "false"}
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
      {overSelectionLimit ? (
        <div
          className="app-alert app-alert--warn evidence-library-bulk-helper"
          role="status"
          data-bulk-limit-helper
        >
          <strong>
            {selectedCount} records selected — a bulk action can carry at most{" "}
            {EVIDENCE_BULK_MAX_IDS}
          </strong>
          <p className="app-hint">
            Narrow the selection to {EVIDENCE_BULK_MAX_IDS} records or fewer and run the action
            again. Nothing has been submitted.
          </p>
        </div>
      ) : null}
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

      {/* ONE dialog for the whole action: confirm → committing → result.
          A second "results" modal used to open behind the first, which is why
          a partial outcome could be dismissed without ever being read. */}
      <Modal
        open={confirmOpen}
        onClose={closeDialog}
        title={showResult ? "Bulk Action Results" : "Confirm Bulk Action"}
        testid="evidence-bulk-confirm"
        /* While the request is committing the dialog cannot be dismissed:
           there is no cancellation for a mutation already in flight, and a
           dismissal would hide the outcome of work that is still happening. */
        dismissDisabled={running}
        footer={
          showResult ? (
            <button
              type="button"
              className="app-secondary-action"
              onClick={closeDialog}
              data-bulk-result-close
            >
              Close
            </button>
          ) : (
            <>
              <button
                type="button"
                className="app-secondary-action"
                onClick={closeDialog}
                disabled={running}
              >
                Cancel
              </button>
              <button
                type="button"
                className={action === "TRASH" ? "app-danger-action" : "app-primary-action"}
                onClick={() => void runAction()}
                disabled={running}
                aria-busy={running}
                data-bulk-confirm-submit
              >
                {running ? (
                  <>
                    <Loader2
                      size={15}
                      strokeWidth={2.2}
                      aria-hidden="true"
                      className="app-spinner"
                    />
                    {verb.pending}
                  </>
                ) : (
                  confirmLabel
                )}
              </button>
            </>
          )
        }
      >
        {showResult ? (
          <div className="evidence-library-bulk-result" data-bulk-result-summary>
            {queued ? (
              <>
                <strong data-bulk-result-accepted>
                  {result?.pendingCount ?? selectedCount} records accepted and queued
                </strong>
                <p className="evidence-library-muted">
                  The workspace is processing them. This list updates when the run reports a
                  terminal outcome.
                </p>
              </>
            ) : (
              <>
                <strong data-bulk-result-succeeded>
                  {result?.successCount ?? 0} record{result?.successCount === 1 ? "" : "s"}{" "}
                  {verb.past}
                </strong>
                {result && result.failedCount > 0 ? (
                  <>
                    <strong data-bulk-result-failed>
                      {result.failedCount} record{result.failedCount === 1 ? "" : "s"} could not be{" "}
                      {verb.gerund}
                    </strong>
                    <ul className="evidence-library-bulk-reasons" data-bulk-result-reasons>
                      {failureGroups.map((group) => (
                        <li key={group.key} data-bulk-result-reason={group.key}>
                          <span>{group.label}</span>
                          <span className="evidence-library-muted">
                            {group.count} record{group.count === 1 ? "" : "s"}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="evidence-library-muted">
                      The records that could not be {verb.gerund} are still selected.
                    </p>
                  </>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <>
            <p>
              {confirmLabel} will run for {selectedCount} currently selected records.
            </p>
            <p className="evidence-library-muted">
              Bulk selection applies only to the records you selected in the currently loaded pages.
            </p>
            {error ? (
              <div
                className="app-alert app-alert--danger evidence-library-bulk-error"
                role="alert"
                tabIndex={-1}
                ref={errorRef}
                data-bulk-error
              >
                {error}
              </div>
            ) : null}
          </>
        )}
      </Modal>
    </>
  );
}
