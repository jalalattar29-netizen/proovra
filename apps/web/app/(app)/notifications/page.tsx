"use client";

/**
 * Phase 8.5 — Notification log / admin UI.
 *
 * Compact authenticated view of NotificationDelivery rows for the current
 * workspace. Operators can:
 *   - filter by status / event type
 *   - inspect the safe delivery projection
 *   - resend FAILED / RETRY_SCHEDULED / SKIPPED rows
 *
 * Privacy boundary: the page only renders fields returned by the safe
 * projector (services/api/src/services/notifications/index.ts —
 * projectNotificationDelivery). It does NOT render templateContextJson,
 * raw token bytes, IP/UA, or any workspace-internal field.
 */

import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import { useTeamId } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../components/ui";
import {
  AppListbox,
  AppStatusBadge,
  type AppTone,
} from "../../../components/app-primitives";
type Delivery = {
  id: string;
  eventType: string;
  channel: string;
  provider: string;
  recipient: string;
  recipientName: string | null;
  status: string;
  subject: string | null;
  templateKey: string;
  renderedPreview: string | null;
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  nextAttemptAtUtc: string | null;
  sentAtUtc: string | null;
  deliveredAtUtc: string | null;
  failedAtUtc: string | null;
  evidenceRequestId: string | null;
  createdAt: string;
};

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "SENT", label: "Sent" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "RETRY_SCHEDULED", label: "Retry scheduled" },
  { value: "FAILED", label: "Failed" },
  { value: "SKIPPED", label: "Skipped" },
  { value: "CANCELLED", label: "Cancelled" },
];

const EVENT_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All events" },
  { value: "EVIDENCE_REQUEST_SENT", label: "Evidence request sent" },
  { value: "EVIDENCE_REQUEST_REMINDER", label: "Reminder" },
  { value: "EVIDENCE_REQUEST_RESPONSE_RECEIVED", label: "Response received" },
  { value: "EVIDENCE_REQUEST_NEEDS_MORE_INFO", label: "Needs more info" },
  { value: "REVIEW_REQUEST_ASSIGNED", label: "Review assignment" },
  { value: "EXTERNAL_INTAKE_LINK_CREATED", label: "Intake link created" },
];

const RESEND_ELIGIBLE = new Set([
  "FAILED",
  "RETRY_SCHEDULED",
  "SKIPPED",
]);

/** Delivery status → shared semantic badge tone. */
function deliveryTone(status: string): AppTone {
  switch (status) {
    case "DELIVERED":
    case "SENT":
      return "green";
    case "PENDING":
    case "RETRY_SCHEDULED":
      return "amber";
    case "FAILED":
      return "red";
    case "SKIPPED":
    case "CANCELLED":
    default:
      return "slate";
  }
}

// Phase 38.9 — wrap in canonical PageRouteGate.
export default function NotificationsPage() {
  return (
    <PageRouteGate routeId="workspace.notifications">
      <NotificationsPageInner />
    </PageRouteGate>
  );
}

function NotificationsPageInner() {
  const teamId = useTeamId();
  const [items, setItems] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [eventFilter, setEventFilter] = useState<string>("");
  const [resendBusyId, setResendBusyId] = useState<string | null>(null);


const queryString = useMemo(() => {
    if (!teamId) return "";
    const params = new URLSearchParams({ teamId });
    if (statusFilter) params.set("status", statusFilter);
    if (eventFilter) params.set("eventType", eventFilter);
    params.set("limit", "100");
    return params.toString();
  }, [teamId, statusFilter, eventFilter]);

  async function reload() {
    if (!teamId) return;
    try {
      const res: { deliveries: Delivery[] } = await apiFetch(
        `/v1/notifications/deliveries?${queryString}`,
        { method: "GET" },
      );
      setItems(res.deliveries ?? []);
      setError(null);
    } catch (err) {
      const e = err as { message?: string };
      setError(toSafeUserError(e, { message: "Unable to load notification log." }).message);
    }
  }

  useEffect(() => {
    if (!queryString) return;
    void reload();
  }, [queryString]);

  async function resend(id: string) {
    if (!teamId) return;
    setResendBusyId(id);
    try {
      await apiFetch(`/v1/notifications/deliveries/${id}/resend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      await reload();
    } catch (err) {
      const e = err as { message?: string };
      alert(toSafeUserError(e, { message: "Could not resend." }).message);
    } finally {
      setResendBusyId(null);
    }
  }

  return (
    <PageShell>
      <PageHeader
        title="Notification deliveries"
        subtitle={
          <>
            Outbound delivery log for this workspace — sent, queued, failed, and
            retried communications with resend controls. Available to workspace
            owners and admins. This is a delivery-debugging surface, not your
            notifications: those live in the Operations Center.
          </>
        }
      />

      <section
        style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
      >
        <label className="ops-filter-label" id="notifications-status-filter-label">
          Status
        </label>
        <AppListbox
          value={statusFilter}
          options={STATUS_FILTERS}
          onChange={(v) => setStatusFilter(v)}
          ariaLabelledby="notifications-status-filter-label"
        />

        <label className="ops-filter-label" id="notifications-event-filter-label">
          Event
        </label>
        <AppListbox
          value={eventFilter}
          options={EVENT_FILTERS}
          onChange={(v) => setEventFilter(v)}
          ariaLabelledby="notifications-event-filter-label"
        />
      </section>

      {error ? <div className="ops-error-box">{error}</div> : null}

      {!teamId ? (
        <p className="ops-muted">Switch to a workspace to view notifications.</p>
      ) : items === null ? (
        <p className="ops-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="ops-muted">No notifications match the current filters.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {items.map((it) => (
            <li key={it.id} className="ops-log-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ops-log-row__subject">
                  {it.subject ?? "(no subject)"}
                </div>
                <div className="ops-muted">
                  {it.eventType} · {it.channel}/{it.provider} · {it.recipient}
                </div>
                <div className="ops-muted">
                  Created {formatUserDateTime(it.createdAt)}
                  {it.sentAtUtc
                    ? ` · sent ${formatUserDateTime(it.sentAtUtc)}`
                    : ""}
                  {it.failedAtUtc
                    ? ` · failed ${formatUserDateTime(it.failedAtUtc)}`
                    : ""}
                </div>
                {it.errorCode || it.errorMessage ? (
                  <div className="ops-error">
                    {it.errorCode ? `${it.errorCode}: ` : ""}
                    {it.errorMessage ?? ""}
                  </div>
                ) : null}
                {it.retryCount > 0 ? (
                  <div className="ops-muted">
                    Retry attempts: {it.retryCount}
                    {it.nextAttemptAtUtc
                      ? ` · next ${formatUserDateTime(it.nextAttemptAtUtc)}`
                      : ""}
                  </div>
                ) : null}
              </div>
              <AppStatusBadge tone={deliveryTone(it.status)}>
                {it.status}
              </AppStatusBadge>
              {RESEND_ELIGIBLE.has(it.status) ? (
                <button
                  type="button"
                  className="ops-retry-btn"
                  onClick={() => resend(it.id)}
                  disabled={resendBusyId === it.id}
                >
                  {resendBusyId === it.id ? "Sending…" : "Resend"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}

// Phase Final-Closure — local statusBadgeStyle removed; the canonical
// version lives in components/ui/StatusBadge.tsx. CANCELLED now renders
// neutral (terminal-passive), matching ARCHIVED elsewhere.
// Ops-restyle — visual styling now comes from notifications.css
// (`ops-log-row`, `ops-muted`, `ops-error`, `ops-error-box`,
// `ops-retry-btn`, `ops-filter-label`) plus the shared AppListbox /
// AppStatusBadge primitives. No literal colors remain in this file.
