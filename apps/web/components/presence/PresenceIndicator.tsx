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
 *
 * PHASE 12B — observe-vs-claim split. A backgrounded tab must not keep
 * claiming "I am here" (that would advertise an operator who has walked
 * away), but it should still SEE who is here when the reader returns.
 * So visibility drives the endpoint:
 *   * visible → POST /v1/me/presence/heartbeat (claim + read)
 *   * hidden  → GET  /v1/me/presence/here      (read-only, no claim)
 * Both are workspace-bound server-side. Responses are stamped with the
 * request's workspace generation and discarded if the workspace or
 * resource changed while the request was in flight (stale-context
 * rejection), and polling is disposed on unmount.
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

  // Workspace/resource generation. Any change invalidates in-flight
  // responses so a switch can never paint the previous workspace's
  // viewers into the new one.
  const generation = `${teamId ?? ""}:${resourceId ?? ""}`;
  const generationRef = useRef(generation);
  generationRef.current = generation;

  const beat = useCallback(async () => {
    const t = teamIdRef.current;
    const r = resourceIdRef.current;
    if (!t || !r) return;
    const sentGeneration = generationRef.current;
    // A hidden tab observes without claiming presence.
    const observeOnly =
      typeof document !== "undefined" && document.visibilityState === "hidden";
    try {
      // apiFetch resolves to the PARSED body and throws on a non-2xx.
      // (The previous code called `.json()` on the parsed object inside a
      // silent catch, so the viewer list never populated at all.)
      const json = (
        observeOnly
          ? await apiFetch(
              `/v1/me/presence/here?teamId=${encodeURIComponent(t)}&resourceKind=${encodeURIComponent(
                resourceKind,
              )}&resourceId=${encodeURIComponent(r)}`,
            )
          : await apiFetch("/v1/me/presence/heartbeat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                teamId: t,
                resourceKind,
                resourceId: r,
              }),
            })
      ) as HeartbeatResponse | null;
      // Discard a response that outlived its workspace/resource context.
      if (!aliveRef.current || generationRef.current !== sentGeneration) return;
      setViewers(json?.viewers ?? []);
    } catch {
      // Best-effort. Presence failures (incl. denial) must never break the
      // surface and must never invent viewers.
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
    // `generation` participates so a workspace/resource switch restarts the
    // loop against the new context instead of polling the stale one.
  }, [beat, generation]);

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
