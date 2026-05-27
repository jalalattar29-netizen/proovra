"use client";

/**
 * Phase G3.1 — Presence indicator (polling).
 *
 * Posts a heartbeat to `/v1/me/presence/heartbeat` every 30 seconds
 * while the component is mounted, and renders the OTHER viewers
 * returned by the backend. The component is intentionally tiny: a
 * row of name chips with a "currently viewing" tooltip.
 *
 * Hard rules:
 *   * Bounded payload — only `{ userId, displayName, lastSeenAtUtc }`
 *     are rendered. No IP / device / route history.
 *   * Workspace-scoped — the backend enforces team membership.
 *   * No surveillance language. The chip says "Also here" — never
 *     "watching", "tracking", "monitoring".
 *   * Read-only. The component never mutates state and never claims
 *     authorisation — collision warnings live on a separate
 *     CollisionWarning component.
 *   * Suppressed when no teamId or resourceId is available (e.g.,
 *     personal workspace surfaces) so solo users never see an empty
 *     "Also here" chip.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";

type ResourceKind =
  | "evidence"
  | "matter"
  | "discussion_thread"
  | "reviewer_workflow"
  | "evidence_request";

type Viewer = {
  userId: string;
  displayName: string;
  lastSeenAtUtc: string;
};

type HeartbeatResponse = { viewers: ReadonlyArray<Viewer> };

const HEARTBEAT_INTERVAL_MS = 30_000;

export function PresenceIndicator({
  teamId,
  resourceKind,
  resourceId,
}: {
  teamId: string | null;
  resourceKind: ResourceKind;
  resourceId: string | null;
}) {
  const [viewers, setViewers] = useState<ReadonlyArray<Viewer>>([]);
  const aliveRef = useRef(true);
  const teamIdRef = useRef(teamId);
  const resourceIdRef = useRef(resourceId);
  teamIdRef.current = teamId;
  resourceIdRef.current = resourceId;

  const beat = useCallback(async () => {
    const t = teamIdRef.current;
    const r = resourceIdRef.current;
    if (!t || !r) return;
    try {
      const res = await apiFetch("/v1/me/presence/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId: t,
          resourceKind,
          resourceId: r,
        }),
      });
      const json = (await res.json()) as HeartbeatResponse;
      if (aliveRef.current) setViewers(json.viewers ?? []);
    } catch {
      // Best-effort. Presence failures must never break the surface.
    }
  }, [resourceKind]);

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function loop() {
      if (!aliveRef.current) return;
      await beat();
      if (aliveRef.current) {
        timer = setTimeout(loop, HEARTBEAT_INTERVAL_MS);
      }
    }
    void loop();
    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [beat]);

  if (!teamId || !resourceId) return null;
  if (viewers.length === 0) return null;

  return (
    <div
      data-presence-indicator
      data-presence-resource-kind={resourceKind}
      data-presence-resource-id={resourceId}
      data-presence-viewer-count={viewers.length}
      style={{
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
        fontSize: 12,
        color: "#475569",
      }}
      title={`${viewers.length} other operator${viewers.length === 1 ? "" : "s"} also here`}
      aria-label={`${viewers.length} other operator${viewers.length === 1 ? "" : "s"} also here`}
    >
      <span style={{ fontSize: 11, opacity: 0.7 }}>Also here:</span>
      {viewers.slice(0, 4).map((v) => (
        <span
          key={v.userId}
          data-presence-viewer={v.userId}
          style={{
            padding: "2px 8px",
            borderRadius: 999,
            background: "#eef2ff",
            color: "#3730a3",
            fontWeight: 600,
            border: "1px solid #c7d2fe",
          }}
        >
          {v.displayName}
        </span>
      ))}
      {viewers.length > 4 ? (
        <span style={{ opacity: 0.7 }}>+{viewers.length - 4}</span>
      ) : null}
    </div>
  );
}
