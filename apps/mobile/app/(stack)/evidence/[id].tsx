import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { spacing, typography } from "@proovra/ui";
import { Badge, BottomNav, Button, Card, StatusPill } from "../../../components/ui";
import { useLocale } from "../../../src/locale-context";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../../src/api";
import type { EvidenceOutputState } from "@proovra/shared";

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

/**
 * P2-3 CLOSURE (2026-09-10) — one sentence per canonical output state.
 *
 * TOTAL over `EvidenceOutputState` (imported from @proovra/shared — mobile
 * holds no vocabulary of its own), so a state added to the product is a
 * compile error here rather than a blank card on a phone.
 *
 * `null` is the honest "we could not read the status" case, and it is
 * deliberately not folded into any real state: not knowing is not the same as
 * knowing there is nothing.
 */
function reportStateMessage(state: EvidenceOutputState | null): string {
  switch (state) {
    case null:
      return "Report status is unavailable right now. Pull to refresh, or open this record on the web app.";
    case "READY":
      // Reached only if the URL could not be minted; the button is hidden.
      return "The report is ready. Open this record on the web app to download it.";
    case "NOT_INCLUDED":
      return "A report and verification package are not included for this record. Its integrity materials and public verification are unaffected.";
    case "NOT_APPLICABLE":
      return "A report becomes available once this record is finalized.";
    case "ELIGIBLE_NOT_GENERATED":
      return "No report has been generated for this record yet. Generate one from the web app.";
    case "QUEUED":
    case "GENERATING":
      return "The report is being generated. It will be available here shortly.";
    case "RETRYABLE_FAILURE":
      return "The last attempt to generate the report did not complete. The evidence record and its integrity state are unaffected.";
    case "TERMINAL_FAILURE":
      return "Report generation stopped for this record. Open it on the web app for the reason.";
    case "BLOCKED":
      return "Report generation is blocked for this record by a governance or lifecycle decision.";
  }
}

export default function EvidenceDetailScreen() {
  const { t, fontFamilyBold, fontFamily, isRTL } = useLocale();
  const params = useLocalSearchParams<{ id?: string }>();

  const [status, setStatus] = useState<string>("SIGNED");
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  /*
   * P2-3 CLOSURE (2026-09-10) — THE SERVER'S CANONICAL OUTPUT STATE.
   *
   * This screen had only `reportUrl`, and it rendered an ALWAYS-ENABLED
   * "Download Report" whose handler was `if (reportUrl) …`. On every record
   * without a report — which is every record on Free — pressing it did nothing
   * at all, with no message. A control that silently no-ops is worse than an
   * absent one: the customer concludes the app is broken rather than that the
   * artifact does not exist.
   *
   * The state comes from the SAME projection web reads
   * (`GET /v1/evidence/:id/artifacts/status`). Mobile reimplements no plan
   * logic and holds no enum of its own — `EvidenceOutputState` is imported
   * from @proovra/shared, which this app already depends on.
   */
  const [reportState, setReportState] = useState<EvidenceOutputState | null>(
    null,
  );
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

    /*
     * P2-3 — the STATE first, then the URL only when the state says READY.
     *
     * `/report/latest` emits custody and audit events for a real download, so
     * calling it speculatively on every screen open recorded a download that
     * nobody performed. The status endpoint is explicitly side-effect free and
     * is the one this screen should have been reading.
     */
    apiFetch(`/v1/evidence/${params.id}/artifacts/status`)
      .then((data) => {
        const next = data?.outputs?.report?.state ?? null;
        setReportState(next);
        if (next !== "READY") {
          setReportUrl(null);
          return;
        }
        return apiFetch(`/v1/evidence/${params.id}/report/latest`)
          .then((report) => setReportUrl(report.url ?? null))
          .catch(() => setReportUrl(null));
      })
      .catch(() => {
        setReportState(null);
        setReportUrl(null);
      });
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
        {/*
          P2-3 CLOSURE (2026-09-10) — THE CONTROL EXISTS ONLY WHEN IT WORKS.

          The button was rendered unconditionally and enabled, with
          `onPress = () => { if (reportUrl) … }`. On any record without a report
          it did nothing and said nothing. It now appears only when the server
          says READY and a URL was minted; every other state renders the
          server-derived sentence instead, so the screen always explains itself.

          Hidden rather than disabled because the mobile `Button` primitive has
          no disabled affordance, and adding one to show a control that can
          never be pressed on this screen would be the same dead button with a
          lower opacity.
        */}
        {reportState === "READY" && reportUrl ? (
          <View style={styles.buttonRow}>
            <Button
              label={t("downloadReport")}
              onPress={() => {
                void Linking.openURL(reportUrl);
              }}
            />
          </View>
        ) : (
          <Card style={[styles.darkCard, { marginTop: spacing.md }]}>
            <Text
              style={[styles.k, { fontFamily, textAlign: isRTL ? "right" : "left" }]}
            >
              {reportStateMessage(reportState)}
            </Text>
          </Card>
        )}
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