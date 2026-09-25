/**
 * CANONICAL APP SHELL + RESPONSIVE NAVIGATION (Phase 3/5). One nav, two forms:
 * a bottom bar on phones (compact) and a persistent left rail on tablets
 * (medium/expanded), chosen at runtime by useResponsive — not by device name.
 * Content is clamped to a readable column on wide layouts. Supersedes the
 * legacy components/ui.tsx BottomNav (Home/Cases/Settings only).
 */
import React, { useEffect, useMemo, useState } from "react";
import { ShellBackdrop } from "./shell-surface";
import {
  Image,
  ImageBackground,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePathname, useRouter } from "expo-router";
import { useLocale } from "../locale-context";
import { useNetwork } from "../network/network-context";
import { useResponsive } from "../theme/responsive";
import { theme } from "../theme/theme";
import {
  bottomBarItems,
  isActiveHref,
  navigationInputFromEnvelope,
  provisionalNavigation,
  resolveNativeNavigation,
  type NavGroup,
  type NavItem,
} from "../product/navigation";
import { usePlatformContext } from "../product/platform-context";
import { apiFetch } from "../api";
import { BILLING_OVERVIEW_PATH } from "../product/billing";
import { storageViewFromOverview, type StorageView } from "../product/storage-widget";
import { resolveShellGate } from "../product/shell-gates";
import { ShellGatePanel } from "./shell-gate-panel";
import { ProovraHeader } from "./header";
import { NativeChatAssistant } from "./native-chat-assistant";

// T-05 / RC-05 — the canonical sidebar artwork, copied from the web reference
// (apps/web/public/assets/cards/sidebar.png) which app-shell-v2.css:175 loads.
import SIDEBAR_BG from "../../assets/brand/sidebar-bg.png";
// T-09g — the expanded-rail wordmark, apps/web/public/assets/branding/logo-dark.png.
import LOGO_DARK from "../../assets/brand/logo-dark.png";

/*
 * T-09f / RC-10 — navigation is no longer a hardcoded array. The destination
 * set, its grouping, its icons and its access decision all come from
 * `src/product/navigation.ts`, which mirrors the web registry pipeline and is
 * held to it by `test/navigation-model.test.mjs`.
 */
export type { NavGroup, NavItem } from "../product/navigation";

/**
 * The grouped navigation for the active envelope — ONE derivation per shell,
 * shared by the rail, the bottom bar and the drawer so they cannot disagree.
 *
 * Until the envelope arrives (or if it cannot be read) the provisional set is
 * offered WITHOUT access chips: we do not yet know the access state, and a chip
 * would be a claim we cannot back. Screens enforce their own access regardless.
 */
export function useNavigationGroups(): readonly NavGroup[] {
  const { envelope } = usePlatformContext();
  return useNavigationGroupsFor(envelope);
}

function useNavigationGroupsFor(envelope: unknown): readonly NavGroup[] {
  return useMemo(
    () => (envelope ? resolveNativeNavigation(navigationInputFromEnvelope(envelope)) : provisionalNavigation()),
    [envelope],
  );
}

function useNavLabel(): (item: NavItem) => string {
  const { t } = useLocale();
  return (item) => (item.route.labelKey ? t(item.route.labelKey) : item.route.label);
}

/**
 * T-06 / RC-06 — the canonical sidebar palette.
 *
 * A CORRECTION TO THE AUDIT FINDING, MADE BEFORE IMPLEMENTING IT.
 * --------------------------------------------------------------
 * RC-06 reported that `theme.color.nav.*` carried values "byte-identical to the
 * web's --nav-* custom properties" and that the web sidebar was DARK artwork
 * with LIGHT ink. Both halves were wrong, because the audit resolved `--nav-*`
 * through `tokens.css` (`:root`) only and never saw that
 * `app-shell-v2.css:48-58` **overrides every one of them** at component scope.
 *
 * The web's own comment there is unambiguous:
 *   "Light branded sidebar — the rail background is a very light artwork
 *    (assets/cards/sidebar.png), so every nav foreground colour is
 *    enterprise-dark for excellent contrast + readability. Never white."
 *
 * So `theme.color.nav.inkStrong` (#F8FAFC, from tokens.css) is near-WHITE and
 * would be illegible on the light artwork. Applying it — which is what the
 * finding literally asked for — would have replaced one unreadable rail with
 * another. The values below are the component-scoped overrides that actually
 * win on the web, cited line by line and kept honest by
 * `test/shell-artwork-and-nav.test.mjs`.
 *
 * This is also a worked example of audit item U-2 ("which declaration wins" is
 * not decidable from a `:root` scan) turning out to change the answer.
 */
const SIDEBAR = {
  /** app-shell-v2.css:48 --nav-ink — primary labels */
  ink: "#1A1F2B",
  /** :49 --nav-ink-strong — active / hover strong text */
  inkStrong: "#141A22",
  /** :50 --nav-ink-muted */
  inkMuted: "#7A8597",
  /** :51 --nav-ink-secondary — section titles */
  inkSecondary: "#4B5565",
  /** :52 --nav-icon-idle */
  iconIdle: "#495469",
  /** :54 --nav-icon-active — PROOVRA brand navy */
  iconActive: "#223354",
  /** :55 --nav-hover-bg — very light white wash */
  hoverBg: "rgba(255, 255, 255, 0.30)",
  /** :56 --nav-active-bg — soft white capsule */
  activeBg: "rgba(255, 255, 255, 0.45)",
  /** :57 --nav-active-border — the capsule ring */
  activeBorder: "rgba(255, 255, 255, 0.55)",
  /** :58 --nav-divider */
  divider: "rgba(255, 255, 255, 0.25)",
} as const;

function navPalette(orientation: "bottom" | "rail", active: boolean) {
  if (orientation === "rail") {
    return {
      label: active ? SIDEBAR.inkStrong : SIDEBAR.ink,
      icon: active ? SIDEBAR.iconActive : SIDEBAR.iconIdle,
      rowBg: active ? SIDEBAR.activeBg : "transparent",
      pressedBg: SIDEBAR.hoverBg,
    };
  }
  // The phone bottom bar is NOT the branded rail — it sits on surface.card, so
  // it keeps the body ink ramp. Deliberate, not an oversight.
  return {
    label: active ? theme.color.ink.primary : theme.color.ink.muted,
    icon: active ? theme.color.accent.a500 : theme.color.ink.muted,
    rowBg: "transparent",
    pressedBg: undefined,
  };
}

/** `.app-sidebar-v2-link` degradation chip — AppSidebarV2.tsx:303-325, verbatim values. */
const CHIP = {
  bg: "rgba(20, 26, 34, 0.06)",
  border: "rgba(20, 26, 34, 0.14)",
  fg: "#5A6576",
} as const;

function DegradationChip({ label }: { label: string }) {
  const { familyForWeight } = useLocale();
  return (
    <View style={styles.chip} testID="nav-degradation-chip">
      <Text numberOfLines={1} style={[styles.chipText, { fontFamily: familyForWeight("600") }]}>
        {label}
      </Text>
    </View>
  );
}

/**
 * One rail / drawer row — `.app-sidebar-v2-link` (app-shell-v2.css:347-427):
 * 44px row, 40px icon box holding an 18px glyph, 13.5px label at 500 (600
 * active), active capsule with a hairline white ring.
 *
 * A degraded destination still navigates, exactly as the web link still points
 * at its href: the destination owns the recovery state. The chip tells someone
 * BEFORE they tap that it will need setup, permission or an upgrade.
 */
function NavRow({ item, active, onNavigate, collapsed = false }: { item: NavItem; active: boolean; onNavigate?: () => void; collapsed?: boolean }) {
  const { familyForWeight, isRTL } = useLocale();
  const router = useRouter();
  const labelFor = useNavLabel();
  const label = labelFor(item);
  const palette = navPalette("rail", active);
  return (
    <Pressable
      onPress={() => {
        onNavigate?.();
        router.push(item.route.href);
      }}
      accessibilityRole="link"
      accessibilityState={{ selected: active }}
      accessibilityLabel={item.chip ? `${label}, ${item.chip}` : label}
      testID={`nav-${item.route.id}`}
      style={({ pressed }) => [
        styles.railItem,
        { flexDirection: isRTL ? "row-reverse" : "row", backgroundColor: palette.rowBg },
        collapsed ? { justifyContent: "center", paddingHorizontal: 0 } : null,
        active ? styles.railItemActive : null,
        // The web expresses hover as --nav-hover-bg. Touch has no hover, so the
        // same affordance becomes the pressed state rather than being dropped.
        pressed && !active ? { backgroundColor: palette.pressedBg } : null,
      ]}
    >
      <View style={styles.railIcon}>
        <Feather name={item.route.icon} size={18} color={palette.icon} />
      </View>
      {!collapsed ? <Text
        numberOfLines={1}
        style={[
          styles.railLabel,
          { fontFamily: familyForWeight(active ? "600" : "500"), color: palette.label, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {label}
      </Text> : null}
      {!collapsed && item.chip ? <DegradationChip label={item.chip} /> : null}
    </Pressable>
  );
}

function BottomNavButton({ item, active }: { item: NavItem; active: boolean }) {
  const { familyForWeight } = useLocale();
  const router = useRouter();
  const labelFor = useNavLabel();
  const label = labelFor(item);
  const palette = navPalette("bottom", active);
  return (
    <Pressable
      onPress={() => router.push(item.route.href)}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={item.chip ? `${label}, ${item.chip}` : label}
      testID={`nav-${item.route.id}`}
      style={({ pressed }) => [styles.bottomItem, pressed ? { opacity: 0.9 } : null]}
    >
      <Feather name={item.route.icon} size={22} color={palette.icon} />
      <Text
        numberOfLines={1}
        style={[styles.bottomLabel, { fontFamily: familyForWeight(active ? "700" : "500"), color: palette.label }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * T-09g — the web rail's storage footer (SidebarStorageWidget.tsx), with the
 * values of `.app-sidebar-v2-storage*` (app-shell-v2.css:528-600).
 *
 * Renders nothing until a usable view exists, and nothing if the read fails:
 * a 0% bar for an unknown value would claim the workspace is empty.
 */
function SidebarStorage() {
  const { familyForWeight } = useLocale();
  const [view, setView] = useState<StorageView | null>(null);
  useEffect(() => {
    let live = true;
    apiFetch(BILLING_OVERVIEW_PATH)
      .then((d) => {
        if (live) setView(storageViewFromOverview(d));
      })
      .catch(() => {
        if (live) setView(null);
      });
    return () => {
      live = false;
    };
  }, []);
  if (!view) return null;
  return (
    <View style={styles.storage} testID="nav-storage">
      <View style={styles.storageHead}>
        <Text style={[styles.storageLabel, { fontFamily: familyForWeight("600") }]}>Storage</Text>
        <Text style={[styles.storagePercent, { fontFamily: familyForWeight("600") }]}>{`${view.percent}%`}</Text>
      </View>
      <View
        style={styles.storageTrack}
        accessibilityRole="progressbar"
        accessibilityLabel="Storage used"
        accessibilityValue={{ min: 0, max: 100, now: view.percent }}
      >
        <View style={[styles.storageFill, { width: `${view.percent}%` }]} />
      </View>
      <Text style={[styles.storageDetail, { fontFamily: familyForWeight("400") }]}>
        {`${view.usedLabel} of ${view.limitLabel}`}
      </Text>
    </View>
  );
}

/**
 * T-09g — the rail's contents: brand area, grouped scrolling destinations with
 * titles and separators, and the help footer. Rendered by the tablet rail and
 * by the phone drawer, as the web renders ONE `<AppSidebarV2 />` in both its
 * sidebar slot and its mobile drawer (`AppShellV2.tsx:212`, `:276`).
 */
function RailContents({ groups, onNavigate, collapsed = false, onToggle }: {
  groups: readonly NavGroup[];
  onNavigate?: () => void;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { familyForWeight, isRTL } = useLocale();
  return (
    <>
      {/* `.app-sidebar-v2-brand` (:213-262) — the web shows the mark while the
          rail is collapsed and the wordmark once it expands. The native rail is
          always expanded (touch has no hover to expand it), so it shows the
          wordmark. */}
      <View style={[styles.brand, { alignItems: collapsed ? "center" : isRTL ? "flex-end" : "flex-start" }]} testID="nav-brand">
        {collapsed && onToggle ? (
          <Pressable
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityLabel="Expand navigation"
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <Feather name="menu" size={23} color={SIDEBAR.inkStrong} />
          </Pressable>
        ) : <Image
          source={LOGO_DARK}
          style={styles.brandLogo}
          resizeMode="contain"
          accessible
          accessibilityRole="image"
          accessibilityLabel="PROOVRA"
        />}
        {!collapsed && onToggle ? (
          <Pressable
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityLabel="Collapse navigation"
            style={{ position: "absolute", right: 4, top: 14, width: 36, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <Feather name="chevrons-left" size={18} color={SIDEBAR.inkStrong} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.railScroll, collapsed ? { paddingHorizontal: 8, gap: 10 } : null]}
        showsVerticalScrollIndicator={false}
        testID="nav-rail-scroll"
      >
        {groups.map((group, index) => (
          <View key={group.id} style={styles.group} testID={`nav-group-${group.id}`}>
            {/* The web draws a hairline above every group title but the first. */}
            {index > 0 ? <View style={styles.groupDivider} testID="nav-group-divider" /> : null}
            {!collapsed ? <Text
              accessibilityRole="header"
              style={[styles.groupTitle, { fontFamily: familyForWeight("700"), textAlign: isRTL ? "right" : "left" }]}
            >
              {group.title.toUpperCase()}
            </Text> : null}
            <View style={styles.groupNav}>
              {group.items.map((item) => (
                <NavRow
                  key={item.route.id}
                  item={item}
                  active={isActiveHref(pathname, item.route.href)}
                  onNavigate={onNavigate}
                  collapsed={collapsed}
                />
              ))}
            </View>
          </View>
        ))}
      </ScrollView>

      {!collapsed ? <SidebarStorage /> : null}

      {/* `.app-sidebar-v2-help` (AppSidebarV2.tsx:741-768). The web opens the
          public support page in a new tab so the shell stays put; native has a
          real support screen, so it routes there. */}
      <Pressable
        onPress={() => {
          onNavigate?.();
          router.push("/support");
        }}
        accessibilityRole="link"
        accessibilityLabel="Need help? Contact support"
        testID="nav-help"
        style={({ pressed }) => [
          styles.help,
          { flexDirection: isRTL ? "row-reverse" : "row" },
          pressed ? { backgroundColor: SIDEBAR.hoverBg } : null,
        ]}
      >
        <Feather name="life-buoy" size={18} color={SIDEBAR.inkMuted} />
        {!collapsed ? <View style={styles.helpText}>
          <Text style={[styles.helpStrong, { fontFamily: familyForWeight("600") }]}>Need help?</Text>
          <Text style={[styles.helpSmall, { fontFamily: familyForWeight("400") }]}>Contact support</Text>
        </View> : null}
      </Pressable>
    </>
  );
}

/**
 * Phone bottom navigation bar — a bounded five-slot subset of the Workspace
 * group, plus Menu, which opens the full grouped navigation.
 */
export function ProovraBottomNav({ groups, onOpenMenu }: { groups: readonly NavGroup[]; onOpenMenu: () => void }) {
  const pathname = usePathname();
  const { familyForWeight } = useLocale();
  const items = bottomBarItems(groups);
  const palette = navPalette("bottom", false);
  return (
    <View style={styles.bottomBar} testID="nav-bottom-bar">
      {items.map((item) => (
        <BottomNavButton key={item.route.id} item={item} active={isActiveHref(pathname, item.route.href)} />
      ))}
      <Pressable
        onPress={onOpenMenu}
        accessibilityRole="button"
        accessibilityLabel="Open navigation menu"
        testID="nav-menu"
        style={({ pressed }) => [styles.bottomItem, pressed ? { opacity: 0.9 } : null]}
      >
        <Feather name="menu" size={22} color={palette.icon} />
        <Text numberOfLines={1} style={[styles.bottomLabel, { fontFamily: familyForWeight("500"), color: palette.label }]}>
          Menu
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Phone navigation drawer — the web's `#app-mobile-drawer` (AppShellV2.tsx:
 * 263-279): a modal panel over the page holding the SAME sidebar, labelled
 * "Navigation", closed by the overlay or by choosing a destination.
 */
function ProovraNavDrawer({ visible, onClose, groups }: { visible: boolean; onClose: () => void; groups: readonly NavGroup[] }) {
  const { isRTL } = useLocale();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.drawerRoot, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
        <ImageBackground
          source={SIDEBAR_BG}
          resizeMode="cover"
          style={styles.drawer}
          accessibilityViewIsModal
          accessibilityLabel="Navigation"
          testID="nav-drawer"
        >
          <SafeAreaView style={styles.flex} edges={["top", "bottom", isRTL ? "right" : "left"]}>
            <RailContents groups={groups} onNavigate={onClose} />
          </SafeAreaView>
        </ImageBackground>
        <Pressable
          style={styles.drawerOverlay}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close navigation menu"
          testID="nav-drawer-close"
        />
      </View>
    </Modal>
  );
}

/**
 * Tablet left rail — the native counterpart of the web `.app-sidebar-v2`.
 *
 * T-05 / RC-05 — the web declares, at `app-shell-v2.css:171-178`:
 *     background-image: url("/assets/cards/sidebar.png");
 *     background-repeat: no-repeat; background-position: center;
 *     background-size: cover;
 * and its own comment is explicit that there is NO gradient and NO overlay:
 * "One image, shown naturally". `resizeMode="cover"` is the RN equivalent of
 * `background-size: cover` with `background-position: center`.
 *
 * Width is the web's EXPANDED rail, 240px (`--sidebar-expanded`). The web
 * collapses to a 68px icon rail and expands on hover; touch has no hover, so
 * the native rail stays expanded — the state in which the web shows labels.
 */
export function ProovraTabletRail({ groups, collapsed = false, onToggle, onNavigate }: {
  groups: readonly NavGroup[];
  collapsed?: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
}) {
  return (
    <ImageBackground
      source={SIDEBAR_BG}
      resizeMode="cover"
      style={[styles.rail, { width: collapsed ? 68 : 240 }]}
      testID="nav-rail"
    >
      <RailContents
        groups={groups}
        collapsed={collapsed}
        onToggle={onToggle}
        onNavigate={onNavigate}
      />
      {collapsed && onToggle ? (
        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel="Expand sidebar"
          testID="nav-expand-background"
          style={{
            position: "absolute",
            top: 72,
            right: 0,
            bottom: 0,
            left: 0,
          }}
          pointerEvents="auto"
        />
      ) : null}
    </ImageBackground>
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

export function ProovraShell({
  children,
  scroll = true,
  footer,
  layout = "shell",
}: {
  children: React.ReactNode;
  /** false for a screen that manages its own scrolling (lists, editors). */
  scroll?: boolean;
  /** A pinned action bar below the content (ProovraScreen's footer). */
  footer?: React.ReactNode;
  /**
   * "shell" pads and clamps the content column itself (the tab surfaces).
   * "bare" leaves both to the caller: ProovraScreen already pads and clamps,
   * and doing it twice doubled the gutter on phones.
   */
  layout?: "shell" | "bare";
}) {
  const { navMode, contentMaxWidth } = useResponsive();
  const { isRTL } = useLocale();
  // ONE envelope read per shell. Navigation and the shell gate derive from the
  // same value, so the rail can never offer a destination the gate is hiding.
  const platform = usePlatformContext();
  const groups = useNavigationGroupsFor(platform.envelope);
  const [menuOpen, setMenuOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(true);

  /*
   * T-09e — the web swaps the PAGE (not the shell) for a recovery surface when
   * the envelope carries recoveryActions, or when policy forbids the active
   * Personal Space (AppShellV2.tsx:241-247). Header and navigation stay, so
   * the person can still reach the switcher and support.
   */
  const gate = useMemo(() => resolveShellGate(platform.envelope), [platform.envelope]);
  const content = gate.kind === "none" ? children : <ShellGatePanel gate={gate} onRetry={platform.refresh} />;

  const bare = layout === "bare";
  const railBody = bare ? content : <View style={[styles.contentColumn, { maxWidth: contentMaxWidth }]}>{content}</View>;
  const body = navMode === "rail" ? railBody : content;
  // The page region: scrolling or not, with the footer pinned beneath it and
  // the keyboard pushing both up (settings and create forms live in here).
  const page = (containerStyle: object) => (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      {scroll ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={bare ? styles.bareContent : containerStyle}
          keyboardShouldPersistTaps="handled"
          testID="shell-main-content"
        >
          {body}
        </ScrollView>
      ) : (
        <View style={styles.flex} testID="shell-main-content">
          {body}
        </View>
      )}
      {footer}
    </KeyboardAvoidingView>
  );

  if (navMode === "rail") {
    return (
      <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
        <OfflineBanner />
        {/*
          T-09h — the web puts "Skip to main content" first in the tab order
          (AppShellV2.tsx:195) because a keyboard user otherwise walked the whole
          sidebar before reaching the page. A screen reader on a tablet has the
          same problem with the rail. A link that exists only to jump past a
          list is a keyboard-web idiom; the native equivalent is to put the
          content FIRST in the accessibility order and the rail after it.

          So the tree is [content column, rail] and the row is REVERSED to draw
          the rail on the leading edge: row-reverse in LTR, row in RTL. Visual
          placement is unchanged; the reading order is header → page → rail.
        */}
        <View style={[styles.railRow, { flexDirection: isRTL ? "row" : "row-reverse" }]}>
          {/* NEW:VIS-SHELL-BG — the artwork sits behind the header + content
              column only; the rail keeps its own (app-shell-v2.css:65-67). */}
          <ShellBackdrop>
            {/* T-09a — the header sits in the CONTENT column on tablet, beside
                the rail, exactly as the web grid places it (column 2, row 1). */}
            <ProovraHeader />
            {page(styles.railContent)}
            {railExpanded ? (
              <Pressable
                onPress={() => setRailExpanded(false)}
                accessibilityRole="button"
                accessibilityLabel="Collapse navigation and return to page"
                testID="nav-collapse-overlay"
                style={[StyleSheet.absoluteFill, { backgroundColor: "transparent" }]}
              />
            ) : null}
            {gate.kind === "none" ? <NativeChatAssistant /> : null}
          </ShellBackdrop>
          <ProovraTabletRail
            groups={groups}
            collapsed={!railExpanded}
            onToggle={() => setRailExpanded((value) => !value)}
            onNavigate={() => setRailExpanded(false)}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <OfflineBanner />
      {/* T-09a / RC-10 — on phones the header spans the full width above the
          scroll region. Search is now reachable from all SEVEN primary
          destinations; before this it existed on Home alone. */}
      <ShellBackdrop>
        <ProovraHeader />
        {page(styles.bottomContent)}
        {gate.kind === "none" ? <NativeChatAssistant /> : null}
      </ShellBackdrop>
      <ProovraBottomNav groups={groups} onOpenMenu={() => setMenuOpen(true)} />
      <ProovraNavDrawer visible={menuOpen} onClose={() => setMenuOpen(false)} groups={groups} />
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
  bareContent: { paddingBottom: theme.space.s10, flexGrow: 1 },
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
  bottomItem: { flex: 1, minHeight: 44, minWidth: 48, alignItems: "center", justifyContent: "center", gap: 2, paddingHorizontal: 2 },
  bottomLabel: { fontSize: 11 },
  rail: {
    // --sidebar-expanded (app-shell-v2.css). Was 220.
    width: 240,
    backgroundColor: theme.color.surface.card,
    borderRightWidth: StyleSheet.hairlineWidth,
    // box-shadow: 1px 0 0 rgba(20, 26, 34, 0.04) — the rail edge.
    borderRightColor: "rgba(20, 26, 34, 0.04)",
  },
  // .app-sidebar-v2-brand :213 — 72px block, 14px 12px padding, 8px below.
  brand: { height: 72, paddingVertical: 14, paddingHorizontal: 12, justifyContent: "center", marginBottom: 8 },
  // .app-sidebar-v2-brand-logo :239 — 46px high; width from the asset ratio (1158×330).
  brandLogo: { height: 46, width: 161 },
  // .app-sidebar-v2-scroll :264 — 26px between groups, 6px/8px padding.
  railScroll: { gap: 26, paddingTop: 6, paddingBottom: 8, paddingHorizontal: 12 },
  // .app-sidebar-v2-group :282 / -nav :287 — 2px and 3px gaps.
  group: { gap: 2 },
  groupNav: { gap: 3 },
  groupDivider: { height: StyleSheet.hairlineWidth, backgroundColor: SIDEBAR.divider, marginBottom: 12 },
  // .app-sidebar-v2-group-title :297 — 11px / 700 / 0.12em / uppercase, --nav-ink-secondary.
  groupTitle: { paddingTop: 2, paddingBottom: 8, paddingHorizontal: 6, fontSize: 11, letterSpacing: 1.32, color: SIDEBAR.inkSecondary },
  // .app-sidebar-v2-link :347 — 44px, 0 14px padding (the 40px icon box
  // supplies most of it), 8px radius, 13.5px.
  railItem: { height: 44, minHeight: 44, alignItems: "center", paddingHorizontal: 2, borderRadius: 8 },
  // .is-active :383 — 10px radius capsule with a hairline white ring.
  railItemActive: { borderRadius: 10, borderWidth: 1, borderColor: SIDEBAR.activeBorder },
  railIcon: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  railLabel: { flex: 1, fontSize: 13.5, letterSpacing: -0.08, paddingHorizontal: 8 },
  chip: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: CHIP.bg,
    borderWidth: 1,
    borderColor: CHIP.border,
    maxWidth: 110,
  },
  chipText: { fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase", color: CHIP.fg },
  // .app-sidebar-v2-help :461 — 44px row, muted ink, 8px above.
  help: { minHeight: 44, alignItems: "center", gap: 12, paddingHorizontal: 22, paddingVertical: 8, marginTop: 8, marginBottom: 8, borderRadius: 8 },
  helpText: { gap: 1 },
  helpStrong: { color: SIDEBAR.inkStrong, fontSize: 13 },
  helpSmall: { color: SIDEBAR.inkMuted, fontSize: 11 },
  // .app-sidebar-v2-storage :528-600
  storage: { marginTop: 8, marginHorizontal: 12, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, backgroundColor: "rgba(255, 255, 255, 0.04)" },
  storageHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  storageLabel: { color: "#172033", fontSize: 12 },
  storagePercent: { color: "#5F6878", fontSize: 12, fontVariant: ["tabular-nums"] },
  storageTrack: { marginTop: 7, height: 4, borderRadius: 999, backgroundColor: "rgba(23, 32, 51, 0.1)", overflow: "hidden" },
  storageFill: { height: "100%", borderRadius: 999, backgroundColor: theme.color.accent.a500 },
  storageDetail: { marginTop: 7, color: "#5F6878", fontSize: 11 },
  drawerRoot: { flex: 1 },
  drawer: { width: 280, maxWidth: "85%", height: "100%", backgroundColor: theme.color.surface.card },
  drawerOverlay: { flex: 1, backgroundColor: "rgba(15, 23, 42, 0.45)" },
  offline: { backgroundColor: theme.color.status.pending.bg, paddingHorizontal: theme.space.s4, paddingVertical: theme.space.s2 },
  offlineText: { color: theme.color.status.pending.fg, fontSize: theme.type.size.label, textAlign: "center" },
});
