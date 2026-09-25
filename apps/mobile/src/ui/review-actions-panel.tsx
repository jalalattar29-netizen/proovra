/**
 * INTERNAL REVIEW ACTIONS PANEL (T-15) — see src/product/review-actions.ts.
 * Touch adaptation: the web's `window.prompt` for a required note becomes a
 * sheet with a note field; unavailable decisions stay visible, disabled, with
 * "Not available from <stage>" as the web's title says.
 */
import React, { useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import {
  REVIEW_ACTIONS_COPY as COPY,
  REVIEW_DECISIONS,
  REVIEW_DECISION_LABEL,
  buildReviewClaimPath,
  buildReviewDecisionBody,
  buildReviewDecisionPath,
  canClaimReview,
  reviewDecisionAllowed,
  reviewNoteLabel,
  reviewStageOf,
  type ReviewDecision,
  type ReviewWorkflowRef,
} from "../product/review-actions";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraSection, ProovraText } from "./index";
import { ProovraSheet } from "./patterns";

export function ReviewActionsPanel({
  evidenceId,
  workflow,
  onChanged,
}: {
  evidenceId: string;
  workflow: ReviewWorkflowRef;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<ReviewDecision | null>(null);
  const [note, setNote] = useState("");
  const stage = reviewStageOf(workflow.status);

  const claim = async () => {
    if (!workflow.teamId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(buildReviewClaimPath(evidenceId), { method: "POST", body: JSON.stringify({ teamId: workflow.teamId }) });
      onChanged();
    } catch (err) {
      setError(toSafeUserError(err, { message: COPY.claimFailed }).message);
    } finally {
      setBusy(false);
    }
  };

  const send = async (d: ReviewDecision, n: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(buildReviewDecisionPath(evidenceId), { method: "POST", body: JSON.stringify(buildReviewDecisionBody(d, n)) });
      setNoteFor(null);
      setNote("");
      onChanged();
    } catch (err) {
      setError(toSafeUserError(err, { message: COPY.decisionFailed }).message);
    } finally {
      setBusy(false);
    }
  };

  const decide = (d: ReviewDecision) => {
    if (!workflow.teamId || !reviewDecisionAllowed(stage, d)) return;
    if (reviewNoteLabel(d)) {
      setNoteFor(d);
      setNote("");
      return;
    }
    void send(d, null);
  };

  return (
    <ProovraSection title={COPY.title}>
      <ProovraCard>
        <View style={{ gap: theme.space.s3 }} testID="review-actions">
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.muted}>{COPY.kicker}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{COPY.boundary}</ProovraText>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
            <ProovraBadge tone="governance" label={stage} />
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {workflow.assignedToUserId ? `assigned to ${workflow.assignedToUserId.slice(0, 8)}…` : COPY.unassigned}
            </ProovraText>
          </View>
          {error ? <ProovraText variant="label" color={theme.color.status.risk.fg}>{error}</ProovraText> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
            {canClaimReview(workflow.teamId, workflow.assignedToUserId, stage) ? (
              <ProovraButton label={COPY.claim} variant="secondary" fullWidth={false} disabled={busy} onPress={() => void claim()} />
            ) : null}
            {REVIEW_DECISIONS.map((d) => {
              const enabled = reviewDecisionAllowed(stage, d);
              return (
                <ProovraButton
                  key={d}
                  label={REVIEW_DECISION_LABEL[d]}
                  accessibilityLabel={enabled ? REVIEW_DECISION_LABEL[d] : `${REVIEW_DECISION_LABEL[d]}, not available from ${stage}`}
                  variant="ghost"
                  fullWidth={false}
                  disabled={busy || !enabled}
                  onPress={() => decide(d)}
                />
              );
            })}
          </View>
        </View>
      </ProovraCard>

      <ProovraSheet visible={noteFor !== null} title={noteFor ? REVIEW_DECISION_LABEL[noteFor] : ""} onClose={() => setNoteFor(null)}>
        {noteFor ? (
          <View style={{ gap: theme.space.s3 }}>
            <ProovraFormField label={`${reviewNoteLabel(noteFor)} (required, internal only)`}>
              <ProovraInput value={note} onChangeText={setNote} multiline autoCapitalize="sentences" />
            </ProovraFormField>
            <ProovraButton
              label={REVIEW_DECISION_LABEL[noteFor]}
              accessibilityLabel={`Submit: ${REVIEW_DECISION_LABEL[noteFor]}`}
              disabled={busy || !note.trim()}
              onPress={() => void send(noteFor, note.trim())}
            />
          </View>
        ) : null}
      </ProovraSheet>
    </ProovraSection>
  );
}
