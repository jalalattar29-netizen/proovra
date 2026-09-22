/**
 * STEP-UP SHEET — the one prompt that answers a step-up challenge.
 *
 * Ports `StepUpPrompt` from
 * `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx`.
 *
 * It asks for what the SERVER said it can accept (`methods`), never for what
 * the client assumes: an account with no password cannot be asked for one. On
 * a rejected retry the server sends STEP_UP_INVALID with its own message, and
 * that message is shown rather than a generic failure, because "that code is
 * wrong" and "that password is wrong" are different problems to the person
 * holding the phone.
 */
import { useCallback, useEffect, useState } from "react";

import { theme } from "../theme/theme";
import {
  ProovraText,
  ProovraButton,
  ProovraInput,
  ProovraFormField,
  ProovraSheet,
} from "./index";
import {
  REAUTH_ONLY_NOTE,
  buildStepUpProof,
  extractStepUp,
  isStepUpRateLimited,
  stepUpFieldFor,
  stepUpMethodFor,
  type StepUpChallenge,
  type StepUpProof,
} from "../product/step-up";

export function StepUpSheet({
  challenge,
  title,
  busy,
  onSubmit,
  onCancel,
}: {
  /** null closes the sheet. */
  challenge: StepUpChallenge | null;
  title: string;
  busy: boolean;
  onSubmit: (proof: StepUpProof) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");

  // A new challenge is a new attempt: keeping the rejected value in the field
  // invites submitting it again unchanged.
  useEffect(() => {
    setValue("");
  }, [challenge?.message, challenge?.methods.join(",")]);

  const method = challenge ? stepUpMethodFor(challenge) : "reauth";
  const field = stepUpFieldFor(method);

  return (
    <ProovraSheet visible={challenge !== null} title={title} onClose={onCancel}>
      <ProovraText variant="label" color={theme.color.ink.secondary}>
        {/*
          A challenge is not a refusal and not an expired session. Saying so
          plainly stops this reading as "you are not allowed to do this".
        */}
        This action needs one more proof that it is you. Nothing has been changed yet.
      </ProovraText>

      {challenge?.message ? (
        <ProovraText variant="label" color={theme.color.status.risk.solid}>
          {challenge.message}
        </ProovraText>
      ) : null}

      {field ? (
        <>
          <ProovraFormField label={field.label}>
            <ProovraInput
              value={value}
              onChangeText={setValue}
              placeholder={field.placeholder}
              secureTextEntry={field.secure}
              keyboardType={field.keypad ? "number-pad" : undefined}
              autoComplete={field.secure ? "password" : "off"}
              accessibilityLabel={field.label}
            />
          </ProovraFormField>
          <ProovraButton
            label="Confirm"
            loading={busy}
            disabled={value.trim().length === 0}
            onPress={() => {
              const proof = buildStepUpProof(method, value);
              if (proof) onSubmit(proof);
            }}
          />
        </>
      ) : (
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {REAUTH_ONLY_NOTE}
        </ProovraText>
      )}

      <ProovraButton label="Cancel" variant="ghost" onPress={onCancel} />
    </ProovraSheet>
  );
}

/**
 * The retry loop, once.
 *
 * Every step-up-guarded action has the same shape: run it, and if the server
 * raises a challenge, ask for the proof and run the SAME request again with
 * it. Written per screen, that loop is where the proof quietly stops being
 * re-sent, or where the challenge is reported as a permission error.
 *
 * `run` receives the proof (null on the first attempt) and must send it with
 * the request — `withStepUp` does that.
 */
export function useStepUp() {
  const [challenge, setChallenge] = useState<StepUpChallenge | null>(null);
  const [pendingRun, setPendingRun] = useState<
    ((proof: StepUpProof | null) => Promise<void>) | null
  >(null);

  const attempt = useCallback(
    async (
      run: (proof: StepUpProof | null) => Promise<void>,
      proof: StepUpProof | null,
      onOtherError: (err: unknown) => void,
    ) => {
      try {
        await run(proof);
        setChallenge(null);
        setPendingRun(null);
      } catch (err) {
        const raised = extractStepUp(err);
        if (raised) {
          setChallenge(raised);
          // Stored as a thunk: React would otherwise CALL a function put into
          // state, which would fire the request instead of remembering it.
          setPendingRun(() => run);
          return;
        }
        setChallenge(null);
        setPendingRun(null);
        if (isStepUpRateLimited(err)) {
          onOtherError(
            new Error("Too many attempts. Wait a moment before trying again."),
          );
          return;
        }
        onOtherError(err);
      }
    },
    [],
  );

  const start = useCallback(
    (run: (proof: StepUpProof | null) => Promise<void>, onOtherError: (err: unknown) => void) =>
      attempt(run, null, onOtherError),
    [attempt],
  );

  const retry = useCallback(
    (proof: StepUpProof, onOtherError: (err: unknown) => void) =>
      pendingRun ? attempt(pendingRun, proof, onOtherError) : Promise.resolve(),
    [attempt, pendingRun],
  );

  const dismiss = useCallback(() => {
    setChallenge(null);
    setPendingRun(null);
  }, []);

  return { challenge, start, retry, dismiss };
}
