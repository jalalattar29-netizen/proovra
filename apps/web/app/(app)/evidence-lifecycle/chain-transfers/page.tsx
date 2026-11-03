"use client";

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { statusBadgeStyle } from "../../../../components/ui/StatusBadge";
import { apiFetch, isApiResponseError } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
import { LifecycleSectionBoundary } from "../_shared";
import { identifierLabel } from "@proovra/shared";
import { permissionDenialCopy } from "../../../../lib/labels/governanceReviewLabels";

type PermissionDenialState = { denial: string; permission: string | null } | null;

interface ChainTransfer {
  direction?: "OUTGOING" | "INCOMING";
  id: string;
  toOrganizationSlug: string;
  evidenceIds: string[];
  reasonNote?: string | null;
  state: string;
  createdAtUtc: string;
  updatedAtUtc: string;
}

function applyDenial(err: unknown, setDenial: (v: PermissionDenialState) => void): void {
  const e = err as { statusCode?: number; details?: Record<string, unknown> };
  const denial =
    e?.details && typeof e.details["denial"] === "string" ? e.details["denial"] : null;
  const permission =
    e?.details && typeof e.details["permission"] === "string"
      ? (e.details["permission"] as string)
      : null;
  if (
    e?.statusCode === 403 &&
    (denial === "ENTITLEMENT_REQUIRED" || denial === "PERMISSION_REQUIRED")
  ) {
    setDenial({ denial: denial as string, permission });
    return;
  }
  if (isApiResponseError(err)) {
    const d =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const p =
      err.details && typeof err.details["permission"] === "string"
        ? (err.details["permission"] as string)
        : null;
    if (
      err.statusCode === 403 &&
      (d === "ENTITLEMENT_REQUIRED" || d === "PERMISSION_REQUIRED")
    ) {
      setDenial({ denial: d, permission: p });
    }
  }
}

export default function ChainTransfersPage() {
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <LifecycleSectionBoundary label="Chain of Custody Transfers">
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
  const [transfers, setTransfers] = useState<ChainTransfer[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);

  // Create form state
  const [toOrganizationId, setToOrganizationId] = useState("");
  const [ownOrganizationId, setOwnOrganizationId] = useState<string | null>(null);
  const [evidenceIds, setEvidenceIds] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const res = (await apiFetch("/v1/exchange/chain-transfers", {
        method: "GET",
      })) as { transfers?: ChainTransfer[]; organizationId?: string | null } | null;
      setTransfers((res?.transfers ?? []) as ChainTransfer[]);
      setOwnOrganizationId(res?.organizationId ?? null);
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
        body: JSON.stringify({ toOrganizationId: toOrganizationId.trim(), evidenceIds: ids, reasonNote: reasonNote || null }),
      });
      setToOrganizationId("");
      setEvidenceIds("");
      setReasonNote("");
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setCreating(false);
    }
  }, [toOrganizationId, evidenceIds, reasonNote, refresh]);

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

  const columns: DataTableColumn<ChainTransfer>[] = [
    {
      key: "toOrganization",
      header: "To Organization",
      render: (t) => <code>{t.toOrganizationSlug}</code>,
    },
    { key: "evidenceCount", header: "Evidence Count", render: (t) => t.evidenceIds.length },
    { key: "reason", header: "Reason", render: (t) => t.reasonNote ?? "—" },
    {
      key: "state",
      header: "State",
      render: (t) => <span style={statusBadgeStyle(t.state)}>{identifierLabel(t.state)}</span>,
    },
    { key: "created", header: "Created", render: (t) => safeDate(t.createdAtUtc) },
  ];

  return (
    <PageShell
      data-chain-transfers-page
      header={
        <PageHeader
          eyebrow="Evidence Lifecycle"
          title="Chain of Custody Transfers"
          subtitle="Transfer custody of evidence to another organization with a full, tamper-evident chain-of-custody record."
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
          <strong>{permissionDenialCopy(denial.denial, denial.permission).title}</strong>{" "}
          {permissionDenialCopy(denial.denial, denial.permission).detail}
        </div>
      ) : null}

      {/* Create form */}
      <Card variant="admin" title="Create Transfer">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            Receiving organization ID
            <input
              style={inputStyle}
              value={toOrganizationId}
              onChange={(e) => setToOrganizationId(e.target.value)}
              placeholder="Ask the receiving organization for its ID"
            />
          </label>
          <label style={labelStyle}>
            Evidence IDs, separated by commas
            <input
              style={{ ...inputStyle, minWidth: 240 }}
              value={evidenceIds}
              onChange={(e) => setEvidenceIds(e.target.value)}
              placeholder="Paste evidence IDs"
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
          <Button
            type="button"
            variant="primary"
            loading={creating}
            disabled={creating || !toOrganizationId || !evidenceIds}
            disabledReason={
              !toOrganizationId
                ? "Enter the organization to transfer the evidence to."
                : !evidenceIds
                  ? "Enter at least one evidence ID."
                  : undefined
            }
            onClick={() => void create()}
          >
            {creating ? "Creating…" : "Create Transfer"}
          </Button>
        </div>
        {ownOrganizationId ? (
          <p style={{ fontSize: 12, marginTop: 8 }}>
            To receive a transfer, give the sender your organization ID: <code>{ownOrganizationId}</code>
          </p>
        ) : null}
      </Card>

      <PageSection title="Chain-of-custody transfers">
        <DataTable<ChainTransfer>
          ariaLabel="Chain of custody transfers"
          columns={columns}
          rows={transfers}
          getRowId={(t) => t.id}
          rowActions={(t) => (
            <span style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {t.state === "INITIATED" && t.direction === "INCOMING" && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void doAction(t.id, "accept")}
                  >
                    Accept
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void doAction(t.id, "reject")}
                  >
                    Reject
                  </Button>
                </>
              )}
              {t.state === "INITIATED" && t.direction !== "INCOMING" && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void doAction(t.id, "revoke")}
                >
                  Revoke
                </Button>
              )}
              {t.state === "ACCEPTED" && t.direction !== "INCOMING" && (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => void doAction(t.id, "complete")}
                >
                  Complete
                </Button>
              )}
            </span>
          )}
          emptyState={
            <EmptyState
              title="No chain-of-custody transfers"
              purpose="Create a transfer above to hand custody of evidence to another organization with a tamper-evident chain-of-custody record."
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
