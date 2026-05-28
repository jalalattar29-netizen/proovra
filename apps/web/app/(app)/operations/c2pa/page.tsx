"use client";

/**
 * Phase M2.1 — C2PA operations console.
 *
 * Consumes the M2.1 backend:
 *   GET  /v1/operations/c2pa                        — overview
 *   POST /v1/operations/c2pa/backfill/preview       — preview
 *   POST /v1/operations/c2pa/backfill/start         — start (step-up)
 *   GET  /v1/operations/c2pa/backfill               — list runs
 *   POST /v1/operations/c2pa/backfill/:id/tick      — drive a batch
 *   POST /v1/operations/c2pa/backfill/:id/cancel    — cancel
 *   GET  /v1/operations/c2pa/generation/readiness   — bounded readiness
 *
 * Sections:
 *   1. Provider status — enabled / mode / raw-manifest export flag.
 *   2. Generation readiness — bounded state + reason. No fake button.
 *   3. Backfill preview + start + recent runs.
 *   4. Standing limitations (always shown).
 *
 * Hard rules surfaced as bounded copy:
 *   * "C2PA does not determine truth, authorship, or legal admissibility."
 *   * Missing C2PA does not fail PROOVRA core integrity.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  badgeStyle,
  cardStyle,
  errorBoxStyle,
  formatDateTime,
  ghostButtonStyle,
  headerRowStyle,
  mutedStyle,
  pageStyle,
  primaryButtonStyle,
  sectionTitleStyle,
  subtitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
} from "../../admin/identity/ui-tokens";

// Bounded palette helpers (mirrors the ui-tokens internal STATUS_PALETTES
// without depending on the un-exported map).
const PALETTE = {
  success: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
  info: { bg: "#eff6ff", fg: "#1e3a8a", border: "#bfdbfe" },
  warning: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
  danger: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  muted: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
} as const;

// ============================================================================
// Types (mirror the backend response shapes)
// ============================================================================

type ProviderStatus = {
  enabled: boolean;
  mode: string;
  rawManifestExportEnabled: boolean;
};

type GenerationReadiness = {
  state:
    | "ready"
    | "disabled"
    | "missing_cert"
    | "missing_key"
    | "tooling_unavailable"
    | "unsupported_target"
    | "blocked_by_signer_governance";
  reason: string;
  configuredTargets: ReadonlyArray<string>;
  canAttempt: boolean;
};

type BackfillRun = {
  id: string;
  teamId: string;
  startedAtUtc: string;
  endedAtUtc: string | null;
  status: "pending" | "running" | "completed" | "cancelled" | "failed";
  filter: "all_eligible" | "missing_summary" | "errored_only";
  candidateCount: number;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
};

type Overview = {
  teamId: string;
  providerStatus: ProviderStatus;
  generationReadiness: GenerationReadiness;
  backfillRuns: ReadonlyArray<BackfillRun>;
  limitations: ReadonlyArray<string>;
};

type Preview = {
  teamId: string;
  filter: BackfillRun["filter"];
  totalEligible: number;
  alreadyProcessed: number;
  candidateCount: number;
  providerMode: string;
  rawManifestExportEnabled: boolean;
  c2paEnabled: boolean;
  note: string;
  warnings: ReadonlyArray<string>;
  sampleEvidenceIds: ReadonlyArray<string>;
};

// ============================================================================
// Page shell
// ============================================================================

export default function OperationsC2paPage() {
  return (
    <PageRouteGate routeId="workspace.security_center">
      <OperationsC2paContent />
    </PageRouteGate>
  );
}

function OperationsC2paContent() {
  const teamId = useTeamId();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    if (!teamId) return;
    try {
      const res = (await apiFetch(
        `/v1/operations/c2pa?teamId=${teamId}`,
      )) as Overview;
      setOverview(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load overview.");
    }
  }, [teamId]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const runPreview = useCallback(async () => {
    if (!teamId) return;
    setBusy(true);
    setErr(null);
    try {
      const res = (await apiFetch(
        `/v1/operations/c2pa/backfill/preview`,
        {
          method: "POST",
          body: JSON.stringify({ teamId, filter: "missing_summary" }),
        },
      )) as { preview: Preview };
      setPreview(res.preview);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview failed.");
    } finally {
      setBusy(false);
    }
  }, [teamId]);

  const startBackfill = useCallback(async () => {
    if (!teamId) return;
    setBusy(true);
    setErr(null);
    try {
      const res = (await apiFetch(
        `/v1/operations/c2pa/backfill/start`,
        {
          method: "POST",
          body: JSON.stringify({ teamId, filter: "missing_summary" }),
        },
      )) as { run: BackfillRun };
      // Drive the run synchronously in 50-evidence ticks until done.
      let run = res.run;
      while (run.status !== "completed" && run.status !== "cancelled") {
        const tick = (await apiFetch(
          `/v1/operations/c2pa/backfill/${run.id}/tick`,
          {
            method: "POST",
            body: JSON.stringify({ teamId, maxBatchSize: 50 }),
          },
        )) as { run: BackfillRun };
        run = tick.run;
        if (tick.run.processedCount === 0) break;
      }
      await loadOverview();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Start failed.");
    } finally {
      setBusy(false);
    }
  }, [teamId, loadOverview]);

  const cancelRun = useCallback(
    async (runId: string) => {
      if (!teamId) return;
      try {
        await apiFetch(`/v1/operations/c2pa/backfill/${runId}/cancel`, {
          method: "POST",
          body: JSON.stringify({ teamId }),
        });
        await loadOverview();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Cancel failed.");
      }
    },
    [teamId, loadOverview],
  );

  if (!teamId) return null;

  return (
    <main style={pageStyle} data-testid="operations-c2pa-page">
      <div style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>C2PA Operations</h1>
          <p style={subtitleStyle}>
            Provider status, bulk backfill, and generation readiness for the
            bounded C2PA provenance layer. C2PA is an interoperability
            signal — it does NOT determine factual truth, authorship, or
            legal admissibility, and missing or invalid C2PA never fails
            PROOVRA hash/custody integrity.
          </p>
        </div>
        <div>
          <button
            type="button"
            onClick={() => void loadOverview()}
            style={ghostButtonStyle}
          >
            Refresh
          </button>
        </div>
      </div>

      {err ? <div style={errorBoxStyle}>{err}</div> : null}

      {/* Provider status */}
      <section style={cardStyle} data-testid="provider-status-card">
        <h2 style={sectionTitleStyle}>Provider</h2>
        {overview ? (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Stat
              label="Enabled"
              value={overview.providerStatus.enabled ? "true" : "false"}
              tone={overview.providerStatus.enabled ? "success" : "muted"}
            />
            <Stat
              label="Mode"
              value={overview.providerStatus.mode}
              tone="info"
            />
            <Stat
              label="Raw-manifest export"
              value={
                overview.providerStatus.rawManifestExportEnabled
                  ? "enabled"
                  : "disabled"
              }
              tone={
                overview.providerStatus.rawManifestExportEnabled
                  ? "success"
                  : "muted"
              }
            />
          </div>
        ) : (
          <p style={mutedStyle}>Loading…</p>
        )}
      </section>

      {/* Generation readiness */}
      <section style={cardStyle} data-testid="generation-readiness-card">
        <h2 style={sectionTitleStyle}>Generation readiness</h2>
        {overview ? (
          <>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span
                style={badgeStyle(
                  overview.generationReadiness.state === "ready"
                    ? PALETTE.success
                    : PALETTE.warning,
                )}
              >
                {overview.generationReadiness.state}
              </span>
              <span style={mutedStyle}>
                {overview.generationReadiness.reason}
              </span>
            </div>
            {overview.generationReadiness.canAttempt ? (
              <p style={{ marginTop: 8 }}>
                Generation pipeline is wired in this deployment only when the
                operator opts in by deploying a signed-generation worker.
                The console will not generate manifests until that pipeline
                is in place.
              </p>
            ) : (
              <p style={{ marginTop: 8, ...mutedStyle }}>
                Generation unavailable. PROOVRA will not produce or sign
                C2PA manifests until readiness reports <code>ready</code>.
              </p>
            )}
          </>
        ) : (
          <p style={mutedStyle}>Loading…</p>
        )}
      </section>

      {/* Backfill */}
      <section style={cardStyle} data-testid="backfill-card">
        <h2 style={sectionTitleStyle}>Bulk backfill</h2>
        <div style={{ display: "flex", gap: 12 }}>
          <button
            type="button"
            onClick={() => void runPreview()}
            disabled={busy}
            style={ghostButtonStyle}
            data-testid="preview-button"
          >
            Preview
          </button>
          <button
            type="button"
            onClick={() => void startBackfill()}
            disabled={busy || !preview || preview.candidateCount === 0}
            style={primaryButtonStyle}
            data-testid="start-button"
          >
            Start backfill
          </button>
        </div>
        {preview ? (
          <div style={{ marginTop: 12 }} data-testid="preview-summary">
            <p>
              Candidates: <strong>{preview.candidateCount}</strong> · already
              processed: <strong>{preview.alreadyProcessed}</strong> ·
              provider mode: <code>{preview.providerMode}</code>
            </p>
            <p style={mutedStyle}>{preview.note}</p>
            {preview.warnings.length > 0 ? (
              <ul style={{ marginTop: 8 }}>
                {preview.warnings.map((w) => (
                  <li key={w}>
                    <code>{w}</code>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p style={mutedStyle}>Run a preview to see the eligible scope.</p>
        )}

        {overview && overview.backfillRuns.length > 0 ? (
          <table style={tableStyle} data-testid="runs-table">
            <thead>
              <tr>
                <th style={thStyle}>Started</th>
                <th style={thStyle}>Filter</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Processed</th>
                <th style={thStyle}>Failed</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {overview.backfillRuns.map((r) => (
                <tr key={r.id}>
                  <td style={tdStyle}>{formatDateTime(r.startedAtUtc)}</td>
                  <td style={tdStyle}>
                    <code>{r.filter}</code>
                  </td>
                  <td style={tdStyle}>
                    <span style={badgeStyle(paletteForStatus(r.status))}>
                      {r.status}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    {r.processedCount}/{r.candidateCount}
                  </td>
                  <td style={tdStyle}>{r.failedCount}</td>
                  <td style={tdStyle}>
                    {r.status === "running" || r.status === "pending" ? (
                      <button
                        type="button"
                        onClick={() => void cancelRun(r.id)}
                        style={ghostButtonStyle}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      {/* Standing limitations */}
      <section style={cardStyle} data-testid="standing-limitations-card">
        <h2 style={sectionTitleStyle}>Standing limitations</h2>
        <ul>
          {overview?.limitations.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "success" | "muted" | "info";
}) {
  return (
    <div>
      <div style={mutedStyle}>{label}</div>
      <div style={{ marginTop: 4 }}>
        <span style={badgeStyle(PALETTE[tone])}>{value}</span>
      </div>
    </div>
  );
}

function paletteForStatus(status: BackfillRun["status"]) {
  switch (status) {
    case "completed":
      return PALETTE.success;
    case "cancelled":
      return PALETTE.warning;
    case "failed":
      return PALETTE.danger;
    default:
      return PALETTE.info;
  }
}
