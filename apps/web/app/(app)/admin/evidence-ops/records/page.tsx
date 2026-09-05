"use client";

/**
 * PLATFORM ADMIN — Evidence health drill-down (ADM-029, ADM-019).
 *
 * THE PAGE THAT DID NOT EXIST
 * ---------------------------------------------------------------------------
 * Every evidence-health figure was a terminal scalar: "TSA failures: 34" with
 * no way to learn whose evidence had failed. And global search, on finding a
 * piece of evidence, sent the operator to `/admin/evidence-ops` — a page of
 * global counters that had discarded the record id entirely.
 *
 * This surface answers both: `?signal=…` enumerates a failure population,
 * `?evidenceId=…` resolves one record, and every row names the workspace and
 * customer it belongs to.
 *
 * WHAT IS NOT HERE, DELIBERATELY
 * ---------------------------------------------------------------------------
 * Evidence content. No file, no storage key, no hash, no signature, no internal
 * notes — the API's projection excludes them and this page could not render
 * them if it tried. Platform-operations visibility and evidence-content
 * authorization are separate grants, and a platform-admin gate does not merge
 * them.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import {
  PageShell,
  PageHeader,
  FilterBar,
  DataTable,
  useToast,
  type DataTableColumn,
} from "../../../../../components/ui";
import { AdmFacts, AdmId } from "../../../../../components/admin/AdminSurfaces";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";
import { Button, buttonSurfaceStyle } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { resolveRunbookSlug } from "../../../../../lib/runbooks/slugs.generated";
import { useUrlFilterSync } from "../../../../../lib/use-url-filter-sync";

type RecordRow = {
  id: string;
  title: string | null;
  type: string;
  status: string;
  verificationStatus: string | null;
  tsaStatus: string | null;
  otsStatus: string | null;
  createdAt: string;
  workspace: {
    id: string;
    name: string;
    kind: string;
    lifecycle: "LIVE" | "CLOSED";
  } | null;
  customer: { id: string; name: string } | null;
  ownerEmail: string | null;
  /**
   * ADM-013 — the row's OWN cohort, from its own columns rather than from the
   * filter it arrived through. In the "All affected" list the two halves need
   * opposite handling, so a row that does not say which half it is in is a row
   * the operator has to guess about.
   */
  cohort: string | null;
  ageDays: number;
  /** Last pipeline change. NOT "last retry" — no per-record attempt log exists. */
  lastChangeAtUtc: string | null;
  retryable: boolean;
  notRetryableReason: string | null;
  operatorAction: string;
  runbookSlug: string | null;
};

type Response = {
  signal: string | null;
  cohort: string | null;
  label: string;
  items: RecordRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

const SIGNALS = [
  { value: "", label: "— none (filter by cohort instead) —" },
  { value: "TSA_FAILED", label: "Timestamp (TSA) failures" },
  { value: "OTS_FAILED", label: "OpenTimestamps anchoring failures" },
  { value: "HASH_MISMATCH", label: "Hash mismatch" },
  { value: "VERIFICATION_FAILED", label: "Verification failed" },
  { value: "SIGNED_NO_REPORT", label: "Signed, no report" },
  { value: "REPORTED_NO_PACKAGE", label: "Reported, no package" },
] as const;

/**
 * ADM-013 — the overlapping cohorts, from the same predicates the summary tiles
 * count with. A SIGNAL asks "which failure"; a COHORT asks "which population,
 * counted once". They are different questions and the filter offers both.
 */
const COHORTS = [
  { value: "", label: "— none (filter by signal instead) —" },
  { value: "ALL_AFFECTED", label: "All affected (union, counted once)" },
  { value: "TSA_FAILED_ONLY", label: "Timestamp failed only" },
  { value: "SIGNED_NO_REPORT_ONLY", label: "Signed without a report only" },
  { value: "BOTH", label: "Both conditions" },
  { value: "RETRYABLE", label: "Retryable" },
  { value: "MANUAL_REVIEW", label: "Manual review" },
] as const;

const COHORT_SHORT: Record<string, string> = {
  TSA_FAILED_ONLY: "Timestamp only",
  SIGNED_NO_REPORT_ONLY: "Report only",
  BOTH: "Both",
};

const PAGE_SIZE = 50;

const STATUS_TONE: Record<string, BadgeTone> = {
  FAILED: "risk",
  CONFIRMED: "verified",
  PENDING: "pending",
};

export default function AdminEvidenceRecordsPage() {
  const { addToast } = useToast();
  const params = useSearchParams();

  const evidenceId = params.get("evidenceId") ?? "";
  // A cohort in the URL wins over the signal default: the summary tiles link
  // here with `?cohort=…`, and silently substituting a signal would show a
  // different population than the tile that was clicked.
  const initialCohort = params.get("cohort") ?? "";
  const [cohort, setCohort] = useState(initialCohort);
  const [signal, setSignal] = useState(
    params.get("signal") ?? (initialCohort ? "" : "TSA_FAILED"),
  );
  const [teamId, setTeamId] = useState(params.get("teamId") ?? "");

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Response | null>(null);
  const [page, setPage] = useState(1);
  /** Which row has its detail open. One at a time: this is a reading pane,
      not a bulk expansion. */
  const [openRow, setOpenRow] = useState<string | null>(null);

  const load = useCallback(
    async (targetPage: number) => {
      // Clearing BOTH filters is not a query. The API refuses it rather than
      // enumerating every live record on the platform, and surfacing that
      // refusal as a toast would blame the operator for using the controls.
      if (!evidenceId && !cohort && !signal) {
        setData(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const qs = new URLSearchParams();
        qs.set("page", String(targetPage));
        qs.set("limit", String(PAGE_SIZE));
        // A direct record lookup is not a signal query — sending both would ask
        // "this record, but only if it also has that failure", which is not what
        // a search click means.
        if (evidenceId) qs.set("evidenceId", evidenceId);
        else {
          // A cohort and a signal can be combined — "the retryable half of the
          // TSA population" is a real question — but one of them must be
          // present or the API refuses rather than listing every record.
          if (cohort) qs.set("cohort", cohort);
          if (signal) qs.set("signal", signal);
        }
        if (teamId) qs.set("teamId", teamId);

        const res = (await apiFetch(
          `/v1/admin/evidence-health/records?${qs.toString()}`,
        )) as Response;
        setData(res ?? null);
        setPage(res?.page ?? targetPage);
      } catch (err) {
        addToast(
          toSafeUserError(err, {
            message: "We couldn't load the affected records.",
          }).message,
          "error",
        );
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [addToast, evidenceId, cohort, signal, teamId],
  );

  // A RECORD LOOKUP OWNS ITS OWN URL.
  //
  // In `?evidenceId=…` mode the cohort and the signal are not the query — the
  // record is — so nothing here manages the address bar and the inbound deep
  // link survives verbatim. Passing no managed keys is how that is said: the
  // sync computes a target identical to the current URL and issues nothing.
  // Otherwise the filters own it, from the filters rather than from the
  // response (see `lib/use-url-filter-sync.ts`).
  useUrlFilterSync(
    "/admin/evidence-ops/records",
    evidenceId ? {} : { cohort, signal, teamId },
  );

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cohort, signal, teamId, evidenceId]);

  const columns = useMemo<DataTableColumn<RecordRow>[]>(
    () => [
      {
        key: "record",
        header: "Record",
        render: (r) => (
          <div style={{ minWidth: 0 }}>
            <div className="adm-table__primary adm-table__truncate" title={r.title ?? undefined}>
              {r.title ?? "(untitled)"}
            </div>
            <AdmId value={r.id} label="evidence id" short />
          </div>
        ),
      },
      { key: "type", header: "Type", render: (r) => r.type },
      {
        key: "cohort",
        header: "Cohort",
        render: (r) =>
          r.cohort ? (
            <Badge tone={r.cohort === "BOTH" ? "risk" : "info"} subtle>
              {COHORT_SHORT[r.cohort] ?? r.cohort}
            </Badge>
          ) : (
            <span style={{ color: "var(--ink-muted)" }}>—</span>
          ),
      },
      {
        key: "status",
        header: "Pipeline status",
        render: (r) => <Badge tone="info" subtle>{r.status}</Badge>,
      },
      {
        key: "preservation",
        header: "Preservation",
        // One line. Three badges wrapping in a 115px column added 25px to
        // every row; the table already scrolls horizontally, which is the
        // right place for the width to come from.
        nowrap: true,
        render: (r) => (
          <div style={{ display: "flex", gap: 6, flexWrap: "nowrap" }}>
            {r.tsaStatus ? (
              <Badge tone={STATUS_TONE[r.tsaStatus] ?? "neutral"} subtle>
                TSA {r.tsaStatus}
              </Badge>
            ) : null}
            {r.otsStatus ? (
              <Badge tone={STATUS_TONE[r.otsStatus] ?? "neutral"} subtle>
                OTS {r.otsStatus}
              </Badge>
            ) : null}
            {r.verificationStatus ? (
              <Badge tone={STATUS_TONE[r.verificationStatus] ?? "neutral"} subtle>
                Verify {r.verificationStatus}
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        key: "workspace",
        header: "Workspace",
        render: (r) =>
          r.workspace ? (
            <div style={{ minWidth: 0 }}>
              <Link href={`/admin/workspaces/${encodeURIComponent(r.workspace.id)}`}>
                {r.workspace.name}
              </Link>
              <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 2 }}>
                {r.customer ? (
                  <Link href={`/admin/customers/${encodeURIComponent(r.customer.id)}`}>
                    {r.customer.name}
                  </Link>
                ) : (
                  "Self-service"
                )}
                {r.workspace.lifecycle === "CLOSED" ? " · closed" : ""}
              </div>
            </div>
          ) : (
            <span style={{ color: "var(--ink-muted)" }}>—</span>
          ),
      },
      {
        key: "owner",
        header: "Owner",
        render: (r) => (
          <span style={{ fontSize: 12.5 }}>{r.ownerEmail ?? "—"}</span>
        ),
      },
      {
        key: "createdAt",
        header: "Created",
        nowrap: true,
        render: (r) => (
          <div style={{ minWidth: 0 }}>
            <div>{formatUserDateTime(r.createdAt)}</div>
            {/* Age in whole days is what makes a backlog readable at a glance:
                a two-day failure and a nine-month failure are different
                problems and the timestamp alone does not say which. */}
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-muted)",
                marginTop: 2,
              }}
            >
              {r.ageDays} day{r.ageDays === 1 ? "" : "s"} old
            </div>
          </div>
        ),
      },
      {
        key: "lastChange",
        header: "Last change",
        nowrap: true,
        // Deliberately NOT "last attempt". There is no per-record attempt log,
        // and labelling `updatedAt` as a retry would describe a measurement
        // nobody takes.
        render: (r) =>
          r.lastChangeAtUtc ? (
            formatUserDateTime(r.lastChangeAtUtc)
          ) : (
            <span style={{ color: "var(--ink-muted)" }}>—</span>
          ),
      },
      {
        key: "action",
        header: "Required action",
        nowrap: true,
        render: (r) => (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Badge tone={r.retryable ? "info" : "neutral"} subtle>
              {r.retryable ? "Retryable" : "Manual"}
            </Badge>
            {r.runbookSlug ? (
              <Link
                href={`/admin/platform/runbooks/${resolveRunbookSlug(r.runbookSlug)}`}
                style={{ fontSize: 12.5 }}
              >
                Runbook
              </Link>
            ) : null}
          </div>
        ),
      },
    ],
    [],
  );

  /**
   * THE NARRATIVE, WHERE IT CAN BE READ.
   *
   * What to do about a record — and, when nothing can be done, WHY — is the
   * most useful thing on this page and the worst possible table cell. It had
   * 244px, wrapped to 331px, and made every row 348px tall while the column
   * itself sat past the container's horizontal scroll. Here it has the full
   * width of the table and one row is one line again.
   *
   * "You cannot retry this" with no reason is the message an operator
   * escalates about, so `notRetryableReason` travels with it. The reason comes
   * from the remediation registry, not from this page.
   */
  const detail = useCallback(
    (r: RecordRow) =>
      openRow === r.id ? (
        <div className="adm-stack" style={{ maxInlineSize: "84ch" }}>
          <div>
            <span className="adm-subhead">Required action</span>
            <p style={{ margin: "4px 0 0", fontSize: 13, lineHeight: 1.55 }}>
              {r.operatorAction}
            </p>
          </div>
          {!r.retryable && r.notRetryableReason ? (
            <div>
              <span className="adm-subhead">Why it cannot be retried</span>
              <p
                style={{
                  margin: "4px 0 0",
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  color: "var(--ink-secondary)",
                }}
              >
                {r.notRetryableReason}
              </p>
            </div>
          ) : null}
          <AdmFacts
            items={[
              { label: "Evidence id", value: <AdmId value={r.id} label="evidence id" /> },
              {
                label: "Workspace id",
                value: r.workspace ? (
                  <AdmId value={r.workspace.id} label="workspace id" />
                ) : (
                  <span className="adm-muted">Not recorded</span>
                ),
              },
            ]}
          />
        </div>
      ) : null,
    [openRow],
  );

  const total = data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Evidence health"
          title={evidenceId ? "Record lookup" : (data?.label ?? "Affected records")}
          subtitle={
            evidenceId
              ? "One evidence record, resolved by id. Operational metadata only — no file, no storage key, no hash and no signature is shown here or returned by the API."
              : "The evidence records behind one health signal, with the workspace and customer each belongs to. Operational metadata only — no evidence content."
          }
          secondaryActions={
            <>
              <Link
                href="/admin/evidence-ops"
                className="ui-button"
                data-variant="ghost"
                data-size="md"
                style={buttonSurfaceStyle("ghost")}
              >
                ← Evidence health
              </Link>
              <Button variant="secondary" onClick={() => void load(page)} disabled={loading}>
                Refresh
              </Button>
            </>
          }
        />
      }
      >

      {!evidenceId ? (
        <FilterBar
          /* "Filtered" here means narrowed BEYOND the page's own default
             view, which is the TSA_FAILED signal — so arriving on the
             default is not a filtered state and must not offer a reset that
             does nothing. A workspace narrowing always is. */
          filtered={cohort !== "" || signal !== "TSA_FAILED" || teamId !== ""}
          onReset={() => {
            setCohort("");
            setSignal("TSA_FAILED");
            setTeamId("");
          }}
        >
          <FilterBar.Select
            label="Cohort"
            value={cohort}
            onChange={setCohort}
            options={COHORTS.map((c) => ({ value: c.value, label: c.label }))}
          />
          <FilterBar.Select
            label="Failure signal"
            value={signal}
            onChange={setSignal}
            options={SIGNALS.map((s) => ({ value: s.value, label: s.label }))}
          />
          <FilterBar.Search
            label="Workspace ID"
            value={teamId}
            onChange={setTeamId}
            placeholder="Narrow to one workspace…"
          />
        </FilterBar>
      ) : null}

      {/* Which population this is, in words. A table of rows with no statement
          of what selected them is a table an operator reads as "everything". */}
      {!evidenceId && cohort ? (
        <Card variant="status" tone="info" padding="comfortable">
          <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
            <strong>{COHORTS.find((c) => c.value === cohort)?.label}</strong>
            {cohort === "ALL_AFFECTED" ? (
              <>
                {" "}— every affected record, counted once. This is a mixed
                population: the Cohort column says which half each row is in,
                and the two halves need opposite handling. Filter to Retryable
                or Manual review before acting in bulk.
              </>
            ) : (
              <>
                {" "}— the same predicate the summary tile counts with, so this
                list and that number cannot disagree.
              </>
            )}
            {signal ? (
              <>
                {" "}Narrowed further by the{" "}
                {SIGNALS.find((x) => x.value === signal)?.label ?? signal}{" "}
                signal.
              </>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card>
        <DataTable<RecordRow>
          ariaLabel="Affected evidence records"
          columns={columns}
          rows={data?.items ?? []}
          getRowId={(r) => r.id}
          loading={loading}
          expandedContent={detail}
          rowActions={(r) => (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={openRow === r.id}
              onClick={() => setOpenRow(openRow === r.id ? null : r.id)}
            >
              {openRow === r.id ? "Hide detail" : "What to do"}
            </Button>
          )}
          emptyState={
            <EmptyState variant="inline"
              title={
                evidenceId
                  ? "Record not found"
                  : !cohort && !signal
                    ? "Choose a cohort or a signal"
                    : "No affected records"
              }
              purpose={
                evidenceId
                  ? "No live evidence record matches that id. It may have been deleted."
                  : !cohort && !signal
                    ? "This page lists a specific population. Pick a cohort to see records counted once each, or a signal to see one failure type. It will not list every record on the platform."
                    : "No live evidence record currently matches this filter. An empty table here means zero, not unmeasured."
              }
            />
          }
        />

        {!evidenceId ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              fontSize: 13,
              color: "var(--ink-secondary)",
              marginTop: 16,
            }}
          >
            <span>
              {total === 0
                ? "No records"
                : `Showing ${rangeStart}–${rangeEnd} of ${total} record${total === 1 ? "" : "s"}`}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void load(page - 1)}
                disabled={loading || page <= 1}
              >
                Previous
              </Button>
              <span style={{ minWidth: 90, textAlign: "center" }}>
                Page {data?.totalPages === 0 ? 0 : page} of {data?.totalPages ?? 0}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void load(page + 1)}
                disabled={loading || page >= (data?.totalPages ?? 0)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </PageShell>
  );
}
