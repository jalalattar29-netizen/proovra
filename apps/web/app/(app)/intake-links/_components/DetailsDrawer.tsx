"use client";

/**
 * Intake links — the link details drawer.
 *
 * The Inspector for one link. It reads the SAME row model as the table and the
 * cards, so a state named "Link disabled" in the list is never called
 * "REVOKED" here. Technical identifiers keep their own direction so they stay
 * readable when the surface is mirrored.
 */

import * as React from "react";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import { formatUserDateTime } from "../../../../lib/date";
import { intakeModeLabel } from "../../../../lib/intake-links/vocabulary";
import type { IntakeLinkListItem } from "../_lib/types";
import { buildRowModel } from "../_lib/rowModel";
import { Drawer } from "./Drawer";

function TimelineRow({ label, iso }: { label: string; iso: string | null }) {
  return (
    <li className="ilk-timeline__row">
      <span className="ilk-timeline__label">{label}</span>
      <span className="ilk-ltr">{iso ? formatUserDateTime(iso) : "—"}</span>
    </li>
  );
}

export function DetailsDrawer({
  item,
  onClose,
  onOpenDelivery,
  onOpenSubmissions,
  onDisable,
  onArchive,
  archivePending,
  now,
}: {
  item: IntakeLinkListItem;
  onClose: () => void;
  onOpenDelivery: () => void;
  onOpenSubmissions: () => void;
  onDisable: () => void;
  onArchive: () => void;
  archivePending: boolean;
  now?: number;
}) {
  const row = React.useMemo(() => buildRowModel(item, now), [item, now]);
  const { link, delivery, activity } = item;

  return (
    <Drawer
      title={row.requestName}
      subtitle={
        <>
          Link ID <span className="ilk-ltr">{link.id.slice(0, 8)}…</span>
        </>
      }
      onClose={onClose}
      testId="intake-links-details-drawer"
    >
      <section className="ilk-drawer__section" data-intake-links-details-overview>
        <h3 className="ilk-drawer__section-title">Overview</h3>
        <div className="ilk-status__line">
          <AppStatusBadge
            tone={row.lifecycleVocab.tone}
            fill="solid"
            data-intake-links-details-link-state={row.lifecycle}
          >
            {row.lifecycleVocab.label}
          </AppStatusBadge>
          <AppStatusBadge
            tone={row.activityVocab.tone}
            fill="solid"
            data-intake-links-details-session-state={row.activity}
          >
            {row.activityVocab.label}
          </AppStatusBadge>
        </div>
        <p className="ilk-note">{row.lifecycleVocab.explanation}</p>
        <dl className="ilk-facts">
          <dt>Request</dt>
          <dd>
            {row.requestName}{" "}
            <span className="ilk-ltr app-table__muted">
              {link.workflowTemplateSlug}
            </span>
          </dd>
          <dt>Link type</dt>
          <dd>{intakeModeLabel(link.intakeMode)}</dd>
          <dt>Customer ID</dt>
          <dd className="ilk-ltr">
            {row.customerId ?? <span className="ilk-empty">Not set</span>}
          </dd>
          <dt>Recipient</dt>
          <dd>
            {row.recipientIsPlaceholder ? (
              <span className="ilk-empty">No recipient</span>
            ) : (
              <div className="ilk-recipient">
                {row.recipientName ? (
                  <span className="ilk-recipient__name">{row.recipientName}</span>
                ) : null}
                {row.recipientEmail ? (
                  <span className="ilk-recipient__line ilk-ltr">
                    {row.recipientEmail}
                  </span>
                ) : null}
                {row.recipientPhone ? (
                  <span className="ilk-recipient__line ilk-ltr">
                    {row.recipientPhone}
                  </span>
                ) : null}
              </div>
            )}
          </dd>
          <dt>Channel</dt>
          <dd>{row.channelLabel}</dd>
          <dt>Submissions used</dt>
          <dd>
            {link.usedCount} of {link.maxUses}
          </dd>
          <dt>Created</dt>
          <dd className="ilk-ltr">{formatUserDateTime(link.createdAt)}</dd>
          <dt>{row.expiryState === "expired" ? "Expired" : "Expires"}</dt>
          <dd className="ilk-ltr">{row.expiryAbsolute}</dd>
          {link.revokedAtUtc ? (
            <>
              <dt>Disabled</dt>
              <dd className="ilk-ltr">
                {formatUserDateTime(link.revokedAtUtc)}
                {link.revokedReason ? ` · ${link.revokedReason}` : ""}
              </dd>
            </>
          ) : null}
          {link.archivedAtUtc ? (
            <>
              <dt>Archived</dt>
              <dd className="ilk-ltr">
                {formatUserDateTime(link.archivedAtUtc)}
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      <section className="ilk-drawer__section" data-intake-links-details-delivery>
        <h3 className="ilk-drawer__section-title">Delivery</h3>
        {row.hasDeliveryHistory ? (
          <>
            <p className="ilk-note">
              {row.deliveryVocab.label} via {row.channelLabel} ·{" "}
              {row.deliveryVocab.explanation}
            </p>
            <p className="ilk-note">
              {delivery.attemptCount} attempt
              {delivery.attemptCount === 1 ? "" : "s"} across{" "}
              {delivery.channelsAttempted.length} channel
              {delivery.channelsAttempted.length === 1 ? "" : "s"}.
            </p>
            <div>
              <button
                type="button"
                className="app-secondary-action"
                onClick={onOpenDelivery}
              >
                Open delivery history
              </button>
            </div>
          </>
        ) : (
          <p className="ilk-note">
            Nothing has been sent for this link — it is shared manually.
          </p>
        )}
      </section>

      <section className="ilk-drawer__section" data-intake-links-details-activity>
        <h3 className="ilk-drawer__section-title">Activity</h3>
        <ul className="ilk-timeline">
          <TimelineRow label="Created" iso={link.createdAt} />
          <TimelineRow
            label="Sent"
            iso={delivery.latestSentAtUtc ?? delivery.latestAtUtc}
          />
          <TimelineRow label="Opened" iso={activity.firstOpenedAtUtc} />
          <TimelineRow label="Upload started" iso={activity.firstStartedAtUtc} />
          <TimelineRow label="Submitted" iso={activity.firstSubmittedAtUtc} />
          {link.revokedAtUtc ? (
            <TimelineRow label="Disabled" iso={link.revokedAtUtc} />
          ) : null}
          {link.archivedAtUtc ? (
            <TimelineRow label="Archived" iso={link.archivedAtUtc} />
          ) : null}
        </ul>
      </section>

      <section
        className="ilk-drawer__section"
        data-intake-links-details-submissions
      >
        <h3 className="ilk-drawer__section-title">Submissions</h3>
        <p className="ilk-note">
          {activity.sessionsSubmitted} submitted · {row.inProgressCount} in
          progress · {activity.evidenceCount} evidence record
          {activity.evidenceCount === 1 ? "" : "s"} produced.
        </p>
        {row.hasSessions ? (
          <div>
            <button
              type="button"
              className="app-secondary-action"
              onClick={onOpenSubmissions}
            >
              View submissions
            </button>
          </div>
        ) : null}
      </section>

      <section className="ilk-drawer__section" data-intake-links-details-safety>
        <h3 className="ilk-drawer__section-title">Access</h3>
        <p className="ilk-note">
          The secure link is shown once, immediately after creation, and is
          never stored or shown again. Contributors submit files without
          accessing this workspace.
        </p>
        <div className="ilk-card__foot">
          <button
            type="button"
            className="app-secondary-action"
            onClick={onArchive}
            disabled={archivePending}
            aria-busy={archivePending || undefined}
            data-intake-links-details-archive
          >
            {archivePending
              ? "Working…"
              : row.canUnarchive
                ? "Restore from archive"
                : "Archive"}
          </button>
          {row.canDisable ? (
            <button
              type="button"
              className="app-danger-action"
              onClick={onDisable}
              data-intake-links-details-revoke
            >
              Disable link
            </button>
          ) : null}
        </div>
        {row.canDisable ? (
          <p className="ilk-note">
            Disabling refuses everyone holding the link. It cannot be undone.
          </p>
        ) : null}
      </section>
    </Drawer>
  );
}

export default DetailsDrawer;
