"use client";

/**
 * PROOVRA Phase 2B Closure — Portal invitation accept landing.
 *
 * Bounded reviewer surface served from `/portal/accept/[grantId]?token=…`.
 * Reached from the invitation email, the operator's "send invitation"
 * action, or the SSO callback redirect.
 *
 * Flow:
 *   1. Parse `?token=` from the URL (kept ONLY in memory + sessionStorage
 *      — never localStorage). Strip it from window.history so a casual
 *      tab close or share does not leak it.
 *   2. Show the bounded invitation context (workspace name is not
 *      available without a token exchange, so we show the grantId and
 *      reviewer expectations honestly).
 *   3. Two clearly labelled choices:
 *        • "Open with invitation link" — exchanges the token for a
 *          portal session and routes to /portal/[token].
 *        • "Sign in with SSO" — calls POST /v1/portal/sso/start/:grantId
 *          and redirects the browser to the IdP's SSO URL.
 *   4. After the SSO callback flow, the IdP-bound redirect lands back
 *      on this page with `?sso=ok` or `?sso=denied`. On `ok` we resume
 *      the token-backed session from sessionStorage; on `denied` we show
 *      the bounded denial reason.
 *
 * Hard rules:
 *   * Manual token paste is NOT shown here — the token comes in via
 *     the URL or sessionStorage. /portal (root) still hosts the
 *     fallback paste-the-token entry surface.
 *   * NEVER persist the raw token to localStorage. The token is
 *     stashed in sessionStorage only during the SSO redirect window.
 *   * Bounded denial — every error is one of EXTERNAL_PORTAL_DENIAL_REASONS.
 */

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  authenticate,
  consumeStashedRawTokenForSso,
  setBearer,
  startPortalSso,
  stashRawTokenForSso,
} from "../../../../lib/external-portal/portal-client";

type SsoOutcome = "none" | "ok" | "denied";

export default function PortalAcceptPage({
  params,
}: {
  params: Promise<{ grantId: string }>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { grantId } = use(params);

  const initialToken = useMemo(() => {
    const fromQuery = searchParams.get("token");
    if (fromQuery && fromQuery.trim().length > 0) {
      return fromQuery.trim();
    }
    // SSO return-path — the raw token was stashed before redirect.
    return consumeStashedRawTokenForSso();
  }, [searchParams]);

  // `token` and `ssoOutcome` are derived ONCE at mount from `searchParams`
  // / sessionStorage / SSO return-path. There is no UI affordance that
  // mutates either value after that — the accept-flow's interaction model
  // is "read what came in, exchange it, redirect" — so the setters are
  // intentionally unused. `_`-prefix marks them as such for the lint
  // rule (`varsIgnorePattern: "^_"` in apps/web/.eslintrc.cjs). The read
  // values keep their original names so every downstream `token`/
  // `ssoOutcome` reference compiles unchanged.
  const [token, _setToken] = useState<string | null>(initialToken);
  const [ssoOutcome, _setSsoOutcome] = useState<SsoOutcome>(() => {
    const sso = searchParams.get("sso");
    if (sso === "ok") return "ok";
    if (sso === "denied") return "denied";
    return "none";
  });
  const denialReason = searchParams.get("reason");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hide the token from the URL bar as soon as we've captured it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    let mutated = false;
    if (url.searchParams.has("token")) {
      url.searchParams.delete("token");
      mutated = true;
    }
    if (url.searchParams.has("sso")) {
      url.searchParams.delete("sso");
      mutated = true;
    }
    if (url.searchParams.has("reason")) {
      url.searchParams.delete("reason");
      mutated = true;
    }
    if (mutated) {
      window.history.replaceState(null, "", url.toString());
    }
  }, []);

  const onOpenWithToken = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setBearer(token);
      await authenticate({ token });
      router.push(`/portal/${encodeURIComponent(token)}`);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const denial = ((err as any)?.denial ?? "TOKEN_INVALID") as string;
      if (denial === "MFA_REQUIRED") {
        // Hand off to the existing /portal token-entry page which has
        // the MFA challenge UI already wired up.
        router.push("/portal");
        return;
      }
      setError(denial);
    } finally {
      setBusy(false);
    }
  }, [token, router]);

  // After successful SSO, automatically open the portal with the stashed
  // token (we never make the reviewer click again).
  useEffect(() => {
    if (ssoOutcome === "ok" && token && !busy) {
      void onOpenWithToken();
    }
  }, [ssoOutcome, token, busy, onOpenWithToken]);

  const onSignInWithSso = useCallback(async () => {
    if (!token) {
      setError("SSO_REQUIRES_TOKEN_BOOTSTRAP");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const origin = window.location.origin;
      const spEntityId =
        window.location.origin + "/portal/sso/sp";
      const acsUrl = `${origin}/portal/sso/callback/${encodeURIComponent(grantId)}`;
      // Stash the raw token so the post-SSO redirect can resume the session.
      stashRawTokenForSso(token);
      setBearer(token);
      const res = await startPortalSso({
        grantId,
        spEntityId,
        acsUrl,
      });
      window.location.href = res.redirectUrl;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const denial = ((err as any)?.denial ?? "POLICY_REJECTED") as string;
      setError(denial);
      setBusy(false);
    }
  }, [grantId, token]);

  return (
    <main
      data-portal-accept-page
      data-portal-accept-grant={grantId}
      style={{
        maxWidth: 520,
        margin: "0 auto",
        padding: "48px 20px",
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#0f172a",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 8, marginTop: 0 }}>
        Welcome to the PROOVRA External Reviewer Portal
      </h1>
      <p style={{ color: "#475569", fontSize: 13, lineHeight: 1.55 }}>
        You were invited to review evidence on behalf of an external
        party. Your activity here is audited. PROOVRA records what you
        observe and decide — it does not assert authenticity of content.
      </p>

      <section
        data-portal-accept-context
        style={{
          marginTop: 14,
          padding: 12,
          background: "rgba(15, 23, 42, 0.04)",
          border: "1px solid rgba(15, 23, 42, 0.1)",
          borderRadius: 10,
          fontSize: 12,
        }}
      >
        <div>
          <strong>Invitation:</strong>{" "}
          <code data-portal-accept-grant-id>{grantId}</code>
        </div>
        <div style={{ color: "#475569", marginTop: 4 }}>
          Access ends when the grant expires. Once you sign in, navigate
          using the dashboard ribbon at the top.
        </div>
      </section>

      {ssoOutcome === "denied" ? (
        <div
          data-portal-accept-sso-denied
          role="alert"
          style={{
            marginTop: 12,
            padding: "8px 12px",
            background: "rgba(239, 68, 68, 0.08)",
            border: "1px solid rgba(239, 68, 68, 0.4)",
            borderRadius: 8,
            color: "#7f1d1d",
            fontSize: 12,
          }}
        >
          SSO sign-in was refused{denialReason ? `: ${denialReason}` : ""}.
          You can still continue with the invitation link below.
        </div>
      ) : null}

      {error ? (
        <div
          data-portal-accept-error
          role="alert"
          style={{
            marginTop: 12,
            padding: "8px 12px",
            background: "rgba(239, 68, 68, 0.08)",
            border: "1px solid rgba(239, 68, 68, 0.4)",
            borderRadius: 8,
            color: "#7f1d1d",
            fontSize: 12,
          }}
        >
          <code>{error}</code>
        </div>
      ) : null}

      {!token ? (
        <div
          data-portal-accept-no-token
          role="alert"
          style={{
            marginTop: 12,
            padding: "10px 12px",
            background: "rgba(245, 158, 11, 0.08)",
            border: "1px solid rgba(245, 158, 11, 0.4)",
            borderRadius: 8,
            color: "#78350f",
            fontSize: 12,
          }}
        >
          We could not find your invitation link in this URL. Please
          re-open the link from your invitation email, or use the
          fallback{" "}
          <a
            data-portal-accept-fallback-link
            href="/portal"
            style={{ color: "#7c2d12" }}
          >
            paste-the-token page
          </a>
          .
        </div>
      ) : (
        <div
          data-portal-accept-actions
          style={{
            marginTop: 18,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <button
            type="button"
            data-portal-accept-open-with-token
            onClick={onOpenWithToken}
            disabled={busy}
            style={{
              padding: "10px 18px",
              border: "1px solid #0f172a",
              background: busy ? "#94a3b8" : "#0f172a",
              color: "#fafafa",
              fontWeight: 600,
              fontSize: 13,
              borderRadius: 8,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Opening portal…" : "Open with invitation link"}
          </button>
          <button
            type="button"
            data-portal-accept-sign-in-with-sso
            onClick={onSignInWithSso}
            disabled={busy}
            style={{
              padding: "10px 18px",
              border: "1px solid #1e3a8a",
              background: busy ? "#cbd5e1" : "#fff",
              color: "#1e3a8a",
              fontWeight: 600,
              fontSize: 13,
              borderRadius: 8,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Redirecting…" : "Sign in with SSO"}
          </button>
          <small style={{ color: "#475569", fontSize: 11 }}>
            Use SSO if your organization is federated with PROOVRA — it
            validates that the identity who arrives matches the invited
            reviewer. If you are not sure, "Open with invitation link"
            always works.
          </small>
        </div>
      )}

      <section
        data-portal-accept-limitations
        style={{
          marginTop: 24,
          padding: 10,
          background: "rgba(15, 23, 42, 0.03)",
          border: "1px dashed rgba(15, 23, 42, 0.18)",
          borderRadius: 8,
          fontSize: 11,
          color: "#475569",
        }}
      >
        <strong style={{ color: "#0f172a" }}>What we will record</strong>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          <li>Every page view inside the portal.</li>
          <li>Annotations, comments, and decisions you submit.</li>
          <li>The fact that you opened the portal and from what IP.</li>
        </ul>
      </section>
    </main>
  );
}
