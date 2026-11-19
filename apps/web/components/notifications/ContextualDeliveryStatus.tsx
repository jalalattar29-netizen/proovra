"use client";

/**
 * Contextual delivery status — the ONLY delivery surface for Personal
 * users and ordinary members: outbound emails for ONE originating
 * workflow (evidence request), with a retry action for eligible rows.
 * Safe projection only — no provider internals, no unrelated rows, no
 * cron diagnostics. The global delivery log remains an organization
 * operations/admin surface.
 */
import { identifierLabel } from "@proovra/shared";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";

type ContextualDelivery = {
  id: string;
  eventType: string;
  status: string;
  errorCode: string | null;
  retryCount: number;
  lastAttemptAtUtc: string;
  retryable: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  SENT: "Sent",
  DELIVERED: "Delivered",
  RETRY_SCHEDULED: "Retrying",
  FAILED: "Failed",
  SKIPPED: "Not sent",
  CANCELLED: "Cancelled",
};

/** PRO-N1Z-03 — say why a retry did not send, by the server's outcome code. */
function retryRefusalMessage(code: string | null): string {
  switch (code) {
    case "skipped_terminal":
    case "not_retryable":
      return "This message was never stored for sending, so it cannot be retried.";
    case "blocked_plan":
      return "This workspace's plan no longer includes secure intake, so the invitation was not sent again.";
    case "blocked_request_closed":
      return "This request is cancelled or closed, so the message was not sent again.";
    case "in_progress":
      return "This message is already being sent.";
    case "rate_limited":
      return "This message was retried recently. Try again later.";
    case "failed_to_dispatch":
      return "The retry was attempted but the email provider did not accept it.";
    default:
      return "The delivery could not be retried right now.";
  }
}

export function ContextualDeliveryStatus({ requestId }: { requestId: string }) {
  const [rows, setRows] = useState<ContextualDelivery[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = (await apiFetch(
        `/v1/evidence-requests/${encodeURIComponent(requestId)}/deliveries`,
      )) as { deliveries: ContextualDelivery[] };
      setRows(res.deliveries);
      setError(null);
    } catch {
      // Delivery status is supplementary — never block the workflow page.
      setRows([]);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function retry(deliveryId: string) {
    if (busyId) return;
    setBusyId(deliveryId);
    try {
      const res = (await apiFetch(
        `/v1/evidence-requests/${encodeURIComponent(requestId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`,
        { method: "POST" },
      )) as { outcome?: string } | null;
      // PRO-N1Z-03 — an older API answers 200 for every outcome; only an
      // actual resend is success.
      if (res?.outcome && res.outcome !== "resent") {
        setError(retryRefusalMessage(res.outcome));
      } else {
        setError(null);
      }
      await load();
    } catch (err) {
      setError(retryRefusalMessage((err as { code?: string } | null)?.code ?? null));
    } finally {
      setBusyId(null);
    }
  }

  if (!rows || rows.length === 0) return null;

  return (
    <section data-contextual-delivery-status className="ops-delivery-card">
      <strong className="ops-delivery-card__title">
        Email delivery for this request
      </strong>
      {error ? (
        <p role="alert" className="ops-delivery-card__error">
          {error}
        </p>
      ) : null}
      <ul className="ops-delivery-card__list">
        {rows.map((d) => (
          <li
            key={d.id}
            data-contextual-delivery-row={d.status}
            className="ops-delivery-row"
          >
            <span className="ops-delivery-row__status">
              {STATUS_LABEL[d.status] ?? identifierLabel(d.status)}
            </span>
            <span>
              {d.eventType.toLowerCase().replace(/_/g, " ")} · last attempt{" "}
              {formatUserDateTime(d.lastAttemptAtUtc)}
              {d.retryCount > 0 ? ` · ${d.retryCount} retr${d.retryCount === 1 ? "y" : "ies"}` : ""}
            </span>
            {d.errorCode ? (
              <span className="ops-delivery-row__error">({d.errorCode})</span>
            ) : null}
            {d.retryable ? (
              <button
                type="button"
                onClick={() => void retry(d.id)}
                disabled={busyId === d.id}
                aria-busy={busyId === d.id}
                className="ops-retry-btn"
              >
                {busyId === d.id ? "Retrying…" : "Retry"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
