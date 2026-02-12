"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../../providers";
import { authLogger } from "../../../../lib/auth-logger";

type Provider = "apple" | "google";

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
  const router = useRouter();
  const { setToken } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const searchParams = new URLSearchParams(window.location.search);
    const hashParams = parseHashParams(window.location.hash);
    const idToken = searchParams.get("id_token") ?? hashParams.get("id_token");
    const code = searchParams.get("code") ?? hashParams.get("code");
    const providerRaw =
      searchParams.get("provider") ?? hashParams.get("provider");
    const state = searchParams.get("state") ?? hashParams.get("state");
    const storedState = sessionStorage.getItem("proovra-apple-state");
    
    authLogger.logCallbackReceived({
      idToken: !!idToken,
      code: !!code,
      provider: providerRaw,
      state: !!state,
      storedState: !!storedState
    });
    
    // Only validate state for Apple (Google uses static state="google")
    if (state && state !== "google" && storedState && state !== storedState) {
      authLogger.logError("callback_state_mismatch", `state=${state}, stored=${storedState}`);
      setError("OAuth state mismatch.");
      return;
    }

    let provider: Provider | null = null;
    if (providerRaw === "apple" || providerRaw === "google") provider = providerRaw;
    if (!provider && state === "google") provider = "google";
    if (!provider) provider = inferProviderFromIdToken(idToken);
    if (!provider) provider = "apple";

    authLogger.log("CALLBACK", "provider_detected", { provider }, provider);

    const tokenToSend = idToken ?? code;
    if (!tokenToSend) {
      authLogger.logError("callback_no_token", "Neither idToken nor code provided");
      setError("Missing OAuth token.");
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
      provider === "apple" && code
        ? { code }
        : provider === "google" && code
          ? { code }
          : { idToken: tokenToSend };

    authLogger.log("CALLBACK", "request_start", {
      endpoint,
      has_code: !!code,
      has_idToken: !!idToken
    }, provider);

    void (async () => {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        
        authLogger.log("CALLBACK", "token_exchange_response", {
          status: res.status,
          ok: res.ok
        }, provider);

        if (!res.ok) {
          const text = await res.text();
          authLogger.logError("callback_exchange_failed", `${res.status}: ${text}`);
          throw new Error(text || "Sign-in failed");
        }
        const data = (await res.json()) as { token?: string };
        if (!data.token) {
          authLogger.logError("callback_no_token_in_response", "Response missing token");
          throw new Error("Missing access token");
        }
        
        authLogger.log("CALLBACK", "token_received", {}, provider);
        setToken(data.token);
        
        const meRes = await fetch(`${apiBase}/v1/auth/me`, {
          headers: { authorization: `Bearer ${data.token}` }
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
          const stored = sessionStorage.getItem("proovra-return-url");
          if (stored && stored.startsWith("/")) {
            redirectTo = stored;
            sessionStorage.removeItem("proovra-return-url");
          }
        } catch {
          void 0;
        }
        
        authLogger.log("CALLBACK", "success", { redirectTo }, provider);
        router.replace(redirectTo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Sign-in failed";
        authLogger.logError("callback_error", msg);
        setError(msg);
      }
    })();
  }, [router, setToken]);

  if (error) {
    return <div style={{ padding: 32 }}>{error}</div>;
  }

  return <div style={{ padding: 32 }}>Signing you in…</div>;
}
