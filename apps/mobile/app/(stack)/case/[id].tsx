import { ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { BottomNav, Button, ListRow } from "../../../components/ui";
import { useLocale } from "../../../src/locale-context";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { apiFetch, getAuthToken } from "../../../src/api";
import * as FileSystem from "expo-file-system/legacy";

export default function CaseDetailScreen() {
  const { t, fontFamilyBold } = useLocale();
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
          <Text style={styles.exportText}>{downloading ? "Exporting..." : "Export ZIP"}</Text>
        </Pressable>
        <Text style={[styles.sectionTitle, { fontFamily: fontFamilyBold }]}>Evidence</Text>
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
        {error ? <Text style={styles.error}>{error}</Text> : null}
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
  },
  sectionTitle: {
    fontSize: typography.size.h4,
    marginTop: spacing.lg,
    marginBottom: spacing.sm
  },
  exportButton: {
    backgroundColor: colors.primaryNavy,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12
  },
  exportText: {
    color: colors.white,
    textAlign: "center",
    fontWeight: "600"
  },
  muted: {
    color: "#64748b"
  },
  error: {
    marginTop: spacing.sm,
    color: "#ef4444"
  }
});
