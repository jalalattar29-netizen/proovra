"use client";

/**
 * Phase P2.6 — Recovery operations dashboard.
 *
 * Consumes the P2.5 backend:
 *
 *   GET  /v1/operations/recovery
 *   POST /v1/operations/recovery/validate-backup
 *   POST /v1/operations/recovery/validate-restore   (step-up)
 *   GET  /v1/operations/recovery/reports
 *   GET  /v1/operations/recovery/reports/:id
 *
 * Sections:
 *   1. Readiness header — last backup / restore report + Object Lock mode.
 *   2. Unsupported domains panel — honest disclosure.
 *   3. Run-backup-validation button.
 *   4. Run-restore-validation button (step-up gated).
 *   5. Recent reports table + drawer.
 *
 * Hard rules:
 *   * Unsupported checks render with a distinct neutral badge.
 *     NEVER green.
 *   * No fake "everything healthy" copy. The dashboard always names
 *     the unsupported domains.
 *   * Restore validation requires step-up server-side; the UI
 *     surfaces the modal via `useStepUpAction`.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
} from "../../../../../components/ui/PageShell";
import "../admin-platform.css";
import { AccessGate } from "../../../../../components/access/AccessGate";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import {
  badgeStyle,
  cardStyle,
  formatDateTime,
  mutedStyle,
  primaryButtonStyle,
  successBoxStyle,
  tableStyle,
  tdStyle,
  thStyle,
  TOKENS,
} from "../../identity/ui-tokens";
import { ResultCount } from "../../../../../components/ui/ResultCount";

type ValidationOutcome = "passed" | "warning" | "failed" | "unsupported";

type ValidationCheck = {
  id: string;
  label: string;
  outcome: ValidationOutcome;
  detail: string;
  unsupported: boolean;
};

type RecoveryReportKind =
  | "backup_validation_report"
  | "restore_validation_report"
  | "recovery_readiness_report"
  | "missing_coverage_report";

type RecoveryValidationReport = {
  reportId: string;
  kind: RecoveryReportKind;
  teamId: string;
  startedAtUtc: string;
  finishedAtUtc: string;
  overallOutcome: ValidationOutcome;
  checks: ReadonlyArray<ValidationCheck>;
  unsupportedDomains: ReadonlyArray<string>;
  recommendedAction: string | null;
};

type ReadinessOverview = {
  readiness: {
    objectLockMode: string;
    lastBackupReport: {
      reportId: string;
      generatedAtUtc: string;
      outcome: ValidationOutcome | null;
    } | null;
    lastRestoreReport: {
      reportId: string;
      generatedAtUtc: string;
      outcome: ValidationOutcome | null;
    } | null;
    unsupportedDomains: ReadonlyArray<string>;
  };
  recentReports: ReadonlyArray<{
    reportId: string;
    kind: RecoveryReportKind;
    generatedAtUtc: string;
    outcome: ValidationOutcome | null;
  }>;
};

export default function OperationsRecoveryPage() {
  return (
    <PageRouteGate routeId="operations.recovery">
      <OperationsRecoveryContent />
    </PageRouteGate>
  );
}

function OperationsRecoveryContent() {
  const teamId = useTeamId();
  const stepUp = useStepUpAction({ teamId });
  const [overview, setOverview] = useState<ReadinessOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] =
    useState<RecoveryValidationReport | null>(null);

  const load = useCallback(() => {
    if (!teamId) return;
    setError(null);
    apiFetch(
      `/v1/operations/recovery?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: ReadinessOverview) => setOverview(r))
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load recovery overview." }).message),
      );
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const runBackup = useCallback(async () => {
    if (!teamId) return;
    setBusy("backup");
    setError(null);
    setSuccess(null);
    try {
      const r = (await apiFetch("/v1/operations/recovery/validate-backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId }),
      })) as { report: RecoveryValidationReport };
      setSelectedReport(r.report);
      setSuccess(
        `Backup validation completed (${r.report.overallOutcome}).`,
      );
      load();
    } catch (err) {
      setError(
        toSafeUserError(err, { message: "Backup validation failed." }).message,
      );
    } finally {
      setBusy(null);
    }
  }, [teamId, load]);

  const runRestore = useCallback(async () => {
    if (!teamId) return;
    setBusy("restore");
    setError(null);
    setSuccess(null);
    try {
      const r = (await stepUp.runStepUpAction(async (headers) => {
        return (await apiFetch("/v1/operations/recovery/validate-restore", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({ teamId }),
        })) as { report: RecoveryValidationReport };
      })) as { report: RecoveryValidationReport };
      setSelectedReport(r.report);
      setSuccess(
        `Restore validation completed (${r.report.overallOutcome}).`,
      );
      load();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        setError("Step-up cancelled — restore validation did not run.");
      } else {
        setError(
          toSafeUserError(err, { message: "Restore validation failed." }).message,
        );
      }
    } finally {
      setBusy(null);
    }
  }, [teamId, stepUp, load]);

  const openReport = useCallback(
    async (reportId: string) => {
      if (!teamId) return;
      try {
        const r = (await apiFetch(
          `/v1/operations/recovery/reports/${encodeURIComponent(
            reportId,
          )}?teamId=${encodeURIComponent(teamId)}`,
          { method: "GET" },
        )) as { report: RecoveryValidationReport };
        setSelectedReport(r.report);
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Could not load report." }).message,
        );
      }
    },
    [teamId],
  );

  const pageHeader = (
    <PageHeader
      eyebrow="Platform operations"
      title="Recovery Validation"
      subtitle={"What the PROOVRA application can validate at the application layer. Infrastructure-layer database backups, full disaster-recovery rehearsals, and cross-region failover live outside this surface and are listed below as unsupported domains. There are no fake blanket guarantees here."}
      secondaryActions={
        <>
          <button type="button" className="apf-control" onClick={load}>
          Refresh
          </button>
        </>
      }
    />
  );

  if (!teamId) {
    return (
      <PageShell width="full" header={pageHeader}>
        <AccessGate
          kind="WORKSPACE_REQUIRED"
          surface="Recovery"
          headline="Switch to a workspace to view recovery readiness"
          reason="Recovery validation is workspace-scoped."
          actions={[
            { label: "Open workspaces", href: "/workspaces", variant: "primary" },
          ]}
          testid="recovery-no-workspace"
        />
      </PageShell>
    );
  }

  return (
    <PageShell width="full" header={pageHeader} data-testid="operations-recovery-root">

      {error ? <div className="apf-note" data-tone="critical">{error}</div> : null}
      {success ? <div style={successBoxStyle}>{success}</div> : null}

      {!overview ? (
        <p style={{ ...mutedStyle, marginTop: 16 }}>
          Loading recovery overview…
        </p>
      ) : (
        <>
          <ReadinessSummary
            overview={overview}
            busy={busy}
            onRunBackup={runBackup}
            onRunRestore={runRestore}
          />

          <UnsupportedDomainsPanel
            domains={overview.readiness.unsupportedDomains}
          />

          <RecentReportsTable
            reports={overview.recentReports}
            onOpen={openReport}
          />
        </>
      )}

      {selectedReport ? (
        <ReportDrawer
          report={selectedReport}
          onClose={() => setSelectedReport(null)}
        />
      ) : null}

      <StepUpModal control={stepUp} />
    </PageShell>
  );
}

// ============================================================================
// Components
// ============================================================================

function outcomeBadge(outcome: ValidationOutcome | null) {
  if (outcome === "passed")
    return badgeStyle({ bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" });
  if (outcome === "warning")
    return badgeStyle({ bg: "#fef3c7", fg: "#78350f", border: "#fde68a" });
  if (outcome === "failed")
    return badgeStyle({ bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" });
  return badgeStyle({ bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" });
}

function ReadinessSummary({
  overview,
  busy,
  onRunBackup,
  onRunRestore,
}: {
  overview: ReadinessOverview;
  busy: string | null;
  onRunBackup: () => void;
  onRunRestore: () => void;
}) {
  const last = overview.readiness;
  return (
    <section style={{ ...cardStyle, marginTop: 16 }} data-testid="readiness">
      <h2 className="apf-section-title">Readiness</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        <div>
          <div className="apf-muted">S3 Object Lock platform mode</div>
          <div style={{ marginTop: 4 }}>
            <span
              style={badgeStyle(
                last.objectLockMode === "verified"
                  ? { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" }
                  : { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
              )}
            >
              {last.objectLockMode}
            </span>
          </div>
        </div>
        <div>
          <div className="apf-muted">Last backup validation</div>
          <div style={{ marginTop: 4 }}>
            {last.lastBackupReport ? (
              <>
                <span style={outcomeBadge(last.lastBackupReport.outcome)}>
                  {last.lastBackupReport.outcome ?? "unknown"}
                </span>
                <div style={{ ...mutedStyle, fontSize: 12, marginTop: 4 }}>
                  {formatDateTime(last.lastBackupReport.generatedAtUtc)}
                </div>
              </>
            ) : (
              <span className="apf-muted">Never run.</span>
            )}
          </div>
        </div>
        <div>
          <div className="apf-muted">Last restore validation</div>
          <div style={{ marginTop: 4 }}>
            {last.lastRestoreReport ? (
              <>
                <span style={outcomeBadge(last.lastRestoreReport.outcome)}>
                  {last.lastRestoreReport.outcome ?? "unknown"}
                </span>
                <div style={{ ...mutedStyle, fontSize: 12, marginTop: 4 }}>
                  {formatDateTime(last.lastRestoreReport.generatedAtUtc)}
                </div>
              </>
            ) : (
              <span className="apf-muted">Never run.</span>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={onRunBackup}
          disabled={busy !== null}
          data-testid="run-backup-validation"
        >
          {busy === "backup" ? "Running…" : "Run backup validation"}
        </button>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={onRunRestore}
          disabled={busy !== null}
          data-testid="run-restore-validation"
        >
          {busy === "restore" ? "Running…" : "Run restore validation (step-up)"}
        </button>
      </div>
    </section>
  );
}

function UnsupportedDomainsPanel({
  domains,
}: {
  domains: ReadonlyArray<string>;
}) {
  return (
    <section
      style={{
        ...cardStyle,
        marginTop: 12,
        background: TOKENS.surfaceMuted,
      }}
      data-testid="unsupported-domains"
    >
      <h2 className="apf-section-title">Unsupported domains (honest disclosure)</h2>
      <p className="apf-muted">
        These categories are explicitly NOT validated by the PROOVRA
        application layer. They must be exercised through the infrastructure
        provider's tooling and confirmed out-of-band.
      </p>
      <ul style={{ marginTop: 8, paddingLeft: 18, fontSize: 13 }}>
        {domains.map((d) => (
          <li key={d}>
            <code style={{ fontFamily: "monospace", fontSize: 11 }}>{d}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentReportsTable({
  reports,
  onOpen,
}: {
  reports: ReadonlyArray<{
    reportId: string;
    kind: RecoveryReportKind;
    generatedAtUtc: string;
    outcome: ValidationOutcome | null;
  }>;
  onOpen: (id: string) => void;
}) {
  return (
    <section
      style={{ ...cardStyle, marginTop: 12, padding: 0 }}
      data-testid="recent-reports"
    >
      <div style={{ padding: 12, borderBottom: `1px solid ${TOKENS.border}` }}>
        <strong style={{ fontSize: 14 }}>Recent reports</strong>
      </div>
      {reports.length === 0 ? (
        <p style={{ ...mutedStyle, padding: 24 }}>
          No reports yet. Run a backup or restore validation above.
        </p>
      ) : (
        <div className="apf-table-wrap">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Kind</th>
                <th style={thStyle}>Generated</th>
                <th style={thStyle}>Outcome</th>
                <th style={thStyle}>Report id</th>
                <th style={thStyle}>{" "}</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.reportId}>
                  <td style={tdStyle}>{r.kind}</td>
                  <td style={tdStyle}>
                    <span className="apf-muted">
                      {formatDateTime(r.generatedAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={outcomeBadge(r.outcome)}>
                      {r.outcome ?? "unknown"}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                      {r.reportId.slice(0, 28)}
                      {r.reportId.length > 28 ? "…" : ""}
                    </code>
                  </td>
                  <td style={tdStyle}>
                    <button
                      type="button"
                      className="apf-control"
                      onClick={() => onOpen(r.reportId)}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* No server cap on recovery reports, so a plain total is the honest statement. */}
          <ResultCount
            shown={reports.length}
            noun="validation report"
            data-testid="admin-recovery-reports-count"
          />
        </div>
      )}
    </section>
  );
}

function ReportDrawer({
  report,
  onClose,
}: {
  report: RecoveryValidationReport;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="Recovery report"
      data-testid="report-drawer"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        height: "100vh",
        width: "min(640px, 100vw)",
        background: TOKENS.surface,
        borderLeft: `1px solid ${TOKENS.border}`,
        boxShadow: "0 0 40px rgba(15,23,42,0.1)",
        zIndex: 50,
        overflowY: "auto",
        padding: 20,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2 style={{ fontSize: 16, margin: 0 }}>{report.kind}</h2>
        <button type="button" className="apf-control" onClick={onClose}>
          Close
        </button>
      </header>
      <p style={{ ...mutedStyle, marginTop: 8 }}>
        Report id <code style={{ fontFamily: "monospace" }}>{report.reportId}</code>
        <br />
        Started {formatDateTime(report.startedAtUtc)} · finished{" "}
        {formatDateTime(report.finishedAtUtc)}
      </p>
      <div style={{ marginTop: 12 }}>
        <span style={outcomeBadge(report.overallOutcome)}>
          {report.overallOutcome}
        </span>
        {report.recommendedAction ? (
          <p style={{ marginTop: 8, fontSize: 13 }}>
            <strong>Recommended action:</strong> {report.recommendedAction}
          </p>
        ) : null}
      </div>
      <section style={{ marginTop: 16 }}>
        <h2 className="apf-section-title">Checks</h2>
        <div className="apf-table-wrap">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Check</th>
                <th style={thStyle}>Outcome</th>
                <th style={thStyle}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((c) => (
                <tr key={c.id}>
                  <td style={tdStyle}>
                    <strong style={{ fontSize: 13 }}>{c.label}</strong>
                    <div style={{ ...mutedStyle, fontSize: 11 }}>{c.id}</div>
                  </td>
                  <td style={tdStyle}>
                    <span style={outcomeBadge(c.outcome)}>{c.outcome}</span>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ fontSize: 12 }}>{c.detail}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {report.unsupportedDomains.length > 0 ? (
        <section style={{ marginTop: 16 }}>
          <h2 className="apf-section-title">Unsupported domains</h2>
          <ul style={{ paddingLeft: 18, fontSize: 12 }}>
            {report.unsupportedDomains.map((d) => (
              <li key={d}>
                <code style={{ fontFamily: "monospace" }}>{d}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
