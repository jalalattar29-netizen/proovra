import { ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import { colors, spacing } from "@proovra/ui";
import { BottomNav, TopBar } from "../../components/ui";
import { useLocale } from "../../src/locale-context";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { apiFetch } from "../../src/api";

export default function ReportsScreen() {
  const { t, fontFamilyBold } = useLocale();
  const router = useRouter();
  const [reports, setReports] = useState<
    Array<{ id: string; evidenceId: string; status: string; createdAt: string }>
  >([]);

  useEffect(() => {
    apiFetch("/v1/evidence")
      .then((data) => {
        // Extract evidence with reports
        const reportsData = data.items?.map((item: { id: string; status: string; createdAt: string }) => ({
          id: item.id,
          evidenceId: item.id,
          status: item.status,
          createdAt: item.createdAt
        })) ?? [];
        setReports(reportsData);
      })
      .catch(() => setReports([]));
  }, []);

  return (
    <View style={styles.container}>
      <TopBar title={t("cases")} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {reports.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyStateText, { fontFamily: fontFamilyBold }]}>
              No reports yet
            </Text>
            <Text style={styles.emptyStateSubtext}>
              Capture evidence to generate signed reports.
            </Text>
            <Pressable
              style={styles.actionButton}
              onPress={() => router.push("/capture")}
            >
              <Text style={[styles.actionButtonText, { fontFamily: fontFamilyBold }]}>
                Start Capturing
              </Text>
            </Pressable>
          </View>
        ) : (
          <View>
            <Text style={[styles.sectionTitle, { fontFamily: fontFamilyBold }]}>
              Generated Reports
            </Text>
            {reports.map((report) => (
              <Pressable
                key={report.id}
                onPress={() => router.push(`/evidence/${report.evidenceId}`)}
                style={styles.reportItem}
              >
                <View style={styles.reportContent}>
                  <Text style={[styles.reportTitle, { fontFamily: fontFamilyBold }]}>
                    Report #{report.evidenceId.slice(0, 8)}
                  </Text>
                  <Text style={styles.reportDate}>
                    {new Date(report.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <Text style={styles.reportStatus}>{report.status}</Text>
              </Pressable>
            ))}
          </View>
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
  emptyState: {
    marginTop: spacing["2xl"],
    alignItems: "center",
    paddingHorizontal: spacing.xl
  },
  emptyStateText: {
    fontSize: 18,
    color: colors.primaryNavy,
    marginBottom: spacing.md
  },
  emptyStateSubtext: {
    fontSize: 14,
    color: "#64748b",
    marginBottom: spacing.xl,
    textAlign: "center"
  },
  actionButton: {
    backgroundColor: colors.primaryNavy,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 8
  },
  actionButtonText: {
    color: colors.white,
    fontSize: 14
  },
  sectionTitle: {
    fontSize: 18,
    color: colors.primaryNavy,
    marginTop: spacing.xl,
    marginBottom: spacing.md
  },
  reportItem: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: spacing.lg,
    marginBottom: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 }
  },
  reportContent: {
    flex: 1
  },
  reportTitle: {
    fontSize: 16,
    color: colors.primaryNavy,
    marginBottom: spacing.xs
  },
  reportDate: {
    fontSize: 12,
    color: "#94A3B8"
  },
  reportStatus: {
    fontSize: 12,
    color: "#2bb673",
    fontWeight: "600"
  }
});
