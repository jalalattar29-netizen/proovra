/**
 * "Also here" chip row (T-15) — see src/product/presence.ts.
 * Renders nothing without a workspace + resource, or when nobody else is here.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";

import { apiFetch } from "../api";
import { theme } from "../theme/theme";
import {
  PRESENCE_HEARTBEAT_PATH,
  PRESENCE_INTERVAL_MS,
  PRESENCE_VISIBLE_LIMIT,
  buildPresenceHerePath,
  parsePresenceViewers,
  presenceSummary,
  type PresenceResourceKind,
  type PresenceViewer,
} from "../product/presence";
import { ProovraBadge, ProovraText } from "./index";

export function PresenceIndicator({
  teamId,
  resourceKind,
  resourceId,
}: {
  teamId: string | null;
  resourceKind: PresenceResourceKind;
  resourceId: string | null;
}) {
  const [viewers, setViewers] = useState<PresenceViewer[]>([]);
  const alive = useRef(true);
  // Any workspace/resource change invalidates in-flight responses.
  const generation = `${teamId ?? ""}:${resourceId ?? ""}`;
  const generationRef = useRef(generation);
  generationRef.current = generation;

  const beat = useCallback(async () => {
    if (!teamId || !resourceId) return;
    const sent = `${teamId}:${resourceId}`;
    // A backgrounded app observes without claiming presence.
    const observeOnly = AppState.currentState !== "active";
    try {
      const res = observeOnly
        ? await apiFetch(buildPresenceHerePath(teamId, resourceKind, resourceId))
        : await apiFetch(PRESENCE_HEARTBEAT_PATH, {
            method: "POST",
            body: JSON.stringify({ teamId, resourceKind, resourceId }),
          });
      if (!alive.current || generationRef.current !== sent) return;
      setViewers(parsePresenceViewers(res));
    } catch {
      // Best-effort: a denial or outage never breaks the screen and never invents viewers.
    }
  }, [teamId, resourceKind, resourceId]);

  useEffect(() => {
    alive.current = true;
    setViewers([]);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      if (!alive.current) return;
      await beat();
      if (alive.current) {
        timer = setTimeout(() => void loop(), PRESENCE_INTERVAL_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
      }
    };
    void loop();
    return () => {
      alive.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [beat]);

  if (!teamId || !resourceId || viewers.length === 0) return null;
  return (
    <View
      accessible
      accessibilityLabel={presenceSummary(viewers.length)}
      style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s1 }}
      testID="presence-indicator"
    >
      <ProovraText variant="label" color={theme.color.ink.muted}>Also here:</ProovraText>
      {viewers.slice(0, PRESENCE_VISIBLE_LIMIT).map((v) => (
        <ProovraBadge key={v.userId} tone="info" label={v.displayName} />
      ))}
      {viewers.length > PRESENCE_VISIBLE_LIMIT ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>{`+${viewers.length - PRESENCE_VISIBLE_LIMIT}`}</ProovraText>
      ) : null}
    </View>
  );
}
