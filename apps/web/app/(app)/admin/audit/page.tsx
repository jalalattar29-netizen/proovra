"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { PageShell, PageHeader, PageSection, FilterBar } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../components/ui/Badge";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { ResultCount } from "../../../../components/ui/ResultCount";
import { apiFetch } from "../../../../lib/api";
import { useToast } from "../../../../components/ui";
import { notifyApiError } from "../../../../lib/feedback/notify";
import { useTenantGuard } from "../../../../lib/platform-context";
import { formatUtcAuditDateTime } from "../../../../lib/date";

/**
 * ONE PAGE OF THE LOG, AND THE CURSOR TO THE NEXT.
 *
 * The list read has accepted `cursor=` since it was written and this page
 * never sent one: it showed the newest 25 rows as full cards and offered no
 * way past them. Every row is still reachable — through Next/Previous over
 * the server's own cursor, not through a longer first page.
 */
type AuditPage = {
  items: AuditRow[];
  nextCursor: string | null;
  hasMore: boolean;
};

const PAGE_SIZE = 25;

type AuditRow = {
  id: string;
  userId: string | null;
  isPublic: boolean;
  action: string;
  category?: string | null;
  severity?: string | null;
  source?: string | null;
  outcome?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  requestId?: string | null;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: string;
  anchoredAt: string | null;
};

type VerifyState =
  | { valid: true; partial?: boolean; verifiedCount?: number }
  | { valid: false; brokenAt: string }
  | null;

const INK_PRIMARY = "var(--ink-primary, #0F172A)";
const INK_SECONDARY = "var(--ink-secondary, #475569)";
const INK_MUTED = "var(--ink-muted, #94a3b8)";
const BORDER_DEFAULT = "var(--border-default, #e2e8f0)";

function formatTimestamp(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return formatUtcAuditDateTime(value);
}

function prettyMetadataJson(metadata: unknown): string {
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return String(metadata);
  }
}

function severityTone(severity?: string | null): BadgeTone {
  const value = (severity ?? "").toLowerCase();
  if (value === "critical" || value === "high") return "risk";
  if (value === "medium" || value === "warning") return "pending";
  return "info";
}

function outcomeTone(outcome?: string | null): BadgeTone {
  const value = (outcome ?? "").toLowerCase();
  if (value === "failed" || value === "error" || value === "denied") return "risk";
  if (value === "warning" || value === "partial") return "pending";
  return "verified";
}

function dash(value: string | null | undefined): string {
  return value && value.trim() ? value : "—";
}

/**
 * THE LONG TAIL OF ONE ROW, shown only when asked for.
 *
 * Every entry used to be a card printing all of this — identifiers, flags and
 * the raw metadata preview — whether or not anyone wanted it, which is how
 * the log came to be nine screens tall. The row now carries what an operator
 * scans by; this carries what they investigate with.
 */
function AuditEntryDetails({ entry }: { entry: AuditRow }) {
  const facts: Array<[string, string]> = [
    ["Request ID", dash(entry.requestId)],
    ["Resource", `${dash(entry.resourceType)} · ${dash(entry.resourceId)}`],
    ["Source", dash(entry.source)],
    ["Category", dash(entry.category)],
    ["IP address", dash(entry.ipAddress)],
    ["Public / system", entry.isPublic ? "yes" : "no"],
    ["Anchored", entry.anchoredAt ? formatTimestamp(entry.anchoredAt) : "not anchored"],
  ];
  return (
    <div data-admin-audit-details={entry.id} style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "8px 16px",
          margin: 0,
          fontSize: 12.5,
          color: INK_SECONDARY,
        }}
      >
        {facts.map(([label, value]) => (
          <div key={label} style={{ minWidth: 0 }}>
            <dt style={{ fontSize: 11, color: INK_MUTED, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {label}
            </dt>
            <dd style={{ margin: "2px 0 0", color: INK_PRIMARY, overflowWrap: "anywhere" }}>{value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <div style={{ fontSize: 11, color: INK_MUTED, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Metadata
        </div>
        <pre
          style={{
            fontSize: 11,
            color: INK_SECONDARY,
            lineHeight: 1.5,
            marginTop: 4,
            marginBottom: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
            fontFamily: "ui-monospace, monospace",
            background: "var(--surface-card, #ffffff)",
            border: `1px solid ${BORDER_DEFAULT}`,
            borderRadius: 10,
            padding: 12,
          }}
        >
          {prettyMetadataJson(entry.metadata)}
        </pre>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: number;
  note: string;
  tone: BadgeTone;
}) {
  return (
    <Card padding="comfortable" style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: INK_MUTED,
        }}
      >
        {label}
      </div>
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontSize: 30,
            fontWeight: 750,
            letterSpacing: "-0.02em",
            color: INK_PRIMARY,
          }}
        >
          {value}
        </span>
        <Badge tone={tone} dot>
          {label}
        </Badge>
      </div>
      <div style={{ marginTop: 8, fontSize: 12.5, color: INK_SECONDARY, lineHeight: 1.6 }}>
        {note}
      </div>
    </Card>
  );
}

export default function AdminAuditPage() {
  const { addToast } = useToast();
  const [items, setItems] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [exporting, setExporting] = useState(false);
  // PHASE 12 — context-generation guard: an export that resolves after the
  // operator switched context must not produce a file from the old context.
  const { stamp, isStale } = useTenantGuard();
  const [verify, setVerify] = useState<VerifyState>(null);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [categoryFilter, setCategoryFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("");
  /**
   * The cursors that led to the current page, oldest first. Page one is the
   * empty stack; Previous pops it. The server issues the cursors, the page
   * only remembers the route it took.
   */
  const [cursors, setCursors] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const toggleExpanded = (id: string) => {
    setExpandedRows((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const isExpanded = (id: string) => Boolean(expandedRows[id]);

  const loadAudit = useCallback(async (cursor: string | null) => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      if (cursor) params.set("cursor", cursor);
      if (categoryFilter.trim()) params.set("category", categoryFilter.trim());
      if (severityFilter !== "all") params.set("severity", severityFilter);
      if (sourceFilter.trim()) params.set("source", sourceFilter.trim());
      const data = (await apiFetch(`/v1/admin/audit-log?${params.toString()}`)) as
        | Partial<AuditPage>
        | null;
      setItems(Array.isArray(data?.items) ? data.items : []);
      setNextCursor(typeof data?.nextCursor === "string" ? data.nextCursor : null);
      setHasMore(data?.hasMore === true);
      setExpandedRows({});
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      notifyApiError(addToast, err, { message: "We couldn't load the admin audit log." });
    } finally {
      setLoading(false);
    }
  }, [addToast, categoryFilter, severityFilter, sourceFilter]);

  const currentCursor = cursors.length > 0 ? cursors[cursors.length - 1] : null;

  const goNext = useCallback(() => {
    if (!nextCursor) return;
    setCursors((prev) => [...prev, nextCursor]);
    void loadAudit(nextCursor);
  }, [nextCursor, loadAudit]);

  const goPrevious = useCallback(() => {
    if (cursors.length === 0) return;
    const remaining = cursors.slice(0, -1);
    setCursors(remaining);
    void loadAudit(remaining.length > 0 ? remaining[remaining.length - 1] : null);
  }, [cursors, loadAudit]);

  /**
   * PHASE 12 — Admin audit export.
   *
   * Uses the ONE canonical export authority (`GET /v1/admin/audit-log/export`),
   * which applies the platform-admin gate and the row projection server-side and
   * returns CSV. Nothing is filtered or shaped in the browser.
   *
   * FILTER FIDELITY: the export sends the SAME filter set as the list read
   * above — category, severity and source. `source` is now honoured
   * database-side by the canonical `listAdminAuditLogs` query (PHASE 12 BATCH
   * A1); before that fix the backend silently ignored it, so the table and the
   * exported file could disagree. Both paths build their filters from the same
   * page state and hit the same authority, so they cannot diverge.
   */
  const exportAudit = useCallback(async () => {
    const captured = stamp();
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (categoryFilter.trim()) params.set("category", categoryFilter.trim());
      if (severityFilter !== "all") params.set("severity", severityFilter);
      if (sourceFilter.trim()) params.set("source", sourceFilter.trim());
      const qs = params.toString();
      const csv = await apiFetch(
        `/v1/admin/audit-log/export${qs ? `?${qs}` : ""}`,
        { method: "GET" },
      );
      // A context switch mid-export must not hand the operator a file built
      // from the previous context.
      if (isStale(captured)) return;
      const body = typeof csv === "string" ? csv : String(csv ?? "");
      const stampText = new Date().toISOString().replace(/[:.]/g, "-");
      const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `admin-audit-log-${stampText}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast("Audit log exported.", "success");
    } catch (err) {
      // A denial must produce NO file at all — the download only runs past a
      // successful response.
      notifyApiError(addToast, err, {
        message: "We couldn't export the admin audit log.",
      });
    } finally {
      setExporting(false);
    }
  }, [addToast, categoryFilter, severityFilter, sourceFilter, stamp, isStale]);

  const verifyChain = useCallback(async () => {
    try {
      setVerifying(true);
      const data = await apiFetch("/v1/admin/audit-log/verify?limit=1000");
      setVerify(data ?? null);
      addToast("Audit chain verification completed", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "We couldn't verify the audit chain." });
    } finally {
      setVerifying(false);
    }
  }, [addToast]);

  // A filter change is a NEW query, so it starts from page one: a cursor
  // issued under the old filters describes a position in a different list.
  useEffect(() => {
    setCursors([]);
    void loadAudit(null);
  }, [loadAudit]);

  useEffect(() => {
    void verifyChain();
  }, [verifyChain]);

  const summary = useMemo(() => {
    let publicCount = 0;
    let anchoredCount = 0;
    let failureCount = 0;
    let highSeverityCount = 0;

    for (const item of items) {
      if (item.isPublic) publicCount += 1;
      if (item.anchoredAt) anchoredCount += 1;

      const outcome = (item.outcome ?? "").toLowerCase();
      const severity = (item.severity ?? "").toLowerCase();

      if (outcome === "failed" || outcome === "error" || outcome === "denied") {
        failureCount += 1;
      }

      if (severity === "high" || severity === "critical") {
        highSeverityCount += 1;
      }
    }

    return {
      total: items.length,
      publicCount,
      anchoredCount,
      failureCount,
      highSeverityCount,
    };
  }, [items]);

  const filtered =
    categoryFilter.trim() !== "" || severityFilter !== "all" || sourceFilter.trim() !== "";

  const columns = useMemo<DataTableColumn<AuditRow>[]>(
    () => [
      {
        key: "createdAt",
        header: "When",
        nowrap: true,
        render: (entry) => (
          <span style={{ fontSize: 12.5, color: INK_MUTED }}>{formatTimestamp(entry.createdAt)}</span>
        ),
      },
      {
        key: "action",
        header: "Action",
        render: (entry) => (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 620, overflowWrap: "anywhere" }}>{entry.action}</div>
            <div style={{ fontSize: 12, color: INK_MUTED, overflowWrap: "anywhere" }}>
              {dash(entry.category)}
              {entry.source ? ` · ${entry.source}` : ""}
            </div>
          </div>
        ),
      },
      {
        key: "severity",
        header: "Severity",
        render: (entry) => <Badge tone={severityTone(entry.severity)}>{entry.severity ?? "info"}</Badge>,
      },
      {
        key: "outcome",
        header: "Outcome",
        render: (entry) => <Badge tone={outcomeTone(entry.outcome)}>{entry.outcome ?? "success"}</Badge>,
      },
      {
        key: "actor",
        header: "Actor",
        render: (entry) => (
          <span style={{ fontSize: 12.5, color: INK_SECONDARY, overflowWrap: "anywhere" }}>
            {entry.userId ?? "public/system"}
          </span>
        ),
      },
    ],
    [],
  );

  // Next/Previous over the SERVER's cursor. Disabled truthfully: Previous has
  // nothing to pop on page one, Next has nothing to follow when the server
  // said there is no more.
  const pager = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12.5, color: INK_MUTED }}>{`Page ${cursors.length + 1}`}</span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={loading || cursors.length === 0}
        onClick={goPrevious}
        data-testid="admin-audit-previous"
      >
        Previous
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={loading || !hasMore || !nextCursor}
        onClick={goNext}
        data-testid="admin-audit-next"
      >
        Next
      </Button>
    </div>
  );

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform admin"
          title="Audit Integrity"
          subtitle="Tamper-evident, hash-chained record of privileged admin actions with on-demand chain-integrity verification."
          secondaryActions={
            <Button variant="secondary" onClick={() => void loadAudit(currentCursor)}>
              Refresh
            </Button>
          }
          primaryAction={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button
                variant="secondary"
                data-admin-audit-export
                disabled={exporting}
                loading={exporting}
                onClick={() => void exportAudit()}
              >
                {exporting ? "Exporting…" : "Export CSV"}
              </Button>
              <Button variant="primary" onClick={() => void verifyChain()}>
                {verifying ? "Verifying..." : "Verify Chain"}
              </Button>
            </div>
          }
        />
      }
    >

      <div
        style={{
          fontSize: 13,
          color: INK_SECONDARY,
          lineHeight: 1.6,
        }}
      >
        This is the <strong style={{ color: INK_PRIMARY }}>tamper-evident admin audit log</strong> — a
        hash-chained record of privileged actions with chain-integrity verification. For the
        broader platform event feed (security events, incidents, org lifecycle, billing/team
        events), see the{" "}
        <Link
          href="/admin/timeline"
          style={{ color: "var(--accent-500, #7C3AED)", fontWeight: 700, textDecoration: "underline" }}
        >
          Global timeline
        </Link>
        . The timeline is a broader, non-tamper-evident operational feed; this page is the
        authoritative, verifiable admin audit trail.
      </div>

      <PageSection
        title="Audit summary"
        description="Rollup of the audit rows currently loaded in this view."
      >
        <div
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          }}
        >
          <SummaryCard
            label="Audit Entries"
            value={summary.total}
            note="Recent administrative actions currently visible in this log view."
            tone="info"
          />
          <SummaryCard
            label="Anchored Rows"
            value={summary.anchoredCount}
            note="Entries that include an anchor timestamp in the current result set."
            tone="verified"
          />
          <SummaryCard
            label="Failures"
            value={summary.failureCount}
            note="Requests marked with failed, denied, or error outcomes."
            tone="risk"
          />
          <SummaryCard
            label="High Severity"
            value={summary.highSeverityCount}
            note="Actions classified as high or critical severity."
            tone="risk"
          />
        </div>
      </PageSection>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 16,
        }}
      >
        <Card padding="comfortable" style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: INK_PRIMARY, letterSpacing: "-0.01em" }}>
            Chain Status
          </div>
          <div style={{ marginTop: 8, color: INK_SECONDARY, lineHeight: 1.6, fontSize: 13.5 }}>
            Verify whether the administrative audit chain is still intact and whether the
            currently checked segment passed validation.
          </div>

          <div style={{ display: "grid", gap: 14, marginTop: 18 }}>
            {verify === null ? (
              <div
                style={{
                  border: `1px solid ${BORDER_DEFAULT}`,
                  background: "var(--surface-muted, #f8fafc)",
                  borderRadius: 14,
                  padding: 16,
                  minWidth: 0,
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 700, color: INK_SECONDARY, overflowWrap: "anywhere" }}>
                  Verification unavailable
                </div>
                <div style={{ fontSize: 13, color: INK_MUTED, marginTop: 6, lineHeight: 1.6, overflowWrap: "anywhere" }}>
                  Chain status could not be determined yet. Refresh or re-run verification to
                  fetch the latest integrity result.
                </div>
              </div>
            ) : verify.valid ? (
              <div
                style={{
                  border: `1px solid ${BORDER_DEFAULT}`,
                  background: "var(--surface-muted, #f8fafc)",
                  borderRadius: 14,
                  padding: 16,
                  minWidth: 0,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: INK_PRIMARY, overflowWrap: "anywhere" }}>
                    Audit chain verified
                  </span>
                  <Badge tone="verified" dot>
                    Verified
                  </Badge>
                </div>
                <div style={{ fontSize: 13, color: INK_SECONDARY, marginTop: 6, lineHeight: 1.6, overflowWrap: "anywhere" }}>
                  {verify.partial ? "Tail verification" : "Full verification"}
                  {typeof verify.verifiedCount === "number"
                    ? ` · ${verify.verifiedCount} rows checked`
                    : ""}
                </div>
              </div>
            ) : (
              <div
                style={{
                  border: `1px solid ${BORDER_DEFAULT}`,
                  background: "var(--surface-muted, #f8fafc)",
                  borderRadius: 14,
                  padding: 16,
                  minWidth: 0,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: INK_PRIMARY, overflowWrap: "anywhere" }}>
                    Integrity issue detected
                  </span>
                  <Badge tone="risk" dot>
                    Broken
                  </Badge>
                </div>
                <div style={{ fontSize: 13, color: INK_SECONDARY, marginTop: 6, lineHeight: 1.6, overflowWrap: "anywhere" }}>
                  brokenAt: {verify.brokenAt}
                </div>
              </div>
            )}

            <div
              style={{
                border: `1px solid ${BORDER_DEFAULT}`,
                background: "var(--surface-muted, #f8fafc)",
                borderRadius: 14,
                padding: 16,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: INK_MUTED,
                }}
              >
                Current Snapshot
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 12,
                  marginTop: 12,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: INK_MUTED }}>Loaded rows</div>
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 20,
                      fontWeight: 750,
                      color: INK_PRIMARY,
                      letterSpacing: "-0.02em",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {summary.total}
                  </div>
                </div>

                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: INK_MUTED }}>Public/system</div>
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 20,
                      fontWeight: 750,
                      color: INK_PRIMARY,
                      letterSpacing: "-0.02em",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {summary.publicCount}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Card>

        <Card padding="comfortable" style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: INK_PRIMARY, letterSpacing: "-0.01em" }}>
            Audit Overview
          </div>
          <div style={{ marginTop: 8, color: INK_SECONDARY, lineHeight: 1.6, fontSize: 13.5 }}>
            Use this page to inspect administrative actions, review metadata, and quickly
            identify elevated severity or failed outcomes.
          </div>

          <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
            <div
              style={{
                border: `1px solid ${BORDER_DEFAULT}`,
                background: "var(--surface-muted, #f8fafc)",
                borderRadius: 14,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: INK_PRIMARY }}>
                What you can check here
              </div>
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  marginTop: 12,
                  fontSize: 13,
                  color: INK_SECONDARY,
                  lineHeight: 1.7,
                }}
              >
                <div>• action names and categories</div>
                <div>• outcome and severity markers</div>
                <div>• linked request, resource, and user identifiers</div>
                <div>• raw metadata for deeper investigation</div>
              </div>
            </div>

            <div
              style={{
                border: `1px solid ${BORDER_DEFAULT}`,
                background: "var(--surface-muted, #f8fafc)",
                borderRadius: 14,
                padding: 16,
              }}
            >
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Badge tone={severityTone("low")}>Low / Info</Badge>
                <Badge tone={severityTone("medium")}>Medium</Badge>
                <Badge tone={severityTone("high")}>High</Badge>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                <Badge tone={outcomeTone("success")}>Success</Badge>
                <Badge tone={outcomeTone("warning")}>Warning</Badge>
                <Badge tone={outcomeTone("failed")}>Failed</Badge>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <PageSection
        title="Recent Admin Actions"
        description="One line per audit row, newest first, in pages of 25. Open a row's details for its identifiers and raw metadata."
      >
        <FilterBar style={{ marginBottom: 16 }}>
          <FilterBar.Search
            label="Category"
            placeholder="Filter by category"
            value={categoryFilter}
            onChange={setCategoryFilter}
          />
          <FilterBar.Select
            label="Severity"
            value={severityFilter}
            onChange={setSeverityFilter}
            options={[
              { value: "all", label: "All severities" },
              { value: "info", label: "Info" },
              { value: "warning", label: "Warning" },
              { value: "critical", label: "Critical" },
            ]}
          />
          <FilterBar.Search
            label="Source"
            placeholder="Filter by source"
            value={sourceFilter}
            onChange={setSourceFilter}
          />
        </FilterBar>

        <DataTable<AuditRow>
          ariaLabel="Recent admin actions"
          density="compact"
          columns={columns}
          rows={items}
          getRowId={(entry) => entry.id}
          loading={loading}
          emptyState={
            <EmptyState
              title="No audit entries"
              purpose={
                filtered
                  ? "No audit entries match the current filters. Clear them to see the whole log."
                  : "No privileged admin actions have been recorded yet."
              }
            />
          }
          rowActions={(entry) => (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-expanded={isExpanded(entry.id)}
              data-admin-audit-details-toggle={entry.id}
              onClick={() => toggleExpanded(entry.id)}
            >
              {isExpanded(entry.id) ? "Hide details" : "Details"}
            </Button>
          )}
          expandedContent={(entry) =>
            isExpanded(entry.id) ? <AuditEntryDetails entry={entry} /> : null
          }
        />

        <ResultCount
          shown={items.length}
          hasMore={hasMore}
          noun="audit entry"
          pluralNoun="audit entries"
          filtered={filtered}
          loading={loading}
          failed={loadFailed}
          data-testid="admin-audit-count"
          action={pager}
        />
      </PageSection>
    </PageShell>
  );
}
