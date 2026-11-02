"use client";

import { useCallback, useEffect, useState } from "react";

import {
  identifierLabel,
  type DestructionCertificateProjection,
  type DestructionRequestProjection,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { statusBadgeStyle } from "../../../../components/ui/StatusBadge";
import { RecordPicker } from "../../../../components/governance/RecordPicker";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { apiFetch } from "../../../../lib/api";
import { useTeamId } from "../../../../lib/platform-context";
import { formatUserDate } from "../../../../lib/date";
import {
  DenialBanner,
  LifecycleSectionBoundary,
  resolveLifecycleError,
  type LifecycleDenial,
} from "../_shared";

/**
 * GOV-008 — the API's own shape. This page was written against a different
 * contract: it read evidenceId, updatedAtUtc and certificateUrl, none of which
 * exist, and offered Approve for a PENDING state the API never returns.
 */
type DestructionRequest = DestructionRequestProjection;
type Approver = { userId: string; label: string };

function certificateSummary(certificate: DestructionCertificateProjection): string {
  const records = certificate.evidenceCount === 1 ? "1 record" : `${certificate.evidenceCount} records`;
  return `${records} verified destroyed · ${certificate.certificateHash.slice(0, 16)}…`;
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
  const [approverUserId, setApproverUserId] = useState("");
  const [approvers, setApprovers] = useState<Approver[] | null>(null);
  const [creating, setCreating] = useState(false);
  const teamId = useTeamId();
  const stepUp = useStepUpAction({ teamId });

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    setReadFailed(false);
    try {
      const res = (await apiFetch("/v1/lifecycle/destruction/requests", {
        method: "GET",
      })) as { requests?: DestructionRequest[] } | null;
      setRequests((res?.requests ?? []) as DestructionRequest[]);
      // Only someone who can request needs this list, so its refusal is not a
      // refusal of the page: the form simply cannot offer anyone.
      const eligible = (await apiFetch("/v1/lifecycle/destruction/eligible-approvers", {
        method: "GET",
      }).catch(() => null)) as { approvers?: Approver[] } | null;
      setApprovers(eligible?.approvers ?? null);
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
        body: JSON.stringify({
          evidenceIds: [evidenceId],
          reason: reason.trim(),
          requiredApproverUserIds: [approverUserId],
        }),
      });
      setEvidenceId("");
      setReason("");
      setApproverUserId("");
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setCreating(false);
    }
  }, [evidenceId, reason, approverUserId, refresh]);

  const doAction = useCallback(
    async (id: string, action: "approve" | "reject" | "execute") => {
      setDenial(null);
      try {
        const send = (headers?: Record<string, string>) =>
          apiFetch(`/v1/lifecycle/destruction/requests/${id}/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify(action === "reject" ? { reason: "Rejected by the approver." } : {}),
          });
        // Approving and executing take a fresh factor (SEC-03).
        await (action === "reject" ? send() : stepUp.runStepUpAction(send));
        await refresh();
      } catch (err) {
        if ((err as { code?: string })?.code === "STEP_UP_CANCEL") return;
        applyDenial(err, setDenial);
      }
    },
    [refresh, stepUp],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const columns: DataTableColumn<DestructionRequest>[] = [
    {
      key: "records",
      header: "Records",
      render: (r) => (
        <span data-destruction-request-row={r.id}>
          {r.evidenceIds.length === 1 ? "1 record" : `${r.evidenceIds.length} records`}
        </span>
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
    { key: "created", header: "Created", render: (r) => safeDate(r.createdAt) },
    {
      key: "certificate",
      header: "Certificate",
      render: (r) => (r.certificate ? certificateSummary(r.certificate) : "—"),
    },
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
          <RecordPicker
            kind="evidence"
            evidenceScope="trash"
            label="Record in the trash"
            value={evidenceId}
            onChange={setEvidenceId}
          />
          <label style={labelStyle}>
            Reason
            <input
              style={inputStyle}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this record should be destroyed"
            />
          </label>
          <label style={labelStyle}>
            Approver
            <select
              style={inputStyle}
              value={approverUserId}
              onChange={(e) => setApproverUserId(e.target.value)}
            >
              <option value="">Choose a second person</option>
              {(approvers ?? []).map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="primary"
            loading={creating}
            disabled={creating || !evidenceId || !reason.trim() || !approverUserId}
            disabledReason={
              !evidenceId
                ? "Choose the record to destroy."
                : !reason.trim()
                  ? "Say why this record should be destroyed."
                  : !approverUserId
                    ? approvers && approvers.length === 0
                      ? "Nobody else in this workspace can approve destruction. Grant that to a second person first."
                      : "Choose who approves this. It cannot be you."
                    : undefined
            }
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
              {r.state === "REQUESTED" && (
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
              {(r.state === "APPROVED" || r.state === "FAILED") && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => void doAction(r.id, "execute")}
                >
                  {r.state === "FAILED" ? "Execute again" : "Execute"}
                </Button>
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
      <StepUpModal control={stepUp} />
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
