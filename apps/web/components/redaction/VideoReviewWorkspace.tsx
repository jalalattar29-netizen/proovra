"use client";

/**
 * PROOVRA Phase 3A Elite Closure — Video Review Workspace.
 *
 * Single-pane multi-layer timeline that the operator reviews a
 * video redaction project through. Layers (FRAME / DETECTION /
 * TRACKING / APPROVAL / CONFIDENCE / COMMENT / DECISION /
 * DERIVATIVE) render as horizontal bands; tracks render as
 * coloured spans within the TRACKING layer. Range / track / bulk
 * operations live in a sticky action bar above the timeline.
 *
 * Hard rules:
 *   * All actions round-trip through the bounded API.
 *   * NEVER renders the original video bytes; the timeline is
 *     metadata only.
 *   * Track segment colour reflects bounded state (SUGGESTED /
 *     ACCEPTED / REJECTED / MERGED / SPLIT) so the operator can
 *     scan the whole video at a glance.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  VIDEO_TIMELINE_LAYERS,
  type VideoTimelineLayer,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";

type TrackRow = {
  id: string;
  kind: string;
  label: string | null;
  method: string;
  startFrame: number;
  endFrame: number;
  state: string;
  confidenceBand: string;
  decisionByUserId: string | null;
  decidedAtUtc: string | null;
  detectionCount: number;
};

type TimelineEventRow = {
  id: string;
  code: string;
  label: string | null;
  startFrame: number;
  endFrame: number;
  startMs: number;
  endMs: number;
  trackId: string | null;
  actorUserId: string | null;
  occurredAtUtc: string;
};

type Timeline = {
  schemaVersion: string;
  generatedAtUtc: string;
  evidenceId: string;
  totalFrames: number;
  totalDurationMs: number;
  layers: Partial<Record<VideoTimelineLayer, TimelineEventRow[]>>;
  tracks: TrackRow[];
};

export function VideoReviewWorkspace({
  evidenceId,
  versionLocked,
  onChanged,
}: {
  evidenceId: string;
  versionLocked: boolean;
  onChanged: () => void;
}) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(
    new Set(),
  );
  const [rangeStart, setRangeStart] = useState<number>(0);
  const [rangeEnd, setRangeEnd] = useState<number>(0);
  const [splitFrame, setSplitFrame] = useState<number>(0);
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/v1/redaction/videos/${encodeURIComponent(evidenceId)}/timeline`,
        { method: "GET" },
      );
      setTimeline(res?.timeline ?? null);
    } catch {
      setTimeline(null);
    }
  }, [evidenceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totalFrames = timeline?.totalFrames ?? 0;
  const totalDurationMs = timeline?.totalDurationMs ?? 0;

  const onDecideTrack = useCallback(
    async (trackId: string, toState: "ACCEPTED" | "REJECTED" | "MODIFIED") => {
      try {
        await apiFetch(
          `/v1/redaction/video-tracks/${trackId}/decision`,
          {
            method: "POST",
            body: JSON.stringify({ toState }),
          },
        );
        setBanner(`Track ${toState.toLowerCase()}`);
        await refresh();
        onChanged();
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setBanner(`Refused: ${((err as any)?.denial ?? "POLICY_REJECTED")}`);
      }
    },
    [refresh, onChanged],
  );

  const onPropagateRange = useCallback(
    async (toState: "ACCEPTED" | "REJECTED") => {
      if (rangeEnd < rangeStart) return;
      try {
        const res = await apiFetch(
          `/v1/redaction/videos/${encodeURIComponent(evidenceId)}/decisions/range`,
          {
            method: "POST",
            body: JSON.stringify({
              startFrame: rangeStart,
              endFrame: rangeEnd,
              toState,
            }),
          },
        );
        setBanner(
          `Range ${toState.toLowerCase()} · ${(res?.affectedTrackIds ?? []).length} tracks affected`,
        );
        await refresh();
        onChanged();
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setBanner(`Refused: ${((err as any)?.denial ?? "POLICY_REJECTED")}`);
      }
    },
    [evidenceId, rangeStart, rangeEnd, refresh, onChanged],
  );

  const onMergeSelected = useCallback(async () => {
    const ids = Array.from(selectedTrackIds);
    if (ids.length < 2) return;
    try {
      await apiFetch(`/v1/redaction/video-tracks/merge`, {
        method: "POST",
        body: JSON.stringify({ trackIds: ids }),
      });
      setBanner(`Merged ${ids.length} tracks`);
      setSelectedTrackIds(new Set());
      await refresh();
      onChanged();
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setBanner(`Refused: ${((err as any)?.denial ?? "POLICY_REJECTED")}`);
    }
  }, [selectedTrackIds, refresh, onChanged]);

  const onSplitTrack = useCallback(
    async (trackId: string) => {
      try {
        await apiFetch(`/v1/redaction/video-tracks/${trackId}/split`, {
          method: "POST",
          body: JSON.stringify({ splitAfterFrame: splitFrame }),
        });
        setBanner(`Track split at frame ${splitFrame}`);
        await refresh();
        onChanged();
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setBanner(`Refused: ${((err as any)?.denial ?? "POLICY_REJECTED")}`);
      }
    },
    [splitFrame, refresh, onChanged],
  );

  const toggleSelected = useCallback((trackId: string) => {
    setSelectedTrackIds((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }, []);

  return (
    <section
      data-redaction-video-review-workspace
      data-redaction-video-evidence={evidenceId}
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
          alignItems: "baseline",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 13 }}>Video review workspace</strong>
        <span style={{ flex: 1 }} />
        <small style={{ color: "#475569", fontSize: 11 }}>
          {totalFrames} frames · {Math.round(totalDurationMs / 1000)}s
        </small>
      </header>

      {banner ? (
        <div
          data-redaction-video-banner
          style={{
            marginBottom: 8,
            padding: "6px 10px",
            background: "rgba(15, 23, 42, 0.05)",
            borderRadius: 6,
            fontSize: 11,
          }}
        >
          {banner}
        </div>
      ) : null}

      <div
        data-redaction-video-bulk-bar
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          padding: 8,
          background: "rgba(15, 23, 42, 0.04)",
          borderRadius: 8,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <label style={lblStyle}>
          Range
          <input
            data-redaction-video-range-start
            type="number"
            min={0}
            value={rangeStart}
            onChange={(e) => setRangeStart(Number(e.target.value))}
            disabled={versionLocked}
            style={numInputStyle}
          />
          to
          <input
            data-redaction-video-range-end
            type="number"
            min={0}
            value={rangeEnd}
            onChange={(e) => setRangeEnd(Number(e.target.value))}
            disabled={versionLocked}
            style={numInputStyle}
          />
        </label>
        <button
          type="button"
          data-redaction-video-range-approve
          onClick={() => onPropagateRange("ACCEPTED")}
          disabled={versionLocked || rangeEnd < rangeStart}
          style={smallActionGreen}
        >
          Approve range
        </button>
        <button
          type="button"
          data-redaction-video-range-reject
          onClick={() => onPropagateRange("REJECTED")}
          disabled={versionLocked || rangeEnd < rangeStart}
          style={smallActionRed}
        >
          Reject range
        </button>
        <span style={{ width: 8 }} />
        <label style={lblStyle}>
          Split at
          <input
            data-redaction-video-split-frame
            type="number"
            min={0}
            value={splitFrame}
            onChange={(e) => setSplitFrame(Number(e.target.value))}
            disabled={versionLocked}
            style={numInputStyle}
          />
        </label>
        <button
          type="button"
          data-redaction-video-merge-selected
          onClick={onMergeSelected}
          disabled={versionLocked || selectedTrackIds.size < 2}
          style={smallActionBlue}
        >
          Merge selected ({selectedTrackIds.size})
        </button>
      </div>

      <TimelineCanvas
        timeline={timeline}
        selectedTrackIds={selectedTrackIds}
        toggleSelected={toggleSelected}
      />

      <TracksTable
        tracks={timeline?.tracks ?? []}
        versionLocked={versionLocked}
        selectedTrackIds={selectedTrackIds}
        toggleSelected={toggleSelected}
        onDecideTrack={onDecideTrack}
        onSplitTrack={onSplitTrack}
      />
    </section>
  );
}

function TimelineCanvas({
  timeline,
  selectedTrackIds,
  toggleSelected,
}: {
  timeline: Timeline | null;
  selectedTrackIds: Set<string>;
  toggleSelected: (trackId: string) => void;
}) {
  const totalFrames = timeline?.totalFrames ?? 0;
  const layers = useMemo(
    () => VIDEO_TIMELINE_LAYERS as ReadonlyArray<VideoTimelineLayer>,
    [],
  );
  return (
    <section
      data-redaction-video-timeline
      style={{
        marginBottom: 10,
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: 8,
      }}
    >
      <strong style={{ fontSize: 12, color: "#0f172a" }}>
        Multi-layer timeline
      </strong>
      <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
        {layers.map((layer) => (
          <div
            key={layer}
            data-redaction-video-timeline-layer={layer}
            style={{
              display: "grid",
              gridTemplateColumns: "120px 1fr",
              gap: 8,
              alignItems: "center",
            }}
          >
            <small
              style={{
                fontSize: 11,
                color: "#475569",
                fontWeight: 600,
              }}
            >
              {layer}
            </small>
            <div
              style={{
                position: "relative",
                height: layer === "TRACKING" ? 28 : 16,
                background: "rgba(15, 23, 42, 0.04)",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              {layer === "TRACKING"
                ? (timeline?.tracks ?? []).map((t) =>
                    renderTrackSegment(
                      t,
                      totalFrames,
                      selectedTrackIds.has(t.id),
                      toggleSelected,
                    ),
                  )
                : (timeline?.layers[layer] ?? []).map((e) =>
                    renderTimelineEvent(e, totalFrames),
                  )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function renderTrackSegment(
  t: TrackRow,
  totalFrames: number,
  isSelected: boolean,
  toggleSelected: (id: string) => void,
): React.ReactNode {
  if (totalFrames <= 0) return null;
  const left = (t.startFrame / totalFrames) * 100;
  const width = Math.max(
    0.4,
    ((t.endFrame - t.startFrame + 1) / totalFrames) * 100,
  );
  const color = trackColour(t.state);
  return (
    <div
      key={t.id}
      data-redaction-video-track-span={t.id}
      data-redaction-video-track-state={t.state}
      title={`${t.label ?? t.kind} · ${t.state} · ${t.startFrame}..${t.endFrame}`}
      onClick={() => toggleSelected(t.id)}
      style={{
        position: "absolute",
        left: `${left}%`,
        width: `${width}%`,
        top: 4,
        bottom: 4,
        background: color.bg,
        border: isSelected ? "2px solid #0f172a" : `1px solid ${color.border}`,
        borderRadius: 4,
        cursor: "pointer",
      }}
    />
  );
}

function renderTimelineEvent(
  e: TimelineEventRow,
  totalFrames: number,
): React.ReactNode {
  if (totalFrames <= 0) return null;
  const left = (e.startFrame / totalFrames) * 100;
  const width = Math.max(
    0.2,
    ((e.endFrame - e.startFrame + 1) / totalFrames) * 100,
  );
  return (
    <div
      key={e.id}
      data-redaction-video-timeline-event={e.code}
      title={`${e.code} · ${e.label ?? ""} · ${e.startFrame}..${e.endFrame}`}
      style={{
        position: "absolute",
        left: `${left}%`,
        width: `${width}%`,
        top: 2,
        bottom: 2,
        background: "rgba(59, 130, 246, 0.4)",
        borderRadius: 3,
      }}
    />
  );
}

function TracksTable({
  tracks,
  versionLocked,
  selectedTrackIds,
  toggleSelected,
  onDecideTrack,
  onSplitTrack,
}: {
  tracks: ReadonlyArray<TrackRow>;
  versionLocked: boolean;
  selectedTrackIds: Set<string>;
  toggleSelected: (trackId: string) => void;
  onDecideTrack: (
    trackId: string,
    toState: "ACCEPTED" | "REJECTED" | "MODIFIED",
  ) => void;
  onSplitTrack: (trackId: string) => void;
}) {
  if (tracks.length === 0) {
    return (
      <p
        data-redaction-video-tracks-empty
        style={{ color: "#475569", fontSize: 12, margin: 0 }}
      >
        No tracks yet. Run video detection or draw a manual track to begin.
      </p>
    );
  }
  return (
    <table
      data-redaction-video-tracks-table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 11,
      }}
    >
      <thead>
        <tr style={{ textAlign: "left", color: "#475569" }}>
          <th style={th}></th>
          <th style={th}>Track</th>
          <th style={th}>Kind</th>
          <th style={th}>Range</th>
          <th style={th}>Confidence</th>
          <th style={th}>State</th>
          <th style={th}>Decide</th>
          <th style={th}>Split</th>
        </tr>
      </thead>
      <tbody>
        {tracks.map((t) => (
          <tr
            key={t.id}
            data-redaction-video-track-row={t.id}
            data-redaction-video-track-state={t.state}
          >
            <td style={td}>
              <input
                data-redaction-video-track-select={t.id}
                type="checkbox"
                checked={selectedTrackIds.has(t.id)}
                onChange={() => toggleSelected(t.id)}
              />
            </td>
            <td style={td}>{t.label ?? `Track ${t.id.slice(0, 8)}`}</td>
            <td style={td}>
              <code>{t.kind}</code>
            </td>
            <td style={td}>
              {t.startFrame}..{t.endFrame}
            </td>
            <td style={td}>{t.confidenceBand}</td>
            <td style={td}>
              <Chip label={t.state} tone={trackTone(t.state)} />
            </td>
            <td style={td}>
              {t.state === "SUGGESTED" && !versionLocked ? (
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    type="button"
                    data-redaction-video-track-approve={t.id}
                    onClick={() => onDecideTrack(t.id, "ACCEPTED")}
                    style={smallActionGreen}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    data-redaction-video-track-reject={t.id}
                    onClick={() => onDecideTrack(t.id, "REJECTED")}
                    style={smallActionRed}
                  >
                    Reject
                  </button>
                </div>
              ) : (
                <span style={{ color: "#475569" }}>—</span>
              )}
            </td>
            <td style={td}>
              {!versionLocked ? (
                <button
                  type="button"
                  data-redaction-video-track-split={t.id}
                  onClick={() => onSplitTrack(t.id)}
                  style={subtleButton}
                >
                  Split
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function trackColour(state: string): { bg: string; border: string } {
  switch (state) {
    case "ACCEPTED":
      return { bg: "rgba(34, 197, 94, 0.35)", border: "rgba(34, 197, 94, 0.6)" };
    case "REJECTED":
      return { bg: "rgba(239, 68, 68, 0.35)", border: "rgba(239, 68, 68, 0.6)" };
    case "MERGED":
    case "SPLIT":
      return { bg: "rgba(15, 23, 42, 0.18)", border: "rgba(15, 23, 42, 0.35)" };
    case "MODIFIED":
      return { bg: "rgba(245, 158, 11, 0.35)", border: "rgba(245, 158, 11, 0.6)" };
    default:
      return { bg: "rgba(59, 130, 246, 0.3)", border: "rgba(59, 130, 246, 0.55)" };
  }
}

function Chip({
  label,
  tone,
}: {
  label: string;
  tone: "ok" | "info" | "muted" | "warn";
}) {
  const palette = {
    ok: { bg: "rgba(34, 197, 94, 0.12)", fg: "#166534" },
    info: { bg: "rgba(59, 130, 246, 0.1)", fg: "#1e3a8a" },
    muted: { bg: "rgba(15, 23, 42, 0.06)", fg: "#0f172a" },
    warn: { bg: "rgba(239, 68, 68, 0.1)", fg: "#7f1d1d" },
  }[tone];
  return (
    <span
      style={{
        padding: "1px 6px",
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        fontSize: 10,
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
}

function trackTone(state: string): "ok" | "info" | "muted" | "warn" {
  switch (state) {
    case "ACCEPTED":
      return "ok";
    case "REJECTED":
      return "warn";
    case "MERGED":
    case "SPLIT":
      return "muted";
    case "MODIFIED":
      return "info";
    default:
      return "info";
  }
}

const lblStyle = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontSize: 11,
  color: "#475569",
} as const;
const numInputStyle = {
  width: 64,
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  fontSize: 11,
} as const;
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
const smallActionGreen = {
  padding: "3px 8px",
  border: "1px solid #16a34a",
  background: "#16a34a",
  color: "#fff",
  fontSize: 10,
  borderRadius: 6,
  cursor: "pointer",
} as const;
const smallActionRed = {
  padding: "3px 8px",
  border: "1px solid #dc2626",
  background: "#fff",
  color: "#dc2626",
  fontSize: 10,
  borderRadius: 6,
  cursor: "pointer",
} as const;
const smallActionBlue = {
  padding: "3px 8px",
  border: "1px solid #1e3a8a",
  background: "#1e3a8a",
  color: "#fff",
  fontSize: 10,
  borderRadius: 6,
  cursor: "pointer",
} as const;
const subtleButton = {
  padding: "3px 8px",
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontSize: 10,
  borderRadius: 6,
  cursor: "pointer",
} as const;
