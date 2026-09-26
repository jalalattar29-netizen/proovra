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
import { REGENERATE_CONSEQUENCE, buildRegeneratePath, readGenerationOutcome } from "../product/evidence-detail";
import { REPORT_ACTION_COMPACT_LABEL, type ArtifactRow } from "../product/reports";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraText } from "./index";

export function ReportRowAction({ row, onRequested }: { row: ArtifactRow; onRequested?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * REGENERATE asks first, as it does on Evidence Detail and on the web row: it
   * creates a new immutable version and uses workspace storage. A first
   * generation and a retry produce what the record is already owed.
   */
  const [confirming, setConfirming] = useState(false);

  const trigger = async () => {
    if (busy || row.action === "NONE") return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(readGenerationOutcome(await apiFetch(buildRegeneratePath(row.evidenceId), { method: "POST" })).message);
      // Re-read the list and the counters from the server; nothing is marked
      // complete here.
      onRequested?.();
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
      {row.action !== "NONE" && !confirming ? (
        <ProovraButton
          label={busy ? "Requesting…" : REPORT_ACTION_COMPACT_LABEL[row.action]}
          accessibilityLabel={`${REPORT_ACTION_COMPACT_LABEL[row.action]}: ${row.displayTitle}`}
          variant={row.action === "REGENERATE" ? "ghost" : "secondary"}
          fullWidth={false}
          disabled={busy}
          onPress={() => (row.action === "REGENERATE" ? setConfirming(true) : void trigger())}
        />
      ) : null}
      {row.action === "REGENERATE" && confirming ? (
        <View style={{ gap: 6 }} testID={`report-row-regenerate-confirm-${row.evidenceId}`}>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{REGENERATE_CONSEQUENCE}</ProovraText>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <ProovraButton
              label={busy ? "Requesting…" : "Create a new version"}
              accessibilityLabel={`Create a new version: ${row.displayTitle}`}
              variant="secondary"
              fullWidth={false}
              disabled={busy}
              onPress={() => void trigger()}
            />
            <ProovraButton label="Cancel" variant="ghost" fullWidth={false} onPress={() => setConfirming(false)} />
          </View>
        </View>
      ) : null}
      {error || notice ? (
        <ProovraText variant="label" color={error ? theme.color.status.risk.fg : theme.color.ink.secondary}>{error ?? notice}</ProovraText>
      ) : null}
    </View>
  );
}
