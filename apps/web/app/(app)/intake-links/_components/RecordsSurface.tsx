"use client";

/**
 * Intake links — the records surface.
 *
 * TWO renderers, ONE model. `buildRowModel` decides every label, tone and
 * action-eligibility once; the wide table and the narrow cards read the result.
 * Exactly one of them is in the layout AND in the accessibility tree at any
 * width, because the other is `display: none` (see `intake-links.css`).
 *
 * ---------------------------------------------------------------------------
 * SEVEN COLUMNS, NOT TEN
 * ---------------------------------------------------------------------------
 *
 * The table used to give ten facts ten columns at one level of hierarchy:
 * Request, Customer ID, Recipient, Channel, Lifecycle, Delivery & activity,
 * Latest activity, Expiration, Submissions, Actions. Ten peers is not a
 * hierarchy, it is a list, and the columns that paid for it were the ones
 * holding identifiers — a Customer ID in a 10ch column breaks into
 * "1551004 / 55151", which stops being a number you can read.
 *
 * The facts are now grouped by the QUESTION an operator is asking:
 *
 *   Request     what was asked for
 *   Recipient   who it concerns, and under which of your own references
 *   & reference
 *   Delivery    how it was sent, and what the provider did
 *   Status      whether the link still works, and what the contributor did
 *   Timeline    when it last moved, and when it stops working
 *   Submissions what came back
 *   Actions
 *
 * THIS IS GROUPING, NOT MERGING. Every value the ten columns carried is still
 * rendered, still from its own field on the row model, still with its own
 * machine-readable probe. `customerId`, `recipientLabel`, `recipientEmail` and
 * `recipientPhone` remain four independent fields end to end — four separate
 * search arms on the server, four separate lines in the cell. Nothing is
 * concatenated into a display label, and nothing falls back to anything else.
 *
 * The two renderers now share their cells rather than each composing the row
 * from primitives, so a card cannot drift from a row.
 */

import * as React from "react";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import type { IntakeLinkListItem } from "../_lib/types";
import { buildRowModel, type IntakeRowModel } from "../_lib/rowModel";
import { DeliveryChannelIcon, IconDots, IconSpinner } from "./icons";
import {
  AppRowMenu,
  type AppRowAction,
} from "../../../../components/app-primitives/AppRowMenu";

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
): ReadonlyArray<AppRowAction> {
  const pending = handlers.pendingArchiveId === row.id;
  const actions: AppRowAction[] = [
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
// Shared cells — the table and the cards render THESE, not their own markup.
// ---------------------------------------------------------------------------

/** What was asked for: the template, then the mode it was issued in. */
function RequestCell({
  row,
  onOpenDetails,
}: {
  row: IntakeRowModel;
  onOpenDetails: (id: string) => void;
}) {
  return (
    <>
      <button
        type="button"
        className="ilk-row__title"
        onClick={() => onOpenDetails(row.id)}
        aria-label={`Open details for ${row.requestName}`}
        data-intake-links-row-open-details
      >
        {row.requestName}
      </button>
      <p className="ilk-row__sub">{row.modeLabel}</p>
    </>
  );
}

/**
 * WHO THE REQUEST CONCERNS — and under whose reference.
 *
 * Four independent facts in one cell, each on its own line, none standing in
 * for another. The cell used to be two columns and a substitution: a
 * `label ?? email ?? phone` chain that showed only the name when a name
 * existed, beside a Customer ID column narrow enough to hyphenate a number.
 *
 * The hierarchy is deliberate. The NAME is what a person recognises, so it
 * leads in the heading weight. The address and the number are operational
 * metadata — where it went — so they sit under it in the secondary tone. The
 * Customer ID is the ORGANIZATION's own business reference, not a property of
 * the recipient at all, so it is labelled and set apart from the contact
 * block rather than being mistaken for a fourth way of naming the person.
 *
 * Absence omits a line. It does not print a dash, and it never substitutes.
 */
function IdentityCell({ row }: { row: IntakeRowModel }) {
  const maskedEmailTitle = row.recipientContactIsMasked
    ? "Masked — you do not have permission to view the full address"
    : row.recipientEmail ?? undefined;
  const maskedPhoneTitle = row.recipientContactIsMasked
    ? "Masked — you do not have permission to view the full number"
    : undefined;

  return (
    <div className="ilk-identity" data-intake-links-identity>
      {row.recipientIsPlaceholder ? (
        /*
         * A manual Copy link genuinely has nobody to name — the operator sent
         * it themselves. Saying so is a fact; a dash would be a shrug, and
         * inventing a placeholder name would be a lie.
         */
        <span className="ilk-identity__none" data-intake-links-recipient="none">
          <span className="ilk-identity__none-primary">No recipient</span>
          {row.channelWire === "MANUAL" ? (
            <span className="ilk-identity__none-sub">Manual link</span>
          ) : null}
        </span>
      ) : (
        <div className="ilk-identity__who" data-intake-links-recipient="present">
          {row.recipientName ? (
            <span
              className="ilk-identity__name"
              data-intake-links-recipient-name
            >
              {row.recipientName}
            </span>
          ) : null}
          {row.recipientEmail ? (
            /*
             * An address may be long and is the one identifier here that can
             * lose its tail without losing its meaning, so it is the one
             * allowed to truncate. The full value stays on the title, and the
             * text is still selectable and copyable in full.
             */
            <span
              className="ilk-identity__email ilk-ltr"
              data-intake-links-recipient-email
              title={maskedEmailTitle}
            >
              {row.recipientEmail}
            </span>
          ) : null}
          {row.recipientPhone ? (
            <span
              className="ilk-identity__phone ilk-ltr"
              data-intake-links-recipient-phone
              title={maskedPhoneTitle}
            >
              {row.recipientPhone}
            </span>
          ) : null}
        </div>
      )}

      {row.customerId ? (
        <span className="ilk-identity__ref">
          <span className="ilk-identity__ref-key">Customer ID</span>
          <span className="ilk-identity__ref-sep" aria-hidden="true">
            ·
          </span>
          {/*
            The probe stays on the element whose text is the identifier ALONE,
            so a machine reading it gets "CUST-849271" rather than the labelled
            phrase around it.
          */}
          <span
            className="ilk-identity__ref-value ilk-ltr"
            data-intake-links-customer-id
            title={row.customerId}
          >
            {row.customerId}
          </span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * HOW IT WAS SENT, and what the provider did with it.
 *
 * Channel and delivery state were two columns and are one fact in two parts:
 * "SMS · With provider" answers in one read what "SMS" in one column and
 * "Delivery: With provider" three columns later answered in two. The wire
 * values, the tones and the probes are unchanged, and WhatsApp still renders
 * truthfully for the historical rows that carry it even though no new link
 * can be created on it.
 */
function DeliveryCell({ row }: { row: IntakeRowModel }) {
  return (
    <div className="ilk-delivery" data-intake-links-delivery-cell>
      <span className="ilk-delivery__channel">
        <DeliveryChannelIcon
          icon={CHANNEL_ICON[row.channelWire] ?? "link"}
          size={14}
        />
        <span className="ilk-delivery__channel-label">{row.channelLabel}</span>
      </span>
      <span className="ilk-delivery__line">
        <span className="app-visually-hidden">Delivery status: </span>
        <span
          className="ilk-delivery__state ilk-state-text"
          data-ilk-tone={row.deliveryVocab.tone}
          data-intake-links-row-delivery={row.delivery}
          title={row.deliveryVocab.explanation}
        >
          {row.deliveryVocab.label}
        </span>
      </span>
      {row.deliveryDetail ? (
        <span
          className="ilk-delivery__detail"
          data-intake-links-row-delivery-detail
        >
          {row.deliveryDetail}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The lifecycle chip. It has exactly ONE home in each renderer — the Status
 * column in the table, the card head on narrow widths — so the operator never
 * reads the same state twice in one record.
 *
 * Every state renders the same filled badge — same height, padding, radius,
 * size, weight and alignment — and only the semantic colour varies. Active is
 * the canonical green (`--success-ink`, #167A5B); white on it measures
 * 5.29:1, so the badge holds WCAG AA.
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
 * The contributor's activity — subordinate to the lifecycle, never merged
 * with it.
 *
 * NEUTRAL TEXT, NOT A BADGE. The lifecycle is the state the row is SCANNED
 * by and keeps the fill; this is a detail of it, read after the operator has
 * found the row they want. Two saturated rectangles in one cell would be a
 * colour vocabulary competing with itself.
 */
function ActivityLine({ row }: { row: IntakeRowModel }) {
  return (
    <span className="ilk-status__activity-line">
      <span className="app-visually-hidden">Contributor activity: </span>
      <span
        className="ilk-status__activity ilk-state-text"
        data-ilk-tone={row.activityVocab.tone}
        data-intake-links-row-session-state={row.activity}
        title={row.activityVocab.explanation}
      >
        {row.activityVocab.label}
      </span>
    </span>
  );
}

/**
 * WHETHER THE LINK STILL WORKS, and what the contributor did.
 *
 * One column, two levels — a filled badge over quiet toned text. They are
 * separate elements with separate probes and separate treatments, so
 * "Expired" over "Submitted" cannot read as one status made of two words,
 * which is the confusion the old two-column arrangement was protecting
 * against by separation. A visual hierarchy answers it better than a column
 * boundary did, and costs three fewer columns.
 */
function StatusCell({ row }: { row: IntakeRowModel }) {
  return (
    <div className="ilk-status" data-intake-links-status-cell>
      <LifecycleBadge row={row} />
      <ActivityLine row={row} />
    </div>
  );
}

/**
 * WHEN IT LAST MOVED, and when it stops working.
 *
 * Two dates were two columns; they are one question. The keys are visible,
 * because "4h ago" stacked over "07 Sep 2026" with no keys is two numbers,
 * not two facts.
 *
 * The key is "Expires" in every state. The Status column one cell away
 * already says "Expired" when it is, and printing the word twice in one row
 * is how a table talks over itself. The near-expiry caution stays, because
 * "this stops working within three days" is a fact no badge carries. Exact
 * local timestamps stay one hover away.
 */
function TimelineCell({ row }: { row: IntakeRowModel }) {
  return (
    <dl className="ilk-timeline" data-intake-links-timeline-cell>
      <div className="ilk-timeline__line">
        <dt className="ilk-timeline__key">Latest</dt>
        <dd
          className="ilk-timeline__value ilk-relative"
          title={row.latestActivityAbsolute}
        >
          {row.latestActivityRelative}
        </dd>
      </div>
      <div className="ilk-timeline__line">
        <dt className="ilk-timeline__key">Expires</dt>
        <dd
          className="ilk-timeline__value ilk-expiry"
          data-state={row.expiryState}
          data-intake-links-row-expires={row.expiryState}
          title={row.expiryAbsolute}
        >
          <span className="ilk-expiry__date" data-intake-links-row-expiry-date>
            {row.expiryDate}
          </span>
        </dd>
      </div>
    </dl>
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

function RowMenu({
  row,
  handlers,
}: {
  row: IntakeRowModel;
  handlers: RecordsHandlers;
}) {
  return (
    <AppRowMenu
      label={`Actions for ${row.requestName}`}
      actions={buildActions(row, handlers)}
      dataPrefix="intake-links"
      triggerLabel="Actions"
      triggerLabelClassName="ilk-when-wide"
      icon={<IconDots size={16} />}
      pendingIcon={<IconSpinner size={14} />}
    />
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
        <RequestCell row={row} onOpenDetails={handlers.onOpenDetails} />
      </td>
      <td data-col="identity">
        <IdentityCell row={row} />
      </td>
      <td data-col="delivery">
        <DeliveryCell row={row} />
      </td>
      <td data-col="status">
        <StatusCell row={row} />
      </td>
      <td data-col="timeline">
        <TimelineCell row={row} />
      </td>
      <td data-col="submissions">
        <SubmissionsCell row={row} onOpenSubmissions={handlers.onOpenSubmissions} />
      </td>
      <td data-col="actions">
        <RowMenu row={row} handlers={handlers} />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Narrow layout — the same cells, stacked
// ---------------------------------------------------------------------------

/**
 * The card is a SECOND LAYOUT, not a second implementation. It renders the
 * very cells the table renders, in the order the columns run, so a value can
 * never appear on one and not the other.
 */
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
      {/* Lifecycle leads the card the way it leads the Status column — it is
          the one state the record is scanned by. */}
      <div className="ilk-card__head">
        <div className="ilk-card__heading">
          <RequestCell row={row} onOpenDetails={handlers.onOpenDetails} />
        </div>
        <LifecycleBadge row={row} />
      </div>

      <IdentityCell row={row} />

      <div className="ilk-card__facts">
        <DeliveryCell row={row} />
        <ActivityLine row={row} />
        <TimelineCell row={row} />
      </div>

      <div className="ilk-card__foot">
        <SubmissionsCell row={row} onOpenSubmissions={handlers.onOpenSubmissions} />
        <RowMenu row={row} handlers={handlers} />
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
          column. Seven columns fit the frame the page gives them at every
          width the table is shown at, so this is now a safety net rather than
          a working mechanism — but a long user-generated template name is
          still allowed to make one row wide, and losing the Actions column to
          a clip is not an acceptable answer to that. */}
      <div
        className="app-table-surface app-table-surface--scroll ilk-records--wide"
        data-intake-links-table-surface
      >
        <table className="app-table ilk-table" data-intake-links-table aria-label="Intake links">
          <colgroup>
            <col data-col="request" />
            <col data-col="identity" />
            <col data-col="delivery" />
            <col data-col="status" />
            <col data-col="timeline" />
            <col data-col="submissions" />
            <col data-col="actions" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" data-col="request">Request</th>
              {/* One heading over four independent fields. The GROUPING is
                  visual; the fields, and the four search arms that match
                  them, remain separate everywhere else. */}
              <th scope="col" data-col="identity">Recipient &amp; reference</th>
              <th scope="col" data-col="delivery">Delivery</th>
              <th scope="col" data-col="status">Status</th>
              <th scope="col" data-col="timeline">Timeline</th>
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
