"use client";

/**
 * Phase G3.1 — Collision warning.
 *
 * Renders an operational warning when the entity the operator is
 * working on has changed since they opened the surface. Drives off
 * the `updatedAt` timestamp the relevant entity already exposes
 * (no new schema required):
 *
 *   * `EvidenceReviewWorkflow.updatedAt`
 *   * `Evidence.updatedAt`
 *   * `DiscussionThread.updatedAt`
 *
 * Hard rules:
 *   * Read-only. The component does NOT mutate state and does NOT
 *     block destructive actions on its own — server-side optimistic
 *     concurrency is the authoritative gate (a future inline-action
 *     wave will surface 409 STALE_WRITE responses).
 *   * Never silently overwrites. When the warning is visible,
 *     operators see "this changed since you opened it" copy and the
 *     option to reload.
 *   * Bounded vocabulary. No legal claims, no compliance attestation.
 */

import { useMemo } from "react";

export function CollisionWarning({
  initialUpdatedAtUtc,
  currentUpdatedAtUtc,
  /** Optional — operator-readable label of the entity (e.g., "Matter", "Evidence", "Thread"). */
  entityLabel = "Record",
  /** Callback when the operator clicks "Reload". The parent decides what reload means. */
  onReload,
}: {
  initialUpdatedAtUtc: string | null;
  currentUpdatedAtUtc: string | null;
  entityLabel?: string;
  onReload?: () => void;
}) {
  const stale = useMemo(() => {
    if (!initialUpdatedAtUtc || !currentUpdatedAtUtc) return false;
    return initialUpdatedAtUtc !== currentUpdatedAtUtc;
  }, [initialUpdatedAtUtc, currentUpdatedAtUtc]);

  if (!stale) return null;

  return (
    <div
      role="alert"
      data-collision-warning
      data-collision-entity={entityLabel}
      data-collision-initial-updated={initialUpdatedAtUtc ?? ""}
      data-collision-current-updated={currentUpdatedAtUtc ?? ""}
      style={{
        marginBottom: 12,
        padding: "10px 14px",
        border: "1px solid #fcd34d",
        background: "#fef3c7",
        borderRadius: 8,
        color: "#78350f",
        fontSize: 13,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div>
        <strong style={{ display: "block", marginBottom: 2 }}>
          {entityLabel} changed since you opened it
        </strong>
        <span style={{ fontSize: 12.5, lineHeight: 1.4 }}>
          Another operator updated this {entityLabel.toLowerCase()} while you
          were working. Reload to see the latest state before continuing — the
          server will reject conflicting writes.
        </span>
      </div>
      {onReload ? (
        <button
          type="button"
          onClick={onReload}
          data-collision-warning-reload
          style={{
            padding: "6px 12px",
            fontSize: 12.5,
            fontWeight: 600,
            background: "#0f172a",
            color: "#fff",
            border: 0,
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      ) : null}
    </div>
  );
}
