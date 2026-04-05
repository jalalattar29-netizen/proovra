import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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

type DeletedEvidenceItem = {
  id: string;
  title?: string | null;
  type?: string | null;
  status?: string | null;
  createdAt?: string | null;
  deletedAt?: string | null;
  deleteScheduledForUtc?: string | null;
  itemCount?: number;
  displaySubtitle?: string | null;
};

type DeletedEvidenceResponse = {
  scope?: string;
  items?: DeletedEvidenceItem[];
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

function resolveTitle(item: DeletedEvidenceItem): string {
  const raw = typeof item.title === "string" ? item.title.trim() : "";
  return raw || "Digital Evidence Record";
}

export default function DeletedEvidenceScreen() {
  const router = useRouter();

  const [items, setItems] = useState<DeletedEvidenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDeletedEvidence = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError(null);

      const data = (await apiFetch(
        "/v1/evidence?scope=deleted"
      )) as DeletedEvidenceResponse;

      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load deleted evidence";
      setError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadDeletedEvidence();
  }, [loadDeletedEvidence]);

  const handleRefresh = useCallback(async () => {
    await loadDeletedEvidence(true);
  }, [loadDeletedEvidence]);

  const handleOpenEvidence = useCallback(
    (evidenceId: string) => {
      router.push(`/(stack)/evidence/${evidenceId}` as never);
    },
    [router]
  );

  const handleRestore = useCallback((item: DeletedEvidenceItem) => {
    if (!item.id) return;

    Alert.alert(
      "Restore Evidence",
      "Do you want to restore this evidence from secure trash?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restore",
          onPress: async () => {
            try {
              setRestoringId(item.id);

              await apiFetch(`/v1/evidence/${item.id}/restore`, {
                method: "POST",
                body: JSON.stringify({ restore: true }),
              });

              setItems((current) => current.filter((x) => x.id !== item.id));

              Alert.alert(
                "Restored",
                "The evidence has been restored successfully."
              );
            } catch (err) {
              const message =
                err instanceof Error
                  ? err.message
                  : "Failed to restore evidence";
              Alert.alert("Restore failed", message);
            } finally {
              setRestoringId(null);
            }
          },
        },
      ]
    );
  }, []);

  const renderHeader = () => (
    <View style={styles.header}>
      <Text style={styles.title}>Deleted Evidence</Text>
      <Text style={styles.subtitle}>
        Records in secure trash remain recoverable until their scheduled
        permanent deletion date.
      </Text>
    </View>
  );

  const renderEmpty = () => {
    if (loading) return null;

    return (
      <View style={styles.emptyCard}>
        <Text style={styles.emptyTitle}>No deleted evidence</Text>
        <Text style={styles.emptyText}>
          Your secure trash is currently empty.
        </Text>
      </View>
    );
  };

  const renderItem = ({ item }: { item: DeletedEvidenceItem }) => {
    const busy = restoringId === item.id;

    return (
      <View style={styles.card}>
        <View style={styles.badgeRow}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>In Trash</Text>
          </View>
        </View>

        <Text style={styles.cardTitle}>{resolveTitle(item)}</Text>

        <Text style={styles.cardSubtitle}>
          {item.displaySubtitle ||
            `${item.itemCount ?? 1} item${(item.itemCount ?? 1) === 1 ? "" : "s"}`}
        </Text>

        <View style={styles.metaBlock}>
          <Text style={styles.metaLine}>
            <Text style={styles.metaLabel}>Deleted At: </Text>
            {formatUtcDateTime(item.deletedAt)}
          </Text>

          <Text style={styles.metaLine}>
            <Text style={styles.metaLabel}>Permanent Deletion Date: </Text>
            {formatUtcDateTime(item.deleteScheduledForUtc)}
          </Text>

          <Text style={styles.metaLine}>
            <Text style={styles.metaLabel}>Type: </Text>
            {item.type || "Unknown"}
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

          <TouchableOpacity
            style={[styles.button, styles.primaryButton, busy && styles.disabled]}
            onPress={() => handleRestore(item)}
            disabled={busy}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryButtonText}>
              {busy ? "Restoring..." : "Restore"}
            </Text>
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
          <Text style={styles.loaderText}>Loading deleted evidence...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorTitle}>Failed to load deleted evidence</Text>
          <Text style={styles.errorText}>{error}</Text>

          <TouchableOpacity
            style={[styles.button, styles.primaryButton, { marginTop: 12 }]}
            onPress={() => void loadDeletedEvidence()}
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
    borderColor: "rgba(248,113,113,0.24)",
    backgroundColor: "rgba(127,29,29,0.18)",
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#fecaca",
    marginBottom: 6,
  },
  errorText: {
    fontSize: 14,
    lineHeight: 22,
    color: "#fee2e2",
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
    borderColor: "rgba(248,113,113,0.22)",
    backgroundColor: "rgba(248,113,113,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#fca5a5",
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
  disabled: {
    opacity: 0.6,
  },
});