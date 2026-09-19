/**
 * OAuth ceremony hook (Phase 4C). Encapsulates the Google (expo-auth-session)
 * and Apple (expo-apple-authentication) flows and routes their result through
 * the typed LoginResult so callers handle `session` vs `mfaRequired` uniformly.
 * Errors are sanitized via the safe-error layer (no raw provider strings, no
 * debug/API-base leakage). The native OAuth *client configuration* remains
 * EXTERNAL-CONFIG-PENDING; this is the repository-side wiring.
 */
import { useCallback, useEffect, useState } from "react";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Google from "expo-auth-session/providers/google";
import * as AuthSession from "expo-auth-session";
import { oauthApple, oauthGoogle, type LoginResult } from "./auth-api";
import { toSafeUserError, type SafeError } from "../errors/safe-error";

export type OAuthMode = "google" | "apple";

export interface UseOAuth {
  googleReady: boolean;
  appleAvailable: boolean;
  busy: OAuthMode | null;
  error: SafeError | null;
  promptGoogle: () => void;
  signInApple: () => void;
  clearError: () => void;
}

export function useOAuth(opts: {
  onResult: (result: LoginResult, mode: OAuthMode) => void;
}): UseOAuth {
  const { onResult } = opts;
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [busy, setBusy] = useState<OAuthMode | null>(null);
  const [error, setError] = useState<SafeError | null>(null);

  const googleClientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? "";
  const redirectUri = AuthSession.makeRedirectUri({ scheme: "proovra" });
  const [googleRequest, googleResponse, promptAsync] = Google.useAuthRequest({
    clientId: googleClientId,
    responseType: AuthSession.ResponseType.IdToken,
    scopes: ["openid", "email", "profile"],
    redirectUri,
  });

  useEffect(() => {
    void AppleAuthentication.isAvailableAsync()
      .then(setAppleAvailable)
      .catch(() => setAppleAvailable(false));
  }, []);

  useEffect(() => {
    if (!googleResponse) return;
    if (googleResponse.type === "dismiss") {
      setBusy(null);
      return;
    }
    if (googleResponse.type === "error") {
      setError(toSafeUserError({ status: 400, code: "OAUTH_GOOGLE" }));
      setBusy(null);
      return;
    }
    if (googleResponse.type !== "success") return;
    const idToken = googleResponse.params?.id_token;
    if (!idToken) {
      setError(toSafeUserError({ status: 400, code: "OAUTH_GOOGLE_NO_TOKEN" }));
      setBusy(null);
      return;
    }
    void (async () => {
      setBusy("google");
      setError(null);
      try {
        onResult(await oauthGoogle(idToken), "google");
      } catch (err) {
        setError(toSafeUserError(err));
      } finally {
        setBusy(null);
      }
    })();
  }, [googleResponse, onResult]);

  const promptGoogle = useCallback(() => {
    if (!googleClientId || !googleRequest) {
      // Repository wiring is present; the native client id is provisioned via
      // EXPO_PUBLIC_GOOGLE_CLIENT_ID (EXTERNAL-CONFIG-PENDING).
      setError(toSafeUserError({ status: 503, code: "OAUTH_GOOGLE_UNCONFIGURED" }));
      return;
    }
    setError(null);
    void promptAsync();
  }, [googleClientId, googleRequest, promptAsync]);

  const signInApple = useCallback(() => {
    void (async () => {
      setBusy("apple");
      setError(null);
      try {
        const result = await AppleAuthentication.signInAsync({
          requestedScopes: [
            AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
            AppleAuthentication.AppleAuthenticationScope.EMAIL,
          ],
        });
        if (!result.identityToken) throw new Error("No identity token");
        onResult(await oauthApple(result.identityToken), "apple");
      } catch (err) {
        const isCancel =
          (err as { code?: string })?.code === "ERR_REQUEST_CANCELED" ||
          (err instanceof Error && /cancel/i.test(err.message ?? ""));
        if (!isCancel) setError(toSafeUserError(err));
      } finally {
        setBusy(null);
      }
    })();
  }, [onResult]);

  return {
    googleReady: !!googleRequest,
    appleAvailable,
    busy,
    error,
    promptGoogle,
    signInApple,
    clearError: () => setError(null),
  };
}
