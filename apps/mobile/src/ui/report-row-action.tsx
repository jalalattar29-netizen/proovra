/**
 * REPORT ROW ACTION (T-14 ReportsIndex) — the server's verbs on one Reports
 * row, PER OUTPUT: POST /v1/evidence/:id/reports/regenerate with the intent
 * the output offers (a missing package is "Recover package" and only the
 * package is rebuilt, from the stored report), the outcome read by the same
 * reader Evidence Detail uses, the reason said when the server offers none,
 * and the optional new version behind its own menu and confirmation.
 */
import React, { useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import {
  buildOutputRequestBody,
  buildRegeneratePath,
  outputActionLabel,
  outputUnavailableReasonShort,
  readGenerationOutcome,
} from "../product/evidence-detail";
import type { ArtifactRow, ReportOutputAction } from "../product/reports";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraText } from "./index";
import { NewVersionAction } from "./new-version-action";

export function ReportRowAction({ row, onRequested }: { row: ArtifactRow; onRequested?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trigger = async (intent: ReportOutputAction) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(
        readGenerationOutcome(
          await apiFetch(buildRegeneratePath(row.evidenceId), { method: "POST", body: buildOutputRequestBody(intent) }),
        ).message,
      );
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      setError(
        status === 403
          ? "You do not have permission to generate reports in this workspace."
          : status === 404
            ? "Evidence not found."
            : toSafeUserError(err, { message: "Could not request generation." }).message,
      );
    } finally {
      setBusy(false);
      // Re-read the list and the counters either way; nothing is marked
      // complete here, and a declined request means this row was stale.
      onRequested?.();
    }
  };

  const withheld = outputUnavailableReasonShort(row.actionWithheldReason as never);
  const offersNewVersion = row.newVersion?.action === "CREATE_NEW_VERSION";
  if (row.outputActions.length === 0 && !withheld && !offersNewVersion) return null;
  return (
    <View style={{ gap: 4, paddingBottom: theme.space.s2 }} testID={`report-row-action-${row.evidenceId}`}>
      {withheld ? <ProovraBadge label={withheld} tone="neutral" /> : null}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {row.outputActions.map(({ output, action }) => {
          const label = outputActionLabel(output, action, "compact");
          return (
            <ProovraButton
              key={output}
              label={busy ? "Requesting…" : label}
              accessibilityLabel={`${label}: ${row.displayTitle}`}
              variant="secondary"
              fullWidth={false}
              disabled={busy}
              onPress={() => void trigger(action)}
            />
          );
        })}
        {/* Optional and secondary: behind its own menu, read fresh on open. */}
        <NewVersionAction
          evidenceId={row.evidenceId}
          displayTitle={row.displayTitle}
          offer={row.newVersion}
          readCurrentOffer
          onRequested={onRequested}
        />
      </View>
      {error || notice ? (
        <ProovraText variant="label" color={error ? theme.color.status.risk.fg : theme.color.ink.secondary}>{error ?? notice}</ProovraText>
      ) : null}
    </View>
  );
}
