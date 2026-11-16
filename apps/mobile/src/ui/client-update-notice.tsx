/**
 * B8-F-402 — the app-wide "update required / please update" notice.
 *
 * Shown only when an API response said this build is below the minimum client
 * contract it serves, or that it serves a newer presentation contract (see
 * src/network/client-contract.ts). It never blocks: an overlay card the person
 * can dismiss, and nothing at all when the API sent no such headers.
 */
import React, { useEffect, useState } from "react";
import { View } from "react-native";

import {
  CLIENT_UPDATE_COPY,
  getClientUpdateNotice,
  subscribeClientUpdateNotice,
  type ClientUpdateNotice as Notice,
} from "../network/client-contract";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraText } from "./index";

export function ClientUpdateNotice() {
  const [notice, setNotice] = useState<Notice | null>(() => getClientUpdateNotice());
  const [dismissed, setDismissed] = useState<Notice | null>(null);

  useEffect(() => {
    setNotice(getClientUpdateNotice());
    return subscribeClientUpdateNotice(() => setNotice(getClientUpdateNotice()));
  }, []);

  // A dismissed notice returns when it escalates (available → required).
  if (!notice || dismissed === notice) return null;
  const copy = CLIENT_UPDATE_COPY[notice];
  const palette = notice === "UPDATE_REQUIRED" ? theme.color.status.risk : theme.color.status.pending;
  return (
    <View
      testID={`client-update-notice-${notice}`}
      accessibilityRole="alert"
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: theme.space.s3,
        right: theme.space.s3,
        bottom: 96,
        gap: theme.space.s1,
        padding: theme.space.s3,
        borderWidth: 1,
        borderRadius: theme.radius.md,
        backgroundColor: palette.bg,
        borderColor: palette.border,
        ...theme.elevation.card,
      }}
    >
      <ProovraText variant="bodySm" weight="semibold" color={palette.fg}>
        {copy.title}
      </ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>
        {copy.body}
      </ProovraText>
      <ProovraButton label="Dismiss" accessibilityLabel="Dismiss update notice" variant="ghost" fullWidth={false} onPress={() => setDismissed(notice)} />
    </View>
  );
}
