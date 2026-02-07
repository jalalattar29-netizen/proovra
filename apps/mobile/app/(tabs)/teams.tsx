import { ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { BottomNav, Card, ListRow, TopBar } from "../../components/ui";
import { useLocale } from "../../src/locale-context";
import { useEffect, useState } from "react";
import { apiFetch } from "../../src/api";

export default function TeamsScreen() {
  const { fontFamilyBold, t } = useLocale();
  const [items, setItems] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    apiFetch("/v1/teams")
      .then((data) => setItems(data.teams ?? []))
      .catch(() => setItems([]));
  }, []);
  return (
    <View style={styles.container}>
      <TopBar title={t("teams")} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.title, { fontFamily: fontFamilyBold }]}>{t("teams")}</Text>
        {items.length === 0 ? (
          <Card>No teams yet.</Card>
        ) : (
          items.map((item) => (
            <Card key={item.id}>
              <ListRow title={item.name} subtitle="Members" badge={<View />} />
            </Card>
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
