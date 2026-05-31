"use client";

/**
 * PROOVRA Phase 2A Closure — PDF viewer.
 *
 * Uses the browser's native PDF rendering via <iframe>. Reviewers
 * navigate pages with j/k or the toolbar. Annotations linked to a
 * page render in a side rail; clicking jumps to the page.
 */

import { useState } from "react";

import type { ReviewerAnnotationSummary } from "../../../lib/reviewer-workspace/annotation-types";

export type PdfViewerProps = {
  src: string;
  evidenceId: string;
  annotations: ReadonlyArray<ReviewerAnnotationSummary>;
};

export function PdfViewer({ src, evidenceId, annotations }: PdfViewerProps) {
  const [page, setPage] = useState(1);
  const pageAnnotations = annotations.filter(
    (a) => a.pageNumber !== null && a.parentAnnotationId === null,
  );
  return (
    <div
      data-pdf-viewer
      data-evidence-id={evidenceId}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 180px",
        gap: 8,
        background: "#0f172a",
        borderRadius: 10,
        overflow: "hidden",
        minHeight: 320,
        flex: 1,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          background: "#fff",
        }}
      >
        <div
          data-pdf-toolbar
          style={{
            display: "flex",
            gap: 6,
            padding: "6px 10px",
            background: "rgba(15,23,42,0.04)",
            borderBottom: "1px solid rgba(15,23,42,0.08)",
            fontSize: 11,
            color: "#0f172a",
            alignItems: "center",
          }}
        >
          <button
            type="button"
            data-pdf-prev
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            style={pdfBtn}
          >
            ← Prev
          </button>
          <span style={{ minWidth: 90 }}>
            Page <input
              data-pdf-page-input
              type="number"
              min={1}
              value={page}
              onChange={(e) => setPage(Math.max(1, Number(e.target.value)))}
              style={{
                width: 50,
                padding: "1px 4px",
                margin: "0 4px",
                border: "1px solid #cbd5e1",
                borderRadius: 4,
                fontSize: 11,
              }}
            />
          </span>
          <button
            type="button"
            data-pdf-next
            onClick={() => setPage((p) => p + 1)}
            style={pdfBtn}
          >
            Next →
          </button>
          <span style={{ flex: 1 }} />
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            data-pdf-open-external
            style={{ fontSize: 11, color: "#0f172a" }}
          >
            Open in new tab ↗
          </a>
        </div>
        <iframe
          data-pdf-iframe
          title="Evidence PDF"
          src={`${src}#page=${page}`}
          style={{
            flex: 1,
            border: "none",
            minHeight: 320,
            background: "#e2e8f0",
          }}
        />
      </div>
      <aside
        data-pdf-annotation-rail
        style={{
          padding: 8,
          background: "rgba(255,255,255,0.04)",
          color: "#fafafa",
          fontSize: 11,
          overflowY: "auto",
        }}
      >
        <strong style={{ display: "block", marginBottom: 6 }}>
          Annotations
        </strong>
        {pageAnnotations.length === 0 ? (
          <small style={{ color: "#94a3b8" }}>No page-bound annotations.</small>
        ) : (
          pageAnnotations.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => a.pageNumber && setPage(a.pageNumber)}
              data-pdf-rail-item={a.id}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "5px 6px",
                marginBottom: 4,
                border: "1px solid rgba(255,255,255,0.16)",
                borderRadius: 6,
                background:
                  a.pageNumber === page
                    ? "rgba(245, 158, 11, 0.22)"
                    : "transparent",
                color: "#fafafa",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              <strong>p.{a.pageNumber}</strong> {a.annotationType}
              {a.body ? <div style={{ color: "#cbd5e1" }}>{a.body.slice(0, 60)}</div> : null}
            </button>
          ))
        )}
      </aside>
    </div>
  );
}

const pdfBtn = {
  background: "transparent",
  border: "1px solid #cbd5e1",
  color: "#0f172a",
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 6,
  cursor: "pointer",
} as const;
