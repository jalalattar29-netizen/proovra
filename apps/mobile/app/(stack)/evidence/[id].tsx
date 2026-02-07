import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { BottomNav, Button } from "../../../components/ui";
import { useLocale } from "../../../src/locale-context";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { apiFetch } from "../../../src/api";

export default function EvidenceDetailScreen() {
  const { t, fontFamilyBold, isRTL } = useLocale();
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
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerIcon}>‹</Text>
        <Text style={[styles.headerTitle, { fontFamily: fontFamilyBold }]}>
          Evidence #{params.id ?? "A3F9"}
        </Text>
        <Text style={styles.headerIcon}>⋮</Text>
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.statusCard}>
          <View style={styles.statusBadge}>
            <View style={styles.statusHex} />
          </View>
          <Text style={[styles.statusType, { fontFamily: fontFamilyBold }]}>{type}</Text>
          <Text style={styles.statusText}>
            {status === "SIGNED" ? t("statusSigned") : status}
          </Text>
        </View>
        <View style={styles.detailsCard}>
          <Text style={[styles.timestamp, { textAlign: isRTL ? "right" : "left" }]}>
            {createdAt ? new Date(createdAt).toISOString() : "—"}
          </Text>
          <View style={styles.hashRow}>
            <Text style={[styles.hashLabel, { textAlign: isRTL ? "right" : "left" }]}>
              SHA-256
            </Text>
            <Text style={[styles.hashValue, { fontFamily: fontFamilyBold }]}>
              {fileSha ? `${fileSha.slice(0, 24)}...` : "—"}
            </Text>
          </View>
          <View style={styles.hashRow}>
            <Text style={[styles.hashLabel, { textAlign: isRTL ? "right" : "left" }]}>
              Ed25519
            </Text>
            <Text style={[styles.hashValue, { fontFamily: fontFamilyBold }]}>
              {fingerprintHash ? `${fingerprintHash.slice(0, 24)}...` : "—"}
            </Text>
          </View>
        </View>
        <View style={styles.buttonRow}>
          <Button
            label={t("downloadReport")}
            onPress={() => {
              if (reportUrl) {
                void Linking.openURL(reportUrl);
              }
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
  container: {
    flex: 1,
    backgroundColor: colors.lightBg
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg
  },
  headerTitle: {
    fontSize: typography.size.h3,
    color: colors.textDark
  },
  headerIcon: {
    fontSize: 18,
    color: "#94A3B8"
  },
  statusCard: {
    backgroundColor: "#0B1F53",
    borderRadius: 18,
    padding: spacing.lg,
    alignItems: "center",
    marginTop: spacing.md
  },
  statusBadge: {
    width: 54,
    height: 54,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm
  },
  statusHex: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: colors.white
  },
  statusType: {
    color: colors.white,
    fontSize: typography.size.h3
  },
  statusText: {
    color: colors.white,
    opacity: 0.8
  },
  detailsCard: {
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: spacing.lg,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.border
  },
  timestamp: {
    marginTop: spacing.md,
    color: "#64748b"
  },
  hashRow: {
    marginTop: spacing.sm
  },
  hashLabel: {
    fontSize: 11,
    color: "#64748b"
  },
  hashValue: {
    fontSize: 13,
    color: colors.textDark
  },
  buttonRow: {
    marginTop: spacing.lg,
    gap: spacing.sm
  }
});
