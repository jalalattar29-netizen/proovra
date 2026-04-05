// D:\digital-witness\apps\mobile\app\(tabs)\reports.tsx
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
    apiFetch("/v1/evidence?scope=active")
      .then((data) => {
        const reportsData =
          data.items?.map((item: { id: string; status: string; createdAt: string }) => ({
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
          <View style={styles.emptyStateCard}>
            <Text style={[styles.emptyStateText, { fontFamily: fontFamilyBold }]}>No reports yet</Text>
            <Text style={styles.emptyStateSubtext}>Capture evidence to generate signed reports.</Text>

            <Pressable style={styles.actionButton} onPress={() => router.push("/capture")}>
              <Text style={[styles.actionButtonText, { fontFamily: fontFamilyBold }]}>
                Start Capturing
              </Text>
            </Pressable>
          </View>
        ) : (
          <View>
            <Text style={[styles.sectionTitle, { fontFamily: fontFamilyBold }]}>Generated Reports</Text>

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

                <View
                  style={[
                    styles.statusPill,
                    report.status === "SIGNED"
                      ? styles.statusSigned
                      : report.status === "PROCESSING"
                      ? styles.statusProcessing
                      : styles.statusReady
                  ]}
                >
                  <Text style={[styles.statusPillText, { fontFamily: fontFamilyBold }]}>
                    {report.status}
                  </Text>
                </View>
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
    backgroundColor: "#050b18"
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl
  },

  sectionTitle: {
    fontSize: 18,
    color: "rgba(245, 251, 255, 0.92)",
    marginTop: spacing.xl,
    marginBottom: spacing.md
  },

  // Empty state: dark glass card
  emptyStateCard: {
    marginTop: spacing["2xl"],
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
    borderRadius: 18,
    backgroundColor: "rgba(11, 27, 50, 0.92)",
    borderWidth: 1,
    borderColor: "rgba(101, 235, 255, 0.22)",
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 18 },
    elevation: 3
  },
  emptyStateText: {
    fontSize: 18,
    color: "rgba(245, 251, 255, 0.92)",
    marginBottom: spacing.sm
  },
  emptyStateSubtext: {
    fontSize: 14,
    color: "rgba(219, 235, 248, 0.72)",
    marginBottom: spacing.xl,
    textAlign: "center"
  },

  actionButton: {
    backgroundColor: "rgba(6, 13, 31, 0.52)",
    borderWidth: 1,
    borderColor: "rgba(153, 204, 233, 0.40)",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 999,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 2
  },
  actionButtonText: {
    color: "rgba(245, 251, 255, 0.92)",
    fontSize: 14
  },

  // Report row: dark glass
  reportItem: {
    backgroundColor: "rgba(11, 27, 50, 0.92)",
    borderRadius: 16,
    padding: spacing.lg,
    marginBottom: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(101, 235, 255, 0.18)",
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 12 },
    elevation: 2
  },
  reportContent: {
    flex: 1,
    paddingRight: spacing.md
  },
  reportTitle: {
    fontSize: 15,
    color: "rgba(245, 251, 255, 0.92)",
    marginBottom: spacing.xs
  },
  reportDate: {
    fontSize: 12,
    color: "rgba(219, 235, 248, 0.72)"
  },

  // Status pill (neon)
  statusPill: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1
  },
  statusPillText: {
    fontSize: 11,
    color: "rgba(245, 251, 255, 0.92)"
  },
  statusSigned: {
    backgroundColor: "rgba(31,153,85,0.14)",
    borderColor: "rgba(31,153,85,0.28)"
  },
  statusProcessing: {
    backgroundColor: "rgba(47,125,170,0.14)",
    borderColor: "rgba(47,125,170,0.28)"
  },
  statusReady: {
    backgroundColor: "rgba(101, 235, 255, 0.14)",
    borderColor: "rgba(101, 235, 255, 0.34)"
  }
});