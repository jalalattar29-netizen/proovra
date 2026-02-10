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

    // Load AI analysis if available
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
    if (!riskLevel) return colors.textDark;
    if (riskLevel === "high") return "#ef4444";
    if (riskLevel === "medium") return "#f97316";
    return "#22c55e";
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
          <Card style={{ marginTop: spacing.md }}>
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
                <View style={[styles.safetyRow, { backgroundColor: aiAnalysis.moderation.is_safe ? "#f0fdf4" : "#fef2f2" }]}>
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
                    <View key={idx} style={[styles.tag, { backgroundColor: colors.primaryNavy }]}>
                      <Text style={[styles.tagText, { fontFamily, color: colors.white }]}>
                        #{tag}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </Card>
        ) : aiLoading ? (
          <Card style={{ marginTop: spacing.md, alignItems: "center", paddingVertical: spacing.lg }}>
            <ActivityIndicator size="large" color={colors.primaryNavy} />
            <Text style={[styles.loadingText, { fontFamily, marginTop: spacing.md }]}>
              Analyzing evidence...
            </Text>
          </Card>
        ) : (
          <Card style={{ marginTop: spacing.md }}>
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

        <Card style={{ marginTop: spacing.md }}>
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
  container: { flex: 1, backgroundColor: colors.lightBg },
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg
  },
  headerTitle: { fontSize: typography.size.h3, color: colors.textDark },
  headerIcon: { fontSize: 18, color: "#94A3B8" },

  banner: {
    backgroundColor: colors.primaryNavy,
    borderRadius: 20,
    padding: spacing.xl,
    marginTop: spacing.md,
    shadowColor: "#000",
    shadowOpacity: 0.10,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 16 },
    elevation: 2
  },
  bannerType: { color: colors.white, fontSize: typography.size.h2, marginTop: spacing.sm },
  bannerSub: { marginTop: spacing.xs, color: "rgba(255,255,255,0.75)" },

  // AI Analysis Styles
  aiSection: { marginBottom: spacing.lg },
  aiLabel: { fontSize: 11, color: "#64748b", marginBottom: spacing.xs, textTransform: "uppercase" },
  aiValue: { fontSize: 13, color: colors.textDark, lineHeight: 20 },
  
  classificationPill: {
    backgroundColor: "#f0f4f8",
    borderRadius: 12,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  classificationText: { fontSize: 13, color: colors.primaryNavy },
  confidenceText: { fontSize: 11, color: "#64748b" },

  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  tag: {
    backgroundColor: "#f0f4f8",
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm
  },
  tagText: { fontSize: 11, color: colors.primaryNavy },

  safetyRow: {
    borderRadius: 12,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  safetyDot: { width: 8, height: 8, borderRadius: 4 },
  safetyText: { fontSize: 13 },

  emptyState: {
    alignItems: "center",
    paddingVertical: spacing.lg
  },
  emptyTitle: { fontSize: 14, color: colors.textDark, marginBottom: spacing.xs },
  emptySubtitle: { fontSize: 12, color: "#64748b", marginBottom: spacing.md, maxWidth: "85%" },
  
  analyzeButton: {
    backgroundColor: colors.primaryNavy,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md
  },
  analyzeButtonText: { color: colors.white, fontSize: 12 },
  
  errorText: { fontSize: 11, color: "#ef4444", marginTop: spacing.xs },
  loadingText: { fontSize: 12, color: colors.textDark },

  detailsTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md
  },
  detailsTitle: { fontSize: 14, color: colors.textDark },

  row: {
    borderTopWidth: 1,
    borderTopColor: "rgba(15,23,42,0.06)",
    paddingTop: spacing.md,
    marginTop: spacing.md
  },
  k: { fontSize: 11, color: "#64748b" },
  v: { marginTop: 4, fontSize: 13, color: colors.textDark },

  buttonRow: { marginTop: spacing.lg, gap: spacing.sm }
});
