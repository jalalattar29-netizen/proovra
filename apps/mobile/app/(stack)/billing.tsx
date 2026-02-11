import { ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import { colors, spacing } from "@proovra/ui";
import { TopBar } from "../../components/ui";
import { useLocale } from "../../src/locale-context";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { apiFetch } from "../../src/api";

export default function BillingScreen() {
  const { t, fontFamilyBold } = useLocale();
  const router = useRouter();
  const [plan, setPlan] = useState("FREE");

  useEffect(() => {
    apiFetch("/v1/billing/status")
      .then((data) => setPlan(data.entitlement?.plan ?? "FREE"))
      .catch(() => setPlan("FREE"));
  }, []);

  const plans = [
    { name: "FREE", price: "$0", description: "3 evidence limit" },
    { name: "PAY-PER-EVIDENCE", price: "$5/evidence", description: "Pay as you go" },
    { name: "PRO", price: "$19/month", description: "Unlimited captures" },
    { name: "TEAM", price: "$79/month", description: "5 team members" }
  ];

  return (
    <View style={styles.container}>
      <TopBar title={t("billing")} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.currentPlanCard}>
          <Text style={[styles.label, { fontFamily: fontFamilyBold }]}>Current Plan</Text>
          <Text style={[styles.planName, { fontFamily: fontFamilyBold }]}>{plan}</Text>
          <Text style={styles.planDescription}>Active subscription</Text>
        </View>

        <Text style={[styles.sectionTitle, { fontFamily: fontFamilyBold }]}>
          Available Plans
        </Text>

        {plans.map((planItem) => (
          <Pressable
            key={planItem.name}
            style={[
              styles.planCard,
              plan === planItem.name && styles.planCardActive
            ]}
          >
            <View>
              <Text style={[styles.planCardName, { fontFamily: fontFamilyBold }]}>
                {planItem.name}
              </Text>
              <Text style={styles.planCardPrice}>{planItem.price}</Text>
              <Text style={styles.planCardDescription}>{planItem.description}</Text>
            </View>
            <Text style={styles.planCardButton}>
              {plan === planItem.name ? "Current" : "Upgrade"}
            </Text>
          </Pressable>
        ))}

        <View style={styles.paymentNotice}>
          <Text style={[styles.paymentNoticeTitle, { fontFamily: fontFamilyBold }]}>
            📋 Payment Coming Soon
          </Text>
          <Text style={styles.paymentNoticeText}>
            Payment integration is under development. In-app billing will be available soon.
          </Text>
          <Text style={styles.paymentNoticeText}>
            For billing inquiries, contact: support@proovra.com
          </Text>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <Text style={[styles.backButtonText, { fontFamily: fontFamilyBold }]}>
            Back
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.lightBg
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl
  },
  currentPlanCard: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 }
  },
  label: {
    fontSize: 12,
    color: "#94A3B8",
    marginBottom: spacing.xs
  },
  planName: {
    fontSize: 24,
    color: colors.primaryNavy,
    marginBottom: spacing.xs
  },
  planDescription: {
    fontSize: 14,
    color: "#64748b"
  },
  sectionTitle: {
    fontSize: 16,
    color: colors.primaryNavy,
    marginTop: spacing.lg,
    marginBottom: spacing.md
  },
  planCard: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: spacing.lg,
    marginBottom: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e2e8f0"
  },
  planCardActive: {
    borderColor: colors.primaryNavy,
    borderWidth: 2,
    backgroundColor: "#f0f7ff"
  },
  planCardName: {
    fontSize: 14,
    color: colors.primaryNavy,
    marginBottom: spacing.xs
  },
  planCardPrice: {
    fontSize: 16,
    color: colors.primaryNavy,
    fontWeight: "600",
    marginBottom: spacing.xs
  },
  planCardDescription: {
    fontSize: 12,
    color: "#94A3B8"
  },
  planCardButton: {
    fontSize: 12,
    color: colors.primaryNavy,
    fontWeight: "600"
  },
  paymentNotice: {
    backgroundColor: "#fff3cd",
    borderRadius: 12,
    padding: spacing.lg,
    marginTop: spacing.xl,
    borderLeftWidth: 4,
    borderLeftColor: "#ffc107"
  },
  paymentNoticeTitle: {
    fontSize: 14,
    color: "#333",
    marginBottom: spacing.sm
  },
  paymentNoticeText: {
    fontSize: 13,
    color: "#555",
    marginBottom: spacing.sm,
    lineHeight: 20
  },
  footer: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0"
  },
  backButton: {
    backgroundColor: colors.primaryNavy,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: "center"
  },
  backButtonText: {
    color: colors.white,
    fontSize: 14
  }
});
