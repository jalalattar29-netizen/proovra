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

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { apiBaseUrl, apiFetch, isApiResponseError } from "../../../../lib/api";
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
  // PRO-X1-01 (DEC-29) — the person confirms the connection explicitly.
  const [phase, setPhase] = useState<"confirm" | "connecting" | "declined" | "failed">("confirm");

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
    // Signed in: nothing happens until the person presses Connect.
  }, [validation, authReady, user, router]);

  const connect = useCallback(async () => {
    if (!validation.ok || handedOff.current) return;
    setPhase("connecting");
    try {
      const res = (await apiFetch("/v1/oauth/extension/approve", {
        method: "POST",
        body: JSON.stringify({
          client_id: validation.params.client_id,
          redirect_uri: validation.params.redirect_uri,
          code_challenge: validation.params.code_challenge,
        }),
      })) as { approval?: string } | null;
      if (!res?.approval) {
        setPhase("failed");
        return;
      }
      handedOff.current = true;
      const withApproval = `${validation.query}&approval=${encodeURIComponent(res.approval)}`;
      window.location.replace(extensionAuthorizeUrl(apiBaseUrl(), withApproval));
    } catch (err) {
      // An API that predates the confirmation step has no approve route: it
      // still issues the code on authorize, exactly as before.
      if (isApiResponseError(err) && err.statusCode === 404) {
        handedOff.current = true;
        window.location.replace(extensionAuthorizeUrl(apiBaseUrl(), validation.query));
        return;
      }
      setPhase("failed");
    }
  }, [validation]);

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

  if (authReady && user) {
    const account = (user as { email?: string | null }).email ?? "your PROOVRA account";
    return (
      <main style={shell} data-page="auth-extension-continue" data-extension-continue-state={phase}>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Connect the PROOVRA browser extension</h1>
        {phase === "declined" ? (
          <p style={{ color: "#475569", lineHeight: 1.5 }} role="status">
            The extension was not connected. You can close this window.
          </p>
        ) : (
          <>
            <p style={{ color: "#475569", lineHeight: 1.5 }}>
              Connect the PROOVRA extension as <strong>{account}</strong>? It will be able to capture
              pages into the workspaces this account can record evidence in, for up to an hour, and it
              is signed out when you sign out here.
            </p>
            <p style={{ color: "#475569", lineHeight: 1.5, fontSize: 14 }}>
              Only continue if you just chose Sign in from the PROOVRA extension yourself.
            </p>
            {phase === "failed" ? (
              <p role="alert" style={{ color: "#b91c1c" }}>
                The extension could not be connected. Close this window and choose Sign in again from
                the extension.
              </p>
            ) : null}
            <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
              <button
                type="button"
                onClick={() => void connect()}
                disabled={phase === "connecting"}
                data-extension-continue-action="connect"
              >
                {phase === "connecting" ? "Connecting…" : `Connect as ${account}`}
              </button>
              <button
                type="button"
                onClick={() => setPhase("declined")}
                disabled={phase === "connecting"}
                data-extension-continue-action="cancel"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </main>
    );
  }

  return (
    <main
      style={shell}
      data-page="auth-extension-continue"
      data-extension-continue-state={!authReady ? "resolving" : "sign-in"}
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
