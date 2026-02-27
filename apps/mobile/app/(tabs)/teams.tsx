// D:\digital-witness\apps\mobile\app\(tabs)\teams.tsx
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
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={[styles.title, { fontFamily: fontFamilyBold }]}>{t("teams")}</Text>

        {items.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Card>
              <View style={styles.emptyIcon} />
              <Text style={[styles.emptyTitle, { fontFamily: fontFamilyBold }]}>No teams yet.</Text>
              <Text style={styles.emptySub}>Create a team to collaborate and share evidence securely.</Text>
            </Card>
          </View>
        ) : (
          items.map((item) => (
            <Card key={item.id} style={styles.teamCard}>
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
    color: "rgba(245, 251, 255, 0.92)"
  },

  teamCard: {
    borderWidth: 1,
    borderColor: "rgba(101, 235, 255, 0.18)"
  },

  emptyWrap: {
    marginTop: spacing.md
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignSelf: "center",
    marginBottom: spacing.md,
    backgroundColor: "rgba(6, 13, 31, 0.48)",
    borderWidth: 1,
    borderColor: "rgba(101, 235, 255, 0.42)",
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 14 },
    elevation: 3
  },
  emptyTitle: {
    textAlign: "center",
    color: "rgba(245, 251, 255, 0.92)",
    fontSize: 14,
    marginBottom: spacing.xs
  },
  emptySub: {
    textAlign: "center",
    color: "rgba(219, 235, 248, 0.72)",
    fontSize: 12,
    lineHeight: 18
  }
});