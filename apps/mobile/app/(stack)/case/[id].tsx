import { ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { BottomNav, ListRow } from "../../../components/ui";
import { useLocale } from "../../../src/locale-context";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { apiFetch, getAuthToken } from "../../../src/api";
import * as FileSystem from "expo-file-system";

export default function CaseDetailScreen() {
  const { fontFamilyBold } = useLocale();
  const params = useLocalSearchParams<{ id?: string }>();
  const [name, setName] = useState("Case");
  const [evidence, setEvidence] = useState<
    Array<{ id: string; type: string; status: string; createdAt: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!params.id) return;
    Promise.all([
      apiFetch(`/v1/cases/${params.id}`),
      apiFetch(`/v1/evidence?caseId=${params.id}`)
    ])
      .then(([caseData, evidenceData]) => {
        setName(caseData.case?.name ?? "Case");
        setEvidence(evidenceData.items ?? []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load case"));
  }, [params.id]);

  const handleExport = async () => {
    if (!params.id) return;
    const token = getAuthToken();
    if (!token) {
      setError("Not authenticated.");
      return;
    }
    setDownloading(true);
    try {
      const base = process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:8080";
      const url = `${base}/v1/cases/${params.id}/export`;
      const dest = `${FileSystem.cacheDirectory}case-${params.id}.zip`;
      await FileSystem.downloadAsync(url, dest, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setError(`Export saved to ${dest}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.title, { fontFamily: fontFamilyBold }]}>{name}</Text>

        <Pressable style={styles.exportButton} onPress={handleExport} disabled={downloading}>
          <Text style={[styles.exportText, { fontFamily: fontFamilyBold }]}>
            {downloading ? "Exporting..." : "Export ZIP"}
          </Text>
        </Pressable>

        <Text style={[styles.sectionTitle, { fontFamily: fontFamilyBold }]}>Evidence</Text>

        <View style={styles.listCard}>
          {evidence.length === 0 ? (
            <Text style={styles.muted}>No evidence in this case yet.</Text>
          ) : (
            evidence.map((item) => (
              <ListRow
                key={item.id}
                title={item.type}
                subtitle={new Date(item.createdAt).toLocaleString()}
                badge={<View />}
              />
            ))
          )}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
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
  sectionTitle: {
    fontSize: typography.size.h4,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    color: "rgba(245,251,255,0.92)"
  },

  exportButton: {
    backgroundColor: "rgba(6, 13, 31, 0.62)",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.22)"
  },
  exportText: {
    color: "rgba(245,251,255,0.92)",
    textAlign: "center",
    fontWeight: "800"
  },

  listCard: {
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderRadius: 18,
    padding: spacing.md,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.16)"
  },

  muted: {
    color: "rgba(219,235,248,0.70)"
  },
  error: {
    marginTop: spacing.sm,
    color: "rgba(239, 68, 68, 0.95)"
  }
});