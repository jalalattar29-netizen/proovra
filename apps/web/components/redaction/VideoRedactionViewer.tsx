"use client";

/**
 * PROOVRA Phase 3A — Video redaction viewer.
 *
 * Bounded timeline-aware region authoring for VIDEO redaction.
 * Operators select a frame range (startFrame..endFrame) and draw
 * a normalized bbox; the region is persisted as `VIDEO_FRAME_BBOX`
 * with the matching method.
 *
 * Hard rules:
 *   * The viewer never holds the original video bytes — it only
 *     authors the bounded geometry the worker pipeline will mask.
 *   * `trackingId` is optional and bounded — it lets the worker
 *     pipeline keep continuity across frames when a future
 *     tracker is wired in.
 */

import { useCallback, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";

export function VideoRedactionViewer({
  evidenceId,
  versionId,
  versionLocked,
  onChanged,
}: {
  evidenceId: string;
  versionId: string;
  versionLocked: boolean;
  onChanged: () => void;
}) {
  const [startFrame, setStartFrame] = useState<number>(0);
  const [endFrame, setEndFrame] = useState<number>(30);
  const [method, setMethod] = useState<"BLUR" | "PIXELATE" | "BLACKOUT">(
    "BLUR",
  );
  const [trackingId, setTrackingId] = useState<string>("");
  const [drag, setDrag] = useState<null | {
    startX: number;
    startY: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  void evidenceId;

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (versionLocked) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      setDrag({ startX: x, startY: y, x, y, w: 0, h: 0 });
    },
    [versionLocked],
  );
  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!drag || versionLocked) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const w = Math.abs(x - drag.startX);
      const h = Math.abs(y - drag.startY);
      const minX = Math.min(x, drag.startX);
      const minY = Math.min(y, drag.startY);
      setDrag({ ...drag, x: minX, y: minY, w, h });
    },
    [drag, versionLocked],
  );
  const onMouseUp = useCallback(async () => {
    if (!drag || versionLocked) return;
    if (endFrame < startFrame) return;
    const bbox = {
      x: Math.max(0, Math.min(1, drag.x)),
      y: Math.max(0, Math.min(1, drag.y)),
      width: Math.max(0.005, Math.min(1 - drag.x, drag.w)),
      height: Math.max(0.005, Math.min(1 - drag.y, drag.h)),
    };
    setDrag(null);
    try {
      await apiFetch(`/v1/redaction/versions/${versionId}/regions`, {
        method: "POST",
        body: JSON.stringify({
          kind: "VIDEO_FRAME_BBOX",
          method,
          geometry: {
            startFrame,
            endFrame,
            bbox,
            ...(trackingId.trim() ? { trackingId: trackingId.trim() } : {}),
          },
        }),
      });
      onChanged();
    } catch {
      /* swallow */
    }
  }, [
    drag,
    endFrame,
    method,
    onChanged,
    startFrame,
    trackingId,
    versionId,
    versionLocked,
  ]);

  return (
    <section
      data-redaction-video-viewer
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 13 }}>Video redaction</strong>
        <label style={{ fontSize: 11, color: "#475569", marginLeft: 12 }}>
          Start frame
          <input
            data-redaction-video-start-frame
            type="number"
            min={0}
            value={startFrame}
            onChange={(e) => setStartFrame(Number(e.target.value))}
            disabled={versionLocked}
            style={frameInputStyle}
          />
        </label>
        <label style={{ fontSize: 11, color: "#475569" }}>
          End frame
          <input
            data-redaction-video-end-frame
            type="number"
            min={0}
            value={endFrame}
            onChange={(e) => setEndFrame(Number(e.target.value))}
            disabled={versionLocked}
            style={frameInputStyle}
          />
        </label>
        <label style={{ fontSize: 11, color: "#475569" }}>
          Tracking id (optional)
          <input
            data-redaction-video-tracking-id
            value={trackingId}
            onChange={(e) => setTrackingId(e.target.value)}
            disabled={versionLocked}
            style={{
              ...frameInputStyle,
              width: 90,
            }}
          />
        </label>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 11, color: "#475569" }}>
          Method&nbsp;
          <select
            data-redaction-video-method
            value={method}
            onChange={(e) =>
              setMethod(
                e.target.value as "BLUR" | "PIXELATE" | "BLACKOUT",
              )
            }
            disabled={versionLocked}
            style={{
              padding: "3px 6px",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              fontSize: 11,
            }}
          >
            <option value="BLUR">BLUR</option>
            <option value="PIXELATE">PIXELATE</option>
            <option value="BLACKOUT">BLACKOUT</option>
          </select>
        </label>
      </header>

      <div
        ref={containerRef}
        data-redaction-video-canvas
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          background:
            "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
          color: "#cbd5e1",
          borderRadius: 8,
          overflow: "hidden",
          cursor: versionLocked ? "not-allowed" : "crosshair",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
          }}
        >
          Frame preview · drag to draw a per-frame region · range&nbsp;
          {startFrame}..{endFrame}
        </span>
        {drag ? (
          <div
            data-redaction-video-active-rect
            style={{
              position: "absolute",
              left: `${drag.x * 100}%`,
              top: `${drag.y * 100}%`,
              width: `${drag.w * 100}%`,
              height: `${drag.h * 100}%`,
              border: "2px solid #fafafa",
              background: "rgba(250, 250, 250, 0.18)",
            }}
          />
        ) : null}
      </div>

      <small
        style={{
          display: "block",
          marginTop: 6,
          color: "#475569",
          fontSize: 11,
        }}
      >
        Regions persist across the bounded frame range. The worker
        ffmpeg pipeline applies the method (blur / pixelate /
        blackout) per frame; the original video is never modified.
      </small>
    </section>
  );
}

const frameInputStyle = {
  marginLeft: 4,
  width: 60,
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  fontSize: 11,
};
