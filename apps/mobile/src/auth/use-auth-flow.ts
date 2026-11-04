/**
 * Shared post-authentication flow (Phase 4C). One place that turns a
 * LoginResult into the correct destination:
 *   - mfaRequired  → MFA challenge screen (carries the pending token),
 *   - mfaEnrollmentRequired → add a factor, then a session (token held in memory),
 *   - session      → confirm /me, store the session, then run the legal-status
 *                    gate: missing acceptance → legal screen, else main app.
 * Used by every sign-in path (email, Google, Apple, MFA, verify) so behavior
 * is identical regardless of entry point.
 */
import { useCallback } from "react";
import { useRouter } from "expo-router";
import { getAuthToken, setAuthToken } from "../api";
import { useAuth } from "../auth-context";
import { endSessionReplacedBy } from "./account-switch";
import { fetchMe, getLegalStatus, recordLegalAcceptance, type LoginResult } from "./auth-api";
import { endMfaEnrollment, holdMfaEnrollment } from "./mfa-enrollment-session";
import type { OAuthMode } from "./use-oauth";
import { takePendingRoute } from "../deep-link/pending-intent";

export type LoginMode = OAuthMode | "email" | "sso";

export interface CompleteLoginOptions {
  /**
   * The person ticked the Terms / Privacy / Cookie box on THIS screen, and this
   * names the flow ("login", "register"). The web records those acceptances
   * as soon as the session exists (login/page.tsx:285-294, 380-388:
   * POST /v1/users/legal-acceptance { source, acceptances }), so a person who
   * just agreed is not asked a second time by the acceptance gate. The
   * versions are the server's own `requiredVersions` — never a copy.
   */
  legalAcceptedSource?: string;
}

export function useCompleteLogin() {
  const { setSession, token: currentToken, user: currentUser } = useAuth();
  const router = useRouter();

  return useCallback(
    async (result: LoginResult, mode: LoginMode, options: CompleteLoginOptions = {}) => {
      if (result.kind === "mfaEnrollmentRequired") {
        // The token stays out of the route: see mfa-enrollment-session.ts.
        if (result.mfaEnrollmentToken) {
          holdMfaEnrollment({
            token: result.mfaEnrollmentToken,
            mode,
            expiresInSeconds: result.expiresInSeconds,
            legalAcceptedSource: options.legalAcceptedSource,
          });
        } else {
          endMfaEnrollment();
        }
        router.push({ pathname: "/mfa", params: { enroll: "1", mode } });
        return;
      }
      if (result.kind === "mfaRequired") {
        router.push({ pathname: "/mfa", params: { pendingToken: result.mfaPendingToken, mode } });
        return;
      }
      // The session this sign-in replaces, if the device holds one (PRO-113).
      const previousToken = currentToken;
      const previousUserId = currentUser?.id ?? null;

      // Confirm the session (fetch the user if the login response omitted it),
      // then persist it.
      setAuthToken(result.token);
      let user = result.user ?? null;
      if (!user) {
        try {
          user = await fetchMe();
        } catch {
          user = null;
        }
        // A token the server refused has already ended this sign-in, and the
        // sign-in screen is saying why. It must not be stored after that.
        if (getAuthToken() !== result.token) return;
      }

      // PRO-113 / MOBILE-01 — a sign-in never silently leaves the replaced
      // session live. A different (or unprovable) account ends the old one as
      // sign-out does: capture torn down, session revoked, residue cleared.
      // A deep link that arrived before auth resumes here (survives auth → MFA →
      // legal). The destination screen still authorizes via its own fetch. Taken
      // before a switch clears the old account's residue: the link was opened
      // for the sign-in happening now.
      const pending = takePendingRoute();
      const destination = pending ?? "/(tabs)";

      if (previousToken && previousToken !== result.token) {
        const sameAccount = Boolean(previousUserId && user?.id && user.id === previousUserId);
        await endSessionReplacedBy(previousToken, sameAccount);
        setAuthToken(result.token);
      }
      setSession({ token: result.token, user, mode });

      // Legal-status gate at the entry to the app (audit §Z13). Fail-open on a
      // transient error — the server's 428 gate will still catch a real gap.
      try {
        let legal = await getLegalStatus();
        if (options.legalAcceptedSource) {
          const acceptances = Object.entries(legal.requiredVersions)
            .filter(([, v]) => typeof v === "string" && v.length > 0)
            .map(([policyKey, version]) => ({ policyKey, version }));
          if (acceptances.length > 0) {
            try {
              await recordLegalAcceptance(acceptances, options.legalAcceptedSource);
              legal = { ...legal, ok: true, missingPolicies: [] };
            } catch {
              /* not saved — the acceptance gate below asks again, as the web's warning does */
            }
          }
        }
        if (!legal.ok && legal.missingPolicies.length > 0) {
          router.replace({ pathname: "/legal-acceptance", params: { policies: legal.missingPolicies.join(","), next: destination } });
          return;
        }
      } catch {
        /* proceed; runtime 428 handles it */
      }
      if (getAuthToken() !== result.token) return;
      router.replace(destination as never);
    },
    [router, setSession, currentToken, currentUser],
  );
}
