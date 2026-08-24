"use client";

/**
 * Operations workbench — the incident surface.
 *
 * TWO renderers, ONE model. `buildRowModel` decides every label, tone,
 * relative age and action-eligibility once; the wide table and the narrow
 * cards read the result. Exactly one of them is in the layout AND in the
 * accessibility tree at any width, because the other is `display: none`.
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE AND NOT A LIST OF PANELS
 * ---------------------------------------------------------------------------
 * The production console rendered each condition as a full-width block of
 * prose: title, then the safe summary, then a run-on line of "first … last …
 * runbook … req 4f2a…". Nothing lined up between rows, so comparing severity
 * or age across a queue meant reading every block. A queue is scanned down
 * columns, not read across paragraphs.
 *
 * ---------------------------------------------------------------------------
 * SELECTION IS TWO DIFFERENT GESTURES
 * ---------------------------------------------------------------------------
 * Clicking a row OPENS it in the inspector. The checkbox marks it for a bulk
 * action. Conflating them — as a single "selected" state — means an operator
 * who wanted to read one condition has silently armed a bulk toolbar over it.
 */

import * as React from "react";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import { formatUserDateTime } from "../../../../lib/date";
import { describeRelativeTime } from "../../../../lib/relative-time";
import type { OperationsRowModel } from "../_lib/rowModel";
import {
  AppRowMenu,
  type AppRowAction,
} from "../../../../components/app-primitives/AppRowMenu";
import { IconDots, IconSpinner } from "./icons";

export type SurfaceHandlers = {
  onOpen: (incidentId: string) => void;
  onAcknowledge: (incidentId: string) => void;
  onResolve: (incidentId: string) => void;
  onSuppress: (incidentId: string) => void;
  onAssign: (incidentId: string) => void;
  onToggleMark: (incidentId: string) => void;
  /** The condition whose mutation is in flight, if any. */
  pendingId: string | null;
};

function buildActions(
  row: OperationsRowModel,
  handlers: SurfaceHandlers,
): ReadonlyArray<AppRowAction> {
  const pending = handlers.pendingId === row.id;

  // ==========================================================================
  // A MENU IS FOR THINGS THE TITLE CANNOT DO.
  //
  // "Open details" is a convenience INSIDE the menu, never a reason for the
  // menu to exist: the condition title is already a button that opens the
  // inspector. A read-only viewer, whose only available action is opening
  // something they can open by clicking it, therefore gets no menu at all —
  // rather than a trigger that reveals one item duplicating the affordance
  // beside it.
  //
  // So the mutations are collected FIRST, and the open item is prepended only
  // if any of them survived the capability and state checks.
  // ==========================================================================
  const actions: AppRowAction[] = [];
  if (row.canAssign) {
    actions.push({
      key: "assign",
      label: "Change owner",
      pending,
      onSelect: () => handlers.onAssign(row.id),
    });
  }
  if (row.canAcknowledge) {
    actions.push({
      key: "acknowledge",
      label: "Acknowledge",
      pending,
      onSelect: () => handlers.onAcknowledge(row.id),
    });
  }
  if (row.canResolve) {
    actions.push({
      key: "resolve",
      label: "Resolve",
      pending,
      onSelect: () => handlers.onResolve(row.id),
    });
  }
  if (row.canSuppress) {
    actions.push({
      key: "suppress",
      label: "Stop notifying about this",
      danger: true,
      separated: true,
      pending,
      onSelect: () => handlers.onSuppress(row.id),
    });
  }
  if (actions.length === 0) return actions;
  return [
    {
      key: "open",
      label: "Open details",
      onSelect: () => handlers.onOpen(row.id),
    },
    ...actions,
  ];
}

// ---------------------------------------------------------------------------
// Shared cell fragments — rendered identically by the table and the cards.
// ---------------------------------------------------------------------------

function SeverityBadge({ row }: { row: OperationsRowModel }) {
  return (
    <AppStatusBadge
      tone={row.severityTone}
      fill="solid"
      title={row.severityExplanation}
      data-ops-severity={row.severityValue}
    >
      {row.severityLabel}
    </AppStatusBadge>
  );
}

function StatusBadge({ row }: { row: OperationsRowModel }) {
  return (
    <AppStatusBadge
      tone={row.statusTone}
      title={row.statusExplanation}
      data-ops-status={row.statusValue}
    >
      {row.statusLabel}
    </AppStatusBadge>
  );
}

/**
 * The owner cell.
 *
 * "Unassigned" is a WORD, not an empty cell. A blank there reads as missing
 * data on a surface where the whole point of the column is to distinguish work
 * somebody has from work nobody has.
 */
function Owner({ row }: { row: OperationsRowModel }) {
  return (
    <span
      className="opsw-owner"
      data-ops-owner={row.owner.kind}
      data-ops-owner-assigned={row.owner.kind === "unassigned" ? "false" : "true"}
    >
      {row.owner.kind === "unassigned" ? "Unassigned" : row.owner.label}
    </span>
  );
}

function Activity({ row }: { row: OperationsRowModel }) {
  return (
    <span className="opsw-activity">
      <span className="opsw-activity__last" title={formatUserDateTime(row.lastSeenAtUtc)}>
        {describeRelativeTime(row.lastSeenAtUtc)}
      </span>
      {row.occurrenceCount > 1 ? (
        <span className="opsw-activity__count" data-ops-occurrences={row.occurrenceCount}>
          {row.occurrenceCount} occurrences
        </span>
      ) : null}
    </span>
  );
}

/**
 * HOW LONG THIS HAS BEEN OPEN, AND WHETHER THAT IS LATE.
 *
 * TWO different facts, and only one of them is a verdict.
 *
 * The elapsed time is an OBSERVATION and is always shown: it is how long the
 * condition has existed, and nothing judges it. The SLA badge is a VERDICT
 * against the promise the workspace recorded for this specific condition,
 * and it comes from the server.
 *
 * There is no longer a second "overdue" badge derived from a fixed age
 * threshold. That was a competing authority on lateness — a row could read
 * BREACHED against a four-hour promise while the same page's counter called
 * it fine — and two answers to "is this late?" on one screen is worse than
 * either answer alone, because the operator cannot tell which to act on.
 *
 * Only postures the SERVER classed as needing attention are badged. A
 * condition that is on time, owned, resolved or has no recorded promise gets
 * its elapsed time and nothing else: badging every row would make the badge
 * mean "this is a row" rather than "look at this".
 */
function Age({ row }: { row: OperationsRowModel }) {
  const sla = row.sla;
  return (
    <span className="opsw-age" data-ops-sla={sla?.posture ?? "none"}>
      <span title={formatUserDateTime(row.firstSeenAtUtc)}>
        {describeRelativeTime(row.firstSeenAtUtc)}
      </span>
      {/* Lateness is a WORD as well as a colour, because an operator who
          cannot distinguish the two reds still has to be able to triage. */}
      {sla?.needsAttention ? (
        <AppStatusBadge
          tone={sla.tone}
          title={sla.explanation}
          data-ops-sla-badge={sla.posture}
        >
          {sla.label}
        </AppStatusBadge>
      ) : null}
    </span>
  );
}

/** The condition itself: what happened, to what, from where. */
function Condition({ row }: { row: OperationsRowModel }) {
  return (
    <div className="opsw-condition">
      <span className="app-table__primary opsw-condition__title">{row.title}</span>
      <span className="opsw-condition__meta">
        <span className="opsw-condition__source">{row.categoryLabel}</span>
        {row.affectedLabel ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="opsw-condition__affected">{row.affectedLabel}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function IncidentSurface({
  rows,
  handlers,
  openId,
  markedIds,
  showOwnerColumn,
  showSelection,
}: {
  rows: ReadonlyArray<OperationsRowModel>;
  handlers: SurfaceHandlers;
  /** The condition currently in the inspector, highlighted in the list. */
  openId: string | null;
  markedIds: ReadonlySet<string>;
  showOwnerColumn: boolean;
  showSelection: boolean;
}) {
  return (
    <>
      {/* ---------------------------------------------------------------- */}
      {/* WIDE — the table                                                  */}
      {/* ---------------------------------------------------------------- */}
      <div className="app-table-surface opsw-table-surface" data-ops-table-surface>
        <table className="app-table opsw-table">
          <caption className="app-visually-hidden">
            Operational conditions in this workspace
          </caption>
          <thead>
            <tr>
              {showSelection ? (
                <th scope="col" className="opsw-col-select">
                  <span className="app-visually-hidden">Select</span>
                </th>
              ) : null}
              <th scope="col" className="opsw-col-severity">
                Severity
              </th>
              <th scope="col">Condition</th>
              <th scope="col" className="opsw-col-status">
                Status
              </th>
              {showOwnerColumn ? (
                <th scope="col" className="opsw-col-owner">
                  Owner
                </th>
              ) : null}
              <th scope="col" className="opsw-col-age">
                First seen
              </th>
              <th scope="col" className="opsw-col-activity">
                Latest activity
              </th>
              <th scope="col" className="opsw-col-actions">
                <span className="app-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const actions = buildActions(row, handlers);
              return (
                <tr
                  key={row.id}
                  data-ops-row={row.id}
                  data-ops-row-open={openId === row.id ? "true" : "false"}
                  data-ops-row-marked={markedIds.has(row.id) ? "true" : "false"}
                  className="opsw-row"
                >
                  {showSelection ? (
                    <td className="opsw-col-select">
                      <input
                        type="checkbox"
                        className="app-checkbox"
                        checked={markedIds.has(row.id)}
                        onChange={() => handlers.onToggleMark(row.id)}
                        aria-label={`Select ${row.title} for a bulk action`}
                        data-ops-row-mark={row.id}
                      />
                    </td>
                  ) : null}
                  <td className="opsw-col-severity">
                    <SeverityBadge row={row} />
                  </td>
                  <td>
                    {/* The title is the control that opens the inspector.
                        A whole-row click handler would swallow the checkbox
                        and the menu, and would give a keyboard user nothing
                        to tab to. */}
                    <button
                      type="button"
                      className="opsw-open"
                      onClick={() => handlers.onOpen(row.id)}
                      data-ops-open={row.id}
                    >
                      <Condition row={row} />
                    </button>
                  </td>
                  <td className="opsw-col-status">
                    <StatusBadge row={row} />
                  </td>
                  {showOwnerColumn ? (
                    <td className="opsw-col-owner">
                      <Owner row={row} />
                    </td>
                  ) : null}
                  <td className="opsw-col-age">
                    <Age row={row} />
                  </td>
                  <td className="opsw-col-activity">
                    <Activity row={row} />
                  </td>
                  <td className="opsw-col-actions">
                    <AppRowMenu
                      actions={actions}
                      label={`Actions for ${row.title}`}
                      dataPrefix="ops"
                      testId={`ops-row-menu-${row.id}`}
                      triggerLabel="Actions"
                      triggerLabelClassName="opsw-when-wide"
                      icon={<IconDots size={16} />}
                      pendingIcon={<IconSpinner size={14} />}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* NARROW — the cards                                                */}
      {/* ---------------------------------------------------------------- */}
      <ul className="opsw-cards" data-ops-cards>
        {rows.map((row) => {
          const actions = buildActions(row, handlers);
          return (
            <li
              key={row.id}
              className="opsw-card"
              data-ops-card={row.id}
              data-ops-card-open={openId === row.id ? "true" : "false"}
            >
              <div className="opsw-card__head">
                {showSelection ? (
                  <input
                    type="checkbox"
                    className="app-checkbox"
                    checked={markedIds.has(row.id)}
                    onChange={() => handlers.onToggleMark(row.id)}
                    aria-label={`Select ${row.title} for a bulk action`}
                    data-ops-row-mark={row.id}
                  />
                ) : null}
                <SeverityBadge row={row} />
                <StatusBadge row={row} />
              </div>

              <button
                type="button"
                className="opsw-open opsw-card__open"
                onClick={() => handlers.onOpen(row.id)}
                data-ops-open={row.id}
              >
                <Condition row={row} />
              </button>

              <dl className="opsw-card__facts">
                {showOwnerColumn ? (
                  <div className="opsw-card__fact">
                    <dt>Owner</dt>
                    <dd>
                      <Owner row={row} />
                    </dd>
                  </div>
                ) : null}
                <div className="opsw-card__fact">
                  <dt>First seen</dt>
                  <dd>
                    <Age row={row} />
                  </dd>
                </div>
                <div className="opsw-card__fact">
                  <dt>Latest activity</dt>
                  <dd>
                    <Activity row={row} />
                  </dd>
                </div>
              </dl>

              <div className="opsw-card__foot">
                <AppRowMenu
                  actions={actions}
                  label={`Actions for ${row.title}`}
                  dataPrefix="ops"
                  testId={`ops-card-menu-${row.id}`}
                  icon={<IconDots size={16} />}
                  pendingIcon={<IconSpinner size={14} />}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export default IncidentSurface;
