"use client";

/**
 * PROOVRA Phase 2A Closure — Image viewer.
 *
 * Reviewer-grade image surface with zoom, pan, rotation, EXIF panel,
 * and an annotation overlay layer. Built on a single <img> wrapped in
 * a CSS-transform container; no heavy dependencies.
 */

import { useCallback, useMemo, useRef, useState } from "react";

import type { ReviewerAnnotationSummary } from "../../../lib/reviewer-workspace/annotation-types";

export type ImageViewerProps = {
  src: string;
  evidenceId: string;
  annotations: ReadonlyArray<ReviewerAnnotationSummary>;
  metadata?: Record<string, unknown> | null;
};

export function ImageViewer({
  src,
  evidenceId,
  annotations,
  metadata,
}: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const overlays = useMemo(
    () =>
      annotations.filter(
        (a) =>
          a.coordinateSpace === "NORMALIZED" &&
          a.x !== null &&
          a.y !== null &&
          a.parentAnnotationId === null,
      ),
    [annotations],
  );

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    setScale((s) => Math.min(8, Math.max(0.25, s + dir * 0.15)));
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
  }, [offset]);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    setOffset({
      x: e.clientX - dragRef.current.x,
      y: e.clientY - dragRef.current.y,
    });
  }, []);
  const onMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <div
      data-image-viewer
      data-evidence-id={evidenceId}
      style={{
        position: "relative",
        background: "#0f172a",
        borderRadius: 10,
        overflow: "hidden",
        minHeight: 320,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Toolbar
        scale={scale}
        rotation={rotation}
        onZoomIn={() => setScale((s) => Math.min(8, s + 0.25))}
        onZoomOut={() => setScale((s) => Math.max(0.25, s - 0.25))}
        onRotate={() => setRotation((r) => (r + 90) % 360)}
        onReset={() => {
          setScale(1);
          setRotation(0);
          setOffset({ x: 0, y: 0 });
        }}
      />
      <div
        data-image-viewport
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          cursor: dragRef.current ? "grabbing" : "grab",
          userSelect: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale}) rotate(${rotation}deg)`,
            transition: dragRef.current ? "none" : "transform 80ms",
            transformOrigin: "center center",
          }}
        >
          {/*
            Native <img> is intentional: the evidence viewer applies
            user-driven scale/rotate/pan transforms in real time, which
            fights next/image's responsive srcSet + server-side transform
            pipeline. The asset is also already served from a presigned S3
            URL, so there is no SSR optimisation benefit to capture.

            The previous `eslint-disable-next-line @next/next/no-img-element`
            directive here referenced a rule this project never registers
            (apps/web/.eslintrc.cjs intentionally does NOT extend
            eslint-config-next — see the file's own header for the
            stabilisation-pass rationale). With the rule undefined the
            disable comment itself became an ESLint error
            ("Definition for rule '@next/next/no-img-element' was not
            found"). Removing the orphan directive resolves the lint error
            without altering the rendered element or any of its props.
          */}
          <img
            src={src}
            alt="Evidence"
            data-image-viewer-img
            draggable={false}
            style={{ maxWidth: "70vw", maxHeight: "60vh" }}
          />
          {overlays.map((a) => (
            <div
              key={a.id}
              data-image-annotation-overlay={a.id}
              style={{
                position: "absolute",
                left: `${(a.x ?? 0) * 100}%`,
                top: `${(a.y ?? 0) * 100}%`,
                width: a.width ? `${a.width * 100}%` : 12,
                height: a.height ? `${a.height * 100}%` : 12,
                background: a.resolvedAtUtc
                  ? "rgba(34, 197, 94, 0.18)"
                  : "rgba(245, 158, 11, 0.22)",
                border: `2px solid ${a.resolvedAtUtc ? "#16a34a" : "#f59e0b"}`,
                pointerEvents: "none",
              }}
              title={a.body ?? a.annotationType}
            />
          ))}
        </div>
      </div>
      {metadata ? <MetadataPanel metadata={metadata} /> : null}
    </div>
  );
}

function Toolbar(props: {
  scale: number;
  rotation: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onRotate: () => void;
  onReset: () => void;
}) {
  return (
    <div
      data-image-toolbar
      style={{
        display: "flex",
        gap: 6,
        padding: "6px 10px",
        background: "rgba(255,255,255,0.04)",
        borderBottom: "1px solid rgba(255,255,255,0.1)",
        fontSize: 11,
        color: "#cbd5e1",
      }}
    >
      <ToolBtn onClick={props.onZoomOut}>−</ToolBtn>
      <span data-image-scale style={{ minWidth: 48, textAlign: "center" }}>
        {Math.round(props.scale * 100)}%
      </span>
      <ToolBtn onClick={props.onZoomIn}>+</ToolBtn>
      <span style={{ width: 8 }} />
      <ToolBtn onClick={props.onRotate}>⟳ {props.rotation}°</ToolBtn>
      <ToolBtn onClick={props.onReset}>Reset</ToolBtn>
    </div>
  );
}

function ToolBtn({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-image-toolbar-btn
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

function MetadataPanel({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata).slice(0, 12);
  if (entries.length === 0) return null;
  return (
    <div
      data-image-metadata-panel
      style={{
        padding: "8px 12px",
        background: "rgba(255,255,255,0.04)",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        fontSize: 11,
        color: "#cbd5e1",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: 4,
      }}
    >
      {entries.map(([k, v]) => (
        <div key={k}>
          <strong style={{ color: "#fafafa" }}>{k}:</strong> {String(v)}
        </div>
      ))}
    </div>
  );
}
