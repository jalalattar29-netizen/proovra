"use client";

/**
 * PROOVRA Phase 1 — Reviewer Workspace OCR / TRANSCRIPT side-pane.
 *
 * Reads canonical GET /v1/intelligence/evidence/:id?teamId=... which
 * returns `extractedTexts` SUMMARIES (no raw text bodies — the server
 * `projectExtractedTextSummary` helper deliberately strips the text
 * column). We further filter by `kind` so the OCR tab shows OCR rows
 * and the TRANSCRIPT tab shows TRANSCRIPT rows.
 *
 * Hard rules:
 *   * No new endpoints. No extraction trigger.
 *   * Bounded copy. No raw text body — only metadata.
 *   * Honest empty state when no rows match or the call fails.
 */

import type {
  ExtractedTextSummaryRow,
  ExtractedTextsResult,
} from "../../lib/reviewer-workspace/reviewer-api";
import { formatUserDateTime } from "../../lib/date";

const MAX_ROWS = 25;

export function SidePaneExtractedTexts({
  mode,
  state,
  onRetry,
}: {
  mode: "OCR" | "TRANSCRIPT";
  state:
    | { phase: "LOADING" }
    | { phase: "READY"; result: ExtractedTextsResult };
  onRetry: () => void;
}) {
  if (state.phase === "LOADING") {
    return (
      <PaneFrame mode={mode}>
        <p
          data-side-pane-loading={mode}
          style={{ margin: 0, color: "#475569" }}
        >
          Loading…
        </p>
      </PaneFrame>
    );
  }
  const result = state.result;
  if (!result.ok) {
    const message =
      result.reason === "NO_TEAM"
        ? `${mode} projection is only available for workspaces.`
        : result.reason === "FORBIDDEN"
          ? `${mode} projection is not available — you do not have access.`
          : result.reason === "NOT_FOUND"
            ? `${mode} projection is not available for this evidence.`
            : `Could not load ${mode.toLowerCase()} projection — please retry.`;
    return (
      <PaneFrame mode={mode}>
        <p
          data-side-pane-empty={`${mode}:${result.reason}`}
          style={{ margin: 0, color: "#475569" }}
        >
          {message}
        </p>
        {result.reason === "ERROR" ? (
          <button
            type="button"
            data-side-pane-retry-btn={mode}
            onClick={onRetry}
            style={retryBtnStyle}
          >
            Retry
          </button>
        ) : null}
      </PaneFrame>
    );
  }
  const filtered = result.rows.filter((r) => r.kind === mode).slice(0, MAX_ROWS);
  if (filtered.length === 0) {
    const copy =
      mode === "OCR"
        ? "No OCR records for this evidence yet."
        : "No transcript segments for this evidence yet.";
    return (
      <PaneFrame mode={mode}>
        <p
          data-side-pane-empty={`${mode}:NO_ROWS`}
          style={{ margin: 0, color: "#475569" }}
        >
          {copy}
        </p>
      </PaneFrame>
    );
  }
  return (
    <PaneFrame mode={mode}>
      <p
        data-side-pane-count={mode}
        style={{ margin: 0, color: "#475569", fontSize: 11 }}
      >
        {filtered.length} record{filtered.length === 1 ? "" : "s"}
      </p>
      <ul
        data-side-pane-rows={mode}
        style={{
          margin: 0,
          padding: 0,
          listStyle: "none",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {filtered.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </ul>
    </PaneFrame>
  );
}

function Row({ row }: { row: ExtractedTextSummaryRow }) {
  const when = row.extractedAtUtc
    ? formatUserDateTime(row.extractedAtUtc)
    : null;
  return (
    <li
      data-side-pane-row={row.id}
      style={{
        background: "rgba(15, 23, 42, 0.03)",
        borderRadius: 8,
        padding: "6px 8px",
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong style={{ color: "#0f172a" }}>{row.status}</strong>
        <span style={{ color: "#475569", fontSize: 11 }}>{row.provider}</span>
      </div>
      <div style={{ display: "flex", gap: 8, color: "#475569", fontSize: 11 }}>
        {row.language ? <span>{row.language}</span> : null}
        {typeof row.wordCount === "number" ? (
          <span>{row.wordCount} words</span>
        ) : null}
        {typeof row.confidence === "number" ? (
          <span>conf {row.confidence.toFixed(2)}</span>
        ) : null}
      </div>
      {when ? (
        <div style={{ color: "#94a3b8", fontSize: 10 }}>{when}</div>
      ) : null}
    </li>
  );
}

function PaneFrame({
  mode,
  children,
}: {
  mode: "OCR" | "TRANSCRIPT";
  children: React.ReactNode;
}) {
  return (
    <section
      data-side-pane={mode}
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 12,
        padding: 12,
        color: "#0f172a",
        fontSize: 12,
        lineHeight: 1.55,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <strong style={{ fontSize: 12, color: "#0f172a" }}>{mode}</strong>
      {children}
    </section>
  );
}

const retryBtnStyle: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  background: "#0f172a",
  color: "#fafafa",
  border: "none",
  fontSize: 11,
  fontWeight: 700,
  cursor: "pointer",
  alignSelf: "flex-start",
};
