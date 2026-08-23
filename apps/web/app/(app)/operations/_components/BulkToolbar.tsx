"use client";

/**
 * Operations workbench — the bulk toolbar.
 *
 * ---------------------------------------------------------------------------
 * IT APPEARS ONLY AFTER A SELECTION
 * ---------------------------------------------------------------------------
 * A permanently-visible bulk bar is a row of controls that do nothing most of
 * the time, and on a surface where the controls close shared work that is
 * worse than clutter. It mounts when the operator has marked something and
 * unmounts when they clear the selection.
 *
 * ---------------------------------------------------------------------------
 * IT IS NOT A PERMISSION BYPASS
 * ---------------------------------------------------------------------------
 * `POST /v1/ops/bulk-actions` selects its permission from the action type, out
 * of the SAME table the single-item routes use, and fans out into the same
 * lifecycle service per target. Acknowledge appears here exactly when the
 * single-row Acknowledge appears, and suppression likewise. There is no
 * "may run bulk actions" capability, because one would be a hole through every
 * individual gate.
 *
 * The actions offered are the ones the bulk runner supports for INCIDENTS
 * (`BULK_ACKNOWLEDGE_INCIDENTS`, `BULK_SUPPRESS_INCIDENTS`,
 * `BULK_ASSIGN_INCIDENTS`). Its other action types operate on operational
 * WORKFLOWS, which are a different authority with a different lifecycle and
 * are not what this queue lists — offering them here would send workflow verbs
 * at incident ids.
 *
 * ---------------------------------------------------------------------------
 * WHAT A SWEEP REPORTS
 * ---------------------------------------------------------------------------
 * The runner answers PER TARGET, and this bar preserves that: a sweep where
 * some conditions moved and some did not says so. Collapsing a partial result
 * into one success banner would tell the operator that work is owned when some
 * of it still is not, and collapsing it into one failure banner would send
 * them to re-do work that already landed.
 */

import * as React from "react";

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import type { AssignableOperator, OperationsCapabilities } from "../_lib/types";

export function BulkToolbar({
  count,
  capabilities,
  busy,
  onAcknowledge,
  onSuppress,
  onClear,
  showOwnership,
  operators,
  selfUserId,
  onAssign,
  outcome,
}: {
  count: number;
  capabilities: OperationsCapabilities;
  busy: boolean;
  onAcknowledge: () => void;
  onSuppress: () => void;
  onClear: () => void;
  /**
   * Whether ownership is a real axis in this workspace, server-projected from
   * the count of eligible operators. A solo workspace gets no assignment
   * control, because there is nobody to assign to.
   */
  showOwnership: boolean;
  operators: ReadonlyArray<AssignableOperator>;
  selfUserId: string | null;
  onAssign: (assigneeUserId: string) => void;
  /** The PER-TARGET result of the last sweep, or null. */
  outcome: string | null;
}) {
  const [assignee, setAssignee] = React.useState("");
  // A selection change invalidates the previous sweep's answer: leaving it on
  // screen would attach a count to a set of conditions it never described.
  React.useEffect(() => setAssignee(""), [count]);

  const canAssign = showOwnership && capabilities.canAssign && operators.length > 0;

  if (count === 0) return null;
  return (
    <div
      className="opsw-bulk"
      role="region"
      aria-label="Actions for the selected conditions"
      data-ops-bulk-toolbar
      data-ops-bulk-count={count}
    >
      <p className="opsw-bulk__count" role="status">
        {count === 1 ? "1 condition selected" : `${count} conditions selected`}
      </p>
      <div className="opsw-bulk__actions">
        {capabilities.canAcknowledge ? (
          <button
            type="button"
            className="app-secondary-action"
            disabled={busy}
            onClick={onAcknowledge}
            data-ops-bulk-action="acknowledge"
          >
            Acknowledge
          </button>
        ) : null}
        {capabilities.canSuppress ? (
          <button
            type="button"
            className="app-secondary-action app-secondary-action--danger"
            disabled={busy}
            onClick={onSuppress}
            data-ops-bulk-action="suppress"
          >
            Stop notifying
          </button>
        ) : null}
        {canAssign ? (
          <div className="opsw-bulk__assign">
            <AppListbox
              value={assignee}
              onChange={(next) => {
                setAssignee(next);
                // Assigning is not destructive and is trivially reversible by
                // assigning again, so it commits on choice rather than behind
                // a second "Apply" the operator has to find.
                if (next) onAssign(next);
              }}
              disabled={busy}
              aria-label="Assign the selected conditions to"
              options={[
                { value: "", label: "Assign to…" },
                ...(selfUserId
                  ? [{ value: selfUserId, label: "Me" }]
                  : []),
                ...operators
                  .filter((o) => o.userId !== selfUserId)
                  .map((o) => ({
                    value: o.userId,
                    label:
                      o.displayName?.trim() ||
                      o.email?.trim() ||
                      o.userId.slice(0, 8),
                  })),
              ]}
              data-ops-bulk-assign
            />
          </div>
        ) : null}
        <button
          type="button"
          className="app-ghost-action"
          onClick={onClear}
          data-ops-bulk-clear
        >
          Clear selection
        </button>
      </div>
      {outcome ? (
        <p
          className="opsw-bulk__outcome"
          role="status"
          aria-live="polite"
          data-ops-bulk-outcome
        >
          {outcome}
        </p>
      ) : null}
    </div>
  );
}

export default BulkToolbar;
