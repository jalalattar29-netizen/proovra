import { Linking, ScrollView, StyleSheet, Text, View, Pressable, ActivityIndicator } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { Badge, BottomNav, Button, Card, StatusPill } from "../../../components/ui";
import { useLocale } from "../../../src/locale-context";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../../src/api";

interface AIAnalysis {
  classification?: { category: string; confidence: number };
  metadata?: { objects_detected: string[]; text_content?: string };
  description?: { title: string; summary: string };
  moderation?: { risk_level: string; is_safe: boolean };
  tags?: { tags: string[] };
}

export default function EvidenceDetailScreen() {
  const { t, fontFamilyBold, fontFamily, isRTL } = useLocale();
  const params = useLocalSearchParams<{ id?: string }>();

  const [status, setStatus] = useState<string>("SIGNED");
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [type, setType] = useState<string>("Evidence");
  const [fileSha, setFileSha] = useState<string | null>(null);
  const [fingerprintHash, setFingerprintHash] = useState<string | null>(null);
  const [aiAnalysis, setAIAnalysis] = useState<AIAnalysis | null>(null);
  const [aiLoading, setAILoading] = useState(false);
  const [aiError, setAIError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.id) return;

    apiFetch(`/v1/evidence/${params.id}`)
      .then((data) => {
        setStatus(data.evidence?.status ?? "SIGNED");
        setCreatedAt(data.evidence?.createdAt ?? null);
        setType(data.evidence?.type ?? "Evidence");
        setFileSha(data.evidence?.fileSha256 ?? null);
        setFingerprintHash(data.evidence?.fingerprintHash ?? null);
      })
      .catch(() => setStatus("SIGNED"));

    apiFetch(`/v1/evidence/${params.id}/report/latest`)
      .then((data) => setReportUrl(data.url ?? null))
      .catch(() => setReportUrl(null));

    apiFetch(`/v1/evidence/${params.id}/analysis`)
      .then((data) => {
        if (data.data) {
          setAIAnalysis(data.data);
        }
      })
      .catch(() => {
        // Analysis not yet available, will offer to run
      });
  }, [params.id]);

  const handleRunAnalysis = async () => {
    if (!params.id) return;
    setAILoading(true);
    setAIError(null);
    try {
      const result = await apiFetch(`/v1/evidence/${params.id}/analyze`, { method: "POST" });
      if (result.data) {
        setAIAnalysis(result.data);
      }
    } catch (error) {
      setAIError(error instanceof Error ? error.message : "Failed to analyze evidence");
    } finally {
      setAILoading(false);
    }
  };

  const statusTone = useMemo(() => {
    if (status === "SIGNED") return "signed" as const;
    if (status === "PROCESSING") return "processing" as const;
    return "ready" as const;
  }, [status]);

  const getRiskColor = (riskLevel?: string) => {
    if (!riskLevel) return "rgba(245,251,255,0.90)";
    if (riskLevel === "high") return "rgba(239, 68, 68, 0.95)";
    if (riskLevel === "medium") return "rgba(245, 158, 11, 0.95)";
    return "rgba(34, 197, 94, 0.95)";
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerIcon}>‹</Text>
        <Text style={[styles.headerTitle, { fontFamily: fontFamilyBold }]}>
          Evidence #{params.id ?? "A3F9"}
        </Text>
        <Text style={styles.headerIcon}>⋮</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.banner}>
          <StatusPill label={status === "SIGNED" ? "SIGNED" : status} />
          <Text style={[styles.bannerType, { fontFamily: fontFamilyBold }]}>{type}</Text>
          <Text style={[styles.bannerSub, { fontFamily, textAlign: isRTL ? "right" : "left" }]}>
            {createdAt ? `Created ${new Date(createdAt).toISOString()}` : "—"}
          </Text>
        </View>

        {/* AI Analysis Section */}
        {aiAnalysis ? (
          <Card style={[styles.darkCard, { marginTop: spacing.md }]}>
            <Text style={[styles.detailsTitle, { fontFamily: fontFamilyBold, marginBottom: spacing.md }]}>
              AI Analysis
            </Text>

            {aiAnalysis.description && (
              <View style={styles.aiSection}>
                <Text style={[styles.aiLabel, { fontFamily }]}>Summary</Text>
                <Text style={[styles.aiValue, { fontFamily }]}>
                  {aiAnalysis.description.summary}
                </Text>
              </View>
            )}

            {aiAnalysis.classification && (
              <View style={styles.aiSection}>
                <Text style={[styles.aiLabel, { fontFamily }]}>Classification</Text>
                <View style={styles.classificationPill}>
                  <Text style={[styles.classificationText, { fontFamily: fontFamilyBold }]}>
                    {aiAnalysis.classification.category}
                  </Text>
                  <Text style={[styles.confidenceText, { fontFamily }]}>
                    {Math.round(aiAnalysis.classification.confidence * 100)}% confidence
                  </Text>
                </View>
              </View>
            )}

            {aiAnalysis.metadata?.objects_detected && aiAnalysis.metadata.objects_detected.length > 0 && (
              <View style={styles.aiSection}>
                <Text style={[styles.aiLabel, { fontFamily }]}>Objects Detected</Text>
                <View style={styles.tagRow}>
                  {aiAnalysis.metadata.objects_detected.slice(0, 5).map((obj, idx) => (
                    <View key={idx} style={styles.tag}>
                      <Text style={[styles.tagText, { fontFamily }]}>{obj}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {aiAnalysis.moderation && (
              <View style={styles.aiSection}>
                <Text style={[styles.aiLabel, { fontFamily }]}>Content Safety</Text>
                <View
                  style={[
                    styles.safetyRow,
                    { backgroundColor: aiAnalysis.moderation.is_safe ? "rgba(34,197,94,0.10)" : "rgba(239,68,68,0.10)" }
                  ]}
                >
                  <View style={[styles.safetyDot, { backgroundColor: getRiskColor(aiAnalysis.moderation.risk_level) }]} />
                  <Text style={[styles.safetyText, { fontFamily, color: getRiskColor(aiAnalysis.moderation.risk_level) }]}>
                    {aiAnalysis.moderation.is_safe ? "Safe" : "Unsafe"} - {aiAnalysis.moderation.risk_level || "unknown"}
                  </Text>
                </View>
              </View>
            )}

            {aiAnalysis.tags?.tags && aiAnalysis.tags.tags.length > 0 && (
              <View style={styles.aiSection}>
                <Text style={[styles.aiLabel, { fontFamily }]}>Auto-Generated Tags</Text>
                <View style={styles.tagRow}>
                  {aiAnalysis.tags.tags.slice(0, 6).map((tag, idx) => (
                    <View key={idx} style={[styles.tag, styles.tagDark]}>
                      <Text style={[styles.tagText, { fontFamily, color: "rgba(245,251,255,0.92)" }]}>
                        #{tag}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </Card>
        ) : aiLoading ? (
          <Card style={[styles.darkCard, { marginTop: spacing.md, alignItems: "center", paddingVertical: spacing.lg }]}>
            <ActivityIndicator size="large" color="#65ebff" />
            <Text style={[styles.loadingText, { fontFamily, marginTop: spacing.md }]}>
              Analyzing evidence...
            </Text>
          </Card>
        ) : (
          <Card style={[styles.darkCard, { marginTop: spacing.md }]}>
            <View style={styles.emptyState}>
              <Text style={[styles.emptyTitle, { fontFamily: fontFamilyBold }]}>
                No AI Analysis Yet
              </Text>
              <Text style={[styles.emptySubtitle, { fontFamily }]}>
                Run AI analysis to get insights about this evidence
              </Text>
              <Pressable
                style={[styles.analyzeButton, aiError && { opacity: 0.6 }]}
                onPress={handleRunAnalysis}
                disabled={aiLoading}
              >
                <Text style={[styles.analyzeButtonText, { fontFamily: fontFamilyBold }]}>
                  🤖 Analyze Evidence
                </Text>
              </Pressable>
              {aiError && (
                <Text style={[styles.errorText, { fontFamily }]}>{aiError}</Text>
              )}
            </View>
          </Card>
        )}

        <Card style={[styles.darkCard, { marginTop: spacing.md }]}>
          <View style={styles.detailsTop}>
            <Text style={[styles.detailsTitle, { fontFamily: fontFamilyBold }]}>Details</Text>
            <Badge label={status === "SIGNED" ? t("statusSigned") : status} tone={statusTone} />
          </View>

          <View style={styles.row}>
            <Text style={[styles.k, { fontFamily, textAlign: isRTL ? "right" : "left" }]}>
              SHA-256
            </Text>
            <Text style={[styles.v, { fontFamily: fontFamilyBold }]}>
              {fileSha ? `${fileSha.slice(0, 28)}…` : "—"}
            </Text>
          </View>

          <View style={styles.row}>
            <Text style={[styles.k, { fontFamily, textAlign: isRTL ? "right" : "left" }]}>
              Ed25519
            </Text>
            <Text style={[styles.v, { fontFamily: fontFamilyBold }]}>
              {fingerprintHash ? `${fingerprintHash.slice(0, 28)}…` : "—"}
            </Text>
          </View>
        </Card>

        <View style={styles.buttonRow}>
          <Button
            label={t("downloadReport")}
            onPress={() => {
              if (reportUrl) void Linking.openURL(reportUrl);
            }}
          />
          <Button label={t("shareLink")} variant="secondary" />
        </View>
      </ScrollView>

      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#050b18" },
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg
  },
  headerTitle: { fontSize: typography.size.h3, color: "rgba(245,251,255,0.96)" },
  headerIcon: { fontSize: 18, color: "rgba(219,235,248,0.70)" },

  banner: {
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderRadius: 20,
    padding: spacing.xl,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.18)",
    shadowColor: "#000",
    shadowOpacity: 0.30,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 16 },
    elevation: 2
  },
  bannerType: { color: "rgba(245,251,255,0.96)", fontSize: typography.size.h2, marginTop: spacing.sm },
  bannerSub: { marginTop: spacing.xs, color: "rgba(219,235,248,0.78)" },

  // Dark card wrapper for Card component
  darkCard: {
    backgroundColor: "rgba(7, 20, 38, 0.88)",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.18)"
  },

  detailsTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md
  },
  detailsTitle: { fontSize: 14, color: "rgba(245,251,255,0.92)" },

  row: {
    borderTopWidth: 1,
    borderTopColor: "rgba(101,235,255,0.12)",
    paddingTop: spacing.md,
    marginTop: spacing.md
  },
  k: { fontSize: 11, color: "rgba(219,235,248,0.70)" },
  v: { marginTop: 4, fontSize: 13, color: "rgba(245,251,255,0.92)" },

  buttonRow: { marginTop: spacing.lg, gap: spacing.sm },

  // AI Analysis Styles (dark)
  aiSection: { marginBottom: spacing.lg },
  aiLabel: { fontSize: 11, color: "rgba(219,235,248,0.64)", marginBottom: spacing.xs, textTransform: "uppercase" },
  aiValue: { fontSize: 13, color: "rgba(245,251,255,0.86)", lineHeight: 20 },

  classificationPill: {
    backgroundColor: "rgba(6, 13, 31, 0.52)",
    borderRadius: 12,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.14)"
  },
  classificationText: { fontSize: 13, color: "rgba(101,235,255,0.96)" },
  confidenceText: { fontSize: 11, color: "rgba(219,235,248,0.66)" },

  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  tag: {
    backgroundColor: "rgba(6, 13, 31, 0.52)",
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.12)"
  },
  tagDark: {
    backgroundColor: "rgba(101,235,255,0.12)",
    borderColor: "rgba(101,235,255,0.22)"
  },
  tagText: { fontSize: 11, color: "rgba(245,251,255,0.90)" },

  safetyRow: {
    borderRadius: 12,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.12)"
  },
  safetyDot: { width: 8, height: 8, borderRadius: 4 },
  safetyText: { fontSize: 13 },

  emptyState: {
    alignItems: "center",
    paddingVertical: spacing.lg
  },
  emptyTitle: { fontSize: 14, color: "rgba(245,251,255,0.92)", marginBottom: spacing.xs },
  emptySubtitle: { fontSize: 12, color: "rgba(219,235,248,0.70)", marginBottom: spacing.md, maxWidth: "85%" },

  analyzeButton: {
    backgroundColor: "rgba(6, 13, 31, 0.62)",
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: "rgba(101,235,255,0.22)"
  },
  analyzeButtonText: { color: "rgba(245,251,255,0.92)", fontSize: 12 },

  errorText: { fontSize: 11, color: "rgba(239, 68, 68, 0.95)", marginTop: spacing.xs },
  loadingText: { fontSize: 12, color: "rgba(219,235,248,0.78)" }
});