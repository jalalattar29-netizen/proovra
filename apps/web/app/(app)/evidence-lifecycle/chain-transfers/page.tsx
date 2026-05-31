"use client";

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../../lib/api";

type PermissionDenialState = { denial: string; tier: string } | null;

interface ChainTransfer {
  id: string;
  toOrganizationSlug: string;
  evidenceIds: string[];
  reasonNote?: string | null;
  state: string;
  createdAtUtc: string;
  updatedAtUtc: string;
}

const STATE_COLORS: Record<string, string> = {
  PENDING: "#fef3c7",
  ACCEPTED: "#d1fae5",
  REJECTED: "#fee2e2",
  REVOKED: "#f3f4f6",
  COMPLETED: "#f0fdf4",
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

export default function ChainTransfersPage() {
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [transfers, setTransfers] = useState<ChainTransfer[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);

  // Create form state
  const [toOrganizationSlug, setToOrganizationSlug] = useState("");
  const [evidenceIds, setEvidenceIds] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const res = (await apiFetch("/v1/exchange/chain-transfers", {
        method: "GET",
      })) as { transfers?: ChainTransfer[] } | null;
      setTransfers((res?.transfers ?? []) as ChainTransfer[]);
    } catch (err) {
      setTransfers([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback(async () => {
    setCreating(true);
    setDenial(null);
    try {
      const ids = evidenceIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await apiFetch("/v1/exchange/chain-transfers", {
        method: "POST",
        body: JSON.stringify({ toOrganizationSlug, evidenceIds: ids, reasonNote: reasonNote || null }),
      });
      setToOrganizationSlug("");
      setEvidenceIds("");
      setReasonNote("");
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setCreating(false);
    }
  }, [toOrganizationSlug, evidenceIds, reasonNote, refresh]);

  const doAction = useCallback(
    async (id: string, action: "accept" | "reject" | "revoke" | "complete") => {
      setDenial(null);
      try {
        await apiFetch(`/v1/exchange/chain-transfers/${id}/${action}`, { method: "POST" });
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
      data-chain-transfers-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Chain of Custody Transfers</h1>
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
          Create Transfer
        </strong>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            To Organization Slug
            <input
              style={inputStyle}
              value={toOrganizationSlug}
              onChange={(e) => setToOrganizationSlug(e.target.value)}
              placeholder="org-slug"
            />
          </label>
          <label style={labelStyle}>
            Evidence IDs (comma-sep)
            <input
              style={{ ...inputStyle, minWidth: 240 }}
              value={evidenceIds}
              onChange={(e) => setEvidenceIds(e.target.value)}
              placeholder="uuid1, uuid2"
            />
          </label>
          <label style={labelStyle}>
            Reason Note
            <input
              style={inputStyle}
              value={reasonNote}
              onChange={(e) => setReasonNote(e.target.value)}
              placeholder="optional"
            />
          </label>
          <button
            type="button"
            disabled={creating || !toOrganizationSlug || !evidenceIds}
            onClick={() => void create()}
            style={primaryButton}
          >
            {creating ? "Creating…" : "Create Transfer"}
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
              <th style={th}>To Organization</th>
              <th style={th}>Evidence Count</th>
              <th style={th}>Reason</th>
              <th style={th}>State</th>
              <th style={th}>Created</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {transfers.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ ...td, color: "#475569" }}>
                  No chain transfers.
                </td>
              </tr>
            ) : (
              transfers.map((t) => (
                <tr key={t.id}>
                  <td style={td}>
                    <code>{t.toOrganizationSlug}</code>
                  </td>
                  <td style={td}>{t.evidenceIds.length}</td>
                  <td style={td}>{t.reasonNote ?? "—"}</td>
                  <td style={td}>
                    <span
                      style={{
                        padding: "2px 6px",
                        borderRadius: 4,
                        background: STATE_COLORS[t.state] ?? "#f1f5f9",
                        fontWeight: 700,
                        fontSize: 11,
                      }}
                    >
                      {t.state}
                    </span>
                  </td>
                  <td style={td}>{new Date(t.createdAtUtc).toLocaleDateString()}</td>
                  <td style={td}>
                    <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {t.state === "PENDING" && (
                        <>
                          <button
                            type="button"
                            onClick={() => void doAction(t.id, "accept")}
                            style={secondaryButton}
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            onClick={() => void doAction(t.id, "reject")}
                            style={{ ...secondaryButton, color: "#dc2626", borderColor: "#dc2626" }}
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            onClick={() => void doAction(t.id, "revoke")}
                            style={secondaryButton}
                          >
                            Revoke
                          </button>
                        </>
                      )}
                      {t.state === "ACCEPTED" && (
                        <button
                          type="button"
                          onClick={() => void doAction(t.id, "complete")}
                          style={{ ...secondaryButton, background: "#0f172a", color: "#fafafa" }}
                        >
                          Complete
                        </button>
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
