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

  // Google native sign-in needs PLATFORM-SPECIFIC client ids (A1). Passing these
  // lets expo-auth-session derive the correct native redirect (iOS uses the
  // reversed-client-id scheme; Android binds to the package + SHA) — a single
  // generic clientId + a custom proovra:// redirect is the defect this replaces.
  // The webClientId sets the id_token audience for the server exchange; the
  // backend audience allowlist stays strict (no wildcard). External console
  // values remain EXTERNAL-CONFIG-PENDING.
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || undefined;
  const androidClientId = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || undefined;
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || undefined;
  const [googleRequest, googleResponse, promptAsync] = Google.useAuthRequest({
    iosClientId,
    androidClientId,
    webClientId,
    responseType: AuthSession.ResponseType.IdToken,
    scopes: ["openid", "email", "profile"],
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
    if (!googleRequest) {
      // Request is null until a platform client id is provisioned via
      // EXPO_PUBLIC_GOOGLE_{IOS,ANDROID,WEB}_CLIENT_ID (EXTERNAL-CONFIG-PENDING).
      setError(toSafeUserError({ status: 503, code: "OAUTH_GOOGLE_UNCONFIGURED" }));
      return;
    }
    setError(null);
    void promptAsync();
  }, [googleRequest, promptAsync]);

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
