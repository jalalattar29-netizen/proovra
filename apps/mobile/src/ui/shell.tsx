/**
 * CANONICAL APP SHELL + RESPONSIVE NAVIGATION (Phase 3/5). One nav, two forms:
 * a bottom bar on phones (compact) and a persistent left rail on tablets
 * (medium/expanded), chosen at runtime by useResponsive — not by device name.
 * Content is clamped to a readable column on wide layouts. Supersedes the
 * legacy components/ui.tsx BottomNav (Home/Cases/Settings only).
 */
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePathname, useRouter } from "expo-router";
import { useLocale } from "../locale-context";
import { useNetwork } from "../network/network-context";
import { useResponsive } from "../theme/responsive";
import { theme } from "../theme/theme";

export interface NavItem {
  label: string;
  href: string;
}

/** Canonical primary destinations (only routes that actually exist today). */
export function useNavItems(): NavItem[] {
  const { t } = useLocale();
  return [
    { label: t("home"), href: "/" },
    { label: t("ctaCapture"), href: "/capture" },
    { label: t("cases"), href: "/cases" },
    { label: "Evidence", href: "/evidence" },
    { label: "Reports", href: "/reports" },
    { label: "Alerts", href: "/notifications" },
    { label: t("settings"), href: "/settings" },
  ];
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname === "/index";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavButton({ item, active, orientation }: { item: NavItem; active: boolean; orientation: "bottom" | "rail" }) {
  const { fontFamilyBold } = useLocale();
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push(item.href)}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={item.label}
      style={({ pressed }) => [
        orientation === "rail" ? styles.railItem : styles.bottomItem,
        pressed && { opacity: 0.9 },
      ]}
    >
      <View
        style={[
          styles.indicator,
          { backgroundColor: active ? theme.color.accent.a500 : theme.color.border.strong },
        ]}
      />
      <Text
        numberOfLines={1}
        style={[
          styles.navLabel,
          { fontFamily: fontFamilyBold, color: active ? theme.color.ink.primary : theme.color.ink.muted },
        ]}
      >
        {item.label}
      </Text>
    </Pressable>
  );
}

/** Phone bottom navigation bar. */
export function ProovraBottomNav() {
  const items = useNavItems();
  const pathname = usePathname();
  return (
    <View style={styles.bottomBar}>
      {items.map((item) => (
        <NavButton key={item.href} item={item} active={isActive(pathname, item.href)} orientation="bottom" />
      ))}
    </View>
  );
}

/** Tablet left rail. */
export function ProovraTabletRail() {
  const items = useNavItems();
  const pathname = usePathname();
  return (
    <View style={styles.rail}>
      {items.map((item) => (
        <NavButton key={item.href} item={item} active={isActive(pathname, item.href)} orientation="rail" />
      ))}
    </View>
  );
}

/**
 * App shell for a primary tab surface. Phone: scroll + bottom nav. Tablet:
 * left rail + a readable, centered content column.
 */
function OfflineBanner() {
  const { isOffline } = useNetwork();
  if (!isOffline) return null;
  return (
    <View style={styles.offline} accessibilityRole="alert">
      <Text style={styles.offlineText}>You're offline — showing the latest available data.</Text>
    </View>
  );
}

export function ProovraShell({ children }: { children: React.ReactNode }) {
  const { navMode, contentMaxWidth } = useResponsive();
  const { isRTL } = useLocale();

  if (navMode === "rail") {
    return (
      <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
        <OfflineBanner />
        <View style={[styles.railRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <ProovraTabletRail />
          <ScrollView style={styles.flex} contentContainerStyle={styles.railContent}>
            <View style={[styles.contentColumn, { maxWidth: contentMaxWidth }]}>{children}</View>
          </ScrollView>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <OfflineBanner />
      <ScrollView style={styles.flex} contentContainerStyle={styles.bottomContent}>
        {children}
      </ScrollView>
      <ProovraBottomNav />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: theme.color.surface.app },
  bottomContent: { paddingHorizontal: theme.space.s4, paddingBottom: theme.space.s6, flexGrow: 1 },
  railRow: { flex: 1 },
  railContent: { paddingHorizontal: theme.space.s6, paddingVertical: theme.space.s5, flexGrow: 1, alignItems: "center" },
  contentColumn: { width: "100%" },
  bottomBar: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingTop: theme.space.s2,
    paddingBottom: theme.space.s2,
    paddingHorizontal: theme.space.s3,
    backgroundColor: theme.color.surface.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border.default,
  },
  bottomItem: { minHeight: 44, minWidth: 56, alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 6 },
  rail: {
    width: 220,
    paddingTop: theme.space.s5,
    paddingHorizontal: theme.space.s3,
    gap: theme.space.s1,
    backgroundColor: theme.color.surface.card,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.color.border.default,
  },
  railItem: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: theme.space.s3, paddingHorizontal: theme.space.s3, borderRadius: theme.radius.md },
  indicator: { width: 8, height: 8, borderRadius: 4 },
  navLabel: { fontSize: theme.type.size.label },
  offline: { backgroundColor: theme.color.status.pending.bg, paddingHorizontal: theme.space.s4, paddingVertical: theme.space.s2 },
  offlineText: { color: theme.color.status.pending.fg, fontSize: theme.type.size.label, textAlign: "center" },
});
