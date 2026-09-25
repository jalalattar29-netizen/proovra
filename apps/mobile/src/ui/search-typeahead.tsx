/**
 * THE SEARCH FORM + TYPEAHEAD — the web console's query form and
 * SearchTypeahead (apps/web/app/(app)/search/page.tsx:1809-1885, 3535-3683).
 *
 * The search runs on SUBMIT (the Search button or the keyboard's search key),
 * as on the web — a query per keystroke also wrote a "recent search" per
 * keystroke. While the field is focused a list opens beneath it:
 *   - fewer than 2 characters: this device's recent searches (each with its
 *     own remove control, plus "Clear all"), or a tip when there are none;
 *   - 2+ characters: title suggestions from GET /v1/search/suggest, each with
 *     its record type, or "No matching titles. Press Enter to search anyway."
 * Picking an entry runs that search.
 *
 * ProovraInput exposes neither focus events nor maxLength, so the field is a
 * TextInput wearing the same input tokens.
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { theme } from "../theme/theme";
import { documentTypeDisplay, SEARCH_QUERY_MAX, type SearchSuggestion } from "../product/search";
import { ProovraBadge, ProovraButton, ProovraText } from "./index";

export function SearchQueryForm({
  value,
  onChangeText,
  onSubmit,
  onPick,
  suggestions,
  recent,
  onRemoveRecent,
  onClearRecent,
  editable,
}: {
  value: string;
  onChangeText: (q: string) => void;
  onSubmit: () => void;
  onPick: (q: string) => void;
  suggestions: readonly SearchSuggestion[];
  recent: readonly string[];
  onRemoveRecent: (q: string) => void;
  onClearRecent: () => void;
  editable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const trimmed = value.trim();
  const showRecent = trimmed.length < 2;
  const pick = (q: string) => {
    setOpen(false);
    onPick(q);
  };
  return (
    <View style={styles.form}>
      <View style={styles.fieldRow}>
        <TextInput
          value={value}
          onChangeText={(t) => {
            setOpen(true);
            onChangeText(t);
          }}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
          }}
          onBlur={() => setFocused(false)}
          onSubmitEditing={() => {
            setOpen(false);
            onSubmit();
          }}
          placeholder="Search evidence, cases, reports, notes, OCR text…"
          placeholderTextColor={theme.color.ink.muted}
          accessibilityLabel="Search query"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          maxLength={SEARCH_QUERY_MAX}
          editable={editable}
          testID="search-input"
          style={[styles.input, { borderColor: focused ? theme.color.accent.a500 : theme.color.border.strong }, !editable && styles.disabled]}
        />
        <ProovraButton
          label="Search"
          fullWidth={false}
          disabled={!editable}
          onPress={() => {
            setOpen(false);
            onSubmit();
          }}
        />
      </View>

      {open && editable ? (
        <View style={styles.menu} testID="search-typeahead">
          {showRecent && recent.length === 0 ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              Tip: try searching by filename, case name, or report title.
            </ProovraText>
          ) : null}
          {showRecent && recent.length > 0 ? (
            <View style={styles.group}>
              <View style={styles.groupHead}>
                <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Recent searches</ProovraText>
                <Pressable onPress={onClearRecent} accessibilityRole="button" accessibilityLabel="Clear all recent searches" hitSlop={8}>
                  <ProovraText variant="label" weight="semibold" color={theme.color.accent.a600}>Clear all</ProovraText>
                </Pressable>
              </View>
              {recent.map((r) => (
                <View key={r} style={styles.itemRow}>
                  <Pressable onPress={() => pick(r)} accessibilityRole="button" accessibilityLabel={`Search again: ${r}`} style={styles.item}>
                    <ProovraText variant="bodySm" numberOfLines={1}>{r}</ProovraText>
                  </Pressable>
                  <Pressable onPress={() => onRemoveRecent(r)} accessibilityRole="button" accessibilityLabel={`Remove search "${r}"`} hitSlop={8} style={styles.remove}>
                    <ProovraText variant="label" color={theme.color.ink.muted}>✕</ProovraText>
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          {!showRecent && suggestions.length > 0 ? (
            <View style={styles.group}>
              <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Suggestions</ProovraText>
              {suggestions.map((s) => (
                <Pressable key={s.id} onPress={() => pick(s.title)} accessibilityRole="button" accessibilityLabel={`Suggestion: ${s.title}`} style={[styles.item, styles.itemRow]}>
                  <ProovraText variant="bodySm" numberOfLines={1} style={{ flex: 1 }}>{s.title}</ProovraText>
                  {s.documentType ? <ProovraBadge tone="neutral" label={documentTypeDisplay(s.documentType).label} /> : null}
                </Pressable>
              ))}
            </View>
          ) : null}
          {!showRecent && suggestions.length === 0 ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              No matching titles. Press Enter to search anyway.
            </ProovraText>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: theme.space.s2 },
  fieldRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s2 },
  input: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.s3,
    paddingVertical: theme.space.s3,
    fontSize: theme.type.size.body,
    color: theme.color.ink.primary,
    backgroundColor: theme.color.surface.card,
  },
  disabled: { opacity: 0.5 },
  menu: {
    gap: theme.space.s2,
    padding: theme.space.s3,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border.default,
    backgroundColor: theme.color.surface.card,
  },
  group: { gap: theme.space.s1 },
  groupHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  itemRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s2 },
  item: { flex: 1, minHeight: 36, justifyContent: "center" },
  remove: { minWidth: 32, minHeight: 32, alignItems: "center", justifyContent: "center" },
});
