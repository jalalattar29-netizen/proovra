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
import { type AppTone } from "../app-primitives";
import { formatUserDateTime } from "../../lib/date";
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
      <section className="evd-panel" aria-label="Media intelligence">
        <PanelHeader />
        <p className="evd-muted">
          Workspace context is required to load media intelligence.
        </p>
      </section>
    );
  }

  return (
    <section className="evd-panel" aria-label="Media intelligence">
      <PanelHeader
        onRunAnalyzer={async () => {
          await runAsync();
        }}
        running={state.loading}
      />

      <p className="evd-muted">
        Observations below are deterministic, advisory-only signals
        derived from file metadata. They do not establish authenticity
        or content. Review with normal operator judgment.
      </p>

      {state.error ? (
        <p className="evd-error">
          Could not load signals ({state.error.code}). Retry from the
          analyzer button above.
        </p>
      ) : null}

      {state.loading && !state.data ? (
        <p className="evd-muted">Loading…</p>
      ) : null}

      {state.data && sortedSignals.length === 0 ? (
        <p className="evd-muted">
          No signals recorded yet. Run the analyzer to populate the
          known categories below.
        </p>
      ) : null}

      {sortedSignals.length > 0 ? (
        <ul className="evd-list">
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
        <details className="evd-stack">
          <summary className="evd-kicker">
            Categories not yet computed for this evidence
            ({missingCategories.length})
          </summary>
          <ul className="evd-list">
            {missingCategories.map((entry) => (
              <li key={entry.signalType} className="evd-list-item">
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
    <div className="evd-stack">
      <div className="evd-header">
        <div className="evd-title">Derived previews</div>
        <div className="evd-muted evd-muted--small">
          Operator-facing thumbnails generated from the recorded material.
          Advisory aids only; never a substitute for the preserved original.
        </div>
      </div>

      {completed.length > 0 ? (
        <ul className="evd-grid">
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
        <div className="evd-actions">
          {pending.length > 0 ? (
            <span className="app-status-badge" data-tone="blue">
              {pending.length} generating
            </span>
          ) : null}
          {failed.length > 0 ? (
            <span className="app-status-badge" data-tone="amber">
              {failed.length} failed
            </span>
          ) : null}
          {unsupported.length > 0 ? (
            <span className="app-status-badge" data-tone="slate">
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
    <li className="evd-card">
      <button
        type="button"
        onClick={onOpen}
        disabled={imageState === "failed"}
        aria-label={`Open ${humanAssetKind(asset.assetKind)} preview`}
        className="evd-thumb-button"
      >
        {asset.bytesUrl && imageState !== "failed" ? (
          <>
            {imageState === "loading" ? (
              <div className="evd-thumb-placeholder" aria-hidden="true">
                <span className="evd-muted evd-muted--small">Loading…</span>
              </div>
            ) : null}
            <img
              src={asset.bytesUrl}
              alt=""
              /**
               * PHASE 13 (NEW-037) — deliberately NOT `loading="lazy"`.
               *
               * While `imageState === "loading"` this element carries
               * `display: none`, which removes its layout box — and an element
               * with no box can never intersect the viewport, so whether a lazy
               * image in that state is ever fetched is a browser implementation
               * detail. Where a browser defers it, the card sits on "Loading…"
               * forever and presents exactly as the missing-asset defect
               * NEW-028 fixed: the URL was right and nothing appeared.
               *
               * The asset list for one evidence item is small and bounded, so
               * the deferral was buying almost nothing against a failure mode
               * that is indistinguishable from a broken URL.
               */
              // The bytes route is authenticated and cross-origin; without this the
              // browser omits the session cookie and the image 401s.
              crossOrigin="use-credentials"
              className={imageState === "loaded" ? "evd-thumb-image" : "evd-thumb-image evd-thumb-image--hidden"}
              onLoad={() => setImageState("loaded")}
              onError={() => setImageState("failed")}
            />
          </>
        ) : (
          <div className="evd-thumb-placeholder" aria-hidden="true">
            <span className="evd-muted evd-muted--small">
              {humanAssetKind(asset.assetKind)} unavailable
            </span>
          </div>
        )}
      </button>
      <div className="evd-thumb-meta">
        <span className="evd-strong">
          {humanAssetKind(asset.assetKind)} (derived)
        </span>
        <span>
          {asset.widthPx && asset.heightPx
            ? `${asset.widthPx}×${asset.heightPx}`
            : "—"}
        </span>
        <span className="evd-mono">
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
      className="evd-dialog-backdrop"
    >
      <div onClick={(e) => e.stopPropagation()} className="evd-dialog evd-dialog--wide">
        <header className="evd-header">
          <div>
            <div className="evd-kicker">Derived preview</div>
            <div className="evd-title">{humanAssetKind(asset.assetKind)}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="app-ghost-action"
          >
            ×
          </button>
        </header>
        <div className="evd-thumb-frame">
          {asset.bytesUrl && imageState !== "failed" ? (
            <>
              {imageState === "loading" ? (
                <div className="evd-thumb-placeholder" aria-hidden="true">
                  Loading preview…
                </div>
              ) : null}
              <img
                src={asset.bytesUrl}
                alt=""
                // Same authenticated cross-origin route as the thumbnail above.
                crossOrigin="use-credentials"
                className={imageState === "loaded" ? "evd-thumb-image" : "evd-thumb-image evd-thumb-image--hidden"}
                onLoad={() => setImageState("loaded")}
                onError={() => setImageState("failed")}
              />
            </>
          ) : (
            <div className="evd-thumb-placeholder">Preview unavailable</div>
          )}
        </div>
        <p className="evd-muted">
          This preview is an operator-facing rendering derived from the
          recorded material. It is an advisory aid only and is not a
          substitute for the preserved original or the canonical custody
          record.
        </p>
        <div className="evd-actions">
          <span className="evd-muted evd-muted--small">
            {asset.widthPx && asset.heightPx
              ? `${asset.widthPx}×${asset.heightPx}`
              : "Dimensions unrecorded"}
          </span>
          <span className="evd-muted evd-muted--small">
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
    <header className="evd-header">
      <div>
        <h3 className="evd-title">Media intelligence</h3>
        <p className="evd-subtitle">
          Deterministic metadata observations
        </p>
      </div>
      {onRunAnalyzer ? (
        <button
          type="button"
          className="app-secondary-action app-secondary-action--filled"
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
    <li className="evd-card">
      <div className="evd-card-header">
        <span className="app-status-badge" data-tone={severityTone(signal.severity)}>
          {severityLabel(signal.severity)}
        </span>
        <span className="evd-badge">
          {confidenceLabel(signal.confidence)}
        </span>
        <span className="app-status-badge" data-tone={statusTone(signal.status)}>
          {statusLabel(signal.status)}
        </span>
      </div>
      <p className="evd-paragraph">{signal.safeSummary}</p>
      <div className="evd-actions">
        <time className="evd-muted evd-muted--small" dateTime={signal.createdAtUtc}>
          Recorded {formatTimestamp(signal.createdAtUtc)}
        </time>
        {isOpen ? (
          <div className="evd-actions">
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => onAck("ACKNOWLEDGED")}
            >
              Acknowledge
            </button>
            <button
              type="button"
              className="app-ghost-action"
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
  return formatUserDateTime(iso);
}

// ---------------------------------------------------------------------------
// Styles — inline, dense, enterprise. Matches the existing
// `LifecycleIndicators` pattern so the panel can drop into evidence
// pages without pulling new CSS modules.
// ---------------------------------------------------------------------------

function severityTone(severity: ClientSeverity): AppTone {
  if (severity === "ATTENTION") return "red";
  if (severity === "REVIEW_RECOMMENDED") return "amber";
  return "blue";
}

function statusTone(status: ClientStatus): AppTone {
  if (status === "ACKNOWLEDGED") return "green";
  if (status === "DISMISSED") return "slate";
  return "blue";
}
