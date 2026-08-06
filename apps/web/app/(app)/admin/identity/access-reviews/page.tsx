"use client";

/**
 * PHASE 12B — Access reviews.
 *
 *   GET  /v1/identity/access-reviews
 *   POST /v1/identity/access-reviews/regenerate
 *   POST /v1/identity/access-reviews/:id/decision
 *
 * The certification queue: periodic and triggered reviews of who still needs
 * the access they hold. Three things changed in this pass:
 *
 *   1. REGENERATE is wired. An administrator can rebuild the queue on demand
 *      (stale access, unused service accounts, expiring temporary access) and
 *      is told how many NEW items were created — never a silent refresh.
 *   2. The decision payload now matches the server contract (`decision`, one of
 *      KEEP / SUSPEND_MEMBER / REVOKE_MEMBER / NO_ACTION / CANCEL). It
 *      previously sent a `status` field the API never read, so decisions were
 *      rejected as invalid.
 *   3. Denials are distinct from emptiness: a workspace without the access-review
 *      entitlement, or an operator without the capability, sees an explicit
 *      refusal instead of "no campaigns".
 *
 * The workspace is SERVER-derived (the API resolves it from the active
 * workspace and echoes it back); responses landing after a workspace switch are
 * dropped.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  classifyFailure,
  isStepUpCancel,
  type RowResult,
  type SurfaceFailure,
} from "../_sections/identity-admin-shared";
import {
  formatDateTime,
  inputStyle,
  mutedStyle,
  statusBadgeStyle,
} from "../ui-tokens";
import { PageShell, PageHeader, PageSection } from "../../../../../components/ui/PageShell";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
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

/** Server decision vocabulary → operator wording. */
const DECISIONS = [
  {
    decision: "KEEP",
    label: "Certify",
    tone: "secondary" as const,
    noteRequired: false,
    confirm:
      "You are certifying that this access is still needed. The decision is recorded against your identity.",
  },
  {
    decision: "SUSPEND_MEMBER",
    label: "Suspend",
    tone: "secondary" as const,
    noteRequired: true,
    confirm:
      "The subject's access stops immediately and their sessions are revoked. The held role is preserved so they can be restored.",
  },
  {
    decision: "REVOKE_MEMBER",
    label: "Revoke",
    tone: "destructive" as const,
    noteRequired: true,
    confirm:
      "The subject's access is removed for good. Re-admitting them requires a new invitation.",
  },
  {
    decision: "NO_ACTION",
    label: "No action",
    tone: "ghost" as const,
    noteRequired: true,
    confirm:
      "The review is closed without a change. Record why, so the next reviewer understands the context.",
  },
] as const;

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
  const { stamp, isStale } = useTenantGuard();
  const { confirm } = useConfirmAction();

  const [reviews, setReviews] = useState<ReadonlyArray<AccessReview> | null>(
    null,
  );
  const [statusFilter, setStatusFilter] = useState<string>("PENDING");
  const [failure, setFailure] = useState<SurfaceFailure | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [rowResult, setRowResult] = useState<RowResult | null>(null);
  const [note, setNote] = useState("");
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenNotice, setRegenNotice] = useState<string | null>(null);
  const [regenFailure, setRegenFailure] = useState<SurfaceFailure | null>(null);

  const load = useCallback(async () => {
    const captured = stamp();
    setFailure(null);
    try {
      const qs = new URLSearchParams();
      if (statusFilter) qs.set("status", statusFilter);
      const res = await apiFetch(
        `/v1/identity/access-reviews${qs.toString() ? `?${qs.toString()}` : ""}`,
        { method: "GET" },
      );
      if (isStale(captured)) return;
      setReviews((res?.accessReviews ?? []) as ReadonlyArray<AccessReview>);
    } catch (err) {
      if (isStale(captured)) return;
      setReviews([]);
      setFailure(classifyFailure(err, "Unable to load the access-review queue."));
    }
  }, [statusFilter, stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const regenerate = useCallback(async () => {
    const ok = await confirm({
      title: "Regenerate the review queue?",
      description:
        "The platform re-scans this workspace for access that needs certifying — stale memberships, unused service accounts, expiring temporary access — and adds any newly-detected items. Existing decisions are untouched.",
      confirmLabel: "Regenerate queue",
      tone: "warning",
      testId: "identity-access-review-regenerate",
    });
    if (!ok) return;
    const captured = stamp();
    setRegenBusy(true);
    setRegenFailure(null);
    setRegenNotice(null);
    try {
      const res = await apiFetch("/v1/identity/access-reviews/regenerate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (isStale(captured)) return;
      const created = Number((res as { created?: number })?.created ?? 0);
      setRegenNotice(
        created === 0
          ? "No new review items — nothing in this workspace currently needs certifying."
          : `${created} new review item${created === 1 ? "" : "s"} added to the queue.`,
      );
      await load();
    } catch (err) {
      if (isStale(captured)) return;
      setRegenFailure(
        classifyFailure(err, "Could not regenerate the review queue."),
      );
    } finally {
      if (!isStale(captured)) setRegenBusy(false);
    }
  }, [confirm, load, stamp, isStale]);

  const decide = useCallback(
    async (review: AccessReview, option: (typeof DECISIONS)[number]) => {
      if (option.noteRequired && note.trim().length === 0) {
        setRowResult({
          rowId: review.id,
          ok: false,
          message:
            "This decision needs a note. Record why before applying it — the note is part of the audit record.",
        });
        return;
      }
      const ok = await confirm({
        title: `${option.label} this access?`,
        description: option.confirm,
        confirmLabel: option.label,
        tone: option.decision === "REVOKE_MEMBER" ? "danger" : "warning",
        testId: `identity-access-review-${option.decision.toLowerCase()}`,
      });
      if (!ok) return;
      const captured = stamp();
      setBusyRow(review.id);
      setRowResult(null);
      try {
        await apiFetch(
          `/v1/identity/access-reviews/${encodeURIComponent(review.id)}/decision`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              decision: option.decision,
              ...(note.trim() ? { decisionNote: note.trim().slice(0, 2000) } : {}),
            }),
          },
        );
        if (isStale(captured)) return;
        setRowResult({
          rowId: review.id,
          ok: true,
          message: `Recorded: ${option.label}.`,
        });
        setNote("");
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        if (isStepUpCancel(err)) return;
        setRowResult({
          rowId: review.id,
          ok: false,
          message: classifyFailure(err, "Could not record the decision.").message,
        });
      } finally {
        if (!isStale(captured)) setBusyRow(null);
      }
    },
    [note, confirm, load, stamp, isStale],
  );

  if (!teamId) {
    return (
      <PageShell
        header={
          <PageHeader eyebrow="Identity operations" title="Access reviews" />
        }
      >
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
      render: (r) => (
        <div data-access-review-row={r.id}>
          <span style={{ ...mutedStyle, fontSize: 11 }}>{r.kind}</span>
          {rowResult && rowResult.rowId === r.id ? (
            <div
              data-access-review-result={rowResult.ok ? "ok" : "failed"}
              style={{
                ...mutedStyle,
                color: rowResult.ok ? "#065f46" : "#991b1b",
              }}
            >
              {rowResult.message}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <span style={statusBadgeStyle(r.status.split("_")[0] ?? r.status)}>
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
          {(r.subjectUserId ?? r.subjectApiCredentialId ?? "").slice(0, 8)}…
        </code>
      ),
    },
    {
      key: "initiated",
      header: "Initiated",
      nowrap: true,
      render: (r) => (
        <span style={mutedStyle}>{formatDateTime(r.initiatedAtUtc)}</span>
      ),
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
      data-access-reviews-page
      header={
        <PageHeader
          eyebrow="Identity operations"
          title="Access reviews"
          subtitle="Periodic and triggered certification of the access people and machines still hold. Every decision is recorded in the immutable audit trail with your identity and the subject's."
          contextStrip={
            <Link href="/admin/identity" style={{ fontSize: 12 }}>
              ← Back to identity administration
            </Link>
          }
          primaryAction={
            <Button
              variant="enterprise"
              data-access-review-regenerate
              loading={regenBusy}
              disabled={regenBusy}
              onClick={() => void regenerate()}
            >
              Regenerate queue
            </Button>
          }
          secondaryActions={
            <Button variant="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          }
        />
      }
    >
      {failure ? (
        <Card
          variant="status"
          tone="risk"
          padding="compact"
          data-access-reviews-failure={failure.kind}
        >
          <strong>
            {failure.kind === "denied"
              ? "Not available to you"
              : failure.kind === "blocked"
                ? "Refused"
                : "Could not load"}
          </strong>
          <div style={{ marginTop: 4 }}>{failure.message}</div>
        </Card>
      ) : null}

      {regenFailure ? (
        <Card
          variant="status"
          tone="risk"
          padding="compact"
          data-access-review-regenerate-failure={regenFailure.kind}
        >
          {regenFailure.message}
        </Card>
      ) : null}
      {regenNotice ? (
        <Card
          variant="status"
          tone="verified"
          padding="compact"
          data-access-review-regenerate-notice
        >
          {regenNotice}
        </Card>
      ) : null}

      <PageSection>
        <FilterBar>
          <FilterBar.Select
            label="Status"
            showLabel
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUS_OPTIONS.map((s) => ({
              value: s,
              label: s ? s.toLowerCase().replace(/_/g, " ") : "All statuses",
            }))}
          />
        </FilterBar>

        <Card variant="admin" padding="compact" style={{ marginTop: 12 }}>
          <label
            htmlFor="access-review-note"
            style={{ ...mutedStyle, display: "block", marginBottom: 4 }}
          >
            Decision note — required for Suspend, Revoke and No action. Applied
            to the next decision you record.
          </label>
          <input
            id="access-review-note"
            data-access-review-note
            style={{ ...inputStyle, maxWidth: 560 }}
            value={note}
            maxLength={2000}
            placeholder="e.g. contractor rolled off, confirmed with the engagement lead"
            onChange={(e) => setNote(e.target.value)}
          />
        </Card>

        <div style={{ marginTop: 12 }} data-access-reviews-table>
          <DataTable<AccessReview>
            columns={columns}
            rows={(reviews ?? []) as AccessReview[]}
            getRowId={(r) => r.id}
            loading={reviews === null}
            ariaLabel="Access reviews"
            emptyState={
              failure ? (
                <EmptyState
                  title="Access reviews unavailable"
                  purpose={failure.message}
                />
              ) : (
                <EmptyState
                  title="Nothing to certify"
                  purpose="No access reviews match this filter. Regenerate the queue to re-scan for stale access, unused service accounts and expiring temporary access."
                />
              )
            }
            rowActions={(r) =>
              r.status === "PENDING" || r.status === "IN_PROGRESS" ? (
                <div
                  style={{
                    display: "flex",
                    gap: 4,
                    flexWrap: "wrap",
                    justifyContent: "flex-end",
                  }}
                >
                  {DECISIONS.map((option) => (
                    <Button
                      key={option.decision}
                      variant={option.tone}
                      size="sm"
                      data-access-review-decision={`${r.id}:${option.decision}`}
                      disabled={busyRow === r.id}
                      onClick={() => void decide(r, option)}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              ) : null
            }
          />
        </div>
      </PageSection>
    </PageShell>
  );
}
