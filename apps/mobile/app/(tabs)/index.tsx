import { Platform, View, StyleSheet } from "react-native";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { useLocale } from "../../src/locale-context";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { usePlatformContext } from "../../src/product/platform-context";
import { projectTrustKpis, parseTrustSummary, type Kpi } from "../../src/product/home-metrics";
import { useResponsive } from "../../src/theme/responsive";
import { theme, statusTone } from "../../src/theme/theme";
import {
  ProovraShell,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../src/ui";
import { evidenceStatusDisplay, evidenceTypeLabel } from "../../src/product/domain-display";

type EvidenceItem = {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  statusLabel?: string | null;
  displayTitle?: string | null;
  title?: string | null;
  displaySubtitle?: string | null;
};
type LoadState = "loading" | "ready" | "error";

export default function HomeScreen() {
  const { t } = useLocale();
  const router = useRouter();
  const { breakpoint } = useResponsive();
  const { context } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [kpis, setKpis] = useState<Kpi[] | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const data = await apiFetch("/v1/evidence?scope=active");
      setItems((data.items ?? []) as EvidenceItem[]);
      setState("ready");
    } catch (err) {
      // Honest failure — never a silent catch → empty (audit §I / drift register).
      setError(toSafeUserError(err));
      setState("error");
    }
  }, []);

  // KPIs are a SEPARATE, optional load (partial-failure tolerant): a trust-summary
  // error or a not-yet-resolved workspace just hides the tiles — it never blocks
  // the evidence list, and no metric is fabricated (all real server counts).
  const loadKpis = useCallback(async () => {
    if (!teamId) {
      setKpis(null);
      return;
    }
    try {
      const data = await apiFetch(`/v1/dashboard/trust-summary?teamId=${encodeURIComponent(teamId)}`);
      setKpis(projectTrustKpis(parseTrustSummary(data)));
    } catch {
      setKpis(null); // hide tiles on failure; the rest of Home is unaffected
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadKpis();
  }, [loadKpis]);

  const kpiColumns = breakpoint === "compact" ? 2 : 4;

  return (
    <ProovraShell>
      <ProovraCard style={styles.searchBar} onPress={() => router.push("/search")} accessibilityLabel="Search evidence and cases">
        <ProovraText variant="body" color={theme.color.ink.muted}>
          Search evidence, cases…
        </ProovraText>
      </ProovraCard>

      {kpis ? (
        <View style={styles.kpiGrid} accessibilityRole="summary">
          {kpis.map((kpi) => {
            const c = statusTone(kpi.tone);
            return (
              <View
                key={kpi.key}
                style={[styles.kpiTile, { width: `${100 / kpiColumns - 2}%`, borderColor: theme.color.border.default }]}
              >
                <ProovraText variant="h2" weight="bold" color={c.solid}>
                  {kpi.value}
                </ProovraText>
                <ProovraText variant="label" color={theme.color.ink.secondary} numberOfLines={2}>
                  {kpi.label}
                </ProovraText>
              </View>
            );
          })}
        </View>
      ) : null}

      <ProovraCard style={styles.hero}>
        <ProovraText variant="h1" weight="bold">
          {t("brand")}
        </ProovraText>
        <ProovraText variant="body" color={theme.color.ink.secondary} style={styles.heroSub}>
          Capture truth. Prove it forever.
        </ProovraText>
        <View style={styles.heroActions}>
          <ProovraButton label={`+ ${t("ctaCapture")}`} onPress={() => router.push("/capture")} />
          {Platform.OS === "android" && (
            <>
              <ProovraButton
                label="Direct Screen Capture"
                variant="secondary"
                onPress={() => router.push("/screen-capture")}
              />
              <ProovraButton
                label="Continuous Screen Capture"
                variant="secondary"
                onPress={() => router.push("/continuous-capture")}
              />
            </>
          )}
          {Platform.OS === "ios" && (
            <ProovraButton
              label="Screen Capture"
              variant="secondary"
              onPress={() => router.push("/continuous-capture")}
            />
          )}
        </View>
      </ProovraCard>

      <ProovraSection title={t("recentEvidence")}>
        {state === "loading" ? (
          <ProovraLoadingState label={t("recentEvidence")} />
        ) : state === "error" && error ? (
          <ProovraErrorState message={error.message} onRetry={load} />
        ) : items.length === 0 ? (
          <ProovraEmptyState
            title="No evidence yet"
            message="Capture your first record to see it here."
            action={<ProovraButton label={`+ ${t("ctaCapture")}`} fullWidth={false} onPress={() => router.push("/capture")} />}
          />
        ) : (
          <ProovraCard>
            {items.map((item) => {
              const status = evidenceStatusDisplay(item.status);
              return (
                <ProovraListRow
                  key={item.id}
                  title={item.displayTitle?.trim() || item.title?.trim() || evidenceTypeLabel(item.type)}
                  subtitle={item.displaySubtitle?.trim() || `${evidenceTypeLabel(item.type)} · ${formatUserDateTime(item.createdAt)}`}
                  trailing={<ProovraBadge tone={status.tone} label={item.statusLabel?.trim() || status.label} />}
                  onPress={() => router.push(`/evidence/${item.id}`)}
                />
              );
            })}
          </ProovraCard>
        )}
      </ProovraSection>
    </ProovraShell>
  );
}

const styles = StyleSheet.create({
  searchBar: { marginTop: theme.space.s4, paddingVertical: theme.space.s3 },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s3 },
  kpiTile: {
    backgroundColor: theme.color.surface.card,
    borderRadius: theme.radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: theme.space.s4,
    paddingHorizontal: theme.space.s3,
    gap: theme.space.s1,
    minHeight: 84,
    justifyContent: "center",
  },
  hero: { marginTop: theme.space.s4, marginBottom: theme.space.s5 },
  heroSub: { marginTop: theme.space.s2 },
  heroActions: { marginTop: theme.space.s5, gap: theme.space.s3 },
});
