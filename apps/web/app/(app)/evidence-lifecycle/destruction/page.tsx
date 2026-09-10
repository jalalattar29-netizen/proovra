"use client";

import { useCallback, useEffect, useState } from "react";

import { identifierLabel } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { statusBadgeStyle } from "../../../../components/ui/StatusBadge";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
import {
  DenialBanner,
  LifecycleSectionBoundary,
  resolveLifecycleError,
  type LifecycleDenial,
} from "../_shared";

interface DestructionRequest {
  id: string;
  evidenceId: string;
  state: string;
  reason?: string | null;
  certificateUrl?: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}

/**
 * PV-STATE-001 — ONE resolver for every refusal on this page: the segment's
 * shared `resolveLifecycleError` (product-language banner, every status),
 * replacing a private copy that recognised two 403 shapes and silently
 * dropped everything else — so any other failure left the page looking empty.
 */
function applyDenial(err: unknown, setDenial: (v: LifecycleDenial | null) => void): void {
  setDenial(resolveLifecycleError(err));
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
  const [denial, setDenial] = useState<LifecycleDenial | null>(null);
  // PV-STATE-001 — the queue could not be read. Distinct from "no requests":
  // while set, the table (and its "No destruction requests pending" claim) is
  // not rendered at all.
  const [readFailed, setReadFailed] = useState(false);

  // Create form state
  const [evidenceId, setEvidenceId] = useState("");
  const [reason, setReason] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    setReadFailed(false);
    try {
      const res = (await apiFetch("/v1/lifecycle/destruction/requests", {
        method: "GET",
      })) as { requests?: DestructionRequest[] } | null;
      setRequests((res?.requests ?? []) as DestructionRequest[]);
    } catch (err) {
      setRequests([]);
      setReadFailed(true);
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
          {identifierLabel(r.state)}
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
      {denial ? <DenialBanner denial={denial} /> : null}

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
            disabledReason={!evidenceId ? "Enter the ID of the evidence record to destroy." : undefined}
            onClick={() => void create()}
          >
            {creating ? "Creating…" : "Create Request"}
          </Button>
        </div>
      </Card>

      <PageSection title="Destruction requests">
        {readFailed ? (
          <p data-destruction-queue-unreadable style={{ margin: 0, fontSize: 13, color: "#475569" }}>
            The destruction queue could not be read. This is not an empty queue —
            requests may be waiting that this page cannot show.
          </p>
        ) : (
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
        )}
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
