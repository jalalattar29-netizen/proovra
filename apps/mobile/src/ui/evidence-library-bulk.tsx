/**
 * EVIDENCE LIBRARY BULK ACTIONS — the web's BulkActionsToolbar
 * (apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx).
 *
 * Choose an action (and a target case for Add to Case), Run Bulk Action, then
 * ONE sheet carries the whole run: confirm → committing → result. The
 * selection is narrowed only by an accepted TERMINAL result — empty after a
 * total success, the failed ids after a partial one, untouched when the
 * request was refused or merely queued.
 */
import React, { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { EVIDENCE_BULK_MAX_IDS, evidenceBulkActionRequiresCase, type EvidenceBulkActionName } from "@proovra/shared";

import { theme } from "../theme/theme";
import { toSafeUserError } from "../errors/safe-error";
import { ProovraButton, ProovraCard, ProovraText } from "./index";
import { ProovraFilterChips } from "./patterns";
import {
  BULK_ACTION_LABELS,
  BULK_ACTION_VERBS,
  bulkActionsForScope,
  countBulkProtected,
  groupBulkFailures,
  isBulkQueued,
  isBulkValidationFailure,
  isLifecycleBulkAction,
  type EvidenceBulkResponse,
} from "../product/evidence-library";

export function EvidenceLibraryBulkToolbar({
  scope,
  selectedCount,
  selectedItems,
  cases,
  onClear,
  onRun,
  onSelectionResolved,
}: {
  scope: string;
  selectedCount: number;
  /** The selected rows that are loaded — the lifecycle projection lives on them. */
  selectedItems: ReadonlyArray<{ id: string; lifecycle?: unknown }>;
  cases: ReadonlyArray<{ id: string; name: string }>;
  onClear: () => void;
  onRun: (action: EvidenceBulkActionName, caseId?: string) => Promise<EvidenceBulkResponse>;
  onSelectionResolved: (remainingIds: string[]) => void;
}) {
  const actions = bulkActionsForScope(scope);
  const [chosen, setChosen] = useState<EvidenceBulkActionName>("ARCHIVE");
  // The toolbar defaults to Archive, as the web does; a scope without it
  // (Trash) starts on its first action.
  const action: EvidenceBulkActionName = actions.some((a) => a.action === chosen) ? chosen : actions[0].action;
  const [caseId, setCaseId] = useState("");
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<EvidenceBulkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needsCase = evidenceBulkActionRequiresCase(action);
  const label = BULK_ACTION_LABELS[action];
  const verb = BULK_ACTION_VERBS[action];
  const overLimit = selectedCount > EVIDENCE_BULK_MAX_IDS;
  const destructive = action === "TRASH";

  const protectedCount = useMemo(() => countBulkProtected(selectedItems, action), [selectedItems, action]);
  const lifecycle = isLifecycleBulkAction(action);
  const eligibleCount = lifecycle ? Math.max(0, selectedCount - protectedCount) : selectedCount;
  const allProtected = lifecycle && protectedCount > 0 && eligibleCount === 0;

  const failureGroups = useMemo(() => groupBulkFailures(result?.results), [result]);
  const queued = result !== null && isBulkQueued(result);

  const close = () => {
    if (running) return;
    setOpen(false);
    setResult(null);
    setError(null);
  };

  const run = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const next = await onRun(action, caseId || undefined);
      const failedIds = (next.results ?? []).filter((r) => !r.ok).map((r) => r.evidenceId);
      if (isBulkQueued(next)) {
        setResult(next);
        return;
      }
      if (failedIds.length === 0) {
        setOpen(false);
        setResult(null);
        onSelectionResolved([]);
        return;
      }
      setResult(next);
      onSelectionResolved(failedIds);
    } catch (err) {
      setError(
        isBulkValidationFailure(err)
          ? `The ${label || "bulk action"} request was invalid and was not applied. Please retry, or refresh the selected records.`
          : toSafeUserError(err).message || `${label} could not be completed. No records were changed.`,
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <ProovraCard style={styles.bar}>
      <ProovraText variant="body" weight="bold">
        {`${selectedCount} selected`}
      </ProovraText>
      <ProovraFilterChips
        label="Bulk action"
        value={action}
        options={actions.map((a) => ({ value: a.action, label: a.label }))}
        onChange={(next) => setChosen(next)}
      />
      {needsCase ? (
        cases.length === 0 ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            No cases available. Create a case before adding evidence to one.
          </ProovraText>
        ) : (
          <ProovraFilterChips
            label="Target case"
            value={caseId}
            options={cases.map((c) => ({ value: c.id, label: c.name }))}
            onChange={setCaseId}
          />
        )
      ) : null}
      <View style={styles.row}>
        <ProovraButton
          label="Run Bulk Action"
          variant={destructive ? "danger" : "primary"}
          fullWidth={false}
          disabled={selectedCount === 0 || (needsCase && !caseId) || allProtected || overLimit}
          onPress={() => {
            if (selectedCount === 0 || overLimit) return;
            setResult(null);
            setError(null);
            setOpen(true);
          }}
        />
        <ProovraButton label="Clear Selection" variant="secondary" fullWidth={false} onPress={onClear} />
      </View>

      {overLimit ? (
        <View style={[styles.helper, styles.warn]} testID="bulk-limit-helper">
          <ProovraText variant="bodySm" weight="semibold">
            {`${selectedCount} records selected — a bulk action can carry at most ${EVIDENCE_BULK_MAX_IDS}`}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`Narrow the selection to ${EVIDENCE_BULK_MAX_IDS} records or fewer and run the action again. Nothing has been submitted.`}
          </ProovraText>
        </View>
      ) : null}
      {action === "TRASH" && protectedCount > 0 ? (
        <View style={[styles.helper, styles.warn]} testID="bulk-trash-helper">
          <ProovraText variant="bodySm" weight="semibold">
            {`${protectedCount} of ${selectedCount} selected records cannot be moved to trash`}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {allProtected
              ? "All selected records are protected by retention or legal hold. Use Archive instead to remove them from Active evidence without deleting protected records."
              : `${eligibleCount} eligible record${eligibleCount === 1 ? "" : "s"} will be moved to trash; ${protectedCount} protected record${protectedCount === 1 ? "" : "s"} will be skipped.`}
          </ProovraText>
        </View>
      ) : null}

      <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
        <Pressable style={styles.scrim} onPress={running ? undefined : close} accessibilityLabel="Dismiss" />
        <View style={styles.sheet} testID="bulk-sheet">
          <ScrollView contentContainerStyle={styles.sheetBody}>
            <ProovraText variant="h3" weight="semibold" accessibilityRole="header">
              {result ? "Bulk Action Results" : "Confirm Bulk Action"}
            </ProovraText>
            {result ? (
              queued ? (
                <>
                  <ProovraText variant="bodySm" weight="bold">
                    {`${result.pendingCount ?? selectedCount} records accepted and queued`}
                  </ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    The workspace is processing them. This list updates when the run reports a terminal outcome.
                  </ProovraText>
                </>
              ) : (
                <>
                  <ProovraText variant="bodySm" weight="bold">
                    {`${result.successCount ?? 0} record${result.successCount === 1 ? "" : "s"} ${verb.past}`}
                  </ProovraText>
                  {(result.failedCount ?? 0) > 0 ? (
                    <>
                      <ProovraText variant="bodySm" weight="bold" color={theme.color.status.risk.fg}>
                        {`${result.failedCount} record${result.failedCount === 1 ? "" : "s"} could not be ${verb.gerund}`}
                      </ProovraText>
                      {failureGroups.map((g) => (
                        <View key={g.key} style={styles.reason} testID={`bulk-reason-${g.key}`}>
                          <ProovraText variant="label">{g.label}</ProovraText>
                          <ProovraText variant="label" color={theme.color.ink.muted}>
                            {`${g.count} record${g.count === 1 ? "" : "s"}`}
                          </ProovraText>
                        </View>
                      ))}
                      <ProovraText variant="label" color={theme.color.ink.secondary}>
                        {`The records that could not be ${verb.gerund} are still selected.`}
                      </ProovraText>
                    </>
                  ) : null}
                </>
              )
            ) : (
              <>
                <ProovraText variant="bodySm">{`${label} will run for ${selectedCount} currently selected records.`}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  Bulk selection applies only to the records you selected in the currently loaded pages.
                </ProovraText>
                {error ? (
                  <View style={[styles.helper, styles.danger]} accessibilityRole="alert" testID="bulk-error">
                    <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>
                      {error}
                    </ProovraText>
                  </View>
                ) : null}
              </>
            )}
            <View style={styles.row}>
              {result ? (
                <ProovraButton label="Close" variant="secondary" fullWidth={false} onPress={close} />
              ) : (
                <>
                  <ProovraButton label="Cancel" variant="secondary" fullWidth={false} disabled={running} onPress={close} />
                  <ProovraButton
                    label={running ? verb.pending : label}
                    accessibilityLabel={`Confirm ${label}`}
                    variant={destructive ? "danger" : "primary"}
                    fullWidth={false}
                    loading={running}
                    onPress={() => void run()}
                  />
                </>
              )}
            </View>
          </ScrollView>
        </View>
      </Modal>
    </ProovraCard>
  );
}

const styles = StyleSheet.create({
  bar: { gap: theme.space.s2, marginBottom: theme.space.s3 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  helper: { gap: 2, padding: theme.space.s3, borderRadius: theme.radius.md, borderWidth: 1 },
  warn: { backgroundColor: theme.color.status.pending.bg, borderColor: theme.color.status.pending.border },
  danger: { backgroundColor: theme.color.status.risk.bg, borderColor: theme.color.status.risk.border },
  reason: { flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.34)" },
  sheet: {
    maxHeight: "80%",
    backgroundColor: theme.color.surface.app,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
  },
  sheetBody: { padding: theme.space.s4, gap: theme.space.s3 },
});
