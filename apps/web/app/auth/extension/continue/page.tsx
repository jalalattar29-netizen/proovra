"use client";

/**
 * UC-EXT-006 — extension sign-in continuation.
 *
 * Reached in the extension's auth window when GET /v1/oauth/extension/authorize
 * found no PROOVRA session. It requires sign-in (sending the user to /login
 * with this exact URL as `next`), validates the OAuth parameters with the one
 * validator, and then hands the auth window back to the API's authorize
 * endpoint on the canonical API origin (never a relative /v1 URL — there is no
 * /v1 rewrite on the web origin). Invalid parameters render an error and go
 * nowhere.
 */

import { Suspense, useEffect, useMemo, useRef, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { apiBaseUrl } from "../../../../lib/api";
import {
  extensionAuthorizeUrl,
  validateExtensionAuthorizeQuery,
} from "../../../../lib/extension/extension-authorize-request";
import { useAuth } from "../../../providers";

const shell: CSSProperties = {
  maxWidth: 520,
  margin: "0 auto",
  padding: "48px 16px",
  fontFamily: "system-ui, -apple-system, sans-serif",
};

function ExtensionContinueBody() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, authReady } = useAuth();
  const handedOff = useRef(false);

  const validation = useMemo(
    () => validateExtensionAuthorizeQuery(new URLSearchParams(searchParams?.toString() ?? "")),
    [searchParams],
  );

  useEffect(() => {
    if (!validation.ok || !authReady || handedOff.current) return;
    if (!user) {
      const here = `/auth/extension/continue?${validation.query}`;
      handedOff.current = true;
      router.replace(`/login?next=${encodeURIComponent(here)}`);
      return;
    }
    handedOff.current = true;
    window.location.replace(extensionAuthorizeUrl(apiBaseUrl(), validation.query));
  }, [validation, authReady, user, router]);

  if (!validation.ok) {
    return (
      <main style={shell} data-page="auth-extension-continue" data-extension-continue-state="invalid">
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>This sign-in link is not valid</h1>
        <p style={{ color: "#475569", lineHeight: 1.5 }}>
          The PROOVRA browser extension sent a sign-in request this page cannot continue. Close this
          window and choose Sign in again from the extension.
        </p>
        <p style={{ marginTop: 16 }}>
          <Link href="/support" style={{ color: "#1d4ed8" }}>
            Contact support
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main
      style={shell}
      data-page="auth-extension-continue"
      data-extension-continue-state={!authReady ? "resolving" : user ? "continuing" : "sign-in"}
      aria-busy="true"
    >
      <h1 style={{ fontSize: 22, marginBottom: 8 }}>Connecting the PROOVRA extension</h1>
      <p style={{ color: "#475569", lineHeight: 1.5 }} role="status">
        {!authReady
          ? "Checking your PROOVRA session…"
          : user
            ? "Returning to the extension…"
            : "Sign in to PROOVRA to connect the extension…"}
      </p>
    </main>
  );
}

export default function ExtensionContinuePage() {
  return (
    <Suspense fallback={<main style={shell}>Loading…</main>}>
      <ExtensionContinueBody />
    </Suspense>
  );
}
