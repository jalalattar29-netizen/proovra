/**
 * CANONICAL NATIVE APP HEADER (T-09 / RC-10).
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * The native app had NO header at all. Its entire global chrome was
 * `src/ui/shell.tsx` (175 lines) against the web's `components/app-shell-v2/`
 * (2,757 lines across six components), and the consequence the user actually
 * hit was that **global search did not exist**: `/search` was reachable from
 * exactly ONE place in the whole app — a card on Home
 * (`app/(tabs)/index.tsx:280`). Five of the seven primary destinations offered
 * no search at all.
 *
 * `AppShellV2.tsx` renders `AppAccountToolbar` on EVERY authenticated surface.
 * This is its native counterpart, rendered by `ProovraShell` in both nav modes.
 *
 * SCOPE OF THIS SLICE — T-09a only.
 * The web header additionally carries a workspace switcher (T-09b), an account
 * menu (T-09c), a notification bell (T-09d), a language selector and a system
 * status chip. Those are separate ledger rows and land in later slices; the
 * layout below leaves their zone in place rather than pretending they exist.
 */
import React, { useEffect, useState } from "react";
import { SHELL_SURFACE, useShellSurface } from "./shell-surface";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "../api";
import { useAuth } from "../auth-context";
import { useLocale } from "../locale-context";
import { accountDisplayName, accountInitials } from "../product/account-identity";
import {
  INBOX_SUMMARY_PATH,
  inboxBadgeLabel,
  resolveInboxSummaryUnread,
} from "../product/inbox";
import { usePlatformContext } from "../product/platform-context";
import { theme } from "../theme/theme";

// The canonical mark, as the web header's left zone carries the brand.
import MARK from "../../assets/brand/proovra-mark.png";

/**
 * Header geometry and palette, from `app-shell-v2.css`:
 *   .app-header-zone-*   :644-645  column-gap 20px, padding 0 20px
 *   .app-header-search   :706-715  height 36, gap 10, padding 0 8 0 12,
 *                                  radius 8, bg #FBFCFE, colour #94A3B8,
 *                                  font-size 13 / weight 500
 * The 36px control height is raised to the 44pt touch minimum, exactly as the
 * button primitive does; every other value is the web's.
 */
const SEARCH = {
  radius: theme.radius.md, // :711 border-radius: 8px
  bg: "#FBFCFE", // :712 background
  border: "rgba(15, 23, 42, 0.09)", // :713 var(--content-hover-border)
  fg: theme.color.ink.muted, // :714 #94A3B8 === ink.muted
  fontSize: 13, // :715
} as const;

export function ProovraHeader() {
  const router = useRouter();
  const { fontFamily, isRTL } = useLocale();
  const { context } = usePlatformContext();

  /*
   * The ACTIVE space's server-projected display name. Never derived locally:
   * `activeSpace.displayName` is what the canonical envelope reports
   * (`platform-context.ts:81`), and the web reads the same field. While the
   * envelope is still loading the control shows a neutral placeholder rather
   * than guessing "Personal Space" — a wrong workspace name in the chrome is
   * worse than no name.
   */
  const workspaceName = context?.displayName ?? "Workspace";

  /*
   * T-09d — the bell count. One read of the canonical cached aggregation.
   *
   * `null` is preserved all the way to the badge: an unread count that could
   * not be read is NOT zero, and rendering it as zero would tell someone they
   * are caught up when the request failed. `inboxBadgeLabel` returns null for
   * both unknown and genuinely-zero, so no badge is drawn in either case.
   */
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void apiFetch(INBOX_SUMMARY_PATH)
      .then((d) => {
        if (live) setUnread(resolveInboxSummaryUnread(d));
      })
      .catch(() => {
        // Leave the count unknown. The header must never invent "all clear".
        if (live) setUnread(null);
      });
    return () => {
      live = false;
    };
    // Re-read when the active workspace changes: the aggregation is scoped to it.
  }, [context?.activeTeamId]);

  const badge = inboxBadgeLabel(unread);

  // T-09c — the signed-in identity, from the canonical auth context.
  const { user } = useAuth();
  const onArtwork = useShellSurface();
  const accountName = accountDisplayName(user);
  const initials = accountInitials(user);

  return (
    <View
      style={[styles.header, onArtwork && styles.headerOnArtwork, { flexDirection: isRTL ? "row-reverse" : "row" }]}
      accessibilityRole="header"
    >
      <Image
        source={MARK}
        style={styles.mark}
        resizeMode="contain"
        accessible
        accessibilityRole="image"
        accessibilityLabel="PROOVRA"
      />

      {/*
        T-09a — the search affordance, on EVERY screen.
        The web renders a button reading "Search or jump to…" that opens the
        command palette (AppAccountToolbar.tsx:326-338). Native has no palette
        overlay yet, so the same control routes straight to the `/search`
        surface — the same destination, one step shorter.
      */}
      <Pressable
        onPress={() => router.push("/search")}
        accessibilityRole="search"
        accessibilityLabel="Search evidence, cases and reports"
        testID="header-search"
        style={({ pressed }) => [styles.search, pressed && styles.searchPressed]}
      >
        <Text
          numberOfLines={1}
          style={[styles.searchText, { fontFamily }]}
        >
          Search or jump to…
        </Text>
      </Pressable>

      {/*
        T-09b — the workspace switcher.

        Before this, `/spaces` was reachable from ONE row inside the Settings
        tab (`app/(tabs)/settings.tsx:174`), while the web offers the switcher
        in the header on every authenticated page. A user looking at the wrong
        workspace's data had to leave the screen, open Settings and find a row.

        The control REUSES the existing switcher surface rather than
        reimplementing it: `src/product/spaces.ts` already owns
        `projectSpaces` / `canSwitchTo` / `SWITCH_WORKSPACE_PATH`, and
        `app/(stack)/spaces.tsx` renders them. The web opens a dropdown; native
        routes to that full screen — same destination, same capability, a
        justified platform adaptation.

        The accessible name mirrors the web's exactly
        (`AppAccountToolbar.tsx:402`) so a screen reader announces the active
        workspace before the action.
      */}
      <Pressable
        onPress={() => router.push("/spaces")}
        accessibilityRole="button"
        accessibilityLabel={`Active workspace: ${workspaceName}. Open workspace switcher.`}
        testID="header-workspace"
        style={({ pressed }) => [styles.workspace, pressed && styles.workspacePressed]}
      >
        <Text numberOfLines={1} style={[styles.workspaceText, { fontFamily }]}>
          {workspaceName}
        </Text>
      </Pressable>

      {/*
        T-09d — the notification bell.

        The web shows it on every authenticated page; native surfaced unread
        state only by opening the Alerts destination. The count comes from the
        CANONICAL cached aggregation (`/v1/me/inbox/summary`), which the API
        guarantees cannot disagree with the page or with bulk actions
        (me-inbox.routes.ts:1376-1386).

        An UNKNOWN count renders no badge — never a confident "0". A failed
        read must not tell someone they are caught up.
      */}
      <Pressable
        onPress={() => router.push("/notifications")}
        accessibilityRole="button"
        accessibilityLabel={
          badge
            ? `Notifications, ${badge} unread. Open the notification centre.`
            : "Notifications. Open the notification centre."
        }
        testID="header-bell"
        style={({ pressed }) => [styles.bell, pressed && styles.workspacePressed]}
      >
        <Text style={[styles.bellGlyph, { fontFamily }]}>{"⚑"}</Text>
        {badge ? (
          <View style={styles.badge} accessible={false}>
            <Text style={[styles.badgeText, { fontFamily }]} numberOfLines={1}>
              {badge}
            </Text>
          </View>
        ) : null}
      </Pressable>

      {/*
        T-09c — the account control.

        The web renders an avatar with the signed-in name on every page
        (`AppAccountToolbar.tsx:578-590`). Native showed the identity NOWHERE in
        its chrome, so a user could not tell which account they were in.

        The web opens a menu whose entries (Settings, Billing, Organizations,
        Sign out) ALL already exist as rows in the native Settings tab. Building
        a second menu here would duplicate that surface, so the control routes
        to `/settings` — the native account home — and its job in the chrome is
        to make the identity VISIBLE, which is the part that was missing.
      */}
      <Pressable
        onPress={() => router.push("/settings")}
        accessibilityRole="button"
        accessibilityLabel={`Signed in as ${accountName}. Open account settings.`}
        testID="header-account"
        style={({ pressed }) => [styles.avatar, pressed && styles.workspacePressed]}
      >
        <Text style={[styles.avatarText, { fontFamily }]} numberOfLines={1}>
          {initials}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: "center",
    gap: theme.space.s3,
    paddingHorizontal: theme.space.s5, // :645 padding: 0 20px
    paddingVertical: theme.space.s2,
    backgroundColor: theme.color.surface.header,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border.default,
  },
  // Over the shell artwork: a faint glass bar with no separator (app-shell-v2.css:626-631).
  headerOnArtwork: { backgroundColor: SHELL_SURFACE.header, borderBottomWidth: 0 },
  mark: { width: 22, height: 25 },
  search: {
    flex: 1,
    minHeight: 44, // the web's 36px raised to the touch minimum
    justifyContent: "center",
    paddingHorizontal: theme.space.s3,
    borderRadius: SEARCH.radius,
    backgroundColor: SEARCH.bg,
    borderWidth: 1,
    borderColor: SEARCH.border,
  },
  // The web expresses this as :hover; touch has no hover, so it becomes press.
  searchPressed: { backgroundColor: "#F4F6FB", borderColor: "rgba(15, 23, 42, 0.14)" },
  searchText: { fontSize: SEARCH.fontSize, color: SEARCH.fg },
  workspace: {
    minHeight: 44,
    maxWidth: 140,
    justifyContent: "center",
    paddingHorizontal: theme.space.s3,
    borderRadius: SEARCH.radius,
    borderWidth: 1,
    borderColor: SEARCH.border,
  },
  workspacePressed: { backgroundColor: theme.color.surface.hover },
  workspaceText: {
    fontSize: SEARCH.fontSize,
    color: theme.color.ink.secondary,
    fontWeight: "500",
  },
  bell: {
    minHeight: 44,
    minWidth: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: SEARCH.radius,
  },
  bellGlyph: { fontSize: 18, color: theme.color.ink.secondary },
  badge: {
    position: "absolute",
    top: 4,
    right: 2,
    minWidth: 18,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.semantic.error,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: 10, color: theme.color.ink.onAccent, fontWeight: "700" },
  avatar: {
    minHeight: 44,
    minWidth: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.accent["050"],
    borderWidth: 1,
    borderColor: theme.color.accent.a200,
  },
  avatarText: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.color.accent.a600,
  },
});
