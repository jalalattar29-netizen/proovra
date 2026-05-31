"use client";

/**
 * PROOVRA Phase 2B — Watermark overlay.
 *
 * Translucent, non-interactive overlay rendered on top of the
 * evidence viewer. Contains the bounded watermark fields:
 *
 *   reviewer email · session id · grant id · evidence id ·
 *   timestamp · organization (when present)
 *
 * Hard rules:
 *   * `pointer-events: none` so it never blocks the bytes underneath.
 *   * `user-select: none` so casual copy-paste does not extract the
 *     overlay text (the visible accountability remains intact).
 *   * NEVER removed via UI; the visible band repeats across the viewer
 *     surface.
 */

import type { SignedWatermark } from "@proovra/shared";

export function WatermarkOverlay({
  watermark,
}: {
  watermark: SignedWatermark | null;
}) {
  if (!watermark) return null;
  const p = watermark.payload;
  const line =
    `${p.reviewerEmail}` +
    (p.organization ? ` · ${p.organization}` : "") +
    ` · sess:${p.sessionId.slice(0, 8)}` +
    ` · grant:${p.grantId.slice(0, 8)}` +
    ` · ${p.issuedAtUtc.slice(0, 19)}Z`;

  return (
    <div
      data-portal-watermark-overlay
      data-portal-watermark-grant={p.grantId}
      data-portal-watermark-session={p.sessionId}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        userSelect: "none",
        background:
          "repeating-linear-gradient(135deg, rgba(15, 23, 42, 0.06) 0 1px, transparent 1px 80px)",
        overflow: "hidden",
        zIndex: 5,
      }}
    >
      {Array.from({ length: 6 }).map((_, row) => (
        <div
          key={row}
          data-portal-watermark-band={row}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: `${row * 17 + 7}%`,
            transform: "rotate(-12deg)",
            color: "rgba(15, 23, 42, 0.22)",
            fontSize: 13,
            fontWeight: 600,
            whiteSpace: "nowrap",
            textAlign: "center",
            fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
          }}
        >
          {Array.from({ length: 6 }).map((_, col) => (
            <span key={col} style={{ marginRight: 80 }}>
              {line}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
