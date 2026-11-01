/**
 * MOBILE-007 — add an authenticator during a sign-in the organization refused.
 *
 * Native counterpart of apps/web/components/identity-security/MfaEnrollmentAtSignIn.tsx.
 * Set up, confirm a code, save the recovery codes, finish. The token that
 * authorises these steps is held in memory by src/auth/mfa-enrollment-session.ts.
 * It goes as the bearer of each call, and `enroll/verify` replaces it with the
 * one that proves the factor, which is the only token `complete` accepts.
 *
 * An answer here says nothing about a session, because there is none yet. A 401
 * ends this sign-in, never the app's session handling.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";

import {
  completeSignInEnrollment,
  startSignInEnrollment,
  verifySignInEnrollment,
  type AuthSession,
} from "../auth/auth-api";
import {
  currentMfaEnrollment,
  endMfaEnrollment,
  replaceMfaEnrollmentToken,
  type MfaEnrollmentHold,
} from "../auth/mfa-enrollment-session";
import { toSafeUserError } from "../errors/safe-error";
import {
  classifyEnrollFailure,
  enrollFailureMessage,
  validateTotpCode,
  type TotpEnrollment,
} from "../product/account-security";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraCard, ProovraText } from "./index";
import { AuthNote } from "./auth-form";
import { RecoveryCodesSheet } from "./recovery-codes-sheet";
import { TotpSetupStep } from "./totp-enrolment";

type Phase =
  | { kind: "starting" }
  | { kind: "scan"; enrollment: TotpEnrollment }
  | { kind: "codes"; codes: string[] }
  | { kind: "finishing" }
  /** `factorActive`: only a code is missing now, so the next sign-in is a challenge. */
  | { kind: "ended"; factorActive: boolean };

const statusOf = (err: unknown): number | undefined => (err as { statusCode?: number } | null)?.statusCode;

const ENDED = "Your sign-in session ended. Please sign in again to continue setup.";
const ENDED_AFTER_FACTOR = "Your authenticator is set up. Sign in again and enter a code from it.";
const START_FAILED = "Could not start setup. Check your connection and try again.";
const FINISH_FAILED = "Could not finish signing in. Try again.";
const NEW_KEY = "This setup expired. Add this new key to your authenticator.";

export function MfaEnrollmentAtSignIn({
  onSignedIn,
  onRestart,
  support,
}: {
  onSignedIn: (session: AuthSession, hold: MfaEnrollmentHold) => Promise<void>;
  onRestart: () => void;
  support: React.ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>(() =>
    currentMfaEnrollment() ? { kind: "starting" } : { kind: "ended", factorActive: false },
  );
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const end = useCallback((factorActive: boolean) => {
    endMfaEnrollment();
    setPhase({ kind: "ended", factorActive });
  }, []);

  const start = useCallback(
    async (notice: string | null = null) => {
      const hold = currentMfaEnrollment();
      if (!hold) {
        end(false);
        return;
      }
      setError(null);
      try {
        const enrollment = await startSignInEnrollment(hold.token);
        if (!enrollment) {
          setError(START_FAILED);
          return;
        }
        setCode("");
        setError(notice);
        setPhase({ kind: "scan", enrollment });
      } catch (err) {
        if (statusOf(err) === 401) end(false);
        else setError(START_FAILED);
      }
    },
    [end],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (currentMfaEnrollment()) void start();
  }, [start]);

  // The token lasts as long as this screen. Going back means signing in again.
  useEffect(() => () => endMfaEnrollment(), []);

  const confirmCode = useCallback(async () => {
    const hold = currentMfaEnrollment();
    if (phase.kind !== "scan" || busy) return;
    if (!hold) {
      end(false);
      return;
    }
    const invalid = validateTotpCode(code);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const verified = await verifySignInEnrollment(hold.token, phase.enrollment.factorId, code);
      if (verified.provingToken) replaceMfaEnrollmentToken(verified.provingToken);
      setCode("");
      setPhase({ kind: "codes", codes: verified.recoveryCodes });
    } catch (err) {
      if (statusOf(err) === 401) {
        end(false);
        return;
      }
      const failure = classifyEnrollFailure(err);
      if (failure === "NOT_FOUND") {
        await start(NEW_KEY);
      } else if (failure === "UNKNOWN") {
        setError(toSafeUserError(err).message);
      } else {
        setError(enrollFailureMessage(failure));
      }
    } finally {
      setBusy(false);
    }
  }, [phase, busy, code, end, start]);

  const finish = useCallback(async () => {
    const hold = currentMfaEnrollment();
    if (busy) return;
    if (!hold) {
      end(true);
      return;
    }
    setBusy(true);
    setError(null);
    setPhase({ kind: "finishing" });
    try {
      const session = await completeSignInEnrollment(hold.token);
      endMfaEnrollment();
      await onSignedIn(session, hold);
    } catch (err) {
      const status = statusOf(err);
      // 401: the token ended. 403 and 409: it proves no factor. Retrying cannot
      // help in any of the three, and the factor is active either way.
      if (status === 401 || status === 403 || status === 409) end(true);
      else setError(FINISH_FAILED);
    } finally {
      setBusy(false);
    }
  }, [busy, end, onSignedIn]);

  if (phase.kind === "ended") {
    return (
      <ProovraCard testID="mfa-enroll-ended">
        <ProovraText variant="h2" weight="semibold" accessibilityRole="header">
          Set up two-factor authentication
        </ProovraText>
        <ProovraText variant="body" color={theme.color.status.risk.fg}>
          {phase.factorActive ? ENDED_AFTER_FACTOR : ENDED}
        </ProovraText>
        <View style={{ marginTop: theme.space.s3 }}>
          <ProovraButton label="Return to sign in" onPress={onRestart} />
        </View>
        {support}
      </ProovraCard>
    );
  }

  return (
    <>
      <ProovraCard testID="mfa-enroll-required">
        <ProovraText variant="h2" weight="semibold" accessibilityRole="header">
          Set up two-factor authentication
        </ProovraText>
        <ProovraText variant="body" color={theme.color.ink.secondary}>
          Your organization requires two-factor authentication. Add an authenticator to finish signing in.
        </ProovraText>

        {phase.kind === "scan" ? (
          <TotpSetupStep
            enrollment={phase.enrollment}
            code={code}
            onChangeCode={setCode}
            verifyLabel="Verify and continue"
            busy={busy}
            onVerify={() => void confirmCode()}
            onOpenFailed={setError}
          />
        ) : null}

        {phase.kind === "starting" && !error ? <AuthNote tone="status">Preparing setup...</AuthNote> : null}
        {phase.kind === "finishing" && !error ? <AuthNote tone="status">Finishing sign-in...</AuthNote> : null}
        {error ? <AuthNote tone="error" testID="mfa-enroll-error">{error}</AuthNote> : null}

        {phase.kind === "starting" && error ? (
          <ProovraButton label="Try again" onPress={() => void start()} />
        ) : null}
        {phase.kind === "finishing" && error ? (
          <ProovraButton label="Finish signing in" onPress={() => void finish()} />
        ) : null}
        {support}
      </ProovraCard>

      {/* Shown once, and held until the person says they saved them. */}
      <RecoveryCodesSheet
        codes={phase.kind === "codes" ? phase.codes : null}
        context="enroll"
        onDone={() => void finish()}
      />
    </>
  );
}
