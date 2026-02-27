// D:\digital-witness\apps\mobile\components\ui.tsx
import React from "react";
import { Image, Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from "react-native";
import { spacing, typography } from "@proovra/ui";
import { appTheme } from "../src/app-theme";
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
  style?: StyleProp<ViewStyle>;
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
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        isPrimary ? styles.buttonPrimary : styles.buttonSecondary,
        pressed && styles.buttonPressed
      ]}
    >
      {({ pressed }) => (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {left}
          <Text style={[styles.buttonText, { fontFamily: fontFamilyBold }, pressed && { opacity: 0.92 }]}>
            {label}
          </Text>
        </View>
      )}
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
      ? { bg: "rgba(31,153,85,0.12)", border: "rgba(31,153,85,0.25)", dot: "#22c55e", fg: "#22c55e" }
      : tone === "processing"
      ? { bg: "rgba(47,125,170,0.12)", border: "rgba(47,125,170,0.25)", dot: "#2F7DAA", fg: "#2F7DAA" }
      : { bg: "rgba(101,235,255,0.10)", border: "rgba(101,235,255,0.22)", dot: appTheme.accent, fg: appTheme.accent };

  return (
    <View style={[styles.badge, { backgroundColor: toneStyle.bg, borderColor: toneStyle.border }]}>
      <View style={[styles.badgeDot, { backgroundColor: toneStyle.dot }]} />
      <Text style={[styles.badgeText, { fontFamily: fontFamilyBold, color: toneStyle.fg }]}>{label}</Text>
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
                active ? styles.tabTextActive : styles.tabTextInactive
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
    <Pressable onPress={onPress} style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.94 }]}>
      <View style={[styles.listRowInner, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
        <View style={styles.thumbnail} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.listTitle, { fontFamily: fontFamilyBold, textAlign: isRTL ? "right" : "left" }]}>
            {title}
          </Text>
          <Text style={[styles.listSubtitle, { fontFamily, textAlign: isRTL ? "right" : "left" }]}>
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
        <View key={item} style={[styles.timelineRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <View style={styles.timelineDot} />
          <Text style={[styles.timelineText, { fontFamily, textAlign: isRTL ? "right" : "left" }]}>{item}</Text>
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
              <View style={[styles.bottomNavIcon, active ? styles.bottomNavIconActive : styles.bottomNavIconInactive]} />
              <Text
                style={[
                  styles.bottomNavText,
                  { fontFamily: fontFamilyBold },
                  active ? styles.bottomNavTextActive : styles.bottomNavTextInactive
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
    color: appTheme.textStrong
  },
  logo: {
    width: 34,
    height: 34,
    borderRadius: 10
  },

  card: {
    backgroundColor: appTheme.surfaceTop,
    borderRadius: 18,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: appTheme.border,
    shadowColor: appTheme.shadowColor,
    shadowOpacity: 0.22,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 18 },
    elevation: 3
  },

  button: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1
  },
  buttonPrimary: {
    backgroundColor: appTheme.btnBg,
    borderColor: appTheme.btnBorder,
    shadowColor: appTheme.shadowColor,
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 2
  },
  buttonSecondary: {
    backgroundColor: "rgba(6, 13, 31, 0.48)",
    borderColor: appTheme.borderSoft
  },
  buttonPressed: {
    transform: [{ translateY: -1 }],
    backgroundColor: "rgba(0, 170, 255, 0.18)",
    borderColor: "rgba(0, 210, 255, 0.55)"
  },
  buttonText: {
    fontSize: 14,
    color: appTheme.text
  },

  pill: {
    backgroundColor: "rgba(101, 235, 255, 0.14)",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: appTheme.border
  },
  pillDot: {
    width: 8,
    height: 8,
    borderRadius: 99,
    backgroundColor: appTheme.accent
  },
  pillText: {
    color: appTheme.text,
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
    backgroundColor: "rgba(6, 13, 31, 0.35)",
    padding: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: appTheme.borderSoft
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 999,
    alignItems: "center",
    borderWidth: 1
  },
  tabActive: {
    backgroundColor: appTheme.pillActiveBg,
    borderColor: appTheme.pillActiveBorder
  },
  tabInactive: {
    backgroundColor: "transparent",
    borderColor: "transparent"
  },
  tabText: {
    fontSize: 12
  },
  tabTextActive: {
    color: appTheme.textStrong
  },
  tabTextInactive: {
    color: appTheme.muted
  },

  listRow: {
    borderTopWidth: 1,
    borderTopColor: "rgba(101, 235, 255, 0.10)",
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
    backgroundColor: "rgba(101, 235, 255, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(101, 235, 255, 0.14)"
  },
  listTitle: {
    fontSize: 13,
    color: appTheme.textStrong
  },
  listSubtitle: {
    fontSize: 11,
    color: appTheme.muted,
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
    backgroundColor: appTheme.accent
  },
  timelineText: {
    fontSize: 12,
    color: "rgba(219, 235, 248, 0.78)"
  },

  bottomNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    paddingTop: spacing.sm,
    backgroundColor: "rgba(6, 13, 31, 0.55)",
    borderTopWidth: 1,
    borderTopColor: appTheme.borderSoft
  },
  bottomNavItem: {
    alignItems: "center",
    gap: 6
  },
  bottomNavIcon: {
    width: 18,
    height: 18,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: appTheme.borderSoft
  },
  bottomNavIconActive: {
    backgroundColor: "rgba(101, 235, 255, 0.22)",
    borderColor: appTheme.borderStrong
  },
  bottomNavIconInactive: {
    backgroundColor: "rgba(6, 13, 31, 0.35)",
    borderColor: "rgba(101, 235, 255, 0.10)"
  },
  bottomNavText: {
    fontSize: 10
  },
  bottomNavTextActive: {
    color: "rgba(101, 235, 255, 0.98)"
  },
  bottomNavTextInactive: {
    color: "rgba(219, 235, 248, 0.60)"
  }
});