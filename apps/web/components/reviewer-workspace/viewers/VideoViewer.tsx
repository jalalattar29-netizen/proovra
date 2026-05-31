"use client";

/**
 * PROOVRA Phase 2A Closure — Video viewer.
 *
 * HTML5 video with frame stepping (1/30s by default), bookmarkable
 * timestamps, and timeline-positioned annotation markers. Built on
 * the native <video> element; no heavy media dependencies.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ReviewerAnnotationSummary } from "../../../lib/reviewer-workspace/annotation-types";

export type VideoViewerProps = {
  src: string;
  evidenceId: string;
  annotations: ReadonlyArray<ReviewerAnnotationSummary>;
};

export function VideoViewer({ src, evidenceId, annotations }: VideoViewerProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    function onTime() {
      if (!v) return;
      setCurrentMs(Math.round(v.currentTime * 1000));
    }
    function onMeta() {
      if (!v) return;
      setDurationMs(Math.round((v.duration || 0) * 1000));
    }
    function onPlay() {
      setPlaying(true);
    }
    function onPause() {
      setPlaying(false);
    }
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, []);

  const seek = useCallback((ms: number) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min((durationMs || 0) / 1000, ms / 1000));
  }, [durationMs]);

  const stepFrame = useCallback((dir: 1 | -1) => {
    seek(currentMs + dir * Math.round(1000 / 30));
  }, [currentMs, seek]);

  const togglePlay = useCallback(() => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  const timestamped = annotations.filter(
    (a) =>
      a.mediaTimestampMs !== null &&
      a.parentAnnotationId === null,
  );

  return (
    <div
      data-video-viewer
      data-evidence-id={evidenceId}
      style={{
        background: "#0f172a",
        borderRadius: 10,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minHeight: 320,
        flex: 1,
      }}
    >
      <video
        ref={ref}
        src={src}
        data-video-element
        controls={false}
        style={{ width: "100%", maxHeight: "55vh", background: "#000" }}
      />
      <div
        data-video-toolbar
        style={{
          display: "flex",
          gap: 6,
          padding: "6px 10px",
          background: "rgba(255,255,255,0.04)",
          color: "#fafafa",
          fontSize: 11,
          alignItems: "center",
        }}
      >
        <ToolBtn onClick={togglePlay} dataAttr="video-play-pause">
          {playing ? "❚❚" : "►"}
        </ToolBtn>
        <ToolBtn onClick={() => stepFrame(-1)} dataAttr="video-frame-back">
          ⟸ frame
        </ToolBtn>
        <ToolBtn onClick={() => stepFrame(1)} dataAttr="video-frame-fwd">
          frame ⟹
        </ToolBtn>
        <span data-video-time style={{ minWidth: 90 }}>
          {formatTime(currentMs)} / {formatTime(durationMs)}
        </span>
        <span style={{ flex: 1 }} />
      </div>
      <div
        data-video-timeline
        style={{
          position: "relative",
          height: 28,
          background: "rgba(255,255,255,0.05)",
          cursor: "pointer",
        }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          seek(pct * durationMs);
        }}
      >
        <div
          data-video-progress
          style={{
            position: "absolute",
            height: "100%",
            width: durationMs ? `${(currentMs / durationMs) * 100}%` : "0%",
            background: "rgba(34, 197, 94, 0.4)",
            pointerEvents: "none",
          }}
        />
        {timestamped.map((a) => {
          if (durationMs === 0 || a.mediaTimestampMs === null) return null;
          const pct = (a.mediaTimestampMs / durationMs) * 100;
          return (
            <button
              key={a.id}
              type="button"
              data-video-timeline-marker={a.id}
              onClick={(e) => {
                e.stopPropagation();
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
                cursor: "pointer",
              }}
              title={`${formatTime(a.mediaTimestampMs)} · ${a.annotationType}`}
            />
          );
        })}
      </div>
    </div>
  );
}

function ToolBtn({
  onClick,
  children,
  dataAttr,
}: {
  onClick: () => void;
  children: React.ReactNode;
  dataAttr: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-video-toolbar-btn={dataAttr}
      style={{
        background: "transparent",
        border: "1px solid rgba(255,255,255,0.16)",
        color: "#fafafa",
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: 6,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const tenths = Math.floor((ms % 1000) / 100);
  return `${m}:${s.toString().padStart(2, "0")}.${tenths}`;
}
