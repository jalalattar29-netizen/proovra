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
import { Check, X } from "lucide-react";

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
  /**
   * How many 4s polls a run may go without reporting a terminal state before
   * it is declared stalled. Production keeps the ~2 minute budget; the test
   * suite lowers it so proving the bound exists does not cost two minutes.
   */
  stallAfterPolls?: number;
};

export default function MediaIntelligencePanel({
  evidenceId,
  teamId,
  pollWhileRunning = false,
  stallAfterPolls = 30,
}: MediaIntelligencePanelProps) {
  /**
   * THE RUN LIFECYCLE, held explicitly.
   *
   * The panel used to call `void runAsync()` and pass `running={state.loading}`
   * — the LIST-FETCH flag, which `runAsync` never sets. So the button had no
   * pending state, its `{ ok: false, reason }` was discarded, a `queued: false`
   * response (queue down, run row left PENDING) read as success, and nothing
   * refreshed afterwards because polling was off. The request really was sent
   * and the run row really was created; the operator simply saw nothing, which
   * is why the control read as dead.
   */
  const [run, setRun] = useState<{
    phase: "idle" | "queued" | "running" | "completed" | "failed" | "stalled";
    message: string | null;
    runId: string | null;
    /** Observation count when the run was accepted, to report what changed. */
    baseline: number | null;
    /** New observations this run produced, and the total now on the record. */
    added: number | null;
    total: number | null;
    completedAtUtc: string | null;
    polls: number;
  }>({
    phase: "idle",
    message: null,
    runId: null,
    baseline: null,
    added: null,
    total: null,
    completedAtUtc: null,
    polls: 0,
  });

  /** Signals with an acknowledge/dismiss request in flight. */
  const [pendingAcks, setPendingAcks] = useState<Record<string, boolean>>({});
  const [ackError, setAckError] = useState<string | null>(null);

  const runInFlight = run.phase === "queued" || run.phase === "running";

  const { state, runAsync, ack, refresh } = useMediaIntelligence({
    evidenceId,
    teamId,
    // Poll while a run is actually in flight, not only when a caller opted in.
    // Without this the async run enqueued and the panel never looked again.
    pollMs: runInFlight || pollWhileRunning ? 4_000 : null,
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

  /**
   * Open observations first; acknowledged and dismissed together in a resolved
   * group. Every record is preserved — nothing is deduplicated away — because
   * each one is its own audit row.
   */
  const openSignals = useMemo(
    () => sortedSignals.filter((x) => x.status === "PENDING"),
    [sortedSignals],
  );
  const resolvedSignals = useMemo(
    () => sortedSignals.filter((x) => x.status !== "PENDING"),
    [sortedSignals],
  );

  const handleRunAnalyzer = useCallback(async () => {
    // Duplicate protection: the control is disabled while in flight, and the
    // handler refuses re-entry even if a caller invokes it directly.
    if (runInFlight) return;
    setRun({
      phase: "queued",
      message: "Starting the analyzer…",
      runId: null,
      // The list as it stands NOW is the baseline this run is measured against.
      baseline: state.data?.signals.length ?? 0,
      added: null,
      total: null,
      completedAtUtc: null,
      polls: 0,
    });
    const result = await runAsync();

    if (!result.ok) {
      setRun((prev) => ({
        ...prev,
        phase: "failed",
        // The server's own reason, never a generic invention.
        message: `The analyzer could not be started (${result.reason}).`,
      }));
      return;
    }

    if (!result.queued) {
      // 202 with queued:false — the run row exists, the queue refused it.
      setRun((prev) => ({
        ...prev,
        phase: "failed",
        runId: result.runId,
        message:
          "The analysis was recorded but could not be queued for processing. It stays pending until the queue is available.",
      }));
      return;
    }

    setRun((prev) => ({
      ...prev,
      phase: "queued",
      runId: result.runId,
      message: "Analysis queued.",
    }));
  }, [runInFlight, runAsync, state.data]);

  /**
   * THE TERMINAL STATE COMES FROM THE RUN ROW, not from a side effect.
   *
   * The previous version inferred completion by watching the observation COUNT
   * change against a baseline. A re-run that produces no new observations —
   * the normal case on an already-analysed record — never changes the count, so
   * the bounded wait always expired and the panel said "still processing"
   * forever. `GET /media-intelligence` now projects `latestRun`, so the run
   * reports its own PENDING / PROCESSING / COMPLETED / FAILED state.
   */
  useEffect(() => {
    if (!runInFlight) return;
    const latest = state.data?.latestRun ?? null;
    if (!latest) return;

    if (latest.status === "PROCESSING" && run.phase !== "running") {
      setRun((prev) => ({
        ...prev,
        phase: "running",
        runId: latest.runId,
        message: latest.startedAtUtc
          ? `Analysis running since ${formatTimestamp(latest.startedAtUtc)}.`
          : "Analysis running…",
      }));
      return;
    }

    if (latest.status === "COMPLETED") {
      // Counts come from the COMPLETED run's own projection and the list it
      // produced — never from stale client state. `added` is the delta against
      // the list as it stood when this run was accepted.
      const total = state.data?.signals.length ?? 0;
      const added = run.baseline === null ? null : Math.max(0, total - run.baseline);
      setRun((prev) => ({
        ...prev,
        phase: "completed",
        runId: latest.runId,
        completedAtUtc: latest.completedAtUtc,
        added,
        total,
        message: null,
      }));
      return;
    }

    if (latest.status === "FAILED") {
      setRun((prev) => ({
        ...prev,
        phase: "failed",
        runId: latest.runId,
        message: latest.lastError
          ? `The analysis failed: ${latest.lastError}`
          : "The analysis failed. No reason was recorded.",
      }));
    }
  }, [runInFlight, run.phase, run.baseline, state.data]);

  /**
   * A DELIBERATE BOUNDED TIMEOUT.
   *
   * A run that never reaches a terminal state is reported as stalled with a way
   * to re-check — never left spinning, and never quietly marked complete.
   */
  useEffect(() => {
    if (!runInFlight) return;
    const t = setInterval(() => {
      setRun((prev) => {
        if (prev.phase !== "queued" && prev.phase !== "running") return prev;
        const polls = prev.polls + 1;
        if (polls > stallAfterPolls) {
          return {
            ...prev,
            phase: "stalled",
            polls,
            message:
              "The analysis has not reported a result yet. It may still be processing.",
          };
        }
        return { ...prev, polls };
      });
    }, 4_000);
    return () => clearInterval(t);
  }, [runInFlight, stallAfterPolls]);

  /** Re-read observations once the run reaches a terminal state. */
  useEffect(() => {
    if (run.phase !== "completed") return;
    void refresh();
  }, [run.phase, refresh]);

  const handleRefreshStatus = useCallback(async () => {
    await refresh();
    setRun((prev) => ({ ...prev, phase: "idle", message: null, polls: 0 }));
  }, [refresh]);

  const handleAck = useCallback(
    async (signalId: string, action: "ACKNOWLEDGED" | "DISMISSED") => {
      if (pendingAcks[signalId]) return;
      setAckError(null);
      setPendingAcks((prev) => ({ ...prev, [signalId]: true }));
      const result = await ack(signalId, action);
      setPendingAcks((prev) => {
        const next = { ...prev };
        delete next[signalId];
        return next;
      });
      if (!result.ok) {
        setAckError(
          action === "ACKNOWLEDGED"
            ? "The observation could not be acknowledged. Nothing was changed."
            : "The observation could not be dismissed. Nothing was changed.",
        );
        return;
      }
      // Re-read from the server so the rendered status is the PERSISTED one
      // rather than only the optimistic local edit.
      await refresh();
    },
    [ack, pendingAcks, refresh],
  );

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
      <PanelHeader onRunAnalyzer={handleRunAnalyzer} running={runInFlight} phase={run.phase} />

      <p className="evd-muted">
        These are deterministic metadata observations. They are advisory
        workflow signals only: they do not establish authenticity, factual
        truth, or legal admissibility.
      </p>

      {/* The run's own state, stated. Polite live region so a screen reader
          hears the outcome without the focus moving. */}
      {run.phase !== "idle" ? (
        <div
          className="mi-runstate"
          role="status"
          aria-live="polite"
          data-media-intelligence-run-state={run.phase}
        >
          {run.phase === "completed" ? (
            <div className="mi-result" data-media-intelligence-result>
              <p className="mi-result__head">
                <Check size={15} strokeWidth={2.4} aria-hidden="true" />
                Analysis complete
              </p>
              <p className="mi-result__line" data-media-intelligence-new={run.added ?? 0}>
                {run.added === 0 || run.added === null
                  ? "No new observations were found."
                  : `${run.added} new observation${run.added === 1 ? "" : "s"} ${run.added === 1 ? "was" : "were"} recorded.`}
              </p>
              <p className="mi-result__line" data-media-intelligence-total={run.total ?? 0}>
                {/* The total is stated on its own line so it can never be read
                    as the number this run produced. */}
                {run.total === 0
                  ? "No observations are recorded for this evidence."
                  : run.added === 0 || run.added === null
                    ? `${run.total} existing observation${run.total === 1 ? "" : "s"} remain available for review.`
                    : `${run.total} observation${run.total === 1 ? " is" : "s are"} now recorded in total.`}
              </p>
              {run.completedAtUtc ? (
                <p className="mi-result__line mi-result__line--meta">
                  Completed {formatTimestamp(run.completedAtUtc)}
                </p>
              ) : null}
            </div>
          ) : (
            <p className={run.phase === "failed" ? "evd-error" : "evd-muted evd-muted--small"}>
              {run.message}
            </p>
          )}
          {run.phase === "failed" ? (
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => void handleRunAnalyzer()}
              data-media-intelligence-retry
            >
              Retry analysis
            </button>
          ) : null}
          {run.phase === "stalled" ? (
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => void handleRefreshStatus()}
              data-media-intelligence-refresh
            >
              Refresh status
            </button>
          ) : null}
        </div>
      ) : null}

      {ackError ? (
        <p className="evd-error" role="alert" data-media-intelligence-ack-error>
          {ackError}
        </p>
      ) : null}

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

      {openSignals.length > 0 ? (
        <p className="evd-muted evd-muted--small mi-action-help" id="mi-action-help">
          <strong>Acknowledge</strong> marks an observation as reviewed for
          workflow purposes; it does not verify the evidence.{" "}
          <strong>Dismiss</strong> marks it as not actionable; it does not delete
          the evidence or its audit history.
        </p>
      ) : null}

      {openSignals.length > 0 ? (
        <ul className="evd-list" data-media-intelligence-group="open">
          {openSignals.map((signal) => (
            <SignalRow
              key={signal.id}
              signal={signal}
              pending={Boolean(pendingAcks[signal.id])}
              onAck={(action) => {
                void handleAck(signal.id, action);
              }}
            />
          ))}
        </ul>
      ) : null}

      {/* Resolved observations keep their individual audit records. They are
          collapsed once there are enough of them to bury the open ones. */}
      {resolvedSignals.length > 0 ? (
        <details
          className="evd-stack"
          data-media-intelligence-group="resolved"
        >
          <summary className="evd-disclosure-summary">
            Resolved observations ({resolvedSignals.length})
          </summary>
          <ul className="evd-list">
            {resolvedSignals.map((signal) => (
              <SignalRow
                key={signal.id}
                signal={signal}
                pending={Boolean(pendingAcks[signal.id])}
                onAck={(action) => {
                  void handleAck(signal.id, action);
                }}
              />
            ))}
          </ul>
        </details>
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
  phase,
}: {
  onRunAnalyzer?: () => void | Promise<void>;
  running?: boolean;
  phase?: string;
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
          {phase === "queued" ? "Queued…" : phase === "running" ? "Running…" : "Run analyzer"}
        </button>
      ) : null}
    </header>
  );
}

function SignalRow({
  signal,
  pending,
  onAck,
}: {
  signal: MediaIntelligenceSignal;
  pending: boolean;
  onAck: (action: Extract<ClientStatus, "ACKNOWLEDGED" | "DISMISSED">) => void;
}) {
  const isOpen = signal.status === "PENDING";
  // One section-level description, referenced by every row's controls.
  const helpId = "mi-action-help";
  return (
    <li className="evd-card">
      <div className="evd-card-header" data-media-intelligence-statuses>
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
              className="app-secondary-action mi-acknowledge"
              onClick={() => onAck("ACKNOWLEDGED")}
              disabled={pending}
              aria-busy={pending}
              aria-describedby={helpId}
              data-media-intelligence-action="acknowledge"
            >
              {pending ? (
                "Working…"
              ) : (
                <>
                  <Check size={15} strokeWidth={2.2} aria-hidden="true" />
                  Acknowledge
                </>
              )}
            </button>
            <button
              type="button"
              className="app-secondary-action mi-dismiss"
              onClick={() => onAck("DISMISSED")}
              disabled={pending}
              aria-busy={pending}
              aria-describedby={helpId}
              data-media-intelligence-action="dismiss"
            >
              {pending ? (
                "Working…"
              ) : (
                <>
                  <X size={15} strokeWidth={2.2} aria-hidden="true" />
                  Dismiss
                </>
              )}
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
  // The resolved states carry the tone of the action that produced them —
  // the canonical success green for Acknowledged, the canonical danger red
  // for Dismissed — so the badge and the button that set it read as one
  // workflow. They remain badges: text, never a control.
  if (status === "ACKNOWLEDGED") return "green";
  if (status === "DISMISSED") return "red";
  return "blue";
}
