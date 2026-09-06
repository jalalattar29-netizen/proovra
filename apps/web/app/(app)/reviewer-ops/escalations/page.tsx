"use client";

/**
 * Phase 25 — Escalation Console.
 *
 * Operator surface for the escalation lifecycle:
 *   - Filter by status / severity / reason
 *   - Acknowledge / reassign / resolve / suppress
 *   - Link back to the workflow workspace
 *   - Optional link to the Phase 21 operational incident
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  NoEscalationsEmptyState,
  RuntimeStatusBanner,
} from "../../../../components/operational";
import {
  ReviewerReasonModal,
  type ReviewerReasonKind,
} from "../components/ReviewerReasonModal";
import { formatCellDateTime } from "../../../../lib/date";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge, type BadgeTone } from "../../../../components/ui/Badge";
import { severityTone } from "../../../../components/ui/StatusBadge";
import { DataTable } from "../../../../components/ui/DataTable";
import { FilterBar } from "../../../../components/ui/FilterBar";

type EscalationStatus =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "REASSIGNED"
  | "RESOLVED"
  | "SUPPRESSED";

type EscalationProjection = {
  id: string;
  teamId: string;
  workflowId: string;
  evidenceId: string | null;
  reason: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  status: EscalationStatus;
  safeSummary: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAtUtc: string | null;
  resolvedAtUtc: string | null;
  resolutionNote: string | null;
  suppressedAtUtc: string | null;
  suppressionReason: string | null;
  assignedToUserId: string | null;
  incidentId: string | null;
};

const STATUS_FILTERS: (EscalationStatus | "ALL")[] = [
  "OPEN",
  "ACKNOWLEDGED",
  "REASSIGNED",
  "RESOLVED",
  "SUPPRESSED",
  "ALL",
];

const SEVERITY_FILTERS = ["", "INFO", "WARNING", "HIGH", "CRITICAL"];

// Phase 38.10 — wrap in canonical PageRouteGate. `review.escalations`
// is organization-only; the gate renders the structured "Create or
// switch organization" panel for personal-space users, so the inner
// component is guaranteed an active organization id.
export default function EscalationsConsolePage() {
  return (
    <PageRouteGate routeId="review.escalations">
      <EscalationsConsolePageInner />
    </PageRouteGate>
  );
}

function EscalationsConsolePageInner() {
  // PageRouteGate guarantees an active ORGANIZATION space at this
  // point. We still read the id from the canonical envelope.
  const teamId = useActiveSpaceId();
  const [rows, setRows] = useState<EscalationProjection[] | null>(null);
  const [status, setStatus] = useState<EscalationStatus | "ALL">("OPEN");
  const [severity, setSeverity] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Phase 2.4 — structured reason modal replaces 3 window.prompt calls
  // (reassign / resolve / suppress). `reasonModal` holds the kind +
  // the escalation id the action targets.
  const [reasonModal, setReasonModal] = useState<{
    kind: ReviewerReasonKind;
    escalationId: string;
  } | null>(null);

  const load = useCallback(() => {
    if (!teamId) return;
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    qs.set("status", status);
    if (severity) qs.set("severity", severity);
    qs.set("limit", "100");
    apiFetch(`/v1/reviewer-ops/escalations?${qs.toString()}`, {
      method: "GET",
    })
      .then((r: { escalations: EscalationProjection[] }) => {
        setRows(r.escalations ?? []);
        setError(null);
      })
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load escalations." }).message),
      );
  }, [teamId, status, severity]);

  useEffect(() => {
    load();
  }, [load]);

  const act = useCallback(
    async (
      label: string,
      id: string,
      path: string,
      body: Record<string, unknown>,
    ) => {
      if (!teamId) return;
      setBusy(`${id}:${label}`);
      try {
        await apiFetch(
          `/v1/reviewer-ops/escalations/${encodeURIComponent(id)}/${path}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId, ...body }),
          },
        );
        load();
      } catch (err) {
        setError(
          toSafeUserError(err, { message: `Action "${label}" failed.` }).message,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

  // PageRouteGate guarantees ALLOWED state here. If the envelope is
  // still loading and teamId hasn't resolved yet, render the
  // bounded loading shell rather than crashing.
  if (!teamId) {
    return (
      <PageShell
        data-escalations-loading
        header={
          <PageHeader
            eyebrow="Review operations"
            title="Escalation Console"
            subtitle="Loading organization workspace…"
          />
        }
      />
    );
  }

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Review operations"
          title="Escalation Console"
          subtitle="Operator escalation lifecycle. Open / acknowledged / reassigned escalations affect workspace SLA pressure; resolved / suppressed escalations remain in history."
          primaryAction={
            <Button
              variant="secondary"
              onClick={load}
              disabled={busy !== null}
            >
              Refresh
            </Button>
          }
        />
      }
    >
      <FilterBar>
        <FilterBar.Select
          label="Status"
          value={status}
          onChange={(v) => setStatus(v as EscalationStatus | "ALL")}
          options={STATUS_FILTERS.map((s) => ({ value: s, label: s }))}
        />
        <FilterBar.Select
          label="Severity"
          value={severity}
          onChange={setSeverity}
          options={SEVERITY_FILTERS.map((s) => ({
            value: s,
            label: s || "All severities",
          }))}
        />
      </FilterBar>

      {error ? (
        <Card variant="status" tone="risk">
          {error}
        </Card>
      ) : null}

      {teamId ? (
        <RuntimeStatusBanner teamId={teamId} forDomains={["reviewer_ops"]} />
      ) : null}

      <DataTable
        ariaLabel="Escalations"
        loading={rows === null}
        rows={rows ?? []}
        getRowId={(e) => e.id}
        columns={[
          {
            key: "severity",
            header: "Severity",
            render: (e) => (
              <Badge tone={severityTone(e.severity)} subtle>
                {e.severity}
              </Badge>
            ),
          },
          {
            key: "reason",
            header: "Reason",
            render: (e) => (
              <span className="app-table__muted">{e.reason}</span>
            ),
          },
          {
            key: "status",
            header: "Status",
            render: (e) => (
              <Badge tone={statusTone(e.status)} subtle>
                {e.status}
              </Badge>
            ),
          },
          {
            key: "summary",
            header: "Summary",
            render: (e) => (
              <>
                <div style={{ maxWidth: 360, fontSize: 12 }}>
                  {e.safeSummary}
                </div>
                {e.incidentId ? (
                  <a href="/operations" style={{ fontSize: 12, color: "var(--ink-link)" }}>
                    incident {e.incidentId.slice(0, 8)}…
                  </a>
                ) : null}
              </>
            ),
          },
          {
            key: "workflow",
            header: "Workflow",
            render: (e) => (
              <a
                href={`/reviewer-ops/${encodeURIComponent(e.workflowId)}`}
                style={{
                  color: "var(--ink-link)",
                  textDecoration: "none",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: 12,
                }}
              >
                {e.workflowId.slice(0, 8)}…
              </a>
            ),
          },
          {
            key: "created",
            header: "Created",
            nowrap: true,
            render: (e) => (
              <span className="app-table__muted">{formatCellDateTime(e.createdAt)}</span>
            ),
          },
        ]}
        rowActions={(e) => (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, justifyContent: "flex-end" }}>
            {e.status === "OPEN" ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy !== null}
                onClick={() => act("ack", e.id, "acknowledge", {})}
              >
                Acknowledge
              </Button>
            ) : null}
            {!["RESOLVED", "SUPPRESSED"].includes(e.status) ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    setReasonModal({
                      kind: "ESCALATION_REASSIGN",
                      escalationId: e.id,
                    })
                  }
                  data-escalation-action-reassign
                >
                  Reassign
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    setReasonModal({
                      kind: "ESCALATION_RESOLVE",
                      escalationId: e.id,
                    })
                  }
                  data-escalation-action-resolve
                >
                  Resolve
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    setReasonModal({
                      kind: "ESCALATION_SUPPRESS",
                      escalationId: e.id,
                    })
                  }
                  data-escalation-action-suppress
                >
                  Suppress
                </Button>
              </>
            ) : null}
          </div>
        )}
        emptyState={
          // Phase 28-G — actionable enterprise empty state.
          <div style={{ padding: 20 }}>
            <NoEscalationsEmptyState />
          </div>
        }
      />

      {/* Phase 2.4 — structured reason modal for reassign / resolve /
          suppress. Replaces 3 window.prompt calls. */}
      <ReviewerReasonModal
        kind={reasonModal?.kind ?? null}
        open={reasonModal !== null}
        onCancel={() => setReasonModal(null)}
        onSubmit={async (reason) => {
          if (!reasonModal) return;
          const { kind, escalationId } = reasonModal;
          if (kind === "ESCALATION_REASSIGN") {
            await act("reassign", escalationId, "reassign", {
              newAssigneeUserId: reason,
            });
          } else if (kind === "ESCALATION_RESOLVE") {
            await act("resolve", escalationId, "resolve", {
              resolutionNote: reason,
            });
          } else if (kind === "ESCALATION_SUPPRESS") {
            await act("suppress", escalationId, "suppress", {
              suppressionReason: reason,
            });
          }
          setReasonModal(null);
        }}
      />
    </PageShell>
  );
}

function statusTone(status: EscalationStatus): BadgeTone {
  switch (status) {
    case "OPEN":
      return "risk";
    case "ACKNOWLEDGED":
      return "pending";
    case "REASSIGNED":
      return "info";
    case "RESOLVED":
      return "verified";
    case "SUPPRESSED":
    default:
      return "neutral";
  }
}
