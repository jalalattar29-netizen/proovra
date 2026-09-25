/**
 * SEARCH MULTI-SELECT CHIPS — the web search console's "Document type" and
 * "Evidence kind" chip rows (apps/web/app/(app)/search/page.tsx:1994-2040):
 * each chip toggles its own value (aria-pressed), and none on means "all".
 * ProovraFilterChips is single-select, so it cannot express this; the chip
 * geometry and selected treatment are the same tokens.
 */
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { theme } from "../theme/theme";
import { ProovraText } from "./index";

export function SearchToggleChips<T extends string>({
  label,
  options,
  selected,
  onToggle,
  disabled,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  selected: readonly T[];
  onToggle: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.group} accessibilityRole="none" accessibilityLabel={label}>
      <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
        {label}
      </ProovraText>
      <View style={styles.row}>
        {options.map((opt) => {
          const on = selected.includes(opt.value);
          return (
            <Pressable
              key={opt.value}
              onPress={() => onToggle(opt.value)}
              disabled={disabled}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: !!disabled }}
              accessibilityLabel={`${label}: ${opt.label}`}
              style={[styles.chip, on && styles.chipOn, disabled && styles.chipDisabled]}
            >
              <ProovraText variant="label" weight="semibold" color={on ? theme.color.accent.a600 : theme.color.ink.secondary}>
                {opt.label}
              </ProovraText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: theme.space.s2 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  chip: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: theme.space.s3,
    borderRadius: theme.radius.pill ?? 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.default,
    backgroundColor: theme.color.surface.card,
  },
  chipOn: { borderColor: theme.color.accent.a500, backgroundColor: theme.color.accent.a050 },
  chipDisabled: { opacity: 0.5 },
});
