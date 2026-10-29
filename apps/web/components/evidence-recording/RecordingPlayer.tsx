"use client";

/**
 * 2026-10-29 — THE recording player for a continuous screen recording.
 *
 * For a legacy SEGMENTED recording it plays the DERIVED combined video: one
 * <video> on a short-lived presigned URL (S3 honours Range, so seeking never
 * pulls the whole file), the gaps from the lineage drawn on the timeline and
 * listed as "No recording: X s" (click to jump past), and the downloads:
 *   * "Download combined recording (derived)" — the combined MP4;
 *   * "Download recording" — only when the parent supplies a single-file
 *     recording download (a new recording is already one file);
 *   * "Original technical files" — the segments and the capture record.
 * Readiness: "Preparing combined video" while the worker runs; "Combined video
 * unavailable — original segments remain available" when it cannot be made.
 *
 * Everything combined is labelled DERIVED. Mounted by the evidence page
 * (OUTPUTS); this component owns no routing.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  SCREEN_RECORDING_COMBINE_COPY,
  screenRecordingCombineHeadline,
  screenRecordingGapLabel,
} from "@proovra/shared";

import { useCombinedRecording } from "./useCombinedRecording";

export type RecordingPlayerProps = {
  evidenceId: string;
  /** The workspace the record is addressed through (null ⇒ nothing is fetched). */
  teamId: string | null;
  /** Opens the original segments + capture record (technical files). */
  onShowOriginalFiles?: () => void;
  /** A single-file recording's own download (new recordings). */
  onDownloadRecording?: () => void;
  /** May this person start preparation for a historical record? */
  canPrepare?: boolean;
};

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function RecordingPlayer(props: RecordingPlayerProps) {
  const { evidenceId, teamId, onShowOriginalFiles, onDownloadRecording, canPrepare } = props;
  const { view, loading, error, preparing, prepare, issue } = useCombinedRecording(evidenceId, teamId);
  const [src, setSrc] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);

  const combined = view?.combined ?? null;
  const allowed = view?.release.allowed === true;

  // The playback URL is issued once the combined video exists and may be released.
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    if (view?.state !== "COMPLETED" || !allowed || !combined) return;
    void issue("playback").then((u) => {
      if (!cancelled && u) setSrc(u.url);
    });
    return () => {
      cancelled = true;
    };
  }, [view?.state, allowed, combined?.assetId, issue]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = useCallback(async () => {
    setDownloading(true);
    try {
      const u = await issue("download");
      if (u) {
        const a = document.createElement("a");
        a.href = u.url;
        a.download = u.filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } finally {
      setDownloading(false);
    }
  }, [issue]);

  const seekTo = (ms: number) => {
    if (video.current) video.current.currentTime = ms / 1000;
  };

  if (!teamId) return null;
  if (loading && !view) {
    return (
      <section className="evidence-recording" aria-busy="true" data-testid="recording-player">
        <p>Loading recording…</p>
      </section>
    );
  }
  if (!view) {
    return error ? (
      <section className="evidence-recording" data-testid="recording-player">
        <p role="alert">{SCREEN_RECORDING_COMBINE_COPY.unavailable}</p>
        {onShowOriginalFiles ? (
          <button type="button" onClick={onShowOriginalFiles}>
            {SCREEN_RECORDING_COMBINE_COPY.originals}
          </button>
        ) : null}
      </section>
    ) : null;
  }

  const originals = onShowOriginalFiles ? (
    <button type="button" className="evidence-recording__originals" onClick={onShowOriginalFiles}>
      {SCREEN_RECORDING_COMBINE_COPY.originals}
    </button>
  ) : null;
  const singleDownload = onDownloadRecording ? (
    <button type="button" onClick={onDownloadRecording}>
      {SCREEN_RECORDING_COMBINE_COPY.downloadRecording}
    </button>
  ) : null;

  if (view.state === "NOT_APPLICABLE") {
    return singleDownload || originals ? (
      <section className="evidence-recording" data-testid="recording-player">
        <div className="evidence-recording__actions">
          {singleDownload}
          {originals}
        </div>
      </section>
    ) : null;
  }

  const headline = screenRecordingCombineHeadline(view.state);
  const durationMs = combined?.durationMs ?? null;
  const inTimeline = (combined?.gaps ?? []).filter((g) => g.atMs !== null && g.durationMs !== null);
  const outside = (combined?.gaps ?? []).filter((g) => g.atMs === null);

  return (
    <section className="evidence-recording" data-testid="recording-player" data-state={view.state}>
      <header className="evidence-recording__header">
        <h3>Screen recording</h3>
        {combined ? (
          <span className="evidence-recording__badge" data-testid="derived-badge">
            {SCREEN_RECORDING_COMBINE_COPY.derivedLabel}
          </span>
        ) : null}
      </header>

      {headline ? (
        <p role="status" data-testid="recording-headline">
          {headline}
        </p>
      ) : null}

      {view.state === "NOT_STARTED" && canPrepare ? (
        <button type="button" onClick={() => void prepare()} disabled={preparing}>
          {preparing ? "Starting…" : "Prepare combined video"}
        </button>
      ) : null}

      {view.state === "COMPLETED" && combined ? (
        <>
          {allowed ? (
            <video
              ref={video}
              data-testid="recording-video"
              controls
              preload="metadata"
              playsInline
              src={src ?? undefined}
              aria-label="Combined screen recording (derived)"
            />
          ) : (
            <p role="note">
              You can see that a combined video exists, but your access does not include downloading recordings
              {view.release.code ? ` (${view.release.code})` : ""}.
            </p>
          )}

          {durationMs && inTimeline.length > 0 ? (
            <div className="evidence-recording__timeline" aria-hidden="true" data-testid="gap-timeline">
              {inTimeline.map((g, i) => (
                <span
                  key={i}
                  className="evidence-recording__gap"
                  title={screenRecordingGapLabel(g)}
                  style={{
                    left: `${(100 * g.atMs!) / durationMs}%`,
                    width: `${Math.max(0.5, (100 * g.durationMs!) / durationMs)}%`,
                  }}
                />
              ))}
            </div>
          ) : null}

          {combined.completeness === "PARTIAL" ? (
            <p role="note" data-testid="recording-partial">
              {SCREEN_RECORDING_COMBINE_COPY.partial}
            </p>
          ) : null}

          {inTimeline.length + outside.length > 0 ? (
            <ul className="evidence-recording__gaps" data-testid="gap-list">
              {inTimeline.map((g, i) => (
                <li key={`t${i}`}>
                  <button type="button" onClick={() => seekTo(g.atMs! + g.durationMs!)}>
                    {clock(g.atMs!)} — {screenRecordingGapLabel(g)}
                  </button>
                </li>
              ))}
              {outside.map((g, i) => (
                <li key={`o${i}`}>
                  {g.cause === "HEAD_MISSING" ? "Before the start — " : "After the end — "}
                  {screenRecordingGapLabel(g)}
                </li>
              ))}
            </ul>
          ) : null}

          {combined.statement ? <p className="evidence-recording__statement">{combined.statement}</p> : null}
        </>
      ) : null}

      <div className="evidence-recording__actions">
        {view.state === "COMPLETED" && combined && allowed ? (
          <button type="button" onClick={() => void download()} disabled={downloading}>
            {SCREEN_RECORDING_COMBINE_COPY.downloadCombined}
          </button>
        ) : null}
        {singleDownload}
        {originals}
      </div>

      {error && view.state === "COMPLETED" ? <p role="alert">{SCREEN_RECORDING_COMBINE_COPY.unavailable}</p> : null}
    </section>
  );
}

export default RecordingPlayer;
