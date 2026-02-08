import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { Badge, BottomNav, Button, Card, StatusPill } from "../../../components/ui";
import { useLocale } from "../../../src/locale-context";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../../src/api";

export default function EvidenceDetailScreen() {
  const { t, fontFamilyBold, fontFamily, isRTL } = useLocale();
  const params = useLocalSearchParams<{ id?: string }>();

  const [status, setStatus] = useState<string>("SIGNED");
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [type, setType] = useState<string>("Evidence");
  const [fileSha, setFileSha] = useState<string | null>(null);
  const [fingerprintHash, setFingerprintHash] = useState<string | null>(null);

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
  }, [params.id]);

  const statusTone = useMemo(() => {
    if (status === "SIGNED") return "signed" as const;
    if (status === "PROCESSING") return "processing" as const;
    return "ready" as const;
  }, [status]);

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
