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
  formatArtifactSize,
  packageDownloadMessage,
  type ArtifactHistory,
  type ArtifactVersion,
} from "../product/artifact-history";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraCard, ProovraText } from "./index";

function versionMeta(v: ArtifactVersion): string {
  return [
    v.generatedAtIso ? formatUserDateTime(v.generatedAtIso) : null,
    formatArtifactSize(v.sizeBytes),
    v.latest ? "Latest" : null,
    v.immutableRecorded ? "Immutable recorded" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ArtifactHistoryPanel({ evidenceId, history }: { evidenceId: string; history: ArtifactHistory }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const open = async (key: string, path: string, unavailable: string, failure: (err: unknown) => string) => {
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
                void open(
                  `${kind}-${v.version}`,
                  kind === "report" ? buildReportVersionPath(evidenceId, v.version) : buildPackageVersionPath(evidenceId, v.version),
                  kind === "report" ? `Report v${v.version} is not available.` : `Verification package v${v.version} is not available.`,
                  () => (kind === "report" ? `Could not download report v${v.version}.` : `Could not download verification package v${v.version}.`),
                )
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
        <ProovraButton
          label="Download verification package"
          variant="secondary"
          loading={busy === "package-latest"}
          onPress={() =>
            void open("package-latest", buildPackageDownloadPath(evidenceId), "Verification package is temporarily unavailable.", (err) => {
              const { code, status } = errCode(err);
              return packageDownloadMessage(code, status);
            })
          }
        />
        {family("PDF reports", history.reports, "report")}
        {family("Verification Packages", history.packages, "package")}
        {message ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{message}</ProovraText> : null}
      </View>
    </ProovraCard>
  );
}
