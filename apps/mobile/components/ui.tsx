import { colors, radius, spacing, typography } from "@proovra/ui";
import React from "react";
import { Image, Pressable, StyleSheet, Text, View, ViewStyle } from "react-native";
import { useLocale } from "../src/locale-context";
import appIcon from "../assets/icon.png";
import { usePathname, useRouter } from "expo-router";

export function TopBar({ title }: { title: string }) {
  const { fontFamilyBold, isRTL } = useLocale();
  return (
    <View style={[styles.topBar, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
      <Image source={appIcon} style={styles.logo} />
      <Text style={[styles.topBarTitle, { fontFamily: fontFamilyBold }]}>{title}</Text>
    </View>
  );
}

export function Card({
  children,
  style
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  label,
  variant = "primary",
  onPress,
  left
}: {
  label: string;
  variant?: "primary" | "secondary";
  onPress?: () => void;
  left?: React.ReactNode;
}) {
  const { fontFamilyBold } = useLocale();
  const isPrimary = variant === "primary";
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        isPrimary ? styles.buttonPrimary : styles.buttonSecondary,
        pressed && { opacity: 0.92 }
      ]}
      onPress={onPress}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {left}
        <Text
          style={[
            styles.buttonText,
            { fontFamily: fontFamilyBold },
            !isPrimary && { color: colors.primaryNavy }
          ]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

export function StatusPill({ label }: { label: string }) {
  const { fontFamilyBold } = useLocale();
  return (
    <View style={styles.pill}>
      <View style={styles.pillDot} />
      <Text style={[styles.pillText, { fontFamily: fontFamilyBold }]}>{label}</Text>
    </View>
  );
}

export function Badge({
  label,
  tone
}: {
  label: string;
  tone: "signed" | "processing" | "ready";
}) {
  const { fontFamilyBold } = useLocale();

  const toneStyle =
    tone === "signed"
      ? { bg: "rgba(31,153,85,0.12)", border: "rgba(31,153,85,0.25)", dot: colors.greenValid, fg: colors.greenValid }
      : tone === "processing"
      ? { bg: "rgba(47,125,170,0.12)", border: "rgba(47,125,170,0.25)", dot: colors.blueInfo ?? "#2F7DAA", fg: colors.blueInfo ?? "#2F7DAA" }
      : { bg: "rgba(11,31,83,0.10)", border: "rgba(11,31,83,0.20)", dot: colors.primaryNavy, fg: colors.primaryNavy };

  return (
    <View style={[styles.badge, { backgroundColor: toneStyle.bg, borderColor: toneStyle.border }]}>
      <View style={[styles.badgeDot, { backgroundColor: toneStyle.dot }]} />
      <Text style={[styles.badgeText, { fontFamily: fontFamilyBold, color: toneStyle.fg }]}>
        {label}
      </Text>
    </View>
  );
}

export function Tabs({
  items,
  activeIndex = 0,
  onSelect
}: {
  items: string[];
  activeIndex?: number;
  onSelect?: (index: number) => void;
}) {
  const { fontFamilyBold } = useLocale();
  return (
    <View style={styles.tabs}>
      {items.map((item, idx) => {
        const active = idx === activeIndex;
        return (
          <Pressable
            key={item}
            onPress={() => onSelect?.(idx)}
            style={({ pressed }) => [
              styles.tab,
              active ? styles.tabActive : styles.tabInactive,
              pressed && { opacity: 0.95 }
            ]}
          >
            <Text
              style={[
                styles.tabText,
                { fontFamily: fontFamilyBold },
                active ? { color: colors.primaryNavy } : { color: "#475569" }
              ]}
            >
              {item}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ListRow({
  title,
  subtitle,
  badge,
  onPress
}: {
  title: string;
  subtitle: string;
  badge: React.ReactNode;
  onPress?: () => void;
}) {
  const { fontFamilyBold, fontFamily, isRTL } = useLocale();

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.94 }]}
    >
      <View style={[styles.listRowInner, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
        <View style={styles.thumbnail} />
        <View style={{ flex: 1 }}>
          <Text
            style={[
              styles.listTitle,
              { fontFamily: fontFamilyBold, textAlign: isRTL ? "right" : "left" }
            ]}
          >
            {title}
          </Text>
          <Text
            style={[
              styles.listSubtitle,
              { fontFamily, textAlign: isRTL ? "right" : "left" }
            ]}
          >
            {subtitle}
          </Text>
        </View>
        {badge}
      </View>
    </Pressable>
  );
}

export function TimelineBlock({ items }: { items: string[] }) {
  const { fontFamily, isRTL } = useLocale();
  return (
    <View style={styles.timeline}>
      {items.map((item) => (
        <View
          key={item}
          style={[styles.timelineRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}
        >
          <View style={styles.timelineDot} />
          <Text
            style={[
              styles.timelineText,
              { fontFamily, textAlign: isRTL ? "right" : "left" }
            ]}
          >
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function BottomNav() {
  const { fontFamilyBold, t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const items = [
    { label: t("home"), href: "/" },
    { label: t("cases"), href: "/cases" },
    { label: t("teams"), href: "/teams" },
    { label: t("settings"), href: "/settings" }
  ];
  return (
    <View style={styles.bottomNav}>
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Pressable key={item.href} onPress={() => router.push(item.href)}>
            <View style={styles.bottomNavItem}>
              <View
                style={[
                  styles.bottomNavIcon,
                  active ? { backgroundColor: colors.primaryNavy } : { backgroundColor: "#CBD5E1" }
                ]}
              />
              <Text
                style={[
                  styles.bottomNavText,
                  { fontFamily: fontFamilyBold },
                  active ? { color: colors.primaryNavy } : { color: "#94A3B8" }
                ]}
              >
                {item.label}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    alignItems: "center",
    gap: 12,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm
  },
  topBarTitle: {
    fontSize: typography.size.h3,
    color: colors.textDark
  },
  logo: {
    width: 34,
    height: 34,
    borderRadius: 10
  },

  card: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
    elevation: 2
  },

  button: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center"
  },
  buttonPrimary: {
    backgroundColor: colors.primaryNavy
  },
  buttonSecondary: {
    backgroundColor: "#EEF2F7",
    borderWidth: 1,
    borderColor: "rgba(15,23,42,0.08)"
  },
  buttonText: {
    fontSize: 14,
    color: colors.white
  },

  pill: {
    backgroundColor: "rgba(255,255,255,0.18)",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  pillDot: {
    width: 8,
    height: 8,
    borderRadius: 99,
    backgroundColor: "rgba(255,255,255,0.9)"
  },
  pillText: {
    color: colors.white,
    fontSize: 11
  },

  badge: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  badgeDot: { width: 8, height: 8, borderRadius: 99 },
  badgeText: { fontSize: 11 },

  tabs: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: "rgba(17,21,39,0.06)",
    padding: 4,
    borderRadius: 999
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 999,
    alignItems: "center"
  },
  tabActive: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border
  },
  tabInactive: {
    backgroundColor: "transparent"
  },
  tabText: {
    fontSize: 12
  },

  listRow: {
    borderTopWidth: 1,
    borderTopColor: "rgba(15,23,42,0.06)",
    paddingTop: spacing.md
  },
  listRowInner: {
    alignItems: "center",
    gap: 12
  },
  thumbnail: {
    width: 54,
    height: 54,
    borderRadius: 16,
    backgroundColor: "#DCE3F1"
  },
  listTitle: {
    fontSize: 13
  },
  listSubtitle: {
    fontSize: 11,
    color: "#64748b",
    marginTop: 3
  },

  timeline: {
    marginTop: 12,
    gap: 10
  },
  timelineRow: {
    alignItems: "center",
    gap: 10
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.greenValid
  },
  timelineText: {
    fontSize: 12,
    color: "#4b5563"
  },

  bottomNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    paddingTop: spacing.sm
  },
  bottomNavItem: {
    alignItems: "center",
    gap: 4
  },
  bottomNavIcon: {
    width: 18,
    height: 18,
    borderRadius: 6
  },
  bottomNavText: {
    fontSize: 10
  }
});
