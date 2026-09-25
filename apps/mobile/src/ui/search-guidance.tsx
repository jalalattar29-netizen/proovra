/**
 * THE SEARCH GUIDANCE PANEL — apps/web/app/(app)/search/components/SearchGuidance.tsx.
 *
 * On the web it stands in for the Inspector while nothing is selected. A phone
 * opens the Inspector as a sheet, so this panel sits below an empty result
 * region instead. Every list is REAL: recent searches are this device's own
 * history for the workspace, saved searches come from GET /v1/search/saved-views
 * (search.routes.ts:407 → `{ views }`), and each tip describes something the
 * console really does.
 */
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { theme } from "../theme/theme";
import { ProovraCard, ProovraText } from "./index";

export interface SavedSearchEntry {
  id: string;
  name: string;
  visibilityLabel: string;
}

function Label({ children, action }: { children: string; action?: React.ReactNode }) {
  return (
    <View style={styles.labelRow}>
      <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>{children}</ProovraText>
      {action}
    </View>
  );
}

export function SearchGuidancePanel({
  recent,
  onApplyRecent,
  onClearRecent,
  saved,
  onApplySaved,
  onContactSupport,
}: {
  recent: readonly string[];
  onApplyRecent: (q: string) => void;
  onClearRecent: () => void;
  /** null when saved views could not be read — said the same way as none. */
  saved: readonly SavedSearchEntry[] | null;
  onApplySaved: (id: string) => void;
  onContactSupport: () => void;
}) {
  return (
    <ProovraCard testID="search-guidance">
      <View style={styles.section}>
        <Label
          action={
            recent.length > 0 ? (
              <Pressable onPress={onClearRecent} accessibilityRole="button" accessibilityLabel="Clear recent searches" hitSlop={8}>
                <ProovraText variant="label" weight="semibold" color={theme.color.accent.a600}>Clear</ProovraText>
              </Pressable>
            ) : undefined
          }
        >
          Recent searches
        </Label>
        {recent.length === 0 ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Your recent searches will appear here.</ProovraText>
        ) : (
          recent.map((q) => (
            <Pressable key={q} onPress={() => onApplyRecent(q)} accessibilityRole="button" accessibilityLabel={`Recent search: ${q}`} style={styles.item}>
              <ProovraText variant="bodySm" color={theme.color.accent.a600} numberOfLines={1}>{q}</ProovraText>
            </Pressable>
          ))
        )}
      </View>

      <View style={styles.section}>
        <Label>Saved searches</Label>
        {saved === null || saved.length === 0 ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>No saved searches yet.</ProovraText>
        ) : (
          saved.map((v) => (
            <Pressable key={v.id} onPress={() => onApplySaved(v.id)} accessibilityRole="button" accessibilityLabel={`Saved search: ${v.name}`} style={[styles.item, styles.savedRow]}>
              <ProovraText variant="bodySm" color={theme.color.accent.a600} numberOfLines={1} style={{ flex: 1 }}>{v.name}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>{v.visibilityLabel}</ProovraText>
            </Pressable>
          ))
        )}
      </View>

      <View style={styles.section}>
        <Label>Search tips</Label>
        <ProovraText variant="label" color={theme.color.ink.secondary}>Search by filename, case name, report title, package, note, or record ID.</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.secondary}>OCR and transcript text appear in results when available.</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.secondary}>Use the filters to narrow by type, status, case, or date.</ProovraText>
      </View>

      <View style={[styles.section, styles.support]}>
        <ProovraText variant="bodySm" weight="semibold">Need help?</ProovraText>
        <Pressable onPress={onContactSupport} accessibilityRole="link" accessibilityLabel="Contact system admin" hitSlop={8}>
          <ProovraText variant="bodySm" weight="semibold" color={theme.color.accent.a600}>Contact system admin</ProovraText>
        </Pressable>
      </View>
    </ProovraCard>
  );
}

const styles = StyleSheet.create({
  section: { gap: theme.space.s1, marginBottom: theme.space.s3 },
  labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  item: { minHeight: 36, justifyContent: "center" },
  savedRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s2 },
  support: { marginBottom: 0, paddingTop: theme.space.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.default },
});
