/**
 * CAPTURE SESSION ACTIVITY (T-14) — the touch port of the web
 * CaptureActivityDisclosure: collapsed to one row with a count, expanded to
 * the session's local log.
 */
import React, { useState } from "react";
import { Pressable, View } from "react-native";

import { formatUserTime } from "../lib/date";
import { captureActivityCountLabel, type CaptureActivityEvent } from "../product/capture-activity";
import { theme } from "../theme/theme";
import { ProovraText } from "./index";

export function CaptureActivityDisclosure({ events }: { events: ReadonlyArray<CaptureActivityEvent> }) {
  const [open, setOpen] = useState(false);
  return (
    <View testID="capture-activity" style={{ gap: theme.space.s2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Session activity, ${captureActivityCountLabel(events.length)}. ${open ? "Hide activity" : "View activity"}`}
        onPress={() => setOpen((v) => !v)}
        style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 44, gap: theme.space.s2 }}
      >
        <ProovraText variant="bodySm" weight="semibold">
          {`Session activity · ${captureActivityCountLabel(events.length)}`}
        </ProovraText>
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {open ? "Hide activity" : "View activity"}
        </ProovraText>
      </Pressable>
      {open ? (
        events.length === 0 ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>No activity recorded in this session yet.</ProovraText>
        ) : (
          events.map((e) => (
            <View key={e.id} style={{ flexDirection: "row", gap: theme.space.s2 }} testID={`capture-activity-${e.tone}`}>
              <ProovraText variant="label" color={theme.color.ink.muted}>{formatUserTime(e.atUtc)}</ProovraText>
              <View style={{ flex: 1 }}>
                <ProovraText variant="bodySm" weight="semibold">{e.title}</ProovraText>
                {e.detail ? <ProovraText variant="label" color={theme.color.ink.secondary}>{e.detail}</ProovraText> : null}
              </View>
            </View>
          ))
        )
      ) : null}
    </View>
  );
}
