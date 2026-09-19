/**
 * Shared post-authentication flow (Phase 4C). One place that turns a
 * LoginResult into the correct destination:
 *   - mfaRequired  → MFA challenge screen (carries the pending token),
 *   - session      → confirm /me, store the session, then run the legal-status
 *                    gate: missing acceptance → legal screen, else main app.
 * Used by every sign-in path (email, Google, Apple, MFA, verify) so behavior
 * is identical regardless of entry point.
 */
import { useCallback } from "react";
import { useRouter } from "expo-router";
import { setAuthToken } from "../api";
import { useAuth } from "../auth-context";
import { fetchMe, getLegalStatus, type LoginResult } from "./auth-api";
import type { OAuthMode } from "./use-oauth";

export type LoginMode = OAuthMode | "email";

export function useCompleteLogin() {
  const { setSession } = useAuth();
  const router = useRouter();

  return useCallback(
    async (result: LoginResult, mode: LoginMode) => {
      if (result.kind === "mfaRequired") {
        router.push({ pathname: "/mfa", params: { pendingToken: result.mfaPendingToken, mode } });
        return;
      }
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
      }
      setSession({ token: result.token, user, mode });

      // Legal-status gate at the entry to the app (audit §Z13). Fail-open on a
      // transient error — the server's 428 gate will still catch a real gap.
      try {
        const legal = await getLegalStatus();
        if (!legal.ok && legal.missingPolicies.length > 0) {
          router.replace({ pathname: "/legal-acceptance", params: { policies: legal.missingPolicies.join(",") } });
          return;
        }
      } catch {
        /* proceed; runtime 428 handles it */
      }
      router.replace("/(tabs)");
    },
    [router, setSession],
  );
}
