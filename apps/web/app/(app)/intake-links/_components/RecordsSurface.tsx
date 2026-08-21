"use client";

/**
 * Intake links — the records surface.
 *
 * TWO renderers, ONE model. `buildRowModel` decides every label, tone and
 * action-eligibility once; the wide table and the narrow cards read the result.
 * Exactly one of them is in the layout AND in the accessibility tree at any
 * width, because the other is `display: none` (see `intake-links.css`).
 *
 * Lifecycle and activity are SEPARATE regions with explicit labels. The old
 * surface stacked an "Archived" chip on top of a "Submitted" chip in one cell
 * and let the browser run them together; here the lifecycle answers "can this
 * still accept submissions?", the activity answers "what have contributors
 * done?", and the delivery line answers "what did the provider do?".
 */

import * as React from "react";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import type { IntakeLinkListItem } from "../_lib/types";
import { buildRowModel, type IntakeRowModel } from "../_lib/rowModel";
import { DeliveryChannelIcon } from "./icons";
import { RowActionsMenu, type RowAction } from "./RowActionsMenu";

export type RecordsHandlers = {
  onOpenDetails: (linkId: string) => void;
  onOpenDelivery: (linkId: string) => void;
  onOpenSubmissions: (linkId: string) => void;
  onDisable: (linkId: string) => void;
  onArchive: (linkId: string, archived: boolean) => void;
  /** Link id currently committing an archive/unarchive, if any. */
  pendingArchiveId: string | null;
};

const CHANNEL_ICON: Record<string, "link" | "mail" | "sms" | "whatsapp"> = {
  EMAIL: "mail",
  SMS: "sms",
  WHATSAPP: "whatsapp",
  MANUAL: "link",
};

function buildActions(
  row: IntakeRowModel,
  handlers: RecordsHandlers,
): ReadonlyArray<RowAction> {
  const pending = handlers.pendingArchiveId === row.id;
  const actions: RowAction[] = [
    {
      key: "details",
      label: "View details",
      onSelect: () => handlers.onOpenDetails(row.id),
    },
    {
      key: "delivery",
      label: "Delivery history",
      onSelect: () => handlers.onOpenDelivery(row.id),
    },
  ];
  if (row.hasSessions) {
    actions.push({
      key: "submissions",
      label: "View submissions",
      onSelect: () => handlers.onOpenSubmissions(row.id),
    });
  }
  actions.push({
    key: row.canUnarchive ? "unarchive" : "archive",
    label: row.canUnarchive ? "Restore from archive" : "Archive",
    separated: true,
    pending,
    onSelect: () => handlers.onArchive(row.id, row.canUnarchive),
  });
  if (row.canDisable) {
    actions.push({
      key: "revoke",
      label: "Disable link",
      danger: true,
      onSelect: () => handlers.onDisable(row.id),
    });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Shared cell fragments — rendered identically by the table and the cards.
// ---------------------------------------------------------------------------

/**
 * The lifecycle chip. It has exactly ONE home in each renderer — its own
 * column in the table, the card head on narrow widths — so the operator never
 * reads the same state twice in one record.
 */
function LifecycleBadge({ row }: { row: IntakeRowModel }) {
  return (
    <AppStatusBadge
      tone={row.lifecycleVocab.tone}
      fill="solid"
      title={row.lifecycleVocab.explanation}
      data-intake-links-row-link-state={row.lifecycle}
    >
      {row.lifecycleVocab.label}
    </AppStatusBadge>
  );
}

/**
 * Delivery and Activity — and deliberately NOTHING else.
 *
 * Lifecycle sits in its own adjacent column and used to be restated here with
 * a visible "Lifecycle:" key, which meant a wide row showed the same state in
 * two places a few pixels apart. Both values are labelled in the cell rather
 * than relying on the column header alone, because "Delivered / Submitted"
 * stacked without keys reads as one status with two words.
 *
 * NEUTRAL TEXT, NOT BADGES.
 *
 * These two are supporting facts about a request, read after the operator has
 * found the row they want. Filling them made a row carry three saturated
 * rectangles, which is a colour vocabulary competing with itself: the eye had
 * no way to tell that the Lifecycle chip is the record's state and these two
 * are details of it. Lifecycle keeps the fill because it is the one state the
 * row is scanned by. The wording, the vocabulary authority, the machine-
 * readable axis probes and the unknown-value fallbacks are all unchanged —
 * only the treatment is.
 */
function StatusCluster({ row }: { row: IntakeRowModel }) {
  return (
    <dl className="ilk-status">
      <div className="ilk-status__line">
        <dt className="ilk-status__key">Delivery</dt>
        <dd
          className="ilk-status__value"
          data-intake-links-row-delivery={row.delivery}
          title={row.deliveryVocab.explanation}
        >
          {row.deliveryVocab.label}
        </dd>
      </div>
      <div className="ilk-status__line">
        <dt className="ilk-status__key">Activity</dt>
        <dd
          className="ilk-status__value"
          data-intake-links-row-session-state={row.activity}
          title={row.activityVocab.explanation}
        >
          {row.activityVocab.label}
        </dd>
      </div>
      {row.deliveryDetail ? (
        <div className="ilk-status__line">
          <dt className="app-visually-hidden">Delivery detail</dt>
          <dd
            className="ilk-status__detail"
            data-intake-links-row-delivery-detail
          >
            {row.deliveryDetail}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * The DATE, and only the date.
 *
 * The word "Expired" belongs to the Lifecycle column, which is one cell away.
 * Printing it here too made the row state its own status twice — and made a
 * column that only ever needs to hold a date carry a phrase that fragmented
 * when it did not fit. Assistive technology still hears the relationship,
 * because the visually-hidden prefix names it, and the full local timestamp
 * stays one hover away.
 */
function ExpiryCell({ row }: { row: IntakeRowModel }) {
  return (
    <span
      className="ilk-expiry"
      data-state={row.expiryState}
      data-intake-links-row-expires={row.expiryState}
      title={row.expiryAbsolute}
    >
      <span className="app-visually-hidden">
        {row.expiryState === "expired" ? "Expired on " : "Expires on "}
      </span>
      <span className="ilk-expiry__date" data-intake-links-row-expiry-date>
        {row.expiryDate}
      </span>
    </span>
  );
}

function SubmissionsCell({
  row,
  onOpenSubmissions,
}: {
  row: IntakeRowModel;
  onOpenSubmissions: (id: string) => void;
}) {
  if (row.submissionsAction === "view") {
    return (
      <button
        type="button"
        className="app-secondary-action"
        onClick={() => onOpenSubmissions(row.id)}
        // The accessible name is the FULL phrase at every width; only the
        // visible text shortens, because at 768px a 150px button does not fit
        // a 120px column and pushed itself into the actions cell.
        aria-label={row.submissionsLabel}
        data-intake-links-row-submissions
      >
        <span className="ilk-when-wide">{row.submissionsLabel}</span>
        <span className="ilk-fold" data-fold="short">
          View ({row.submissionsCount})
        </span>
      </button>
    );
  }
  return (
    <span className="app-table__muted" data-intake-links-row-submissions-empty>
      {row.submissionsLabel}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Wide layout — the management table
// ---------------------------------------------------------------------------

function TableRow({
  row,
  handlers,
}: {
  row: IntakeRowModel;
  handlers: RecordsHandlers;
}) {
  return (
    <tr
      data-intake-links-row
      data-intake-links-row-id={row.id}
      data-intake-links-row-archived={row.archived ? "true" : "false"}
      data-intake-links-row-lifecycle={row.computedLifecycle}
    >
      <td data-col="request">
        <button
          type="button"
          className="ilk-row__title"
          onClick={() => handlers.onOpenDetails(row.id)}
          aria-label={`Open details for ${row.requestName}`}
          data-intake-links-row-open-details
        >
          {row.requestName}
        </button>
        <p className="ilk-row__sub">
          {row.modeLabel}
          <span className="ilk-fold" data-fold="channel">
            {" · "}
            {row.channelLabel}
          </span>
        </p>
      </td>
      <td data-col="recipient">
        <span className="ilk-ltr">{row.recipientText}</span>
      </td>
      <td data-col="channel">
        <span className="app-chip">
          <DeliveryChannelIcon icon={CHANNEL_ICON[row.channelWire] ?? "link"} size={14} />
          <span>{row.channelLabel}</span>
        </span>
      </td>
      <td data-col="lifecycle">
        <LifecycleBadge row={row} />
      </td>
      <td data-col="status">
        <StatusCluster row={row} />
      </td>
      <td data-col="latest">
        <span className="ilk-relative" title={row.latestActivityAbsolute}>
          {row.latestActivityRelative}
        </span>
      </td>
      <td data-col="expires">
        <ExpiryCell row={row} />
      </td>
      <td data-col="submissions">
        <SubmissionsCell row={row} onOpenSubmissions={handlers.onOpenSubmissions} />
      </td>
      <td data-col="actions">
        <RowActionsMenu
          label={`Actions for ${row.requestName}`}
          actions={buildActions(row, handlers)}
        />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Narrow layout — purpose-built cards
// ---------------------------------------------------------------------------

function RecordCard({
  row,
  handlers,
}: {
  row: IntakeRowModel;
  handlers: RecordsHandlers;
}) {
  return (
    <li
      className="ilk-card"
      data-intake-links-card
      data-intake-links-card-id={row.id}
      data-intake-links-card-lifecycle={row.computedLifecycle}
    >
      <div className="ilk-card__head">
        <div className="ilk-card__heading">
          <button
            type="button"
            className="ilk-row__title"
            onClick={() => handlers.onOpenDetails(row.id)}
            aria-label={`Open details for ${row.requestName}`}
          >
            {row.requestName}
          </button>
          <p className="ilk-row__sub">
            {row.modeLabel} · {row.channelLabel}
          </p>
        </div>
        <LifecycleBadge row={row} />
      </div>

      {/* Lifecycle is in the head above; Delivery and Activity are two more
          separate, labelled facts here. Three concepts, three regions — the
          card never merges them any more than the table does. */}
      <dl className="ilk-card__facts">
        <dt>Recipient</dt>
        <dd className="ilk-ltr">{row.recipientText}</dd>
        <dt>Delivery</dt>
        {/* Neutral text, exactly as the table cell renders it — the card is a
            second renderer of one row model, not a second design. Can carry a
            provider code and an English provider sentence; keep each run in
            its own direction so an RTL page does not reorder it. */}
        <dd className="ilk-ltr" data-intake-links-row-delivery={row.delivery}>
          {row.deliveryVocab.label}
          {row.deliveryDetail ? ` ${row.deliveryDetail}` : ""}
        </dd>
        <dt>Activity</dt>
        {/* The card carries the SAME machine-readable axis probes as the table
            row, so a matrix can prove the two renderers agree instead of
            comparing prose. */}
        <dd data-intake-links-row-session-state={row.activity}>
          {row.activityVocab.label}
        </dd>
        <dt>Latest activity</dt>
        <dd>{row.latestActivityRelative}</dd>
        {/* A neutral field name, so the card does not restate the lifecycle
            badge sitting a few lines above it. */}
        <dt>Expiry</dt>
        <dd className="ilk-ltr" data-intake-links-row-expiry-date>
          {row.expiryDate}
        </dd>
      </dl>

      <div className="ilk-card__foot">
        <SubmissionsCell row={row} onOpenSubmissions={handlers.onOpenSubmissions} />
        <RowActionsMenu
          label={`Actions for ${row.requestName}`}
          actions={buildActions(row, handlers)}
        />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export function RecordsSurface({
  items,
  handlers,
  now,
}: {
  items: ReadonlyArray<IntakeLinkListItem>;
  handlers: RecordsHandlers;
  /** Injected in tests so relative times are not clock-flaky. */
  now?: number;
}) {
  const rows = React.useMemo(
    () => items.map((item) => buildRowModel(item, now)),
    [items, now],
  );

  return (
    <>
      {/* `--scroll` is the primitive's opt-in for a table wider than its
          column. Without it `.app-table-surface` clips — and a nine-column
          table in a 1068px frame does not fit, so the Actions column was
          silently cut off between about 1100px and 1380px with no scrollbar to
          reach it. Scrolling inside the surface is what this page promises;
          losing a column is not. */}
      <div
        className="app-table-surface app-table-surface--scroll ilk-records--wide"
        data-intake-links-table-surface
      >
        <table className="app-table ilk-table" data-intake-links-table aria-label="Intake links">
          <colgroup>
            <col data-col="request" />
            <col data-col="recipient" />
            <col data-col="channel" />
            <col data-col="lifecycle" />
            <col data-col="status" />
            <col data-col="latest" />
            <col data-col="expires" />
            <col data-col="submissions" />
            <col data-col="actions" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" data-col="request">Request</th>
              <th scope="col" data-col="recipient">Recipient</th>
              <th scope="col" data-col="channel">Channel</th>
              <th scope="col" data-col="lifecycle">Lifecycle</th>
              <th scope="col" data-col="status">Delivery &amp; activity</th>
              <th scope="col" data-col="latest">Latest activity</th>
              <th scope="col" data-col="expires">Expiration</th>
              <th scope="col" data-col="submissions">Submissions</th>
              <th scope="col" data-col="actions">
                <span className="app-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <TableRow key={row.id} row={row} handlers={handlers} />
            ))}
          </tbody>
        </table>
      </div>

      <ul className="ilk-cards ilk-records--narrow" data-intake-links-cards aria-label="Intake links">
        {rows.map((row) => (
          <RecordCard key={row.id} row={row} handlers={handlers} />
        ))}
      </ul>
    </>
  );
}

export default RecordsSurface;
