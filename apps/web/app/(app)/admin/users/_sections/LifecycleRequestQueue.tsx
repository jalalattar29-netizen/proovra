"use client";

/**
 * PLATFORM ADMIN — account closure / data-export queue (ADM-031).
 *
 * `AccountClosureRequest` and `AccountDataExportRequest` are both real, both
 * driven by their own state machines, and both were invisible to Platform
 * Admin: an operator could not see who had asked for erasure or for their data,
 * which is a compliance-relevant blind spot rather than a convenience gap.
 *
 * READ-ONLY, deliberately. Each machine owns its own cooling-off window, blocker
 * preflight and cron execution. An admin button that wrote a status directly
 * would be the "direct DB state hacking from UI" this remediation forbids — and
 * it would be a second authority over a lifecycle that already has one.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import {
  PageSection,
  FilterBar,
  DataTable,
  useToast,
  type DataTableColumn,
} from "../../../../../components/ui";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";
import { Card } from "../../../../../components/ui/Card";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

type Row = {
  kind: "CLOSURE" | "DATA_EXPORT";
  id: string;
  userId: string;
  userEmail: string | null;
  status: string;
  requestedAtUtc: string;
  completedAtUtc: string | null;
  failureCode: string | null;
  detail: string | null;
};

type Response = {
  closure: Array<{
    id: string;
    userId: string;
    userEmail: string | null;
    status: string;
    reason: string | null;
    requestedAtUtc: string;
    coolingOffEndsAtUtc: string | null;
    completedAtUtc: string | null;
    cancelledAtUtc: string | null;
    failureCode: string | null;
    blockers: string | null;
  }>;
  dataExport: Array<{
    id: string;
    userId: string;
    userEmail: string | null;
    status: string;
    requestedAtUtc: string;
    completedAtUtc: string | null;
    expiresAtUtc: string | null;
    failureCode: string | null;
    downloadCount: number;
  }>;
};

const STATUS_TONE: Record<string, BadgeTone> = {
  REQUESTED: "pending",
  COOLING_OFF: "pending",
  SCHEDULED: "pending",
  PROCESSING: "info",
  BLOCKED: "risk",
  FAILED: "risk",
  COMPLETED: "verified",
  READY: "verified",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
};

export function LifecycleRequestQueue() {
  const { addToast } = useToast();
  const [kind, setKind] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ kind, limit: "100" });
      const res = (await apiFetch(
        `/v1/admin/lifecycle-requests?${qs.toString()}`,
      )) as Response;

      const merged: Row[] = [
        ...(res.closure ?? []).map((c) => ({
          kind: "CLOSURE" as const,
          id: c.id,
          userId: c.userId,
          userEmail: c.userEmail,
          status: c.status,
          requestedAtUtc: c.requestedAtUtc,
          completedAtUtc: c.completedAtUtc,
          failureCode: c.failureCode,
          detail:
            c.status === "BLOCKED" && c.blockers
              ? "Blocked — see blockers"
              : c.coolingOffEndsAtUtc
                ? `Cooling off until ${formatUserDateTime(c.coolingOffEndsAtUtc)}`
                : c.reason,
        })),
        ...(res.dataExport ?? []).map((e) => ({
          kind: "DATA_EXPORT" as const,
          id: e.id,
          userId: e.userId,
          userEmail: e.userEmail,
          status: e.status,
          requestedAtUtc: e.requestedAtUtc,
          completedAtUtc: e.completedAtUtc,
          failureCode: e.failureCode,
          detail: e.expiresAtUtc
            ? `Expires ${formatUserDateTime(e.expiresAtUtc)} · ${e.downloadCount} download${e.downloadCount === 1 ? "" : "s"}`
            : null,
        })),
      ].sort((a, b) => b.requestedAtUtc.localeCompare(a.requestedAtUtc));

      setRows(merged);
    } catch (err) {
      addToast(
        toSafeUserError(err, {
          message: "We couldn't load the lifecycle request queue.",
        }).message,
        "error",
      );
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [addToast, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<Row>[] = [
    {
      key: "kind",
      header: "Request",
      render: (r) => (
        <Badge tone={r.kind === "CLOSURE" ? "risk" : "info"} subtle>
          {r.kind === "CLOSURE" ? "Account closure" : "Data export"}
        </Badge>
      ),
    },
    {
      key: "subject",
      header: "Person",
      render: (r) => (
        <Link href={`/admin/users/${encodeURIComponent(r.userId)}`}>
          {r.userEmail ?? "View person"}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Badge tone={STATUS_TONE[r.status] ?? "neutral"} dot>
            {r.status}
          </Badge>
          {r.failureCode ? (
            <Badge tone="risk" subtle>
              {r.failureCode}
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: "detail",
      header: "Detail",
      render: (r) => (
        <span style={{ fontSize: 12.5, color: "var(--ink-secondary, #475569)" }}>
          {r.detail ?? "—"}
        </span>
      ),
    },
    {
      key: "requestedAtUtc",
      header: "Requested",
      nowrap: true,
      render: (r) => formatUserDateTime(r.requestedAtUtc),
    },
  ];

  return (
    <PageSection
      title="Account lifecycle requests"
      description="Closure and data-export requests across the platform. Read-only — each request is driven by its own state machine with a cooling-off window and a blocker preflight, and this console never writes their status directly."
    >
      <FilterBar>
        <FilterBar.Select
          label="Request type"
          value={kind}
          onChange={setKind}
          options={[
            { value: "ALL", label: "All requests" },
            { value: "CLOSURE", label: "Account closure" },
            { value: "DATA_EXPORT", label: "Data export" },
          ]}
        />
      </FilterBar>

      <Card>
        <DataTable<Row>
          ariaLabel="Account lifecycle requests"
          columns={columns}
          rows={rows}
          getRowId={(r) => `${r.kind}:${r.id}`}
          loading={loading}
          emptyState={
            <EmptyState
              title="No lifecycle requests"
              purpose="Nobody has an outstanding account-closure or data-export request. This is a real zero, not an unmeasured signal."
            />
          }
        />
      </Card>
    </PageSection>
  );
}
