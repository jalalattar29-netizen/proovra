/**
 * ARTIFACT HISTORY (T-14) — the touch port of the web ArtifactHistorySection:
 * the verification-package download and every retained report / package
 * version. URLs are minted on tap and opened by the platform.
 */
import React, { useState } from "react";
import { Linking, View } from "react-native";

import { apiFetch } from "../api";
import { formatUserDateTime } from "../lib/date";
import {
  buildPackageDownloadPath,
  buildPackageVersionPath,
  buildReportVersionPath,
  artifactDownloadMessage,
  formatArtifactSize,
  packageDownloadMessage,
  type ArtifactHistory,
  type ArtifactVersion,
  type MatchedPairView,
} from "../product/artifact-history";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraCard, ProovraText } from "./index";

function versionMeta(v: ArtifactVersion): string {
  return [
    // A package names the report it certifies, so package v2 is never read as
    // proof for report v7 (2026-09-29; web parity).
    v.certifiesReportVersion != null ? `Certifies report v${v.certifiesReportVersion}` : null,
    v.certifiesReportVersion != null
      ? v.sealed
        ? "Sealed"
        : "Older format; anchoring not chain-checked"
      : null,
    v.generatedAtIso ? formatUserDateTime(v.generatedAtIso) : null,
    formatArtifactSize(v.sizeBytes),
    v.latest ? "Latest" : null,
    v.immutableRecorded ? "Immutable recorded" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ArtifactHistoryPanel({
  evidenceId,
  history,
  pairs = null,
}: {
  evidenceId: string;
  history: ArtifactHistory;
  /** Matched immutable pairs from /artifacts/status; null on an older API. */
  pairs?: MatchedPairView[] | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // The API path is the FIRST argument, as in every other request helper, so
  // each call site names the route it reaches.
  const open = async (path: string, key: string, unavailable: string, failure: (err: unknown) => string) => {
    if (busy) return;
    setBusy(key);
    setMessage(null);
    try {
      const data = (await apiFetch(path)) as { url?: unknown; code?: unknown } | null;
      if (data && typeof data.url === "string" && data.url.length > 0) await Linking.openURL(data.url);
      else setMessage(typeof data?.code === "string" ? packageDownloadMessage(data.code, null) : unavailable);
    } catch (err) {
      setMessage(failure(err));
    } finally {
      setBusy(null);
    }
  };

  const errCode = (err: unknown) => {
    const e = err as { code?: unknown; statusCode?: unknown } | null;
    return { code: typeof e?.code === "string" ? e.code : null, status: typeof e?.statusCode === "number" ? e.statusCode : null };
  };

  const family = (title: string, list: ArtifactVersion[], kind: "report" | "package") => (
    <View style={{ gap: theme.space.s1 }} testID={`artifact-history-${kind}`}>
      <ProovraText variant="label" weight="semibold">{title}</ProovraText>
      {list.length === 0 ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>No versions yet.</ProovraText>
      ) : (
        list.map((v) => (
          <View key={v.version} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.space.s2 }}>
            <View style={{ flex: 1 }}>
              <ProovraText variant="bodySm" weight="semibold">{`v${v.version}`}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>{versionMeta(v)}</ProovraText>
            </View>
            <ProovraButton
              label={`Download v${v.version}`}
              accessibilityLabel={`Download ${kind === "report" ? "report" : "verification package"} v${v.version}`}
              variant="ghost"
              fullWidth={false}
              loading={busy === `${kind}-${v.version}`}
              onPress={() =>
                void (kind === "report"
                  ? open(
                      buildReportVersionPath(evidenceId, v.version),
                      `${kind}-${v.version}`,
                      `Report v${v.version} is not available.`,
                      (err) => artifactDownloadMessage("report", { code: errCode(err).code, statusCode: errCode(err).status }, v.version),
                    )
                  : open(
                      buildPackageVersionPath(evidenceId, v.version),
                      `${kind}-${v.version}`,
                      `Verification package v${v.version} is not available.`,
                      (err) => artifactDownloadMessage("verificationPackage", { code: errCode(err).code, statusCode: errCode(err).status }, v.version),
                    ))
              }
            />
          </View>
        ))
      )}
    </View>
  );

  return (
    <ProovraCard testID="artifact-history">
      <View style={{ gap: theme.space.s3 }}>
        <View>
          <ProovraText variant="h3" weight="semibold">Artifacts & Versions</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>Latest and prior generated materials</ProovraText>
        </View>
        {/*
          The latest-package button is offered only when a package exists for
          the LATEST report — "latest" is the paired package, never the newest
          package certifying an older report (2026-09-29; web parity).
        */}
        {history.packages.some((p) => p.latest) ? (
        <ProovraButton
          label="Download verification package"
          variant="secondary"
          loading={busy === "package-latest"}
          onPress={() =>
            void open(buildPackageDownloadPath(evidenceId), "package-latest", "Verification package is temporarily unavailable.", (err) => {
              const { code, status } = errCode(err);
              return packageDownloadMessage(code, status);
            })
          }
        />
        ) : null}
        {pairs ? (
          pairs.length === 0 ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>No report versions yet.</ProovraText>
          ) : (
            pairs.map((pair) => (
              <View
                key={pair.reportVersion}
                testID={`artifact-pair-${pair.reportVersion}`}
                style={{
                  gap: theme.space.s1,
                  padding: theme.space.s2,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: pair.latest ? theme.color.accent.a500 : theme.color.border.default,
                }}
              >
                <ProovraText variant="bodySm" weight="semibold">
                  {`Version ${pair.reportVersion} · ${pair.latest ? "Latest" : "Previous"} · Immutable`}
                </ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {[`Report v${pair.reportVersion}`, pair.generatedAtIso ? formatUserDateTime(pair.generatedAtIso) : null, formatArtifactSize(pair.sizeBytes)].filter(Boolean).join(" · ")}
                </ProovraText>
                <ProovraButton
                  label={`Download report v${pair.reportVersion}`}
                  variant="ghost"
                  fullWidth={false}
                  loading={busy === `report-${pair.reportVersion}`}
                  onPress={() =>
                    void open(
                      buildReportVersionPath(evidenceId, pair.reportVersion),
                      `report-${pair.reportVersion}`,
                      `Report v${pair.reportVersion} is not available.`,
                      (err) => artifactDownloadMessage("report", { code: errCode(err).code, statusCode: errCode(err).status }, pair.reportVersion),
                    )
                  }
                />
                {pair.package ? (
                  <>
                    <ProovraText variant="label" color={theme.color.ink.muted}>
                      {[`Verification package v${pair.package.version} · certifies report v${pair.reportVersion}`, pair.package.sealed ? "Sealed" : "Older format", formatArtifactSize(pair.package.sizeBytes)].filter(Boolean).join(" · ")}
                    </ProovraText>
                    <ProovraButton
                      label={`Download verification package v${pair.package.version}`}
                      variant="ghost"
                      fullWidth={false}
                      loading={busy === `package-${pair.package.version}`}
                      onPress={() =>
                        void open(
                          buildPackageVersionPath(evidenceId, pair.package!.version),
                          `package-${pair.package!.version}`,
                          `Verification package v${pair.package!.version} is not available.`,
                          (err) => artifactDownloadMessage("verificationPackage", { code: errCode(err).code, statusCode: errCode(err).status }, pair.package!.version),
                        )
                      }
                    />
                  </>
                ) : (
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    {`No verification package certifies report v${pair.reportVersion}.`}
                  </ProovraText>
                )}
                {pair.issueReason ? (
                  <ProovraText variant="label" color={theme.color.ink.secondary}>{`Reason recorded: ${pair.issueReason}`}</ProovraText>
                ) : null}
              </View>
            ))
          )
        ) : (
          <>
            {family("PDF reports", history.reports, "report")}
            {family("Verification Packages", history.packages, "package")}
          </>
        )}
        {message ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{message}</ProovraText> : null}
      </View>
    </ProovraCard>
  );
}
