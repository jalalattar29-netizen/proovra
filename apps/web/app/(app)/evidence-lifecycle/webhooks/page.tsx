"use client";

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../lib/api";
import { LifecycleSectionBoundary } from "../_shared";

type PermissionDenialState = { denial: string; tier: string } | null;

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

const DELIVERY_STATE_COLORS: Record<string, string> = {
  PENDING: "#fef3c7",
  DELIVERED: "#d1fae5",
  FAILED: "#fee2e2",
  RETRYING: "#dbeafe",
  DEAD_LETTERED: "#fce7f3",
};

function applyDenial(err: unknown, setDenial: (v: PermissionDenialState) => void): void {
  const e = err as { statusCode?: number; details?: Record<string, unknown> };
  const denial =
    e?.details && typeof e.details["denial"] === "string" ? e.details["denial"] : null;
  const tier =
    e?.details && typeof e.details["requiredTier"] === "string"
      ? (e.details["requiredTier"] as string)
      : "DELEGATED_ADMIN";
  if (
    e?.statusCode === 403 &&
    (denial === "ENTITLEMENT_REQUIRED" || denial === "DELEGATED_ADMIN_REQUIRED")
  ) {
    setDenial({ denial: denial as string, tier });
    return;
  }
  if (err instanceof ApiError) {
    const d =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const t =
      err.details && typeof err.details["requiredTier"] === "string"
        ? (err.details["requiredTier"] as string)
        : "DELEGATED_ADMIN";
    if (
      err.statusCode === 403 &&
      (d === "ENTITLEMENT_REQUIRED" || d === "DELEGATED_ADMIN_REQUIRED")
    ) {
      setDenial({ denial: d, tier: t });
    }
  }
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
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function Shell() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);

  // Create endpoint form
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [secretBanner, setSecretBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      // allSettled — endpoint listing and delivery history fail independently;
      // one being down must not blank the other half of the page.
      const [eRes, dRes] = await Promise.allSettled([
        apiFetch("/v1/integrations/webhooks/endpoints", { method: "GET" }),
        apiFetch("/v1/integrations/webhooks/lifecycle-deliveries", { method: "GET" }),
      ]);
      setEndpoints(
        eRes.status === "fulfilled"
          ? ((eRes.value as { endpoints?: WebhookEndpoint[] } | null)?.endpoints ??
              []) as WebhookEndpoint[]
          : [],
      );
      setDeliveries(
        dRes.status === "fulfilled"
          ? ((dRes.value as { deliveries?: WebhookDelivery[] } | null)?.deliveries ??
              []) as WebhookDelivery[]
          : [],
      );
      if (eRes.status === "rejected" && dRes.status === "rejected") {
        applyDenial(eRes.reason, setDenial);
      }
    } catch (err) {
      setEndpoints([]);
      setDeliveries([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

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
    <div
      data-webhooks-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Webhooks</h1>
        <p>
          <a href="/evidence-lifecycle" style={{ fontSize: 12 }}>
            ← Back to Evidence Lifecycle
          </a>
        </p>
      </header>

      {denial ? (
        <div
          data-permission-denied={denial.denial}
          style={{
            padding: 10,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          <strong>Permission required:</strong> {denial.tier}
        </div>
      ) : null}

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
      <section
        style={{
          background: "rgba(15,23,42,0.03)",
          border: "1px solid rgba(15,23,42,0.06)",
          borderRadius: 10,
          padding: 14,
          marginBottom: 16,
        }}
      >
        <strong style={{ display: "block", marginBottom: 10, fontSize: 14 }}>
          Create Webhook Endpoint
        </strong>
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
            <button
              type="button"
              disabled={creating || !url || selectedEvents.length === 0}
              onClick={() => void createEndpoint()}
              style={primaryButton}
            >
              {creating ? "Creating…" : "Create Endpoint"}
            </button>
          </div>
        </div>
      </section>

      <button
        type="button"
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      {/* Endpoints */}
      <section
        style={{
          background: "#fff",
          border: "1px solid rgba(15,23,42,0.08)",
          borderRadius: 10,
          padding: 8,
          marginTop: 12,
          overflowX: "auto",
        }}
      >
        <strong style={{ fontSize: 14, display: "block", marginBottom: 8 }}>Endpoints</strong>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>URL</th>
              <th style={th}>Events</th>
              <th style={th}>State</th>
              <th style={th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ ...td, color: "#475569" }}>
                  No endpoints.
                </td>
              </tr>
            ) : (
              endpoints.map((ep) => (
                <tr key={ep.id} data-webhook-endpoint-row={ep.id}>
                  <td style={td}>
                    <code style={{ wordBreak: "break-all" }}>{ep.url}</code>
                  </td>
                  <td style={td}>{ep.subscribedEvents.join(", ")}</td>
                  <td style={td}>
                    <strong>{ep.state}</strong>
                  </td>
                  <td style={td}>{safeDate(ep.createdAtUtc)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {/* Deliveries */}
      <section
        style={{
          background: "#fff",
          border: "1px solid rgba(15,23,42,0.08)",
          borderRadius: 10,
          padding: 8,
          marginTop: 12,
          overflowX: "auto",
        }}
      >
        <strong style={{ fontSize: 14, display: "block", marginBottom: 8 }}>
          Recent Lifecycle Webhook Deliveries
        </strong>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Endpoint</th>
              <th style={th}>Event</th>
              <th style={th}>State</th>
              <th style={th}>Attempts</th>
              <th style={th}>Status</th>
              <th style={th}>Next Attempt</th>
              <th style={th}>Enqueued</th>
              <th style={th}>Action</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ ...td, color: "#475569" }}>
                  No deliveries.
                </td>
              </tr>
            ) : (
              deliveries.map((d) => (
                <tr key={d.id} data-webhook-delivery-row={d.id}>
                  <td style={td}>
                    <code style={{ fontSize: 10 }}>{d.endpointId.slice(0, 8)}…</code>
                  </td>
                  <td style={td}>{d.eventKind}</td>
                  <td style={td}>
                    <span
                      style={{
                        padding: "2px 6px",
                        borderRadius: 4,
                        background: DELIVERY_STATE_COLORS[d.state] ?? "#f1f5f9",
                        fontWeight: 700,
                        fontSize: 11,
                      }}
                    >
                      {d.state}
                    </span>
                  </td>
                  <td style={td}>{d.attemptCount}</td>
                  <td style={td}>{d.responseStatus ?? "—"}</td>
                  <td style={td}>
                    {d.nextAttemptAtUtc
                      ? new Date(d.nextAttemptAtUtc).toLocaleString()
                      : "—"}
                  </td>
                  <td style={td}>{new Date(d.enqueuedAtUtc).toLocaleString()}</td>
                  <td style={td}>
                    <button
                      type="button"
                      data-webhook-replay-button={d.id}
                      disabled={replayingId === d.id}
                      onClick={() => void replayDelivery(d.id)}
                      style={{
                        padding: "2px 8px",
                        fontSize: 11,
                        fontWeight: 600,
                        border: "1px solid #0f172a",
                        background: "#fff",
                        borderRadius: 5,
                        cursor: replayingId === d.id ? "not-allowed" : "pointer",
                        color: "#0f172a",
                      }}
                    >
                      {replayingId === d.id ? "…" : "Replay"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

const primaryButton = {
  padding: "6px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 2, fontSize: 11, fontWeight: 600 };
const inputStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#fff",
  minWidth: 140,
} as const;
