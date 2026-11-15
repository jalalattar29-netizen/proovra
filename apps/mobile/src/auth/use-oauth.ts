/**
 * OAuth ceremony hook (Phase 4C). Encapsulates the Google (expo-auth-session)
 * and Apple (expo-apple-authentication) flows and routes their result through
 * the typed LoginResult so callers handle `session` vs `mfaRequired` uniformly.
 * Errors are sanitized via the safe-error layer (no raw provider strings, no
 * debug/API-base leakage). The native OAuth *client configuration* remains
 * EXTERNAL-CONFIG-PENDING; this is the repository-side wiring.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Google from "expo-auth-session/providers/google";
import { fetchOAuthNonce, oauthApple, oauthGoogle, type LoginResult } from "./auth-api";
import { toSafeUserError, type SafeError } from "../errors/safe-error";

export type OAuthMode = "google" | "apple";

/**
 * B-23 — how long a held Google nonce is offered. The API keeps a nonce for 10
 * minutes (social-sign-in-nonce.service.ts SOCIAL_NONCE_TTL_SECONDS); one older
 * than this is replaced before it is used, leaving the person at least five
 * minutes to finish Google's sheet.
 */
export const OAUTH_NONCE_FRESH_MS = 5 * 60 * 1000;

/** PURE — whether a nonce fetched at `fetchedAtMs` may still start an attempt. */
export function oauthNonceIsFresh(fetchedAtMs: number | null, nowMs: number): boolean {
  return fetchedAtMs !== null && nowMs - fetchedAtMs < OAUTH_NONCE_FRESH_MS;
}

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
  // PRO-034 — the nonce the API issued for the NEXT Google attempt. Google signs
  // it into the id_token and the API accepts that token once; a fresh one is
  // fetched after every attempt. Until one arrives Google is not offered.
  const [googleNonce, setGoogleNonce] = useState<string | null>(null);
  // B-23 — when the held nonce was fetched. It used to be fetched once on mount
  // and kept, so the first tap after the API's 10-minute TTL (a screen left
  // open, an app backgrounded) carried an expired nonce and failed at the
  // server. It is now replaced on a schedule, on return to the foreground, and
  // at the tap itself when it has grown old.
  const nonceFetchedAt = useRef<number | null>(null);
  const refreshGoogleNonce = useCallback(() => {
    setGoogleNonce(null);
    nonceFetchedAt.current = null;
    void fetchOAuthNonce("google")
      .then((nonce) => {
        nonceFetchedAt.current = Date.now();
        setGoogleNonce(nonce);
      })
      .catch(() => setGoogleNonce(null));
  }, []);

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
  // Only a build that can offer Google asks the API for a Google nonce.
  useEffect(() => {
    if (!googleConfigured) return;
    refreshGoogleNonce();
    const timer = setInterval(refreshGoogleNonce, OAUTH_NONCE_FRESH_MS);
    // JS timers do not run while the app is suspended: check on the way back.
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && !oauthNonceIsFresh(nonceFetchedAt.current, Date.now())) refreshGoogleNonce();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [googleConfigured, refreshGoogleNonce]);

  // Never sent anywhere: `promptGoogle` returns OAUTH_GOOGLE_UNCONFIGURED
  // before any request is built. It exists only so the provider's invariant
  // sees a defined value instead of throwing mid-render.
  const UNCONFIGURED = "proovra-google-unconfigured.invalid";

  const [googleRequest, googleResponse, promptAsync] = Google.useAuthRequest({
    iosClientId: iosClientId ?? UNCONFIGURED,
    androidClientId: androidClientId ?? UNCONFIGURED,
    webClientId: webClientId ?? UNCONFIGURED,
    scopes: ["openid", "email", "profile"],
    ...(googleNonce ? { extraParams: { nonce: googleNonce } } : {}),
  });

  useEffect(() => {
    void AppleAuthentication.isAvailableAsync()
      .then(setAppleAvailable)
      .catch(() => setAppleAvailable(false));
  }, []);

  useEffect(() => {
    if (!googleResponse) return;
    // Whatever the outcome, the nonce this attempt carried is spent.
    refreshGoogleNonce();
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
  }, [googleResponse, onResult, onIdToken, refreshGoogleNonce]);

  const promptGoogle = useCallback(() => {
    if (!googleConfigured || !googleRequest || !googleNonce) {
      // Request is null until a platform client id is provisioned via
      // EXPO_PUBLIC_GOOGLE_{IOS,ANDROID,WEB}_CLIENT_ID (EXTERNAL-CONFIG-PENDING).
      setError(toSafeUserError({ status: 503, code: "OAUTH_GOOGLE_UNCONFIGURED" }));
      return;
    }
    // B-23 — an old nonce is replaced, not spent: the control reads "not ready"
    // for the moment the fresh one takes to arrive, and the next tap uses it.
    if (!oauthNonceIsFresh(nonceFetchedAt.current, Date.now())) {
      refreshGoogleNonce();
      return;
    }
    setError(null);
    void promptAsync();
  }, [googleConfigured, googleRequest, googleNonce, promptAsync, refreshGoogleNonce]);

  const signInApple = useCallback(() => {
    void (async () => {
      setBusy("apple");
      setError(null);
      try {
        // PRO-034 — a fresh API-issued nonce, signed into the identity token.
        const nonce = await fetchOAuthNonce("apple");
        const result = await AppleAuthentication.signInAsync({
          nonce,
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
    googleReady: googleConfigured && !!googleRequest && !!googleNonce,
    appleAvailable,
    busy,
    error,
    promptGoogle,
    signInApple,
    clearError: () => setError(null),
  };
}
