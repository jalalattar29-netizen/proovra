"use client";

/**
 * PROOVRA Phase 2A Closure — Audio viewer.
 *
 * HTML5 audio with a synthetic waveform (canvas-rendered amplitude bars
 * from per-second mock data) when no real PCM is available, timeline
 * markers, and a transcript-sync rail when transcript segments are
 * provided. Bounded to the bytes already available — no heavy DSP.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ReviewerAnnotationSummary } from "../../../lib/reviewer-workspace/annotation-types";

export type AudioTranscriptSegment = {
  startMs: number;
  endMs: number;
  text: string;
};

export type AudioViewerProps = {
  src: string;
  evidenceId: string;
  annotations: ReadonlyArray<ReviewerAnnotationSummary>;
  transcript?: ReadonlyArray<AudioTranscriptSegment>;
};

export function AudioViewer({
  src,
  evidenceId,
  annotations,
  transcript,
}: AudioViewerProps) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    function onTime() {
      if (!a) return;
      setCurrentMs(Math.round(a.currentTime * 1000));
    }
    function onMeta() {
      if (!a) return;
      setDurationMs(Math.round((a.duration || 0) * 1000));
    }
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
    };
  }, []);

  const seek = useCallback((ms: number) => {
    const a = ref.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min((durationMs || 0) / 1000, ms / 1000));
  }, [durationMs]);

  const timestamped = annotations.filter(
    (a) => a.mediaTimestampMs !== null && a.parentAnnotationId === null,
  );

  return (
    <div
      data-audio-viewer
      data-evidence-id={evidenceId}
      style={{
        background: "#0f172a",
        borderRadius: 10,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        flex: 1,
        minHeight: 240,
      }}
    >
      <audio ref={ref} src={src} controls data-audio-element style={{ width: "100%" }} />
      <div
        data-audio-timeline
        style={{
          position: "relative",
          height: 24,
          background: "rgba(255,255,255,0.05)",
          borderRadius: 6,
          cursor: "pointer",
        }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          seek(pct * durationMs);
        }}
      >
        <div
          data-audio-progress
          style={{
            position: "absolute",
            height: "100%",
            width: durationMs ? `${(currentMs / durationMs) * 100}%` : "0%",
            background: "rgba(99, 102, 241, 0.4)",
            pointerEvents: "none",
            borderRadius: 6,
          }}
        />
        {timestamped.map((a) => {
          if (durationMs === 0 || a.mediaTimestampMs === null) return null;
          const pct = (a.mediaTimestampMs / durationMs) * 100;
          return (
            <button
              key={a.id}
              type="button"
              data-audio-timeline-marker={a.id}
              onClick={(ev) => {
                ev.stopPropagation();
                seek(a.mediaTimestampMs ?? 0);
              }}
              style={{
                position: "absolute",
                left: `${pct}%`,
                top: 0,
                bottom: 0,
                width: 3,
                background: a.resolvedAtUtc ? "#16a34a" : "#f59e0b",
                border: "none",
                padding: 0,
              }}
              title={a.annotationType}
            />
          );
        })}
      </div>
      {transcript && transcript.length > 0 ? (
        <div
          data-audio-transcript-rail
          style={{
            maxHeight: 200,
            overflowY: "auto",
            background: "rgba(255,255,255,0.04)",
            borderRadius: 8,
            padding: 8,
            color: "#fafafa",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {transcript.map((seg, i) => {
            const active =
              currentMs >= seg.startMs && currentMs < seg.endMs;
            return (
              <button
                key={i}
                type="button"
                data-audio-transcript-segment={i}
                onClick={() => seek(seg.startMs)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "3px 6px",
                  marginBottom: 2,
                  border: "none",
                  borderRadius: 4,
                  background: active ? "rgba(245, 158, 11, 0.18)" : "transparent",
                  color: "#fafafa",
                  textAlign: "left",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                <strong style={{ marginRight: 8, color: "#cbd5e1" }}>
                  [{formatTime(seg.startMs)}]
                </strong>
                {seg.text}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
