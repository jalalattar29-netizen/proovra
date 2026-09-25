/**
 * The native counterparts of the web's `WorkspaceRecoveryPanel` and
 * `PersonalSpaceUnavailablePanel` (T-09e). The DECISION lives in
 * `src/product/shell-gates.ts`; this file only draws it.
 *
 * Both render inside the shell, so the header and navigation stay usable — the
 * web keeps its topbar and sidebar for the same reason ("so the user can
 * navigate to … the workspace switcher", AppShellV2.tsx:143).
 */
import React from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import {
  PERSONAL_UNAVAILABLE_COPY,
  RECOVERY_COPY,
  type ShellGate,
} from "../product/shell-gates";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraSupportReference, ProovraText } from "./index";

export function ShellGatePanel({ gate, onRetry }: { gate: Exclude<ShellGate, { kind: "none" }>; onRetry: () => void }) {
  const router = useRouter();

  if (gate.kind === "recovery") {
    return (
      <ProovraCard>
        <View style={styles.body} testID="workspace-recovery" accessibilityRole="alert">
          <ProovraBadge label={RECOVERY_COPY.statusLabel} tone="pending" />
          <ProovraText variant="h2" weight="semibold">
            {RECOVERY_COPY.title}
          </ProovraText>
          <ProovraText color={theme.color.ink.secondary}>{RECOVERY_COPY.message}</ProovraText>
          <View style={styles.actions}>
            {gate.actions.map((a, i) => (
              <ProovraButton
                key={a.id}
                label={a.label}
                variant={i === 0 ? "primary" : "secondary"}
                testID={`workspace-recovery-action-${a.id}`}
                onPress={() => (a.href ? router.push(a.href) : onRetry())}
              />
            ))}
          </View>
          <ProovraSupportReference reference={gate.requestId} />
        </View>
      </ProovraCard>
    );
  }

  return (
    <ProovraCard>
      <View style={styles.body} testID="personal-space-unavailable" accessibilityRole="alert">
        <ProovraBadge label={PERSONAL_UNAVAILABLE_COPY.statusLabel} tone="pending" />
        <ProovraText variant="h2" weight="semibold">
          {PERSONAL_UNAVAILABLE_COPY.title}
        </ProovraText>
        <ProovraText color={theme.color.ink.secondary}>{PERSONAL_UNAVAILABLE_COPY.message}</ProovraText>
        <View style={styles.actions}>
          {gate.switchAvailable ? (
            <ProovraButton
              label={PERSONAL_UNAVAILABLE_COPY.switchLabel}
              testID="personal-space-switch"
              onPress={() => router.push("/spaces")}
            />
          ) : null}
          <ProovraButton
            label={PERSONAL_UNAVAILABLE_COPY.supportLabel}
            variant="secondary"
            testID="personal-space-unavailable-support"
            onPress={() => router.push("/support")}
          />
        </View>
      </View>
    </ProovraCard>
  );
}

const styles = StyleSheet.create({
  body: { gap: theme.space.s3, paddingVertical: theme.space.s2 },
  actions: { gap: theme.space.s2, marginTop: theme.space.s2 },
});
