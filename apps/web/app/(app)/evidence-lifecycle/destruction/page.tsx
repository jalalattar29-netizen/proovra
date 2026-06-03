"use client";

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../lib/api";
import { LifecycleSectionBoundary } from "../_shared";

type PermissionDenialState = { denial: string; tier: string } | null;

interface DestructionRequest {
  id: string;
  evidenceId: string;
  state: string;
  reason?: string | null;
  certificateUrl?: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}

const STATE_COLORS: Record<string, string> = {
  PENDING: "#fef3c7",
  APPROVED: "#d1fae5",
  REJECTED: "#fee2e2",
  EXECUTING: "#dbeafe",
  CERTIFIED: "#f0fdf4",
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

export default function DestructionPage() {
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <LifecycleSectionBoundary label="Destruction Governance">
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
  const [requests, setRequests] = useState<DestructionRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);

  // Create form state
  const [evidenceId, setEvidenceId] = useState("");
  const [reason, setReason] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const res = (await apiFetch("/v1/lifecycle/destruction/requests", {
        method: "GET",
      })) as { requests?: DestructionRequest[] } | null;
      setRequests((res?.requests ?? []) as DestructionRequest[]);
    } catch (err) {
      setRequests([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback(async () => {
    setCreating(true);
    setDenial(null);
    try {
      await apiFetch("/v1/lifecycle/destruction/requests", {
        method: "POST",
        body: JSON.stringify({ evidenceId, reason: reason || null }),
      });
      setEvidenceId("");
      setReason("");
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setCreating(false);
    }
  }, [evidenceId, reason, refresh]);

  const doAction = useCallback(
    async (id: string, action: "approve" | "reject" | "execute") => {
      setDenial(null);
      try {
        await apiFetch(`/v1/lifecycle/destruction/requests/${id}/${action}`, { method: "POST" });
        await refresh();
      } catch (err) {
        applyDenial(err, setDenial);
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-destruction-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Destruction Requests</h1>
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

      {/* Create form */}
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
          Create Destruction Request
        </strong>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            Evidence ID
            <input
              style={inputStyle}
              value={evidenceId}
              onChange={(e) => setEvidenceId(e.target.value)}
              placeholder="uuid"
            />
          </label>
          <label style={labelStyle}>
            Reason
            <input
              style={inputStyle}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="optional"
            />
          </label>
          <button
            type="button"
            disabled={creating || !evidenceId}
            onClick={() => void create()}
            style={primaryButton}
          >
            {creating ? "Creating…" : "Create Request"}
          </button>
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
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Evidence ID</th>
              <th style={th}>State</th>
              <th style={th}>Reason</th>
              <th style={th}>Created</th>
              <th style={th}>Updated</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {requests.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ ...td, color: "#475569" }}>
                  No destruction requests.
                </td>
              </tr>
            ) : (
              requests.map((r) => (
                <tr key={r.id} data-destruction-request-row={r.id}>
                  <td style={td}>
                    <code>{r.evidenceId}</code>
                  </td>
                  <td style={td}>
                    <span
                      data-destruction-state={r.state}
                      style={{
                        padding: "2px 6px",
                        borderRadius: 4,
                        background: STATE_COLORS[r.state] ?? "#f1f5f9",
                        fontWeight: 700,
                        fontSize: 11,
                      }}
                    >
                      {r.state}
                    </span>
                  </td>
                  <td style={td}>{r.reason ?? "—"}</td>
                  <td style={td}>{safeDate(r.createdAtUtc)}</td>
                  <td style={td}>{safeDate(r.updatedAtUtc)}</td>
                  <td style={td}>
                    <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {r.state === "PENDING" && (
                        <>
                          <button
                            type="button"
                            onClick={() => void doAction(r.id, "approve")}
                            style={secondaryButton}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => void doAction(r.id, "reject")}
                            style={{ ...secondaryButton, color: "#dc2626", borderColor: "#dc2626" }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {r.state === "APPROVED" && (
                        <button
                          type="button"
                          onClick={() => void doAction(r.id, "execute")}
                          style={{ ...secondaryButton, background: "#0f172a", color: "#fafafa" }}
                        >
                          Execute
                        </button>
                      )}
                      {r.state === "CERTIFIED" && r.certificateUrl && (
                        <a
                          href={r.certificateUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 11, color: "#0f172a", fontWeight: 600 }}
                        >
                          Certificate
                        </a>
                      )}
                    </span>
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
const secondaryButton = {
  padding: "4px 8px",
  border: "1px solid #0f172a",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 600,
  fontSize: 11,
  borderRadius: 6,
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
