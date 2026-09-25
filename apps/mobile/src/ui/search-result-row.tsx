/**
 * ONE SEARCH RESULT — the web console's result card
 * (apps/web/app/(app)/search/page.tsx:2356-2459): the type as a filled
 * classification badge, the title, the record's leading STATE as toned text
 * (a legal hold first — primaryStatusBadge — else its lifecycle), the match
 * reasons, the supporting line (dropped when it only repeats the state), the
 * summary, the remaining signals, and "updated <time>".
 */
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import {
  documentTypeDisplay,
  primaryStatusBadge,
  rowLifecycleState,
  rowSupportingSubtitle,
  searchBadgeLabel,
  searchBadgeTone,
  searchLifecycleLabel,
  searchLifecycleTone,
  type SearchRow,
} from "../product/search";
import { ProovraBadge, ProovraText } from "./index";

export function SearchResultRow({ row, onPress, testID }: { row: SearchRow; onPress: () => void; testID?: string }) {
  const type = documentTypeDisplay(row.documentType);
  const badges = row.badges ?? [];
  const status = primaryStatusBadge(badges);
  const lifecycle = rowLifecycleState(row);
  const others = badges.filter((b) => b !== status);
  const subtitle = rowSupportingSubtitle(row);
  const title = row.title?.trim() || type.label;
  const stateTone = status ? searchBadgeTone(status) : lifecycle ? searchLifecycleTone(lifecycle) : null;
  const stateText = status ? searchBadgeLabel(status) : lifecycle ? searchLifecycleLabel(lifecycle) : null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      testID={testID}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.head}>
        <ProovraBadge tone={type.tone} label={type.label} />
        {stateText && stateTone ? (
          <ProovraText variant="label" weight="semibold" color={theme.color.status[stateTone].fg} testID="search-result-status">
            {stateText}
          </ProovraText>
        ) : null}
      </View>
      <ProovraText variant="body" weight="semibold" numberOfLines={2}>
        {title}
      </ProovraText>
      {row.matchReasons && row.matchReasons.length > 0 ? (
        <View style={styles.wrap}>
          {row.matchReasons.map((reason) => (
            <ProovraText key={reason} variant="label" color={theme.color.accent.a600}>
              {reason}
            </ProovraText>
          ))}
        </View>
      ) : null}
      {subtitle ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary} numberOfLines={2}>
          {subtitle}
        </ProovraText>
      ) : null}
      {row.summary ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary} numberOfLines={3}>
          {row.summary}
        </ProovraText>
      ) : null}
      {others.length > 0 ? (
        <View style={styles.wrap}>
          {others.map((b) => (
            <ProovraBadge key={b} tone={searchBadgeTone(b)} label={searchBadgeLabel(b)} />
          ))}
        </View>
      ) : null}
      {row.updatedAtUtc ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {`updated ${formatUserDateTime(row.updatedAtUtc)}`}
        </ProovraText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: theme.space.s1,
    paddingVertical: theme.space.s3,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border.default,
  },
  pressed: { opacity: 0.7 },
  head: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s1 },
});
