"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  const params = useSearchParams();
  const { setToken } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const provider = params.get("provider");
    const idToken = params.get("id_token");
    const code = params.get("code");
    const state = params.get("state");
    return { provider, idToken, code, state };
  }, [params]);

  useEffect(() => {
    const hashParams =
      typeof window !== "undefined" ? parseHashParams(window.location.hash) : new URLSearchParams();
    const idToken = query.idToken ?? hashParams.get("id_token");
    const code = query.code ?? hashParams.get("code");
    const providerRaw = query.provider ?? hashParams.get("provider");

    let provider: Provider | null = null;
    if (providerRaw === "apple" || providerRaw === "google") provider = providerRaw;
    if (!provider) provider = inferProviderFromIdToken(idToken);
    if (!provider) provider = "apple";

    const tokenToSend = idToken ?? code;
    if (!tokenToSend) {
      setError("Missing OAuth token.");
      return;
    }

    const endpoint =
      provider === "google"
        ? "https://api.proovra.com/v1/auth/google"
        : "https://api.proovra.com/v1/auth/apple";

    void (async () => {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idToken: tokenToSend })
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
  }, [query, router, setToken]);

  if (error) {
    return <div style={{ padding: 32 }}>{error}</div>;
  }

  return <div style={{ padding: 32 }}>Signing you in…</div>;
}
