/**
 * REPORT ROW ACTION (T-14 ReportsIndex) — the server's generation verb on one
 * Reports row: POST /v1/evidence/:id/reports/regenerate (one request, both
 * artifacts), the outcome read by the same reader Evidence Detail uses, and
 * the withheld state said in words when the server withdrew the verb.
 */
import React, { useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { buildRegeneratePath, readGenerationOutcome } from "../product/evidence-detail";
import { REPORT_ACTION_COMPACT_LABEL, type ArtifactRow } from "../product/reports";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraText } from "./index";

export function ReportRowAction({ row }: { row: ArtifactRow }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trigger = async () => {
    if (busy || row.action === "NONE") return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(readGenerationOutcome(await apiFetch(buildRegeneratePath(row.evidenceId), { method: "POST" })).message);
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      setError(
        status === 403
          ? "You do not have permission to generate reports in this workspace."
          : status === 404
            ? "Evidence not found."
            : toSafeUserError(err, { message: "Could not enqueue regeneration." }).message,
      );
    } finally {
      setBusy(false);
    }
  };

  if (row.action === "NONE" && row.actionWithheldReason !== "WORKSPACE_UNRESOLVED") return null;
  return (
    <View style={{ gap: 4, paddingBottom: theme.space.s2 }} testID={`report-row-action-${row.evidenceId}`}>
      {row.actionWithheldReason === "WORKSPACE_UNRESOLVED" ? <ProovraBadge label="Needs a workspace association" tone="neutral" /> : null}
      {row.action !== "NONE" ? (
        <ProovraButton
          label={busy ? "Requesting…" : REPORT_ACTION_COMPACT_LABEL[row.action]}
          accessibilityLabel={`${REPORT_ACTION_COMPACT_LABEL[row.action]}: ${row.displayTitle}`}
          variant="secondary"
          fullWidth={false}
          disabled={busy}
          onPress={() => void trigger()}
        />
      ) : null}
      {error || notice ? (
        <ProovraText variant="label" color={error ? theme.color.status.risk.fg : theme.color.ink.secondary}>{error ?? notice}</ProovraText>
      ) : null}
    </View>
  );
}
