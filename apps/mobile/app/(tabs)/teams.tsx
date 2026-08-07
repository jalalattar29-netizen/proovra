// D:\digital-witness\apps\mobile\app\(tabs)\teams.tsx
/**
 * PHASE 12 REMEDIATION — MOBILE-001 (2026-08-06).
 *
 * What this screen used to be
 * ---------------------------
 * It fetched `GET /v1/teams` and rendered each workspace as a card with a
 * HARD-CODED "Members" subtitle, an EMPTY `<View />` badge, no `onPress`, no
 * route push, and no create or join affordance. Its empty state invited the
 * user to "Create a team to collaborate and share evidence securely" — an
 * action the mobile app does not implement anywhere. Of the 43 `onPress`
 * handlers in the reachable mobile graph, this screen contributed none.
 *
 * It was a dead product surface advertising a capability the app does not
 * have.
 *
 * Why a notice and not an implementation
 * --------------------------------------
 * The approved mobile scope is CITIZEN CAPTURE, Personal-Space-only. That is
 * not an accident of this screen — it is the app's architecture:
 * `apps/mobile/src/personal-space.ts` states that the app "has no workspace
 * switcher and no concept of an 'Organization workspace' target", and there
 * is no context to switch INTO. Building workspace selection here would mean
 * inventing a partial capability (a list without a switch, or a switch
 * without the authorization surfaces that make a workspace usable), which
 * the remediation explicitly forbids.
 *
 * So the honest correction is to stop advertising it:
 *
 *   * the Workspaces entry is REMOVED from the bottom navigation
 *     (`apps/mobile/components/ui.tsx`), so nothing routes here any more;
 *   * the route itself is KEPT so an existing deep link or a restored
 *     navigation state resolves to an explanation rather than a crash or a
 *     blank screen;
 *   * the screen is entirely NON-INTERACTIVE and makes no API call. It
 *     states what the app does and where workspace management lives. It
 *     names no workspace, so it leaks nothing about the account's tenancy;
 *   * no "Create a team" invitation survives, because there is no create.
 *
 * `noPersonalSpace` fails closed independently of this screen: capture is
 * gated by `isPersonalSpaceDisallowed` against the server-projected
 * `personalSpaceAllowed` flag, and every personal-scope mutation is
 * re-enforced server-side.
 */
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { spacing, typography } from "@proovra/ui";
import { BottomNav, Card, TopBar } from "../../components/ui";
import { useLocale } from "../../src/locale-context";

const NOTICE_TITLE = "Workspaces are managed on the web";

const NOTICE_BODY =
  "This app captures evidence into your Personal Space. Creating workspaces, inviting members and managing access are done in the PROOVRA web app on a browser.";

const NOTICE_FOOTNOTE =
  "Evidence you capture here stays in your Personal Space and is unaffected.";

export default function WorkspacesInfoScreen() {
  const { fontFamilyBold, t } = useLocale();

  return (
    <View style={styles.container}>
      <TopBar title={t("teams")} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.title, { fontFamily: fontFamilyBold }]}>
          {t("teams")}
        </Text>

        <View style={styles.noticeWrap}>
          <Card>
            <Text style={[styles.noticeTitle, { fontFamily: fontFamilyBold }]}>
              {NOTICE_TITLE}
            </Text>
            <Text style={styles.noticeBody}>{NOTICE_BODY}</Text>
            <Text style={styles.noticeFootnote}>{NOTICE_FOOTNOTE}</Text>
          </Card>
        </View>
      </ScrollView>

      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#050b18"
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl
  },
  title: {
    fontSize: typography.size.h3,
    marginTop: spacing.md,
    marginBottom: spacing.md,
    color: "rgba(245, 251, 255, 0.92)"
  },

  noticeWrap: {
    marginTop: spacing.md
  },
  noticeTitle: {
    color: "rgba(245, 251, 255, 0.92)",
    fontSize: 14,
    marginBottom: spacing.sm
  },
  noticeBody: {
    color: "rgba(219, 235, 248, 0.72)",
    fontSize: 12,
    lineHeight: 18,
    marginBottom: spacing.sm
  },
  noticeFootnote: {
    color: "rgba(219, 235, 248, 0.56)",
    fontSize: 11,
    lineHeight: 16
  }
});
