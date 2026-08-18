"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { PageShell, PageHeader, PageSection, FilterBar, Skeleton } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../components/ui/Badge";
import { apiFetch } from "../../../../lib/api";
import { useToast } from "../../../../components/ui";
import { notifyApiError } from "../../../../lib/feedback/notify";
import { useTenantGuard } from "../../../../lib/platform-context";
import AdminConsoleNav from "../../../../components/admin/AdminConsoleNav";
import { formatUtcAuditDateTime } from "../../../../lib/date";

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

function metadataPreview(metadata: unknown): string {
  const raw = prettyMetadataJson(metadata).replace(/\s+/g, " ").trim();
  if (raw.length <= 180) return raw;
  return `${raw.slice(0, 180)}…`;
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

  const toggleExpanded = (id: string) => {
    setExpandedRows((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const isExpanded = (id: string) => Boolean(expandedRows[id]);

  const loadAudit = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.set("limit", "25");
      if (categoryFilter.trim()) params.set("category", categoryFilter.trim());
      if (severityFilter !== "all") params.set("severity", severityFilter);
      if (sourceFilter.trim()) params.set("source", sourceFilter.trim());
      const data = await apiFetch(`/v1/admin/audit-log?${params.toString()}`);
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      notifyApiError(addToast, err, { message: "We couldn't load the admin audit log." });
    } finally {
      setLoading(false);
    }
  }, [addToast, categoryFilter, severityFilter, sourceFilter]);

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

  useEffect(() => {
    void loadAudit();
    void verifyChain();
  }, [loadAudit, verifyChain]);

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

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform admin"
          title="Audit Integrity"
          subtitle="Tamper-evident, hash-chained record of privileged admin actions with on-demand chain-integrity verification."
          secondaryActions={
            <Button variant="secondary" onClick={() => void loadAudit()}>
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
      <AdminConsoleNav />

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
        description="Latest audit rows with expandable metadata, consistent status badges, and quick visual scanning for important events."
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

        {loading ? (
          <div style={{ display: "grid", gap: 12 }}>
            <Skeleton width="100%" height="120px" />
            <Skeleton width="100%" height="120px" />
            <Skeleton width="100%" height="120px" />
          </div>
        ) : items.length === 0 ? (
          <div style={{ color: INK_MUTED }}>No audit entries found.</div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {items.map((entry) => (
              <Card key={entry.id} padding="comfortable" style={{ minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 16,
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    minWidth: 0,
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: INK_PRIMARY,
                        letterSpacing: "-0.01em",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {entry.action}
                    </div>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                      <Badge tone={severityTone(entry.severity)}>{entry.severity ?? "info"}</Badge>
                      <Badge tone={outcomeTone(entry.outcome)}>{entry.outcome ?? "success"}</Badge>
                      <Badge tone="neutral">{entry.category ?? "uncategorized"}</Badge>
                    </div>

                    <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
                      <div style={{ fontSize: 12.5, color: INK_SECONDARY, lineHeight: 1.6, overflowWrap: "anywhere" }}>
                        user: {entry.userId ?? "public/system"} · ip: {entry.ipAddress ?? "—"}
                      </div>
                      <div style={{ fontSize: 12.5, color: INK_SECONDARY, lineHeight: 1.6, overflowWrap: "anywhere" }}>
                        request: {entry.requestId ?? "—"} · resource: {entry.resourceType ?? "—"} · id:{" "}
                        {entry.resourceId ?? "—"}
                      </div>
                      <div style={{ fontSize: 12.5, color: INK_SECONDARY, lineHeight: 1.6, overflowWrap: "anywhere" }}>
                        source: {entry.source ?? "—"} · public: {entry.isPublic ? "yes" : "no"} · anchored:{" "}
                        {entry.anchoredAt ? formatTimestamp(entry.anchoredAt) : "—"}
                      </div>
                    </div>

                    <div
                      style={{
                        marginTop: 12,
                        border: `1px solid ${BORDER_DEFAULT}`,
                        background: "var(--surface-muted, #f8fafc)",
                        borderRadius: 12,
                        padding: 14,
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: 12.5, color: INK_SECONDARY, lineHeight: 1.6, overflowWrap: "anywhere" }}>
                        {isExpanded(entry.id)
                          ? "Full metadata shown below."
                          : metadataPreview(entry.metadata)}
                      </div>

                      <div style={{ marginTop: 10 }}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => toggleExpanded(entry.id)}
                        >
                          {isExpanded(entry.id) ? "Hide metadata" : "Show metadata"}
                        </Button>
                      </div>

                      {isExpanded(entry.id) ? (
                        <pre
                          style={{
                            fontSize: 11,
                            color: INK_SECONDARY,
                            lineHeight: 1.5,
                            marginTop: 10,
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
                      ) : null}
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: INK_MUTED, whiteSpace: "nowrap", flexShrink: 0 }}>
                    {formatTimestamp(entry.createdAt)}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}
