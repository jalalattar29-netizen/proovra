/**
 * PHASE R8.1.6 — User-facing MFA recovery email verification page.
 *
 * The user clicks the verification link sent by the API's
 * `sendMfaRecoveryVerificationEmail`. The link points HERE with
 * `?id=` (request id) and `?token=` (raw verification token) in
 * the query string. This page POSTs them to the canonical verify
 * endpoint `POST /v1/identity/mfa/recovery-requests/:id/verify-email`
 * and renders a calm, bounded result.
 *
 * Hard rules (UI-enforced):
 *   - The token NEVER lands in localStorage / sessionStorage.
 *   - The token NEVER renders to the page after submission.
 *   - The token NEVER appears in console.log / authLogger.
 *   - The page DOES NOT issue a session.
 *   - The page DOES NOT bypass MFA.
 *   - Success ONLY moves the request to PENDING_ADMIN_REVIEW —
 *     the user still has to wait for an organization admin.
 *   - We strip the `?token=` from the URL via history.replaceState
 *     after posting so a back-button + share would not leak it.
 */

"use client";

import { Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { apiFetch, ApiError } from "../../../../lib/api";

type VerifyState =
  | { kind: "idle" }
  | { kind: "verifying" }
  | {
      kind: "verified";
      // PHASE R8.1.7 — session detection. After successful verify
      // we probe /v1/auth/me to decide whether to offer "Continue
      // to home" (authenticated) or "Return to sign in" (anonymous).
      sessionPresent: boolean;
    }
  | {
      kind: "error";
      reason:
        | "missing_params"
        | "expired"
        | "invalid"
        | "wrong_user"
        | "already_handled"
        | "unknown";
    };

function MfaRecoveryVerifyBody() {
  const search = useSearchParams();
  const rawId = search.get("id");
  const rawToken = search.get("token");
  const [state, setState] = useState<VerifyState>({ kind: "idle" });
  const inFlightRef = useRef(false);

  useEffect(() => {
    // Guard against StrictMode double-invoke + a manual reload.
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    // PHASE R8.1.7 — page-viewed analytics. Fire BEFORE we touch
    // the verify endpoint so SecOps can dashboard the top of the
    // verify funnel. Best-effort; failure is non-fatal.
    void (async () => {
      try {
        await apiFetch(
          "/v1/identity/mfa/recovery-requests/analytics/page-viewed",
          { method: "POST", body: JSON.stringify({}) },
          { auth: false },
        );
      } catch {
        // ignore — analytics is best-effort.
      }
    })();

    if (!rawId || !rawToken) {
      setState({ kind: "error", reason: "missing_params" });
      return;
    }

    setState({ kind: "verifying" });

    // Best-effort: strip the token from the visible URL the moment
    // we begin posting it, so back-button / copy-link / browser
    // history doesn't leak it. We keep `?id=` so refresh still
    // identifies the request (the operator can then resend if the
    // first verify hasn't completed yet — the resend endpoint is
    // owner-only and refuses if status has moved past pending).
    try {
      if (typeof window !== "undefined" && window.history?.replaceState) {
        const u = new URL(window.location.href);
        u.searchParams.delete("token");
        window.history.replaceState(null, "", u.toString());
      }
    } catch {
      // history API not available — non-fatal.
    }

    void (async () => {
      try {
        await apiFetch(
          `/v1/identity/mfa/recovery-requests/${encodeURIComponent(
            rawId,
          )}/verify-email`,
          {
            method: "POST",
            body: JSON.stringify({ token: rawToken }),
          },
          { auth: false },
        );
        // PHASE R8.1.9 — detect whether the user happens to be
        // signed in already. Uses the dedicated session-light
        // probe (`GET /v1/auth/session-light`) which returns only
        // `{ authenticated: boolean }`. This endpoint:
        //   - Accepts BOTH Bearer header AND the HttpOnly
        //     `proovra_session` cookie, so SSO-only users who
        //     have no localStorage entry are detected correctly
        //     (R8.1.8's localStorage pre-check is no longer
        //     needed).
        //   - Refuses pending-MFA tokens — `authenticated: false`
        //     for a user mid-challenge is the right answer here.
        //   - Collapses all error states (invalid sig, expired,
        //     missing token) to `authenticated: false`.
        //   - NEVER creates a session, NEVER refreshes a cookie.
        let sessionPresent = false;
        try {
          const probe = await apiFetch(
            "/v1/auth/session-light",
            { method: "GET" },
            { auth: false },
          );
          sessionPresent = Boolean(probe?.authenticated);
        } catch {
          sessionPresent = false;
        }
        setState({ kind: "verified", sessionPresent });
      } catch (err) {
        if (err instanceof ApiError) {
          // Disambiguate the bounded backend reasons.
          const msg = err.message ?? "";
          if (
            msg === "token_expired" ||
            msg.includes("expired")
          ) {
            setState({ kind: "error", reason: "expired" });
          } else if (msg === "wrong_user") {
            setState({ kind: "error", reason: "wrong_user" });
          } else if (msg === "request_not_in_email_pending") {
            // The row was already verified, cancelled, rejected,
            // approved, expired, or completed. We collapse to a
            // single calm "already handled" message — never leak
            // the specific state.
            setState({ kind: "error", reason: "already_handled" });
          } else if (msg === "token_invalid" || err.statusCode === 404) {
            setState({ kind: "error", reason: "invalid" });
          } else {
            setState({ kind: "error", reason: "unknown" });
          }
        } else {
          setState({ kind: "error", reason: "unknown" });
        }
      }
    })();
  }, [rawId, rawToken]);

  if (state.kind === "verifying" || state.kind === "idle") {
    return (
      <Shell title="Verifying your recovery request">
        <p style={mutedStyle} data-cc-mfa-recovery-verify-state="verifying">
          Hold tight — we&apos;re confirming your recovery link…
        </p>
      </Shell>
    );
  }

  if (state.kind === "verified") {
    return (
      <Shell title="Email verified">
        <p data-cc-mfa-recovery-verify-state="verified">
          Thanks — your mailbox access is confirmed.
        </p>
        <p style={mutedStyle}>
          Your two-factor recovery request is now waiting for an
          administrator in your organization to review. You do NOT
          need to take any further action until they reach out.
        </p>
        <p style={warnBoxStyle}>
          This step confirmed your email only. It did NOT log you in
          and did NOT change your two-factor authentication. You will
          still need to enroll a fresh authenticator once an admin
          approves your reset.
        </p>
        {/* PHASE R8.1.7 — session-aware CTA. Authenticated users get
             a direct path back to their workspace; anonymous users
             get the sign-in entry point. NEITHER path issues a
             session here — they just navigate the existing one. */}
        {state.sessionPresent ? (
          <Link
            href="/home"
            style={primaryLinkStyle}
            data-cc-mfa-recovery-verify-cta="continue-home"
          >
            Continue to home
          </Link>
        ) : (
          <Link
            href="/login"
            style={primaryLinkStyle}
            data-cc-mfa-recovery-verify-cta="return-to-sign-in"
          >
            Return to sign in
          </Link>
        )}
      </Shell>
    );
  }

  // Error states — bounded copy per reason.
  const copy = errorCopy(state.reason);
  return (
    <Shell title={copy.title}>
      <p
        role="alert"
        style={errorBoxStyle}
        data-cc-mfa-recovery-verify-state="error"
        data-cc-mfa-recovery-verify-reason={state.reason}
      >
        {copy.message}
      </p>
      <p style={mutedStyle}>{copy.next}</p>
      <Link href="/login" style={primaryLinkStyle}>
        Return to sign in
      </Link>
    </Shell>
  );
}

type VerifyErrorReason =
  | "missing_params"
  | "expired"
  | "invalid"
  | "wrong_user"
  | "already_handled"
  | "unknown";

function errorCopy(reason: VerifyErrorReason): {
  title: string;
  message: string;
  next: string;
} {
  switch (reason) {
    case "missing_params":
      return {
        title: "Recovery link incomplete",
        message:
          "This link is missing required information. Please use the most recent recovery email you received.",
        next:
          "If you no longer have the email, request a new MFA recovery from your sign-in page.",
      };
    case "expired":
      return {
        title: "Recovery link expired",
        message:
          "Your recovery verification link has expired. Each link is valid for a short window for your safety.",
        next:
          "Request a fresh recovery email from your sign-in page and click the new link within 15 minutes.",
      };
    case "invalid":
      return {
        title: "Recovery link invalid",
        message:
          "This recovery link is not valid. It may have been already used or replaced by a more recent one.",
        next:
          "If you need to start over, request a fresh MFA recovery from your sign-in page.",
      };
    case "wrong_user":
      return {
        title: "Different account signed in",
        message:
          "This recovery link belongs to a different account than the one currently signed in.",
        next: "Sign out and try the link again in a private window.",
      };
    case "already_handled":
      return {
        title: "Recovery request already handled",
        message:
          "This recovery request has already been verified, cancelled, approved, or expired.",
        next: "No further action is needed on this email. Return to sign in to continue.",
      };
    case "unknown":
    default:
      return {
        title: "Could not verify recovery link",
        message:
          "Something went wrong while confirming your recovery link.",
        next: "Please try again, or contact your administrator if the problem persists.",
      };
  }
}

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main
      data-page="auth-mfa-recovery-verify"
      style={pageStyle}
    >
      <h1 style={{ fontSize: 22, marginBottom: 12 }}>{title}</h1>
      {children}
      <p style={{ marginTop: 24, fontSize: 13, color: "#64748b" }}>
        If you did not request an MFA recovery, contact your
        organization administrator immediately.
      </p>
    </main>
  );
}

export default function MfaRecoveryVerifyPage() {
  return (
    <Suspense
      fallback={
        <main style={{ padding: 48, textAlign: "center" }}>Loading…</main>
      }
    >
      <MfaRecoveryVerifyBody />
    </Suspense>
  );
}

const pageStyle: CSSProperties = {
  maxWidth: 520,
  margin: "0 auto",
  padding: "48px 24px",
  fontFamily: "system-ui, -apple-system, sans-serif",
};
const mutedStyle: CSSProperties = { color: "#475569", marginBottom: 12 };
const warnBoxStyle: CSSProperties = {
  border: "1px solid #fde68a",
  background: "#fffbeb",
  color: "#92400e",
  padding: "10px 14px",
  borderRadius: 8,
  marginTop: 12,
  marginBottom: 16,
};
const errorBoxStyle: CSSProperties = {
  border: "1px solid #fecaca",
  background: "#fef2f2",
  color: "#b91c1c",
  padding: "10px 14px",
  borderRadius: 8,
  marginBottom: 12,
};
const primaryLinkStyle: CSSProperties = {
  display: "inline-block",
  marginTop: 12,
  padding: "10px 18px",
  background: "#1d4ed8",
  color: "white",
  borderRadius: 8,
  textDecoration: "none",
};
