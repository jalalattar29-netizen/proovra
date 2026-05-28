"use client";

/**
 * Phase M2.1 — internal evidence detail C2PA panel.
 *
 * Mounts inside the evidence workspace (technical / integrity tab)
 * and surfaces the bounded C2PA state for a single evidence record.
 *
 * Hard rules:
 *   * Renders all bounded states honestly (disabled / unsupported /
 *     not_present / present / valid / invalid / error).
 *   * Never claims authenticity / truth / admissibility.
 *   * Retry button is bounded — it posts to the retry endpoint and
 *     surfaces an honest "queued" / "disabled" note.
 *   * The panel is QUIET (compact / muted) when the C2PA provider is
 *     disabled or the file is unsupported — no noisy red badges.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";

// Bounded copy used as the standing caption on every render. NEVER
// elevates C2PA into a PROOVRA integrity statement.
const C2PA_STANDING_CAPTION =
  "C2PA is a provenance interoperability signal. It does not determine factual truth, authorship, or legal admissibility.";

type C2paStatus =
  | "not_present"
  | "present"
  | "valid"
  | "invalid"
  | "unsupported"
  | "disabled"
  | "error";

type C2paValidationStatus =
  | "not_checked"
  | "valid"
  | "invalid"
  | "unsupported"
  | "error";

type C2paFileResult = {
  itemId: string | null;
  mediaType: string;
  status: C2paStatus;
  manifestDetected: boolean;
  validationStatus: C2paValidationStatus;
  claimGenerator: string | null;
  ingredientsCount: number;
  assertionsSummary: {
    total: number;
  };
  rawManifest?: {
    status: string;
    sizeBytes: number | null;
    packageRelativePath: string | null;
  };
};

type C2paEvidenceSummary = {
  schemaVersion: string;
  generatedAtUtc: string;
  evidenceId: string;
  providerMode: string;
  toolVersion: string | null;
  aggregateStatus: C2paStatus;
  aggregateValidationStatus: C2paValidationStatus;
  itemsChecked: number;
  files: ReadonlyArray<C2paFileResult>;
  warnings: ReadonlyArray<string>;
  limitations: ReadonlyArray<string>;
  rawManifestExportStatus?: string;
  generatedAssertion?: { status: string; targetKind: string };
  note: string | null;
};

type Panel = {
  evidenceId: string;
  summary: C2paEvidenceSummary;
  limitations: ReadonlyArray<string>;
  projectedAtUtc: string;
};

const STATUS_TONE: Record<C2paStatus, "ok" | "warn" | "danger" | "muted"> = {
  valid: "ok",
  present: "ok",
  not_present: "muted",
  unsupported: "muted",
  disabled: "muted",
  invalid: "warn",
  error: "danger",
};

const PALETTE = {
  ok: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
  warn: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
  danger: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  muted: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
};

function badge(status: C2paStatus): React.CSSProperties {
  const p = PALETTE[STATUS_TONE[status]];
  return {
    display: "inline-block",
    padding: "2px 8px",
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 4,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    whiteSpace: "nowrap",
  };
}

export type C2paPanelProps = {
  evidenceId: string;
};

export function C2paPanel({ evidenceId }: C2paPanelProps) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = (await apiFetch(
        `/v1/evidence/${evidenceId}/c2pa`,
      )) as { panel: Panel };
      setPanel(res.panel);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load C2PA panel.");
    }
  }, [evidenceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = useCallback(async () => {
    setRetryBusy(true);
    setRetryNote(null);
    try {
      const res = (await apiFetch(`/v1/evidence/${evidenceId}/c2pa/retry`, {
        method: "POST",
      })) as { accepted: boolean; note: string };
      setRetryNote(res.note);
    } catch (e) {
      setRetryNote(
        e instanceof Error
          ? e.message
          : "Retry request failed. The provider may be unavailable.",
      );
    } finally {
      setRetryBusy(false);
    }
  }, [evidenceId]);

  if (err) {
    return (
      <section
        data-testid="c2pa-panel"
        style={{
          padding: 12,
          border: "1px solid #fecaca",
          background: "#fef2f2",
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        <strong>C2PA panel</strong> — could not load: {err}
      </section>
    );
  }
  if (!panel) {
    return (
      <section
        data-testid="c2pa-panel"
        style={{
          padding: 12,
          border: "1px solid #e2e8f0",
          background: "#f8fafc",
          borderRadius: 6,
          fontSize: 13,
          color: "#475569",
        }}
      >
        Loading C2PA…
      </section>
    );
  }
  const summary = panel.summary;
  return (
    <section
      data-testid="c2pa-panel"
      style={{
        padding: 12,
        border: "1px solid #e2e8f0",
        background: "#ffffff",
        borderRadius: 6,
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <strong>C2PA provenance</strong>
        <span style={badge(summary.aggregateStatus)}>
          {summary.aggregateStatus}
        </span>
        <span style={{ color: "#475569" }}>
          validation = <code>{summary.aggregateValidationStatus}</code> ·
          items = <strong>{summary.itemsChecked}</strong> · mode =
          <code> {summary.providerMode}</code>
        </span>
      </div>
      <p style={{ margin: "8px 0 0", color: "#475569" }}>
        {C2PA_STANDING_CAPTION}
      </p>
      {summary.aggregateStatus === "disabled" ? (
        <p style={{ margin: "8px 0 0", color: "#64748b" }}>
          PROOVRA&apos;s C2PA provider is operationally disabled at this
          deployment. Missing C2PA does not reduce PROOVRA hash/custody
          integrity.
        </p>
      ) : summary.aggregateStatus === "invalid" ? (
        <p style={{ margin: "8px 0 0", color: "#78350f" }}>
          The bundled C2PA manifest could not be validated. This does NOT
          override PROOVRA hash/custody integrity — PROOVRA&apos;s own
          verdict is unchanged. Use external C2PA tooling against the
          original evidence file if you need an independent check.
        </p>
      ) : null}

      {/* Per-file table for multi-part evidence. */}
      {summary.files.length > 0 ? (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginTop: 10,
            fontSize: 12,
          }}
          data-testid="c2pa-files-table"
        >
          <thead>
            <tr>
              <th style={cell}>Item</th>
              <th style={cell}>Media type</th>
              <th style={cell}>Status</th>
              <th style={cell}>Validation</th>
              <th style={cell}>Generator</th>
              <th style={cell}>Raw manifest</th>
            </tr>
          </thead>
          <tbody>
            {summary.files.map((f, i) => (
              <tr key={f.itemId ?? `item-${i}`}>
                <td style={cell}>
                  <code>{f.itemId ?? "single"}</code>
                </td>
                <td style={cell}>
                  <code>{f.mediaType}</code>
                </td>
                <td style={cell}>
                  <span style={badge(f.status)}>{f.status}</span>
                </td>
                <td style={cell}>
                  <code>{f.validationStatus}</code>
                </td>
                <td style={cell}>{f.claimGenerator ?? "—"}</td>
                <td style={cell}>
                  <code>{f.rawManifest?.status ?? "disabled"}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {summary.warnings.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <strong style={{ fontSize: 12 }}>Warnings</strong>
          <ul style={{ margin: 4, paddingLeft: 18, fontSize: 12 }}>
            {summary.warnings.map((w) => (
              <li key={w}>
                <code>{w}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => void retry()}
          disabled={retryBusy}
          data-testid="c2pa-retry-button"
          style={{
            padding: "4px 10px",
            fontSize: 12,
            background: "#0f172a",
            color: "#fff",
            border: "1px solid #0f172a",
            borderRadius: 4,
            cursor: retryBusy ? "wait" : "pointer",
          }}
        >
          {retryBusy ? "Queuing…" : "Retry extraction"}
        </button>
        {retryNote ? (
          <span style={{ fontSize: 12, color: "#475569" }}>{retryNote}</span>
        ) : null}
      </div>
    </section>
  );
}

const cell: React.CSSProperties = {
  padding: "4px 8px",
  borderBottom: "1px solid #f1f5f9",
  textAlign: "left",
  verticalAlign: "top",
};
