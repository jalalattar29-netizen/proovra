/**
 * B7A-F-006 (free-audit 0ea0) — "Signed with a withdrawn key" on the record
 * screen (native).
 *
 * Renders ONLY the shared sentences (`describeRecordKeyCompromise`, which the
 * web renders too): what happened, where the replacement stands, and each
 * output no replacement restores. The control appears only when the server
 * says the replacement is AVAILABLE to this caller; it posts the existing
 * regenerate route with `{ intent: "KEY_COMPROMISE_REPLACEMENT" }` and, on
 * 202, asks the screen to re-read the artifact status. A refusal reads as the
 * shared dictionary's copy for its code.
 */
import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { RecordKeyCompromise } from "@proovra/shared";

import { apiFetch } from "../api";
import {
  buildKeyCompromiseReplacementRequest,
  keyCompromiseNotice,
  keyCompromiseReplacementError,
  keyCompromiseReplacementRequested,
} from "../product/key-compromise";
import { buildRegeneratePath } from "../product/evidence-detail";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraCard, ProovraText } from "./index";

export function KeyCompromiseNotice({
  evidenceId,
  keyCompromise,
  onRequested,
}: {
  evidenceId: string;
  keyCompromise: RecordKeyCompromise | null;
  /** Re-read the artifact status after a 202. */
  onRequested?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ title?: string; text: string; error: boolean } | null>(null);

  const view = keyCompromiseNotice(keyCompromise);
  if (!view) return null;

  const requestReplacement = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const { init } = buildKeyCompromiseReplacementRequest(evidenceId);
      await apiFetch(buildRegeneratePath(evidenceId), init);
      setNotice({ text: keyCompromiseReplacementRequested(), error: false });
      onRequested?.();
    } catch (err) {
      const e = keyCompromiseReplacementError(err);
      setNotice({ title: e.title, text: e.message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProovraCard testID="key-compromise-notice" style={styles.card}>
      <ProovraText variant="bodySm" weight="semibold" accessibilityRole="header">
        {view.title}
      </ProovraText>
      <ProovraText variant="label">{view.message}</ProovraText>
      <ProovraText variant="label" testID="key-compromise-replacement-line">
        {view.replacementLine}
      </ProovraText>
      {view.notReplaced.map((line) => (
        <ProovraText key={line} variant="label" color={theme.color.ink.secondary}>
          {line}
        </ProovraText>
      ))}
      {view.offered && view.actionLabel ? (
        <ProovraButton
          label={busy ? "Requesting…" : view.actionLabel}
          accessibilityLabel={view.actionLabel}
          variant="primary"
          fullWidth={false}
          loading={busy}
          disabled={busy}
          onPress={() => void requestReplacement()}
          testID="key-compromise-request"
        />
      ) : null}
      {notice ? (
        <View accessibilityLiveRegion={notice.error ? "assertive" : "polite"} testID="key-compromise-result">
          {notice.title ? (
            <ProovraText variant="label" weight="semibold" color={theme.color.status.risk.fg}>
              {notice.title}
            </ProovraText>
          ) : null}
          <ProovraText variant="label" color={notice.error ? theme.color.status.risk.fg : theme.color.ink.secondary}>
            {notice.text}
          </ProovraText>
        </View>
      ) : null}
    </ProovraCard>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 6,
    borderColor: theme.color.status.pending.border,
    backgroundColor: theme.color.status.pending.bg,
  },
});
