"use client";

/**
 * Phase 31.6 — Media intelligence panel.
 *
 * Drop-in, self-contained UI surface for an evidence detail page.
 * Consumes the `useMediaIntelligence` hook and renders the bounded
 * list of signals plus operator controls (acknowledge / dismiss /
 * run analyzer).
 *
 * Hard rules:
 *   * Tone is advisory only — NEVER uses words like "tampered",
 *     "forged", "fake", "authentic", "manipulated", "admissible",
 *     "proves", "confirms". The catalog's `safeSummary` already
 *     enforces this server-side; this component intentionally adds
 *     no extra prose that could imply a verdict.
 *   * Bounded vocabularies only — severity/confidence/status labels
 *     come from the `types.ts` helpers, never raw enum strings.
 *   * No storage internals — the projection from the server is
 *     anti-leak safe; this component has no fields to render any
 *     storage_key / signed URL / multipart upload id even if one
 *     leaked into the response.
 *   * Pure additive — mounting this panel anywhere is safe: it does
 *     nothing without a teamId, and it never throws.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { useMediaIntelligence } from "../../lib/media-intelligence/useMediaIntelligence";
import {
  useDerivedAssets,
  type DerivedAssetRow,
} from "../../lib/media-intelligence/useDerivedAssets";
import {
  compareSignalsForDisplay,
  confidenceLabel,
  severityLabel,
  statusLabel,
  type ClientSeverity,
  type ClientStatus,
  type MediaIntelligenceSignal,
} from "../../lib/media-intelligence/types";

export type MediaIntelligencePanelProps = {
  evidenceId: string;
  teamId: string | null;
  /** When true, poll every 5s while the user is on the page (e.g.
   *  immediately after a runAsync). Caller is responsible for
   *  turning polling off when the run has settled. */
  pollWhileRunning?: boolean;
};

export default function MediaIntelligencePanel({
  evidenceId,
  teamId,
  pollWhileRunning = false,
}: MediaIntelligencePanelProps) {
  const { state, runAsync, ack } = useMediaIntelligence({
    evidenceId,
    teamId,
    pollMs: pollWhileRunning ? 5_000 : null,
  });

  // Phase 31.13 — derived assets viewer state. Bounded read; the
  // server projects safe fields only (no storage internals).
  const derived = useDerivedAssets({
    evidenceId,
    teamId,
    pollMs: pollWhileRunning ? 5_000 : null,
  });

  const sortedSignals = useMemo(() => {
    if (!state.data) return [];
    return [...state.data.signals].sort(compareSignalsForDisplay);
  }, [state.data]);

  const missingCategories = useMemo(() => {
    if (!state.data) return [];
    const present = new Set(state.data.signals.map((s) => s.signalType));
    return state.data.catalog.filter(
      (c) => c.implemented && !present.has(c.signalType),
    );
  }, [state.data]);

  if (!teamId) {
    return (
      <section style={panelStyle} aria-label="Media intelligence">
        <PanelHeader />
        <p style={emptyStyle}>
          Workspace context is required to load media intelligence.
        </p>
      </section>
    );
  }

  return (
    <section style={panelStyle} aria-label="Media intelligence">
      <PanelHeader
        onRunAnalyzer={async () => {
          await runAsync();
        }}
        running={state.loading}
      />

      <p style={advisoryStyle}>
        Observations below are deterministic, advisory-only signals
        derived from file metadata. They do not establish authenticity
        or content. Review with normal operator judgment.
      </p>

      {state.error ? (
        <p style={errorStyle}>
          Could not load signals ({state.error.code}). Retry from the
          analyzer button above.
        </p>
      ) : null}

      {state.loading && !state.data ? (
        <p style={emptyStyle}>Loading…</p>
      ) : null}

      {state.data && sortedSignals.length === 0 ? (
        <p style={emptyStyle}>
          No signals recorded yet. Run the analyzer to populate the
          known categories below.
        </p>
      ) : null}

      {sortedSignals.length > 0 ? (
        <ul style={listStyle}>
          {sortedSignals.map((signal) => (
            <SignalRow
              key={signal.id}
              signal={signal}
              onAck={(action) => {
                void ack(signal.id, action);
              }}
            />
          ))}
        </ul>
      ) : null}

      {derived.state.assets.length > 0 ? (
        <DerivedAssetsStrip assets={derived.state.assets} />
      ) : null}

      {missingCategories.length > 0 ? (
        <details style={detailsStyle}>
          <summary style={summaryStyle}>
            Categories not yet computed for this evidence
            ({missingCategories.length})
          </summary>
          <ul style={catalogListStyle}>
            {missingCategories.map((entry) => (
              <li key={entry.signalType} style={catalogItemStyle}>
                {entry.displayLabel}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Phase 31.13 — Derived assets strip
// ---------------------------------------------------------------------------

function DerivedAssetsStrip({
  assets,
}: {
  assets: ReadonlyArray<DerivedAssetRow>;
}) {
  const completed = assets.filter((a) => a.status === "COMPLETED");
  const failed = assets.filter((a) => a.status === "FAILED");
  const unsupported = assets.filter((a) => a.status === "UNSUPPORTED");
  const pending = assets.filter(
    (a) => a.status === "PENDING" || a.status === "PROCESSING",
  );

  const [openAsset, setOpenAsset] = useState<DerivedAssetRow | null>(null);

  // Phase 31.14 — keyboard-accessible preview modal. Esc closes;
  // focus is bounded so background scroll is suppressed while open.
  useEffect(() => {
    if (!openAsset) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenAsset(null);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [openAsset]);

  const closeModal = useCallback(() => setOpenAsset(null), []);

  return (
    <div style={derivedSectionStyle}>
      <div style={derivedHeaderStyle}>
        <div style={derivedTitleStyle}>Derived previews</div>
        <div style={derivedHintStyle}>
          Operator-facing thumbnails generated from the recorded material.
          Advisory aids only; never a substitute for the preserved original.
        </div>
      </div>

      {completed.length > 0 ? (
        <ul style={thumbGridStyle}>
          {completed.map((a) => (
            <DerivedAssetThumbnail
              key={a.id}
              asset={a}
              onOpen={() => setOpenAsset(a)}
            />
          ))}
        </ul>
      ) : null}

      {(pending.length > 0 ||
        failed.length > 0 ||
        unsupported.length > 0) ? (
        <div style={derivedStatusRowStyle}>
          {pending.length > 0 ? (
            <span style={derivedStatusPillStyle("info")}>
              {pending.length} generating
            </span>
          ) : null}
          {failed.length > 0 ? (
            <span style={derivedStatusPillStyle("warn")}>
              {failed.length} failed
            </span>
          ) : null}
          {unsupported.length > 0 ? (
            <span style={derivedStatusPillStyle("neutral")}>
              {unsupported.length} unsupported
            </span>
          ) : null}
        </div>
      ) : null}

      {openAsset ? (
        <DerivedAssetPreviewModal asset={openAsset} onClose={closeModal} />
      ) : null}
    </div>
  );
}

function DerivedAssetThumbnail({
  asset,
  onOpen,
}: {
  asset: DerivedAssetRow;
  onOpen: () => void;
}) {
  const [imageState, setImageState] = useState<"loading" | "loaded" | "failed">(
    asset.bytesUrl ? "loading" : "failed",
  );

  return (
    <li style={thumbCardStyle}>
      <button
        type="button"
        onClick={onOpen}
        disabled={imageState === "failed"}
        aria-label={`Open ${humanAssetKind(asset.assetKind)} preview`}
        style={thumbButtonStyle(imageState === "failed")}
      >
        {asset.bytesUrl && imageState !== "failed" ? (
          <>
            {imageState === "loading" ? (
              <div style={thumbPlaceholderStyle} aria-hidden="true">
                <span style={thumbPlaceholderLabelStyle}>Loading…</span>
              </div>
            ) : null}
            <img
              src={asset.bytesUrl}
              alt=""
              loading="lazy"
              style={imageState === "loaded" ? thumbImageStyle : thumbImageHiddenStyle}
              onLoad={() => setImageState("loaded")}
              onError={() => setImageState("failed")}
            />
          </>
        ) : (
          <div style={thumbPlaceholderStyle} aria-hidden="true">
            <span style={thumbPlaceholderLabelStyle}>
              {humanAssetKind(asset.assetKind)} unavailable
            </span>
          </div>
        )}
      </button>
      <div style={thumbMetaStyle}>
        <span style={thumbKindStyle}>
          {humanAssetKind(asset.assetKind)} (derived)
        </span>
        <span style={thumbSizeStyle}>
          {asset.widthPx && asset.heightPx
            ? `${asset.widthPx}×${asset.heightPx}`
            : "—"}
        </span>
        <span style={thumbHashStyle}>
          sha256 {asset.derivedSha256 ? asset.derivedSha256.slice(0, 10) : "—"}
        </span>
      </div>
    </li>
  );
}

function DerivedAssetPreviewModal({
  asset,
  onClose,
}: {
  asset: DerivedAssetRow;
  onClose: () => void;
}) {
  const [imageState, setImageState] = useState<"loading" | "loaded" | "failed">(
    asset.bytesUrl ? "loading" : "failed",
  );
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Derived preview"
      onClick={onClose}
      style={modalBackdropStyle}
    >
      <div onClick={(e) => e.stopPropagation()} style={modalCardStyle}>
        <header style={modalHeaderStyle}>
          <div>
            <div style={modalKickerStyle}>Derived preview</div>
            <div style={modalTitleStyle}>{humanAssetKind(asset.assetKind)}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            style={modalCloseStyle}
          >
            ×
          </button>
        </header>
        <div style={modalImageWrapStyle}>
          {asset.bytesUrl && imageState !== "failed" ? (
            <>
              {imageState === "loading" ? (
                <div style={modalPlaceholderStyle} aria-hidden="true">
                  Loading preview…
                </div>
              ) : null}
              <img
                src={asset.bytesUrl}
                alt=""
                style={
                  imageState === "loaded"
                    ? modalImageStyle
                    : modalImageHiddenStyle
                }
                onLoad={() => setImageState("loaded")}
                onError={() => setImageState("failed")}
              />
            </>
          ) : (
            <div style={modalPlaceholderStyle}>Preview unavailable</div>
          )}
        </div>
        <p style={modalDisclaimerStyle}>
          This preview is an operator-facing rendering derived from the
          recorded material. It is an advisory aid only and is not a
          substitute for the preserved original or the canonical custody
          record.
        </p>
        <div style={modalMetaRowStyle}>
          <span style={modalMetaItemStyle}>
            {asset.widthPx && asset.heightPx
              ? `${asset.widthPx}×${asset.heightPx}`
              : "Dimensions unrecorded"}
          </span>
          <span style={modalMetaItemStyle}>
            sha256 {asset.derivedSha256 ? asset.derivedSha256.slice(0, 16) : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

function humanAssetKind(kind: string): string {
  switch (kind) {
    case "image_thumbnail":
      return "Image preview";
    case "video_frame":
      return "Video frame";
    case "audio_waveform":
      return "Audio waveform";
    case "low_res_proxy":
      return "Low-res proxy";
    case "compact_review_preview":
      return "Compact preview";
    default:
      return "Derived preview";
  }
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function PanelHeader({
  onRunAnalyzer,
  running,
}: {
  onRunAnalyzer?: () => void | Promise<void>;
  running?: boolean;
} = {}) {
  return (
    <header style={headerStyle}>
      <div>
        <h3 style={titleStyle}>Media intelligence</h3>
        <p style={subtitleStyle}>
          Deterministic metadata observations
        </p>
      </div>
      {onRunAnalyzer ? (
        <button
          type="button"
          style={runButtonStyle(running ?? false)}
          disabled={running}
          onClick={() => {
            void onRunAnalyzer();
          }}
        >
          {running ? "Working…" : "Run analyzer"}
        </button>
      ) : null}
    </header>
  );
}

function SignalRow({
  signal,
  onAck,
}: {
  signal: MediaIntelligenceSignal;
  onAck: (action: Extract<ClientStatus, "ACKNOWLEDGED" | "DISMISSED">) => void;
}) {
  const isOpen = signal.status === "PENDING";
  return (
    <li style={rowStyle}>
      <div style={rowHeaderStyle}>
        <span style={severityBadgeStyle(signal.severity)}>
          {severityLabel(signal.severity)}
        </span>
        <span style={confidenceBadgeStyle}>
          {confidenceLabel(signal.confidence)}
        </span>
        <span style={statusBadgeStyle(signal.status)}>
          {statusLabel(signal.status)}
        </span>
      </div>
      <p style={summaryTextStyle}>{signal.safeSummary}</p>
      <div style={rowFooterStyle}>
        <time style={timestampStyle} dateTime={signal.createdAtUtc}>
          Recorded {formatTimestamp(signal.createdAtUtc)}
        </time>
        {isOpen ? (
          <div style={actionsStyle}>
            <button
              type="button"
              style={ackButtonStyle}
              onClick={() => onAck("ACKNOWLEDGED")}
            >
              Acknowledge
            </button>
            <button
              type="button"
              style={dismissButtonStyle}
              onClick={() => onAck("DISMISSED")}
            >
              Dismiss
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Styles — inline, dense, enterprise. Matches the existing
// `LifecycleIndicators` pattern so the panel can drop into evidence
// pages without pulling new CSS modules.
// ---------------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 16,
  background: "#ffffff",
  margin: "12px 0",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  marginBottom: 8,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 700,
  color: "#0f172a",
};

const subtitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "#64748b",
};

const advisoryStyle: React.CSSProperties = {
  margin: "0 0 12px 0",
  fontSize: 12,
  color: "#475569",
  lineHeight: 1.4,
};

const errorStyle: React.CSSProperties = {
  margin: "0 0 12px 0",
  fontSize: 12,
  color: "#991b1b",
  background: "#fef2f2",
  border: "1px solid #fca5a5",
  borderRadius: 6,
  padding: "6px 10px",
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "#64748b",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const rowStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  padding: 10,
  background: "#f8fafc",
};

const rowHeaderStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginBottom: 6,
};

const summaryTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "#0f172a",
  lineHeight: 1.4,
};

const rowFooterStyle: React.CSSProperties = {
  marginTop: 8,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const timestampStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
};

const actionsStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
};

const ackButtonStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid #bfdbfe",
  background: "#eff6ff",
  color: "#1e40af",
  cursor: "pointer",
};

const dismissButtonStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid #e5e7eb",
  background: "#ffffff",
  color: "#475569",
  cursor: "pointer",
};

function runButtonStyle(running: boolean): React.CSSProperties {
  return {
    fontSize: 12,
    fontWeight: 600,
    padding: "6px 14px",
    borderRadius: 6,
    border: "1px solid #0f172a",
    background: running ? "#94a3b8" : "#0f172a",
    color: "#ffffff",
    cursor: running ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
  };
}

function severityBadgeStyle(severity: ClientSeverity): React.CSSProperties {
  const palette: Record<ClientSeverity, [string, string, string]> = {
    INFO: ["#eff6ff", "#bfdbfe", "#1e40af"],
    REVIEW_RECOMMENDED: ["#fffbeb", "#fcd34d", "#92400e"],
    ATTENTION: ["#fef2f2", "#fca5a5", "#991b1b"],
  };
  const [bg, border, color] = palette[severity];
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    whiteSpace: "nowrap",
  };
}

const confidenceBadgeStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 500,
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  color: "#334155",
  borderRadius: 999,
  whiteSpace: "nowrap",
};

function statusBadgeStyle(status: ClientStatus): React.CSSProperties {
  const palette: Record<ClientStatus, [string, string, string]> = {
    PENDING: ["#ffffff", "#cbd5e1", "#334155"],
    ACKNOWLEDGED: ["#ecfdf5", "#bbf7d0", "#166534"],
    DISMISSED: ["#f1f5f9", "#cbd5e1", "#64748b"],
  };
  const [bg, border, color] = palette[status];
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 500,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    whiteSpace: "nowrap",
  };
}

const detailsStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 12,
  color: "#475569",
};

const summaryStyle: React.CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  color: "#1e40af",
  userSelect: "none",
};

const catalogListStyle: React.CSSProperties = {
  listStyle: "disc",
  paddingLeft: 20,
  margin: "6px 0 0 0",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const catalogItemStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#475569",
};

// ---------------------------------------------------------------------------
// Phase 31.13 — Derived assets strip styles
// ---------------------------------------------------------------------------

const derivedSectionStyle: React.CSSProperties = {
  marginTop: 12,
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 12,
  background: "#f8fafc",
};

const derivedHeaderStyle: React.CSSProperties = {
  marginBottom: 8,
};

const derivedTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#0f172a",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const derivedHintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  marginTop: 2,
  lineHeight: 1.4,
};

const thumbGridStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
  gap: 8,
};

const thumbCardStyle: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  padding: 6,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const thumbPlaceholderStyle: React.CSSProperties = {
  aspectRatio: "1 / 1",
  background: "#f1f5f9",
  border: "1px dashed #cbd5e1",
  borderRadius: 4,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const thumbPlaceholderLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#64748b",
  textAlign: "center",
};

const thumbMetaStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const thumbSizeStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#475569",
};

const thumbHashStyle: React.CSSProperties = {
  fontSize: 9,
  color: "#94a3b8",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const derivedStatusRowStyle: React.CSSProperties = {
  marginTop: 8,
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
};

function derivedStatusPillStyle(
  tone: "info" | "warn" | "neutral",
): React.CSSProperties {
  const palette: Record<typeof tone, [string, string, string]> = {
    info: ["#eff6ff", "#bfdbfe", "#1e40af"],
    warn: ["#fffbeb", "#fcd34d", "#92400e"],
    neutral: ["#f1f5f9", "#cbd5e1", "#475569"],
  };
  const [bg, border, color] = palette[tone];
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    whiteSpace: "nowrap",
  };
}

// ---------------------------------------------------------------------------
// Phase 31.14 — thumbnail + modal styles
// ---------------------------------------------------------------------------

function thumbButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    all: "unset",
    cursor: disabled ? "default" : "pointer",
    display: "block",
    aspectRatio: "1 / 1",
    width: "100%",
    background: "#f1f5f9",
    border: "1px solid #cbd5e1",
    borderRadius: 4,
    overflow: "hidden",
    outlineOffset: 2,
  };
}

const thumbImageStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  objectFit: "cover",
};

const thumbImageHiddenStyle: React.CSSProperties = {
  display: "none",
};

const thumbKindStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#334155",
  fontWeight: 600,
};

const modalBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.72)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 24,
};

const modalCardStyle: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  maxWidth: 720,
  width: "100%",
  maxHeight: "calc(100vh - 48px)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const modalHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  padding: 14,
  borderBottom: "1px solid #e2e8f0",
};

const modalKickerStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const modalTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: "#0f172a",
  marginTop: 2,
};

const modalCloseStyle: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  fontSize: 22,
  lineHeight: 1,
  color: "#475569",
  padding: "0 6px",
};

const modalImageWrapStyle: React.CSSProperties = {
  flex: "1 1 auto",
  background: "#0f172a",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
  minHeight: 240,
};

const modalImageStyle: React.CSSProperties = {
  display: "block",
  maxWidth: "100%",
  maxHeight: "60vh",
  objectFit: "contain",
};

const modalImageHiddenStyle: React.CSSProperties = {
  display: "none",
};

const modalPlaceholderStyle: React.CSSProperties = {
  color: "#94a3b8",
  fontSize: 12,
};

const modalDisclaimerStyle: React.CSSProperties = {
  margin: 0,
  padding: "10px 14px",
  fontSize: 11,
  color: "#475569",
  lineHeight: 1.5,
  borderTop: "1px solid #e2e8f0",
  background: "#f8fafc",
};

const modalMetaRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 14,
  padding: "8px 14px 12px 14px",
  borderTop: "1px solid #f1f5f9",
};

const modalMetaItemStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};
