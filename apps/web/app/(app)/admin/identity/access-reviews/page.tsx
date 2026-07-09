"use client";

/**
 * Phase 26 — Access Reviews admin page.
 *
 * Lightweight wrapper around the existing Phase 17 access-review
 * service (`GET /v1/identity/access-reviews`). Displays the queue and
 * surfaces the certify / revoke decisions via the existing decision
 * route (`POST /v1/identity/access-reviews/:id/decision`).
 *
 * Phase 26 does NOT replace the underlying Phase 17 model; this page
 * gives operators a denser inspector.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import {
  errorBoxStyle,
  formatDateTime,
  mutedStyle,
  statusBadgeStyle,
} from "../ui-tokens";
import { PageShell, PageHeader, PageSection } from "../../../../../components/ui/PageShell";
import { Button } from "../../../../../components/ui/Button";
import { FilterBar } from "../../../../../components/ui/FilterBar";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";

type AccessReview = {
  id: string;
  kind: string;
  status: string;
  subjectKind: string;
  subjectUserId: string | null;
  subjectApiCredentialId: string | null;
  initiatedAtUtc: string;
  dueAtUtc: string | null;
  completedAtUtc: string | null;
  decisionNote: string | null;
};

const STATUS_OPTIONS = [
  "",
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED_KEEP",
  "COMPLETED_REVOKED",
  "COMPLETED_SUSPENDED",
  "COMPLETED_NO_ACTION",
  "CANCELLED",
];

export default function AccessReviewsPage() {
  const teamId = useTeamId();
  const [reviews, setReviews] = useState<AccessReview[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("PENDING");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  
const load = useCallback(() => {
    if (!teamId) return;
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    if (statusFilter) qs.set("status", statusFilter);
    apiFetch(`/v1/identity/access-reviews?${qs.toString()}`, { method: "GET" })
      .then(
        (r: { reviews?: AccessReview[]; items?: AccessReview[] }) => {
          setReviews(r.reviews ?? r.items ?? []);
          setError(null);
        },
      )
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load access reviews." }).message),
      );
  }, [teamId, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = useCallback(
    async (id: string, decision: string) => {
      if (!teamId) return;
      const note =
        decision === "COMPLETED_KEEP"
          ? window.prompt("Decision note (optional)") ?? ""
          : window.prompt("Decision note (required)") ?? "";
      if (decision !== "COMPLETED_KEEP" && !note) return;
      setBusy(id);
      try {
        await apiFetch(
          `/v1/identity/access-reviews/${encodeURIComponent(id)}/decision`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teamId,
              status: decision,
              decisionNote: note.slice(0, 2000),
            }),
          },
        );
        load();
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Could not record decision." }).message,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

  if (!teamId) {
    return (
      <PageShell header={<PageHeader eyebrow="Identity operations" title="Access Reviews" />}>
        <EmptyState
          framed
          title="No workspace selected"
          purpose="Switch to a workspace to view and act on its access-review queue."
        />
      </PageShell>
    );
  }

  const columns: DataTableColumn<AccessReview>[] = [
    {
      key: "kind",
      header: "Kind",
      render: (r) => <span style={{ ...mutedStyle, fontSize: 11 }}>{r.kind}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <span style={statusBadgeStyle(r.status.split("_")[0])}>
          {r.status.toLowerCase().replace(/_/g, " ")}
        </span>
      ),
    },
    {
      key: "subject",
      header: "Subject",
      render: (r) => (
        <code
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 11,
          }}
        >
          {r.subjectKind}{" "}
          {(r.subjectUserId ?? r.subjectApiCredentialId ?? "").slice(0, 12)}
          …
        </code>
      ),
    },
    {
      key: "initiated",
      header: "Initiated",
      nowrap: true,
      render: (r) => <span style={mutedStyle}>{formatDateTime(r.initiatedAtUtc)}</span>,
    },
    {
      key: "due",
      header: "Due",
      nowrap: true,
      render: (r) => <span style={mutedStyle}>{formatDateTime(r.dueAtUtc)}</span>,
    },
    {
      key: "note",
      header: "Note",
      render: (r) => (
        <span
          style={{
            ...mutedStyle,
            fontSize: 11,
            maxWidth: 240,
            display: "block",
          }}
        >
          {r.decisionNote ?? "—"}
        </span>
      ),
    },
  ];

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Identity operations"
          title="Access Reviews"
          subtitle="Periodic and triggered access reviews from the Phase 17 access-review queue. Certify, revoke, or suspend; every decision is audited via the immutable platform audit log."
          secondaryActions={
            <Button variant="secondary" onClick={load}>
              Refresh
            </Button>
          }
        />
      }
    >
      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      <PageSection>
        <FilterBar>
          <FilterBar.Select
            label="Status"
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUS_OPTIONS.map((s) => ({
              value: s,
              label: s || "All statuses",
            }))}
          />
        </FilterBar>
        <div style={{ marginTop: 12 }}>
          <DataTable
            columns={columns}
            rows={reviews ?? []}
            getRowId={(r) => r.id}
            loading={reviews === null}
            ariaLabel="Access reviews"
            emptyState={
              <EmptyState
                title="No access-review campaigns"
                purpose="No access reviews match this filter. Periodic and triggered reviews will appear here for certification."
              />
            }
            rowActions={(r) =>
              r.status === "PENDING" || r.status === "IN_PROGRESS" ? (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy === r.id}
                    onClick={() => decide(r.id, "COMPLETED_KEEP")}
                  >
                    Certify
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy === r.id}
                    onClick={() => decide(r.id, "COMPLETED_REVOKED")}
                  >
                    Revoke
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy === r.id}
                    onClick={() => decide(r.id, "COMPLETED_SUSPENDED")}
                  >
                    Suspend
                  </Button>
                </div>
              ) : null
            }
          />
        </div>
      </PageSection>
    </PageShell>
  );
}
