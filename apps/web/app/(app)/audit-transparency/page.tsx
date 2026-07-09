"use client";

/**
 * PROOVRA Phase 3B — Audit & Transparency Center.
 *
 * Bounded federated timeline across every audit-producing surface
 * (provider usage, corrections, redaction activity, policy audit,
 * video timeline, portal access). Operators + auditors filter by
 * bounded category + period.
 *
 * Phase 7C — VISUAL redesign only. Composes the shared PageShell /
 * PageHeader + FilterBar foundation. The federated timeline keeps its
 * bespoke <table> because each row carries the load-bearing
 * data-audit-transparency-row / -category-row contract attributes that
 * the DataTable primitive cannot express; it is restyled with design
 * tokens (tokenised surface, sticky header, hairline rows). Every
 * data-audit-transparency-* attribute and the bounded category
 * vocabulary are preserved verbatim.
 *
 * Hard rules:
 *   * NEVER PII. Bounded category vocabulary.
 *   * Reads through `/v1/audit-transparency`.
 *   * Capped at 500 rows per request.
 */

import { useCallback, useEffect, useState } from "react";

import {
  AUDIT_TRANSPARENCY_CATEGORIES,
  type AuditTransparencyCategory,
  type AuditTransparencyEntry,
} from "@proovra/shared";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../lib/api";
import { formatUtcAuditDateTime } from "../../../lib/date";
import {
  PageShell,
  PageHeader,
  PageSection,
  FilterBar,
} from "../../../components/ui";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";

export default function AuditTransparencyCenterPage() {
  return (
    <PageRouteGate routeId="workspace.audit_transparency">
      <AuditTransparencyShell />
    </PageRouteGate>
  );
}

function AuditTransparencyShell() {
  const [entries, setEntries] = useState<AuditTransparencyEntry[]>([]);
  const [category, setCategory] = useState<
    AuditTransparencyCategory | "ALL"
  >("ALL");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const url =
        category === "ALL"
          ? "/v1/audit-transparency?limit=200"
          : `/v1/audit-transparency?category=${category}&limit=200`;
      const res = await apiFetch(url, { method: "GET" });
      setEntries((res?.entries ?? []) as AuditTransparencyEntry[]);
    } catch {
      setEntries([]);
    } finally {
      setBusy(false);
    }
  }, [category]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Compliance"
          title="Audit & Transparency Center"
          subtitle="Federated audit timeline across PROOVRA's bounded activity tables. Bounded counts + bounded ids only — NEVER PII."
        />
      }
    >
      <div data-audit-transparency-center>
        <PageSection>
          <FilterBar
            data-audit-transparency-filter-bar
            actions={
              <Button
                variant="secondary"
                data-audit-transparency-refresh
                onClick={() => void refresh()}
                loading={busy}
                disabled={busy}
              >
                {busy ? "Loading…" : "Refresh"}
              </Button>
            }
          >
            <FilterBar.Select
              label="Category"
              showLabel
              data-audit-transparency-category
              value={category}
              onChange={(v) =>
                setCategory(v as AuditTransparencyCategory | "ALL")
              }
              options={[
                { value: "ALL", label: "All" },
                ...AUDIT_TRANSPARENCY_CATEGORIES.map((c) => ({
                  value: c,
                  label: c,
                })),
              ]}
            />
          </FilterBar>
        </PageSection>

        <PageSection>
          <div
            data-audit-transparency-table-wrap
            style={{
              background: "var(--surface-card, #ffffff)",
              border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
              borderRadius: "var(--radius-card, 14px)",
              overflowX: "auto",
            }}
          >
            <table
              data-audit-transparency-table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
                color: "var(--ink-primary, #0f172a)",
              }}
            >
              <thead>
                <tr>
                  <th style={th}>When</th>
                  <th style={th}>Category</th>
                  <th style={th}>Code</th>
                  <th style={th}>Label</th>
                  <th style={th}>Failure reason</th>
                  <th style={th}>Source</th>
                  <th style={th}>Actor</th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: 0 }}>
                      <EmptyState
                        compact
                        title="No activity in the selected window."
                        purpose="Audit entries across the selected category appear here as bounded, PII-free records."
                      />
                    </td>
                  </tr>
                ) : (
                  entries.map((e, idx) => {
                    const failureReason =
                      (e.payload as Record<string, unknown> | null)
                        ?.failureReason ??
                      (e.payload as Record<string, unknown> | null)?.reason ??
                      null;
                    return (
                      <tr
                        key={`${e.occurredAtUtc}:${e.code}:${idx}`}
                        data-audit-transparency-row={e.code}
                        data-audit-transparency-category-row={e.category}
                      >
                        <td style={td}>
                          {formatUtcAuditDateTime(e.occurredAtUtc)}
                        </td>
                        <td style={td}>
                          <code style={codeStyle}>{e.category}</code>
                        </td>
                        <td style={td}>
                          <code style={codeStyle}>{e.code}</code>
                        </td>
                        <td style={td}>{e.label}</td>
                        <td
                          style={td}
                          data-audit-transparency-failure-reason={String(
                            failureReason ?? "",
                          )}
                        >
                          {failureReason ? (
                            <code
                              style={{
                                ...codeStyle,
                                color: "var(--status-risk-fg, #b91c1c)",
                              }}
                            >
                              {String(failureReason).slice(0, 60)}
                            </code>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={td}>
                          <code style={codeStyle}>{e.sourceService}</code>
                        </td>
                        <td style={td}>
                          {e.actorUserId ? (
                            <code style={codeStyle}>
                              {e.actorUserId.slice(0, 8)}…
                            </code>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </PageSection>
      </div>
    </PageShell>
  );
}

const codeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
};

const th: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  textAlign: "left",
  padding: "10px 14px",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-muted, #94a3b8)",
  background: "var(--surface-header, #f8fafc)",
  borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
  verticalAlign: "middle",
};
