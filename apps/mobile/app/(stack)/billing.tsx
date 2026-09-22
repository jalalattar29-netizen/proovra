import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useLocale } from "../../src/locale-context";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import { BillingSections } from "../../src/ui/billing-sections";
import {
  BILLING_ACCOUNTS_PATH,
  buildBillingAccountPath,
} from "../../src/product/billing";
import {
  buildPricingPath,
  formatMonthlyPrice,
  isCurrentPlan,
  parsePricingCatalogue,
  planSummaryLine,
  formatAddonSize,
  parseEvidenceCreditOffer,
  parseStorageAddons,
  type EvidenceCreditOffer,
  type PricingCatalogue,
  type StorageAddonOffer,
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
  const [accountId, setAccountId] = useState<string | null>(null);
  const [addons, setAddons] = useState<StorageAddonOffer[]>([]);
  const [credit, setCredit] = useState<EvidenceCreditOffer | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<SafeError | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const { accounts } = await apiFetch(BILLING_ACCOUNTS_PATH);
      const personal = (accounts ?? []).find((a: { type?: string }) => a.type === "PERSONAL");
      if (!personal) { setPlan("FREE"); setAccountId(null); setState("ready"); return; }
      setAccountId(typeof personal.id === "string" ? personal.id : null);
      const projection = await apiFetch(buildBillingAccountPath("PERSONAL", personal.id));
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
      .then((d) => {
        setCatalogue(parsePricingCatalogue(d));
        setAddons(parseStorageAddons(d));
        setCredit(parseEvidenceCreditOffer(d));
      })
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

            {/*
              What the customer is paying for, every payment they have made,
              and the ability to stop paying.

              This used to be one line saying plan changes happen on the web,
              justified by "app-store rules". That was not evidence, and it
              removed reads and cancellations that no store has a position on.
              The transaction matrix in src/product/billing.ts classifies every
              billing action; exactly three — the subscription, storage and
              credit CHECKOUTS — are a distribution-policy question, and they
              are named there rather than here.
            */}
            {/* What can be bought, and what it costs. Display, not purchase. */}
            {catalogue && addons.length > 0 ? (
              <ProovraSection title="Storage add-ons">
                <ProovraCard style={styles.card}>
                  {addons.map((a) => (
                    <View key={a.key} style={styles.planRow}>
                      <ProovraText variant="bodySm">
                        {formatAddonSize(a.storageBytes) ?? a.label}
                      </ProovraText>
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {formatMonthlyPrice(a.priceCents, catalogue.currency).replace(" / month", "")}
                      </ProovraText>
                    </View>
                  ))}
                </ProovraCard>
              </ProovraSection>
            ) : null}

            {credit ? (
              <ProovraSection title="Pay per record">
                <ProovraCard style={styles.card}>
                  <ProovraText variant="body" weight="semibold">
                    {credit.displayName}
                  </ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {[
                      credit.unitPriceCents !== null
                        ? formatMonthlyPrice(credit.unitPriceCents, catalogue?.currency ?? null)
                            .replace(" / month", " per credit")
                        : null,
                      credit.creditsRequiredPerCompletion !== null
                        ? `${credit.creditsRequiredPerCompletion} credit(s) per completed record`
                        : null,
                      // Reported, not assumed: "credits do not expire" is a
                      // commercial promise, and stating it without reading it
                      // would be making that promise on the product's behalf.
                      credit.creditsExpire === false ? "Credits do not expire" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </ProovraText>
                </ProovraCard>
              </ProovraSection>
            ) : null}

            <BillingSections
              accountType="PERSONAL"
              accountId={accountId}
              onChanged={() => void load()}
            />
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
