import { colors, radius, spacing } from "@proovra/ui";
import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
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

export function Button({
  label,
  variant = "primary",
  onPress
}: {
  label: string;
  variant?: "primary" | "secondary";
  onPress?: () => void;
}) {
  const { fontFamilyBold } = useLocale();
  return (
    <Pressable
      style={[
        styles.button,
        variant === "primary" ? styles.buttonPrimary : styles.buttonSecondary
      ]}
      onPress={onPress}
    >
      <Text
        style={[
          styles.buttonText,
          { fontFamily: fontFamilyBold },
          variant === "secondary" && { color: colors.primaryNavy }
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function StatusPill({ label }: { label: string }) {
  const { fontFamilyBold } = useLocale();
  return (
    <View style={styles.pill}>
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
      ? styles.badgeSigned
      : tone === "processing"
      ? styles.badgeProcessing
      : styles.badgeReady;
  return (
    <View style={[styles.badge, toneStyle]}>
      <Text style={[styles.badgeText, { fontFamily: fontFamilyBold }]}>{label}</Text>
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
      {items.map((item, idx) => (
        <Pressable
          key={item}
          onPress={() => onSelect?.(idx)}
          style={[
            styles.tab,
            idx === activeIndex ? styles.tabActive : styles.tabInactive
          ]}
        >
          <Text
            style={[
              styles.tabText,
              { fontFamily: fontFamilyBold },
              idx === activeIndex ? { color: colors.white } : { color: "#475569" }
            ]}
          >
            {item}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function ListRow({
  title,
  subtitle,
  badge
}: {
  title: string;
  subtitle: string;
  badge: React.ReactNode;
}) {
  const { fontFamilyBold, fontFamily, isRTL } = useLocale();
  return (
    <View style={[styles.listRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
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
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm
  },
  topBarTitle: {
    fontSize: 20,
    color: colors.textDark
  },
  logo: {
    width: 34,
    height: 34,
    borderRadius: 10
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
    backgroundColor: "#EEF2F7"
  },
  buttonText: {
    fontSize: 14,
    color: colors.white
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border
  },
  pill: {
    backgroundColor: colors.primaryNavy,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.pill
  },
  pillText: {
    color: colors.white,
    fontSize: 12
  },
  badge: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radius.pill
  },
  badgeText: {
    fontSize: 11
  },
  badgeSigned: {
    backgroundColor: "rgba(31,153,85,0.12)",
    borderColor: "rgba(31,153,85,0.25)",
    borderWidth: 1
  },
  badgeProcessing: {
    backgroundColor: "rgba(47,125,170,0.12)",
    borderColor: "rgba(47,125,170,0.25)",
    borderWidth: 1
  },
  badgeReady: {
    backgroundColor: "rgba(11,31,83,0.1)",
    borderColor: "rgba(11,31,83,0.2)",
    borderWidth: 1
  },
  tabs: {
    flexDirection: "row",
    gap: 10
  },
  tab: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "#E2E8F0"
  },
  tabActive: {
    backgroundColor: colors.primaryNavy
  },
  tabInactive: {
    backgroundColor: colors.white
  },
  tabText: {
    fontSize: 12
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  thumbnail: {
    width: 50,
    height: 50,
    borderRadius: 14,
    backgroundColor: "#DCE3F1"
  },
  listTitle: {
    fontSize: 13
  },
  listSubtitle: {
    fontSize: 11,
    color: "#64748b"
  },
  timeline: {
    marginTop: 12,
    gap: 10
  },
  timelineRow: {
    flexDirection: "row",
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
