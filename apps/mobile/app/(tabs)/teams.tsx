/**
 * Workspaces — intentional stub (WEB-ONLY-INTENTIONAL).
 *
 * The approved mobile scope is CITIZEN CAPTURE, Personal-Space-only
 * (src/personal-space.ts: no workspace switcher, no Organization target). This
 * screen makes NO API call and is non-interactive: it explains where workspace
 * management lives and names no tenancy. It is not linked from navigation; the
 * route is kept so a restored nav-state / deep link resolves to an explanation.
 * Converged onto the canonical kit (Phase 12).
 */
import { StyleSheet } from "react-native";
import { useLocale } from "../../src/locale-context";
import { theme } from "../../src/theme/theme";
import { ProovraScreen, ProovraCard, ProovraSection, ProovraText } from "../../src/ui";

const NOTICE_TITLE = "Workspaces are managed on the web";
const NOTICE_BODY =
  "This app captures evidence into your Personal Space. Creating workspaces, inviting members and managing access are done in the PROOVRA web app on a browser.";
const NOTICE_FOOTNOTE =
  "Evidence you capture here stays in your Personal Space and is unaffected.";

export default function WorkspacesInfoScreen() {
  const { t } = useLocale();
  return (
    <ProovraScreen>
      <ProovraSection title={t("teams")}>
        <ProovraCard>
          <ProovraText variant="h3" weight="semibold">{NOTICE_TITLE}</ProovraText>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary} style={styles.body}>{NOTICE_BODY}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted} style={styles.footnote}>{NOTICE_FOOTNOTE}</ProovraText>
        </ProovraCard>
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  body: { marginTop: theme.space.s2 },
  footnote: { marginTop: theme.space.s2 },
});
