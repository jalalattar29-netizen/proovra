"use client";

/**
 * Operations workbench — ownership.
 *
 * ---------------------------------------------------------------------------
 * ONE ASSIGNMENT AUTHORITY
 * ---------------------------------------------------------------------------
 * This writes through `POST /v1/ops/incidents/:id/assign` and nothing else.
 * The eligible set comes from `GET /v1/ops/assignable-operators`, which is the
 * SAME resolver the mutation re-runs server-side — so the people offered here
 * and the people the server will accept cannot drift apart. There is no local
 * notion of who may own work.
 *
 * Assignment is never applied optimistically. The server re-checks eligibility
 * (ACTIVE membership, unexpired access, operational permission tier) and can
 * refuse; a queue that shows an owner the backend rejected is the worst
 * possible outcome on a surface whose job is telling you who has what.
 *
 * ---------------------------------------------------------------------------
 * THE CONTROL IS A LISTBOX, NOT A `<select>`
 * ---------------------------------------------------------------------------
 * The previous implementation used a native `<select>` on the grounds that it
 * is keyboard- and screen-reader-operable for free. So is `AppListbox`, which
 * is the audited control the rest of this route and every other redesigned
 * surface uses — and unlike the native popup it can be styled to match, and it
 * escapes the drawer's clipping context through a portal.
 */

import * as React from "react";

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import type { AssignableOperator } from "../_lib/types";
import type { OwnerDisplay } from "../_lib/rowModel";

const UNASSIGNED = "__unassigned__";

export function operatorLabel(o: AssignableOperator): string {
  return o.displayName?.trim() || o.email?.trim() || o.userId.slice(0, 8);
}

export function AssignmentControl({
  incidentId,
  assignedOperatorUserId,
  ownerDisplay,
  canAssign,
  operators,
  selfUserId,
  busy,
  onAssign,
}: {
  incidentId: string;
  assignedOperatorUserId: string | null;
  /** The resolved display, so read-only mode says a name and not an id. */
  ownerDisplay: OwnerDisplay;
  /** Resolved server-side. Presentation only — the server re-checks. */
  canAssign: boolean;
  operators: ReadonlyArray<AssignableOperator>;
  selfUserId: string | null;
  busy: boolean;
  /** null means UNASSIGN — one transition on one column, one code path. */
  onAssign: (assigneeUserId: string | null) => void;
}) {
  const labelId = React.useId();

  // -------------------------------------------------------------------
  // READ-ONLY. A viewer may see WHO owns a condition — that is part of
  // understanding the workspace — and may not change it.
  // -------------------------------------------------------------------
  if (!canAssign) {
    return (
      <p
        className="opsw-owner-readonly"
        data-ops-assignee-readonly
        data-assigned={assignedOperatorUserId ? "true" : "false"}
      >
        <span className="opsw-owner-readonly__label">Owner</span>{" "}
        <span>
          {ownerDisplay.kind === "unassigned" ? "Unassigned" : ownerDisplay.label}
        </span>
      </p>
    );
  }

  const options = [
    { value: UNASSIGNED, label: "Unassigned" },
    ...operators.map((o) => ({
      value: o.userId,
      label: operatorLabel(o),
      description: o.role,
    })),
  ];

  return (
    <div className="opsw-assign" data-ops-assignment-control={incidentId}>
      <span className="app-field-label" id={labelId}>
        Owner
      </span>
      <div className="opsw-assign__row">
        <AppListbox
          value={assignedOperatorUserId ?? UNASSIGNED}
          options={options}
          ariaLabelledby={labelId}
          disabled={busy}
          onChange={(v) => onAssign(v === UNASSIGNED ? null : v)}
        />
        {/* Self-assign is the most common action on a triage surface and
            deserves one press rather than a search through a list. Hidden
            when the caller already owns it, because a button that does
            nothing is worse than an absent one. */}
        {selfUserId && assignedOperatorUserId !== selfUserId ? (
          <button
            type="button"
            className="app-secondary-action"
            disabled={busy}
            onClick={() => onAssign(selfUserId)}
            data-ops-action="self-assign"
          >
            Take it
          </button>
        ) : null}
      </div>
      {operators.length === 0 ? (
        <p className="opsw-muted" data-ops-assignment-empty="true">
          Nobody else in this workspace can take operational work yet.
        </p>
      ) : null}
    </div>
  );
}

export default AssignmentControl;
