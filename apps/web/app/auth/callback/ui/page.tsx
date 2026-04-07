"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../../providers";
import { useToast } from "../../../../components/ui";
import { authLogger } from "../../../../lib/auth-logger";
import {
  clearPendingOAuthLegalAcceptance,
  readPendingOAuthLegalAcceptance,
} from "../../../../lib/legalAcceptance";

type Provider = "apple" | "google";

const DEBUG_AUTH = process.env.NEXT_PUBLIC_DEBUG_AUTH === "1";

/** Prevents duplicate token exchange (React Strict Mode / re-mounts consume OAuth codes) */
const processedTokens = new Set<string>();
let callbackProcessing = false;

function parseHashParams(hash: string) {
  const cleaned = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(cleaned);
  return params;
}

function base64UrlDecode(input: string) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(input.length / 4) * 4,
    "="
  );
  try {
    return atob(padded);
  } catch {
    return "";
  }
}

function inferProviderFromIdToken(idToken: string | null): Provider | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  const payloadRaw = base64UrlDecode(parts[1]);
  if (!payloadRaw) return null;
  try {
    const payload = JSON.parse(payloadRaw) as { iss?: string };
    if (payload.iss?.includes("appleid.apple.com")) return "apple";
    if (payload.iss?.includes("accounts.google.com")) return "google";
  } catch {
    return null;
  }
  return null;
}

export default function AppleCallbackPage() {
  const { setToken } = useAuth();
  const { addToast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const exchangedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (exchangedRef.current) return;
    if (callbackProcessing) return;
    exchangedRef.current = true;
    callbackProcessing = true;

    const searchParams = new URLSearchParams(window.location.search);
    const hashParams = parseHashParams(window.location.hash);
    const idToken = searchParams.get("id_token") ?? hashParams.get("id_token");
    const code = searchParams.get("code") ?? hashParams.get("code");
    const providerRaw =
      searchParams.get("provider") ?? hashParams.get("provider");
    const state = searchParams.get("state") ?? hashParams.get("state");
    const storedState = sessionStorage.getItem("proovra-apple-state");
    const pendingLegal = readPendingOAuthLegalAcceptance();

    authLogger.log("AUTH_CALLBACK_RECEIVED", `provider=${providerRaw ?? "unknown"}`, {
      hasCode: !!code,
      hasIdToken: !!idToken,
      hasState: !!state,
      hasStoredState: !!storedState,
      hasPendingLegal: !!pendingLegal,
    });
    authLogger.logCallbackReceived({
      idToken: !!idToken,
      code: !!code,
      provider: providerRaw,
      state: !!state,
      storedState: !!storedState
    });

    if (DEBUG_AUTH) {
      console.info("[Auth] Callback received:", {
        provider: providerRaw,
        hasCode: !!code,
        hasIdToken: !!idToken,
        hasPendingLegal: !!pendingLegal,
      });
    }

    // Only validate state for Apple (Google uses static state="google")
    if (state && state !== "google" && storedState && state !== storedState) {
      authLogger.logError("callback_state_mismatch", `state=${state}, stored=${storedState}`);
      setError("OAuth state mismatch.");
      addToast("OAuth state mismatch. Please try again.", "error");
      callbackProcessing = false;
      return;
    }

    let provider: Provider | null = null;
    if (providerRaw === "apple" || providerRaw === "google") provider = providerRaw;
    if (!provider && state === "google") provider = "google";
    if (!provider) provider = inferProviderFromIdToken(idToken);
    if (!provider) provider = "apple";

    authLogger.log("CALLBACK", "provider_detected", { provider }, provider);

    const oauthError = searchParams.get("error") ?? hashParams.get("error");
    const tokenToSend = idToken ?? code;

    if (tokenToSend && processedTokens.has(tokenToSend)) {
      if (DEBUG_AUTH) console.info("[Auth] Callback already processed for this token, skipping duplicate");
      callbackProcessing = false;
      return;
    }
    if (tokenToSend) processedTokens.add(tokenToSend);

    if (!tokenToSend) {
      if (
        oauthError === "access_denied" ||
        oauthError === "user_cancelled_authorize" ||
        oauthError === "user_cancelled_login"
      ) {
        authLogger.log("CALLBACK", "user_cancelled", { error: oauthError }, provider ?? "unknown");
        setError("Sign-in was cancelled.");
        addToast("Sign-in was cancelled.", "info");
      } else {
        authLogger.logError("callback_no_token", "Neither idToken nor code provided");
        setError("Missing OAuth token.");
        addToast("Sign-in failed: Missing OAuth token.", "error");
      }
      callbackProcessing = false;
      return;
    }

    const apiBase =
      process.env.NEXT_PUBLIC_API_BASE ??
      (typeof window !== "undefined" &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
        ? "http://localhost:8081"
        : "https://api.proovra.com");

    const endpoint =
      provider === "google"
        ? `${apiBase}/v1/auth/google`
        : `${apiBase}/v1/auth/apple`;

    const body =
      idToken
        ? { idToken }
        : code
          ? { code }
          : {};

    authLogger.log("CALLBACK", "request_start", {
      endpoint,
      has_code: !!code,
      has_idToken: !!idToken
    }, provider);

    void (async () => {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-web-client": "1" },
          body: JSON.stringify(body),
          credentials: "include"
        });

        authLogger.log("CALLBACK", "token_exchange_response", {
          status: res.status,
          ok: res.ok
        }, provider);

        if (!res.ok) {
          const text = await res.text();
          let errMsg = "Sign-in failed";
          try {
            const errJson = JSON.parse(text) as {
              message?: string;
              hint?: string;
              error?: { message?: string };
            };
            errMsg =
              [errJson.message, errJson.hint].filter(Boolean).join(" — ") ||
              errJson.error?.message ||
              errMsg;
          } catch {
            // ignore parse failure
          }
          authLogger.logError("callback_exchange_failed", `${res.status}: ${text}`);
          authLogger.log("AUTH_SESSION_FAILED", "error", { code: "token_exchange", status: res.status, message: errMsg }, provider);
          throw new Error(errMsg);
        }

        const data = (await res.json()) as { token?: string };
        if (!data.token) {
          authLogger.logError("callback_no_token_in_response", "Response missing token");
          throw new Error("Missing access token");
        }

        authLogger.log("CALLBACK", "token_received", {}, provider);

        if (!isMountedRef.current) return;
        setToken(data.token);

        if (pendingLegal?.acceptances?.length) {
          try {
            const legalRes = await fetch(`${apiBase}/v1/users/legal-acceptance`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${data.token}`,
                "x-web-client": "1",
              },
              body: JSON.stringify({
                source: pendingLegal.source,
                acceptances: pendingLegal.acceptances,
              }),
              credentials: "include",
            });

            if (legalRes.ok) {
              clearPendingOAuthLegalAcceptance();
            } else {
              authLogger.log("CALLBACK", "legal_acceptance_not_saved", {
                status: legalRes.status,
              }, provider);
            }
          } catch (legalErr) {
            authLogger.logError(
              "callback_legal_acceptance_failed",
              legalErr instanceof Error ? legalErr.message : "unknown error"
            );
          }
        }

        const meRes = await fetch(`${apiBase}/v1/auth/me`, {
          headers: { authorization: `Bearer ${data.token}`, "x-web-client": "1" },
          credentials: "include"
        });

        authLogger.log("CALLBACK", "session_validation", {
          status: meRes.status,
          ok: meRes.ok
        }, provider);

        if (!meRes.ok) {
          authLogger.logError("callback_session_validation_failed", `/me returned ${meRes.status}`);
          throw new Error("Session not confirmed");
        }

        let redirectTo = "/home";

        try {
          if (pendingLegal?.returnUrl && pendingLegal.returnUrl.startsWith("/")) {
            redirectTo = pendingLegal.returnUrl;
          } else {
            const stored = sessionStorage.getItem("proovra-return-url");
            if (stored && stored.startsWith("/")) {
              redirectTo = stored;
            }
          }
          sessionStorage.removeItem("proovra-return-url");
        } catch {
          // ignore
        }

        const meData = await meRes.json().catch(() => ({}));
        const userId = meData?.user?.id;
        authLogger.log("AUTH_SESSION_SUCCESS", `userId=${userId ?? "unknown"}`, { provider, redirectTo }, provider);
        authLogger.log("CALLBACK", "success", { redirectTo }, provider);

        if (!isMountedRef.current) return;

        const appBase = process.env.NEXT_PUBLIC_APP_BASE ?? "https://app.proovra.com";
        const target = `${appBase}${redirectTo}`;
        authLogger.log("CALLBACK", "redirecting", { target }, provider);

        clearPendingOAuthLegalAcceptance();
        window.location.replace(target);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Sign-in failed";
        authLogger.logError("callback_error", msg);
        authLogger.log("AUTH_SESSION_FAILED", "error", { code: "callback_error", message: msg }, provider);
        if (!isMountedRef.current) return;
        setError(msg);
        addToast(msg, "error", 6000);
      } finally {
        callbackProcessing = false;
      }
    })();

    return () => {
      isMountedRef.current = false;
    };
  }, [setToken, addToast]);

  if (error) {
    return (
      <div style={{ padding: 32 }}>
        <p>{error}</p>
        <a href="/login" style={{ marginTop: 16, display: "inline-block", color: "#2563eb" }}>
          Back to sign in
        </a>
      </div>
    );
  }

  return <div style={{ padding: 32 }}>Signing you in…</div>;
}