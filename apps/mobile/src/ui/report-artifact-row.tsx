/**
 * ONE REPORTS ROW — the native port of ReportsIndex.tsx ArtifactRowView +
 * ArtifactRowActions: the record's name and kind, the report and package
 * lifecycle (with version), integrity, the case, the org's Customer ID, when
 * it was captured and any governance block — then the two governed downloads,
 * the server's generation verb, and Open evidence.
 *
 * MINTED ON TAP, never per row: GET /v1/evidence/:id/report/latest and
 * /verification-package record a custody download, so nothing here fetches a
 * URL until the operator asks for one. The governance preflight
 * (/v1/governance/export-eligibility) runs first, as the web's
 * GovernedExportAction does, and a blocked verdict is said inline.
 */
import React, { useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { evidenceTypeLabel } from "../product/domain-display";
import { buildPackageDownloadPath } from "../product/artifact-history";
import {
  EXPORT_CHECK_FAILED,
  buildExportEligibilityPath,
  exportBlockedMessage,
  parseExportEligibility,
} from "../product/export-eligibility";
import {
  CUSTOMER_ID_HINT,
  DOWNLOAD_PACKAGE_LABEL,
  DOWNLOAD_REPORT_LABEL,
  buildReportLatestPath,
  formatRelativeTime,
  integrityTone,
  isPackageRetrievable,
  isReportRetrievable,
  lifecycleTone,
  packageActionStatus,
  packageDownloadError,
  packageNoUrlMessage,
  packageStatusText,
  parseReportUrl,
  reportActionStatus,
  reportDownloadError,
  reportIntegrityLabel,
  reportStatusText,
  type ArtifactRow,
} from "../product/reports";
import { theme } from "../theme/theme";
import { ReportRowAction } from "./report-row-action";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraText } from "./index";

type Busy = null | "report" | "package";

export function ReportArtifactRow({
  row,
  teamId,
  onOutputsRequested,
}: {
  row: ArtifactRow;
  teamId: string | null;
  onOutputsRequested?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (kind: "report" | "package") => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      if (teamId) {
        const verdict = parseExportEligibility(await apiFetch(buildExportEligibilityPath(teamId, row.evidenceId)));
        if (!verdict) {
          setError(EXPORT_CHECK_FAILED);
          return;
        }
        if (verdict.outcome !== "ALLOWED") {
          setError(exportBlockedMessage(verdict));
          return;
        }
      }
      const payload = await apiFetch(kind === "report" ? buildReportLatestPath(row.evidenceId) : buildPackageDownloadPath(row.evidenceId));
      const url = parseReportUrl(payload);
      if (url) await Linking.openURL(url);
      else setError(kind === "report" ? "Report URL is unavailable." : packageNoUrlMessage(payload));
    } catch (err) {
      const status = typeof (err as { statusCode?: unknown })?.statusCode === "number" ? (err as { statusCode: number }).statusCode : null;
      const safe = toSafeUserError(err).message;
      setError(kind === "report" ? reportDownloadError(status, safe) : packageDownloadError(status, safe));
    } finally {
      setBusy(null);
    }
  };

  const reportWaiting = reportActionStatus(row);
  const packageWaiting = packageActionStatus(row);

  return (
    <ProovraCard testID={`reports-row-${row.evidenceId}`}>
      <ProovraText variant="bodySm" weight="semibold">
        {row.displayTitle}
      </ProovraText>
      <ProovraText variant="label" color={theme.color.ink.muted}>
        {evidenceTypeLabel(row.type)}
      </ProovraText>

      <View style={styles.meta}>
        <ProovraText variant="label" weight="semibold" color={statusFg(lifecycleTone(row.reportState))}>
          {reportStatusText(row)}
        </ProovraText>
        <ProovraText variant="label" weight="semibold" color={statusFg(lifecycleTone(row.packageState))}>
          {packageStatusText(row)}
        </ProovraText>
        {row.verificationStatus ? (
          <ProovraText variant="label" weight="semibold" color={statusFg(integrityTone(row.verificationStatus))}>
            {`Integrity: ${reportIntegrityLabel(row.verificationStatus)}`}
          </ProovraText>
        ) : null}
      </View>
      <View style={styles.meta}>
        {row.caseId ? (
          <ProovraButton
            label={`Case: ${row.caseTitle ?? `#${row.caseId.slice(0, 6)}`}`}
            variant="ghost"
            fullWidth={false}
            onPress={() => router.push(`/case/${row.caseId}`)}
          />
        ) : null}
        {row.intakeCustomerId ? (
          <View accessible accessibilityLabel={`${CUSTOMER_ID_HINT}: ${row.intakeCustomerId}`}>
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {`Customer: ${row.intakeCustomerId}`}
            </ProovraText>
          </View>
        ) : null}
        {row.createdAt ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {`Captured ${formatRelativeTime(row.createdAt)}`}
          </ProovraText>
        ) : null}
        {row.packageBlockedReason ? (
          <ProovraText variant="label" weight="semibold" color={theme.color.status.pending.fg}>
            {`Export blocked by governance: ${row.packageBlockedReason}`}
          </ProovraText>
        ) : null}
      </View>

      <View style={styles.actions}>
        {isReportRetrievable(row) ? (
          <ProovraButton
            label={busy === "report" ? "Opening…" : DOWNLOAD_REPORT_LABEL}
            accessibilityLabel={`${DOWNLOAD_REPORT_LABEL}: ${row.displayTitle}`}
            variant="primary"
            fullWidth={false}
            disabled={busy !== null}
            onPress={() => void download("report")}
          />
        ) : reportWaiting ? (
          <ProovraBadge label={reportWaiting} tone="neutral" />
        ) : null}
        {isPackageRetrievable(row) ? (
          <ProovraButton
            label={busy === "package" ? "Opening…" : DOWNLOAD_PACKAGE_LABEL}
            accessibilityLabel={`${DOWNLOAD_PACKAGE_LABEL}: ${row.displayTitle}`}
            variant="secondary"
            fullWidth={false}
            disabled={busy !== null}
            onPress={() => void download("package")}
          />
        ) : packageWaiting ? (
          <ProovraBadge label={packageWaiting} tone="neutral" />
        ) : null}
      </View>
      <ReportRowAction row={row} onRequested={onOutputsRequested} />
      <ProovraButton
        label="Open evidence"
        accessibilityLabel={`Open evidence: ${row.displayTitle}`}
        variant="ghost"
        fullWidth={false}
        onPress={() => router.push(`/evidence/${row.evidenceId}`)}
      />
      {error ? (
        <View accessibilityRole="alert">
          <ProovraText variant="label" color={theme.color.status.risk.fg}>
            {error}
          </ProovraText>
        </View>
      ) : null}
    </ProovraCard>
  );
}

function statusFg(tone: ReturnType<typeof lifecycleTone>): string {
  return theme.color.status[tone].fg;
}

const styles = StyleSheet.create({
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2, marginTop: theme.space.s1 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2, marginTop: theme.space.s2 },
});
