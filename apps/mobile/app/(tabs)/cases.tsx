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
          <Card>No cases yet.</Card>
        ) : (
          items.map((item) => (
            <Pressable key={item.id} onPress={() => router.push(`/case/${item.id}`)}>
              <Card>
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
    backgroundColor: colors.lightBg
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl
  },
  title: {
    fontSize: typography.size.h3,
    marginTop: spacing.md,
    marginBottom: spacing.md
  }
});
