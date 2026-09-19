import { Platform, View, StyleSheet } from "react-native";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { useLocale } from "../../src/locale-context";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { theme } from "../../src/theme/theme";
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
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<SafeError | null>(null);

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

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProovraShell>
      <ProovraCard style={styles.searchBar} onPress={() => router.push("/search")} accessibilityLabel="Search evidence and cases">
        <ProovraText variant="body" color={theme.color.ink.muted}>
          Search evidence, cases…
        </ProovraText>
      </ProovraCard>

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
  hero: { marginTop: theme.space.s3, marginBottom: theme.space.s5 },
  heroSub: { marginTop: theme.space.s2 },
  heroActions: { marginTop: theme.space.s5, gap: theme.space.s3 },
});
