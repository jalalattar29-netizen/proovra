"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../../providers";

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
    if (state && storedState && state !== storedState) {
      setError("OAuth state mismatch.");
      return;
    }

    let provider: Provider | null = null;
    if (providerRaw === "apple" || providerRaw === "google") provider = providerRaw;
    if (!provider && state === "google") provider = "google";
    if (!provider) provider = inferProviderFromIdToken(idToken);
    if (!provider) provider = "apple";

    const tokenToSend = idToken ?? code;
    if (!tokenToSend) {
      setError("Missing OAuth token.");
      return;
    }

    const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "https://api.proovra.com";
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

    void (async () => {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || "Sign-in failed");
        }
        const data = (await res.json()) as { token?: string };
        if (!data.token) throw new Error("Missing access token");
        setToken(data.token);
        router.replace("/dashboard");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign-in failed");
      }
    })();
  }, [router, setToken]);

  if (error) {
    return <div style={{ padding: 32 }}>{error}</div>;
  }

  return <div style={{ padding: 32 }}>Signing you in…</div>;
}
