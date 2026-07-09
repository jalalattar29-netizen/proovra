"use client";

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { statusBadgeStyle } from "../../../../components/ui/StatusBadge";
import { apiFetch, ApiError } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
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
  return Number.isNaN(d.getTime()) ? "—" : formatUserDate(input);
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

  const columns: DataTableColumn<DestructionRequest>[] = [
    {
      key: "evidenceId",
      header: "Evidence ID",
      render: (r) => (
        <code data-destruction-request-row={r.id}>{r.evidenceId}</code>
      ),
    },
    {
      key: "state",
      header: "State",
      render: (r) => (
        <span data-destruction-state={r.state} style={statusBadgeStyle(r.state)}>
          {r.state}
        </span>
      ),
    },
    { key: "reason", header: "Reason", render: (r) => r.reason ?? "—" },
    { key: "created", header: "Created", render: (r) => safeDate(r.createdAtUtc) },
    { key: "updated", header: "Updated", render: (r) => safeDate(r.updatedAtUtc) },
  ];

  return (
    <PageShell
      data-destruction-page
      header={
        <PageHeader
          eyebrow="Evidence Lifecycle"
          title="Destruction Requests"
          subtitle="Request, approve, and execute the permanent destruction of evidence under governance controls."
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
      <Card variant="admin" title="Create Destruction Request">
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
          <Button
            type="button"
            variant="primary"
            loading={creating}
            disabled={creating || !evidenceId}
            onClick={() => void create()}
          >
            {creating ? "Creating…" : "Create Request"}
          </Button>
        </div>
      </Card>

      <PageSection title="Destruction requests">
        <DataTable<DestructionRequest>
          ariaLabel="Destruction requests"
          columns={columns}
          rows={requests}
          getRowId={(r) => r.id}
          rowActions={(r) => (
            <span style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {r.state === "PENDING" && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void doAction(r.id, "approve")}
                  >
                    Approve
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void doAction(r.id, "reject")}
                  >
                    Reject
                  </Button>
                </>
              )}
              {r.state === "APPROVED" && (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => void doAction(r.id, "execute")}
                >
                  Execute
                </Button>
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
          )}
          emptyState={
            <EmptyState
              title="No destruction requests pending"
              purpose="Create a destruction request above to route evidence through the approval and certified-destruction workflow."
            />
          }
        />
      </PageSection>
    </PageShell>
  );
}

const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 2, fontSize: 11, fontWeight: 600 };
const inputStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#fff",
  minWidth: 140,
} as const;
