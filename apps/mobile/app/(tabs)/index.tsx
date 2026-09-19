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
import type { ProovraStatusTone } from "@proovra/ui";

type EvidenceItem = { id: string; type: string; status: string; createdAt: string };
type LoadState = "loading" | "ready" | "error";

function toneFor(status: string): ProovraStatusTone {
  if (status === "SIGNED" || status === "REPORTED") return "verified";
  if (status === "PROCESSING" || status === "UPLOADING") return "pending";
  return "neutral";
}

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
            {items.map((item) => (
              <ProovraListRow
                key={item.id}
                title={item.type}
                subtitle={formatUserDateTime(item.createdAt)}
                trailing={
                  <ProovraBadge
                    tone={toneFor(item.status)}
                    label={
                      item.status === "SIGNED"
                        ? t("statusSigned")
                        : item.status === "PROCESSING"
                        ? t("statusProcessing")
                        : t("statusReady")
                    }
                  />
                }
                onPress={() => router.push(`/evidence/${item.id}`)}
              />
            ))}
          </ProovraCard>
        )}
      </ProovraSection>
    </ProovraShell>
  );
}

const styles = StyleSheet.create({
  hero: { marginTop: theme.space.s4, marginBottom: theme.space.s5 },
  heroSub: { marginTop: theme.space.s2 },
  heroActions: { marginTop: theme.space.s5, gap: theme.space.s3 },
});
