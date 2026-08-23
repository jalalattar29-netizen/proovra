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
 * The two actions offered are the two the bulk runner supports for INCIDENTS
 * (`BULK_ACKNOWLEDGE_INCIDENTS`, `BULK_SUPPRESS_INCIDENTS`). Its other action
 * types operate on operational WORKFLOWS, which are a different authority with
 * a different lifecycle and are not what this queue lists — offering them here
 * would send workflow verbs at incident ids.
 */

import * as React from "react";

import type { OperationsCapabilities } from "../_lib/types";

export function BulkToolbar({
  count,
  capabilities,
  busy,
  onAcknowledge,
  onSuppress,
  onClear,
}: {
  count: number;
  capabilities: OperationsCapabilities;
  busy: boolean;
  onAcknowledge: () => void;
  onSuppress: () => void;
  onClear: () => void;
}) {
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
        <button
          type="button"
          className="app-ghost-action"
          onClick={onClear}
          data-ops-bulk-clear
        >
          Clear selection
        </button>
      </div>
    </div>
  );
}

export default BulkToolbar;
