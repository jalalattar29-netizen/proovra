import { ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { Badge, BottomNav, ListRow, TopBar } from "../../components/ui";
import { useLocale } from "../../src/locale-context";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { apiFetch } from "../../src/api";

export default function HomeScreen() {
  const { t, fontFamilyBold, isRTL } = useLocale();
  const router = useRouter();
  const [items, setItems] = useState<
    Array<{ id: string; type: string; status: string; createdAt: string }>
  >([]);

  useEffect(() => {
    apiFetch("/v1/evidence")
      .then((data) => setItems(data.items ?? []))
      .catch(() => setItems([]));
  }, []);
  return (
    <View style={styles.container}>
      <TopBar title={t("brand")} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.heroCard}>
          <Text style={[styles.heroTitle, { fontFamily: fontFamilyBold }]}>Capture truth.</Text>
          <Text style={styles.heroSubtitle}>Prove it forever.</Text>
          <Pressable style={styles.heroButton} onPress={() => router.push("/capture")}>
            <Text style={[styles.heroButtonText, { fontFamily: fontFamilyBold }]}>
              + Capture Evidence
            </Text>
          </Pressable>
        </View>
        <Text
          style={[
            styles.sectionTitle,
            { fontFamily: fontFamilyBold, textAlign: isRTL ? "right" : "left" }
          ]}
        >
          {t("recentEvidence")}
        </Text>
        <View style={styles.listCard}>
          {items.length === 0 ? (
            <Pressable onPress={() => router.push("/evidence/1")}>
              <ListRow
                title={t("photo")}
                subtitle="3 minutes ago"
                badge={<Badge tone="signed" label={t("statusSigned")} />}
              />
            </Pressable>
          ) : (
            items.map((item) => (
              <Pressable key={item.id} onPress={() => router.push(`/evidence/${item.id}`)}>
                <ListRow
                  title={item.type}
                  subtitle={new Date(item.createdAt).toLocaleString()}
                  badge={
                    item.status === "SIGNED" ? (
                      <Badge tone="signed" label={t("statusSigned")} />
                    ) : item.status === "PROCESSING" ? (
                      <Badge tone="processing" label={t("statusProcessing")} />
                    ) : (
                      <Badge tone="ready" label={t("statusReady")} />
                    )
                  }
                />
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>
      <BottomNav />
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
    paddingBottom: spacing.xl
  },
  heroCard: {
    backgroundColor: colors.primaryNavy,
    borderRadius: 18,
    padding: spacing.lg,
    marginTop: spacing.md
  },
  heroTitle: {
    fontSize: typography.size.h2,
    color: colors.white
  },
  heroSubtitle: {
    marginTop: spacing.xs,
    color: "rgba(255,255,255,0.75)"
  },
  heroButton: {
    marginTop: spacing.md,
    alignSelf: "flex-start",
    backgroundColor: colors.white,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12
  },
  heroButtonText: {
    color: colors.primaryNavy,
    fontSize: 12
  },
  sectionTitle: {
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    fontSize: typography.size.h3,
    color: colors.textDark
  },
  listCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: spacing.md,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border
  }
});
