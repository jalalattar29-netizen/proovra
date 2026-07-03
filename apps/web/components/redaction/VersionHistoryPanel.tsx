"use client";

/**
 * PROOVRA Phase 3A — Version history panel.
 *
 * Bounded sidebar that lists every version on the project, newest
 * first, with a state chip and the version ordinal. Selecting a row
 * surfaces that version in the main workspace.
 *
 * Hard rules:
 *   * Versions are append-only — the panel never offers a delete
 *     action.
 *   * Region / detection counts come from the projection, so the
 *     panel never needs to re-query individual versions.
 */

import { formatUserDateTime } from "../../lib/date";

type VersionRow = {
  id: string;
  versionOrdinal: number;
  state: string;
  createdAtUtc: string;
  regionCount: number;
  acceptedDetectionCount: number;
  rejectedDetectionCount: number;
  derivative: { state: string } | null;
};

export function VersionHistoryPanel({
  versions,
  selectedId,
  onSelect,
}: {
  versions: ReadonlyArray<VersionRow>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section
      data-redaction-version-history
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      <header style={{ marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Version history</strong>
      </header>
      {versions.length === 0 ? (
        <p
          data-redaction-version-history-empty
          style={{ color: "#475569", fontSize: 12 }}
        >
          No versions yet.
        </p>
      ) : (
        <ol
          data-redaction-version-history-list
          style={{ margin: 0, padding: 0, listStyle: "none" }}
        >
          {versions.map((v) => {
            const isSelected = selectedId === v.id;
            return (
              <li
                key={v.id}
                data-redaction-version-row={v.id}
                data-redaction-version-state={v.state}
                onClick={() => onSelect(v.id)}
                style={{
                  padding: "6px 8px",
                  marginBottom: 4,
                  borderRadius: 8,
                  border: isSelected
                    ? "1px solid #0f172a"
                    : "1px solid #e2e8f0",
                  background: isSelected
                    ? "rgba(15, 23, 42, 0.04)"
                    : "#fff",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                  <strong style={{ fontSize: 12 }}>v{v.versionOrdinal}</strong>
                  <Chip label={v.state} tone={stateTone(v.state)} />
                  <span style={{ flex: 1 }} />
                  {v.derivative ? (
                    <Chip
                      label={`derivative · ${v.derivative.state}`}
                      tone={
                        v.derivative.state === "READY"
                          ? "ok"
                          : v.derivative.state === "FAILED" ||
                            v.derivative.state === "QUARANTINED"
                          ? "warn"
                          : "info"
                      }
                    />
                  ) : null}
                </div>
                <small style={{ color: "#475569", fontSize: 11 }}>
                  {v.regionCount} regions · {v.acceptedDetectionCount}{" "}
                  accepted · {v.rejectedDetectionCount} rejected
                </small>
                <div style={{ color: "#475569", fontSize: 11 }}>
                  {formatUserDateTime(v.createdAtUtc)}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
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

function stateTone(state: string): "ok" | "info" | "muted" | "warn" {
  switch (state) {
    case "PUBLISHED":
      return "ok";
    case "APPROVED":
    case "IN_REVIEW":
      return "info";
    case "REJECTED":
      return "warn";
    default:
      return "muted";
  }
}
