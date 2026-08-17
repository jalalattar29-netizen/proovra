"use client";

/**
 * PHASE 13 — Video frame registration + track grouping.
 *
 * Two registered write routes had no product surface and no machine caller
 * either, which is why the video review workspace's merge / split / decide
 * controls had nothing to act on: no frames were ever registered, so no
 * tracks could ever be grouped.
 *
 *   POST /v1/redaction/videos/:evidenceId/frames/batch
 *     gate  redaction.administer
 *     body  { extractor: FFMPEG_SAMPLE | FFMPEG_KEYFRAME | OPERATOR_INLINE,
 *             samplePreset?: EVERY_FRAME | EVERY_500MS | EVERY_1S
 *                          | EVERY_5S | EVERY_KEYFRAME,
 *             frames: [{ frameIndex, timestampMs, … }]  (max 5000) }
 *     202   { inserted, reused }
 *     409   { denial }            — unknown extractor / over the 5000 cap
 *
 *   POST /v1/redaction/videos/:evidenceId/tracks/group
 *     gate  redaction.detection.run
 *     body  { kind, label?, versionId?, iouThreshold?,
 *             detections: [{ frameId, frameIndex,
 *                            bbox { x, y, width, height } (0..1),
 *                            rawConfidence (0..1) }]  (max 5000) }
 *     200   { trackCount, trackIds }
 *
 * Both routes resolve the workspace SERVER-side from the caller's active
 * workspace pointer, so no teamId travels in the request. Both are gated
 * on `versionLocked` client-side and on the redaction capability tier
 * server-side; a 403 renders as a permission state, never as a silent
 * no-op.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  VIDEO_FRAME_EXTRACTORS,
  VIDEO_TRACK_KINDS,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

/**
 * Mirrors `VIDEO_FRAME_SAMPLE_PRESETS` / `VIDEO_FRAME_SAMPLE_MS` in
 * packages/shared/src/redaction-elite.ts. Those two are not re-exported
 * from the shared barrel, so the bounded list is restated here rather than
 * widening a package this surface does not own. `null` = the preset has no
 * fixed cadence and the operator supplies the interval.
 */
const SAMPLE_PRESETS: ReadonlyArray<{ value: string; ms: number | null }> = [
  { value: "EVERY_FRAME", ms: 0 },
  { value: "EVERY_500MS", ms: 500 },
  { value: "EVERY_1S", ms: 1000 },
  { value: "EVERY_5S", ms: 5000 },
  { value: "EVERY_KEYFRAME", ms: null },
];

const MAX_BATCH = 5000;

export type VideoFrameRow = {
  id: string;
  frameIndex: number;
  timestampMs: number;
  extractor: string;
  storageKey: string | null;
};

type ErrorLike = { statusCode?: number; details?: Record<string, unknown> };

function statusOf(err: unknown): number {
  const e = err as ErrorLike | null;
  return typeof e?.statusCode === "number" ? e.statusCode : 0;
}

function describeFailure(err: unknown, fallback: string): string {
  const status = statusOf(err);
  if (status === 403) {
    return "Your role in this workspace cannot perform this redaction action.";
  }
  if (status === 404) {
    return "This workspace context could not be confirmed. Switch workspace and try again.";
  }
  if (status === 409) {
    return "The request was refused by policy. Reduce the batch size or change the extractor and try again.";
  }
  if (status === 400 || status === 422) {
    return "One of the values was rejected. Check the numbers and try again.";
  }
  return toSafeUserError(err, { message: fallback }).message;
}

function parseIntField(raw: string): number | null {
  if (!/^-?\d+$/.test(raw.trim())) return null;
  return Number.parseInt(raw.trim(), 10);
}

function parseUnit(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Frame registration — POST /v1/redaction/videos/:evidenceId/frames/batch
// ---------------------------------------------------------------------------

export function VideoFrameBatchPanel({
  evidenceId,
  versionLocked,
  onRegistered,
}: {
  evidenceId: string;
  versionLocked: boolean;
  onRegistered: () => Promise<void> | void;
}) {
  const baseId = useId();
  const [extractor, setExtractor] = useState<string>("FFMPEG_SAMPLE");
  const [preset, setPreset] = useState<string>("EVERY_1S");
  const [intervalMs, setIntervalMs] = useState<string>("1000");
  const [startIndex, setStartIndex] = useState<string>("0");
  const [frameCount, setFrameCount] = useState<string>("60");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const onPresetChange = useCallback((value: string) => {
    setPreset(value);
    const found = SAMPLE_PRESETS.find((p) => p.value === value);
    if (found && found.ms !== null && found.ms > 0) {
      setIntervalMs(String(found.ms));
    }
  }, []);

  const submit = useCallback(async () => {
    if (busy || versionLocked) return;

    const next: Record<string, string> = {};
    const start = parseIntField(startIndex);
    const count = parseIntField(frameCount);
    const step = parseIntField(intervalMs);
    if (start === null || start < 0) {
      next["startIndex"] = "Enter a whole number of 0 or more.";
    }
    if (count === null || count < 1 || count > MAX_BATCH) {
      next["frameCount"] = `Enter between 1 and ${MAX_BATCH} frames.`;
    }
    if (step === null || step < 0) {
      next["intervalMs"] = "Enter the spacing in milliseconds (0 or more).";
    }
    if (!(VIDEO_FRAME_EXTRACTORS as ReadonlyArray<string>).includes(extractor)) {
      next["extractor"] = "Choose how the frames were extracted.";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const frames = Array.from({ length: count as number }, (_, i) => ({
      frameIndex: (start as number) + i,
      timestampMs: ((start as number) + i) * (step as number),
    }));

    const seq = ++seqRef.current;
    setBusy(true);
    setNotice(null);
    setProblem(null);
    try {
      const res = await apiFetch(
        `/v1/redaction/videos/${encodeURIComponent(evidenceId)}/frames/batch`,
        {
          method: "POST",
          body: JSON.stringify({
            extractor,
            samplePreset: preset,
            frames,
          }),
        },
      );
      if (!mountedRef.current || seq !== seqRef.current) return;
      const inserted = typeof res?.inserted === "number" ? res.inserted : 0;
      const reused = typeof res?.reused === "number" ? res.reused : 0;
      setNotice(
        `Registered ${inserted} new frame${inserted === 1 ? "" : "s"}${
          reused > 0 ? ` · ${reused} already known` : ""
        }.`,
      );
      await onRegistered();
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setProblem(
        describeFailure(
          err,
          "The frames could not be registered. Nothing was changed — try again shortly.",
        ),
      );
    } finally {
      if (mountedRef.current && seq === seqRef.current) setBusy(false);
    }
  }, [
    busy,
    evidenceId,
    extractor,
    frameCount,
    intervalMs,
    onRegistered,
    preset,
    startIndex,
    versionLocked,
  ]);

  return (
    <section
      data-redaction-video-frame-batch
      aria-labelledby={`${baseId}-heading`}
      aria-busy={busy}
      style={panelStyle}
    >
      <h4 id={`${baseId}-heading`} style={headingStyle}>
        Register extracted frames
      </h4>
      <p style={mutedStyle}>
        Records the sampling grid this video was decoded on. Tracks are drawn
        against these frames — without them there is nothing to group.
      </p>

      <div style={gridStyle}>
        <Field
          id={`${baseId}-extractor`}
          label="Extractor"
          error={errors["extractor"]}
        >
          <select
            id={`${baseId}-extractor`}
            data-redaction-video-frame-extractor
            value={extractor}
            disabled={busy || versionLocked}
            onChange={(e) => setExtractor(e.target.value)}
            style={controlStyle}
          >
            {(VIDEO_FRAME_EXTRACTORS as ReadonlyArray<string>).map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </Field>

        <Field id={`${baseId}-preset`} label="Sample preset">
          <select
            id={`${baseId}-preset`}
            data-redaction-video-frame-preset
            value={preset}
            disabled={busy || versionLocked}
            onChange={(e) => onPresetChange(e.target.value)}
            style={controlStyle}
          >
            {SAMPLE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.value}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id={`${baseId}-interval`}
          label="Spacing (ms)"
          error={errors["intervalMs"]}
        >
          <input
            id={`${baseId}-interval`}
            data-redaction-video-frame-interval
            type="number"
            min={0}
            value={intervalMs}
            disabled={busy || versionLocked}
            onChange={(e) => setIntervalMs(e.target.value)}
            style={controlStyle}
          />
        </Field>

        <Field
          id={`${baseId}-start`}
          label="First frame index"
          error={errors["startIndex"]}
        >
          <input
            id={`${baseId}-start`}
            data-redaction-video-frame-start
            type="number"
            min={0}
            value={startIndex}
            disabled={busy || versionLocked}
            onChange={(e) => setStartIndex(e.target.value)}
            style={controlStyle}
          />
        </Field>

        <Field
          id={`${baseId}-count`}
          label={`Frame count (1–${MAX_BATCH})`}
          error={errors["frameCount"]}
        >
          <input
            id={`${baseId}-count`}
            data-redaction-video-frame-count
            type="number"
            min={1}
            max={MAX_BATCH}
            value={frameCount}
            disabled={busy || versionLocked}
            onChange={(e) => setFrameCount(e.target.value)}
            style={controlStyle}
          />
        </Field>
      </div>

      <button
        type="button"
        data-redaction-video-frame-batch-submit
        onClick={() => void submit()}
        disabled={busy || versionLocked}
        style={{
          ...primaryButtonStyle,
          opacity: busy || versionLocked ? 0.55 : 1,
          cursor: busy || versionLocked ? "not-allowed" : "pointer",
        }}
      >
        {busy ? "Registering…" : "Register frames"}
      </button>
      {versionLocked ? (
        <p data-redaction-video-frame-locked style={hintStyle}>
          This version is no longer a draft, so its frame set is fixed.
        </p>
      ) : null}

      <div
        role="status"
        aria-live="polite"
        data-redaction-video-frame-status
        style={notice || problem ? statusStyle : srOnlyStyle}
      >
        {busy ? "Registering frames…" : null}
        {!busy && problem ? problem : null}
        {!busy && !problem && notice ? notice : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Track grouping — POST /v1/redaction/videos/:evidenceId/tracks/group
// ---------------------------------------------------------------------------

export function VideoTrackGroupingPanel({
  evidenceId,
  versionId,
  versionLocked,
  onGrouped,
  reloadToken,
}: {
  evidenceId: string;
  versionId?: string | null;
  versionLocked: boolean;
  onGrouped: () => Promise<void> | void;
  /** Bumped by the parent when frames may have changed. */
  reloadToken?: number;
}) {
  const baseId = useId();
  const [frames, setFrames] = useState<ReadonlyArray<VideoFrameRow>>([]);
  const [framesLoaded, setFramesLoaded] = useState(false);
  const [kind, setKind] = useState<string>("FACE");
  const [label, setLabel] = useState("");
  const [startFrame, setStartFrame] = useState("0");
  const [endFrame, setEndFrame] = useState("0");
  const [x, setX] = useState("0.2");
  const [y, setY] = useState("0.2");
  const [width, setWidth] = useState("0.2");
  const [height, setHeight] = useState("0.2");
  const [confidence, setConfidence] = useState("0.8");
  const [iou, setIou] = useState("0.3");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const framesSeqRef = useRef(0);
  const seqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadFrames = useCallback(async () => {
    const seq = ++framesSeqRef.current;
    try {
      const res = await apiFetch(
        `/v1/redaction/videos/${encodeURIComponent(evidenceId)}/frames`,
        { method: "GET" },
      );
      if (!mountedRef.current || seq !== framesSeqRef.current) return;
      const rows: ReadonlyArray<VideoFrameRow> = Array.isArray(res?.frames)
        ? (res.frames as VideoFrameRow[])
        : [];
      setFrames(rows);
      setFramesLoaded(true);
      if (rows.length > 0) {
        setStartFrame((prev) => (prev === "0" ? String(rows[0].frameIndex) : prev));
        setEndFrame((prev) =>
          prev === "0" ? String(rows[rows.length - 1].frameIndex) : prev,
        );
      }
    } catch {
      if (!mountedRef.current || seq !== framesSeqRef.current) return;
      setFrames([]);
      setFramesLoaded(true);
    }
  }, [evidenceId]);

  useEffect(() => {
    void loadFrames();
  }, [loadFrames, reloadToken]);

  const hasFrames = frames.length > 0;
  const blocked = versionLocked
    ? "This version is no longer a draft, so tracks cannot be authored on it."
    : framesLoaded && !hasFrames
      ? "No frames are registered for this video yet. Register the sampling grid above first."
      : null;
  const permitted = blocked === null && framesLoaded;

  const selectedFrames = useMemo(() => {
    const s = parseIntField(startFrame);
    const e = parseIntField(endFrame);
    if (s === null || e === null || e < s) return [];
    return frames.filter((f) => f.frameIndex >= s && f.frameIndex <= e);
  }, [endFrame, frames, startFrame]);

  const submit = useCallback(async () => {
    if (busy || !permitted) return;

    const next: Record<string, string> = {};
    const s = parseIntField(startFrame);
    const e = parseIntField(endFrame);
    const bx = parseUnit(x);
    const by = parseUnit(y);
    const bw = parseUnit(width);
    const bh = parseUnit(height);
    const conf = parseUnit(confidence);
    const threshold = parseUnit(iou);

    if (!(VIDEO_TRACK_KINDS as ReadonlyArray<string>).includes(kind)) {
      next["kind"] = "Choose what this track covers.";
    }
    if (label.trim().length > 80) {
      next["label"] = "Keep the label under 80 characters.";
    }
    if (s === null || s < 0) next["startFrame"] = "Enter a frame index of 0 or more.";
    if (e === null || e < 0) next["endFrame"] = "Enter a frame index of 0 or more.";
    if (s !== null && e !== null && e < s) {
      next["endFrame"] = "The last frame must not come before the first.";
    }
    if (bx === null) next["x"] = "Enter a value between 0 and 1.";
    if (by === null) next["y"] = "Enter a value between 0 and 1.";
    if (bw === null || bw <= 0) next["width"] = "Enter a width above 0 and at most 1.";
    if (bh === null || bh <= 0) next["height"] = "Enter a height above 0 and at most 1.";
    if (bx !== null && bw !== null && bx + bw > 1) {
      next["width"] = "The box runs off the right edge of the frame.";
    }
    if (by !== null && bh !== null && by + bh > 1) {
      next["height"] = "The box runs off the bottom edge of the frame.";
    }
    if (conf === null) next["confidence"] = "Enter a confidence between 0 and 1.";
    if (threshold === null) next["iou"] = "Enter an overlap threshold between 0 and 1.";
    if (selectedFrames.length === 0) {
      next["startFrame"] = "No registered frames fall inside that range.";
    } else if (selectedFrames.length > MAX_BATCH) {
      next["endFrame"] = `That range covers more than ${MAX_BATCH} frames.`;
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const bbox = {
      x: bx as number,
      y: by as number,
      width: bw as number,
      height: bh as number,
    };
    const detections = selectedFrames.map((f) => ({
      frameId: f.id,
      frameIndex: f.frameIndex,
      bbox,
      rawConfidence: conf as number,
    }));

    const seq = ++seqRef.current;
    setBusy(true);
    setNotice(null);
    setProblem(null);
    try {
      const res = await apiFetch(
        `/v1/redaction/videos/${encodeURIComponent(evidenceId)}/tracks/group`,
        {
          method: "POST",
          body: JSON.stringify({
            kind,
            label: label.trim() ? label.trim() : undefined,
            versionId: versionId ?? null,
            iouThreshold: threshold as number,
            detections,
          }),
        },
      );
      if (!mountedRef.current || seq !== seqRef.current) return;
      const trackCount = typeof res?.trackCount === "number" ? res.trackCount : 0;
      setNotice(
        `Grouped ${detections.length} detection${
          detections.length === 1 ? "" : "s"
        } into ${trackCount} track${trackCount === 1 ? "" : "s"}.`,
      );
      await onGrouped();
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setProblem(
        describeFailure(
          err,
          "The detections could not be grouped. Nothing was changed — try again shortly.",
        ),
      );
    } finally {
      if (mountedRef.current && seq === seqRef.current) setBusy(false);
    }
  }, [
    busy,
    confidence,
    endFrame,
    evidenceId,
    height,
    iou,
    kind,
    label,
    onGrouped,
    permitted,
    selectedFrames,
    startFrame,
    versionId,
    width,
    x,
    y,
  ]);

  return (
    <section
      data-redaction-video-track-grouping
      aria-labelledby={`${baseId}-heading`}
      aria-busy={busy}
      style={panelStyle}
    >
      <h4 id={`${baseId}-heading`} style={headingStyle}>
        Author a track
      </h4>
      <p style={mutedStyle}>
        Draw one region across a range of registered frames. The server groups
        the resulting detections into tracks you can then approve, reject,
        merge, or split below.
      </p>

      <div style={gridStyle}>
        <Field id={`${baseId}-kind`} label="Covers" error={errors["kind"]}>
          <select
            id={`${baseId}-kind`}
            data-redaction-video-track-kind
            value={kind}
            disabled={busy || !permitted}
            onChange={(e) => setKind(e.target.value)}
            style={controlStyle}
          >
            {(VIDEO_TRACK_KINDS as ReadonlyArray<string>).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>

        <Field id={`${baseId}-label`} label="Label (optional)" error={errors["label"]}>
          <input
            id={`${baseId}-label`}
            data-redaction-video-track-label
            type="text"
            maxLength={80}
            value={label}
            disabled={busy || !permitted}
            onChange={(e) => setLabel(e.target.value)}
            style={controlStyle}
          />
        </Field>

        <Field id={`${baseId}-from`} label="From frame" error={errors["startFrame"]}>
          <input
            id={`${baseId}-from`}
            data-redaction-video-track-from
            type="number"
            min={0}
            value={startFrame}
            disabled={busy || !permitted}
            onChange={(e) => setStartFrame(e.target.value)}
            style={controlStyle}
          />
        </Field>

        <Field id={`${baseId}-to`} label="To frame" error={errors["endFrame"]}>
          <input
            id={`${baseId}-to`}
            data-redaction-video-track-to
            type="number"
            min={0}
            value={endFrame}
            disabled={busy || !permitted}
            onChange={(e) => setEndFrame(e.target.value)}
            style={controlStyle}
          />
        </Field>

        <Field id={`${baseId}-x`} label="Box x (0–1)" error={errors["x"]}>
          <input
            id={`${baseId}-x`}
            data-redaction-video-track-bbox-x
            type="number"
            step={0.01}
            min={0}
            max={1}
            value={x}
            disabled={busy || !permitted}
            onChange={(e) => setX(e.target.value)}
            style={controlStyle}
          />
        </Field>

        <Field id={`${baseId}-y`} label="Box y (0–1)" error={errors["y"]}>
          <input
            id={`${baseId}-y`}
            data-redaction-video-track-bbox-y
            type="number"
            step={0.01}
            min={0}
            max={1}
            value={y}
            disabled={busy || !permitted}
            onChange={(e) => setY(e.target.value)}
            style={controlStyle}
          />
        </Field>

        <Field id={`${baseId}-w`} label="Box width (0–1)" error={errors["width"]}>
          <input
            id={`${baseId}-w`}
            data-redaction-video-track-bbox-width
            type="number"
            step={0.01}
            min={0}
            max={1}
            value={width}
            disabled={busy || !permitted}
            onChange={(e) => setWidth(e.target.value)}
            style={controlStyle}
          />
        </Field>

        <Field id={`${baseId}-h`} label="Box height (0–1)" error={errors["height"]}>
          <input
            id={`${baseId}-h`}
            data-redaction-video-track-bbox-height
            type="number"
            step={0.01}
            min={0}
            max={1}
            value={height}
            disabled={busy || !permitted}
            onChange={(e) => setHeight(e.target.value)}
            style={controlStyle}
          />
        </Field>

        <Field
          id={`${baseId}-conf`}
          label="Confidence (0–1)"
          error={errors["confidence"]}
        >
          <input
            id={`${baseId}-conf`}
            data-redaction-video-track-confidence
            type="number"
            step={0.01}
            min={0}
            max={1}
            value={confidence}
            disabled={busy || !permitted}
            onChange={(e) => setConfidence(e.target.value)}
            style={controlStyle}
          />
        </Field>

        <Field id={`${baseId}-iou`} label="Overlap threshold" error={errors["iou"]}>
          <input
            id={`${baseId}-iou`}
            data-redaction-video-track-iou
            type="number"
            step={0.05}
            min={0}
            max={1}
            value={iou}
            disabled={busy || !permitted}
            onChange={(e) => setIou(e.target.value)}
            style={controlStyle}
          />
        </Field>
      </div>

      <button
        type="button"
        data-redaction-video-track-group-submit
        onClick={() => void submit()}
        disabled={busy || !permitted}
        style={{
          ...primaryButtonStyle,
          opacity: busy || !permitted ? 0.55 : 1,
          cursor: busy || !permitted ? "not-allowed" : "pointer",
        }}
      >
        {busy
          ? "Grouping…"
          : `Group ${selectedFrames.length} frame${
              selectedFrames.length === 1 ? "" : "s"
            } into tracks`}
      </button>
      {blocked ? (
        <p data-redaction-video-track-blocked style={hintStyle}>
          {blocked}
        </p>
      ) : null}

      <div
        role="status"
        aria-live="polite"
        data-redaction-video-track-status
        style={notice || problem ? statusStyle : srOnlyStyle}
      >
        {busy ? "Grouping detections into tracks…" : null}
        {!busy && problem ? problem : null}
        {!busy && !problem && notice ? notice : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" data-redaction-field-error style={errorTextStyle}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const panelStyle: CSSProperties = {
  marginBottom: 10,
  padding: 10,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 700,
  color: "#0f172a",
};
const mutedStyle: CSSProperties = {
  margin: "4px 0 8px",
  fontSize: 11,
  color: "#475569",
};
const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 8,
  marginBottom: 8,
};
const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "#475569",
  fontWeight: 600,
  marginBottom: 2,
};
const controlStyle: CSSProperties = {
  width: "100%",
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 11,
  boxSizing: "border-box",
};
const primaryButtonStyle: CSSProperties = {
  padding: "5px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 6,
};
const hintStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 11,
  color: "#64748b",
};
const errorTextStyle: CSSProperties = {
  margin: "4px 0 0",
  fontSize: 11,
  color: "#b91c1c",
};
const statusStyle: CSSProperties = {
  marginTop: 8,
  padding: "6px 8px",
  background: "rgba(15, 23, 42, 0.05)",
  borderRadius: 6,
  fontSize: 11,
  color: "#0f172a",
};
const srOnlyStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
