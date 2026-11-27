/**
 * INTERNAL REVIEW ACTIONS PANEL (T-15) — see src/product/review-actions.ts.
 * Touch adaptation: the web's `window.prompt` for a required note becomes a
 * sheet with a note field; unavailable decisions stay visible, disabled, with
 * "Not available from <stage>" as the web's title says.
 */
import React, { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { reauthRequiredSentence } from "@proovra/shared";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { STEP_UP_CANCEL, isReauthRequired } from "../product/challenge-step-up";
import { ChallengeStepUpSheet, useChallengeStepUp } from "./challenge-step-up";
import { theme } from "../theme/theme";
import {
  REVIEW_ACTIONS_COPY as COPY,
  REVIEW_DECISIONS,
  REVIEW_DECISION_LABEL,
  buildReviewClaimPath,
  buildReviewDecisionBody,
  buildReviewDecisionPath,
  canClaimReview,
  isPlacementRefusal,
  reviewDecisionResultMessage,
  reviewDecisionAllowed,
  reviewDecisionBlockedReason,
  reviewNoteLabel,
  reviewStageOf,
  type ReviewDecision,
  type ReviewWorkflowRef,
} from "../product/review-actions";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraSection, ProovraText } from "./index";
import { ProovraSheet } from "./patterns";

/** T-027 — closing the confirmation records nothing; the note is kept. */
const COPY_STEP_UP_CLOSED = "Nothing was recorded. Confirm it's you when you're ready, then try again — your note is kept.";

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
  // T-098 — the claim was refused because the person is not yet in a
  // Collaboration Team; said in words, with the way there.
  const [notPlaced, setNotPlaced] = useState(false);
  const router = useRouter();
  const [noteFor, setNoteFor] = useState<ReviewDecision | null>(null);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const stage = reviewStageOf(workflow.status);
  /**
   * T-165 (stage B) — the Evidence-page decision door is step-up gated (the
   * workspace checkbox, session risk) and age gated. Without the shared
   * challenge a STEP_UP_REQUIRED here could not be satisfied on the phone; a
   * reauth_required read as a generic failure. The note sheet keeps its text
   * through either.
   */
  const stepUp = useChallengeStepUp(workflow.teamId ?? null);

  const claim = async () => {
    if (!workflow.teamId) return;
    setBusy(true);
    setError(null);
    setNotPlaced(false);
    try {
      await apiFetch(buildReviewClaimPath(evidenceId), { method: "POST", body: JSON.stringify({ teamId: workflow.teamId }) });
      onChanged();
    } catch (err) {
      if (isPlacementRefusal(err)) setNotPlaced(true);
      else setError(toSafeUserError(err, { message: COPY.claimFailed }).message);
    } finally {
      setBusy(false);
    }
  };

  const send = async (d: ReviewDecision, n: string | null) => {
    setBusy(true);
    setError(null);
    setNotPlaced(false);
    try {
      const resp = (await stepUp.run((headers) =>
        apiFetch(buildReviewDecisionPath(evidenceId), {
          method: "POST",
          ...(headers ? { headers } : {}),
          body: JSON.stringify(buildReviewDecisionBody(d, n)),
        }),
      )) as unknown;
      setNoteFor(null);
      setNote("");
      // T-165 — what the decision actually did, in the copy every surface shares
      // (a first-of-two decision is never shown as an approval).
      // Null-safe: a request for information answers `decision: null`.
      setResult(reviewDecisionResultMessage(d, resp));
      onChanged();
    } catch (err) {
      const e = err as { code?: string; details?: Record<string, unknown> };
      if (e?.code === STEP_UP_CANCEL) {
        setError(COPY_STEP_UP_CLOSED);
      } else if (isReauthRequired(err)) {
        // A fresher sign-in, not an ended session; nothing ran, the note stays.
        setError(reauthRequiredSentence(e.details as { reason?: unknown; windowHours?: unknown } | undefined));
      } else {
        setError(toSafeUserError(err, { message: COPY.decisionFailed }).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const decide = (d: ReviewDecision) => {
    if (!workflow.teamId || !reviewDecisionAllowed(stage, d, workflow)) return;
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
              {workflow.assignedToUserId ? `assigned to ${workflow.assigneeLabel ?? "a workspace member"}` : COPY.unassigned}
            </ProovraText>
          </View>
          {error ? <ProovraText variant="label" color={theme.color.status.risk.fg}>{error}</ProovraText> : null}
          {result ? <ProovraText variant="label" color={theme.color.ink.secondary} testID="review-actions-result">{result}</ProovraText> : null}
          {notPlaced ? (
            <View style={{ gap: theme.space.s1 }} testID="review-claim-not-placed">
              <ProovraText variant="label" weight="semibold">{COPY.claimNotPlacedTitle}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{COPY.claimNotPlaced}</ProovraText>
              <ProovraButton label={COPY.claimNotPlacedAction} variant="secondary" fullWidth={false} onPress={() => router.push("/teams" as never)} />
            </View>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
            {canClaimReview(workflow.teamId, workflow.assignedToUserId, stage) ? (
              <ProovraButton label={COPY.claim} variant="secondary" fullWidth={false} disabled={busy} onPress={() => void claim()} />
            ) : null}
            {REVIEW_DECISIONS.filter((d) => !(workflow.notIncluded ?? []).includes(d)).map((d) => {
              const enabled = reviewDecisionAllowed(stage, d, workflow);
              const blocked = reviewDecisionBlockedReason(d, workflow);
              return (
                <ProovraButton
                  key={d}
                  label={REVIEW_DECISION_LABEL[d]}
                  accessibilityLabel={
                    enabled
                      ? REVIEW_DECISION_LABEL[d]
                      : blocked
                        ? `${REVIEW_DECISION_LABEL[d]}, ${blocked}`
                        : `${REVIEW_DECISION_LABEL[d]}, not available from ${stage}`
                  }
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
            {error ? (
              <ProovraText variant="label" color={theme.color.status.risk.fg} testID="review-actions-sheet-error">
                {error}
              </ProovraText>
            ) : null}
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
      <ChallengeStepUpSheet stepUp={stepUp} />
    </ProovraSection>
  );
}
