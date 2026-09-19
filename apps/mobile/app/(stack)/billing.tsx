import { useCallback, useEffect, useState } from "react";
import { Linking, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useLocale } from "../../src/locale-context";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../src/ui";

/**
 * Billing — READ-ONLY. Shows the current plan from the same capability-gated
 * projection the web reads. No hardcoded catalog, no fake upgrade cards, no
 * in-app checkout: plan changes are managed on the web (§11E).
 */
export default function BillingScreen() {
  const { t } = useLocale();
  const router = useRouter();
  const [plan, setPlan] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<SafeError | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const { accounts } = await apiFetch("/v1/billing/accounts");
      const personal = (accounts ?? []).find((a: { type?: string }) => a.type === "PERSONAL");
      if (!personal) { setPlan("FREE"); setState("ready"); return; }
      const projection = await apiFetch(`/v1/billing/accounts/PERSONAL/${personal.id}`);
      setPlan(projection.plan?.planKey ?? "FREE");
      setState("ready");
    } catch (err) {
      setError(toSafeUserError(err));
      setState("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <ProovraScreen>
      <View style={styles.headerRow}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
      </View>
      <ProovraSection title={t("billing")}>
        {state === "loading" ? (
          <ProovraLoadingState label="Loading plan" />
        ) : state === "error" && error ? (
          <ProovraErrorState message={error.message} onRetry={load} />
        ) : (
          <>
            <ProovraCard style={styles.card}>
              <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Current plan</ProovraText>
              <View style={styles.planRow}>
                <ProovraText variant="h1" weight="bold">{plan}</ProovraText>
                <ProovraBadge tone="info" label="Active" />
              </View>
            </ProovraCard>
            <ProovraCard style={styles.card}>
              <ProovraText variant="body" color={theme.color.ink.secondary}>
                Plan changes and payment are managed on the web app.
              </ProovraText>
              <ProovraButton
                label="Manage plan on the web"
                variant="secondary"
                onPress={() => void Linking.openURL("https://www.proovra.com/billing")}
              />
            </ProovraCard>
          </>
        )}
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  card: { marginBottom: theme.space.s4, gap: theme.space.s3 },
  planRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s3, marginTop: theme.space.s2 },
});
