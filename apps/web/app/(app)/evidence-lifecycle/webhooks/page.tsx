"use client";

/**
 * BATCH J — POST /v1/integrations/webhooks/endpoints/:id/deactivate is wired
 * as a per-row "Deactivate" on ACTIVE endpoints: danger confirmation naming
 * the URL, the write, then a reread of the endpoint list. Success is
 * announced only when the reread shows the endpoint deactivated.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { StatusBadge, statusBadgeStyle } from "../../../../components/ui/StatusBadge";
import { webhookDeliveryStateLabel } from "../../../../lib/labels/governanceReviewLabels";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate, formatUserDateTime } from "../../../../lib/date";
import {
  DenialBanner,
  LifecycleSectionBoundary,
  resolveLifecycleError,
  type LifecycleDenial,
} from "../_shared";

interface WebhookEndpoint {
  id: string;
  url: string;
  subscribedEvents: string[];
  state: string;
  createdAtUtc: string;
}

interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventKind: string;
  state: string;
  attemptCount: number;
  responseStatus?: number | null;
  responseBodyExcerpt?: string | null;
  enqueuedAtUtc: string;
  lastAttemptAtUtc?: string | null;
  nextAttemptAtUtc?: string | null;
}

const AVAILABLE_EVENTS = [
  "evidence.created",
  "evidence.updated",
  "evidence.deleted",
  "lifecycle.retention_expired",
  "lifecycle.legal_hold_placed",
  "lifecycle.legal_hold_released",
  "lifecycle.destruction_requested",
  "lifecycle.destruction_certified",
  "lifecycle.tier_transitioned",
];

/**
 * PV-STATE-001 — ONE resolver for every refusal on this page: the segment's
 * shared `resolveLifecycleError` (product-language banner, every status),
 * replacing a private copy that recognised two 403 shapes and silently
 * dropped everything else — so any other failure left the page looking empty.
 */
function applyDenial(err: unknown, setDenial: (v: LifecycleDenial | null) => void): void {
  setDenial(resolveLifecycleError(err));
}

export default function WebhooksPage() {
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <LifecycleSectionBoundary label="Lifecycle Webhooks">
        <Shell />
      </LifecycleSectionBoundary>
    </PageRouteGate>
  );
}

function safeDate(input: string | null | undefined): string {
  if (!input) return "—";
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? "—" : formatUserDate(input);
}

/** The operator sentence for a refused or failed deactivation. */
function deactivateFailureMessage(err: unknown): string {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status === 404) {
    return "This endpoint no longer exists in this workspace. Refresh the list.";
  }
  if (status === 403) {
    return "Only an organization administrator can deactivate a webhook endpoint.";
  }
  return toSafeUserError(err, {
    message: "The endpoint could not be deactivated. Refresh the list and try again.",
  }).message;
}

function Shell() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [endpointsLoaded, setEndpointsLoaded] = useState(false);
  const { confirm: confirmAction } = useConfirmAction();
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [endpointNotice, setEndpointNotice] = useState<string | null>(null);
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<LifecycleDenial | null>(null);
  // PV-STATE-001 — each half of the page fails on its own. A half that could
  // not be read renders that fact, never its "nothing configured yet" state.
  const [endpointsFailed, setEndpointsFailed] = useState(false);
  const [deliveriesFailed, setDeliveriesFailed] = useState(false);
  const [replayingId, setReplayingId] = useState<string | null>(null);

  // Create endpoint form
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [secretBanner, setSecretBanner] = useState<string | null>(null);

  /** Resolves with the endpoint rows it painted, or null when that read failed. */
  const refresh = useCallback(async (): Promise<WebhookEndpoint[] | null> => {
    setBusy(true);
    setDenial(null);
    try {
      // allSettled — endpoint listing and delivery history fail independently;
      // one being down must not blank the other half of the page.
      const [eRes, dRes] = await Promise.allSettled([
        apiFetch("/v1/integrations/webhooks/endpoints", { method: "GET" }),
        apiFetch("/v1/integrations/webhooks/lifecycle-deliveries", { method: "GET" }),
      ]);
      const endpointRows =
        eRes.status === "fulfilled"
          ? (((eRes.value as { endpoints?: WebhookEndpoint[] } | null)?.endpoints ??
              []) as WebhookEndpoint[])
          : null;
      setEndpoints(endpointRows ?? []);
      setEndpointsLoaded(true);
      setDeliveries(
        dRes.status === "fulfilled"
          ? ((dRes.value as { deliveries?: WebhookDelivery[] } | null)?.deliveries ??
              []) as WebhookDelivery[]
          : [],
      );
      setEndpointsFailed(eRes.status === "rejected");
      setDeliveriesFailed(dRes.status === "rejected");
      if (eRes.status === "rejected") {
        applyDenial(eRes.reason, setDenial);
      } else if (dRes.status === "rejected") {
        applyDenial(dRes.reason, setDenial);
      }
      return endpointRows;
    } catch (err) {
      setEndpoints([]);
      setDeliveries([]);
      setEndpointsLoaded(true);
      setEndpointsFailed(true);
      setDeliveriesFailed(true);
      applyDenial(err, setDenial);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * POST /v1/integrations/webhooks/endpoints/:id/deactivate — stops lifecycle
   * delivery to one endpoint. Announced only after the endpoint list reread
   * shows the endpoint is no longer active.
   */
  const deactivateEndpoint = useCallback(
    async (endpoint: WebhookEndpoint) => {
      if (deactivatingId) return;
      setEndpointNotice(null);
      setEndpointError(null);
      const confirmed = await confirmAction({
        title: "Deactivate this webhook endpoint?",
        description: `Lifecycle events stop being delivered to ${endpoint.url} immediately. The endpoint cannot be reactivated from this page; register it again to resume delivery.`,
        confirmLabel: "Deactivate endpoint",
        tone: "danger",
        testId: "lifecycle-webhook-deactivate",
      });
      if (!alive.current || !confirmed) return;
      setDeactivatingId(endpoint.id);
      let written = false;
      try {
        await apiFetch(
          `/v1/integrations/webhooks/endpoints/${encodeURIComponent(endpoint.id)}/deactivate`,
          { method: "POST", body: JSON.stringify({}) },
        );
        written = true;
        const rows = await refresh();
        if (!alive.current) return;
        const reread = rows?.find((row) => row.id === endpoint.id);
        if (rows === null) {
          setEndpointError(
            "The endpoint was deactivated, but the endpoint list could not be reloaded to confirm it. Refresh before relying on its state.",
          );
        } else if (!reread || reread.state !== "ACTIVE") {
          setEndpointNotice(
            "Endpoint deactivated and confirmed from the saved record. No further lifecycle events will be delivered to it.",
          );
        } else {
          setEndpointError(
            "The deactivation was sent, but the endpoint still shows as active. Refresh and check again.",
          );
        }
      } catch (err) {
        if (!alive.current) return;
        if (!written) setEndpointError(deactivateFailureMessage(err));
      } finally {
        if (alive.current) setDeactivatingId(null);
      }
    },
    [confirmAction, deactivatingId, refresh],
  );

  const replayDelivery = useCallback(async (deliveryId: string) => {
    setReplayingId(deliveryId);
    try {
      await apiFetch(`/v1/integrations/webhooks/lifecycle-deliveries/${deliveryId}/replay`, {
        method: "POST",
      });
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setReplayingId(null);
    }
  }, [refresh]);

  const createEndpoint = useCallback(async () => {
    setCreating(true);
    setDenial(null);
    setSecretBanner(null);
    try {
      const res = (await apiFetch("/v1/integrations/webhooks/endpoints", {
        method: "POST",
        body: JSON.stringify({ url, subscribedEvents: selectedEvents }),
      })) as { secret?: string } | null;
      if (res?.secret) {
        setSecretBanner(res.secret);
      }
      setUrl("");
      setSelectedEvents([]);
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setCreating(false);
    }
  }, [url, selectedEvents, refresh]);

  const toggleEvent = useCallback((event: string) => {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <PageShell
      data-webhooks-page
      header={
        <PageHeader
          eyebrow="Evidence Lifecycle"
          title="Webhooks"
          subtitle="Deliver lifecycle events to your own endpoints and replay failed deliveries."
          primaryAction={
            <Button
              type="button"
              variant="primary"
              loading={busy}
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? "Loading…" : "Refresh"}
            </Button>
          }
          contextStrip={
            <a href="/evidence-lifecycle" style={{ fontSize: 12 }}>
              ← Back to Evidence Lifecycle
            </a>
          }
        />
      }
    >
      {denial ? <DenialBanner denial={denial} /> : null}

      {secretBanner ? (
        <div
          data-webhook-secret-banner
          style={{
            padding: 12,
            background: "#f0fdf4",
            border: "2px solid #16a34a",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 14,
          }}
        >
          <strong style={{ color: "#15803d" }}>
            Signing secret — copy now, it will not be shown again:
          </strong>
          <pre
            style={{
              margin: "8px 0 0",
              fontFamily: "monospace",
              fontSize: 13,
              wordBreak: "break-all",
            }}
          >
            {secretBanner}
          </pre>
          <button
            type="button"
            onClick={() => setSecretBanner(null)}
            style={{ marginTop: 8, fontSize: 11, cursor: "pointer" }}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Create endpoint form */}
      <Card variant="admin" title="Create Webhook Endpoint">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          <label style={labelStyle}>
            URL
            <input
              type="url"
              style={{ ...inputStyle, minWidth: 260 }}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-server.example/webhook"
            />
          </label>
          <div>
            <small style={{ fontWeight: 600, fontSize: 11 }}>Subscribed Events</small>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                marginTop: 4,
                maxHeight: 180,
                overflowY: "auto",
              }}
            >
              {AVAILABLE_EVENTS.map((ev) => (
                <label key={ev} style={{ fontSize: 11, display: "flex", gap: 4, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(ev)}
                    onChange={() => toggleEvent(ev)}
                  />
                  {ev}
                </label>
              ))}
            </div>
          </div>
          <div style={{ alignSelf: "flex-end" }}>
            <Button
              type="button"
              variant="primary"
              loading={creating}
              disabled={creating || !url || selectedEvents.length === 0}
              disabledReason={
                !url
                  ? "Enter the endpoint URL to deliver events to."
                  : selectedEvents.length === 0
                    ? "Choose at least one lifecycle event to subscribe to."
                    : undefined
              }
              onClick={() => void createEndpoint()}
            >
              {creating ? "Creating…" : "Create Endpoint"}
            </Button>
          </div>
        </div>
      </Card>

      {/* Endpoints */}
      <PageSection title="Endpoints">
        {endpointNotice ? (
          <p role="status" data-webhook-endpoint-notice style={{ margin: "0 0 8px", fontSize: 13 }}>
            {endpointNotice}
          </p>
        ) : null}
        {endpointError ? (
          <p role="alert" data-webhook-endpoint-error style={{ margin: "0 0 8px", fontSize: 13 }}>
            {endpointError}
          </p>
        ) : null}
        {endpointsFailed ? (
          <p data-webhook-endpoints-unreadable style={{ margin: 0, fontSize: 13, color: "#475569" }}>
            The endpoint list could not be read. This is not an empty list —
            endpoints may be configured that this page cannot show.
          </p>
        ) : (
        <DataTable<WebhookEndpoint>
          ariaLabel="Webhook endpoints"
          columns={ENDPOINT_COLUMNS}
          rows={endpoints}
          getRowId={(ep) => ep.id}
          loading={!endpointsLoaded}
          rowActions={(ep) =>
            ep.state === "ACTIVE" ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-webhook-endpoint-deactivate={ep.id}
                aria-label={`Deactivate endpoint ${ep.url}`}
                loading={deactivatingId === ep.id}
                disabled={deactivatingId !== null}
                disabledReason={
                  deactivatingId !== null && deactivatingId !== ep.id
                    ? "Another endpoint is being deactivated. Wait for it to finish."
                    : undefined
                }
                onClick={() => void deactivateEndpoint(ep)}
              >
                {deactivatingId === ep.id ? "Deactivating…" : "Deactivate"}
              </Button>
            ) : (
              <span style={{ fontSize: 12 }}>No longer receives events</span>
            )
          }
          emptyState={
            <EmptyState
              title="No webhook endpoints configured"
              purpose="Register an endpoint above to receive lifecycle events (retention, legal holds, destruction, tier transitions) at your own server."
            />
          }
        />
        )}
      </PageSection>

      {/* Deliveries */}
      <PageSection title="Recent Lifecycle Webhook Deliveries">
        {deliveriesFailed ? (
          <p data-webhook-deliveries-unreadable style={{ margin: 0, fontSize: 13, color: "#475569" }}>
            Delivery history could not be read. This is not a quiet history —
            deliveries may have been attempted that this page cannot show.
          </p>
        ) : (
        <DataTable<WebhookDelivery>
          ariaLabel="Recent lifecycle webhook deliveries"
          columns={DELIVERY_COLUMNS}
          rows={deliveries}
          getRowId={(d) => d.id}
          rowActions={(d) => (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-webhook-replay-button={d.id}
              loading={replayingId === d.id}
              disabled={replayingId === d.id}
              onClick={() => void replayDelivery(d.id)}
            >
              {replayingId === d.id ? "…" : "Replay"}
            </Button>
          )}
          emptyState={
            <EmptyState
              title="No webhook deliveries yet"
              purpose="Once lifecycle events fire, their delivery attempts to your endpoints appear here with status and replay controls."
            />
          }
        />
        )}
      </PageSection>
    </PageShell>
  );
}

const ENDPOINT_COLUMNS: DataTableColumn<WebhookEndpoint>[] = [
  {
    key: "url",
    header: "URL",
    render: (ep) => (
      <code data-webhook-endpoint-row={ep.id} style={{ wordBreak: "break-all" }}>
        {ep.url}
      </code>
    ),
  },
  { key: "events", header: "Events", render: (ep) => ep.subscribedEvents.join(", ") },
  { key: "state", header: "State", render: (ep) => <StatusBadge status={ep.state} /> },
  { key: "created", header: "Created", render: (ep) => safeDate(ep.createdAtUtc) },
];

const DELIVERY_COLUMNS: DataTableColumn<WebhookDelivery>[] = [
  {
    key: "endpoint",
    header: "Endpoint",
    render: (d) => (
      <code data-webhook-delivery-row={d.id} style={{ fontSize: 10 }}>
        {d.endpointId.slice(0, 8)}…
      </code>
    ),
  },
  { key: "event", header: "Event", render: (d) => d.eventKind },
  {
    key: "state",
    header: "State",
    render: (d) => <span style={statusBadgeStyle(d.state)}>{webhookDeliveryStateLabel(d.state)}</span>,
  },
  { key: "attempts", header: "Attempts", render: (d) => d.attemptCount },
  { key: "status", header: "Status", render: (d) => d.responseStatus ?? "—" },
  {
    key: "nextAttempt",
    header: "Next Attempt",
    render: (d) => (d.nextAttemptAtUtc ? formatUserDateTime(d.nextAttemptAtUtc) : "—"),
  },
  { key: "enqueued", header: "Enqueued", render: (d) => formatUserDateTime(d.enqueuedAtUtc) },
];

const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 2, fontSize: 11, fontWeight: 600 };
const inputStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#fff",
  minWidth: 140,
} as const;
