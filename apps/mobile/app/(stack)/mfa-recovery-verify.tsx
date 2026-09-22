/**
 * MFA RECOVERY EMAIL VERIFICATION — the native port of
 * `apps/web/app/auth/mfa-recovery/verify/page.tsx`.
 *
 * Reached from the link in the recovery email, which carries `?id=` and
 * `?token=`. Like the other credential links, it must work with NO session:
 * the whole point is that the user cannot get in.
 *
 * The token is used once and never stored, never re-rendered and never logged.
 * Success moves the request to admin review and nothing more — the screen says
 * so in the body, not in fine print, because a user who thinks this signed
 * them in will wait for an app that is never going to let them in.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";

import { apiFetch } from "../../src/api";
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraPageHeader,
  ProovraLoadingState,
} from "../../src/ui";
import {
  MFA_RECOVERY_BOUNDARY,
  MFA_RECOVERY_PAGE_VIEWED_PATH,
  SESSION_LIGHT_PATH,
  buildVerifyEmailPath,
  classifyVerifyFailure,
  failureMessage,
  parseRecoveryLink,
  parseSessionProbe,
  type MfaRecoveryFailure,
} from "../../src/product/mfa-recovery";

type State =
  | { kind: "verifying" }
  | { kind: "verified"; sessionPresent: boolean }
  | { kind: "error"; reason: MfaRecoveryFailure };

export default function MfaRecoveryVerifyScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[]; token?: string | string[] }>();
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const [state, setState] = useState<State>({ kind: "verifying" });
  const started = useRef(false);

  const run = useCallback(async () => {
    // Guard a double-invoke and a manual retry: the token is single-use, and
    // posting it twice turns a valid link into "already handled".
    if (started.current) return;
    started.current = true;

    // Best-effort funnel analytics, fired before the verify so the top of the
    // funnel is observable. Never fatal.
    void apiFetch(MFA_RECOVERY_PAGE_VIEWED_PATH, {
      method: "POST",
      body: JSON.stringify({}),
    }).catch(() => undefined);

    const link = parseRecoveryLink({ id: one(params.id), token: one(params.token) });
    if (!link) {
      setState({ kind: "error", reason: "missing_params" });
      return;
    }

    try {
      await apiFetch(buildVerifyEmailPath(link.requestId), {
        method: "POST",
        body: JSON.stringify({ token: link.token }),
      });

      // Whether the user happens to already have a session decides where we
      // send them next. It never creates one.
      let sessionPresent = false;
      try {
        sessionPresent = parseSessionProbe(await apiFetch(SESSION_LIGHT_PATH));
      } catch {
        sessionPresent = false;
      }
      setState({ kind: "verified", sessionPresent });
    } catch (err) {
      setState({ kind: "error", reason: classifyVerifyFailure(err) });
    }
  }, [params.id, params.token]);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <ProovraScreen testID="mfa-recovery-verify">
      <ProovraPageHeader
        title={
          state.kind === "verifying"
            ? "Verifying your recovery request"
            : state.kind === "verified"
              ? "Email verified"
              : "We could not confirm this link"
        }
        eyebrow="Account recovery"
      />

      {state.kind === "verifying" ? (
        <ProovraLoadingState label="Confirming your recovery link" />
      ) : null}

      {state.kind === "verified" ? (
        <ProovraCard>
          <ProovraText variant="body">Thanks — your mailbox access is confirmed.</ProovraText>
          <ProovraText variant="body" color={theme.color.ink.secondary}>
            Your two-factor recovery request is now waiting for an administrator in your
            organization to review. You do not need to do anything else until they reach out.
          </ProovraText>
          <ProovraText variant="bodySm" color={theme.color.status.pending.fg}>
            {MFA_RECOVERY_BOUNDARY}
          </ProovraText>
          <ProovraButton
            label={state.sessionPresent ? "Continue to home" : "Return to sign in"}
            onPress={() =>
              state.sessionPresent ? router.replace("/(tabs)") : router.replace("/(stack)/auth")
            }
          />
        </ProovraCard>
      ) : null}

      {state.kind === "error" ? (
        <ProovraCard>
          <ProovraText variant="body">{failureMessage(state.reason)}</ProovraText>
          <ProovraButton
            label="Return to sign in"
            variant="secondary"
            onPress={() => router.replace("/(stack)/auth")}
          />
        </ProovraCard>
      ) : null}
    </ProovraScreen>
  );
}
