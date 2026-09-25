/**
 * OAuth ceremony hook (Phase 4C). Encapsulates the Google (expo-auth-session)
 * and Apple (expo-apple-authentication) flows and routes their result through
 * the typed LoginResult so callers handle `session` vs `mfaRequired` uniformly.
 * Errors are sanitized via the safe-error layer (no raw provider strings, no
 * debug/API-base leakage). The native OAuth *client configuration* remains
 * EXTERNAL-CONFIG-PENDING; this is the repository-side wiring.
 */
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
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
  /**
   * T-15 — LINK mode. When set, the provider's ID token is handed here and is
   * NOT exchanged for a session: Settings → Sign-in methods posts it to
   * `/v1/identity/links/:provider` to add Google/Apple to the SIGNED-IN
   * account. Sign-in screens leave it unset.
   */
  onIdToken?: (mode: OAuthMode, idToken: string) => Promise<void> | void;
}): UseOAuth {
  const { onResult, onIdToken } = opts;
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

  /*
   * THE PROVIDER THROWS DURING RENDER WHEN ITS PLATFORM ID IS MISSING.
   *
   * `expo-auth-session` resolves the id inside a useMemo and calls
   * `invariantClientId`, which is literally:
   *
   *     if (typeof value === 'undefined')
   *       throw new Error(`Client Id property \`${idName}\` must be
   *         defined to use ${providerName} auth on this platform.`);
   *
   * So on iOS with no `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `useAuthRequest`
   * throws while rendering and the `if (!googleRequest)` guard below never
   * runs — it is dead code in exactly the case it was written for. MEASURED
   * on a physical iPad on 2026-09-24: the sign-in screen failed with that
   * message, from a Metro bundle whose `.env` still carried the old generic
   * `EXPO_PUBLIC_GOOGLE_CLIENT_ID`.
   *
   * The id the CURRENT platform needs decides whether Google is offered at
   * all. When it is absent the provider is handed a placeholder that cannot
   * authenticate anything, purely to keep the invariant from throwing, and
   * `promptGoogle` refuses before it could ever be used. A legible refusal
   * beats a crash on the first screen of the app.
   */
  const platformClientId =
    Platform.OS === "ios"
      ? iosClientId
      : Platform.OS === "android"
        ? androidClientId
        : webClientId;
  const googleConfigured = typeof platformClientId === "string" && platformClientId.length > 0;

  // Never sent anywhere: `promptGoogle` returns OAUTH_GOOGLE_UNCONFIGURED
  // before any request is built. It exists only so the provider's invariant
  // sees a defined value instead of throwing mid-render.
  const UNCONFIGURED = "proovra-google-unconfigured.invalid";

  const [googleRequest, googleResponse, promptAsync] = Google.useAuthRequest({
    iosClientId: iosClientId ?? UNCONFIGURED,
    androidClientId: androidClientId ?? UNCONFIGURED,
    webClientId: webClientId ?? UNCONFIGURED,
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
        if (onIdToken) await onIdToken("google", idToken);
        else onResult(await oauthGoogle(idToken), "google");
      } catch (err) {
        setError(toSafeUserError(err));
      } finally {
        setBusy(null);
      }
    })();
  }, [googleResponse, onResult, onIdToken]);

  const promptGoogle = useCallback(() => {
    if (!googleConfigured || !googleRequest) {
      // Request is null until a platform client id is provisioned via
      // EXPO_PUBLIC_GOOGLE_{IOS,ANDROID,WEB}_CLIENT_ID (EXTERNAL-CONFIG-PENDING).
      setError(toSafeUserError({ status: 503, code: "OAUTH_GOOGLE_UNCONFIGURED" }));
      return;
    }
    setError(null);
    void promptAsync();
  }, [googleConfigured, googleRequest, promptAsync]);

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
        if (onIdToken) await onIdToken("apple", result.identityToken);
        else onResult(await oauthApple(result.identityToken), "apple");
      } catch (err) {
        const isCancel =
          (err as { code?: string })?.code === "ERR_REQUEST_CANCELED" ||
          (err instanceof Error && /cancel/i.test(err.message ?? ""));
        if (!isCancel) setError(toSafeUserError(err));
      } finally {
        setBusy(null);
      }
    })();
  }, [onResult, onIdToken]);

  return {
    googleReady: googleConfigured && !!googleRequest,
    appleAvailable,
    busy,
    error,
    promptGoogle,
    signInApple,
    clearError: () => setError(null),
  };
}
