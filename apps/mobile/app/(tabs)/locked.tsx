import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api";

type LockedEvidenceItem = {
  id: string;
  title?: string | null;
  type?: string | null;
  status?: string | null;
  createdAt?: string | null;
  lockedAt?: string | null;
  itemCount?: number;
  displaySubtitle?: string | null;
};

type LockedEvidenceResponse = {
  scope?: string;
  items?: LockedEvidenceItem[];
};

function formatUtcDateTime(value: string | null | undefined): string {
  if (!value) return "Not available";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";

  const day = date.getUTCDate().toString().padStart(2, "0");
  const month = date.toLocaleString("en-GB", {
    month: "short",
    timeZone: "UTC",
  });
  const year = date.getUTCFullYear();
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");

  return `${day} ${month} ${year}, ${hours}:${minutes}:${seconds} UTC`;
}

function resolveTitle(item: LockedEvidenceItem): string {
  const raw = typeof item.title === "string" ? item.title.trim() : "";
  return raw || "Digital Evidence Record";
}

export default function LockedEvidenceScreen() {
  const router = useRouter();

  const [items, setItems] = useState<LockedEvidenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLockedEvidence = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError(null);

      const data = (await apiFetch(
        "/v1/evidence?scope=locked"
      )) as LockedEvidenceResponse;

      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load locked evidence";
      setError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadLockedEvidence();
  }, [loadLockedEvidence]);

  const handleRefresh = useCallback(async () => {
    await loadLockedEvidence(true);
  }, [loadLockedEvidence]);

  const handleOpenEvidence = useCallback(
    (evidenceId: string) => {
      router.push(`/(stack)/evidence/${evidenceId}` as never);
    },
    [router]
  );

  const renderHeader = () => (
    <View style={styles.header}>
      <Text style={styles.title}>Locked Evidence</Text>
      <Text style={styles.subtitle}>
        Permanently sealed evidence records are listed here after being removed
        from the active workspace.
      </Text>
    </View>
  );

  const renderEmpty = () => {
    if (loading) return null;

    return (
      <View style={styles.emptyCard}>
        <Text style={styles.emptyTitle}>No locked evidence</Text>
        <Text style={styles.emptyText}>
          You do not have any permanently locked evidence yet.
        </Text>
      </View>
    );
  };

  const renderItem = ({ item }: { item: LockedEvidenceItem }) => {
    return (
      <View style={styles.card}>
        <View style={styles.badgeRow}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Locked</Text>
          </View>
        </View>

        <Text style={styles.cardTitle}>{resolveTitle(item)}</Text>

        <Text style={styles.cardSubtitle}>
          {item.displaySubtitle ||
            `${item.itemCount ?? 1} item${(item.itemCount ?? 1) === 1 ? "" : "s"}`}
        </Text>

        <View style={styles.metaBlock}>
          <Text style={styles.metaLine}>
            <Text style={styles.metaLabel}>Locked At: </Text>
            {formatUtcDateTime(item.lockedAt)}
          </Text>

          <Text style={styles.metaLine}>
            <Text style={styles.metaLabel}>Type: </Text>
            {item.type || "Unknown"}
          </Text>

          <Text style={styles.metaLine}>
            <Text style={styles.metaLabel}>Legal State: </Text>
            Permanently sealed
          </Text>
        </View>

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.button, styles.secondaryButton]}
            onPress={() => handleOpenEvidence(item.id)}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryButtonText}>Open Record</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.screen}>
        {renderHeader()}
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" />
          <Text style={styles.loaderText}>Loading locked evidence...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorTitle}>Failed to load locked evidence</Text>
          <Text style={styles.errorText}>{error}</Text>

          <TouchableOpacity
            style={[styles.button, styles.primaryButton, { marginTop: 12 }]}
            onPress={() => void loadLockedEvidence()}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryButtonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListHeaderComponent={renderHeader}
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#020817",
  },
  listContent: {
    padding: 16,
    paddingBottom: 28,
  },
  header: {
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: "#f8fafc",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 22,
    color: "#94a3b8",
  },
  loaderWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  loaderText: {
    marginTop: 12,
    fontSize: 14,
    color: "#94a3b8",
  },
  errorBanner: {
    margin: 16,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(96,165,250,0.24)",
    backgroundColor: "rgba(30,41,59,0.22)",
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#bfdbfe",
    marginBottom: 6,
  },
  errorText: {
    fontSize: 14,
    lineHeight: 22,
    color: "#dbeafe",
  },
  emptyCard: {
    padding: 18,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.16)",
    backgroundColor: "rgba(15,23,42,0.34)",
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#f8fafc",
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 22,
    color: "#94a3b8",
  },
  card: {
    padding: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.14)",
    backgroundColor: "rgba(15,23,42,0.34)",
    marginBottom: 14,
  },
  badgeRow: {
    flexDirection: "row",
    marginBottom: 12,
  },
  badge: {
    minHeight: 30,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(96,165,250,0.22)",
    backgroundColor: "rgba(96,165,250,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#93c5fd",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#f8fafc",
  },
  cardSubtitle: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 20,
    color: "#94a3b8",
  },
  metaBlock: {
    marginTop: 14,
    gap: 6,
  },
  metaLine: {
    fontSize: 13,
    lineHeight: 20,
    color: "#cbd5e1",
  },
  metaLabel: {
    fontWeight: "700",
    color: "#e2e8f0",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
  },
  button: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  primaryButton: {
    backgroundColor: "#0f172a",
    borderWidth: 1,
    borderColor: "rgba(59,130,246,0.26)",
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#e2e8f0",
  },
  secondaryButton: {
    backgroundColor: "rgba(15,23,42,0.6)",
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.18)",
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#cbd5e1",
  },
});