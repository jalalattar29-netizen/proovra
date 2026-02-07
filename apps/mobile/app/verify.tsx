import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, spacing, typography } from "@proovra/ui";
import { BottomNav, Button, TimelineBlock } from "../components/ui";
import { useLocale } from "../src/locale-context";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { apiFetch } from "../src/api";

export default function VerifyScreen() {
  const { t, fontFamilyBold, isRTL } = useLocale();
  const params = useLocalSearchParams<{ id?: string }>();
  const [timeline, setTimeline] = useState<string[]>([
    "12:05 Created",
    "12:10 Uploaded",
    "12:12 Signed",
    "12:15 Report Generated"
  ]);
  const [reportUrl, setReportUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!params.id) return;
    apiFetch(`/public/verify/${params.id}`)
      .then((data) => {
        setTimeline(
          (data.custodyEvents ?? []).map(
            (ev: { eventType: string; atUtc: string }) =>
              `${ev.eventType} ${new Date(ev.atUtc).toLocaleTimeString()}`
          )
        );
        setReportUrl(data.publicUrl ?? null);
      })
      .catch(() => {});
  }, [params.id]);
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerIcon}>‹</Text>
        <Text style={[styles.headerTitle, { fontFamily: fontFamilyBold }]}>{t("verifyTitle")}</Text>
        <Text style={styles.headerIcon}>⋮</Text>
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text
          style={[styles.valid, { fontFamily: fontFamilyBold, textAlign: isRTL ? "right" : "left" }]}
        >
          {t("verifyTitle")}
        </Text>
        <Text
          style={[styles.type, { fontFamily: fontFamilyBold, textAlign: isRTL ? "right" : "left" }]}
        >
          Video
        </Text>
        <Text style={[styles.timestamp, { textAlign: isRTL ? "right" : "left" }]}>
          2026-02-04 14:22 UTC
        </Text>
        <View style={styles.hashRow}>
        <Text style={[styles.hashLabel, { textAlign: isRTL ? "right" : "left" }]}>
          SHA-256
        </Text>
          <Text style={[styles.hashValue, { fontFamily: fontFamilyBold }]}>
            261577e3fb77c3eb2467...
          </Text>
        </View>
        <View style={styles.hashRow}>
        <Text style={[styles.hashLabel, { textAlign: isRTL ? "right" : "left" }]}>
          Ed25519
        </Text>
          <Text style={[styles.hashValue, { fontFamily: fontFamilyBold }]}>
            t+knXQVoWnnqqcPZJi46...
          </Text>
        </View>
        <Text
          style={[
            styles.timelineTitle,
            { fontFamily: fontFamilyBold, textAlign: isRTL ? "right" : "left" }
          ]}
        >
          {t("timeline")}
        </Text>
        <TimelineBlock items={timeline} />
        <View style={{ marginTop: spacing.lg }}>
          <Button
            label={t("downloadReport")}
            onPress={() => {
              if (reportUrl) {
                void Linking.openURL(reportUrl);
              }
            }}
          />
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
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl
  },
  valid: {
    color: colors.greenValid,
    fontSize: typography.size.h2,
    marginTop: spacing.lg
  },
  type: {
    fontSize: typography.size.h3,
    marginTop: spacing.xs
  },
  timestamp: {
    marginTop: spacing.xs,
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
    fontSize: 13
  },
  timelineTitle: {
    marginTop: spacing.lg,
    fontSize: typography.size.h3
  }
});
