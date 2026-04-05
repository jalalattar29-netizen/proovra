import { ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import { spacing } from "@proovra/ui";
import { BottomNav, TopBar, ListRow, Badge } from "../../components/ui";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { apiFetch } from "../../src/api";

type ArchivedItem = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  archivedAt: string | null;
  displaySubtitle: string;
};

export default function ArchiveScreen() {
  const router = useRouter();
  const [items, setItems] = useState<ArchivedItem[]>([]);

  useEffect(() => {
    apiFetch("/v1/evidence?scope=archived")
      .then((data) => setItems(data.items ?? []))
      .catch(() => setItems([]));
  }, []);

  return (
    <View style={styles.container}>
      <TopBar title="Archived Evidence" />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.listCard}>
          {items.length === 0 ? (
            <Text style={styles.emptyText}>No archived evidence.</Text>
          ) : (
            items.map((item) => (
              <Pressable key={item.id} onPress={() => router.push(`/evidence/${item.id}`)}>
                <ListRow
                  title={item.title || "Digital Evidence Record"}
                  subtitle={item.displaySubtitle}
                  badge={<Badge tone="ready" label="Archived" />}
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
    backgroundColor: "#050b18",
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
  },
  listCard: {
    marginTop: spacing.lg,
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderRadius: 20,
    padding: spacing.lg,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.18)",
  },
  emptyText: {
    color: "rgba(219,235,248,0.74)",
  },
});