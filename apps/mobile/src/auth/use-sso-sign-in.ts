/**
 * MOBILE-002 — the Enterprise SSO sign-in ceremony, once (see sso-native.ts).
 *
 * The sign-in screen starts it; the browser normally returns straight to the
 * waiting auth session. When a platform delivers the return as a deep link
 * instead, the sso-complete screen finishes it with `finishSsoReturn`. Either
 * way the code is redeemed exactly once, with this attempt's verifier, and the
 * answer goes through the shared useCompleteLogin like every other sign-in.
 */
import { useCallback, useState } from "react";
import * as WebBrowser from "expo-web-browser";

import { apiBaseUrl } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { discoverSso, exchangeNativeSso, type LoginResult } from "./auth-api";
import {
  SSO_NOT_AVAILABLE_FOR_EMAIL,
  SSO_RETURN_URL,
  buildNativeSsoUrl,
  createPkcePair,
  hasHeldSsoVerifier,
  holdSsoVerifier,
  parseSsoReturn,
  ssoFailureMessage,
  takeSsoVerifier,
} from "./sso-native";

/** A completion refusal: the shared wording, or the organization's own "no" when the reason is not one we word. */
function refusalInWords(reason: string): string {
  const message = ssoFailureMessage(reason);
  return message === ssoFailureMessage("")
    ? "Your organization did not allow this sign-in. Ask your administrator."
    : message;
}

/** Redeem a proovra://sso/complete return. Null when it was handled; else a message. */
export async function finishSsoReturn(
  url: string,
  onResult: (result: LoginResult) => Promise<void>,
  opts: { quietIfSpent?: boolean } = {},
): Promise<string | null> {
  const parsed = parseSsoReturn(url);
  if (!parsed) return ssoFailureMessage("sso_failed");
  const verifier = takeSsoVerifier();
  // No verifier: the other landing (deep link or auth session) already finished
  // this attempt, or the app restarted and the attempt is gone.
  if (!verifier && opts.quietIfSpent) return null;
  if (parsed.kind === "error") return ssoFailureMessage(parsed.reason);
  if (!verifier) return "This sign-in has expired. Start again from the sign-in screen.";
  try {
    await onResult(await exchangeNativeSso(parsed.code, verifier));
    return null;
  } catch (err) {
    const e = err as { code?: string; body?: { error?: { reason?: unknown } } } | null;
    const code = e?.code;
    if (code === "SSO_NATIVE_CODE_INVALID") return "This sign-in has expired. Start again from the sign-in screen.";
    if (code === "SSO_SIGN_IN_REFUSED") {
      // The exchange names why (sso-auth.routes.ts: the session limit, a seat,
      // a managed identity conflict, a connection disabled meanwhile).
      const reason = e?.body?.error?.reason;
      return typeof reason === "string" && reason.length > 0
        ? refusalInWords(reason)
        : "Your organization did not allow this sign-in. Ask your administrator.";
    }
    if (code === "SSO_TEMPORARILY_UNAVAILABLE") return "Single sign-on could not be completed. Start again from the sign-in screen.";
    return toSafeUserError(err, { message: "Single sign-on did not complete. Try again." }).message;
  }
}

export function useSsoSignIn(onResult: (result: LoginResult) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (email: string) => {
      setError(null);
      setBusy(true);
      try {
        const loginPath = await discoverSso(email);
        if (!loginPath) {
          setError(SSO_NOT_AVAILABLE_FOR_EMAIL);
          return;
        }
        const { verifier, challenge } = await createPkcePair();
        holdSsoVerifier(verifier);
        const res = await WebBrowser.openAuthSessionAsync(
          buildNativeSsoUrl(apiBaseUrl(), loginPath, challenge),
          SSO_RETURN_URL,
        );
        if (res.type === "success" && typeof (res as { url?: unknown }).url === "string") {
          setError(await finishSsoReturn((res as { url: string }).url, onResult, { quietIfSpent: true }));
          return;
        }
        // Closed without an answer. If the return was delivered as a deep link
        // instead, the sso-complete screen has already spent the verifier.
        if (hasHeldSsoVerifier()) {
          takeSsoVerifier();
          setError("Single sign-on was cancelled.");
        }
      } catch (err) {
        takeSsoVerifier();
        setError(toSafeUserError(err, { message: "Single sign-on could not be started. Try again." }).message);
      } finally {
        setBusy(false);
      }
    },
    [onResult],
  );

  return { busy, error, start, clearError: () => setError(null) };
}
