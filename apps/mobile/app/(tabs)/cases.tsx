import { ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { BottomNav, Card, ListRow, TopBar } from "../../components/ui";
import { useLocale } from "../../src/locale-context";
import { apiFetch } from "../../src/api";
import { useEffect, useState } from "react";
import { useRouter } from "expo-router";

export default function CasesScreen() {
  const { fontFamilyBold, t } = useLocale();
  const router = useRouter();
  const [items, setItems] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    apiFetch("/v1/cases")
      .then((data) => setItems(data.items ?? []))
      .catch(() => setItems([]));
  }, []);
  return (
    <View style={styles.container}>
      <TopBar title={t("cases")} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.title, { fontFamily: fontFamilyBold }]}>{t("cases")}</Text>

        {items.length === 0 ? (
          <Card style={styles.darkCard}>
            <Text style={styles.emptyText}>No cases yet.</Text>
          </Card>
        ) : (
          items.map((item) => (
            <Pressable key={item.id} onPress={() => router.push(`/case/${item.id}`)}>
              <Card style={styles.darkCard}>
                <ListRow title={item.name} subtitle="View details" badge={<View />} />
              </Card>
            </Pressable>
          ))
        )}
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
    color: "rgba(245,251,255,0.96)"
  },

  // override Card look locally (حتى لو Card بالـui.tsx لسا أبيض)
  darkCard: {
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)"
  },
  emptyText: {
    color: "rgba(219,235,248,0.72)"
  }
});