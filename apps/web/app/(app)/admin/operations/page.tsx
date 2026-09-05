"use client";

/**
 * PLATFORM ADMIN — Operations (ADM-010, ADM-011, ADM-034).
 *
 * WHAT THIS REPLACES
 * ---------------------------------------------------------------------------
 * The platform incident feed used to live as one section of `/admin/security`,
 * a page that also carried tenant MFA policy, tenant security scans and a
 * tenant member-posture table. Two audiences, two scopes, one page (ADM-034).
 * Platform operations gets its own surface here; `/admin/security` keeps the
 * workspace security administration it actually is.
 *
 * WHAT IS NEW
 * ---------------------------------------------------------------------------
 * Incidents now carry their tenant (ADM-010) — the projection omitted `teamId`
 * entirely, so an operator looking at forty open incidents could not tell
 * whether they belonged to forty customers or to one — and they can now be
 * ACTED on (ADM-011). Acknowledge, resolve and assign previously existed only
 * as workspace-scoped endpoints that answer 404 to a cross-workspace id, so the
 * console could see every incident on the platform and act on none of them.
 *
 * A refused resolve is reported as a refusal, not as a failure: the canonical
 * lifecycle declines to close a condition whose own source still says it is
 * live, and that is the rule working rather than the button being broken.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import {
  PageShell,
  PageHeader,
  PageSection,
  FilterBar,
  DataTable,
  useToast,
  type DataTableColumn,
} from "../../../../components/ui";
import { Badge, type BadgeTone } from "../../../../components/ui/Badge";
import { Button, buttonSurfaceStyle } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { usePlatformContext } from "../../../../lib/platform-context";
import { PlatformSecurityEvents } from "./_sections/PlatformSecurityEvents";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { hasRunbook, resolveRunbookSlug } from "../../../../lib/runbooks/slugs.generated";
import { ResultCount } from "../../../../components/ui/ResultCount";

type IncidentRow = {
  id: string;
  teamId: string | null;
  scope: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  safeSummary: string;
  occurrenceCount: number;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  acknowledgedAtUtc: string | null;
  resolvedAtUtc: string | null;
  assignedOperatorUserId: string | null;
  runbookSlug: string | null;
  affected: {
    workspaceId: string;
    workspaceName: string;
    workspaceKind: string;
    workspaceLifecycle: "LIVE" | "CLOSED";
    customer: { id: string; name: string } | null;
  } | null;
};

type IncidentsResponse = {
  items: IncidentRow[];
  severityBreakdown: Record<string, number>;
  statusBreakdown: Record<string, number>;
  unresolvedCount: number;
  totalIncidents: number;
};

const SEVERITY_TONE: Record<string, BadgeTone> = {
  CRITICAL: "risk",
  HIGH: "risk",
  WARNING: "pending",
  INFO: "neutral",
};

const STATUS_TONE: Record<string, BadgeTone> = {
  OPEN: "risk",
  ACKNOWLEDGED: "pending",
  RESOLVED: "verified",
  SUPPRESSED: "neutral",
};

export default function AdminOperationsPage() {
  const { addToast } = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const { confirm } = useConfirmAction();
  // ADM-011 — "Assign to me" needs the operator's own id. It comes from the
  // platform context the whole app already resolves, never from a client-
  // supplied field: the server re-derives the actor from the session anyway,
  // so a spoofed id here would simply be ignored.
  const platform = usePlatformContext();
  const currentUserId = platform?.envelope?.user?.id ?? null;

  const [status, setStatus] = useState(params.get("status") ?? "OPEN");
  const [severity, setSeverity] = useState(params.get("severity") ?? "");
  const [teamId, setTeamId] = useState(params.get("teamId") ?? "");

  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [data, setData] = useState<IncidentsResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", "200");
      if (status) qs.set("status", status);
      if (severity) qs.set("severity", severity);
      if (teamId) qs.set("teamId", teamId);

      const res = (await apiFetch(
        `/v1/admin/incidents?${qs.toString()}`,
      )) as IncidentsResponse;
      setData(res ?? null);

      const shareable = new URLSearchParams(qs);
      shareable.delete("limit");
      router.replace(
        shareable.toString() ? `/admin/operations?${shareable.toString()}` : "/admin/operations",
        { scroll: false },
      );
    } catch (err) {
      addToast(
        toSafeUserError(err, { message: "We couldn't load platform operations." })
          .message,
        "error",
      );
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [addToast, status, severity, teamId, router]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, severity, teamId]);

  // ADM-017 — `?tab=security` means "you clicked the security-events number",
  // so land on that table rather than at the top of the incident feed.
  useEffect(() => {
    if (loading || params.get("tab") !== "security") return;
    document
      .getElementById("security")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [loading, params]);

  const runAction = useCallback(
    async (
      row: IncidentRow,
      action: "acknowledge" | "resolve" | "assign",
      body?: Record<string, unknown>,
    ) => {
      setBusyId(row.id);
      try {
        await apiFetch(`/v1/admin/incidents/${encodeURIComponent(row.id)}/${action}`, {
          method: "POST",
          body: JSON.stringify(body ?? {}),
        });
        addToast(
          action === "acknowledge"
            ? "Incident acknowledged."
            : action === "resolve"
              ? "Incident resolved."
              : body?.assigneeUserId
                ? "Incident assigned to you."
                : "Incident returned to the unassigned queue.",
          "success",
        );
        await load();
      } catch (err) {
        // A refused resolve is the lifecycle working: the condition's own source
        // still reports it live. Say that rather than "something went wrong".
        addToast(
          toSafeUserError(err, {
            message:
              action === "resolve"
                ? "This condition was not resolved. Its source still reports it as live, so the platform declined to close it."
                : action === "acknowledge"
                  ? "The incident could not be acknowledged."
                  : "The assignment could not be changed.",
          }).message,
          "error",
        );
      } finally {
        setBusyId(null);
      }
    },
    [addToast, load],
  );

  const columns = useMemo<DataTableColumn<IncidentRow>[]>(
    () => [
      {
        key: "title",
        header: "Condition",
        render: (r) => (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 620 }}>{r.title}</div>
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-muted)",
                marginTop: 2,
              }}
            >
              {r.category} · seen {r.occurrenceCount}× · last{" "}
              {formatUserDateTime(r.lastSeenAtUtc)}
            </div>
          </div>
        ),
      },
      {
        // ADM-010 — the whole point. This column did not exist because the
        // projection did not carry a tenant.
        key: "affected",
        header: "Affected",
        render: (r) => {
          if (!r.affected) {
            return (
              <span
                style={{ fontSize: 12, color: "var(--ink-muted)" }}
                title={`Scope: ${r.scope}`}
              >
                {r.scope === "PLATFORM" ? "Platform-wide" : "No owning workspace"}
              </span>
            );
          }
          return (
            <div style={{ minWidth: 0 }}>
              <Link href={`/admin/workspaces/${encodeURIComponent(r.affected.workspaceId)}`}>
                {r.affected.workspaceName}
              </Link>
              <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 2 }}>
                {r.affected.customer ? (
                  <Link href={`/admin/customers/${encodeURIComponent(r.affected.customer.id)}`}>
                    {r.affected.customer.name}
                  </Link>
                ) : (
                  "Self-service"
                )}
                {r.affected.workspaceLifecycle === "CLOSED" ? " · workspace closed" : ""}
              </div>
            </div>
          );
        },
      },
      {
        key: "severity",
        header: "Severity",
        render: (r) => (
          <Badge tone={SEVERITY_TONE[r.severity] ?? "neutral"}>{r.severity}</Badge>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (r) => (
          <Badge tone={STATUS_TONE[r.status] ?? "neutral"} dot>
            {r.status}
          </Badge>
        ),
      },
      {
        key: "assigned",
        header: "Assigned",
        render: (r) =>
          r.assignedOperatorUserId ? (
            <Link href={`/admin/users/${encodeURIComponent(r.assignedOperatorUserId)}`}>
              Assigned
            </Link>
          ) : (
            <span style={{ color: "var(--ink-muted)" }}>Unassigned</span>
          ),
      },
      {
        key: "actions",
        header: "Actions",
        // Declared as an ordinary column rather than via rowActions, so the
        // table's own no-wrap rule for the actions cell does not reach it.
        // Four buttons wrapping in a 352px column made every row 113px tall.
        render: (r) => (
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "nowrap",
              whiteSpace: "nowrap",
            }}
          >
            {r.status === "OPEN" ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busyId === r.id}
                aria-label={`Acknowledge "${r.title}"`}
                title="Marks the condition as seen by an operator. It stays open and can still be resolved or reassigned."
                onClick={() => void runAction(r, "acknowledge")}
              >
                Acknowledge
              </Button>
            ) : null}
            {r.status === "OPEN" || r.status === "ACKNOWLEDGED" ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busyId === r.id}
                onClick={async () => {
                  const ok = await confirm({
                    title: "Resolve this condition?",
                    description: `"${r.title}" affects ${
                      r.affected?.workspaceName ?? "no specific workspace"
                    }. The platform will refuse the resolve if the condition's own source still reports it as live.`,
                    confirmLabel: "Resolve",
                    tone: "warning",
                  });
                  if (ok) await runAction(r, "resolve");
                }}
              >
                Resolve
              </Button>
            ) : null}
            {/*
              ADM-011 — ASSIGN / UNASSIGN. One column, one transition, one gate:
              a null assignee IS the unassign, so there is no second endpoint
              whose authorization could drift from this one's.
            */}
            <Button
              size="sm"
              variant="ghost"
              disabled={busyId === r.id}
              aria-label={`${r.assignedOperatorUserId ? "Unassign" : "Assign to me"}: "${r.title}"`}
              title={
                r.assignedOperatorUserId
                  ? "Returns the condition to the unassigned queue. Nothing else changes."
                  : "Records you as the operator working this condition. Reversible with Unassign."
              }
              onClick={() =>
                void runAction(r, "assign", {
                  assigneeUserId: r.assignedOperatorUserId ? null : currentUserId,
                })
              }
            >
              {r.assignedOperatorUserId ? "Unassign" : "Assign to me"}
            </Button>
            {/* Only a slug with a runbook behind it gets a button. Most
                incident `runbookSlug` values are condition labels with no
                document, and the reader 404s an unknown slug by design — a
                Runbook button that dead-ends mid-incident is worse than no
                button. The old link pointed at `#<slug>`, an anchor the
                catalog never rendered, so it landed at the top of a list of
                thirty. */}
            {r.runbookSlug && hasRunbook(r.runbookSlug) ? (
              <Link
                href={`/admin/platform/runbooks/${resolveRunbookSlug(r.runbookSlug)}`}
                className="ui-button"
                data-variant="ghost"
                data-size="sm"
                style={buttonSurfaceStyle("ghost", "sm")}
              >
                Runbook
              </Link>
            ) : null}
          </div>
        ),
      },
    ],
    [busyId, runAction, confirm, currentUserId],
  );

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform control center"
          title="Operations"
          subtitle="Every operational condition on the platform, with the workspace and customer it affects. Acknowledge and resolve run through the same canonical lifecycle a workspace operator uses — including its refusal to close a condition whose source still reports it live."
          secondaryActions={
            <Button variant="secondary" onClick={() => void load()} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          }
        />
      }
        >

      {data ? (
        <PageSection title="Posture">
          <div className="admin-stat-grid">
            <div className="admin-stat">
              <div className="admin-stat-label">Unresolved</div>
              <div
                className="admin-stat-value"
                data-emphasis={data.unresolvedCount > 0 ? "critical" : undefined}
              >
                {data.unresolvedCount}
              </div>
              <div className="admin-stat-hint">Open + acknowledged</div>
            </div>
            {(["CRITICAL", "HIGH", "WARNING"] as const).map((s) => (
              <div className="admin-stat" key={s}>
                <div className="admin-stat-label">{s}</div>
                <div
                  className="admin-stat-value"
                  data-emphasis={
                    s === "CRITICAL" ? "critical" : s === "HIGH" ? "attention" : undefined
                  }
                >
                  {data.severityBreakdown[s] ?? 0}
                </div>
              </div>
            ))}
          </div>
        </PageSection>
      ) : null}

      <FilterBar
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus("OPEN");
              setSeverity("");
              setTeamId("");
            }}
          >
            Clear
          </Button>
        }
          >
        <FilterBar.Select
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: "All statuses" },
            { value: "OPEN", label: "Open" },
            { value: "ACKNOWLEDGED", label: "Acknowledged" },
            { value: "RESOLVED", label: "Resolved" },
            { value: "SUPPRESSED", label: "Suppressed" },
          ]}
        />
        <FilterBar.Select
          label="Severity"
          value={severity}
          onChange={setSeverity}
          options={[
            { value: "", label: "All severities" },
            { value: "CRITICAL", label: "Critical" },
            { value: "HIGH", label: "High" },
            { value: "WARNING", label: "Warning" },
            { value: "INFO", label: "Info" },
          ]}
        />
        <FilterBar.Search
          label="Workspace ID"
          value={teamId}
          onChange={setTeamId}
          placeholder="Filter by workspace…"
        />
      </FilterBar>

      <Card>
        <DataTable<IncidentRow>
          ariaLabel="Platform operational incidents"
          columns={columns}
          rows={data?.items ?? []}
          getRowId={(r) => r.id}
          loading={loading}
          emptyState={
            <EmptyState variant="inline"
              title="No conditions match"
              purpose="No operational condition matches the current filters. With the Status filter on Open, an empty table means nothing is currently open — not that nothing was measured."
            />
          }
        />
        {/* The request caps at 200. Without saying so, "200 incidents" reads
            as the total, and somebody counting open conditions during a
            review gets a confident wrong answer. */}
        <ResultCount
          shown={data?.items?.length ?? 0}
          cap={200}
          noun="condition"
          filtered={status !== "" || severity !== ""}
          loading={loading}
          data-testid="admin-operations-count"
        />
      </Card>

      <div id="security">
        <PlatformSecurityEvents />
      </div>
    </PageShell>
  );
}
