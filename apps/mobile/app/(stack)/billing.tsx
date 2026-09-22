import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useLocale } from "../../src/locale-context";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import {
  buildPricingPath,
  formatMonthlyPrice,
  isCurrentPlan,
  parsePricingCatalogue,
  planSummaryLine,
  type PricingCatalogue,
} from "../../src/product/pricing";
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
  const [catalogue, setCatalogue] = useState<PricingCatalogue | null>(null);
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

  // The plan catalogue loads separately and never blocks the current plan:
  // what you are on is the question this screen exists to answer, and a
  // catalogue read that fails must not hide it.
  useEffect(() => {
    void apiFetch(buildPricingPath())
      .then((d) => setCatalogue(parsePricingCatalogue(d)))
      .catch(() => setCatalogue(null));
  }, []);

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
            {/*
              WHAT EACH PLAN INCLUDES, from GET /v1/billing/pricing — the same
              canonical source the public Pricing page reads. That endpoint's
              own comment says the catalogue is published "so the public
              Pricing page AND in-app Billing UI both source Enterprise
              capability copy from the same place", so this is the surface it
              was published for. Nothing here recomputes a price, a storage
              allowance or a seat count.
            */}
            {catalogue && catalogue.plans.length > 0 ? (
              <ProovraSection title="What each plan includes">
                {catalogue.plans.map((offer) => (
                  <ProovraCard key={offer.key} style={styles.card}>
                    <View style={styles.planRow}>
                      <ProovraText variant="body" weight="semibold">
                        {offer.displayName}
                      </ProovraText>
                      {isCurrentPlan(offer, plan) ? (
                        <ProovraBadge tone="verified" label="Your plan" />
                      ) : null}
                    </View>
                    <ProovraText variant="body">
                      {formatMonthlyPrice(offer.monthlyPriceCents, catalogue.currency)}
                    </ProovraText>
                    {planSummaryLine(offer) ? (
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {planSummaryLine(offer)}
                      </ProovraText>
                    ) : null}
                    {offer.capabilities.map((c, i) => (
                      <ProovraText key={i} variant="label" color={theme.color.ink.secondary}>
                        {`• ${c}`}
                      </ProovraText>
                    ))}
                  </ProovraCard>
                ))}
              </ProovraSection>
            ) : null}

            <ProovraCard style={styles.card}>
              {/*
                No purchase, upgrade or checkout control, and the reason is
                stated rather than left as a missing button: mobile app-store
                payment rules govern digital-goods purchases inside an app.
                The catalogue above answers what each plan includes, which is
                the question this screen has to answer anyway.
              */}
              <ProovraText variant="body" color={theme.color.ink.secondary}>
                Plan changes and payment are handled in the PROOVRA web app.
              </ProovraText>
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
