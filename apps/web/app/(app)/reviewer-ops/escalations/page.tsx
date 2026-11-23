"use client";

/**
 * Phase 25 — Escalation Console (Review hub → Monitoring → Escalations).
 *
 * Operator surface for the escalation lifecycle:
 *   - Filter by status / severity
 *   - Acknowledge / reassign / resolve / suppress
 *   - Link back to the review
 *   - Optional link to the operational incident
 *
 * TEAM-SPEC §2 item 7 / §3 (2026-11-23):
 *   - The default filter is "Active" (`status=ACTIVE`: open, acknowledged and
 *     reassigned), the same definition the SLA dashboard, analytics and the
 *     inspector use for "open escalation". It used to be exactly OPEN, so an
 *     acknowledged escalation counted on the SLA page and was missing here.
 *   - The API returns `total` under the same filters; the page says
 *     "Showing N of total".
 *   - The empty state names the filter ("No active escalations").
 *   - `?escalationId=` (from notifications and Operations rows) is honoured:
 *     the list opens on All, and the row is highlighted and scrolled to.
 *   - Links go through `reviewDestination`; no worker jargon in the copy.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

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
import { identifierLabel } from "@proovra/shared";
import { escalationReasonLabel } from "../../../../lib/labels/governanceReviewLabels";
import { ReviewHubNav } from "../../../../components/reviewer-experience/ReviewHubNav";
import { useReviewDestinationResolver } from "../../../../components/reviewer-experience/reviewDestination";
import {
  ESCALATION_STATUS_FILTERS,
  type EscalationStatusFilter,
} from "../../../../components/reviewer-experience/monitoringDisplay";

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


const SEVERITY_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "All severities" },
  { value: "INFO", label: "Info" },
  { value: "WARNING", label: "Warning" },
  { value: "HIGH", label: "High" },
  { value: "CRITICAL", label: "Critical" },
];

const STATUS_LABEL: Record<EscalationStatus, string> = {
  OPEN: "Open",
  ACKNOWLEDGED: "Acknowledged",
  REASSIGNED: "Reassigned",
  RESOLVED: "Resolved",
  SUPPRESSED: "Suppressed",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PageRouteGate resolves `review.escalations`: PERSONAL_OR_ORG + the
// workspace's reviewer-operations entitlement (TEAM-SPEC R1). The inner
// component may run in a Team-entitled Personal Workspace or an organization.
export default function EscalationsConsolePage() {
  return (
    <PageRouteGate routeId="review.escalations">
      <EscalationsConsolePageInner />
    </PageRouteGate>
  );
}

function EscalationsConsolePageInner() {
  // The ACTIVE workspace (personal or organization), from the canonical envelope.
  const teamId = useActiveSpaceId();
  const searchParams = useSearchParams();
  const rawEscalationId = searchParams?.get("escalationId") ?? null;
  const focusEscalationId =
    rawEscalationId && UUID_RE.test(rawEscalationId) ? rawEscalationId : null;
  const resolveDestination = useReviewDestinationResolver();
  const inspectorDestination = resolveDestination("review.queue_detail");
  const operationsDestination = resolveDestination("workspace.operations");
  const [rows, setRows] = useState<EscalationProjection[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  // A deep link opens on All so the linked escalation is found whatever its state.
  const [status, setStatus] = useState<EscalationStatusFilter>(
    focusEscalationId ? "ALL" : "ACTIVE",
  );
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
  // Every read carries a generation; a slower response for an older filter is dropped.
  const loadGenerationRef = useRef(0);

  const load = useCallback(() => {
    if (!teamId) return;
    const generation = ++loadGenerationRef.current;
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    qs.set("status", status);
    if (severity) qs.set("severity", severity);
    qs.set("limit", "100");
    apiFetch(`/v1/reviewer-ops/escalations?${qs.toString()}`, {
      method: "GET",
    })
      .then((r: { escalations?: EscalationProjection[]; total?: number }) => {
        if (generation !== loadGenerationRef.current) return;
        const list = r.escalations ?? [];
        setRows(list);
        setTotal(typeof r.total === "number" && Number.isFinite(r.total) ? r.total : list.length);
        setError(null);
      })
      .catch((err: { message?: string }) => {
        if (generation !== loadGenerationRef.current) return;
        setError(toSafeUserError(err, { message: "Could not load escalations." }).message);
      });
  }, [teamId, status, severity]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  // Scroll the linked escalation into view once it is rendered.
  useEffect(() => {
    if (!focusEscalationId || !rows) return;
    const el = document.getElementById(`escalation-${focusEscalationId}`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center" });
    }
  }, [focusEscalationId, rows]);

  const act = useCallback(
    async (
      label: string,
      id: string,
      path: string,
      body: Record<string, unknown>,
    ): Promise<boolean> => {
      // PRO-R2-16 — true only on success, so the reason modal keeps its text on a refusal.
      if (!teamId) return false;
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
        return true;
      } catch (err) {
        setError(
          toSafeUserError(err, { message: `Could not ${label} the escalation.` }).message,
        );
        return false;
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

  // While the envelope is still hydrating, render the bounded loading shell.
  if (!teamId) {
    return (
      <PageShell
        data-escalations-loading
        header={
          <PageHeader
            eyebrow="Review"
            title="Escalations"
            subtitle="Loading workspace…"
          />
        }
      />
    );
  }

  const shown = rows?.length ?? 0;
  const linkedMissing =
    focusEscalationId !== null && rows !== null && !rows.some((r) => r.id === focusEscalationId);

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Review"
          title="Escalations"
          subtitle="Reviews that passed their SLA deadline or were raised by a person. Active escalations (open, acknowledged or reassigned) count toward SLA pressure; resolved and suppressed ones stay in the history."
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
      <ReviewHubNav active="monitoring" monitoringView="escalations" />

      <FilterBar>
        <FilterBar.Select
          label="Status"
          value={status}
          onChange={(v) => setStatus(v as EscalationStatusFilter)}
          options={ESCALATION_STATUS_FILTERS.map((s) => ({ value: s.value, label: s.label }))}
        />
        <FilterBar.Select
          label="Severity"
          value={severity}
          onChange={setSeverity}
          options={SEVERITY_FILTERS.map((s) => ({ value: s.value, label: s.label }))}
        />
      </FilterBar>

      {rows !== null && total !== null ? (
        <p className="app-field-help" data-escalations-count role="status">
          Showing {shown} of {total} escalation{total === 1 ? "" : "s"}.
          {status === "ACTIVE" ? " Active means open, acknowledged or reassigned." : ""}
        </p>
      ) : null}

      {linkedMissing ? (
        <Card variant="status" tone="info" data-escalation-link-missing>
          The linked escalation is not in this list. It may belong to another
          workspace or no longer be visible to you.
        </Card>
      ) : null}

      {error ? (
        <Card variant="status" tone="risk" role="alert">
          {error}
        </Card>
      ) : null}

      {/* Review automation only: a stale review automation pass is said here,
          in one line. Global service status lives in the header indicator. */}
      <RuntimeStatusBanner requires={["reviewAutomation"]} />

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
              <span
                id={`escalation-${e.id}`}
                data-escalation-row={e.id}
                data-escalation-highlighted={e.id === focusEscalationId ? "true" : undefined}
                style={
                  e.id === focusEscalationId
                    ? { display: "inline-flex", gap: 6, alignItems: "center" }
                    : undefined
                }
              >
                <Badge tone={severityTone(e.severity)} subtle>
                  {identifierLabel(e.severity)}
                </Badge>
                {e.id === focusEscalationId ? (
                  <Badge tone="info">Linked</Badge>
                ) : null}
              </span>
            ),
          },
          {
            key: "reason",
            header: "Reason",
            render: (e) => (
              <span className="app-table__muted">{escalationReasonLabel(e.reason)}</span>
            ),
          },
          {
            key: "status",
            header: "Status",
            render: (e) => (
              <Badge tone={statusTone(e.status)} subtle>
                {STATUS_LABEL[e.status] ?? identifierLabel(e.status)}
              </Badge>
            ),
          },
          {
            key: "summary",
            header: "Summary",
            render: (e) => (
              <>
                <div style={{ maxWidth: 360, fontSize: 12 }}>{e.safeSummary}</div>
                {e.incidentId && operationsDestination ? (
                  <a href={operationsDestination.href} style={{ fontSize: 12, color: "var(--ink-link)" }}>
                    View the related incident
                  </a>
                ) : null}
              </>
            ),
          },
          {
            key: "workflow",
            header: "Review",
            render: (e) =>
              inspectorDestination ? (
                <a
                  href={`/reviewer-ops/${encodeURIComponent(e.workflowId)}`}
                  style={{ color: "var(--ink-link)", textDecoration: "none", fontSize: 12 }}
                >
                  Open review
                </a>
              ) : (
                <span className="app-table__muted">—</span>
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
                onClick={() => act("acknowledge", e.id, "acknowledge", {})}
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
          <div style={{ padding: 20 }}>
            <NoEscalationsEmptyState filter={status} severityFiltered={severity !== ""} />
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
          let ok = false;
          if (kind === "ESCALATION_REASSIGN") {
            ok = await act("reassign", escalationId, "reassign", {
              newAssigneeUserId: reason,
            });
          } else if (kind === "ESCALATION_RESOLVE") {
            ok = await act("resolve", escalationId, "resolve", {
              resolutionNote: reason,
            });
          } else if (kind === "ESCALATION_SUPPRESS") {
            ok = await act("suppress", escalationId, "suppress", {
              suppressionReason: reason,
            });
          }
          if (ok) setReasonModal(null);
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
