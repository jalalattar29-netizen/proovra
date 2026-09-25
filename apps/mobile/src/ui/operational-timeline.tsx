/**
 * OPERATIONAL TIMELINE (T-14) — the touch port of the web
 * OperationalTimelinePanel on the Custody tab: actor and severity per entry,
 * newest first as the server orders them, fail-closed on a read error.
 */
import React, { useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { describeRelativeTime } from "../lib/relative-time";
import {
  TIMELINE_EMPTY_REASON,
  TIMELINE_EMPTY_TITLE,
  TIMELINE_UNAVAILABLE,
  buildOperationalTimelinePath,
  parseOperationalTimeline,
  type TimelineEntry,
} from "../product/operational-timeline";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraCard, ProovraSection, ProovraText } from "./index";

export function OperationalTimeline({ evidenceId, teamId }: { evidenceId: string; teamId: string }) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setFailed(false);
    apiFetch(buildOperationalTimelinePath(evidenceId, teamId))
      .then((d) => {
        if (!cancelled) setEntries(parseOperationalTimeline(d));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceId, teamId]);

  return (
    <ProovraSection title="Operational activity">
      <ProovraCard testID="operational-timeline">
        {failed ? (
          <ProovraText variant="bodySm" color={theme.color.status.pending.fg}>{TIMELINE_UNAVAILABLE}</ProovraText>
        ) : entries === null ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Loading operational activity…</ProovraText>
        ) : entries.length === 0 ? (
          <View>
            <ProovraText variant="bodySm" weight="semibold">{TIMELINE_EMPTY_TITLE}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{TIMELINE_EMPTY_REASON}</ProovraText>
          </View>
        ) : (
          entries.map((e) => (
            <View key={e.id} style={{ gap: 2, paddingVertical: theme.space.s1 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
                <ProovraText variant="bodySm" weight={e.severity === "HIGH" || e.severity === "CRITICAL" ? "semibold" : undefined}>{e.label}</ProovraText>
                <ProovraBadge label={e.severity} tone={e.severity === "CRITICAL" ? "risk" : e.severity === "HIGH" || e.severity === "WARNING" ? "pending" : "neutral"} />
              </View>
              {e.safeSummary ? <ProovraText variant="label" color={theme.color.ink.secondary}>{e.safeSummary}</ProovraText> : null}
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {[e.actorUserId ? `actor ${e.actorUserId.slice(0, 8)}` : null, e.occurredAtIso ? describeRelativeTime(e.occurredAtIso) : null].filter(Boolean).join(" · ")}
              </ProovraText>
            </View>
          ))
        )}
      </ProovraCard>
    </ProovraSection>
  );
}
