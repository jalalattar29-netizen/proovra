import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { spacing, typography } from "@proovra/ui";
import { Badge, BottomNav, Button, Card, StatusPill } from "../../../components/ui";
import { useLocale } from "../../../src/locale-context";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../../src/api";

/**
 * Phase 12 Point 4 (Pass E) — the on-screen "AI Analysis" section was
 * removed. It called `GET /v1/evidence/:id/analysis` and
 * `POST /v1/evidence/:id/analyze`, neither of which is registered on the
 * API. The GET's rejection was swallowed with a "not yet available"
 * comment, so a removed endpoint rendered as an empty state inviting the
 * operator to press "Analyze Evidence" — a visible product action that
 * could only ever fail. The canonical intelligence projection is
 * `GET /v1/intelligence/evidence/:id` (workspace-scoped, advisory,
 * entities/extracted-text shaped); it is a different contract than this
 * screen rendered, so no mobile surface is claimed here. Re-adding a
 * mobile intelligence surface is product work, not dead-code cleanup.
 */

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

        {/* Phase 12 Point 4 (Pass E) — the "Share Link" button next to
            Download Report was removed. It had NO `onPress` at all (the
            mobile Button's handler is optional), so it rendered a fully
            styled, pressable control that did nothing. Mobile has no
            share/public-verification surface to wire it to: there is no
            verification-link fetch anywhere in apps/mobile, and the
            evidence detail response this screen reads carries no share
            URL. Building one is product work, not dead-code cleanup. */}
        <View style={styles.buttonRow}>
          <Button
            label={t("downloadReport")}
            onPress={() => {
              if (reportUrl) void Linking.openURL(reportUrl);
            }}
          />
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

  buttonRow: { marginTop: spacing.lg, gap: spacing.sm }
});