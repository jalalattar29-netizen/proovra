"use client";

/**
 * Intake links — delivery history for one link.
 *
 * Reads `GET /v1/communications/messages?relatedIntakeLinkId=…` and offers the
 * ONE resend the backend actually supports without the raw token:
 * `POST /v1/communications/messages/:id/retry`, which re-drives an attempt the
 * provider already has. There is deliberately no "resend" that composes a new
 * message from a row — the secure token is unrecoverable after creation, so
 * such a button could not do what it says.
 */

import * as React from "react";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import {
  channelLabel,
  providerErrorCodeLabel,
  DELIVERY_STATE_VOCABULARY,
} from "../../../../lib/intake-links/vocabulary";
import { getDeliveryState } from "../../../../lib/intake-links/state-model";
import type { CommunicationMessageRow } from "../_lib/types";
import { describeRelativeTime } from "../_lib/rowModel";
import { Drawer } from "./Drawer";
import { IconSpinner } from "./icons";

export function DeliveryHistoryDrawer({
  linkId,
  teamId,
  onClose,
}: {
  linkId: string;
  teamId: string;
  onClose: () => void;
}) {
  const [rows, setRows] = React.useState<CommunicationMessageRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [retryBusy, setRetryBusy] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setError(null);
    try {
      const res = (await apiFetch(
        `/v1/communications/messages?teamId=${encodeURIComponent(teamId)}&relatedIntakeLinkId=${encodeURIComponent(linkId)}&limit=50`,
        { method: "GET" },
      )) as { messages: CommunicationMessageRow[] };
      setRows(res.messages ?? []);
    } catch (err) {
      setError(
        toSafeUserError(err, {
          message: "Couldn't load delivery history.",
        }).message,
      );
      setRows([]);
    }
  }, [linkId, teamId]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  async function retry(messageId: string) {
    if (retryBusy) return;
    setRetryBusy(messageId);
    setError(null);
    try {
      await apiFetch(
        `/v1/communications/messages/${encodeURIComponent(messageId)}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      );
      await reload();
    } catch (err) {
      setError(toSafeUserError(err, { message: "Retry failed." }).message);
    } finally {
      setRetryBusy(null);
    }
  }

  return (
    <Drawer
      title="Delivery history"
      onClose={onClose}
      testId="intake-link-delivery-drawer"
    >
      {error ? (
        <p className="app-alert app-alert--danger" role="alert">
          {error}
        </p>
      ) : null}

      {rows === null ? (
        <p className="ilk-note" aria-busy="true">
          Loading delivery history…
        </p>
      ) : rows.length === 0 ? (
        <div className="app-empty">
          <strong>Nothing sent yet</strong>
          <p>
            Email, SMS and WhatsApp attempts for this link will appear here as
            soon as one is made.
          </p>
        </div>
      ) : (
        <ul className="ilk-history" data-intake-link-delivery-list>
          {rows.map((r) => {
            const state = getDeliveryState({
              latestStatus: r.status,
              latestFailedAtUtc: r.failedAtUtc,
            });
            const vocab = DELIVERY_STATE_VOCABULARY[state];
            const canRetry =
              r.status === "RETRY_SCHEDULED" ||
              r.status === "FAILED" ||
              r.status === "UNDELIVERED";
            return (
              <li
                key={r.id}
                className="ilk-history__item"
                data-delivery-row={r.id}
                data-delivery-status={r.status}
                data-delivery-channel={r.channel}
              >
                <div className="ilk-history__head">
                  <span className="app-chip">{channelLabel(r.channel)}</span>
                  <AppStatusBadge tone={vocab.tone} fill="solid" title={vocab.explanation}>
                    {vocab.label}
                  </AppStatusBadge>
                  <span className="app-table__muted ilk-relative">
                    {describeRelativeTime(r.createdAt)}
                  </span>
                </div>
                <p className="ilk-note">
                  To <span className="ilk-ltr">{r.recipientPreview ?? "—"}</span>{" "}
                  · attempt {r.attemptCount}
                </p>
                {r.errorCode ? (
                  <p className="app-alert app-alert--danger">
                    {providerErrorCodeLabel(r.errorCode)}
                  </p>
                ) : null}
                <p className="ilk-note">
                  {[
                    r.sentAtUtc ? `Sent ${describeRelativeTime(r.sentAtUtc)}` : "",
                    r.deliveredAtUtc
                      ? `Delivered ${describeRelativeTime(r.deliveredAtUtc)}`
                      : "",
                    r.failedAtUtc
                      ? `Failed ${describeRelativeTime(r.failedAtUtc)}`
                      : "",
                    r.nextAttemptAtUtc
                      ? `Next retry ${describeRelativeTime(r.nextAttemptAtUtc)}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ") || "No provider timestamps recorded."}
                </p>
                {canRetry ? (
                  <div>
                    <button
                      type="button"
                      className="app-secondary-action"
                      onClick={() => void retry(r.id)}
                      disabled={retryBusy !== null}
                      aria-busy={retryBusy === r.id || undefined}
                      data-delivery-retry={r.id}
                    >
                      {retryBusy === r.id ? (
                        <>
                          <IconSpinner size={14} />
                          <span>Retrying…</span>
                        </>
                      ) : (
                        <span>Retry now</span>
                      )}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}

export default DeliveryHistoryDrawer;
