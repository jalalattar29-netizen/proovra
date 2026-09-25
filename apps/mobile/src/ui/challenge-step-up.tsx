/**
 * Challenge step-up — hook + sheet. The decisions and copy live in
 * `src/product/challenge-step-up.ts`; this file holds the state machine the
 * web's `useStepUpAction` runs (StepUpModal.tsx:110-398), adapted to a bottom
 * sheet.
 *
 * Usage:
 *   const stepUp = useChallengeStepUp(teamId);
 *   const result = await stepUp.run((headers) => apiFetch(path, { method: "POST", headers, body }));
 *   …
 *   <ChallengeStepUpSheet stepUp={stepUp} />
 *
 * `run` resolves with the action's result — immediately when no step-up is
 * needed, or after the code is verified and the action retried with the
 * challenge header. It rejects with code STEP_UP_CANCEL when the person
 * cancels, so the caller can say "nothing was changed".
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import {
  CHALLENGE_COPY,
  STEP_UP_CANCEL,
  STEP_UP_CHALLENGE_HEADER,
  STEP_UP_CHECK_PATH,
  STEP_UP_START_PATH,
  buildStartBody,
  challengeDetailsFrom,
  isChallengeStepUpRequired,
  isEnrollmentRequired,
  parseStartedChallenge,
  purposeLabel,
  type ChallengeDetails,
  type ChallengeMethod,
} from "../product/challenge-step-up";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraFormField, ProovraInput, ProovraSheet, ProovraText } from "./index";

export type ChallengeAction<T> = (headers?: Record<string, string>) => Promise<T>;

export type ChallengeState =
  | { kind: "idle" }
  | { kind: "starting"; details: ChallengeDetails }
  | {
      kind: "verifying";
      details: ChallengeDetails;
      challengeId: string;
      method: ChallengeMethod;
      destinationMask: string | null;
      notice: string | null;
    }
  | { kind: "enrollment_required"; details: ChallengeDetails }
  | { kind: "failed"; details: ChallengeDetails; reason: string; canRestart: boolean }
  | { kind: "retrying"; details: ChallengeDetails };

function cancelError(): Error {
  const e = new Error("Step-up cancelled by operator") as Error & { code?: string };
  e.code = STEP_UP_CANCEL;
  return e;
}

export function useChallengeStepUp(teamId: string | null) {
  const [state, setState] = useState<ChallengeState>({ kind: "idle" });
  const pending = useRef<{
    action: ChallengeAction<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  } | null>(null);

  const run = useCallback(async <T,>(action: ChallengeAction<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      if (!isChallengeStepUpRequired(err)) throw err;
      return new Promise<T>((resolve, reject) => {
        pending.current = { action: action as ChallengeAction<unknown>, resolve: resolve as (v: unknown) => void, reject };
        setState({ kind: "starting", details: challengeDetailsFrom(err) });
      });
    }
  }, []);

  const settle = useCallback((next: ChallengeState) => {
    pending.current = null;
    setState(next);
  }, []);

  const cancel = useCallback(() => {
    const p = pending.current;
    settle({ kind: "idle" });
    p?.reject(cancelError());
  }, [settle]);

  const startChallenge = useCallback(
    async (details: ChallengeDetails, preferred?: ChallengeMethod, previous?: Extract<ChallengeState, { kind: "verifying" }>) => {
      if (!teamId) {
        setState({ kind: "failed", details, reason: CHALLENGE_COPY.noWorkspace, canRestart: false });
        return;
      }
      try {
        const started = parseStartedChallenge(
          await apiFetch(STEP_UP_START_PATH, { method: "POST", body: JSON.stringify(buildStartBody(teamId, details, preferred)) }),
        );
        if (!started) throw new Error(CHALLENGE_COPY.startFailed);
        setState({ kind: "verifying", details, notice: null, ...started });
      } catch (err) {
        const enrollment = isEnrollmentRequired(err);
        if (previous) {
          setState({
            ...previous,
            notice: enrollment
              ? preferred === "TOTP"
                ? CHALLENGE_COPY.noTotp
                : CHALLENGE_COPY.noPhone
              : toSafeUserError(err).message || CHALLENGE_COPY.switchFailed,
          });
          return;
        }
        if (enrollment) {
          setState({ kind: "enrollment_required", details });
          return;
        }
        setState({ kind: "failed", details, reason: toSafeUserError(err).message || CHALLENGE_COPY.startFailed, canRestart: false });
      }
    },
    [teamId],
  );

  // The web starts the challenge as soon as the modal opens; a separate
  // "send code" tap would be one more step between the person and the action.
  // Keyed on the state OBJECT, so a re-run of the effect (StrictMode runs
  // effects twice in development) cannot start — and send — a second code.
  const startedFor = useRef<ChallengeState | null>(null);
  useEffect(() => {
    if (state.kind !== "starting" || startedFor.current === state) return;
    startedFor.current = state;
    void startChallenge(state.details);
  }, [state, startChallenge]);

  const switchMethod = useCallback(() => {
    if (state.kind !== "verifying") return;
    void startChallenge(state.details, state.method === "TOTP" ? "SMS" : "TOTP", state);
  }, [state, startChallenge]);

  const restart = useCallback(() => {
    if (state.kind !== "failed" || !state.canRestart) return;
    setState({ kind: "starting", details: state.details });
  }, [state]);

  const verifyAndRetry = useCallback(
    async (code: string) => {
      if (state.kind !== "verifying") return;
      const { details } = state;
      const rejected: ChallengeState = {
        kind: "failed",
        details,
        reason: state.method === "TOTP" ? CHALLENGE_COPY.rejectedTotp : CHALLENGE_COPY.rejectedPhone,
        canRestart: true,
      };
      let status: unknown;
      try {
        const res = (await apiFetch(STEP_UP_CHECK_PATH, {
          method: "POST",
          body: JSON.stringify({ teamId, challengeId: state.challengeId, code }),
        })) as { status?: unknown };
        status = res?.status;
      } catch (err) {
        if ((err as { statusCode?: number })?.statusCode === 400) {
          setState(rejected);
          return;
        }
        setState({ kind: "failed", details, reason: toSafeUserError(err).message || CHALLENGE_COPY.checkFailed, canRestart: true });
        return;
      }
      if (status !== "approved") {
        setState(rejected);
        return;
      }
      const p = pending.current;
      if (!p) {
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "retrying", details });
      try {
        const value = await p.action({ [STEP_UP_CHALLENGE_HEADER]: state.challengeId });
        settle({ kind: "idle" });
        p.resolve(value);
      } catch (err) {
        settle({ kind: "failed", details, reason: toSafeUserError(err).message || CHALLENGE_COPY.actionFailed, canRestart: false });
        p.reject(err);
      }
    },
    [state, teamId, settle],
  );

  const close = useCallback(() => {
    // Closing a terminal state is not a cancel of anything still pending.
    if (pending.current) cancel();
    else setState({ kind: "idle" });
  }, [cancel]);

  return { state, run, cancel, close, restart, switchMethod, verifyAndRetry };
}

export type ChallengeStepUp = ReturnType<typeof useChallengeStepUp>;

export function ChallengeStepUpSheet({ stepUp }: { stepUp: ChallengeStepUp }) {
  const { state } = stepUp;
  const [code, setCode] = useState("");
  useEffect(() => {
    if (state.kind !== "verifying") setCode("");
  }, [state.kind]);

  if (state.kind === "idle") return null;
  const title = purposeLabel(state.details.purpose);

  return (
    <ProovraSheet visible title={title} onClose={stepUp.close}>
      <View style={{ gap: theme.space.s3 }} testID="challenge-step-up">
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {CHALLENGE_COPY.intro}
        </ProovraText>

        {state.kind === "starting" ? <ProovraText variant="bodySm">{CHALLENGE_COPY.preparing}</ProovraText> : null}

        {state.kind === "enrollment_required" ? (
          <>
            <ProovraText variant="bodySm">{CHALLENGE_COPY.enrollment}</ProovraText>
            <ProovraButton label="Close" variant="secondary" onPress={stepUp.close} />
          </>
        ) : null}

        {state.kind === "verifying" ? (
          <>
            <ProovraFormField
              label={state.method === "TOTP" ? CHALLENGE_COPY.codeLabelTotp : CHALLENGE_COPY.codeLabelPhone(state.destinationMask)}
            >
              <ProovraInput
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                accessibilityLabel="Verification code"
                onSubmitEditing={() => code.trim() && void stepUp.verifyAndRetry(code.trim())}
              />
            </ProovraFormField>
            {state.notice ? (
              <ProovraText variant="label" color={theme.color.status.pending.fg}>
                {state.notice}
              </ProovraText>
            ) : null}
            <ProovraButton
              label="Confirm + retry"
              disabled={code.trim().length === 0}
              onPress={() => void stepUp.verifyAndRetry(code.trim())}
            />
            <ProovraButton
              label={state.method === "TOTP" ? CHALLENGE_COPY.switchToSms : CHALLENGE_COPY.switchToTotp}
              variant="ghost"
              onPress={stepUp.switchMethod}
            />
            <ProovraButton label="Cancel" variant="ghost" onPress={stepUp.cancel} />
          </>
        ) : null}

        {state.kind === "retrying" ? <ProovraText variant="bodySm">{CHALLENGE_COPY.retrying}</ProovraText> : null}

        {state.kind === "failed" ? (
          <>
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>
              {state.reason}
            </ProovraText>
            {state.canRestart ? <ProovraButton label="Start again" onPress={stepUp.restart} /> : null}
            <ProovraButton label="Close" variant="secondary" onPress={stepUp.close} />
          </>
        ) : null}
      </View>
    </ProovraSheet>
  );
}
